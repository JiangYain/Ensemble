import { LIMITS } from "@shared/constants";
import type { ToolUpdate } from "@shared/events";
import { isoNow, makePreview } from "@shared/format";
import { sliceHead } from "@shared/safe-slice";
import type { AccessLevel, ErrorInfo, FileChange, ModelInfo, Preview, ToolCategory, ToolStatus, Usage } from "@shared/types";
import {
  arr,
  asRecord,
  categorizeTool,
  classifyError,
  countDiffLines,
  countLines,
  displayPath,
  inputPreview,
  num,
  oneLine,
  outputPreview,
  str,
  textOfContent,
  type Json,
} from "./common";

/**
 * Codex app-server 事件（ThreadItem、TurnError、token 用量…）到 Ensemble 统一事件的纯函数映射。
 * 形状以 Codex 0.151.0 在 Windows 上的真实抓包为准：
 * - fileChange.changes[].kind.type = add / update / delete；add 的 diff 是文件原文，update 的 diff 是只有 hunk 的统一 diff；
 * - commandExecution.command 是带 shell 包装的完整命令行（如 `"pwsh.exe" -Command '…'`）；
 * - 非零退出码的命令状态是 failed，被用户拒绝的是 declined。
 */

// ───────────────────────── 访问级别 ─────────────────────────

export type CodexSandboxMode = "read-only" | "danger-full-access";
export type CodexSandboxType = "readOnly" | "dangerFullAccess";

export interface SandboxChoice {
  sandbox: CodexSandboxMode;
  /** 被委派的会话从不等待授权：无论哪个访问级别，策略都是 never。 */
  approvalPolicy: "never";
  /** thread/start 响应里 sandbox.type 应该等于什么，用来核对 Codex 真的采用了请求的沙箱。 */
  expectType: CodexSandboxType;
}

/**
 * - read_only：只读沙箱 + 从不弹授权（写入直接失败，而不是让运行卡在等待批准上）；
 * - full：Full Access（默认）：无沙箱、无授权。
 */
export function sandboxFor(access: AccessLevel): SandboxChoice {
  switch (access) {
    case "read_only":
      return { sandbox: "read-only", approvalPolicy: "never", expectType: "readOnly" };
    case "full":
      return { sandbox: "danger-full-access", approvalPolicy: "never", expectType: "dangerFullAccess" };
  }
}

// ───────────────────────── 命令 ─────────────────────────

function unquote(text: string): string {
  const first = text[0];
  if (text.length >= 2 && (first === "'" || first === '"') && text.endsWith(first)) return text.slice(1, -1);
  return text;
}

/** 去掉 shell 包装，还原模型真正想执行的命令：`"pwsh.exe" -Command 'echo hi'` → `echo hi`。 */
export function unwrapShellCommand(command: string): string {
  const trimmed = command.trim();
  const match = /^(?:"([^"]+)"|(\S+))\s+([\s\S]*)$/.exec(trimmed);
  if (!match) return trimmed;
  const program = (match[1] ?? match[2] ?? "").replace(/\\/g, "/").split("/").pop()?.toLowerCase().replace(/\.exe$/, "") ?? "";
  const rest = match[3] ?? "";
  let inner: string | undefined;
  if (program === "pwsh" || program === "powershell") inner = /(?:^|\s)-Command\s+([\s\S]+)$/i.exec(rest)?.[1];
  else if (program === "bash" || program === "zsh" || program === "sh" || program === "dash") inner = /(?:^|\s)-l?c\s+([\s\S]+)$/.exec(rest)?.[1];
  else if (program === "cmd") inner = /(?:^|\s)\/c\s+([\s\S]+)$/i.exec(rest)?.[1];
  return inner === undefined ? trimmed : unquote(inner.trim());
}

export function commandText(item: Json): string {
  const unwrapped = unwrapShellCommand(str(item["command"]) ?? "");
  if (unwrapped) return unwrapped;
  const actions = (arr(item["commandActions"]) ?? []).map((action) => str(asRecord(action)?.["command"])).filter((text): text is string => !!text);
  return actions.join(" && ");
}

// ───────────────────────── 文件变更 ─────────────────────────

interface ParsedChange {
  path: string;
  type: "add" | "delete" | "update";
  movePath: string | undefined;
  diff: string;
}

function parseChanges(item: Json): ParsedChange[] {
  const parsed: ParsedChange[] = [];
  for (const raw of arr(item["changes"]) ?? []) {
    const change = asRecord(raw);
    const path = str(change?.["path"]);
    const kind = asRecord(change?.["kind"]);
    const type = str(kind?.["type"]);
    if (!change || !path || (type !== "add" && type !== "delete" && type !== "update")) continue;
    parsed.push({ path, type, movePath: str(kind?.["move_path"]), diff: str(change["diff"]) ?? "" });
  }
  return parsed;
}

