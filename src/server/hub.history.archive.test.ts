/**
 * 事件中枢的归档标记（只在会话旁加标记，不改会话本身的状态与记录），以及 mapPool 的约定：启动时读侧文件靠它限流，
 * 它与这组历史会话测试原本就放在一起，这里随归档标记一并保留。
 * 启动时的载入在 hub.history.test.ts；冻结与解冻在 hub.history.freeze.test.ts；冷会话的读、写、删在 hub.history.cold.test.ts。
 */

import { describe, expect, it, vi } from "vitest";
import { mapPool } from "@shared/map-pool";
import { lazyHub, MINUTE, NOW, seed, SpyStore, type Clock } from "./history-fixtures";
import { RECENT, startedOnce } from "./hub.history.fixtures";

describe("archive marks", () => {
  const MARK = { archivedAt: "2026-05-30T00:00:00.000Z", by: "user" } as const;

  it("show up in the summary and the counts, are saved beside the log, and change nothing about the session itself", async () => {
    const { store, clock } = await startedOnce([{ id: "a" }, { id: "b" }]);
    const hub = lazyHub(store, clock);
    await hub.load();
    const events = await store.load("a");
    const before = hub.summary("a");
    const listener = vi.fn();
    hub.subscribe(listener);

    await hub.setArchived(["a", "missing"], MARK);

    expect(hub.summary("a")).toMatchObject({ archivedAt: MARK.archivedAt, archivedBy: "user", seq: before?.seq, updatedAt: before?.updatedAt, phase: before?.phase });
    expect(hub.archiveOf("a")).toEqual(MARK);
    expect(hub.archiveOf("missing")).toBeUndefined();
    expect(hub.counts().archived).toBe(1);
    expect(await store.readArchive("a")).toEqual(MARK);
    expect(await store.load("a")).toEqual(events);
    expect(hub.isHot("a")).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ type: "archive", sessionId: "a" });
    expect(hub.allSummaries("exclude").map((summary) => summary.id)).toEqual(["b"]);
    expect(hub.allSummaries("only").map((summary) => summary.id)).toEqual(["a"]);
    expect(hub.allSummaries("include").map((summary) => summary.id)).toEqual(["a", "b"]);
    expect(hub.allSummaries().map((summary) => summary.id)).toEqual(["a", "b"]);
  });

  it("survive a restart, and are gone after the session is unarchived", async () => {
    const { store, clock } = await startedOnce([{ id: "a" }]);
    const hub = lazyHub(store, clock);
    await hub.load();
    await hub.setArchived(["a"], MARK);

    const restarted = lazyHub(store, clock);
    await restarted.load();
    expect(restarted.archiveOf("a")).toEqual(MARK);
    expect(restarted.summary("a")).toMatchObject({ archivedAt: MARK.archivedAt, archivedBy: "user" });
    expect(restarted.counts().archived).toBe(1);

    await restarted.setArchived(["a"], null);
    expect(restarted.summary("a")?.archivedAt).toBeUndefined();
    expect(await store.readArchive("a")).toBeUndefined();
    expect(restarted.counts().archived).toBe(0);
    // 再取消一次什么也不发生，也不通知。
    const listener = vi.fn();
    restarted.subscribe(listener);
    await restarted.setArchived(["a"], null);
    expect(listener).not.toHaveBeenCalled();
  });

  it("are rolled back in memory when saving them fails, and the failure is reported", async () => {
    const { store, clock } = await startedOnce([{ id: "a" }]);
    const hub = lazyHub(store, clock);
    await hub.load();
    const listener = vi.fn();
    hub.subscribe(listener);
    store.failArchive = true;

    await expect(hub.setArchived(["a"], MARK)).rejects.toThrow(/Could not save the archive mark for 1 session/);

    expect(hub.archiveOf("a")).toBeUndefined();
    expect(hub.summary("a")?.archivedAt).toBeUndefined();
    expect(hub.counts().archived).toBe(0);
    // 先通知了归档、又通知了回滚：页面最终与磁盘一致。
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("leave the recorded history exactly as it was, through archiving, freezing, thawing and unarchiving", async () => {
    const store = new SpyStore();
    const written = await seed(store, [RECENT("a")]);
    const clock: Clock = { now: NOW };
    const hub = lazyHub(store, clock);
    await hub.load();
    await hub.setArchived(["a"], MARK);
    clock.now = NOW + 6 * MINUTE;
    expect(await hub.sweep()).toBe(1);
    await hub.ensureHot("a");
    await hub.setArchived(["a"], null);
    expect(await store.load("a")).toEqual(written.get("a"));
  });
});

// mapPool 在 shared/map-pool.ts，启动读取靠它限流；它自己的约定（上限、保序、错误谁捕获）在这里一并固定。
describe("mapPool", () => {
  /** 让出一轮事件循环：此刻所有已经可以推进的 Promise 都会先推进完。 */
  const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

  function gate<T>(): { promise: Promise<T>; open: (value: T) => void } {
    let open!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
      open = resolve;
    });
    return { promise, open };
  }

  it("keeps the results in the order of the input, whichever piece of work finishes first, and never runs more than the limit at once", async () => {
    const gates = [gate<string>(), gate<string>(), gate<string>(), gate<string>()];
    const started: number[] = [];
    let running = 0;
    let peak = 0;
    const done = mapPool([0, 1, 2, 3], 2, async (item) => {
      started.push(item);
      running += 1;
      peak = Math.max(peak, running);
      try {
        return await gates[item]!.promise;
      } finally {
        running -= 1;
      }
    });

    await settle();
    expect(started).toEqual([0, 1]);

    // 后开始的先结束：空出来的那一路接着取下一项。
    gates[1]!.open("b");
    await settle();
    expect(started).toEqual([0, 1, 2]);

    gates[2]!.open("c");
    await settle();
    expect(started).toEqual([0, 1, 2, 3]);

    gates[3]!.open("d");
    gates[0]!.open("a");
    expect(await done).toEqual(["a", "b", "c", "d"]);
    expect(peak).toBe(2);
  });

  it("does not catch errors: the first one rejects the whole call, and no new piece of work is started after it", async () => {
    const started: number[] = [];
    const slow = gate<string>();
    const failure = mapPool([0, 1, 2, 3], 2, async (item) => {
      started.push(item);
      if (item === 1) throw new Error("boom");
      return item === 0 ? slow.promise : "never reached";
    });

    await expect(failure).rejects.toThrow("boom");
    // 还在途中的那一路收尾以后，也不会再去领新的一项。
    slow.open("late");
    await settle();
    expect(started).toEqual([0, 1]);
  });

  it("treats a limit below one as one, and has nothing to do for an empty list", async () => {
    expect(await mapPool([1, 2, 3], 0, async (n) => n * 2)).toEqual([2, 4, 6]);
    expect(await mapPool([1, 2], Number.NaN, async (n) => n)).toEqual([1, 2]);
    expect(await mapPool([], 8, async () => "unused")).toEqual([]);
  });
});
