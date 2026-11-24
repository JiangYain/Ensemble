import { isAbsolute, relative } from "node:path";
import { LIMITS } from "@shared/constants";
import { clip, collapseWhitespace, makePreview } from "@shared/format";
import type { ErrorInfo, Preview, RunId, ToolCategory } from "@shared/types";
import type { ExecutorDraft } from "./types";

/** 适配器共用的小工具：宽松的 JSON 取值、工具归类、路径展示、错误归类。 */

export type Json = Record<string, unknown>;

export function asRecord(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function arr(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/**
 * 适配器在连接/启动执行端时失败。带稳定的错误码，管理器会原样写进 run.failed，
 * 这样界面与主 Agent 看到的是“模型不存在 / 需要登录”这类可行动的原因，而不是泛泛的“启动失败”。
 */
export class HarnessStartError extends Error {
  readonly code: string;
  readonly detail: string | undefined;

  constructor(code: string, message: string, detail?: string) {
    super(message);
    this.name = "HarnessStartError";
    this.code = code;
    this.detail = detail;
  }
}

/** 统一换行并去掉首尾空白，用来比较“发出去的文本”和“执行端回显的文本”。 */
export function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

export function oneLine(text: string, max: number): string {
  return clip(collapseWhitespace(text), max);
}

/** 给适配器事件盖上运行标识（没有运行时原样返回）。草稿是带判别字段的联合类型，展开后 TS 保不住联合，断言只在这里做一次。 */
export function stampRun(draft: ExecutorDraft, runId: RunId | undefined): ExecutorDraft {
  return runId ? ({ ...draft, runId } as ExecutorDraft) : draft;
}

// ───────────────────────── 工具 ─────────────────────────

const CATEGORY_BY_NAME: Record<string, ToolCategory> = {
  read: "read",
  read_file: "read",
  view: "read",
  cat: "read",
  write: "write",
  write_file: "write",
  create: "write",
  create_file: "write",
  edit: "edit",
  edit_file: "edit",
  multiedit: "edit",
  str_replace: "edit",
  strreplace: "edit",
  apply_patch: "edit",
  applyagentdiff: "edit",
  patch: "edit",
  delete: "edit",
  delete_file: "edit",
  readlints: "read",
  semsearch: "search",
  grep: "search",
  find: "search",
  ls: "search",
  glob: "search",
  search: "search",
  list_dir: "search",
  ripgrep: "search",
  bash: "shell",
  shell: "shell",
  exec: "shell",
  command: "shell",
  terminal: "shell",
  run_terminal_cmd: "shell",
  web_search: "web",
  websearch: "web",
  web_fetch: "web",
  webfetch: "web",
  fetch: "web",
  task: "task",
  subagent: "task",
  todo: "plan",
  todo_write: "plan",
  todowrite: "plan",
  updatetodos: "plan",
  readtodos: "plan",
  createplan: "plan",
  update_plan: "plan",
  plan: "plan",
};

export function categorizeTool(name: string): ToolCategory {
  const key = name.toLowerCase();
  const direct = CATEGORY_BY_NAME[key];
  if (direct) return direct;
  if (key.startsWith("mcp") || key.includes("__")) return "mcp";
  return "other";
}

/** 路径在界面上的统一写法：工作目录内用相对路径，统一为正斜杠，避免同一文件出现两种写法。 */
export function displayPath(cwd: string, path: string): string {
  const normalize = (value: string): string => value.replace(/\\/g, "/");
  if (!isAbsolute(path)) return normalize(path).replace(/^\.\//, "");
  const rel = relative(cwd, path);
  if (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)) return normalize(rel);
  return normalize(path);
}

/** 从 MCP / Pi 风格的 content 数组（[{type:"text", text}]）取文本。 */
export function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  const blocks = arr(content);
  if (!blocks) return "";
  const parts: string[] = [];
  for (const block of blocks) {
    const record = asRecord(block);
    if (!record) continue;
    const text = str(record["text"]);
    if (text !== undefined) parts.push(text);
    else if (record["type"] === "image") parts.push("[image]");
  }
  return parts.join("\n");
}

export function outputPreview(text: string): Preview {
  return makePreview(text, LIMITS.maxToolOutputChars, "text");
}

export function inputPreview(value: unknown, hint?: Preview["format"]): Preview {
  return makePreview(value, LIMITS.maxToolInputChars, hint);
}

/** 统计统一 diff 中新增/删除的行数（忽略文件头）。 */
export function countDiffLines(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return { added, removed };
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

// ───────────────────────── 错误 ─────────────────────────

/** 把执行端返回的错误文本归类为稳定的错误码，方便界面本地化与主 Agent 判断是否值得重试。 */
export function classifyError(message: string): Pick<ErrorInfo, "code" | "retryable"> {
  const text = message.toLowerCase();
  // “The 'x' model is not supported when using Codex with a ChatGPT account” 是 Codex 对不可用模型的真实说法。
  if (/model.{0,60}(not found|not supported|does not exist)|unknown model|invalid model|unsupported model|model_not_found/.test(text)) {
    return { code: "model_not_found" };
  }
  if (/\b401\b|unauthori[sz]ed|invalid api key|authentication|not logged in|login required|credential|api key/.test(text)) {
    return { code: "auth_failed" };
  }
  if (/\b429\b|rate.?limit|usage.?limit|quota|too many requests|insufficient/.test(text)) return { code: "rate_limited", retryable: true };
  if (/context (length|window)|too long|maximum context|token limit|context_length/.test(text)) return { code: "context_overflow" };
  if (/overloaded|\b5\d\d\b|unavailable|timeout|timed out|econnreset|enotfound|network|fetch failed/.test(text)) {
    return { code: "provider_unavailable", retryable: true };
  }
  return { code: "model_error" };
}

/** 执行端报告的错误文本 → 带归类错误码的 ErrorInfo（与 server/errors.ts 里处理“抛出的值”的 toErrorInfo 不同）。 */
export function errorInfoFromText(message: string, detail?: string): ErrorInfo {
  const classified = classifyError(message);
  return {
    code: classified.code,
    message: clip(collapseWhitespace(message), 400),
    ...(detail && detail !== message ? { detail: clip(detail, 2_000) } : {}),
    ...(classified.retryable !== undefined ? { retryable: classified.retryable } : {}),
  };
}
