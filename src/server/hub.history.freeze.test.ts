/**
 * 事件中枢的冻结与解冻：静了足够久才冻结、哪些会话不冻结、冷热两张表里的次序、解冻只重放一次，
 * 以及冻结写盘的当口会话又变了（来了新事件、出现冻结守卫、被删除）。
 * 启动时的载入在 hub.history.test.ts；冷会话的读、写、删在 hub.history.cold.test.ts；归档标记与 mapPool 在 hub.history.archive.test.ts。
 */

import { describe, expect, it } from "vitest";
import type { Notice } from "@shared/types";
import { DAY, lazyHub, MINUTE, NOW, seed, SpyStore, type Clock } from "./history-fixtures";
import { iso, RECENT, startedOnce } from "./hub.history.fixtures";
import { parseSnapshot } from "./snapshot";

/**
 * 写快照的当口（快照已经写下、中枢还在等这次写入返回）执行一段动作：模拟“冻结写盘期间有人动了这个会话”。
 * 中枢在写盘返回之后要把条件整个重新核对一遍（见 EventHub.freeze）。
 */
class HookedSnapshotStore extends SpyStore {
  duringSnapshotWrite: ((sessionId: string) => void) | undefined;

  override async writeSnapshot(sessionId: string, snapshot: unknown): Promise<void> {
    await super.writeSnapshot(sessionId, snapshot);
    this.duringSnapshotWrite?.(sessionId);
  }
}

