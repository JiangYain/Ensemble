/**
 * 报告的 Markdown 原语：转义、围栏、表格、截断，数字与时间的写法，以及带截断提示的“引用”（行内文字 / 行内代码 / 围栏块）。
 *
 * 纯函数，不碰 Node API，也不读时钟。所有“被引用的原文”一律放进围栏代码块：围栏长度总是比内容里最长的反引号串多一个
 * （至少 3 个），所以原文里的 Markdown、HTML、未闭合的围栏都不会漏出来影响报告的版式；任何一处截断都有明文提示，不会悄悄发生。
 * 会话章节怎么写在 report-session.ts，过程里逐条的步骤（含提问）与散落条目怎么写在 report-steps.ts，任务树怎么排、预算怎么分在 report.ts。
 */

import { formatDuration } from "./format";
import { fmt, REPORT_LABELS } from "./report-labels";
import type { ReportLabelKey } from "./report-labels";
import type { ReportDetail, ReportLang, ReportOptions } from "./report-options";
import { isHighSurrogate, isLowSurrogate } from "./safe-slice";
import type { Preview, SessionId } from "./types";

// ───────────────────────── 文本基础 ─────────────────────────

export const DASH = "—";

/** 大数组逐条追加：展开参数在元素过多时会爆栈，而引用内容的行数是不受控的。 */
export function pushAll(target: string[], source: readonly string[]): void {
  for (const line of source) target.push(line);
}

/**
 * 统一换行；除制表符与换行外的控制字符换成 Unicode 的可见符号（␀ … ␡）：
 * 报告是要被存档和转发的纯文本，不该夹带会改写终端或编辑器显示的字符。
 */
function clean(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (ch) =>
      ch === "\u007f" ? "\u2421" : String.fromCharCode(0x2400 + ch.charCodeAt(0)),
    );
}

/** 折成一行（所有空白并成一个空格）：用于行内文字。 */
export function oneLine(text: string): string {
  return clean(text).replace(/\s+/g, " ").trim();
}

/** 折成一行但保留行内的连续空格：用于行内代码（命令行里的空格是有意义的）。 */
function flat(text: string): string {
  return clean(text).replace(/\s*\n\s*/g, " ").trim();
}

