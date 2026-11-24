import { describe, expect, it } from "vitest";
import type { EnsembleEvent } from "@shared/events";
import { sessionEvents } from "./history-fixtures";
import { EventCache } from "./event-cache";

function eventsOf(id: string): EnsembleEvent[] {
  return sessionEvents({ id });
}

describe("EventCache", () => {
  it("returns what was stored for the same log size", () => {
    const cache = new EventCache(4, 1_000);
    const events = eventsOf("a");
    cache.set("a", 100, 100, events);
    expect(cache.get("a", 100)).toBe(events);
    expect(cache.get("b", 100)).toBeUndefined();
  });

  it("drops an entry whose log has changed since it was read", () => {
    const cache = new EventCache(4, 1_000);
    cache.set("a", 100, 100, eventsOf("a"));
    expect(cache.get("a", 101)).toBeUndefined();
    // 作废的一条已经被丢掉，不会占着名额与字节。
    expect(cache.has("a")).toBe(false);
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });

  it("evicts the least recently used entry once there are too many", () => {
    const cache = new EventCache(2, 1_000);
    cache.set("a", 1, 10, eventsOf("a"));
    cache.set("b", 1, 10, eventsOf("b"));
    // 看一眼 a：它变成最近用过的，下一个被挤掉的是 b。
    expect(cache.get("a", 1)).toBeDefined();
    cache.set("c", 1, 10, eventsOf("c"));
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
    expect(cache.size).toBe(2);
  });

  it("evicts from the oldest when the total size is over the byte limit", () => {
    const cache = new EventCache(10, 100);
    cache.set("a", 1, 40, eventsOf("a"));
    cache.set("b", 1, 40, eventsOf("b"));
    cache.set("c", 1, 40, eventsOf("c"));
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
    expect(cache.has("c")).toBe(true);
    expect(cache.bytes).toBe(80);
  });

  it("does not keep a single log that is bigger than the whole byte limit", () => {
    const cache = new EventCache(10, 100);
    cache.set("small", 1, 10, eventsOf("small"));
    cache.set("huge", 1, 101, eventsOf("huge"));
    expect(cache.has("huge")).toBe(false);
    // 放不下的那一条不会顺带把别人挤出去。
    expect(cache.has("small")).toBe(true);
    expect(cache.bytes).toBe(10);
  });

  it("replaces an entry stored again under the same session and keeps the accounting right", () => {
    const cache = new EventCache(4, 1_000);
    cache.set("a", 1, 100, eventsOf("a"));
    const newer = eventsOf("a");
    cache.set("a", 2, 30, newer);
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(30);
    expect(cache.get("a", 1)).toBeUndefined();
    cache.set("a", 2, 30, newer);
    expect(cache.get("a", 2)).toBe(newer);
  });

  it("gives back the space of a deleted entry, and ignores deleting something that is not there", () => {
    const cache = new EventCache(4, 1_000);
    cache.set("a", 1, 100, eventsOf("a"));
    cache.set("b", 1, 50, eventsOf("b"));
    cache.delete("a");
    cache.delete("nope");
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(50);
  });

  it("caches nothing when the entry limit is zero", () => {
    const cache = new EventCache(0, 1_000);
    cache.set("a", 1, 10, eventsOf("a"));
    expect(cache.size).toBe(0);
    expect(cache.get("a", 1)).toBeUndefined();
  });
});
