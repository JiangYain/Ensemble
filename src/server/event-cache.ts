import type { EnsembleEvent } from "@shared/events";
import type { SessionId } from "@shared/types";

interface Entry {
  events: EnsembleEvent[];
  /** 读的时候 events.jsonl 的字节数：缓存的钥匙之一，日志变了缓存就作废。 */
  logBytes: number;
  /** 记账用的占用（字节）：用文件大小近似，不去量解析后的对象。 */
  bytes: number;
}

/**
 * 冷会话事件日志的读取缓存（LRU）：缓存解析好的事件数组，省得翻几下同一个冷会话就读几次几十 MB 的文件。
 * 同时受两个上限约束——会话个数与合计字节数——任何一个超了都从最久没用的开始丢；
 * 单个日志就比字节上限还大时不缓存（读完即放）：为一个 200 MB 的日志长期占着内存不值得。
 *
 * 缓存的数组由调用方只读使用（hub.readEvents 返回的是切片副本）。
 */
export class EventCache {
  private readonly entries = new Map<SessionId, Entry>();
  private total = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
  ) {}

  /** 取缓存；logBytes 对不上（日志在缓存之后变过，例如解冻、续写、再冻结）就丢掉这一条并当作没命中。 */
  get(sessionId: SessionId, logBytes: number): EnsembleEvent[] | undefined {
    const entry = this.entries.get(sessionId);
    if (!entry) return undefined;
    if (entry.logBytes !== logBytes) {
      this.delete(sessionId);
      return undefined;
    }
    // Map 保持插入次序：删了再放，最近用过的就排到最后。
    this.entries.delete(sessionId);
    this.entries.set(sessionId, entry);
    return entry.events;
  }

  set(sessionId: SessionId, logBytes: number, bytes: number, events: EnsembleEvent[]): void {
    this.delete(sessionId);
    if (this.maxEntries <= 0 || bytes > this.maxBytes) return;
    this.entries.set(sessionId, { events, logBytes, bytes });
    this.total += bytes;
    while (this.entries.size > this.maxEntries || this.total > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
  }

  delete(sessionId: SessionId): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.entries.delete(sessionId);
    this.total -= entry.bytes;
  }

  get size(): number {
    return this.entries.size;
  }

  get bytes(): number {
    return this.total;
  }

  has(sessionId: SessionId): boolean {
    return this.entries.has(sessionId);
  }
}
