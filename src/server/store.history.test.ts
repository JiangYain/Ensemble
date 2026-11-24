import { appendFile, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EnsembleEvent } from "@shared/events";
import { testMeta } from "@shared/testing";
import { DAY, lazyHub, MINUTE, NOW, seed, sessionEvents, type Clock } from "./history-fixtures";
import { silentLogger } from "./logger";
import { parseSnapshot } from "./snapshot";
import { FileEventStore } from "./store";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ensemble-history-"));
}

const logFile = (dir: string, id: string): string => join(dir, id, "events.jsonl");

/** 数着“完整载入”几次的文件存储。 */
class CountingFileStore extends FileEventStore {
  readonly loads: string[] = [];

  override async load(sessionId: string): Promise<EnsembleEvent[]> {
    this.loads.push(sessionId);
    return super.load(sessionId);
  }
}

describe("FileEventStore: the side files of a session", () => {
  it("seal writes out what is buffered and reports the size the log really has", async () => {
    const dir = await tempDir();
    const store = new FileEventStore(dir, silentLogger);
    for (const event of sessionEvents({ id: "a" })) store.append(event);

    const bytes = await store.seal("a");

    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBe((await stat(logFile(dir, "a"))).size);
    expect(await store.logSize("a")).toBe(bytes);
    expect(await store.seal("missing")).toBeUndefined();
    expect(await store.logSize("missing")).toBeUndefined();
  });

  it("readLog reads the whole log without repairing anything on disk, unlike load", async () => {
    const dir = await tempDir();
    const store = new FileEventStore(dir, silentLogger);
    const events = sessionEvents({ id: "a" });
    for (const event of events) store.append(event);
    await store.flush();
    await appendFile(logFile(dir, "a"), '{"id":"torn');
    const before = await readFile(logFile(dir, "a"));

    const read = await store.readLog("a");

    expect(read?.events.map((event) => event.seq)).toEqual(events.map((event) => event.seq));
    expect(read?.bytes).toBe(before.length);
    expect(await readFile(logFile(dir, "a"))).toEqual(before);
    expect(await store.readLog("missing")).toBeUndefined();
  });

  it("keeps a snapshot and an archive mark beside the log, and leaves nothing temporary behind", async () => {
    const dir = await tempDir();
    const store = new FileEventStore(dir, silentLogger);
    await seed(store, [{ id: "a" }]);

    expect(await store.readSnapshot("a")).toBeUndefined();
    expect(await store.readArchive("a")).toBeUndefined();

    await store.writeSnapshot("a", { format: 1, note: "first" });
    await store.writeSnapshot("a", { format: 1, note: "second" });
    await store.writeArchive("a", { archivedAt: "2026-05-30T00:00:00.000Z", by: "retention" });

    expect(await store.readSnapshot("a")).toEqual({ format: 1, note: "second" });
    expect(await store.readArchive("a")).toEqual({ archivedAt: "2026-05-30T00:00:00.000Z", by: "retention" });
    expect((await readdir(join(dir, "a"))).sort()).toEqual(["archive.json", "events.jsonl", "summary.json"]);

    await store.clearArchive("a");
    await store.clearArchive("a");
    expect(await store.readArchive("a")).toBeUndefined();
    expect((await readdir(join(dir, "a"))).sort()).toEqual(["events.jsonl", "summary.json"]);
  });

  it("writes an archive mark for a session whose first events are still in the write buffer: the directory only exists once they are out", async () => {
    const dir = await tempDir();
    const store = new FileEventStore(dir, silentLogger);
    for (const event of sessionEvents({ id: "a" })) store.append(event);
    // 事件只在缓冲里：会话目录还没有建出来。
    expect(await readdir(dir)).toEqual([]);

    await store.writeArchive("a", { archivedAt: "2026-05-30T00:00:00.000Z", by: "user" });

    expect(await store.readArchive("a")).toEqual({ archivedAt: "2026-05-30T00:00:00.000Z", by: "user" });
    expect((await readdir(join(dir, "a"))).sort()).toEqual(["archive.json", "events.jsonl"]);
    expect((await store.load("a")).length).toBe(sessionEvents({ id: "a" }).length);
  });

  it("treats a side file it cannot read as absent instead of failing", async () => {
    const dir = await tempDir();
    const store = new FileEventStore(dir, silentLogger);
    await seed(store, [{ id: "a" }]);
    await writeFile(join(dir, "a", "summary.json"), '{"format":1,');
    await writeFile(join(dir, "a", "archive.json"), "not json at all");

    expect(await store.readSnapshot("a")).toBeUndefined();
    expect(await store.readArchive("a")).toBeUndefined();
  });

  it("refuses to write a side file for a session whose directory is gone, and does not bring the directory back", async () => {
    const dir = await tempDir();
    const store = new FileEventStore(dir, silentLogger);
    await seed(store, [{ id: "a" }]);
    await store.remove("a");

    await expect(store.writeSnapshot("a", { format: 1 })).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.writeArchive("a", { archivedAt: "2026-05-30T00:00:00.000Z", by: "user" })).rejects.toMatchObject({ code: "ENOENT" });
    await store.clearArchive("a");
    expect(await readdir(dir)).toEqual([]);
  });

  it("applies several writes to the same file in the order they were asked for", async () => {
    const dir = await tempDir();
    const store = new FileEventStore(dir, silentLogger);
    await seed(store, [{ id: "a" }]);

    await Promise.all([1, 2, 3, 4, 5].map((n) => store.writeSnapshot("a", { n })));

    expect(await store.readSnapshot("a")).toEqual({ n: 5 });
    expect((await readdir(join(dir, "a"))).sort()).toEqual(["events.jsonl", "summary.json"]);
  });

  it("removes the side files together with the session", async () => {
    const dir = await tempDir();
    const store = new FileEventStore(dir, silentLogger);
    await seed(store, [{ id: "a" }, { id: "b" }]);
    await store.writeSnapshot("a", { format: 1 });
    await store.writeArchive("a", { archivedAt: "2026-05-30T00:00:00.000Z", by: "user" });

    await store.remove("a");

    expect(await readdir(dir)).toEqual(["b"]);
    expect(await store.listSessionIds()).toEqual(["b"]);
  });

  it("does not let the side files change what load returns: an older service that ignores them sees the same history", async () => {
    const dir = await tempDir();
    const store = new FileEventStore(dir, silentLogger);
    const written = await seed(store, [{ id: "a" }]);
    const bare = await store.load("a");
    await store.writeSnapshot("a", { format: 1 });
    await store.writeArchive("a", { archivedAt: "2026-05-30T00:00:00.000Z", by: "user" });

    expect(await store.load("a")).toEqual(bare);
    expect(bare).toEqual(written.get("a"));
    expect(await store.listSessionIds()).toEqual(["a"]);
  });
});

