import { describe, expect, it } from "vitest";
import { testMeta, USER } from "@shared/testing";
import type { SessionId, SessionMeta } from "@shared/types";
import { EventHub, type HubChange } from "./hub";
import { silentLogger } from "./logger";
import { MemoryEventStore } from "./store";

function makeHub(store = new MemoryEventStore()): EventHub {
  return new EventHub({ store, log: silentLogger, coalesceMs: 0 });
}

let clock = Date.parse("2026-01-01T00:00:00.000Z");

/** 按调用顺序递增创建时间，childIds 的次序才可预期。 */
function create(hub: EventHub, id: SessionId, extra: Partial<SessionMeta> = {}): void {
  clock += 1000;
  const createdAt = new Date(clock).toISOString();
  hub.emit(id, { kind: "session.created", data: { meta: testMeta({ id, createdAt, ...extra }) }, source: "ensemble", at: createdAt });
}

/** hub 只忠实地登记事件（校验在 manager）：这里按调用者写的值照搬。 */
function relink(hub: EventHub, id: SessionId, parent: SessionId | null, depth: number): void {
  const state = hub.state(id)!;
  hub.emit(id, {
    kind: "session.relinked",
    data: {
      parentSessionId: parent,
      depth,
      previous: { ...(state.meta.parentSessionId ? { parentSessionId: state.meta.parentSessionId } : {}), depth: state.meta.depth },
      cause: "self",
      by: USER,
    },
    source: "user",
  });
}

describe("hub children table", () => {
  it("follows a session that was moved to another parent and back to none", () => {
    const hub = makeHub();
    create(hub, "ses_a");
    create(hub, "ses_b");
    create(hub, "ses_a1", { parentSessionId: "ses_a", depth: 1 });
    expect(hub.childIds("ses_a")).toEqual(["ses_a1"]);

    relink(hub, "ses_a1", "ses_b", 1);
    expect(hub.childIds("ses_a")).toEqual([]);
    expect(hub.childIds("ses_b")).toEqual(["ses_a1"]);
    expect(hub.summary("ses_b")?.childIds).toEqual(["ses_a1"]);
    expect(hub.summary("ses_a1")).toMatchObject({ parentSessionId: "ses_b", depth: 1 });

    relink(hub, "ses_a1", null, 0);
    expect(hub.childIds("ses_b")).toEqual([]);
    const summary = hub.summary("ses_a1")!;
    expect("parentSessionId" in summary).toBe(false);
    expect(summary.depth).toBe(0);
  });

  it("tells subscribers about the moved session and both parents, with the new table already in place", () => {
    const hub = makeHub();
    create(hub, "ses_a");
    create(hub, "ses_b");
    create(hub, "ses_a1", { parentSessionId: "ses_a", depth: 1 });

    const changes: HubChange[] = [];
    const seenByB: SessionId[][] = [];
    hub.subscribe((change) => {
      changes.push(change);
      seenByB.push(hub.summary("ses_b")?.childIds ?? []);
    });
    relink(hub, "ses_a1", "ses_b", 1);

    expect(changes.map((change) => (change.type === "event" ? `event:${change.event.kind}:${change.event.sessionId}` : `${change.type}:${change.sessionId}`))).toEqual([
      "event:session.relinked:ses_a1",
      "relationship:ses_a",
      "relationship:ses_b",
    ]);
    expect(seenByB.every((ids) => ids.includes("ses_a1"))).toBe(true);
  });

  it("does not announce parents when only the depth changed", () => {
    const hub = makeHub();
    create(hub, "ses_a");
    create(hub, "ses_a1", { parentSessionId: "ses_a", depth: 1 });
    const changes: HubChange[] = [];
    hub.subscribe((change) => changes.push(change));
    const state = hub.state("ses_a1")!;
    hub.emit("ses_a1", {
      kind: "session.relinked",
      data: { parentSessionId: "ses_a", depth: 2, previous: { parentSessionId: "ses_a", depth: state.meta.depth }, cause: "ancestor", by: USER },
      source: "user",
    });
    expect(changes.map((change) => change.type)).toEqual(["event"]);
    expect(hub.childIds("ses_a")).toEqual(["ses_a1"]);
  });

  it("keeps children in creation order whichever order they were linked in", () => {
    const hub = makeHub();
    create(hub, "ses_b");
    create(hub, "ses_c1");
    create(hub, "ses_c2");
    relink(hub, "ses_c2", "ses_b", 1);
    relink(hub, "ses_c1", "ses_b", 1);
    expect(hub.childIds("ses_b")).toEqual(["ses_c1", "ses_c2"]);
  });
});

