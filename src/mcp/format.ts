import { clip, collapseWhitespace, formatCount, formatDuration, formatUsd, shortenPath, tail, versionLabel } from "@shared/format";
import { catalogDefaultModel, effortsLimited, resolveModelChoices, type ModelChoices } from "@shared/models";
import type { SendResponse } from "@shared/protocol";
import { openQuestionItems, relevantRun, type SessionState } from "@shared/projection";
import { sliceHead } from "@shared/safe-slice";
import { preferredAssistant } from "@shared/timeline-selectors";
import type {
  Activity,
  AttentionItem,
  DeliveryStage,
  FileChange,
  HarnessInfo,
  Message,
  ModelInfo,
  ModelRef,
  Notice,
  Origin,
  Run,
  SessionPhase,
  SessionSummary,
  TimelineItem,
  ToolItem,
  Usage,
} from "@shared/types";
import { questionItemLine, questionLines, questionSummary } from "./format-questions";
import { directoryKey } from "./workspace";

/**
 * MCP 工具返回给主模型的文本。保持短、事实性强，并在需要主 Agent 采取行动的地方写明下一步。
 * 全部是纯函数（时间通过参数传入），便于测试。
 */

const PHASE_TEXT: Record<SessionPhase, string> = {
  ready: "ready (no run yet)",
  starting: "starting",
  queued: "queued (waiting for a free slot)",
  running: "running",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
  stopped: "stopped",
  lost: "lost (the service restarted and the native session could not be reattached)",
};

