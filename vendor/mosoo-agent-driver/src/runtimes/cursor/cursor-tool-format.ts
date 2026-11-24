// ENSEMBLE ADDED — 本文件由 Ensemble 新增（Cursor SDK 后端），不属于上游 mosoo-agent-driver。详见 VENDORING.md。
import { basename } from "node:path";
import type { Json } from "./cursor-values";
import { arr, asRecord, displayPath, isString, num, oneLine, str } from "./cursor-values";

/**
 * Cursor 内置工具的展示与结果解析。
 *
 * `tool_call.result` 在 SDK 类型里是 unknown，但本地运行实际产出的是
 * `{ status: "success", value: {...} }` 或 `{ status: "error", error: { message, path? } }`
 * （形状取自 @cursor/sdk 1.3.1 打包源码里的各工具转换函数）。认不出形状时一律返回 undefined，
 * 由调用方原样展示 JSON，而不是猜测。
 */

/** 只读会话允许模型使用的内置工具；名称取自 SDK 的 ToolName 词汇，未知名称会让 Agent.create 抛 ConfigurationError。 */
export const CURSOR_READ_ONLY_TOOLS = [
  "read",
  "grep",
  "glob",
  "ls",
  "semSearch",
  "readLints",
  "readTodos",
  "updateTodos",
] as const;

export const READ_ONLY_SET: ReadonlySet<string> = new Set(CURSOR_READ_ONLY_TOOLS.map((name) => name.toLowerCase()));

export const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "edit",
  "write",
  "strreplace",
  "str_replace",
  "multiedit",
  "applyagentdiff",
  "apply_patch",
  "createfile",
  "create_file",
  "write_file",
  "edit_file",
]);

export const DELETE_TOOLS: ReadonlySet<string> = new Set(["delete", "delete_file", "deletefile"]);

/** 在只读会话里出现就说明白名单没有生效的工具。 */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  ...EDIT_TOOLS,
  ...DELETE_TOOLS,
  "shell",
  "task",
  "mcp",
  "generateimage",
]);

const PATH_KEYS = [
  "path",
  "file_path",
  "filePath",
  "target_file",
  "targetFile",
  "relative_workspace_path",
  "relativeWorkspacePath",
  "target_directory",
  "targetDirectory",
  "directory",
];

export function pathOf(args: Json): string | undefined {
  for (const key of PATH_KEYS) {
    const value = str(args[key]);
    if (value) return value;
  }
  return undefined;
}

/** 参数的粗略大小，用来判断流式增量里的参数是否又长了；序列化失败当作 0。 */
export function argsSize(raw: unknown): number {
  if (raw === undefined) return 0;
  try {
    return JSON.stringify(raw)?.length ?? 0;
  } catch {
    return 0;
  }
}

export function commandOf(args: Json): string | undefined {
  const command = args["command"];
  if (typeof command === "string") return command;
  if (Array.isArray(command)) return command.filter((part): part is string => typeof part === "string").join(" ");
  return undefined;
}

export function mcpOf(args: Json): { server?: string; tool?: string } | undefined {
  const server = str(args["providerIdentifier"]) ?? str(args["server"]) ?? str(args["serverName"]);
  const tool = str(args["toolName"]) ?? str(args["tool"]);
  if (!server && !tool) return undefined;
  return { ...(server ? { server } : {}), ...(tool ? { tool } : {}) };
}

function stringsOf(value: unknown): string[] {
  return (arr(value) ?? []).filter(isString);
}

export function toolTitle(name: string, args: Json, cwd: string): string {
  const path = pathOf(args);
  switch (name.toLowerCase()) {
    case "shell":
      return oneLine(commandOf(args) ?? name, 140);
    case "read":
    case "edit":
    case "write":
    case "strreplace":
    case "str_replace":
    case "delete":
      return path ? displayPath(cwd, path) : name;
    case "readlints": {
      const paths = stringsOf(args["paths"]);
      if (paths.length === 0) return path ? displayPath(cwd, path) : name;
      return oneLine(`${displayPath(cwd, paths[0] ?? "")}${paths.length > 1 ? ` +${paths.length - 1}` : ""}`, 120);
    }
    case "ls":
      return path ? displayPath(cwd, path) : ".";
    case "mcp": {
      const mcp = mcpOf(args);
      return oneLine([mcp?.server, mcp?.tool].filter(isString).join(" · ") || name, 120);
    }
    case "generateimage":
      return oneLine(str(args["description"]) ?? name, 120);
    case "createplan":
      return oneLine(str(args["plan"]) ?? name, 120);
    case "grep": {
      const pattern = str(args["pattern"]) ?? str(args["query"]);
      return oneLine([pattern, path ? `in ${displayPath(cwd, path)}` : undefined].filter(Boolean).join(" ") || name, 120);
    }
    case "glob":
      return oneLine(str(args["glob_pattern"]) ?? str(args["globPattern"]) ?? str(args["pattern"]) ?? path ?? name, 120);
    case "semsearch":
      return oneLine(str(args["query"]) ?? name, 120);
    case "websearch":
      return oneLine(str(args["search_term"]) ?? str(args["searchTerm"]) ?? str(args["query"]) ?? name, 120);
    case "webfetch":
      return oneLine(str(args["url"]) ?? name, 140);
    case "task":
      return oneLine(str(args["description"]) ?? str(args["prompt"]) ?? name, 120);
    default: {
      const first = Object.values(args).find((value): value is string => typeof value === "string" && value.length > 0);
      return first ? oneLine(first, 120) : name;
    }
  }
}

