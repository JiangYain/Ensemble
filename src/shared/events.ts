import type {
  DeliveryRecord,
  ErrorInfo,
  EventId,
  FileChange,
  Message,
  MessageId,
  Notice,
  NoticeId,
  PlanEntry,
  Preview,
  Run,
  RunId,
  SessionId,
  SessionMeta,
  SessionStatus,
  ToolCategory,
  ToolStatus,
  Usage,
  Actor,
} from "./types";
import type { QuestionAsk, QuestionResolution } from "./questions";

/**
 * 统一事件词汇。命名沿用 mosoo Driver 的风格（message / tool / run / usage …），
 * 并增加 Ensemble 自己负责的委派、干预与投递事件。
 * 所有“执行步骤”类事件只能由执行端真实的 SDK / 控制接口事件转换而来。
 *
 * 没有“授权”类事件：被委派的 Agent 以 Full Access 运行，不存在需要人来批准的闸门。
 * 旧版本日志里残留的 `permission.*` 事件在重放时会被忽略（见 projection 的 applyEvent）。
 * “提问”（`question.*`）不是授权：它是执行端遇到需求歧义、停下来向发起方要一个答案（见 questions.ts）。
 * 提问的记录就是日志里的这两类事件，没有另外的状态文件；老版本读到它们时按“不认识的事件”处理（只推进序号）。
 */

export type EventSource = "executor" | "ensemble" | "user" | "origin";

export interface ToolUpdate {
  callId: string;
  name?: string;
  category?: ToolCategory;
  title?: string;
  status?: ToolStatus;
  input?: Preview;
  output?: Preview;
  error?: string;
  exitCode?: number;
  startedAt?: string;
  endedAt?: string;
  mcp?: { server?: string; tool?: string };
}

export type SessionMetaPatch = Partial<
  Pick<SessionMeta, "title" | "model" | "effort" | "nativeRef" | "capabilities" | "accessEnforcement">
>;

/**
 * 事后调整“上级会话”（承接关系）的记录。每个受影响的会话在自己的日志里各记一条，重放才不必跨会话：
 * 被改的会话本身（cause "self"），以及它的后代（cause "ancestor"：上级没变，只有层数跟着变）。
 */
export interface RelinkData {
  /** 调整后的上级；null 表示不再有上级（回到直接挂在来源下）。有多个上级时是其中的第一个（主上级）。 */
  parentSessionId: SessionId | null;
  /**
   * 调整后完整、有序的上级集合，只在多于一个上级时才有（`parentSessionId` 是它的第一项）；
   * 没有这个字段就是 0 个或 1 个上级，由 `parentSessionId` 单独说明——老日志里的记录全是这样，重放结果与原来完全一致。
   * 投影在新的集合不足两个时会清掉会话原先记着的 parentSessionIds。
   */
  parentSessionIds?: SessionId[];
  depth: number;
  /** 调整之前的上级与深度；同样，parentSessionIds 只在原先有多个上级时才有。 */
  previous: { parentSessionId?: SessionId; parentSessionIds?: SessionId[]; depth: number };
  cause: "self" | "ancestor";
  by: Actor;
}

export type EventPayload =
  // ── 会话 ──
  | { kind: "session.created"; data: { meta: SessionMeta } }
  | { kind: "session.updated"; data: { patch: SessionMetaPatch } }
  | { kind: "session.relinked"; data: RelinkData }
  | { kind: "session.status"; data: { status: SessionStatus; reason?: string; error?: ErrorInfo } }
  // ── 运行 ──
  | { kind: "run.queued"; data: { run: Run } }
  | { kind: "run.starting"; data: { resuming?: boolean } }
  | { kind: "run.started"; data: { nativeTurnId?: string } }
  | { kind: "run.completed"; data: { stopReason?: string } }
  | { kind: "run.failed"; data: { error: ErrorInfo } }
  | { kind: "run.cancelled"; data: { by?: Actor; note?: string } }
  // ── 消息与投递 ──
  | { kind: "message.sent"; data: { message: Message } }
  | { kind: "message.delivery"; data: { messageId: MessageId; record: DeliveryRecord } }
  // ── 执行端输出 ──
  | { kind: "assistant.delta"; data: { itemId: string; text: string; phase?: "commentary" | "final" } }
  | { kind: "assistant.completed"; data: { itemId: string; text?: string; phase?: "commentary" | "final" } }
  | { kind: "reasoning.delta"; data: { itemId: string; text: string } }
  | { kind: "reasoning.completed"; data: { itemId: string; durationMs?: number } }
  | { kind: "tool.updated"; data: ToolUpdate }
  | { kind: "file.changed"; data: { callId?: string; files: FileChange[] } }
  | { kind: "plan.updated"; data: { entries: PlanEntry[]; explanation?: string } }
  | { kind: "usage.updated"; data: { usage: Usage } }
  // ── 提问（执行端停下来要一个答案；不是授权） ──
  | { kind: "question.asked"; data: { question: QuestionAsk } }
  | { kind: "question.resolved"; data: QuestionResolution }
  // ── 诊断与向发起端的同步 ──
  | {
      kind: "diagnostic";
      data: { level: "info" | "warn" | "error"; code: string; message: string };
    }
  | { kind: "notice.created"; data: { notice: Notice } }
  | { kind: "notice.delivered"; data: { noticeIds: NoticeId[]; messageIds: MessageId[]; at: string } };

export type EventKind = EventPayload["kind"];

export interface EventBase {
  id: EventId;
  sessionId: SessionId;
  /** 会话内单调递增的序号，用于幂等重放。 */
  seq: number;
  at: string;
  runId?: RunId;
  source: EventSource;
}

export type EnsembleEvent = EventBase & EventPayload;

/** 尚未分配 id / seq / 时间的事件草稿，由事件管线补全。 */
export type EventDraft = EventPayload & { runId?: RunId; source: EventSource; at?: string };

/** 流式增量事件：可在合并窗口内拼接。 */
export function isDeltaEvent(event: EventPayload): event is
  | Extract<EventPayload, { kind: "assistant.delta" }>
  | Extract<EventPayload, { kind: "reasoning.delta" }> {
  return event.kind === "assistant.delta" || event.kind === "reasoning.delta";
}
