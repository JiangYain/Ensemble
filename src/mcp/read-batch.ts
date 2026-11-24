import { clip, collapseWhitespace, formatCount, formatDuration, formatUsd, msBetween, shortenPath } from "@shared/format";
import { mapPool } from "@shared/map-pool";
import { replay, type SessionState } from "@shared/projection";
import type { SessionDetail } from "@shared/protocol";
import { sliceHead } from "@shared/safe-slice";
import type { SessionSummary, Usage } from "@shared/types";
import { collectFiles, finalAnswer, hasRun, renderAttention, sessionHead } from "./format";

/**
 * `read` 的批量读取（sessionIds）：一次调用收回多个会话的核心结论。
 *
 * 内存峰值不随会话数线性增长：`readBatch` 里每个并发任务取回一份详情（带完整事件数组）后，立刻把它压成“事实”
 * （摘要、改动文件的路径、结论文字、各轮耗时的合计）再放手，渲染只用这些事实——同一时刻最多 BATCH_CONCURRENCY 份完整详情在内存里，
 * 而不是每个会话的详情都攥到最后一起渲染。
 * 与展示时刻有关的文字（“已进行多久”“多久以前”）不在压缩时算，而是等全部取回之后用同一个时刻一次算出，各块之间的口径一致。
 * 全部是纯函数，取数函数由调用方注入，不碰网络。不依赖 read.ts：read.ts 依赖这里（参数校验要用这里的常量与类型），反过来会成环。
 */

/** 一次批量读取最多收几个会话：再多，每个会话分到的篇幅就没有意义了。 */
export const BATCH_LIMIT = 20;
/** 批量读取时同时向服务取的会话数。 */
export const BATCH_CONCURRENCY = 4;
/** `maxChars` 的上限：参数校验（read.ts）与这里“预算太小”的提示共用同一个数。 */
export const MAX_CHARS = 40_000;
/** 批量读取里，核心结论一节（标签、正文与截断说明）至少留这么多：再少只剩半句话，没有信息量。 */
const MIN_CONCLUSION_SECTION = 520;
/** 批量读取的标题行与块间空行预留的字数。 */
const BATCH_HEADER_RESERVE = 280;
/** 批量读取里，截断说明那一行预留的字数。 */
const TRUNCATION_NOTE_RESERVE = 170;

/** 主 Agent 等待多个会话都结束之后，提示它可以一次取回全部结论（`wait` 的结构化结果不变，只多这一行文字）。 */
export const BATCH_READ_HINT = `To collect every session's conclusion, changed files, duration and cost in one call, use \`read\` with \`sessionIds\` (up to ${BATCH_LIMIT}).`;

export interface ManyRequest {
  kind: "many";
  sessionIds: string[];
  /** 所有会话合计的字数预算。 */
  maxChars: number;
  /** 入参里被忽略的重复（或空白）编号个数。 */
  ignored: number;
}

export type BatchOutcome = { id: string; detail: SessionDetail } | { id: string; reason: string };

export interface BatchOutput {
  text: string;
  /** 读到的会话（按入参顺序）。 */
  readable: SessionSummary[];
  unreadable: { id: string; reason: string }[];
}

// ───────────────────────── 压成事实 ─────────────────────────

/** 各轮运行的耗时数据：排版时才和展示时刻一起拼成 `run:` 那一行。只数离开了排队的轮次。 */
interface RunTally {
  started: number;
  /** 既有开始又有结束时间的轮数，以及它们各自耗时的合计。 */
  finished: number;
  finishedMs: number;
}

function tallyRuns(state: SessionState): RunTally {
  const tally: RunTally = { started: 0, finished: 0, finishedMs: 0 };
  for (const run of state.runs) {
    if (run.status === "queued") continue;
    tally.started += 1;
    if (run.startedAt && run.endedAt) {
      tally.finishedMs += msBetween(run.startedAt, run.endedAt);
      tally.finished += 1;
    }
  }
  return tally;
}