const prefixLines = (text: string, prefix: string): string =>
  text
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");

function diffPreview(changes: ParsedChange[], cwd: string, limit: number): Preview {
  const text = changes
    .map((change) => {
      const path = displayPath(cwd, change.movePath ?? change.path);
      switch (change.type) {
        case "add":
          return `*** Add File: ${path}\n${prefixLines(change.diff, "+")}`;
        case "delete":
          return `*** Delete File: ${path}${change.diff ? `\n${prefixLines(change.diff, "-")}` : ""}`;
        case "update":
          return `*** Update File: ${path}${change.movePath ? ` (moved from ${displayPath(cwd, change.path)})` : ""}\n${change.diff.replace(/\n$/, "")}`;
      }
    })
    .join("\n");
  return makePreview(text, limit, "diff");
}

export function fileChangesOf(item: Json, cwd: string): FileChange[] {
  return parseChanges(item).map((change): FileChange => {
    const path = displayPath(cwd, change.movePath ?? change.path);
    const diff = diffPreview([change], cwd, LIMITS.maxToolInputChars);
    switch (change.type) {
      case "add":
        return { path, change: "created", addedLines: countLines(change.diff), diff };
      case "delete":
        return { path, change: "deleted", ...(change.diff ? { removedLines: countLines(change.diff) } : {}), diff };
      case "update": {
        const counts = countDiffLines(change.diff);
        return { path, change: change.movePath ? "renamed" : "modified", addedLines: counts.added, removedLines: counts.removed, diff };
      }
    }
  });
}

// ───────────────────────── 工具 ─────────────────────────

const NON_TOOL_ITEMS = new Set([
  "userMessage",
  "agentMessage",
  "reasoning",
  "plan",
  "hookPrompt",
  "functionCallOutput",
  "contextCompaction",
  "enteredReviewMode",
  "exitedReviewMode",
  "subAgentActivity",
]);

function isToolItem(type: string | undefined): boolean {
  return type !== undefined && !NON_TOOL_ITEMS.has(type);
}

function listPaths(paths: string[]): string {
  const shown = paths.slice(0, 2).join(", ");
  return paths.length > 2 ? `${shown} +${paths.length - 2}` : shown;
}

/** 工具开始时展示用的名称、分类、标题与输入。 */
export function toolStart(item: Json, cwd: string): ToolUpdate | undefined {
  const callId = str(item["id"]);
  const type = str(item["type"]);
  if (!callId || !isToolItem(type)) return undefined;
  const base = { callId, status: "running" as const, startedAt: isoNow() };

  switch (type) {
    case "commandExecution": {
      const command = commandText(item);
      return { ...base, name: "shell", category: "shell", title: oneLine(command || "shell", 140), input: inputPreview(command, "text") };
    }
    case "fileChange": {
      const changes = parseChanges(item);
      const paths = changes.map((change) => displayPath(cwd, change.movePath ?? change.path));
      const category: ToolCategory = changes.length > 0 && changes.every((change) => change.type === "add") ? "write" : "edit";
      return {
        ...base,
        name: "apply_patch",
        category,
        title: oneLine(listPaths(paths) || "apply_patch", 140),
        ...(changes.length > 0 ? { input: diffPreview(changes, cwd, LIMITS.maxToolInputChars) } : {}),
      };
    }
    case "mcpToolCall": {
      const server = str(item["server"]) ?? "mcp";
      const tool = str(item["tool"]) ?? "tool";
      return {
        ...base,
        name: `mcp__${server}__${tool}`,
        category: "mcp",
        title: oneLine(`${server} / ${tool}`, 140),
        input: inputPreview(item["arguments"] ?? {}, "json"),
        mcp: { server, tool },
      };
    }
    case "dynamicToolCall": {
      const tool = str(item["tool"]) ?? "tool";
      const namespace = str(item["namespace"]);
      return {
        ...base,
        name: namespace ? `${namespace}__${tool}` : tool,
        category: categorizeTool(tool),
        title: oneLine(namespace ? `${namespace} / ${tool}` : tool, 140),
        input: inputPreview(item["arguments"] ?? {}, "json"),
      };
    }
    case "webSearch": {
      const action = asRecord(item["action"]);
      const query = str(item["query"]) || str(action?.["query"]) || (arr(action?.["queries"])?.map(String).join(" · ") ?? "");
      const target = str(action?.["url"]);
      return { ...base, name: "web_search", category: "web", title: oneLine(query || target || "web search", 140), ...(query ? { input: inputPreview(query, "text") } : {}) };
    }
    case "collabAgentToolCall": {
      const tool = str(item["tool"]) ?? "agent";
      const prompt = str(item["prompt"]);
      return {
        ...base,
        name: `agent_${tool}`,
        category: "task",
        title: oneLine(prompt ? `${tool}: ${prompt}` : tool, 140),
        ...(prompt ? { input: inputPreview(prompt, "text") } : {}),
      };
    }
    case "imageView": {
      const path = str(item["path"]);
      return { ...base, name: "view_image", category: "read", title: oneLine(path ? displayPath(cwd, path) : "image", 140) };
    }
    default:
      return { ...base, name: type ?? "item", category: "other", title: type ?? "item" };
  }
}

