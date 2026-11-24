import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { LIMITS } from "@shared/constants";
import type { StateSnapshot } from "@shared/protocol";
import { store } from "./app";
import { startLive } from "./live";

/** 可控的 EventSource：测试用 emit 模拟浏览器对连接的各种回应。 */
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

const snapshot: StateSnapshot = {
  rev: 0,
  serverTime: "2026-11-14T00:00:00.000Z",
  version: "test",
  protocol: 1,
  sessions: [],
  harnesses: [],
  capacity: { occupied: 0, max: LIMITS.maxConcurrentRuns, waiting: 0 },
  dev: false,
};

function reply(status: number, body: unknown) {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
}

const invalidToken = () => reply(403, { error: { code: "invalid_token", message: "Missing or invalid Ensemble token." } });

interface Server {
  /** 依次返回给 /api/state 的结果；用完后一直重复最后一个。函数表示网络失败。 */
  state: Array<() => ReturnType<typeof reply> | never>;
  calls: { state: number };
}

function fakeServer(server: Server): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (input.startsWith("/api/state")) {
        const step = server.state[Math.min(server.calls.state, server.state.length - 1)]!;
        server.calls.state += 1;
        return step();
      }
      throw new Error(`unexpected request ${input}`);
    }),
  );
}

const networkFailure = (): never => {
  throw new TypeError("fetch failed");
};

const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

describe("实时连接遇到失效的令牌", () => {
  let stop: (() => void) | undefined;
  let reload: Mock<() => void>;
  let server: Server;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    sessionStorage.clear();
    store.set({ conn: "connecting", ready: false });
    reload = vi.fn<() => void>();
    server = { state: [() => reply(200, snapshot)], calls: { state: 0 } };
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** 浏览器遇到非 200 回应时的行为：触发 error，且连接直接关闭（不会自己重连）。 */
  const rejectStream = (): void => {
    const source = FakeEventSource.instances.at(-1)!;
    source.readyState = FakeEventSource.CLOSED;
    source.emit("error");
  };

  it("首屏读取状态就被拒绝：直接整页刷新一次，并记下时间", async () => {
    server.state = [invalidToken];
    fakeServer(server);
    stop = startLive({ reload });
    await settle();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("ensemble:token-reload-at")).not.toBeNull();
  });

  it("页面从没连上过、连接被关闭，且令牌被拒绝：刷新页面，而不是用同一个令牌反复重开连接", async () => {
    // 首屏那次请求碰巧因网络失败而没有给出结论；之后连接被关闭，轮询时才问出令牌已失效。
    server.state = [networkFailure, invalidToken];
    fakeServer(server);
    stop = startLive({ reload });
    await settle();
    expect(reload).not.toHaveBeenCalled();

    rejectStream();
    expect(store.get().conn).toBe("offline");
    await settle(1000);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(1);

    // 刷新已经发起：不会再继续轮询或重开连接。
    const stateCalls = server.calls.state;
    await settle(20_000);
    expect(server.calls.state).toBe(stateCalls);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("刚刷新过令牌仍被拒绝：不再自动刷新，停在“连接已断开”，也不再重试", async () => {
    sessionStorage.setItem("ensemble:token-reload-at", String(Date.now() - 2_000));
    server.state = [invalidToken];
    fakeServer(server);
    stop = startLive({ reload });
    await settle();

    expect(reload).not.toHaveBeenCalled();
    expect(store.get().conn).toBe("offline");

    const stateCalls = server.calls.state;
    await settle(30_000);
    expect(server.calls.state).toBe(stateCalls);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("上一次刷新已经过去很久：令牌再次失效时可以再刷新一次", async () => {
    sessionStorage.setItem("ensemble:token-reload-at", String(Date.now() - 60_000));
    server.state = [invalidToken];
    fakeServer(server);
    stop = startLive({ reload });
    await settle();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("sessionStorage 不可用：无法防止刷新死循环，所以不自动刷新", async () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    server.state = [invalidToken];
    fakeServer(server);
    stop = startLive({ reload });
    await settle();

    expect(reload).not.toHaveBeenCalled();
    expect(store.get().conn).toBe("offline");
  });

  it("其他权限拒绝不当成过期令牌", async () => {
    server.state = [() => reply(403, { error: { code: "forbidden", message: "Unexpected Host" } })];
    fakeServer(server);
    stop = startLive({ reload });
    await settle();
    rejectStream();
    await settle(10_000);
    expect(reload).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("服务在已认证的 SSE 握手后立即重启时，旧令牌只触发一次刷新", async () => {
    fakeServer(server);
    stop = startLive({ reload });
    await settle();

    // 握手时令牌有效；执行到握手回调时，新的服务已启动并拒绝了旧令牌。
    server.state.push(invalidToken);
    FakeEventSource.instances[0]!.emit("open");
    await settle();
    rejectStream();
    await settle(1000);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("令牌有效、只是连接断了（同一个进程）：重新打开连接，不刷新页面", async () => {
    fakeServer(server);
    stop = startLive({ reload });
    await settle();

    // 页面没连上过，但令牌是好的：不能误判成令牌失效。
    rejectStream();
    await settle(1000);

    expect(reload).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(store.get().conn).toBe("reconnecting");
  });

  it("服务暂时连不上：继续等待，恢复后再判断", async () => {
    server.state = [() => reply(200, snapshot), networkFailure];
    fakeServer(server);
    stop = startLive({ reload });
    await settle();

    rejectStream();
    await settle(1000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(reload).not.toHaveBeenCalled();

    server.state.push(() => reply(200, snapshot));
    await settle(10_000);
    expect(reload).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(2);
  });
});
