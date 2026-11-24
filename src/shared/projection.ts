/**
 * 事件 → 会话状态的投影。服务端持有权威状态，网页对当前聚焦的会话用同一份逻辑回放，
 * 保证两边展示一致。`applyEvent` 原地修改传入的状态（调用方独占所有权），
 * 被更新的时间线条目会被替换成新对象，便于 React 按引用判断是否需要重绘。
 *
 * 本文件只是入口：`replay`、`applyEvent`（会话关系调整的前言、按事件种类分派、分派之后统一重算活动），以及对外导出。
 * 其余按职责放在同目录的 projection-*.ts 里；下面按依赖顺序排列，每个文件只导入排在它前面的，没有任何一个导入本文件：
 * - projection-state：`SessionState` 的形状与 `createState`；
 * - projection-timeline：时间线条目、运行、消息的登记 / 查找 / 收束，以及提问条目的收束与到期，各处理文件共用
 *   （助手文字与推理条目的键 `itemKey` 也在这里，别处注释里写的“projection.ts 的 itemKey”指的就是它）；
 * - projection-handlers-run：会话信息与状态、运行生命周期的事件（session.updated / status、run.*）；
 * - projection-handlers-content：消息、助手文字、推理、工具、文件、计划、用量、诊断、提问与通知的事件；
 * - projection-derive：从状态派生“相关的运行”、活动、进度与阶段；`applyEvent` 收尾时重算活动也走这里；
 * - projection-summary：用量累计与 `toSummary`。
 */

import type { EnsembleEvent } from "./events";
import { parentFields } from "./lineage";
import { refreshActivity } from "./projection-derive";
import { applyContentEvent } from "./projection-handlers-content";
import { applyRunEvent } from "./projection-handlers-run";
import { createState, type SessionState } from "./projection-state";

// 对外导出：下面这些原先都定义在本文件里，拆分之后改由各自的模块持有，这里原样转出，调用方不必改 import。
export { derivePhase, deriveProgress, latestRunningTool, openQuestionItems, relevantRun } from "./projection-derive";
export { createState } from "./projection-state";
export type { SessionState } from "./projection-state";
export { toSummary, totalUsage } from "./projection-summary";

/** 从完整事件序列重建状态；第一条必须是 session.created。 */
export function replay(events: readonly EnsembleEvent[]): SessionState | undefined {
  const first = events[0];
  if (!first || first.kind !== "session.created") return undefined;
  const state = createState(first);
  for (let i = 1; i < events.length; i++) {
    const event = events[i];
    if (event) applyEvent(state, event);
  }
  return state;
}

// ───────────────────────── 事件应用 ─────────────────────────

export function applyEvent(state: SessionState, event: EnsembleEvent): boolean {
  if (event.kind === "session.created") return false;
  if (event.seq <= state.seq) return false;

  state.seq = event.seq;
  if (event.kind === "session.relinked") {
    // 关系的调整是对会话的记录而不是它自己的活动：不动 updatedAt（“静默了多久”以它为准，见 attention.ts），也无需重算活动状态。
    const { parentSessionId, parentSessionIds, depth } = event.data;
    const { parentSessionId: _previous, parentSessionIds: _previousIds, ...rest } = state.meta;
    // 调整后的上级整组替换：事件里有 ≥2 个上级就用它们；否则（老日志里的记录全是这样）只有 parentSessionId 说明 0 个或 1 个，
    // 会话原先记着的 parentSessionIds 一并清掉——不清的话，改回单上级之后读到的仍是旧的汇聚集合。
    const next = parentSessionIds && parentSessionIds.length > 1 ? parentSessionIds : parentSessionId ? [parentSessionId] : [];
    state.meta = { ...rest, depth, ...parentFields(next) };
    return true;
  }
  state.updatedAt = event.at;

  // 各事件的处理在 projection-handlers-*.ts；这里列出的种类要与那边内层 switch 的 case 一一对应——
  // 这个 switch 没有 default，漏列一种，那种事件就会被悄悄忽略。处理完（含处理里提前 break）都落到下面的收尾。
  switch (event.kind) {
    case "session.updated":
    case "session.status":
    case "run.queued":
    case "run.starting":
    case "run.started":
    case "run.completed":
    case "run.failed":
    case "run.cancelled":
      applyRunEvent(state, event);
      break;

    case "message.sent":
    case "message.delivery":
    case "assistant.delta":
    case "assistant.completed":
    case "reasoning.delta":
    case "reasoning.completed":
    case "tool.updated":
    case "file.changed":
    case "plan.updated":
    case "usage.updated":
    case "diagnostic":
    case "question.asked":
    case "question.resolved":
    case "notice.created":
    case "notice.delivered":
      applyContentEvent(state, event);
      break;
  }

  refreshActivity(state, event.at);
  return true;
}
