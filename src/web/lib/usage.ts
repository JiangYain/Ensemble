import type { Usage } from "@shared/types";

/** 环上的一段。顺序即顺时针顺序：缓存命中 → 输入（其余） → 推理 → 输出（其余）。 */
export type UsageRole = "cached" | "input" | "reasoning" | "output";

export interface UsagePart {
  role: UsageRole;
  tokens: number;
  /** 占总量的比例，0–1。 */
  share: number;
  /** 这一段是父项扣掉子项之后的“其余”（例如输入里没命中缓存的那部分），界面据此换一个更准确的名字。 */
  remainder: boolean;
}

export interface UsageBreakdown {
  total: number;
  parts: UsagePart[];
}

/**
 * 把用量拆成互不重叠的几段，供环形图使用。
 *
 * 前提是 `Usage` 的口径（见 shared/types）：缓存 ⊂ 输入，推理 ⊂ 输出。
 * 缺少输入或输出、总量为 0、或数据违反这个前提（缓存比输入还多、推理比输出还多）时返回 undefined，
 * 调用方应退回逐项列表，而不是硬画一个会误导人的环。
 */
export function usageBreakdown(usage: Usage): UsageBreakdown | undefined {
  const { inputTokens: input, outputTokens: output } = usage;
  if (input === undefined || output === undefined) return undefined;
  const cached = usage.cachedTokens ?? 0;
  const reasoning = usage.reasoningTokens ?? 0;
  const values = [input, output, cached, reasoning];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return undefined;
  if (cached > input || reasoning > output) return undefined;
  const total = input + output;
  if (total <= 0) return undefined;

  const entries: Array<Omit<UsagePart, "share">> = [
    { role: "cached", tokens: cached, remainder: false },
    { role: "input", tokens: input - cached, remainder: cached > 0 },
    { role: "reasoning", tokens: reasoning, remainder: false },
    { role: "output", tokens: output - reasoning, remainder: reasoning > 0 },
  ];
  const parts = entries.filter((entry) => entry.tokens > 0).map((entry) => ({ ...entry, share: entry.tokens / total }));
  return { total, parts };
}

export interface RingArc {
  /** 这一段可见部分的长度（沿描边中心线，px）。 */
  length: number;
  /** 这一段起点离环的起点（上边中点，12 点钟）的距离（沿描边中心线，px）。 */
  offset: number;
}

/**
 * 把各段占比换算成沿环一周的长度；`perimeter` 是描边中心线走一周的总长。
 * - 相邻两段之间留 `gap` 的缺口（只有一段时不留）。
 * - 占比再小的段也至少画 `minArc`，否则 0.2% 的一段会小到看不见；多画出来的长度从最长的一段里扣回，一周的总长不变。
 * 精确数字永远在图例和悬停提示里，环只负责比例的直觉。
 */
export function ringArcs(shares: readonly number[], perimeter: number, options: { gap: number; minArc: number }): RingArc[] {
  const visible = shares.filter((share) => share > 0).length;
  if (visible === 0) return shares.map(() => ({ length: 0, offset: 0 }));
  const gap = visible > 1 ? options.gap : 0;
  const available = perimeter - visible * gap;
  const lengths = shares.map((share) => (share > 0 ? Math.max(share * available, options.minArc) : 0));

  const excess = lengths.reduce((sum, length) => sum + length, 0) - available;
  if (excess > 0) {
    let longest = 0;
    lengths.forEach((length, index) => {
      if (length > (lengths[longest] ?? 0)) longest = index;
    });
    lengths[longest] = Math.max((lengths[longest] ?? 0) - excess, options.minArc);
  }

  let cursor = 0;
  return lengths.map((length) => {
    const arc = { length, offset: cursor };
    if (length > 0) cursor += length + gap;
    return arc;
  });
}

