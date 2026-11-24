/**
 * 会话报告的选项与预算：范围、详细程度、语言、各处引用的字符上限，以及预算放不下时逐级收紧的阶梯。
 *
 * 只有常量、类型和一个纯函数，不依赖渲染器、也不依赖标签表：HTTP 请求校验、MCP 桥与网页只需要这几个取值，
 * 不该为此把整个报告渲染器拉进来。shared/report.ts 仍把它们原样再导出，原来的导入路径照常可用。
 */

import type { SessionId } from "./types";

// ───────────────────────── 对外类型与上限 ─────────────────────────

export const REPORT_SCOPES = ["session", "tree"] as const;
export const REPORT_DETAILS = ["brief", "full"] as const;
export const REPORT_LANGS = ["en", "zh"] as const;
export type ReportScope = (typeof REPORT_SCOPES)[number];
export type ReportDetail = (typeof REPORT_DETAILS)[number];
export type ReportLang = (typeof REPORT_LANGS)[number];

/**
 * 报告里各处的上限。都是实现取舍，不是用户逐项确认的数值；超出时一律在原处明文写出被截掉多少，不会悄悄发生。
 */
export const REPORT_LIMITS = {
  /** maxChars 的下限：再小连概览、一个会话的最小片段和页脚说明都放不下。 */
  minChars: 6_000,
  /** brief 里每次运行最多逐条列出的关键步骤；超出时取开头与结尾各一半，中间只计数。 */
  stepsPerRun: 40,
  /** 委派原文与最终回答（整段引用）的字符上限。 */
  textChars: { brief: 30_000, full: 100_000 },
  /** 其余引用块（补充消息、上下文条目、助手文字、工具输入、错误详情）的字符上限。 */
  blockChars: { brief: 600, full: 1_500 },
  /** detail=full 里每条工具输出的字符上限（头尾各留一部分，中间标明省略了多少）。brief 不收录工具输出。 */
  outputChars: 1_500,
  /** 改动文件清单最多列出的路径数。 */
  filesListed: { brief: 200, full: 2_000 },
  /** 行内引用（命令行、错误、计划条目、诊断消息）的字符上限。 */
  inlineChars: 240,
  /** 一次运行的计划最多列出的条目数。 */
  planEntries: 40,
  /** 一个会话的片段至少要有这么多预算才值得展开，否则整段略去。 */
  minSectionChars: 1_500,
} as const;

export interface ReportOptions {
  scope: ReportScope;
  detail: ReportDetail;
  lang: ReportLang;
  /** 导出时刻（ISO）。由调用方传入：渲染器不读时钟，同一份输入永远得到同一份输出。 */
  exportedAt: string;
  /** 生成报告的 Ensemble 版本，写在“生成说明”里。 */
  version: string;
  /** 输出的字符数上限；缺省 = 不限。小于 REPORT_LIMITS.minChars 的值按 minChars 处理。 */
  maxChars?: number;
  /**
   * 报告引用到、却不在报告里的会话的标题（会话编号 → 标题）：汇聚节点（有多个上级）的“还跟随”一行要写出别的上级，
   * 那些上级可能在这棵树之外。报告自己包含的会话用它们自己的标题；这里没有、又不在报告里的，只写编号。
   */
  references?: Readonly<Record<SessionId, string>>;
}

// ───────────────────────── 预算放不下时逐级收紧 ─────────────────────────

/** 各类引用的上限；一个会话片段放不下预算时按阶梯逐级收紧（见 CAPS）。 */
export interface Trim {
  steps: number;
  text: number;
  block: number;
  output: number;
  files: number;
  inline: number;
  /** 完整展开的运行数（从最后一次往前数）；更早的运行只留一行标题。会话有几十次补充消息时，光是各次运行的抬头就能撑破预算。 */
  runs: number;
}

/** 第 1…4 级收紧的上限（第 0 级是 REPORT_LIMITS 里的基础值）。output 为 0 = 不收录工具输出。 */
const CAPS: readonly Trim[] = [
  { steps: 12, text: 8_000, block: 400, output: 400, files: 60, inline: 160, runs: 10 },
  { steps: 4, text: 3_000, block: 200, output: 0, files: 20, inline: 120, runs: 5 },
  { steps: 0, text: 1_200, block: 120, output: 0, files: 8, inline: 100, runs: 3 },
  { steps: 0, text: 400, block: 80, output: 0, files: 0, inline: 80, runs: 2 },
];
/** 一个会话片段最多试几档：第 0 档（基础值）加上 CAPS 里的各档。 */
export const LEVELS = CAPS.length + 1;

export function trimFor(detail: ReportDetail, level: number): Trim {
  const base: Trim = {
    steps: detail === "full" ? Number.POSITIVE_INFINITY : REPORT_LIMITS.stepsPerRun,
    text: REPORT_LIMITS.textChars[detail],
    block: REPORT_LIMITS.blockChars[detail],
    output: detail === "full" ? REPORT_LIMITS.outputChars : 0,
    files: REPORT_LIMITS.filesListed[detail],
    inline: REPORT_LIMITS.inlineChars,
    runs: Number.POSITIVE_INFINITY,
  };
  const cap = level > 0 ? CAPS[level - 1] : undefined;
  if (!cap) return base;
  return {
    runs: Math.min(base.runs, cap.runs),
    steps: Math.min(base.steps, cap.steps),
    text: Math.min(base.text, cap.text),
    block: Math.min(base.block, cap.block),
    output: Math.min(base.output, cap.output),
    files: Math.min(base.files, cap.files),
    inline: Math.min(base.inline, cap.inline),
  };
}
