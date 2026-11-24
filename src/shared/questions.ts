import { LIMITS } from "./constants";
import { clip } from "./format";
import type { Actor } from "./types";

/**
 * 执行端的“业务提问”：子会话遇到需求上的歧义，停下来向发起方（主 Agent 或用户）要一个答案。
 *
 * 它和“工具授权”是两回事。Ensemble 仍然没有任何授权闸门：被委派的会话是 Full Access，
 * 执行端发来的授权请求当场自动应答，不会等人，也不进入这里。提问只是一类事实——执行端停在这里，等一个回答。
 * 这里的类型与函数服务端、MCP 桥、网页共用，全部是纯的。
 *
 * 词汇是固定的：提问 question · 待回答 open · 回答 answer · 不回答 decline · 过期 expired。
 * 不出现任何授权、批准、允许、拒绝一类的词。
 */

export type QuestionId = string;

/** 一个可选项：回答时交回的是 label，description 只是说明。 */
export interface QuestionOption {
  label: string;
  description?: string;
}

/** 一次提问里的一个问题。 */
export interface QuestionPrompt {
  /**
   * 这个问题在执行端那边的键（Codex 的 question id、OpenCode 的字段键）。只用来在适配器内部对回答，
   * 服务重启后它不再对应任何在等的请求，展示时不需要出现。
   */
  key: string;
  /** 简短的标题（执行端给了才有）。 */
  header?: string;
  text: string;
  /** 没有可选项 = 自由文本。 */
  options?: QuestionOption[];
  /** 可以选多个选项（回答是多个标签）。 */
  multiple: boolean;
  /** 除了可选项之外还允许自己写一个答案；没有可选项时恒为 true。 */
  custom: boolean;
}

/** `question.asked` 事件带的内容。 */
export interface QuestionAsk {
  id: QuestionId;
  /** 至少一个问题。 */
  prompts: QuestionPrompt[];
}

export type QuestionStatus = "open" | "answered" | "declined" | "expired";

/**
 * 提问为什么过期（执行端不会再收到回答）：
 * - timeout：时限内没有人回答，Ensemble 告知执行端自行假设并继续（回复已交给执行端）；
 * - withdrawn：执行端自己撤回了这个提问（回合被中断、在别处被处理了……）；
 * - run_ended：所属运行已经结束（完成或失败），执行端不再等待；
 * - cancelled：所属运行被取消；
 * - session_closed：会话被关闭、失败，或与执行端的连接中断；
 * - restarted：Ensemble 重启，与执行端的连接已经断开；
 * - not_waiting：想回复时发现执行端已经不再等待这个提问，回复没有送达。
 */
export type QuestionExpiry = "timeout" | "withdrawn" | "run_ended" | "cancelled" | "session_closed" | "restarted" | "not_waiting";

/** 过期原因的一句话：服务端的错误消息与 MCP 的输出共用（英文，与 MCP 的其余输出一致）。 */
export const EXPIRY_TEXT: Record<QuestionExpiry, string> = {
  timeout: "nobody answered in time",
  withdrawn: "the harness withdrew it",
  run_ended: "the run ended",
  cancelled: "the run was cancelled",
  session_closed: "the session was closed",
  restarted: "Ensemble restarted",
  not_waiting: "the harness stopped waiting for it",
};

/**
 * 回复交给执行端的结果，如实区分：
 * - handed_off：执行端接受了这条回复（Codex：已写进它的 stdin；OpenCode：回复接口返回成功）。不代表模型已经读到、采纳；
 * - not_waiting：想回复时执行端已经不再等待这个提问，回复没有送达。
 * 没有这个字段 = 没有试图回复（运行早已结束，执行端无从等待）。
 */
export type QuestionDelivery = "handed_off" | "not_waiting";

/** `question.resolved` 事件带的内容：一次提问的结局。 */
export interface QuestionResolution {
  questionId: QuestionId;
  outcome: Exclude<QuestionStatus, "open">;
  /** 谁做的：用户 / 主 Agent；过期、撤回与时限都是系统。 */
  by: Actor;
  /** answered：每个问题所选的标签或自填的文字，与 `prompts` 一一对应。 */
  answers?: string[][];
  /** 附给执行端的一句话（不回答时的说明、时限的说明）；英文，原样写给执行端的那句。 */
  note?: string;
  /** expired 的原因。 */
  reason?: QuestionExpiry;
  delivery?: QuestionDelivery;
}

/** 时间线条目上记下的结局：事件内容加上发生的时刻。 */
export interface QuestionOutcomeRecord {
  at: string;
  by: Actor;
  answers?: string[][];
  note?: string;
  reason?: QuestionExpiry;
  delivery?: QuestionDelivery;
}

/** 系统自己做的结局（过期、撤回、时限）署名。 */
export const SYSTEM_ACTOR: Actor = { kind: "system", label: "Ensemble" };

/** 提问在时间线上的条目编号：投影与查找共用这一处，免得两边各拼一遍。 */
export const questionItemId = (questionId: QuestionId): string => `question:${questionId}`;

// ───────────────────────── 整理执行端给的原文 ─────────────────────────

/** 截法与 format.ts 的 `clip` 是同一个（保留开头、去尾部空白、加省略号，截点不切开 emoji 等代理对），不另留一份实现。 */
const clipText = clip;

/**
 * 把适配器解析出来的问题收进受限的形状：问题数、可选项数、各处文字都有上限，首尾空白去掉。
 * `clean` 由适配器给（脱敏）：执行端的原文进事件之前先过一遍。整理之后文字为空的问题丢弃；
 * 返回被丢掉的问题数，让适配器在时间线上留一条说明，而不是悄悄少一个问题。
 */