function describeActivity(activity: Activity, now: number): string {
  const age = Number.isFinite(Date.parse(activity.since)) ? ` (${formatDuration(now - Date.parse(activity.since))})` : "";
  switch (activity.kind) {
    case "tool":
      return `${activity.tool ? `${activity.tool.category} \`${clip(collapseWhitespace(activity.tool.title), 80)}\`` : "using a tool"}${age}`;
    case "thinking":
      return `thinking${age}`;
    case "writing":
      return `writing a reply${age}`;
    case "working":
      return `working${age}`;
    case "idle":
      return "idle, can take a follow-up";
    case "ready":
      return "ready";
    case "starting":
      return `connecting to the harness${age}`;
    case "queued":
      return `queued${age}`;
    case "done":
      return "finished";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "stopped":
      return "stopped";
    case "lost":
      return "lost";
  }
}

export function modelText(model: ModelRef | undefined, effort: string | undefined): string {
  const resolved = model?.resolved ?? model?.requested;
  let text = resolved ?? "harness default";
  if (model?.resolved && model.requested && model.requested !== model.resolved) text += ` (requested ${model.requested})`;
  if (effort) text += `, effort ${effort}`;
  return text;
}

function usageText(usage: Usage | undefined): string | undefined {
  if (!usage) return undefined;
  const parts: string[] = [];
  if (usage.totalTokens !== undefined) parts.push(`${formatCount(usage.totalTokens)} tokens`);
  else if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
    parts.push(`${formatCount((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0))} tokens`);
  }
  if (usage.costUsd !== undefined) parts.push(formatUsd(usage.costUsd));
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function progressText(summary: SessionSummary): string | undefined {
  const { progress, counters } = summary;
  const parts: string[] = [];
  if (progress.total !== undefined) parts.push(`${progress.done}/${progress.total} plan items done`);
  if (counters.tools > 0) {
    parts.push(`${counters.tools} tool step${counters.tools === 1 ? "" : "s"}${counters.failedTools > 0 ? ` (${counters.failedTools} failed)` : ""}`);
  }
  if (counters.files > 0) parts.push(`${counters.files} file${counters.files === 1 ? "" : "s"} changed`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function elapsedText(summary: SessionSummary, now: number): string | undefined {
  const run = summary.lastRun;
  if (!run) return undefined;
  if (run.durationMs !== undefined) return formatDuration(run.durationMs);
  if (run.startedAt) return formatDuration(now - Date.parse(run.startedAt));
  return undefined;
}

export interface RenderOptions {
  now?: number;
  panelUrl?: string;
}

/** 一行摘要里不含进度的部分：编号、执行端、标题与状态（批量读取要把进度拆成自己的几行）。 */
export function sessionHead(summary: SessionSummary, options: RenderOptions = {}): string {
  const now = options.now ?? Date.now();
  const active = summary.phase === "running";
  const state = active ? `${PHASE_TEXT[summary.phase]} — ${describeActivity(summary.activity, now)}` : PHASE_TEXT[summary.phase];
  // 已归档的会话只是移出了默认视图，状态与记录都在、照常能读：状态后面标一笔，免得被当成仍在进行的工作或看漏。
  return `• ${summary.id} [${harnessLabel(summary)}] "${summary.title}" — ${state}${summary.archivedAt ? " (archived)" : ""}`;
}

/** 一行摘要。 */
export function renderSessionLine(summary: SessionSummary, options: RenderOptions = {}): string {
  const progress = progressText(summary);
  return `${sessionHead(summary, options)}${progress ? ` · ${progress}` : ""}`;
}

/** 首字母大写拼不出品牌写法的执行端：DSH 是缩写，要全大写（隔离服务里走 MCP 实测时读到过“Dsh”）。 */
const HARNESS_BRAND_NAMES: Partial<Record<string, string>> = { dsh: "DSH" };

export function harnessLabel(summary: Pick<SessionSummary, "harness" | "runtime">): string {
  const name = HARNESS_BRAND_NAMES[summary.harness] ?? summary.harness.charAt(0).toUpperCase() + summary.harness.slice(1);
  return summary.runtime === "fixture" ? `${name} (simulated)` : name;
}

/** 多行详情：状态、模型、访问级别、进度、最近输出与错误。 */
export function renderSessionDetail(summary: SessionSummary, options: RenderOptions = {}): string {
  const now = options.now ?? Date.now();
  const lines = [renderSessionLine(summary, options)];
  const add = (label: string, value: string | undefined): void => {
    if (value) lines.push(`    ${label}: ${value}`);
  };

  add("model", modelText(summary.model, summary.effort));
  const enforcement = summary.accessEnforcement;
  add(
    "access",
    `${summary.access}${enforcement ? ` (${enforcement.level === "enforced" ? "enforced" : enforcement.level === "advisory" ? "prompt-only, not enforced" : "NOT enforced"}: ${enforcement.mechanism})` : ""}`,
  );
  add("workspace", shortenPath(summary.cwd, 90));
  // 汇聚：跟随不止一个会话时才写（只有 id；单上级的输出与以前一字不差）。
  if (summary.parentSessionIds && summary.parentSessionIds.length > 1) add("follows", summary.parentSessionIds.join(", "));
  if (summary.archivedAt) {
    const by = summary.archivedBy === "retention" ? " by the retention policy" : summary.archivedBy === "user" ? " by the user" : "";
    add("archived", `${summary.archivedAt}${by} — moved out of the default view; the history is kept and still readable`);
  }
  const elapsed = elapsedText(summary, now);
  const usage = usageText(summary.usage);
  const runIndex = summary.lastRun?.index ?? (summary.runCount > 0 ? summary.runCount : undefined);
  if (runIndex !== undefined) {
    add("run", `#${runIndex}${elapsed ? `, ${elapsed}` : ""}${usage ? `, ${usage}` : ""}${summary.runCount > 1 ? ` (${summary.runCount} runs so far)` : ""}`);
  }
  if (summary.messages.pending > 0) add("messages", `${summary.messages.pending} not yet applied by the harness`);
  if (summary.lastAssistantPreview) add("latest output", `"${clip(collapseWhitespace(summary.lastAssistantPreview), 280)}"`);
  if (summary.lastError) add("error", `[${summary.lastError.code}] ${clip(collapseWhitespace(summary.lastError.message), 300)}`);
  if (summary.nativeRef) add("native session", `${summary.nativeRef.kind} ${summary.nativeRef.id}`);
  if (options.panelUrl) add("panel", options.panelUrl);
  return lines.join("\n");
}

