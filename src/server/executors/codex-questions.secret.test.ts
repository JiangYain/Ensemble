import { describe, expect, it } from "vitest";
import type { RunId } from "@shared/types";
import { CodexQuestions } from "./codex-questions";
import type { RpcId } from "./codex-rpc";
import type { Json } from "./common";
import type { ExecutorDraft } from "./types";

/**
 * 机密类提问（item/tool/requestUserInput 里标了 `isSecret` 的条目）的识别，补 codex-questions.test.ts 没有覆盖的一类：
 * 转交读不出的条目——缺 `id`、`id` 为空或不是字符串、缺问题正文——照样可能是机密类提问，不能因为读不出就被悄悄丢掉。
 * 请求里只要有一条原始条目标了机密，整个请求都不转交，诊断码是 `codex.question_secret`，文字是固定的、不含请求里的任何字。
 * 只用桩出来的 RPC 与事件通道，不起任何进程。
 */

const RUN: RunId = "run_1";

interface RigOptions {
  runId?: RunId | undefined;
}

function rig(options: RigOptions = {}) {
  const errors: Array<{ id: RpcId; code: number; message: string }> = [];
  const responses: Array<{ id: RpcId; result: unknown }> = [];
  const emitted: ExecutorDraft[] = [];
  const diagnostics: Array<{ level: string; code: string; message: string }> = [];
  const questions = new CodexQuestions({
    rpc: () => ({
      respond: (id, result) => {
        responses.push({ id, result });
        return true;
      },
      respondError: (id, code, message) => {
        errors.push({ id, code, message });
        return true;
      },
    }),
    emit: (draft) => {
      emitted.push(draft);
    },
    diagnostic: (level, code, message) => {
      diagnostics.push({ level, code, message });
    },
    activeRunId: () => ("runId" in options ? options.runId : RUN),
    cancelRequested: () => false,
  });
  return { questions, errors, responses, emitted, diagnostics };
}

/**
 * 格式正确的机密类条目走的是标准做法：回给 Codex 一句固定的错误，时间线上留一条固定的诊断。
 * 读不出的机密类条目必须得到与它逐字相同的处理。不另抄一份期望文字，免得文案改了两边不同步；
 * 这里的请求文字与下面各用例的都不同，所以诊断或错误里只要引用了请求里的任何字，逐字比较就会不相等。
 */
function standardRefusal() {
  const r = rig();
  expect(r.questions.relay(1, { questions: [{ id: "k", question: "Paste the key", isSecret: true }] })).toBe(true);
  expect(r.errors).toHaveLength(1);
  expect(r.errors[0]).toMatchObject({ id: 1, code: -32000 });
  expect(r.diagnostics).toHaveLength(1);
  expect(r.diagnostics[0]).toMatchObject({ level: "warn", code: "codex.question_secret" });
  return { errors: r.errors, diagnostics: r.diagnostics };
}

// 模型写的字：标题、问题、选项里各放着同一个词，哪一处被引用了都看得出来。
const WORDS = "ZEBRA-SECRET-HOST";
const ASKED = `What is the production database password for ${WORDS}?`;

/** 一个无害的、转交读得出的问题：混在请求里，看它会不会被连累，或者反过来让机密条目消失。 */
const HARMLESS: Json = { id: "scope", question: "Which package should I update?" };

const secretEntry = (extra: Json): Json => ({ header: WORDS, options: [{ label: WORDS, description: ASKED }], isSecret: true, ...extra });

const NO_ID = secretEntry({ question: ASKED });

/** 机密类条目各种“转交读不出”的形状：转交只认带非空字符串 `id` 与问题正文的条目。 */
const UNREADABLE: Array<[string, Json]> = [
  ["no id", NO_ID],
  ["an empty id", secretEntry({ id: "", question: ASKED })],
  ["an id that is not a string", secretEntry({ id: 7, question: ASKED })],
  ["no question text", secretEntry({ id: "k" })],
  ["an empty question text", secretEntry({ id: "k", question: "" })],
];

