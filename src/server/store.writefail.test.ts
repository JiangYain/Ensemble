import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EnsembleEvent, EventDraft } from "@shared/events";
import { appendTo, lazyHub, MINUTE, NOW, seed, sessionEvents, type Clock } from "./history-fixtures";
import { silentLogger } from "./logger";
import { FileEventStore } from "./store";

// 日志写盘失败之后，什么还能被“封存”（做快照）。
//
// FileEventStore.drain 先把一批事件从缓冲里取走再写，写失败时这一批不会放回去重试：日志里永久缺了它们，而热会话的内存投影里有。
// 修复前 seal 只看 needsSeparator（“文件末尾可能是半行”），它在下一批写入成功后就被清掉——于是 seal 又返回了字节数，
// 中枢据此用含有缺失事件的内存状态做出快照；下次启动字节数校验通过、快照被采信，打开事件历史却无法由日志重建同一份状态，也没有任何“日志不完整”的提示。
// 修复后丢过事件的会话由 lostEvents 记着，seal 一直返回 undefined（本进程内；删除会话时清掉）：会话留在内存里，下次启动照日志重放，读时修复补上诊断。

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ensemble-writefail-"));
}

const logFile = (dir: string, id: string): string => join(dir, id, "events.jsonl");

/**
 * 让这个会话的下一次追加必然失败：把 events.jsonl 挪开，原处放一个同名目录（往目录上追加，POSIX 是 EISDIR，Windows 上是 EISDIR 或 EPERM）。
 * 与 store.test.ts 里同一种做法。返回“恢复原样”的函数：删掉那个目录，把原文件挪回来。
 */
async function blockLog(dir: string, id: string): Promise<() => Promise<void>> {
  const file = logFile(dir, id);
  await rename(file, `${file}.saved`);
  await mkdir(file);
  return async () => {
    await rm(file, { recursive: true });
    await rename(`${file}.saved`, file);
  };
}

/**
 * 日志丢一批事件：lost 这一批写盘失败（它离开缓冲，再也写不进日志），随后 kept 这一批写成功。alongside 是和 lost 同一批交给存储的别的事件。
 * 调用前这个会话的日志必须已经在磁盘上。
 */
async function loseOneBatch(
  store: FileEventStore,
  dir: string,
  id: string,
  lost: EnsembleEvent,
  kept: EnsembleEvent,
  alongside: readonly EnsembleEvent[] = [],
): Promise<void> {
  const restore = await blockLog(dir, id);
  store.append(lost);
  for (const event of alongside) store.append(event);
  await store.flush();
  await restore();
  store.append(kept);
  await store.flush();
}

/** 数着“完整载入”几次的文件存储。 */
class CountingFileStore extends FileEventStore {
  readonly loads: string[] = [];

  override async load(sessionId: string): Promise<EnsembleEvent[]> {
    this.loads.push(sessionId);
    return super.load(sessionId);
  }
}

const diagnostic = (code: string): EventDraft => ({
  kind: "diagnostic",
  data: { level: "info", code, message: `Diagnostic ${code}` },
  source: "ensemble",
  at: new Date(NOW).toISOString(),
});

/** 事件里的诊断代码，按出现顺序。 */
const codes = (events: readonly EnsembleEvent[]): string[] => events.flatMap((event) => (event.kind === "diagnostic" ? [event.data.code] : []));

