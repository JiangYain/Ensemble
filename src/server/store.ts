import { appendFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { EnsembleEvent } from "@shared/events";
import { isoNow } from "@shared/format";
import { newId } from "@shared/ids";
import { removeFileQuiet, writeFileAtomic } from "./atomic-file";
import type { ArchiveMark } from "./archive-mark";
import type { Logger } from "./logger";

/** 一次只读载入的结果：解析好的事件，以及读到的日志字节数（冷会话读取缓存的记账与校验用）。 */
export interface LogRead {
  events: EnsembleEvent[];
  bytes: number;
}

/**
 * 每个会话一个 JSONL 文件。读取时隔离损坏的行，并报告已经丢失的事件。
 * 写入先进入内存缓冲，按短间隔合并落盘，flush() 可等待全部落盘完成。
 *
 * 会话目录里除了 events.jsonl 还有两个旁路小文件，都是原子写入的，任何一个丢了都不损失会话记录：
 * - summary.json：摘要快照（见 snapshot.ts），让已结束的会话在启动时不必重放整份日志；
 * - archive.json：归档标记（见 archive-mark.ts）。
 * 下面“冷热分离”与“归档”两组方法就是这两个文件的读写；删除会话（remove）连同整个目录一起带走它们。
 */
export interface EventStore {
  /**
   * 这个存储能不能做冷热分离（快照 + 只读载入）。文件存储总是可以；内存存储默认不行——
   * 测试里“重启”一个内存存储上的中心、期望状态仍在内存里，所以只有显式打开才做冷热分离。
   */
  readonly supportsSnapshots: boolean;
  listSessionIds(): Promise<string[]>;
  load(sessionId: string): Promise<EnsembleEvent[]>;
  append(event: EnsembleEvent): void;
  flush(): Promise<void>;
  remove(sessionId: string): Promise<void>;

  /** 事件日志此刻的字节数（只 stat，不碰写缓冲，启动时校验快照用）；没有这份日志返回 undefined。 */
  logSize(sessionId: string): Promise<number | undefined>;
  /**
   * 先让这个会话缓冲里与在途的写入落盘，再返回日志的字节数——写快照前用，保证快照记下的大小确实包含内存里已有的全部事件。
   * 没有这份日志、或这个会话的写盘失败过（失败那一批事件已经离开写缓冲、不会重试：日志里缺了它们，内存里的状态却有，大小再对也证明不了对应）时
   * 返回 undefined：这时不该据此写快照。失败过就一直如此，之后的写入成功也不会改变（本进程内，删除会话时清掉）。
   */
  seal(sessionId: string): Promise<number | undefined>;
  /**
   * 只读地读完整事件日志，不做 load() 的读时修复（补结尾换行、补“日志不完整”的诊断）：
   * 冷会话在写快照之前就已经走过 load() 的修复，这里不应该再改动磁盘。没有这份日志返回 undefined。
   */
  readLog(sessionId: string): Promise<LogRead | undefined>;
  /** 读摘要快照的原始 JSON；没有或内容损坏返回 undefined（由调用方做结构校验）。其他读错误会抛出。 */
  readSnapshot(sessionId: string): Promise<unknown>;
  writeSnapshot(sessionId: string, snapshot: unknown): Promise<void>;

  /** 读归档标记的原始 JSON；没有或损坏返回 undefined。 */
  readArchive(sessionId: string): Promise<unknown>;
  writeArchive(sessionId: string, mark: ArchiveMark): Promise<void>;
  /** 取消归档：删除标记；本来就没有不算错。 */
  clearArchive(sessionId: string): Promise<void>;
}

const FLUSH_DELAY_MS = 25;

function parseEvent(line: string, sessionId: string, after: number): EnsembleEvent | undefined {
  try {
    const event = JSON.parse(line) as EnsembleEvent | null;
    return event?.sessionId === sessionId &&
      Number.isSafeInteger(event.seq) && event.seq > after &&
      typeof event.kind === "string" && typeof event.at === "string" &&
      event.data !== null && typeof event.data === "object" ? event : undefined;
  } catch {
    return undefined;
  }
}

interface ParsedLog {
  events: EnsembleEvent[];
  /** 读不懂（或序号倒退）而被隔离的行数。 */
  skipped: number;
  /** 序号上缺了多少条。 */
  missing: number;
  /** 读到的最后一个序号。 */
  last: number;
}

/** 把整份日志文本解析成事件；load() 与只读的 readLog() 共用，两者对“什么算有效事件”的判断必须一致。 */
function parseLog(raw: string, sessionId: string): ParsedLog {
  const events: EnsembleEvent[] = [];
  let skipped = 0;
  let previous = 0;
  let missing = 0;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    const event = parseEvent(line, sessionId, previous);
    if (!event) {
      skipped += 1;
      continue;
    }
    missing += event.seq - previous - 1;
    previous = event.seq;
    events.push(event);
  }
  return { events, skipped, missing, last: previous };
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export class FileEventStore implements EventStore {
  readonly supportsSnapshots = true;
  private readonly buffers = new Map<string, string[]>();
  private timer: NodeJS.Timeout | undefined;
  private chain: Promise<void> = Promise.resolve();
  private readonly knownDirs = new Set<string>();
  private readonly needsSeparator = new Set<string>();
  /**
   * 在本进程里写盘失败过的会话。drain 先把一批事件从缓冲里取走再写，失败的这一批不会放回去重试：日志里从此永久缺了它们（或只落了半截），
   * 而热会话的内存投影里有。这与 needsSeparator 是两回事——那个只记“文件末尾可能是半行”，下一批写成功就清掉；丢掉的事件却不会因为后来的写入成功就回来。
   * seal 对这里的会话一直返回 undefined（不据此做快照），只在 remove 时清掉；下次启动照日志重放，读时修复会补一条“日志不完整”的诊断（见 load）。
   */
  private readonly lostEvents = new Set<string>();
  /** 旁路小文件（快照、归档标记）按文件串行写：同一个文件的写 / 删按调用次序一个接一个，不会交叉。 */
  private readonly fileChains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly dir: string,
    private readonly log: Logger,
  ) {}

  private fileFor(sessionId: string): string {
    return join(this.dir, sessionId, "events.jsonl");
  }

  private snapshotFile(sessionId: string): string {
    return join(this.dir, sessionId, "summary.json");
  }

  private archiveFile(sessionId: string): string {
    return join(this.dir, sessionId, "archive.json");
  }

  async listSessionIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.dir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
  }

  async load(sessionId: string): Promise<EnsembleEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.fileFor(sessionId), "utf8");
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    const { events, skipped, missing, last: previous } = parseLog(raw, sessionId);
    if (skipped > 0) this.log.warn("skipped malformed event lines", { sessionId, skipped });
    if (missing > 0) this.log.warn("event log has sequence gaps", { sessionId, missing });
    if (raw.length > 0 && !raw.endsWith("\n")) {
      // Keep the original bytes, but end the old line before admitting new writes.
      await appendFile(this.fileFor(sessionId), "\n");
    }
    if ((skipped > 0 || missing > 0) && events[0]?.kind === "session.created" &&
      !events.some((event) => event.kind === "diagnostic" && event.data.code === "event_log_incomplete")) {
      const diagnostic: EnsembleEvent = {
        id: newId("evt"), sessionId, seq: previous + 1, at: isoNow(), source: "ensemble",
        kind: "diagnostic", data: { level: "warn", code: "event_log_incomplete",
          message: "Part of the saved event history could not be read. The timeline may be incomplete." },
      };
      this.append(diagnostic);
      events.push(diagnostic);
    }
    return events;
  }

  append(event: EnsembleEvent): void {
    const lines = this.buffers.get(event.sessionId);
    const line = JSON.stringify(event);
    if (lines) lines.push(line);
    else this.buffers.set(event.sessionId, [line]);
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, FLUSH_DELAY_MS);
  }

  private drain(): Promise<void> {
    const batch = [...this.buffers.entries()];
    this.buffers.clear();
    this.chain = this.chain.then(async () => {
      await Promise.all(batch.map(async ([sessionId, lines]) => {
        try {
          const file = this.fileFor(sessionId);
          if (!this.knownDirs.has(sessionId)) {
            await mkdir(join(this.dir, sessionId), { recursive: true });
            this.knownDirs.add(sessionId);
          }
          // If a prior write failed, this very write also separates its possibly torn tail.
          const separator = this.needsSeparator.has(sessionId) ? "\n" : "";
          await appendFile(file, `${separator}${lines.join("\n")}\n`, "utf8");
          this.needsSeparator.delete(sessionId);
        } catch (error) {
          this.knownDirs.delete(sessionId);
          this.needsSeparator.add(sessionId);
          this.lostEvents.add(sessionId);
          this.log.error("failed to persist events", { sessionId, error });
        }
      }));
    });
    return this.chain;
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.drain();
  }

  async remove(sessionId: string): Promise<void> {
    this.buffers.delete(sessionId);
    await this.chain;
    // 旁路文件的在途写入也等它们收尾：否则目录删掉之后，迟到的写入会让一个只有临时文件的目录重新冒出来。
    await Promise.all([this.fileChains.get(this.snapshotFile(sessionId)), this.fileChains.get(this.archiveFile(sessionId))]);
    this.knownDirs.delete(sessionId);
    this.needsSeparator.delete(sessionId);
    this.lostEvents.delete(sessionId);
    await rm(join(this.dir, sessionId), { recursive: true, force: true });
  }

  // ───────────────────────── 冷热分离 ─────────────────────────

  async logSize(sessionId: string): Promise<number | undefined> {
    try {
      return (await stat(this.fileFor(sessionId))).size;
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
  }

  async seal(sessionId: string): Promise<number | undefined> {
    // 这个会话缓冲里的事件先落盘；没有缓冲时也要等在途的写入收尾，之后文件大小才是最终的。
    if (this.buffers.has(sessionId)) await this.flush();
    else await this.chain;
    // 写盘失败过：那一批事件已经丢出缓冲，日志里缺了它们（末尾也可能是半行），而内存里的状态有。
    // 之后的写入成功了，文件大小也只是“这份残缺日志”的大小：据此做的快照会在下次启动被采信，却无法由日志重建出同一份状态。
    // 所以不再封存，会话留在内存里，下次启动照日志重放（needsSeparator 只管换行，下一批成功就清掉，管不了这件事）。
    if (this.lostEvents.has(sessionId)) return undefined;
    return this.logSize(sessionId);
  }

  async readLog(sessionId: string): Promise<LogRead | undefined> {
    let buffer: Buffer;
    try {
      buffer = await readFile(this.fileFor(sessionId));
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
    const { events, skipped, missing } = parseLog(buffer.toString("utf8"), sessionId);
    if (skipped > 0 || missing > 0) this.log.warn("event log of a cold session has malformed lines or gaps", { sessionId, skipped, missing });
    return { events, bytes: buffer.length };
  }

  async readSnapshot(sessionId: string): Promise<unknown> {
    return this.readJson(this.snapshotFile(sessionId));
  }

  async writeSnapshot(sessionId: string, snapshot: unknown): Promise<void> {
    const file = this.snapshotFile(sessionId);
    await this.serialize(file, () => writeFileAtomic(file, `${JSON.stringify(snapshot)}\n`));
  }

  // ───────────────────────── 归档 ─────────────────────────

  async readArchive(sessionId: string): Promise<unknown> {
    return this.readJson(this.archiveFile(sessionId));
  }

  async writeArchive(sessionId: string, mark: ArchiveMark): Promise<void> {
    const file = this.archiveFile(sessionId);
    await this.serialize(file, async () => {
      // 会话目录要等这个会话的第一批事件落盘时才建出来（见 drain），而写旁路文件不创建目录：
      // 刚创建、事件还在 25ms 写缓冲里的会话此刻还没有目录，直接写会 ENOENT。先让它的事件落盘；
      // 已被删除的会话缓冲与目录都已没有，之后的写入照旧以 ENOENT 失败（不把目录带回来）。
      if (this.buffers.has(sessionId)) await this.flush();
      else await this.chain;
      await writeFileAtomic(file, `${JSON.stringify(mark)}\n`);
    });
  }

  async clearArchive(sessionId: string): Promise<void> {
    const file = this.archiveFile(sessionId);
    await this.serialize(file, () => removeFileQuiet(file));
  }

  /** 读一个 JSON 小文件：不存在或内容不是合法 JSON 都按“没有”处理（旁路文件只是缓存或标记，坏了不该影响会话本身）。 */
  private async readJson(file: string): Promise<unknown> {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  }

  private serialize<T>(file: string, job: () => Promise<T>): Promise<T> {
    const previous = this.fileChains.get(file) ?? Promise.resolve();
    // 前一个任务失败不该拖累后一个：无论结果如何都接着跑。
    const run = previous.then(job, job);
    const tail = run.catch(() => undefined);
    this.fileChains.set(file, tail);
    void tail.then(() => {
      if (this.fileChains.get(file) === tail) this.fileChains.delete(file);
    });
    return run;
  }
}

/** 测试与演示用的内存存储。 */
export class MemoryEventStore implements EventStore {
  readonly supportsSnapshots: boolean;
  private readonly data = new Map<string, EnsembleEvent[]>();
  /** 旁路文件按 JSON 文本存放，和文件存储一样经过一次序列化往返（undefined 字段会消失）。 */
  private readonly snapshots = new Map<string, string>();
  private readonly archives = new Map<string, string>();

  constructor(options: { snapshots?: boolean } = {}) {
    this.supportsSnapshots = options.snapshots === true;
  }

  async listSessionIds(): Promise<string[]> {
    return [...this.data.keys()].sort();
  }
  async load(sessionId: string): Promise<EnsembleEvent[]> {
    return [...(this.data.get(sessionId) ?? [])];
  }
  append(event: EnsembleEvent): void {
    const list = this.data.get(event.sessionId);
    if (list) list.push(event);
    else this.data.set(event.sessionId, [event]);
  }
  async flush(): Promise<void> {}
  async remove(sessionId: string): Promise<void> {
    this.data.delete(sessionId);
    this.snapshots.delete(sessionId);
    this.archives.delete(sessionId);
  }

  /** 日志的“字节数”：每条事件序列化后的长度加换行，只要同一份内容算出来总是同一个数、内容变了数就变即可。 */
  private bytesOf(sessionId: string): number {
    return (this.data.get(sessionId) ?? []).reduce((sum, event) => sum + JSON.stringify(event).length + 1, 0);
  }
  async logSize(sessionId: string): Promise<number | undefined> {
    return this.data.has(sessionId) ? this.bytesOf(sessionId) : undefined;
  }
  async seal(sessionId: string): Promise<number | undefined> {
    return this.logSize(sessionId);
  }
  async readLog(sessionId: string): Promise<LogRead | undefined> {
    const list = this.data.get(sessionId);
    return list ? { events: [...list], bytes: this.bytesOf(sessionId) } : undefined;
  }
  async readSnapshot(sessionId: string): Promise<unknown> {
    return this.parseText(this.snapshots.get(sessionId));
  }
  async writeSnapshot(sessionId: string, snapshot: unknown): Promise<void> {
    this.requireSession(sessionId);
    this.snapshots.set(sessionId, JSON.stringify(snapshot));
  }
  async readArchive(sessionId: string): Promise<unknown> {
    return this.parseText(this.archives.get(sessionId));
  }
  async writeArchive(sessionId: string, mark: ArchiveMark): Promise<void> {
    this.requireSession(sessionId);
    this.archives.set(sessionId, JSON.stringify(mark));
  }
  async clearArchive(sessionId: string): Promise<void> {
    this.archives.delete(sessionId);
  }

  /** 与文件存储对齐：会话已经不存在时，往它的“目录”里写旁路文件以 ENOENT 失败。 */
  private requireSession(sessionId: string): void {
    if (!this.data.has(sessionId)) throw Object.assign(new Error(`ENOENT: no session ${sessionId}`), { code: "ENOENT" });
  }
  private parseText(text: string | undefined): unknown {
    return text === undefined ? undefined : (JSON.parse(text) as unknown);
  }
}
