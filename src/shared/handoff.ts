import type { EnsembleEvent } from "./events";
import { isHighSurrogate } from "./safe-slice";
import type { ContextItem, FileChange, HarnessId, RunStatus, SessionId, SessionPhase } from "./types";

/**
 * “按引用交接”：委派时在 `context` 里放一项 `{ kind: "session", sessionId, include }`，
 * 由 Ensemble 服务在派发那一刻从上游会话**自己的事件日志**里取出它真实的最终回答、改动过的文件、最后一次失败，
 * 原样放进下游会话的提示。主 Agent 不必先读一遍上游的输出、再自己转述一遍（转述会丢字、会改写，也烧它自己的上下文）。
 *
 * 本文件只放纯函数与类型（服务端、网页、MCP 桥共用）：取样用的事实类型、归一化、以及从原始事件里取数的 `extractHandoff`。
 * 读中枢、校验、渲染成注入文本、额度，都在 `server/context-refs.ts`。
 */

/** 一个引用能取走的三样东西：最终回答、改动过的文件清单、最后一次失败。 */
export const HANDOFF_PARTS = ["result", "files", "error"] as const;
export type HandoffPart = (typeof HANDOFF_PARTS)[number];

/** 没写 `include` 时取什么：只取结果（实现取舍，用户没有确认）。文件与错误是明确要才给的，免得每次都带一屏用不上的东西。 */
export const DEFAULT_HANDOFF_PARTS: readonly HandoffPart[] = ["result"];

/** 引用的会话还在进行中时，它的产出不是定稿，委派被拒绝（见 server/context-refs.ts）。 */
export const ACTIVE_PHASES: ReadonlySet<SessionPhase> = new Set<SessionPhase>(["starting", "queued", "running"]);

/**
 * 注入文本里每个引用块的标题前缀。服务端渲染时用它，网页按 `sample.block` 取回“当时交出去的原文”时也用它核对：
 * 区间对不上（提示被改过、记录损坏）就不展示，而不是展示一段错位的文字。
 */
export const HANDOFF_BLOCK_HEADING = "### Session ";

/** 引用块在 `meta.task.prompt` 里占的区间：字符下标，左闭右开。 */
export interface HandoffBlockSpan {
  start: number;
  end: number;
}

/** 取不到结果的原因：没有任何运行 / 运行了但没有任何文字 / 有文字，但执行端把它们全标成了过程说明（commentary）。 */
export type HandoffNoResult = "no_runs" | "no_text" | "no_final";

export type HandoffResultFact =
  | {
      found: true;
      /**
       * final：执行端把这段文字标成了最终回答（phase: "final"）；
       * unlabeled：这个会话没有任何一段文字被标过 final，取的是最后一段没有标记的文字——它只是“最后写下的文字”，不保证是结论。
       */
      label: "final" | "unlabeled";
      /** 取自第几次运行（`Run.index`，从 1 起）。 */
      runIndex: number;
      /** 原文的字符数，以及实际交出去的字符数（超出上限被截断时后者更小）。 */
      chars: number;
      sentChars: number;
      /** 最新一次运行里没有可取的，所以取了更早的一次时：被跳过的最新一次运行的序号与结局。 */
      latest?: { runIndex: number; status: RunStatus };
    }
  | { found: false; reason: HandoffNoResult };

/** 文件清单：会话所有运行里按路径去重后的总数，以及实际交出去几个（超出上限时 sent < total）。 */
export interface HandoffFilesFact {
  total: number;
  sent: number;
}

export type HandoffErrorFact =
  | {
      found: true;
      /** 失败记录里原样的错误码；消息原文在注入文本里。 */
      code: string;
      /** 失败发生在第几次运行；会话级的失败（没有对应运行）没有这个字段。 */
      runIndex?: number;
      /** 消息超过上限被截断了。 */
      truncated?: boolean;
    }
  | { found: false };

/**
 * 派发那一刻取到的事实，由服务端写进 `meta.task.context[i].sample`，之后不再变：
 * 页面据此画“这一项当时交出去了什么”，不必（也不该）再回头读上游——上游之后可能继续跑、改名、被归档甚至被删除。
 * 正文不在这里存第二份：它已经在 `meta.task.prompt` 里，`block` 记着它的位置。
 */
export interface HandoffSample {
  /** 取样时刻（ISO）。 */
  at: string;
  /** 上游会话当时的标题、执行端、模型与阶段。 */
  title: string;
  harness: HarnessId;
  /** 展示用的模型名（label、resolved、requested 里第一个有的），不是完整的 ModelRef：页面只需要“它是什么模型”。 */
  model?: string;
  phase: SessionPhase;
  /** 上游当时一共有几次运行。 */
  runCount: number;
  /** 只有请求了的部分才有对应的事实。 */
  result?: HandoffResultFact;
  files?: HandoffFilesFact;
  error?: HandoffErrorFact;
  block?: HandoffBlockSpan;
}

