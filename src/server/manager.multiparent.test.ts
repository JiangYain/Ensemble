import { afterEach, describe, expect, it } from "vitest";
import { LIMITS } from "@shared/constants";
import { replay } from "@shared/projection";
import { USER } from "@shared/testing";
import type { SessionId, SessionMeta } from "@shared/types";
import { archiveSessions } from "./archive";
import { EnsembleError } from "./errors";
import { FixtureExecutor } from "./executors/fixture";
import { DEFAULT_MANAGER_CONFIG } from "./manager";
import { ManualExecutor, delegatorFor, makeTrackedEnv, shutdownTrackedEnvs, stateOf, until, type TestEnv } from "./testing";

/**
 * 汇聚（一个会话跟随多个上级）在管理器里的样子：委派、改挂、判重、取消归档。
 * 只有一个上级的行为由 manager.relink.test.ts 与 manager.dedupe.test.ts 守着。
 */

afterEach(shutdownTrackedEnvs);

const manual = delegatorFor("cursor", "Work that keeps running");
const quick = delegatorFor("pi", "[fixture:quick] Work that finishes");

function setup(maxDepth = 2, config: Parameters<typeof makeTrackedEnv>[1] = {}): { env: TestEnv; exec: ManualExecutor } {
  const exec = new ManualExecutor("cursor");
  exec.autoStart = true;
  return { env: makeTrackedEnv([exec, new FixtureExecutor("pi", { speed: 0 })], { maxDepth, ...config }), exec };
}

/** 等执行端报回原生会话引用：之后 meta 只会被关系调整改动，比较起来不会和异步到达的事件赛跑。 */
async function make(env: TestEnv, parents: readonly SessionId[] = []): Promise<SessionId> {
  const { sessionId } = await manual(env, parents.length > 0 ? { parentSessionIds: [...parents] } : {});
  await until(() => stateOf(env, sessionId).meta.nativeRef !== undefined);
  return sessionId;
}

/** 一个很快做完的会话（已结束，可以归档）。 */
async function finishedSession(env: TestEnv): Promise<SessionId> {
  const { sessionId } = await quick(env);
  await until(() => stateOf(env, sessionId).runs[0]?.status === "completed");
  return sessionId;
}

function lastRelink(env: TestEnv, sessionId: SessionId) {
  return env.hub.events(sessionId).filter((event) => event.kind === "session.relinked").at(-1);
}

function createdMeta(env: TestEnv, sessionId: SessionId): SessionMeta {
  for (const event of env.hub.events(sessionId)) if (event.kind === "session.created") return event.data.meta;
  throw new Error("the session has no session.created event");
}

/** 被拒绝表现为返回的 Promise 失败。 */
async function failure(run: () => unknown): Promise<EnsembleError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof EnsembleError) return error;
    throw error;
  }
  throw new Error("expected the call to be rejected");
}