/**
 * 一条“值得留意”的事实，写给主模型：只陈述有事件依据的内容，并明说这不是诊断。
 * 时长从事实成立的起点算到现在，所以每次调用看到的是最新的数字。
 */
export function describeAttention(item: AttentionItem, summary: Pick<SessionSummary, "harness" | "runtime">, now: number): string {
  const since = formatDuration(now - Date.parse(item.since));
  const harness = harnessLabel(summary);
  switch (item.kind) {
    case "quiet":
      return `no events from ${harness} for ${since} (last event #${item.seq}) and no tool call is in progress — read the transcript to see what it was last doing before deciding anything`;
    case "long_tool": {
      const started = formatDuration(now - Date.parse(item.tool.startedAt));
      return `no events for ${since} since ${item.tool.category} \`${clip(collapseWhitespace(item.tool.title), 80)}\` started ${started} ago — a long build or test is normal; read the transcript if that is not what you expect`;
    }
    case "long_run":
      return `this run has been going for ${since}`;
    case "shared_file":
      return `${shortenPath(item.path, 90)} was also written by ${item.withSessionIds.join(", ")} (latest write ${since} ago) — concurrent edits to one file can overwrite each other`;
    case "undelivered":
      return `${item.messageKind === "task" ? "the task" : `the ${item.messageKind === "steer" ? "correction" : "follow-up"}`} message ${item.messageId} is still "${STAGE_TEXT[item.stage]}" after ${since} — the harness has not confirmed it was applied`;
    case "question":
      // 提问在列表里是一整块（问题、可选项、怎么回复，见 renderAttention），这一行只是它的摘要。
      return questionSummary(item, harness);
  }
}

/** 值得留意的事项，每条一行；提问不是“留意”而是在等一个答案，写成带问题、可选项与回复方式的一整块。 */
export function renderAttention(summary: SessionSummary, now: number): string[] {
  return (summary.attention ?? []).flatMap((item) =>
    item.kind === "question"
      ? questionLines(item, { id: summary.id, harness: harnessLabel(summary) }, now)
      : [`    attention: ${describeAttention(item, summary, now)}`],
  );
}

export function renderSessions(summaries: readonly SessionSummary[], options: RenderOptions & { detail?: boolean } = {}): string {
  if (summaries.length === 0) return "No sessions.";
  const render = options.detail ? renderSessionDetail : renderSessionLine;
  const now = options.now ?? Date.now();
  return summaries.map((summary) => [render(summary, options), ...renderAttention(summary, now)].join("\n")).join("\n");
}

export function renderNotices(notices: readonly Notice[]): string {
  if (notices.length === 0) return "";
  const lines = notices.map((notice) => `- [${notice.sessionId}] ${notice.summary}${notice.text ? `\n    user wrote: "${clip(collapseWhitespace(notice.text), 400)}"` : ""}`);
  return `While you were away, the user acted directly on delegated sessions:\n${lines.join("\n")}`;
}

/** 会话是否正占着执行端干活（排队、启动、运行中）；待命（ready）与已结束的不算。 */
function inFlight(summary: Pick<SessionSummary, "phase">): boolean {
  return summary.phase === "starting" || summary.phase === "queued" || summary.phase === "running";
}

/**
 * 来源只有桥进程级别的身份（宿主没给会话标识、Agent 也没自报 `conversationId`）时，同一个桥上的所有对话
 * （Cursor IDE 里就是全部对话）都被并成这一个来源。它名下同时在跑的会话如果分散在不同的目录里，
 * 多半不是同一个对话派的。这里只陈述这个事实并指出出路，不替主 Agent 下判断；没有这种迹象时返回 undefined。
 */
export function renderSharedOriginHint(origin: Pick<Origin, "sessionRef">, mine: readonly Pick<SessionSummary, "phase" | "cwd">[]): string | undefined {
  if (origin.sessionRef) return undefined;
  const directories = new Set(mine.filter(inFlight).map((summary) => directoryKey(summary.cwd)));
  if (directories.size < 2) return undefined;
  return (
    `Note: this origin has no conversation identity of its own, and its running sessions work in ${directories.size} different directories — it may be shared by several conversations. ` +
    "Pass `sessionIds` explicitly, or pass your conversation id as `conversationId` on every Ensemble call."
  );
}

