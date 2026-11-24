import { afterEach, describe, expect, it } from "vitest";
import { SYSTEM_ACTOR, type QuestionId, type QuestionPrompt } from "@shared/questions";
import { AGENT, USER, testOrigin } from "@shared/testing";
import type { QuestionItem } from "@shared/types";
import { EnsembleError } from "./errors";
import { ReplyRejected } from "./executors/types";
import type { ManagerConfig } from "./manager";
import { ManualExecutor, delegatorFor, makeTrackedEnv, shutdownTrackedEnvs, stateOf, until, type ManualSession, type QuestionReply, type TestEnv } from "./testing";

afterEach(shutdownTrackedEnvs);

const delegate = delegatorFor("pi", "Build the service");

const CHOICE: QuestionPrompt[] = [
  {
    key: "pkg",
    text: "Which package should I update?",
    options: [{ label: "core", description: "the engine" }, { label: "web" }],
    multiple: false,
    custom: true,
  },
];
/** 只能从可选项里选。 */
const CLOSED: QuestionPrompt[] = [{ key: "mode", text: "Which mode?", options: [{ label: "fast" }, { label: "safe" }], multiple: false, custom: false }];

interface Rig {
  env: TestEnv;
  exec: ManualExecutor;
  session: ManualSession;
  sessionId: string;
  runId: string;
  questionId: QuestionId;
}

/** 一个正在运行、并且停下来问了一个问题的会话。`reply: "unsupported"` = 这个执行端根本不接收对提问的回复。 */
async function asking(setup: { reply?: QuestionReply | "unsupported"; config?: Partial<ManagerConfig>; prompts?: QuestionPrompt[] } = {}): Promise<Rig> {
  const exec = new ManualExecutor("pi");
  exec.autoStart = true;
  if (setup.reply !== "unsupported") exec.questionReply = setup.reply ?? true;
  const env = makeTrackedEnv([exec], setup.config);
  const { sessionId, runId } = await delegate(env);
  await until(() => env.hub.summary(sessionId)?.phase === "running", 4000, "the run to start");
  const session = exec.sessions[0]!;
  const questionId = session.ask(runId, setup.prompts ?? CHOICE);
  await until(() => (env.hub.summary(sessionId)?.openQuestions ?? 0) > 0, 4000, "the question to be recorded");
  return { env, exec, session, sessionId, runId, questionId };
}

const questionOf = (rig: Pick<Rig, "env" | "sessionId" | "questionId">): QuestionItem => {
  const item = stateOf(rig.env, rig.sessionId).timeline.find((entry): entry is QuestionItem => entry.type === "question" && entry.questionId === rig.questionId);
  if (!item) throw new Error("the question is not on the timeline");
  return item;
};

const resolvedEvents = (rig: Pick<Rig, "env" | "sessionId">) => rig.env.hub.events(rig.sessionId).filter((event) => event.kind === "question.resolved");

/** 一个调用抛出的 EnsembleError（没有抛就让用例失败）。 */
async function failure(call: Promise<unknown>): Promise<EnsembleError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof EnsembleError) return error;
    throw error;
  }
  throw new Error("expected the call to be refused");
}

