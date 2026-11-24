import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import { LIMITS } from "@shared/constants";
import type { EnsembleEvent } from "@shared/events";
import { isoNow } from "@shared/format";
import type { Capacity, ConcurrencySetting, StateSnapshot, StreamMessage } from "@shared/protocol";
import type { SessionId } from "@shared/types";
import type { EventHub, HubChange } from "../hub";
import type { Logger } from "../logger";

interface Frame {
  rev: number;
  data: string;
}

/** `capacity` 消息的内容：名额账目与并发上限的设置成对给，页面一次更新两处（两者对不上会让“来源”与“上限”说的是两回事）。 */
export interface CapacityPayload {
  capacity: Capacity;
  concurrency: ConcurrencySetting;
}

const MAX_CLIENT_BACKLOG_BYTES = 8 * 1024 * 1024;
const HEARTBEAT_MS = 10_000;

/**
 * SSE 广播：把中枢里的事件按短窗口合并后推送给所有网页。
 * 每条消息带单调递增的 rev 作为 SSE id，断线重连时用 Last-Event-ID 从环形缓冲补发；
 * 缓冲已不足以补发时，改发完整快照，网页据此重建。
 */
export class Broadcaster {
  private readonly clients = new Set<ServerResponse>();
  private readonly ring: Frame[] = [];
  private rev = 0;
  /** 进程级启动标识：服务重启后 rev 会重新计数，带上它才能识别来自旧进程的 Last-Event-ID。 */
  private readonly bootId = randomBytes(4).toString("hex");
  private readonly pending = new Map<SessionId, EnsembleEvent[]>();
  private readonly dirty = new Set<SessionId>();
  private flushTimer: NodeJS.Timeout | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private unsubscribe: (() => void) | undefined;
  /** 读取名额账目与并发上限设置的方式（见 watchCapacity）；没登记就不推 capacity 消息。 */
  private readCapacity: (() => CapacityPayload) | undefined;
  private capacityDirty = false;
  /** 最近一次推给页面（或已体现在快照里）的容量内容；只有真的变了才再推。 */
  private lastCapacity: string | undefined;

  constructor(
    private readonly hub: EventHub,
    private readonly log: Logger,
    private readonly flushMs = 40,
  ) {}

