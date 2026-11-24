import { randomBytes } from "node:crypto";
import http from "node:http";
import { StringDecoder } from "node:string_decoder";
import { clip, errorMessage, tail } from "@shared/format";
import { HarnessStartError, asRecord, str, type Json } from "./common";
import type { OpenCodeLaunch } from "./opencode-launch";
import { redact } from "./opencode-items";
import { spawnJsonl, type JsonlProcess } from "./process";

/**
 * OpenCode 的 HTTP / SSE 通道（V2，按 2.3.0 核对）。
 *
 * 每个 Ensemble 会话独占一个 `opencode serve --stdio` 进程：
 * - 端口让系统挑（`--port 0`），启动后它在 stdout 打印一行 `{"url":"http://127.0.0.1:端口"}`；
 * - 密码是每个进程随机生成的，只经环境变量 `OPENCODE_PASSWORD` 交给它（HTTP Basic，用户名固定 opencode），
 *   所以同一台机器上别的程序即使扫到端口也进不来；
 * - stdin 就是它的生命线：我们这一端一关（或整个服务崩溃），它自己就退出。
 * 不连用户已经开着的那个共享服务：那个服务的会话、权限和配置都归用户，Ensemble 不该混进去。
 */

const ANNOUNCE_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 15_000;
/** OpenCode 每 15 秒发一次心跳注释帧；连续三个周期没有任何字节，说明连接已经死了。 */
const STREAM_IDLE_MS = 45_000;
const MAX_FRAME_CHARS = 8_000_000;

export interface OpenCodeEvent {
  type: string;
  data: Json;
}

export class OpenCodeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OpenCodeHttpError";
  }
}

/** 密码只发给本机：公告里的地址不是环回地址就不用它（防止被异常输出骗去把凭据发到别处）。 */
export function loopbackUrl(text: string): URL | undefined {
  try {
    const url = new URL(text);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return url.protocol === "http:" && (host === "127.0.0.1" || host === "localhost" || host === "::1") ? url : undefined;
  } catch {
    return undefined;
  }
}

export class OpenCodeClient {
  private readonly authorization: string;
  private readonly inflight = new Set<http.ClientRequest>();
  private failure: Error | undefined;

  constructor(
    private readonly base: URL,
    password: string,
  ) {
    this.authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  }

  /** 发一个 JSON 请求。非 2xx 抛 `OpenCodeHttpError`（消息已脱敏、截断），204 返回 undefined。 */
  request(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.failure) return reject(this.failure);
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
      const req = http.request(
        {
          hostname: this.base.hostname.replace(/^\[|\]$/g, ""),
          port: this.base.port,
          path,
          method,
          agent: false,
          headers: {
            authorization: this.authorization,
            accept: "application/json",
            ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
          },
        },
        (res) => {
          const decoder = new StringDecoder("utf8");
          let text = "";
          res.on("data", (chunk: Buffer) => {
            text += decoder.write(chunk);
          });
          res.on("end", () => {
            this.inflight.delete(req);
            text += decoder.end();
            let parsed: unknown;
            try {
              parsed = text.length > 0 ? JSON.parse(text) : undefined;
            } catch {
              parsed = undefined;
            }
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) return resolve(parsed);
            const detail = str(asRecord(parsed)?.["message"]) ?? str(asRecord(asRecord(parsed)?.["error"])?.["message"]) ?? text;
            reject(new OpenCodeHttpError(status, clip(redact(`${method} ${path} → ${status}${detail ? `: ${detail}` : ""}`), 400)));
          });
          res.on("error", reject);
        },
      );
      this.inflight.add(req);
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`${method} ${path} timed out after ${Math.round(timeoutMs / 1000)}s`)));
      req.on("error", (error) => {
        this.inflight.delete(req);
        reject(error);
      });
      req.end(payload);
    });
  }

  /**
   * 订阅 `/api/event`（SSE）。收到第一帧 `server.connected` 才算连上；之后每个事件交给 `onEvent`，
   * 连接结束（或心跳中断）调用一次 `onClose`。调用 `failAll` 主动结束时不会触发 `onClose` 的错误。
   */
  subscribe(onEvent: (event: OpenCodeEvent) => void, onClose: (error: Error | undefined) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.failure) return reject(this.failure);
      let connected = false;
      let closed = false;
      const finish = (error: Error | undefined): void => {
        if (closed) return;
        closed = true;
        this.inflight.delete(req);
        if (!connected) reject(error ?? new Error("The OpenCode event stream closed before it connected."));
        else onClose(this.failure ? undefined : error);
      };
      const req = http.request(
        {
          hostname: this.base.hostname.replace(/^\[|\]$/g, ""),
          port: this.base.port,
          path: "/api/event",
          method: "GET",
          agent: false,
          headers: { authorization: this.authorization, accept: "text/event-stream" },
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            return finish(new OpenCodeHttpError(res.statusCode ?? 0, `GET /api/event → ${res.statusCode}`));
          }
          const decoder = new StringDecoder("utf8");
          let buffer = "";
          res.socket.setTimeout(STREAM_IDLE_MS, () => req.destroy(new Error("The OpenCode event stream went silent (no heartbeat).")));
          res.on("data", (chunk: Buffer) => {
            buffer += decoder.write(chunk).replace(/\r\n/g, "\n");
            if (buffer.length > MAX_FRAME_CHARS) return req.destroy(new Error("An OpenCode event frame was unreasonably large."));
            for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
              const frame = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const parsed = parseFrame(frame);
              if (!parsed) continue; // 心跳等注释帧
              if (!connected) {
                // 第一帧必须是 server.connected，之后的才交给调用方。
                if (parsed.type !== "server.connected") continue;
                connected = true;
                resolve();
                continue;
              }
              onEvent(parsed);
            }
          });
          res.on("end", () => finish(undefined));
          res.on("error", (error) => finish(error));
        },
      );
      this.inflight.add(req);
      req.setTimeout(CONNECT_TIMEOUT_MS, () => {
        if (!connected) req.destroy(new Error("Timed out waiting for the OpenCode event stream."));
      });
      req.on("error", (error) => finish(error));
      req.end();
    });
  }

  /** 会话关闭或进程退出：让所有进行中的请求立刻失败，之后的请求直接拒绝。 */
  failAll(error: Error): void {
    this.failure ??= error;
    for (const req of this.inflight) req.destroy(error);
    this.inflight.clear();
  }
}

