import { sameAttention } from "@shared/attention";
import { LIMITS } from "@shared/constants";
import { isDeltaEvent, type EnsembleEvent, type EventDraft } from "@shared/events";
import { isoNow } from "@shared/format";
import { newId } from "@shared/ids";
import { parentIdsOf } from "@shared/lineage";
import { mapPool } from "@shared/map-pool";
import { applyEvent, createState, replay, toSummary, type SessionState } from "@shared/projection";
import type { AttentionItem, SessionId, SessionSummary } from "@shared/types";
import { parseArchiveMark, type ArchiveMark } from "./archive-mark";
import { EventCache } from "./event-cache";
import type { HistoryMode } from "./history-mode";
import { persistArchive, persistMark, type ArchiveChange } from "./hub-archive";
import { HubDispatcher } from "./hub-dispatch";
import { sameStream, sliceEvents } from "./hub-events";
import { readTrustedSnapshots, writeSnapshot } from "./hub-snapshots";
import {
  STARTUP_READ_LIMIT,
  type ArchivedFilter,
  type DeltaDraft,
  type HubChange,
  type HubListener,
  type HubNode,
  type HubOptions,
  type IndexFields,
  type ReadEventsOptions,
  type Staged,
} from "./hub-types";
import type { Logger } from "./logger";
import { applyNoticeEvent, NEVER_TOUCHED, undeliveredNotices, type HotSession } from "./session-residency";
import { isStableState, type SessionSnapshot } from "./snapshot";
import type { EventStore } from "./store";

export type { ArchivedFilter, HubChange, HubListener, HubNode, HubOptions, ReadEventsOptions } from "./hub-types";

/**
 * 事件中枢：唯一允许写入会话事件的地方。
 * 职责：分配 id / 序号 / 时间 → 合并流式增量 → 持久化 → 投影到内存状态 → 通知订阅者。
 * 序号在提交时分配，因此任何订阅者看到的都是严格有序、无空洞的事件流。
 *
 * 冷热分离（lazy 模式，默认）：历史会话不再全部常驻内存。
 * - 热会话：一条 `HotSession` 记录（完整的 `SessionState`、事件列表、最近取用时刻、未送达通知、值得留意事项，见 session-residency.ts）
 *   在内存里（进行中的、保温期内的、被取用过的、有运行时连着的、有未送达通知的）；
 * - 冷会话：只有一份启动时从 summary.json 读来的摘要快照，事件日志留在磁盘上，用到时再读（`readEvents`）或解冻（`ensureHot`）；
 * - 热表与冷表是两张表，一个会话任何时刻只在其中一张里；冻结、解冻、删除都按整条记录换，两张表各自保持登记次序；
 * - 后台清扫把过了保温期的稳定会话写好快照后冻结；`ENSEMBLE_HISTORY_MODE=eager` 回到老办法（启动时全部重放、从不冻结）。
 * 冷会话与热会话对外的摘要是同一份内容（只有 attention 仅热会话才有）。写事件的路径必须先 `await ensureHot`；
 * 万一漏了，`emit` 会先把会话解冻再记录这条事件（安全网，会打一条警告），而不是把事件丢掉。
 *
 * 归档标记（archive.json）与事件日志无关：归档不产生事件、不占序号、不改 updatedAt，也不需要解冻会话；见 archive-mark.ts。
 *
 * 本文件只留 EventHub 本身：它拥有按会话 id 索引的各张表与标志，方法之间互相交织地读写它们，所以没有再往下拆。
 * 不持有这些表的部分在同目录的辅助文件里：类型与常量 hub-types.ts；订阅与派发（含重入规则）hub-dispatch.ts；
 * 归档标记的落盘与失败回滚 hub-archive.ts（persistArchive 经 ArchiveHost 拿到归档标记表，只在落盘失败时回滚它）；
 * 快照的写与启动时的读 hub-snapshots.ts；事件区间切片与增量同流判断 hub-events.ts。
 */
