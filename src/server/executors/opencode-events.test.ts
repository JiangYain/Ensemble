import { describe, expect, it } from "vitest";
import { newRun, terminalOf, type Outcome, type RunState } from "./opencode-events";

/** 一次执行的结局怎样落成 Ensemble 的运行终态：取消、被拒绝、意外中断、失败的优先级。 */
const runWith = (patch: Partial<RunState> = {}): RunState => ({ ...newRun("run_1", "msg_1"), ...patch });

describe("terminalOf", () => {
  it("turns a succeeded execution into completed and keeps the finish reason", () => {
    expect(terminalOf({ kind: "succeeded" }, runWith({ finish: "stop" }))).toEqual({ kind: "completed", stopReason: "stop" });
    expect(terminalOf({ kind: "succeeded" }, runWith())).toEqual({ kind: "completed" });
  });

  it("classifies a failed execution from the error OpenCode sent, or from the last step failure when the execution carries none", () => {
    const rateLimited = { type: "provider.http", message: "Rate limited, retry later", status: 429 };
    expect(terminalOf({ kind: "failed", error: rateLimited }, runWith())).toMatchObject({ kind: "failed", error: { code: "rate_limited", retryable: true } });
    expect(terminalOf({ kind: "failed", error: undefined }, runWith({ failure: rateLimited }))).toMatchObject({ kind: "failed", error: { code: "rate_limited" } });
    expect(terminalOf({ kind: "failed", error: undefined }, runWith())).toMatchObject({ kind: "failed", error: { message: "OpenCode reported an error." } });
  });

  it("calls an interruption the user asked for cancelled, whichever way OpenCode words the reason", () => {
    expect(terminalOf({ kind: "interrupted", reason: "shutdown" }, runWith({ cancelRequested: true }))).toEqual({ kind: "cancelled" });
    expect(terminalOf({ kind: "interrupted", reason: "user" }, runWith())).toEqual({ kind: "cancelled" });
  });

  it("says so when OpenCode stopped a run nobody asked to stop, instead of pretending it was cancelled", () => {
    const end = terminalOf({ kind: "interrupted", reason: "shutdown" }, runWith());
    expect(end).toMatchObject({ kind: "failed", error: { code: "opencode.interrupted" } });
    expect(end.kind === "failed" && end.error.message).toContain("shutdown");
    const unknown = terminalOf({ kind: "interrupted", reason: undefined }, runWith());
    expect(unknown.kind === "failed" && unknown.error.message).toContain("unknown");
  });

  it("reports the reason Ensemble itself rejected something over a plain interruption, even when a cancel was also requested", () => {
    const blocked = { code: "opencode.permission_rejected", message: "A read-only session must not do that." };
    const outcome: Outcome = { kind: "interrupted", reason: "shutdown" };
    expect(terminalOf(outcome, runWith({ blocked }))).toEqual({ kind: "failed", error: blocked });
    expect(terminalOf(outcome, runWith({ blocked, cancelRequested: true }))).toEqual({ kind: "failed", error: blocked });
  });
});
