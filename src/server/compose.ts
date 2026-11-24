import type { ContextRefReceipt, HandoffBlockSpan, HandoffPart, HandoffSample, SessionContextItem } from "@shared/handoff";
import type { ContextItem } from "@shared/types";

/**
 * 把委派原文与上下文合成为发给执行端的完整提示。
 * 不注入任何“角色设定”：执行端收到的就是发起端写的任务加上它显式传入的上下文，
 * 合成结果会原样保存并展示在页面上。
 *
 * 有两个入口，拼接只有一份（`assemble`）：含会话引用的委派走 `composeContext`，按条目一次组装出提示、要存的上下文与回执；
 * 只要提示文字的走 `composePrompt` / `composePromptParts`。
 */

// ───────────────────────── 含会话引用：按条目一次组装 ─────────────────────────

/** 取样事实：`sample` 里除块的区间以外的全部。区间要等块拼进提示时才量得出，所以由 `composeContext` 补上。 */
export type SampleFacts = Omit<HandoffSample, "block">;

/** 不是会话引用的条目：原样放进记录，文字由本模块按各自的格式渲染。 */
export interface PlainEntry {
  item: Exclude<ContextItem, SessionContextItem>;
}

/**
 * 一个已经取样、渲染好的会话引用。`include`、`block`、`sample` 出自 context-refs 对 `item` 的同一次渲染，所以不会错配；
 * 块在提示里的位置要等拼接时才知道，由 `composeContext` 量出，补进记录里的 `sample.block`。
 */
export interface SessionEntry {
  /** 合并之后的原输入：规范的 include 与 note，不带 sample。 */
  item: SessionContextItem;
  /** 渲染这一块时用的规范 include；回执里写的也是它。 */
  include: HandoffPart[];
  /** 同一次渲染得到的块文字，逐字进提示。 */
  block: string;
  /** 同一次渲染得到的取样事实。 */
  sample: SampleFacts;
}

/** `composeContext` 的一个条目；数组里的次序就是它在 `context` 里的次序。 */
export type ComposeEntry = PlainEntry | SessionEntry;

/** 会话引用的条目带着渲染好的块，普通条目只有 `item`。 */
export function isSessionEntry(entry: ComposeEntry): entry is SessionEntry {
  return "block" in entry;
}

export interface ComposedContext {
  /** 合成好的完整提示（任务原文 + 全部上下文）：存进 `meta.task.prompt`，也是发给执行端的那一份。 */
  prompt: string;
  /**
   * 要存进 `meta.task.context` 的上下文，与条目同序。会话引用带着取样事实和它的块在 `prompt` 里的区间（`sample.block`）——
   * 页面据此取回“当时交出去的原文”，所以正文只在 `prompt` 里存这一份；其余条目就是传进来的那个对象。
   */
  context: ContextItem[];
  /** 每个会话引用一条，按它们出现的先后；带取样事实，不带块的区间（那是提示里的位置，对回执没有意义）。 */
  receipts: ContextRefReceipt[];
}

/**
 * 含会话引用的委派的组装：每个条目只处理一次，提示、各会话块在提示里的区间、要存的上下文与回执都从同一份条目列表产出，
 * 不再靠相同的数组下标去对齐几张表。会话块要先由调用方取样、渲染好（见 `SessionEntry`）；这里不读任何会话，也不改传进来的条目。
 */
export function composeContext(task: string, entries: readonly ComposeEntry[]): ComposedContext {
  const { prompt, placed } = assemble(task, entries, (entry, index) => (isSessionEntry(entry) ? entry.block : renderItem(entry.item, index)));
  const context: ContextItem[] = [];
  const receipts: ContextRefReceipt[] = [];
  for (const { entry, span } of placed) {
    if (!isSessionEntry(entry)) {
      context.push(entry.item);
      continue;
    }
    context.push({ ...entry.item, sample: { ...entry.sample, block: span } });
    receipts.push({ sessionId: entry.item.sessionId, include: entry.include, ...entry.sample });
  }
  return { prompt, context, receipts };
}

// ───────────────────────── 只要提示文字 ─────────────────────────

/**
 * 只要提示文字的合成。`sessionBlocks` 只在上下文里有 `session` 条目时需要：键是该条目在 `context` 里的下标，值是已经渲染好的那一块文字。
 * 没有 session 条目时这个参数不起作用，输出与加这个参数之前逐字相同。含会话引用的委派还要存记录与回执，走 `composeContext`。
 */
