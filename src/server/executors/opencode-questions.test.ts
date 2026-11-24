import { describe, expect, it } from "vitest";
import { LIMITS } from "@shared/constants";
import { SYSTEM_ACTOR } from "@shared/questions";
import type { RunId } from "@shared/types";
import type { Json } from "./common";
import { OpenCodeHttpError } from "./opencode-api";
import { OpenCodeQuestions } from "./opencode-questions";
import { ReplyRejected, type ExecutorDraft } from "./types";

/**
 * OpenCode 的业务提问（form.created 里 metadata.kind 为 question 的表单）：只用桩出来的 HTTP 与事件通道，不起任何进程。
 * 用假 OpenCode 走完整流程的用例在 opencode.test.ts；这里补的是那边不方便触发的边角：
 * 字段取值的各种形状、回复被拒 / 表单已不在、回声与并发、转不了的提问怎样撤回。
 * 表单的字段与状态码取自 OpenCode 2.3.0 随包的源码，没有在真实的 OpenCode 里触发过。
 */

const RUN = "run_1" as RunId;
const OTHER_RUN = "run_2" as RunId;

function rig(initial: { runId?: RunId | undefined } = {}) {
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const emitted: Array<{ draft: ExecutorDraft; runId: RunId }> = [];
  const diagnostics: Array<{ level: string; code: string; message: string }> = [];
  const debugged: string[] = [];
  const state = {
    runId: "runId" in initial ? initial.runId : RUN,
    cancelRequested: false,
    /** 每个请求怎样回应；默认成功（204）。 */
    respond: (): Promise<unknown> => Promise.resolve(undefined),
  };
  const questions = new OpenCodeQuestions({
    sessionId: () => "ses_1",
    request: (method, path, body) => {
      requests.push({ method, path, ...(body !== undefined ? { body } : {}) });
      return state.respond();
    },
    emit: (draft, runId) => {
      emitted.push({ draft, runId });
    },
    diagnostic: (level, code, message) => {
      diagnostics.push({ level, code, message });
    },
    activeRunId: () => state.runId,
    cancelRequested: () => state.cancelRequested,
    debug: (message) => {
      debugged.push(message);
    },
  });
  return { questions, requests, emitted, diagnostics, debugged, state };
}

type Rig = ReturnType<typeof rig>;

/** 一个问题的表单字段。 */
const field = (extra: Json = {}): Json => ({ key: "q0", type: "string", title: "Color", description: "Which color should the button be?", ...extra });

const FORM: Json = {
  id: "frm_1",
  title: "Questions",
  metadata: { kind: "question" },
  fields: [
    field({ options: [{ value: "r", label: "Red" }, { value: "b", label: "Blue", description: "calm" }], custom: true }),
    { key: "q1", type: "multiselect", title: "Letters", description: "Which letters?", options: [{ value: "a", label: "Alpha" }, { value: "b", label: "beta" }] },
  ],
};

const formWith = (fields: Json[], extra: Json = {}): Json => ({ id: "frm_1", title: "Questions", metadata: { kind: "question" }, fields, ...extra });

const asked = (r: Rig) => r.emitted.flatMap(({ draft, runId }) => (draft.kind === "question.asked" ? [{ ...draft.data.question, runId }] : []));
const resolved = (r: Rig) => r.emitted.flatMap(({ draft, runId }) => (draft.kind === "question.resolved" ? [{ ...draft.data, runId }] : []));

/** 接手一个表单并返回它的提问编号。 */
function open(r: Rig, form: Json = FORM): string {
  expect(r.questions.created(form)).toBe(true);
  const last = asked(r).at(-1);
  if (!last) throw new Error("the form was not relayed as a question");
  return last.id;
}

const REPLY = "/api/session/ses_1/form/frm_1/reply";
const withdrawals = (r: Rig) => r.requests.filter((request) => request.method === "DELETE");

