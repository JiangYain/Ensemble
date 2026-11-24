import { describe, expect, it } from "vitest";
import { SYSTEM_ACTOR, type QuestionOutcomeRecord, type QuestionPrompt, type QuestionStatus } from "@shared/questions";
import { AGENT, USER } from "@shared/testing";
import type { QuestionItem } from "@shared/types";
import { questionItemLine, questionLines, questionSummary, replyHint } from "./format-questions";

const SINCE = "2026-01-01T00:00:00.000Z";
const NOW = Date.parse("2026-01-01T00:02:30.000Z");
const SESSION = { id: "ses_1", harness: "Pi" };

const CHOICE: QuestionPrompt = {
  key: "pkg",
  text: "Which package should I update?",
  options: [{ label: "core", description: "the engine" }, { label: "web" }],
  multiple: false,
  custom: true,
};
const FREE: QuestionPrompt = { key: "why", text: "What is the deadline?", multiple: false, custom: true };

/** 不在写给主模型的提问文字里出现的词：提问不是授权。 */
const AUTHORIZATION_WORDS = /authori[sz]|approv|permission|allow|reject|deny|denied|consent/i;

describe("replyHint", () => {
  it("shows the exact `send` call for one prompt: an answer, or a decline that lets the session use its own judgment", () => {
    expect(replyHint("ses_1", "qst_a", 1)).toBe(
      'reply with `send`: { sessionId: "ses_1", questionId: "qst_a", answer: "<an option label, or your own text>" } — or { sessionId: "ses_1", questionId: "qst_a", decline: true } to let the session use its own judgment',
    );
  });

  it("asks for one entry per question, in order, when there are several", () => {
    const hint = replyHint("ses_1", "qst_a", 3);
    expect(hint).toContain("answers: [one entry per question, in order; an array of labels for a multiple-choice one]");
    expect(hint).not.toContain("answer:");
    expect(hint).toContain("decline: true");
  });

  it("never uses authorization words", () => {
    for (const count of [1, 2]) expect(replyHint("ses_1", "qst_a", count)).not.toMatch(AUTHORIZATION_WORDS);
  });
});

describe("questionLines", () => {
  it("writes who is waiting for how long, the question, its options and how to reply", () => {
    expect(questionLines({ questionId: "qst_a", prompts: [CHOICE], since: SINCE }, SESSION, NOW)).toEqual([
      "    question qst_a: Pi has been waiting for 2m 30s for an answer",
      "      Which package should I update?",
      '         options (pick one, or write your own): "core" — the engine | "web"',
      `      ${replyHint("ses_1", "qst_a", 1)}`,
    ]);
  });

  it("says a free-text prompt is free text, and a closed one takes only its options", () => {
    expect(questionLines({ questionId: "qst_a", prompts: [FREE], since: SINCE }, SESSION, NOW)).toContain("         (free-text answer)");
    const closed: QuestionPrompt = { ...CHOICE, custom: false, multiple: true };
    const lines = questionLines({ questionId: "qst_a", prompts: [closed], since: SINCE }, SESSION, NOW);
    expect(lines).toContain('         options (pick any): "core" — the engine | "web"');
  });

  it("numbers several questions, keeps each one's header, and says how many there are", () => {
    const lines = questionLines(
      { questionId: "qst_a", prompts: [{ ...CHOICE, header: "Scope" }, FREE], since: SINCE },
      SESSION,
      NOW,
    );
    expect(lines[0]).toBe("    question qst_a: Pi has been waiting for 2m 30s for an answer to 2 questions");
    expect(lines).toContain("      1. [Scope] Which package should I update?");
    expect(lines).toContain("      2. What is the deadline?");
    expect(lines.at(-1)).toContain("answers: [one entry per question");
  });

  it("collapses whitespace, and says out loud when a long question was shortened", () => {
    const long: QuestionPrompt = { ...FREE, text: `Line one\n\n   line two ${"x".repeat(700)}` };
    const lines = questionLines({ questionId: "qst_a", prompts: [long], since: SINCE }, SESSION, NOW);
    const shown = lines[1]!;
    expect(shown.startsWith("      Line one line two xxx")).toBe(true);
    expect(shown).not.toContain("\n");
    expect(shown).toContain("[shortened — the full text is in the panel]");
    expect(shown.length).toBeLessThan(600);

    const exact: QuestionPrompt = { ...FREE, text: "y".repeat(500) };
    expect(questionLines({ questionId: "qst_a", prompts: [exact], since: SINCE }, SESSION, NOW)[1]).not.toContain("shortened");
  });

  it("shortens a long option description, and leaves the others whole", () => {
    const wordy: QuestionPrompt = { ...CHOICE, options: [{ label: "core", description: `desc ${"d".repeat(300)}` }, { label: "web" }] };
    const options = questionLines({ questionId: "qst_a", prompts: [wordy], since: SINCE }, SESSION, NOW)[2]!;
    expect(options).toContain('"web"');
    expect(options).toContain("…");
    expect(options.length).toBeLessThan(260);
  });

  it("leaves out the waiting time when the question has no usable time", () => {
    const [head] = questionLines({ questionId: "qst_a", prompts: [CHOICE], since: "not a time" }, SESSION, NOW);
    expect(head).toBe("    question qst_a: Pi has been waiting for an answer");
  });

  it("never uses authorization words", () => {
    const lines = questionLines({ questionId: "qst_a", prompts: [CHOICE, FREE], since: SINCE }, SESSION, NOW).join("\n");
    expect(lines).not.toMatch(AUTHORIZATION_WORDS);
  });
});

