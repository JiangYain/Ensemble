import { describe, expect, it } from "vitest";
import { applyEvent, createState, openQuestionItems, replay, toSummary, type SessionState } from "./projection";
import { questionItemId, SYSTEM_ACTOR, type QuestionPrompt } from "./questions";
import { AGENT, EventLog, USER } from "./testing";
import type { QuestionItem } from "./types";

const PROMPTS: QuestionPrompt[] = [
  {
    key: "db",
    header: "Database",
    text: "Which database should the service use?",
    options: [{ label: "SQLite", description: "single file" }, { label: "PostgreSQL" }],
    multiple: false,
    custom: true,
  },
];

/** 一个正在运行的会话（任务消息与第一次运行已就绪）。 */
function running(): EventLog {
  const log = new EventLog("ses_q");
  log.created({ harness: "codex" });
  const message = log.message("msg_1", "task", "Build the service");
  log.run("run_1", 1, message.id);
  log.startRun("run_1");
  return log;
}

const state = (log: EventLog): SessionState => {
  const result = replay(log.events);
  if (!result) throw new Error("replay produced no state");
  return result;
};

const questionOf = (current: SessionState, questionId = "qst_1"): QuestionItem | undefined => {
  const item = current.timeline.find((entry) => entry.id === questionItemId(questionId));
  return item?.type === "question" ? item : undefined;
};

const answered = (log: EventLog, questionId = "qst_1"): void => {
  log.settle({ questionId, outcome: "answered", by: USER, answers: [["SQLite"]], delivery: "handed_off" }, "run_1");
};

describe("question.asked", () => {
  it("becomes one open item on the timeline, verbatim, where it was asked", () => {
    const log = running();
    log.tool("run_1", "t1", "running");
    log.tool("run_1", "t1", "completed");
    const asked = log.ask("qst_1", PROMPTS, "run_1");
    const current = state(log);

    expect(current.timeline.map((item) => item.type)).toEqual(["message", "run", "tool", "question"]);
    expect(questionOf(current)).toEqual({
      type: "question",
      id: "question:qst_1",
      runId: "run_1",
      at: asked.at,
      updatedAt: asked.at,
      questionId: "qst_1",
      prompts: PROMPTS,
      status: "open",
    });
    expect([...current.openQuestions]).toEqual(["qst_1"]);
    expect(openQuestionItems(current).map((item) => item.questionId)).toEqual(["qst_1"]);
  });

  it("is a single entry however many times the same event is delivered", () => {
    const log = running();
    log.ask("qst_1", PROMPTS, "run_1");
    const current = state(log);
    const again = log.ask("qst_1", PROMPTS, "run_1");
    applyEvent(current, again);
    expect(current.timeline.filter((item) => item.type === "question")).toHaveLength(1);
    expect(current.openQuestions.size).toBe(1);
  });

  it("is counted in the summary only while it is open, and does not add a phase", () => {
    const log = running();
    const before = toSummary(state(log));
    log.ask("qst_1", PROMPTS, "run_1");
    const asking = toSummary(state(log));
    // 阶段仍是运行中：提问不是新的会话状态，页面凭 openQuestions 区分“在等回答”。
    expect(asking.phase).toBe(before.phase);
    expect(asking.status).toBe(before.status);
    expect(asking.openQuestions).toBe(1);
    expect("openQuestions" in before).toBe(false);

    log.ask("qst_2", [{ key: "n", text: "What should the table be called?", multiple: false, custom: true }], "run_1");
    expect(toSummary(state(log)).openQuestions).toBe(2);

    answered(log, "qst_1");
    answered(log, "qst_2");
    const after = toSummary(state(log));
    expect("openQuestions" in after).toBe(false);
    expect(after.phase).toBe(before.phase);
  });

  it("closes a reply that was still streaming: the executor has stopped to wait", () => {
    const log = running();
    log.push({ kind: "assistant.delta", data: { itemId: "a1", text: "I need to decide something" } }, { runId: "run_1" });
    expect(state(log).timeline.find((item) => item.type === "assistant")).toMatchObject({ streaming: true });
    log.ask("qst_1", PROMPTS, "run_1");
    expect(state(log).timeline.find((item) => item.type === "assistant")).toMatchObject({ streaming: false });
  });

  it("keeps several open questions in the order they were asked", () => {
    const log = running();
    log.ask("qst_b", PROMPTS, "run_1");
    log.ask("qst_a", PROMPTS, "run_1");
    expect(openQuestionItems(state(log)).map((item) => item.questionId)).toEqual(["qst_b", "qst_a"]);
  });
});

