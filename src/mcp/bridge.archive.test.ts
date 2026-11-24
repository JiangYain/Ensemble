import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { USER } from "@shared/testing";
import { archiveSessions } from "../server/archive";
import { DAY, NOW, seed, type SessionFixture } from "../server/history-fixtures";
import { silentLogger } from "../server/logger";
import { pathsFor } from "../server/paths";
import type { RunningService } from "../server/service";
import { FileEventStore } from "../server/store";
import { until } from "../server/testing";
import { closeTestBridges, connectTestBridge, startTestService, tempHome, type McpSession } from "./bridge.fixtures";

/**
 * 已归档的会话在 MCP 这一层：`status` 默认不列并说明略去了几个、`includeArchived` 与点名的 `sessionIds` 把它们列出来，
 * `wait` 的默认范围不含它们、点名时照常返回，`read` 照常读（包括还留在磁盘上的冷会话），以及 `send` / `follows` 把它们取消归档。
 * 一行怎么写（“(archived)” 标记、详情里的那一行）在 format.archive.test.ts。全部用临时状态目录与模拟执行端。
 */

afterEach(closeTestBridges);

interface Harness extends McpSession {
  service: RunningService;
}

/** fixtures 是启动前就写进状态目录的老会话（启动时它们是冷的）。 */
async function setup(fixtures: readonly SessionFixture[] = []): Promise<Harness> {
  const home = tempHome("ensemble-mcp-archive-");
  if (fixtures.length > 0) await seed(new FileEventStore(pathsFor(home).sessions, silentLogger), fixtures);
  const service = await startTestService({
    home,
    env: {},
    // 服务的时钟固定在夹具的“现在”：夹具里的会话是几十天前的老会话，测试里新建的（真实时间）不会被当作老会话冻结。
    history: { now: () => NOW },
  });
  return { service, ...(await connectTestBridge(service)) };
}

/** 经 MCP 委派一个会话，返回它的 id（不等它结束）。 */
async function delegated(harness: Harness, task: string, extra: Record<string, unknown> = {}): Promise<string> {
  const result = await harness.call("delegate", { harness: "pi", task, cwd: tmpdir(), ...extra });
  expect(result.isError, result.text).toBe(false);
  return result.data?.["sessionId"] as string;
}

/** 经 MCP 委派一个很快结束的会话，等它完成。 */
async function finished(harness: Harness, task: string): Promise<string> {
  const id = await delegated(harness, task);
  await until(() => harness.service.hub.summary(id)?.phase === "done");
  return id;
}

const lineOf = (text: string, id: string): string => text.split("\n").find((line) => line.includes(id)) ?? "";

describe("status and archived sessions", () => {
  it("leaves them out by default and says how many, then lists them, marked, when asked", async () => {
    const h = await setup();
    const first = await finished(h, "[fixture:quick] first piece of work");
    const second = await finished(h, "[fixture:quick] second piece of work");
    await archiveSessions(h.service.hub, [first], "user");

    const status = await h.call("status");
    expect(status.isError).toBe(false);
    expect(status.text).toContain(second);
    expect(status.text).not.toContain(first);
    expect(status.text).toContain("Not listed: 1 archived session (");
    expect(status.data?.["archivedOmitted"]).toBe(1);
    expect((status.data?.["sessions"] as { id: string }[]).map((session) => session.id)).toEqual([second]);

    const everything = await h.call("status", { includeArchived: true });
    expect(everything.text).not.toContain("Not listed");
    expect(everything.data?.["archivedOmitted"]).toBeUndefined();
    expect(lineOf(everything.text, first)).toContain("(archived)");
    expect(lineOf(everything.text, second)).not.toContain("(archived)");
    const compact = everything.data?.["sessions"] as { id: string; archived?: boolean }[];
    expect(compact.find((session) => session.id === first)?.archived).toBe(true);
    expect(compact.find((session) => session.id === second)?.archived).toBeUndefined();
  });

  it("returns a session that is named, archived or not, and does not call it missing", async () => {
    const h = await setup();
    const first = await finished(h, "[fixture:quick] first piece of work");
    const second = await finished(h, "[fixture:quick] second piece of work");
    await archiveSessions(h.service.hub, [first], "retention");

    const named = await h.call("status", { sessionIds: [first, second], detail: true });

    expect(named.isError).toBe(false);
    expect(named.text).toContain(first);
    expect(named.text).toContain(second);
    expect(named.text).not.toContain("Not found");
    expect(named.text).not.toContain("Not listed");
    expect(lineOf(named.text, first)).toContain("(archived)");
    expect(named.text).toMatch(/ {4}archived: \S+ by the retention policy — moved out of the default view/);
  });

  it("says plainly when everything the conversation started is archived, and how many were left out", async () => {
    const h = await setup();
    const first = await finished(h, "[fixture:quick] first piece of work");
    const second = await finished(h, "[fixture:quick] second piece of work");
    await archiveSessions(h.service.hub, [first, second], "user");

    const mine = await h.call("status");
    expect(mine.text).toContain("None of your sessions in this conversation is unarchived.");
    expect(mine.text).toContain("Not listed: 2 archived sessions (");
    expect(mine.data?.["archivedOmitted"]).toBe(2);
    expect(mine.data?.["sessions"]).toEqual([]);

    const all = await h.call("status", { scope: "all" });
    expect(all.text).toContain("No unarchived sessions.");
    expect(all.text).toContain("Not listed: 2 archived sessions (");
  });

  it("does not mention archived sessions at all when there are none", async () => {
    const h = await setup();
    await finished(h, "[fixture:quick] first piece of work");

    const status = await h.call("status");

    expect(status.text).not.toMatch(/archived/i);
    expect(status.data).not.toHaveProperty("archivedOmitted");
  });
});

