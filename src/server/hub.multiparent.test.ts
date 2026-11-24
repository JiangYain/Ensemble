import { describe, expect, it } from "vitest";
import { parentFields } from "@shared/lineage";
import { testMeta, USER } from "@shared/testing";
import type { SessionId, SessionMeta } from "@shared/types";
import { lazyHub, NOW, seed, SpyStore, type SessionFixture } from "./history-fixtures";
import { EventHub, type HubChange } from "./hub";
import { silentLogger } from "./logger";
import { parseSnapshot } from "./snapshot";
import { MemoryEventStore } from "./store";

/**
 * 汇聚（一个会话跟随多个上级）在事件中枢里的样子：子会话表、关系通知、重放与冷会话的快照。
 * 只有一个上级的会话与原来完全一样，由 hub.relink.test.ts 与 hub.history*.test.ts 守着。
 */

function makeHub(store = new MemoryEventStore()): EventHub {
  return new EventHub({ store, log: silentLogger, coalesceMs: 0 });
}

let clock = Date.parse("2026-01-01T00:00:00.000Z");

/** 按调用顺序递增创建时间，childIds 的次序才可预期。 */
function create(hub: EventHub, id: SessionId, parents: readonly SessionId[] = [], depth = parents.length > 0 ? 1 : 0, extra: Partial<SessionMeta> = {}): void {
  clock += 1000;
  const createdAt = new Date(clock).toISOString();
  hub.emit(id, { kind: "session.created", data: { meta: testMeta({ id, createdAt, depth, ...parentFields(parents), ...extra }) }, source: "ensemble", at: createdAt });
}

/** hub 只忠实地登记事件（校验在 manager）：这里按调用者写的值照搬，一次写整组上级。 */
function relink(hub: EventHub, id: SessionId, parents: readonly SessionId[], depth: number): void {
  const before = hub.state(id)!.meta;
  const after = parentFields(parents);
  hub.emit(id, {
    kind: "session.relinked",
    data: {
      parentSessionId: after.parentSessionId ?? null,
      ...(after.parentSessionIds ? { parentSessionIds: after.parentSessionIds } : {}),
      depth,
      previous: {
        ...(before.parentSessionId ? { parentSessionId: before.parentSessionId } : {}),
        ...(before.parentSessionIds ? { parentSessionIds: before.parentSessionIds } : {}),
        depth: before.depth,
      },
      cause: "self",
      by: USER,
    },
    source: "user",
  });
}

const describeChange = (change: HubChange): string => (change.type === "event" ? `event:${change.event.kind}:${change.event.sessionId}` : `${change.type}:${change.sessionId}`);

describe("the children table of a join", () => {
  it("lists the join under every one of its parents, once, and the summaries agree", () => {
    const hub = makeHub();
    create(hub, "ses_a");
    create(hub, "ses_b");
    create(hub, "ses_j", ["ses_a", "ses_b"]);

    expect(hub.childIds("ses_a")).toEqual(["ses_j"]);
    expect(hub.childIds("ses_b")).toEqual(["ses_j"]);
    expect(hub.summary("ses_a")?.childIds).toEqual(["ses_j"]);
    expect(hub.summary("ses_b")?.childIds).toEqual(["ses_j"]);
    expect(hub.summary("ses_j")).toMatchObject({ parentSessionId: "ses_a", parentSessionIds: ["ses_a", "ses_b"], depth: 1 });
    expect(hub.node("ses_j")).toMatchObject({ parentSessionId: "ses_a", parentSessionIds: ["ses_a", "ses_b"], depth: 1 });
  });

  it("gives a session with one parent the same node and summary as always, with no parentSessionIds", () => {
    const hub = makeHub();
    create(hub, "ses_a");
    create(hub, "ses_c", ["ses_a"]);

    expect("parentSessionIds" in hub.summary("ses_c")!).toBe(false);
    expect("parentSessionIds" in hub.node("ses_c")!).toBe(false);
  });

  it("tells every parent about a join when it is created, with the table already in place", () => {
    const hub = makeHub();
    create(hub, "ses_a");
    create(hub, "ses_b");
    const changes: HubChange[] = [];
    const seen: SessionId[][] = [];
    hub.subscribe((change) => {
      changes.push(change);
      seen.push([...(hub.summary("ses_b")?.childIds ?? [])]);
    });

    create(hub, "ses_j", ["ses_a", "ses_b"]);

    expect(changes.map(describeChange)).toEqual(["event:session.created:ses_j", "relationship:ses_a", "relationship:ses_b"]);
    expect(seen.every((ids) => ids.includes("ses_j"))).toBe(true);
  });

  it("keeps a join among the children in creation order, with the other children of the same parent", () => {
    const hub = makeHub();
    create(hub, "ses_a");
    create(hub, "ses_b");
    create(hub, "ses_c1", ["ses_a"]);
    create(hub, "ses_j", ["ses_a", "ses_b"]);
    create(hub, "ses_c2", ["ses_a"]);

    expect(hub.childIds("ses_a")).toEqual(["ses_c1", "ses_j", "ses_c2"]);
    expect(hub.childIds("ses_b")).toEqual(["ses_j"]);
  });
});