describe("OpenCodeQuestions.created", () => {
  it("relays a question form as asked under the active run, with each field as a question and its options as labels", () => {
    const r = rig();
    expect(r.questions.created(FORM)).toBe(true);

    expect(asked(r)).toEqual([
      {
        id: expect.stringMatching(/^qst_/),
        runId: RUN,
        prompts: [
          { key: "q0", header: "Color", text: "Which color should the button be?", options: [{ label: "Red" }, { label: "Blue", description: "calm" }], multiple: false, custom: true },
          { key: "q1", header: "Letters", text: "Which letters?", options: [{ label: "Alpha" }, { label: "beta" }], multiple: true, custom: true },
        ],
      },
    ]);
    expect(r.questions.size).toBe(1);
    expect(r.requests).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });

  it("is not its business when the form is not a question, or has no id: the caller handles it the old way", () => {
    const r = rig();
    expect(r.questions.created({ ...FORM, metadata: { kind: "other" } })).toBe(false);
    expect(r.questions.created({ ...FORM, metadata: {} })).toBe(false);
    expect(r.questions.created({ id: "frm_9", fields: FORM["fields"] })).toBe(false);
    expect(r.questions.created({ ...FORM, id: undefined })).toBe(false);
    expect(r.emitted).toEqual([]);
    expect(r.requests).toEqual([]);
    expect(r.diagnostics).toEqual([]);
    expect(r.questions.size).toBe(0);
  });

  describe("how a field becomes a question", () => {
    const only = (extra: Json) => {
      const r = rig();
      open(r, formWith([field(extra)]));
      return asked(r)[0]!.prompts[0]!;
    };

    it("uses the description as the question and the title as its header; a lone title is the question itself", () => {
      expect(only({})).toMatchObject({ header: "Color", text: "Which color should the button be?" });
      const lone = only({ description: undefined });
      expect(lone.text).toBe("Color");
      expect(lone).not.toHaveProperty("header");
    });

    it("allows writing one's own answer unless the field says custom: false; a field without options is free text either way", () => {
      const options = [{ value: "r", label: "Red" }];
      expect(only({ options })).toMatchObject({ custom: true });
      expect(only({ options, custom: true })).toMatchObject({ custom: true });
      expect(only({ options, custom: false })).toMatchObject({ custom: false });
      expect(only({ custom: false })).toMatchObject({ custom: true });
      expect(only({ custom: false })).not.toHaveProperty("options");
    });

    it("falls back between an option's label and value, and shows what it has", () => {
      const prompt = only({ options: [{ value: "only-value" }, { label: "Only label" }, { value: "v", label: "Both", description: "note" }, { description: "nothing to show" }] });
      expect(prompt.options).toEqual([{ label: "only-value" }, { label: "Only label" }, { label: "Both", description: "note" }]);
    });

    it("makes a multiselect field multiple choice", () => {
      expect(only({ type: "multiselect", options: [{ value: "a", label: "A" }] })).toMatchObject({ multiple: true });
      expect(only({ type: "string", options: [{ value: "a", label: "A" }] })).toMatchObject({ multiple: false });
    });
  });

  describe("withdraws, with an explanation, a question it cannot relay faithfully (the model assumes and the run goes on)", () => {
    function expectWithdrawn(r: Rig, title: string): void {
      expect(r.emitted).toEqual([]);
      expect(r.questions.size).toBe(0);
      expect(withdrawals(r)).toHaveLength(1);
      const request = withdrawals(r)[0]!;
      expect(request.path.startsWith("/api/session/ses_1/form/frm_1?message=")).toBe(true);
      expect(decodeURIComponent(request.path)).toContain("Ensemble could not relay this question to a person.");
      expect(r.diagnostics).toEqual([{ level: "warn", code: "opencode.question_unanswered", message: expect.stringContaining(`("${title}")`) }]);
    }

    it.each([
      ["no fields", formWith([])],
      ["a field type it does not know", formWith([field({ type: "number" })])],
      ["a field without a key", formWith([field({ key: undefined })])],
      ["a field with neither title nor description", formWith([field({ title: undefined, description: undefined })])],
      ["a field whose text is only whitespace (nothing would be shown)", formWith([field({ description: "   " })])],
      ["more options than fit", formWith([field({ options: Array.from({ length: LIMITS.question.maxOptions + 1 }, (_, index) => ({ value: `v${index}`, label: `Option ${index}` })) })])],
      ["more questions than fit", formWith(Array.from({ length: LIMITS.question.maxPrompts + 1 }, (_, index) => field({ key: `q${index}`, description: `Question ${index}` })))],
    ] as Array<[string, Json]>)("%s", (_name, form) => {
      const r = rig();
      expect(r.questions.created(form)).toBe(true);
      expectWithdrawn(r, "Questions");
    });

    it("also when no run is active (nothing to hang the question on)", () => {
      const r = rig({ runId: undefined });
      expect(r.questions.created(FORM)).toBe(true);
      expectWithdrawn(r, "Questions");
    });

    it("names the question 'a question' when the form has no title, and redacts what it quotes", () => {
      const untitled = rig();
      untitled.questions.created(formWith([], { title: undefined }));
      expect(untitled.diagnostics[0]?.message).toContain('("a question")');

      const secret = rig();
      secret.questions.created(formWith([], { title: "Use token=abcdefghijkl1234" }));
      expect(secret.diagnostics[0]?.message).not.toContain("abcdefghijkl1234");
    });

    it("carries on when the withdrawal itself fails: the question is still reported as handled, and the failure goes to the debug log", async () => {
      const r = rig();
      r.state.respond = () => Promise.reject(new Error("connection refused"));
      expect(r.questions.created(formWith([]))).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(r.debugged).toEqual(["opencode: form withdraw failed"]);
    });
  });
});