describe("delegating with several parents", () => {
  it("records every parent on the new session, one level below the deepest, and lists it under each of them", async () => {
    const { env } = setup();
    const a = await make(env);
    const b = await make(env);

    const joined = await make(env, [a, b]);

    expect(stateOf(env, joined).meta).toMatchObject({ parentSessionId: a, parentSessionIds: [a, b], depth: 1 });
    expect(env.hub.childIds(a)).toEqual([joined]);
    expect(env.hub.childIds(b)).toEqual([joined]);
    expect(env.hub.summary(a)?.childIds).toEqual([joined]);
    expect(env.hub.summary(joined)).toMatchObject({ parentSessionId: a, parentSessionIds: [a, b] });
    // 日志里的 session.created 带着完整集合，重放得到同一份。
    expect(createdMeta(env, joined)).toMatchObject({ parentSessionId: a, parentSessionIds: [a, b] });
    expect(replay(await env.store.load(joined))?.meta).toEqual(stateOf(env, joined).meta);
  });

  it("writes nothing new for a session with one parent, however it was asked for", async () => {
    const { env } = setup();
    const a = await make(env);

    const viaField = (await manual(env, { parentSessionId: a })).sessionId;
    const viaList = (await manual(env, { parentSessionIds: [a] })).sessionId;

    for (const id of [viaField, viaList]) {
      expect(stateOf(env, id).meta.parentSessionId).toBe(a);
      expect("parentSessionIds" in stateOf(env, id).meta, id).toBe(false);
      expect("parentSessionIds" in createdMeta(env, id), id).toBe(false);
      expect("parentSessionIds" in env.hub.summary(id)!, id).toBe(false);
    }
  });

  it("takes the depth from the longest chain, not from the first parent", async () => {
    const { env } = setup(2);
    const top = await make(env);
    const middle = await make(env, [top]);
    const loose = await make(env);

    const joined = await make(env, [loose, middle]);

    expect(stateOf(env, middle).meta.depth).toBe(1);
    expect(stateOf(env, joined).meta).toMatchObject({ parentSessionId: loose, depth: 2 });
  });

  it("refuses a join that would sit over the limit, names the deepest parent, and creates nothing", async () => {
    const { env } = setup(1);
    const top = await make(env);
    const middle = await make(env, [top]);
    const before = env.hub.sessionIds().length;

    const error = await failure(() => manual(env, { parentSessionIds: [top, middle] }));

    expect(error.code).toBe("depth_exceeded");
    expect(error.message).toContain(middle);
    expect(error.message).toContain("deepest of its 2 parents");
    expect(error.details).toMatchObject({ depth: 2, maxDepth: 1, parentSessionId: top, parentSessionIds: [top, middle], deepestParentId: middle });
    expect(env.hub.sessionIds()).toHaveLength(before);
  });

  it("says what it said before when a single parent is too deep (no new words, no new details)", async () => {
    const { env } = setup(1);
    const top = await make(env);
    const middle = await make(env, [top]);

    const error = await failure(() => manual(env, { parentSessionId: middle }));

    expect(error.code).toBe("depth_exceeded");
    expect(error.message).not.toContain("deepest");
    expect(error.details).toEqual({ depth: 2, maxDepth: 1, parentSessionId: middle });
  });

  it("names every parent that does not exist at once, and creates nothing", async () => {
    const { env } = setup();
    const a = await make(env);

    const error = await failure(() => manual(env, { parentSessionIds: [a, "ses_gone1", "ses_gone2"] }));

    expect(error.code).toBe("not_found");
    expect(error.message).toContain("ses_gone1");
    expect(error.message).toContain("ses_gone2");
    expect(env.hub.sessionIds()).toEqual([a]);
  });

  it("refuses an empty list, too many parents and two fields that disagree, with invalid_request, before looking anything up", async () => {
    const { env } = setup();
    const a = await make(env);
    const b = await make(env);
    const tooMany = Array.from({ length: LIMITS.maxParents + 1 }, (_, index) => `ses_missing_${index}`);

    for (const bad of [{ parentSessionIds: [] }, { parentSessionIds: tooMany }, { parentSessionId: b, parentSessionIds: [a, b] }]) {
      expect((await failure(() => manual(env, bad))).code, JSON.stringify(bad)).toBe("invalid_request");
    }
    expect(env.hub.sessionIds().sort()).toEqual([a, b].sort());
  });

  it("deduplicates the list and treats a repeated parent as one", async () => {
    const { env } = setup();
    const a = await make(env);
    const b = await make(env);

    const joined = await make(env, [a, b, a]);
    const single = (await manual(env, { parentSessionIds: [a, a] })).sessionId;

    expect(stateOf(env, joined).meta.parentSessionIds).toEqual([a, b]);
    expect(stateOf(env, single).meta.parentSessionId).toBe(a);
    expect("parentSessionIds" in stateOf(env, single).meta).toBe(false);
  });

  it("brings every archived parent back first, since the new session is using them again", async () => {
    const { env } = setup();
    const a = await finishedSession(env);
    const b = await finishedSession(env);
    expect((await archiveSessions(env.hub, [a, b], "user")).changed.sort()).toEqual([a, b].sort());

    const { sessionId } = await manual(env, { parentSessionIds: [a, b] });

    expect(env.hub.archiveOf(a)).toBeUndefined();
    expect(env.hub.archiveOf(b)).toBeUndefined();
    expect(env.hub.summary(sessionId)?.parentSessionIds).toEqual([a, b]);
  });
});

