import { describe, expect, it } from "vitest";
import { deriveAttention } from "./attention";
import { LIMITS } from "./constants";
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

describe("session.relinked", () => {
  it("records a later parent in the session's own log and replays to the same relation", () => {
    const log = new EventLog("ses_fix");
    log.created();
    log.message("msg_1", "task", "Fix R4");
    relink(log, { parentSessionId: "ses_review", depth: 1 });

    const state = replay(log.events)!;
    expect(state.meta).toMatchObject({ parentSessionId: "ses_review", depth: 1 });
    expect(toSummary(state, [])).toMatchObject({ parentSessionId: "ses_review", depth: 1 });
    // 同一份日志逐条应用与整体重放结果一致，页面上实时应用的事件也就不会和重新读取的不同。
    const first = replay(log.events.slice(0, 2))!;
    expect(first.meta.parentSessionId).toBeUndefined();
    expect(state.seq).toBe(log.events.length);
  });

  it("removes the link on null instead of leaving a null behind", () => {
    const log = new EventLog("ses_fix");
    log.created({ parentSessionId: "ses_review", depth: 1 });
    relink(log, { parentSessionId: null, depth: 0, previous: { parentSessionId: "ses_review", depth: 1 } });

    const state = replay(log.events)!;
    expect("parentSessionId" in state.meta).toBe(false);
    expect(state.meta.depth).toBe(0);
    expect("parentSessionId" in toSummary(state, [])).toBe(false);
  });

  it("changes only the depth when an ancestor was moved", () => {
    const log = new EventLog("ses_grandchild");
    log.created({ parentSessionId: "ses_fix", depth: 1 });
    relink(log, { parentSessionId: "ses_fix", depth: 2, previous: { parentSessionId: "ses_fix", depth: 1 }, cause: "ancestor" });

    expect(replay(log.events)!.meta).toMatchObject({ parentSessionId: "ses_fix", depth: 2 });
  });

  it("leaves a log that never has the event exactly as it was created", () => {
    const log = new EventLog("ses_old");
    log.created({ parentSessionId: "ses_parent", depth: 1 });
    log.message("msg_1", "task", "Old session");
    expect(replay(log.events)!.meta).toMatchObject({ parentSessionId: "ses_parent", depth: 1 });
  });

  it("is a record of the relation, not activity of the session", () => {
    const log = new EventLog("ses_fix");
    log.created();
    log.message("msg_1", "task", "Fix R4");
    log.run("run_1", 1, "msg_1");
    log.startRun("run_1");
    const before = replay(log.events)!;
    const lastActivity = before.updatedAt;

    log.tick(LIMITS.attention.quietMs - 1_000);
    relink(log, { parentSessionId: "ses_review", depth: 1 });
    const state = replay(log.events)!;

    expect(state.seq).toBe(before.seq + 1);
    expect(state.updatedAt).toBe(lastActivity);
    expect(state.activity).toEqual(before.activity);
    expect(toSummary(state, []).updatedAt).toBe(lastActivity);

    // “静默了多久”以会话自己最后一次活动为准：登记关系不能把一个已经静默的会话变成“刚刚有动静”。
    const now = Date.parse(lastActivity) + LIMITS.attention.quietMs + 1_000;
    const quiet = deriveAttention(state, now).filter((item) => item.kind === "quiet");
    expect(quiet).toEqual([expect.objectContaining({ since: lastActivity })]);
  });
});