describe("relinking a join", () => {
  it("only announces the parents whose children really changed", () => {
    const hub = makeHub();
    create(hub, "ses_a");
    create(hub, "ses_b");
    create(hub, "ses_c");
    create(hub, "ses_j", ["ses_a", "ses_b"]);
    const changes: HubChange[] = [];
    hub.subscribe((change) => changes.push(change));

    // [a, b] → [b]：只有 a 少了一个子会话，b 仍然有它。
    relink(hub, "ses_j", ["ses_b"], 1);
    expect(changes.map(describeChange)).toEqual(["event:session.relinked:ses_j", "relationship:ses_a"]);
    expect(hub.childIds("ses_a")).toEqual([]);
    expect(hub.childIds("ses_b")).toEqual(["ses_j"]);

    // [b] → [b, c]：只有 c 多了一个。
    changes.length = 0;
    relink(hub, "ses_j", ["ses_b", "ses_c"], 1);
    expect(changes.map(describeChange)).toEqual(["event:session.relinked:ses_j", "relationship:ses_c"]);
    expect(hub.childIds("ses_c")).toEqual(["ses_j"]);

    // 只换先后（换了主上级）：子会话表没有变，谁也不用通知。
    changes.length = 0;
    relink(hub, "ses_j", ["ses_c", "ses_b"], 1);
    expect(changes.map(describeChange)).toEqual(["event:session.relinked:ses_j"]);
    expect(hub.summary("ses_j")).toMatchObject({ parentSessionId: "ses_c", parentSessionIds: ["ses_c", "ses_b"] });
  });

  it("drops the old set when it goes back to one parent, and the summary says so", () => {
    const hub = makeHub();
    create(hub, "ses_a");
    create(hub, "ses_b");
    create(hub, "ses_j", ["ses_a", "ses_b"]);

    relink(hub, "ses_j", ["ses_a"], 1);

    const summary = hub.summary("ses_j")!;
    expect(summary.parentSessionId).toBe("ses_a");
    expect("parentSessionIds" in summary).toBe(false);
    expect(hub.summary("ses_b")?.childIds).toEqual([]);
  });

  it("does not serve a stale child list from the summary cache when a join moves between parents", () => {
    const hub = makeHub();
    create(hub, "ses_a");
    create(hub, "ses_b");
    create(hub, "ses_c");
    create(hub, "ses_j", ["ses_a", "ses_b"]);
    // 先把各个上级的摘要读进缓存。
    for (const id of ["ses_a", "ses_b", "ses_c"]) hub.summary(id);

    relink(hub, "ses_j", ["ses_b", "ses_c"], 1);

    expect(hub.summary("ses_a")?.childIds).toEqual([]);
    expect(hub.summary("ses_b")?.childIds).toEqual(["ses_j"]);
    expect(hub.summary("ses_c")?.childIds).toEqual(["ses_j"]);
  });
});

