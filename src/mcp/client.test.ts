import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ACCEPTS_HEADER } from "@shared/constants";
import { FixtureExecutor } from "../server/executors/fixture";
import { silentLogger } from "../server/logger";
import { startService, type RunningService } from "../server/service";
import { simulateOlderService } from "./bridge.fixtures";
import { ServiceClient } from "./client";

it("rediscovers the token after the service restarts on the same port, even for a write", async () => {
  const home = await mkdtemp(join(tmpdir(), "ensemble-client-"));
  const options = { home, executors: [new FixtureExecutor("pi", { speed: 0 })], webRoot: null, idleExitMs: 0, log: silentLogger };
  const first = await startService({ ...options, port: 0 });
  const fetchWithoutReuse: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("connection", "close");
    return fetch(input, { ...init, headers });
  };
  const client = new ServiceClient({
    paths: first.paths, fetchImpl: fetchWithoutReuse,
    ensure: async () => { throw new Error("The replacement service is already running"); },
  });
  try {
    await client.request("GET", "/api/sessions");
  } finally {
    await first.close();
  }

  const next = await startService({ ...options, port: first.port });
  try {
    await client.request("POST", "/api/sessions", { body: { harness: "pi", task: "[fixture:quick] After restart", cwd: home } });
    const result = await client.request<{ sessions: unknown[] }>("GET", "/api/sessions");
    expect(result.sessions).toHaveLength(1);
  } finally {
    await next.close();
  }
});

it("says on every request that this bridge understands questions, so a new service hands it question items (an older service ignores the header)", async () => {
  const home = await mkdtemp(join(tmpdir(), "ensemble-client-"));
  const service = await startService({ home, port: 0, executors: [new FixtureExecutor("pi", { speed: 0 })], webRoot: null, idleExitMs: 0, log: silentLogger });
  const sent: Array<Record<string, string>> = [];
  const client = new ServiceClient({
    paths: service.paths,
    fetchImpl: ((input, init) => {
      sent.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return fetch(input, init);
    }) satisfies typeof fetch,
    ensure: async () => { throw new Error("the service should already be running"); },
  });
  try {
    await client.request("GET", "/api/sessions");
    await client.request("POST", "/api/sessions", { body: { harness: "pi", task: "[fixture:quick] Header check", cwd: home } });
    const fromBridge = sent.filter((headers) => headers["x-ensemble-client"] === "mcp");
    expect(fromBridge.length).toBeGreaterThanOrEqual(2);
    // 读写请求都带；值就是服务公布的那个功能名（见 SERVICE_FEATURES）。
    for (const headers of fromBridge) expect(headers[ACCEPTS_HEADER]).toBe("session-questions");
  } finally {
    await service.close();
  }
});

// ───────────────────────── 重试时按新服务重新构造请求体（rebuildBody） ─────────────────────────

/** 不复用连接：服务重启之后，连接池里不能留着指向已关闭服务的连接，否则第一个请求撞上的是被掐断的连接，而不是“令牌被拒”。 */
const freshConnection: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("connection", "close");
  return fetch(input, { ...init, headers });
};

/**
 * 客户端连过一个服务，随后它在同一个端口上换成了另一个服务（新令牌）：客户端手里的令牌是旧的，
 * 下一个请求会先被拒绝，重新发现之后才送到。`older`：换上来的这个服务看起来是老版本（service.json 里没有 features，服务本身还是新的）。
 */
async function replacedService(older: boolean): Promise<{ client: ServiceClient; next: RunningService; home: string }> {
  const home = await mkdtemp(join(tmpdir(), "ensemble-client-"));
  const options = { home, executors: [new FixtureExecutor("pi", { speed: 0 })], webRoot: null, idleExitMs: 0, log: silentLogger };
  const first = await startService({ ...options, port: 0 });
  const client = new ServiceClient({
    paths: first.paths,
    fetchImpl: freshConnection,
    ensure: async () => { throw new Error("The replacement service is already running"); },
  });
  try {
    await client.request("GET", "/api/sessions");
  } finally {
    await first.close();
  }
  const next = await startService({ ...options, port: first.port });
  if (older) simulateOlderService(next);
  return { client, next, home };
}