describe("answering a question", () => {
  it("hands the reply to the harness, then records who answered, what, and that it was handed off", async () => {
    const rig = await asking();
    const { env, sessionId, questionId, session } = rig;
    const result = await env.manager.answerQuestion(sessionId, questionId, { answer: "web" }, USER);

    expect(result).toMatchObject({ questionId, status: "answered", outcome: { by: USER, answers: [["web"]], delivery: "handed_off" } });
    expect(session.replies).toEqual([{ kind: "answer", questionId, answers: [["web"]] }]);

    const item = questionOf(rig);
    expect(item.status).toBe("answered");
    expect(item.outcome).toEqual(result.outcome);
    expect(env.hub.summary(sessionId)?.openQuestions).toBeUndefined();
    expect(stateOf(env, sessionId).openQuestions.size).toBe(0);
    // 事件记在这个提问所属的运行上，署名是用户。
    const [event] = resolvedEvents(rig);
    expect(event).toMatchObject({ kind: "question.resolved", source: "user", runId: rig.runId });
  });

  it("goes to the harness first: while the reply is on its way, the log still says the question is open", async () => {
    const rig = await asking();
    let openWhenReplied: number | undefined;
    rig.exec.questionReply = async () => {
      openWhenReplied = stateOf(rig.env, rig.sessionId).openQuestions.size;
      return true;
    };
    await rig.env.manager.answerQuestion(rig.sessionId, rig.questionId, { answer: "core" }, USER);
    expect(openWhenReplied).toBe(1);
    expect(questionOf(rig).status).toBe("answered");
  });

  it("turns the answer into the option's own label, whatever case or spacing it was written in", async () => {
    const rig = await asking();
    const result = await rig.env.manager.answerQuestion(rig.sessionId, rig.questionId, { answer: "  CORE " }, USER);
    expect(result.outcome.answers).toEqual([["core"]]);
    expect(rig.session.replies[0]).toMatchObject({ answers: [["core"]] });
  });

  it("takes the user's own words when the question allows it", async () => {
    const rig = await asking();
    const result = await rig.env.manager.answerQuestion(rig.sessionId, rig.questionId, { answer: "both, core first" }, USER);
    expect(result.outcome.answers).toEqual([["both, core first"]]);
  });

  it("refuses an answer that does not fit the question, and leaves the question open for another try", async () => {
    const rig = await asking({ prompts: CLOSED });
    const error = await failure(rig.env.manager.answerQuestion(rig.sessionId, rig.questionId, { answer: "slow" }, USER));
    expect(error.code).toBe("invalid_request");
    expect(error.message).toContain('must be one of the options ("fast", "safe")');
    expect(rig.session.replies).toEqual([]);
    expect(questionOf(rig).status).toBe("open");
    expect(resolvedEvents(rig)).toHaveLength(0);

    await rig.env.manager.answerQuestion(rig.sessionId, rig.questionId, { answer: "safe" }, USER);
    expect(questionOf(rig).outcome?.answers).toEqual([["safe"]]);
  });

  it("an agent's answer is recorded under the agent's name and is not echoed back to that same agent", async () => {
    const rig = await asking();
    await rig.env.manager.answerQuestion(rig.sessionId, rig.questionId, { answer: "web" }, AGENT);
    expect(questionOf(rig).outcome?.by).toEqual(AGENT);
    expect(resolvedEvents(rig)[0]).toMatchObject({ source: "origin" });
    expect(rig.env.notices.peek(testOrigin().key)).toEqual([]);
  });

  it("tells the delegating agent when the user answers on the panel: it is a direct intervention", async () => {
    const rig = await asking();
    await rig.env.manager.answerQuestion(rig.sessionId, rig.questionId, { answer: "web" }, USER);
    const notices = rig.env.notices.peek(testOrigin().key);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: "intervention", sessionId: rig.sessionId, text: "web" });
    expect(notices[0]?.summary).toContain("answered the question asked by");
    expect(notices[0]?.summary).toContain("Which package should I update?");
  });

  it("answers a question with several parts in order", async () => {
    const rig = await asking({
      prompts: [
        { key: "a", text: "Which package?", options: [{ label: "core" }, { label: "web" }], multiple: false, custom: false },
        { key: "b", text: "Which targets?", options: [{ label: "linux" }, { label: "win" }], multiple: true, custom: false },
      ],
    });
    const result = await rig.env.manager.answerQuestion(rig.sessionId, rig.questionId, { answers: ["web", ["linux", "win"]] }, USER);
    expect(result.outcome.answers).toEqual([["web"], ["linux", "win"]]);
    expect(rig.session.replies[0]).toMatchObject({ answers: [["web"], ["linux", "win"]] });
  });
});

