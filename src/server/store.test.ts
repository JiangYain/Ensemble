import { appendFile, mkdir, mkdtemp, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EventLog } from "@shared/testing";
import { EventHub } from "./hub";
import { silentLogger } from "./logger";
import { FileEventStore } from "./store";

describe("persisted session events", () => {
  it("still replays the first new event after a crash leaves a torn JSONL tail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ensemble-log-"));
    const log = new EventLog();
    const created = log.created();
    const id = created.sessionId;
    const disk = () => new FileEventStore(dir, silentLogger);
    const store = disk();
    store.append(created);
    await store.flush();
    await appendFile(join(dir, id, "events.jsonl"), '{"id":"torn');

    const hub = new EventHub({ store: disk(), log: silentLogger });
    await hub.load();
    hub.emit(id, { kind: "diagnostic", data: { level: "info", code: "after_restart", message: "First new event" }, source: "ensemble" });
    await hub.flush();

    const restarted = new EventHub({ store: disk(), log: silentLogger });
    await restarted.load();
    expect(restarted.events(id)).toEqual([
      expect.objectContaining({ seq: 1, kind: "session.created" }),
      expect.objectContaining({ seq: 2, data: expect.objectContaining({ code: "event_log_incomplete" }) }),
      expect.objectContaining({ seq: 3, data: expect.objectContaining({ code: "after_restart" }) }),
    ]);
  });

  it("reports sequence gaps alongside the history that could be read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ensemble-log-gap-"));
    const warn = vi.fn();
    const store = new FileEventStore(dir, { ...silentLogger, warn });
    const log = new EventLog();
    const created = log.created();
    store.append(created);
    store.append({ ...created, seq: 3 });
    await store.flush();

    const loaded = await store.load(created.sessionId);
    await store.flush();
    expect(loaded.map((event) => event.seq)).toEqual([1, 3, 4]);
    expect(warn).toHaveBeenCalledWith("event log has sequence gaps", { sessionId: created.sessionId, missing: 1 });
  });

  it("preserves the next batch when a failed write cannot seal the tail immediately", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ensemble-log-write-"));
    const store = new FileEventStore(dir, silentLogger);
    const log = new EventLog();
    const created = log.created();
    const file = join(dir, created.sessionId, "events.jsonl");
    const diagnostic = (message: string) => log.push({ kind: "diagnostic", data: { code: "test", level: "warn", message } });
    store.append(created);
    await store.flush();
    await appendFile(file, '{"id":"torn');
    await rename(file, file + ".saved");
    await mkdir(file); // The append and any immediate recovery write must both fail.
    store.append(diagnostic("Lost"));
    await store.flush();
    await rename(file, file + ".blocked");
    await rename(file + ".saved", file);
    store.append(diagnostic("Preserved"));
    await store.flush();

    expect(await new FileEventStore(dir, silentLogger).load(created.sessionId)).toContainEqual(expect.objectContaining({
      seq: 3, kind: "diagnostic", data: { code: "test", level: "warn", message: "Preserved" },
    }));
  });
});
