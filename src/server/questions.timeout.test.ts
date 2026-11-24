import { afterEach, describe, expect, it, vi } from "vitest";
import { SYSTEM_ACTOR, type QuestionId, type QuestionPrompt } from "@shared/questions";
import { USER } from "@shared/testing";
import type { QuestionItem } from "@shared/types";
import { EnsembleError } from "./errors";
import { ReplyRejected } from "./executors/types";
import { ManualExecutor, delegatorFor, makeTrackedEnv, shutdownTrackedEnvs, stateOf, until, type ManualSession, type TestEnv } from "./testing";

/**
 * 提问的时限遇上“已经在途的回复”（审阅报告 E5）。全部用假的计时器，时间由测试拨动。
 *
 * 时限的计时器一到点就先从表里删掉，随后 `expire` 发现这个提问已有回复在途（`settle` 的 inFlight），按“先到先得”让出去、什么也不写。
 * 若那个回复随后被执行端拒绝（`ReplyRejected`；按约定提问回到“待回答”，等人改了重答），修复前再也没有任何计时器去收尾它：
 * 提问会一直开着，执行端一直等一个不会来的回答。
 *
 * 修复前会失败的只有“still ends the question when the harness then rejects that reply”这一条（answer / decline 两种回复各一次）：
 * 时限到点那一刻回复还挂在执行端手里，随后被拒，提问停在 open，`expect(item.status).toBe("expired")` 过不去。
 * 修复后，被挡掉的时限记在 `overdue` 里，回复收尾时立刻补上，按 timeout 过期。
 * 其余用例（没有回复在途的基线、在途回复获胜、回复在时限之前被拒、没有时限）修复前后都成立，用来证明修复没有多做任何事。
 */

afterEach(async () => {
  // 先换回真的计时器：收尾（manager.shutdown）不该被假的计时器卡住。
  vi.useRealTimers();
  await shutdownTrackedEnvs();
});

const delegate = delegatorFor("pi", "Build the service");

/** 取一个整分钟数：告知执行端的那句话里读得出来（“within 5 minutes”）。 */
const TIMEOUT_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

const PROMPTS: QuestionPrompt[] = [
  { key: "pkg", text: "Which package should I update?", options: [{ label: "core" }, { label: "web" }], multiple: false, custom: true },
];

interface Rig {
  env: TestEnv;
  session: ManualSession;
  sessionId: string;
  runId: string;
  questionId: QuestionId;
  /** 对执行端的第一次回复卡在这里，由测试决定它的结局；之后的回复（时限的“请自行判断”）直接收下。 */
  gate: PromiseWithResolvers<boolean>;
}

/** 一个正在运行、停下来问了一个问题的会话；`timeoutMs` 是提问的时限（0 = 不设）。 */
async function asking(timeoutMs = TIMEOUT_MS): Promise<Rig> {
  const exec = new ManualExecutor("pi");
  exec.autoStart = true;
  const gate = Promise.withResolvers<boolean>();
  let replies = 0;
  exec.questionReply = () => (++replies === 1 ? gate.promise : Promise.resolve(true));
  const env = makeTrackedEnv([exec], { questionTimeoutMs: timeoutMs });
  const { sessionId, runId } = await delegate(env);
  await until(() => env.hub.summary(sessionId)?.phase === "running", 4000, "the run to start");
  const session = exec.sessions[0]!;
  // 假的计时器要先于提问装好：时限的计时器是 question.asked 到达的那一刻挂上的。
  // 装好之后不能再用 until（它靠真的 setTimeout 轮询），一律用 advance 推进；提问是同步写进日志的，计时器此刻已经挂上。
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const questionId = session.ask(runId, PROMPTS);
  return { env, session, sessionId, runId, questionId, gate };
}

/** 把时间往前拨 `ms`（缺省 0），并让已经排好的异步收尾都跑完。 */
const advance = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

const questionOf = (rig: Pick<Rig, "env" | "sessionId" | "questionId">): QuestionItem => {
  const item = stateOf(rig.env, rig.sessionId).timeline.find((entry): entry is QuestionItem => entry.type === "question" && entry.questionId === rig.questionId);
  if (!item) throw new Error("the question is not on the timeline");
  return item;
};

const resolvedEvents = (rig: Pick<Rig, "env" | "sessionId">) => rig.env.hub.events(rig.sessionId).filter((event) => event.kind === "question.resolved");

/** 一个调用抛出的 EnsembleError（没有抛就让用例失败）。先调用、后等待也安全：处理函数立刻就挂上了，不会有未处理的拒绝。 */
async function failure(call: Promise<unknown>): Promise<EnsembleError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof EnsembleError) return error;
    throw error;
  }
  throw new Error("expected the call to be refused");
}

/** 用户（页面）对这个提问的两种回复。 */
const REPLY = {
  answer: (rig: Rig) => rig.env.manager.answerQuestion(rig.sessionId, rig.questionId, { answer: "web" }, USER),
  decline: (rig: Rig) => rig.env.manager.declineQuestion(rig.sessionId, rig.questionId, undefined, USER),
};