const STAGE_TEXT: Record<DeliveryStage, string> = {
  recorded: "recorded by Ensemble",
  queued: "queued",
  handed_off: "handed to the harness",
  applied: "applied",
  failed: "failed",
  cancelled: "cancelled",
};

/** 用诚实的措辞说明一条补充消息的投递状态。 */
export function sendOutcomeText(response: SendResponse, harnessName: string): string {
  const { kind, stage } = response;
  const what = kind === "steer" ? "correction" : kind === "follow_up" ? "follow-up" : "message";
  switch (stage) {
    case "applied":
      return `The ${what} reached ${harnessName} and is confirmed applied.`;
    case "handed_off":
      return kind === "steer"
        ? `The ${what} was handed to ${harnessName} mid-run. ${harnessName} has accepted it but has not yet confirmed it took effect — the panel will show "applied" once it does.`
        : `The ${what} was handed to ${harnessName}.`;
    case "queued":
      return kind === "follow_up"
        ? `The ${what} is queued and will start a new run as soon as the current one finishes.`
        : `The ${what} is queued; ${harnessName} will take it at the next safe boundary.`;
    case "recorded":
      return `The ${what} is recorded but not delivered yet.`;
    case "failed":
      return `The ${what} could not be delivered.`;
    case "cancelled":
      return `The ${what} was cancelled before delivery.`;
  }
}

/**
 * 不指定 model 时用哪个，只在“用户指定过默认”时单独说一行（执行端自己的默认已经由 models 行里的 `*` 说明）：
 * 用的是用户的选择就讲明来由；用户的选择现在用不了就讲明已经退回了什么。
 * 不点名用户指定的那个模型：没被开放的模型对主 Agent 不存在，连名字都不出现（与 models 行一致），而主 Agent 也不需要它。
 */
function describeDefault(info: HarnessInfo, choices: ModelChoices): string | undefined {
  if (choices.kind !== "unrestricted" && choices.kind !== "restricted") return undefined;
  const { defaultModel: standard, defaultSource, staleDefault } = choices;
  if (defaultSource === "user" && standard !== undefined) {
    // 执行端自己的默认只在它也被开放时才提：关掉的模型不出现。
    const own = catalogDefaultModel(info);
    const alongside = own !== undefined && own !== standard && choices.models.some((model) => model.id === own) ? ` (the harness's own default is ${own})` : "";
    return `    default model: ${standard} — chosen by the user in Ensemble's settings; used when you omit \`model\`${alongside}`;
  }
  if (!staleDefault) return undefined;
  const why = staleDefault.why === "missing" ? "this harness no longer offers that model" : "that model is not among the ones the user allows";
  const usable = `The default the user chose in Ensemble's settings is not usable right now (${why})`;
  if (standard === undefined) return `    default model: none fixed — omitting \`model\` lets the harness pick its own. ${usable}`;
  return `    default model: ${standard} — used when you omit \`model\`. ${usable}, so ${defaultSource === "first_open" ? "the first model the user allows" : "the harness's own default"} applies instead`;
}