/**
 * `context` 的第五种条目：引用另一个会话的产出。请求里只有 `sessionId`、`include`、`note`；
 * `sample` 由服务端在派发时写入（请求里带了会被校验丢掉，伪造不了）。
 */
export interface SessionContextItem {
  kind: "session";
  sessionId: SessionId;
  /** 取哪几样；缺省见 DEFAULT_HANDOFF_PARTS。顺序与重复不重要，存下来的是规范顺序。 */
  include?: HandoffPart[];
  /** 发起端对这次引用的说明，原样放在块里。 */
  note?: string;
  sample?: HandoffSample;
}

/** 派发回执里每个引用的一条：取样事实加上请求的部分。不含 `block`（那是提示里的位置，对回执没有意义）。 */
export interface ContextRefReceipt extends Omit<HandoffSample, "block"> {
  sessionId: SessionId;
  include: HandoffPart[];
}

/** 规范顺序、去重；没写（或写空）就是默认。认不出的取值丢掉，全丢光了也回到默认。 */
export function normalizeParts(include: readonly HandoffPart[] | undefined): HandoffPart[] {
  const wanted: readonly HandoffPart[] = include ?? [];
  const picked = HANDOFF_PARTS.filter((part) => wanted.includes(part));
  return picked.length > 0 ? picked : [...DEFAULT_HANDOFF_PARTS];
}

export function hasSessionRefs(items: readonly ContextItem[] | undefined): boolean {
  return items?.some((item) => item.kind === "session") === true;
}

/**
 * 只留“请求的那一部分”：session 项只剩 sessionId、规范化的 include 与 note（去掉 sample 与取样时刻），其余种类原样。
 * 防重复要比较的是“要的是什么”，不是“当时取到了什么”——取样时刻每次都不同，比较它就永远判不出重复。
 * 没有 session 项的上下文（包括所有旧会话的）经过它还是原来的元素，比较结果与以前完全一致。
 */
export function requestedContext(items: readonly ContextItem[]): ContextItem[] {
  return items.map((item): ContextItem => {
    if (item.kind !== "session") return item;
    const note = item.note?.trim();
    return { kind: "session", sessionId: item.sessionId, include: normalizeParts(item.include), ...(note ? { note } : {}) };
  });
}

/**
 * 取回某个引用“当时交出去的原文”（`meta.task.prompt` 里它那一块）。区间缺失、越界或块的标题对不上时返回 undefined：
 * 页面据此说“记录缺失”，而不是展示一段错位的文字。
 */
export function handedOverText(prompt: string, item: SessionContextItem): string | undefined {
  const block = item.sample?.block;
  if (!block || !Number.isInteger(block.start) || !Number.isInteger(block.end)) return undefined;
  if (block.start < 0 || block.end > prompt.length || block.start >= block.end) return undefined;
  const text = prompt.slice(block.start, block.end);
  const heading = `${HANDOFF_BLOCK_HEADING}${item.sessionId}`;
  if (!text.startsWith(heading)) return undefined;
  // 编号后面必须紧跟“: 标题”或换行：只核对前缀的话，编号恰好是另一个编号开头时会认错块。
  const next = text.charAt(heading.length);
  return next === ":" || next === "\n" ? text : undefined;
}

/**
 * 从头截取最多 `max` 个字符，不把一个代理对（emoji 等）从中间切开；返回保留的文本与被省略的字符数。
 * 与 safe-slice.ts 的 `sliceHead` 有意不合并：这里截点前一个码元只要是高位代理就让出（单侧规则），
 * `sliceHead` 要求后一个码元确实是低位代理才让出（成对规则，原文里本来就孤立的高位代理恰好落在截点时原样保留）。
 * 两者只在这种退化输入上不同；这里的行为一字不改，只共用判断码元的那个小函数。
 */
export function cutHead(text: string, max: number): { text: string; omitted: number } {
  if (text.length <= max) return { text, omitted: 0 };
  let end = Math.max(0, max);
  if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return { text: text.slice(0, end), omitted: text.length - end };
}

// ───────────────────────── 从原始事件里取数 ─────────────────────────

export interface HandoffRun {
  /** `Run.index`，从 1 起。 */
  index: number;
  status: RunStatus;
}

export type HandoffAnswer =
  | {
      found: true;
      label: "final" | "unlabeled";
      runIndex: number;
      /** 原文，没有截断、没有改动。 */
      text: string;
      /** 取的不是最新一次运行时：被跳过的最新一次。 */
      latest?: HandoffRun;
    }
  | { found: false; reason: HandoffNoResult };

export interface HandoffFile {
  path: string;
  /** 这个路径最后一次被上报的变更类型。 */
  change: FileChange["change"];
}

