/**
 * 事件中枢怎样载入历史会话（冷热分离）：按模式与存储能力、升级后第一次启动（还没有 summary.json）、之后的启动信任快照，以及并发读取侧文件。
 * 冻结与解冻在 hub.history.freeze.test.ts；冷会话的读、写、删在 hub.history.cold.test.ts；归档标记与 mapPool 在 hub.history.archive.test.ts；
 * 几份共用的小辅助在 hub.history.fixtures.ts。
 */

import { describe, expect, it, vi } from "vitest";
import { LIMITS } from "@shared/constants";
import type { Notice } from "@shared/types";
import { appendTo, DAY, lazyHub, MINUTE, NOW, seed, SpyStore } from "./history-fixtures";
import { historyModeFrom } from "./history-mode";
import { iso, RECENT, startedOnce } from "./hub.history.fixtures";
import { silentLogger } from "./logger";
import { DEFAULT_MANAGER_CONFIG } from "./manager";
import { parseSnapshot } from "./snapshot";
import { MemoryEventStore } from "./store";

/**
 * 每次读快照 / 读归档标记都让出一轮事件循环，并数着同时有几个在读（peak）；`unreadable` 里的会话读起来会失败。
 * 用来量启动时的并发路数，以及“某一个读不了不影响其余的”。
 */
class SlowReadStore extends SpyStore {
  readonly peak = { snapshot: 0, archive: 0 };
  readonly unreadable = { snapshot: new Set<string>(), archive: new Set<string>() };
  private readonly active = { snapshot: 0, archive: 0 };

  private async slowly<T>(kind: "snapshot" | "archive", sessionId: string, read: () => Promise<T>): Promise<T> {
    this.active[kind] += 1;
    this.peak[kind] = Math.max(this.peak[kind], this.active[kind]);
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (this.unreadable[kind].has(sessionId)) throw new Error(`the ${kind} of ${sessionId} cannot be read`);
      return await read();
    } finally {
      this.active[kind] -= 1;
    }
  }

  override readSnapshot(sessionId: string): Promise<unknown> {
    return this.slowly("snapshot", sessionId, () => super.readSnapshot(sessionId));
  }

  override readArchive(sessionId: string): Promise<unknown> {
    return this.slowly("archive", sessionId, () => super.readArchive(sessionId));
  }
}

describe("how history is loaded", () => {
  it("treats a store that cannot hold snapshots as eager, whatever was asked for", async () => {
    const store = new MemoryEventStore();
    await seed(store, [{ id: "a" }]);
    const hub = lazyHub(store, { now: NOW });
    expect(hub.mode).toBe("eager");
    await hub.load();
    expect(hub.counts()).toEqual({ total: 1, hot: 1, archived: 0 });
    expect(await hub.sweep()).toBe(0);
  });

  it("eager mode on a store that could do snapshots still loads everything into memory and writes nothing", async () => {
    const store = new SpyStore();
    await seed(store, [{ id: "a" }, { id: "b" }]);
    const hub = lazyHub(store, { now: NOW }, { mode: "eager" });
    await hub.load();
    expect(hub.mode).toBe("eager");
    expect(hub.counts()).toEqual({ total: 2, hot: 2, archived: 0 });
    expect(await hub.sweep()).toBe(0);
    expect(await store.readSnapshot("a")).toBeUndefined();
  });

  it("reads the choice from ENSEMBLE_HISTORY_MODE: lazy by default, eager on request, and reports what it could not understand", () => {
    expect(historyModeFrom({})).toEqual({ mode: "lazy" });
    expect(historyModeFrom({ ENSEMBLE_HISTORY_MODE: "  " })).toEqual({ mode: "lazy" });
    expect(historyModeFrom({ ENSEMBLE_HISTORY_MODE: "eager" })).toEqual({ mode: "eager" });
    expect(historyModeFrom({ ENSEMBLE_HISTORY_MODE: " EAGER " })).toEqual({ mode: "eager" });
    expect(historyModeFrom({ ENSEMBLE_HISTORY_MODE: "Lazy" })).toEqual({ mode: "lazy" });
    expect(historyModeFrom({ ENSEMBLE_HISTORY_MODE: "everything" })).toEqual({ mode: "lazy", ignored: "everything" });
  });

  it("keeps the warm period comfortably longer than the window in which a repeated delegation is recognised", () => {
    // 判重只看内存里的会话：保温期必须覆盖防重复窗口，且留足余量，否则刚创建的会话可能在判重窗口内就被放出内存。
    expect(LIMITS.history.warmMs).toBeGreaterThanOrEqual(3 * DEFAULT_MANAGER_CONFIG.duplicateWindowMs);
  });
});