describe("recognising a repeated delegation with several parents", () => {
  const ON = { duplicateWindowMs: DEFAULT_MANAGER_CONFIG.duplicateWindowMs };

  it("compares the parents as a set: the same set in another order is a repeat, a different set is not", async () => {
    const { env } = setup(2, ON);
    const a = (await manual(env, { task: "Parent A" })).sessionId;
    const b = (await manual(env, { task: "Parent B" })).sessionId;
    const c = (await manual(env, { task: "Parent C" })).sessionId;

    const first = await manual(env, { task: "Merge the two", parentSessionIds: [a, b] });
    const reordered = await manual(env, { task: "Merge the two", parentSessionIds: [b, a] });
    const fewer = await manual(env, { task: "Merge the two", parentSessionIds: [a] });
    const other = await manual(env, { task: "Merge the two", parentSessionIds: [a, c] });
    const none = await manual(env, { task: "Merge the two" });

    expect(first).not.toHaveProperty("duplicate");
    expect(reordered).toMatchObject({ sessionId: first.sessionId, duplicate: expect.anything() });
    for (const created of [fewer, other, none]) {
      expect(created).not.toHaveProperty("duplicate");
      expect(created.sessionId).not.toBe(first.sessionId);
    }
    expect(new Set([first.sessionId, fewer.sessionId, other.sessionId, none.sessionId]).size).toBe(4);
  });
});