export class EventHub {
  /** 热会话：每个会话一条整记录。解冻的会话排到表尾；`sessionIds()` / `hotIds()` 的次序就是这张表的插入次序。 */
  private readonly hot = new Map<SessionId, HotSession>();
  /** 冷会话：只有快照。与 hot 互斥——一个会话任何时刻要么热、要么冷。冻结的会话排到表尾。 */
  private readonly cold = new Map<SessionId, SessionSnapshot>();
  private readonly children = new Map<SessionId, Set<SessionId>>();
  private readonly staged = new Map<SessionId, Staged>();
  /**
   * `children` 是子会话 id 的有序拼接：缓存要认“内容”，两个上级互换子会话时数量不变、内容变了。
   * archive 按引用判断：归档与取消归档都会换一个标记对象。
   */
  private readonly summaries = new Map<
    SessionId,
    { seq: number; children: string; attention: AttentionItem[] | undefined; archive: ArchiveMark | undefined; summary: SessionSummary }
  >();
  /** 归档标记：与会话目录里的 archive.json 一致（先改内存、再落盘，见 setArchived）。热、冷会话都有。 */
  private readonly archive = new Map<SessionId, ArchiveMark>();
  /** 正在解冻 / 冷读 / 冻结的任务：并发的请求合并成一次，删除会话时要等它们收尾。 */
  private readonly thawing = new Map<SessionId, Promise<SessionState | undefined>>();
  private readonly coldReads = new Map<string, Promise<EnsembleEvent[] | undefined>>();
  private readonly freezing = new Map<SessionId, Promise<boolean>>();
  /** 写给冷会话、等它解冻后补记的事件（安全网）；解冻完成时按原来的先后次序提交。 */
  private readonly deferred = new Map<SessionId, EventDraft[]>();
  private readonly freezeGuards = new Set<(sessionId: SessionId) => boolean>();
  private readonly eventCache: EventCache;
  /** 订阅与派发：监听器表、派发队列、派发中标志与批深度都在它里面（重入规则见 hub-dispatch.ts）。 */
  private readonly dispatcher: HubDispatcher;
  private sweepTimer: NodeJS.Timeout | undefined;
  private sweeping: Promise<number> | undefined;
  private readonly store: EventStore;
  private readonly log: Logger;
  private readonly coalesceMs: number;
  private readonly warmMs: number;
  private readonly sweepMs: number;
  private readonly now: () => number;
  /** 实际生效的载入方式：请求 lazy 但存储不支持快照时是 eager。 */
  private readonly effectiveMode: HistoryMode;

  constructor(options: HubOptions) {
    this.store = options.store;
    this.log = options.log;
    this.coalesceMs = options.coalesceMs ?? LIMITS.deltaCoalesceMs;
    this.warmMs = options.warmMs ?? LIMITS.history.warmMs;
    this.sweepMs = options.sweepMs ?? LIMITS.history.sweepMs;
    this.now = options.now ?? Date.now;
    this.effectiveMode = (options.mode ?? "lazy") === "lazy" && options.store.supportsSnapshots ? "lazy" : "eager";
    this.eventCache = new EventCache(options.eventCache?.entries ?? LIMITS.history.eventCacheEntries, options.eventCache?.bytes ?? LIMITS.history.eventCacheBytes);
    this.dispatcher = new HubDispatcher(this.log);
  }

  /** 实际生效的历史载入方式。 */
  get mode(): HistoryMode {
    return this.effectiveMode;
  }

  private get lazy(): boolean {
    return this.effectiveMode === "lazy";
  }

  // ───────────────────────── 启动载入 ─────────────────────────

  /**
   * 启动时载入全部会话，返回成功载入的会话 id。
   * - eager：逐个重放日志，全部进内存（老办法）；
   * - lazy：先并行读各会话的快照并校验，可信的直接登记为冷会话（不读 events.jsonl）；其余的——快照缺失、损坏、版本不符、
   *   与日志大小对不上、还在保温期、有未送达通知、不稳定——退回完整重放。重放过的会话如果已经可以冷存，就地写好快照再放掉，
   *   一个会话一个会话地处理：升级后的第一次启动不会把整个历史同时堆进内存。快照绝不会导致记录丢失或被改写。
   * 最后读各会话的归档标记。
   */
  async load(): Promise<SessionId[]> {
    const loaded: SessionId[] = [];
    const ids = await this.store.listSessionIds();
    const trusted = this.lazy ? await readTrustedSnapshots(this.store, this.log, (iso) => this.isOld(iso), ids) : new Map<SessionId, SessionSnapshot>();
    for (const sessionId of ids) {
      try {
        const snapshot = trusted.get(sessionId);
        if (snapshot) {
          this.registerCold(sessionId, snapshot);
          loaded.push(sessionId);
        } else if (await this.loadByReplay(sessionId)) {
          loaded.push(sessionId);
        }
      } catch (error) {
        this.log.error("failed to load session", { sessionId, error });
      }
    }
    await this.readArchiveMarks(loaded);
    return loaded;
  }

  /** 重放一个会话的完整日志；已经可以冷存的（lazy 模式）顺手写好快照、登记为冷会话，否则登记为热会话。 */
  private async loadByReplay(sessionId: SessionId): Promise<boolean> {
    const events = await this.store.load(sessionId);
    const state = replay(events);
    if (!state) {
      this.log.warn("session log has no session.created, skipped", { sessionId });
      return false;
    }
    const undelivered = undeliveredNotices(events);
    if (this.lazy && undelivered.size === 0 && isStableState(state) && this.isOld(state.updatedAt)) {
      const snapshot = await writeSnapshot(this.store, this.log, sessionId, state);
      if (snapshot) {
        this.registerCold(sessionId, snapshot);
        return true;
      }
    }
    this.register(sessionId, { state, events, undelivered, touchedAt: NEVER_TOUCHED });
    return true;
  }

