/**
 * 仅供测试使用：经真实本地 HTTP 测服务的套件（service*.test.ts）与 MCP 桥套件（bridge*.test.ts，见 mcp/bridge.fixtures.ts）共用的夹具：
 * 临时状态目录里的真服务、带令牌的 API 客户端、SSE 帧解析器。
 *
 * 服务由 `boot` 登记，测试文件里写一次 `afterEach(closeServices)` 收尾（桥套件用 `closeTestBridges`：先关 MCP 客户端，再调用这里）。
 * 每个服务都用自己的临时目录和系统分配的端口（端口 0），从不碰真实的服务与数据；登记表每个测试文件各有一份。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOKEN_HEADER } from "@shared/constants";
import type { StreamMessage } from "@shared/protocol";
import { FixtureExecutor } from "./executors/fixture";
import type { Executor } from "./executors/types";
import { silentLogger } from "./logger";
import { startService, type RunningService, type StartServiceOptions } from "./service";

const running: RunningService[] = [];

/** 关掉 `boot` 起的全部服务（后起的先关）。 */
export async function closeServices(): Promise<void> {
  while (running.length > 0) await running.pop()!.close("test");
}

/** 测试里的“重启”：关掉一个服务（之后用同一个 home 再 `boot` 一次），并从登记里去掉它，收尾时不会再关第二遍。 */
export async function stopService(service: RunningService, reason = "restart"): Promise<void> {
  await service.close(reason);
  const index = running.indexOf(service);
  if (index >= 0) running.splice(index, 1);
}

export function tempHome(prefix = "ensemble-home-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 两个不等待的模拟执行端：`boot` 缺省用它们，免得误起真实的执行端。 */
export function fixtureExecutors(): Executor[] {
  return [new FixtureExecutor("pi", { speed: 0 }), new FixtureExecutor("cursor", { speed: 0 })];
}

export interface BootOptions extends Omit<StartServiceOptions, "home"> {
  /** 不传就新建一个临时目录；传已有的 home，就是在同一份状态上再起一次服务。 */
  home?: string;
  /** 新建临时目录时的名字前缀（只是方便从目录名认出是哪个套件留下的）。 */
  homePrefix?: string;
}

/**
 * 起一个真服务。缺省：新的临时 home、系统分配的端口、`fixtureExecutors()`、静默日志、不托管网页、不自动退出。
 * 其余选项原样交给 `startService`；`env` 不传就沿用 `process.env`，要不要隔离由各套件自己决定。
 */
export async function boot(options: BootOptions = {}): Promise<RunningService> {
  const { home, homePrefix, ...rest } = options;
  const service = await startService({
    ...rest,
    home: home ?? tempHome(homePrefix),
    port: rest.port ?? 0,
    executors: rest.executors ?? fixtureExecutors(),
    log: rest.log ?? silentLogger,
    webRoot: rest.webRoot ?? null,
    idleExitMs: rest.idleExitMs ?? 0,
  });
  running.push(service);
  return service;
}

export interface Api {
  get(path: string, init?: RequestInit): Promise<Response>;
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  put(path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  json<T>(response: Response): Promise<T>;
}

/** 带访问令牌与 JSON 头的 API 客户端；`post` / `put` 的第三个参数追加（或覆盖）请求头。 */
export function api(service: RunningService): Api {
  const headers = { [TOKEN_HEADER]: service.token, "content-type": "application/json" };
  return {
    get: (path, init) => fetch(`${service.url}${path}`, { ...init, headers: { ...headers, ...init?.headers } }),
    post: (path, body, extra) =>
      fetch(`${service.url}${path}`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body ?? {}) }),
    put: (path, body, extra) =>
      fetch(`${service.url}${path}`, { method: "PUT", headers: { ...headers, ...extra }, body: JSON.stringify(body ?? {}) }),
    json: async <T>(response: Response) => (await response.json()) as T,
  };
}

export interface SseFrame {
  message: StreamMessage;
  /** `id:` 行的原文（`<启动标识>:<rev>`，续传时原样放进 Last-Event-ID）。hello 这类不带 id 的消息没有。 */
  rawId?: string;
  /** `rawId` 里冒号后面的修订号。 */
  rev?: number;
}

/** 带 `id:` 的帧：SSE 的续传游标只认这样的帧。 */
export interface IdentifiedSseFrame extends SseFrame {
  rawId: string;
  rev: number;
}

export interface SseStream {
  response: Response;
  /** 收到的全部消息，按到达顺序（含不带 id 的）。 */
  frames: SseFrame[];
  /** 只要带 `id:` 的帧，按到达顺序。 */
  identified(): IdentifiedSseFrame[];
  /** 主动断开连接。 */
  close(): void;
}

/** 解析一帧（两个换行之间的文本）。没有 `data:` 行的（例如只有 `retry:`）不是消息，返回 undefined。 */
export function parseSseFrame(raw: string): SseFrame | undefined {
  const lines = raw.split("\n");
  const data = lines.find((line) => line.startsWith("data: "));
  if (data === undefined) return undefined;
  const id = lines.find((line) => line.startsWith("id: "));
  const message = JSON.parse(data.slice(6)) as StreamMessage;
  if (id === undefined) return { message };
  const rawId = id.slice(4);
  return { message, rawId, rev: Number(rawId.split(":")[1]) };
}

function isIdentified(frame: SseFrame): frame is IdentifiedSseFrame {
  return frame.rawId !== undefined;
}

/** 极简 SSE 客户端：连上 `/api/stream`，把收到的帧收进 `frames`；带 `lastEventId` 就按它续传。用完要 `close()`。 */
export async function openStream(service: RunningService, lastEventId?: string): Promise<SseStream> {
  const controller = new AbortController();
  const response = await fetch(`${service.url}/api/stream?token=${service.token}`, {
    signal: controller.signal,
    headers: lastEventId !== undefined ? { "last-event-id": lastEventId } : {},
  });
  const frames: SseFrame[] = [];
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
          const frame = parseSseFrame(buffer.slice(0, index));
          buffer = buffer.slice(index + 2);
          if (frame) frames.push(frame);
        }
      }
    } catch {
      // 连接被主动中止。
    }
  })();
  return { response, frames, identified: () => frames.filter(isIdentified), close: () => controller.abort() };
}