export interface HandoffFailure {
  /** 失败记录里原样的错误码与消息（不含执行端的原始 detail）。 */
  code: string;
  message: string;
  /** 失败的是第几次运行；会话级失败没有。 */
  runIndex?: number;
}

export interface HandoffExtract {
  /** 全部运行，按序号。 */
  runs: readonly HandoffRun[];
  answer: HandoffAnswer;
  /** 所有运行里 `file.changed` 的并集：按路径去重，顺序是路径第一次出现的先后。 */
  files: readonly HandoffFile[];
  /** 最后一次失败记录；一次都没有失败过就是 undefined。 */
  failure: HandoffFailure | undefined;
}

interface TextEntry {
  runId: string;
  text: string;
  phase: "commentary" | "final" | undefined;
  /** 收到过 `assistant.completed`：这一条结束了，同一个 itemId 之后再来的增量是新的一条。 */
  closed: boolean;
}

interface RunState extends HandoffRun {
  terminal: boolean;
}

interface FailureRecord {
  code: string;
  message: string;
  runIndex: number | undefined;
  /** 来自 `session.status` 的错误（不属于某次运行）。 */
  sessionLevel: boolean;
}

const nonEmpty = (entry: TextEntry): boolean => entry.text.trim() !== "";

/**
 * 直接从会话的原始事件里取出交接要用的三样东西。**不要**改成读 `projection` 的时间线或 MCP 的 `finalAnswer(state)`：
 * 投影的助手文字条目键现在也带 runId（`assistant:<runId>:<itemId>`，没有 runId 的老事件仍用 `assistant:<itemId>`，见 `projection-timeline.ts` 的 `itemKey`），
 * 几次运行的文字已经不会被拼在一起；但交接用的是下面这套自己的规则，投影与 `finalAnswer` 不是这样取的：
 * 同一运行里条目被复用时的处理、跨运行找最近一个有非空 final 的运行、过程说明永远不当作结果。
 * 所以这里仍然直接读原始事件，按（runId, itemId）合并，各次运行互不串。
 *
 * 助手文字的合并规则：
 * - 同一个（runId, itemId）的 `assistant.delta` 顺序拼接；`assistant.completed` 结束这一条，
 *   它自带的完整文本优先于拼出来的（Claude 会在收尾时重发完整文本），它带的 phase 记到这一条上；
 *   同一个键上之后再来的增量是新的一条（itemId 被复用）；已结束的条目再收到 completed（Codex、Pi 等在运行结束时补发只带 phase 的
 *   completed；Claude 的二次完整文本）就是在更正这一条，而不是新开一条。
 * - 没有 runId 的文字（没有运行在进行时来的）认不出属于哪次运行，不取。
 *
 * 取哪一段（全按运行序号，不按到达先后）：
 * 1. 最近一个有非空 `phase: "final"` 的运行，取它里面最后一条；
 * 2. 没有任何运行有 final（执行端不标 phase，如 Claude）：最近一个有非空、没有 phase 标记的文字的运行里最后一条，结果标成 unlabeled；
 * 3. 都没有：如实说原因（没有运行 / 没有文字 / 文字全是过程说明）。
 * 过程说明（commentary）永远不当作结果——这与 MCP 的 `finalAnswer` 不同，它在没有 final 时会退回任意一条最后的文字，包括过程说明。
 *
 * 一次运行以第一个终态事件为准（与投影的 `endRun` 一致）：之后重复的 run.failed 不再算一条失败记录。
 */
