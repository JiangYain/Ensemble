import type { EnsembleEvent } from "@shared/events";
import { replay, type SessionState } from "@shared/projection";
import { buildEntries, splitSlots, type BuildContext, type Entry, type ListView } from "./read-entries";

/**
 * `read` 的增量读取（afterSeq）：只给自上次读取以来新增或变化的条目，并在超出预算时分页。
 * 纯函数、不碰网络。依赖 read-entries.ts 的条目，不依赖 read.ts。
 */

const NOUNS: Record<ListView, { one: string; many: string }> = {
  transcript: { one: "entry", many: "entries" },
  files: { one: "file", many: "files" },
  errors: { one: "error", many: "errors" },
  commands: { one: "command", many: "commands" },
};

function entriesSize(entries: readonly Entry[]): number {
  return entries.reduce((sum, entry) => sum + entry.text.length + 1, 0);
}

function eventSpan(first: number, last: number): string {
  return first >= last ? `event #${last}` : `events #${first}–#${last}`;
}

function markFirstLine(text: string, suffix: string): string {
  const newline = text.indexOf("\n");
  return newline < 0 ? `${text}${suffix}` : `${text.slice(0, newline)}${suffix}${text.slice(newline)}`;
}

/** 条目按 key 记下的文字：只用来判断“同一个 key 的文字变没变”，不留条目本身。 */
function textsOf(entries: readonly Entry[]): Map<string, string> {
  return new Map(entries.map((entry) => [entry.key, entry.text] as const));
}

function changedAgainst(entries: readonly Entry[], base: ReadonlyMap<string, string>): Entry[] {
  return entries.filter((entry) => base.get(entry.key) !== entry.text);
}

/** 事件回放到第 index 个（含）时，这个视角排出来的条目；index 为 -1 就是什么事件都还没有。 */
function entriesThrough(view: ListView, events: readonly EnsembleEvent[], index: number, ctx: BuildContext): Entry[] {
  const slice = events.slice(0, index + 1);
  const at = replay(slice);
  return at ? buildEntries(view, at, slice, ctx) : [];
}

export interface PageInput {
  view: ListView;
  state: SessionState;
  events: readonly EnsembleEvent[];
  ctx: BuildContext;
  afterSeq: number;
  /** 条目部分的字数预算。 */
  budget: number;
  maxChars: number;
}

export interface Page {
  lines: string[];
  /** 下一页从这个事件序号接着读。 */
  cursor: number;
  /** 受预算限制、这一页之后还有几条没给出。 */
  remaining: number;
}

/** 事件回放到第 index 个时排出的条目，以及其中相对 afterSeq 时的基准新增或变化的那部分。 */
interface Probe {
  index: number;
  entries: Entry[];
  changed: Entry[];
}

/**
 * 超出预算时选这一页的终点：最大的事件下标 X，使 afterSeq→X 之间变化的条目排出来放得下（二分）。
 * 二分里每个探测都要回放一次前缀，所以只留放得下的那个最大者，其余用完即弃，不缓存各个中间的投影。
 * 放得下的那一页如果一条都没有（预算放不下“下一件会变的事”），就取第一个有变化的事件——至少交出一条，否则游标原地不动、永远读不完。
 * `whole` 是回放到最后一个事件的探测（也就是“现在”），区间的右端永远是它或某个已确认有变化的探测。
 */