function toolStatus(status: string | undefined): ToolStatus {
  switch (status) {
    case "failed":
      return "failed";
    case "declined":
      return "cancelled";
    default:
      return "completed";
  }
}

export interface ToolEnd {
  update: ToolUpdate;
  /** 仅 fileChange 成功落盘时有值。 */
  files: FileChange[];
}

/** 工具结束时的状态、输出、退出码与文件变更。 */
export function toolEnd(item: Json, cwd: string): ToolEnd | undefined {
  const callId = str(item["id"]);
  const type = str(item["type"]);
  if (!callId || !isToolItem(type)) return undefined;
  const endedAt = isoNow();
  const status = toolStatus(str(item["status"]));
  const done = (extra: Partial<ToolUpdate>, files: FileChange[] = []): ToolEnd => ({ update: { callId, status, endedAt, ...extra }, files });

  switch (type) {
    case "commandExecution": {
      const output = str(item["aggregatedOutput"]);
      const exitCode = num(item["exitCode"]);
      return done({
        ...(output ? { output: outputPreview(output) } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(status === "failed" ? { error: exitCode !== undefined ? `Exit code ${exitCode}` : "The command failed." } : {}),
      });
    }
    case "fileChange":
      return done(status === "failed" ? { error: "The patch could not be applied." } : {}, status === "completed" ? fileChangesOf(item, cwd) : []);
    case "mcpToolCall": {
      const error = str(asRecord(item["error"])?.["message"]);
      const result = asRecord(item["result"]);
      let text = textOfContent(result?.["content"]);
      if (!text && result?.["structuredContent"] !== undefined && result["structuredContent"] !== null) text = JSON.stringify(result["structuredContent"], null, 2);
      return {
        update: {
          callId,
          status: error ? "failed" : status,
          endedAt,
          ...(text ? { output: outputPreview(text) } : {}),
          ...(error ? { error: oneLine(error, 400) } : {}),
        },
        files: [],
      };
    }
    case "dynamicToolCall": {
      const text = (arr(item["contentItems"]) ?? [])
        .map((entry) => str(asRecord(entry)?.["text"]))
        .filter((value): value is string => !!value)
        .join("\n");
      const failed = item["success"] === false || status === "failed";
      return {
        update: { callId, status: failed ? "failed" : status, endedAt, ...(text ? { output: outputPreview(text) } : {}) },
        files: [],
      };
    }
    default:
      return done(status === "failed" ? { error: "The step failed." } : {});
  }
}

// ───────────────────────── 用量 ─────────────────────────

export interface TokenBase {
  input: number;
  output: number;
  cached: number;
  reasoning: number;
  total: number;
}

function breakdown(value: unknown): TokenBase | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return {
    input: num(record["inputTokens"]) ?? 0,
    output: num(record["outputTokens"]) ?? 0,
    cached: num(record["cachedInputTokens"]) ?? 0,
    reasoning: num(record["reasoningOutputTokens"]) ?? 0,
    total: num(record["totalTokens"]) ?? 0,
  };
}

/**
 * Codex 上报的是整个线程的累计用量（total）和最近一次请求的用量（last）。
 * 本次运行的第一次上报里，total − last 就是运行开始前的累计值，据此得到本次运行的增量，不需要额外状态。
 * contextTokens 取最近一次请求的 token 总数（输入 + 输出），近似“当前上下文占用”。
 */
