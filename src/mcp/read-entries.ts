import type { EnsembleEvent } from "@shared/events";
import { clip, collapseWhitespace, formatDuration, tail } from "@shared/format";
import type { SessionState } from "@shared/projection";
import { sliceHead } from "@shared/safe-slice";
import type { FileChange, Message, Run, TimelineItem, ToolItem } from "@shared/types";
import { fileLine, itemLines } from "./format";

/**
 * `read` 各列表视角（transcript / files / errors / commands）的条目，以及整段读取时把条目排进预算的版式。
 * 条目是“一件有稳定 key 的事加排好版的文字”：整段读取把它们排进预算；增量读取（read-page.ts）靠“同一个 key 的文字变没变”判断新增与更新。
 * 纯函数、不碰网络，时间只通过 BuildContext.now 传入。这里不依赖 read.ts：read.ts 依赖这里，反过来会成环。
 */

/** 列表型视角。result 是一页摘要，不在其内。 */
export type ListView = "transcript" | "files" | "errors" | "commands";

/** 一条命令的结局归类：汇总行里的计数与这一条的排版出自同一次遍历，不会各数各的。 */
export type CommandTally = "ok" | "failed" | "cancelled" | "open";

/** 条目的稳定标识与排好版的文字：增量读取靠“同一个 key 的文字变没变”判断新增与更新。 */
export interface Entry {
  key: string;
  text: string;
  /** 列表之外单独成段的条目：head 排在最前，foot 排在最后。 */
  slot?: "head" | "foot";
  /** 事件发生的时间，只有 errors 视图用它排序与说明“最近一次是多久以前”。 */
  at?: string;
  /** 只有 commands 视图的条目带：这条命令算成功、失败、已取消还是没有结束（整段读取的汇总行按它计数）。 */
  tally?: CommandTally;
}

export interface BuildContext {
  harness: string;
  includeReasoning: boolean;
  /** 增量读取时，还在写的助手文本要标明（默认视图不加，保持原来的输出）。 */
  markOpen: boolean;
  runId?: string | undefined;
  now: number;
  /** 会话有不止一轮运行时，条目要标明属于哪一轮。 */
  multiRun: boolean;
}

/** `commands` 视图里单条命令的字数上限（`transcript` 里是 140）。 */
const COMMAND_CHARS = 500;

// ───────────────────────── 条目 ─────────────────────────

export function buildEntries(view: ListView, state: SessionState, events: readonly EnsembleEvent[], ctx: BuildContext): Entry[] {
  switch (view) {
    case "transcript":
      return transcriptEntries(state, ctx);
    case "files":
      return fileEntries(state, ctx);
    case "errors":
      return errorEntries(state, events, ctx);
    case "commands":
      return commandEntries(state, ctx);
  }
}

/** 条目所属的运行。补充消息在送达前没有 runId，以消息自己记录的为准（送达后才会补上）。 */
function itemRunId(state: SessionState, item: TimelineItem): string | undefined {
  if (item.type === "message") {
    const index = state.idx.messages.get(item.messageId);
    return (index === undefined ? undefined : state.messages[index]?.runId) ?? item.runId;
  }
  return item.runId;
}

function runNumber(state: SessionState, runId: string | undefined): number | undefined {
  if (!runId) return undefined;
  const index = state.idx.runs.get(runId);
  return index === undefined ? undefined : state.runs[index]?.index;
}

/** 工具调用是否算失败：执行端标了失败，或标了完成却带着非零退出码（已取消、未结束的不算）。 */
function isFailedTool(item: ToolItem): boolean {
  return item.status === "failed" || (item.status === "completed" && item.exitCode !== undefined && item.exitCode !== 0);
}

function toolDuration(item: ToolItem, now: number): string | undefined {
  if (item.durationMs !== undefined) return item.durationMs < 1000 ? "<1s" : formatDuration(item.durationMs);
  if (item.status === "running") return `${formatDuration(now - Date.parse(item.startedAt))} so far`;
  return undefined;
}

/** 失败调用的说明：执行端给的错误文字（与输出相同就只写一遍），再加输出末尾几行——测试失败的清单通常在末尾。 */
function failureDetail(item: ToolItem, indent: string): string[] {
  const lines: string[] = [];
  const error = item.error ? collapseWhitespace(item.error) : "";
  const output = item.output?.text.trim() ?? "";
  if (error && collapseWhitespace(output) !== error) lines.push(`${indent}${clip(error, 300)}`);
  if (output) {
    const rows = tail(output, 600)
      .split(/\r?\n/)
      .filter((row) => row.trim().length > 0);
    lines.push(...rows.slice(-6).map((row) => `${indent}${clip(row.trimEnd(), 240)}`));
  }
  return lines;
}

