import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV, LIMITS, TOKEN_HEADER } from "@shared/constants";
import type { SetConcurrencyResponse, StateSnapshot, StreamMessage } from "@shared/protocol";
import { testOrigin } from "@shared/testing";
import { silentLogger, type Logger } from "./logger";
import type { ManagerConfig } from "./manager";
import { UNLIMITED_RUNS } from "./run-slots";
import { startService, type RunningService } from "./service";
import { ManualExecutor, until } from "./testing";

// 设置窗口里的“并发上限”在服务这一层的行为：启动时的优先级、运行中改写（立即生效）、落盘与重启、
// HTTP 入口的校验与防护，以及推给所有页面的 capacity 消息。run-slots / settings / concurrency 各自的单元测试在旁边的文件里。

const running: RunningService[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()!.close("test");
});

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "ensemble-home-"));
}

interface BootOptions {
  home?: string;
  /** 一律显式传入：不读测试进程自己的环境变量，结果才不会因机器而异。 */
  env?: NodeJS.ProcessEnv;
  executor?: ManualExecutor;
  managerConfig?: Partial<ManagerConfig>;
  log?: Logger;
}

async function boot(options: BootOptions = {}): Promise<RunningService> {
  const service = await startService({
    home: options.home ?? tempHome(),
    port: 0,
    executors: [options.executor ?? new ManualExecutor("pi")],
    log: options.log ?? silentLogger,
    webRoot: null,
    idleExitMs: 0,
    env: options.env ?? {},
    ...(options.managerConfig ? { managerConfig: options.managerConfig } : {}),
  });
  running.push(service);
  return service;
}

/** 启动前就放在状态目录里的 settings.json（对象会被序列化，字符串原样写入）。返回文件路径。 */
function seed(home: string, contents: unknown): string {
  const file = join(home, "settings.json");
  writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  return file;
}

function api(service: RunningService) {
  const headers = { [TOKEN_HEADER]: service.token, "content-type": "application/json" };
  return {
    get: (path: string) => fetch(`${service.url}${path}`, { headers }),
    put: (path: string, body: unknown, extra: Record<string, string> = {}) =>
      fetch(`${service.url}${path}`, { method: "PUT", headers: { ...headers, ...extra }, body: JSON.stringify(body) }),
    json: async <T>(response: Response) => (await response.json()) as T,
  };
}

const PATH = "/api/settings/concurrency";

/** 浏览器里别的网页发来的写请求会带这样的 Origin；MCP 桥与脚本不带。 */
const FOREIGN = { origin: "https://evil.example.com" };

/** 极简 SSE 客户端：读取并解析帧里的消息。 */
async function openStream(service: RunningService) {
  const controller = new AbortController();
  const response = await fetch(`${service.url}/api/stream?token=${service.token}`, { signal: controller.signal });
  const messages: StreamMessage[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const raw = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const data = raw.split("\n").find((line) => line.startsWith("data: "));
          if (data) messages.push(JSON.parse(data.slice(6)) as StreamMessage);
        }
      }
    } catch {
      // 连接被主动中止。
    }
  })();
  return { messages, close: () => controller.abort() };
}

type CapacityMessage = Extract<StreamMessage, { type: "capacity" }>;
const capacityMessages = (stream: { messages: StreamMessage[] }): CapacityMessage[] =>
  stream.messages.filter((message): message is CapacityMessage => message.type === "capacity");