  /** 读各会话的归档标记（有界并行）。读不了或读不懂的按“没有归档”处理。 */
  private async readArchiveMarks(ids: readonly SessionId[]): Promise<void> {
    await mapPool(ids, STARTUP_READ_LIMIT, async (sessionId) => {
      try {
        const mark = parseArchiveMark(await this.store.readArchive(sessionId));
        if (mark) this.archive.set(sessionId, mark);
      } catch (error) {
        this.log.warn("session archive mark unreadable, treating it as not archived", { sessionId, error });
      }
    });
  }

  /** 登记一个热会话（整条记录），并把它记进各个上级的子会话表。 */
  private register(sessionId: SessionId, session: HotSession): void {
    this.hot.set(sessionId, session);
    for (const parent of parentIdsOf(session.state.meta)) this.addChild(parent, sessionId);
  }

  private registerCold(sessionId: SessionId, snapshot: SessionSnapshot): void {
    this.cold.set(sessionId, snapshot);
    for (const parent of parentIdsOf(snapshot.summary)) this.addChild(parent, sessionId);
  }

  private addChild(parent: SessionId | undefined, sessionId: SessionId): void {
    if (!parent) return;
    const set = this.children.get(parent) ?? new Set<SessionId>();
    set.add(sessionId);
    this.children.set(parent, set);
  }

  /** 时间读不懂（NaN）时一律当作“还不够旧”：宁可多留在内存里，也不把来历不明的会话冻起来。 */
  private isOld(iso: string): boolean {
    const time = Date.parse(iso);
    return Number.isFinite(time) && this.now() - time >= this.warmMs;
  }

  subscribe(listener: HubListener): () => void {
    return this.dispatcher.subscribe(listener);
  }

  /** 同一个同步转换的事件先全部写入投影，再让 wait 和 SSE 观察。 */
  batch<T>(commit: () => T): T {
    return this.dispatcher.batch(commit);
  }

  // ───────────────────────── 查询 ─────────────────────────

  /** 会话是否存在（热的或冷的）。 */
  has(sessionId: SessionId): boolean {
    return this.hot.has(sessionId) || this.cold.has(sessionId);
  }

  /** 会话是否在内存里（热）。冷会话要完整状态时先 `await ensureHot(id)`。 */
  isHot(sessionId: SessionId): boolean {
    return this.hot.has(sessionId);
  }

  /** 全部已知会话（热的在前、冷的在后；各自保持登记次序：解冻的排到热表末尾，冻结的排到冷表末尾）。 */
  sessionIds(): SessionId[] {
    return [...this.hot.keys(), ...this.cold.keys()];
  }

  /** 内存里的会话：监督者、通知重建这类“只关心进行中会话”的使用者只看它们，不会因此去读冷会话。 */
  hotIds(): SessionId[] {
    return [...this.hot.keys()];
  }

  /** 会话数量：全部已知的（含冷、含归档）、热的、已归档的。 */
  counts(): { total: number; hot: number; archived: number } {
    return { total: this.hot.size + this.cold.size, hot: this.hot.size, archived: this.archive.size };
  }

  /** 热会话的完整状态；冷会话返回 undefined（先 `await ensureHot(id)`）。 */
  state(sessionId: SessionId): SessionState | undefined {
    return this.hot.get(sessionId)?.state;
  }

  /** 索引层面的会话来源：热会话取 `state.meta`，冷会话取快照里的 `summary`；两者都没有就是不存在。 */
  private indexFieldsOf(sessionId: SessionId): IndexFields | undefined {
    return this.hot.get(sessionId)?.state.meta ?? this.cold.get(sessionId)?.summary;
  }

  /** 索引层面的会话信息；热、冷都能读，不会解冻。 */
  node(sessionId: SessionId): HubNode | undefined {
    const source = this.indexFieldsOf(sessionId);
    if (!source) return undefined;
    const { parentSessionId, parentSessionIds } = source;
    return {
      id: sessionId,
      depth: source.depth,
      createdAt: source.createdAt,
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(parentSessionIds && parentSessionIds.length > 1 ? { parentSessionIds: [...parentSessionIds] } : {}),
    };
  }

  private createdAtOf(sessionId: SessionId): string {
    return this.indexFieldsOf(sessionId)?.createdAt ?? "";
  }