function transcriptEntries(state: SessionState, ctx: BuildContext): Entry[] {
  const entries: Entry[] = [];
  for (const item of state.timeline) {
    if (ctx.runId !== undefined && itemRunId(state, item) !== ctx.runId) continue;
    const text = itemLines(state, item, { includeReasoning: ctx.includeReasoning, harness: ctx.harness });
    if (!text) continue;
    const open = ctx.markOpen && (item.type === "assistant" || item.type === "reasoning") && item.streaming;
    entries.push({ key: item.id, text: open ? `${text}  [still being written]` : text });
  }
  return entries;
}

interface FileTotals {
  path: string;
  first: FileChange["change"];
  last: FileChange["change"];
  added: number | undefined;
  removed: number | undefined;
  edits: number;
  runs: number[];
}

/**
 * 每个路径一条：多次编辑合并，行数把每次编辑报告的数字加起来（不是净差异），并写明合并了几次、涉及哪几轮。
 * 先创建、后又修改的文件对这个会话而言仍是新建的。结果视图里的清单只留每个路径的最后一条，两者的行数口径不同。
 */
function fileEntries(state: SessionState, ctx: BuildContext): Entry[] {
  const byPath = new Map<string, FileTotals>();
  for (const item of state.timeline) {
    if (item.type !== "tool" || !item.files?.length) continue;
    if (ctx.runId !== undefined && item.runId !== ctx.runId) continue;
    const run = runNumber(state, item.runId);
    for (const file of item.files) {
      const totals: FileTotals = byPath.get(file.path) ?? { path: file.path, first: file.change, last: file.change, added: undefined, removed: undefined, edits: 0, runs: [] };
      totals.last = file.change;
      totals.edits += 1;
      if (file.addedLines !== undefined) totals.added = (totals.added ?? 0) + file.addedLines;
      if (file.removedLines !== undefined) totals.removed = (totals.removed ?? 0) + file.removedLines;
      if (run !== undefined && !totals.runs.includes(run)) totals.runs.push(run);
      byPath.set(file.path, totals);
    }
  }
  return [...byPath.values()].map((totals) => {
    const change = totals.first === "created" && totals.last === "modified" ? "created" : totals.last;
    const notes = [
      totals.edits > 1 ? `${totals.edits} edits` : "",
      ctx.runId === undefined && ctx.multiRun && totals.runs.length > 0 ? `run${totals.runs.length === 1 ? "" : "s"} ${totals.runs.join(", ")}` : "",
    ].filter((note) => note.length > 0);
    const line = fileLine({
      path: totals.path,
      change,
      ...(totals.added !== undefined ? { addedLines: totals.added } : {}),
      ...(totals.removed !== undefined ? { removedLines: totals.removed } : {}),
    });
    return { key: `file:${totals.path}`, text: notes.length > 0 ? `${line} (${notes.join(", ")})` : line };
  });
}

/** 命令原文：文本输入直接取；JSON 输入（Claude Code）取 `command` 字段，取不到就退回标题。比转录里的 140 字完整，但仍有上限并写明被截掉多少。 */
function commandOf(item: ToolItem): string {
  const input = item.input;
  let raw = "";
  if (input && input.text.trim()) {
    if (input.format === "json") {
      try {
        const parsed: unknown = JSON.parse(input.text);
        const command = typeof parsed === "object" && parsed !== null ? (parsed as { command?: unknown }).command : undefined;
        if (typeof command === "string") raw = command;
      } catch {
        // 超长的输入被适配器截断后不再是合法 JSON：退回标题。
      }
    } else {
      raw = input.text;
    }
  }
  const text = collapseWhitespace(raw.trim() ? raw : item.title);
  if (text.length <= COMMAND_CHARS) return text;
  // 截点落在代理对（emoji）中间时少留一个码元；下面的“+N chars”由 shown 的实际长度算出，所以那半个字符也算在被截掉的里面。
  const shown = sliceHead(text, COMMAND_CHARS).trimEnd();
  // 适配器自己已经截过的输入，以它记下的原始字数为准，免得把“已经丢掉的部分”也算成只丢了这一点。
  const total = input?.truncated && input.chars !== undefined && input.format !== "json" ? Math.max(input.chars, text.length) : text.length;
  return `${shown}… (+${total - shown.length} chars)`;
}

