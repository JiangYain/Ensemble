import { clip } from "@shared/format";
import type { AccessLevel, ErrorInfo, FileChange, ModelInfo, Preview, Usage } from "@shared/types";
import {
  arr,
  asRecord,
  countDiffLines,
  countLines,
  displayPath,
  errorInfoFromText,
  inputPreview,
  num,
  oneLine,
  str,
  type Json,
} from "./common";
import { redact } from "./redact";

/** OpenCode 原生数据到 Ensemble 展示结构的纯转换（权限规则、模型目录、工具摘要、文件变更、用量、错误）。 */

// ───────────────────────── 脱敏 ─────────────────────────

/**
 * OpenCode 的错误文本、stderr 偶尔会带上提供商返回的片段，里面可能有密钥。
 * 凡是要写进事件、日志或错误信息的执行端原文，都先过一遍 `redact`（实现在 redact.ts，提问的转交也用同一份）。
 */
export { redact };

// ───────────────────────── 权限 ─────────────────────────

export interface PermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

/** 只读会话放行的动作；其余一律拒绝。实测：被拒绝的工具不会出现在模型的工具列表里（连 execute 也没有）。 */
export const READ_ONLY_ACTIONS = ["read", "glob", "grep"] as const;

/**
 * 创建会话时写入的会话级权限规则，按顺序匹配、最后一条命中的生效。
 * 实测（OpenCode 2.3.0）：会话级规则压得过配置文件与 agent 里的 `ask`（包括 `.env` 读取的默认询问），
 * 所以 Full Access 不需要改用户的 opencode.json，也不会有等待批准的闸门；
 * 唯一的例外是 `policies`（硬策略），它不可覆盖，被拦下的工具会如实以失败呈现。
 * `question` 工具（执行端向发起方提业务问题，不是授权）两种级别都放行：只读会话同样会遇到需求歧义。
 * 它会生成表单，由 opencode-questions.ts 转给发起方回答；没人回答也不会一直悬着——Ensemble 的时限、运行结束与取消都会收尾。
 * 以前这里把它禁掉，是因为没有“等待回答”的去处；现在有了，直接拒绝只会让子会话瞎猜返工。
 */
export function permissionRules(access: AccessLevel): PermissionRule[] {
  if (access === "read_only") {
    return [
      { action: "*", resource: "*", effect: "deny" },
      ...READ_ONLY_ACTIONS.map((action): PermissionRule => ({ action, resource: "*", effect: "allow" })),
      { action: "question", resource: "*", effect: "allow" },
    ];
  }
  return [
    { action: "*", resource: "*", effect: "allow" },
    { action: "question", resource: "*", effect: "allow" },
  ];
}

// ───────────────────────── 模型目录 ─────────────────────────

export interface CatalogModel {
  providerID: string;
  modelID: string;
  name: string;
  /** 真实上报的推理档位（variant）id，原样保留。 */
  variants: string[];
  contextWindow: number | undefined;
}

export function modelKey(model: { providerID: string; modelID: string }): string {
  return `${model.providerID}/${model.modelID}`;
}

/** “提供商/模型”拆成两段；模型 id 里还可能带斜杠（例如 google-vertex/xai/grok-4.7），所以只在第一个斜杠处拆。 */
export function splitModelKey(key: string): { providerID: string; modelID: string } | undefined {
  const index = key.indexOf("/");
  if (index <= 0 || index === key.length - 1) return undefined;
  return { providerID: key.slice(0, index), modelID: key.slice(index + 1) };
}

/**
 * 读取 `GET /api/model`。注意：目录里每个模型的 `settings` 会带 apiKey 等凭据，
 * 这里只挑展示需要的字段，整个对象绝不能写日志、事件或错误信息。
 */
