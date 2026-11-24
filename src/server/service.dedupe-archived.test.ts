import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ArchiveResponse, DelegateResponse } from "@shared/protocol";
import type { SessionSummary } from "@shared/types";
import { pathsFor } from "./paths";
import { api, boot, closeServices, tempHome, type Api } from "./service.fixtures";
import { until } from "./testing";

/**
 * 重复提交一个在这期间被归档的会话（经 HTTP）：照旧回 200 与已有的那个会话；它仍然是归档的，回执里的摘要如实带着 archivedAt，
 * 磁盘上的归档标记与事件日志一个字节都没动，也没有多出会话。`allowDuplicate` 放行时是 201 的新会话，旧的仍然归档着。
 * 用真服务与真文件存储（临时目录，从不碰真实的数据）：这里核对的正是磁盘上的东西。
 * 判重本身的规则在 manager.dedupe.test.ts 与 service.dedupe.test.ts，管理器一层的同类用例在 manager.dedupe-archived.test.ts。
 */

afterEach(closeServices);

const BODY = { harness: "pi", task: "[fixture:quick] Ask twice, with an archive in between", cwd: tmpdir() };

async function listed(client: Api, query = ""): Promise<SessionSummary[]> {
  return (await client.json<{ sessions: SessionSummary[] }>(await client.get(`/api/sessions${query}`))).sessions;
}

describe("POST /api/sessions: a repeat of a session that was archived in the meantime", () => {
  it("answers 200 with that session, still archived, and nothing on disk changes", async () => {
    const home = tempHome("ensemble-dedupe-archived-http-");
    // 显式传入 env：不读测试进程自己的环境变量。
    const service = await boot({ home, env: {} });
    const client = api(service);
    const created = await client.post("/api/sessions", BODY);
    expect(created.status).toBe(201);
    const { sessionId, runId, messageId } = await client.json<DelegateResponse>(created);
    await until(() => service.hub.summary(sessionId)?.phase === "done", 6000, "the session to finish");
    const archived = await client.json<ArchiveResponse>(await client.post("/api/sessions/archive", { ids: [sessionId] }));
    expect(archived.changed).toEqual([sessionId]);
    await service.hub.flush();
    const sessionsDir = pathsFor(home).sessions;
    const dir = join(sessionsDir, sessionId);
    const markBefore = await readFile(join(dir, "archive.json"), "utf8");
    const logBefore = await readFile(join(dir, "events.jsonl"));
    const entriesBefore = await readdir(sessionsDir);
    expect(entriesBefore).toContain(sessionId);
    const archivedAt = service.hub.summary(sessionId)?.archivedAt;
    expect(archivedAt).toBeDefined();

    const repeated = await client.post("/api/sessions", BODY);

    expect(repeated.status).toBe(200);
    const receipt = await client.json<DelegateResponse>(repeated);
    expect(receipt).toMatchObject({ sessionId, runId, messageId, summary: { id: sessionId, archivedAt, archivedBy: "user" } });
    expect(receipt.duplicate).toBeDefined();
    await service.hub.flush();
    expect(await readFile(join(dir, "archive.json"), "utf8")).toBe(markBefore);
    expect(await readFile(join(dir, "events.jsonl"))).toEqual(logBefore);
    // 没有多出会话：中枢里一个，磁盘上也没有新的会话目录。
    expect(service.hub.sessionIds()).toEqual([sessionId]);
    expect(await readdir(sessionsDir)).toEqual(entriesBefore);
    // 默认的列表里仍然没有它，只在“已归档”里。
    expect(await listed(client)).toEqual([]);
    expect((await listed(client, "?archived=only")).map((summary) => summary.id)).toEqual([sessionId]);
  });

  it("with allowDuplicate it is a new session (201), and the archived one stays archived", async () => {
    const home = tempHome("ensemble-dedupe-archived-http-");
    const service = await boot({ home, env: {} });
    const client = api(service);
    const { sessionId } = await client.json<DelegateResponse>(await client.post("/api/sessions", BODY));
    await until(() => service.hub.summary(sessionId)?.phase === "done", 6000, "the session to finish");
    await client.post("/api/sessions/archive", { ids: [sessionId] });
    const archivedAt = service.hub.summary(sessionId)?.archivedAt;
    expect(archivedAt).toBeDefined();

    const forced = await client.post("/api/sessions", { ...BODY, allowDuplicate: true });

    expect(forced.status).toBe(201);
    const receipt = await client.json<DelegateResponse>(forced);
    expect(receipt.sessionId).not.toBe(sessionId);
    expect(receipt).not.toHaveProperty("duplicate");
    expect(receipt.summary.archivedAt).toBeUndefined();
    expect(service.hub.summary(sessionId)?.archivedAt).toBe(archivedAt);
    expect((await listed(client)).map((summary) => summary.id)).toEqual([receipt.sessionId]);
    expect((await listed(client, "?archived=only")).map((summary) => summary.id)).toEqual([sessionId]);
  });
});