describe("wait and archived sessions", () => {
  it("does not wait for them by default, but returns at once when they are named", async () => {
    const h = await setup();
    const done = await finished(h, "[fixture:quick] already finished");
    const held = await delegated(h, "Wait for guidance [fixture:hold]");
    await until(() => h.service.hub.state(held)?.status === "running");
    await archiveSessions(h.service.hub, [done], "user");

    const waiting = await h.call("wait", { timeoutSeconds: 1 });
    expect(waiting.data?.["reason"]).toBe("timeout");
    expect(waiting.data?.["waitedOn"]).toEqual([held]);
    expect(waiting.text).not.toContain(done);

    const named = await h.call("wait", { sessionIds: [done], timeoutSeconds: 1 });
    expect(named.data?.["reason"]).toBe("settled");
    expect(named.text).toContain(done);
    expect(lineOf(named.text, done)).toContain("(archived)");

    await h.service.manager.stop(held, USER);
  });

  it("says that there is nothing to wait for, and why, when all of its sessions are archived", async () => {
    const h = await setup();
    const first = await finished(h, "[fixture:quick] first piece of work");
    const second = await finished(h, "[fixture:quick] second piece of work");
    await archiveSessions(h.service.hub, [first, second], "user");

    const waiting = await h.call("wait", { timeoutSeconds: 1 });

    expect(waiting.isError).toBe(false);
    expect(waiting.text).toContain("Nothing to wait for");
    expect(waiting.text).toContain("archived");
    expect(waiting.text).toContain("includeArchived: true");
  });
});

describe("read and archived sessions", () => {
  it("reads one as before and marks it", async () => {
    const h = await setup();
    const id = await finished(h, "[fixture:quick] a piece of work worth reading later");
    await archiveSessions(h.service.hub, [id], "user");

    const read = await h.call("read", { sessionId: id });

    expect(read.isError).toBe(false);
    expect(read.text).toContain(id);
    expect(read.text).toContain("(archived)");
    expect((read.data?.["session"] as { archived?: boolean }).archived).toBe(true);
  });
});

describe("old sessions that are still on disk", () => {
  const OLD: SessionFixture[] = [
    { id: "ses_old_a", ending: "done", at: NOW - 40 * DAY },
    { id: "ses_old_b", ending: "failed", at: NOW - 35 * DAY },
  ];

  it("are listed, read and waited for without being loaded into memory, archived or not", async () => {
    const h = await setup(OLD);
    const { hub } = h.service;
    expect(hub.isHot("ses_old_a")).toBe(false);
    expect(hub.isHot("ses_old_b")).toBe(false);

    const listing = await h.call("status", { scope: "all" });
    expect(listing.text).toContain("ses_old_a");
    expect(listing.text).toContain("ses_old_b");

    await archiveSessions(hub, ["ses_old_a"], "user");
    const after = await h.call("status", { scope: "all" });
    expect(after.text).not.toContain("ses_old_a");
    expect(after.text).toContain("ses_old_b");
    expect(after.text).toContain("Not listed: 1 archived session (");

    const detail = await h.call("status", { sessionIds: ["ses_old_a"], detail: true });
    expect(detail.text).toMatch(/ {4}archived: \S+ by the user — moved out of the default view/);
    const read = await h.call("read", { sessionId: "ses_old_a" });
    expect(read.isError, read.text).toBe(false);
    expect(read.text).toContain("(archived)");
    const waited = await h.call("wait", { sessionIds: ["ses_old_a", "ses_old_b"], timeoutSeconds: 1 });
    expect(waited.data?.["reason"]).toBe("settled");

    // 列出、读取、等待都只用摘要与日志文件：没有哪一次把冷会话载回内存。
    expect(hub.isHot("ses_old_a")).toBe(false);
    expect(hub.isHot("ses_old_b")).toBe(false);
  });
});

describe("using an archived session again", () => {
  it("brings it back when the main agent sends it a message", async () => {
    const h = await setup();
    const id = await finished(h, "[fixture:quick] archived, then continued");
    await archiveSessions(h.service.hub, [id], "user");

    const sent = await h.call("send", { sessionId: id, text: "[fixture:quick] and one more thing" });

    expect(sent.isError, sent.text).toBe(false);
    expect(h.service.hub.summary(id)?.archivedAt).toBeUndefined();
    const status = await h.call("status");
    expect(status.text).toContain(id);
    expect(status.text).not.toContain("Not listed");
  });

  it("brings it back when a new delegation follows it, and nests the new session under it", async () => {
    const h = await setup();
    const parent = await finished(h, "[fixture:quick] the work to build on");
    await archiveSessions(h.service.hub, [parent], "user");

    const child = await delegated(h, "[fixture:quick] carry on from there", { follows: parent });

    expect(h.service.hub.summary(parent)?.archivedAt).toBeUndefined();
    expect(h.service.hub.summary(child)?.parentSessionId).toBe(parent);
  });
});
