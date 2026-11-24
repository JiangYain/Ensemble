import { useSyncExternalStore } from "react";
import { collapseWhitespace, formatCount, formatDuration } from "@shared/format";
import { questionPreview } from "@shared/questions";
import { sliceHead } from "@shared/safe-slice";
import type { ActivityKind, AttentionItem, AttentionKind, SessionPhase, SessionSummary, ToolCategory } from "@shared/types";
import type { Lang, TFunction } from "./i18n";

// ───────────────────────── 时间 ─────────────────────────

let now = Date.now();
const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void): () => void {
  subscribers.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const subscriber of [...subscribers]) subscriber();
    }, 1000);
  }
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** 每秒更新一次的“现在”，所有计时显示共用同一个定时器。 */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now);
}

/** 计时器样式：0:04 / 12:03 / 1:02:03。 */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
  return `${minutes}:${ss}`;
}

/** 工具耗时：亚秒用毫秒，几秒内保留一位小数，更长的用分秒。 */
export function shortDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return formatDuration(ms);
}

export function timeOfDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour12: false });
}

/**
 * 精确到分钟的完整时刻：2026年11月14日 17:50（英文 Nov 14, 2026 17:50）。
 * 始终带上年月日、不用“今天 / 昨天”：画布可能开着过夜或隔天再看，这样的写法任何时候都准确。
 * short 是同样完整、但更窄的数字写法 2026-11-14 17:50（两种语言一样），给放不下长写法的紧凑卡片用；
 * 数字等宽、位数固定，多张卡片上下排开时还能逐位对齐。
 */
export function dateMinute(iso: string, lang: Lang, short = false): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const hm = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  if (short) {
    const two = (value: number): string => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${hm}`;
  }
  if (lang === "zh") return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${hm}`;
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} ${hm}`;
}

export function dateTime(iso: string, lang: Lang): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(lang === "zh" ? "zh-CN" : "en-US", { hour12: false, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function relative(iso: string, at: number, t: TFunction): string {
  const seconds = Math.max(0, Math.floor((at - Date.parse(iso)) / 1000));
  if (seconds < 8) return t("time.justNow");
  if (seconds < 60) return t("time.seconds", { n: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("time.minutes", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("time.hours", { n: hours });
  return t("time.days", { n: Math.floor(hours / 24) });
}

/** 会话已用时长：运行中随现在增长，结束后固定为上一次运行的时长。 */
export function elapsedOf(summary: SessionSummary, at: number): number | undefined {
  const run = summary.lastRun;
  if (summary.activeRunId && run?.startedAt) return at - Date.parse(run.startedAt);
  if (run?.durationMs !== undefined) return run.durationMs;
  if (run?.startedAt && !run.endedAt) return at - Date.parse(run.startedAt);
  return undefined;
}

// ───────────────────────── 文本 ─────────────────────────

/**
 * 外部 id（例如发起端的会话编号）的开头部分，去掉 `xxx_` 前缀；与 shared/ids.ts 里取 Ensemble id 末尾的 shortId 不同。
 * 自报的对话标识可以是任意字符串，截点落在 emoji 中间时少取一个码元，不留孤立的代理项。
 */
export function idHead(id: string, length: number): string {
  const bare = id.replace(/^[a-z]+_/i, "");
  return sliceHead(bare, length);
}

export function tokensText(value: number | undefined): string | undefined {
  return value === undefined ? undefined : formatCount(value);
}

/** 压成一行，超过 max 个码元就截断并加省略号（总长不超过 max）；截点落在 emoji 中间时少取一个，不留孤立的代理项。 */
export function oneLine(text: string, max = 140): string {
  const flat = collapseWhitespace(text);
  return flat.length > max ? `${sliceHead(flat, max - 1).trimEnd()}…` : flat;
}

/**
 * Markdown 的标记，按“在这个位置能无歧义认出来”的原则挑选；一次扫描、从左到右，被匹配的片段不会再被扫第二遍
 * （所以行内代码里看起来像标记的东西原样保留）。故意不处理的：
 * - `_` 形式的强调：和 snake_case、`__init__` 这类标识符分不开；
 * - 列表符、引用符、表格线：服务端给的摘要已经把换行压成了空格，它们和正文里的 “-”“>”“|” 分不开；
 * - 路径通配 `src/**\/a.ts`、`*.ts,*.js`、乘号 `2 * 3`：强调的开头要紧贴文字，且不能挨着 “/” “\”。
 */
const MARKDOWN_MARKS = new RegExp(
  [
    // 围栏（含紧贴在围栏后的语言名；隔着空格的是代码本身）。
    "(?<fence>(?:`{3,}|~{3,})(?:[\\w+#.-]+(?=\\s|$))?)",
    "(?<tick>`{1,2})(?<code>[^`]+?)\\k<tick>",
    '!?\\[(?<label>[^\\]]*)\\]\\([^)\\s]*(?:\\s+"[^"]*")?\\)',
    "(?<![\\w*/\\\\])\\*\\*(?=\\S)(?<bold>.+?)(?<=\\S)\\*\\*(?![\\w*/\\\\])",
    "(?<![\\w~])~~(?=\\S)(?<strike>.+?)(?<=\\S)~~(?![\\w~])",
    "(?<![\\w*/\\\\])\\*(?=[\\p{L}\\p{N}])(?<italic>[^*]+?)(?<=\\S)\\*(?![\\w*/\\\\])",
    "(?<=^|\\s)(?<hash>#{1,6})(?=\\s)",
  ].join("|"),
  "gu",
);

