import { describe, expect, it } from "vitest";
import { LIMITS } from "@shared/constants";
import { SYSTEM_ACTOR } from "@shared/questions";
import type { RunId } from "@shared/types";
import { CodexQuestions } from "./codex-questions";
import type { RpcId } from "./codex-rpc";
import type { Json } from "./common";
import type { ExecutorDraft } from "./types";

/**
 * Codex 的业务提问（item/tool/requestUserInput）：只用桩出来的 RPC 与事件通道，不起任何进程。
 * 用真的（假）Codex 走完整流程的用例在 codex.questions.test.ts；这里补的是那边不方便触发的边角：
 * 执行端自己结清请求、运行结束、拒绝转交的各种形状、回复送不出去。
 */

const RUN = "run_1" as RunId;
const OTHER_RUN = "run_2" as RunId;

function rig(initial: { runId?: RunId | undefined; cancelRequested?: boolean } = {}) {
  const sent = { responses: [] as Array<{ id: RpcId; result: unknown }>, errors: [] as Array<{ id: RpcId; code: number; message: string }> };
  const emitted: Array<{ draft: ExecutorDraft; runId: RunId }> = [];
  const diagnostics: Array<{ level: string; code: string; message: string }> = [];
  const state = { runId: "runId" in initial ? initial.runId : RUN, cancelRequested: initial.cancelRequested ?? false, delivered: true };
  const questions = new CodexQuestions({
    rpc: () => ({
      respond: (id, result) => {
        sent.responses.push({ id, result });
        return state.delivered;
      },
      respondError: (id, code, message) => {
        sent.errors.push({ id, code, message });
        return state.delivered;
      },
    }),
    emit: (draft, runId) => {
      emitted.push({ draft, runId });
    },
    diagnostic: (level, code, message) => {
      diagnostics.push({ level, code, message });
    },
    activeRunId: () => state.runId,
    cancelRequested: () => state.cancelRequested,
  });
  return { questions, sent, emitted, diagnostics, state };
}

type Rig = ReturnType<typeof rig>;

/** 一个阻塞的、带一个问题的请求。 */
const REQUEST: Json = {
  threadId: "thr_1",
  turnId: "turn_1",
  itemId: "item_1",
  questions: [
    {
      id: "scope",
      header: "Scope",
      question: "Which package should I update?",
      isOther: true,
      isSecret: false,
      options: [{ label: "core", description: "The core package" }, { label: "web" }],
    },
  ],
};

const asked = (rig: Rig) =>
  rig.emitted.flatMap(({ draft, runId }) => (draft.kind === "question.asked" ? [{ ...draft.data.question, runId }] : []));
const resolved = (rig: Rig) =>
  rig.emitted.flatMap(({ draft, runId }) => (draft.kind === "question.resolved" ? [{ ...draft.data, runId }] : []));

/** 接手一个请求并返回它的提问编号。 */
function relay(rig: Rig, rpcId: RpcId = 7, params: Json = REQUEST): string {
  expect(rig.questions.relay(rpcId, params)).toBe(true);
  return asked(rig).at(-1)!.id;
}

