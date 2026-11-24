/**
 * 事件中枢怎样对待冷会话：读它的事件不解冻它、写到它身上的事件不丢，以及删除冷会话；删除热会话放在同一处，与冷会话的删除对照。
 * 启动时的载入在 hub.history.test.ts；冻结与解冻在 hub.history.freeze.test.ts；归档标记与 mapPool 在 hub.history.archive.test.ts。
 */

import { describe, expect, it, vi } from "vitest";
import type { Notice } from "@shared/types";
import { lazyHub, MINUTE, NOW, seed, SpyStore } from "./history-fixtures";
import { iso, RECENT, startedOnce } from "./hub.history.fixtures";
import { silentLogger } from "./logger";

describe("reading the events of a cold session", () => {
  it("reads them from disk without thawing the session, and serves the next read from the cache", async () => {
    const store = new SpyStore();
    const written = await seed(store, [{ id: "a" }, { id: "b" }]);
    const hub = lazyHub(store, { now: NOW });
    await hub.load();
    store.loads.length = 0;

    expect(await hub.readEvents("a")).toEqual(written.get("a"));
    expect(hub.isHot("a")).toBe(false);
    expect(store.logReads).toEqual(["a"]);
    expect(store.loads).toEqual([]);

    await hub.readEvents("a", { afterSeq: 2 });
    expect(store.logReads).toEqual(["a"]);
  });

  it("slices by sequence number and by count, the same way for hot and cold sessions", async () => {
    const store = new SpyStore();
    const written = await seed(store, [{ id: "cold" }, { id: "hot", at: NOW - 5 * MINUTE }]);
    const hub = lazyHub(store, { now: NOW });
    await hub.load();
    expect(hub.isHot("cold")).toBe(false);
    expect(hub.isHot("hot")).toBe(true);

    for (const id of ["cold", "hot"]) {
      const all = written.get(id) ?? [];
      expect((await hub.readEvents(id, { afterSeq: 3 })).map((event) => event.seq), id).toEqual(all.filter((event) => event.seq > 3).map((event) => event.seq));
      expect((await hub.readEvents(id, { limit: 2 })).map((event) => event.seq), id).toEqual(all.slice(-2).map((event) => event.seq));
      expect((await hub.readEvents(id, { afterSeq: 3, limit: 1 })).map((event) => event.seq), id).toEqual([all.at(-1)?.seq]);
      expect(await hub.readEvents(id, { afterSeq: all.length }), id).toEqual([]);
    }
    expect(await hub.readEvents("missing")).toEqual([]);
  });

  it("merges simultaneous reads of the same log into one read from disk", async () => {
    const { store, clock } = await startedOnce([{ id: "a" }]);
    const hub = lazyHub(store, clock);
    await hub.load();
    await Promise.all([hub.readEvents("a"), hub.readEvents("a"), hub.readEvents("a")]);
    expect(store.logReads).toEqual(["a"]);
  });

  it("keeps only as many logs in the cache as it is allowed to, dropping the least recently read", async () => {
    const { store, clock } = await startedOnce([{ id: "a" }, { id: "b" }]);
    const hub = lazyHub(store, clock, { eventCache: { entries: 1, bytes: 1_000_000_000 } });
    await hub.load();
    await hub.readEvents("a");
    await hub.readEvents("b");
    await hub.readEvents("a");
    expect(store.logReads).toEqual(["a", "b", "a"]);
  });

  it("never serves a stale cached log after the session has been written to and frozen again", async () => {
    const { store, clock } = await startedOnce([{ id: "a" }]);
    const hub = lazyHub(store, clock);
    await hub.load();
    const original = await hub.readEvents("a");

    await hub.ensureHot("a");
    hub.emit("a", { kind: "diagnostic", data: { level: "info", code: "after", message: "Written while hot" }, source: "ensemble", at: iso(NOW) });
    clock.now = NOW + 11 * MINUTE;
    expect(await hub.sweep()).toBe(1);
    expect(hub.isHot("a")).toBe(false);

    const events = await hub.readEvents("a");
    expect(events).toHaveLength(original.length + 1);
    expect(events.at(-1)).toMatchObject({ kind: "diagnostic", data: { code: "after" } });
  });
});