/** 最近一轮的耗时；多轮时写明轮数，总耗时只在能算出来时给，并标清是哪些轮的总和。 */
function runTiming(summary: SessionSummary, runs: RunTally, now: number): string {
  const last = summary.lastRun;
  if (!last) return "none yet (the session has not started a run)";
  const own =
    last.durationMs !== undefined
      ? formatDuration(last.durationMs)
      : last.startedAt
        ? `running for ${formatDuration(now - Date.parse(last.startedAt))}`
        : last.status === "cancelled"
          ? "cancelled before it started"
          : "not started yet";
  if (runs.started <= 1) return `#${last.index}, ${own}`;
  const lead = `#${last.index} of ${runs.started} runs, ${own}`;
  if (runs.finished === 0) return lead;
  return `${lead}; ${runs.finished === runs.started ? "all runs together" : `${runs.finished} finished run${runs.finished === 1 ? "" : "s"} together`}: ${formatDuration(runs.finishedMs)}`;
}

/** 用量是整个会话各轮的合计（服务端按轮累加）；没有上报的费用写明“未上报”，既不写成 $0 也不省略。 */
function batchUsage(usage: Usage | undefined): string {
  if (!usage) return "no token or cost figures reported by the harness";
  const tokens = usage.totalTokens ?? (usage.inputTokens !== undefined || usage.outputTokens !== undefined ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) : undefined);
  const cost =
    usage.costUsd === undefined
      ? "cost: not reported by the harness"
      : usage.costUsd === 0
        ? "cost $0.00 (reported as zero — may mean the harness has no price for the model)"
        : `cost ${formatUsd(usage.costUsd)}`;
  return `${tokens !== undefined ? `${formatCount(tokens)} tokens` : "tokens not reported"}, ${cost}`;
}

type Conclusion = { kind: "text"; label: string; body: string } | { kind: "none"; line: string };

/**
 * 结论一节与固定几行末尾那句说明讲的，是哪一种局面：
 * - running：这一轮正在跑，看到的是它到目前为止的输出；
 * - starting：这一轮已经交给执行端启动、还没有开始（`run:` 那一行写的是 not started yet）；
 * - waiting：前面跑过的一轮已经结束，后续一轮在排队、还没开始——看到的回答是前一轮的；
 * - settled：没有任何一轮在进行（含从未跑过、第一轮还在排队、待命、已结束）。
 * 只有 running 才能说“最新输出 / 仍在运行”；排队与启动不是“在跑”。
 */
type Moment = "running" | "starting" | "waiting" | "settled";

function momentOf(summary: SessionSummary): Moment {
  switch (summary.phase) {
    case "running":
      return "running";
    case "starting":
      // 阶段是 starting 的会话有两种：还在连执行端、一轮都没有的，与某一轮已发出启动、还没开始的；只有后一种才是“这一轮正在启动”。
      return summary.lastRun?.status === "starting" ? "starting" : "settled";
    case "queued":
      // 排队的是后续一轮才有“前一轮的回答”可言；第一轮就在排队（一轮都没跑过）归 settled，由“还没跑过”那一句说明。
      return hasRun(summary) ? "waiting" : "settled";
    default:
      return "settled";
  }
}

function answerLabel(moment: Moment, final: boolean, runIndex: number | undefined): string {
  switch (moment) {
    case "running":
      return "latest output so far (not final)";
    case "starting":
      return "output so far (not final — the run is still starting)";
    case "waiting": {
      // 回答是更早一轮的：写明是哪一轮，不能说成“这一轮的最新输出”。
      const source = runIndex === undefined ? "" : ` of run #${runIndex}`;
      return final ? `conclusion${source}` : `last message${source} (the harness did not mark it final)`;
    }
    case "settled":
      return final ? "conclusion" : "last message (the harness did not mark it final)";
  }
}

function noAnswerLine(moment: Moment, ran: boolean): string {
  // 一轮都没开始过（刚创建、第一轮还在排队，或者待命但从没跑过）：没有任何东西在跑，也谈不上“上一轮没产出”——不能写成 still running。
  if (!ran) return "    conclusion: none — the session has not run yet";
  switch (moment) {
    case "running":
      return "    conclusion: none yet — still running";
    case "starting":
      return "    conclusion: none yet — the run is starting";
    case "waiting":
    case "settled":
      return "    conclusion: none — the last run produced no assistant text";
  }
}