describe("relinking to several parents", () => {
  it("replaces the whole set without sending anything, and records the full set in the log", async () => {
    const { env } = setup();
    const a = await make(env);
    const b = await make(env);
    const moved = await make(env);
    const before = stateOf(env, moved);
    const counts = { messages: before.messages.length, runs: before.runs.length, seq: before.seq };

    const result = await env.manager.relink(moved, [a, b], USER);

    expect(result).toEqual({ changed: true, depthUpdated: [] });
    expect(stateOf(env, moved).meta).toMatchObject({ parentSessionId: a, parentSessionIds: [a, b], depth: 1 });
    expect(env.hub.childIds(a)).toEqual([moved]);
    expect(env.hub.childIds(b)).toEqual([moved]);
    const state = stateOf(env, moved);
    expect(state.messages).toHaveLength(counts.messages);
    expect(state.runs).toHaveLength(counts.runs);
    expect(state.seq).toBe(counts.seq + 1);
    expect(env.notices.pendingCount()).toBe(0);
    expect(lastRelink(env, moved)).toMatchObject({
      kind: "session.relinked",
      source: "user",
      data: { parentSessionId: a, parentSessionIds: [a, b], depth: 1, previous: { depth: 0 }, cause: "self", by: USER },
    });
    expect(replay(await env.store.load(moved))?.meta).toEqual(stateOf(env, moved).meta);
  });

  it("goes back to one parent, leaves the other one's children alone, and clears the set", async () => {
    const { env } = setup();
    const a = await make(env);
    const b = await make(env);
    const joined = await make(env, [a, b]);

    await env.manager.relink(joined, b, USER);

    expect(stateOf(env, joined).meta.parentSessionId).toBe(b);
    expect("parentSessionIds" in stateOf(env, joined).meta).toBe(false);
    expect(env.hub.childIds(a)).toEqual([]);
    expect(env.hub.childIds(b)).toEqual([joined]);
    const record = lastRelink(env, joined);
    expect(record).toMatchObject({ data: { parentSessionId: b, previous: { parentSessionId: a, parentSessionIds: [a, b], depth: 1 } } });
    expect(record !== undefined && record.kind === "session.relinked" && "parentSessionIds" in record.data).toBe(false);
    expect(replay(await env.store.load(joined))?.meta).toEqual(stateOf(env, joined).meta);
  });

  it("does nothing for the same list; a new order changes the primary parent and nothing else", async () => {
    const { env } = setup();
    const a = await make(env);
    const b = await make(env);
    const joined = await make(env, [a, b]);
    const seq = stateOf(env, joined).seq;

    expect(await env.manager.relink(joined, [a, b], USER)).toEqual({ changed: false, depthUpdated: [] });
    expect(stateOf(env, joined).seq).toBe(seq);

    expect(await env.manager.relink(joined, [b, a], USER)).toEqual({ changed: true, depthUpdated: [] });
    expect(stateOf(env, joined).meta).toMatchObject({ parentSessionId: b, parentSessionIds: [b, a], depth: 1 });
    expect(env.hub.childIds(a)).toEqual([joined]);
    expect(env.hub.childIds(b)).toEqual([joined]);
  });

  it("removes every parent with null", async () => {
    const { env } = setup();
    const a = await make(env);
    const b = await make(env);
    const joined = await make(env, [a, b]);

    expect(await env.manager.relink(joined, null, USER)).toMatchObject({ changed: true });

    expect("parentSessionId" in stateOf(env, joined).meta).toBe(false);
    expect("parentSessionIds" in stateOf(env, joined).meta).toBe(false);
    expect(stateOf(env, joined).meta.depth).toBe(0);
    expect(env.hub.childIds(a)).toEqual([]);
    expect(env.hub.childIds(b)).toEqual([]);
  });

  it("turns a session with one parent into a join and back, one record each way", async () => {
    const { env } = setup();
    const a = await make(env);
    const b = await make(env);
    const kid = await make(env, [a]);

    await env.manager.relink(kid, [a, b], USER);
    expect(stateOf(env, kid).meta.parentSessionIds).toEqual([a, b]);
    expect(env.hub.childIds(b)).toEqual([kid]);

    await env.manager.relink(kid, a, USER);
    expect("parentSessionIds" in stateOf(env, kid).meta).toBe(false);
    expect(env.hub.childIds(b)).toEqual([]);
    expect(env.hub.events(kid).filter((event) => event.kind === "session.relinked")).toHaveLength(2);
  });

  it("refuses a parent set that contains itself or one of its descendants, and changes nothing", async () => {
    // 放宽到 8，只有环路检查能拦住（默认上限 2 会让深度检查先一步拒绝，掩盖环路检查是否还在）。
    const { env } = setup(8);
    const top = await make(env);
    const middle = await make(env, [top]);
    const bottom = await make(env, [middle]);
    const loose = await make(env);
    const seqs = () => [top, middle, bottom, loose].map((id) => stateOf(env, id).seq);
    const before = seqs();

    const self = await failure(() => env.manager.relink(loose, [top, loose], USER));
    expect(self.code).toBe("invalid_request");
    for (const wanted of [[loose, bottom], [middle], [bottom, loose]]) {
      const error = await failure(() => env.manager.relink(top, wanted, USER));
      expect(error.code, wanted.join()).toBe("conflict");
      expect(error.message).toContain("loop");
    }

    expect(seqs()).toEqual(before);
    expect("parentSessionId" in stateOf(env, top).meta).toBe(false);
  });

  it("names every parent that does not exist at once", async () => {
    const { env } = setup();
    const a = await make(env);
    const moved = await make(env);

    const error = await failure(() => env.manager.relink(moved, [a, "ses_nope1", "ses_nope2"], USER));

    expect(error.code).toBe("not_found");
    expect(error.message).toContain("ses_nope1");
    expect(error.message).toContain("ses_nope2");
    expect("parentSessionId" in stateOf(env, moved).meta).toBe(false);
  });

  it("brings an archived new parent back, whichever position it has in the list", async () => {
    const { env } = setup();
    const a = await finishedSession(env);
    const b = await finishedSession(env);
    await archiveSessions(env.hub, [a, b], "user");
    const moved = await make(env);

    await env.manager.relink(moved, [a, b], USER);

    expect(env.hub.archiveOf(a)).toBeUndefined();
    expect(env.hub.archiveOf(b)).toBeUndefined();
    expect(stateOf(env, moved).meta.parentSessionIds).toEqual([a, b]);
  });
});

