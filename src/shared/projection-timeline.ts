/**
 * 时间线条目、运行与消息在 `SessionState` 里的登记、查找与收束：各类事件的处理函数共用的原语，只读写传入的状态
 * （`itemKey` 例外，它只是按事件算出条目的键）。
 *
 * - 登记（putItem / putRun / putMessage）：第一次见到的先以当前长度登记下标、再追加到末尾，已有的按下标换成新对象——
 *   被更新的条目是新对象，网页（React）才能按引用判断它是否需要重绘；
 * - 提问条目的收束（settleQuestion / expireQuestions）也放在这一层，而不在提问事件的处理文件里：
 *   运行结束与会话关闭的处理同样要把提问收束掉，处理文件之间因此不必互相导入。
 *
 * 依赖方向：只依赖 projection-state.ts（类型）与共享的类型 / 提问定义，不导入任何处理文件。
 */

import type { SessionState } from "./projection-state";
import { questionItemId, SYSTEM_ACTOR, type QuestionExpiry, type QuestionOutcomeRecord, type QuestionStatus } from "./questions";
import type { Message, MessageId, QuestionItem, Run, RunId, TimelineItem } from "./types";

// ───────────────────────── 时间线辅助 ─────────────────────────

/**
 * 助手文字与推理条目的键。执行端给的条目编号只在一次运行之内唯一（事件映射器每次运行、Codex 自动续跑的每一轮都从头编号：a1、r2……），
 * 所以键里要带上运行标识：不带的话，后一次运行的文字会被拼到前一次运行里同号的条目上，
 * 它们各自的运行（`read` 指定某一轮、网页时间线的第 2 轮）就读不到自己的文字。
 * 事件没有 runId（老日志、没有运行在进行时来的事件）就沿用不带运行的旧键；
 * 这些条目的 id 对外是不透明值，网页、`read` 与报告都只拿它比较相等，不解析。
 */
export function itemKey(kind: "assistant" | "reasoning", event: { runId?: RunId | undefined; data: { itemId: string } }): string {
  return event.runId ? `${kind}:${event.runId}:${event.data.itemId}` : `${kind}:${event.data.itemId}`;
}

export function putItem(state: SessionState, item: TimelineItem): void {
  const index = state.idx.items.get(item.id);
  if (index === undefined) {
    state.idx.items.set(item.id, state.timeline.length);
    state.timeline.push(item);
  } else {
    state.timeline[index] = item;
  }
}

export function getItem<T extends TimelineItem>(state: SessionState, id: string): T | undefined {
  const index = state.idx.items.get(id);
  return index === undefined ? undefined : (state.timeline[index] as T | undefined);
}

/** 新内容出现时，收束仍处于“流式”的文本块（只回看最近若干条，避免全表扫描）。 */
export function closeStreaming(state: SessionState, at: string): void {
  const floor = Math.max(0, state.timeline.length - 48);
  for (let i = state.timeline.length - 1; i >= floor; i--) {
    const item = state.timeline[i];
    if (!item) continue;
    if ((item.type === "assistant" || item.type === "reasoning") && item.streaming) {
      state.timeline[i] = { ...item, streaming: false, updatedAt: at };
    }
  }
}

// ───────────────────────── 提问（见 questions.ts） ─────────────────────────

/** 给提问定下结局：条目原位更新，并从“待回答”索引里拿掉。 */
export function settleQuestion(
  state: SessionState,
  item: QuestionItem,
  status: Exclude<QuestionStatus, "open">,
  outcome: QuestionOutcomeRecord,
): void {
  putItem(state, { ...item, status, updatedAt: outcome.at, outcome });
  state.openQuestions.delete(item.questionId);
}

/**
 * 把仍待回答、且满足 `belongs` 的提问记为过期。
 * 这是兜底：执行端撤回、运行结束、会话关闭时，适配器与运行时通常会先写明确的结局事件（带更准确的原因）；
 * 缺了它们（进程崩溃、旧版本留下的日志）也不会留下永远“待回答”的幽灵提问。
 */
export function expireQuestions(
  state: SessionState,
  at: string,
  reason: QuestionExpiry,
  belongs: (item: QuestionItem) => boolean = () => true,
): void {
  if (state.openQuestions.size === 0) return;
  for (const questionId of [...state.openQuestions]) {
    const item = getItem<QuestionItem>(state, questionItemId(questionId));
    if (!item || item.status !== "open") {
      state.openQuestions.delete(questionId);
      continue;
    }
    if (belongs(item)) settleQuestion(state, item, "expired", { at, by: SYSTEM_ACTOR, reason });
  }
}

// ───────────────────────── 运行与消息 ─────────────────────────

export function getRun(state: SessionState, runId: RunId | undefined): Run | undefined {
  if (!runId) return undefined;
  const index = state.idx.runs.get(runId);
  return index === undefined ? undefined : state.runs[index];
}

export function putRun(state: SessionState, run: Run): void {
  const index = state.idx.runs.get(run.id);
  if (index === undefined) {
    state.idx.runs.set(run.id, state.runs.length);
    state.runs.push(run);
  } else {
    state.runs[index] = run;
  }
}

export function getMessage(state: SessionState, id: MessageId): Message | undefined {
  const index = state.idx.messages.get(id);
  return index === undefined ? undefined : state.messages[index];
}

export function putMessage(state: SessionState, message: Message): void {
  const index = state.idx.messages.get(message.id);
  if (index === undefined) {
    state.idx.messages.set(message.id, state.messages.length);
    state.messages.push(message);
  } else {
    state.messages[index] = message;
  }
}