describe("启动时的并发上限：managerConfig > settings.json > 环境变量 > 默认值", () => {
  it("什么都没配置：内置默认 20，来源写 default", async () => {
    const service = await boot();
    expect(service.manager.capacity()).toEqual({ occupied: 0, max: LIMITS.maxConcurrentRuns, waiting: 0 });
    expect(service.concurrency.view()).toEqual({ source: "default", inherited: { max: 20, source: "default" } });
  });

  it("只有环境变量：用它，来源写 env（0 与 unlimited 都是不限制）", async () => {
    const eight = await boot({ env: { [ENV.maxConcurrentRuns]: "8" } });
    expect(eight.manager.capacity().max).toBe(8);
    expect(eight.concurrency.view()).toEqual({ source: "env", inherited: { max: 8, source: "env" } });

    const off = await boot({ env: { [ENV.maxConcurrentRuns]: "unlimited" } });
    expect(off.manager.capacity().max).toBe(UNLIMITED_RUNS);
    expect(off.concurrency.view()).toMatchObject({ source: "env", inherited: { max: UNLIMITED_RUNS, source: "env" } });
  });

  it("settings.json 压过环境变量，环境变量留在 inherited 里（“恢复默认”会回到它）", async () => {
    const home = tempHome();
    seed(home, { version: 1, harnesses: {}, maxConcurrentRuns: 4 });
    const service = await boot({ home, env: { [ENV.maxConcurrentRuns]: "9" } });
    expect(service.manager.capacity().max).toBe(4);
    expect(service.concurrency.view()).toEqual({ source: "settings", stored: 4, inherited: { max: 9, source: "env" } });
  });

  it("settings.json 里写 unlimited：不设上限", async () => {
    const home = tempHome();
    seed(home, { version: 1, harnesses: {}, maxConcurrentRuns: "unlimited" });
    const service = await boot({ home, env: { [ENV.maxConcurrentRuns]: "3" } });
    expect(service.manager.capacity().max).toBe(UNLIMITED_RUNS);
    expect(service.concurrency.view()).toMatchObject({ source: "settings", stored: "unlimited" });
  });

  it("启动方显式给定的 managerConfig 压过一切；页面上标成 startup，文件里存的值仍如实给出", async () => {
    const home = tempHome();
    seed(home, { version: 1, harnesses: {}, maxConcurrentRuns: 7 });
    const service = await boot({ home, env: { [ENV.maxConcurrentRuns]: "9" }, managerConfig: { maxConcurrentRuns: 2 } });
    expect(service.manager.capacity().max).toBe(2);
    expect(service.concurrency.view()).toEqual({ source: "startup", stored: 7, inherited: { max: 9, source: "env" } });
  });

  it("文件里的值无效：服务照常启动、落回环境变量，文件原样保留，页面能看到“值无效”", async () => {
    const home = tempHome();
    const raw = JSON.stringify({ version: 1, harnesses: {}, maxConcurrentRuns: -3 });
    const file = seed(home, raw);
    const service = await boot({ home, env: { [ENV.maxConcurrentRuns]: "6" } });
    expect(service.manager.capacity().max).toBe(6);
    expect(service.concurrency.view()).toEqual({ source: "env", inherited: { max: 6, source: "env" }, issue: "invalid_value" });
    expect(readFileSync(file, "utf8")).toBe(raw);
  });

  it("设置文件整个读不了：落回环境变量 / 默认，标明读不了，文件原样保留，服务照常运行", async () => {
    const home = tempHome();
    const file = seed(home, "{ not json");
    const service = await boot({ home });
    expect(service.manager.capacity().max).toBe(20);
    expect(service.concurrency.view()).toEqual({ source: "default", inherited: { max: 20, source: "default" }, issue: "unreadable_file" });
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("环境变量写得无法解析：回到默认，只记一行警告，不挡启动", async () => {
    const warn = vi.fn();
    const log: Logger = { ...silentLogger, warn, child: () => log };
    const service = await boot({ env: { [ENV.maxConcurrentRuns]: "abc" }, log });
    expect(service.manager.capacity().max).toBe(20);
    expect(service.concurrency.view().source).toBe("default");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(ENV.maxConcurrentRuns), expect.objectContaining({ value: "abc", fallback: 20 }));
  });

  it("启动日志写明生效的上限与来源", async () => {
    const info = vi.fn();
    const log: Logger = { ...silentLogger, info, child: () => log };
    const home = tempHome();
    seed(home, { version: 1, harnesses: {}, maxConcurrentRuns: "unlimited" });
    await boot({ home, env: { [ENV.maxConcurrentRuns]: "5" }, log });
    expect(info).toHaveBeenCalledWith("service started", expect.objectContaining({ maxConcurrentRuns: "unlimited", maxConcurrentRunsSource: "settings" }));

    const second = vi.fn();
    const secondLog: Logger = { ...silentLogger, info: second, child: () => secondLog };
    await boot({ env: { [ENV.maxConcurrentRuns]: "5" }, log: secondLog });
    expect(second).toHaveBeenCalledWith("service started", expect.objectContaining({ maxConcurrentRuns: 5, maxConcurrentRunsSource: "env" }));
  });
});

describe("PUT /api/settings/concurrency", () => {
  it("运行中立即生效、不必重启：调高让排队的会话开始，调低不打断正在跑的，之后只有占用降到新上限以下才补位", async () => {
    const executor = new ManualExecutor("pi");
    const service = await boot({ executor, env: { [ENV.maxConcurrentRuns]: "1" } });
    const client = api(service);
    const delegate = (task: string) => service.manager.delegate({ harness: "pi", task, cwd: tmpdir(), origin: testOrigin() });
    const sessionOf = (sessionId: string) => executor.sessions.find((session) => session.input.meta.id === sessionId)!;

    const first = await delegate("first");
    const second = await delegate("second");
    const third = await delegate("third");
    await until(() => executor.sessions.length === 1, 4000, "the first session opened");
    expect(service.manager.capacity()).toEqual({ occupied: 1, max: 1, waiting: 2 });

    const raised = await client.put(PATH, { max: 3 });
    expect(raised.status).toBe(200);
    // 回执里已经是生效后的上限，所以页面不需要再猜。
    expect((await client.json<SetConcurrencyResponse>(raised)).capacity.max).toBe(3);
    await until(() => executor.sessions.length === 3, 4000, "the two queued sessions started");
    expect(service.manager.capacity()).toEqual({ occupied: 3, max: 3, waiting: 0 });

    // 调低：三个都还在跑，没有谁被取消，占用数暂时高于上限；新委派排队。
    expect((await client.put(PATH, { max: 1 })).status).toBe(200);
    expect(service.manager.capacity()).toEqual({ occupied: 3, max: 1, waiting: 0 });
    expect(executor.sessions.every((session) => session.cancelled.length === 0)).toBe(true);
    const fourth = await delegate("fourth");
    await until(() => service.hub.state(fourth.sessionId)?.status === "queued", 4000, "the fourth session queued");
    expect(service.manager.capacity()).toEqual({ occupied: 3, max: 1, waiting: 1 });

    sessionOf(first.sessionId).complete(first.runId);
    await until(() => service.manager.capacity().occupied === 2, 4000, "the first slot released");
    sessionOf(second.sessionId).complete(second.runId);
    await until(() => service.manager.capacity().occupied === 1, 4000, "the second slot released");
    expect(executor.sessions).toHaveLength(3);
    expect(service.hub.state(fourth.sessionId)?.status).toBe("queued");

    sessionOf(third.sessionId).complete(third.runId);
    await until(() => executor.sessions.length === 4, 4000, "the fourth started once occupancy fell under the lowered limit");
    expect(service.manager.capacity()).toEqual({ occupied: 1, max: 1, waiting: 0 });
  });

  it("改成不限制会让所有排队的会话立刻开始，null 恢复默认（回到环境变量）", async () => {
    const executor = new ManualExecutor("pi");
    const service = await boot({ executor, env: { [ENV.maxConcurrentRuns]: "1" } });
    const client = api(service);
    const delegate = (task: string) => service.manager.delegate({ harness: "pi", task, cwd: tmpdir(), origin: testOrigin() });
    await delegate("a");
    await delegate("b");
    await delegate("c");
    await until(() => executor.sessions.length === 1, 4000, "one session opened");

    const unlimited = await client.json<SetConcurrencyResponse>(await client.put(PATH, { max: "unlimited" }));
    expect(unlimited).toEqual({
      capacity: { occupied: expect.any(Number), max: 0, waiting: expect.any(Number) },
      concurrency: { source: "settings", stored: "unlimited", inherited: { max: 1, source: "env" } },
    });
    await until(() => executor.sessions.length === 3, 4000, "everybody started");
    expect(service.manager.capacity()).toEqual({ occupied: 3, max: UNLIMITED_RUNS, waiting: 0 });

    const restored = await client.json<SetConcurrencyResponse>(await client.put(PATH, { max: null }));
    expect(restored.concurrency).toEqual({ source: "env", inherited: { max: 1, source: "env" } });
    expect(restored.capacity).toEqual({ occupied: 3, max: 1, waiting: 0 });
    expect(JSON.parse(readFileSync(join(service.paths.home, "settings.json"), "utf8"))).toEqual({ version: 1, harnesses: {} });
  });

  it("GET /api/state 的快照带着这项设置；/api/health 的容量形状没有变，也不带设置", async () => {
    const service = await boot({ env: { [ENV.maxConcurrentRuns]: "12" } });
    const client = api(service);
    await client.put(PATH, { max: 5 });

    const snapshot = await client.json<StateSnapshot>(await client.get("/api/state"));
    expect(snapshot.capacity).toEqual({ occupied: 0, max: 5, waiting: 0 });
    expect(snapshot.concurrency).toEqual({ source: "settings", stored: 5, inherited: { max: 12, source: "env" } });

    const health = (await (await fetch(`${service.url}/api/health`)).json()) as Record<string, unknown>;
    expect(health["capacity"]).toEqual({ occupied: 0, max: 5, waiting: 0 });
    expect(health).not.toHaveProperty("concurrency");
  });

  it("写进 settings.json，同一个状态目录重新启动（相当于服务重启）后仍是它，且压过环境变量", async () => {
    const home = tempHome();
    const first = await boot({ home });
    expect((await api(first).put(PATH, { max: 5 })).status).toBe(200);
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8"))).toEqual({ version: 1, harnesses: {}, maxConcurrentRuns: 5 });
    await first.close("test");

    const second = await boot({ home, env: { [ENV.maxConcurrentRuns]: "9" } });
    expect(second.manager.capacity().max).toBe(5);
    expect(second.concurrency.view()).toMatchObject({ source: "settings", stored: 5, inherited: { max: 9, source: "env" } });
  });

  it("每次真的改了上限记一行日志（旧值、新值、来源），没变化不记", async () => {
    const info = vi.fn();
    const log: Logger = { ...silentLogger, info, child: () => log };
    const service = await boot({ log });
    const client = api(service);
    await client.put(PATH, { max: 3 });
    expect(info).toHaveBeenCalledWith("concurrency limit changed", expect.objectContaining({ from: 20, to: 3, source: "settings" }));

    const before = info.mock.calls.filter(([message]) => message === "concurrency limit changed").length;
    await client.put(PATH, { max: 3 });
    expect(info.mock.calls.filter(([message]) => message === "concurrency limit changed")).toHaveLength(before);

    await client.put(PATH, { max: "unlimited" });
    expect(info).toHaveBeenCalledWith("concurrency limit changed", expect.objectContaining({ from: 3, to: "unlimited", source: "settings" }));
  });

  const badBodies: Array<[string, unknown]> = [
    ["缺少 max", {}],
    ["0", { max: 0 }],
    ["负数", { max: -1 }],
    ["小数", { max: 2.5 }],
    ["超出 1000", { max: 1001 }],
    ["字符串形式的数字", { max: "8" }],
    ["大小写不对的 unlimited", { max: "Unlimited" }],
    ["布尔值", { max: true }],
    ["数组", { max: [] }],
  ];
  it.each(badBodies)("%s：400 invalid_request，设置、上限与文件都不变", async (_label, body) => {
    const home = tempHome();
    const service = await boot({ home });
    const client = api(service);
    expect((await client.put(PATH, { max: 6 })).status).toBe(200);
    const before = readFileSync(join(home, "settings.json"), "utf8");

    const response = await client.put(PATH, body);
    expect(response.status).toBe(400);
    expect(await client.json(response)).toMatchObject({ error: { code: "invalid_request" } });
    expect(service.manager.capacity().max).toBe(6);
    expect(readFileSync(join(home, "settings.json"), "utf8")).toBe(before);
  });

  it("要令牌，也要过 Origin 检查：别的网页不能借浏览器替用户改；同源的网页可以", async () => {
    const service = await boot();
    const client = api(service);

    const anonymous = await fetch(`${service.url}${PATH}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ max: 2 }) });
    expect(anonymous.status).toBe(403);
    const foreign = await client.put(PATH, { max: 2 }, FOREIGN);
    expect(foreign.status).toBe(403);
    expect(await client.json(foreign)).toMatchObject({ error: { code: "forbidden" } });
    expect(service.manager.capacity().max).toBe(20);
    expect(service.concurrency.view().source).toBe("default");

    const sameOrigin = await client.put(PATH, { max: 2 }, { origin: service.url });
    expect(sameOrigin.status).toBe(200);
    expect(service.manager.capacity().max).toBe(2);
  });

  it("启动方显式给定了上限时拒绝（409 conflict）：这时改设置改变不了任何事，不能假装成功；文件不被写", async () => {
    const home = tempHome();
    const service = await boot({ home, managerConfig: { maxConcurrentRuns: 2 } });
    const response = await api(service).put(PATH, { max: 9 });
    expect(response.status).toBe(409);
    expect(await api(service).json(response)).toMatchObject({ error: { code: "conflict" } });
    expect(service.manager.capacity().max).toBe(2);
    expect(service.concurrency.view().source).toBe("startup");
    expect(() => readFileSync(join(home, "settings.json"), "utf8")).toThrow();
  });

  it("设置文件读不了时拒绝（409 conflict），文件原样保留", async () => {
    const home = tempHome();
    const file = seed(home, "{ not json");
    const service = await boot({ home, env: { [ENV.maxConcurrentRuns]: "4" } });
    const response = await api(service).put(PATH, { max: 9 });
    expect(response.status).toBe(409);
    expect(service.manager.capacity().max).toBe(4);
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("文件里原来的值无效时，页面里重新设置就能修好它，上限随即生效", async () => {
    const home = tempHome();
    const file = seed(home, { version: 1, harnesses: {}, maxConcurrentRuns: "many" });
    const service = await boot({ home });
    expect(service.concurrency.view().issue).toBe("invalid_value");

    const response = await api(service).json<SetConcurrencyResponse>(await api(service).put(PATH, { max: 7 }));
    expect(response.concurrency).toEqual({ source: "settings", stored: 7, inherited: { max: 20, source: "default" } });
    expect(service.manager.capacity().max).toBe(7);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, harnesses: {}, maxConcurrentRuns: 7 });
  });
});

describe("推给页面的 capacity 消息", () => {
  it("快照里带着这项设置，设置一变就推一条：名额账目与设置成对给", async () => {
    const service = await boot({ env: { [ENV.maxConcurrentRuns]: "10" } });
    const stream = await openStream(service);
    try {
      await until(() => stream.messages.some((message) => message.type === "snapshot"), 4000, "the snapshot");
      const snapshot = stream.messages.find((message): message is Extract<StreamMessage, { type: "snapshot" }> => message.type === "snapshot")!.snapshot;
      expect(snapshot.capacity).toEqual({ occupied: 0, max: 10, waiting: 0 });
      expect(snapshot.concurrency).toEqual({ source: "env", inherited: { max: 10, source: "env" } });
      expect(capacityMessages(stream)).toHaveLength(0);

      await api(service).put(PATH, { max: 3 });
      await until(() => capacityMessages(stream).length === 1, 4000, "the capacity message");
      expect(capacityMessages(stream)[0]).toEqual({
        type: "capacity",
        capacity: { occupied: 0, max: 3, waiting: 0 },
        concurrency: { source: "settings", stored: 3, inherited: { max: 10, source: "env" } },
      });

      await api(service).put(PATH, { max: null });
      await until(() => capacityMessages(stream).length === 2, 4000, "the second capacity message");
      expect(capacityMessages(stream)[1]).toMatchObject({
        capacity: { max: 10 },
        concurrency: { source: "env" },
      });
    } finally {
      stream.close();
    }
  });

  it("会话占用与等待的变化也推，内容没变就不推（不是心跳，也不随每个会话事件刷屏）", async () => {
    const executor = new ManualExecutor("pi");
    const service = await boot({ executor, env: { [ENV.maxConcurrentRuns]: "1" } });
    const stream = await openStream(service);
    try {
      await until(() => stream.messages.some((message) => message.type === "snapshot"), 4000, "the snapshot");
      const delegate = (task: string) => service.manager.delegate({ harness: "pi", task, cwd: tmpdir(), origin: testOrigin() });
      const first = await delegate("first");
      await delegate("second");
      await until(() => capacityMessages(stream).at(-1)?.capacity.waiting === 1, 4000, "one session waiting");
      expect(capacityMessages(stream).at(-1)?.capacity).toEqual({ occupied: 1, max: 1, waiting: 1 });

      await until(() => executor.sessions.length === 1, 4000, "the first session opened");
      executor.sessions[0]!.complete(first.runId);
      await until(() => {
        const last = capacityMessages(stream).at(-1)?.capacity;
        return last?.occupied === 1 && last.waiting === 0;
      }, 4000, "the waiting session took the slot");

      // 没有两条相邻的 capacity 消息内容完全一样。
      const keys = capacityMessages(stream).map((message) => JSON.stringify([message.capacity, message.concurrency]));
      expect(keys.length).toBeGreaterThanOrEqual(2);
      for (let index = 1; index < keys.length; index += 1) expect(keys[index]).not.toBe(keys[index - 1]);
    } finally {
      stream.close();
    }
  });

  it("设置变了以后才连上的页面，快照里已经是新设置", async () => {
    const service = await boot();
    await api(service).put(PATH, { max: "unlimited" });
    const stream = await openStream(service);
    try {
      await until(() => stream.messages.some((message) => message.type === "snapshot"), 4000, "the snapshot");
      const snapshot = stream.messages.find((message): message is Extract<StreamMessage, { type: "snapshot" }> => message.type === "snapshot")!.snapshot;
      expect(snapshot.capacity.max).toBe(UNLIMITED_RUNS);
      expect(snapshot.concurrency).toMatchObject({ source: "settings", stored: "unlimited" });
    } finally {
      stream.close();
    }
  });
});