  start(): void {
    this.unsubscribe = this.hub.subscribe((change) => this.onChange(change));
    this.heartbeatTimer = setInterval(() => {
      const frame = this.frameFor({ type: "ping", at: isoNow() }, this.rev);
      for (const client of this.clients) this.write(client, frame);
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  /**
   * 登记容量的读取方式。名额的占用 / 等待每个会话开始、结束都会变，所以容量与会话事件共用同一个合并窗口，
   * 并且内容与上次推送的完全一样就不推——页面看到的是变化本身，不是心跳；也不依赖页面自己从会话状态里推算名额。
   */
  watchCapacity(read: () => CapacityPayload): void {
    this.readCapacity = read;
    this.lastCapacity = JSON.stringify(read());
  }

  /** 名额的占用、等待，或并发上限的设置变了：标记一下，随下一个合并窗口一并推出（窗口里变几次都只推最后的样子）。 */
  capacityChanged(): void {
    if (!this.readCapacity) return;
    this.capacityDirty = true;
    this.flushTimer ??= setTimeout(() => this.flushNow(), this.flushMs);
  }

  stop(): void {
    this.unsubscribe?.();
    this.readCapacity = undefined;
    this.capacityDirty = false;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const client of this.clients) client.end();
    this.clients.clear();
  }

  clientCount(): number {
    return this.clients.size;
  }

  currentRev(): number {
    return this.rev;
  }

  /** 解析 Last-Event-ID；只有来自本进程的 id 才有意义。 */
  private parseLastEventId(raw: string | undefined): number | undefined {
    const match = raw ? /^([0-9a-f]+):(\d+)$/.exec(raw) : null;
    return match && match[1] === this.bootId ? Number(match[2]) : undefined;
  }

  add(
    res: ServerResponse,
    lastEventIdRaw: string | undefined,
    snapshot: () => StateSnapshot,
    version: string,
  ): void {
    const lastEventId = this.parseLastEventId(lastEventIdRaw);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 2000\n\n");
    // Flush pending frames to existing clients only. Establish the new client's cut before subscribing it.
    this.flushNow();

    const oldest = this.ring[0]?.rev;
    if (lastEventId !== undefined && oldest !== undefined && lastEventId >= oldest - 1 && lastEventId <= this.rev) {
      for (const frame of this.ring) {
        if (frame.rev > lastEventId) this.write(res, frame);
      }
    } else {
      const snap = snapshot();
      // Only the snapshot advances Last-Event-ID. A client that loses the connection after hello still needs it.
      res.write(`event: hello\ndata: ${JSON.stringify({ type: "hello", rev: snap.rev, bootId: this.bootId, serverTime: isoNow(), version } satisfies StreamMessage)}\n\n`);
      this.write(res, this.frameFor({ type: "snapshot", snapshot: snap }, snap.rev));
    }
    if (!res.destroyed && !res.writableEnded) {
      this.clients.add(res);
      res.on("close", () => this.clients.delete(res));
    }
  }

  publish(message: StreamMessage): void {
    this.rev += 1;
    const frame = this.frameFor(message, this.rev);
    this.ring.push(frame);
    if (this.ring.length > LIMITS.sseReplayBuffer) this.ring.splice(0, this.ring.length - LIMITS.sseReplayBuffer);
    for (const client of this.clients) this.write(client, frame);
  }

  private frameFor(message: StreamMessage, rev: number): Frame {
    return { rev, data: `id: ${this.bootId}:${rev}\nevent: ${message.type}\ndata: ${JSON.stringify(message)}\n\n` };
  }

  private write(client: ServerResponse, frame: Frame): void {
    if (client.destroyed || client.writableEnded) return;
    if (client.writableLength > MAX_CLIENT_BACKLOG_BYTES) {
      this.log.warn("dropping slow sse client", { backlog: client.writableLength });
      client.destroy();
      this.clients.delete(client);
      return;
    }
    client.write(frame.data);
  }

  private onChange(change: HubChange): void {
    if (change.type === "removed") {
      this.pending.delete(change.sessionId);
      this.dirty.delete(change.sessionId);
      this.publish({ type: "removed", sessionId: change.sessionId });
      return;
    }
    if (change.type === "event") {
      const list = this.pending.get(change.event.sessionId);
      if (list) list.push(change.event);
      else this.pending.set(change.event.sessionId, [change.event]);
    }
    this.dirty.add(change.type === "event" ? change.event.sessionId : change.sessionId);
    this.flushTimer ??= setTimeout(() => this.flushNow(), this.flushMs);
  }

  private flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    const sessionIds = [...this.dirty];
    this.dirty.clear();
    for (const sessionId of sessionIds) {
      const events = this.pending.get(sessionId);
      this.pending.delete(sessionId);
      if (events && events.length > 0) this.publish({ type: "events", sessionId, events });
      const summary = this.hub.summary(sessionId);
      if (summary) this.publish({ type: "summary", summary });
    }
    this.flushCapacity();
  }

  /** 排在会话事件之后：名额的变化是会话进展的结果，页面先看到会话、再看到名额。内容没变（来回抖动后回到原样）就不推。 */
  private flushCapacity(): void {
    if (!this.capacityDirty) return;
    this.capacityDirty = false;
    const payload = this.readCapacity?.();
    if (!payload) return;
    const key = JSON.stringify(payload);
    if (key === this.lastCapacity) return;
    this.lastCapacity = key;
    this.publish({ type: "capacity", capacity: payload.capacity, concurrency: payload.concurrency });
  }
}