const delegation = (home: string, task: string) => ({ harness: "pi", task: `[fixture:quick] ${task}`, cwd: home });

interface Listed {
  sessions: Array<{ taskPreview: string }>;
}

it("asks the caller to rebuild the request when the service it re-discovers declares other features than the one the request was written for", async () => {
  const { client, next, home } = await replacedService(true);
  try {
    let rebuilt = 0;
    await client.request("POST", "/api/sessions", {
      body: delegation(home, "Written for the old connection"),
      rebuildBody: async () => {
        rebuilt += 1;
        // 回调被调用时，客户端连着的已经是新服务：`supports` 读到的是它声明的功能（这里是什么都没有）。
        expect(client.supports("delegation-profiles")).toBe(false);
        return delegation(home, "Rebuilt for the new service");
      },
    });
    expect(rebuilt).toBe(1);
    const { sessions } = await client.request<Listed>("GET", "/api/sessions");
    expect(sessions.map((session) => session.taskPreview)).toEqual(["[fixture:quick] Rebuilt for the new service"]);
  } finally {
    await next.close();
  }
});

it("sends the request again as it was when the re-discovered service declares the same features (the usual case: it was only restarted)", async () => {
  const { client, next, home } = await replacedService(false);
  try {
    let rebuilt = 0;
    await client.request("POST", "/api/sessions", {
      body: delegation(home, "Sent again as it was"),
      rebuildBody: async () => {
        rebuilt += 1;
        return delegation(home, "Never used");
      },
    });
    expect(rebuilt).toBe(0);
    const { sessions } = await client.request<Listed>("GET", "/api/sessions");
    expect(sessions.map((session) => session.taskPreview)).toEqual(["[fixture:quick] Sent again as it was"]);
  } finally {
    await next.close();
  }
});

it("sends nothing to the new service when the caller refuses to rebuild the request", async () => {
  const { client, next, home } = await replacedService(true);
  try {
    await expect(
      client.request("POST", "/api/sessions", {
        body: delegation(home, "Written for the old connection"),
        rebuildBody: async () => {
          throw new Error("this request cannot be written for the older service");
        },
      }),
    ).rejects.toThrow("this request cannot be written for the older service");
    const { sessions } = await client.request<Listed>("GET", "/api/sessions");
    expect(sessions).toEqual([]);
  } finally {
    await next.close();
  }
});

it("does not ask for a rebuild when nothing had to be sent again", async () => {
  const home = await mkdtemp(join(tmpdir(), "ensemble-client-"));
  const service = await startService({ home, port: 0, executors: [new FixtureExecutor("pi", { speed: 0 })], webRoot: null, idleExitMs: 0, log: silentLogger });
  const client = new ServiceClient({
    paths: service.paths,
    ensure: async () => { throw new Error("the service should already be running"); },
  });
  try {
    let rebuilt = 0;
    await client.request("POST", "/api/sessions", {
      body: delegation(home, "First time"),
      rebuildBody: async () => {
        rebuilt += 1;
        return {};
      },
    });
    expect(rebuilt).toBe(0);
  } finally {
    await service.close();
  }
});

// ───────────────────────── “功能有没有变”的比较（sameFeatures）：个数一样内容不同、没有声明与空清单 ─────────────────────────

/** service.json 里的 `features`：一份清单；或 undefined——整个字段不写（老服务就是这样）。 */
type Declared = readonly string[] | undefined;
const UNDECLARED: Declared = undefined;

/** 改写服务写下的 service.json 里的 `features`：服务本身不变，客户端读到的只是这份文件。 */
async function declareFeatures(service: RunningService, declared: Declared): Promise<void> {
  const file = JSON.parse(await readFile(service.paths.serviceFile, "utf8")) as Record<string, unknown>;
  if (declared === undefined) delete file["features"];
  else file["features"] = declared;
  await writeFile(service.paths.serviceFile, JSON.stringify(file));
}