/** 工具输入的展示文本：shell 直接给命令，其余给缩进过的 JSON（由调用方序列化）。 */
export function isShellCommandInput(name: string, args: Json): string | undefined {
  if (name.toLowerCase() !== "shell") return undefined;
  const command = commandOf(args);
  return command !== undefined && command.length > 0 ? command : undefined;
}

export function resultBody(result: unknown): Json | undefined {
  const record = asRecord(result);
  return asRecord(record?.["value"]) ?? asRecord(record?.["success"]) ?? record;
}

function grepText(body: Json, cwd: string): string | undefined {
  const parts = [...Object.values(asRecord(body["workspaceResults"]) ?? {}), body["activeEditorResult"]].map(asRecord);
  if (parts.every((part) => part === undefined)) return undefined;
  const lines: string[] = [];
  for (const part of parts) {
    const output = asRecord(part?.["output"]);
    switch (str(part?.["type"])) {
      case "content":
        for (const raw of arr(output?.["matches"]) ?? []) {
          const match = asRecord(raw);
          const file = str(match?.["file"]);
          const lineNumber = num(match?.["lineNumber"]);
          lines.push(
            `${file ? displayPath(cwd, file) : ""}${lineNumber !== undefined ? `:${lineNumber}` : ""}: ${str(match?.["line"]) ?? ""}`,
          );
        }
        break;
      case "files":
        lines.push(...stringsOf(output?.["files"]).map((file) => displayPath(cwd, file)));
        break;
      case "count":
        for (const raw of arr(output?.["counts"]) ?? []) {
          const entry = asRecord(raw);
          lines.push(`${displayPath(cwd, str(entry?.["file"]) ?? "")}: ${num(entry?.["count"]) ?? 0}`);
        }
        break;
      default:
        break;
    }
  }
  return lines.join("\n");
}

/** 目录只列第一层：子目录以 “/” 结尾。 */
function lsText(body: Json): string | undefined {
  const root = asRecord(body["directoryTreeRoot"]);
  if (!root) return undefined;
  const dirs = (arr(root["childrenDirs"]) ?? [])
    .map((dir) => str(asRecord(dir)?.["absPath"]))
    .filter(isString)
    .map((path) => `${basename(path)}/`)
    .sort();
  const files = (arr(root["childrenFiles"]) ?? [])
    .map((file) => str(asRecord(file)?.["name"]))
    .filter(isString)
    .sort();
  return [...dirs, ...files].join("\n");
}

