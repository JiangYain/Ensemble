import { describe, expect, it } from "vitest";
import { LIMITS } from "./constants";
import { answersText, capPrompts, checkAnswers, EXPIRY_TEXT, questionItemId, questionPreview, SYSTEM_ACTOR, type QuestionExpiry, type QuestionPrompt } from "./questions";

const prompt = (overrides: Partial<QuestionPrompt> = {}): QuestionPrompt => ({ key: "q", text: "Which database?", multiple: false, custom: true, ...overrides });
const choice = (overrides: Partial<QuestionPrompt> = {}): QuestionPrompt =>
  prompt({ options: [{ label: "SQLite", description: "single file" }, { label: "PostgreSQL" }], ...overrides });

describe("questionItemId", () => {
  it("is the one place that decides how a question is named on the timeline", () => {
    expect(questionItemId("qst_1")).toBe("question:qst_1");
  });

  it("signs system outcomes as the system, never as a person", () => {
    expect(SYSTEM_ACTOR).toEqual({ kind: "system", label: "Ensemble" });
  });
});

describe("capPrompts", () => {
  it("keeps a well-formed question as it is, key included", () => {
    const given = choice({ key: "db", header: "Database" });
    expect(capPrompts([given])).toEqual({ prompts: [given], dropped: 0 });
  });

  it("trims whitespace around every piece of text", () => {
    const { prompts } = capPrompts([prompt({ text: "  Which database?\n", header: " Database ", options: [{ label: " SQLite ", description: " single file " }], multiple: false, custom: false })]);
    expect(prompts[0]).toMatchObject({ text: "Which database?", header: "Database", options: [{ label: "SQLite", description: "single file" }] });
  });

  it("drops a question whose text is empty once tidied, and says how many were dropped", () => {
    const { prompts, dropped } = capPrompts([prompt({ key: "a", text: "   " }), prompt({ key: "b", text: "Keep me" })]);
    expect(prompts.map((item) => item.key)).toEqual(["b"]);
    expect(dropped).toBe(1);
  });

  it("limits the number of questions", () => {
    const many = Array.from({ length: LIMITS.question.maxPrompts + 3 }, (_, index) => prompt({ key: `k${index}`, text: `Question ${index}` }));
    const { prompts, dropped } = capPrompts(many);
    expect(prompts).toHaveLength(LIMITS.question.maxPrompts);
    expect(prompts[0]?.key).toBe("k0");
    expect(dropped).toBe(3);
  });

  it("cuts over-long text with an ellipsis at the limit", () => {
    const { prompts } = capPrompts([prompt({ text: "x".repeat(LIMITS.question.maxTextChars + 50) })]);
    const text = prompts[0]?.text ?? "";
    expect(text).toHaveLength(LIMITS.question.maxTextChars);
    expect(text.endsWith("…")).toBe(true);
  });

  it("limits the header, the number of options, and each label and description", () => {
    const options = Array.from({ length: LIMITS.question.maxOptions + 5 }, (_, index) => ({ label: `option ${index}`, description: "d" }));
    const { prompts } = capPrompts([
      choice({
        header: "h".repeat(LIMITS.question.maxHeaderChars + 10),
        options: [{ label: "L".repeat(LIMITS.question.maxLabelChars + 10), description: "D".repeat(LIMITS.question.maxDescriptionChars + 10) }, ...options],
      }),
    ]);
    const capped = prompts[0];
    expect(capped?.header).toHaveLength(LIMITS.question.maxHeaderChars);
    expect(capped?.options).toHaveLength(LIMITS.question.maxOptions);
    expect(capped?.options?.[0]?.label).toHaveLength(LIMITS.question.maxLabelChars);
    expect(capped?.options?.[0]?.description).toHaveLength(LIMITS.question.maxDescriptionChars);
  });

  it("drops options with no label and leaves out empty descriptions", () => {
    const { prompts } = capPrompts([choice({ options: [{ label: "  " }, { label: "Keep", description: "   " }] })]);
    expect(prompts[0]?.options).toEqual([{ label: "Keep" }]);
  });

  it("a question without options is free text: it cannot be multiple and always allows writing", () => {
    const { prompts } = capPrompts([prompt({ multiple: true, custom: false })]);
    expect(prompts[0]).toMatchObject({ multiple: false, custom: true });
    expect("options" in (prompts[0] ?? {})).toBe(false);
    // 可选项全被丢弃时同理。
    const emptied = capPrompts([choice({ options: [{ label: " " }], multiple: true, custom: false })]).prompts[0];
    expect(emptied).toMatchObject({ multiple: false, custom: true });
  });

  it("keeps multiple and custom as given when there are options", () => {
    const { prompts } = capPrompts([choice({ multiple: true, custom: false })]);
    expect(prompts[0]).toMatchObject({ multiple: true, custom: false });
  });

  it("runs the executor's text through the cleaner before anything else (secrets never reach the log)", () => {
    const clean = (text: string): string => text.replace(/sk-[a-z0-9]+/gi, "[redacted]");
    const { prompts } = capPrompts([choice({ text: "Use key sk-abc123?", header: "key sk-abc123", options: [{ label: "sk-abc123", description: "the sk-abc123 key" }] })], clean);
    const serialized = JSON.stringify(prompts);
    expect(serialized).not.toContain("sk-abc123");
    expect(prompts[0]?.text).toBe("Use key [redacted]?");
    expect(prompts[0]?.options?.[0]).toEqual({ label: "[redacted]", description: "the [redacted] key" });
  });
});