describe("summary cache", () => {
  it("does not serve a stale child list when two parents trade a child each (same counts)", () => {
    const hub = makeHub();
    create(hub, "ses_a");
    create(hub, "ses_b");
    create(hub, "ses_a1", { parentSessionId: "ses_a", depth: 1 });
    create(hub, "ses_b1", { parentSessionId: "ses_b", depth: 1 });
    // 先把两个上级的摘要读进缓存：之后它们自己没有新事件，数量也都还是 1。
    expect(hub.summary("ses_a")?.childIds).toEqual(["ses_a1"]);
    expect(hub.summary("ses_b")?.childIds).toEqual(["ses_b1"]);

    hub.batch(() => {
      relink(hub, "ses_a1", "ses_b", 1);
      relink(hub, "ses_b1", "ses_a", 1);
    });

    expect(hub.summary("ses_a")?.childIds).toEqual(["ses_b1"]);
    expect(hub.summary("ses_b")?.childIds).toEqual(["ses_a1"]);
    expect(hub.allSummaries().find((summary) => summary.id === "ses_a")?.childIds).toEqual(["ses_b1"]);
  });
});

describe("replay and removal", () => {
  it("loads the same relations from the stored logs as the live hub had", async () => {
    const store = new MemoryEventStore();
    const live = makeHub(store);
    create(live, "ses_review");
    create(live, "ses_fix1");
    create(live, "ses_fix2");
    create(live, "ses_sub", { parentSessionId: "ses_fix2", depth: 1 });
    live.batch(() => {
      relink(live, "ses_fix2", "ses_review", 1);
      live.emit("ses_sub", {
        kind: "session.relinked",
        data: { parentSessionId: "ses_fix2", depth: 2, previous: { parentSessionId: "ses_fix2", depth: 1 }, cause: "ancestor", by: USER },
        source: "user",
      });
    });
    relink(live, "ses_fix1", "ses_review", 1);
    relink(live, "ses_fix1", null, 0);

    const reloaded = makeHub(store);
    await reloaded.load();
    const relation = (hub: EventHub) =>
      hub.allSummaries().map(({ id, parentSessionId, childIds, depth, seq }) => ({ id, parentSessionId, childIds, depth, seq }));
    expect(relation(reloaded)).toEqual(relation(live));
    expect(reloaded.childIds("ses_review")).toEqual(["ses_fix2"]);
    expect(reloaded.state("ses_sub")?.meta).toMatchObject({ parentSessionId: "ses_fix2", depth: 2 });
    expect("parentSessionId" in reloaded.state("ses_fix1")!.meta).toBe(false);
  });

  it("removes a moved session from the parent it has now, and drops the table of a removed parent", async () => {
    const hub = makeHub();
    create(hub, "ses_p");
    create(hub, "ses_q");
    create(hub, "ses_c", { parentSessionId: "ses_p", depth: 1 });
    relink(hub, "ses_c", "ses_q", 1);

    await hub.remove("ses_c");
    expect(hub.childIds("ses_q")).toEqual([]);
    expect(hub.childIds("ses_p")).toEqual([]);

    create(hub, "ses_d", { parentSessionId: "ses_q", depth: 1 });
    await hub.remove("ses_q");
    expect(hub.childIds("ses_q")).toEqual([]);
    // 子会话自己仍记着那个上级；上级已不在，页面据此提示“上级会话已不存在”。
    expect(hub.summary("ses_d")?.parentSessionId).toBe("ses_q");
  });
});
