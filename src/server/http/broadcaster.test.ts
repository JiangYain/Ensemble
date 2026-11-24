import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import type { StateSnapshot } from "@shared/protocol";
import { EventLog } from "@shared/testing";
import { EventHub } from "../hub";
import { silentLogger } from "../logger";
import { MemoryEventStore } from "../store";
import { Broadcaster } from "./broadcaster";

it("replays buffered and not-yet-broadcast SSE events once, in order", async () => {
  const hub = new EventHub({ store: new MemoryEventStore(), log: silentLogger });
  const broadcaster = new Broadcaster(hub, silentLogger, 10_000);
  const snapshot = (): StateSnapshot => ({
    rev: broadcaster.currentRev(), serverTime: "", version: "test", protocol: 1, sessions: hub.allSummaries(),
    harnesses: [], capacity: { max: 1, occupied: 0, waiting: 0 }, dev: true,
  });
  const server = createServer((req, res) => {
    const id = req.headers["last-event-id"];
    broadcaster.add(res, typeof id === "string" ? id : undefined, snapshot, "test");
  });
  broadcaster.start();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const controller = new AbortController();
  const url = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  try {
    const open = async (lastEventId?: string) => {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: lastEventId ? { "last-event-id": lastEventId } : {},
      });
      return response.body!.pipeThrough(new TextDecoderStream()).getReader();
    };
    const read = async (reader: ReadableStreamDefaultReader<string>, count: number) => {
      let text = "";
      while ((text.match(/^id: /gm) ?? []).length < count) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Stream closed before the frames arrived.");
        text += chunk.value;
      }
      return Array.from(text.matchAll(/^id: (\S+)/gm), (match) => match[1]!);
    };
    const log = new EventLog();
    const created = log.created();
    if (created.kind !== "session.created") throw new Error("Expected a session creation event");
    hub.emit(created.sessionId, { kind: created.kind, data: created.data, source: "ensemble" });
    const initial = await open();
    const [lastId] = await read(initial, 1);
    expect(lastId).toBeDefined();

    const emit = (message: string) => hub.emit(created.sessionId, {
      kind: "diagnostic", data: { level: "info", code: "test", message }, source: "ensemble",
    });
    emit("Already published before the reconnect");
    const later = await open();
    await read(later, 1); // Snapshot flushes the previous event into the replay buffer.
    emit("Still waiting in the broadcast batch");

    const reconnected = await open(lastId);
    const ids = await read(reconnected, 4);
    expect(ids.map((id) => Number(id.split(":").at(-1)))).toEqual([3, 4, 5, 6]);
  } finally {
    controller.abort();
    broadcaster.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
