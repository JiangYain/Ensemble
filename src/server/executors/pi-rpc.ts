import { existsSync } from "node:fs";
import { join } from "node:path";
import { ENV } from "@shared/constants";
import { asRecord, str, type Json } from "./common";
import { resolveNpmCommandEntry, runCapture, type JsonlProcess } from "./process";
import { PendingRequests, exitMessage } from "./rpc";

const RPC_TIMEOUT_MS = 30_000;

// ───────────────────────── 入口定位 ─────────────────────────

let npmRootCache: string | null | undefined;

async function npmGlobalRoot(): Promise<string | undefined> {
  if (npmRootCache !== undefined) return npmRootCache ?? undefined;
  const result =
    process.platform === "win32"
      ? await runCapture("cmd.exe", ["/d", "/s", "/c", "npm root -g"], { timeoutMs: 15_000 })
      : await runCapture("npm", ["root", "-g"], { timeoutMs: 15_000 });
  const root = result.code === 0 ? result.stdout.trim().split(/\r?\n/).pop()?.trim() : undefined;
  npmRootCache = root ? root : null;
  return root || undefined;
}

export async function resolvePiEntry(options: { cli?: string | undefined; env: NodeJS.ProcessEnv }): Promise<string | undefined> {
  const explicit = options.cli ?? options.env[ENV.piCli];
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  const fromPath = resolveNpmCommandEntry("pi", options.env);
  if (fromPath) return fromPath;
  const root = await npmGlobalRoot();
  if (root) {
    const candidate = join(root, "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

// ───────────────────────── RPC 通道 ─────────────────────────

/** 对 Pi RPC 的“命令 → 响应”做关联；其余消息都当作事件交给 onEvent。 */
export class PiRpc {
  private seq = 0;
  private readonly pending = new PendingRequests<string, Json>("Pi");

  constructor(
    private readonly proc: JsonlProcess,
    private readonly onEvent: (event: Json) => void,
    private readonly onUnmatched: (response: Json) => void = () => undefined,
  ) {
    proc.onMessage((message) => this.dispatch(message));
    proc.onExit((info) => this.failAll(new Error(exitMessage("Pi", info))));
  }

  request(type: string, params: Json = {}, timeoutMs = RPC_TIMEOUT_MS): Promise<Json> {
    const id = `ens-${++this.seq}`;
    return this.pending.request(id, type, timeoutMs, () => this.proc.send({ id, type, ...params }));
  }

  failAll(error: Error): void {
    this.pending.failAll(error);
  }

  private dispatch(message: unknown): void {
    const record = asRecord(message);
    if (!record) return;
    if (record["type"] !== "response") {
      this.onEvent(record);
      return;
    }
    const id = str(record["id"]);
    const pending = id ? this.pending.take(id) : undefined;
    if (!pending) {
      this.onUnmatched(record);
      return;
    }
    if (record["success"] === false) {
      pending.reject(new Error(`Pi rejected "${pending.what}": ${str(record["error"]) ?? "unknown error"}`));
    } else {
      pending.resolve(record);
    }
  }
}
