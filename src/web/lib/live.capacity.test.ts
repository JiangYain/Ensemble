import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConcurrencySetting, StateSnapshot, StreamMessage } from "@shared/protocol";
import { store } from "./app";
import { startLive } from "./live";

/** 可控的 EventSource：测试用 emit 模拟服务推来的消息。 */
class FakeEventSource {
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 0;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const setting: ConcurrencySetting = { source: "default", inherited: { max: 20, source: "default" } };

const snapshotOf = (patch: Partial<StateSnapshot> = {}): StateSnapshot => ({
  rev: 0,
  serverTime: "2026-11-22T00:00:00.000Z",
  version: "test",
  protocol: 1,
  sessions: [],
  harnesses: [],
  capacity: { occupied: 0, max: 20, waiting: 0 },
  dev: false,
  ...patch,
});

describe("实时连接里的并发上限", () => {
  let stop: (() => void) | undefined;
  const previous = store.get();

  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    store.set({ conn: "connecting", ready: false, concurrency: undefined, capacity: { occupied: 0, max: 0, waiting: 0 } });
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    store.set({ conn: previous.conn, ready: previous.ready, concurrency: previous.concurrency, capacity: previous.capacity });
  });

  const serve = (body: StateSnapshot): void => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        if (!input.startsWith("/api/state")) throw new Error(`unexpected request ${input}`);
        const text = JSON.stringify(body);
        return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
      }),
    );
  };

  const start = async (): Promise<void> => {
    stop = startLive({ reload: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
  };

  /** 服务通过 SSE 推来一条消息。 */
  const push = (message: StreamMessage): void => {
    FakeEventSource.instances.at(-1)!.emit(message.type, { data: JSON.stringify(message) });
  };

  it("首屏快照里的设置与容量一起存进状态", async () => {
    serve(snapshotOf({ capacity: { occupied: 2, max: 5, waiting: 1 }, concurrency: { source: "settings", stored: 5, inherited: { max: 20, source: "default" } } }));
    await start();
    expect(store.get().capacity).toEqual({ occupied: 2, max: 5, waiting: 1 });
    expect(store.get().concurrency).toEqual({ source: "settings", stored: 5, inherited: { max: 20, source: "default" } });
  });

  it("老服务的快照没有这项设置：留空，而不是当成“不限制”", async () => {
    serve(snapshotOf());
    await start();
    expect(store.get().ready).toBe(true);
    expect(store.get().concurrency).toBeUndefined();
    expect(store.get().capacity).toEqual({ occupied: 0, max: 20, waiting: 0 });
  });

  it("capacity 消息成对更新容量与设置（别的标签页改了上限，这里立刻看到）", async () => {
    serve(snapshotOf({ concurrency: setting }));
    await start();
    push({
      type: "capacity",
      capacity: { occupied: 3, max: 3, waiting: 2 },
      concurrency: { source: "settings", stored: 3, inherited: { max: 20, source: "default" } },
    });
    expect(store.get().capacity).toEqual({ occupied: 3, max: 3, waiting: 2 });
    expect(store.get().concurrency).toEqual({ source: "settings", stored: 3, inherited: { max: 20, source: "default" } });
  });

  it("capacity 消息也能把一个本来没有设置的页面补上（服务在页面打开之后才升级的情形不需要刷新）", async () => {
    serve(snapshotOf());
    await start();
    expect(store.get().concurrency).toBeUndefined();
    push({ type: "capacity", capacity: { occupied: 0, max: 0, waiting: 0 }, concurrency: { source: "settings", stored: "unlimited", inherited: { max: 20, source: "default" } } });
    expect(store.get().concurrency).toMatchObject({ source: "settings", stored: "unlimited" });
    expect(store.get().capacity.max).toBe(0);
  });

  it("重连后的快照以服务端为准：带设置就更新，对面是不认识这项设置的老服务就清空", async () => {
    serve(snapshotOf({ concurrency: setting }));
    await start();
    push({ type: "snapshot", snapshot: snapshotOf({ capacity: { occupied: 1, max: 7, waiting: 0 }, concurrency: { source: "settings", stored: 7, inherited: { max: 20, source: "default" } } }) });
    expect(store.get().capacity.max).toBe(7);
    expect(store.get().concurrency).toMatchObject({ source: "settings", stored: 7 });

    push({ type: "snapshot", snapshot: snapshotOf() });
    expect(store.get().concurrency).toBeUndefined();
    expect(store.get().capacity.max).toBe(20);
  });

  it("不碰别人的状态：容量消息不改会话、执行端与角色", async () => {
    serve(snapshotOf({ concurrency: setting }));
    await start();
    const before = store.get();
    push({ type: "capacity", capacity: { occupied: 1, max: 2, waiting: 0 }, concurrency: setting });
    const after = store.get();
    expect(after.sessions).toBe(before.sessions);
    expect(after.harnesses).toBe(before.harnesses);
    expect(after.profiles).toBe(before.profiles);
  });
});