function commandOutcome(item: ToolItem): string {
  if (isFailedTool(item)) return item.exitCode !== undefined && item.exitCode !== 0 ? `failed (exit ${item.exitCode})` : "failed";
  switch (item.status) {
    case "completed":
      return "ok";
    case "cancelled":
      return "cancelled";
    case "running":
      return "running";
    case "unfinished":
      return "not finished";
    case "failed":
      return "failed";
  }
}

/** 命令的结局归类，与 `commandOutcome` 的文字同一套判断（失败优先，其余按状态；还在跑与没有结束事件的都算“未结束”）。 */
function commandTally(item: ToolItem): CommandTally {
  if (isFailedTool(item)) return "failed";
  if (item.status === "completed") return "ok";
  if (item.status === "cancelled") return "cancelled";
  return "open";
}

/**
 * 序号是这条命令在整个会话里的顺位（不随 runIndex / afterSeq 重新编号），主 Agent 可以稳定地引用。
 * 每条命令随带它的结局归类（tally）：整段读取的汇总行从这里数，不必再把时间线遍历一遍。
 */
function commandEntries(state: SessionState, ctx: BuildContext): Entry[] {
  const entries: Entry[] = [];
  let number = 0;
  for (const item of state.timeline) {
    if (item.type !== "tool" || item.category !== "shell") continue;
    number += 1;
    if (ctx.runId !== undefined && item.runId !== ctx.runId) continue;
    const run = runNumber(state, item.runId);
    const duration = toolDuration(item, ctx.now);
    const parts = [...(ctx.multiRun && ctx.runId === undefined && run !== undefined ? [`run ${run}`] : []), commandOutcome(item), ...(duration ? [duration] : []), commandOf(item)];
    const lines = [`  ${number}. ${parts.join(" · ")}`, ...(isFailedTool(item) ? failureDetail(item, "       ") : [])];
    entries.push({ key: item.id, text: lines.join("\n"), tally: commandTally(item) });
  }
  return entries;
}

interface Mark {
  seq: number;
  at: string;
}

/** 每件“出错的事”落在哪个事件上（工具取最后一次更新）；键与条目的 key 一致，取不到就只写时间不写事件号。 */
function markEvents(events: readonly EnsembleEvent[]): Map<string, Mark> {
  const marks = new Map<string, Mark>();
  for (const event of events) {
    const mark = { seq: event.seq, at: event.at };
    switch (event.kind) {
      case "tool.updated":
        marks.set(`tool:${event.data.callId}`, mark);
        break;
      case "diagnostic":
        marks.set(`diagnostic:${event.id}`, mark);
        break;
      case "run.failed":
        if (event.runId) marks.set(`run:${event.runId}:failed`, mark);
        break;
      case "message.delivery":
        if (event.data.record.stage === "failed" && !marks.has(`message:${event.data.messageId}:failed`)) marks.set(`message:${event.data.messageId}:failed`, mark);
        break;
      default:
        break;
    }
  }
  return marks;
}

function clock(at: string): string {
  const time = /T(\d{2}:\d{2}:\d{2})/.exec(at)?.[1];
  return time ? `${time}Z` : at;
}

function messageLabel(message: Message): string {
  return message.kind === "task" ? "task message" : message.kind === "steer" ? "correction" : "follow-up";
}

/**
 * 只收真实的失败：工具调用失败、警告与错误级别的提示、失败的运行、没送达的消息，以及会话级的错误。
 * “未结束”的工具不算失败（执行端没上报结束事件，既不能说成功也不能说失败），只在末尾单独陈述一行。按时间升序排好，展示时再决定先后。
 */
