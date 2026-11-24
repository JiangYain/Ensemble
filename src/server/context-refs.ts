import { LIMITS } from "@shared/constants";
import type { EnsembleEvent } from "@shared/events";
import { isoNow } from "@shared/format";
import {
  cutHead,
  extractHandoff,
  HANDOFF_BLOCK_HEADING,
  HANDOFF_PARTS,
  normalizeParts,
  ACTIVE_PHASES,
  type HandoffErrorFact,
  type HandoffExtract,
  type HandoffFilesFact,
  type HandoffNoResult,
  type HandoffPart,
  type HandoffResultFact,
  type SessionContextItem,
} from "@shared/handoff";
import type { ContextItem, ModelRef, SessionId, SessionPhase, SessionSummary } from "@shared/types";
import { composeContext, isSessionEntry, type ComposeEntry, type ComposedContext, type SampleFacts } from "./compose";
import { EnsembleError } from "./errors";
import type { EventHub } from "./hub";

/**
 * 委派时的“按引用交接”（`context` 里的 `session` 条目，见 shared/handoff.ts）：在派发那一刻读上游会话**自己的事件日志**，
 * 取出它真实的最终回答 / 改动过的文件 / 最后一次失败，渲染成注入文本，原样放进下游会话的提示。
 *
 * 取到的事实冻结在新会话的 `meta.task.context[i].sample` 里，注入文本冻结在 `meta.task.prompt` 里；之后上游再变（继续跑、改名、归档），
 * 下游记录里的“当时交出去了什么”都不变。正文只存在提示里这一份，`sample.block` 记着它的区间，不存第二份。
 */

const CAP = LIMITS.contextSession;

/** 读冷会话日志的最多轮数：每一轮之后都会重新核对（读的过程中上游又有了新事件，就得重读），正常情况一轮就够。 */
const MAX_READ_ROUNDS = 4;

/**
 * 展开会话引用要用到的中枢能力，只有这四样：摘要（索引层面，冷会话也能读）、是否在内存里、热会话的事件、热或冷会话的日志。
 * 生产里传整个 `EventHub`；测试用一个只实现这四个方法的假中枢，直接满足这个类型，不必硬转成 `EventHub`。
 */
export type ContextRefHub = Pick<EventHub, "summary" | "isHot" | "events" | "readEvents">;

/**
 * `prepareSessionContext` 的结果，形状就是 `composeContext` 产出的那一份：
 * `context` 要存进 `meta.task.context`（session 条目带着取样事实与它的块在提示里的区间，其余条目原样），
 * `prompt` 要存进 `meta.task.prompt` 并发给执行端，`receipts` 每个被引用的会话一条、按它们在 `context` 里出现的先后。
 */
export type PreparedContext = ComposedContext;

/**
 * 同一个会话在 `context` 里写了多次：合并成一条，放在第一次出现的位置（要的部分取并集，说明合在一起，去掉重复的），
 * 免得同一份回答在提示里出现两遍。同时把每个 session 条目整理成规范形态（include 规范顺序、note 去首尾空白、丢掉任何传进来的 sample）。
 * 不含 session 条目的上下文原样返回。
 */
export function mergeSessionRefs(items: readonly ContextItem[]): ContextItem[] {
  const position = new Map<SessionId, number>();
  const merged: ContextItem[] = [];
  for (const item of items) {
    if (item.kind !== "session") {
      merged.push(item);
      continue;
    }
    const note = item.note?.trim();
    const include = normalizeParts(item.include);
    const at = position.get(item.sessionId);
    const earlier = at === undefined ? undefined : merged[at];
    if (at === undefined || earlier?.kind !== "session") {
      position.set(item.sessionId, merged.length);
      merged.push({ kind: "session", sessionId: item.sessionId, include, ...(note ? { note } : {}) });
      continue;
    }
    const union = HANDOFF_PARTS.filter((part) => earlier.include?.includes(part) || include.includes(part));
    const notes = [earlier.note, note].filter((text): text is string => text !== undefined && text !== "");
    const joined = notes.filter((text, i) => notes.indexOf(text) === i).join("\n");
    merged[at] = { kind: "session", sessionId: earlier.sessionId, include: union, ...(joined ? { note: joined } : {}) };
  }
  return merged;
}

