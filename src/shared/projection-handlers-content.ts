/**
 * 时间线内容与消息类事件的处理：message.sent / delivery、assistant.delta / completed、reasoning.delta / completed、tool.updated、
 * file.changed、plan.updated、usage.updated、diagnostic，以及提问（question.asked / resolved）与通知（notice.created / delivered）。
 *
 * 由 projection.ts 的 `applyEvent` 按事件种类分派进来；这里只改状态，不重算活动——分派之后由 `applyEvent` 统一做。
 * 某个 case 提前 `break`（重复投递、找不到对应的条目或消息）时也一样：事件仍算已应用（seq、updatedAt 在分派之前就推进了），收尾照常执行。
 * 已有的时间线条目被更新时一律换成新对象，便于网页按引用判断是否重绘。
 * 工具调用的创建与合并（`createTool` / `mergeToolUpdate`）只有 `tool.updated` 用，留在本文件；
 * 提问的收束（`settleQuestion`）来自 projection-timeline.ts；运行结束与会话关闭时的到期收束（`expireQuestions`）也在那里，由 projection-handlers-run.ts 用。
 *
 * 依赖方向：只依赖 projection-state.ts 与 projection-timeline.ts，不导入 projection.ts，也不导入别的处理文件。
 */

import { advanceDelivery } from "./delivery";
import type { EnsembleEvent } from "./events";
import { msBetween } from "./format";
import type { SessionState } from "./projection-state";
import { closeStreaming, getItem, getMessage, getRun, itemKey, putItem, putMessage, putRun, settleQuestion } from "./projection-timeline";
import { questionItemId } from "./questions";
import type { AssistantItem, QuestionItem, ReasoningItem, ToolItem } from "./types";

type ToolEvent = Extract<EnsembleEvent, { kind: "tool.updated" }>;

/** 第一次见到某个工具调用：缺省字段按“刚开始运行的普通工具”补齐。 */
function createTool(state: SessionState, event: ToolEvent): void {
  const data = event.data;
  closeStreaming(state, event.at);
  const name = data.name ?? "tool";
  const status = data.status ?? "running";
  const item: ToolItem = {
    type: "tool",
    id: `tool:${data.callId}`,
    ...(event.runId ? { runId: event.runId } : {}),
    at: event.at,
    updatedAt: event.at,
    callId: data.callId,
    name,
    category: data.category ?? "other",
    title: data.title ?? name,
    status,
    startedAt: data.startedAt ?? event.at,
    ...(data.input ? { input: data.input } : {}),
    ...(data.output ? { output: data.output } : {}),
    ...(data.error ? { error: data.error } : {}),
    ...(data.exitCode !== undefined ? { exitCode: data.exitCode } : {}),
    ...(data.mcp ? { mcp: data.mcp } : {}),
  };
  state.counters.tools += 1;
  if (status === "failed") state.counters.failedTools += 1;
  if (status !== "running") {
    item.endedAt = data.endedAt ?? event.at;
    item.durationMs = msBetween(item.startedAt, item.endedAt);
  }
  putItem(state, item);
}

/** 已有的工具调用收到更新：只覆盖这次带了值的字段；第一次离开“运行中”时记下结束时间。 */
function mergeToolUpdate(state: SessionState, existing: ToolItem, event: ToolEvent): void {
  const data = event.data;
  const next: ToolItem = {
    ...existing,
    updatedAt: event.at,
    ...(data.name ? { name: data.name } : {}),
    ...(data.category ? { category: data.category } : {}),
    ...(data.title ? { title: data.title } : {}),
    ...(data.status ? { status: data.status } : {}),
    ...(data.input ? { input: data.input } : {}),
    ...(data.output ? { output: data.output } : {}),
    ...(data.error ? { error: data.error } : {}),
    ...(data.exitCode !== undefined ? { exitCode: data.exitCode } : {}),
    ...(data.mcp ? { mcp: data.mcp } : {}),
  };
  if (next.status !== "running" && existing.status === "running") {
    next.endedAt = data.endedAt ?? event.at;
    next.durationMs = msBetween(next.startedAt, next.endedAt);
  }
  if (existing.status !== "failed" && next.status === "failed") state.counters.failedTools += 1;
  putItem(state, next);
}

