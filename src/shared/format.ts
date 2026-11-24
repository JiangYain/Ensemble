import { sliceHead, sliceTail } from "./safe-slice";
import type { Preview } from "./types";

/** 文本与数值格式化（服务端、MCP 文本、网页共用，全部是无副作用的纯函数）。 */

export function isoNow(): string {
  return new Date().toISOString();
}

export function msBetween(from: string, to: string): number {
  return Math.max(0, Date.parse(to) - Date.parse(from));
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 任意抛出值的可读文本：Error 取 message，字符串原样，其余尽量写成 JSON（写不出来时退回 String）。 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** 以数字开头的版本号加上 v；Cursor 的 “SDK 1.3.1” 这类自带说明的写法原样保留。 */
export function versionLabel(version: string): string {
  return /^\d/.test(version) ? `v${version}` : version;
}

/** 近似显示宽度：CJK 与全角字符按 2 计。 */
function charWidth(codePoint: number): number {
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  ) {
    return 2;
  }
  return 1;
}

/** 按显示宽度截断，超出时追加省略号。 */
export function clipByWidth(text: string, maxWidth: number): string {
  let width = 0;
  let out = "";
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0) ?? 0);
    if (width + w > maxWidth - 1) {
      return `${out.trimEnd()}…`;
    }
    width += w;
    out += ch;
  }
  return out;
}

/** 超长时保留开头并加省略号。截点落在代理对（emoji）中间时少留一个码元，不留孤立的代理项，见 safe-slice.ts。 */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${sliceHead(text, Math.max(0, max - 1)).trimEnd()}…`;
}

/** 超长时保留结尾并加省略号。起点落在代理对中间时同样少留一个码元。 */
export function tail(text: string, max: number): string {
  if (text.length <= max) return text;
  return `…${sliceTail(text, Math.max(0, max - 1)).trimStart()}`;
}

function safeStringify(value: unknown): { text: string; format: "text" | "json" } {
  if (typeof value === "string") return { text: value, format: "text" };
  if (value === undefined) return { text: "", format: "text" };
  try {
    const seen = new WeakSet<object>();
    const text = JSON.stringify(
      value,
      (_key, val: unknown) => {
        if (typeof val === "bigint") return val.toString();
        if (typeof val === "object" && val !== null) {
          if (seen.has(val)) return "[Circular]";
          seen.add(val);
        }
        return val;
      },
      2,
    );
    return { text: text ?? "", format: "json" };
  } catch {
    return { text: String(value), format: "text" };
  }
}

/**
 * 生成带截断标记的预览。保留头部与尾部（命令错误通常出现在输出末尾），
 * 并明确写出省略了多少字符，避免把截断的内容误当作完整输出。
 */
export function makePreview(value: unknown, limit: number, formatHint?: Preview["format"]): Preview {
  const { text, format } = safeStringify(value);
  const chars = text.length;
  const resolvedFormat = formatHint ?? format;
  if (chars <= limit) return { text, truncated: false, chars, format: resolvedFormat };

  const head = Math.floor(limit * 0.6);
  const rest = limit - head;
  // 头尾各自落在代理对中间时会少留一个码元，所以“省略了多少”按实际留下的算，而不是 chars - limit。
  const headText = sliceHead(text, head);
  const tailText = sliceTail(text, rest);
  const omitted = chars - headText.length - tailText.length;
  return {
    text: `${headText}\n… ${omitted} chars omitted …\n${tailText}`,
    truncated: true,
    chars,
    format: resolvedFormat,
  };
}

export function basename(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

/** 中间省略的路径缩写，始终保留文件名。skills 里的 watch.mjs 抄了一份同样的写法，测试逐字对照，改这里要两边一起改。 */
export function shortenPath(path: string, max = 52): string {
  if (path.length <= max) return path;
  const name = basename(path);
  // 名字本身放不下，或者连同省略号几乎占满 max（名字长度 ≥ max - 2）：不留头部，只留名字的结尾，至多 max - 1 个字符。
  // 名字只有 max - 2 个字符时，max - 1 比它还长，sliceTail 把越界的数夹成整段，所以整个名字都留下；
  // 别改回 name.slice(name.length - (max - 1))：这个边界上下标是 -1，slice 把它当成“倒数第一个”，名字就只剩最后一个字符。
  if (name.length >= max - 2) return `…${sliceTail(name, max - 1)}`;
  const room = max - name.length - 2;
  return `${sliceHead(path, Math.max(3, room))}…${sliceTail(path, name.length + 1)}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(value));
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "$0";
  if (value > 0 && value < 0.01) return "<$0.01";
  return `$${value.toFixed(value >= 10 ? 1 : 2)}`;
}

/** 从委派原文派生一个简短标题：取第一行有内容的文字，去掉 Markdown 记号。 */
export function deriveTitle(taskText: string, maxWidth = 44): string {
  const lines = taskText
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s>#*\-+\d.)]+/, "").replace(/[`*_]/g, "").trim())
    .filter((line) => line.length > 0);
  const first = lines[0] ?? "Untitled task";
  const sentence = first.split(/(?<=[。！？.!?])\s*/u)[0] ?? first;
  return clipByWidth(sentence.length >= 6 ? sentence : first, maxWidth);
}
