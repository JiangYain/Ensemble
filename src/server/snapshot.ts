import { isDeliveryPending } from "@shared/delivery";
import { toSummary, type SessionState } from "@shared/projection";
import type { SessionId, SessionPhase, SessionStatus, SessionSummary } from "@shared/types";

/**
 * 会话的摘要快照（会话目录里的 summary.json）：服务据此在启动时不读 events.jsonl 就认得一个已结束的会话（“冷会话”），
 * 事件日志留到真正要看 / 要继续时才读。快照只是 events.jsonl 的缓存，不是第二份真相：
 * 它丢了、坏了、对不上，服务都退回完整重放，什么也不会丢（见 EventHub.load）。
 *
 * 内容（索引需要的元信息——上级、深度、来源、创建时间——都在 summary 里，不另存一份以免两份对不上）：
 * - summary：服务端用 toSummary 算好的摘要；childIds 记为空（子会话表以启动时各会话记录的上级为准，不信快照里一份会过期的列表），
 *   不含 attention 与归档标记（它们不来自事件日志，由服务端运行时合并）；
 * - lastSeq：摘要对应的最后一条事件序号；logBytes：写快照那一刻 events.jsonl 的实际字节数。
 *   两者合起来证明“这份快照对应日志的当前末尾”：启动时只 stat 一下文件大小，不一致（日志后来又追加了、被外部改过）就不采信；
 * - undeliveredNotices：当时还没送达主 Agent 的通知条数。有未送达通知的会话不冷存（启动时要据此重建通知队列），所以只在为 0 时才会采信。
 */

/**
 * 快照格式版本。SessionSummary 的字段集合变化、或 toSummary 对某个字段的算法变化时必须加一：
 * 老快照里缺新字段、或带着旧算法算出来的值，冷会话的摘要就会和热会话（实时算的）不一样。
 * 版本不符的快照一律不采信、退回完整重放，随后会按新格式重写，所以加一只是让下一次启动慢一次，不会丢东西。
 *
 * 没有例外：连“只在特定情形下才出现”的可选字段也要加。快照不是只有写它的那一版服务会读：服务随宿主起落，装着不同版本插件的宿主
 * 可能轮流起服务，旧服务重放日志（或让会话冷下来）时会按它认识的字段写一份快照，盖掉新服务写的那份；
 * 版本号若相同，新服务下一次启动就会采信它——摘要里缺了本该有的字段，而事件日志其实是完整的。
 * isSummary 只查结构，查不出“这里本该有这个字段”，所以版本号是新旧两边互相拒收对方快照的唯一手段。
 *
 * 版本记录：
 * - 1：第一版。`parentSessionIds`（汇聚，多于一个上级时才有）加进摘要时没有升版本：新服务写的版本 1 快照带着它，
 *   旧服务重放同一个汇聚会话后写的版本 1 快照不带；版本号一样，新服务分不出来，采信了后者，汇聚会话就在界面上变成单上级
 *   （其余上级的子会话表里也少了它；日志里的关系没丢，只是显示错了）。
 * - 2：为此升版，版本 1 的快照一律作废、各自完整重放，两个方向都互相拒收，汇聚关系因此保留。同一次升版也覆盖投影里的一处改动：
 *   助手文字条目的键带上了 runId（见 projection-timeline.ts 的 itemKey），多次运行的会话里 `lastAssistantPreview` 的取值可能随之不同，
 *   版本 1 的快照里留着的是旧算法的结果。代价只是升级后的第一次启动把各会话多重放一遍。
 */
export const SNAPSHOT_FORMAT = 2;

/**
 * SessionSummary 的全部字段。这张表与 SessionSummary 逐项对应（Record<keyof SessionSummary, true>：漏写或多写都过不了类型检查），
 * 它存在的唯一目的是：改动摘要的字段集合的人必须来到这里，看到上面的说明，顺手把 SNAPSHOT_FORMAT 加一。
 * snapshot.test.ts 另有一个测试把这张表、版本号与真实的 toSummary 输出钉在一起。
 */
export const SUMMARY_FIELDS: Record<keyof SessionSummary, true> = {
  id: true,
  title: true,
  harness: true,
  runtime: true,
  model: true,
  effort: true,
  access: true,
  accessEnforcement: true,
  cwd: true,
  origin: true,
  parentSessionId: true,
  parentSessionIds: true,
  childIds: true,
  depth: true,
  status: true,
  phase: true,
  activity: true,
  progress: true,
  attention: true,
  openQuestions: true,
  archivedAt: true,
  archivedBy: true,
  taskPreview: true,
  runCount: true,
  activeRunId: true,
  lastRun: true,
  usage: true,
  messages: true,
  counters: true,
  lastAssistantPreview: true,
  lastError: true,
  nativeRef: true,
  capabilities: true,
  createdAt: true,
  updatedAt: true,
  startedAt: true,
  endedAt: true,
  seq: true,
};

const STATUSES: Record<SessionStatus, true> = { starting: true, queued: true, running: true, idle: true, stopped: true, failed: true, lost: true };
const PHASES: Record<SessionPhase, true> = {
  ready: true, starting: true, queued: true, running: true, done: true, failed: true, cancelled: true, stopped: true, lost: true,
};

export interface SessionSnapshot {
  format: number;
  sessionId: SessionId;
  /** 摘要对应的最后一条事件序号（等于 summary.seq）。 */
  lastSeq: number;
  /** 写快照那一刻 events.jsonl 的字节数。 */
  logBytes: number;
  /** 当时还没送达的通知条数；只有 0 才会被采信（见文件头）。 */
  undeliveredNotices: number;
  writtenAt: string;
  summary: SessionSummary;
}

