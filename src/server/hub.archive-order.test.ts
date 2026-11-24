import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ArchiveMark } from "./archive-mark";
import { lazyHub, NOW, seed, SpyStore } from "./history-fixtures";
import type { EventHub } from "./hub";
import { silentLogger } from "./logger";
import { FileEventStore } from "./store";

// 归档与取消归档的“落盘次序 = 内存里改动的次序”。
//
// 事件中枢先同步改完内存，再把标记写进各会话的 archive.json；存储里同一个文件的写 / 删按“被调用的先后”排队，
// 所以磁盘上的结果只取决于存储方法被调用的先后。修复前 setArchived 在 persistArchive 里逐个会话 await：
// 批里第二个会话的写入要等第一个写完才被调用，这段空档里发生的另一次操作（比如取消其中一个会话的归档）已经把自己的写 / 删先排进了队，
// 旧批次随后才补上它那条写入——磁盘上的先后与内存里相反，两次调用都成功，重启后却与网页相反。
// 修复后每个会话的写 / 删都在改内存的同一个同步段里就交给了存储。

const MARK: ArchiveMark = { archivedAt: "2026-05-30T00:00:00.000Z", by: "user" };
const LATER: ArchiveMark = { archivedAt: "2026-05-31T00:00:00.000Z", by: "retention" };

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * 内存存储，另外：记下归档的写 / 删是按什么先后被调用的（在方法被调用的当场记，不等它返回）；
 * 可以让某个会话的下一次标记写入失败，还可以让它等一道闸门打开之后才失败（模拟一次很慢、最后出错的磁盘写）。
 */
class ScriptedArchiveStore extends SpyStore {
  readonly calls: string[] = [];
  private readonly failures = new Map<string, { error: Error; after: Promise<void> | undefined }>();

  failNextWrite(sessionId: string, error: Error, after?: Promise<void>): void {
    this.failures.set(sessionId, { error, after });
  }

  override async writeArchive(sessionId: string, mark: ArchiveMark): Promise<void> {
    this.calls.push(`write ${sessionId}`);
    const failure = this.failures.get(sessionId);
    if (failure) {
      this.failures.delete(sessionId);
      if (failure.after) await failure.after;
      throw failure.error;
    }
    return super.writeArchive(sessionId, mark);
  }

  override async clearArchive(sessionId: string): Promise<void> {
    this.calls.push(`clear ${sessionId}`);
    return super.clearArchive(sessionId);
  }
}

/** 这些会话都是早已结束的（启动后是冷的），放在一个内存存储里，中枢已载入。 */
async function started(ids: readonly string[]): Promise<{ store: ScriptedArchiveStore; hub: EventHub }> {
  const store = new ScriptedArchiveStore();
  await seed(store, ids.map((id) => ({ id })));
  const hub = lazyHub(store, { now: NOW });
  await hub.load();
  return { store, hub };
}

/** 同上，但放在真实的文件存储里：archive.json 的写 / 删走真实的按文件队列。 */
async function startedOnDisk(ids: readonly string[]): Promise<{ dir: string; store: FileEventStore; hub: EventHub }> {
  const dir = await mkdtemp(join(tmpdir(), "ensemble-archive-order-"));
  await seed(new FileEventStore(dir, silentLogger), ids.map((id) => ({ id })));
  const store = new FileEventStore(dir, silentLogger);
  const hub = lazyHub(store, { now: NOW });
  await hub.load();
  return { dir, store, hub };
}

/** 重启：同一个目录上全新的存储与中枢，只认磁盘上的东西。 */
async function restart(dir: string): Promise<EventHub> {
  const hub = lazyHub(new FileEventStore(dir, silentLogger), { now: NOW });
  await hub.load();
  return hub;
}

