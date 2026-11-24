import type { EnsembleEvent } from "@shared/events";
import type { SessionState } from "@shared/projection";
import type { AttentionItem, NoticeId } from "@shared/types";

/**
 * 一个热会话（完整状态在内存里的会话）的整条记录。
 *
 * 事件中枢（hub.ts）原来把一个热会话散放在五张按会话 id 索引的表里：投影状态、事件列表、最近取用时刻、未送达通知、值得留意事项。
 * 它们同生同灭——登记、解冻、冻结、删除都是对同一个会话把这几样一起换掉——分开放，每一处切换都得记得逐张表处理，
 * 漏一张就是半截状态（有状态却没有事件列表，或冻结之后还留着旧的通知集合）。现在热表是 `Map<SessionId, HotSession>`，
 * 冷热切换只动这一张表；以后再给热会话加随它同生同灭的数据，也加在这条记录里，不要另开一张按会话 id 索引的表。
 * 冷会话没有这样的记录，只有一份快照（见 snapshot.ts）。
 */
export interface HotSession {
  /**
   * 投影出来的完整状态。`applyEvent` 原地修改它，整个热期间始终是同一个对象，
   * 所以“还是不是同一条记录”就是“还是不是同一个状态”（冻结落盘后据此复核，见 EventHub.freeze）。
   */
  readonly state: SessionState;
  /** 已提交的全部事件，序号严格递增。只有 EventHub 的提交路径往里追加，事件列表与投影在同一处同步推进。 */
  readonly events: EnsembleEvent[];
  /** 还没送达主 Agent 的通知 id：非空时不冷存（启动时要据此重建通知队列）。 */
  readonly undelivered: Set<NoticeId>;
  /** 最近一次被取用或写入的时刻（毫秒）：保温期从这里起算，防止刚被取用的会话立刻又被冻结。 */
  touchedAt: number;
  /** 由 AttentionSupervisor 整组替换，所以摘要缓存可以按引用判断是否过期；没有值得留意的事项时是 undefined。 */
  attention?: AttentionItem[] | undefined;
}

/**
 * 从未被取用过：启动时重放登记的热会话，在第一次被取用或写入之前是这个值。
 * 保温期看的是“现在 − touchedAt”，所以它永远不会挡住冻结——那时只看会话最后一次活动离现在多久。
 */
export const NEVER_TOUCHED = Number.NEGATIVE_INFINITY;

/**
 * 一条事件对“未送达通知”集合的影响：notice.created 记下这条通知，notice.delivered 划掉它点名的通知，别的事件不动。
 * 实时提交（EventHub.commit）与整份日志的重放（undeliveredNotices）走同一个函数，两处对“什么算未送达”的判断不会分叉。
 */
export function applyNoticeEvent(pending: Set<NoticeId>, event: EnsembleEvent): void {
  if (event.kind === "notice.created") pending.add(event.data.notice.id);
  else if (event.kind === "notice.delivered") {
    for (const id of event.data.noticeIds) pending.delete(id);
  }
}

/** 日志里还没送达的通知：被某条 notice.delivered 点名的算已送达。 */
export function undeliveredNotices(events: readonly EnsembleEvent[]): Set<NoticeId> {
  const pending = new Set<NoticeId>();
  for (const event of events) applyNoticeEvent(pending, event);
  return pending;
}