describe("FileEventStore.seal after a batch of events was lost", () => {
  it("never seals the session again, not even after a later write succeeded, and leaves the other sessions alone", async () => {
    const dir = await tempDir();
    const store = new FileEventStore(dir, silentLogger);
    const a = sessionEvents({ id: "a" });
    const baseSeqs = a.map((event) => event.seq);
    for (const event of a) store.append(event);
    await store.flush();
    // 对照：日志完好的时候，seal 照常给出文件大小。
    expect(await store.seal("a")).toBe((await stat(logFile(dir, "a"))).size);

    const lost = appendTo(a, { kind: "diagnostic", data: { level: "info", code: "lost", message: "Dropped by a failed write" } });
    const kept = appendTo(a, { kind: "diagnostic", data: { level: "info", code: "kept", message: "Written after the failure" } });
    await loseOneBatch(store, dir, "a", lost, kept, sessionEvents({ id: "b" }));

    // 修复前：失败之后的那次写入成功把 needsSeparator 清掉了，这里返回的是字节数。
    expect(await store.seal("a")).toBeUndefined();
    // 同一批里别的会话写进去了，不受牵连。
    expect(await store.seal("b")).toBe((await stat(logFile(dir, "b"))).size);
    // 日志里确实缺了 lost，kept 落了盘（下一批照旧先补一个换行，不会和上一行粘在一起）。
    const read = await store.readLog("a");
    expect(kept.seq).toBe(lost.seq + 1);
    expect(read?.events.map((event) => event.seq)).toEqual([...baseSeqs, kept.seq]);
  });

  it("forgets the loss when the session is removed, so a new session under the same id can be sealed", async () => {
    const dir = await tempDir();
    const store = new FileEventStore(dir, silentLogger);
    const a = sessionEvents({ id: "a" });
    for (const event of a) store.append(event);
    await store.flush();
    const lost = appendTo(a, { kind: "diagnostic", data: { level: "info", code: "lost", message: "Dropped by a failed write" } });
    const kept = appendTo(a, { kind: "diagnostic", data: { level: "info", code: "kept", message: "Written after the failure" } });
    await loseOneBatch(store, dir, "a", lost, kept);
    // 修复前这一句就会失败（见上一条）；之后的部分钉住的是：标志只在删除会话时清掉，而不是对同一个 id 永远粘着。
    expect(await store.seal("a")).toBeUndefined();

    await store.remove("a");
    for (const event of sessionEvents({ id: "a" })) store.append(event);
    await store.flush();

    expect(await store.seal("a")).toBe((await stat(logFile(dir, "a"))).size);
  });
});

describe("a hub whose session lost a batch of events", () => {
  it("keeps the session in memory instead of freezing it behind a snapshot its log cannot back up; the next start replays the log and says it is incomplete", async () => {
    const dir = await tempDir();
    // 两个都是刚结束 5 分钟的会话：启动时在热表里，再过 6 分钟就可以冻结。b 是对照，它的日志完好。
    await seed(new FileEventStore(dir, silentLogger), [{ id: "a", at: NOW - 5 * MINUTE }, { id: "b", at: NOW - 5 * MINUTE }]);
    const store = new FileEventStore(dir, silentLogger);
    const clock: Clock = { now: NOW };
    const hub = lazyHub(store, clock);
    await hub.load();
    expect(hub.hotIds()).toEqual(["a", "b"]);

    // a 的一条事件写盘失败（它只在内存里），随后又有一条事件写成功。
    const restore = await blockLog(dir, "a");
    hub.emit("a", diagnostic("lost"));
    await hub.flush();
    await restore();
    hub.emit("a", diagnostic("kept"));
    await hub.flush();
    expect(codes(hub.events("a"))).toEqual(["lost", "kept"]);

    // 修复前：a 也被冻结了（返回 2），快照里记着内存里的序号与日志此刻的字节数——下次启动会被采信。
    clock.now = NOW + 11 * MINUTE;
    expect(await hub.sweep()).toBe(1);
    expect(hub.isHot("a")).toBe(true);
    expect(hub.isHot("b")).toBe(false);
    expect(await store.readSnapshot("a")).toBeUndefined();
    expect(await store.readSnapshot("b")).toBeDefined();

    // 下次启动：b 的快照可信，a 没有快照、照日志重放——事件缺了一条，读时修复补上“日志不完整”的诊断，不再假装一切完好。
    const next = new CountingFileStore(dir, silentLogger);
    const restarted = lazyHub(next, clock);
    await restarted.load();
    expect(next.loads).toEqual(["a"]);
    expect(codes(await restarted.readEvents("a"))).toEqual(["kept", "event_log_incomplete"]);
    await restarted.flush();
  });
});