describe("CodexQuestions.relay", () => {
  it("takes a blocking question, shows it as asked under the active run, and does not answer Codex yet", () => {
    const r = rig();
    expect(r.questions.relay(7, REQUEST)).toBe(true);

    expect(asked(r)).toEqual([
      {
        id: expect.stringMatching(/^qst_/),
        runId: RUN,
        prompts: [
          {
            key: "scope",
            header: "Scope",
            text: "Which package should I update?",
            options: [{ label: "core", description: "The core package" }, { label: "web" }],
            multiple: false,
            // isOther：除了选项之外还可以自己写。
            custom: true,
          },
        ],
      },
    ]);
    expect(r.questions.size).toBe(1);
    expect(r.sent.responses).toEqual([]);
    expect(r.sent.errors).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });

  it("makes a question without options free text, and one with options but no isOther a closed choice", () => {
    const r = rig();
    relay(r, 1, { questions: [{ id: "free", question: "What is the deadline?" }] });
    relay(r, 2, { questions: [{ id: "closed", question: "Which mode?", isOther: false, options: [{ label: "fast" }, { label: "safe" }] }] });
    const [free, closed] = asked(r);
    expect(free?.prompts[0]).toEqual({ key: "free", text: "What is the deadline?", multiple: false, custom: true });
    expect(closed?.prompts[0]).toMatchObject({ key: "closed", options: [{ label: "fast" }, { label: "safe" }], multiple: false, custom: false });
  });

  it("gives every request its own question id, and keeps them apart", () => {
    const r = rig();
    const first = relay(r, 1);
    const second = relay(r, 2);
    expect(first).not.toBe(second);
    expect(r.questions.size).toBe(2);
  });

  it("does not take it (so the old refusal applies) when no run is active", () => {
    const r = rig({ runId: undefined });
    expect(r.questions.relay(7, REQUEST)).toBe(false);
    expect(r.emitted).toEqual([]);
    expect(r.sent.errors).toEqual([]);
    expect(r.questions.size).toBe(0);
  });

  it("does not take it when nobody is waiting for the answer (isBlocking=false), or when it holds no usable question", () => {
    const r = rig();
    expect(r.questions.relay(1, { ...REQUEST, isBlocking: false })).toBe(false);
    expect(r.questions.relay(2, { questions: [] })).toBe(false);
    expect(r.questions.relay(3, {})).toBe(false);
    // 缺 id 或缺问题正文的条目没法回答，不当作问题。
    expect(r.questions.relay(4, { questions: [{ question: "No id" }, { id: "x" }, null, "text"] })).toBe(false);
    expect(r.emitted).toEqual([]);
    expect(r.questions.size).toBe(0);
    // 明确写 isBlocking: true（或没写）才转交。
    expect(r.questions.relay(5, { ...REQUEST, isBlocking: true })).toBe(true);
  });

  it("skips an option with no label, and keeps the labels it does show exactly as Codex wrote them", () => {
    const r = rig();
    // 没有标签的选项被忽略；剩下的选项一字不差（连中间的两个空格也在），所以仍可转交。
    relay(r, 1, { questions: [{ id: "q", question: "Pick", isOther: false, options: [{ description: "no label" }, { label: "Keep  Spacing" }] }] });
    expect(asked(r)[0]?.prompts[0]?.options).toEqual([{ label: "Keep  Spacing" }]);
  });

  describe("refuses to relay what cannot be answered faithfully, so Codex is told the old way", () => {
    it.each([
      ["a label longer than the limit (it would be shortened, so the answer could not name it)", { questions: [{ id: "q", question: "Pick", options: [{ label: "x".repeat(LIMITS.question.maxLabelChars + 1) }] }] }],
      ["a label that redaction would change", { questions: [{ id: "q", question: "Pick", options: [{ label: "sk-abcdefgh12345678" }] }] }],
      ["a label with spaces at its edges (trimming would change it)", { questions: [{ id: "q", question: "Pick", options: [{ label: " padded " }] }] }],
      ["more options than fit", { questions: [{ id: "q", question: "Pick", options: Array.from({ length: LIMITS.question.maxOptions + 1 }, (_, index) => ({ label: `opt ${index}` })) }] }],
      ["more questions than fit", { questions: Array.from({ length: LIMITS.question.maxPrompts + 1 }, (_, index) => ({ id: `q${index}`, question: `Question ${index}` })) }],
    ] as Array<[string, Json]>)("%s", (_name, params) => {
      const r = rig();
      expect(r.questions.relay(7, params)).toBe(false);
      expect(r.emitted).toEqual([]);
      expect(r.sent.errors).toEqual([]);
      expect(r.questions.size).toBe(0);
    });

    it("still relays one that only has a long question text: the text may be shortened, the labels may not", () => {
      const r = rig();
      relay(r, 1, { questions: [{ id: "q", question: "w".repeat(LIMITS.question.maxTextChars + 500), options: [{ label: "a" }, { label: "b" }] }] });
      const text = asked(r)[0]?.prompts[0]?.text ?? "";
      expect(text.length).toBeLessThanOrEqual(LIMITS.question.maxTextChars);
    });
  });

  describe("a question that asks for a secret", () => {
    const SECRET: Json = { questions: [{ id: "k", header: "API access", question: "Paste your API token", isSecret: true }] };
    // 诊断是一句固定的话：没有任何地方可以把模型写的字带进去。
    const DIAGNOSTIC =
      "Codex asked for a secret value. Ensemble does not relay secrets, so the question was declined and the session was told to proceed without it.";
    const DIAGNOSED = [{ level: "warn", code: "codex.question_secret", message: DIAGNOSTIC }];

    it("is answered with an error right away, never reaches the delegator, and leaves a diagnostic without any of the model's words", () => {
      const r = rig();
      expect(r.questions.relay(9, SECRET)).toBe(true);

      expect(r.emitted).toEqual([]);
      expect(r.questions.size).toBe(0);
      expect(r.sent.errors).toHaveLength(1);
      expect(r.sent.errors[0]).toMatchObject({ id: 9, code: -32000 });
      expect(r.sent.errors[0]?.message).toContain("secret value");
      expect(r.diagnostics).toHaveLength(1);
      expect(r.diagnostics[0]).toMatchObject({ level: "warn", code: "codex.question_secret" });
      expect(r.diagnostics[0]?.message).toContain("does not relay secrets");
      // 标题与问题都不进诊断：标题同样是模型写的，可能就是要问的内容。
      expect(r.diagnostics[0]?.message).not.toContain("API access");
      expect(r.diagnostics[0]?.message).not.toContain("Paste your API token");
    });

    it.each([
      // 没有标题：问题本身是唯一的文字。脱敏只认得出少数密钥形状，认不出主机名和口令的描述。
      ["no header, so the question is the only text", { questions: [{ id: "k", question: "What is the production database password for ZEBRA-SECRET-HOST?", isSecret: true }] }],
      ["a header, a question and options with labels and descriptions", { questions: [{ id: "k", header: "ZEBRA-SECRET-HOST", question: "Which ZEBRA-SECRET-HOST password?", isSecret: true, options: [{ label: "ZEBRA-SECRET-HOST", description: "the production database password" }] }] }],
    ] as Array<[string, Json]>)("never quotes the model's text in the diagnostic: %s", (_name, params) => {
      const r = rig();
      expect(r.questions.relay(11, params)).toBe(true);

      // 整条诊断与固定文案逐字相同，也就没有任何一个词来自模型。
      expect(r.diagnostics).toEqual(DIAGNOSED);
      expect(JSON.stringify(r.diagnostics)).not.toContain("ZEBRA");
      expect(JSON.stringify(r.diagnostics)).not.toContain("production database password");
      // 回给 Codex 的错误同样是固定的一句，不复述它的问题。
      expect(r.sent.errors).toHaveLength(1);
      expect(JSON.stringify(r.sent.errors)).not.toContain("ZEBRA");
      expect(r.emitted).toEqual([]);
    });

    it("is just as quiet when no run is active or nobody is waiting for the answer, so it never falls through to the generic refusal, which quotes the question", () => {
      const params: Json = { questions: [{ id: "k", question: "What is the production database password for ZEBRA-SECRET-HOST?", isSecret: true }] };
      const outsideRun = rig({ runId: undefined });
      const notBlocking = rig();
      expect(outsideRun.questions.relay(12, params)).toBe(true);
      expect(notBlocking.questions.relay(13, { ...params, isBlocking: false })).toBe(true);

      for (const r of [outsideRun, notBlocking]) {
        expect(r.emitted).toEqual([]);
        expect(r.questions.size).toBe(0);
        expect(r.sent.errors).toHaveLength(1);
        expect(r.sent.errors[0]?.message).toContain("secret value");
        expect(r.diagnostics).toEqual(DIAGNOSED);
      }
    });

    it("takes the whole request down with it, even when the other questions are harmless", () => {
      const r = rig();
      const mixed: Json = { questions: [{ id: "a", question: "Which package?" }, ...(SECRET["questions"] as unknown[])] };
      expect(r.questions.relay(10, mixed)).toBe(true);
      expect(r.emitted).toEqual([]);
      expect(r.sent.errors).toHaveLength(1);
      // 无害的那个问题的文字同样不在诊断里。
      expect(r.diagnostics).toEqual(DIAGNOSED);
    });
  });
});