/** 行内字面文字：转义会被 Markdown 当作标记的字符（`|` 不在这里处理，只在表格单元格里统一转义一次）。 */
export function esc(text: string): string {
  return oneLine(text).replace(/[\\`*_[\]<>~$]/g, "\\$&");
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}

/** 行内代码：定界符比内容里最长的反引号串多一个；内容以空格或反引号开头 / 结尾时两侧各补一个空格。 */
export function code(text: string): string {
  const body = flat(text);
  if (body === "") return DASH;
  const mark = "`".repeat(longestBacktickRun(body) + 1);
  const pad = /^[ `]|[ `]$/.test(body) ? " " : "";
  return `${mark}${pad}${body}${pad}${mark}`;
}

/** 围栏代码块：围栏长度比内容里最长的反引号串多一个（至少 3 个）；indent 用于嵌在列表项里的块。 */
function fenceLines(text: string, language: string, indent: string): string[] {
  const body = clean(text).replace(/^\n+/, "").replace(/\n+$/, "");
  const mark = "`".repeat(Math.max(3, longestBacktickRun(body) + 1));
  const lines = body.split("\n").map((line) => (line === "" ? "" : indent + line));
  return [`${indent}${mark}${language}`, ...lines, `${indent}${mark}`];
}

/** 表格单元格：单行，`|` 一律转义（GFM 要求连行内代码里的也要）。 */
function cell(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|");
}

export function tableLines(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  rightAligned: readonly number[] = [],
): string[] {
  const line = (cells: readonly string[]): string => `| ${cells.map(cell).join(" | ")} |`;
  const rule = header.map((_, index) => (rightAligned.includes(index) ? "---:" : "---"));
  return [line(header), `| ${rule.join(" | ")} |`, ...rows.map(line)];
}

// 下面两个截法与 safe-slice.ts 的 sliceHead / sliceTail 有意不合并：这里是单侧规则（头部截点前一个码元是高位代理就让出，
// 尾部起点是低位代理就跳过，不看另一侧），safe-slice 是成对规则（原文里本来就孤立的代理项恰好落在截点时原样保留）。
// 两者只在这种退化输入上不同；这里的行为一字不改，只共用判断码元的两个小函数。

/** 保留开头 cap 个字符；不会把一个代理对切成两半。omitted 是被略去的字符数（UTF-16 码元数，与 LIMITS 同口径）。 */
function clipEnd(text: string, cap: number): { text: string; omitted: number } {
  const body = clean(text);
  if (body.length <= cap) return { text: body, omitted: 0 };
  let end = Math.max(0, cap);
  if (end > 0 && isHighSurrogate(body.charCodeAt(end - 1))) end -= 1;
  return { text: body.slice(0, end), omitted: body.length - end };
}

/** 保留头部 40% 与尾部 60%（命令的错误通常在输出末尾），中间换成一行标记。 */
function clipMiddle(text: string, cap: number, marker: (omitted: number) => string): string {
  const body = clean(text);
  if (body.length <= cap) return body;
  let headEnd = Math.floor(cap * 0.4);
  let tailStart = body.length - (cap - headEnd);
  if (headEnd > 0 && isHighSurrogate(body.charCodeAt(headEnd - 1))) headEnd -= 1;
  if (tailStart < body.length && isLowSurrogate(body.charCodeAt(tailStart))) tailStart += 1;
  return `${body.slice(0, headEnd)}\n${marker(tailStart - headEnd)}\n${body.slice(tailStart)}`;
}

export function num(value: number): string {
  if (!Number.isFinite(value)) return DASH;
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 费用：保留 4 位小数，再去掉至多两个末尾的 0（最少两位小数）。 */
function usd(value: number): string {
  if (!Number.isFinite(value)) return DASH;
  return `$${value.toFixed(4).replace(/0{1,2}$/, "")}`;
}

export function utc(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return esc(iso);
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

export function clock(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? "--:--:--" : new Date(ms).toISOString().slice(11, 19);
}

export function heading(level: number, text: string): string {
  return `${"#".repeat(level)} ${text}`;
}

// ───────────────────────── 渲染上下文与引用 ─────────────────────────

export interface Ctx {
  lang: ReportLang;
  detail: ReportDetail;
  tree: boolean;
  /** 会话在树里的编号（"1.2"）；scope=session 时为空。 */
  number: string;
  /** 并列短语之间的分隔符。 */
  sep: string;
  /** 报告里已知的会话标题（报告包含的会话加上 ReportOptions.references），用来给“还跟随”的那些上级写标题。 */
  titles: ReadonlyMap<SessionId, string>;
  t: (key: ReportLabelKey, vars?: Readonly<Record<string, string | number>>) => string;
}

export function makeCtx(options: ReportOptions, tree: boolean, number: string, titles: ReadonlyMap<SessionId, string> = new Map()): Ctx {
  const labels = REPORT_LABELS[options.lang] ?? REPORT_LABELS.en;
  return {
    lang: options.lang,
    detail: options.detail,
    tree,
    number,
    sep: options.lang === "zh" ? "、" : ", ",
    titles,
    t: (key, vars) => fmt(labels[key], vars),
  };
}

/** 行内文字（转义后）；超过 cap 时在末尾写明还有多少字符没显示。 */
export function inlineText(c: Ctx, text: string, cap: number): string {
  const cut = clipEnd(oneLine(text), cap);
  return `${esc(cut.text)}${cut.omitted > 0 ? ` ${c.t("cutInline", { n: num(cut.omitted) })}` : ""}`;
}

/** 行内代码；超过 cap 时在代码外写明还有多少字符没显示。 */
export function inlineCode(c: Ctx, text: string, cap: number): string {
  const cut = clipEnd(flat(text), cap);
  return `${code(cut.text)}${cut.omitted > 0 ? ` ${c.t("cutInline", { n: num(cut.omitted) })}` : ""}`;
}

/** 命令行：只取第一行有内容的，多出的行数写明；行内长度同样受 cap 限制。 */
export function commandInline(c: Ctx, text: string, cap: number): string {
  const lines = clean(text).split("\n").filter((line) => line.trim() !== "");
  const extra = lines.length - 1;
  return `${inlineCode(c, lines[0] ?? "", cap)}${extra > 0 ? ` ${c.t("cutLines", { n: num(extra) })}` : ""}`;
}

interface QuoteOptions {
  indent?: string;
  language?: string;
  /** 头尾各留一部分、中间换成标记（工具输出用）；默认只留开头、截断提示放在块后。 */
  middle?: boolean;
}

/** 被引用的原文：围栏代码块；超出 cap 时明文写出省略了多少字符。 */
export function quote(c: Ctx, text: string, cap: number, options: QuoteOptions = {}): string[] {
  const indent = options.indent ?? "";
  const language = options.language ?? "text";
  if (text.trim() === "") return [`${indent}${c.t("emptyText")}`];
  if (options.middle) {
    const body = clipMiddle(text, cap, (omitted) => c.t("cutInBlock", { n: num(omitted) }));
    return fenceLines(body, language, indent);
  }
  const cut = clipEnd(text, cap);
  const lines = fenceLines(cut.text, language, indent);
  if (cut.omitted > 0) lines.push(`${indent}${c.t("cutBlock", { n: num(cut.omitted) })}`);
  return lines;
}

export function languageOf(preview: Preview | undefined): string {
  return preview?.format === "json" ? "json" : preview?.format === "diff" ? "diff" : "text";
}

// ───────────────────────── 用量表的单元格 ─────────────────────────

export function tokenCell(c: Ctx, value: number | undefined, starred: boolean): string {
  return value === undefined ? c.t("uNotReported") : `${num(value)}${starred ? "\\*" : ""}`;
}

export function costCell(c: Ctx, value: number | undefined, starred: boolean): string {
  return value === undefined ? c.t("uNotReported") : `${usd(value)}${starred ? "\\*" : ""}`;
}

export function durationCell(value: number | undefined): string {
  return value === undefined ? DASH : formatDuration(value);
}

// ───────────────────────── 安全网：按行截断并补上未闭合的围栏 ─────────────────────────

/**
 * 在不超过 max 个字符的前提下，按整行截断一段 Markdown，并补上被截断时仍未闭合的围栏，
 * 免得后面接上去的内容被当成代码块的一部分。预算耗尽时由 ReportBuilder 当作最后一道安全网使用。
 */
export function cutMarkdown(text: string, max: number): string {
  if (text.length <= max) return text;
  const kept: string[] = [];
  let size = 0;
  let open: { mark: string; indent: string } | undefined;
  for (const line of text.split("\n")) {
    const opener = open ? undefined : /^(\s*)(`{3,})([^`]*)$/.exec(line);
    const pending = open ?? (opener ? { indent: opener[1] ?? "", mark: opener[2] ?? "" } : undefined);
    // 每一行都要给“补上闭合围栏”留出位置。
    const reserve = pending ? pending.indent.length + pending.mark.length + 1 : 0;
    if (size + line.length + 1 + reserve > max) break;
    kept.push(line);
    size += line.length + 1;
    if (!open) {
      if (opener) open = { indent: opener[1] ?? "", mark: opener[2] ?? "" };
    } else {
      const closer = /^\s*(`{3,})\s*$/.exec(line);
      if (closer && (closer[1]?.length ?? 0) >= open.mark.length) open = undefined;
    }
  }
  if (open) kept.push(`${open.indent}${open.mark}`);
  return kept.join("\n");
}