  /** 按创建时间排序：事后改挂过的会话不会因为“最后加入”排到最后，实时与重启后重放的次序一致。 */
  childIds(sessionId: SessionId): SessionId[] {
    return [...(this.children.get(sessionId) ?? [])].sort((a, b) => this.createdAtOf(a).localeCompare(this.createdAtOf(b)) || a.localeCompare(b));
  }

  /**
   * 会话摘要。热会话实时算（带 attention）；冷会话取快照里的摘要，补上实时的子会话表。
   * 两者都合并归档标记；内容与热会话冻结前一致（attention 除外：冷会话不会有）。
   */
  summary(sessionId: SessionId): SessionSummary | undefined {
    // 热与冷互斥：有热记录就以它的状态为准。
    const session = this.hot.get(sessionId);
    const snapshot = session ? undefined : this.cold.get(sessionId);
    const seq = session?.state.seq ?? snapshot?.lastSeq;
    if (seq === undefined) return undefined;
    const childIds = this.childIds(sessionId);
    const children = childIds.join(",");
    const attention = session?.attention;
    const archive = this.archive.get(sessionId);
    const cached = this.summaries.get(sessionId);
    if (cached && cached.seq === seq && cached.children === children && cached.attention === attention && cached.archive === archive) return cached.summary;
    // 流式增量可能暂存在窗口里，摘要以已提交状态为准。
    const base = session ? toSummary(session.state, childIds) : snapshot ? { ...snapshot.summary, childIds } : undefined;
    if (!base) return undefined;
    const summary: SessionSummary = {
      ...base,
      ...(attention ? { attention } : {}),
      ...(archive ? { archivedAt: archive.archivedAt, archivedBy: archive.by } : {}),
    };
    this.summaries.set(sessionId, { seq, children, attention, archive, summary });
    return summary;
  }

  /** 当前登记的“值得留意”事项（没有则为空数组）。 */
  attentionOf(sessionId: SessionId): readonly AttentionItem[] {
    return this.hot.get(sessionId)?.attention ?? [];
  }

  /**
   * 整组替换某个会话的“值得留意”事项；内容没有变化时什么也不做。
   * 变化会像事件一样通知订阅者（SSE 据此推送新摘要，wait 据此重新判断）。
   * 只有热会话有：冷会话是稳定、已结束的，没有值得留意的事。
   */
  setAttention(sessionId: SessionId, items: readonly AttentionItem[]): void {
    const session = this.hot.get(sessionId);
    if (!session || sameAttention(session.attention, items)) return;
    session.attention = items.length === 0 ? undefined : [...items];
    this.notify({ type: "attention", sessionId });
  }