/**
 * 读上游、渲染、合成：`context` 里有 `session` 条目的委派走这里，其余委派不经过它（行为与以前逐字一致）。
 * 返回合并后的上下文、完整提示与回执；不改任何会话、不解冻任何会话（冷会话只读磁盘上的日志）。
 * 最后一次检查通过之后，按合并后的次序给每个条目生成一份记录（会话引用连同同一次渲染得到的块与取样事实），
 * 提示、块在提示里的区间、要存的上下文与回执都由 `composeContext` 从这份记录一次组装出来。
 *
 * 会拒绝（都带着说明，不会悄悄丢内容）：
 * - 引用个数超过 `LIMITS.contextSession.maxRefs`，或合成后的提示超过 `maxPromptChars`（`context_too_large`）；
 * - 引用的会话不存在（`not_found`，一次说全）；
 * - 引用的会话还在进行（starting / queued / running）：它没有定稿，拿到的只会是半截（`context_session_active`，一次说全）。
 *
 * 调用方要把这一步放在“判重与创建会话”那段同步代码之前：这里有 await（冷会话读磁盘），而判重到创建之间不能有 await。
 */
export async function prepareSessionContext(hub: ContextRefHub, task: string, items: readonly ContextItem[]): Promise<PreparedContext> {
  const merged = mergeSessionRefs(items);
  const refs = merged.filter((item): item is SessionContextItem => item.kind === "session");
  if (refs.length > CAP.maxRefs) {
    throw new EnsembleError(
      "context_too_large",
      `context references ${refs.length} different sessions; a delegation can reference at most ${CAP.maxRefs}. Reference only the sessions this work really depends on.`,
      { via: "context", refs: refs.length, maxRefs: CAP.maxRefs },
    );
  }

  // 先不读任何日志：摘要是索引层面的信息，冷会话也能读。不存在的、还在进行的一次说全，免得改一个再撞下一个。
  let summaries = checkReferable(hub, refs);

  // 热会话的事件就在内存里，取样时同步读（永远是最新的）。冷会话的日志在磁盘上，先读好；读的过程中它可能又被唤醒、有了新事件，
  // 所以每次读完都重新取摘要核对：序号变了就重读，而不是拿着旧日志去配新的阶段。
  const cold = new Map<SessionId, { seq: number; events: EnsembleEvent[] }>();
  for (let round = 0; ; round++) {
    const stale = refs.filter((item) => !hub.isHot(item.sessionId) && cold.get(item.sessionId)?.seq !== summaries.get(item.sessionId)?.seq);
    if (stale.length === 0) break;
    if (round >= MAX_READ_ROUNDS) {
      throw new EnsembleError("conflict", `Session ${stale.map((item) => item.sessionId).join(", ")} kept changing while its record was being read. Try again in a moment.`, {
        via: "context",
        sessionIds: stale.map((item) => item.sessionId),
      });
    }
    await Promise.all(
      stale.map(async (item) => {
        const seq = summaries.get(item.sessionId)?.seq;
        const events = await hub.readEvents(item.sessionId);
        if (seq !== undefined) cold.set(item.sessionId, { seq, events });
      }),
    );
    // 等待期间上游可能又开始运行了：重新取摘要，再查一遍是否还在进行。
    summaries = checkReferable(hub, refs);
  }

  // ↓ 从最后一次 checkReferable 到返回之间没有 await：每个引用的“阶段”与“事件”取自同一个时刻。
  const at = isoNow();
  // 按合并之后的次序，一个条目一份记录：普通条目带原输入；会话引用带原输入，以及同一次渲染得到的块与取样事实。
  const entries = merged.map((item): ComposeEntry => {
    if (item.kind !== "session") return { item };
    const summary = summaries.get(item.sessionId);
    const events = hub.isHot(item.sessionId) ? hub.events(item.sessionId) : cold.get(item.sessionId)?.events;
    // 会话总有 session.created 这一条：一条都读不到，说明日志不可读，而不是“这个会话什么都没有”——不能拿空的去说“没有结果”。
    if (!summary || !events || events.length === 0) {
      throw new EnsembleError("internal", `The record of session ${item.sessionId} could not be read, so nothing can be handed over from it.`, {
        via: "context",
        sessionId: item.sessionId,
      });
    }
    const include = normalizeParts(item.include);
    const { block, sample } = renderSessionBlock({ sessionId: item.sessionId, include, note: item.note, summary, extract: extractHandoff(events), at });
    return { item, include, block, sample };
  });

  const composed = composeContext(task, entries);
  if (composed.prompt.length > CAP.maxPromptChars) {
    const taskChars = task.trim().length;
    const refChars = entries.filter(isSessionEntry).map((entry) => ({ sessionId: entry.item.sessionId, chars: entry.block.length }));
    const otherChars = composed.prompt.length - taskChars - refChars.reduce((sum, ref) => sum + ref.chars, 0);
    throw new EnsembleError(
      "context_too_large",
      `The task and its context come to ${composed.prompt.length} characters, over the limit of ${CAP.maxPromptChars} for a delegation that references sessions `
        + `(task ${taskChars}; ${refChars.map((ref) => `session ${ref.sessionId} ${ref.chars}`).join("; ")}; other context ${otherChars}). `
        + "Narrow `include`, drop a reference, shorten the task, or point to a file instead of pasting its content.",
      { via: "context", chars: composed.prompt.length, maxPromptChars: CAP.maxPromptChars, taskChars, refs: refChars, otherChars },
    );
  }
  return composed;
}

