import type { FileChange, ModelInfo, Preview, Usage } from "@shared/types";
import {
  arr,
  asRecord,
  countDiffLines,
  countLines,
  displayPath,
  inputPreview,
  num,
  oneLine,
  str,
  type Json,
} from "./common";

/** Pi 原生数据到 Ensemble 展示结构的纯转换（模型目录、工具摘要、文件变更、用量）。 */

// ───────────────────────── 模型与思考档位 ─────────────────────────

const THINKING_BASE = ["off", "minimal", "low", "medium", "high"] as const;
const THINKING_EXTRA = ["xhigh", "max"] as const;
const THINKING_LEVELS = new Set<string>([...THINKING_BASE, ...THINKING_EXTRA]);

export function isThinkingLevel(value: string): boolean {
  return THINKING_LEVELS.has(value);
}

export function toModelInfo(raw: unknown, defaultKey: string | undefined, defaultEffort: string | undefined): ModelInfo | undefined {
  const model = asRecord(raw);
  const id = str(model?.["id"]);
  if (!model || !id) return undefined;
  const provider = str(model["provider"]);
  const key = provider ? `${provider}/${id}` : id;
  const map = asRecord(model["thinkingLevelMap"]);
  // thinkingLevelMap 里 null 表示明确不支持；xhigh / max 只有映射里出现才支持。
  const efforts: string[] =
    model["reasoning"] === true
      ? [
          ...THINKING_BASE.filter((level) => map?.[level] !== null),
          ...THINKING_EXTRA.filter((level) => typeof map?.[level] === "string"),
        ]
      : [];
  const contextWindow = num(model["contextWindow"]);
  const isDefault = key === defaultKey;
  return {
    id: key,
    label: str(model["name"]) ?? id,
    ...(provider ? { provider } : {}),
    ...(efforts.length > 1 ? { efforts } : {}),
    ...(isDefault ? { isDefault: true } : {}),
    ...(isDefault && defaultEffort && efforts.includes(defaultEffort) ? { defaultEffort } : {}),
    ...(contextWindow ? { contextWindow } : {}),
  };
}

// ───────────────────────── 工具 ─────────────────────────

export function toolTitle(name: string, args: Json, cwd: string): string {
  const path = str(args["path"]) ?? str(args["file_path"]) ?? str(args["filePath"]);
  switch (name) {
    case "read":
    case "write":
    case "edit":
      return path ? displayPath(cwd, path) : name;
    case "bash":
      return oneLine(str(args["command"]) ?? name, 140);
    case "grep": {
      const pattern = str(args["pattern"]) ?? str(args["query"]);
      return oneLine([pattern, path ? `in ${displayPath(cwd, path)}` : undefined].filter(Boolean).join(" ") || name, 120);
    }
    case "find":
      return oneLine(str(args["pattern"]) ?? str(args["glob"]) ?? path ?? name, 120);
    case "ls":
      return path ? displayPath(cwd, path) : ".";
    default: {
      const first = Object.values(args).find((value): value is string => typeof value === "string" && value.length > 0);
      return first ? oneLine(first, 120) : name;
    }
  }
}

export function toolInput(name: string, args: Json): Preview {
  if (name === "bash" && str(args["command"]) !== undefined) return inputPreview(str(args["command"]), "text");
  if (name === "write" && str(args["content"]) !== undefined) return inputPreview(str(args["content"]), "text");
  if (name === "edit") {
    const edits = arr(args["edits"]);
    if (edits) {
      const text = edits
        .map((edit) => {
          const record = asRecord(edit);
          const oldText = str(record?.["oldText"]) ?? "";
          const newText = str(record?.["newText"]) ?? "";
          return `${oldText.split("\n").map((line) => `-${line}`).join("\n")}\n${newText.split("\n").map((line) => `+${line}`).join("\n")}`;
        })
        .join("\n");
      return inputPreview(text, "diff");
    }
  }
  return inputPreview(args);
}

/** 工具开始时记下的、结束时判断文件变更要用的信息。 */
export interface FileToolInfo {
  name: string;
  path: string | undefined;
  /** 仅 write：目标文件在工具运行之前是否存在。 */
  existedBefore: boolean | undefined;
  /** 仅 write：写入的内容，用于统计新增行数。 */
  content: string | undefined;
}

/** 成功的 write / edit 调用对应的文件变更；别的工具（例如 bash 里的改动）看不到。 */
export function fileChangesOf(tool: FileToolInfo, result: Json | undefined, cwd: string): FileChange[] {
  if (!tool.path) return [];
  const path = displayPath(cwd, tool.path);
  if (tool.name === "write") {
    const created = tool.existedBefore === false;
    return [{ path, change: created ? "created" : "modified", ...(created && tool.content !== undefined ? { addedLines: countLines(tool.content) } : {}) }];
  }
  if (tool.name === "edit") {
    const patch = str(asRecord(result?.["details"])?.["patch"]);
    const counts = patch ? countDiffLines(patch) : undefined;
    return [
      {
        path,
        change: "modified",
        ...(counts ? { addedLines: counts.added, removedLines: counts.removed } : {}),
        ...(patch ? { diff: { ...inputPreview(patch, "diff"), format: "diff" as const } } : {}),
      },
    ];
  }
  return [];
}

// ───────────────────────── 用量 ─────────────────────────

/**
 * Pi 的统计是整个会话的累计值。
 * 注意口径：Pi 的 `input` 不含缓存（`total = input + output + cacheRead + cacheWrite`），
 * 与 Ensemble 的 `Usage.inputTokens`（含缓存）不同，换算见 `usageSince`。
 */
export interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

export const ZERO_TOTALS: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };

/** 读取 `get_session_stats` 的响应；没有 token 统计时返回 undefined。 */
export function readTotals(response: Json): Totals | undefined {
  const data = asRecord(response["data"]);
  const tokens = asRecord(data?.["tokens"]);
  if (!data || !tokens) return undefined;
  return {
    input: num(tokens["input"]) ?? 0,
    output: num(tokens["output"]) ?? 0,
    cacheRead: num(tokens["cacheRead"]) ?? 0,
    cacheWrite: num(tokens["cacheWrite"]) ?? 0,
    total: num(tokens["total"]) ?? 0,
    cost: num(data["cost"]) ?? 0,
  };
}

/**
 * 本次运行的用量：累计值减去运行开始时的基线；上下文占用取自同一份响应。
 * 输入按 Ensemble 的口径把缓存读、写都算进去（Claude 适配器同样如此），这样 `cachedTokens ⊂ inputTokens`，
 * 且 `inputTokens + outputTokens` 与 Pi 自己的 `total` 一致。
 */
export function usageSince(now: Totals, baseline: Totals, response: Json): Usage {
  const context = asRecord(asRecord(response["data"])?.["contextUsage"]);
  const contextTokens = num(context?.["tokens"]);
  const contextWindow = num(context?.["contextWindow"]);
  const delta = (key: "input" | "output" | "cacheRead" | "cacheWrite"): number => Math.max(0, now[key] - baseline[key]);
  return {
    inputTokens: delta("input") + delta("cacheRead") + delta("cacheWrite"),
    outputTokens: delta("output"),
    cachedTokens: delta("cacheRead"),
    totalTokens: Math.max(0, now.total - baseline.total),
    costUsd: Math.max(0, Math.round((now.cost - baseline.cost) * 1e6) / 1e6),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}