  /** 全部会话的摘要（按创建时间排序）；archived 决定怎样对待已归档的会话，缺省全部返回。 */
  allSummaries(archived: ArchivedFilter = "include"): SessionSummary[] {
    const result: SessionSummary[] = [];
    for (const id of this.sessionIds()) {
      const marked = this.archive.has(id);
      if ((archived === "exclude" && marked) || (archived === "only" && !marked)) continue;
      const summary = this.summary(id);
      if (summary) result.push(summary);
    }
    return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * 读取热会话已提交的事件；staged 的增量先提交，保证读到的是最新内容。
   * 同步接口只服务热会话：冷会话的事件在磁盘上，用 `readEvents`（会按需读取）。
   */
  events(sessionId: SessionId, options: ReadEventsOptions = {}): EnsembleEvent[] {
    if (!this.hot.has(sessionId) && this.cold.has(sessionId)) {
      throw new Error(`Session ${sessionId} is not in memory; read its events with readEvents().`);
    }
    this.flushStaged(sessionId);
    return sliceEvents(this.hot.get(sessionId)?.events ?? [], options);
  }

  /**
   * 读取一个会话的事件（热或冷）：热会话来自内存，冷会话读磁盘上的日志（经 LRU 缓存、并发读合并）。
   * 不解冻会话，也不改动磁盘。会话不存在时返回空数组。读的过程中会话被解冻（又有了新事件）时，以内存里的为准。
   */
  async readEvents(sessionId: SessionId, options: ReadEventsOptions = {}): Promise<EnsembleEvent[]> {
    if (this.hot.has(sessionId)) return this.events(sessionId, options);
    const snapshot = this.cold.get(sessionId);
    if (!snapshot) return [];
    const all = await this.coldEvents(sessionId, snapshot);
    if (this.hot.has(sessionId)) return this.events(sessionId, options);
    return all ? sliceEvents(all, options) : [];
  }

  private coldEvents(sessionId: SessionId, snapshot: SessionSnapshot): Promise<EnsembleEvent[] | undefined> {
    const cached = this.eventCache.get(sessionId, snapshot.logBytes);
    if (cached) return Promise.resolve(cached);
    // 同一份日志的并发读合并成一次磁盘读；钥匙带上日志大小，会话解冻又冻结后（日志变了）不会拿到旧的读。
    const key = `${sessionId}@${snapshot.logBytes}`;
    const inflight = this.coldReads.get(key);
    if (inflight) return inflight;
    const read = (async (): Promise<EnsembleEvent[] | undefined> => {
      const log = await this.store.readLog(sessionId);
      if (!log) return undefined;
      // 磁盘上的日志与快照记录的大小对不上（有人在我们背后改过）：照读照用，但不缓存。
      if (log.bytes === snapshot.logBytes && this.cold.get(sessionId) === snapshot) this.eventCache.set(sessionId, snapshot.logBytes, log.bytes, log.events);
      return log.events;
    })().finally(() => this.coldReads.delete(key));
    this.coldReads.set(key, read);
    return read;
  }

  // ───────────────────────── 冷热切换 ─────────────────────────

  /**
   * 保证会话在内存里（必要时解冻），返回它的完整状态；会话不存在返回 undefined。
   * 需要完整状态的使用者（补充消息、停止、取消、改挂、恢复……）在读 `state()` 之前先 await 它。
   * 并发的解冻合并成同一个 Promise；对热会话它顺便刷新保温期，让刚被取用的会话不会马上被冻结。
   * 注意：“检查会话是否已载入”与“登记”之间不要有 await（见 manager.delegate 里关于防重复的注释）。
   */
  ensureHot(sessionId: SessionId): Promise<SessionState | undefined> {
    const session = this.hot.get(sessionId);
    if (session) {
      session.touchedAt = this.now();
      return Promise.resolve(session.state);
    }
    const pending = this.thawing.get(sessionId);
    if (pending) return pending;
    const snapshot = this.cold.get(sessionId);
    if (!snapshot) return Promise.resolve(undefined);
    const task = this.thaw(sessionId, snapshot).finally(() => this.thawing.delete(sessionId));
    this.thawing.set(sessionId, task);
    return task;
  }

  /** 完整重放这个会话的日志并换成热会话。读的期间会话被删除则返回 undefined；日志读不出来则抛出（会话仍是冷的）。 */
  private async thaw(sessionId: SessionId, snapshot: SessionSnapshot): Promise<SessionState | undefined> {
    const events = await this.store.load(sessionId);
    if (this.cold.get(sessionId) !== snapshot) return undefined;
    const state = replay(events);
    if (!state) throw new Error(`The saved history of session ${sessionId} could not be read.`);
    if (state.seq !== snapshot.lastSeq) {
      this.log.warn("session log changed since its snapshot was written", { sessionId, snapshotSeq: snapshot.lastSeq, logSeq: state.seq });
    }
    // 同步完成：整条记录换进热表、从冷表拿掉，中间没有任何 await。子会话表不用动：冷会话登记时就已经在里面了。
    this.cold.delete(sessionId);
    this.hot.set(sessionId, { state, events, undelivered: undeliveredNotices(events), touchedAt: this.now() });
    this.eventCache.delete(sessionId);
    // 冷期间有人写过这个会话（安全网）：先于任何等待它的使用者，按原来的次序补记。
    const drafts = this.deferred.get(sessionId);
    if (drafts) {
      this.deferred.delete(sessionId);
      this.batch(() => {
        for (const draft of drafts) this.emit(sessionId, draft);
      });
    }
    return state;
  }

  /** 登记一个“不许冻结”的否决者：返回 false 就不冻结这个会话（管理器用它声明还有运行时连着）。返回注销函数。 */
  addFreezeGuard(guard: (sessionId: SessionId) => boolean): () => void {
    this.freezeGuards.add(guard);
    return () => {
      this.freezeGuards.delete(guard);
    };
  }

  /**
   * 现在能不能冻结：在内存里、稳定（没有进行中 / 排队的运行、没有待确认的消息）、没有未送达的通知、没有暂存的增量、
   * 最后一次活动与最近一次被取用都已超过保温期、没有任何否决者反对。
   */
  private canFreeze(sessionId: SessionId): boolean {
    const session = this.hot.get(sessionId);
    if (!session || this.staged.has(sessionId) || this.thawing.has(sessionId)) return false;
    if (session.undelivered.size > 0) return false;
    if (!isStableState(session.state) || !this.isOld(session.state.updatedAt)) return false;
    if (this.now() - session.touchedAt < this.warmMs) return false;
    for (const guard of this.freezeGuards) {
      if (!guard(sessionId)) return false;
    }
    return true;
  }

  /**
   * 冻结一个会话：写快照，再把它从内存里放掉、登记为冷会话。写快照要 await，所以放掉之前把条件整个重新核对一遍
   * （还是同一条热记录——它与状态同生同灭，记录没换就是状态没换——序号没变、仍然允许冻结）；
   * 任何一项变了就放弃这一轮——快照里记的日志大小对不上，下次启动不会被采信。重新核对到放掉之间没有 await。
   */
  private async freeze(sessionId: SessionId): Promise<boolean> {
    const session = this.hot.get(sessionId);
    if (!session || !this.canFreeze(sessionId)) return false;
    const seq = session.state.seq;
    const snapshot = await writeSnapshot(this.store, this.log, sessionId, session.state);
    if (!snapshot || this.hot.get(sessionId) !== session || session.state.seq !== seq || !this.canFreeze(sessionId)) return false;
    this.hot.delete(sessionId);
    this.cold.set(sessionId, snapshot);
    return true;
  }

  /** 把已经过了保温期的稳定会话冻结，返回本轮冻结了几个。同一时刻只有一轮在跑，重叠的调用共用它的结果。eager 模式什么也不做。 */
  sweep(): Promise<number> {
    if (!this.lazy) return Promise.resolve(0);
    if (this.sweeping) return this.sweeping;
    const task = this.sweepOnce().finally(() => {
      this.sweeping = undefined;
    });
    this.sweeping = task;
    return task;
  }

  private async sweepOnce(): Promise<number> {
    let frozen = 0;
    for (const sessionId of [...this.hot.keys()]) {
      if (!this.canFreeze(sessionId)) continue;
      const task = this.freeze(sessionId).catch((error: unknown) => {
        this.log.warn("could not freeze a session", { sessionId, error });
        return false;
      });
      this.freezing.set(sessionId, task);
      try {
        if (await task) frozen += 1;
      } finally {
        if (this.freezing.get(sessionId) === task) this.freezing.delete(sessionId);
      }
    }
    if (frozen > 0) this.log.info("froze idle sessions", { frozen, hot: this.hot.size, cold: this.cold.size });
    return frozen;
  }

  /** 启动后台清扫（定时器不阻止进程退出）。eager 模式不启动。 */
  startSweeper(): void {
    if (this.sweepTimer || !this.lazy) return;
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch((error: unknown) => this.log.error("history sweep failed", { error }));
    }, this.sweepMs);
    this.sweepTimer.unref?.();
  }

  /** 停止后台清扫，并等正在进行的一轮收尾（关闭服务前调用，免得退出时留下写到一半的快照）。 */
  async stopSweeper(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    await this.sweeping?.catch(() => undefined);
  }

  // ───────────────────────── 写入 ─────────────────────────

  /**
   * 写入一条事件。流式增量会在合并窗口内拼接，其余事件会先冲刷暂存的增量再提交，
   * 以保持顺序。返回已提交的事件；被合并（暂存）的增量返回 undefined。
   * 写给冷会话的事件不会被提交也不会被丢弃：先解冻再补记（安全网，同样返回 undefined）。
   */
  emit(sessionId: SessionId, draft: EventDraft): EnsembleEvent | undefined {
    if (!this.hot.has(sessionId) && this.cold.has(sessionId)) {
      if (draft.kind === "session.created") {
        this.log.warn("duplicate session.created ignored", { sessionId });
        return undefined;
      }
      this.defer(sessionId, draft);
      return undefined;
    }
    if (isDeltaEvent(draft)) {
      this.stageDelta(sessionId, draft as DeltaDraft);
      return undefined;
    }
    this.flushStaged(sessionId);
    return this.commit(sessionId, draft);
  }

  /**
   * 安全网：有人在没有先 ensureHot 的情况下写了冷会话。事件先排队，会话解冻时（thaw 里）按原来的次序补记；
   * 补记用原来的时刻。正常路径不该走到这里，所以每次开始排队都记一条警告。
   */
  private defer(sessionId: SessionId, draft: EventDraft): void {
    const stamped: EventDraft = { ...draft, at: draft.at ?? isoNow() };
    const queue = this.deferred.get(sessionId);
    if (queue) {
      queue.push(stamped);
      return;
    }
    this.deferred.set(sessionId, [stamped]);
    this.log.warn("event written to a session that is not in memory; thawing it first", { sessionId, kind: draft.kind });
    void this.ensureHot(sessionId).then(
      (state) => {
        // 解冻成功时 thaw 已经补记了；走到这里还有排队的，说明会话在读的期间被删除了。
        const dropped = this.deferred.get(sessionId);
        if (state || !dropped) return;
        this.deferred.delete(sessionId);
        this.log.error("dropping events for a session that no longer exists", { sessionId, count: dropped.length });
      },
      (error: unknown) => {
        const dropped = this.deferred.get(sessionId);
        this.deferred.delete(sessionId);
        this.log.error("could not thaw a session to record events; they were dropped", { sessionId, count: dropped?.length ?? 0, error });
      },
    );
  }

  private stageDelta(sessionId: SessionId, draft: DeltaDraft): void {
    const stamped: DeltaDraft = { ...draft, at: draft.at ?? isoNow() };
    const current = this.staged.get(sessionId);
    if (current && sameStream(current.draft, stamped)) {
      current.draft = {
        ...current.draft,
        data: { ...current.draft.data, text: current.draft.data.text + stamped.data.text },
      } as DeltaDraft;
      return;
    }
    if (current) this.flushStaged(sessionId);
    const timer = setTimeout(() => this.flushStaged(sessionId), this.coalesceMs);
    timer.unref?.();
    this.staged.set(sessionId, { draft: stamped, timer });
  }

  flushStaged(sessionId: SessionId): void {
    const staged = this.staged.get(sessionId);
    if (!staged) return;
    clearTimeout(staged.timer);
    this.staged.delete(sessionId);
    this.commit(sessionId, staged.draft);
  }

  /**
   * 提交一条事件：分配 id 与序号，写进热记录。顺序固定，全部同步：
   * 1. 内存先提交：事件追加进热记录的事件列表 → 投影到状态 → 更新未送达通知 → 更新子会话表（改挂时）；
   * 2. 再交给存储：`store.append` 只是把这一行放进存储的写缓冲（稍后合并落盘），这里不等落盘，落盘失败也不会在这里出现；
   * 3. 最后通知订阅者：它们读到的内存状态已经包含这条事件，子会话表也已就位。
   * 所以内存里的状态不会落后于已交给存储的事件；反过来，磁盘上的日志可能落后于内存（还在缓冲里，或写失败过）。
   * 要知道磁盘有没有追上内存，用 `store.seal`（见 hub-snapshots.ts 的 writeSnapshot），不要以为这里写过就等于落盘了。
   */
  private commit(sessionId: SessionId, draft: EventDraft): EnsembleEvent | undefined {
    const existing = this.hot.get(sessionId);
    const event: EnsembleEvent = {
      ...draft,
      id: newId("evt"),
      sessionId,
      seq: (existing?.state.seq ?? 0) + 1,
      at: draft.at ?? isoNow(),
    };

    let session: HotSession;
    let reparented: SessionId[] = [];
    if (event.kind === "session.created") {
      if (existing) {
        this.log.warn("duplicate session.created ignored", { sessionId });
        return undefined;
      }
      session = { state: createState(event), events: [event], undelivered: new Set(), touchedAt: NEVER_TOUCHED };
      this.register(sessionId, session);
    } else {
      if (!existing) {
        this.log.warn("dropping event for unknown session", { sessionId, kind: event.kind });
        return undefined;
      }
      session = existing;
      session.events.push(event);
      const parentsBefore = parentIdsOf(session.state.meta);
      applyEvent(session.state, event);
      applyNoticeEvent(session.undelivered, event);
      // 子会话表要在通知订阅者之前就位：订阅者收到事件后会立刻读上级的摘要。
      if (event.kind === "session.relinked") reparented = this.moveChild(sessionId, parentsBefore, parentIdsOf(session.state.meta));
    }
    // 任何写入都刷新保温期：保温期从“最近一次动静”起算，不只看 updatedAt（改挂这类事件不动 updatedAt）。
    // 新建的会话也是在这里第一次记下取用时刻。
    session.touchedAt = this.now();

    this.store.append(event);
    this.notify({ type: "event", event, state: session.state });
    if (event.kind === "session.created") {
      // 汇聚的会话有几个上级就通知几个：每个上级的摘要里都多了一个子会话。
      for (const parent of parentIdsOf(session.state.meta)) this.notify({ type: "relationship", sessionId: parent });
    }
    // 旧上级少了一个子会话、新上级多了一个：两边的摘要（childIds）都要重新推送。
    for (const parent of reparented) this.notify({ type: "relationship", sessionId: parent });
    return event;
  }

  /**
   * 把子会话在上级登记里的位置从旧的上级集合换成新的；返回子会话表真正变了的上级：先是不再有它的，再是新多了它的（没变就是空）。
   * 单上级时就是“旧上级、新上级”两个（或其中一个），与原来一样；汇聚时仍留在集合里的上级没有变化，不会被通知。
   */
  private moveChild(sessionId: SessionId, from: readonly SessionId[], to: readonly SessionId[]): SessionId[] {
    const after = new Set(to);
    const before = new Set(from);
    const removed = [...before].filter((id) => !after.has(id));
    const added = [...after].filter((id) => !before.has(id));
    for (const parent of removed) this.children.get(parent)?.delete(sessionId);
    for (const parent of added) this.addChild(parent, sessionId);
    return [...removed, ...added];
  }

  private notify(change: HubChange): void {
    this.dispatcher.notify(change);
  }

  // ───────────────────────── 归档 ─────────────────────────

  /** 会话的归档标记（没有归档就是 undefined）。 */
  archiveOf(sessionId: SessionId): ArchiveMark | undefined {
    return this.archive.get(sessionId);
  }

  /**
   * 登记归档（mark 给出标记）或取消归档（mark 为 null），对 ids 里存在的会话生效；不检查规则——规则由调用方
   * （server/archive.ts）先算好。先改内存并立刻通知订阅者（SSE 推一条新摘要），再把标记落盘（archive.json）：
   * 这样“按规则判断 → 登记”之间没有 await，判断时的世界与登记时一致；落盘失败的会话回滚内存里的标记并让这次调用抛出。
   * 归档不产生事件、不占序号、不改 updatedAt，对冷会话也不需要解冻。
   *
   * 落盘是在改内存的同一个同步段里就发起的（每个会话一次，不等前一个写完），之后才统一等结果：存储里同一个文件的写 / 删
   * 按“被调用的先后”排队，所以只有调用的先后等于内存里改动的先后，两次重叠的调用（一批归档还在写盘，又有人取消了其中一个会话）
   * 在磁盘上的结果才与内存一致，重启后不会与网页相反。若等前一个会话写完才发起下一个，期间的另一次操作就会插到它前面去。
   *
   * ids 必须互不相同，这里不去重：现有调用方（server/archive.ts 按 plan.changed 传入）在规划阶段已经去重（shared/archive.ts 的 planArchive、planUnarchive）。
   * 登记（mark 非空）时若同一个会话出现两次，第二次读到的 before 是第一次刚写进内存的标记；两次落盘都失败的话，persistArchive 的回滚
   * 只会退回到那个标记，而不是最初的状态，内存与磁盘就对不上。
   */
  setArchived(ids: readonly SessionId[], mark: ArchiveMark | null): Promise<void> {
    const applied: ArchiveChange[] = [];
    this.batch(() => {
      for (const sessionId of ids) {
        if (!this.has(sessionId)) continue;
        const before = this.archive.get(sessionId);
        // 每个会话一份：摘要缓存与回滚都按引用判断。
        const after = mark ? { ...mark } : undefined;
        if (!after && !before) continue;
        if (after) this.archive.set(sessionId, after);
        else this.archive.delete(sessionId);
        applied.push({ sessionId, before, after, persisted: persistMark(this.store, sessionId, after) });
        this.notify({ type: "archive", sessionId });
      }
    });
    return persistArchive(applied, {
      log: this.log,
      archive: this.archive,
      has: (sessionId) => this.has(sessionId),
      notify: (change) => this.notify(change),
    });
  }

  // ───────────────────────── 删除与收尾 ─────────────────────────

  async remove(sessionId: SessionId): Promise<void> {
    const staged = this.staged.get(sessionId);
    if (staged) clearTimeout(staged.timer);
    this.staged.delete(sessionId);
    const parents = parentIdsOf(this.indexFieldsOf(sessionId));
    for (const parent of parents) this.children.get(parent)?.delete(sessionId);
    // 它自己的子会话登记也一并去掉，别留一张指向已不存在会话的表。
    this.children.delete(sessionId);
    // 热记录整条放掉：状态、事件列表、取用时刻、未送达通知、值得留意事项一起走。
    this.hot.delete(sessionId);
    this.cold.delete(sessionId);
    this.summaries.delete(sessionId);
    this.archive.delete(sessionId);
    this.deferred.delete(sessionId);
    this.eventCache.delete(sessionId);
    // 正在进行的冻结、解冻、冷读各自在每个 await 之后核对会话还在不在；这里只等它们收尾，免得目录删到一半又被读写。
    const busy: (Promise<unknown> | undefined)[] = [this.freezing.get(sessionId), this.thawing.get(sessionId)];
    for (const [key, read] of this.coldReads) {
      if (key.startsWith(`${sessionId}@`)) busy.push(read);
    }
    await Promise.allSettled(busy);
    await this.store.remove(sessionId);
    this.notify({ type: "removed", sessionId });
    for (const parent of parents) this.notify({ type: "relationship", sessionId: parent });
  }

  /** 冲刷所有暂存增量并等待落盘（关闭服务前调用）。 */
  async flush(): Promise<void> {
    for (const sessionId of [...this.staged.keys()]) this.flushStaged(sessionId);
    await this.store.flush();
  }
}