describe("question.resolved", () => {
  it("settles the item in place: same row, new object, outcome recorded with who, when and how", () => {
    const log = running();
    log.ask("qst_1", PROMPTS, "run_1");
    const current = state(log);
    const open = questionOf(current)!;
    const index = current.timeline.indexOf(open);

    const settled = log.settle({ questionId: "qst_1", outcome: "answered", by: USER, answers: [["SQLite"]], delivery: "handed_off" }, "run_1");
    applyEvent(current, settled);

    const item = questionOf(current)!;
    expect(current.timeline.indexOf(item)).toBe(index);
    expect(item).not.toBe(open);
    expect(item).toMatchObject({ status: "answered", updatedAt: settled.at, prompts: PROMPTS, at: open.at });
    expect(item.outcome).toEqual({ at: settled.at, by: USER, answers: [["SQLite"]], delivery: "handed_off" });
    expect(current.openQuestions.size).toBe(0);
    expect(open.status).toBe("open");
  });

  it("records a decline with the user's own note, and an agent's answer under the agent's name", () => {
    const log = running();
    log.ask("qst_1", PROMPTS, "run_1");
    log.ask("qst_2", PROMPTS, "run_1");
    log.settle({ questionId: "qst_1", outcome: "declined", by: USER, note: "Use your own judgment.", delivery: "handed_off" }, "run_1");
    log.settle({ questionId: "qst_2", outcome: "answered", by: AGENT, answers: [["PostgreSQL"]], delivery: "handed_off" }, "run_1");
    const current = state(log);
    expect(questionOf(current, "qst_1")?.outcome).toMatchObject({ by: USER, note: "Use your own judgment." });
    expect(questionOf(current, "qst_1")?.status).toBe("declined");
    expect(questionOf(current, "qst_2")?.outcome?.by).toEqual(AGENT);
  });

  it("lets the first resolution win: a later answer or expiry never rewrites it", () => {
    const log = running();
    log.ask("qst_1", PROMPTS, "run_1");
    log.settle({ questionId: "qst_1", outcome: "answered", by: USER, answers: [["SQLite"]], delivery: "handed_off" }, "run_1");
    log.settle({ questionId: "qst_1", outcome: "answered", by: AGENT, answers: [["PostgreSQL"]], delivery: "handed_off" }, "run_1");
    log.settle({ questionId: "qst_1", outcome: "expired", by: SYSTEM_ACTOR, reason: "timeout" }, "run_1");
    const item = questionOf(state(log))!;
    expect(item.status).toBe("answered");
    expect(item.outcome).toMatchObject({ by: USER, answers: [["SQLite"]] });
    expect(item.outcome?.reason).toBeUndefined();
  });

  it("ignores a resolution for a question it never saw, but still advances the sequence", () => {
    const log = running();
    const before = state(log);
    const event = log.settle({ questionId: "qst_unknown", outcome: "expired", by: SYSTEM_ACTOR, reason: "withdrawn" }, "run_1");
    applyEvent(before, event);
    expect(before.timeline.some((item) => item.type === "question")).toBe(false);
    expect(before.seq).toBe(event.seq);
  });

  it("keeps an explicit expiry's own reason and delivery", () => {
    const log = running();
    log.ask("qst_1", PROMPTS, "run_1");
    log.settle({ questionId: "qst_1", outcome: "expired", by: SYSTEM_ACTOR, reason: "timeout", delivery: "handed_off", note: "Nobody answered in time." }, "run_1");
    expect(questionOf(state(log))?.outcome).toMatchObject({ by: SYSTEM_ACTOR, reason: "timeout", delivery: "handed_off", note: "Nobody answered in time." });
  });
});