export function capPrompts(prompts: readonly QuestionPrompt[], clean: (text: string) => string = (text) => text): { prompts: QuestionPrompt[]; dropped: number } {
  const limits = LIMITS.question;
  const tidy = (text: string, max: number): string => clipText(clean(text).trim(), max);
  const kept: QuestionPrompt[] = [];
  for (const prompt of prompts) {
    const text = tidy(prompt.text, limits.maxTextChars);
    if (!text) continue;
    const options = (prompt.options ?? [])
      .slice(0, limits.maxOptions)
      .flatMap((option): QuestionOption[] => {
        const label = tidy(option.label, limits.maxLabelChars);
        if (!label) return [];
        const description = option.description ? tidy(option.description, limits.maxDescriptionChars) : "";
        return [{ label, ...(description ? { description } : {}) }];
      });
    const header = prompt.header ? tidy(prompt.header, limits.maxHeaderChars) : "";
    kept.push({
      key: prompt.key,
      ...(header ? { header } : {}),
      text,
      ...(options.length > 0 ? { options } : {}),
      multiple: options.length > 0 && prompt.multiple,
      // 没有可选项时只能自己写。
      custom: options.length === 0 || prompt.custom,
    });
  }
  const capped = kept.slice(0, limits.maxPrompts);
  return { prompts: capped, dropped: prompts.length - capped.length };
}

/** 第一个问题的一行摘要（值得留意、通知、列表里用）。 */
export function questionPreview(prompts: readonly QuestionPrompt[], max = 160): string {
  const first = prompts[0];
  if (!first) return "";
  return clipText(first.text.replace(/\s+/g, " ").trim(), max);
}

// ───────────────────────── 回答的核对 ─────────────────────────

/** 调用方给出的回答：只有一个问题时 `answer` 是最简的写法；多个问题或多选用 `answers`（每个问题一项，按顺序）。 */
export interface AnswerInput {
  answer?: string | readonly string[] | undefined;
  answers?: ReadonlyArray<string | readonly string[]> | undefined;
}

export type AnswerCheck = { ok: true; answers: string[][] } | { ok: false; message: string };

const sameLabel = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * 核对回答并整理成与 `prompts` 一一对应的 `string[][]`：
 * - 每个问题至少一个答案；只能单选的问题只收一个；
 * - 与某个可选项的标签相同（忽略大小写与首尾空白）的，换成那个可选项的标签原文；
 * - 有可选项又不允许自己写的问题，答案必须是其中一项；允许自己写的，不是标签的就按自填文字收下。
 * 不让回答悄悄变成“空”：执行端会把空回答当成用户的意见。
 */
export function checkAnswers(prompts: readonly QuestionPrompt[], input: AnswerInput): AnswerCheck {
  const limits = LIMITS.question;
  const asList = (value: string | readonly string[]): string[] => (typeof value === "string" ? [value] : [...value]);
  let entries: Array<string | readonly string[]>;
  if (input.answers !== undefined) {
    if (input.answer !== undefined) return { ok: false, message: "Give `answer` or `answers`, not both." };
    entries = [...input.answers];
    if (entries.length !== prompts.length) {
      return { ok: false, message: `This question has ${prompts.length} question${prompts.length === 1 ? "" : "s"}, but ${entries.length} answer${entries.length === 1 ? " was" : "s were"} given: give one entry per question, in order.` };
    }
  } else if (input.answer !== undefined) {
    if (prompts.length !== 1) {
      return { ok: false, message: `This question asks ${prompts.length} questions: pass \`answers\` with one entry per question, in order, instead of a single \`answer\`.` };
    }
    entries = [input.answer];
  } else {
    return { ok: false, message: "No answer was given." };
  }

  const result: string[][] = [];
  for (const [index, prompt] of prompts.entries()) {
    const where = prompts.length === 1 ? "The answer" : `Question ${index + 1}`;
    const raw = asList(entries[index] ?? []);
    const picks: string[] = [];
    for (const item of raw) {
      const text = item.trim();
      if (!text) continue;
      if (text.length > limits.maxAnswerChars) return { ok: false, message: `${where} is longer than ${limits.maxAnswerChars} characters.` };
      const option = prompt.options?.find((candidate) => sameLabel(candidate.label, text));
      const value = option ? option.label : text;
      if (!picks.includes(value)) picks.push(value);
    }
    if (picks.length === 0) return { ok: false, message: `${where} has no answer: choose an option${prompt.custom ? " or write one" : ""}, or decline to answer.` };
    if (!prompt.multiple && picks.length > 1) return { ok: false, message: `${where} takes a single answer, but ${picks.length} were given.` };
    if (picks.length > limits.maxPicks) return { ok: false, message: `${where} has more than ${limits.maxPicks} answers.` };
    if (prompt.options && !prompt.custom) {
      const unknown = picks.find((pick) => !prompt.options?.some((candidate) => candidate.label === pick));
      if (unknown !== undefined) {
        return { ok: false, message: `${where} must be one of the options (${prompt.options.map((candidate) => JSON.stringify(candidate.label)).join(", ")}); ${JSON.stringify(clipText(unknown, 80))} is not.` };
      }
    }
    result.push(picks);
  }
  return { ok: true, answers: result };
}

/** 回答的一行文字（通知、日志用）：多个问题用 ` / ` 隔开，多选用 `, `。 */
export function answersText(answers: readonly (readonly string[])[], max = 400): string {
  return clipText(answers.map((picks) => picks.join(", ")).join(" / "), max);
}
