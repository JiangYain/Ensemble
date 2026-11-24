import type { AnswerQuestionRequest } from "@shared/protocol";
import type { QuestionExpiry, QuestionOutcomeRecord, QuestionPrompt } from "@shared/questions";
import type { Actor } from "@shared/types";
import type { TFunction } from "./i18n";

/**
 * 提问卡片（components/QuestionCard.tsx）背后的纯数据与纯函数：用户正在填的回答、冲突与过期的措辞。
 * 不依赖 React，单独可测。
 *
 * 词汇与 shared/questions.ts 一致：提问 · 待回答 · 回答 · 不回答 · 过期；这里没有授权、批准、允许、拒绝一类的词。
 */

/** 一个问题里用户已经填了什么。 */
export interface PromptDraft {
  /** 选中的可选项标签；单选最多一个。 */
  picks: string[];
  /** “其他”里自己写的文字；没有可选项的问题，它就是回答本身。 */
  other: string;
  /** “其他”是否被选中（没有可选项的问题恒为 true）。 */
  otherOn: boolean;
}

export const hasOptions = (prompt: QuestionPrompt): boolean => (prompt.options?.length ?? 0) > 0;

export function emptyDraft(prompt: QuestionPrompt): PromptDraft {
  return { picks: [], other: "", otherOn: !hasOptions(prompt) };
}

export function emptyDrafts(prompts: readonly QuestionPrompt[]): PromptDraft[] {
  return prompts.map(emptyDraft);
}

/** 点选一个可选项：单选换成它（并放掉“其他”），多选则切换它。 */
export function pickOption(prompt: QuestionPrompt, draft: PromptDraft, label: string): PromptDraft {
  if (!prompt.multiple) return { ...draft, picks: [label], otherOn: false };
  const picks = draft.picks.includes(label) ? draft.picks.filter((pick) => pick !== label) : [...draft.picks, label];
  return { ...draft, picks };
}

/** 点选“其他”：单选换成它（并放掉可选项），多选则切换它。没有可选项的问题恒为选中，点什么都不变。 */
export function pickOther(prompt: QuestionPrompt, draft: PromptDraft): PromptDraft {
  if (!hasOptions(prompt)) return draft;
  if (!prompt.multiple) return { ...draft, picks: [], otherOn: true };
  return { ...draft, otherOn: !draft.otherOn };
}

/**
 * 在“其他”里写字：写了字就等于选了它（单选时同时放掉可选项）。
 * 把字删光不会自动取消选中——选中却是空的，“回答”按钮保持不可用，比悄悄换成别的更不让人意外。
 */
export function typeOther(prompt: QuestionPrompt, draft: PromptDraft, text: string): PromptDraft {
  if (!hasOptions(prompt)) return { ...draft, other: text, otherOn: true };
  if (text.trim() === "") return { ...draft, other: text };
  return prompt.multiple ? { ...draft, other: text, otherOn: true } : { picks: [], other: text, otherOn: true };
}

/** 草稿折成要交回的答案：可选项按它们出现的顺序排，自己写的那一条放在最后；不允许自己写的问题忽略“其他”。 */
export function draftAnswer(prompt: QuestionPrompt, draft: PromptDraft): string[] {
  const chosen = (prompt.options ?? []).map((option) => option.label).filter((label) => draft.picks.includes(label));
  const own = draft.otherOn && prompt.custom ? draft.other.trim() : "";
  return own ? [...chosen, own] : chosen;
}

/** 每个问题都有至少一个答案，“回答”才可用；不让空回答出门（执行端会把空回答当成用户的意见）。 */
export function answersReady(prompts: readonly QuestionPrompt[], drafts: readonly PromptDraft[]): boolean {
  return prompts.length > 0 && prompts.every((prompt, index) => {
    const draft = drafts[index];
    return draft !== undefined && draftAnswer(prompt, draft).length > 0;
  });
}

/** `POST …/answer` 的请求体：每个问题一项，与 `prompts` 一一对应（服务端按选项标签再核对一遍）。 */
export function answerBody(prompts: readonly QuestionPrompt[], drafts: readonly PromptDraft[]): AnswerQuestionRequest {
  return { answers: prompts.map((prompt, index) => draftAnswer(prompt, drafts[index] ?? emptyDraft(prompt))) };
}

// ───────────────────────── 措辞 ─────────────────────────

/**
 * 回答时撞上的冲突（HTTP 409）：提问此刻的状态决定该说什么，状态取自服务端随错误附带的 `details.status`。
 * 键都写成字面量，词典的“死键”检查才认得出它们仍在使用。
 */
const CONFLICT_KEYS: Readonly<Record<string, string>> = {
  answered: "question.conflict.answered",
  declined: "question.conflict.declined",
  expired: "question.conflict.expired",
  open: "question.conflict.busy",
};

export function conflictKey(details: Record<string, unknown> | undefined): string | undefined {
  const status = details?.["status"];
  return typeof status === "string" ? CONFLICT_KEYS[status] : undefined;
}

/** 过期原因的文案键；Record 保证 shared/questions.ts 新增一种原因时这里编译不过，不会漏写措辞。 */
const EXPIRY_KEYS: Readonly<Record<QuestionExpiry, string>> = {
  timeout: "question.expiry.timeout",
  withdrawn: "question.expiry.withdrawn",
  run_ended: "question.expiry.run_ended",
  cancelled: "question.expiry.cancelled",
  session_closed: "question.expiry.session_closed",
  restarted: "question.expiry.restarted",
  not_waiting: "question.expiry.not_waiting",
};

/**
 * 一次过期该写的那句话。时限到了、并且 Ensemble 已告知执行端自行判断的，单独说明这一点；
 * 没有记下原因的（不应出现，除非日志是旧的或残缺的）不编造，返回 undefined，卡片只显示“已过期”。
 */
export function expiryText(outcome: QuestionOutcomeRecord, t: TFunction): string | undefined {
  if (outcome.reason === "timeout" && outcome.delivery === "handed_off") return t("question.expiry.timeoutTold");
  return outcome.reason ? t(EXPIRY_KEYS[outcome.reason]) : undefined;
}

/** 谁做的：用户写成“你”（服务端记的是英文标签 You），主 Agent 用来源宿主的名字，系统是 Ensemble。 */
export function actorName(by: Actor, t: TFunction): string {
  return by.kind === "user" ? t("question.by.user") : by.label;
}