describe("OpenCodeQuestions.answerQuestion", () => {
  it("replies with the values OpenCode gave (not the labels shown), one entry per field, a list for a multiselect", async () => {
    const r = rig();
    const id = open(r);
    await expect(r.questions.answerQuestion(id, [["Red"], ["Alpha", "beta"]])).resolves.toBe(true);
    expect(r.requests).toEqual([{ method: "POST", path: REPLY, body: { answer: { q0: "r", q1: ["a", "b"] } } }]);
    expect(r.questions.size).toBe(0);
  });

  it("hands over free text exactly as written", async () => {
    const r = rig();
    const id = open(r);
    await r.questions.answerQuestion(id, [["Teal, please"], ["Alpha"]]);
    expect(r.requests[0]?.body).toEqual({ answer: { q0: "Teal, please", q1: ["a"] } });
  });

  it("takes the first pick for a single-choice field, and sends an empty answer rather than leaving the field out", async () => {
    const r = rig();
    const id = open(r, formWith([field({ options: [{ value: "r", label: "Red" }] }), field({ key: "q1", description: "Another?" })]));
    await r.questions.answerQuestion(id, [["Red", "Red"]]);
    expect(r.requests[0]?.body).toEqual({ answer: { q0: "r", q1: "" } });
  });

  it("only ever replies once, and not at all for a question it does not know", async () => {
    const r = rig();
    const id = open(r);
    await expect(r.questions.answerQuestion(id, [["Red"], ["Alpha"]])).resolves.toBe(true);
    await expect(r.questions.answerQuestion(id, [["Blue"], ["Alpha"]])).resolves.toBe(false);
    await expect(r.questions.answerQuestion("qst_unknown", [["Blue"], ["Alpha"]])).resolves.toBe(false);
    expect(r.requests).toHaveLength(1);
  });

  it("raises ReplyRejected when OpenCode finds the answer unacceptable (400), and keeps the form waiting so the answer can be fixed", async () => {
    const r = rig();
    const id = open(r);
    r.state.respond = () => Promise.reject(new OpenCodeHttpError(400, "answer q0 is not one of the options\nand more"));
    const failure = await r.questions.answerQuestion(id, [["Red"], ["Alpha"]]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReplyRejected);
    expect((failure as Error).message).toBe("answer q0 is not one of the options and more");
    expect(r.questions.size).toBe(1);

    r.state.respond = () => Promise.resolve(undefined);
    await expect(r.questions.answerQuestion(id, [["Blue"], ["Alpha"]])).resolves.toBe(true);
    expect(r.questions.size).toBe(0);
  });

  it.each([404, 409])("says the form is no longer waiting (false) on a %i, and forgets it", async (status) => {
    const r = rig();
    const id = open(r);
    r.state.respond = () => Promise.reject(new OpenCodeHttpError(status, "gone"));
    await expect(r.questions.answerQuestion(id, [["Red"], ["Alpha"]])).resolves.toBe(false);
    expect(r.questions.size).toBe(0);
  });

  it("lets any other failure through to the caller, and does not leave the question hanging", async () => {
    const r = rig();
    const id = open(r);
    r.state.respond = () => Promise.reject(new Error("socket hang up"));
    await expect(r.questions.answerQuestion(id, [["Red"], ["Alpha"]])).rejects.toThrow("socket hang up");
    expect(r.questions.size).toBe(0);
    r.state.respond = () => Promise.reject(new OpenCodeHttpError(500, "server error"));
    const second = open(r, formWith([field()], { id: "frm_2" }));
    await expect(r.questions.answerQuestion(second, [["x"]])).rejects.toBeInstanceOf(OpenCodeHttpError);
    expect(r.questions.size).toBe(0);
  });

  it("while a reply is on its way, ignores a second reply and OpenCode's own echo of the first (it is not a withdrawal)", async () => {
    const r = rig();
    const id = open(r);
    const gate = Promise.withResolvers<undefined>();
    r.state.respond = () => gate.promise;

    const first = r.questions.answerQuestion(id, [["Red"], ["Alpha"]]);
    await expect(r.questions.answerQuestion(id, [["Blue"], ["Alpha"]])).resolves.toBe(false);
    await expect(r.questions.declineQuestion(id, "no")).resolves.toBe(false);
    // form.replied：我们自己回复的回声，不当作“被撤回”。
    r.questions.settled("frm_1");
    expect(resolved(r)).toEqual([]);

    gate.resolve(undefined);
    await expect(first).resolves.toBe(true);
    expect(r.requests).toHaveLength(1);
    expect(resolved(r)).toEqual([]);
  });
});

