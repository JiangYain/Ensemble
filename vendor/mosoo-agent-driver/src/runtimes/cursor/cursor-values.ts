// ENSEMBLE ADDED — 本文件由 Ensemble 新增（Cursor SDK 后端），不属于上游 mosoo-agent-driver。详见 VENDORING.md。
import { isAbsolute, relative } from "node:path";

/** SDK 消息与参数是 unknown：这里是宽松取值的小工具，不做任何猜测式转换。 */
export type Json = Record<string, unknown>;

export function asRecord(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
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

/** 非空字符串。 */
export function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function oneLine(text: string, max: number): string {
  return clip(collapseWhitespace(text), max);
}

/** 统一换行并去掉首尾空白，用来比较“发出去的文本”和“执行端回显的文本”。 */
export function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

/** 路径的统一写法：工作目录内用相对路径，统一为正斜杠，避免同一文件出现两种写法。 */
export function displayPath(cwd: string, path: string): string {
  const normalize = (value: string): string => value.replace(/\\/g, "/");
  if (!isAbsolute(path)) return normalize(path).replace(/^\.\//, "");
  const rel = relative(cwd, path);
  if (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)) return normalize(rel);
  return normalize(path);
}

/**
 * 把可能很长的文本压成不超过 limit 个字符：保留头部与尾部（命令错误通常出现在输出末尾），
 * 并写明省略了多少字符。事件里不应无限制地搬运工具输出。
 */
export function clipMiddle(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.6);
  const rest = limit - head;
  const omitted = text.length - head - rest;
  return `${text.slice(0, head)}\n… ${omitted} chars omitted …\n${text.slice(text.length - rest)}`;
}

/** 序列化失败（循环引用、bigint）时不抛出：工具参数只是展示用途。 */
export function stringifyForDisplay(value: unknown): { text: string; format: "text" | "json" } {
  if (typeof value === "string") return { text: value, format: "text" };
  if (value === undefined) return { text: "", format: "text" };
  try {
    const seen = new WeakSet<object>();
    const text = JSON.stringify(
      value,
      (_key, entry: unknown) => {
        if (typeof entry === "bigint") return entry.toString();
        if (typeof entry === "object" && entry !== null) {
          if (seen.has(entry)) return "[Circular]";
          seen.add(entry);
        }
        return entry;
      },
      2,
    );
    return { text: text ?? "", format: "json" };
  } catch {
    return { text: String(value), format: "text" };
  }
}
