import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LIMITS, TOKEN_HEADER } from "@shared/constants";
import { REPORT_LIMITS } from "@shared/report";
import { testOrigin } from "@shared/testing";
import { FixtureExecutor } from "./executors/fixture";
import { silentLogger } from "./logger";
import { startService, type RunningService } from "./service";
import { until } from "./testing";

const running: RunningService[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()!.close("test");
});

/** 一律用临时目录当 ENSEMBLE_HOME：不碰这台机器上真实的数据。 */
async function boot(): Promise<RunningService> {
  const service = await startService({
    home: mkdtempSync(join(tmpdir(), "ensemble-home-")),
    port: 0,
    executors: [new FixtureExecutor("pi", { speed: 0 })],
    log: silentLogger,
    webRoot: null,
    idleExitMs: 0,
  });
  running.push(service);
  return service;
}

const authorized = (service: RunningService): Record<string, string> => ({ [TOKEN_HEADER]: service.token });

function get(service: RunningService, path: string): Promise<Response> {
  return fetch(`${service.url}${path}`, { headers: authorized(service) });
}

/**
 * 委派一个立刻完成的会话，等它结束，返回会话 id。每次的任务文字都不同，免得被防重复挡掉。
 * 除了阶段变成 done，还等到没有在途的消息：之后日志不再增长，两次导出的内容才可比较，会话也才允许被归档。
 */
async function delegate(service: RunningService, task: string, extra: Record<string, unknown> = {}): Promise<string> {
  const response = await fetch(`${service.url}/api/sessions`, {
    method: "POST",
    headers: { ...authorized(service), "content-type": "application/json" },
    body: JSON.stringify({ harness: "pi", task, cwd: tmpdir(), ...extra }),
  });
  expect(response.status).toBe(201);
  const { sessionId } = (await response.json()) as { sessionId: string };
  await until(() => {
    const summary = service.hub.summary(sessionId);
    return summary?.phase === "done" && summary.messages.pending === 0;
  }, 6000, `${sessionId} done`);
  return sessionId;
}

/** 一个上级会话与它名下的两个子会话。 */
async function family(service: RunningService): Promise<{ parent: string; childA: string; childB: string }> {
  const parent = await delegate(service, "[fixture:quick] Parent task", { title: "Parent" });
  const childA = await delegate(service, "[fixture:quick] Child A task", { title: "Child A", origin: testOrigin(), parentSessionId: parent });
  const childB = await delegate(service, "[fixture:quick] Child B task", { title: "Child B", origin: testOrigin(), parentSessionId: parent });
  return { parent, childA, childB };
}

/** 导出时刻写在报告里：比较两份报告的其余内容时先把它抹掉。 */
const withoutTimes = (text: string): string => text.replace(/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC/g, "<time>");

