/**
 * 管理器碰到冷会话时的行为：要写它的日志之前先把它载回内存（写在它已有的历史之后），不需要完整状态的操作（取消、已停止的会话再停、
 * 建在它名下、删除、读索引）不为它去读日志；持有运行时连接的会话不会被再次冻结。
 * 用懒加载模式的中枢 + 内存存储（SpyStore 数着谁的日志被读了几次），时钟由测试拨动，不碰文件系统里的会话数据。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replay } from "@shared/projection";
import { AGENT, USER } from "@shared/testing";
import type { NativeRef } from "@shared/types";
import { archiveSessions } from "./archive";
import { ExecutorRegistry } from "./executors/registry";
import { HOUR, NOW, SpyStore, lazyHub, seed, sessionEvents, type Clock, type SessionFixture } from "./history-fixtures";
import { silentLogger } from "./logger";
import { SessionManager, type ManagerConfig } from "./manager";
import { NoticeCenter } from "./notices";
import { ManualExecutor, delegatorFor, until, type TestEnv } from "./testing";

const managers: SessionManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown().catch(() => undefined)));
});

const NATIVE: NativeRef = { kind: "pi-session", id: "native-cold" };

const COLD = "ses_cold";
const OTHER = "ses_other";
const TOP = "ses_top";
const MOVED = "ses_moved";
const KID = "ses_kid";

interface Lazy {
  env: TestEnv;
  store: SpyStore;
  clock: Clock;
  exec: ManualExecutor;
}

/** 懒加载环境：夹具里的老会话启动时就是冷的；载入启动时读过的日志不计，之后的断言只看“谁又被读了”。 */
async function lazyEnv(fixtures: readonly SessionFixture[], config: Partial<ManagerConfig> = {}): Promise<Lazy> {
  const store = new SpyStore();
  await seed(store, fixtures);
  const clock: Clock = { now: NOW };
  const hub = lazyHub(store, clock);
  await hub.load();
  const exec = new ManualExecutor("pi");
  exec.canResume = true;
  exec.autoStart = true;
  const registry = new ExecutorRegistry([exec], silentLogger);
  const notices = new NoticeCenter(hub);
  notices.rebuild();
  const manager = new SessionManager({ hub, executors: registry, notices, log: silentLogger, config: { duplicateWindowMs: 0, ...config } });
  managers.push(manager);
  store.loads.length = 0;
  store.logReads.length = 0;
  return { env: { hub, manager, notices, registry, store, cwd: mkdtempSync(join(tmpdir(), "ensemble-history-")) }, store, clock, exec };
}

const resumable = (id: string): SessionFixture => ({ id, ending: "done", meta: { nativeRef: NATIVE } });

