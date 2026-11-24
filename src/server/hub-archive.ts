/**
 * 归档标记（archive.json）的落盘与失败回滚，是 EventHub.setArchived 的后半段。
 * 前半段——先改内存里的标记、通知订阅者、并在同一个同步段里就发起每个会话的落盘——必须留在 EventHub.setArchived 里，
 * 这里是它调用的两步：`persistMark` 发起一个会话的写 / 删，`persistArchive` 按次序收取各个结果、对失败的会话回滚内存里的标记。
 * 内存里的标记表仍归 EventHub 所有，`persistArchive` 通过 `ArchiveHost` 显式拿到它，不另存一份。
 */

import type { SessionId } from "@shared/types";
import type { ArchiveMark } from "./archive-mark";
import type { HubChange } from "./hub-types";
import type { Logger } from "./logger";
import type { EventStore } from "./store";

/** 一个归档标记落盘失败的原因（装在结果里而不是拒绝，见 persistMark）。 */
export interface ArchiveSaveFailure {
  error: unknown;
}

/** 一次归档 / 取消归档对某个会话做的改动：先改内存，落盘失败时按 before 回滚。 */
export interface ArchiveChange {
  sessionId: SessionId;
  before: ArchiveMark | undefined;
  after: ArchiveMark | undefined;
  /** 这一条的落盘：在改内存的同一个同步段里就已发起，永不拒绝（成功是 undefined，失败是原因），由 persistArchive 按次序收取。 */
  persisted: Promise<ArchiveSaveFailure | undefined>;
}

/** `persistArchive` 要用到的、由 EventHub 持有的几样东西：失败时回滚的标记表本身、会话还在不在、通知订阅者、日志。 */
export interface ArchiveHost {
  readonly log: Logger;
  /** EventHub 的归档标记表本身（不是副本）：落盘失败时按 before 回滚它。 */
  readonly archive: Map<SessionId, ArchiveMark>;
  /** 会话是否存在（热的或冷的）。 */
  has(sessionId: SessionId): boolean;
  notify(change: HubChange): void;
}

/**
 * 把一个会话的标记落盘：给了标记就写，没有就删。必须在改内存的同一个同步段里调用（见 EventHub.setArchived）：
 * FileEventStore 的按文件队列在 writeArchive / clearArchive 被调用的当场（第一个 await 之前）就登记了任务，
 * async 函数在第一个 await 之前也是同步执行的，所以存储的方法就是在这里被当场调用的。
 * 同步抛出的异常与拒绝一样装进结果，不会冒出去打断这一批里其余会话的登记。
 */
export async function persistMark(store: EventStore, sessionId: SessionId, mark: ArchiveMark | undefined): Promise<ArchiveSaveFailure | undefined> {
  try {
    if (mark) await store.writeArchive(sessionId, mark);
    else await store.clearArchive(sessionId);
    return undefined;
  } catch (error) {
    return { error };
  }
}

/** 按次序收取各会话的落盘结果并处理失败（写盘早已全部发起）：错误文字里引用的原因，仍是这一批里排在最前面的那个失败。 */
export async function persistArchive(applied: readonly ArchiveChange[], host: ArchiveHost): Promise<void> {
  const failed: SessionId[] = [];
  let cause: unknown;
  for (const { sessionId, before, after, persisted } of applied) {
    const failure = await persisted;
    if (!failure) continue;
    const { error } = failure;
    // 会话在落盘的过程中被删除了：标记随目录一起没了，不算失败。
    if (!host.has(sessionId) && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
    failed.push(sessionId);
    cause ??= error;
    host.log.error("failed to persist the archive mark", { sessionId, error });
    // 回滚内存里的标记，让界面与磁盘一致；这期间又被别的操作改过的就不动。
    if (host.has(sessionId) && host.archive.get(sessionId) === after) {
      if (before) host.archive.set(sessionId, before);
      else host.archive.delete(sessionId);
      host.notify({ type: "archive", sessionId });
    }
  }
  if (failed.length > 0) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Could not save the archive mark for ${failed.length} session(s): ${reason}`);
  }
}
