import { afterEach, describe, expect, it } from "vitest";
import type { ContextItem, SessionId } from "@shared/types";
import { archiveSessions } from "./archive";
import { FixtureExecutor } from "./executors/fixture";
import { DEFAULT_MANAGER_CONFIG } from "./manager";
import { ManualExecutor, delegatorFor, makeTrackedEnv, shutdownTrackedEnvs, stateOf, until, type TestEnv } from "./testing";

/**
 * 委派要接在已归档的上级后面时，“先取消归档”只在这次委派确定会被接受之后才做：
 * 被拒绝的委派（上级不存在、层数超限、引用的会话还在运行或不存在）既不新建会话，也不能留下“上级连同它的整棵子树被取消归档”的副作用。
 * 被接受的委派照旧先取消归档，命中重复委派时也一样（`docs/manual.zh-CN.md` 的“自动取消归档”写明了这一点）。
 */

afterEach(shutdownTrackedEnvs);

const running = delegatorFor("cursor", "Work that keeps running");
const quick = delegatorFor("pi", "[fixture:quick] Work that finishes");

function setup(config: Parameters<typeof makeTrackedEnv>[1] = {}): TestEnv {
  const exec = new ManualExecutor("cursor");
  exec.autoStart = true;
  return makeTrackedEnv([exec, new FixtureExecutor("pi", { speed: 0 })], config);
}

/** 一个做完了的会话（可以归档）；`overrides` 用来把它接在别的会话后面。 */
async function finishedSession(env: TestEnv, overrides: Parameters<typeof quick>[1] = {}): Promise<SessionId> {
  const { sessionId } = await quick(env, overrides);
  await until(() => env.hub.summary(sessionId)?.phase === "done", 4000, "the session to finish");
  return sessionId;
}

/** 一棵已经归档的小树：`top` 和接在它后面的 `kid`，都做完了，一起归档。 */
async function archivedPair(env: TestEnv): Promise<{ top: SessionId; kid: SessionId }> {
  const top = await finishedSession(env);
  const kid = await finishedSession(env, { parentSessionId: top });
  expect((await archiveSessions(env.hub, [top], "user")).changed.sort()).toEqual([top, kid].sort());
  return { top, kid };
}

/** 内存里的标记、对外的摘要、磁盘上的标记，三处都在。 */
async function expectArchived(env: TestEnv, ids: readonly SessionId[]): Promise<void> {
  for (const id of ids) {
    expect(env.hub.archiveOf(id), `${id}: mark in the hub`).toBeDefined();
    expect(env.hub.summary(id)?.archivedAt, `${id}: archivedAt in the summary`).toBeDefined();
    expect(await env.store.readArchive(id), `${id}: mark in the store`).toBeDefined();
  }
}

/** 三处都没有了。 */
async function expectRestored(env: TestEnv, ids: readonly SessionId[]): Promise<void> {
  for (const id of ids) {
    expect(env.hub.archiveOf(id), `${id}: mark in the hub`).toBeUndefined();
    expect(env.hub.summary(id)?.archivedAt, `${id}: archivedAt in the summary`).toBeUndefined();
    expect(await env.store.readArchive(id), `${id}: mark in the store`).toBeUndefined();
  }
}

describe("a delegation that is refused leaves the archived parent archived", () => {
  // 修复之前，取消归档排在下面这些检查的前面：拒绝来的时候上级（连同它的整棵子树）已经取消归档了，却没有任何新会话。

  it("when another parent it follows does not exist", async () => {
    const env = setup();
    const { top, kid } = await archivedPair(env);
    const before = env.hub.sessionIds().length;

    await expect(quick(env, { parentSessionIds: [top, "ses_gone"] })).rejects.toMatchObject({ code: "not_found" });

    await expectArchived(env, [top, kid]);
    expect(env.hub.sessionIds()).toHaveLength(before);
  });

  it("when the new session would sit over the depth limit", async () => {
    const env = setup({ maxDepth: 1 });
    // top 在第 0 层，kid 在第 1 层：接在 kid 后面的会话会在第 2 层。
    const { top, kid } = await archivedPair(env);
    const before = env.hub.sessionIds().length;

    await expect(quick(env, { parentSessionId: kid })).rejects.toMatchObject({ code: "depth_exceeded" });

    // 接在 kid 后面本来会把 kid 连同仍归档的上级 top 一起带回来：两个都要还在归档里。
    await expectArchived(env, [top, kid]);
    expect(env.hub.sessionIds()).toHaveLength(before);
  });

  it("when a session it reads from is still running", async () => {
    const env = setup();
    const { top, kid } = await archivedPair(env);
    const busy = await running(env);
    await until(() => stateOf(env, busy.sessionId).status === "running", 4000, "the upstream to run");
    const before = env.hub.sessionIds().length;
    const context: ContextItem[] = [{ kind: "session", sessionId: busy.sessionId }];

    await expect(quick(env, { parentSessionId: top, context })).rejects.toMatchObject({ code: "context_session_active" });

    await expectArchived(env, [top, kid]);
    expect(env.hub.sessionIds()).toHaveLength(before);
  });

  it("when a session it reads from does not exist", async () => {
    const env = setup();
    const { top, kid } = await archivedPair(env);
    const before = env.hub.sessionIds().length;
    const context: ContextItem[] = [{ kind: "session", sessionId: "ses_nope" }];

    await expect(quick(env, { parentSessionId: top, context })).rejects.toMatchObject({ code: "not_found" });

    await expectArchived(env, [top, kid]);
    expect(env.hub.sessionIds()).toHaveLength(before);
  });
});

describe("a delegation that goes ahead still brings the archived parent back first", () => {
  it("restores the parent with its whole subtree, in the hub and in the store", async () => {
    const env = setup();
    const { top, kid } = await archivedPair(env);

    const { sessionId } = await quick(env, { parentSessionId: top });

    await expectRestored(env, [top, kid]);
    expect(env.hub.summary(sessionId)?.parentSessionId).toBe(top);
  });

  it("does so even when the request turns out to repeat a recent one: the repeat check comes after the revive", async () => {
    const env = setup({ duplicateWindowMs: DEFAULT_MANAGER_CONFIG.duplicateWindowMs });
    const top = await finishedSession(env);
    const first = await finishedSession(env, { parentSessionId: top });
    await archiveSessions(env.hub, [top], "user");
    await expectArchived(env, [top]);

    const again = await quick(env, { parentSessionId: top });

    expect(again.duplicate).toBeDefined();
    expect(again.sessionId).toBe(first);
    await expectRestored(env, [top]);
  });
});
