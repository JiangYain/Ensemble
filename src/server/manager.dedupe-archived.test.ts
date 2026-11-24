import { afterEach, describe, expect, it } from "vitest";
import type { SessionId } from "@shared/types";
import { archiveSessions } from "./archive";
import { FixtureExecutor } from "./executors/fixture";
import { DEFAULT_MANAGER_CONFIG } from "./manager";
import { delegatorFor, makeTrackedEnv, shutdownTrackedEnvs, until, type TestEnv } from "./testing";

/**
 * 防重复命中一个已归档的会话：命中什么也不产生（不开始运行、不写事件、不画线），所以也不动它的归档状态——
 * 它照旧归档着，调用方拿到的仍是已有会话的标识（见 manager.delegate 命中分支的注释）。
 * 这与“被用到才取消归档”（send、follows、改挂：都会产生新的运行或连线）是两回事。
 *
 * 一个边界：委派的 `follows` 指向的已归档上级，照旧在判重之前取消归档（连同整棵子树；`docs/manual.zh-CN.md` 的“自动取消归档”写明了这一点，
 * manager.delegate-archive.test.ts 钉住了上级那一半）。被命中的会话若在这棵子树里，会随上级一起回来——最后一个用例把这一半写成断言。
 */

afterEach(shutdownTrackedEnvs);

const quick = delegatorFor("pi", "[fixture:quick] Work that finishes");

type Delegated = Awaited<ReturnType<typeof quick>>;

/** 防重复开成生产设定（测试环境默认把它关掉）。 */
function setup(): TestEnv {
  return makeTrackedEnv([new FixtureExecutor("pi", { speed: 0 })], { duplicateWindowMs: DEFAULT_MANAGER_CONFIG.duplicateWindowMs });
}

/** 一个做完了的会话（才能归档）；`overrides` 用来把它接在别的会话后面。 */
async function finished(env: TestEnv, overrides: Parameters<typeof quick>[1] = {}): Promise<Delegated> {
  const delegated = await quick(env, overrides);
  await until(() => env.hub.summary(delegated.sessionId)?.phase === "done", 4000, "the session to finish");
  return delegated;
}

/** 一个会话此刻在各处留下的痕迹：内存里的标记与摘要、存储里的标记与日志大小，以及存储与中枢里各有哪些会话。标记取副本，免得与之后的原对象比成同一个。 */
async function pictureOf(env: TestEnv, sessionId: SessionId) {
  const mark = env.hub.archiveOf(sessionId);
  return {
    mark: mark === undefined ? undefined : { ...mark },
    archivedAt: env.hub.summary(sessionId)?.archivedAt,
    stored: await env.store.readArchive(sessionId),
    logBytes: await env.store.logSize(sessionId),
    storedSessions: await env.store.listSessionIds(),
    hubSessions: env.hub.sessionIds(),
  };
}

/** 已归档会话的“之前”：三处的标记都在，后面拿它与命中重复之后的样子比。 */
async function archivedPicture(env: TestEnv, sessionId: SessionId) {
  const picture = await pictureOf(env, sessionId);
  expect(picture.mark, "mark in the hub").toBeDefined();
  expect(picture.archivedAt, "archivedAt in the summary").toBeDefined();
  expect(picture.stored, "mark in the store").toBeDefined();
  return picture;
}

/** 三处的标记都没有了。 */
async function expectNotArchived(env: TestEnv, ids: readonly SessionId[]): Promise<void> {
  for (const id of ids) {
    expect(env.hub.archiveOf(id), `${id}: mark in the hub`).toBeUndefined();
    expect(env.hub.summary(id)?.archivedAt, `${id}: archivedAt in the summary`).toBeUndefined();
    expect(await env.store.readArchive(id), `${id}: mark in the store`).toBeUndefined();
  }
}

describe("a repeated delegation that lands on an archived session", () => {
  it("answers with that same session and leaves its archive mark, its log and the set of sessions exactly as they were", async () => {
    const env = setup();
    const first = await finished(env);
    expect((await archiveSessions(env.hub, [first.sessionId], "user")).changed).toEqual([first.sessionId]);
    const before = await archivedPicture(env, first.sessionId);
    const seen: string[] = [];
    env.hub.subscribe((change) => seen.push(change.type));

    const again = await quick(env);

    expect(again).toMatchObject({ sessionId: first.sessionId, runId: first.runId, messageId: first.messageId });
    expect(again.duplicate).toBeDefined();
    expect(await pictureOf(env, first.sessionId)).toEqual(before);
    // 中枢里没有任何变化通知：没有事件、没有关系变化、没有归档变化。
    expect(seen).toEqual([]);
  });

  it("does not bring back a child that was archived on its own, although the repeat follows its parent", async () => {
    const env = setup();
    const top = await finished(env);
    const kid = await finished(env, { parentSessionId: top.sessionId });
    // 只点名 kid：归档它自己（和它的下级），上级不动。
    expect((await archiveSessions(env.hub, [kid.sessionId], "user")).changed).toEqual([kid.sessionId]);
    const before = await archivedPicture(env, kid.sessionId);

    const again = await quick(env, { parentSessionId: top.sessionId });

    expect(again).toMatchObject({ sessionId: kid.sessionId, runId: kid.runId, messageId: kid.messageId });
    expect(again.duplicate).toBeDefined();
    expect(await pictureOf(env, kid.sessionId)).toEqual(before);
    await expectNotArchived(env, [top.sessionId]);
  });

  it("starts a new session when the caller allows a duplicate, and leaves the archived one archived", async () => {
    const env = setup();
    const first = await finished(env);
    await archiveSessions(env.hub, [first.sessionId], "user");
    const before = await archivedPicture(env, first.sessionId);

    const another = await quick(env, { allowDuplicate: true });
    await until(() => env.hub.summary(another.sessionId)?.phase === "done", 4000, "the new session to finish");

    expect(another.sessionId).not.toBe(first.sessionId);
    expect(another).not.toHaveProperty("duplicate");
    // 新会话是新的：没有归档标记；旧的那个还在归档里，记录一个字节都没变。
    await expectNotArchived(env, [another.sessionId]);
    const after = await pictureOf(env, first.sessionId);
    expect(after.mark).toEqual(before.mark);
    expect(after.stored).toEqual(before.stored);
    expect(after.logBytes).toBe(before.logBytes);
    expect([...after.hubSessions].sort()).toEqual([first.sessionId, another.sessionId].sort());
  });

  it("but a request that follows an archived parent still brings the parent's subtree back first, including the session it then repeats", async () => {
    const env = setup();
    const top = await finished(env);
    const first = await finished(env, { parentSessionId: top.sessionId });
    expect((await archiveSessions(env.hub, [top.sessionId], "user")).changed.sort()).toEqual([top.sessionId, first.sessionId].sort());
    await archivedPicture(env, first.sessionId);

    const again = await quick(env, { parentSessionId: top.sessionId });

    // 命中的还是 first；它回到未归档，是因为 follows 的上级先取消了归档（连同整棵子树），不是因为命中重复。
    expect(again.sessionId).toBe(first.sessionId);
    expect(again.duplicate).toBeDefined();
    await expectNotArchived(env, [top.sessionId, first.sessionId]);
  });
});
