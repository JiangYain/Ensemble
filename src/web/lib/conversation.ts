/**
 * 会话页（时间线与输入框）用到的纯函数：把事件整理成界面要显示的数字与分组。
 * 这里只做归纳与判断，不编造任何事件里没有的内容；组件拿到结果直接显示。
 */
import type { ReasoningItem, ToolCategory, ToolItem } from "@shared/types";

export type WorkItem = ToolItem | ReasoningItem;

/** 时间线的行类型（与 Timeline.tsx 的 Row.kind 一致）。 */
export type RowKind = "message" | "assistant" | "work" | "plan" | "diagnostic" | "run" | "question";

// ───────────────────────── 工作组 ─────────────────────────

export interface WorkStats {
  /** 工具调用的数量（推理不计入“步骤”）。 */
  tools: number;
  /** 其中失败的数量。 */
  failed: number;
  /** 有步骤还在进行，或推理还在流式输出。 */
  running: boolean;
  /** 从第一个条目开始到最后一个条目最近一次更新的跨度；没有工具调用时不给。 */
  durationMs: number | undefined;
  /** 各类工具的次数，多的在前；次数相同按先出现的在前。 */
  mix: [ToolCategory, number][];
}

/** 一个工作组的汇总。只数事件里确实有的东西。 */
export function workStats(items: readonly WorkItem[]): WorkStats {
  let tools = 0;
  let failed = 0;
  let running = false;
  const counts = new Map<ToolCategory, number>();
  for (const item of items) {
    if (item.type === "tool") {
      tools += 1;
      if (item.status === "failed") failed += 1;
      if (item.status === "running") running = true;
      counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
    } else if (item.streaming) {
      running = true;
    }
  }
  const first = items[0];
  const last = items[items.length - 1];
  const span = first && last && tools > 0 ? Date.parse(last.updatedAt) - Date.parse(first.at) : Number.NaN;
  return {
    tools,
    failed,
    running,
    durationMs: Number.isFinite(span) ? Math.max(0, span) : undefined,
    mix: [...counts.entries()].sort((a, b) => b[1] - a[1]),
  };
}

/**
 * 把“类别 × 次数”换成“动词 × 次数”后再汇总。不同类别可能共用同一个动词（写入与编辑都叫“写入”），
 * 直接按类别列出会出现“写入 3 · 写入 2”；这里按动词合并计数，再按次数从多到少排（次数相同保持先出现的在前）。
 */
export function mixLabels<C extends string>(mix: ReadonlyArray<readonly [C, number]>, label: (category: C) => string): [string, number][] {
  const merged = new Map<string, number>();
  for (const [category, count] of mix) {
    const key = label(category);
    merged.set(key, (merged.get(key) ?? 0) + count);
  }
  return [...merged.entries()].sort((a, b) => b[1] - a[1]);
}

// ───────────────────────── 发言的起点 ─────────────────────────

/**
 * 哪些行是执行端“开口说话”的起点——只有这些行要署名（图标、名字、时刻）。
 *
 * 一段发言 = 紧跟在派发方消息之后、直到下一条派发方消息之前，执行端的全部内容（回复、工作组、计划）。
 * 运行分隔线和诊断提示夹在中间不打断发言，它们本身也不算执行端的发言。
 */
export function turnLeads(kinds: readonly RowKind[]): boolean[] {
  let inTurn = false;
  return kinds.map((kind) => {
    if (kind === "message") {
      inTurn = false;
      return false;
    }
    if (kind === "run" || kind === "diagnostic") return false;
    const lead = !inTurn;
    inTurn = true;
    return lead;
  });
}

// ───────────────────────── 滚动 ─────────────────────────

export interface ScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/** 离底部不到 threshold 像素就算“在底部”：此时新内容到来要继续贴底。 */
export function isNearBottom({ scrollTop, clientHeight, scrollHeight }: ScrollMetrics, threshold: number): boolean {
  return scrollHeight - scrollTop - clientHeight < threshold;
}

// ───────────────────────── 输入框 ─────────────────────────

export interface LimitState {
  /** 已经超过上限，不能发送。 */
  over: boolean;
  /** 接近上限（达到 90%）：开始显示字数，让用户有数。 */
  near: boolean;
}

export function limitState(length: number, max: number): LimitState {
  return { over: length > max, near: length >= Math.floor(max * 0.9) };
}

/**
 * 发送失败后把原文放回输入框。发送时输入框就清空了（用户可以立刻接着写），
 * 失败时如果用户已经写了新的内容，不覆盖它，也不丢掉失败的那条：两段都留下，失败的在前，用空行隔开。
 */
export function restoreDraft(current: string, failed: string): string {
  if (current.trim().length === 0) return failed;
  if (current.includes(failed)) return current;
  return `${failed}\n\n${current}`;
}