function stripMarks(text: string): string {
  return text.replace(MARKDOWN_MARKS, (...args) => {
    const g = args.at(-1) as Record<string, string | undefined>;
    if (g["code"] !== undefined) return g["code"];
    const inner = g["label"] ?? g["bold"] ?? g["strike"] ?? g["italic"];
    if (inner !== undefined) return stripMarks(inner);
    // 围栏换成空格（免得和前后的字粘在一起），标题的 # 直接去掉。
    return g["fence"] !== undefined ? " " : "";
  });
}

/**
 * 把一段 Markdown 摘要收成单行纯文本：去掉围栏行与行内标记，其余字符原样保留，不增不改。
 * 给页头与画布卡片的副标题用——它们只有一行，原始的 ```ts 与 ** 读起来是噪音。
 */
export function plainLine(markdown: string): string {
  return collapseWhitespace(stripMarks(markdown));
}

export function pathName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

// ───────────────────────── 状态文案 ─────────────────────────

export function phaseLabel(phase: SessionPhase, t: TFunction): string {
  return t(`phase.${phase}`);
}

const TOOL_VERB: Record<ToolCategory, string> = {
  read: "act.read",
  write: "act.write",
  edit: "act.write",
  search: "act.search",
  shell: "act.shell",
  web: "act.web",
  mcp: "act.mcp",
  task: "act.task",
  plan: "act.plan",
  other: "act.other",
};

export function toolVerb(category: ToolCategory, t: TFunction): string {
  return t(TOOL_VERB[category]);
}

export function activityLabel(kind: ActivityKind, t: TFunction): string {
  return t(`activity.${kind}`);
}

/**
 * 节点副标题：只讲执行端真实上报的事——正在用的工具、在思考/写回复，或结束后的结论。
 * 没有更具体的信息时如实写“执行中”，不编造步骤。
 */
export function subtitleOf(summary: SessionSummary, t: TFunction): string {
  const { activity } = summary;
  switch (summary.phase) {
    case "running": {
      // 执行端停下来问了问题、在等回答：副标题直说这件事，而不是继续写“执行中”。
      if (summary.openQuestions) return t("question.waiting");
      if (activity.kind === "tool" && activity.tool) return `${toolVerb(activity.tool.category, t)} ${oneLine(activity.tool.title, 80)}`;
      return activityLabel(activity.kind, t);
    }
    case "done": {
      // 取自执行端最后一条回复（Markdown），显示前去掉标记；工具标题与错误原文不是 Markdown，不做处理。
      const reply = summary.lastAssistantPreview ? plainLine(summary.lastAssistantPreview) : "";
      return reply ? oneLine(reply, 90) : t("activity.done");
    }
    case "failed":
      return summary.lastError ? oneLine(summary.lastError.message, 90) : t("activity.failed");
    case "ready":
      return activityLabel("ready", t);
    default:
      return activityLabel(activity.kind, t);
  }
}

export function isActivePhase(phase: SessionPhase): boolean {
  return phase === "running" || phase === "starting" || phase === "queued";
}

const ATTENTION_KEY: Record<AttentionKind, string> = {
  quiet: "attention.quiet",
  long_tool: "attention.longTool",
  long_run: "attention.longRun",
  shared_file: "attention.sharedFile",
  undelivered: "attention.undelivered",
  question: "attention.question",
};

/**
 * 一条“值得留意”的事实，写成一句话：只陈述有事件依据的内容，不下结论。
 * 时长从事实成立的起点算到 `at`，所以调用方要随 useNow() 重新取值。
 */
export function attentionText(item: AttentionItem, at: number, t: TFunction): string {
  const d = formatDuration(at - Date.parse(item.since));
  switch (item.kind) {
    case "quiet":
    case "long_run":
      return t(ATTENTION_KEY[item.kind], { d });
    case "long_tool":
      return t(ATTENTION_KEY.long_tool, {
        d,
        tool: `${toolVerb(item.tool.category, t)} ${oneLine(item.tool.title, 60)}`,
        started: formatDuration(at - Date.parse(item.tool.startedAt)),
      });
    case "shared_file":
      return t(ATTENTION_KEY.shared_file, { file: pathName(item.path), n: item.withSessionIds.length, d });
    case "undelivered":
      return t(ATTENTION_KEY.undelivered, { kind: t(`msg.kind.${item.messageKind}`), d, state: t(`delivery.${item.stage}`) });
    case "question":
      // 提问原文只取第一个问题的一行摘要；完整的问题与回答入口在时间线里的提问卡片上。
      return t(ATTENTION_KEY.question, { q: questionPreview(item.prompts, 100), d });
  }
}

/** 悬停提示：一行标题 + 每条事实一行。 */
export function attentionTip(items: readonly AttentionItem[], at: number, t: TFunction): string {
  return [t("attention.title"), ...items.map((item) => attentionText(item, at, t))].join("\n");
}