describe("replay and removal with a join", () => {
  it("loads the same relations from the stored logs as the live hub had", async () => {
    const store = new MemoryEventStore();
    const live = makeHub(store);
    create(live, "ses_a");
    create(live, "ses_b");
    create(live, "ses_c");
    create(live, "ses_j", ["ses_a", "ses_b"]);
    create(live, "ses_k", ["ses_c"]);
    relink(live, "ses_k", ["ses_a", "ses_c"], 1);
    relink(live, "ses_j", ["ses_b"], 1);

    const reloaded = makeHub(store);
    await reloaded.load();
    const relation = (hub: EventHub) =>
      hub.allSummaries().map(({ id, parentSessionId, parentSessionIds, childIds, depth, seq }) => ({ id, parentSessionId, parentSessionIds, childIds, depth, seq }));
    expect(relation(reloaded)).toEqual(relation(live));
    expect(reloaded.childIds("ses_a")).toEqual(["ses_k"]);
    expect(reloaded.summary("ses_k")?.parentSessionIds).toEqual(["ses_a", "ses_c"]);
    expect("parentSessionIds" in reloaded.summary("ses_j")!).toBe(false);
  });

  it("takes a removed join out of every parent's table and tells each of them", async () => {
    const hub = makeHub();
    create(hub, "ses_a");
    create(hub, "ses_b");
    create(hub, "ses_j", ["ses_a", "ses_b"]);
    const changes: HubChange[] = [];
    hub.subscribe((change) => changes.push(change));

    await hub.remove("ses_j");

    expect(hub.childIds("ses_a")).toEqual([]);
    expect(hub.childIds("ses_b")).toEqual([]);
    expect(changes.map(describeChange)).toEqual(["removed:ses_j", "relationship:ses_a", "relationship:ses_b"]);
  });

  it("keeps the join, and what it records, when one of its parents is removed", async () => {
    const hub = makeHub();
    create(hub, "ses_a");
    create(hub, "ses_b");
    create(hub, "ses_j", ["ses_a", "ses_b"]);

    await hub.remove("ses_a");

    expect(hub.childIds("ses_a")).toEqual([]);
    expect(hub.childIds("ses_b")).toEqual(["ses_j"]);
    // 记录仍写着两个上级，页面据此提示“其中一个已不存在”，而不是悄悄改写。
    expect(hub.summary("ses_j")?.parentSessionIds).toEqual(["ses_a", "ses_b"]);
  });
});

describe("a join among cold sessions", () => {
  const FIXTURES: SessionFixture[] = [
    { id: "a", at: NOW - 30 * 86_400_000 },
    { id: "b", at: NOW - 29 * 86_400_000 },
    { id: "j", at: NOW - 28 * 86_400_000, meta: { parentSessionId: "a", parentSessionIds: ["a", "b"], depth: 1 } },
    { id: "c", at: NOW - 27 * 86_400_000, parent: "a" },
  ];

  it("writes the whole parent set into the snapshot and gets it back on the next start without reading a log", async () => {
    const store = new SpyStore();
    await seed(store, FIXTURES);
    const first = lazyHub(store, { now: NOW });
    await first.load();
    const before = first.allSummaries();
    expect(parseSnapshot(await store.readSnapshot("j"), "j")?.summary.parentSessionIds).toEqual(["a", "b"]);
    store.loads.length = 0;

    const second = lazyHub(store, { now: NOW });
    await second.load();

    expect(store.loads).toEqual([]);
    expect(store.logReads).toEqual([]);
    expect(second.allSummaries()).toEqual(before);
    expect(second.summary("j")).toMatchObject({ parentSessionId: "a", parentSessionIds: ["a", "b"] });
    expect(second.childIds("a")).toEqual(["j", "c"]);
    expect(second.childIds("b")).toEqual(["j"]);
  });

  it("does not put a parentSessionIds into the snapshot of a session with one parent", async () => {
    const store = new SpyStore();
    await seed(store, FIXTURES);
    await lazyHub(store, { now: NOW }).load();

    const summary = parseSnapshot(await store.readSnapshot("c"), "c")?.summary;
    expect(summary?.parentSessionId).toBe("a");
    expect(summary !== undefined && "parentSessionIds" in summary).toBe(false);
  });

  it("answers questions about a cold join's parents from the index, without thawing anyone", async () => {
    const store = new SpyStore();
    await seed(store, FIXTURES);
    const hub = lazyHub(store, { now: NOW });
    await hub.load();
    store.loads.length = 0;

    expect(hub.node("j")).toMatchObject({ parentSessionId: "a", parentSessionIds: ["a", "b"], depth: 1 });
    expect(hub.childIds("b")).toEqual(["j"]);
    expect(store.loads).toEqual([]);
    expect(hub.isHot("j")).toBe(false);
  });
});