describe("the first start after an upgrade (no summary.json yet)", () => {
  it("replays each session, writes a snapshot for the settled ones and lets go of them, and keeps the live ones in memory", async () => {
    const store = new SpyStore();
    const written = await seed(store, [
      { id: "old_done" },
      { id: "old_failed", ending: "failed" },
      { id: "old_ready", ending: "ready" },
      { id: "old_running", ending: "running" },
      { id: "old_pending", ending: "pending" },
      RECENT("recent"),
    ]);
    const hub = lazyHub(store, { now: NOW });

    const loaded = await hub.load();

    expect([...loaded].sort()).toEqual(["old_done", "old_failed", "old_pending", "old_ready", "old_running", "recent"]);
    expect(hub.counts()).toEqual({ total: 6, hot: 3, archived: 0 });
    for (const id of ["old_done", "old_failed", "old_ready"]) {
      expect(hub.isHot(id), id).toBe(false);
      expect(parseSnapshot(await store.readSnapshot(id), id), id).toBeDefined();
    }
    for (const id of ["old_running", "old_pending", "recent"]) {
      expect(hub.isHot(id), id).toBe(true);
      expect(await store.readSnapshot(id), id).toBeUndefined();
    }
    // 事件日志一个字都没动。
    for (const [id, events] of written) expect(await store.load(id), id).toEqual(events);
  });

  it("lists cold and hot sessions together, in creation order, with the same fields", async () => {
    const store = new SpyStore();
    await seed(store, [{ id: "a", at: NOW - 30 * DAY }, { id: "b", at: NOW - 20 * DAY, ending: "running" }, { id: "c", at: NOW - 10 * DAY }]);
    const hub = lazyHub(store, { now: NOW });
    await hub.load();
    expect(hub.allSummaries().map((summary) => [summary.id, summary.phase])).toEqual([["a", "done"], ["b", "running"], ["c", "done"]]);
    expect(hub.sessionIds().sort()).toEqual(["a", "b", "c"]);
    expect(hub.hotIds()).toEqual(["b"]);
  });
});

describe("the next start", () => {
  it("trusts the snapshots: no session log is read at all and the summaries come back the same", async () => {
    const store = new SpyStore();
    await seed(store, [{ id: "a" }, { id: "b", ending: "failed" }, { id: "c", parent: "a" }]);
    const first = lazyHub(store, { now: NOW });
    await first.load();
    const before = first.allSummaries();
    store.loads.length = 0;

    const second = lazyHub(store, { now: NOW });
    await second.load();

    expect(store.loads).toEqual([]);
    expect(store.logReads).toEqual([]);
    expect(second.counts()).toEqual({ total: 3, hot: 0, archived: 0 });
    expect(second.allSummaries()).toEqual(before);
    expect(second.summary("a")?.childIds).toEqual(["c"]);
  });

  it("falls back to replaying a session whose log grew after the snapshot was written, and writes a fresh snapshot", async () => {
    const store = new SpyStore();
    const written = await seed(store, [{ id: "a" }, { id: "b" }]);
    await lazyHub(store, { now: NOW }).load();
    const extra = appendTo(written.get("a") ?? [], { kind: "diagnostic", data: { level: "info", code: "later", message: "Appended behind the snapshot's back" } });
    store.append(extra);
    store.loads.length = 0;

    const hub = lazyHub(store, { now: NOW });
    await hub.load();

    expect(store.loads).toEqual(["a"]);
    expect(hub.summary("a")?.seq).toBe(extra.seq);
    expect(parseSnapshot(await store.readSnapshot("a"), "a")?.lastSeq).toBe(extra.seq);
    expect(hub.isHot("a")).toBe(false);
    expect(hub.isHot("b")).toBe(false);
  });

  it("does not trust a snapshot that is damaged, of another version, or belongs to another session, and rewrites it", async () => {
    const damage: Array<[string, (store: SpyStore, id: string, other: unknown) => Promise<void>]> = [
      ["an unknown format", async (store, id) => store.writeSnapshot(id, { format: 99 })],
      ["something that is not a snapshot", async (store, id) => store.writeSnapshot(id, "garbage")],
      ["another session's snapshot", async (store, id, other) => store.writeSnapshot(id, other)],
      ["a snapshot that admits to undelivered notices", async (store, id) => {
        const current = (await store.readSnapshot(id)) as Record<string, unknown>;
        await store.writeSnapshot(id, { ...current, undeliveredNotices: 2 });
      }],
    ];
    for (const [label, apply] of damage) {
      const { store, clock } = await startedOnce([{ id: "a" }, { id: "b" }]);
      await apply(store, "a", await store.readSnapshot("b"));

      const hub = lazyHub(store, clock);
      await hub.load();

      expect(store.loads, label).toEqual(["a"]);
      expect(parseSnapshot(await store.readSnapshot("a"), "a"), label).toBeDefined();
      expect(hub.summary("a")?.phase, label).toBe("done");
    }
  });

  it("does not trust a snapshot for a session that was active a moment ago, and keeps that session in memory", async () => {
    const { store } = await startedOnce([{ id: "a", at: NOW - 30 * DAY }]);
    // 快照是真的，只是“重启”发生在这个会话最后一次动静之后不到保温期：先留在内存里。
    const hub = lazyHub(store, { now: NOW - 30 * DAY + MINUTE });
    await hub.load();
    expect(store.loads).toEqual(["a"]);
    expect(hub.isHot("a")).toBe(true);
  });

  it("keeps a session with an undelivered notice in memory, however old it is, so the notice queue can be rebuilt", async () => {
    const store = new SpyStore();
    const written = await seed(store, [{ id: "a" }, { id: "b" }]);
    const notice: Notice = { id: "ntc_1", originKey: "codex:thr_test", sessionId: "a", kind: "intervention", createdAt: iso(NOW - 30 * DAY), summary: "The user sent a message." };
    store.append(appendTo(written.get("a") ?? [], { kind: "notice.created", data: { notice } }));

    const hub = lazyHub(store, { now: NOW });
    await hub.load();

    expect(hub.isHot("a")).toBe(true);
    expect(hub.isHot("b")).toBe(false);
    expect(await store.readSnapshot("a")).toBeUndefined();
  });

  it("starts with sessions that have no summary.json (old data) next to sessions that do (new data): only the old ones are replayed", async () => {
    const store = new SpyStore();
    await seed(store, [{ id: "fresh" }]);
    await lazyHub(store, { now: NOW }).load();
    // legacy 是另一个版本的服务写下的：日志在，却从来没有 summary.json。
    await seed(store, [{ id: "legacy" }]);
    store.loads.length = 0;

    const hub = lazyHub(store, { now: NOW });
    await hub.load();

    expect(store.loads).toEqual(["legacy"]);
    expect(hub.counts()).toEqual({ total: 2, hot: 0, archived: 0 });
    expect(hub.summary("legacy")?.phase).toBe("done");
    expect(hub.summary("fresh")?.phase).toBe("done");
    expect(parseSnapshot(await store.readSnapshot("legacy"), "legacy")).toBeDefined();
  });
});