export function renderHarness(info: HarnessInfo, choices: ModelChoices = resolveModelChoices(info)): string {
  const head = `• ${info.id} — ${info.displayName}${info.runtime === "fixture" ? " (simulated)" : ""}: ${info.status}${info.version ? ` · ${versionLabel(info.version)}` : ""}${info.account ? ` · ${info.account}` : ""}`;
  const lines = [head];
  if (info.setup) lines.push(`    setup: ${info.setup.message}${info.setup.command ? ` — run: ${info.setup.command}` : ""}`);
  if (choices.kind === "blocked") {
    const repair = choices.issue === "unreadable_file"
      ? "the user needs to restore settings.json and restart Ensemble"
      : "the user needs to save a new selection in Ensemble's executor settings";
    lines.push(`    models: settings unavailable — ${repair} before delegating`);
  }
  if (info.status === "ready") {
    const { models, defaultModel: standard } = choices;
    const restricted = choices.kind === "restricted";
    if (choices.kind === "empty") {
      lines.push("    models: none allowed — no open model can be selected right now; do not delegate to this harness and tell the user to check Ensemble's executor settings");
    } else if (models.length > 0) {
      const shown = models.slice(0, 8).map((model) => `${model.id}${model.id === standard ? "*" : ""}`);
      const notes = [standard ? "* = default" : "", restricted ? "only these are allowed by the user" : ""].filter(Boolean);
      lines.push(`    models: ${shown.join(", ")}${models.length > 8 ? `, … (+${models.length - 8})` : ""}${notes.length > 0 ? `  (${notes.join("; ")})` : ""}`);
      const defaultNote = describeDefault(info, choices);
      if (defaultNote) lines.push(defaultNote);
      const leveled = (list: readonly ModelInfo[]): ModelInfo[] => list.filter((model) => (model.efforts?.length ?? 0) > 0);
      const efforts = leveled(models.slice(0, 8)).map((model) => {
        const tags = [model.defaultEffort ? `default ${model.defaultEffort}` : "", effortsLimited(info, model.id) ? "only these are allowed by the user" : ""].filter(Boolean);
        return `${model.id}: ${(model.efforts ?? []).join(", ")}${tags.length > 0 ? ` (${tags.join("; ")})` : ""}`;
      });
      if (efforts.length > 0) lines.push(`    efforts: ${efforts.join(" | ")}${leveled(models.slice(8)).length > 0 ? " | …" : ""}`);
    }
    const steer = info.capabilities.steer;
    const cap = (name: string, entry: { support: string; verification?: string | undefined }): string =>
      entry.support === "yes" ? `${name}${entry.verification === "live" ? "" : " (declared)"}` : entry.support === "partial" ? `${name} (partial)` : `no ${name}`;
    lines.push(
      `    can: ${[
        cap("steer mid-run", steer),
        cap("follow-up", info.capabilities.followUp),
        cap("cancel", info.capabilities.cancel),
        cap("resume after restart", info.capabilities.resume),
        // 执行端的业务提问能否转给你、再把回答送回去：没有这一项的执行端不转交（它遇到的提问仍按原来的办法处理）。
        info.capabilities.question ? cap("question relay", info.capabilities.question) : "no question relay",
      ].join(", ")}`,
    );
    const levels = (["read_only", "full"] as const).map((level) => {
      const entry = info.access[level];
      if (!entry) return `${level}: unavailable`;
      return `${level}: ${entry.level === "enforced" ? "enforced" : entry.level === "advisory" ? "prompt-only" : "not enforced"}`;
    });
    lines.push(`    access: ${levels.join(" · ")}`);
  }
  return lines.join("\n");
}

// ───────────────────────── 结果与转录 ─────────────────────────

/**
 * 当前（或最近一次）运行里执行端给出的最终回答；传入 `run` 时取那一轮运行的。
 * 挑哪一条由共享的 `preferredAssistant` 决定（最后一条非空的 final，没有 final 才退回最后一条非空的助手文字；报告用的是同一个选择器）——
 * 这里仍只限在“相关的那一轮”里挑，再把文字去掉首尾空白、把 phase 折成“是否标成最终”。
 */
export function finalAnswer(state: SessionState, run?: Run): { text: string; final: boolean; streaming: boolean } | undefined {
  const pick = preferredAssistant(state.timeline, (run ?? relevantRun(state))?.id);
  return pick ? { text: pick.text.trim(), final: pick.phase === "final" || pick.phase === undefined, streaming: pick.streaming } : undefined;
}

/** 各次工具调用里报告的文件改动，同一个路径只留最后一条；传入 `runId` 时只看那一轮运行写的。 */
export function collectFiles(state: SessionState, runId?: string): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const item of state.timeline) {
    if (item.type !== "tool" || (runId !== undefined && item.runId !== runId)) continue;
    for (const file of item.files ?? []) byPath.set(file.path, file);
  }
  return [...byPath.values()];
}