describe("OpenCodeQuestions.declineQuestion", () => {
  it("withdraws the form with the explanation in the query, so the run goes on", async () => {
    const r = rig();
    const id = open(r);
    const note = "Whoever delegated this task chose not to answer. They added: either is fine & dandy?";
    await expect(r.questions.declineQuestion(id, note)).resolves.toBe(true);

    expect(r.requests).toHaveLength(1);
    const [request] = r.requests;
    expect(request?.method).toBe("DELETE");
    expect(request?.path).toBe(`/api/session/ses_1/form/frm_1?message=${encodeURIComponent(note)}`);
    expect(request?.path).not.toContain(" ");
    expect(decodeURIComponent(request?.path.split("?message=")[1] ?? "")).toBe(note);
    expect(r.questions.size).toBe(0);
    await expect(r.questions.declineQuestion(id, note)).resolves.toBe(false);
  });

  it("says the form is no longer waiting when it is gone", async () => {
    const r = rig();
    const id = open(r);
    r.state.respond = () => Promise.reject(new OpenCodeHttpError(404, "no such form"));
    await expect(r.questions.declineQuestion(id, "note")).resolves.toBe(false);
    expect(r.questions.size).toBe(0);
  });

  it("does not know a question it never relayed", async () => {
    const r = rig();
    await expect(r.questions.declineQuestion("qst_unknown", "note")).resolves.toBe(false);
    expect(r.requests).toEqual([]);
  });
});

describe("OpenCodeQuestions: OpenCode settles the form itself (form.replied / form.cancelled)", () => {
  it("records the question as withdrawn under its run, and stops tracking it", async () => {
    const r = rig();
    const id = open(r);
    r.questions.settled("frm_1");
    expect(resolved(r)).toEqual([{ questionId: id, outcome: "expired", by: SYSTEM_ACTOR, reason: "withdrawn", runId: RUN }]);
    expect(r.questions.size).toBe(0);
    await expect(r.questions.answerQuestion(id, [["Red"], ["Alpha"]])).resolves.toBe(false);
    expect(r.requests).toEqual([]);
  });

  it("calls it cancelled when the run was being cancelled by us", () => {
    const r = rig();
    open(r);
    r.state.cancelRequested = true;
    r.questions.settled("frm_1");
    expect(resolved(r)[0]).toMatchObject({ reason: "cancelled" });
  });

  it("ignores a form it is not tracking, and a notification without an id", () => {
    const r = rig();
    open(r);
    r.questions.settled("frm_other");
    r.questions.settled(undefined);
    r.questions.settled("");
    expect(resolved(r)).toEqual([]);
    expect(r.questions.size).toBe(1);
  });
});

describe("OpenCodeQuestions.runEnded and clear", () => {
  it("expires only the questions of the run that ended, as run_ended or cancelled, without touching OpenCode", () => {
    const r = rig();
    const first = open(r);
    r.state.runId = OTHER_RUN;
    const second = open(r, formWith([field()], { id: "frm_2" }));

    r.questions.runEnded(RUN, false);
    expect(resolved(r)).toEqual([{ questionId: first, outcome: "expired", by: SYSTEM_ACTOR, reason: "run_ended", runId: RUN }]);
    expect(r.questions.size).toBe(1);

    r.questions.runEnded(OTHER_RUN, true);
    expect(resolved(r)[1]).toMatchObject({ questionId: second, reason: "cancelled", runId: OTHER_RUN });
    expect(r.questions.size).toBe(0);
    expect(r.requests).toEqual([]);
  });

  it("forgets everything when the session closes: no events, and nobody left to answer", async () => {
    const r = rig();
    const id = open(r);
    r.questions.clear();
    expect(r.questions.size).toBe(0);
    expect(resolved(r)).toEqual([]);
    await expect(r.questions.answerQuestion(id, [["Red"], ["Alpha"]])).resolves.toBe(false);
  });
});