describe("the depth of what hangs below a moved session", () => {
  it("rejects the whole move when any descendant would end up over the limit, whichever chain makes it so", async () => {
    // moved 在 p1c 下面（p1c 在第 1 层）：moved 变成第 2 层，它的子会话第 3 层，超过上限 2。
    const { env } = setup(2);
    const p0 = await make(env);
    const p1 = await make(env);
    const p1c = await make(env, [p1]);
    const moved = await make(env);
    const kid = await make(env, [moved]);
    const seqs = () => [p0, p1, p1c, moved, kid].map((id) => stateOf(env, id).seq);
    const before = seqs();

    const error = await failure(() => env.manager.relink(moved, [p0, p1c], USER));

    expect(error.code).toBe("depth_exceeded");
    expect(error.message).toContain(kid);
    expect(error.details).toMatchObject({ sessionId: moved, parentSessionIds: [p0, p1c], deepestParentId: p1c, depth: 3, maxDepth: 2, deepestSessionId: kid });
    expect(seqs()).toEqual(before);
    expect(stateOf(env, kid).meta.depth).toBe(1);
  });

  it("recalculates by the longest chain and writes a record only for descendants whose depth really changed, each once", async () => {
    // 菱形：r → a、b → j（j 跟随 a 与 b）。把 r 挪到 s 下面，a、b、j 的层数各加 1，j 虽有两条路径，只记一次。
    const { env } = setup(8);
    const s = await make(env);
    const r = await make(env);
    const a = await make(env, [r]);
    const b = await make(env, [r]);
    const j = await make(env, [a, b]);
    const bystander = await make(env);
    const bystanderSeq = stateOf(env, bystander).seq;

    const result = await env.manager.relink(r, [s], USER);

    expect(result).toEqual({ changed: true, depthUpdated: [a, b, j] });
    expect(stateOf(env, r).meta.depth).toBe(1);
    expect(stateOf(env, a).meta.depth).toBe(2);
    expect(stateOf(env, b).meta.depth).toBe(2);
    expect(stateOf(env, j).meta).toMatchObject({ depth: 3, parentSessionId: a, parentSessionIds: [a, b] });
    expect(env.hub.events(j).filter((event) => event.kind === "session.relinked")).toHaveLength(1);
    expect(lastRelink(env, j)).toMatchObject({
      data: { parentSessionId: a, parentSessionIds: [a, b], depth: 3, previous: { parentSessionId: a, parentSessionIds: [a, b], depth: 2 }, cause: "ancestor" },
    });
    expect(stateOf(env, bystander).seq).toBe(bystanderSeq);
    for (const id of [r, a, b, j]) expect(replay(await env.store.load(id))?.meta, id).toEqual(stateOf(env, id).meta);
  });

  it("leaves a descendant alone when another of its parents already keeps it that deep", async () => {
    // k 跟随 a 与 deep（deep 在第 2 层）：k 在第 3 层。把 a 挪深一层不会改变 k 的层数——最长的链仍然经过 deep。
    const { env } = setup(8);
    const root = await make(env);
    const mid = await make(env, [root]);
    const deep = await make(env, [mid]);
    const a = await make(env);
    const k = await make(env, [a, deep]);
    const kSeq = stateOf(env, k).seq;
    expect(stateOf(env, k).meta.depth).toBe(3);

    const result = await env.manager.relink(a, [root], USER);

    expect(result).toEqual({ changed: true, depthUpdated: [] });
    expect(stateOf(env, a).meta.depth).toBe(1);
    expect(stateOf(env, k).meta.depth).toBe(3);
    expect(stateOf(env, k).seq).toBe(kSeq);
  });
});
