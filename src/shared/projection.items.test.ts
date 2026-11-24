import { describe, expect, it } from "vitest";
import { replay, toSummary, type SessionState } from "./projection";
import { EventLog, USER } from "./testing";
import type { AssistantItem, ReasoningItem } from "./types";

/**
 * 助手文字与推理条目的键里带着 runId：执行端给的条目编号只在一次运行之内唯一（事件映射器每次运行、Codex 自动续跑的每一轮都从头编号：a1、r2……），
 * 键里没有运行标识的话，后一次运行的文字会被拼到前一次运行里同号的条目上，第 2 轮就读不到自己的文字。
 */

/** 重放日志的前 eventCount 条（缺省是全部）。 */
function stateOf(log: EventLog, eventCount = log.events.length): SessionState {
  const state = replay(log.events.slice(0, eventCount));
  if (!state) throw new Error("the log has no session.created");
  return state;
}

const assistantsOf = (state: SessionState): AssistantItem[] => state.timeline.filter((item): item is AssistantItem => item.type === "assistant");
const reasoningsOf = (state: SessionState): ReasoningItem[] => state.timeline.filter((item): item is ReasoningItem => item.type === "reasoning");

/** 两次运行，执行端各自从头给条目编号：两次都是助手文字 a1、推理 r2。 */
function twoRunsReusingItemIds(): EventLog {
  const log = new EventLog();
  log.created();
  log.message("m1", "task", "Audit the parser");
  log.run("r1", 1, "m1");
  log.startRun("r1");
  log.push({ kind: "reasoning.delta", data: { itemId: "r2", text: "first-run reasoning" } }, { runId: "r1" });
  log.push({ kind: "reasoning.completed", data: { itemId: "r2" } }, { runId: "r1" });
  log.push({ kind: "assistant.delta", data: { itemId: "a1", text: "first-run answer", phase: "final" } }, { runId: "r1" });
  log.push({ kind: "assistant.completed", data: { itemId: "a1", phase: "final" } }, { runId: "r1" });
  log.push({ kind: "run.completed", data: { stopReason: "end_turn" } }, { runId: "r1" });
  log.message("m2", "follow_up", "And the lexer?", USER);
  log.run("r2", 2, "m2", "follow_up");
  log.startRun("r2");
  log.push({ kind: "reasoning.delta", data: { itemId: "r2", text: "second-run reasoning" } }, { runId: "r2" });
  log.push({ kind: "reasoning.completed", data: { itemId: "r2" } }, { runId: "r2" });
  log.push({ kind: "assistant.delta", data: { itemId: "a1", text: "second-run answer", phase: "final" } }, { runId: "r2" });
  log.push({ kind: "assistant.completed", data: { itemId: "a1", phase: "final" } }, { runId: "r2" });
  log.push({ kind: "run.completed", data: { stopReason: "end_turn" } }, { runId: "r2" });
  return log;
}

describe("assistant and reasoning items across runs", () => {
  it("keeps the text of a later run apart from an earlier run that used the same item id", () => {
    const state = stateOf(twoRunsReusingItemIds());

    expect(assistantsOf(state).map((item) => [item.runId, item.text])).toEqual([
      ["r1", "first-run answer"],
      ["r2", "second-run answer"],
    ]);
    expect(reasoningsOf(state).map((item) => [item.runId, item.text])).toEqual([
      ["r1", "first-run reasoning"],
      ["r2", "second-run reasoning"],
    ]);
    // 同号的条目在各自的运行里是两条不同的条目：id 不能相同，否则网页按 id 渲染时会互相顶替。
    const [firstAnswer, secondAnswer] = assistantsOf(state);
    expect(firstAnswer?.id).not.toBe(secondAnswer?.id);
    const [firstThought, secondThought] = reasoningsOf(state);
    expect(firstThought?.id).not.toBe(secondThought?.id);
  });

  it("takes the latest answer from the later run", () => {
    const summary = toSummary(stateOf(twoRunsReusingItemIds()));
    expect(summary.lastAssistantPreview).toBe("second-run answer");
  });

  it("reads as writing while a later run streams text under an item id an earlier run already used", () => {
    const log = twoRunsReusingItemIds();
    const firstDeltaOfSecondRun = log.events.findIndex((event) => event.kind === "assistant.delta" && event.runId === "r2");
    expect(firstDeltaOfSecondRun).toBeGreaterThan(0);

    const state = stateOf(log, firstDeltaOfSecondRun + 1);

    // 第 2 轮的文字是自己的条目、属于第 2 轮：活动是“正在写”，而不是回落到“在忙”。
    expect(toSummary(state).activity).toMatchObject({ kind: "writing", runId: "r2" });
  });

  it("still joins the deltas and the completion of one item within a run", () => {
    const log = new EventLog();
    log.created();
    log.message("m1", "task", "Go");
    log.run("r1", 1, "m1");
    log.startRun("r1");
    log.push({ kind: "assistant.delta", data: { itemId: "a1", text: "Hel", phase: "final" } }, { runId: "r1" });
    log.push({ kind: "assistant.delta", data: { itemId: "a1", text: "lo", phase: "final" } }, { runId: "r1" });
    log.push({ kind: "assistant.completed", data: { itemId: "a1", phase: "final" } }, { runId: "r1" });

    const items = assistantsOf(stateOf(log));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ runId: "r1", text: "Hello", streaming: false, phase: "final" });
  });

  it("keeps the old key for events that carry no run (old logs, events that came when no run was active)", () => {
    const log = new EventLog();
    log.created();
    log.push({ kind: "assistant.delta", data: { itemId: "a1", text: "no run behind this" } });
    log.push({ kind: "assistant.completed", data: { itemId: "a1" } });
    log.push({ kind: "reasoning.delta", data: { itemId: "r1", text: "nor behind this" } });
    log.push({ kind: "reasoning.completed", data: { itemId: "r1" } });

    const state = stateOf(log);

    expect(assistantsOf(state).map((item) => item.id)).toEqual(["assistant:a1"]);
    expect(reasoningsOf(state).map((item) => item.id)).toEqual(["reasoning:r1"]);
    expect(assistantsOf(state)[0]).toMatchObject({ text: "no run behind this", streaming: false });
  });
});
