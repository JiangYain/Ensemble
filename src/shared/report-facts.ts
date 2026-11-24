/**
 * 一个会话在报告里要用到的事实：从事件日志里**一次性**整理出来，之后各档预算收紧时只读它、不再重算。
 *
 * 为什么单独整理：字符预算放不下时，ReportBuilder 会把同一个会话按五档逐级收紧、重新渲染（见 report-options 的 trimFor）。
 * 回放日志、按运行分组、挑出每次运行的回答、分出关键步骤、汇总用量，这些只取决于日志本身与 detail，
 * 与收紧到第几档无关，所以在这里做一次；report-session.ts 的 formatSession 只消费这里的结果，不碰事件，也不改它。
 *
 * 真实性：这里只做分类与计数，不改写任何内容——引用的文字仍是时间线条目 / 消息 / 事件里的原对象，转义与截断留给渲染那一步。
 */

import type { EnsembleEvent } from "./events";
import { msBetween } from "./format";
import { replay } from "./projection";
import type { SessionState } from "./projection";
import type { ReportDetail } from "./report-options";
import { preferredAssistant } from "./timeline-selectors";
import type {
  Actor,
  AssistantItem,
  DiagnosticItem,
  ErrorInfo,
  Message,
  PlanItem,
  QuestionItem,
  Run,
  RunId,
  SessionStatus,
  SessionSummary,
  TimelineItem,
  ToolItem,
  Usage,
} from "./types";

/** 字符串按码元比较：排序不依赖 locale，同一份输入永远得到同一份输出。 */
export function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ───────────────────────── 用量 ─────────────────────────

export interface UsageRow {
  input?: number;
  output?: number;
  cached?: number;
  reasoning?: number;
  cost?: number;
  /** 运行时长（毫秒）：只有开始与结束时间都有的运行才有。 */
  ms?: number;
}
export type UsageKey = keyof UsageRow;
const USAGE_KEYS: readonly UsageKey[] = ["input", "output", "cached", "reasoning", "cost", "ms"];

function usageRow(usage: Usage | undefined, run: Run | undefined): UsageRow {
  const row: UsageRow = {};
  const input = usage?.inputTokens;
  const output = usage?.outputTokens;
  const cached = usage?.cachedTokens;
  const reasoning = usage?.reasoningTokens;
  const cost = usage?.costUsd;
  if (input !== undefined) row.input = input;
  if (output !== undefined) row.output = output;
  if (cached !== undefined) row.cached = cached;
  if (reasoning !== undefined) row.reasoning = reasoning;
  if (cost !== undefined) row.cost = cost;
  if (run?.startedAt && run.endedAt) row.ms = msBetween(run.startedAt, run.endedAt);
  return row;
}

/** 合计：某一项一个运行都没上报就留空；只有部分运行上报时，合计只是已上报部分的和，记进 partial 以便标注。 */
export function sumRows(rows: readonly UsageRow[]): { total: UsageRow; partial: Set<UsageKey> } {
  const total: UsageRow = {};
  const partial = new Set<UsageKey>();
  for (const key of USAGE_KEYS) {
    let sum = 0;
    let have = 0;
    for (const row of rows) {
      const value = row[key];
      if (value !== undefined) {
        sum += value;
        have += 1;
      }
    }
    if (have > 0) total[key] = sum;
    if (have > 0 && have < rows.length) partial.add(key);
  }
  return { total, partial };
}

export interface UsageEntry {
  run: Run;
  row: UsageRow;
}

/** 参与用量统计的运行：已经开始（或结束）的；排队中还没开始的没有用量可言。 */
function usageRuns(state: SessionState): UsageEntry[] {
  const out: UsageEntry[] = [];
  for (const run of state.runs) {
    if (run.status === "queued") continue;
    out.push({ run, row: usageRow(state.usageByRun[run.id], run) });
  }
  return out;
}

/** 一个会话的用量：逐次运行的行、合计，以及合计里哪几项只是部分运行上报的和。 */
export interface UsageFacts {
  entries: readonly UsageEntry[];
  total: UsageRow;
  partial: ReadonlySet<UsageKey>;
}