/** 固定几行末尾那句“这还不是最终结果”的说明；已经有结果、或没有东西在进行时没有这一行。 */
function pendingNote(moment: Moment, summary: SessionSummary): string | undefined {
  switch (moment) {
    case "running":
      // 没有一轮运行存在时没有东西在跑，不写这一行，免得和上面的 `run: none yet` 自相矛盾。
      return summary.lastRun ? "    still running — not final" : undefined;
    case "starting":
      return "    starting — not final";
    case "waiting":
      return "    next run queued — not started yet";
    case "settled":
      return undefined;
  }
}

/** 结论一节与固定行末尾的说明。两者只取决于运行的进行状态与有没有回答，与展示时刻无关，所以压缩时就能定下来。 */
interface Verdict {
  conclusion: Conclusion;
  pending?: string;
}

function verdictOf(summary: SessionSummary, state: SessionState): Verdict {
  const moment = momentOf(summary);
  const pending = pendingNote(moment, summary);
  const answer = finalAnswer(state);
  const conclusion: Conclusion = answer
    ? { kind: "text", label: answerLabel(moment, answer.final, summary.lastRun?.index), body: answer.text.replace(/\n{3,}/g, "\n\n") }
    : { kind: "none", line: noAnswerLine(moment, hasRun(summary)) };
  return pending === undefined ? { conclusion } : { conclusion, pending };
}

interface BrokenBlock {
  kind: "broken";
  id: string;
  reason: string;
}

/** 一个会话的详情压缩之后的样子：排版需要的一切，但不再带着事件数组。 */
interface ReadableDigest {
  kind: "block";
  id: string;
  summary: SessionSummary;
  /** 改动文件的总数，与前几个路径（已缩短）。 */
  files: { count: number; paths: string[] };
  runs: RunTally;
  verdict: Verdict;
}

type Digest = ReadableDigest | BrokenBlock;

/** 把一份详情压成事实。事件数组只在这里被读一次（重放），调用方拿到返回值之后就可以放手整份详情。 */
function digestOutcome(outcome: BatchOutcome): Digest {
  if (!("detail" in outcome)) return { kind: "broken", id: outcome.id, reason: outcome.reason };
  const { summary } = outcome.detail;
  const state = replay(outcome.detail.events);
  if (!state) return { kind: "broken", id: outcome.id, reason: "it has no readable history." };

  const files = collectFiles(state);
  return {
    kind: "block",
    id: outcome.id,
    summary,
    files: { count: files.length, paths: files.slice(0, 3).map((file) => shortenPath(file.path, 60)) },
    runs: tallyRuns(state),
    verdict: verdictOf(summary, state),
  };
}

// ───────────────────────── 排版 ─────────────────────────

interface ReadableBlock {
  kind: "block";
  id: string;
  summary: SessionSummary;
  /** 不随预算伸缩的几行（第一行是状态行，前面还要加序号）。 */
  fixed: string[];
  conclusion: Conclusion;
}

/** 在展示时刻 `now` 上把事实排成固定几行：这是唯一用到时刻的地方。 */
function blockOf(digest: Digest, now: number): ReadableBlock | BrokenBlock {
  if (digest.kind === "broken") return digest;
  const { summary, files, runs, verdict } = digest;
  const { counters } = summary;
  const fixed = [
    sessionHead(summary, { now }),
    `    run: ${runTiming(summary, runs, now)}`,
    `    tools: ${counters.tools === 0 ? "none" : `${counters.tools} call${counters.tools === 1 ? "" : "s"}, ${counters.failedTools === 0 ? "none failed" : `${counters.failedTools} failed`}`}`,
    `    files: ${files.count === 0 ? "none reported" : `${files.count} changed — ${files.paths.join(", ")}${files.count > files.paths.length ? `, … (+${files.count - files.paths.length} more)` : ""}`}`,
    `    usage (all runs): ${batchUsage(summary.usage)}`,
    ...(summary.lastError && (summary.phase === "failed" || summary.phase === "lost") ? [`    error: [${summary.lastError.code}] ${clip(collapseWhitespace(summary.lastError.message), 300)}`] : []),
    ...renderAttention(summary, now),
    ...(verdict.pending !== undefined ? [verdict.pending] : []),
  ];
  return { kind: "block", id: digest.id, summary, fixed, conclusion: verdict.conclusion };
}