export function fileLine(file: FileChange): string {
  const delta = file.addedLines !== undefined || file.removedLines !== undefined ? ` +${file.addedLines ?? 0} −${file.removedLines ?? 0}` : "";
  return `  - ${file.change} ${file.path}${delta}`;
}

/** 只看某一轮运行时，放在状态行下面的一行：第几轮、共几轮、这一轮的状态与耗时。 */
export function runScopeLine(run: Run, total: number, now: number): string {
  const lead = `Run ${run.index} of ${total}`;
  const took = run.startedAt && run.endedAt ? formatDuration(Date.parse(run.endedAt) - Date.parse(run.startedAt)) : undefined;
  switch (run.status) {
    case "queued":
      return `${lead} · queued, not started yet`;
    case "starting":
      return `${lead} · starting`;
    case "running":
      return `${lead} · running${run.startedAt ? ` for ${formatDuration(now - Date.parse(run.startedAt))}` : ""}`;
    case "completed":
      return `${lead} · completed${took ? ` in ${took}` : ""}`;
    case "failed":
      return `${lead} · failed${took ? ` after ${took}` : ""}`;
    case "cancelled":
      return `${lead} · cancelled${took ? ` after ${took}` : run.startedAt ? "" : " before it started"}`;
  }
}

export interface ResultOptions {
  maxChars: number;
  now?: number;
  /** 只取这一轮运行的回答、错误、文件与用量；不传就是当前（或最近一次）运行，用量是整个会话的合计。 */
  run?: Run;
}

/**
 * 结果里的回答（或“没有回答”）是在什么局面下读到的。批量读取（read-batch.ts 的 `Moment`）是同一种分法、措辞一一对应；
 * 它 import 本文件，所以分类器这里自己留一份小的，不反过来引用（两处对“排队”的归属不同，不要合并；只有下面的 `hasRun` 是同一份）。
 * 只有 running 才能说“最新输出 / 仍在运行”，排队与启动都不是“在跑”：
 * - running：这一轮正在跑；
 * - starting：这一轮已经交给执行端启动、还没有开始；
 * - queued：一轮都没开始过，第一轮在排队（或明确指定的这一轮在排队）；
 * - waiting：前面跑过的一轮已经结束，后续一轮在排队、还没开始——看到的回答是前一轮的；
 * - settled：没有任何一轮在进行（含从未跑过、待命、已结束）。
 */
type ResultMoment = "running" | "starting" | "queued" | "waiting" | "settled";

/** 这个会话有没有真的跑过：看运行记录里有没有离开排队的一轮，不看阶段（待命的会话照样可能已经跑过）。批量读取（read-batch.ts）直接用这一份。 */
export function hasRun(summary: SessionSummary): boolean {
  return summary.lastRun !== undefined || summary.runCount > 0;
}

/** 指定了某一轮时，局面只看这一轮自己的状态。 */
function momentOfRun(run: Run): ResultMoment {
  switch (run.status) {
    case "running":
      return "running";
    case "starting":
      return "starting";
    case "queued":
      return "queued";
    case "completed":
    case "failed":
    case "cancelled":
      return "settled";
  }
}

function momentOfSession(summary: SessionSummary): ResultMoment {
  switch (summary.phase) {
    case "running":
      return "running";
    case "starting":
      // 阶段是 starting 的会话有两种：还在连执行端、一轮都没有的，与某一轮已发出启动、还没开始的；只有后一种才是“这一轮正在启动”。
      return summary.lastRun?.status === "starting" ? "starting" : "settled";
    case "queued":
      // 前面跑过一轮、后续一轮在排队，才有“前一轮的回答”可言；一轮都没跑过就是第一轮在排队。
      return hasRun(summary) ? "waiting" : "queued";
    default:
      return "settled";
  }
}