describe("GET /api/sessions/:id/report", () => {
  it("answers with a Markdown attachment, for the session alone by default", async () => {
    const service = await boot();
    const id = await delegate(service, "[fixture:quick] Write the parser", { title: "Parser work" });

    const response = await get(service, `/api/sessions/${id}/report`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="Parser-work-${id}.md"`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const text = await response.text();
    expect(Number(response.headers.get("content-length"))).toBe(Buffer.byteLength(text, "utf8"));
    expect(text.startsWith("# Session report: Parser work\n")).toBe(true);
    expect(text).toMatch(/Exported .+ UTC by Ensemble \S+ · scope=session · detail=brief/);
    // 委派原文原样在里面；报告的内容来自这个会话真实记录下来的事件。
    expect(text).toContain("[fixture:quick] Write the parser");
    expect(text).toContain(`| Session | \`${id}\` |`);
  });

  it("takes the whole task tree with scope=tree, and honours detail and lang", async () => {
    const service = await boot();
    const { parent, childA, childB } = await family(service);

    const response = await get(service, `/api/sessions/${parent}/report?scope=tree&detail=full&lang=zh`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="Parent-${parent}-tree-full.md"`);
    const text = await response.text();
    expect(text.startsWith("# 任务树报告：Parent\n")).toBe(true);
    expect(text).toContain("scope=tree · detail=full");
    for (const id of [parent, childA, childB]) expect(text).toContain(id);
    expect(text).toContain("[fixture:quick] Child A task");
    expect(text).toContain("[fixture:quick] Child B task");
    expect(text).toMatch(/^### 1\.1 Child A$/m);
    expect(text).toMatch(/^### 1\.2 Child B$/m);

    const alone = await (await get(service, `/api/sessions/${parent}/report`)).text();
    expect(alone).not.toContain(childA);
    expect(alone).not.toContain("Child A task");
    expect(alone).toContain("2 (not included; use scope=tree)");
  });

  it("asks for a session that does not exist: 404 not_found, before any parameter is looked at", async () => {
    const service = await boot();
    const missing = await get(service, "/api/sessions/ses_missing/report");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "not_found" } });
    const alsoBad = await get(service, "/api/sessions/ses_missing/report?scope=forest");
    expect(alsoBad.status).toBe(404);
  });

  it("rejects a parameter it does not understand with 400 invalid_request, naming the parameter", async () => {
    const service = await boot();
    const id = await delegate(service, "[fixture:quick] Check the parameters");
    const bad = [
      "scope=forest",
      "detail=verbose",
      "lang=fr",
      "maxChars=abc",
      "maxChars=100",
      `maxChars=${LIMITS.maxReportChars + 1}`,
      // 还没有的 Bundle：明确拒绝，而不是悄悄回一份 Markdown。
      "format=bundle",
    ];
    for (const query of bad) {
      const response = await get(service, `/api/sessions/${id}/report?${query}`);
      expect(response.status, query).toBe(400);
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error.code, query).toBe("invalid_request");
      expect(body.error.message, query).toContain(query.split("=")[0] ?? "");
    }
  });

  it("accepts the limits at their edges", async () => {
    const service = await boot();
    const id = await delegate(service, "[fixture:quick] Edges");
    for (const maxChars of [REPORT_LIMITS.minChars, LIMITS.maxReportChars]) {
      const response = await get(service, `/api/sessions/${id}/report?maxChars=${maxChars}`);
      expect(response.status, String(maxChars)).toBe(200);
    }
  });

  it("uses the same authentication as the other GET routes: the header or ?token=, otherwise 403", async () => {
    const service = await boot();
    const id = await delegate(service, "[fixture:quick] Authentication");
    const viaQuery = await fetch(`${service.url}/api/sessions/${id}/report?token=${service.token}`);
    expect(viaQuery.status).toBe(200);
    expect(await viaQuery.text()).toContain("# Session report:");
    expect((await fetch(`${service.url}/api/sessions/${id}/report`)).status).toBe(403);
    expect((await fetch(`${service.url}/api/sessions/${id}/report`, { headers: { [TOKEN_HEADER]: "wrong" } })).status).toBe(403);
  });

  it("keeps the report within maxChars and says that it was cut short", async () => {
    const service = await boot();
    const { parent } = await family(service);
    const response = await get(service, `/api/sessions/${parent}/report?scope=tree&maxChars=${REPORT_LIMITS.minChars}`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text.length).toBeLessThanOrEqual(REPORT_LIMITS.minChars);
    expect(text.startsWith("# Task tree report: Parent\n")).toBe(true);
    // 三个会话的完整内容放不进最小的上限：缩减过的地方都有明文说明，不会悄悄发生。
    expect(text).toMatch(/shortened|Report cut here|not included \(size limit\)/);

    const unlimited = await (await get(service, `/api/sessions/${parent}/report?scope=tree`)).text();
    expect(unlimited.length).toBeGreaterThan(text.length);
    expect(unlimited).not.toContain("Report cut here");
  });

  it("builds a download name that is safe for the header and keeps the real title for clients that read filename*", async () => {
    const service = await boot();
    const id = await delegate(service, "[fixture:quick] Name", { title: 'Fix "parser" / 解析器?' });
    const response = await get(service, `/api/sessions/${id}/report`);
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).toMatch(/^attachment; filename="[\x20-\x7e]+\.md"; filename\*=UTF-8''[A-Za-z0-9%._~!-]+\.md$/);
    expect(disposition).toContain(`filename="Fix-parser-${id}.md"`);
    const encoded = disposition.split("filename*=UTF-8''")[1] ?? "";
    expect(decodeURIComponent(encoded)).toBe(`Fix-parser-解析器-${id}.md`);
    // 标题里的引号、斜杠、问号不会进到头里。
    expect(disposition.match(/"/g)).toHaveLength(2);
  });

  it("gives an archived session and its archived descendants the same report as before they were archived", async () => {
    const service = await boot();
    const { parent, childA, childB } = await family(service);
    const before = await (await get(service, `/api/sessions/${parent}/report?scope=tree&detail=full`)).text();

    const archive = await fetch(`${service.url}/api/sessions/archive`, {
      method: "POST",
      headers: { ...authorized(service), "content-type": "application/json" },
      body: JSON.stringify({ ids: [parent] }),
    });
    expect(archive.status).toBe(200);
    for (const id of [parent, childA, childB]) expect(service.hub.summary(id)?.archivedAt, id).toBeDefined();

    const after = await (await get(service, `/api/sessions/${parent}/report?scope=tree&detail=full`)).text();
    expect(withoutTimes(after)).toBe(withoutTimes(before));
    const alone = await get(service, `/api/sessions/${childA}/report`);
    expect(alone.status).toBe(200);
    expect(await alone.text()).toContain("# Session report: Child A");
  });

  it("only reads: asking for a report adds no event to any session", async () => {
    const service = await boot();
    const { parent, childA, childB } = await family(service);
    const seqs = () => [parent, childA, childB].map((id) => service.hub.summary(id)?.seq);
    const before = seqs();
    for (const query of ["", "?scope=tree", "?scope=tree&detail=full&lang=zh", `?scope=tree&maxChars=${REPORT_LIMITS.minChars}`]) {
      expect((await get(service, `/api/sessions/${parent}/report${query}`)).status, query).toBe(200);
    }
    expect(seqs()).toEqual(before);
  });
});
