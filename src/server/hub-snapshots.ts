/**
 * 事件中枢与摘要快照（summary.json）之间的两步磁盘操作，都只依赖存储与日志（读的那一步另外接一个调用方传入的“够不够旧”的判断），
 * 不碰热 / 冷表：
 * - `writeSnapshot`：给一个调用方已判定稳定、可以冷存的会话写快照（冻结时、启动重放时用）；
 * - `readTrustedSnapshots`：启动时（lazy 模式）并行读各会话的快照，只留下可信的。
 * 快照的格式、结构校验与“稳定”的判断在 snapshot.ts；哪个会话该冻结、登记成热还是冷、
 * 冻结 / 解冻怎样换热表与冷表，仍在 hub.ts 的 EventHub 里。
 */

import { isoNow } from "@shared/format";
import { mapPool } from "@shared/map-pool";
import type { SessionState } from "@shared/projection";
import type { SessionId } from "@shared/types";
import { STARTUP_READ_LIMIT } from "./hub-types";
import type { Logger } from "./logger";
import { buildSnapshot, isStableSummary, parseSnapshot, type SessionSnapshot } from "./snapshot";
import type { EventStore } from "./store";

/**
 * 写会话的摘要快照：先让缓冲里的事件落盘并取日志大小，快照记下这个大小与此刻的序号。成功返回写下的快照；
 * 落盘有任何问题（写失败、这个会话的事件写盘失败过——日志里缺了事件、内存里的状态却有，所以 seal 对它一直不给大小、
 * 写的过程中会话又有了新事件）都只是返回 undefined——会话照旧留在内存里，什么也不丢，下次启动照日志重放。
 */
export async function writeSnapshot(store: EventStore, log: Logger, sessionId: SessionId, state: SessionState): Promise<SessionSnapshot | undefined> {
  const seq = state.seq;
  try {
    const bytes = await store.seal(sessionId);
    // seal 的 await 期间会话有了新事件：这个大小已经不对应当前序号，不写。
    if (bytes === undefined || state.seq !== seq) return undefined;
    const snapshot = buildSnapshot(state, bytes, 0, isoNow());
    await store.writeSnapshot(sessionId, snapshot);
    return snapshot;
  } catch (error) {
    log.warn("could not write the session snapshot; keeping the session in memory", { sessionId, error });
    return undefined;
  }
}

/**
 * 并行（有界）读取各会话的快照，只留下可信的。读不了的按“没有快照”处理并记一条日志。
 * `isOld` 是 EventHub 的保温期判断（快照写下的时刻是否已够旧；时间读不懂时它一律答“不够旧”）。
 */
export async function readTrustedSnapshots(
  store: EventStore,
  log: Logger,
  isOld: (iso: string) => boolean,
  ids: readonly SessionId[],
): Promise<Map<SessionId, SessionSnapshot>> {
  const trusted = new Map<SessionId, SessionSnapshot>();
  // 逐项自己捕获错误：某个会话的快照读不了，只让这一个退回重放，不影响其余的。
  await mapPool(ids, STARTUP_READ_LIMIT, async (sessionId) => {
    try {
      const snapshot = await trustedSnapshot(store, isOld, sessionId);
      if (snapshot) trusted.set(sessionId, snapshot);
    } catch (error) {
      log.warn("session snapshot unreadable, replaying the log instead", { sessionId, error });
    }
  });
  return trusted;
}

/**
 * 快照可信才返回：格式与结构合格；没有未送达通知、会话是稳定的、已过保温期；
 * 并且日志此刻的字节数等于快照写下时记录的字节数——这证明快照对应日志的当前末尾（不读日志本身）。
 */
async function trustedSnapshot(store: EventStore, isOld: (iso: string) => boolean, sessionId: SessionId): Promise<SessionSnapshot | undefined> {
  const snapshot = parseSnapshot(await store.readSnapshot(sessionId), sessionId);
  if (!snapshot || snapshot.undeliveredNotices > 0 || !isStableSummary(snapshot.summary) || !isOld(snapshot.summary.updatedAt)) return undefined;
  return (await store.logSize(sessionId)) === snapshot.logBytes ? snapshot : undefined;
}