describe("questionSummary", () => {
  it("is one line with the first question only, and says how many more there are", () => {
    expect(questionSummary({ questionId: "qst_a", prompts: [CHOICE], since: SINCE }, "Pi")).toBe(
      'Pi is waiting for an answer to a question (qst_a): "Which package should I update?"',
    );
    expect(questionSummary({ questionId: "qst_a", prompts: [CHOICE, FREE, FREE], since: SINCE }, "Pi")).toBe(
      'Pi is waiting for an answer to a question (qst_a): "Which package should I update?" (+2 more)',
    );
  });

  it("flattens line breaks and clips a very long question", () => {
    const text = questionSummary({ questionId: "qst_a", prompts: [{ ...FREE, text: `a\nb ${"z".repeat(400)}` }], since: SINCE }, "Pi");
    expect(text).not.toContain("\n");
    expect(text).toContain('"a b zzz');
    expect(text).toContain('…"');
    expect(text.length).toBeLessThan(260);
  });
});

describe("questionItemLine", () => {
  function item(status: QuestionStatus, outcome?: QuestionOutcomeRecord, prompts: QuestionPrompt[] = [CHOICE]): QuestionItem {
    return {
      id: "question:qst_a",
      type: "question",
      questionId: "qst_a",
      prompts,
      status,
      at: SINCE,
      updatedAt: SINCE,
      ...(outcome ? { outcome } : {}),
    };
  }
  const at = "2026-01-01T00:01:00.000Z";

  it("tells an open question apart: nobody has answered yet", () => {
    expect(questionItemLine(item("open"), "Pi")).toBe("question qst_a from Pi [waiting for an answer]: Which package should I update?");
  });

  it("says who answered, what they said, and that the reply was handed to the harness", () => {
    expect(questionItemLine(item("answered", { at, by: USER, answers: [["web"]], delivery: "handed_off" }), "Pi")).toBe(
      "question qst_a from Pi [answered by You; handed to the harness]: Which package should I update? → web",
    );
    // 主 Agent 自己回答的，署名是它；没有“已交给执行端”就不写这一句。
    expect(questionItemLine(item("answered", { at, by: AGENT, answers: [["core"]] }), "Pi")).toBe(
      "question qst_a from Pi [answered by Codex]: Which package should I update? → core",
    );
  });

  it("joins the answers to several questions, and does not make up an answer that was not recorded", () => {
    const two = item("answered", { at, by: USER, answers: [["web"], ["linux", "win"]], delivery: "handed_off" }, [CHOICE, FREE]);
    expect(questionItemLine(two, "Pi")).toContain("→ web / linux, win");
    expect(questionItemLine(item("answered", { at, by: USER }), "Pi")).toContain("→ (answer not recorded)");
    expect(questionItemLine(item("answered"), "Pi")).toContain("[answered by someone]");
  });

  it("says a declined question was left to the session's own judgment, with the decliner's own note", () => {
    expect(questionItemLine(item("declined", { at, by: USER, delivery: "handed_off" }), "Pi")).toBe(
      "question qst_a from Pi [declined by You; the session was told to use its own judgment]: Which package should I update?",
    );
    expect(questionItemLine(item("declined", { at, by: USER, note: "Pick   whatever\nis simplest", delivery: "handed_off" }), "Pi")).toContain(
      " — note: Pick whatever is simplest",
    );
  });

  it("says why an expired question expired, and only claims the session was told when it was", () => {
    const timedOut = item("expired", { at, by: SYSTEM_ACTOR, reason: "timeout", delivery: "handed_off" });
    expect(questionItemLine(timedOut, "Pi")).toBe(
      "question qst_a from Pi [expired — nobody answered in time; the session was told to use its own judgment]: Which package should I update?",
    );
    // 时限到了、但执行端接不了回复：没有告知任何人。
    expect(questionItemLine(item("expired", { at, by: SYSTEM_ACTOR, reason: "timeout" }), "Pi")).toContain("no answer was delivered");
    expect(questionItemLine(item("expired", { at, by: SYSTEM_ACTOR, reason: "run_ended" }), "Pi")).toBe(
      "question qst_a from Pi [expired — the run ended; no answer was delivered]: Which package should I update?",
    );
    expect(questionItemLine(item("expired", { at, by: SYSTEM_ACTOR, reason: "not_waiting", delivery: "not_waiting" }), "Pi")).toContain("the harness stopped waiting for it; no answer was delivered");
    expect(questionItemLine(item("expired"), "Pi")).toContain("[expired; no answer was delivered]");
  });

  it("joins several questions with a slash, and never uses authorization words", () => {
    const line = questionItemLine(item("open", undefined, [CHOICE, FREE]), "Pi");
    expect(line).toContain("Which package should I update? / What is the deadline?");
    for (const status of ["open", "answered", "declined", "expired"] as const) {
      expect(questionItemLine(item(status, { at, by: SYSTEM_ACTOR, reason: "run_ended", answers: [["x"]], note: "n" }), "Pi")).not.toMatch(AUTHORIZATION_WORDS);
    }
  });
});