/** 诊断的行列号体系 SDK 没有写明（是否从 0 开始），所以只列文件、级别与信息，不转述位置。 */
function lintText(body: Json, cwd: string): string | undefined {
  const files = arr(body["fileDiagnostics"]);
  if (!files) return undefined;
  const lines: string[] = [];
  for (const raw of files) {
    const file = asRecord(raw);
    const path = displayPath(cwd, str(file?.["path"]) ?? "");
    for (const rawDiagnostic of arr(file?.["diagnostics"]) ?? []) {
      const diagnostic = asRecord(rawDiagnostic);
      const source = [str(diagnostic?.["source"]), str(diagnostic?.["code"])].filter(isString).join(" ");
      lines.push(
        `${path}: ${str(diagnostic?.["severity"]) ?? "error"}: ${str(diagnostic?.["message"]) ?? ""}${source ? ` (${source})` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

function mcpText(body: Json): string | undefined {
  const content = arr(body["content"]);
  if (!content) return undefined;
  return content
    .map((raw) => {
      const block = asRecord(raw);
      return str(asRecord(block?.["text"])?.["text"]) ?? (asRecord(block?.["image"]) ? "[image]" : "");
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

/**
 * 能识别形状时返回文本（识别出但为空时返回 ""，例如没有任何输出的命令）；
 * 认不出形状时返回 undefined，由调用方原样展示 JSON。
 */
export function resultText(lowerName: string, result: unknown, cwd: string): string | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === "string") return result;
  const body = resultBody(result);
  if (!body) return undefined;

  // 工具失败：{ status: "error", error: { message } }
  const failure = asRecord(body["error"]);
  if (str(asRecord(result)?.["status"]) === "error" && failure) return str(failure["message"]) ?? undefined;

  switch (lowerName) {
    case "grep":
      return grepText(body, cwd);
    case "ls":
      return lsText(body);
    case "readlints":
      return lintText(body, cwd);
    case "mcp":
      return mcpText(body);
    case "glob":
      return arr(body["files"]) ? stringsOf(body["files"]).map((file) => displayPath(cwd, file)).join("\n") : undefined;
    case "semsearch":
      return str(body["results"]);
    case "generateimage":
      return str(body["filePath"]);
    case "task":
      // 子 Agent 的完整步骤很长且已在 SDK 之外，这里不倾倒。
      return str(body["resultSuffix"]) ?? "";
    default:
      break;
  }

  const stdout = str(body["stdout"]);
  const stderr = str(body["stderr"]);
  if (stdout !== undefined || stderr !== undefined) {
    return [stdout, stderr ? `[stderr]\n${stderr}` : undefined].filter((part): part is string => !!part).join("\n");
  }
  for (const key of ["content", "output", "text", "message", "result"]) {
    const text = str(body[key]);
    if (text) return text;
  }
  return undefined;
}

export function exitCodeOf(result: unknown): number | undefined {
  const body = resultBody(result);
  return num(body?.["exitCode"]) ?? num(body?.["exit_code"]);
}

export interface CursorFileChange {
  readonly path: string;
  readonly change: "delete" | "upsert";
  /** 仅 upsert：工具运行之前目标文件不存在（新建）。 */
  readonly created?: boolean;
  readonly addedLines?: number;
  readonly removedLines?: number;
  readonly diff?: string;
}

export function fileChangeOf(
  lowerName: string,
  track: { path: string | undefined; existedBefore: boolean | undefined },
  cwd: string,
  result: unknown,
): CursorFileChange {
  const path = displayPath(cwd, track.path ?? "");
  if (DELETE_TOOLS.has(lowerName)) return { path, change: "delete" };
  const body = resultBody(result);
  const added = num(body?.["linesAdded"]) ?? num(body?.["lines_added"]);
  const removed = num(body?.["linesRemoved"]) ?? num(body?.["lines_removed"]);
  const diff = str(body?.["diffString"]) ?? str(body?.["diff"]);
  return {
    path,
    change: "upsert",
    created: track.existedBefore === false,
    ...(added !== undefined ? { addedLines: added } : {}),
    ...(removed !== undefined ? { removedLines: removed } : {}),
    ...(diff ? { diff } : {}),
  };
}

export interface CursorPlanEntry {
  readonly id?: string;
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed";
}

function planStatus(raw: string | undefined): CursorPlanEntry["status"] | undefined {
  const value = (raw ?? "pending").toLowerCase();
  if (/cancel/.test(value)) return undefined;
  if (/complete|done/.test(value)) return "completed";
  if (/progress|active|running/.test(value)) return "in_progress";
  return "pending";
}

/** 只在能拿到完整清单时更新计划：merge 模式下参数里只有变动的几项，不能当作全部。 */
export function planEntriesOf(args: Json, result: unknown): CursorPlanEntry[] | undefined {
  const fromResult = arr(resultBody(result)?.["todos"]);
  if (!fromResult && args["merge"] === true) return undefined;
  const todos = fromResult ?? arr(args["todos"]);
  if (!todos) return undefined;
  const entries: CursorPlanEntry[] = [];
  for (const raw of todos) {
    const todo = asRecord(raw);
    const text = str(todo?.["content"]) ?? str(todo?.["text"]) ?? str(todo?.["title"]);
    const status = planStatus(str(todo?.["status"]));
    if (!todo || !text || !status) continue;
    const id = str(todo["id"]);
    entries.push({ ...(id ? { id } : {}), content: text, status });
  }
  return entries.length > 0 ? entries : undefined;
}

export interface CursorTokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  reasoning: number;
  total: number;
  reported: boolean;
}

export function zeroTotals(): CursorTokenTotals {
  return { input: 0, output: 0, cacheRead: 0, reasoning: 0, total: 0, reported: false };
}

export function readTokenUsage(raw: unknown): CursorTokenTotals | undefined {
  const usage = asRecord(raw);
  if (!usage) return undefined;
  const input = num(usage["inputTokens"]) ?? 0;
  const output = num(usage["outputTokens"]) ?? 0;
  return {
    input,
    output,
    cacheRead: num(usage["cacheReadTokens"]) ?? 0,
    reasoning: num(usage["reasoningTokens"]) ?? 0,
    total: num(usage["totalTokens"]) ?? input + output,
    reported: true,
  };
}

/** 工具名到粗略类别：目前后端只需要区分 MCP 与其他。 */
export function isMcpTool(name: string): boolean {
  const key = name.toLowerCase();
  return key.startsWith("mcp") || key.includes("__");
}