describe("declining to answer", () => {
  it("tells the harness to use its own judgment, and records the decline without inventing a note", async () => {
    const rig = await asking();
    const result = await rig.env.manager.declineQuestion(rig.sessionId, rig.questionId, undefined, USER);

    expect(result).toMatchObject({ status: "declined", outcome: { by: USER, delivery: "handed_off" } });
    expect(result.outcome.note).toBeUndefined();
    expect(result.outcome.answers).toBeUndefined();
    const [reply] = rig.session.replies;
    expect(reply).toMatchObject({ kind: "decline", questionId: rig.questionId });
    expect(reply?.kind === "decline" ? reply.note : "").toContain("chose not to answer");
    expect(questionOf(rig).status).toBe("declined");
    expect(rig.env.notices.peek(testOrigin().key)[0]?.summary).toContain("chose not to answer the question");
  });

  it("passes the user's own note on to the harness and records only that note", async () => {
    const rig = await asking();
    const result = await rig.env.manager.declineQuestion(rig.sessionId, rig.questionId, "Pick whatever is simplest", USER);
    const [reply] = rig.session.replies;
    expect(reply?.kind === "decline" ? reply.note : "").toContain("They added: Pick whatever is simplest");
    expect(result.outcome.note).toBe("Pick whatever is simplest");
  });
});

describe("two replies at once", () => {
  it("lets the first one in and tells the second it lost, with the question still open", async () => {
    const rig = await asking();
    const gate = Promise.withResolvers<boolean>();
    rig.exec.questionReply = () => gate.promise;

    const first = rig.env.manager.answerQuestion(rig.sessionId, rig.questionId, { answer: "web" }, USER);
    await until(() => rig.session.replies.length === 1, 4000, "the first reply to reach the harness");
    const second = await failure(rig.env.manager.answerQuestion(rig.sessionId, rig.questionId, { answer: "core" }, AGENT));
    expect(second.code).toBe("conflict");
    expect(second.details).toMatchObject({ questionId: rig.questionId, status: "open" });
    // 输的一方什么也没发给执行端，也没有写任何事件。
    expect(rig.session.replies).toHaveLength(1);

    gate.resolve(true);
    await first;
    expect(questionOf(rig).outcome).toMatchObject({ by: USER, answers: [["web"]] });
    expect(resolvedEvents(rig)).toHaveLength(1);
  });

  it("explains afterwards who got there first, and when", async () => {
    const rig = await asking();
    await rig.env.manager.answerQuestion(rig.sessionId, rig.questionId, { answer: "web" }, USER);
    const late = await failure(rig.env.manager.answerQuestion(rig.sessionId, rig.questionId, { answer: "core" }, AGENT));
    expect(late.code).toBe("conflict");
    expect(late.message).toContain("already answered by You");
    expect(late.details).toMatchObject({ questionId: rig.questionId, status: "answered", resolvedBy: "You", resolvedByKind: "user" });
    expect(late.details?.["resolvedAt"]).toBe(questionOf(rig).outcome?.at);
    expect(rig.session.replies).toHaveLength(1);

    const decline = await failure(rig.env.manager.declineQuestion(rig.sessionId, rig.questionId, undefined, AGENT));
    expect(decline.details).toMatchObject({ status: "answered" });
  });

  it("says declined, not answered, when that is how it ended", async () => {
    const rig = await asking();
    await rig.env.manager.declineQuestion(rig.sessionId, rig.questionId, undefined, USER);
    const late = await failure(rig.env.manager.answerQuestion(rig.sessionId, rig.questionId, { answer: "core" }, AGENT));
    expect(late.details).toMatchObject({ status: "declined", resolvedByKind: "user" });
    expect(late.message).toContain("already declined");
  });
});