function usageOf(state: SessionState | undefined): UsageFacts {
  const entries = state ? usageRuns(state) : [];
  const { total, partial } = sumRows(entries.map((entry) => entry.row));
  return { entries, total, partial };
}

// ───────────────────────── 从事件日志里读出来的东西 ─────────────────────────

export interface SessionNote {
  at: string;
  status: SessionStatus;
  reason?: string;
  error?: ErrorInfo;
}

export interface CancelNote {
  at: string;
  by?: Actor;
  note?: string;
}

/**
 * 只能从原始事件里取的几类（投影 replay 不保留）：
 * 文件改动的次数（状态里只剩一个路径集合）、会话级状态变化（stopped / failed / lost 没有时间线条目）、取消者与备注。
 */
interface LogFacts {
  /** 路径 → 变更类型 → 被上报的次数。 */
  files: Map<string, Map<string, number>>;
  notes: SessionNote[];
  cancels: Map<RunId, CancelNote>;
}

function readLog(events: readonly EnsembleEvent[]): LogFacts {
  const files = new Map<string, Map<string, number>>();
  const notes: SessionNote[] = [];
  const cancels = new Map<RunId, CancelNote>();
  for (const event of events) {
    switch (event.kind) {
      case "file.changed": {
        for (const file of event.data.files) {
          const kinds = files.get(file.path) ?? new Map<string, number>();
          kinds.set(file.change, (kinds.get(file.change) ?? 0) + 1);
          files.set(file.path, kinds);
        }
        break;
      }
      case "session.status": {
        const status = event.data.status;
        if (status === "stopped" || status === "failed" || status === "lost") {
          notes.push({
            at: event.at,
            status,
            ...(event.data.reason ? { reason: event.data.reason } : {}),
            ...(event.data.error ? { error: event.data.error } : {}),
          });
        }
        break;
      }
      case "run.cancelled": {
        if (event.runId && !cancels.has(event.runId)) {
          cancels.set(event.runId, {
            at: event.at,
            ...(event.data.by ? { by: event.data.by } : {}),
            ...(event.data.note ? { note: event.data.note } : {}),
          });
        }
        break;
      }
      default:
        // 其余事件（含将来新增的类型）不影响报告的这几项统计。
        break;
    }
  }
  return { files, notes, cancels };
}

/** 渲染完一个会话后 ReportBuilder 在 slot 里留下的统计（任务树的总览、目录与用量总表要用）；不引用会话历史，历史可以马上释放。 */
export interface ReportSessionStats {
  events: number;
  usage: UsageRow;
  partial: ReadonlySet<UsageKey>;
  /** 按事件里第一次出现的先后。 */
  files: string[];
}

// ───────────────────────── 时间线分组与关键步骤 ─────────────────────────

interface RunView {
  run: Run;
  items: TimelineItem[];
}

/** 把时间线条目按运行分组；不属于任何运行的（例如会话级诊断、没有关联运行的消息）放进 loose。 */
function groupByRun(state: SessionState): { runs: RunView[]; loose: TimelineItem[] } {
  const views = new Map<RunId, RunView>();
  const runs: RunView[] = [];
  for (const run of state.runs) {
    const view: RunView = { run, items: [] };
    views.set(run.id, view);
    runs.push(view);
  }
  // 消息条目自己的 runId 在补发时不一定及时更新，以消息本身记录的为准。
  const messageRun = new Map<string, RunId>();
  for (const message of state.messages) {
    if (message.runId) messageRun.set(message.id, message.runId);
  }
  const loose: TimelineItem[] = [];
  for (const item of state.timeline) {
    if (item.type === "run") continue;
    const runId = item.type === "message" ? (messageRun.get(item.messageId) ?? item.runId) : item.runId;
    const view = runId ? views.get(runId) : undefined;
    if (view) view.items.push(item);
    else loose.push(item);
  }
  return { runs, loose };
}

export interface AnswerPick {
  item: AssistantItem;
  /** 没有标成“过程说明（commentary）”的才算最终回答。 */
  final: boolean;
}