function indentBody(body: string): string {
  return body
    .split("\n")
    .map((row) => (row ? `      ${row}` : row))
    .join("\n");
}

/**
 * 把结论正文缩进后放进 limit 个字符里；放不下就从头保留，并返回被截掉的原文字数。
 * 截点落在代理对（emoji）中间时少留一个码元，所以被截掉的字数一律用 `body.length - kept.length` 现算，不用 cut 推。
 */
function fitBody(body: string, limit: number): { text: string; omitted: number } {
  const whole = indentBody(body);
  if (whole.length <= limit) return { text: whole, omitted: 0 };
  let cut = Math.min(body.length, Math.max(0, limit));
  for (let pass = 0; pass < 4; pass++) {
    const kept = sliceHead(body, cut).trimEnd();
    const over = indentBody(kept).length - limit;
    if (over <= 0) return { text: indentBody(kept), omitted: body.length - kept.length };
    cut = Math.max(0, cut - over);
  }
  const kept = sliceHead(body, cut).trimEnd();
  return { text: indentBody(kept), omitted: body.length - kept.length };
}

/**
 * 把总预算分给各个会话：谁的内容短就先按需给足，剩下的平分给内容长的（注水）；每个会话至少保住固定的几行与一小段结论。
 * 总预算连这个下限都放不下时照下限给，并返回 tight，由调用方明说。
 * 返回的 allowance 与 needs 同序（也就是入参顺序）。
 */
function allocate(budget: number, needs: readonly number[], floors: readonly number[]): { allowance: number[]; tight: boolean } {
  const order = needs.map((_, index) => index).sort((a, b) => (needs[a] ?? 0) - (needs[b] ?? 0));
  const allowance = needs.map(() => 0);
  let remaining = budget;
  let left = needs.length;
  for (const index of order) {
    const give = Math.max(floors[index] ?? 0, Math.min(needs[index] ?? 0, remaining / left));
    allowance[index] = give;
    remaining -= give;
    left -= 1;
  }
  return { allowance, tight: allowance.reduce((sum, value) => sum + value, 0) > budget + 1 };
}

/**
 * 排成最终文字：每个会话一块，按入参顺序。块里是状态、耗时、工具与失败数、改动文件、用量，
 * 以及最终回答的开头——都取自真实事件，没有概括性的叙述。`maxChars` 是所有会话合计的预算。
 * 展示时刻只在这里取一次（调用方没给就在此刻取），也就是在全部会话都取回并压好之后。
 */
