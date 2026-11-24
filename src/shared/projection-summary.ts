/**
 * 会话摘要：用量累计（`totalUsage`）、最后一段助手文字，以及把状态压成 `SessionSummary` 的 `toSummary`。
 *
 * 只读状态。哪些字段“没有就省略”是对外形状的一部分——摘要会序列化给网页、MCP 与快照，旧调用方读到的形状要与以前一样——
 * 所以 `toSummary` 里的写法不要为了整齐而改动；活动、进度与阶段来自 projection-derive.ts，这里只引用结果。
 *
 * 依赖方向：只依赖 projection-state.ts（类型）与 projection-derive.ts，不导入任何处理文件，也不导入 projection.ts。
 */

import { isDeliveryPending } from "./delivery";
import { clip, collapseWhitespace, msBetween, tail } from "./format";
import { derivePhase, deriveProgress, relevantRun } from "./projection-derive";
import type { SessionState } from "./projection-state";
import type { SessionSummary, Usage } from "./types";

// ───────────────────────── 摘要 ─────────────────────────

const NUMERIC_USAGE_KEYS = [
  "inputTokens",
  "outputTokens",
  "cachedTokens",
  "reasoningTokens",
  "totalTokens",
  "costUsd",
] as const satisfies readonly (keyof Usage)[];

export function totalUsage(state: SessionState): Usage | undefined {
  const entries = Object.values(state.usageByRun);
  if (entries.length === 0) return undefined;
  const total: Usage = {};
  for (const usage of entries) {
    for (const key of NUMERIC_USAGE_KEYS) {
      const value = usage[key];
      if (value !== undefined) total[key] = (total[key] ?? 0) + value;
    }
  }
  // 上下文占用不是可累加的量，取最近一次。
  const latest = entries[entries.length - 1];
  if (latest?.contextTokens !== undefined) total.contextTokens = latest.contextTokens;
  if (latest?.contextWindow !== undefined) total.contextWindow = latest.contextWindow;
  return total;
}

function lastAssistantText(state: SessionState): string | undefined {
  for (let i = state.timeline.length - 1; i >= 0; i--) {
    const item = state.timeline[i];
    if (item?.type === "assistant" && item.text.trim().length > 0) return item.text;
  }
  return undefined;
}

export function toSummary(state: SessionState, childIds: readonly string[] = []): SessionSummary {
  const run = relevantRun(state);
  const origin = state.meta.origin;
  const pending = state.messages.filter((m) => isDeliveryPending(m.delivery)).length;
  const lastMessage = state.messages[state.messages.length - 1];
  const assistant = lastAssistantText(state);
  const usage = totalUsage(state);

  return {
    id: state.meta.id,
    title: state.meta.title,
    harness: state.meta.harness,
    runtime: state.meta.runtime,
    ...(state.meta.model ? { model: state.meta.model } : {}),
    ...(state.meta.effort ? { effort: state.meta.effort } : {}),
    access: state.meta.access,
    ...(state.meta.accessEnforcement ? { accessEnforcement: state.meta.accessEnforcement } : {}),
    cwd: state.meta.cwd,
    origin: {
      key: origin.key,
      kind: origin.kind,
      host: origin.host,
      hostLabel: origin.hostLabel,
      ...(origin.sessionRef ? { sessionRef: origin.sessionRef } : {}),
      ...(origin.workspace ? { workspace: origin.workspace } : {}),
      ...(origin.workspace && origin.workspaceSource ? { workspaceSource: origin.workspaceSource } : {}),
      ...(origin.hostTitle ? { hostTitle: origin.hostTitle } : {}),
    },
    ...(state.meta.parentSessionId ? { parentSessionId: state.meta.parentSessionId } : {}),
    // 只有多于一个上级（汇聚）才有这个字段；单上级的摘要与原来一字不差。
    ...(state.meta.parentSessionIds && state.meta.parentSessionIds.length > 1 ? { parentSessionIds: [...state.meta.parentSessionIds] } : {}),
    childIds: [...childIds],
    depth: state.meta.depth,
    status: state.status,
    phase: derivePhase(state),
    activity: state.activity,
    progress: deriveProgress(state),
    taskPreview: clip(collapseWhitespace(state.meta.task.text), 240),
    runCount: state.runs.filter((r) => r.status !== "queued").length,
    ...(state.activeRunId ? { activeRunId: state.activeRunId } : {}),
    ...(run
      ? {
          lastRun: {
            id: run.id,
            index: run.index,
            status: run.status,
            ...(run.startedAt ? { startedAt: run.startedAt } : {}),
            ...(run.endedAt ? { endedAt: run.endedAt } : {}),
            ...(run.startedAt && run.endedAt ? { durationMs: msBetween(run.startedAt, run.endedAt) } : {}),
          },
        }
      : {}),
    ...(usage ? { usage } : {}),
    messages: {
      total: state.messages.length,
      pending,
      ...(lastMessage ? { lastAt: lastMessage.createdAt } : {}),
    },
    counters: {
      tools: state.counters.tools,
      failedTools: state.counters.failedTools,
      files: state.files.size,
      interventions: state.messages.filter((m) => m.kind !== "task" && m.author.kind === "user").length,
    },
    // 待回答的提问数：没有就省略，旧调用方读到的形状与以前一样。
    ...(state.openQuestions.size > 0 ? { openQuestions: state.openQuestions.size } : {}),
    ...(assistant ? { lastAssistantPreview: tail(collapseWhitespace(assistant), 240) } : {}),
    ...(state.lastError ? { lastError: state.lastError } : {}),
    ...(state.meta.nativeRef ? { nativeRef: state.meta.nativeRef } : {}),
    capabilities: state.meta.capabilities,
    createdAt: state.meta.createdAt,
    updatedAt: state.updatedAt,
    ...(state.startedAt ? { startedAt: state.startedAt } : {}),
    ...(state.endedAt && !state.activeRunId ? { endedAt: state.endedAt } : {}),
    seq: state.seq,
  };
}