/**
 * 与 `replacedService` 是同一套换服务的做法：客户端连过一个服务，随后同一个端口上换成了另一个（新令牌）。
 * 区别是两边的功能清单由调用方写进各自的 service.json——这里要的是“个数一样内容不同”“没有声明与空清单”这类 `replacedService` 造不出来的组合。
 */
async function replacedServiceDeclaring(before: Declared, after: Declared): Promise<{ client: ServiceClient; next: RunningService; home: string }> {
  const home = await mkdtemp(join(tmpdir(), "ensemble-client-"));
  const options = { home, executors: [new FixtureExecutor("pi", { speed: 0 })], webRoot: null, idleExitMs: 0, log: silentLogger };
  const first = await startService({ ...options, port: 0 });
  const client = new ServiceClient({
    paths: first.paths,
    fetchImpl: freshConnection,
    ensure: async () => { throw new Error("The replacement service is already running"); },
  });
  try {
    await declareFeatures(first, before);
    await client.request("GET", "/api/sessions");
  } finally {
    await first.close();
  }
  // 前提：客户端手里记的是 `before` 声明的功能，重新发现之后拿来比较的就是它和 `after`。
  expect(client.current()?.features).toEqual(before);
  const next = await startService({ ...options, port: first.port });
  await declareFeatures(next, after);
  return { client, next, home };
}

/** 重新发现之后功能没有变：不请求重建，原来的请求体原样重发，进的是换上来的服务。 */
async function expectSentAgainAsItWas(before: Declared, after: Declared): Promise<void> {
  const { client, next, home } = await replacedServiceDeclaring(before, after);
  try {
    let rebuilt = 0;
    await client.request("POST", "/api/sessions", {
      body: delegation(home, "Sent again as it was"),
      rebuildBody: async () => {
        rebuilt += 1;
        return delegation(home, "Never used");
      },
    });
    expect(rebuilt).toBe(0);
    // 重新发现确实发生了，读到的就是 `after` 声明的那一份（空清单没有被当成“没有这个字段”，否则这里比的就不是这两种声明）。
    expect(client.current()?.features).toEqual(after);
    const { sessions } = await client.request<Listed>("GET", "/api/sessions");
    expect(sessions.map((session) => session.taskPreview)).toEqual(["[fixture:quick] Sent again as it was"]);
  } finally {
    await next.close();
  }
}

it("asks for a rebuild when the service it re-discovers declares as many features as before, but not the same ones", async () => {
  // 两边都是 2 个功能、其中一个换了：只比个数会把它们当成同一个服务，请求体就原样发给了能力不同的服务。
  const { client, next, home } = await replacedServiceDeclaring(["multi-parent", "session-questions"], ["multi-parent", "session-report"]);
  try {
    let rebuilt = 0;
    await client.request("POST", "/api/sessions", {
      body: delegation(home, "Written for the first service"),
      rebuildBody: async () => {
        rebuilt += 1;
        // 回调被调用时，客户端连着的已经是换上来的服务：读到的是它声明的那一份。
        expect(client.current()?.features).toEqual(["multi-parent", "session-report"]);
        return delegation(home, "Rebuilt for the service that declares other features");
      },
    });
    expect(rebuilt).toBe(1);
    const { sessions } = await client.request<Listed>("GET", "/api/sessions");
    // 创建出来的是回调给的那一份，不是原来的请求体。
    expect(sessions.map((session) => session.taskPreview)).toEqual(["[fixture:quick] Rebuilt for the service that declares other features"]);
  } finally {
    await next.close();
  }
});

it("sends the request again as it was when the first service declared no features and the one it finds declares an empty list", () =>
  // 没有声明（老服务）与空清单都是“什么都不支持”，算一样。
  expectSentAgainAsItWas(UNDECLARED, []));

it("sends the request again as it was when the first service declared an empty list and the one it finds declares no features", () =>
  expectSentAgainAsItWas([], UNDECLARED));

it("sends the request again as it was when the service it finds declares the same features in another order", () =>
  // 清单里的先后没有意义：同一批功能，写下来的顺序不同，算同一个服务。
  expectSentAgainAsItWas(["multi-parent", "session-questions"], ["session-questions", "multi-parent"]));