/** 用会话的当前状态做快照。调用方保证 logBytes 是“已含 state 里全部事件”的日志大小（先 seal 再取）。 */
export function buildSnapshot(state: SessionState, logBytes: number, undeliveredNotices: number, writtenAt: string): SessionSnapshot {
  return {
    format: SNAPSHOT_FORMAT,
    sessionId: state.meta.id,
    lastSeq: state.seq,
    logBytes,
    undeliveredNotices,
    writtenAt,
    summary: toSummary(state, []),
  };
}

/**
 * 校验磁盘上读到的快照，返回可用的快照；格式不符、字段残缺、与会话 id 对不上都返回 undefined。
 * 这里只验证快照自身是否完整可信；它是否对应日志的当前末尾由调用方比对文件大小。
 */
export function parseSnapshot(value: unknown, sessionId: SessionId): SessionSnapshot | undefined {
  if (!isRecord(value) || value["format"] !== SNAPSHOT_FORMAT || value["sessionId"] !== sessionId) return undefined;
  const lastSeq = value["lastSeq"];
  const logBytes = value["logBytes"];
  const undeliveredNotices = value["undeliveredNotices"];
  const writtenAt = value["writtenAt"];
  if (!isCount(lastSeq) || !isCount(logBytes) || !isCount(undeliveredNotices) || typeof writtenAt !== "string") return undefined;
  const summary = value["summary"];
  if (!isSummary(summary, sessionId, lastSeq)) return undefined;
  return { format: SNAPSHOT_FORMAT, sessionId, lastSeq, logBytes, undeliveredNotices, writtenAt, summary: withoutDerived(summary) };
}

/** 快照里的摘要是不是“稳定”的：没有进行中的运行、没有待确认的消息。写快照只发生在稳定的会话上，读时再核一遍是防御。 */
export function isStableSummary(summary: SessionSummary): boolean {
  return summary.status !== "starting"
    && summary.status !== "queued"
    && summary.status !== "running"
    && summary.activeRunId === undefined
    && summary.messages.pending === 0
    // 还有待回答的提问：它在等人，不是“已经稳定”（正常情况下运行还在，这里只是兜底）。
    && (summary.openQuestions ?? 0) === 0;
}

/** 会话状态是不是“稳定”的：可以冷存的前提之一。没有进行中 / 排队的运行、没有待确认的消息。 */
export function isStableState(state: SessionState): boolean {
  if (state.status === "starting" || state.status === "queued" || state.status === "running") return false;
  if (state.activeRunId !== undefined) return false;
  if (state.runs.some((run) => run.status === "queued" || run.status === "starting" || run.status === "running")) return false;
  // 还有待回答的提问：它在等人，不是“已经稳定”（正常情况下运行还在，这里只是兜底）。
  if (state.openQuestions.size > 0) return false;
  return !state.messages.some((message) => isDeliveryPending(message.delivery));
}

function withoutDerived(summary: SessionSummary): SessionSummary {
  const { attention: _attention, archivedAt: _archivedAt, archivedBy: _archivedBy, ...rest } = summary;
  return { ...rest, childIds: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * 摘要是不是读得懂的：冷会话的摘要会直接交给网页与 MCP，缺一块就会让它们在某个角落出错，
 * 所以把使用者会读的几个结构（来源、消息计数、进度、活动……）逐个确认存在。检查的是结构，不是取值是否合理。
 */
function isSummary(value: unknown, sessionId: SessionId, lastSeq: number): value is SessionSummary {
  if (!isRecord(value)) return false;
  const status = value["status"];
  const phase = value["phase"];
  const origin = value["origin"];
  const messages = value["messages"];
  const counters = value["counters"];
  const progress = value["progress"];
  const activity = value["activity"];
  const parent = value["parentSessionId"];
  const parents = value["parentSessionIds"];
  return value["id"] === sessionId
    && value["seq"] === lastSeq
    && isString(value["title"])
    && isString(value["harness"])
    && isString(value["cwd"])
    && isString(value["taskPreview"])
    && isString(value["createdAt"])
    && isString(value["updatedAt"])
    && isString(status) && Object.hasOwn(STATUSES, status)
    && isString(phase) && Object.hasOwn(PHASES, phase)
    && (parent === undefined || isString(parent))
    // 汇聚的上级集合：没有（单上级）或是一组会话 id；别的形状说明这份快照不可信，退回完整重放。
    // 汇聚会话的快照里缺了它，这里是看不出来的（缺它和单上级长得一样），靠版本号挡掉旧服务写的那一份，见 SNAPSHOT_FORMAT。
    && (parents === undefined || (Array.isArray(parents) && parents.every(isString)))
    && isNumber(value["depth"])
    && isNumber(value["runCount"])
    && Array.isArray(value["childIds"])
    && isRecord(value["capabilities"])
    && isRecord(origin) && isString(origin["key"]) && isString(origin["kind"])
    && isRecord(messages) && isNumber(messages["total"]) && isNumber(messages["pending"])
    && isRecord(counters) && isNumber(counters["tools"]) && isNumber(counters["failedTools"]) && isNumber(counters["files"]) && isNumber(counters["interventions"])
    && isRecord(progress) && isNumber(progress["done"]) && isNumber(progress["steps"])
    && isRecord(activity) && isString(activity["kind"]) && isString(activity["since"]);
}
