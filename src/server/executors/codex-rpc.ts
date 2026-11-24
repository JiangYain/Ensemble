import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { ENV } from "@shared/constants";
import { asRecord, str, type Json } from "./common";
import { findExecutableOnPath, findFile, resolveNpmCommandEntry, type JsonlProcess } from "./process";
import { PendingRequests, exitMessage } from "./rpc";

/**
 * Codex app-server 的传输层：
 * - 子进程 stdio 上每行一个 JSON，采用“精简版 JSON-RPC”（消息里没有 `jsonrpc` 字段）；
 * - 客户端请求：`{id, method, params}` → `{id, result}` / `{id, error:{code,message}}`；
 * - 服务端通知：`{method, params}`；
 * - 服务端也会向客户端发请求（授权等）：`{id, method, params}`，必须有回应，否则服务端会一直等。
 * 这些形状均以 Codex 0.151.0 在 Windows 上的真实抓包为准。
 */

// ───────────────────────── 定位 ─────────────────────────

export interface CodexLaunch {
  command: string;
  /** 子命令之前的参数（例如通过 node 运行 JS 启动器时的入口路径）。 */
  prefix: string[];
  /** 说明从哪里找到的，用于诊断与 doctor。 */
  source: string;
}

export function appServerArgs(launch: CodexLaunch): string[] {
  return [...launch.prefix, "app-server"];
}

export function versionArgs(launch: CodexLaunch): string[] {
  return [...launch.prefix, "--version"];
}

/**
 * 找到 Codex 的启动方式。优先级：
 * 1. 显式指定（选项或 ENSEMBLE_CODEX_BIN）：原生可执行文件，或 .js 入口（测试用）。
 * 2. PATH 上的 npm 全局安装：解析垫片得到 JS 启动器，再在包目录里找随包安装的原生可执行文件
 *    （Windows 上直接运行 .cmd 垫片很脆弱，且 JS 启动器多一层进程）。
 * 3. PATH 上直接就是原生可执行文件。
 */
export function resolveCodexLaunch(options: { bin?: string | undefined; env: NodeJS.ProcessEnv }): CodexLaunch | undefined {
  const native = process.platform === "win32" ? "codex.exe" : "codex";
  const explicit = options.bin ?? options.env[ENV.codexBin];
  if (explicit) {
    if (!existsSync(explicit)) return undefined;
    return /\.m?js$/i.test(explicit)
      ? { command: process.execPath, prefix: [explicit], source: explicit }
      : { command: explicit, prefix: [], source: explicit };
  }

  const entry = resolveNpmCommandEntry("codex", options.env);
  if (entry) {
    // <包目录>/bin/codex.js → 原生可执行文件在 <包目录>/node_modules/@openai/codex-<平台>/vendor/**/
    const packageDir = dirname(dirname(entry));
    const vendored = findFile(join(packageDir, "node_modules", "@openai"), native, 6);
    if (vendored) return { command: vendored, prefix: [], source: vendored };
    return { command: process.execPath, prefix: [entry], source: entry };
  }

  const onPath = findExecutableOnPath([native], options.env);
  if (onPath) return { command: onPath, prefix: [], source: onPath };
  return undefined;
}

// ───────────────────────── 传输 ─────────────────────────

export class CodexRpcError extends Error {
  readonly method: string;
  readonly code: number;
  readonly data: unknown;

  constructor(method: string, code: number, message: string, data?: unknown) {
    super(`Codex rejected "${method}": ${message}`);
    this.name = "CodexRpcError";
    this.method = method;
    this.code = code;
    this.data = data;
  }
}

export type RpcId = number | string;

export interface CodexRpcHandlers {
  onNotification(method: string, params: Json): void;
  /** 服务端发来的请求：处理方必须调用 respond / respondError。 */
  onServerRequest(id: RpcId, method: string, params: Json): void;
}

export class CodexRpc {
  private seq = 0;
  private readonly pending = new PendingRequests<number, unknown>("Codex");

  constructor(
    private readonly proc: JsonlProcess,
    private readonly handlers: CodexRpcHandlers,
  ) {
    proc.onMessage((message) => this.dispatch(message));
    proc.onExit((info) => this.failAll(new Error(exitMessage("Codex", info))));
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    const id = ++this.seq;
    const message = params === undefined ? { id, method } : { id, method, params };
    return this.pending.request(id, method, timeoutMs, () => this.proc.send(message)) as Promise<T>;
  }

  notify(method: string, params?: unknown): void {
    this.proc.send(params === undefined ? { method } : { method, params });
  }

  /** 返回消息是否已提交给进程（进程已退出时为 false）。 */
  respond(id: RpcId, result: unknown): boolean {
    return this.proc.send({ id, result });
  }

  respondError(id: RpcId, code: number, message: string): boolean {
    return this.proc.send({ id, error: { code, message } });
  }

  failAll(error: Error): void {
    this.pending.failAll(error);
  }

  private dispatch(message: unknown): void {
    const record = asRecord(message);
    if (!record) return;
    const id = record["id"];
    const method = str(record["method"]);

    if (method !== undefined) {
      const params = asRecord(record["params"]) ?? {};
      if (typeof id === "number" || typeof id === "string") this.handlers.onServerRequest(id, method, params);
      else this.handlers.onNotification(method, params);
      return;
    }

    const pending = typeof id === "number" ? this.pending.take(id) : undefined;
    if (!pending) return;
    const error = asRecord(record["error"]);
    if (error) {
      const code = typeof error["code"] === "number" ? error["code"] : -32000;
      pending.reject(new CodexRpcError(pending.what, code, str(error["message"]) ?? "unknown error", error["data"]));
    } else {
      pending.resolve(record["result"]);
    }
  }
}