describe("writing to a cold session", () => {
  it("loads it first, resumes it, and appends after its history instead of over it", async () => {
    const { env, store, exec } = await lazyEnv([resumable(COLD)]);
    const history = sessionEvents(resumable(COLD));
    expect(env.hub.isHot(COLD)).toBe(false);

    const sent = await env.manager.send(COLD, { text: "Please carry on", author: USER });

    expect(sent.kind).toBe("follow_up");
    expect(store.loads).toEqual([COLD]);
    expect(env.hub.isHot(COLD)).toBe(true);
    await until(() => exec.sessions.length === 1);
    expect(exec.sessions[0]?.input.resume).toEqual(NATIVE);
    const written = await store.load(COLD);
    expect(written.slice(0, history.length)).toEqual(history);
    expect(written.map((event) => event.seq)).toEqual(written.map((_, index) => index + 1));
    expect(written.slice(history.length).some((event) => event.kind === "message.sent")).toBe(true);
  });

  it("brings an archived cold session back from the archive when the message is taken", async () => {
    const { env, store } = await lazyEnv([resumable(COLD)]);
    await archiveSessions(env.hub, [COLD], "user");
    expect(await store.readArchive(COLD)).toBeDefined();

    await env.manager.send(COLD, { text: "Please carry on", author: USER });

    expect(env.hub.summary(COLD)?.archivedAt).toBeUndefined();
    expect(await store.readArchive(COLD)).toBeUndefined();
  });

  it("leaves it archived, and writes nothing to it, when the message is refused", async () => {
    const { env, store, exec } = await lazyEnv([resumable(COLD)]);
    const history = sessionEvents(resumable(COLD));
    exec.canResume = false;
    await archiveSessions(env.hub, [COLD], "user");

    await expect(env.manager.send(COLD, { text: "Are you there?", author: USER })).rejects.toMatchObject({ code: "session_not_resumable" });

    expect(env.hub.summary(COLD)?.archivedAt).toBeDefined();
    expect(await store.readArchive(COLD)).toBeDefined();
    expect(await store.load(COLD)).toEqual(history);
  });

  it("has nothing to cancel in a cold session, and says so without loading it", async () => {
    const { env, store } = await lazyEnv([resumable(COLD)]);

    await expect(env.manager.cancel(COLD, USER)).rejects.toMatchObject({ code: "conflict" });

    expect(store.loads).toEqual([]);
    expect(env.hub.isHot(COLD)).toBe(false);
  });

  it("stops a cold session by loading it first, and does not load one that is already stopped", async () => {
    const { env, store } = await lazyEnv([{ id: COLD, ending: "done" }, { id: OTHER, ending: "stopped" }]);

    await env.manager.stop(OTHER, USER);
    expect(store.loads).toEqual([]);
    expect(env.hub.isHot(OTHER)).toBe(false);

    await env.manager.stop(COLD, USER);
    expect(store.loads).toEqual([COLD]);
    expect(env.hub.summary(COLD)?.status).toBe("stopped");
    // 用户停止由主 Agent 派出的会话还会留一条给主 Agent 的通知，所以历史之后不止一条新事件；但原有的记录原样在前，状态变更是最后一条。
    const history = sessionEvents({ id: COLD, ending: "done" });
    const written = await store.load(COLD);
    expect(written.slice(0, history.length)).toEqual(history);
    expect(written.at(-1)).toMatchObject({ kind: "session.status", data: { status: "stopped" } });
  });
});

describe("what does not need a cold session's log", () => {
  it("removes one without loading it, with its archive mark, and takes it off its parent", async () => {
    const { env, store } = await lazyEnv([{ id: TOP }, { id: MOVED, parent: TOP }]);
    await archiveSessions(env.hub, [MOVED], "user");

    await env.manager.remove(MOVED);

    expect(store.loads).toEqual([]);
    expect(env.hub.has(MOVED)).toBe(false);
    expect(env.hub.childIds(TOP)).toEqual([]);
    expect(await store.readArchive(MOVED)).toBeUndefined();
    expect(env.hub.counts()).toMatchObject({ total: 1, archived: 0 });
  });

  it("nests a new delegation under a cold parent without loading it", async () => {
    const { env, store } = await lazyEnv([{ id: TOP }]);

    const { sessionId } = await delegatorFor("pi")(env, { parentSessionId: TOP });

    expect(store.loads).toEqual([]);
    expect(env.hub.isHot(TOP)).toBe(false);
    expect(env.hub.childIds(TOP)).toEqual([sessionId]);
    expect(env.hub.node(sessionId)).toMatchObject({ parentSessionId: TOP, depth: 1 });
  });

  it("brings an archived cold parent back when a delegation follows it, still without loading it", async () => {
    const { env, store } = await lazyEnv([{ id: TOP }]);
    await archiveSessions(env.hub, [TOP], "user");

    const { sessionId } = await delegatorFor("pi")(env, { parentSessionId: TOP });

    expect(env.hub.summary(TOP)?.archivedAt).toBeUndefined();
    expect(env.hub.childIds(TOP)).toEqual([sessionId]);
    expect(store.loads).toEqual([]);
    expect(await store.readArchive(TOP)).toBeUndefined();
  });

  it("looks only at sessions in memory when it reconciles after a restart", async () => {
    const { env, store } = await lazyEnv([{ id: COLD, ending: "done" }, { id: OTHER, ending: "running" }]);

    // 进行中的 OTHER 本来就在内存里（不稳定，不冷存）；冷的 COLD 不需要对账，也就不读它的日志。
    expect(env.hub.isHot(OTHER)).toBe(true);
    expect(env.manager.reconcileAfterRestart()).toBe(1);

    expect(env.hub.summary(OTHER)?.status).toBe("lost");
    expect(store.loads).toEqual([]);
    expect(env.hub.isHot(COLD)).toBe(false);
  });
});

