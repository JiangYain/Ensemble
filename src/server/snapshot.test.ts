import { describe, expect, it } from "vitest";
import { replay, toSummary, type SessionState } from "@shared/projection";
import type { SessionSummary } from "@shared/types";
import { sessionEvents, type Ending } from "./history-fixtures";
import { buildSnapshot, isStableState, isStableSummary, parseSnapshot, SNAPSHOT_FORMAT, SUMMARY_FIELDS } from "./snapshot";

function stateOf(ending: Ending, id = "ses_a"): SessionState {
  const state = replay(sessionEvents({ id, ending }));
  if (!state) throw new Error("fixture has no session.created");
  return state;
}

/** 经过一次 JSON 往返，就像它被写进 summary.json 再读回来。 */
function roundTrip<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("the snapshot format is pinned to the summary shape", () => {
  it("lists exactly the fields of SessionSummary; changing them means bumping SNAPSHOT_FORMAT and updating this test", () => {
    // SUMMARY_FIELDS 在类型层面与 SessionSummary 逐项对应；这里再把字段名与版本号一起钉住：
    // 改摘要字段的人会在这里失败，然后读到 snapshot.ts 里“版本加一”的说明。
    expect(Object.keys(SUMMARY_FIELDS).sort()).toEqual([
      "access", "accessEnforcement", "activeRunId", "activity", "archivedAt", "archivedBy", "attention", "capabilities", "childIds",
      "counters", "createdAt", "cwd", "depth", "effort", "endedAt", "harness", "id", "lastAssistantPreview", "lastError", "lastRun",
      "messages", "model", "nativeRef", "openQuestions", "origin", "parentSessionId", "parentSessionIds", "phase", "progress", "runCount", "runtime", "seq",
      "startedAt", "status", "taskPreview", "title", "updatedAt", "usage",
    ].sort());
    // 版本 2 是 parentSessionIds（汇聚，多于一个上级时才有）加进来之后升的：旧服务重放汇聚会话后写出的版本 1 快照不带它，
    // 版本号不变的话新服务会采信那一份（见 snapshot.ts 的版本记录，以及 snapshot.version.test.ts）。
    expect(SNAPSHOT_FORMAT).toBe(2);
  });

  it("covers every field that toSummary actually produces", () => {
    for (const ending of ["done", "failed", "running", "ready", "pending"] as const) {
      const produced = Object.keys(toSummary(stateOf(ending)));
      for (const key of produced) expect(Object.hasOwn(SUMMARY_FIELDS, key), `${ending}: ${key}`).toBe(true);
    }
  });
});

