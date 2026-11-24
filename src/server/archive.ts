import { archiveNodeOf, planArchive, planUnarchive, type ArchiveTree, type UnarchiveOptions } from "@shared/archive";
import { isoNow } from "@shared/format";
import type { ArchiveResponse } from "@shared/protocol";
import type { SessionId } from "@shared/types";
import type { EventHub } from "./hub";
import type { Logger } from "./logger";

/**
 * 归档的服务端落实：规则本身在 shared/archive.ts（纯函数），这里把它接到中枢上——
 * 规则读到的会话树来自摘要（热的冷的都一样，不解冻任何会话），算出的结果交给 hub.setArchived 登记并落盘。
 * HTTP 路由、留存清扫器、自动取消归档都走这里，所以“什么能归档、归档谁”的口径只有一个。
 *
 * 规则判断与登记之间没有 await（planArchive 与 setArchived 的内存部分在同一个同步段里完成），
 * 所以判断时的世界与登记时一致；只有最后的落盘是异步的。
 */
type ArchiveHub = Pick<EventHub, "summary" | "childIds" | "sessionIds" | "setArchived" | "archiveOf">;

/** 规则用的会话树：从中枢的摘要与子会话表构造。 */
export function archiveTreeOf(hub: Pick<EventHub, "summary" | "childIds" | "sessionIds">): ArchiveTree {
  return {
    node: (id) => {
      const summary = hub.summary(id);
      return summary ? archiveNodeOf(summary) : undefined;
    },
    childrenOf: (id) => hub.childIds(id),
    ids: () => hub.sessionIds(),
  };
}

/** 归档：按规则算出会变的与被跳过的，再登记。by 记录是谁归档的（用户操作 / 留存策略）。 */
export async function archiveSessions(hub: ArchiveHub, ids: readonly SessionId[], by: "user" | "retention"): Promise<ArchiveResponse> {
  const plan = planArchive(archiveTreeOf(hub), ids);
  if (plan.changed.length > 0) await hub.setArchived(plan.changed, { archivedAt: isoNow(), by });
  return plan;
}

/** 取消归档：被点名的会话、它的子树与仍归档的上级链一起回到默认视图；`exact` 时只恢复点名的会话（撤销归档用，见 shared/archive 的 UnarchiveOptions）。 */
export async function unarchiveSessions(hub: ArchiveHub, ids: readonly SessionId[], options?: UnarchiveOptions): Promise<ArchiveResponse> {
  const plan = planUnarchive(archiveTreeOf(hub), ids, options);
  if (plan.changed.length > 0) await hub.setArchived(plan.changed, null);
  return plan;
}

/**
 * 会话被重新用到（收到补充消息、被 follows / parentSessionId 接在后面、被改挂的新上级）：已归档就先取消归档，
 * 连同它的上级链与子树——不然一个正在被使用的会话会躲在归档里，或者脱离上级单独冒出来。返回是否真的取消了归档。
 * 登记在调用的那一刻同步完成（落盘才是异步的）。
 * 从不抛出：这是整理上的附带动作，落盘失败（内存里的标记已回滚）只记一条警告，不该让一次正当的 send / delegate 失败。
 */
export async function reviveSession(hub: ArchiveHub, sessionId: SessionId, log: Logger): Promise<boolean> {
  if (!hub.archiveOf(sessionId)) return false;
  try {
    return (await unarchiveSessions(hub, [sessionId])).changed.length > 0;
  } catch (error) {
    log.warn("could not unarchive a session that was just used", { sessionId, error });
    return false;
  }
}