describe("relinking sessions that are cold", () => {
  const TREE: SessionFixture[] = [{ id: TOP }, { id: MOVED }, { id: KID, parent: MOVED, depth: 1 }];

  it("loads just the sessions that must be written, and leaves the new parent cold and untouched", async () => {
    const { env, store } = await lazyEnv(TREE);

    const result = await env.manager.relink(MOVED, TOP, USER);

    expect(result).toEqual({ changed: true, depthUpdated: [KID] });
    expect([...store.loads].sort()).toEqual([KID, MOVED]);
    expect(env.hub.isHot(TOP)).toBe(false);
    expect(env.hub.childIds(TOP)).toEqual([MOVED]);
    expect(env.hub.node(MOVED)).toMatchObject({ parentSessionId: TOP, depth: 1 });
    expect(env.hub.node(KID)).toMatchObject({ parentSessionId: MOVED, depth: 2 });
    // 写下去的与内存里的一致：重放日志得到同样的关系。
    for (const id of [MOVED, KID]) expect(replay(await store.load(id))?.meta, id).toEqual(env.hub.state(id)?.meta);
    expect(await store.load(TOP)).toEqual(sessionEvents({ id: TOP }));
  });

  it("refuses a move over the depth limit without loading anything", async () => {
    const { env, store } = await lazyEnv(TREE, { maxDepth: 1 });

    await expect(env.manager.relink(MOVED, TOP, USER)).rejects.toMatchObject({ code: "depth_exceeded" });

    expect(store.loads).toEqual([]);
    expect(env.hub.isHot(MOVED)).toBe(false);
    expect(env.hub.isHot(KID)).toBe(false);
  });

  it("brings an archived cold parent back when something is moved under it", async () => {
    const { env, store } = await lazyEnv(TREE);
    await archiveSessions(env.hub, [TOP], "user");

    await env.manager.relink(MOVED, TOP, USER);

    expect(env.hub.summary(TOP)?.archivedAt).toBeUndefined();
    expect(await store.readArchive(TOP)).toBeUndefined();
    expect(env.hub.isHot(TOP)).toBe(false);
  });
});

describe("a session with a live connection", () => {
  it("is never frozen again, however long it has been quiet, while a session without one is", async () => {
    const { env, clock, exec } = await lazyEnv([resumable(COLD), { id: OTHER }]);
    // 主 Agent 自己发的消息：用户发的会留一条给主 Agent 的通知，未送达的通知本身就会让会话不被冻结，那就分不清是哪一条在起作用了。
    await env.manager.send(COLD, { text: "Please carry on", author: AGENT });
    await until(() => exec.sessions.length === 1 && env.hub.summary(COLD)?.phase === "running");
    exec.sessions[0]!.complete(env.hub.state(COLD)!.activeRunId!);
    await until(() => env.hub.summary(COLD)?.phase === "done" && env.hub.summary(COLD)?.runCount === 2);
    await env.hub.ensureHot(OTHER);
    expect(env.hub.counts().hot).toBe(2);

    // 事件带的是真实时间：把中枢的时钟拨到真实时间两小时之后，两个会话都早已过了保温期。
    clock.now = Date.now() + 2 * HOUR;
    const frozen = await env.hub.sweep();

    expect(frozen).toBe(1);
    expect(env.hub.isHot(OTHER)).toBe(false);
    expect(env.hub.isHot(COLD)).toBe(true);
  });
});