export function usageOf(tokenUsage: Json, base: TokenBase | undefined): { usage: Usage; base: TokenBase } | undefined {
  const total = breakdown(tokenUsage["total"]);
  if (!total) return undefined;
  const last = breakdown(tokenUsage["last"]);
  const origin: TokenBase =
    base ??
    (last
      ? {
          input: Math.max(0, total.input - last.input),
          output: Math.max(0, total.output - last.output),
          cached: Math.max(0, total.cached - last.cached),
          reasoning: Math.max(0, total.reasoning - last.reasoning),
          total: Math.max(0, total.total - last.total),
        }
      : { input: 0, output: 0, cached: 0, reasoning: 0, total: 0 });
  const contextWindow = num(tokenUsage["modelContextWindow"]);
  const usage: Usage = {
    inputTokens: Math.max(0, total.input - origin.input),
    outputTokens: Math.max(0, total.output - origin.output),
    cachedTokens: Math.max(0, total.cached - origin.cached),
    reasoningTokens: Math.max(0, total.reasoning - origin.reasoning),
    totalTokens: Math.max(0, total.total - origin.total),
    ...(last ? { contextTokens: last.total } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
  return { usage, base: origin };
}

// ───────────────────────── 错误 ─────────────────────────

function mapCodexErrorInfo(info: unknown): Pick<ErrorInfo, "code" | "retryable"> | undefined {
  const key = typeof info === "string" ? info : Object.keys(asRecord(info) ?? {})[0];
  switch (key) {
    case "contextWindowExceeded":
      return { code: "context_overflow" };
    case "usageLimitExceeded":
    case "sessionBudgetExceeded":
      return { code: "rate_limited" };
    case "rateLimitExceeded":
      return { code: "rate_limited", retryable: true };
    case "serverOverloaded":
    case "internalServerError":
    case "httpConnectionFailed":
    case "responseStreamConnectionFailed":
    case "responseStreamDisconnected":
    case "responseTooManyFailedAttempts":
      return { code: "provider_unavailable", retryable: true };
    case "unauthorized":
      return { code: "auth_failed" };
    case "sandboxError":
      return { code: "sandbox_error" };
    case "cyberPolicy":
    case "misalignmentPolicyViolation":
      return { code: "policy_blocked" };
    default:
      return undefined;
  }
}

/** Codex 的 TurnError → 统一错误。消息里明确的“模型不存在 / 未登录”优先于泛化的 codexErrorInfo（它常被归为 badRequest）。 */
export function toTurnErrorInfo(error: Json | undefined, fallback = "Codex reported an error."): ErrorInfo {
  const message = str(error?.["message"]) ?? fallback;
  const additional = str(error?.["additionalDetails"]);
  const fromMessage = classifyError(`${message} ${additional ?? ""}`);
  const fromInfo = mapCodexErrorInfo(error?.["codexErrorInfo"]);
  const specific = fromMessage.code === "model_not_found" || fromMessage.code === "auth_failed";
  const chosen = specific ? fromMessage : (fromInfo ?? fromMessage);
  const detail = additional && additional !== message ? additional : undefined;
  return {
    code: chosen.code,
    message: oneLine(message, 400),
    ...(detail ? { detail: sliceHead(detail, 2_000) } : {}),
    ...(chosen.retryable !== undefined ? { retryable: chosen.retryable } : {}),
  };
}

// ───────────────────────── 模型 ─────────────────────────

export interface CodexModelEntry {
  info: ModelInfo;
  /** thread/start 里要传的模型标识。 */
  model: string;
}

/**
 * 没有明确指定模型时用哪个：
 * 1. 用户自己的 Codex 配置里的默认模型——前提是它在可用模型目录里（目录为空时无法验证，也照用）；
 * 2. 否则退回目录里标记为默认的模型。用户配置的默认模型不在目录里时（例如已下线或拼写错误），
 *    直接使用会让每次委派都失败为 model_not_found，所以必须退回。
 */
export function pickDefaultModel(
  entries: CodexModelEntry[],
  configModel: string | undefined,
): { model: string | undefined; fellBackFrom?: string } {
  if (configModel && (entries.length === 0 || entries.some((entry) => entry.model === configModel))) return { model: configModel };
  const fallback = entries.find((entry) => entry.info.isDefault) ?? entries[0];
  return {
    model: fallback?.model,
    ...(configModel && fallback ? { fellBackFrom: configModel } : {}),
  };
}

export function toModelEntry(raw: unknown): CodexModelEntry | undefined {
  const record = asRecord(raw);
  const model = str(record?.["model"]) ?? str(record?.["id"]);
  if (!record || !model) return undefined;
  const efforts = (arr(record["supportedReasoningEfforts"]) ?? [])
    .map((entry) => (typeof entry === "string" ? entry : str(asRecord(entry)?.["reasoningEffort"])))
    .filter((effort): effort is string => !!effort);
  const defaultEffort = str(record["defaultReasoningEffort"]);
  const isDefault = record["isDefault"] === true;
  return {
    model,
    info: {
      id: model,
      label: str(record["displayName"]) ?? model,
      ...(efforts.length > 1 ? { efforts } : {}),
      ...(defaultEffort && efforts.includes(defaultEffort) ? { defaultEffort } : {}),
      ...(isDefault ? { isDefault: true } : {}),
    },
  };
}