describe("freezing and thawing", () => {
  it("freezes a session once it has been quiet for longer than the warm period, and its summary does not change", async () => {
    const store = new SpyStore();
    await seed(store, [RECENT("a")]);
    const clock: Clock = { now: NOW };
    const hub = lazyHub(store, clock);
    await hub.load();
    const before = hub.summary("a");

    expect(hub.isHot("a")).toBe(true);
    expect(await hub.sweep()).toBe(0);

    clock.now = NOW + 6 * MINUTE;
    expect(await hub.sweep()).toBe(1);

    expect(hub.isHot("a")).toBe(false);
    expect(hub.counts()).toEqual({ total: 1, hot: 0, archived: 0 });
    expect(parseSnapshot(await store.readSnapshot("a"), "a")).toBeDefined();
    expect(hub.summary("a")).toEqual(before);
    expect(hub.state("a")).toBeUndefined();
  });

  it("never freezes a session that is working, waiting for a confirmation or waiting for an answer", async () => {
    const store = new SpyStore();
    await seed(store, [{ id: "running", ending: "running" }, { id: "pending", ending: "pending" }, { id: "asking", at: NOW - 5 * MINUTE }]);
    const clock: Clock = { now: NOW };
    const hub = lazyHub(store, clock);
    await hub.load();
    hub.state("asking")?.openQuestions.add("q_1");

    clock.now = NOW + 365 * DAY;
    expect(await hub.sweep()).toBe(0);
    expect(hub.counts().hot).toBe(3);
  });

  it("respects a freeze guard until it is withdrawn", async () => {
    const store = new SpyStore();
    await seed(store, [RECENT("a"), RECENT("b")]);
    const clock: Clock = { now: NOW };
    const hub = lazyHub(store, clock);
    await hub.load();
    const withdraw = hub.addFreezeGuard((id) => id !== "a");

    clock.now = NOW + 6 * MINUTE;
    expect(await hub.sweep()).toBe(1);
    expect(hub.isHot("a")).toBe(true);
    expect(hub.isHot("b")).toBe(false);

    withdraw();
    expect(await hub.sweep()).toBe(1);
    expect(hub.isHot("a")).toBe(false);
  });

  it("does not freeze a session that still has a streaming fragment waiting to be committed", async () => {
    const store = new SpyStore();
    await seed(store, [RECENT("a"), RECENT("b")]);
    // 时钟要在启动之后才拨过去：启动时就已经过了保温期的话，两个会话一开始就是冷的，根本走不到“暂存”这条路。
    const clock: Clock = { now: NOW };
    const hub = lazyHub(store, clock, { coalesceMs: 60_000 });
    await hub.load();
    expect(hub.hotIds()).toEqual(["a", "b"]);

    // a 有一段流式文字还停在合并窗口里；b 什么也没有，两个都已经静了足够久：只有 b 冻结。
    hub.emit("a", { kind: "assistant.delta", data: { itemId: "x", text: "partial" }, runId: "run_1", source: "executor", at: iso(NOW - 5 * MINUTE) });
    clock.now = NOW + 6 * MINUTE;
    expect(await hub.sweep()).toBe(1);
    expect(hub.isHot("a")).toBe(true);
    expect(hub.isHot("b")).toBe(false);
    hub.flushStaged("a");
  });

  it("does not freeze a session with an undelivered notice, and freezes it once the notice is delivered", async () => {
    const store = new SpyStore();
    await seed(store, [RECENT("a")]);
    const clock: Clock = { now: NOW };
    const hub = lazyHub(store, clock);
    await hub.load();
    const at = iso(NOW);
    const notice: Notice = { id: "ntc_1", originKey: "codex:thr_test", sessionId: "a", kind: "intervention", createdAt: at, summary: "The user sent a message." };
    hub.emit("a", { kind: "notice.created", data: { notice }, source: "ensemble", at });

    clock.now = NOW + 11 * MINUTE;
    expect(await hub.sweep()).toBe(0);

    hub.emit("a", { kind: "notice.delivered", data: { noticeIds: ["ntc_1"], messageIds: [], at }, source: "ensemble", at });
    // 送达本身也算一次动静：保温期从这里重新起算。
    expect(await hub.sweep()).toBe(0);
    clock.now = NOW + 22 * MINUTE;
    expect(await hub.sweep()).toBe(1);
    expect(hub.isHot("a")).toBe(false);
  });

  it("keeps a session that was just used warm even though its last activity is long ago", async () => {
    const { store, clock } = await startedOnce([{ id: "a" }]);
    const hub = lazyHub(store, clock);
    await hub.load();
    expect(hub.isHot("a")).toBe(false);

    await hub.ensureHot("a");
    clock.now = NOW + 5 * MINUTE;
    expect(await hub.sweep()).toBe(0);
    expect(hub.isHot("a")).toBe(true);

    clock.now = NOW + 11 * MINUTE;
    expect(await hub.sweep()).toBe(1);
    expect(hub.isHot("a")).toBe(false);
  });

  it("lists hot sessions before cold ones, each in the order it arrived there, through freezing, thawing and reading a cold log", async () => {
    // 三个都是刚结束 5 分钟的会话（创建时间各差 1 秒）：启动时都在热表里，按 id 排序读入，次序是 a、b、c。
    const store = new SpyStore();
    await seed(store, [{ id: "a", at: NOW - 5 * MINUTE }, { id: "b", at: NOW - 5 * MINUTE + 1000 }, { id: "c", at: NOW - 5 * MINUTE + 2000 }]);
    const clock: Clock = { now: NOW };
    const hub = lazyHub(store, clock);
    await hub.load();
    expect(hub.sessionIds()).toEqual(["a", "b", "c"]);
    expect(hub.hotIds()).toEqual(["a", "b", "c"]);

    // 只有 b 被冻结：它离开热表，排到冷表末尾（冷表里本来没有别人）。
    const withdraw = hub.addFreezeGuard((id) => id !== "a" && id !== "c");
    clock.now = NOW + 6 * MINUTE;
    expect(await hub.sweep()).toBe(1);
    expect(hub.sessionIds()).toEqual(["a", "c", "b"]);
    expect(hub.hotIds()).toEqual(["a", "c"]);

    // a、c 随后冻结：按它们在热表里的次序排到冷表末尾，冷表里 b 仍在最前。
    withdraw();
    expect(await hub.sweep()).toBe(2);
    expect(hub.sessionIds()).toEqual(["b", "a", "c"]);
    expect(hub.hotIds()).toEqual([]);

    // 解冻的会话从冷表移到热表末尾；冷表里剩下的保持原来的次序。
    await hub.ensureHot("a");
    expect(hub.sessionIds()).toEqual(["a", "b", "c"]);
    expect(hub.hotIds()).toEqual(["a"]);
    await hub.ensureHot("c");
    expect(hub.sessionIds()).toEqual(["a", "c", "b"]);
    expect(hub.hotIds()).toEqual(["a", "c"]);

    // 读冷会话的事件不解冻它，也不动次序。
    await hub.readEvents("b");
    expect(hub.isHot("b")).toBe(false);
    expect(hub.sessionIds()).toEqual(["a", "c", "b"]);

    // 对外的列表按创建时间排，与两张表里的次序无关。
    expect(hub.allSummaries().map((summary) => summary.id)).toEqual(["a", "b", "c"]);
  });

  it("thaws a cold session by replaying its log once, however many callers ask at the same time", async () => {
    const { store, clock } = await startedOnce([{ id: "a" }, { id: "b", parent: "a" }]);
    const hub = lazyHub(store, clock);
    await hub.load();
    const summaryBefore = hub.summary("a");

    const [first, second] = await Promise.all([hub.ensureHot("a"), hub.ensureHot("a")]);

    expect(first).toBe(second);
    expect(store.loads).toEqual(["a"]);
    expect(hub.isHot("a")).toBe(true);
    expect(hub.isHot("b")).toBe(false);
    expect(hub.counts()).toEqual({ total: 2, hot: 1, archived: 0 });
    expect(hub.state("a")).toBe(first);
    expect(hub.summary("a")).toEqual(summaryBefore);
    const seqs = hub.events("a").map((event) => event.seq);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
    expect(seqs.at(-1)).toBe(first?.seq);
    expect(await hub.ensureHot("missing")).toBeUndefined();
  });

  it("answers questions about relatives from the index, without thawing anyone", async () => {
    const { store, clock } = await startedOnce([{ id: "p" }, { id: "c", parent: "p" }]);
    const hub = lazyHub(store, clock);
    await hub.load();
    expect(hub.node("c")).toMatchObject({ id: "c", parentSessionId: "p", depth: 1 });
    expect(hub.childIds("p")).toEqual(["c"]);
    expect(hub.node("missing")).toBeUndefined();
    expect(hub.isHot("p")).toBe(false);
    expect(hub.isHot("c")).toBe(false);
  });

  it("throws, rather than returning an empty list, when the synchronous reader is asked for a cold session", async () => {
    const { store, clock } = await startedOnce([{ id: "a" }]);
    const hub = lazyHub(store, clock);
    await hub.load();
    expect(() => hub.events("a")).toThrow(/not in memory/);
  });
});

