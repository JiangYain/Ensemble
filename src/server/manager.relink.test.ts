import { afterEach, describe, expect, it } from "vitest";
import { replay } from "@shared/projection";
import { testOrigin, USER } from "@shared/testing";
import type { SessionId } from "@shared/types";
import { EnsembleError } from "./errors";
import { FixtureExecutor } from "./executors/fixture";
import { ManualExecutor, delegatorFor, makeTrackedEnv, shutdownTrackedEnvs, stateOf, until, type TestEnv } from "./testing";

afterEach(shutdownTrackedEnvs);

const manual = delegatorFor("cursor", "Work that keeps running");
const quick = delegatorFor("pi", "[fixture:quick] Work that finishes");

function setup(maxDepth = 2): { env: TestEnv; exec: ManualExecutor } {
  const exec = new ManualExecutor("cursor");
  exec.autoStart = true;
  return { env: makeTrackedEnv([exec, new FixtureExecutor("pi", { speed: 0 })], { maxDepth }), exec };
}

/** 等执行端报回原生会话引用：之后 meta 只会被关系调整改动，比较起来不会和异步到达的事件赛跑。 */
async function make(env: TestEnv, parentSessionId?: SessionId): Promise<SessionId> {
  const { sessionId } = await manual(env, parentSessionId ? { parentSessionId } : {});
  await until(() => stateOf(env, sessionId).meta.nativeRef !== undefined);
  return sessionId;
}

function lastRelink(env: TestEnv, sessionId: SessionId) {
  return env.hub.events(sessionId).filter((event) => event.kind === "session.relinked").at(-1);
}

/** relink 是异步的（改挂的会话或它的后代可能是冷的，要先载回内存），所以被拒绝表现为返回的 Promise 失败。 */
async function failure(run: () => unknown): Promise<EnsembleError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof EnsembleError) return error;
    throw error;
  }
  throw new Error("expected the call to be rejected");
}

