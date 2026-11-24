import { asRecord, str, type Json } from "./common";
import type { JsonlProcess } from "./process";
import { exitMessage, PendingRequests } from "./rpc";

/**
 * dsh 的 ACP 服务：stdio 上每行一个 JSON 的 JSON-RPC 2.0（协议版本 1）。
 * 与 Codex 的区别：消息带 `jsonrpc: "2.0"`；`session/prompt` 的响应就是这一轮的结束
 * （可能要几十分钟），所以它的等待不能设超时。
 */

/** “不设超时”：setTimeout 的最大值（再大会被 Node 当成 1ms 立刻触发）。 */
export const NO_TIMEOUT_MS = 2_147_483_647;

export type RpcId = number | string;

/** dsh 明确拒绝了某个请求（JSON-RPC error）。进程退出、超时等传输层失败是普通 Error，不是它。 */
export class DshRpcError extends Error {
  readonly method: string;
  readonly code: number;
  readonly data: unknown;
  /** dsh 给出的原始说明，不含 Ensemble 加的前缀；错误归类与展示用它。 */
  readonly reason: string;

  constructor(method: string, code: number, reason: string, data?: unknown) {
    super(`DSH rejected "${method}": ${reason}`);
    this.name = "DshRpcError";
    this.method = method;
    this.code = code;
    this.data = data;
    this.reason = reason;
  }
}

export interface DshRpcHandlers {
  onNotification(method: string, params: Json): void;
  /** dsh 发来的请求（例如 session/request_permission）：处理方必须调用 respond / respondError。 */
  onServerRequest(id: RpcId, method: string, params: Json): void;
}

export class DshRpc {
  private seq = 0;
  private readonly pending = new PendingRequests<number, unknown>("DSH");

  constructor(
    private readonly proc: JsonlProcess,
    private readonly handlers: DshRpcHandlers,
  ) {
    proc.onMessage((message) => this.dispatch(message));
    proc.onExit((info) => this.failAll(new Error(exitMessage("DSH", info))));
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    const id = ++this.seq;
    const message = params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };
    return this.pending.request(id, method, timeoutMs, () => this.proc.send(message)) as Promise<T>;
  }

  /** 通知没有响应；返回消息是否已提交给进程（进程已退出时为 false）。 */
  notify(method: string, params?: unknown): boolean {
    return this.proc.send(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }

  respond(id: RpcId, result: unknown): boolean {
    return this.proc.send({ jsonrpc: "2.0", id, result });
  }

  respondError(id: RpcId, code: number, message: string): boolean {
    return this.proc.send({ jsonrpc: "2.0", id, error: { code, message } });
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
      pending.reject(new DshRpcError(pending.what, code, str(error["message"]) ?? "unknown error", error["data"]));
    } else {
      pending.resolve(record["result"]);
    }
  }
}