describe("CodexQuestions.relay: a secret question the reader cannot parse", () => {
  describe.each(UNREADABLE)("with %s", (_shape, entry) => {
    it("takes the whole request down with it when ordinary questions come along, whichever comes first", () => {
      const refused = standardRefusal();
      for (const questions of [[HARMLESS, entry], [entry, HARMLESS]]) {
        const r = rig();
        expect(r.questions.relay(1, { questions })).toBe(true);

        // 整个请求都不转交：无害的那个问题没有变成提问，也没有悄悄只剩它一个。
        expect(r.emitted).toEqual([]);
        expect(r.questions.size).toBe(0);
        // Codex 恰好得到一个应答，与格式正确的机密条目逐字相同；没有回答。
        expect(r.responses).toEqual([]);
        expect(r.errors).toEqual(refused.errors);
        // 诊断码是 codex.question_secret，文案固定。
        expect(r.diagnostics).toEqual(refused.diagnostics);
        // 请求里的字一个也没有写出去（连无害的那个问题也没有）。
        const written = JSON.stringify([r.errors, r.diagnostics, r.emitted]);
        expect(written).not.toContain("ZEBRA");
        expect(written).not.toContain("production database password");
        expect(written).not.toContain("Which package");
      }
    });

    it("refuses it the same way when it is the only entry, instead of falling back to the generic refusal", () => {
      const refused = standardRefusal();
      const r = rig();
      // true = 这里已经应答了；退回老办法（false）的话，调用方回的是另一句话、诊断码是 codex.question_unanswered。
      expect(r.questions.relay(1, { questions: [entry] })).toBe(true);

      expect(r.errors).toEqual(refused.errors);
      expect(r.diagnostics).toEqual(refused.diagnostics);
      expect(r.emitted).toEqual([]);
      expect(r.responses).toEqual([]);
      expect(r.questions.size).toBe(0);
    });

    it.each([
      ["no run is active", { runId: undefined }, {}],
      ["nobody is waiting for the answer (isBlocking=false)", {}, { isBlocking: false }],
    ] as Array<[string, RigOptions, Json]>)("refuses it the same way when %s, so it never reaches the old refusal that quotes the question", (_when, options, extra) => {
      const refused = standardRefusal();
      const r = rig(options);
      expect(r.questions.relay(1, { ...extra, questions: [HARMLESS, entry] })).toBe(true);

      expect(r.errors).toEqual(refused.errors);
      expect(r.diagnostics).toEqual(refused.diagnostics);
      expect(r.emitted).toEqual([]);
    });
  });

  it("finds the secret entry among entries of any shape, including ones that are not objects at all", () => {
    const refused = standardRefusal();
    const r = rig();
    expect(r.questions.relay(1, { questions: [null, "text", 5, [], HARMLESS, NO_ID, { id: "x" }] })).toBe(true);

    expect(r.errors).toEqual(refused.errors);
    expect(r.diagnostics).toEqual(refused.diagnostics);
    expect(r.emitted).toEqual([]);
  });
});

describe("CodexQuestions.relay: what is not marked as a secret is relayed as before", () => {
  it.each([
    ['the string "true"', "true"],
    ["the number 1", 1],
    ['the string "yes"', "yes"],
    ["null", null],
    ["false", false],
  ] as Array<[string, unknown]>)("%s is not a secret: the flag must be exactly true", (_what, flag) => {
    const r = rig();
    expect(r.questions.relay(1, { questions: [{ id: "k", question: "Paste your API token", isSecret: flag }] })).toBe(true);

    // 当作普通提问转交：记为待回答，Codex 还没有应答，也没有任何诊断。
    expect(r.emitted.map((draft) => draft.kind)).toEqual(["question.asked"]);
    expect(r.questions.size).toBe(1);
    expect(r.errors).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });

  it("drops an unreadable entry that is not marked as a secret, as it always did: the readable ones go on", () => {
    const r = rig();
    expect(r.questions.relay(1, { questions: [HARMLESS, { question: "No id, and the flag is not a boolean", isSecret: "true" }] })).toBe(true);

    const keys = r.emitted.flatMap((draft) => (draft.kind === "question.asked" ? [draft.data.question.prompts.map((prompt) => prompt.key)] : []));
    expect(keys).toEqual([["scope"]]);
    expect(r.errors).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });

  it("does not take a request whose only entries are unreadable and not secret: the caller refuses it the old way", () => {
    const r = rig();
    expect(r.questions.relay(1, { questions: [{ question: "No id" }, { id: "x", isSecret: false }] })).toBe(false);

    expect(r.emitted).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });
});
