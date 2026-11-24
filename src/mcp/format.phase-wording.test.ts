import { describe, expect, it } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog, USER } from "@shared/testing";
import type { Run, SessionPhase } from "@shared/types";
import { renderResult } from "./format";

/**
 * 单个会话的 `read`（view="result"）里“回答 / 没有回答”那一句的措辞，要与会话此刻真实的进行状态一致，
 * 和批量读取（read.phase-wording.test.ts）是同一套分法：只有一轮正在跑才能说“最新输出 / 仍在进行”；
 * 第一轮在排队、一轮刚交给执行端启动、前一轮已结束而后续一轮在排队、从未跑过，各有各的如实说法。
 * 局面直接用 EventLog 造，并先核对阶段确实是预期的那一个——局面造错了，下面的断言就没有意义。
 */

/** 单个会话的结果视图整段文字；传 `run`（运行序号，从 0 起）就是只看那一轮。 */
function resultOf(log: EventLog, phase: SessionPhase, options: { run?: number } = {}): string {
  const state = replay(log.events);
  if (!state) throw new Error("replay failed");
  const summary = toSummary(state);
  expect(summary.phase).toBe(phase);
  const run: Run | undefined = options.run === undefined ? undefined : state.runs[options.run];
  if (options.run !== undefined) expect(run).toBeDefined();
  return renderResult(state, summary, { maxChars: 8000, ...(run ? { run } : {}) });
}

