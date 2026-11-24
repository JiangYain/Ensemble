import type { AccessEnforcement, AccessLevel, Capabilities } from "@shared/types";
import { toModelEntry, type CodexModelEntry } from "./codex-items";
import type { CodexRpc } from "./codex-rpc";
import { arr, asRecord, str, type Json } from "./common";

/**
 * Codex 执行端里不持有状态的那一半：探测（`CodexExecutor.probe`）与会话启动（`CodexSession.start`）共用的
 * 能力声明、访问级别的说明、超时常量，以及与 `codex app-server` 的握手（`initialize`）和模型目录、账号的查询。
 * 都是只依赖实参的函数与常量，所以放在执行端与会话之外，两边只管调用。
 * 这些声明与行为的验证依据（Codex 0.151.0 / Windows 11 / 2026-11-07）写在 codex.ts 顶部的说明和下面的注释里。
 */

/**
 * live = 已在真实 Codex 上验证（Codex 0.151.0 · Windows 11 · 2026-11-07，探针 + scripts/smoke.ts codex）。
 * 换了 Codex 版本或操作系统后需要重新验证。
 */
export const CODEX_CAPABILITIES: Capabilities = {
  steer: { support: "yes", mode: "turn_boundary", verification: "live" },
  followUp: { support: "yes", mode: "after_run", verification: "live" },
  cancel: { support: "yes", verification: "live" },
  resume: { support: "yes", verification: "live" },
  // 只有推理“摘要”，不是完整思考过程。
  reasoning: { support: "yes", verification: "live" },
  plan: { support: "yes", verification: "live" },
  usage: { support: "yes", verification: "live" },
  // 通过 apply_patch 的改动有逐文件事件；用 shell 命令写入的文件不会被列出。
  fileEvents: { support: "partial", verification: "live" },
  // 业务提问（item/tool/requestUserInput）的转交只对着假 Codex 验证过，请求形状取自随 Codex 生成的协议文件，回复形状是推断的；从未在真实 Codex 上触发过。
  question: { support: "yes", verification: "declared" },
};

export const START_TIMEOUT_MS = 60_000;
export const PROBE_TIMEOUT_MS = 30_000;
/** 这些通知对 Ensemble 没有价值，却会产生大量数据（turn/diff/updated 每次带整份 diff）。 */
const OPT_OUT_NOTIFICATIONS = ["remoteControl/status/changed", "account/rateLimits/updated", "turn/diff/updated", "thread/status/changed"];

export function codexAccess(sandbox: { enforced: boolean; note?: string }): Record<AccessLevel, AccessEnforcement | null> {
  const unconfirmed = sandbox.note ?? "sandbox status unknown";
  return {
    read_only: sandbox.enforced
      ? { level: "enforced", mechanism: "Codex sandbox: read-only, approvals off (writes fail instead of prompting)" }
      : { level: "none", mechanism: `Codex was asked for a read-only sandbox, but enforcement is unconfirmed (${unconfirmed})` },
    full: { level: "none", mechanism: "Codex danger-full-access: no sandbox, approvals off" },
  };
}

// ───────────────────────── 握手与查询 ─────────────────────────

export interface InitInfo {
  platformOs: string | undefined;
}

export async function initialize(rpc: CodexRpc, clientVersion: string): Promise<InitInfo> {
  const result = asRecord(
    await rpc.request(
      "initialize",
      {
        clientInfo: { name: "ensemble", title: "Ensemble", version: clientVersion },
        capabilities: { experimentalApi: false, requestAttestation: false, optOutNotificationMethods: OPT_OUT_NOTIFICATIONS },
      },
      30_000,
    ),
  );
  rpc.notify("initialized");
  return { platformOs: str(result?.["platformOs"]) };
}

export async function listModels(rpc: CodexRpc, timeoutMs: number): Promise<CodexModelEntry[]> {
  const entries: CodexModelEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const result = asRecord(await rpc.request("model/list", { limit: 100, ...(cursor ? { cursor } : {}) }, timeoutMs));
    for (const raw of arr(result?.["data"]) ?? []) {
      const entry = toModelEntry(raw);
      if (entry) entries.push(entry);
    }
    cursor = str(result?.["nextCursor"]);
    if (!cursor) break;
  }
  return entries;
}

export function accountLabel(account: Json | undefined): string | undefined {
  switch (str(account?.["type"])) {
    case "chatgpt": {
      const plan = str(account?.["planType"]);
      return plan ? `ChatGPT ${plan}` : "ChatGPT";
    }
    case "apiKey":
      return "API key";
    case "amazonBedrock":
      return "Amazon Bedrock";
    default:
      return undefined;
  }
}