describe("the time limit on a question while nothing is in flight", () => {
  it("ends an unanswered question exactly when the limit passes, telling the harness to use its own judgment (the baseline the cases below are measured against)", async () => {
    const rig = await asking();
    // 没有用户的回复：时限自己的“请自行判断”是第一个到执行端的，直接收下。
    rig.gate.resolve(true);

    await advance(TIMEOUT_MS - 1);
    expect(questionOf(rig).status).toBe("open");
    expect(rig.session.replies).toEqual([]);

    await advance(1);
    await advance();
    const item = questionOf(rig);
    expect(item.status).toBe("expired");
    expect(item.outcome).toMatchObject({ by: SYSTEM_ACTOR, reason: "timeout", delivery: "handed_off" });
    expect(item.outcome?.note).toContain("Nobody answered this question within 5 minutes");
    expect(rig.session.replies).toHaveLength(1);
    expect(resolvedEvents(rig)).toHaveLength(1);
  });
});

describe("the time limit passes while a reply is on its way", () => {
  it.each(["answer", "decline"] as const)(
    "still ends the question when the harness then rejects that reply (%s), instead of leaving it open for good",
    async (kind) => {
      const rig = await asking();
      // 用户的回复先到，交给了执行端，执行端还没说收下还是拒收。
      const refused = failure(REPLY[kind](rig));
      await advance();
      expect(rig.session.replies.map((reply) => reply.kind)).toEqual([kind]);

      // 时限到点，输给在途的回复：此刻什么也不写，也不打扰执行端。
      await advance(TIMEOUT_MS);
      expect(questionOf(rig).status).toBe("open");
      expect(rig.session.replies).toHaveLength(1);

      // 执行端拒收了那个回复：调用方照旧得到“请改了重答”的错误……
      rig.gate.reject(new ReplyRejected("that option is not in my list"));
      const error = await refused;
      expect(error.code).toBe("invalid_request");
      expect(error.message).toContain("The harness did not accept this reply: that option is not in my list");
      await advance();

      // ……而提问不能就此永远开着：早已到期的时限立刻补上。修复前它停在 open，再没有任何计时器去收尾它。
      const item = questionOf(rig);
      expect(item.status).toBe("expired");
      expect(item.outcome).toMatchObject({ by: SYSTEM_ACTOR, reason: "timeout", delivery: "handed_off" });
      expect(item.outcome?.note).toContain("Nobody answered this question within 5 minutes");
      expect(resolvedEvents(rig)).toHaveLength(1);

      // 执行端先后收到两次：用户被拒的那次，和时限的“请自行判断”。
      const [first, second] = rig.session.replies;
      expect(first?.kind).toBe(kind);
      expect(second).toMatchObject({ kind: "decline", questionId: rig.questionId });
      expect(second?.kind === "decline" ? second.note : "").toContain("Nobody answered this question within 5 minutes");

      // 提问已有结局：再回复得到冲突，原因写的是时限。
      const late = await failure(REPLY.answer(rig));
      expect(late.code).toBe("conflict");
      expect(late.details).toMatchObject({ status: "expired", reason: "timeout" });
    },
  );

  it("lets the reply that was already on its way win: the question ends as answered, once, and the harness is not also told to use its own judgment", async () => {
    const rig = await asking();
    const reply = REPLY.answer(rig);
    await advance();

    await advance(TIMEOUT_MS);
    expect(questionOf(rig).status).toBe("open");

    rig.gate.resolve(true);
    await expect(reply).resolves.toMatchObject({ questionId: rig.questionId, status: "answered", outcome: { by: USER, answers: [["web"]], delivery: "handed_off" } });
    await advance();

    expect(questionOf(rig).outcome).toMatchObject({ by: USER, answers: [["web"]], delivery: "handed_off" });
    expect(resolvedEvents(rig)).toHaveLength(1);
    expect(rig.session.replies).toHaveLength(1);
    // 被挡掉的时限没有留下任何东西：之后再久也不会有第二个结局。
    await advance(DAY_MS);
    expect(resolvedEvents(rig)).toHaveLength(1);
    expect(rig.session.replies).toHaveLength(1);
  });
});

describe("a reply that is rejected before the limit has passed", () => {
  it("leaves the original limit alone: no early expiry, no fresh window, and exactly one ending", async () => {
    const rig = await asking();
    const refused = failure(REPLY.answer(rig));
    await advance();

    await advance(TIMEOUT_MS / 2);
    rig.gate.reject(new ReplyRejected("that option is not in my list"));
    expect((await refused).code).toBe("invalid_request");
    await advance();
    expect(questionOf(rig).status).toBe("open");
    expect(rig.session.replies).toHaveLength(1);

    // 到原来的时刻之前一毫秒还开着；到了那一刻由原来的计时器收尾——不是从被拒的那一刻起重新数一个完整的时限。
    await advance(TIMEOUT_MS / 2 - 1);
    expect(questionOf(rig).status).toBe("open");
    await advance(1);
    await advance();
    expect(questionOf(rig).status).toBe("expired");
    expect(questionOf(rig).outcome).toMatchObject({ by: SYSTEM_ACTOR, reason: "timeout", delivery: "handed_off" });
    expect(resolvedEvents(rig)).toHaveLength(1);
    expect(rig.session.replies).toHaveLength(2);
  });

  it("does not invent a limit where there is none (0 = off): the question simply stays open after the rejection", async () => {
    const rig = await asking(0);
    const refused = failure(REPLY.answer(rig));
    await advance();

    await advance(DAY_MS);
    rig.gate.reject(new ReplyRejected("that option is not in my list"));
    expect((await refused).code).toBe("invalid_request");
    await advance(DAY_MS);

    expect(questionOf(rig).status).toBe("open");
    expect(resolvedEvents(rig)).toHaveLength(0);
    expect(rig.session.replies).toHaveLength(1);
  });
});
