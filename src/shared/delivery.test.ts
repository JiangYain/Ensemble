import { describe, expect, it } from "vitest";
import { advanceDelivery, deliveryLabelKey, isDeliveryPending, newDelivery, stageRank } from "./delivery";

const t = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

describe("delivery state machine", () => {
  it("starts as recorded with a single history entry", () => {
    const state = newDelivery(t(0));
    expect(state.stage).toBe("recorded");
    expect(state.history).toHaveLength(1);
    expect(isDeliveryPending(state)).toBe(true);
  });

  it("moves forward through ensemble queue, hand-off, harness queue and applied", () => {
    let state = newDelivery(t(0));
    state = advanceDelivery(state, { stage: "queued", queuedBy: "ensemble", reason: "run_in_progress", at: t(1) });
    expect(deliveryLabelKey(state)).toBe("queued_ensemble");
    state = advanceDelivery(state, { stage: "handed_off", at: t(2), evidence: "pi:rpc.response" });
    state = advanceDelivery(state, { stage: "queued", queuedBy: "harness", reason: "turn_boundary", at: t(3), evidence: "pi:queue_update" });
    expect(deliveryLabelKey(state)).toBe("queued_harness");
    state = advanceDelivery(state, { stage: "applied", at: t(4), evidence: "pi:message_start(user)" });
    expect(state.stage).toBe("applied");
    expect(state.history.map((h) => h.stage)).toEqual(["recorded", "queued", "handed_off", "queued", "applied"]);
    expect(isDeliveryPending(state)).toBe(false);
  });

  it("ignores backward and duplicate transitions so replays are idempotent", () => {
    let state = newDelivery(t(0));
    state = advanceDelivery(state, { stage: "handed_off", at: t(1) });
    const same = advanceDelivery(state, { stage: "handed_off", at: t(2) });
    expect(same).toBe(state);
    const back = advanceDelivery(state, { stage: "queued", queuedBy: "ensemble", at: t(3) });
    expect(back).toBe(state);
    const recorded = advanceDelivery(state, { stage: "recorded", at: t(4) });
    expect(recorded).toBe(state);
  });

  it("allows failure from any pending stage, and nothing after a terminal stage", () => {
    let state = newDelivery(t(0));
    state = advanceDelivery(state, { stage: "handed_off", at: t(1) });
    const failed = advanceDelivery(state, {
      stage: "failed",
      at: t(2),
      error: { code: "harness_rejected", message: "no active turn" },
    });
    expect(failed.stage).toBe("failed");
    expect(advanceDelivery(failed, { stage: "applied", at: t(3) })).toBe(failed);

    const applied = advanceDelivery(newDelivery(t(0)), { stage: "applied", at: t(1) });
    expect(advanceDelivery(applied, { stage: "failed", at: t(2) })).toBe(applied);
  });

  it("ranks harness-side queueing after hand-off but ensemble-side queueing before it", () => {
    expect(stageRank({ stage: "queued", queuedBy: "ensemble" })).toBeLessThan(stageRank({ stage: "handed_off" }));
    expect(stageRank({ stage: "queued", queuedBy: "harness" })).toBeGreaterThan(stageRank({ stage: "handed_off" }));
  });

  it("bounds the history length", () => {
    let state = newDelivery(t(0));
    state = advanceDelivery(state, { stage: "queued", queuedBy: "ensemble", at: t(1) });
    state = advanceDelivery(state, { stage: "handed_off", at: t(2) });
    state = advanceDelivery(state, { stage: "queued", queuedBy: "harness", at: t(3) });
    state = advanceDelivery(state, { stage: "applied", at: t(4) });
    expect(state.history.length).toBeLessThanOrEqual(12);
  });
});
