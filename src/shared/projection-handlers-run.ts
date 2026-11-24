/**
 * 会话信息、会话状态与运行生命周期的事件处理：session.updated / session.status，以及 run.queued / starting / started / completed / failed / cancelled。
 *
 * 由 projection.ts 的 `applyEvent` 按事件种类分派进来；这里只改状态，不重算活动——分派之后由 `applyEvent` 统一做。
 * 某个 case 提前 `break`（找不到对应的运行、运行已不在排队或启动阶段、已有别的运行在进行）时也一样：
 * 事件仍算已应用（seq、updatedAt 在分派之前就推进了），收尾照常执行。
 * 运行的收尾（`endRun`）只有这里用，连同“运行是否已终结”的集合一起留在本文件；提问的到期收束来自 projection-timeline.ts。
 *
 * 依赖方向：只依赖 projection-state.ts 与 projection-timeline.ts，不导入 projection.ts，也不导入别的处理文件。
 */

import type { EnsembleEvent } from "./events";
import { msBetween } from "./format";
import type { SessionState } from "./projection-state";
import { expireQuestions, getMessage, getRun, putItem, putMessage, putRun } from "./projection-timeline";
import type { Run } from "./types";

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

function endRun(
  state: SessionState,
  event: EnsembleEvent,
  status: "completed" | "failed" | "cancelled",
  patch: Partial<Run>,
): void {
  const run = getRun(state, event.runId);
  if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return;

  const ended: Run = { ...run, ...patch, status, endedAt: event.at };
  putRun(state, ended);

  // 运行结束后仍显示“进行中”的工具，说明执行端没有上报结束事件，如实标记。
  for (let i = 0; i < state.timeline.length; i++) {
    const item = state.timeline[i];
    if (!item || item.runId !== run.id) continue;
    if ((item.type === "assistant" || item.type === "reasoning") && item.streaming) {
      state.timeline[i] = { ...item, streaming: false, updatedAt: event.at };
    } else if (item.type === "tool" && item.status === "running") {
      state.timeline[i] = { ...item, status: "unfinished", updatedAt: event.at };
    }
  }

  // 提问活不过它所属的运行：运行结束，执行端就不再等这个回答（没有归属运行的提问一并算上）。
  expireQuestions(state, event.at, status === "cancelled" ? "cancelled" : "run_ended", (item) => !item.runId || item.runId === run.id);

  const durationMs = run.startedAt ? msBetween(run.startedAt, event.at) : undefined;
  putItem(state, {
    type: "run",
    id: `run:${run.id}:${status}`,
    runId: run.id,
    at: event.at,
    updatedAt: event.at,
    runIndex: run.index,
    phase: status,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(ended.stopReason ? { stopReason: ended.stopReason } : {}),
  });

  if (state.activeRunId === run.id) state.activeRunId = undefined;
  if (!state.activeRunId && (state.status === "running" || state.status === "starting" || state.status === "queued")) {
    state.status = state.runs.some((entry) => entry.status === "queued") ? "queued" : "idle";
    delete state.statusReason;
    state.endedAt = event.at;
    if (status === "failed" && patch.error) state.lastError = patch.error;
  }
}

/** 本文件处理的事件种类；projection.ts 的 `applyEvent` 按同一份清单分派进来。 */
type RunEventKind =
  | "session.updated"
  | "session.status"
  | "run.queued"
  | "run.starting"
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "run.cancelled";
type RunEvent = Extract<EnsembleEvent, { kind: RunEventKind }>;

export function applyRunEvent(state: SessionState, event: RunEvent): void {
  switch (event.kind) {
    case "session.updated": {
      const patch = event.data.patch;
      state.meta = {
        ...state.meta,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.model !== undefined ? { model: { ...state.meta.model, ...patch.model } } : {}),
        ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
        ...(patch.nativeRef !== undefined ? { nativeRef: patch.nativeRef } : {}),
        ...(patch.capabilities !== undefined ? { capabilities: patch.capabilities } : {}),
        ...(patch.accessEnforcement !== undefined ? { accessEnforcement: patch.accessEnforcement } : {}),
      };
      break;
    }

    case "session.status": {
      state.status = event.data.status;
      if (event.data.reason !== undefined) state.statusReason = event.data.reason;
      else delete state.statusReason;
      if (event.data.error) state.lastError = event.data.error;
      // 会话不再开着，执行端不会再收到任何回答。运行的收尾通常先到、运行时也会先写明确的结局；
      // 这里兜住缺了它们的日志，让提问不会永远停在“待回答”。
      if (event.data.status === "stopped" || event.data.status === "failed" || event.data.status === "lost") {
        expireQuestions(state, event.at, event.data.status === "lost" ? "restarted" : "session_closed");
      }
      break;
    }

    case "run.queued": {
      putRun(state, event.data.run);
      const message = getMessage(state, event.data.run.messageId);
      if (message && !message.runId) putMessage(state, { ...message, runId: event.data.run.id });
      if (state.status === "idle") state.status = "queued";
      break;
    }

    case "run.starting": {
      const run = getRun(state, event.runId);
      if (run?.status !== "queued" || state.activeRunId) break;
      putRun(state, { ...run, status: "starting" });
      state.activeRunId = run.id;
      state.status = "starting";
      state.endedAt = undefined;
      if (event.data.resuming) state.statusReason = "resuming";
      else delete state.statusReason;
      break;
    }

    case "run.started": {
      const run = getRun(state, event.runId);
      if (!run || (run.status !== "queued" && run.status !== "starting") ||
        (state.activeRunId && state.activeRunId !== run.id) || state.status === "stopped") break;
      putRun(state, {
        ...run,
        status: "running",
        startedAt: event.at,
        ...(event.data.nativeTurnId ? { nativeTurnId: event.data.nativeTurnId } : {}),
      });
      state.activeRunId = run.id;
      state.status = "running";
      delete state.statusReason;
      state.startedAt ??= event.at;
      state.endedAt = undefined;
      putItem(state, {
        type: "run",
        id: `run:${run.id}:started`,
        runId: run.id,
        at: event.at,
        updatedAt: event.at,
        runIndex: run.index,
        phase: "started",
      });
      break;
    }

    case "run.completed":
      endRun(state, event, "completed", event.data.stopReason ? { stopReason: event.data.stopReason } : {});
      break;
    case "run.failed":
      endRun(state, event, "failed", { error: event.data.error });
      break;
    case "run.cancelled":
      endRun(state, event, "cancelled", {});
      break;
  }
}