/** 一轮正在跑（run.started 之后什么都还没有输出）。 */
function runningRun(): EventLog {
  const log = new EventLog();
  log.created();
  log.message("m1", "task", "Audit the parser");
  log.run("r1", 1, "m1");
  log.startRun("r1");
  return log;
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

/** 第一轮已经结束（给了 answer 就带一条回答，phase 是 final 或 commentary），随后追加了一条补充消息，它的那一轮还在排队。 */
function followUpQueued(answer?: string, phase: "final" | "commentary" = "final"): EventLog {
  const log = new EventLog();
  log.created();
  log.message("m1", "task", "Audit the parser");
  log.run("r1", 1, "m1");
  log.startRun("r1");
  if (answer !== undefined) {
    log.push({ kind: "assistant.delta", data: { itemId: "a1", text: answer, phase } }, { runId: "r1" });
    log.push({ kind: "assistant.completed", data: { itemId: "a1", phase } }, { runId: "r1" });
  }
  log.push({ kind: "run.completed", data: {} }, { runId: "r1" });
  log.message("m2", "follow_up", "Now audit the lexer too", USER);
  log.run("r2", 2, "m2", "follow_up");
  return log;
}

/** 一轮都没跑过，第一轮在排队（会话已经待命，名额满了所以还没开始）。 */
function firstRunQueued(): EventLog {
  const log = new EventLog();
  log.created();
  log.push({ kind: "session.status", data: { status: "idle" } });
  log.message("m1", "task", "Audit the parser");
  log.run("r1", 1, "m1");
  return log;
}

describe("single-session result wording: the next run is queued behind a finished one", () => {
  it("says the answer is from the previous run and that the next run has not started, not that a run is going", () => {
    const text = resultOf(followUpQueued("First run: parser audited."), "queued");
    expect(text).toContain("Final answer of run #1 (the next run is queued and has not started yet):\nFirst run: parser audited.");
    // 前一轮已经结束：这不是“某一轮的最新输出”，更不是“仍在运行”。
    expect(text).not.toContain("Latest output so far");
    expect(text).not.toContain("still going");
    expect(text).not.toContain("not a final answer");
  });

  it("does not call a message the harness did not mark final a final answer, and still names the run it came from", () => {
    const text = resultOf(followUpQueued("Checked the lexer so far.", "commentary"), "queued");
    expect(text).toContain("Last message from run #1 (the next run is queued and has not started yet):\nChecked the lexer so far.");
    expect(text).not.toContain("Final answer");
  });

  it("does not claim the session is working when the previous run left no assistant text", () => {
    const text = resultOf(followUpQueued(), "queued");
    expect(text).toContain("The session produced no assistant text in its last run, and the next run is queued and has not started yet. Call `wait` or check the panel.");
    expect(text).not.toContain("still working");
  });
});

describe("single-session result wording: the first run is still in the queue", () => {
  it("says the session is queued and has not started, not that it is working", () => {
    const text = resultOf(firstRunQueued(), "queued");
    expect(text).toContain("No output yet — the session is queued and has not started. Call `wait` or check the panel.");
    expect(text).not.toContain("still working");
    expect(text).not.toContain("in its last run");
  });

  it("names the run, not the session, when the queued run is asked for while the session is busy with another", () => {
    const log = runningRun();
    log.message("m2", "follow_up", "Now audit the lexer too", USER);
    log.run("r2", 2, "m2", "follow_up");

    const text = resultOf(log, "running", { run: 1 });
    expect(text).toContain("Run 2 of 2 · queued, not started yet");
    expect(text).toContain("No output yet — this run is queued and has not started. Call `wait` or check the panel.");
    expect(text).not.toContain("the session is queued");
    expect(text).not.toContain("still working");
  });
});

describe("single-session result wording: a run that is only starting", () => {
  it("does not call it working or going: the run was handed to the harness but has not started", () => {
    const text = resultOf(startingRun(), "starting");
    expect(text).toContain("No output yet — the run is starting. Call `wait` or check the panel.");
    expect(text).not.toContain("still working");
    expect(text).not.toContain("still going");
  });

  it("says the same when that run is asked for", () => {
    const text = resultOf(startingRun(), "starting", { run: 0 });
    expect(text).toContain("Run 1 of 1 · starting");
    expect(text).toContain("No output yet — the run is starting. Call `wait` or check the panel.");
  });
});

describe("single-session result wording: a session that is still connecting to the harness", () => {
  it("says it has not run yet, not that a run is starting: no run has been handed over, so there is none to be starting", () => {
    const log = new EventLog();
    log.created();
    log.message("m1", "task", "Audit the parser");

    // 阶段是 starting，运行记录里却一轮都没有：会话还在连执行端。与上面“最近一轮已是 starting”成对——
    // 那边是某一轮已经交给执行端启动，才能说“这一轮正在启动”；这里没有这一轮。
    const text = resultOf(log, "starting");
    expect(text).toContain("The session has not run yet.");
    expect(text).not.toContain("the run is starting");
    expect(text).not.toContain("still working");
    expect(text).not.toContain("in its last run");
  });
});

describe("single-session result wording: a ready session", () => {
  it("has no last run to talk about when it has never run", () => {
    const log = new EventLog();
    log.created();
    log.push({ kind: "session.status", data: { status: "idle" } });

    const text = resultOf(log, "ready");
    expect(text).toContain("The session has not run yet.");
    expect(text).not.toContain("in its last run");
    expect(text).not.toContain("still working");
  });

  it("judges 'has it run' by the runs, not by the phase: a run that started and produced no assistant text is still its last run", () => {
    const log = runningRun();
    // 会话状态报了待命，运行记录里这一轮却已经开始、没有结束：阶段是 ready，但“还没跑过”不是事实。
    log.push({ kind: "session.status", data: { status: "idle" } });

    const text = resultOf(log, "ready");
    expect(text).toContain("The session produced no assistant text in its last run.");
    expect(text).not.toContain("has not run yet");
  });
});

describe("single-session result wording: a run that is really going", () => {
  it("keeps its wording word for word", () => {
    const log = runningRun();
    expect(resultOf(log, "running")).toContain("No output yet — the session is still working. Call `wait` or check the panel.");

    log.push({ kind: "assistant.delta", data: { itemId: "a1", text: "Working on it", phase: "commentary" } }, { runId: "r1" });
    expect(resultOf(log, "running")).toContain("Latest output so far (the run is still going; this is not a final answer):\nWorking on it");
  });
});