describe("overlapping archive operations", () => {
  it("leave a session unarchived on disk, as on the page, when it was unarchived while the batch that archived it was still being saved", async () => {
    const { dir, store, hub } = await startedOnDisk(["a", "b"]);

    // 批量归档 a、b：内存立刻改完，写盘才刚开始；紧接着取消 b 的归档。
    // 修复前：b 的归档写入要等 a 写完才被调用，取消归档的删除先进了 b 的文件队列，旧批次随后才写入——磁盘上 b 又成了已归档，重启后与网页相反。
    const batch = hub.setArchived(["a", "b"], MARK);
    const undo = hub.setArchived(["b"], null);
    await Promise.all([batch, undo]);

    expect(hub.archiveOf("a")).toEqual(MARK);
    expect(hub.archiveOf("b")).toBeUndefined();
    expect(await store.readArchive("a")).toEqual(MARK);
    expect(await store.readArchive("b")).toBeUndefined();
    const restarted = await restart(dir);
    expect(restarted.archiveOf("a")).toEqual(MARK);
    expect(restarted.archiveOf("b")).toBeUndefined();
    expect(restarted.counts().archived).toBe(1);
  });

  it("do the same the other way round: a session archived again while the batch that unarchives it is still being saved stays archived on disk", async () => {
    const { dir, store, hub } = await startedOnDisk(["a", "b"]);
    await hub.setArchived(["a", "b"], MARK);

    // 修复前：b 的删除要等 a 的删除完成才被调用，重新归档 b 的写入先进了队，旧批次随后才删——磁盘上 b 成了未归档，内存与网页里它却是已归档。
    const batch = hub.setArchived(["a", "b"], null);
    const again = hub.setArchived(["b"], LATER);
    await Promise.all([batch, again]);

    expect(hub.archiveOf("a")).toBeUndefined();
    expect(hub.archiveOf("b")).toEqual(LATER);
    expect(await store.readArchive("a")).toBeUndefined();
    expect(await store.readArchive("b")).toEqual(LATER);
    const restarted = await restart(dir);
    expect(restarted.archiveOf("a")).toBeUndefined();
    expect(restarted.archiveOf("b")).toEqual(LATER);
  });

  it("hand every save of a batch to the store in the same synchronous step that changes memory, so the order on disk is the order of the changes", async () => {
    const { store, hub } = await started(["a", "b", "c"]);

    const batch = hub.setArchived(["a", "b", "c"], MARK);
    const undo = hub.setArchived(["b"], null);

    // 到这里还没有 await 过任何东西：两次调用已经把各自的写 / 删全交给了存储，先后就是内存里改动的先后。
    // 修复前这里只有 ["write a", "clear b"]：b、c 的写入要等 a 写完才会被调用，而且排在了取消 b 的删除后面。
    expect(store.calls).toEqual(["write a", "write b", "write c", "clear b"]);
    await Promise.all([batch, undo]);

    expect(await store.readArchive("a")).toEqual(MARK);
    expect(await store.readArchive("b")).toBeUndefined();
    expect(await store.readArchive("c")).toEqual(MARK);
  });
});

// 下面几条钉住的是回滚与报错的规则：写盘改成“先全部发起、再按次序收结果”之后，它们必须与原来一样。修复前后都应通过。
describe("when saving archive marks fails", () => {
  it("rolls back only the sessions whose save failed, keeps the others, and says how many failed and why the first of them did", async () => {
    const { store, hub } = await started(["a", "b", "c"]);
    store.failNextWrite("b", new Error("disk full for b"));
    store.failNextWrite("c", new Error("disk full for c"));
    const seen: string[] = [];
    hub.subscribe((change) => {
      if (change.type === "archive") seen.push(change.sessionId);
    });

    await expect(hub.setArchived(["a", "b", "c"], MARK)).rejects.toThrow("Could not save the archive mark for 2 session(s): disk full for b");

    expect(hub.archiveOf("a")).toEqual(MARK);
    expect(hub.archiveOf("b")).toBeUndefined();
    expect(hub.archiveOf("c")).toBeUndefined();
    expect(hub.counts().archived).toBe(1);
    expect(await store.readArchive("a")).toEqual(MARK);
    expect(await store.readArchive("b")).toBeUndefined();
    // 三条归档通知在写盘结果出来之前就发了（页面立刻看到），两条回滚通知随后按批里的次序补上。
    expect(seen).toEqual(["a", "b", "c", "b", "c"]);
  });

  it("does not let an older failed save undo a newer mark of the same session", async () => {
    const { store, hub } = await started(["a"]);
    const slow = gate();
    store.failNextWrite("a", new Error("disk full"), slow.promise);

    // 第一次的写盘很慢、最后失败；它还没结束时，同一个会话已经被第二次操作改成了另一个标记（并且写成功了）。
    const first = hub.setArchived(["a"], MARK);
    const second = hub.setArchived(["a"], LATER);
    const failure = expect(first).rejects.toThrow("Could not save the archive mark for 1 session(s): disk full");
    slow.open();
    await failure;
    await second;

    expect(hub.archiveOf("a")).toEqual(LATER);
    expect(await store.readArchive("a")).toEqual(LATER);
  });

  it("does not count a session that was deleted while its mark was being saved, when the error says its directory is gone", async () => {
    const { store, hub } = await started(["a", "b"]);
    const slow = gate();
    store.failNextWrite("b", Object.assign(new Error("ENOENT: the session directory is gone"), { code: "ENOENT" }), slow.promise);

    const saving = hub.setArchived(["a", "b"], MARK);
    const removal = hub.remove("b");
    slow.open();
    await saving;
    await removal;

    expect(hub.has("b")).toBe(false);
    expect(hub.archiveOf("b")).toBeUndefined();
    expect(hub.archiveOf("a")).toEqual(MARK);
  });

  it("still reports a deleted session's failed save when the error is anything else", async () => {
    const { store, hub } = await started(["a", "b"]);
    const slow = gate();
    store.failNextWrite("b", new Error("permission denied"), slow.promise);

    const saving = hub.setArchived(["a", "b"], MARK);
    const failure = expect(saving).rejects.toThrow("Could not save the archive mark for 1 session(s): permission denied");
    const removal = hub.remove("b");
    slow.open();
    await failure;
    await removal;

    expect(hub.has("b")).toBe(false);
    expect(hub.archiveOf("a")).toEqual(MARK);
  });
});