describe("relinking a session to another parent after it was created", () => {
  it("moves it under the new parent without sending anything or starting a run", async () => {
    const { env } = setup();
    const review = await make(env);
    const fix = await make(env);
    const before = stateOf(env, fix);
    const counts = { messages: before.messages.length, runs: before.runs.length, seq: before.seq };

    const result = await env.manager.relink(fix, review, USER);

    expect(result).toEqual({ changed: true, depthUpdated: [] });
    expect(stateOf(env, fix).meta).toMatchObject({ parentSessionId: review, depth: 1 });
    expect(env.hub.childIds(review)).toEqual([fix]);
    expect(env.hub.summary(review)?.childIds).toEqual([fix]);
    const state = stateOf(env, fix);
    expect(state.messages).toHaveLength(counts.messages);
    expect(state.runs).toHaveLength(counts.runs);
    expect(state.seq).toBe(counts.seq + 1);
    // 它是一次对关系的记录，不是干预：来源是 Main Agent 的会话不会因此多出一条要同步给主 Agent 的通知。
    expect(env.notices.pendingCount()).toBe(0);
    expect(lastRelink(env, fix)).toMatchObject({
      kind: "session.relinked",
      source: "user",
      data: { parentSessionId: review, depth: 1, previous: { depth: 0 }, cause: "self", by: USER },
    });
  });

  it("keeps the origin, so status, wait and intervention sync keep following the Main Agent", async () => {
    const { env } = setup();
    const review = await make(env);
    const fix = await make(env);
    await env.manager.relink(fix, review, USER);

    expect(stateOf(env, fix).meta.origin.key).toBe(testOrigin().key);
    await until(() => stateOf(env, fix).status === "running");
    await env.manager.send(fix, { text: "Skip the slow ones", author: USER });
    expect(env.notices.peek(testOrigin().key).map((notice) => notice.sessionId)).toEqual([fix]);
  });

  it("writes the same relation into every log it touches, so replay gives back the same state", async () => {
    const { env } = setup();
    const target = await make(env);
    const moved = await make(env);
    const child = await make(env, moved);
    await env.manager.relink(moved, target, USER);

    for (const id of [target, moved, child]) {
      expect(replay(await env.store.load(id))?.meta, id).toEqual(stateOf(env, id).meta);
    }
    expect(lastRelink(env, child)).toMatchObject({
      kind: "session.relinked",
      data: { parentSessionId: moved, depth: 2, previous: { parentSessionId: moved, depth: 1 }, cause: "ancestor" },
    });
  });

  it("recalculates the depth of the whole subtree and reports which descendants changed", async () => {
    const { env } = setup();
    const top = await make(env);
    const moved = await make(env);
    const child = await make(env, moved);

    expect(await env.manager.relink(moved, top, USER)).toEqual({ changed: true, depthUpdated: [child] });
    expect(stateOf(env, moved).meta.depth).toBe(1);
    expect(stateOf(env, child).meta).toMatchObject({ parentSessionId: moved, depth: 2 });

    expect(await env.manager.relink(moved, null, USER)).toEqual({ changed: true, depthUpdated: [child] });
    expect(stateOf(env, child).meta.depth).toBe(1);
  });

  it("refuses to move a subtree whose deepest session would end up over the limit, and changes nothing", async () => {
    const { env } = setup(2);
    const top = await make(env);
    const moved = await make(env);
    const child = await make(env, moved);
    const grandchild = await make(env, child);
    const seqs = () => [top, moved, child, grandchild].map((id) => stateOf(env, id).seq);
    const before = seqs();

    const error = await failure(() => env.manager.relink(moved, top, USER));
    expect(error.code).toBe("depth_exceeded");
    expect(error.message).toContain(grandchild);
    expect(error.message).toContain("depth 3");
    expect(error.message).toContain("limit of 2");
    expect(error.details).toMatchObject({ sessionId: moved, parentSessionId: top, depth: 3, maxDepth: 2, deepestSessionId: grandchild });
    expect(seqs()).toEqual(before);
    expect(stateOf(env, grandchild).meta.depth).toBe(2);
  });

  it("refuses a parent that is deeper than the limit allows", async () => {
    const { env } = setup(1);
    const top = await make(env);
    const second = await make(env, top);
    const loose = await make(env);

    const error = await failure(() => env.manager.relink(loose, second, USER));
    expect(error.code).toBe("depth_exceeded");
    expect(stateOf(env, loose).meta.depth).toBe(0);
  });

  it("returns a session to the origin card with an explicit null", async () => {
    const { env } = setup();
    const review = await make(env);
    const fix = await make(env, review);

    expect(await env.manager.relink(fix, null, USER)).toMatchObject({ changed: true });
    expect("parentSessionId" in stateOf(env, fix).meta).toBe(false);
    expect(stateOf(env, fix).meta.depth).toBe(0);
    expect(env.hub.childIds(review)).toEqual([]);
    expect(lastRelink(env, fix)).toMatchObject({ data: { parentSessionId: null, previous: { parentSessionId: review, depth: 1 } } });
  });

  it("does nothing when the session already has that parent", async () => {
    const { env } = setup();
    const review = await make(env);
    const fix = await make(env, review);
    const loose = await make(env);
    const seq = stateOf(env, fix).seq;
    const looseSeq = stateOf(env, loose).seq;

    expect(await env.manager.relink(fix, review, USER)).toEqual({ changed: false, depthUpdated: [] });
    expect(await env.manager.relink(loose, null, USER)).toEqual({ changed: false, depthUpdated: [] });
    expect(stateOf(env, fix).seq).toBe(seq);
    expect(stateOf(env, loose).seq).toBe(looseSeq);
  });

  it("rejects an unknown session, an unknown parent and a session as its own parent", async () => {
    const { env } = setup();
    const fix = await make(env);

    const missing = await failure(() => env.manager.relink("ses_missing", fix, USER));
    expect(missing.code).toBe("not_found");
    expect(missing.message).toContain("ses_missing");
    const noParent = await failure(() => env.manager.relink(fix, "ses_nope", USER));
    expect(noParent.code).toBe("not_found");
    expect(noParent.message).toContain("ses_nope");
    expect((await failure(() => env.manager.relink(fix, fix, USER))).code).toBe("invalid_request");
    expect("parentSessionId" in stateOf(env, fix).meta).toBe(false);
  });

  it("rejects a parent that is one of its own descendants, however far down", async () => {
    const { env } = setup();
    const top = await make(env);
    const middle = await make(env, top);
    const bottom = await make(env, middle);

    for (const parent of [middle, bottom]) {
      const error = await failure(() => env.manager.relink(top, parent, USER));
      expect(error.code).toBe("conflict");
      expect(error.message).toContain("loop");
    }
    expect("parentSessionId" in stateOf(env, top).meta).toBe(false);
  });

  it("catches a loop on its own, even when the depth limit alone would not stop it", async () => {
    // 默认上限 2 会让深度检查先一步拒绝这些改挂，掩盖环路检查是否还在；放宽到 8，只有环路检查能拦住。
    const { env } = setup(8);
    const top = await make(env);
    const middle = await make(env, top);
    const bottom = await make(env, middle);

    for (const parent of [middle, bottom]) expect((await failure(() => env.manager.relink(top, parent, USER))).code, parent).toBe("conflict");
    expect("parentSessionId" in stateOf(env, top).meta).toBe(false);
    expect(env.hub.childIds(bottom)).toEqual([]);
  });

  it("can relink a session that already finished", async () => {
    const { env } = setup();
    const review = await make(env);
    const { sessionId: fix } = await quick(env);
    await until(() => stateOf(env, fix).runs[0]?.status === "completed");
    const finished = { status: stateOf(env, fix).status, updatedAt: stateOf(env, fix).updatedAt };

    await env.manager.relink(fix, review, USER);

    expect(stateOf(env, fix).meta.parentSessionId).toBe(review);
    expect(env.hub.summary(fix)?.phase).toBe("done");
    expect({ status: stateOf(env, fix).status, updatedAt: stateOf(env, fix).updatedAt }).toEqual(finished);
  });

  it("does not disturb a run in progress", async () => {
    const { env, exec } = setup();
    const review = await make(env);
    const fix = await make(env);
    await until(() => stateOf(env, fix).status === "running");
    const runId = stateOf(env, fix).activeRunId!;
    const updatedAt = stateOf(env, fix).updatedAt;

    await env.manager.relink(fix, review, USER);

    const state = stateOf(env, fix);
    expect(state.status).toBe("running");
    expect(state.activeRunId).toBe(runId);
    expect(state.updatedAt).toBe(updatedAt);
    const session = exec.sessions.find((candidate) => candidate.input.meta.id === fix)!;
    expect(session.started).toHaveLength(1);
    expect(session.steers).toEqual([]);
    expect(session.cancelled).toEqual([]);
    expect(session.closed).toBe(false);

    // 之后它照常结束，事件仍然按序落在同一条日志里。
    session.complete(runId);
    await until(() => stateOf(env, fix).runs[0]?.status === "completed");
    expect(stateOf(env, fix).meta.parentSessionId).toBe(review);
    const seqs = env.hub.events(fix).map((event) => event.seq);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
  });
});

describe("relinking around removed sessions", () => {
  it("can detach a session whose parent was removed, and cannot attach to a removed one", async () => {
    const { env } = setup();
    const { sessionId: parent } = await quick(env);
    await until(() => stateOf(env, parent).runs[0]?.status === "completed");
    const child = await make(env, parent);
    const other = await make(env);

    await env.manager.remove(parent);
    expect(env.hub.childIds(parent)).toEqual([]);
    expect(env.hub.summary(child)?.parentSessionId).toBe(parent);

    expect((await failure(() => env.manager.relink(other, parent, USER))).code).toBe("not_found");
    expect(await env.manager.relink(child, null, USER)).toMatchObject({ changed: true });
    expect("parentSessionId" in stateOf(env, child).meta).toBe(false);
  });

  it("answers not_found, not a generic error, when a delegation names a parent that does not exist", async () => {
    const { env } = setup();
    const rejected = await manual(env, { parentSessionId: "ses_gone" }).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(EnsembleError);
    expect((rejected as EnsembleError).code).toBe("not_found");
    expect((rejected as EnsembleError).message).toContain("ses_gone");
    expect(env.hub.sessionIds()).toEqual([]);
  });
});