describe("a write that reaches a cold session", () => {
  it("is not lost: the session is thawed first and the events are recorded in order, with a warning", async () => {
    const { store, clock } = await startedOnce([{ id: "a" }]);
    const warn = vi.fn();
    const hub = lazyHub(store, clock, { log: { ...silentLogger, warn } });
    await hub.load();
    const lastSeq = hub.summary("a")?.seq ?? 0;

    const first = hub.emit("a", { kind: "diagnostic", data: { level: "info", code: "first", message: "Written while cold" }, source: "ensemble" });
    const second = hub.emit("a", { kind: "diagnostic", data: { level: "info", code: "second", message: "Also written while cold" }, source: "ensemble" });
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("event written to a session that is not in memory; thawing it first", expect.objectContaining({ sessionId: "a", kind: "diagnostic" }));

    await hub.ensureHot("a");
    const tail = hub.events("a").slice(-2);
    expect(tail.map((event) => event.seq)).toEqual([lastSeq + 1, lastSeq + 2]);
    expect(tail.map((event) => (event.kind === "diagnostic" ? event.data.code : undefined))).toEqual(["first", "second"]);
    await hub.flush();
    expect((await store.load("a")).slice(-2).map((event) => event.seq)).toEqual([lastSeq + 1, lastSeq + 2]);
  });

  it("still counts a notice that arrived this way as undelivered: the thawed session is not frozen until it is delivered", async () => {
    const { store, clock } = await startedOnce([{ id: "a" }]);
    const hub = lazyHub(store, clock);
    await hub.load();
    const at = iso(NOW);
    const notice: Notice = { id: "ntc_1", originKey: "codex:thr_test", sessionId: "a", kind: "intervention", createdAt: at, summary: "The user sent a message." };

    expect(hub.emit("a", { kind: "notice.created", data: { notice }, source: "ensemble", at })).toBeUndefined();
    await hub.ensureHot("a");
    expect(hub.isHot("a")).toBe(true);

    clock.now = NOW + 11 * MINUTE;
    expect(await hub.sweep()).toBe(0);
    expect(hub.isHot("a")).toBe(true);

    hub.emit("a", { kind: "notice.delivered", data: { noticeIds: ["ntc_1"], messageIds: [], at }, source: "ensemble", at });
    // 送达本身也算一次动静：保温期从这里重新起算。
    clock.now = NOW + 22 * MINUTE;
    expect(await hub.sweep()).toBe(1);
    expect(hub.isHot("a")).toBe(false);
  });

  it("ignores a second session.created for a session that exists but is cold", async () => {
    const { store, clock } = await startedOnce([{ id: "a" }]);
    const warn = vi.fn();
    const hub = lazyHub(store, clock, { log: { ...silentLogger, warn } });
    await hub.load();
    const events = (await store.load("a")).length;

    const created = (await hub.readEvents("a"))[0];
    expect(created?.kind).toBe("session.created");
    if (created?.kind !== "session.created") return;
    expect(hub.emit("a", { kind: "session.created", data: created.data, source: "ensemble" })).toBeUndefined();

    expect(warn).toHaveBeenCalledWith("duplicate session.created ignored", { sessionId: "a" });
    expect(hub.isHot("a")).toBe(false);
    expect((await store.load("a")).length).toBe(events);
  });
});

describe("removing a cold session", () => {
  it("removes it and its side files, tells its parent, and leaves the rest alone", async () => {
    const { store, clock } = await startedOnce([{ id: "p" }, { id: "c", parent: "p" }, { id: "other" }]);
    const hub = lazyHub(store, clock);
    await hub.load();
    const listener = vi.fn();
    hub.subscribe(listener);

    await hub.remove("c");

    expect(hub.has("c")).toBe(false);
    expect(hub.counts().total).toBe(2);
    expect(hub.childIds("p")).toEqual([]);
    expect(hub.summary("p")?.childIds).toEqual([]);
    expect(await store.readSnapshot("c")).toBeUndefined();
    expect(await store.load("c")).toEqual([]);
    expect(await store.load("other")).not.toEqual([]);
    expect(listener).toHaveBeenCalledWith({ type: "removed", sessionId: "c" });
    expect(listener).toHaveBeenCalledWith({ type: "relationship", sessionId: "p" });
  });
});

describe("removing a hot session", () => {
  it("forgets all of it at once, so a new session with the same id starts with nothing left over", async () => {
    const store = new SpyStore();
    await seed(store, [RECENT("a")]);
    const hub = lazyHub(store, { now: NOW });
    await hub.load();
    const created = hub.events("a")[0];
    if (created?.kind !== "session.created") throw new Error("the first event of a session is session.created");
    const at = iso(NOW);
    const notice: Notice = { id: "ntc_1", originKey: "codex:thr_test", sessionId: "a", kind: "intervention", createdAt: at, summary: "The user sent a message." };
    hub.emit("a", { kind: "notice.created", data: { notice }, source: "ensemble", at });
    hub.setAttention("a", [{ kind: "long_run", since: at }]);
    expect(hub.attentionOf("a")).toHaveLength(1);

    await hub.remove("a");

    expect(hub.has("a")).toBe(false);
    expect(hub.isHot("a")).toBe(false);
    expect(hub.state("a")).toBeUndefined();
    expect(hub.events("a")).toEqual([]);
    expect(hub.attentionOf("a")).toEqual([]);
    expect(hub.counts()).toEqual({ total: 0, hot: 0, archived: 0 });

    hub.emit("a", { kind: "session.created", data: created.data, source: "ensemble", at });
    expect(hub.events("a").map((event) => event.seq)).toEqual([1]);
    expect(hub.attentionOf("a")).toEqual([]);
    expect(hub.summary("a")?.attention).toBeUndefined();
    expect(hub.summary("a")?.seq).toBe(1);
  });
});
