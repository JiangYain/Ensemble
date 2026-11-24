import { describe, expect, it } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog, USER } from "@shared/testing";
import type { SessionPhase } from "@shared/types";
import { renderBatch, type BatchOutcome } from "./read";

/**
 * 批量读取（sessionIds）里“结论一节”与“还没有最终结果”那句说明的措辞，要与会话此刻真实的进行状态一致：
 * 只有一轮正在跑（阶段 running）才能说“仍在运行 / 最新输出”；一轮刚交给执行端启动、前一轮已结束而后续一轮在排队、
 * 阶段是待命但运行记录里确有一轮开始过，各有各的如实说法。
 */

const NOW = Date.parse("2026-01-01T00:10:00.000Z");

function outcome(log: EventLog): BatchOutcome {
  const state = replay(log.events);
  if (!state) throw new Error("replay failed");
  return { id: log.sessionId, detail: { summary: toSummary(state), events: log.events } };
}

/** 批量读取这个会话得到的整段文字；先核对阶段确实是预期的那一个——局面造错了，下面的断言就没有意义。 */
function batchText(log: EventLog, phase: SessionPhase): string {
  const batch = renderBatch([outcome(log)], { maxChars: 8000, now: NOW });
  expect(batch.readable[0]?.phase).toBe(phase);
  return batch.text;
}

/** 第一轮已经交给执行端启动（run.starting），执行端还没有报告开始。 */
function startingRun(): EventLog {
  const log = new EventLog();
  log.created();
  log.message("m1", "task", "Audit the parser");
  log.run("r1", 1, "m1");
  log.push({ kind: "run.starting", data: {} }, { runId: "r1" });
  return log;
}

/** 第一轮已经结束（给了 answer 就带一条最终回答），随后追加了一条补充消息，它的那一轮还在排队。 */
function followUpQueued(answer?: string): EventLog {
  const log = new EventLog();
  log.created();
  log.message("m1", "task", "Audit the parser");
  log.run("r1", 1, "m1");
  log.startRun("r1");
  if (answer !== undefined) {
    log.push({ kind: "assistant.delta", data: { itemId: "a1", text: answer, phase: "final" } }, { runId: "r1" });
    log.push({ kind: "assistant.completed", data: { itemId: "a1", phase: "final" } }, { runId: "r1" });
  }
  log.push({ kind: "run.completed", data: {} }, { runId: "r1" });
  log.message("m2", "follow_up", "Now audit the lexer too", USER);
  log.run("r2", 2, "m2", "follow_up");
  return log;
}

describe("batch read wording: a run that is only starting", () => {
  it("does not call it running: the run was handed to the harness but has not started", () => {
    const text = batchText(startingRun(), "starting");
    expect(text).toContain("    run: #1, not started yet");
    expect(text).toContain("    starting — not final");
    expect(text).toContain("    conclusion: none yet — the run is starting");
    expect(text).not.toContain("still running");
  });
});

describe("batch read wording: the next run is queued behind a finished one", () => {
  it("says the answer is from the previous run and that the next run has not started", () => {
    const text = batchText(followUpQueued("First run: parser audited."), "queued");
    expect(text).toContain("    next run queued — not started yet");
    expect(text).toContain("    conclusion of run #1:\n      First run: parser audited.");
    // 前一轮已经结束：这不是“某一轮的最新输出”，更不是“仍在运行”。
    expect(text).not.toContain("latest output so far");
    expect(text).not.toContain("still running");
    expect(text).not.toContain("not final");
  });

  it("does not claim the session is running when the previous run left no assistant text", () => {
    const text = batchText(followUpQueued(), "queued");
    expect(text).toContain("    next run queued — not started yet");
    expect(text).toContain("    conclusion: none — the last run produced no assistant text");
    expect(text).not.toContain("still running");
  });

  it("does not talk about a previous run when nothing has ever run (the first run is the one in the queue)", () => {
    const log = new EventLog();
    log.created();
    log.push({ kind: "session.status", data: { status: "idle" } });
    log.message("m1", "task", "Audit the parser");
    log.run("r1", 1, "m1");
    const text = batchText(log, "queued");
    expect(text).toContain("    conclusion: none — the session has not run yet");
    expect(text).not.toContain("next run queued");
    expect(text).not.toContain("still running");
  });
});

describe("batch read wording: a ready session whose run has actually started", () => {
  it("judges 'has it run' by the runs, not by the phase: the run started and produced no assistant text", () => {
    const log = new EventLog();
    log.created();
    log.message("m1", "task", "Audit the parser");
    log.run("r1", 1, "m1");
    log.startRun("r1");
    // 会话状态报了待命，运行记录里这一轮却已经开始、没有结束：阶段是 ready，但“还没跑过”不是事实。
    log.push({ kind: "session.status", data: { status: "idle" } });
    const text = batchText(log, "ready");
    expect(text).toContain("    conclusion: none — the last run produced no assistant text");
    expect(text).not.toContain("has not run yet");
  });
});
