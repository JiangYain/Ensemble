import type { SessionState } from "@shared/projection";
import type { SessionDetail } from "@shared/protocol";
import { REPORT_DETAILS, REPORT_LIMITS, REPORT_SCOPES, type ReportDetail, type ReportScope } from "@shared/report-options";
import type { Run } from "@shared/types";
import { harnessLabel, renderResult, renderSessionLine, renderSessions, renderTranscript, runScopeLine } from "./format";
import { BATCH_LIMIT, MAX_CHARS, type ManyRequest } from "./read-batch";
import { buildEntries, wholeBody, type BuildContext } from "./read-entries";
import { pageSince } from "./read-page";

/**
 * `read` 工具的参数与单个会话的读取：校验入参（parseReadArgs）、挑出某一轮运行（runIndex）、整段或增量（afterSeq）地排出一个会话的某个视角（readOne）。
 * 实现分在几个模块里：read-entries.ts（各视角的条目与整段排版）、read-page.ts（增量读取与分页）、read-batch.ts（sessionIds 批量读取，含批量的常量与类型）。
 * 对外用的名字仍都从这里取：下面把批量的常量、类型与 readBatch / renderBatch 一并转出，并转出共享的 mapPool。
 * 全部是纯函数（时间通过参数传入），不碰网络，便于测试。
 * 第六个视角 report（Markdown 报告）由服务端渲染：这里只校验它的参数（parseReadArgs → ReportRequest），不排版。
 * 内容只来自执行端真实上报的事件：这里不生成任何叙述，也不下“卡住了”之类的判断。
 */

/** 批量读取要用的有界并发就是共享的这一份（`@shared/map-pool`）；桥与测试仍从这里取。 */
export { mapPool } from "@shared/map-pool";
export { BATCH_CONCURRENCY, BATCH_LIMIT, BATCH_READ_HINT, readBatch, renderBatch } from "./read-batch";
export type { BatchOutcome, BatchOutput, ManyRequest } from "./read-batch";

export const READ_VIEWS = ["result", "transcript", "files", "errors", "commands", "report"] as const;
export type ReadView = (typeof READ_VIEWS)[number];
/**
 * 由单个会话的详情排出来的视角。"report" 不在其内：它是服务端按整份事件日志渲染的 Markdown 报告（GET /api/sessions/:id/report），
 * 桥只带参数过去、原样转交（见 ReportRequest），不经过 readOne，也就不受 runIndex / afterSeq / includeReasoning 的约束。
 */
export type DetailView = Exclude<ReadView, "report">;

const DEFAULT_MAX_CHARS = 12_000;
const BATCH_CHARS_PER_SESSION = 2_000;
const MIN_CHARS = 500;

/** 参数本身、或参数与这个会话对不上（runIndex 越界、afterSeq 超出）：直接把话写给主模型看，与 BridgeInputError 同一待遇。 */
export class ReadInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadInputError";
  }
}

// ───────────────────────── 参数 ─────────────────────────

export interface ReadArgs {
  sessionId?: string | undefined;
  sessionIds?: string[] | undefined;
  view?: ReadView | undefined;
  runIndex?: number | undefined;
  afterSeq?: number | undefined;
  maxChars?: number | undefined;
  includeReasoning?: boolean | undefined;
  /** 只属于 view="report"：只要这个会话自己（缺省），还是连同它名下委派出去的整棵任务树。 */
  scope?: ReportScope | undefined;
  /** 只属于 view="report"：brief（缺省）只列关键步骤；full 另带工具的输入与输出。 */
  detail?: ReportDetail | undefined;
}

export interface OneRequest {
  kind: "one";
  sessionId: string;
  view: DetailView;
  maxChars: number;
  includeReasoning: boolean;
  runIndex?: number;
  afterSeq?: number;
}

/**
 * `view="report"`：整份 Markdown 报告由服务端渲染，桥只把参数带过去，所以这里没有 runIndex / afterSeq / includeReasoning
 * （报告永远从头到尾覆盖整个会话，也从不收录推理内容）。
 */
export interface ReportRequest {
  kind: "report";
  sessionId: string;
  scope: ReportScope;
  detail: ReportDetail;
  /** 交给服务的字数上限：已经抬到报告放得下的最小值（REPORT_LIMITS.minChars）。 */
  maxChars: number;
  /** 调用方要的比最小值还小、被抬高时，记下它原来要的值，好在输出里说明；没被抬高就没有这一项。 */
  raisedFrom?: number;
}

export type ReadRequest = OneRequest | ManyRequest | ReportRequest;

function clampChars(value: number): number {
  return Math.min(MAX_CHARS, Math.max(MIN_CHARS, Math.floor(value)));
}

