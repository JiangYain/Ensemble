/**
 * 事件中枢（hub.ts）的类型与常量：没有任何状态，也不依赖 hub.ts——hub.ts 与它的辅助文件
 * （hub-dispatch / hub-archive / hub-events / hub-snapshots）都单向依赖这里。
 * 对外的类型（HubChange、HubListener、HubOptions、ReadEventsOptions、HubNode、ArchivedFilter）仍从 hub.ts 转出，使用方照旧从 "./hub" 导入；
 * 只在中枢内部用的（DeltaDraft、Staged、IndexFields）和启动时并行读取的路数（STARTUP_READ_LIMIT）只在 hub.ts 与 hub-*.ts 之间共用，不从 hub.ts 转出。
 */

import type { EnsembleEvent, EventDraft } from "@shared/events";
import type { ParentRefs } from "@shared/lineage";
import type { SessionState } from "@shared/projection";
import type { SessionId } from "@shared/types";
import type { HistoryMode } from "./history-mode";
import type { Logger } from "./logger";
import type { EventStore } from "./store";

export type HubChange =
  | { type: "event"; event: EnsembleEvent; state: SessionState }
  | { type: "relationship"; sessionId: SessionId }
  /** 会话的“值得留意”事项变了；会话本身没有新事件（静默、持续过久都是随时间成立的）。 */
  | { type: "attention"; sessionId: SessionId }
  /** 归档或取消归档：会话本身没有新事件，摘要里多了或少了 archivedAt（SSE 据此推送一条新摘要）。 */
  | { type: "archive"; sessionId: SessionId }
  | { type: "removed"; sessionId: SessionId };

export type HubListener = (change: HubChange) => void;

export type DeltaDraft = Extract<EventDraft, { kind: "assistant.delta" | "reasoning.delta" }>;

export interface Staged {
  draft: DeltaDraft;
  timer: NodeJS.Timeout;
}

export interface HubOptions {
  store: EventStore;
  log: Logger;
  coalesceMs?: number;
  /** 历史会话的载入方式（见 ENV.historyMode），缺省 lazy。存储不支持快照（内存存储）时一律按 eager 处理。 */
  mode?: HistoryMode;
  /** 保温期（毫秒），缺省 LIMITS.history.warmMs；测试里用它缩短。 */
  warmMs?: number;
  /** 后台清扫的间隔（毫秒），缺省 LIMITS.history.sweepMs。 */
  sweepMs?: number;
  /** 冷会话事件日志读取缓存的上限，缺省 LIMITS.history。 */
  eventCache?: { entries: number; bytes: number };
  /** 当前时刻（毫秒），测试注入；缺省 Date.now。 */
  now?: () => number;
}

/** 读取事件的范围：afterSeq 之后的事件；limit 取最后 N 条。 */
export interface ReadEventsOptions {
  afterSeq?: number;
  limit?: number;
}

/**
 * 一个会话在“索引”层面的样子：热会话取自它的状态，冷会话取自快照里的摘要。
 * 不需要完整状态的使用者（改挂上级的规划、归档规则）只读它，就不必为了看一眼关系去解冻会话。
 */
export interface HubNode {
  id: SessionId;
  parentSessionId?: SessionId;
  /** 多于一个上级（汇聚）时的完整有序集合；读它请用 `parentIdsOf`（shared/lineage）。 */
  parentSessionIds?: SessionId[];
  depth: number;
  createdAt: string;
}

/** 索引层面读的几个字段：热会话的 `SessionMeta` 与冷会话快照里的 `SessionSummary` 都带着它们，所以两边只要选一次来源。 */
export type IndexFields = ParentRefs & Pick<HubNode, "depth" | "createdAt">;

/** 归档视图：默认不含已归档的；include 全部；only 只要已归档的。 */
export type ArchivedFilter = "exclude" | "include" | "only";

/** 启动时并行读快照、读归档标记的路数：读的是许多个小文件，路数再大也只是挤占磁盘。 */
export const STARTUP_READ_LIMIT = 8;
