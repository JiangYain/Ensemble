import { describe, expect, it } from "vitest";
import type { EventPayload } from "./events";
import { replay, toSummary } from "./projection";
import { EventLog, USER } from "./testing";

type Relink = Extract<EventPayload, { kind: "session.relinked" }>["data"];

function relink(log: EventLog, data: Partial<Relink> & Pick<Relink, "parentSessionId" | "depth">): void {
  log.push(
    { kind: "session.relinked", data: { previous: { depth: 0 }, cause: "self", by: USER, ...data } },
    { source: "user" },
  );
}

describe("a session created with several parents", () => {
  it("keeps the whole ordered set in its meta and summary, and the first one as the primary parent", () => {
    const log = new EventLog("ses_join");
    log.created({ parentSessionId: "ses_a", parentSessionIds: ["ses_a", "ses_b"], depth: 1 });

    const state = replay(log.events)!;
    expect(state.meta).toMatchObject({ parentSessionId: "ses_a", parentSessionIds: ["ses_a", "ses_b"], depth: 1 });
    expect(toSummary(state, [])).toMatchObject({ parentSessionId: "ses_a", parentSessionIds: ["ses_a", "ses_b"] });
  });

  it("has no parentSessionIds in its summary when there is only one parent, exactly as before", () => {
    const log = new EventLog("ses_one");
    log.created({ parentSessionId: "ses_a", depth: 1 });

    const summary = toSummary(replay(log.events)!, []);
    expect(summary.parentSessionId).toBe("ses_a");
    expect("parentSessionIds" in summary).toBe(false);
  });

  it("does not hand out the meta's own array through the summary", () => {
    const log = new EventLog("ses_join");
    log.created({ parentSessionId: "ses_a", parentSessionIds: ["ses_a", "ses_b"], depth: 1 });

    const state = replay(log.events)!;
    const summary = toSummary(state, []);
    summary.parentSessionIds?.push("ses_c");
    expect(state.meta.parentSessionIds).toEqual(["ses_a", "ses_b"]);
  });
});

describe("session.relinked with several parents", () => {
  it("replaces the parents with the whole set the event carries", () => {
    const log = new EventLog("ses_join");
    log.created();
    relink(log, { parentSessionId: "ses_a", parentSessionIds: ["ses_a", "ses_b"], depth: 1 });

    const state = replay(log.events)!;
    expect(state.meta).toMatchObject({ parentSessionId: "ses_a", parentSessionIds: ["ses_a", "ses_b"], depth: 1 });
    expect(toSummary(state, []).parentSessionIds).toEqual(["ses_a", "ses_b"]);
  });

  it("goes back to a single parent without leaving the old set behind", () => {
    const log = new EventLog("ses_join");
    log.created({ parentSessionId: "ses_a", parentSessionIds: ["ses_a", "ses_b"], depth: 1 });
    relink(log, {
      parentSessionId: "ses_b",
      depth: 1,
      previous: { parentSessionId: "ses_a", parentSessionIds: ["ses_a", "ses_b"], depth: 1 },
    });

    const state = replay(log.events)!;
    expect(state.meta.parentSessionId).toBe("ses_b");
    expect("parentSessionIds" in state.meta).toBe(false);
    expect("parentSessionIds" in toSummary(state, [])).toBe(false);
  });

  it("goes back to no parent at all, with neither field left behind", () => {
    const log = new EventLog("ses_join");
    log.created({ parentSessionId: "ses_a", parentSessionIds: ["ses_a", "ses_b"], depth: 1 });
    relink(log, { parentSessionId: null, depth: 0, previous: { parentSessionId: "ses_a", parentSessionIds: ["ses_a", "ses_b"], depth: 1 } });

    const state = replay(log.events)!;
    expect("parentSessionId" in state.meta).toBe(false);
    expect("parentSessionIds" in state.meta).toBe(false);
    expect(state.meta.depth).toBe(0);
  });

  it("keeps the set and changes only the depth when an ancestor was moved", () => {
    const log = new EventLog("ses_join");
    log.created({ parentSessionId: "ses_a", parentSessionIds: ["ses_a", "ses_b"], depth: 1 });
    relink(log, {
      parentSessionId: "ses_a",
      parentSessionIds: ["ses_a", "ses_b"],
      depth: 2,
      previous: { parentSessionId: "ses_a", parentSessionIds: ["ses_a", "ses_b"], depth: 1 },
      cause: "ancestor",
    });

    expect(replay(log.events)!.meta).toMatchObject({ parentSessionId: "ses_a", parentSessionIds: ["ses_a", "ses_b"], depth: 2 });
  });

  it("turns a single parent into several and back, replaying to the same relation as applying the events one by one", () => {
    const log = new EventLog("ses_join");
    log.created({ parentSessionId: "ses_a", depth: 1 });
    relink(log, { parentSessionId: "ses_a", parentSessionIds: ["ses_a", "ses_b"], depth: 2, previous: { parentSessionId: "ses_a", depth: 1 } });
    const joined = replay(log.events)!;
    expect(joined.meta.parentSessionIds).toEqual(["ses_a", "ses_b"]);

    relink(log, { parentSessionId: "ses_a", depth: 1, previous: { parentSessionId: "ses_a", parentSessionIds: ["ses_a", "ses_b"], depth: 2 } });
    const single = replay(log.events)!;
    expect(single.meta.parentSessionId).toBe("ses_a");
    expect("parentSessionIds" in single.meta).toBe(false);
    expect(single.seq).toBe(log.events.length);
  });

  it("reads an old record (only parentSessionId, no parentSessionIds) as one parent", () => {
    const log = new EventLog("ses_old");
    log.created();
    relink(log, { parentSessionId: "ses_review", depth: 1 });

    const state = replay(log.events)!;
    expect(state.meta.parentSessionId).toBe("ses_review");
    expect("parentSessionIds" in state.meta).toBe(false);
  });
});