describe("a harness that is no longer waiting", () => {
  it("records the question as expired (not delivered) and refuses the reply, instead of pretending it worked", async () => {
    const rig = await asking({ reply: false });
    const error = await failure(rig.env.manager.answerQuestion(rig.sessionId, rig.questionId, { answer: "web" }, USER));

    expect(error.code).toBe("conflict");
    expect(error.details).toEqual({ questionId: rig.questionId, status: "expired", reason: "not_waiting" });
    const item = questionOf(rig);
    expect(item.status).toBe("expired");
    expect(item.outcome).toEqual({ at: item.outcome?.at, by: SYSTEM_ACTOR, reason: "not_waiting", delivery: "not_waiting" });
    expect(item.outcome?.answers).toBeUndefined();
    // 回复没有送达，就不告诉主 Agent“用户已经回答了”。
    expect(rig.env.notices.peek(testOrigin().key)).toEqual([]);
  });

  it("treats a harness that throws while taking the reply the same way", async () => {
    const rig = await asking({ reply: new Error("stdin closed") });
    const error = await failure(rig.env.manager.answerQuestion(rig.sessionId, rig.questionId, { answer: "web" }, USER));
    expect(error.details).toMatchObject({ status: "expired", reason: "not_waiting" });
    expect(questionOf(rig).status).toBe("expired");
  });

  it("declining is refused the same way", async () => {
    const rig = await asking({ reply: false });
    const error = await failure(rig.env.manager.declineQuestion(rig.sessionId, rig.questionId, undefined, USER));
    expect(error.details).toMatchObject({ status: "expired", reason: "not_waiting" });
  });
});

describe("a harness that rejects the reply itself", () => {
  it("reports it as a bad request and keeps the question open, so the answer can be fixed", async () => {
    const rig = await asking({ reply: new ReplyRejected("that option is not in my list") });
    const error = await failure(rig.env.manager.answerQuestion(rig.sessionId, rig.questionId, { answer: "web" }, USER));
    expect(error.code).toBe("invalid_request");
    expect(error.message).toContain("The harness did not accept this reply: that option is not in my list");
    expect(questionOf(rig).status).toBe("open");
    expect(resolvedEvents(rig)).toHaveLength(0);

    rig.exec.questionReply = true;
    await rig.env.manager.answerQuestion(rig.sessionId, rig.questionId, { answer: "core" }, USER);
    expect(questionOf(rig).status).toBe("answered");
  });
});

describe("a harness that cannot take replies to its questions", () => {
  it("says so (question_unsupported) and leaves the question open", async () => {
    const rig = await asking({ reply: "unsupported" });
    const answer = await failure(rig.env.manager.answerQuestion(rig.sessionId, rig.questionId, { answer: "web" }, USER));
    expect(answer.code).toBe("question_unsupported");
    expect(answer.status).toBe(422);
    const decline = await failure(rig.env.manager.declineQuestion(rig.sessionId, rig.questionId, undefined, USER));
    expect(decline.code).toBe("question_unsupported");
    expect(questionOf(rig).status).toBe("open");
    expect(resolvedEvents(rig)).toHaveLength(0);
  });
});

describe("what does not exist", () => {
  it("refuses an unknown session and an unknown question", async () => {
    const rig = await asking();
    const noSession = await failure(rig.env.manager.answerQuestion("ses_nope", rig.questionId, { answer: "web" }, USER));
    expect(noSession.code).toBe("not_found");
    const noQuestion = await failure(rig.env.manager.answerQuestion(rig.sessionId, "qst_nope", { answer: "web" }, USER));
    expect(noQuestion.code).toBe("not_found");
    expect(noQuestion.message).toContain("has no question qst_nope");
    const noDecline = await failure(rig.env.manager.declineQuestion(rig.sessionId, "qst_nope", undefined, USER));
    expect(noDecline.code).toBe("not_found");
  });
});