describe("buildSnapshot / parseSnapshot", () => {
  it("records the sequence number, the log size and when it was written", () => {
    const state = stateOf("done");
    const snapshot = buildSnapshot(state, 4096, 0, "2026-06-01T00:00:00.000Z");
    expect(snapshot).toMatchObject({
      format: SNAPSHOT_FORMAT,
      sessionId: "ses_a",
      lastSeq: state.seq,
      logBytes: 4096,
      undeliveredNotices: 0,
      writtenAt: "2026-06-01T00:00:00.000Z",
    });
    expect(snapshot.summary.seq).toBe(state.seq);
  });

  it("stores the summary without the child list: the child table is rebuilt from the sessions' own records", () => {
    const snapshot = buildSnapshot(stateOf("done"), 1, 0, "now");
    expect(snapshot.summary.childIds).toEqual([]);
  });

  it("survives a trip through JSON and comes back without the runtime-only fields", () => {
    const state = stateOf("failed");
    const written = buildSnapshot(state, 123, 0, "2026-06-01T00:00:00.000Z");
    // 手工塞进两个“不来自事件日志”的字段，读回来时必须去掉它们。
    const tampered = { ...written, summary: { ...written.summary, archivedAt: "2026-05-01T00:00:00.000Z", archivedBy: "user", attention: [{ id: "x" }], childIds: ["ses_x"] } };
    const parsed = parseSnapshot(roundTrip(tampered), "ses_a");
    expect(parsed).toBeDefined();
    expect(parsed?.summary).not.toHaveProperty("archivedAt");
    expect(parsed?.summary).not.toHaveProperty("archivedBy");
    expect(parsed?.summary).not.toHaveProperty("attention");
    expect(parsed?.summary.childIds).toEqual([]);
    expect(parsed).toMatchObject({ lastSeq: state.seq, logBytes: 123, undeliveredNotices: 0 });
  });

  it("gives a cold session the same summary its hot self had, once the live child list is put back", () => {
    for (const ending of ["done", "failed", "cancelled", "stopped", "lost", "ready"] as const) {
      const state = stateOf(ending);
      const hot = toSummary(state, ["ses_child"]);
      const cold = parseSnapshot(roundTrip(buildSnapshot(state, 1, 0, "now")), "ses_a");
      expect(cold, ending).toBeDefined();
      expect({ ...cold?.summary, childIds: ["ses_child"] }, ending).toEqual(hot);
    }
  });

  it("refuses anything that is not a complete snapshot of this very session", () => {
    const good = roundTrip(buildSnapshot(stateOf("done"), 10, 0, "now")) as Record<string, unknown>;
    const summary = good["summary"] as Record<string, unknown>;
    const without = (object: Record<string, unknown>, key: string): Record<string, unknown> => {
      const { [key]: _removed, ...rest } = object;
      return rest;
    };
    const cases: Array<[string, unknown]> = [
      ["null", null],
      ["an array", []],
      ["a string", "snapshot"],
      ["another format version", { ...good, format: SNAPSHOT_FORMAT + 1 }],
      ["no format", without(good, "format")],
      ["another session's id", { ...good, sessionId: "ses_other" }],
      ["no lastSeq", without(good, "lastSeq")],
      ["a negative lastSeq", { ...good, lastSeq: -1 }],
      ["a fractional logBytes", { ...good, logBytes: 1.5 }],
      ["a logBytes that is not a number", { ...good, logBytes: "10" }],
      ["no undeliveredNotices", without(good, "undeliveredNotices")],
      ["no writtenAt", without(good, "writtenAt")],
      ["no summary", without(good, "summary")],
      ["a summary of another session", { ...good, summary: { ...summary, id: "ses_other" } }],
      ["a summary whose seq does not match lastSeq", { ...good, summary: { ...summary, seq: (summary["seq"] as number) + 1 } }],
      ["a summary without an origin", { ...good, summary: without(summary, "origin") }],
      ["a summary without message counts", { ...good, summary: without(summary, "messages") }],
      ["a summary without counters", { ...good, summary: without(summary, "counters") }],
      ["a summary without progress", { ...good, summary: without(summary, "progress") }],
      ["a summary without activity", { ...good, summary: without(summary, "activity") }],
      ["a summary with an unknown phase", { ...good, summary: { ...summary, phase: "daydreaming" } }],
      ["a summary with an unknown status", { ...good, summary: { ...summary, status: "napping" } }],
      ["a summary without a title", { ...good, summary: without(summary, "title") }],
    ];
    for (const [label, value] of cases) expect(parseSnapshot(value, "ses_a"), label).toBeUndefined();
    // 对照组：没被破坏的那份是可用的。
    expect(parseSnapshot(good, "ses_a")).toBeDefined();
  });
});

describe("what counts as stable", () => {
  it("finished sessions are stable, whichever way they ended", () => {
    for (const ending of ["done", "failed", "cancelled", "stopped", "lost"] as const) {
      expect(isStableState(stateOf(ending)), ending).toBe(true);
      expect(isStableSummary(toSummary(stateOf(ending))), ending).toBe(true);
    }
  });

  it("a ready session with no run is stable even though it is not finished", () => {
    expect(isStableState(stateOf("ready"))).toBe(true);
    expect(isStableSummary(toSummary(stateOf("ready")))).toBe(true);
  });

  it("a running session is not stable", () => {
    expect(isStableState(stateOf("running"))).toBe(false);
    expect(isStableSummary(toSummary(stateOf("running")))).toBe(false);
  });

  it("a session with a message nobody has confirmed yet is not stable", () => {
    expect(isStableState(stateOf("pending"))).toBe(false);
    expect(isStableSummary(toSummary(stateOf("pending")))).toBe(false);
  });

  it("a session that is waiting for an answer is not stable", () => {
    const state = stateOf("done");
    state.openQuestions.add("q_1");
    expect(isStableState(state)).toBe(false);
    const summary: SessionSummary = { ...toSummary(stateOf("done")), openQuestions: 1 };
    expect(isStableSummary(summary)).toBe(false);
  });

  it("a freshly created session (still starting) is not stable", () => {
    const state = replay(sessionEvents({ id: "ses_a", ending: "done" }).slice(0, 1));
    expect(state?.status).toBe("starting");
    expect(isStableState(state!)).toBe(false);
  });
});