describe("CodexQuestions.answerQuestion", () => {
  it("answers Codex under its own question ids, in the order of the questions, with every pick", async () => {
    const r = rig();
    const id = relay(r, 11, {
      questions: [
        { id: "scope", question: "Which package?", isOther: false, options: [{ label: "core" }, { label: "web" }] },
        { id: "note", question: "Anything else?" },
      ],
    });
    await expect(r.questions.answerQuestion(id, [["web"], ["No, that is all"]])).resolves.toBe(true);
    expect(r.sent.responses).toEqual([{ id: 11, result: { answers: { scope: { answers: ["web"] }, note: { answers: ["No, that is all"] } } } }]);
    expect(r.questions.size).toBe(0);
  });

  it("answers an unanswered part with an empty list rather than leaving it out", async () => {
    const r = rig();
    const id = relay(r, 12, { questions: [{ id: "a", question: "A?" }, { id: "b", question: "B?" }] });
    await r.questions.answerQuestion(id, [["yes"]]);
    expect(r.sent.responses[0]?.result).toEqual({ answers: { a: { answers: ["yes"] }, b: { answers: [] } } });
  });

  it("says the reply was not delivered when Codex's process is gone", async () => {
    const r = rig();
    const id = relay(r);
    r.state.delivered = false;
    await expect(r.questions.answerQuestion(id, [["web"]])).resolves.toBe(false);
    // 不论送没送到，这个请求已经用掉了：不会再有第二次机会。
    await expect(r.questions.answerQuestion(id, [["web"]])).resolves.toBe(false);
    expect(r.sent.responses).toHaveLength(1);
  });

  it("only ever answers a request once, and not at all for a question it does not know", async () => {
    const r = rig();
    const id = relay(r);
    await expect(r.questions.answerQuestion(id, [["web"]])).resolves.toBe(true);
    await expect(r.questions.answerQuestion(id, [["core"]])).resolves.toBe(false);
    await expect(r.questions.answerQuestion("qst_unknown", [["core"]])).resolves.toBe(false);
    expect(r.sent.responses).toHaveLength(1);
  });
});