export interface SquareRing {
  /** 描边中心线的路径数据：从上边中点出发、顺时针走一周，只含 M / H / V。 */
  d: string;
  /** 中心线走一周的总长（px），也就是 ringArcs 的 `perimeter`。 */
  length: number;
  /** 四个拐角（右上、右下、左下、左上）离起点的路径距离（px），升序。 */
  corners: readonly number[];
  /** 描边宽度（px）。 */
  stroke: number;
}

/**
 * 方环的路径。中心线离画布边缘 `stroke`，所以描边的外沿离边缘 `stroke / 2`，整圈都在 `size` 见方的画布里，
 * 内框是 `size - 3 * stroke` 见方（96 / 6：中心线 6 到 90，外沿 3 到 93，内框 78 见方）。
 * 起点在上边中点（12 点钟），顺时针；起点不在拐角上，所以第一段的头和最后一个缺口都落在直边上。
 * 段与段之间的缺口靠 stroke-dasharray 留在这条路径上，距离都是沿这条中心线量的，与 ringArcs 的口径一致。
 */
export function squareRing(size: number, stroke: number): SquareRing {
  const near = stroke;
  const far = size - stroke;
  const mid = size / 2;
  const side = far - near;
  const toFirstCorner = far - mid;
  return {
    d: `M${mid} ${near} H${far} V${far} H${near} V${near} H${mid}`,
    length: 4 * side,
    corners: [0, 1, 2, 3].map((index) => toFirstCorner + index * side),
    stroke,
  };
}

/**
 * 把落在拐角上的缺口挪开。
 * 虚线的端面垂直于它所在的那条边：缺口跨过拐角时，前后两段各被截一刀，外角上会缺一块，看上去像拐角被削掉了。
 * 缺口整个落在拐角处描边的外面——结束于拐角前 `stroke / 2`，或开始于拐角后 `stroke / 2`——才是干净的一刀，缺口的宽度不变。
 * 所以起点落在 (拐角 − stroke / 2 − 缺口宽度, 拐角 + stroke / 2) 里的缺口，挪到这个范围两端中较近的一端：
 * 前一段缩短、后一段加长同样的量，两段各自的另一头不动；挪完有一段短于 `minArc` 就改挪另一端，两端都不行就保持原样。
 * 最远挪 `stroke / 2` 加半个缺口宽度（6 / 2 + 1 = 4px，约一周的 1.2%）；精确比例在图例与悬停提示里，环只负责直觉。
 * 只处理相邻两段之间的缺口：最后一段与第一段之间的那个缺口夹着起点（上边中点），离所有拐角都远。
 */
export function clearCorners(arcs: readonly RingArc[], ring: Pick<SquareRing, "corners" | "stroke">, options: { minArc: number }): RingArc[] {
  const result = arcs.map((arc) => ({ ...arc }));
  const reach = ring.stroke / 2;
  const visible = result.filter((arc) => arc.length > 0);
  visible.forEach((before, index) => {
    const after = visible[index + 1];
    if (!after) return;
    const start = before.offset + before.length;
    const gap = after.offset - start;
    const corner = ring.corners.find((at) => start < at + reach && after.offset > at - reach);
    if (corner === undefined) return;
    const end = after.offset + after.length;
    const target = [corner - reach - gap, corner + reach]
      .sort((a, b) => Math.abs(a - start) - Math.abs(b - start))
      .find((at) => at - before.offset >= options.minArc && end - (at + gap) >= options.minArc);
    if (target === undefined) return;
    before.length = target - before.offset;
    after.offset = target + gap;
    after.length = end - after.offset;
  });
  return result;
}

/** 方环上每一段的长度与起点：先按周长切段，再把落在拐角上的缺口挪开。 */
export function squareRingArcs(shares: readonly number[], ring: SquareRing, options: { gap: number; minArc: number }): RingArc[] {
  return clearCorners(ringArcs(shares, ring.length, options), ring, options);
}

/** 占比文字：不足 0.1% 写“<0.1%”，不足 10% 保留一位小数，其余取整。 */
export function shareText(share: number): string {
  if (share < 0.001) return "<0.1%";
  const percent = share * 100;
  return percent < 10 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`;
}