/** 本文件处理的事件种类；projection.ts 的 `applyEvent` 按同一份清单分派进来。 */
type ContentEventKind =
  | "message.sent"
  | "message.delivery"
  | "assistant.delta"
  | "assistant.completed"
  | "reasoning.delta"
  | "reasoning.completed"
  | "tool.updated"
  | "file.changed"
  | "plan.updated"
  | "usage.updated"
  | "diagnostic"
  | "question.asked"
  | "question.resolved"
  | "notice.created"
  | "notice.delivered";
type ContentEvent = Extract<EnsembleEvent, { kind: ContentEventKind }>;

export function applyContentEvent(state: SessionState, event: ContentEvent): void {
  switch (event.kind) {
    case "message.sent": {
      const message = event.data.message;
      putMessage(state, message);
      putItem(state, {
        type: "message",
        id: `message:${message.id}`,
        ...(message.runId ? { runId: message.runId } : {}),
        at: event.at,
        updatedAt: event.at,
        messageId: message.id,
      });
      break;
    }

    case "message.delivery": {
      const message = getMessage(state, event.data.messageId);
      if (!message) break;
      const delivery = advanceDelivery(message.delivery, event.data.record);
      if (delivery !== message.delivery) {
        const followsUp = message.kind === "steer" && event.runId !== undefined &&
          getRun(state, event.runId)?.messageId === message.id;
        const runId = followsUp ? event.runId : message.runId;
        putMessage(state, { ...message, delivery, runId });
        // 投递状态变化也要让对应的时间线条目被判定为已更新。
        const itemId = `message:${message.id}`;
        const item = getItem(state, itemId);
        if (item) putItem(state, { ...item, runId, updatedAt: event.at });
        const run = getRun(state, event.runId);
        if (run && !followsUp && message.kind === "steer" && event.data.record.stage === "applied") {
          putRun(state, { ...run, steerCount: run.steerCount + 1 });
        }
      }
      break;
    }

    case "assistant.delta": {
      const id = itemKey("assistant", event);
      const existing = getItem<AssistantItem>(state, id);
      if (existing) {
        putItem(state, {
          ...existing,
          text: existing.text + event.data.text,
          streaming: true,
          updatedAt: event.at,
          ...(event.data.phase ? { phase: event.data.phase } : {}),
        });
      } else {
        closeStreaming(state, event.at);
        putItem(state, {
          type: "assistant",
          id,
          ...(event.runId ? { runId: event.runId } : {}),
          at: event.at,
          updatedAt: event.at,
          text: event.data.text,
          streaming: true,
          ...(event.data.phase ? { phase: event.data.phase } : {}),
        });
      }
      break;
    }

    case "assistant.completed": {
      const id = itemKey("assistant", event);
      const existing = getItem<AssistantItem>(state, id);
      const phase = event.data.phase ?? existing?.phase;
      if (existing) {
        putItem(state, {
          ...existing,
          text: event.data.text ?? existing.text,
          streaming: false,
          updatedAt: event.at,
          ...(phase ? { phase } : {}),
        });
      } else if (event.data.text) {
        closeStreaming(state, event.at);
        putItem(state, {
          type: "assistant",
          id,
          ...(event.runId ? { runId: event.runId } : {}),
          at: event.at,
          updatedAt: event.at,
          text: event.data.text,
          streaming: false,
          ...(phase ? { phase } : {}),
        });
      }
      break;
    }

    case "reasoning.delta": {
      const id = itemKey("reasoning", event);
      const existing = getItem<ReasoningItem>(state, id);
      if (existing) {
        putItem(state, { ...existing, text: existing.text + event.data.text, streaming: true, updatedAt: event.at });
      } else {
        closeStreaming(state, event.at);
        putItem(state, {
          type: "reasoning",
          id,
          ...(event.runId ? { runId: event.runId } : {}),
          at: event.at,
          updatedAt: event.at,
          text: event.data.text,
          streaming: true,
        });
      }
      break;
    }

    case "reasoning.completed": {
      const id = itemKey("reasoning", event);
      const existing = getItem<ReasoningItem>(state, id);
      if (existing) {
        putItem(state, {
          ...existing,
          streaming: false,
          updatedAt: event.at,
          ...(event.data.durationMs !== undefined ? { durationMs: event.data.durationMs } : {}),
        });
      }
      break;
    }

    case "tool.updated": {
      const existing = getItem<ToolItem>(state, `tool:${event.data.callId}`);
      if (existing) mergeToolUpdate(state, existing, event);
      else createTool(state, event);
      break;
    }

    case "file.changed": {
      for (const file of event.data.files) state.files.add(file.path);
      const callId = event.data.callId;
      if (callId) {
        const tool = getItem<ToolItem>(state, `tool:${callId}`);
        if (tool) {
          const merged = new Map((tool.files ?? []).map((f) => [f.path, f]));
          for (const file of event.data.files) merged.set(file.path, file);
          putItem(state, { ...tool, files: [...merged.values()], updatedAt: event.at });
        }
      }
      break;
    }

    case "plan.updated": {
      const runId = event.runId ?? state.activeRunId;
      if (!runId) break;
      state.plan = { runId, entries: event.data.entries };
      putItem(state, {
        type: "plan",
        id: `plan:${runId}`,
        runId,
        at: getItem(state, `plan:${runId}`)?.at ?? event.at,
        updatedAt: event.at,
        entries: event.data.entries,
        ...(event.data.explanation ? { explanation: event.data.explanation } : {}),
      });
      break;
    }

    case "usage.updated": {
      const runId = event.runId ?? state.activeRunId;
      if (runId) state.usageByRun[runId] = { ...state.usageByRun[runId], ...event.data.usage };
      break;
    }

    case "diagnostic": {
      putItem(state, {
        type: "diagnostic",
        id: `diagnostic:${event.id}`,
        ...(event.runId ? { runId: event.runId } : {}),
        at: event.at,
        updatedAt: event.at,
        level: event.data.level,
        code: event.data.code,
        message: event.data.message,
      });
      break;
    }

    case "question.asked": {
      const { question } = event.data;
      const id = questionItemId(question.id);
      // 同一个提问只登记一次：重放或重复投递都不会多出一条。
      if (getItem(state, id)) break;
      closeStreaming(state, event.at);
      putItem(state, {
        type: "question",
        id,
        ...(event.runId ? { runId: event.runId } : {}),
        at: event.at,
        updatedAt: event.at,
        questionId: question.id,
        prompts: question.prompts,
        status: "open",
      });
      state.openQuestions.add(question.id);
      break;
    }

    case "question.resolved": {
      const data = event.data;
      const item = getItem<QuestionItem>(state, questionItemId(data.questionId));
      // 只有待回答的提问才有结局：先到的算数，后到的（重复回答、迟来的过期）不改写它。
      if (!item || item.status !== "open") break;
      settleQuestion(state, item, data.outcome, {
        at: event.at,
        by: data.by,
        ...(data.answers ? { answers: data.answers } : {}),
        ...(data.note ? { note: data.note } : {}),
        ...(data.reason ? { reason: data.reason } : {}),
        ...(data.delivery ? { delivery: data.delivery } : {}),
      });
      break;
    }

    case "notice.created":
      break;

    case "notice.delivered": {
      for (const messageId of event.data.messageIds) {
        const message = getMessage(state, messageId);
        if (message) putMessage(state, { ...message, sync: { toOrigin: "delivered", at: event.data.at } });
      }
      break;
    }
  }
}