export function readCatalog(body: unknown): CatalogModel[] {
  const seen = new Set<string>();
  const models: CatalogModel[] = [];
  for (const raw of arr(asRecord(body)?.["data"]) ?? []) {
    const model = asRecord(raw);
    const providerID = str(model?.["providerID"]);
    const modelID = str(model?.["modelID"]) ?? str(model?.["id"]);
    if (!model || !providerID || !modelID) continue;
    // 没有凭据或被配置关掉的模型、已弃用的模型、不是对话类的模型，都不算可用。
    if (model["enabled"] === false || str(model["status"]) === "deprecated") continue;
    const type = str(model["type"]);
    if (type !== undefined && type !== "chat") continue;
    const key = modelKey({ providerID, modelID });
    if (seen.has(key)) continue;
    seen.add(key);
    const variants = (arr(model["variants"]) ?? []).map((variant) => str(asRecord(variant)?.["id"])).filter((id): id is string => !!id);
    models.push({ providerID, modelID, name: str(model["name"]) ?? modelID, variants, contextWindow: num(asRecord(model["limit"])?.["context"]) });
  }
  return models;
}

export function toModelInfo(model: CatalogModel, defaultKey: string | undefined): ModelInfo {
  const key = modelKey(model);
  return {
    id: key,
    label: model.name,
    provider: model.providerID,
    ...(model.variants.length > 0 ? { efforts: model.variants } : {}),
    ...(key === defaultKey ? { isDefault: true } : {}),
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
  };
}

// ───────────────────────── 工具 ─────────────────────────

export function pathOf(input: Json): string | undefined {
  return str(input["path"]) ?? str(input["filePath"]) ?? str(input["file_path"]);
}

export function toolTitle(name: string, input: Json, cwd: string): string {
  const path = pathOf(input);
  switch (name) {
    case "read":
    case "write":
    case "edit":
      return path ? displayPath(cwd, path) : name;
    case "shell":
      return oneLine(str(input["command"]) ?? name, 140);
    case "glob":
      return oneLine(str(input["pattern"]) ?? name, 120);
    case "grep": {
      const pattern = str(input["pattern"]) ?? str(input["query"]);
      return oneLine([pattern, path ? `in ${displayPath(cwd, path)}` : undefined].filter(Boolean).join(" ") || name, 120);
    }
    case "execute":
      return oneLine(str(input["code"]) ?? name, 120);
    default: {
      const first = Object.values(input).find((value): value is string => typeof value === "string" && value.length > 0);
      return first ? oneLine(first, 120) : name;
    }
  }
}

export function toolInput(name: string, input: Json): Preview {
  if (name === "shell" && str(input["command"]) !== undefined) return inputPreview(str(input["command"]), "text");
  if (name === "execute" && str(input["code"]) !== undefined) return inputPreview(str(input["code"]), "text");
  if (name === "write" && str(input["content"]) !== undefined) return inputPreview(str(input["content"]), "text");
  if (name === "edit" && str(input["oldString"]) !== undefined) {
    const lines = (text: string, mark: string): string => text.split("\n").map((line) => `${mark}${line}`).join("\n");
    return inputPreview(`${lines(str(input["oldString"]) ?? "", "-")}\n${lines(str(input["newString"]) ?? "", "+")}`, "diff");
  }
  return inputPreview(input);
}

function changeOf(status: string | undefined): FileChange["change"] {
  switch (status) {
    case "created":
    case "added":
      return "created";
    case "deleted":
    case "removed":
      return "deleted";
    case "renamed":
    case "moved":
      return "renamed";
    default:
      return "modified";
  }
}

/**
 * 成功的写类工具对应的文件变更，只取 OpenCode 明确上报的内容：
 * - 工具结果的 `metadata.files`（实测 edit 会给出文件、状态、增删行数与统一 diff）；
 * - write：入参给路径，“新建”还是“覆盖”看工具自己的回执（实测 “Created file …” / “Wrote file …”）。
 * shell 里的改动、execute（代码模式）里的改动看不到，这里不去猜。
 */