function errorEntries(state: SessionState, events: readonly EnsembleEvent[], ctx: BuildContext): Entry[] {
  const marks = markEvents(events);
  const rows: { key: string; at: string; text: string }[] = [];
  const push = (key: string, fallbackAt: string, runId: string | undefined, what: string, detail: string[] = []): void => {
    const mark = marks.get(key);
    const at = mark?.at ?? fallbackAt;
    const run = runNumber(state, runId);
    const where = [run !== undefined ? `run ${run}` : "no run", ...(mark ? [`#${mark.seq}`] : []), clock(at)].join(" · ");
    rows.push({ key, at, text: [`  - ${where} — ${what}`, ...detail].join("\n") });
  };

  const unfinished: ToolItem[] = [];
  for (const item of state.timeline) {
    if (ctx.runId !== undefined && itemRunId(state, item) !== ctx.runId) continue;
    if (item.type === "tool") {
      if (isFailedTool(item)) {
        const facts = [item.exitCode !== undefined && item.exitCode !== 0 ? `exit ${item.exitCode}` : "", toolDuration(item, ctx.now) ?? ""].filter((fact) => fact.length > 0);
        push(item.id, item.endedAt ?? item.updatedAt, item.runId, `tool failed: ${item.category} \`${clip(collapseWhitespace(item.title), 140)}\`${facts.length > 0 ? ` (${facts.join(", ")})` : ""}`, failureDetail(item, "      "));
      } else if (item.status === "unfinished") {
        unfinished.push(item);
      }
    } else if (item.type === "diagnostic" && item.level !== "info") {
      push(item.id, item.at, item.runId, `note [${item.level}] ${item.code}: ${clip(collapseWhitespace(item.message), 300)}`);
    }
  }
  for (const run of state.runs) {
    if (run.status !== "failed" || (ctx.runId !== undefined && run.id !== ctx.runId)) continue;
    const reason = run.error ? `[${run.error.code}] ${clip(collapseWhitespace(run.error.message), 300)}` : "no error details were recorded";
    push(`run:${run.id}:failed`, run.endedAt ?? run.queuedAt, run.id, `run failed: ${reason}${run.stopReason ? ` (stop reason: ${run.stopReason})` : ""}`);
  }
  for (const message of state.messages) {
    if (message.delivery.stage !== "failed" || (ctx.runId !== undefined && message.runId !== ctx.runId)) continue;
    const failure = message.delivery.error;
    push(
      `message:${message.id}:failed`,
      message.delivery.at,
      message.runId,
      `${messageLabel(message)} ${message.id} was not delivered${failure ? `: [${failure.code}] ${clip(collapseWhitespace(failure.message), 200)}` : ""}`,
    );
  }
  // 排序是稳定的：同一毫秒的几件事保持上面收集的先后。
  rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const entries: Entry[] = rows.map((row) => ({ key: row.key, text: row.text, at: row.at }));
  const lastError = state.lastError;
  if (ctx.runId === undefined && lastError) {
    // 失败的运行已经带着同一段错误时，会话级错误不再重复。
    const repeated = state.runs.some((run) => run.status === "failed" && run.error !== undefined && run.error.code === lastError.code && run.error.message === lastError.message);
    if (!repeated) entries.unshift({ key: "session-error", slot: "head", text: `Session error: [${lastError.code}] ${clip(collapseWhitespace(lastError.message), 300)}` });
  }
  const first = unfinished[0];
  if (first) {
    const example = `${first.category} \`${clip(collapseWhitespace(first.title), 80)}\``;
    entries.push({
      key: "unfinished",
      slot: "foot",
      text: `Not counted above: ${unfinished.length} tool call${unfinished.length === 1 ? "" : "s"} never reported an end event (status "unfinished", for example ${example}) — that alone is not an error.`,
    });
  }
  return entries;
}

// ───────────────────────── 整段读取的排版 ─────────────────────────

export interface BodyInput {
  ctx: BuildContext;
  run: Run | undefined;
  budget: number;
}

export function wholeBody(view: ListView, entries: Entry[], input: BodyInput): string[] {
  switch (view) {
    case "transcript":
      return transcriptBody(entries, input);
    case "files":
      return filesBody(entries, input);
    case "errors":
      return errorsBody(entries, input);
    case "commands":
      return commandsBody(entries, input);
  }
}

/** 预算内保留最新的、丢弃最早的（与默认转录一致）；至少留一条。 */
function takeNewest(entries: readonly Entry[], budget: number): { shown: Entry[]; hidden: number } {
  const shown: Entry[] = [];
  let left = budget;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry) continue;
    if (left - entry.text.length < 0 && shown.length > 0) break;
    left -= entry.text.length + 1;
    shown.unshift(entry);
  }
  return { shown, hidden: entries.length - shown.length };
}