describe("a question does not outlive what it was asked in", () => {
  it("expires when the run completes, and a late reply is told so without bothering the harness", async () => {
    const rig = await asking();
    rig.session.complete(rig.runId);
    await until(() => questionOf(rig).status === "expired", 4000, "the question to expire");
    expect(questionOf(rig).outcome).toMatchObject({ by: SYSTEM_ACTOR, reason: "run_ended" });

    const error = await failure(rig.env.manager.answerQuestion(rig.sessionId, rig.questionId, { answer: "web" }, USER));
    expect(error.code).toBe("conflict");
    expect(error.details).toMatchObject({ status: "expired", reason: "run_ended" });
    expect(error.message).toContain("has expired");
    expect(rig.session.replies).toEqual([]);
  });

  it("expires as cancelled when the run is cancelled", async () => {
    const rig = await asking();
    await rig.env.manager.cancel(rig.sessionId, USER);
    await until(() => questionOf(rig).status === "expired", 4000, "the question to expire");
    expect(questionOf(rig).outcome?.reason).toBe("cancelled");
  });

  it("expires with session_closed when the session is stopped", async () => {
    const rig = await asking();
    await rig.env.manager.stop(rig.sessionId, USER);
    expect(questionOf(rig).status).toBe("expired");
    expect(questionOf(rig).outcome?.reason).toBe("session_closed");
  });

  it("expires with session_closed when the connection to the harness is lost", async () => {
    const rig = await asking();
    rig.session.fail(new Error("pi exited with code 1"));
    await until(() => questionOf(rig).status === "expired", 4000, "the question to expire");
    expect(questionOf(rig).outcome?.reason).toBe("session_closed");
  });

  it("expires with restarted when the service shuts down", async () => {
    const rig = await asking();
    await rig.env.manager.shutdown();
    expect(questionOf(rig).status).toBe("expired");
    expect(questionOf(rig).outcome?.reason).toBe("restarted");
  });
});

describe("the time limit on an unanswered question", () => {
  it("tells the harness to use its own judgment and records the question as expired (timeout, handed off)", async () => {
    const rig = await asking({ config: { questionTimeoutMs: 40 } });
    await until(() => questionOf(rig).status === "expired", 4000, "the time limit to pass");

    const item = questionOf(rig);
    expect(item.outcome).toMatchObject({ by: SYSTEM_ACTOR, reason: "timeout", delivery: "handed_off" });
    expect(item.outcome?.note).toContain("Nobody answered this question within 1 minute");
    const [reply] = rig.session.replies;
    expect(reply).toMatchObject({ kind: "decline", questionId: rig.questionId });
    expect(reply?.kind === "decline" ? reply.note : "").toContain("Nobody answered this question");
    // 时限是系统的收尾，不是用户的操作：不同步给主 Agent。
    expect(rig.env.notices.peek(testOrigin().key)).toEqual([]);
  });

  it("is switched off the moment the question is answered", async () => {
    const rig = await asking({ config: { questionTimeoutMs: 200 } });
    await rig.env.manager.answerQuestion(rig.sessionId, rig.questionId, { answer: "web" }, USER);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(rig.session.replies).toHaveLength(1);
    expect(questionOf(rig).status).toBe("answered");
    expect(resolvedEvents(rig)).toHaveLength(1);
  });

  it("is off when set to 0: the question simply keeps waiting", async () => {
    const rig = await asking({ config: { questionTimeoutMs: 0 } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(questionOf(rig).status).toBe("open");
    expect(rig.session.replies).toEqual([]);
  });

  it("still ends a question whose harness cannot take replies, for the right reason and without claiming it told anyone", async () => {
    const rig = await asking({ reply: "unsupported", config: { questionTimeoutMs: 40 } });
    await until(() => questionOf(rig).status === "expired", 4000, "the time limit to pass");
    const item = questionOf(rig);
    expect(item.outcome).toMatchObject({ by: SYSTEM_ACTOR, reason: "timeout" });
    expect(item.outcome?.delivery).toBeUndefined();
  });

  it("does nothing for a question that already ended with the run: no second ending, nothing sent to the harness", async () => {
    const rig = await asking({ config: { questionTimeoutMs: 80 } });
    rig.session.complete(rig.runId);
    await until(() => questionOf(rig).status === "expired", 4000, "the question to expire");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(questionOf(rig).outcome).toMatchObject({ by: SYSTEM_ACTOR, reason: "run_ended" });
    // 运行结束时的过期由投影兜底得出，日志里没有结局事件；时限到点时发现已经没有待回答的提问，什么也不写。
    expect(resolvedEvents(rig)).toHaveLength(0);
    expect(rig.session.replies).toEqual([]);
  });
});