/** 一次运行的回答：选择规则在 timeline-selectors（与 MCP 的 finalAnswer 同一口径），这里再记下它算不算最终回答。 */
function answerOf(items: readonly TimelineItem[]): AnswerPick | undefined {
  const item = preferredAssistant(items);
  return item ? { item, final: item.phase !== "commentary" } : undefined;
}

export type Step =
  | { kind: "message"; at: string; message: Message }
  | { kind: "tool"; at: string; tool: ToolItem }
  | { kind: "diagnostic"; at: string; item: DiagnosticItem }
  | { kind: "assistant"; at: string; item: AssistantItem }
  | { kind: "question"; at: string; item: QuestionItem };

export interface Skipped {
  tools: Map<string, number>;
  assistant: number;
  diagnostics: number;
  reasoning: number;
  other: number;
}

/**
 * brief 里值得逐条列出的工具调用（写死的规则，不做“重要性”的判断）：
 * 没有正常完成的（失败 / 取消 / 从未上报结束 / 导出时仍在运行）、退出码非 0 的、命令类、改动文件的、MCP 调用。
 */
function isKeyTool(tool: ToolItem): boolean {
  if (tool.status !== "completed") return true;
  if (tool.exitCode !== undefined && tool.exitCode !== 0) return true;
  if (tool.category === "shell" || tool.category === "write" || tool.category === "edit" || tool.category === "mcp") return true;
  if (tool.mcp) return true;
  return (tool.files?.length ?? 0) > 0;
}

/** 一次运行里哪些条目逐条列出、哪些只计数；answer 是这次运行的回答条目（它另有位置，不在步骤里重复）。 */
function collectSteps(
  items: readonly TimelineItem[],
  detail: ReportDetail,
  answer: AssistantItem | undefined,
  messages: ReadonlyMap<string, Message>,
): { steps: Step[]; skipped: Skipped } {
  const steps: Step[] = [];
  const skipped: Skipped = { tools: new Map(), assistant: 0, diagnostics: 0, reasoning: 0, other: 0 };
  const full = detail === "full";
  for (const item of items) {
    switch (item.type) {
      case "message": {
        const message = messages.get(item.messageId);
        // 委派原文单独列在“委派”里；这里只有后来的纠偏与补充消息。
        if (message && message.kind !== "task") steps.push({ kind: "message", at: item.at, message });
        break;
      }
      case "tool": {
        if (full || isKeyTool(item)) {
          steps.push({ kind: "tool", at: item.at, tool: item });
        } else {
          skipped.tools.set(item.category, (skipped.tools.get(item.category) ?? 0) + 1);
        }
        break;
      }
      case "diagnostic": {
        if (full || item.level !== "info") steps.push({ kind: "diagnostic", at: item.at, item });
        else skipped.diagnostics += 1;
        break;
      }
      case "question": {
        // 执行端停下来问了一个问题、以及谁怎样回答了它：量少、都是决定性的事实，brief 里也逐条列出。
        steps.push({ kind: "question", at: item.at, item });
        break;
      }
      case "assistant": {
        // 回答另有位置（本次运行末尾或“最终结果”），这里不重复。
        if (item === answer || item.text.trim() === "") break;
        if (full) steps.push({ kind: "assistant", at: item.at, item });
        else skipped.assistant += 1;
        break;
      }
      case "reasoning": {
        // 推理内容从不收录，只如实说明有多少段。
        skipped.reasoning += 1;
        break;
      }
      case "plan":
      case "run":
        // 计划在运行末尾取最终状态；运行标记本身就是各运行的标题。
        break;
      default:
        // 将来新增的条目类型：不展开，只计数，绝不因此出错。
        skipped.other += 1;
        break;
    }
  }
  return { steps, skipped };
}

/** 不属于任何运行的东西：没有关联运行的消息、诊断与提问，以及会话级的状态变化（被停止 / 失败 / 失联）。 */
export type LooseEntry =
  | { kind: "step"; at: string; step: Step }
  | { kind: "note"; at: string; note: SessionNote };