/** 预算内从头保留、丢弃后面的；至少留一条。 */
function takeFromStart(entries: readonly Entry[], budget: number): { shown: Entry[]; hidden: number } {
  const shown: Entry[] = [];
  let left = budget;
  for (const entry of entries) {
    if (left - entry.text.length < 0 && shown.length > 0) break;
    left -= entry.text.length + 1;
    shown.push(entry);
  }
  return { shown, hidden: entries.length - shown.length };
}

function transcriptBody(entries: Entry[], { run, budget }: BodyInput): string[] {
  if (entries.length === 0) return [run ? "Nothing is recorded for this run yet." : "Nothing is recorded yet."];
  const { shown, hidden } = takeNewest(entries, budget);
  return [...(hidden > 0 ? [`(${hidden} earlier entr${hidden === 1 ? "y" : "ies"} omitted to fit; ask for a larger maxChars to see more)`] : []), ...shown.map((entry) => entry.text)];
}

function filesBody(entries: Entry[], { run, budget }: BodyInput): string[] {
  const note = "edits made inside shell commands are not tracked";
  if (entries.length === 0) return [`No file changes were reported for ${run ? `run ${run.index}` : "this session"} (${note}).`];
  const { shown, hidden } = takeFromStart(entries, budget);
  return [
    `Files changed (${entries.length}) — as reported by the harness (${note}); line counts add up each edit:`,
    ...shown.map((entry) => entry.text),
    ...(hidden > 0 ? [`  … and ${hidden} more (ask for a larger maxChars to see them)`] : []),
  ];
}

export function splitSlots(entries: readonly Entry[]): { head: Entry[]; body: Entry[]; foot: Entry[] } {
  return {
    head: entries.filter((entry) => entry.slot === "head"),
    body: entries.filter((entry) => entry.slot === undefined),
    foot: entries.filter((entry) => entry.slot === "foot"),
  };
}

/** 最新的错误排在最前面，一眼就能看到“刚才哪步出的错”；预算不够时丢弃最旧的。 */
function errorsBody(entries: Entry[], { run, ctx, budget }: BodyInput): string[] {
  const { head, body, foot } = splitSlots(entries);
  const lines = head.map((entry) => entry.text);
  if (body.length === 0) {
    if (head.length === 0) {
      lines.push(`No errors recorded${run ? ` for run ${run.index}` : ""}: no failed tool calls, no warning or error notes, no failed runs, no undelivered messages.`);
    }
  } else {
    const newestFirst = [...body].reverse();
    const { shown, hidden } = takeFromStart(newestFirst, budget);
    const newest = newestFirst[0]?.at;
    const age = newest !== undefined && Number.isFinite(Date.parse(newest)) ? ` — the most recent was ${formatDuration(ctx.now - Date.parse(newest))} ago` : "";
    lines.push(`Errors (${body.length}), newest first${age}:`, ...shown.map((entry) => entry.text));
    if (hidden > 0) lines.push(`(${hidden} older error${hidden === 1 ? "" : "s"} not shown to fit; ask for a larger maxChars to see them)`);
  }
  lines.push(...foot.map((entry) => entry.text));
  return lines;
}

/** 汇总行的数字就是条目自带的归类：条目与计数同出一次遍历，且条目恰好是这一轮（或整个会话）的全部命令。 */
function commandsBody(entries: Entry[], { run, budget }: BodyInput): string[] {
  if (entries.length === 0) return [`No shell command calls were recorded for ${run ? `run ${run.index}` : "this session"}.`];
  const counts: Record<CommandTally, number> = { ok: 0, failed: 0, cancelled: 0, open: 0 };
  for (const entry of entries) {
    if (entry.tally) counts[entry.tally] += 1;
  }
  const parts = [`${counts.ok} ok`, `${counts.failed} failed`, ...(counts.cancelled > 0 ? [`${counts.cancelled} cancelled`] : []), ...(counts.open > 0 ? [`${counts.open} not finished`] : [])];
  const { shown, hidden } = takeNewest(entries, budget);
  return [
    `Shell commands${run ? ` in run ${run.index}` : ""}: ${entries.length} in total — ${parts.join(", ")}.`,
    ...(hidden > 0 ? [`(${hidden} earlier command${hidden === 1 ? "" : "s"} not shown to fit; ask for a larger maxChars to see them)`] : []),
    ...shown.map((entry) => entry.text),
  ];
}