describe("CodexQuestions.declineQuestion", () => {
  it("answers Codex with an error carrying the explanation, not with an empty answer", async () => {
    const r = rig();
    const id = relay(r, 13);
    await expect(r.questions.declineQuestion(id, "Use your own judgment.")).resolves.toBe(true);
    expect(r.sent.errors).toEqual([{ id: 13, code: -32000, message: "Use your own judgment." }]);
    expect(r.sent.responses).toEqual([]);
    expect(r.questions.size).toBe(0);
    await expect(r.questions.declineQuestion(id, "again")).resolves.toBe(false);
    await expect(r.questions.answerQuestion(id, [["web"]])).resolves.toBe(false);
  });

  it("says it was not delivered when Codex's process is gone", async () => {
    const r = rig();
    const id = relay(r);
    r.state.delivered = false;
    await expect(r.questions.declineQuestion(id, "note")).resolves.toBe(false);
  });
});

describe("CodexQuestions: Codex settles the request itself (serverRequest/resolved)", () => {
  it("records the question as withdrawn, under the run it was asked in, and stops tracking it", async () => {
    const r = rig();
    const id = relay(r, 21);
    r.questions.resolved({ threadId: "thr_1", requestId: 21 });

    expect(resolved(r)).toEqual([{ questionId: id, outcome: "expired", by: SYSTEM_ACTOR, reason: "withdrawn", runId: RUN }]);
    expect(r.questions.size).toBe(0);
    // Codex 已经不等了：不再回复它。
    await expect(r.questions.answerQuestion(id, [["web"]])).resolves.toBe(false);
    expect(r.sent.responses).toEqual([]);
    expect(r.sent.errors).toEqual([]);
  });

  it("calls it cancelled when the run was being cancelled by us", () => {
    const r = rig({ cancelRequested: true });
    relay(r, 22);
    r.questions.resolved({ requestId: 22 });
    expect(resolved(r)[0]).toMatchObject({ reason: "cancelled" });
  });

  it("matches the request id whether Codex writes it as a number or a string", () => {
    const r = rig();
    relay(r, 23);
    relay(r, "req-24");
    r.questions.resolved({ requestId: "23" });
    r.questions.resolved({ requestId: "req-24" });
    expect(resolved(r)).toHaveLength(2);
    expect(r.questions.size).toBe(0);
  });

  it("ignores a request it is not tracking, one it already answered, and a malformed notification", async () => {
    const r = rig();
    const id = relay(r, 25);
    r.questions.resolved({ requestId: 999 });
    r.questions.resolved({});
    r.questions.resolved({ requestId: { id: 25 } });
    r.questions.resolved({ requestId: null });
    expect(resolved(r)).toEqual([]);
    expect(r.questions.size).toBe(1);

    // 我们自己回复过的请求，Codex 随后通报“已结清”时不再重复收尾。
    await r.questions.answerQuestion(id, [["web"]]);
    r.questions.resolved({ requestId: 25 });
    expect(resolved(r)).toEqual([]);
  });
});

describe("CodexQuestions.runEnded and clear", () => {
  it("expires only the questions of the run that ended, as run_ended, without answering Codex", () => {
    const r = rig();
    const first = relay(r, 31);
    r.state.runId = OTHER_RUN;
    const second = relay(r, 32);

    r.questions.runEnded(RUN, false);
    expect(resolved(r)).toEqual([{ questionId: first, outcome: "expired", by: SYSTEM_ACTOR, reason: "run_ended", runId: RUN }]);
    expect(r.questions.size).toBe(1);
    expect(r.sent.responses).toEqual([]);
    expect(r.sent.errors).toEqual([]);

    r.questions.runEnded(OTHER_RUN, true);
    expect(resolved(r)[1]).toMatchObject({ questionId: second, reason: "cancelled", runId: OTHER_RUN });
    expect(r.questions.size).toBe(0);
  });

  it("does nothing for a run that has no open question", () => {
    const r = rig();
    r.questions.runEnded(RUN, false);
    expect(r.emitted).toEqual([]);
  });

  it("forgets everything when the session closes, and then there is nobody to answer", async () => {
    const r = rig();
    const id = relay(r, 41);
    r.questions.clear();
    expect(r.questions.size).toBe(0);
    // 收尾由运行时统一记录：这里不写任何事件，也不再回复。
    expect(resolved(r)).toEqual([]);
    await expect(r.questions.answerQuestion(id, [["web"]])).resolves.toBe(false);
    r.questions.resolved({ requestId: 41 });
    expect(resolved(r)).toEqual([]);
  });
});