describe("a session that changes while it is being frozen", () => {
  /** 一个刚结束 5 分钟的会话，启动时在热表里；返回已经载入的中枢，时钟停在启动时刻。 */
  async function hotSession(): Promise<{ store: HookedSnapshotStore; clock: Clock; hub: ReturnType<typeof lazyHub> }> {
    const store = new HookedSnapshotStore();
    await seed(store, [RECENT("a")]);
    const clock: Clock = { now: NOW };
    const hub = lazyHub(store, clock);
    await hub.load();
    expect(hub.isHot("a")).toBe(true);
    return { store, clock, hub };
  }

  it("stays in memory with its new event, and the snapshot written a moment ago is not trusted at the next start", async () => {
    const { store, clock, hub } = await hotSession();
    clock.now = NOW + 6 * MINUTE;
    store.duringSnapshotWrite = (id) => {
      hub.emit(id, { kind: "diagnostic", data: { level: "info", code: "late", message: "Arrived while the snapshot was being written" }, source: "ensemble", at: iso(clock.now) });
    };

    expect(await hub.sweep()).toBe(0);

    expect(hub.isHot("a")).toBe(true);
    expect(hub.events("a").at(-1)).toMatchObject({ kind: "diagnostic", data: { code: "late" } });
    // 快照里记的日志大小是新事件之前的：它对不上现在的日志，重启时必须退回重放。
    store.duringSnapshotWrite = undefined;
    store.loads.length = 0;
    const restarted = lazyHub(store, clock);
    await restarted.load();
    expect(store.loads).toEqual(["a"]);
    expect(restarted.summary("a")?.seq).toBe(hub.summary("a")?.seq);
  });

  it("stays in memory when a freeze guard appears in the meantime", async () => {
    const { store, clock, hub } = await hotSession();
    clock.now = NOW + 6 * MINUTE;
    store.duringSnapshotWrite = () => {
      hub.addFreezeGuard(() => false);
    };

    expect(await hub.sweep()).toBe(0);

    expect(hub.isHot("a")).toBe(true);
    expect(hub.counts()).toEqual({ total: 1, hot: 1, archived: 0 });
  });

  it("is not brought back as a cold session when it was removed in the meantime", async () => {
    const { store, clock, hub } = await hotSession();
    clock.now = NOW + 6 * MINUTE;
    let removal: Promise<void> | undefined;
    store.duringSnapshotWrite = (id) => {
      removal = hub.remove(id);
    };

    expect(await hub.sweep()).toBe(0);
    await removal;

    expect(hub.has("a")).toBe(false);
    expect(hub.counts()).toEqual({ total: 0, hot: 0, archived: 0 });
    expect(await store.readSnapshot("a")).toBeUndefined();
    expect(await store.load("a")).toEqual([]);
  });
});