function chooseStop(probeAt: (index: number) => Probe, whole: Probe, firstNew: number, budget: number): Probe {
  const last = whole.index;
  let low = firstNew;
  let high = last - 1;
  let best: Probe | undefined;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const probe = probeAt(middle);
    if (entriesSize(probe.changed) <= budget) {
      best = probe;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const chosen = best ?? probeAt(firstNew);
  if (chosen.changed.length > 0) return chosen;

  let lo = chosen.index + 1;
  let hi = last;
  let found = whole;
  while (lo < hi) {
    const middle = (lo + hi) >> 1;
    const probe = probeAt(middle);
    if (probe.changed.length > 0) {
      found = probe;
      hi = middle;
    } else {
      lo = middle + 1;
    }
  }
  return found;
}

/**
 * “自 afterSeq 以来新增或变化的条目”：把事件回放到 afterSeq 与回放到现在各排一次版，同一个 key 文字不同（或此前没有）的就是新增 / 更新。
 * 所以更早开始、之后才结束的工具会带着最新状态再出现一次，还在流式输出的文字会标明未结束。
 *
 * 超出预算时保留最早的、截掉最晚的，并且游标落在“事件”上而不是“条目”上：找到最大的 X，使得 afterSeq→X 之间的变化排出来放得下，
 * 下一页从 X 接着读。X 之后的变化一条不丢——它们都会出现在“X 到现在”的差异里；同一条目在 X 前后各变一次，则两页各出现一次。
 * 一页都放不下的单条条目也至少交出来，否则游标原地不动、永远读不完。
 *
 * 常驻内存只有两样：afterSeq 时的基准（key → 文字）与被选中的那个终点的探测条目；“还剩几条”也由这个探测条目算出，
 * 不再为它把前缀另回放一遍。
 */
export function pageSince(input: PageInput): Page {
  const { view, state, events, ctx, afterSeq, budget, maxChars } = input;
  const noun = NOUNS[view];
  const latest = state.seq;
  const firstNew = events.findIndex((event) => event.seq > afterSeq);
  if (firstNew < 0) return { lines: [`No new events since #${afterSeq}.`], cursor: latest, remaining: 0 };

  const earlier = textsOf(entriesThrough(view, events, firstNew - 1, ctx));
  const last = events.length - 1;
  const nowEntries = buildEntries(view, state, events, ctx);
  const delta = changedAgainst(nowEntries, earlier);
  const firstSeq = events[firstNew]?.seq ?? afterSeq + 1;

  if (delta.length === 0) {
    return {
      lines: [`No new ${noun.many} since #${afterSeq} (${eventSpan(firstSeq, latest)} arrived, but none of them changes this view).`],
      cursor: latest,
      remaining: 0,
    };
  }

  // 回放到最后一个事件就是“现在”：这个探测不用再回放，直接用上面排好的。
  const whole: Probe = { index: last, entries: nowEntries, changed: delta };
  const probeAt = (index: number): Probe => {
    if (index === last) return whole;
    const entries = entriesThrough(view, events, index, ctx);
    return { index, entries, changed: changedAgainst(entries, earlier) };
  };
  const stop = entriesSize(delta) > budget ? chooseStop(probeAt, whole, firstNew, budget) : whole;

  const cursor = events[stop.index]?.seq ?? latest;
  const remaining = stop.index === last ? 0 : changedAgainst(nowEntries, textsOf(stop.entries)).length;

  const { head, body, foot } = splitSlots(stop.changed);
  const shown = [...head, ...body, ...foot].map((entry) => (earlier.has(entry.key) ? markFirstLine(entry.text, " [updated]") : entry.text));
  // 页脚的说明（“有几个工具没有结束事件”）是背景，不算这个视图里的条目，标题的数字不把它算进去。
  const counted = head.length + body.length;
  const heading =
    counted === 0
      ? `Since #${afterSeq} — nothing new in this view except the note below (${eventSpan(firstSeq, cursor)}):`
      : `Since #${afterSeq} — ${counted} new or updated ${counted === 1 ? noun.one : noun.many} (${eventSpan(firstSeq, cursor)})${view === "errors" ? ", oldest first" : ""}:`;
  const lines = [heading, ...shown];
  if (remaining > 0) lines.push(`(${remaining} more ${remaining === 1 ? noun.one : noun.many} not shown to fit maxChars=${maxChars}.)`);
  return { lines, cursor, remaining };
}
