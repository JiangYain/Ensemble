/**
 * 投影用的会话状态：`SessionState` 的形状，以及从 `session.created` 创建它（`createState`）。
 *
 * 这里只有类型与创建，没有任何事件处理：改状态的原语在 projection-timeline.ts，各类事件的处理在 projection-handlers-*.ts，
 * 派生与摘要在 projection-derive.ts / projection-summary.ts。它们都只 `import type { SessionState }` 从这里来；
 * 本文件不导入同目录的任何 projection-*.ts，所以依赖方向始终是单向的。
 */

import type { EnsembleEvent } from "./events";
import type { QuestionId } from "./questions";
import type {
  Activity,
  ErrorInfo,
  Message,
  MessageId,
  PlanEntry,
  Run,
  RunId,
  SessionMeta,
  SessionStatus,
  TimelineItem,
  Usage,
} from "./types";

export interface SessionState {
  meta: SessionMeta;
  status: SessionStatus;
  statusReason?: string;
  runs: Run[];
  messages: Message[];
  timeline: TimelineItem[];
  activity: Activity;
  activityKey: string;
  usageByRun: Record<RunId, Usage>;
  plan: { runId: RunId; entries: PlanEntry[] } | undefined;
  activeRunId: RunId | undefined;
  lastError: ErrorInfo | undefined;
  startedAt: string | undefined;
  endedAt: string | undefined;
  updatedAt: string;
  seq: number;
  files: Set<string>;
  counters: { tools: number; failedTools: number };
  /**
   * 待回答的提问（questionId）。时间线上提问条目的状态是权威，这里只是它的索引：
   * 摘要要数、值得留意要列、运行与会话收尾要找，都不必扫描整条时间线。
   */
  openQuestions: Set<QuestionId>;
  idx: {
    items: Map<string, number>;
    messages: Map<MessageId, number>;
    runs: Map<RunId, number>;
  };
}

type CreatedEvent = Extract<EnsembleEvent, { kind: "session.created" }>;

/**
 * 旧版本还有一个“工作区可写，越权时询问用户”的访问级别（workspace_write），现在已经没有了：
 * 被委派的会话要么 Full Access，要么只读。磁盘上遗留的旧值按 Full Access 读取，
 * 否则界面和执行端都会遇到一个不认识的级别。
 */
function normalizeMeta(meta: SessionMeta): SessionMeta {
  const access: string = meta.access;
  return access === "read_only" || access === "full" ? meta : { ...meta, access: "full" };
}

export function createState(event: CreatedEvent): SessionState {
  return {
    meta: normalizeMeta(event.data.meta),
    status: "starting",
    runs: [],
    messages: [],
    timeline: [],
    activity: { kind: "starting", since: event.at },
    activityKey: "starting",
    usageByRun: {},
    plan: undefined,
    activeRunId: undefined,
    lastError: undefined,
    startedAt: undefined,
    endedAt: undefined,
    updatedAt: event.at,
    seq: event.seq,
    files: new Set(),
    counters: { tools: 0, failedTools: 0 },
    openQuestions: new Set(),
    idx: { items: new Map(), messages: new Map(), runs: new Map() },
  };
}