/** 引用的会话都得存在、且不在进行中；返回它们此刻的摘要。不合规时一次说全。 */
function checkReferable(hub: Pick<EventHub, "summary">, refs: readonly SessionContextItem[]): Map<SessionId, SessionSummary> {
  const summaries = new Map<SessionId, SessionSummary>();
  const missing: SessionId[] = [];
  const active: { sessionId: SessionId; phase: SessionPhase }[] = [];
  for (const item of refs) {
    const summary = hub.summary(item.sessionId);
    if (!summary) {
      missing.push(item.sessionId);
      continue;
    }
    summaries.set(item.sessionId, summary);
    if (ACTIVE_PHASES.has(summary.phase)) active.push({ sessionId: item.sessionId, phase: summary.phase });
  }
  if (missing.length > 0) {
    throw new EnsembleError(
      "not_found",
      missing.length === 1
        ? `Session ${missing[0]} referenced in context does not exist.`
        : `Sessions ${missing.join(", ")} referenced in context do not exist.`,
      { via: "context", sessionIds: missing },
    );
  }
  if (active.length > 0) {
    const one = active.length === 1;
    throw new EnsembleError(
      "context_session_active",
      `${one ? "Session" : "Sessions"} ${active.map(({ sessionId, phase }) => `${sessionId} (${phase})`).join(", ")} ${one ? "is" : "are"} still in progress, `
        + `so ${one ? "its" : "their"} output is not final and cannot be handed over yet. Wait for ${one ? "it" : "them"} to finish, then delegate again.`,
      { via: "context", sessions: active },
    );
  }
  return summaries;
}

// ───────────────────────── 渲染注入文本 ─────────────────────────

export interface SessionBlockInput {
  sessionId: SessionId;
  include: readonly HandoffPart[];
  note: string | undefined;
  summary: Pick<SessionSummary, "title" | "harness" | "model" | "phase">;
  extract: HandoffExtract;
  /** 取样时刻（ISO）。 */
  at: string;
}

export interface RenderedSessionBlock {
  block: string;
  sample: SampleFacts;
}

/**
 * 把一个引用渲染成放进提示的那一块（英文：它是写给执行端看的）。每一块都带出处（哪个会话、哪个执行端与模型、何时取的、当时是什么阶段），
 * 正文逐字来自上游事件，没有改写；请求了却取不到的部分只写一行，说明原因与当时的阶段；超出额度被截断的，写明省略了多少、去哪里读全文。
 */
export function renderSessionBlock(input: SessionBlockInput): RenderedSessionBlock {
  const { sessionId, include, note, summary, extract, at } = input;
  const runCount = extract.runs.length;
  const title = oneLine(summary.title);
  const model = modelText(summary.model);
  const where = `Ensemble session ${sessionId} (page #/s/${sessionId}, or the read tool)`;
  const sample: SampleFacts = { at, title: summary.title, harness: summary.harness, ...(model ? { model } : {}), phase: summary.phase, runCount };

  const sections: string[] = [];
  if (include.includes("result")) {
    const part = resultSection(extract, summary.phase, where);
    sections.push(part.text);
    sample.result = part.fact;
  }
  if (include.includes("files")) {
    const part = filesSection(extract, summary.phase, where);
    sections.push(part.text);
    sample.files = part.fact;
  }
  if (include.includes("error")) {
    const part = errorSection(extract, summary.phase, where);
    sections.push(part.text);
    sample.error = part.fact;
  }

  const head = [
    `${HANDOFF_BLOCK_HEADING}${sessionId}${title ? `: ${title}` : ""}`,
    `Source: session ${sessionId} (${summary.harness}${model ? `, ${model}` : ""}), sampled ${at}, phase "${summary.phase}", ${count(runCount, "run")}. `
      + "Copied verbatim from that session's own event log by the Ensemble service; nothing below was retold.",
  ];
  if (note) head.push(`Note from the delegating agent: ${note}`);
  return { block: `${head.join("\n")}\n\n${sections.join("\n\n")}`, sample };
}

