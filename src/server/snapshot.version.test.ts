import { describe, expect, it } from "vitest";
import { replay, type SessionState } from "@shared/projection";
import { DAY, lazyHub, NOW, seed, sessionEvents, SpyStore, type SessionFixture } from "./history-fixtures";
import { buildSnapshot, parseSnapshot, SNAPSHOT_FORMAT } from "./snapshot";

/**
 * 快照格式版本与汇聚（一个会话跟随多个上级）。`parentSessionIds` 只在多于一个上级时才有：旧服务写的快照里没有它，
 * 结构上又和“单上级”长得一样，只有版本号能让新服务认出那一份该作废。原因与版本记录见 snapshot.ts 里的 SNAPSHOT_FORMAT。
 */

/** 汇聚会话：跟随 ses_a 与 ses_b，主上级是第一个。 */
const JOIN_META = { parentSessionId: "ses_a", parentSessionIds: ["ses_a", "ses_b"], depth: 1 };

function joinState(): SessionState {
  const state = replay(sessionEvents({ id: "ses_j", meta: JOIN_META }));
  if (!state) throw new Error("fixture has no session.created");
  return state;
}

/** 经过一次 JSON 往返，就像它被写进 summary.json 再读回来。 */
function roundTrip(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

/**
 * 旧服务（还不认识 parentSessionIds）重放这个会话后会写出的快照：版本 1，摘要里没有这个字段。
 * 日志没有变，所以序号与字节数都对得上；除了版本号，没有任何东西能让新服务认出它是过时的。
 */
function writtenByOlderServer(snapshot: unknown): Record<string, unknown> {
  const written = roundTrip(snapshot);
  const { parentSessionIds: _unknownToTheOlderServer, ...summary } = written["summary"] as Record<string, unknown>;
  return { ...written, format: 1, summary };
}

describe("the snapshot of a join that an older server wrote", () => {
  it("is refused, so the log is replayed instead of trusting a summary that has lost the other parents", () => {
    const current = buildSnapshot(joinState(), 1234, 0, "now");
    // 对照：这一版写出的汇聚会话摘要带着完整的上级集合。
    expect(current.summary.parentSessionIds).toEqual(["ses_a", "ses_b"]);

    const older = writtenByOlderServer(current);
    expect(older["format"]).toBe(1);
    expect(older["summary"]).not.toHaveProperty("parentSessionIds");
    expect(parseSnapshot(older, "ses_j")).toBeUndefined();
  });

  it("cannot be told apart from a sound snapshot by its content: the version number is the only guard", () => {
    const older = writtenByOlderServer(buildSnapshot(joinState(), 1234, 0, "now"));

    // 同样的内容盖上现在的版本号：结构上完全合格、会被采信，汇聚会话就成了单上级。所以必须靠版本号拒收。
    const parsed = parseSnapshot({ ...older, format: SNAPSHOT_FORMAT }, "ses_j");

    expect(parsed).toBeDefined();
    expect(parsed?.summary).not.toHaveProperty("parentSessionIds");
  });
});

describe("the snapshot of a join that this version writes", () => {
  it("is trusted and gives the whole parent set back", () => {
    const parsed = parseSnapshot(roundTrip(buildSnapshot(joinState(), 1234, 0, "now")), "ses_j");

    expect(parsed).toBeDefined();
    expect(parsed?.summary).toMatchObject({ parentSessionId: "ses_a", parentSessionIds: ["ses_a", "ses_b"], depth: 1 });
  });

  it("is not in a format a version-1 server accepts, so such a server replays the log instead of reading it", () => {
    // 旧服务只认版本 1；有了 parentSessionIds 之后写出的版本不能再是 1。
    expect(buildSnapshot(joinState(), 1234, 0, "now").format).toBeGreaterThanOrEqual(2);
  });
});

describe("version 1 as a whole", () => {
  it("is refused whatever the session is: the first start after the upgrade replays each session once", () => {
    const state = replay(sessionEvents({ id: "ses_a" }));
    if (!state) throw new Error("fixture has no session.created");
    const snapshot = roundTrip(buildSnapshot(state, 1234, 0, "now"));

    expect(parseSnapshot({ ...snapshot, format: 1 }, "ses_a")).toBeUndefined();
    // 对照：同样的内容用现在的版本号就是可用的。
    expect(parseSnapshot(snapshot, "ses_a")).toBeDefined();
  });
});

describe("starting again after an older server rewrote a join's snapshot", () => {
  const FIXTURES: SessionFixture[] = [
    { id: "a", at: NOW - 30 * DAY },
    { id: "b", at: NOW - 29 * DAY },
    { id: "j", at: NOW - 28 * DAY, meta: { parentSessionId: "a", parentSessionIds: ["a", "b"], depth: 1 } },
  ];

  it("replays the join from its log and keeps both parents, while the others still start from their snapshots", async () => {
    const store = new SpyStore();
    await seed(store, FIXTURES);
    // 新服务：重放各会话，写下版本 2 的快照。
    await lazyHub(store, { now: NOW }).load();
    // 旧服务随后重放了 j 的日志，把它的快照改写成自己认识的样子（日志没有变，字节数仍然对得上）。
    await store.writeSnapshot("j", writtenByOlderServer(await store.readSnapshot("j")));
    store.loads.length = 0;

    const hub = lazyHub(store, { now: NOW });
    await hub.load();

    expect(store.loads).toEqual(["j"]);
    expect(hub.summary("j")).toMatchObject({ parentSessionId: "a", parentSessionIds: ["a", "b"] });
    expect(hub.childIds("a")).toEqual(["j"]);
    expect(hub.childIds("b")).toEqual(["j"]);
    // 重放之后按新格式重写了它。
    expect(parseSnapshot(await store.readSnapshot("j"), "j")?.summary.parentSessionIds).toEqual(["a", "b"]);
  });
});