export function fileChangesOf(name: string, input: Json, resultText: string, metadata: Json | undefined, cwd: string): FileChange[] {
  const reported: FileChange[] = [];
  for (const raw of arr(metadata?.["files"]) ?? []) {
    const file = asRecord(raw);
    const path = str(file?.["file"]) ?? str(file?.["path"]);
    if (!file || !path) continue;
    const patch = str(file["patch"]);
    const counts = patch ? countDiffLines(patch) : undefined;
    const added = num(file["additions"]) ?? counts?.added;
    const removed = num(file["deletions"]) ?? counts?.removed;
    reported.push({
      path: displayPath(cwd, path),
      change: changeOf(str(file["status"])),
      ...(added !== undefined ? { addedLines: added } : {}),
      ...(removed !== undefined ? { removedLines: removed } : {}),
      ...(patch ? { diff: { ...inputPreview(patch, "diff"), format: "diff" as const } } : {}),
    });
  }
  if (reported.length > 0) return reported;
  if (name !== "write") return [];
  const path = pathOf(input);
  if (!path) return [];
  const created = /^created\b/i.test(resultText.trim());
  const content = str(input["content"]);
  return [{ path: displayPath(cwd, path), change: created ? "created" : "modified", ...(created && content !== undefined ? { addedLines: countLines(content) } : {}) }];
}

// ───────────────────────── 用量 ─────────────────────────

/** 一次或多次模型调用的 token 合计（OpenCode 的口径：input 不含缓存，reasoning 与 output 分开）。 */
export interface Tally {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export const ZERO_TALLY: Tally = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

/** 读取 step.ended / step.failed / usage.recorded 里的 `tokens` 与 `cost`；没有 token 统计时返回 undefined。 */
export function readTally(data: Json | undefined): Tally | undefined {
  const tokens = asRecord(data?.["tokens"]);
  if (!tokens) return undefined;
  const cache = asRecord(tokens["cache"]);
  return {
    input: num(tokens["input"]) ?? 0,
    output: num(tokens["output"]) ?? 0,
    reasoning: num(tokens["reasoning"]) ?? 0,
    cacheRead: num(cache?.["read"]) ?? 0,
    cacheWrite: num(cache?.["write"]) ?? 0,
    cost: num(data?.["cost"]) ?? 0,
  };
}

export function addTally(a: Tally, b: Tally): Tally {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cost: a.cost + b.cost,
  };
}

/**
 * 归一成 Ensemble 的口径（`cachedTokens ⊂ inputTokens`、`reasoningTokens ⊂ outputTokens`、总量 = 输入 + 输出）。
 * 本次运行的用量由每个 step 的 tokens 累加得到（OpenCode 的 usage.updated 是整个会话的累计值，
 * 且包含标题生成等旁路调用，不适合当作某次运行的用量）。
 * 上下文占用取最近一次模型调用的输入侧 token；`cost` 是 OpenCode 按目录里的美元单价算出的值。
 */
export function toUsage(total: Tally, last: Tally | undefined, contextWindow: number | undefined): Usage {
  const input = total.input + total.cacheRead + total.cacheWrite;
  const output = total.output + total.reasoning;
  return {
    inputTokens: input,
    outputTokens: output,
    cachedTokens: total.cacheRead,
    reasoningTokens: total.reasoning,
    totalTokens: input + output,
    costUsd: Math.round(total.cost * 1e6) / 1e6,
    ...(last ? { contextTokens: last.input + last.cacheRead + last.cacheWrite } : {}),
    ...(contextWindow ? { contextWindow } : {}),
  };
}

// ───────────────────────── 错误 ─────────────────────────

/**
 * OpenCode 的错误对象 `{type, message, status?}` → Ensemble 的 ErrorInfo。
 * 实测：不存在的模型、没有凭据的提供商、不存在的 variant 都是在运行开始后以 `provider.no-route` 异步失败，而不是 HTTP 错误。
 * 错误对象里的 `response` 可能带响应头与正文，这里不取。
 */
export function errorInfoOf(error: Json | undefined, fallback: string): ErrorInfo {
  const message = redact(str(error?.["message"]) ?? fallback);
  const type = str(error?.["type"]) ?? "";
  const status = num(error?.["status"]);
  const detail = `type=${type || "unknown"}${status !== undefined ? ` status=${status}` : ""}`;
  if (type === "provider.no-route") return { code: /variant/i.test(message) ? "invalid_request" : "model_not_found", message: clip(message, 400), detail };
  if (status === 401 || status === 403) return { code: "auth_failed", message: clip(message, 400), detail };
  if (status === 429) return { code: "rate_limited", message: clip(message, 400), detail, retryable: true };
  if (status !== undefined && status >= 500) return { code: "provider_unavailable", message: clip(message, 400), detail, retryable: true };
  return errorInfoFromText(message, detail);
}
