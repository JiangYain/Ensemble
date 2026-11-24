/**
 * 仅供测试使用：为“历史会话”（冷热分离、归档、留存）的测试构造事件日志，并把它们写进一个存储。
 * 所有时间都相对 NOW 安排，测试里的时钟由测试自己注入，不依赖真实时间。
 */

import type { EnsembleEvent, EventPayload, EventSource } from "@shared/events";
import { AGENT, EventLog, USER } from "@shared/testing";
import type { SessionId, SessionMeta } from "@shared/types";
import type { ArchiveMark } from "./archive-mark";
import { EventHub, type HubOptions } from "./hub";
import { silentLogger } from "./logger";
import { MemoryEventStore, type EventStore, type LogRead } from "./store";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** 测试里的“现在”。 */
export const NOW = Date.parse("2026-06-01T12:00:00.000Z");

/**
 * 一个会话在日志末尾的样子：
 * - done / failed / cancelled：一次运行以相应方式结束（已结束）；
 * - stopped / lost：运行结束之后又被停止 / 标记为失联（已结束）；
 * - ready：只有创建与“待命”状态，没有运行（不算已结束，但是稳定的）；
 * - running：运行进行中；
 * - pending：运行已完成，但之后又有一条补充消息还没被确认（不算已结束，也不稳定）。
 */
export type Ending = "done" | "failed" | "cancelled" | "stopped" | "lost" | "ready" | "running" | "pending";

export interface SessionFixture {
  id: SessionId;
  ending?: Ending;
  /** 创建时刻（毫秒，缺省是 NOW 往前 30 天）；之后每条事件各晚 100 毫秒，所以最后一条事件在它之后不到一秒。 */
  at?: number;
  parent?: SessionId;
  /** 有上级时的层数，缺省 1。 */
  depth?: number;
  meta?: Partial<SessionMeta>;
}

/** 一个会话的完整事件日志（序号从 1 起，严格递增）。 */
export function sessionEvents(fixture: SessionFixture): EnsembleEvent[] {
  const { id, ending = "done" } = fixture;
  const start = fixture.at ?? NOW - 30 * DAY;
  const log = new EventLog(id, start);
  log.created({
    // testMeta 里的 createdAt 是个写死的日期；会话树按创建时间排序，所以这里让它与第一条事件对得上。
    createdAt: new Date(start).toISOString(),
    ...(fixture.parent ? { parentSessionId: fixture.parent, depth: fixture.depth ?? 1 } : {}),
    ...fixture.meta,
  });
  if (ending === "ready") {
    log.push({ kind: "session.status", data: { status: "idle" } }, { source: "ensemble" });
    return log.events;
  }
  log.message("msg_1", "task", "Do the work", AGENT);
  log.push({ kind: "message.delivery", data: { messageId: "msg_1", record: { stage: "applied", at: log.now() } } }, { source: "ensemble" });
  log.run("run_1", 1, "msg_1");
  log.startRun("run_1");
  if (ending === "running") return log.events;
  if (ending === "failed") log.push({ kind: "run.failed", data: { error: { code: "boom", message: "It failed" } } }, { runId: "run_1" });
  else if (ending === "cancelled") log.push({ kind: "run.cancelled", data: { by: USER } }, { runId: "run_1" });
  else log.push({ kind: "run.completed", data: { stopReason: "end_turn" } }, { runId: "run_1" });
  if (ending === "stopped") log.push({ kind: "session.status", data: { status: "stopped" } }, { source: "ensemble" });
  if (ending === "lost") log.push({ kind: "session.status", data: { status: "lost" } }, { source: "ensemble" });
  if (ending === "pending") log.message("msg_2", "follow_up", "One more thing", USER);
  return log.events;
}

/**
 * 给一份日志再续一条事件：序号接在最后一条后面，时间晚一秒；事件同时追加进传入的数组，并作为返回值给出。
 * 用来模拟“日志在快照写好之后又长了”（旧版本服务续写、外部改动）。
 */
export function appendTo(events: EnsembleEvent[], payload: EventPayload, source: EventSource = "ensemble"): EnsembleEvent {
  const last = events.at(-1);
  if (!last) throw new Error("cannot append to an empty log");
  const event = {
    id: `evt_extra_${last.seq + 1}`,
    sessionId: last.sessionId,
    seq: last.seq + 1,
    at: new Date(Date.parse(last.at) + 1000).toISOString(),
    source,
    ...payload,
  } as EnsembleEvent;
  events.push(event);
  return event;
}

/** 把这些会话的日志写进存储（并等它们落盘），返回各自的事件，方便测试核对。 */
export async function seed(store: EventStore, fixtures: readonly SessionFixture[]): Promise<Map<SessionId, EnsembleEvent[]>> {
  const written = new Map<SessionId, EnsembleEvent[]>();
  for (const fixture of fixtures) {
    const events = sessionEvents(fixture);
    for (const event of events) store.append(event);
    written.set(fixture.id, events);
  }
  await store.flush();
  return written;
}

/** 数着“读了几次日志”的内存存储（支持快照）：测试据此断言冷会话没有被读、读了几次、有没有被缓存。 */
export class SpyStore extends MemoryEventStore {
  /** 完整载入（load，会走读时修复的那条路径）的会话 id，按调用次序。 */
  readonly loads: string[] = [];
  /** 只读载入（readLog）的会话 id，按调用次序。 */
  readonly logReads: string[] = [];
  /** 打开后写、删归档标记一律失败（模拟磁盘出错）。 */
  failArchive = false;

  constructor() {
    super({ snapshots: true });
  }

  override async load(sessionId: string): Promise<EnsembleEvent[]> {
    this.loads.push(sessionId);
    return super.load(sessionId);
  }

  override async readLog(sessionId: string): Promise<LogRead | undefined> {
    this.logReads.push(sessionId);
    return super.readLog(sessionId);
  }

  override async writeArchive(sessionId: string, mark: ArchiveMark): Promise<void> {
    if (this.failArchive) throw new Error("disk full");
    return super.writeArchive(sessionId, mark);
  }

  override async clearArchive(sessionId: string): Promise<void> {
    if (this.failArchive) throw new Error("disk full");
    return super.clearArchive(sessionId);
  }
}

/** 测试里可以手动拨动的时钟（毫秒）。 */
export interface Clock {
  now: number;
}

/** 懒加载模式的中枢：保温期 10 分钟（缺省值的缩影），时间取自传入的时钟，流式增量立即提交。 */
export function lazyHub(store: EventStore, clock: Clock, options: Partial<HubOptions> = {}): EventHub {
  return new EventHub({ store, log: silentLogger, coalesceMs: 0, mode: "lazy", warmMs: 10 * MINUTE, now: () => clock.now, ...options });
}