describe("a question never outlives the run or session it belongs to", () => {
  const expiryOf = (log: EventLog, questionId = "qst_1"): { status?: string; reason?: string; by?: string } => {
    const item = questionOf(state(log), questionId);
    return { status: item?.status, reason: item?.outcome?.reason, by: item?.outcome?.by.kind };
  };

  it("expires when its run completes", () => {
    const log = running();
    log.ask("qst_1", PROMPTS, "run_1");
    log.push({ kind: "run.completed", data: { stopReason: "end_turn" } }, { runId: "run_1" });
    expect(expiryOf(log)).toEqual({ status: "expired", reason: "run_ended", by: "system" });
    expect(state(log).openQuestions.size).toBe(0);
    expect(toSummary(state(log)).openQuestions).toBeUndefined();
  });

  it("expires when its run fails", () => {
    const log = running();
    log.ask("qst_1", PROMPTS, "run_1");
    log.push({ kind: "run.failed", data: { error: { code: "boom", message: "boom" } } }, { runId: "run_1" });
    expect(expiryOf(log)).toEqual({ status: "expired", reason: "run_ended", by: "system" });
  });

  it("says cancelled, not ended, when its run was cancelled", () => {
    const log = running();
    log.ask("qst_1", PROMPTS, "run_1");
    log.push({ kind: "run.cancelled", data: { by: USER } }, { runId: "run_1", source: "user" });
    expect(expiryOf(log)).toEqual({ status: "expired", reason: "cancelled", by: "system" });
  });

  it("expires a question that has no run too", () => {
    const log = running();
    log.ask("qst_1", PROMPTS);
    log.push({ kind: "run.completed", data: {} }, { runId: "run_1" });
    expect(expiryOf(log).status).toBe("expired");
  });

  it("keeps an explicit reason that was written before the run ended", () => {
    const log = running();
    log.ask("qst_1", PROMPTS, "run_1");
    log.settle({ questionId: "qst_1", outcome: "expired", by: SYSTEM_ACTOR, reason: "withdrawn" }, "run_1");
    log.push({ kind: "run.completed", data: {} }, { runId: "run_1" });
    expect(expiryOf(log)).toEqual({ status: "expired", reason: "withdrawn", by: "system" });
  });

  it("does not touch a question that was already answered", () => {
    const log = running();
    log.ask("qst_1", PROMPTS, "run_1");
    answered(log);
    log.push({ kind: "run.completed", data: {} }, { runId: "run_1" });
    expect(expiryOf(log).status).toBe("answered");
  });

  it("expires with session_closed when the session is stopped or failed, and restarted when it is lost", () => {
    for (const [status, reason] of [
      ["stopped", "session_closed"],
      ["failed", "session_closed"],
      ["lost", "restarted"],
    ] as const) {
      const log = running();
      log.ask("qst_1", PROMPTS, "run_1");
      log.push({ kind: "session.status", data: { status } }, { source: "ensemble" });
      expect(expiryOf(log), status).toEqual({ status: "expired", reason, by: "system" });
    }
  });

  it("leaves the question open while the session merely changes between working states", () => {
    const log = running();
    log.ask("qst_1", PROMPTS, "run_1");
    log.push({ kind: "session.status", data: { status: "running" } }, { source: "ensemble" });
    expect(expiryOf(log).status).toBe("open");
  });
});

describe("replaying and applying agree", () => {
  it("builds the same timeline and index whether events are applied one by one or replayed", () => {
    const log = running();
    log.ask("qst_1", PROMPTS, "run_1");
    log.ask("qst_2", PROMPTS, "run_1");
    answered(log, "qst_1");
    log.push({ kind: "run.completed", data: {} }, { runId: "run_1" });

    const first = log.events[0];
    if (first?.kind !== "session.created") throw new Error("unreachable");
    const stepwise = createState(first);
    for (const event of log.events.slice(1)) applyEvent(stepwise, event);
    const whole = state(log);

    expect(stepwise.timeline).toEqual(whole.timeline);
    expect([...stepwise.openQuestions]).toEqual([...whole.openQuestions]);
    expect(toSummary(stepwise)).toEqual(toSummary(whole));
    expect(questionOf(whole, "qst_1")?.status).toBe("answered");
    expect(questionOf(whole, "qst_2")?.status).toBe("expired");
  });
});