export function extractHandoff(events: readonly EnsembleEvent[]): HandoffExtract {
  const runs = new Map<string, RunState>();
  const entries: TextEntry[] = [];
  const latestEntry = new Map<string, TextEntry>();
  const files = new Map<string, FileChange["change"]>();
  const failures: FailureRecord[] = [];

  const settle = (runId: string | undefined, status: "completed" | "failed" | "cancelled"): RunState | undefined => {
    const run = runId === undefined ? undefined : runs.get(runId);
    if (!run || run.terminal) return undefined;
    run.status = status;
    run.terminal = true;
    return run;
  };
  const keyOf = (runId: string, itemId: string): string => `${runId}\u0000${itemId}`;
  const created = (key: string, runId: string): TextEntry => {
    const entry: TextEntry = { runId, text: "", phase: undefined, closed: false };
    entries.push(entry);
    latestEntry.set(key, entry);
    return entry;
  };
  /** 增量：接在这个键上还没结束的那一条后面；没有，或上一条已经结束（itemId 被复用），就新开一条。 */
  const entryToAppend = (runId: string, itemId: string): TextEntry => {
    const key = keyOf(runId, itemId);
    const existing = latestEntry.get(key);
    return existing && !existing.closed ? existing : created(key, runId);
  };
  /** 结束：更正这个键上最近的一条（无论它是否已经结束）；一条都没有才新开。 */
  const entryToComplete = (runId: string, itemId: string): TextEntry => {
    const key = keyOf(runId, itemId);
    return latestEntry.get(key) ?? created(key, runId);
  };

  for (const event of events) {
    switch (event.kind) {
      case "run.queued": {
        const run = event.data.run;
        if (!runs.has(run.id)) runs.set(run.id, { index: run.index, status: "queued", terminal: false });
        break;
      }
      case "run.starting": {
        const run = event.runId === undefined ? undefined : runs.get(event.runId);
        if (run && !run.terminal && run.status === "queued") run.status = "starting";
        break;
      }
      case "run.started": {
        const run = event.runId === undefined ? undefined : runs.get(event.runId);
        if (run && !run.terminal && (run.status === "queued" || run.status === "starting")) run.status = "running";
        break;
      }
      case "run.completed":
        settle(event.runId, "completed");
        break;
      case "run.cancelled":
        settle(event.runId, "cancelled");
        break;
      case "run.failed": {
        const run = settle(event.runId, "failed");
        if (run) failures.push({ code: event.data.error.code, message: event.data.error.message, runIndex: run.index, sessionLevel: false });
        break;
      }
      case "session.status":
        if (event.data.error) failures.push({ code: event.data.error.code, message: event.data.error.message, runIndex: undefined, sessionLevel: true });
        break;
      case "assistant.delta": {
        if (event.runId === undefined) break;
        const entry = entryToAppend(event.runId, event.data.itemId);
        entry.text += event.data.text;
        if (event.data.phase) entry.phase = event.data.phase;
        break;
      }
      case "assistant.completed": {
        if (event.runId === undefined) break;
        const entry = entryToComplete(event.runId, event.data.itemId);
        // 带了完整文本就以它为准（空白不算），没带就保留已经拼出来的。
        if (event.data.text !== undefined && event.data.text.trim() !== "") entry.text = event.data.text;
        if (event.data.phase) entry.phase = event.data.phase;
        entry.closed = true;
        break;
      }
      case "file.changed":
        for (const file of event.data.files) {
          // Map 对已有的键只改值、不改位置：顺序是路径第一次出现的先后，类型是最后一次上报的。
          if (file.path) files.set(file.path, file.change);
        }
        break;
      default:
        break;
    }
  }

  const ordered: HandoffRun[] = [...runs.values()].map(({ index, status }) => ({ index, status })).sort((a, b) => a.index - b.index);

  /** 满足条件的条目里，运行序号最大的那一次里最后一条（迭代是按创建顺序，同一次运行里后来的覆盖先来的）。 */
  const pick = (accept: (entry: TextEntry) => boolean): { entry: TextEntry; runIndex: number } | undefined => {
    let best: { entry: TextEntry; runIndex: number } | undefined;
    for (const entry of entries) {
      if (!accept(entry)) continue;
      const runIndex = runs.get(entry.runId)?.index;
      if (runIndex === undefined) continue;
      if (!best || runIndex >= best.runIndex) best = { entry, runIndex };
    }
    return best;
  };

  const final = pick((entry) => entry.phase === "final" && nonEmpty(entry));
  const picked = final ?? pick((entry) => entry.phase === undefined && nonEmpty(entry));
  const newest = ordered[ordered.length - 1];
  let answer: HandoffAnswer;
  if (picked) {
    answer = {
      found: true,
      label: final ? "final" : "unlabeled",
      runIndex: picked.runIndex,
      text: picked.entry.text,
      ...(newest && newest.index !== picked.runIndex ? { latest: newest } : {}),
    };
  } else {
    const anyText = entries.some((entry) => runs.has(entry.runId) && nonEmpty(entry));
    answer = { found: false, reason: ordered.length === 0 ? "no_runs" : anyText ? "no_final" : "no_text" };
  }

  // 最后一次失败记录。会话级的失败（session.status 带 error）通常紧跟在同一原因的 run.failed 之后：
  // 找得到完全相同的那条运行级记录，就算在那次运行头上——“第 2 次运行失败了”比“会话失败了”更具体，也同样属实。
  let failure: HandoffFailure | undefined;
  const last = failures[failures.length - 1];
  if (last) {
    let runIndex = last.runIndex;
    if (last.sessionLevel) {
      for (let i = failures.length - 2; i >= 0; i--) {
        const earlier = failures[i];
        if (earlier && !earlier.sessionLevel && earlier.code === last.code && earlier.message === last.message) {
          runIndex = earlier.runIndex;
          break;
        }
      }
    }
    failure = { code: last.code, message: last.message, ...(runIndex !== undefined ? { runIndex } : {}) };
  }

  return { runs: ordered, answer, files: [...files].map(([path, change]) => ({ path, change })), failure };
}