/** 校验并规整 `read` 的入参。schema 里的范围只是给模型看的提示，这里仍按运行时的值再核一遍，错误一律写成能直接照做的英文。 */
export function parseReadArgs(args: ReadArgs): ReadRequest {
  const { sessionId, sessionIds } = args;
  if (args.runIndex !== undefined && (!Number.isInteger(args.runIndex) || args.runIndex < 1)) {
    throw new ReadInputError("`runIndex` must be a whole number from 1 (runs are numbered from 1 in the order they were started).");
  }
  if (args.afterSeq !== undefined && (!Number.isInteger(args.afterSeq) || args.afterSeq < 0)) {
    throw new ReadInputError("`afterSeq` must be a whole number from 0 — use the number from the `cursor: #N` line of a previous read of the same session.");
  }

  if (sessionIds !== undefined) {
    if (sessionId !== undefined) throw new ReadInputError("Pass either `sessionId` (one session) or `sessionIds` (several), not both.");
    const clashes = [
      ...(args.view !== undefined && args.view !== "result" ? [`view="${args.view}"`] : []),
      ...(args.runIndex !== undefined ? ["`runIndex`"] : []),
      ...(args.afterSeq !== undefined ? ["`afterSeq`"] : []),
      ...(args.includeReasoning === true ? ["`includeReasoning`"] : []),
      ...(args.scope !== undefined ? ["`scope`"] : []),
      ...(args.detail !== undefined ? ["`detail`"] : []),
    ];
    if (clashes.length > 0) {
      throw new ReadInputError(
        `\`sessionIds\` returns one compact summary per session and cannot be combined with ${clashes.join(", ")}. To use those, read one session at a time with \`sessionId\`.`,
      );
    }
    const unique = [...new Set(sessionIds.map((id) => id.trim()).filter((id) => id.length > 0))];
    if (unique.length === 0) throw new ReadInputError("`sessionIds` has no session id in it. Pass at least one id (ses_…).");
    if (unique.length > BATCH_LIMIT) {
      throw new ReadInputError(`\`sessionIds\` takes at most ${BATCH_LIMIT} sessions per call (got ${unique.length}). Read the rest in a second call.`);
    }
    return {
      kind: "many",
      sessionIds: unique,
      maxChars: clampChars(args.maxChars ?? Math.max(BATCH_CHARS_PER_SESSION, BATCH_CHARS_PER_SESSION * unique.length)),
      ignored: sessionIds.length - unique.length,
    };
  }

  const id = sessionId?.trim();
  if (!id) throw new ReadInputError("Pass `sessionId` to read one session, or `sessionIds` to read several at once.");
  const view = args.view ?? "result";
  if (view === "report") return reportRequest(id, args);
  if (args.scope !== undefined || args.detail !== undefined) {
    throw new ReadInputError(
      '`scope` and `detail` only apply to `view="report"`; with any other view they would be silently ignored, so they are refused. Add `view: "report"`, or leave them out.',
    );
  }
  return {
    kind: "one",
    sessionId: id,
    view,
    maxChars: clampChars(args.maxChars ?? DEFAULT_MAX_CHARS),
    includeReasoning: args.includeReasoning === true,
    ...(args.runIndex !== undefined ? { runIndex: args.runIndex } : {}),
    ...(args.afterSeq !== undefined ? { afterSeq: args.afterSeq } : {}),
  };
}

/**
 * view="report" 的参数：报告永远覆盖整个会话、从不含推理内容，所以 runIndex / afterSeq / includeReasoning 在这里没有意义——
 * 明说不支持，而不是悄悄忽略后让主模型以为拿到了“只含这一轮”的报告。
 * 字数上限低于报告放得下的最小值（概览、一个会话的最小片段与页脚说明）时抬到最小值，并记下原值好在输出里说明。
 */
function reportRequest(sessionId: string, args: ReadArgs): ReportRequest {
  const misused = [
    ...(args.runIndex !== undefined ? ["`runIndex`"] : []),
    ...(args.afterSeq !== undefined ? ["`afterSeq`"] : []),
    ...(args.includeReasoning === true ? ["`includeReasoning`"] : []),
  ];
  if (misused.length > 0) {
    throw new ReadInputError(
      `\`view="report"\` always covers whole sessions, from the first event to the last, and never includes reasoning, so it cannot be combined with ${misused.join(", ")}. ` +
        "To read one run, only what is new, or reasoning summaries, use another view.",
    );
  }
  const scope = args.scope ?? "session";
  if (!REPORT_SCOPES.includes(scope)) {
    throw new ReadInputError(`\`scope\` must be "session" (only this session) or "tree" (this session and every session delegated below it); got "${String(scope)}".`);
  }
  const detail = args.detail ?? "brief";
  if (!REPORT_DETAILS.includes(detail)) {
    throw new ReadInputError(`\`detail\` must be "brief" (key steps only) or "full" (also tool inputs and outputs); got "${String(detail)}".`);
  }
  const asked = args.maxChars;
  return {
    kind: "report",
    sessionId,
    scope,
    detail,
    maxChars: Math.max(REPORT_LIMITS.minChars, clampChars(asked ?? DEFAULT_MAX_CHARS)),
    ...(asked !== undefined && asked < REPORT_LIMITS.minChars ? { raisedFrom: Math.floor(asked) } : {}),
  };
}