describe("a hub on real files", () => {
  it("writes summary.json for settled sessions on the first start, trusts them on the next, and never touches events.jsonl", async () => {
    const dir = await tempDir();
    await seed(new FileEventStore(dir, silentLogger), [{ id: "a" }, { id: "b", ending: "failed" }, { id: "c", parent: "a" }]);
    const original = await Promise.all(["a", "b", "c"].map((id) => readFile(logFile(dir, id))));
    const clock: Clock = { now: NOW };

    const first = new CountingFileStore(dir, silentLogger);
    const firstHub = lazyHub(first, clock);
    await firstHub.load();
    expect(first.loads.sort()).toEqual(["a", "b", "c"]);
    expect(firstHub.counts()).toEqual({ total: 3, hot: 0, archived: 0 });
    for (const id of ["a", "b", "c"]) {
      expect(parseSnapshot(JSON.parse(await readFile(join(dir, id, "summary.json"), "utf8")), id), id).toBeDefined();
    }

    const second = new CountingFileStore(dir, silentLogger);
    const secondHub = lazyHub(second, clock);
    await secondHub.load();
    expect(second.loads).toEqual([]);
    expect(secondHub.allSummaries()).toEqual(firstHub.allSummaries());

    await secondHub.setArchived(["a"], { archivedAt: "2026-05-30T00:00:00.000Z", by: "user" });
    await secondHub.readEvents("b");
    await secondHub.ensureHot("c");
    clock.now = NOW + 11 * MINUTE;
    expect(await secondHub.sweep()).toBe(1);
    await secondHub.flush();

    expect(await Promise.all(["a", "b", "c"].map((id) => readFile(logFile(dir, id))))).toEqual(original);
  });

  it("keeps the archive mark of a session that is archived while its first events are still in the write buffer, instead of rolling it back", async () => {
    const dir = await tempDir();
    const hub = lazyHub(new FileEventStore(dir, silentLogger), { now: NOW });
    hub.emit("fresh", { kind: "session.created", data: { meta: testMeta({ id: "fresh" }) }, source: "ensemble" });
    // 事件还在存储的写缓冲里，会话目录还没有建出来；归档标记不能因此写不进去。
    const mark = { archivedAt: "2026-05-30T00:00:00.000Z", by: "user" } as const;

    await hub.setArchived(["fresh"], mark);

    expect(hub.archiveOf("fresh")).toEqual(mark);
    expect(JSON.parse(await readFile(join(dir, "fresh", "archive.json"), "utf8"))).toEqual(mark);
    await hub.flush();
    expect((await readdir(join(dir, "fresh"))).sort()).toEqual(["archive.json", "events.jsonl"]);
  });

  it("does not hide damage to a log behind its snapshot: a log that changed is replayed, repaired the usual way, and snapshotted again", async () => {
    const dir = await tempDir();
    await seed(new FileEventStore(dir, silentLogger), [{ id: "a" }]);
    const clock: Clock = { now: NOW };
    await lazyHub(new FileEventStore(dir, silentLogger), clock).load();
    // 快照写好之后，日志末尾又多了半行（比如旧版本服务写到一半被杀）。
    await appendFile(logFile(dir, "a"), '{"id":"torn');

    const store = new CountingFileStore(dir, silentLogger);
    // 读时修复补记的那条诊断带的是真实的当前时间，所以这一次启动的时钟也要在真实时间之后：保证它已过保温期，快照才会重写。
    const hub = lazyHub(store, { now: Date.now() + 365 * DAY });
    await hub.load();
    await hub.flush();

    expect(store.loads).toEqual(["a"]);
    const events = await hub.readEvents("a");
    expect(events.at(-1)).toMatchObject({ kind: "diagnostic", data: { code: "event_log_incomplete" } });
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    const snapshot = parseSnapshot(JSON.parse(await readFile(join(dir, "a", "summary.json"), "utf8")), "a");
    expect(snapshot?.lastSeq).toBe(events.at(-1)?.seq);
    expect(snapshot?.logBytes).toBe((await stat(logFile(dir, "a"))).size);
  });
});
