import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfilesView } from "@shared/profiles";
import type { StateSnapshot, StreamMessage } from "@shared/protocol";
import { store } from "./app";
import { startLive } from "./live";
import { PROFILES_UNSUPPORTED, profilesSupported } from "./profiles";

/** 可控的 EventSource：测试用 emit 模拟服务推来的消息（与 live.capacity.test.ts 同一个写法）。 */
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

const roles: ProfilesView = { entries: [{ name: "verify", harness: "codex" }] };

/**
 * 实时连接怎么处理“服务有没有角色功能”：新服务的快照总带着 `profiles`（哪怕是空表），老服务的快照没有这个字段。
 * 设置窗口据此在“有功能、只是还没建角色”（给编辑器）与“根本没有这项功能”（只给一句说明）之间选；界面上的样子见 ProfilesSection.legacy.test.tsx。
 */
describe("实时连接里的角色表：服务有没有角色功能", () => {
  let stop: (() => void) | undefined;
  const previous = store.get();

  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    store.set({ conn: "connecting", ready: false, profiles: { entries: [] } });
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    store.set({ conn: previous.conn, ready: previous.ready, profiles: previous.profiles });
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

  it("标记与一张空表内容一样、只有身份不同：靠身份区分，所以必须是同一个对象", () => {
    expect(PROFILES_UNSUPPORTED).toEqual({ entries: [] });
    expect(profilesSupported(PROFILES_UNSUPPORTED)).toBe(false);
    expect(profilesSupported({ entries: [] })).toBe(true);
    expect(profilesSupported({ entries: [], unavailable: "unreadable_file" })).toBe(true);
    expect(Object.isFrozen(PROFILES_UNSUPPORTED)).toBe(true);
  });

  it("快照里有 profiles：服务有角色功能，表原样进状态", async () => {
    serve(snapshotOf({ profiles: roles }));
    await start();
    expect(store.get().ready).toBe(true);
    expect(profilesSupported(store.get().profiles)).toBe(true);
    expect(store.get().profiles).toEqual(roles);
  });

  it("快照里的 profiles 是空表：服务有这项功能、只是还没建角色——仍然是“支持”，不是标记", async () => {
    serve(snapshotOf({ profiles: { entries: [] } }));
    await start();
    expect(profilesSupported(store.get().profiles)).toBe(true);
    expect(store.get().profiles).not.toBe(PROFILES_UNSUPPORTED);
    expect(store.get().profiles.entries).toEqual([]);
  });

  it("快照里读不出角色（unavailable）也是有功能：这是“暂时不可用”，不是“老服务”", async () => {
    serve(snapshotOf({ profiles: { entries: [], unavailable: "unreadable_file" } }));
    await start();
    expect(profilesSupported(store.get().profiles)).toBe(true);
    expect(store.get().profiles.unavailable).toBe("unreadable_file");
  });

  it("老服务的快照没有 profiles 字段：放进“不支持”的标记，而不是一张空表", async () => {
    serve(snapshotOf());
    await start();
    expect(store.get().ready).toBe(true);
    expect(profilesSupported(store.get().profiles)).toBe(false);
    expect(store.get().profiles).toBe(PROFILES_UNSUPPORTED);
  });

  it("老服务反复发来的快照不会让这一项再变：标记始终是同一个对象", async () => {
    serve(snapshotOf());
    await start();
    const first = store.get().profiles;
    push({ type: "snapshot", snapshot: snapshotOf({ rev: 5 }) });
    expect(store.get().profiles).toBe(first);
    expect(first).toBe(PROFILES_UNSUPPORTED);
  });

  it("页面打开之后收到 profiles 推送：说明服务有这项功能，变回“支持”", async () => {
    serve(snapshotOf());
    await start();
    expect(profilesSupported(store.get().profiles)).toBe(false);

    push({ type: "profiles", profiles: roles });
    expect(profilesSupported(store.get().profiles)).toBe(true);
    expect(store.get().profiles).toEqual(roles);

    // 之后别的标签页把角色删光了，推来的是一张空表：仍是“有功能”，不会倒回标记。
    push({ type: "profiles", profiles: { entries: [] } });
    expect(profilesSupported(store.get().profiles)).toBe(true);
    expect(store.get().profiles.entries).toEqual([]);
  });

  it("重连后的快照以服务端为准：对面换成老服务就回到“不支持”，换回新服务又恢复", async () => {
    serve(snapshotOf({ profiles: roles }));
    await start();
    expect(profilesSupported(store.get().profiles)).toBe(true);

    push({ type: "snapshot", snapshot: snapshotOf() });
    expect(store.get().profiles).toBe(PROFILES_UNSUPPORTED);

    push({ type: "snapshot", snapshot: snapshotOf({ profiles: { entries: [] } }) });
    expect(profilesSupported(store.get().profiles)).toBe(true);
    expect(store.get().profiles).not.toBe(PROFILES_UNSUPPORTED);
  });
});