// ───────────────────────── 单个会话 ─────────────────────────

export interface ReadOutput {
  text: string;
  view: DetailView;
  /** 这次读到的位置：下次把它当 afterSeq 传回，只读此后的新内容。 */
  seq: number;
  runIndex?: number;
  /** 受预算限制、这一页还没给出的条目数（只有 afterSeq 读取会出现）。 */
  remaining?: number;
}

export function cursorLine(seq: number, continued: boolean): string {
  return `cursor: #${seq} — pass afterSeq=${seq} to ${continued ? "continue from here" : "read only what happens after this"}`;
}

function pickRun(state: SessionState, sessionId: string, runIndex: number | undefined): Run | undefined {
  if (runIndex === undefined) return undefined;
  const run = state.runs.find((entry) => entry.index === runIndex);
  if (run) return run;
  const total = state.runs.length;
  throw new ReadInputError(
    total === 0
      ? `runIndex ${runIndex} is out of range: session ${sessionId} has no runs yet.`
      : `runIndex ${runIndex} is out of range: session ${sessionId} has ${total} run${total === 1 ? "" : "s"} (valid: ${total === 1 ? "1" : `1..${total}`}).`,
  );
}

export function readOne(detail: SessionDetail, state: SessionState, request: OneRequest, now: number = Date.now()): ReadOutput {
  const { summary, events } = detail;
  const { view, maxChars, afterSeq } = request;
  const run = pickRun(state, summary.id, request.runIndex);
  const latest = state.seq;
  const base = { view, seq: latest, ...(run ? { runIndex: run.index } : {}) };

  if (afterSeq !== undefined && afterSeq > latest) {
    throw new ReadInputError(
      `afterSeq ${afterSeq} is beyond the latest event of session ${summary.id} (#${latest}). A cursor only fits the session it came from — it may belong to another session. ` +
        "Use the `cursor: #N` line of a read of this session, or leave afterSeq out to read from the start.",
    );
  }
  // 没有新事件：一行说明加状态行（与 attention 行），不做任何重放，轮询时几乎不花 token。
  if (afterSeq !== undefined && afterSeq === latest) {
    return { ...base, text: `No new events since #${afterSeq}.\n${renderSessions([summary], { now })}` };
  }

  if (view === "result") {
    const body = renderResult(state, summary, { maxChars, now, ...(run ? { run } : {}) });
    if (afterSeq === undefined) return { ...base, text: `${body}\n${cursorLine(latest, false)}` };
    const fresh = events.filter((event) => event.seq > afterSeq).length;
    return { ...base, text: `${body}\n${fresh} new event${fresh === 1 ? "" : "s"} since #${afterSeq}.\n${cursorLine(latest, false)}` };
  }

  // 不带 runIndex 与 afterSeq 的转录走原来的排版，保证现有调用的输出一字不变（只在末尾多游标一行）。
  if (view === "transcript" && afterSeq === undefined && !run) {
    return { ...base, text: `${renderTranscript(state, summary, { maxChars, includeReasoning: request.includeReasoning })}\n${cursorLine(latest, false)}` };
  }

  const ctx: BuildContext = {
    harness: harnessLabel(summary),
    includeReasoning: request.includeReasoning,
    markOpen: afterSeq !== undefined,
    runId: run?.id,
    now,
    multiRun: state.runs.filter((entry) => entry.status !== "queued").length > 1,
  };
  const head = [renderSessionLine(summary, { now }), ...(run ? [runScopeLine(run, state.runs.length, now)] : [])];

  if (afterSeq === undefined) {
    const entries = buildEntries(view, state, events, ctx);
    const budget = Math.max(200, maxChars - head.join("\n").length - 160);
    return { ...base, text: [...head, ...wholeBody(view, entries, { ctx, run, budget }), cursorLine(latest, false)].join("\n") };
  }

  const page = pageSince({ view, state, events, ctx, afterSeq, budget: Math.max(200, maxChars - head.join("\n").length - 220), maxChars });
  return {
    ...base,
    seq: page.cursor,
    text: [...head, ...page.lines, cursorLine(page.cursor, page.remaining > 0)].join("\n"),
    ...(page.remaining > 0 ? { remaining: page.remaining } : {}),
  };
}