function renderDigests(digests: readonly Digest[], options: { maxChars: number; ignored?: number | undefined; now?: number | undefined }): BatchOutput {
  const now = options.now ?? Date.now();
  const prepared = digests.map((digest) => blockOf(digest, now));
  const total = prepared.length;
  const lead = (index: number): string => `${index + 1}/${total} `;

  const readable = prepared.flatMap((block, index) => (block.kind === "block" ? [{ block, index }] : []));
  const brokenLength = prepared.reduce((sum, block, index) => sum + (block.kind === "broken" ? lead(index).length + block.id.length + block.reason.length + 40 : 0), 0);

  const fixedLengths = readable.map(({ block, index }) => lead(index).length + block.fixed.join("\n").length);
  const fullSections = readable.map(({ block }) =>
    block.conclusion.kind === "text" ? `    ${block.conclusion.label}:`.length + 1 + indentBody(block.conclusion.body).length : block.conclusion.line.length,
  );
  const needs = readable.map((_, i) => (fixedLengths[i] ?? 0) + 1 + (fullSections[i] ?? 0) + 1);
  const floors = readable.map((_, i) => (fixedLengths[i] ?? 0) + 1 + Math.min(fullSections[i] ?? 0, MIN_CONCLUSION_SECTION) + 1);
  const budget = options.maxChars - BATCH_HEADER_RESERVE - brokenLength;
  const { allowance, tight } = allocate(budget, needs, floors);

  let cut = 0;
  const blocks: string[] = [];
  let readableIndex = 0;
  prepared.forEach((block, index) => {
    if (block.kind === "broken") {
      blocks.push(`${lead(index)}${block.id} — could not be read: ${block.reason}`);
      return;
    }
    const slot = readableIndex++;
    const lines = [...block.fixed];
    lines[0] = `${lead(index)}${lines[0] ?? ""}`;
    const room = Math.max(0, (allowance[slot] ?? 0) - (fixedLengths[slot] ?? 0) - 2);
    const { conclusion } = block;
    if (conclusion.kind === "none") {
      lines.push(conclusion.line);
    } else {
      const label = `    ${conclusion.label}:`;
      const whole = fitBody(conclusion.body, room - label.length - 1);
      if (whole.omitted === 0) {
        lines.push(label, whole.text);
      } else {
        cut += 1;
        const fitted = fitBody(conclusion.body, room - label.length - 1 - TRUNCATION_NOTE_RESERVE);
        lines.push(label, fitted.text, `      … (${fitted.omitted} more characters; read ${block.id} on its own with a larger maxChars for the full answer)`);
      }
    }
    blocks.push(lines.join("\n"));
  });

  const header = [
    `Read ${total} session${total === 1 ? "" : "s"}, in the order given (maxChars ${options.maxChars} in total).`,
    ...(options.ignored ? [`${options.ignored} duplicate or blank id${options.ignored === 1 ? "" : "s"} ignored.`] : []),
    ...(tight
      ? [
          `maxChars ${options.maxChars} is too small for ${readable.length} session${readable.length === 1 ? "" : "s"}: each keeps its facts and only the start of its conclusion, about ${Math.round(allowance.reduce((sum, value) => sum + value, 0) + brokenLength)} characters in all. Raise maxChars (up to ${MAX_CHARS}) for longer conclusions.`,
        ]
      : cut > 0
        ? [`${cut} of ${readable.length} conclusion${readable.length === 1 ? "" : "s"} ${cut === 1 ? "was" : "were"} cut to fit; raise maxChars (up to ${MAX_CHARS}) or read those sessions on their own.`]
        : []),
  ];

  return {
    text: [...header, "", blocks.join("\n\n")].join("\n"),
    readable: readable.map(({ block }) => block.summary),
    unreadable: prepared.flatMap((block) => (block.kind === "broken" ? [{ id: block.id, reason: block.reason }] : [])),
  };
}

// ───────────────────────── 入口 ─────────────────────────

/**
 * 一次调用收回多个会话的核心结论（见 renderDigests 的排版）。会话编号按入参顺序，输出也按这个顺序；有界并发（BATCH_CONCURRENCY）地取，
 * 每个任务取回详情后马上压成事实、放手完整事件数组，全部完成后才排版。
 *
 * `fetchOutcome` 由调用方提供：单个会话读不到（不存在、无权读取这类只涉及它自己的问题）就返回 `{ id, reason }`，那个会话在输出里写成“读不到”，
 * 其余照常；它抛出的错误视为对所有会话都一样的问题（连不上服务、协议不兼容……），整个调用随之失败，尚未开始的会话不再去取。
 * `options.now` 只给测试用，固定展示时刻。
 */
export async function readBatch(request: ManyRequest, fetchOutcome: (id: string) => Promise<BatchOutcome>, options: { now?: number } = {}): Promise<BatchOutput> {
  const digests = await mapPool(request.sessionIds, BATCH_CONCURRENCY, async (id) => digestOutcome(await fetchOutcome(id)));
  return renderDigests(digests, { maxChars: request.maxChars, ignored: request.ignored, now: options.now });
}

/**
 * 同步版：详情已经全在手里时用（测试、旧调用方）。与 `readBatch` 共用同一套压缩与排版，输出一字不差；
 * 区别只在“详情是否一次全部攥在内存里”——生产路径应当用 `readBatch`。
 */
export function renderBatch(outcomes: readonly BatchOutcome[], options: { maxChars: number; ignored?: number; now?: number }): BatchOutput {
  return renderDigests(outcomes.map(digestOutcome), options);
}