describe("reading the side files at startup", () => {
  const MARK = { archivedAt: "2026-05-30T00:00:00.000Z", by: "user" } as const;

  /** 用懒加载启动过一次（写好快照）并把计数清零，之后的“重启”从它开始。 */
  async function startedOnceSlow(ids: readonly string[]): Promise<SlowReadStore> {
    const store = new SlowReadStore();
    await seed(store, ids.map((id) => ({ id })));
    await lazyHub(store, { now: NOW }).load();
    store.loads.length = 0;
    store.peak.snapshot = 0;
    store.peak.archive = 0;
    return store;
  }

  it("reads the snapshots and the archive marks of many sessions at most eight at a time", async () => {
    const store = await startedOnceSlow(Array.from({ length: 20 }, (_, index) => `s${String(index).padStart(2, "0")}`));

    const hub = lazyHub(store, { now: NOW });
    await hub.load();

    expect(hub.counts()).toEqual({ total: 20, hot: 0, archived: 0 });
    expect(store.loads).toEqual([]);
    expect(store.peak).toEqual({ snapshot: 8, archive: 8 });
  });

  it("replays only the session whose snapshot cannot be read, and trusts the others", async () => {
    const store = await startedOnceSlow(["a", "b", "c"]);
    store.unreadable.snapshot.add("b");
    const warn = vi.fn();

    const hub = lazyHub(store, { now: NOW }, { log: { ...silentLogger, warn } });
    await hub.load();

    expect(store.loads).toEqual(["b"]);
    expect(hub.counts()).toEqual({ total: 3, hot: 0, archived: 0 });
    expect(hub.summary("b")?.phase).toBe("done");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("session snapshot unreadable, replaying the log instead", expect.objectContaining({ sessionId: "b" }));
  });

  it("treats an archive mark that cannot be read as no mark, and still reads the others", async () => {
    const store = await startedOnceSlow(["a", "b", "c"]);
    for (const id of ["a", "b", "c"]) await store.writeArchive(id, MARK);
    store.unreadable.archive.add("b");
    const warn = vi.fn();

    const hub = lazyHub(store, { now: NOW }, { log: { ...silentLogger, warn } });
    await hub.load();

    expect(hub.archiveOf("a")).toEqual(MARK);
    expect(hub.archiveOf("b")).toBeUndefined();
    expect(hub.archiveOf("c")).toEqual(MARK);
    expect(hub.counts().archived).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("session archive mark unreadable, treating it as not archived", expect.objectContaining({ sessionId: "b" }));
  });
});