function parseFrame(frame: string): OpenCodeEvent | undefined {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (data.length === 0) return undefined;
  try {
    const parsed = asRecord(JSON.parse(data));
    const type = str(parsed?.["type"]);
    return type ? { type, data: asRecord(parsed?.["data"]) ?? {} } : undefined;
  } catch {
    return undefined;
  }
}

export interface OpenCodeServer {
  proc: JsonlProcess;
  client: OpenCodeClient;
}

/**
 * 起一个私有的 `opencode serve --stdio` 并等它报出监听地址。
 * `env` 里的 USERPROFILE / HOME 等原样传给它（想把 OpenCode 的数据与配置隔离到别处就改这两个）。
 */
export async function startOpenCodeServer(
  launch: OpenCodeLaunch,
  options: { cwd: string; env: NodeJS.ProcessEnv; onNonJson?: (line: string) => void },
): Promise<OpenCodeServer> {
  const password = randomBytes(24).toString("base64url");
  const proc = spawnJsonl(launch.command, [...launch.prefix, "serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: options.cwd,
    env: { ...options.env, OPENCODE_PASSWORD: password },
    ...(options.onNonJson ? { onNonJson: options.onNonJson } : {}),
  });

  const url = await new Promise<URL>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`OpenCode did not announce a listening address within ${ANNOUNCE_TIMEOUT_MS / 1000}s.`)), ANNOUNCE_TIMEOUT_MS);
    proc.onMessage((message) => {
      const announced = str(asRecord(message)?.["url"]);
      if (!announced) return;
      clearTimeout(timer);
      const parsed = loopbackUrl(announced);
      if (parsed) resolve(parsed);
      else reject(new Error("OpenCode announced a non-loopback address; refusing to send it credentials."));
    });
    proc.onExit((info) => {
      clearTimeout(timer);
      reject(new Error(info.error ? `OpenCode could not be started: ${errorMessage(info.error)}` : `OpenCode exited during startup (code ${info.code ?? "none"}).`));
    });
  }).catch(async (error: unknown) => {
    const stderr = proc.stderrTail().trim();
    await proc.kill();
    throw new HarnessStartError("start_failed", `OpenCode could not start: ${clip(redact(errorMessage(error)), 300)}`, stderr ? tail(redact(stderr), 1_500) : undefined);
  });

  return { proc, client: new OpenCodeClient(url, password) };
}