export function composePrompt(
  task: string,
  context: readonly ContextItem[],
  sessionBlocks?: ReadonlyMap<number, string>,
): string {
  return composePromptParts(task, context, sessionBlocks).prompt;
}

export interface ComposedPrompt {
  prompt: string;
  /**
   * 每个 `session` 条目的块在 `prompt` 里占的区间（字符下标，左闭右开），键是条目在 `context` 里的下标。
   * 块与块之间的空行不算在区间里。区间随会话记录一起存下来（`sample.block`），页面据此取回“当时交出去的原文”——
   * 不必把这几万字符再存第二份。
   */
  spans: Map<number, HandoffBlockSpan>;
}

/** 与 `composePrompt` 同一份合成，另外报告每个 session 块的位置；拼接方式与原来完全一致，位置是边拼边量的，不会与正文脱节。 */
export function composePromptParts(
  task: string,
  context: readonly ContextItem[],
  sessionBlocks?: ReadonlyMap<number, string>,
): ComposedPrompt {
  const { prompt, placed } = assemble(task, context, (item, index) => {
    if (item.kind !== "session") return renderItem(item, index);
    // 块要先取样、渲染好再交进来。没有就是调用方漏了一步：宁可抛出，
    // 也不悄悄少一块——少了，下游会话会以为根本没有这份上下文，而回执与页面却说交过了。
    const block = sessionBlocks?.get(index);
    if (block === undefined) throw new Error(`context[${index}] references a session but its block was not rendered`);
    return block;
  });
  const spans = new Map<number, HandoffBlockSpan>();
  placed.forEach(({ entry, span }, index) => {
    if (entry.kind === "session") spans.set(index, span);
  });
  return { prompt, spans };
}

// ───────────────────────── 拼接 ─────────────────────────

interface Placed<E> {
  entry: E;
  /** 这一块在提示里的区间：字符下标，左闭右开，块与块之间的空行不算在内。 */
  span: HandoffBlockSpan;
}

/**
 * 全部拼接只有这一处：任务原文、说明行、各块之间一个空行。每一块的区间在拼的同时量出，与正文出自同一个循环，不会脱节，
 * 并且每个条目带着它自己的区间返回，调用方不必再按下标去配。
 * 下标是 JavaScript 字符串的下标（UTF-16 码元），与 `handedOverText` 用 `slice` 取回时同一口径——
 * 任务、前面的条目或块里有代理对（emoji 等）也不例外，不要改成按码点或字节数。
 */
function assemble<E>(
  task: string,
  entries: readonly E[],
  blockOf: (entry: E, index: number) => string,
): { prompt: string; placed: Placed<E>[] } {
  const text = task.trim();
  const placed: Placed<E>[] = [];
  if (entries.length === 0) return { prompt: text, placed };

  let prompt = `${text}\n\n---\nContext provided with this task:\n\n`;
  entries.forEach((entry, index) => {
    if (index > 0) prompt += "\n\n";
    const block = blockOf(entry, index);
    placed.push({ entry, span: { start: prompt.length, end: prompt.length + block.length } });
    prompt += block;
  });
  return { prompt, placed };
}

/** 普通条目各自的格式；会话引用的块来自取样渲染，不在这里。 */
function renderItem(item: PlainEntry["item"], index: number): string {
  switch (item.kind) {
    case "text":
      return `### ${item.title?.trim() || `Note ${index + 1}`}\n${item.text.trim()}`;
    case "file":
      return `### File: ${item.path}${item.note ? `\n${item.note.trim()}` : ""}`;
    case "snippet": {
      const range =
        item.startLine !== undefined
          ? `:${item.startLine}${item.endLine !== undefined ? `-${item.endLine}` : ""}`
          : "";
      const where = item.path ? `${item.path}${range}` : "Snippet";
      const fence = item.text.includes("```") ? "````" : "```";
      return `### Snippet: ${where}\n${fence}${item.language ?? ""}\n${item.text.replace(/\n+$/, "")}\n${fence}`;
    }
    case "url":
      return `### Link${item.title ? `: ${item.title.trim()}` : ""}\n${item.url}`;
    default: {
      // 以后再加新的种类而忘了这里，类型检查会在这一行报错，而不是运行时悄悄丢掉那一项
      item satisfies never;
      throw new Error(`unsupported context kind: ${JSON.stringify(item)}`);
    }
  }
}