const NO_RESULT: Record<HandoffNoResult, (runs: number) => string> = {
  no_runs: () => "this session has no runs",
  no_text: (runs) => `none of its ${count(runs, "run")} wrote any assistant text`,
  no_final: () =>
    "it wrote messages, but every one was marked as a progress note (commentary) and none as a final answer; progress notes are not passed on as an answer",
};

function resultSection(extract: HandoffExtract, phase: SessionPhase, where: string): { text: string; fact: HandoffResultFact } {
  const { answer } = extract;
  const runCount = extract.runs.length;
  if (!answer.found) {
    return {
      text: `#### Final answer\nNone: ${NO_RESULT[answer.reason](runCount)} (session phase at sampling: ${phase}).`,
      fact: { found: false, reason: answer.reason },
    };
  }
  const labeled = answer.label === "final";
  const lines = [`#### ${labeled ? "Final answer" : "Last message"} (run ${answer.runIndex} of ${runCount})`];
  if (answer.latest) {
    lines.push(
      `Run ${answer.latest.index} (${answer.latest.status}) produced no ${labeled ? "final answer" : "message"} of its own, so this is from run ${answer.runIndex}.`,
    );
  }
  if (!labeled) {
    lines.push("This session never marked any message as its final answer, so this is simply the last message it wrote; it may not be a conclusion.");
  }
  const cut = cutHead(answer.text, CAP.maxResultChars);
  lines.push(fenced(cut.text));
  if (cut.omitted > 0) {
    lines.push(`[Truncated: only the first ${cut.text.length} of ${answer.text.length} characters are included (${cut.omitted} omitted). Full text: ${where}.]`);
  }
  return {
    text: lines.join("\n"),
    fact: {
      found: true,
      label: answer.label,
      runIndex: answer.runIndex,
      chars: answer.text.length,
      sentChars: cut.text.length,
      ...(answer.latest ? { latest: { runIndex: answer.latest.index, status: answer.latest.status } } : {}),
    },
  };
}

function filesSection(extract: HandoffExtract, phase: SessionPhase, where: string): { text: string; fact: HandoffFilesFact } {
  const total = extract.files.length;
  if (total === 0) {
    return {
      text: `#### Files changed\nNone: no run in this session reported a file change (session phase at sampling: ${phase}). Edits made through shell commands may not be reported.`,
      fact: { total: 0, sent: 0 },
    };
  }
  const shown = extract.files.slice(0, CAP.maxFiles);
  const lines = shown.map((file) => `- ${oneLine(file.path)} (${file.change})`);
  if (shown.length < total) lines.push(`- … ${total - shown.length} more not listed (${shown.length} of ${total} shown). Full list: ${where}.`);
  return {
    text: `#### Files changed (${count(total, "path")} across all ${count(extract.runs.length, "run")}, as reported by the executor)\n${lines.join("\n")}`,
    fact: { total, sent: shown.length },
  };
}

function errorSection(extract: HandoffExtract, phase: SessionPhase, where: string): { text: string; fact: HandoffErrorFact } {
  const { failure } = extract;
  if (!failure) {
    return {
      text: `#### Last error\nNone: no run or session failure was recorded (session phase at sampling: ${phase}).`,
      fact: { found: false },
    };
  }
  const code = oneLine(failure.code);
  const heading =
    failure.runIndex !== undefined
      ? `#### Last error (run ${failure.runIndex} of ${extract.runs.length}, code: ${code})`
      : `#### Last error (session-level, code: ${code})`;
  const cut = cutHead(failure.message, CAP.maxErrorChars);
  const lines = [heading, fenced(cut.text === "" ? "(no message)" : cut.text)];
  if (cut.omitted > 0) {
    lines.push(`[Truncated: only the first ${cut.text.length} of ${failure.message.length} characters are included (${cut.omitted} omitted). Full text: ${where}.]`);
  }
  return {
    text: lines.join("\n"),
    fact: {
      found: true,
      code: failure.code,
      ...(failure.runIndex !== undefined ? { runIndex: failure.runIndex } : {}),
      ...(cut.omitted > 0 ? { truncated: true } : {}),
    },
  };
}

/**
 * 用围栏代码块把原文括起来，围栏比原文里最长的连续反引号再长一格：原文里有 ``` 也不会提前结束，
 * 下游会话与页面都能看清“从哪到哪是原文”。原文本身一个字符都不动。
 */
function fenced(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

/** 标题、路径、错误码这类应当是一行的东西：把里面的换行与连续空白压成一个空格，不让它们打乱块的结构。 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** 模型的显示名：与页面一致，优先用显示名，其次实际用的，最后是请求的。 */
function modelText(model: ModelRef | undefined): string | undefined {
  return model?.label ?? model?.resolved ?? model?.requested;
}