describe("questionPreview", () => {
  it("is the first question on one line", () => {
    expect(questionPreview([prompt({ text: "first line\n\n  second   line" }), prompt({ text: "another" })])).toBe("first line second line");
  });

  it("clips to the length asked for, with an ellipsis", () => {
    const text = questionPreview([prompt({ text: "word ".repeat(100) })], 40);
    expect(text).toHaveLength(40);
    expect(text.endsWith("…")).toBe(true);
  });

  it("is empty when there is nothing to show", () => {
    expect(questionPreview([])).toBe("");
  });
});

describe("checkAnswers", () => {
  it("takes a single answer for a single question", () => {
    expect(checkAnswers([choice()], { answer: "PostgreSQL" })).toEqual({ ok: true, answers: [["PostgreSQL"]] });
  });

  it("replaces a label written in a different case or with stray spaces by the option's own label", () => {
    expect(checkAnswers([choice()], { answer: "  sqlite " })).toEqual({ ok: true, answers: [["SQLite"]] });
  });

  it("accepts the user's own words when the question allows it", () => {
    expect(checkAnswers([choice({ custom: true })], { answer: "Postgres with pgvector" })).toEqual({ ok: true, answers: [["Postgres with pgvector"]] });
  });

  it("rejects words that are not an option when the question does not allow writing, and lists the options", () => {
    const result = checkAnswers([choice({ custom: false })], { answer: "MySQL" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain('must be one of the options ("SQLite", "PostgreSQL")');
    expect(!result.ok && result.message).toContain('"MySQL" is not');
  });

  it("never lets an answer quietly become empty", () => {
    for (const answer of ["", "   ", [], ["  "]]) {
      const result = checkAnswers([choice()], { answer });
      expect(result.ok, JSON.stringify(answer)).toBe(false);
      expect(!result.ok && result.message).toContain("has no answer");
    }
    const noWriting = checkAnswers([choice({ custom: false })], { answer: "" });
    expect(!noWriting.ok && noWriting.message).toContain("choose an option, or decline to answer");
    const writing = checkAnswers([choice({ custom: true })], { answer: "" });
    expect(!writing.ok && writing.message).toContain("choose an option or write one, or decline to answer");
  });

  it("asks for something when nothing was given, and refuses both forms at once", () => {
    expect(checkAnswers([choice()], {})).toEqual({ ok: false, message: "No answer was given." });
    const both = checkAnswers([choice()], { answer: "SQLite", answers: ["SQLite"] });
    expect(!both.ok && both.message).toContain("not both");
  });

  it("wants one entry per question, in order", () => {
    const prompts = [choice({ key: "a" }), prompt({ key: "b" })];
    expect(checkAnswers(prompts, { answers: ["SQLite", "no preference"] })).toEqual({ ok: true, answers: [["SQLite"], ["no preference"]] });

    const short = checkAnswers(prompts, { answers: ["SQLite"] });
    expect(!short.ok && short.message).toBe("This question has 2 questions, but 1 answer was given: give one entry per question, in order.");
    const single = checkAnswers(prompts, { answer: "SQLite" });
    expect(!single.ok && single.message).toContain("asks 2 questions: pass `answers`");
  });

  it("names the question that is missing an answer by number when there are several", () => {
    const result = checkAnswers([choice({ key: "a" }), prompt({ key: "b" })], { answers: ["SQLite", ""] });
    expect(!result.ok && result.message).toContain("Question 2 has no answer");
  });

  it("a single-choice question takes exactly one answer", () => {
    const result = checkAnswers([choice()], { answer: ["SQLite", "PostgreSQL"] });
    expect(!result.ok && result.message).toContain("takes a single answer, but 2 were given");
  });

  it("a multiple-choice question takes several, once each, in the order given", () => {
    const prompts = [prompt({ options: [{ label: "linux" }, { label: "mac" }, { label: "win" }], multiple: true, custom: true })];
    expect(checkAnswers(prompts, { answer: ["win", "LINUX", "win", "bsd"] })).toEqual({ ok: true, answers: [["win", "linux", "bsd"]] });
  });

  it("limits how long an answer is and how many can be picked", () => {
    const tooLong = checkAnswers([prompt()], { answer: "x".repeat(LIMITS.question.maxAnswerChars + 1) });
    expect(!tooLong.ok && tooLong.message).toContain(`longer than ${LIMITS.question.maxAnswerChars} characters`);

    const labels = Array.from({ length: LIMITS.question.maxPicks + 1 }, (_, index) => `option ${index}`);
    const many = checkAnswers([prompt({ options: labels.map((label) => ({ label })), multiple: true })], { answer: labels });
    expect(!many.ok && many.message).toContain(`more than ${LIMITS.question.maxPicks} answers`);
  });

  it("accepts an answer built from a readonly list", () => {
    const answers: readonly string[] = ["SQLite"];
    expect(checkAnswers([choice()], { answers: [answers] })).toEqual({ ok: true, answers: [["SQLite"]] });
  });
});

describe("answersText", () => {
  it("writes one line: questions apart by ' / ', picks apart by ', '", () => {
    expect(answersText([["linux", "win"], ["no preference"]])).toBe("linux, win / no preference");
  });

  it("clips a long answer with an ellipsis", () => {
    const text = answersText([["x".repeat(100)]], 20);
    expect(text).toHaveLength(20);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("the vocabulary of questions is not the vocabulary of authorization", () => {
  const reasons: QuestionExpiry[] = ["timeout", "withdrawn", "run_ended", "cancelled", "session_closed", "restarted", "not_waiting"];
  const BANNED = /authori[sz]|approv|permission|allow|reject|deny|denied|consent/i;

  it("has a sentence for every way a question can expire", () => {
    expect(Object.keys(EXPIRY_TEXT).sort()).toEqual([...reasons].sort());
    for (const reason of reasons) expect(EXPIRY_TEXT[reason].trim(), reason).not.toBe("");
  });

  it("uses none of the authorization words in those sentences or in the answer-checking messages", () => {
    const messages = [
      ...Object.values(EXPIRY_TEXT),
      ...[{}, { answer: "" }, { answer: ["a", "b"] }, { answers: [] }].flatMap((input) => {
        const result = checkAnswers([choice({ custom: false })], input);
        return result.ok ? [] : [result.message];
      }),
    ];
    for (const message of messages) expect(message, message).not.toMatch(BANNED);
  });
});