/** 按时间先后（时刻相同的保持原有次序）排好，渲染时依次写出即可。 */
function looseEntries(
  loose: readonly TimelineItem[],
  notes: readonly SessionNote[],
  messages: ReadonlyMap<string, Message>,
  detail: ReportDetail,
): LooseEntry[] {
  const entries: LooseEntry[] = [];
  for (const item of loose) {
    if (item.type === "message") {
      const message = messages.get(item.messageId);
      if (message && message.kind !== "task") entries.push({ kind: "step", at: item.at, step: { kind: "message", at: item.at, message } });
    } else if (item.type === "diagnostic" && (detail === "full" || item.level !== "info")) {
      entries.push({ kind: "step", at: item.at, step: { kind: "diagnostic", at: item.at, item } });
    } else if (item.type === "question") {
      entries.push({ kind: "step", at: item.at, step: { kind: "question", at: item.at, item } });
    }
  }
  for (const note of notes) entries.push({ kind: "note", at: note.at, note });
  return entries.sort((a, b) => byText(a.at, b.at));
}

// ───────────────────────── 整理好的会话事实 ─────────────────────────

/** 一次运行的事实：它的回答、逐条列出的步骤与只计数的类别、运行末尾的计划。 */
export interface RunFacts {
  run: Run;
  answer: AnswerPick | undefined;
  steps: readonly Step[];
  skipped: Skipped;
  /** 这次运行的计划条目（每次运行只有一条，取最后的状态）；没有则 undefined。 */
  plan: PlanItem | undefined;
}

/** 日志以 session.created 开头时才有：概览之外的委派、过程、改动文件、结果与用量都从这里写。 */
export interface SessionHistory {
  state: SessionState;
  /** 路径 → 变更类型 → 被上报的次数。 */
  files: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /** files 的路径，按字符串码元排序。 */
  filePaths: readonly string[];
  cancels: ReadonlyMap<RunId, CancelNote>;
  /** 全部运行（含排队中还没开始的），按序号。 */
  runs: readonly RunFacts[];
  /** 最后一次已开始的运行：“最终结果”写它；一次都没开始就没有。它是 runs 里的同一个对象。 */
  resultRun: RunFacts | undefined;
  loose: readonly LooseEntry[];
  usage: UsageFacts;
}

export interface PreparedSession {
  summary: SessionSummary;
  stats: ReportSessionStats;
  /** 没有读到日志（events 为 undefined），或日志不是以 session.created 开头：只有概览可写。 */
  history: SessionHistory | undefined;
}

/**
 * 把一个会话的事件日志整理成报告要用的事实。ReportBuilder 对每个会话只调用一次，五档预算共用同一份结果。
 * detail 决定哪些条目逐条列出（brief 只列关键的、full 全列）。events 为 undefined 与空日志一样：没有事件、没有状态。
 */
export function prepareReportSession(summary: SessionSummary, events: readonly EnsembleEvent[] | undefined, detail: ReportDetail): PreparedSession {
  const log = events ?? [];
  const { files, notes, cancels } = readLog(log);
  const state = replay(log);
  const usage = usageOf(state);
  const stats: ReportSessionStats = { events: log.length, usage: usage.total, partial: usage.partial, files: [...files.keys()] };
  if (!state) return { summary, stats, history: undefined };

  const messages = new Map<string, Message>();
  for (const message of state.messages) messages.set(message.id, message);
  const grouped = groupByRun(state);
  const runs = grouped.runs.map((view): RunFacts => {
    const answer = answerOf(view.items);
    const { steps, skipped } = collectSteps(view.items, detail, answer?.item, messages);
    const plan = view.items.find((item): item is PlanItem => item.type === "plan");
    return { run: view.run, answer, steps, skipped, plan };
  });
  let resultRun: RunFacts | undefined;
  for (const facts of runs) {
    if (facts.run.status !== "queued") resultRun = facts;
  }
  return {
    summary,
    stats,
    history: {
      state,
      files,
      filePaths: [...files.keys()].sort(byText),
      cancels,
      runs,
      resultRun,
      loose: looseEntries(grouped.loose, notes, messages, detail),
      usage,
    },
  };
}