/** 回答上面的那一行。running 的原句与已结束的原句都逐字保留；其余局面各按其实情说。 */
function answerHeading(moment: ResultMoment, final: boolean, runIndex: number | undefined): string {
  switch (moment) {
    case "running":
      return "Latest output so far (the run is still going; this is not a final answer):";
    case "starting":
      return "Output so far (the run is still starting; this is not a final answer):";
    case "waiting":
      // 回答是更早一轮的：写明是哪一轮，不能说成这一轮的最新输出。
      return `${final ? "Final answer of" : "Last message from"} ${runIndex === undefined ? "the previous run" : `run #${runIndex}`} (the next run is queued and has not started yet):`;
    case "queued":
    case "settled":
      return final ? "Final answer:" : "Last message from the session:";
  }
}

/** 没有任何回答文字时的那一句。`explicitRun`：指定了某一轮；`ran`：这个会话真的跑过（见 `hasRun`）。 */
function noAnswerLine(moment: ResultMoment, explicitRun: boolean, ran: boolean): string {
  switch (moment) {
    case "running":
      return "No output yet — the session is still working. Call `wait` or check the panel.";
    case "starting":
      return "No output yet — the run is starting. Call `wait` or check the panel.";
    case "queued":
      // 指定了某一轮时，排队的是这一轮，会话本身可能正忙着前一轮：不能说成“会话在排队”。
      return `No output yet — ${explicitRun ? "this run" : "the session"} is queued and has not started. Call \`wait\` or check the panel.`;
    case "waiting":
      return "The session produced no assistant text in its last run, and the next run is queued and has not started yet. Call `wait` or check the panel.";
    case "settled":
      if (explicitRun) return "The session produced no assistant text in this run.";
      // 一轮都没跑过（刚创建、待命但从没跑过）：没有“上一轮”可言。
      return ran ? "The session produced no assistant text in its last run." : "The session has not run yet.";
  }
}

/** read(view="result")：主 Agent 最常需要的内容——状态、最终回答、改动的文件、用量。 */
export function renderResult(state: SessionState, summary: SessionSummary, options: ResultOptions): string {
  const { run } = options;
  const lines: string[] = [renderSessionLine(summary, options)];
  if (run) lines.push(runScopeLine(run, state.runs.length, options.now ?? Date.now()));
  // 还在等回答的提问：它挡在最终回答前面，主 Agent 最先要看到、要处理的是它（只看某一轮时只列这一轮的）。
  for (const question of openQuestionItems(state)) {
    if (run && question.runId !== run.id) continue;
    lines.push(...questionLines({ questionId: question.questionId, prompts: question.prompts, since: question.at }, { id: summary.id, harness: harnessLabel(summary) }, options.now ?? Date.now()));
  }
  const answer = finalAnswer(state, run);
  const moment = run ? momentOfRun(run) : momentOfSession(summary);

  if (answer) {
    const heading = answerHeading(moment, answer.final, summary.lastRun?.index);
    const budget = Math.max(400, options.maxChars - 600);
    // 默认视图的提示保持原样；指定了某一轮时，转录里每段回答最多留 1500 字，指过去并不能取全，所以那里改成“调大 maxChars”。
    const more = run ? "raise maxChars to see more" : 'use view="transcript" for the full record';
    // 截点落在代理对（emoji）中间时少留一个码元；“还有多少字符”照旧从截点往后数，让出去的那半个字符也算在里面（没有 emoji 时与以前一字不差）。
    const shown = answer.text.length > budget ? sliceHead(answer.text, budget) : undefined;
    const body = shown === undefined ? answer.text : `${shown.trimEnd()}\n… (${answer.text.length - shown.length} more characters; ${more})`;
    lines.push("", heading, body);
  } else {
    lines.push("", noAnswerLine(moment, run !== undefined, hasRun(summary)));
  }

  const failure = run
    ? run.status === "failed" ? run.error : undefined
    : summary.lastError && (summary.phase === "failed" || summary.phase === "lost") ? summary.lastError : undefined;
  if (failure) lines.push("", `Error: [${failure.code}] ${clip(collapseWhitespace(failure.message), 500)}`);
  const files = collectFiles(state, run?.id);
  if (files.length > 0) lines.push("", `Files changed (${files.length}):`, ...files.slice(0, 40).map(fileLine), ...(files.length > 40 ? [`  … and ${files.length - 40} more`] : []));
  const usage = usageText(run ? state.usageByRun[run.id] : summary.usage);
  if (usage) lines.push("", `${run ? `Usage (run ${run.index})` : "Usage"}: ${usage}`);
  return lines.join("\n");
}

