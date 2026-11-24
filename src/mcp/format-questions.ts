import { clip, collapseWhitespace, formatDuration } from "@shared/format";
import { answersText, EXPIRY_TEXT, type QuestionPrompt } from "@shared/questions";
import type { QuestionItem } from "@shared/types";

/**
 * MCP 对“提问”的呈现：写给主模型，英文，事实性强，写明怎么回复。
 *
 * 提问是执行端（子会话）遇到需求歧义、停下来等一个答案；它不是授权。这里不出现任何授权、批准、允许、拒绝一类的词。
 * 全部是纯函数（时间通过参数传入），便于测试。
 */

/** 待回答的提问需要的字段：来自“值得留意”的条目，也来自时间线上的提问条目。 */
export interface OpenQuestion {
  questionId: string;
  prompts: readonly QuestionPrompt[];
  /** 提问落地的时刻。 */
  since: string;
}

/** 问题正文每个最多这么长；更长的被截断，并且明说，免得主 Agent 对着半句话作答。 */
const TEXT_MAX = 500;
const OPTION_NOTE_MAX = 100;

function shown(text: string, max: number): string {
  const flat = collapseWhitespace(text);
  return flat.length > max ? `${clip(flat, max)} [shortened — the full text is in the panel]` : flat;
}

function promptLines(prompt: QuestionPrompt, number: number | undefined, indent: string): string[] {
  const lead = `${indent}${number === undefined ? "" : `${number}. `}${prompt.header ? `[${prompt.header}] ` : ""}${shown(prompt.text, TEXT_MAX)}`;
  if (!prompt.options?.length) return [lead, `${indent}   (free-text answer)`];
  const how = `${prompt.multiple ? "pick any" : "pick one"}${prompt.custom ? ", or write your own" : ""}`;
  const options = prompt.options.map((option) => `${JSON.stringify(option.label)}${option.description ? ` — ${clip(collapseWhitespace(option.description), OPTION_NOTE_MAX)}` : ""}`);
  return [lead, `${indent}   options (${how}): ${options.join(" | ")}`];
}

/** 怎么回复：用 `send`，回答或不回答。 */
export function replyHint(sessionId: string, questionId: string, count: number): string {
  const answer = count === 1 ? 'answer: "<an option label, or your own text>"' : "answers: [one entry per question, in order; an array of labels for a multiple-choice one]";
  return `reply with \`send\`: { sessionId: "${sessionId}", questionId: "${questionId}", ${answer} } — or { sessionId: "${sessionId}", questionId: "${questionId}", decline: true } to let the session use its own judgment`;
}

/** 一个待回答的提问，多行：谁在等多久、问题与可选项、怎么回复。缩进与 `attention:` 行一致。 */
export function questionLines(question: OpenQuestion, session: { id: string; harness: string }, now: number): string[] {
  const since = Date.parse(question.since);
  const waited = Number.isFinite(since) ? ` for ${formatDuration(now - since)}` : "";
  const many = question.prompts.length > 1;
  return [
    `    question ${question.questionId}: ${session.harness} has been waiting${waited} for an answer${many ? ` to ${question.prompts.length} questions` : ""}`,
    ...question.prompts.flatMap((prompt, index) => promptLines(prompt, many ? index + 1 : undefined, "      ")),
    `      ${replyHint(session.id, question.questionId, question.prompts.length)}`,
  ];
}

/** 一行摘要（`wait` 的结构化结果与回退用）：只含第一个问题。 */
export function questionSummary(question: OpenQuestion, harness: string): string {
  const first = question.prompts[0];
  const more = question.prompts.length > 1 ? ` (+${question.prompts.length - 1} more)` : "";
  return `${harness} is waiting for an answer to a question (${question.questionId}): "${first ? clip(collapseWhitespace(first.text), 160) : ""}"${more}`;
}

/** 转录里的一条提问：问了什么、现在怎样（待回答 / 谁回答了 / 谁决定不回答 / 为什么过期）。 */
export function questionItemLine(item: QuestionItem, harness: string): string {
  const asked = item.prompts.map((prompt) => `${prompt.header ? `[${prompt.header}] ` : ""}${clip(collapseWhitespace(prompt.text), 300)}`).join(" / ");
  const outcome = item.outcome;
  switch (item.status) {
    case "open":
      return `question ${item.questionId} from ${harness} [waiting for an answer]: ${asked}`;
    case "answered":
      return `question ${item.questionId} from ${harness} [answered by ${outcome?.by.label ?? "someone"}${outcome?.delivery === "handed_off" ? "; handed to the harness" : ""}]: ${asked} → ${outcome?.answers ? clip(answersText(outcome.answers, 400), 400) : "(answer not recorded)"}`;
    case "declined":
      return `question ${item.questionId} from ${harness} [declined by ${outcome?.by.label ?? "someone"}; the session was told to use its own judgment]: ${asked}${outcome?.note ? ` — note: ${clip(collapseWhitespace(outcome.note), 200)}` : ""}`;
    case "expired": {
      const told = outcome?.reason === "timeout" && outcome.delivery === "handed_off";
      return `question ${item.questionId} from ${harness} [expired${outcome?.reason ? ` — ${EXPIRY_TEXT[outcome.reason]}` : ""}; ${told ? "the session was told to use its own judgment" : "no answer was delivered"}]: ${asked}`;
    }
  }
}
