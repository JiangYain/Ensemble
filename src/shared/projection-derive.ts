/**
 * 从状态派生出来的东西：当前相关的运行（`relevantRun`）、仍在运行的工具、待回答的提问，以及活动（activity）、进度（progress）与阶段（phase）。
 *
 * 都只读状态，唯一会写的是 `refreshActivity`——projection.ts 的 `applyEvent` 在每个事件处理完之后调用它，
 * 只有活动“实质变化”时才重置起始时间。活动与阶段都以 `state.status` 为主、待命（`idle`）时再看“相关的运行”，放在一起口径才一致；
 * 摘要（projection-summary.ts）直接用这里的结果。
 *
 * 依赖方向：只依赖 projection-state.ts（类型）与 projection-timeline.ts 的查找函数，不导入任何处理文件，也不导入 projection.ts。
 */

import type { SessionState } from "./projection-state";
import { getItem, getRun } from "./projection-timeline";
import { questionItemId } from "./questions";
import type { Activity, Progress, QuestionItem, Run, RunId, SessionPhase, TimelineItem, ToolItem } from "./types";

// ───────────────────────── 活动与进度 ─────────────────────────

function latestOfRun(state: SessionState, runId: RunId | undefined): TimelineItem | undefined {
  for (let i = state.timeline.length - 1; i >= 0; i--) {
    const item = state.timeline[i];
    if (!item) continue;
    if (item.type === "message" || item.type === "diagnostic") continue;
    if (item.type === "run") return undefined;
    if (runId && item.runId && item.runId !== runId) return undefined;
    return item;
  }
  return undefined;
}

export function relevantRun(state: SessionState): Run | undefined {
  if (state.activeRunId) return getRun(state, state.activeRunId);
  let cancelledBeforeStart: Run | undefined;
  for (let i = state.runs.length - 1; i >= 0; i--) {
    const run = state.runs[i];
    if (!run || run.status === "queued") continue;
    if (run.status === "cancelled" && !run.startedAt) cancelledBeforeStart ??= run;
    else return run;
  }
  return cancelledBeforeStart;
}

/**
 * 当前运行里状态仍是“运行中”的工具；多个工具并行时以最近启动的为准。
 * 执行端有时不会为某个工具上报结束事件，所以“运行中”只代表没有收到结束事件，不保证它真的还在执行。
 */
export function latestRunningTool(state: SessionState): ToolItem | undefined {
  const runId = state.activeRunId;
  for (let i = state.timeline.length - 1; i >= 0; i--) {
    const item = state.timeline[i];
    if (!item) continue;
    if (item.type === "run" && item.phase === "started") return undefined;
    if (item.type === "tool" && item.status === "running" && (!runId || item.runId === runId)) return item;
  }
  return undefined;
}

/** 待回答的提问，按提出的先后。 */
export function openQuestionItems(state: SessionState): QuestionItem[] {
  const items: QuestionItem[] = [];
  for (const questionId of state.openQuestions) {
    const item = getItem<QuestionItem>(state, questionItemId(questionId));
    if (item?.status === "open") items.push(item);
  }
  return items.sort((a, b) => (state.idx.items.get(a.id) ?? 0) - (state.idx.items.get(b.id) ?? 0));
}

function computeActivity(state: SessionState): Omit<Activity, "since"> & { key: string } {
  switch (state.status) {
    case "starting":
      return { kind: "starting", key: "starting" };
    case "queued":
      return { kind: "queued", key: "queued" };
    case "stopped":
      return { kind: "stopped", key: "stopped" };
    case "failed":
      return { kind: "failed", key: "failed" };
    case "lost":
      return { kind: "lost", key: "lost" };
    case "running": {
      const runId = state.activeRunId;
      const tool = latestRunningTool(state);
      if (tool) {
        return {
          kind: "tool",
          key: `tool:${tool.callId}`,
          tool: { name: tool.name, category: tool.category, title: tool.title },
          ...(runId ? { runId } : {}),
        };
      }
      const latest = latestOfRun(state, runId);
      if (latest?.type === "reasoning" && latest.streaming) {
        return { kind: "thinking", key: `thinking:${latest.id}`, ...(runId ? { runId } : {}) };
      }
      if (latest?.type === "assistant" && latest.streaming) {
        return { kind: "writing", key: `writing:${latest.id}`, ...(runId ? { runId } : {}) };
      }
      return { kind: "working", key: "working", ...(runId ? { runId } : {}) };
    }
    case "idle": {
      const run = relevantRun(state);
      if (!run) return { kind: "ready", key: "ready" };
      if (run.status === "completed") return { kind: "done", key: `done:${run.id}`, runId: run.id };
      if (run.status === "failed") return { kind: "failed", key: `failed:${run.id}`, runId: run.id };
      if (run.status === "cancelled") return { kind: "cancelled", key: `cancelled:${run.id}`, runId: run.id };
      return { kind: "idle", key: "idle" };
    }
  }
}

/** 只有活动“实质变化”（种类或具体工具改变）时才重置起始时间，用于界面上的计时。 */
export function refreshActivity(state: SessionState, at: string): void {
  const next = computeActivity(state);
  if (state.activityKey === next.key) return;
  state.activityKey = next.key;
  const { key: _key, ...activity } = next;
  state.activity = { ...activity, since: at };
}

export function deriveProgress(state: SessionState): Progress {
  const run = relevantRun(state);
  if (!run) return { done: 0, steps: 0 };

  const tools = state.timeline.filter(
    (item): item is ToolItem => item.type === "tool" && item.runId === run.id,
  );

  if (state.plan && state.plan.runId === run.id && state.plan.entries.length > 0) {
    const entries = state.plan.entries;
    return { done: entries.filter((entry) => entry.status === "completed").length, total: entries.length, steps: tools.length };
  }

  return { done: tools.filter((tool) => tool.status !== "running").length, steps: tools.length };
}

export function derivePhase(state: SessionState): SessionPhase {
  switch (state.status) {
    case "starting":
      return "starting";
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "stopped":
      return "stopped";
    case "failed":
      return "failed";
    case "lost":
      return "lost";
    case "idle": {
      const run = relevantRun(state);
      if (!run) return "ready";
      if (run.status === "completed") return "done";
      if (run.status === "failed") return "failed";
      if (run.status === "cancelled") return "cancelled";
      return "ready";
    }
  }
}