function messageOf(state: SessionState, id: string): Message | undefined {
  const index = state.idx.messages.get(id);
  return index === undefined ? undefined : state.messages[index];
}

function toolLine(item: ToolItem): string {
  const status = item.status === "completed" ? "ok" : item.status;
  const extras: string[] = [];
  if (item.exitCode !== undefined && item.exitCode !== 0) extras.push(`exit ${item.exitCode}`);
  if (item.durationMs !== undefined && item.durationMs >= 1000) extras.push(formatDuration(item.durationMs));
  let line = `  • ${item.category}: ${clip(collapseWhitespace(item.title), 140)} → ${status}${extras.length > 0 ? ` (${extras.join(", ")})` : ""}`;
  if (item.status === "failed" || (item.exitCode !== undefined && item.exitCode !== 0)) {
    const detail = item.error ?? item.output?.text;
    if (detail) line += `\n      ${clip(collapseWhitespace(tail(detail, 400)), 400)}`;
  }
  for (const file of (item.files ?? []).slice(0, 6)) line += `\n      ${file.change} ${file.path}`;
  return line;
}

export function itemLines(state: SessionState, item: TimelineItem, options: { includeReasoning: boolean; harness: string }): string | undefined {
  switch (item.type) {
    case "message": {
      const message = messageOf(state, item.messageId);
      if (!message) return undefined;
      const who = message.kind === "task" ? `task → ${options.harness}` : `${message.kind === "steer" ? "correction" : "follow-up"} from ${message.author.label}`;
      return `[${who}] ${clip(message.text.trim(), 800)}  (${STAGE_TEXT[message.delivery.stage]})`;
    }
    case "assistant":
      return item.text.trim() ? `${options.harness}${item.phase === "commentary" ? " (commentary)" : ""}: ${clip(item.text.trim(), 1500)}` : undefined;
    case "reasoning":
      return options.includeReasoning && item.text.trim() ? `${options.harness} (reasoning summary): ${clip(collapseWhitespace(item.text), 600)}` : undefined;
    case "tool":
      return toolLine(item);
    case "plan":
      return `plan: ${item.entries.map((entry) => `${entry.status === "completed" ? "[x]" : entry.status === "in_progress" ? "[~]" : "[ ]"} ${clip(entry.text, 80)}`).join(" ")}`;
    case "diagnostic":
      return `note [${item.level}]: ${clip(collapseWhitespace(item.message), 240)}`;
    case "question":
      return questionItemLine(item, options.harness);
    case "run":
      return `— run ${item.runIndex} ${item.phase}${item.durationMs !== undefined ? ` (${formatDuration(item.durationMs)})` : ""}${item.stopReason ? ` · ${item.stopReason}` : ""} —`;
  }
}

export interface TranscriptOptions {
  maxChars: number;
  includeReasoning?: boolean;
}

/** read(view="transcript")：按时间顺序的执行记录；超出预算时丢弃最早的部分并说明。 */
export function renderTranscript(state: SessionState, summary: SessionSummary, options: TranscriptOptions): string {
  const harness = harnessLabel(summary);
  const rendered: string[] = [];
  for (const item of state.timeline) {
    const text = itemLines(state, item, { includeReasoning: options.includeReasoning === true, harness });
    if (text) rendered.push(text);
  }

  const header = renderSessionLine(summary);
  let budget = options.maxChars - header.length - 120;
  const kept: string[] = [];
  for (let i = rendered.length - 1; i >= 0; i--) {
    const entry = rendered[i] ?? "";
    if (budget - entry.length < 0 && kept.length > 0) break;
    budget -= entry.length + 1;
    kept.unshift(entry);
  }
  const dropped = rendered.length - kept.length;
  return [header, ...(dropped > 0 ? [`(${dropped} earlier entr${dropped === 1 ? "y" : "ies"} omitted to fit; ask for a larger maxChars to see more)`] : []), ...kept].join("\n");
}
