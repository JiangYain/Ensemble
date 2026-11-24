import { describe, expect, it } from "vitest";
import { clearCorners, ringArcs, shareText, squareRing, squareRingArcs, usageBreakdown, type RingArc } from "./usage";

describe("usageBreakdown", () => {
  it("splits input and output into four non-overlapping parts that add up to the total", () => {
    // 真实运行的量级：缓存占输入的绝大部分，推理占输出的绝大部分。
    const result = usageBreakdown({ inputTokens: 6_300_000, cachedTokens: 6_200_000, outputTokens: 218_000, reasoningTokens: 201_000 });
    expect(result?.parts.map((part) => [part.role, part.tokens, part.remainder])).toEqual([
      ["cached", 6_200_000, false],
      ["input", 100_000, true],
      ["reasoning", 201_000, false],
      ["output", 17_000, true],
    ]);
    expect(result?.total).toBe(6_518_000);
    expect(result?.parts.reduce((sum, part) => sum + part.tokens, 0)).toBe(result?.total);
    expect(result?.parts.reduce((sum, part) => sum + part.share, 0)).toBeCloseTo(1, 10);
  });

  it("keeps input and output whole when there is nothing to split them by", () => {
    const result = usageBreakdown({ inputTokens: 250, outputTokens: 25, cachedTokens: 0 });
    expect(result?.parts.map((part) => [part.role, part.tokens, part.remainder])).toEqual([
      ["input", 250, false],
      ["output", 25, false],
    ]);
  });

  it("drops parts that are empty, such as an input that is entirely cache hits", () => {
    const result = usageBreakdown({ inputTokens: 100, cachedTokens: 100, outputTokens: 10 });
    expect(result?.parts.map((part) => part.role)).toEqual(["cached", "output"]);
  });

  it("declines to draw when the numbers contradict the documented meaning of the fields", () => {
    expect(usageBreakdown({ inputTokens: 100, cachedTokens: 150, outputTokens: 10 })).toBeUndefined();
    expect(usageBreakdown({ inputTokens: 100, outputTokens: 10, reasoningTokens: 11 })).toBeUndefined();
    expect(usageBreakdown({ inputTokens: -1, outputTokens: 10 })).toBeUndefined();
    expect(usageBreakdown({ inputTokens: Number.NaN, outputTokens: 10 })).toBeUndefined();
  });

  it("declines to draw without both input and output, or with nothing to show", () => {
    expect(usageBreakdown({ totalTokens: 500 })).toBeUndefined();
    expect(usageBreakdown({ inputTokens: 500 })).toBeUndefined();
    expect(usageBreakdown({ outputTokens: 500 })).toBeUndefined();
    expect(usageBreakdown({ inputTokens: 0, outputTokens: 0 })).toBeUndefined();
  });
});

describe("ringArcs", () => {
  /** 一周的长度：描边 6、96 见方的方环，中心线是 84 见方，一周 4 × 84。 */
  const C = 4 * 84;
  const options = { gap: 2, minArc: 1.6 };
  const covered = (arcs: ReturnType<typeof ringArcs>, gap: number): number => arcs.filter((arc) => arc.length > 0).reduce((sum, arc) => sum + arc.length + gap, 0);

  it("lays segments end to end around the ring with a gap between each", () => {
    const arcs = ringArcs([0.5, 0.3, 0.2], C, options);
    expect(arcs[0]?.offset).toBe(0);
    expect(arcs[1]?.offset).toBeCloseTo((arcs[0]?.length ?? 0) + 2, 10);
    expect(arcs[2]?.offset).toBeCloseTo((arcs[1]?.offset ?? 0) + (arcs[1]?.length ?? 0) + 2, 10);
    expect(covered(arcs, 2)).toBeCloseTo(C, 8);
  });

  it("draws a single segment as one unbroken ring, with no gap", () => {
    const [only] = ringArcs([1], C, options);
    expect(only?.length).toBeCloseTo(C, 10);
    expect(only?.offset).toBe(0);
  });

  it("keeps very small segments visible and takes the extra length back from the longest one", () => {
    const shares = [0.954, 0.0153, 0.031, 0.0027];
    const arcs = ringArcs(shares, C, options);
    for (const arc of arcs) expect(arc.length).toBeGreaterThanOrEqual(1.6);
    expect(covered(arcs, 2)).toBeCloseTo(C, 8);
    // 大的几段仍然按比例，只有被抬到最小长度的那段偏离。
    const available = C - 4 * 2;
    expect(arcs[1]?.length).toBeCloseTo(0.0153 * available, 8);
    expect(arcs[3]?.length).toBe(1.6);
    expect(arcs[0]?.length).toBeLessThan(0.954 * available);
  });

  it("gives empty segments no length and does not let them move the others", () => {
    const arcs = ringArcs([0.6, 0, 0.4], C, options);
    expect(arcs[1]).toEqual({ length: 0, offset: expect.any(Number) });
    expect(arcs[2]?.offset).toBeCloseTo((arcs[0]?.length ?? 0) + 2, 10);
    expect(covered(arcs, 2)).toBeCloseTo(C, 8);
  });

  it("returns nothing to draw when every share is zero", () => {
    expect(ringArcs([0, 0], C, options)).toEqual([
      { length: 0, offset: 0 },
      { length: 0, offset: 0 },
    ]);
  });
});

/** 把路径（只有 M / H / V）逐条走一遍：量出走了多远，并记下每个顶点的坐标与离起点的路径距离。 */
function walkPath(d: string): { length: number; vertices: Array<{ x: number; y: number; at: number }> } {
  const vertices: Array<{ x: number; y: number; at: number }> = [];
  let x = 0;
  let y = 0;
  let at = 0;
  for (const match of d.matchAll(/([MHV])\s*(-?[\d.]+)(?:\s+(-?[\d.]+))?/g)) {
    const command = match[1]!;
    const first = Number(match[2]);
    if (command === "M") {
      x = first;
      y = Number(match[3]);
    } else if (command === "H") {
      at += Math.abs(first - x);
      x = first;
    } else {
      at += Math.abs(first - y);
      y = first;
    }
    vertices.push({ x, y, at });
  }
  return { length: at, vertices };
}

describe("squareRing", () => {
  const ring = squareRing(96, 6);

  it("is one lap that starts in the middle of the top edge, runs clockwise, and uses nothing but M / H / V", () => {
    expect(ring.d).toBe("M48 6 H90 V90 H6 V6 H48");
    expect(ring.d.match(/[A-Za-z]/g)).toEqual(["M", "H", "V", "H", "V", "H"]);
  });

  it("is as long as its four sides, and its corners are exactly where the path turns", () => {
    const walked = walkPath(ring.d);
    expect(ring.length).toBe(336);
    expect(walked.length).toBe(ring.length);
    // 起点之后、回到起点之前的四个顶点就是拐角：右上 → 右下 → 左下 → 左上。
    expect(walked.vertices.slice(1, -1).map(({ x, y, at }) => [x, y, at])).toEqual([
      [90, 6, 42],
      [90, 90, 126],
      [6, 90, 210],
      [6, 6, 294],
    ]);
    expect(ring.corners).toEqual([42, 126, 210, 294]);
  });

  it("keeps the whole stroke inside the canvas and leaves a 78px box in the middle", () => {
    const numbers = ring.d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    const low = Math.min(...numbers);
    const high = Math.max(...numbers);
    expect(low - ring.stroke / 2).toBeGreaterThanOrEqual(0);
    expect(high + ring.stroke / 2).toBeLessThanOrEqual(96);
    expect(high - low - ring.stroke).toBe(78);
  });

  it("takes any canvas and stroke", () => {
    const other = squareRing(100, 4);
    expect(other.d).toBe("M50 4 H96 V96 H4 V4 H50");
    expect(other.length).toBe(368);
    expect(other.corners).toEqual([46, 138, 230, 322]);
    expect(walkPath(other.d).length).toBe(other.length);
  });
});

describe("clearCorners", () => {
  const ring = squareRing(96, 6); // 拐角在 42 / 126 / 210 / 294，描边半宽 3
  const options = { minArc: 1.6 };
  /** 两段首尾相接，中间隔一个 2px 的缺口。 */
  const pair = (first: number, second: number): RingArc[] => [
    { offset: 0, length: first },
    { offset: first + 2, length: second },
  ];

  it("leaves gaps that are clear of every corner as they are", () => {
    const arcs: RingArc[] = [
      { offset: 0, length: 100 },
      { offset: 102, length: 100 },
      { offset: 204, length: 100 },
    ];
    const result = clearCorners(arcs, ring, options);
    expect(result).toEqual(arcs);
    expect(result).not.toBe(arcs);
  });

  it("moves a gap that sits on a corner to the nearer clean side, keeping its width, and leaves its input alone", () => {
    const arcs = pair(40, 100); // 缺口 [40, 42] 压着拐角 42
    const [first, second] = clearCorners(arcs, ring, options);
    // 干净的位置：缺口结束于拐角前 3（起点 37），或开始于拐角后 3（起点 45）；40 离 37 更近。
    expect(first).toEqual({ offset: 0, length: 37 });
    expect(second).toEqual({ offset: 39, length: 103 });
    expect(arcs).toEqual(pair(40, 100));
  });

  it("pushes it past the corner when that side is nearer", () => {
    const [first, second] = clearCorners(pair(44, 100), ring, options); // 缺口 [44, 46]
    expect(first).toEqual({ offset: 0, length: 45 });
    expect(second).toEqual({ offset: 47, length: 99 });
  });

  it("leaves a gap alone when it already ends right at, or starts right at, the clean edge of a corner", () => {
    expect(clearCorners(pair(37, 100), ring, options)).toEqual(pair(37, 100)); // [37, 39]：结束于拐角前 3
    expect(clearCorners(pair(45, 100), ring, options)).toEqual(pair(45, 100)); // [45, 47]：开始于拐角后 3
  });

  it("takes the other side when the nearer one would leave a segment shorter than the minimum", () => {
    const arcs: RingArc[] = [
      { offset: 36, length: 3.5 },
      { offset: 41.5, length: 100 },
    ];
    // 离得近的是 37，可那样第一段只剩 1px；改去 45。
    expect(clearCorners(arcs, ring, options)).toEqual([
      { offset: 36, length: 9 },
      { offset: 47, length: 94.5 },
    ]);
  });

  it("leaves the gap where it is when neither side keeps both segments at the minimum", () => {
    const arcs: RingArc[] = [
      { offset: 36, length: 3.5 },
      { offset: 41.5, length: 4 },
    ];
    expect(clearCorners(arcs, ring, options)).toEqual(arcs);
  });

  it("does not move the end of the last segment, even when it stops right at a corner", () => {
    // 第二段止于 292，在拐角 294 的范围里；它后面的缺口夹着起点，不是“相邻两段之间”的缺口。
    const arcs: RingArc[] = [
      { offset: 0, length: 100 },
      { offset: 102, length: 190 },
    ];
    expect(clearCorners(arcs, ring, options)).toEqual(arcs);
  });

  it("skips empty segments, and handles gaps next to different corners one after another", () => {
    const withEmpty: RingArc[] = [
      { offset: 0, length: 40 },
      { offset: 42, length: 0 },
      { offset: 42, length: 100 },
    ];
    expect(clearCorners(withEmpty, ring, options)).toEqual([
      { offset: 0, length: 37 },
      { offset: 42, length: 0 },
      { offset: 39, length: 103 },
    ]);
    // 中间那一段两头的缺口各压着一个拐角：前端先挪到 39（加长），后端再挪到 121（缩短），净长不变。
    const chained: RingArc[] = [
      { offset: 0, length: 40 },
      { offset: 42, length: 82 },
      { offset: 126, length: 100 },
    ];
    expect(clearCorners(chained, ring, options)).toEqual([
      { offset: 0, length: 37 },
      { offset: 39, length: 82 },
      { offset: 123, length: 103 },
    ]);
  });
});

describe("squareRingArcs", () => {
  const ring = squareRing(96, 6);
  const options = { gap: 2, minArc: 1.6 };

  it("is plain ringArcs when no gap lands on a corner", () => {
    expect(squareRingArcs([0.5, 0.3, 0.2], ring, options)).toEqual(ringArcs([0.5, 0.3, 0.2], ring.length, options));
    expect(squareRingArcs([1], ring, options)).toEqual([{ length: 336, offset: 0 }]);
  });

  it("moves a gap that would have landed on a corner, and keeps the lap whole", () => {
    // 13% 的一段：按比例缺口起点在 43.16，压着右上角（42）。
    const plain = ringArcs([0.13, 0.87], ring.length, options);
    const [first, second] = squareRingArcs([0.13, 0.87], ring, options);
    expect(plain[0]?.length).toBeCloseTo(43.16, 9);
    expect(first?.offset).toBe(0);
    expect(first?.length).toBeCloseTo(45, 9);
    expect(second?.offset).toBeCloseTo(47, 9);
    expect((second?.offset ?? 0) - ((first?.offset ?? 0) + (first?.length ?? 0))).toBeCloseTo(2, 9);
    // 后一段的末端没动，所以一周的总长不变。
    expect((second?.offset ?? 0) + (second?.length ?? 0)).toBeCloseTo((plain[1]?.offset ?? 0) + (plain[1]?.length ?? 0), 9);
  });

  /** 一种切法里的毛病：缺口压着拐角、段短于最小长度、一周的总长不对、或某个边界比纯按比例的位置挪得太远（4px）。 */
  const problemsOf = (shares: number[]): string[] => {
    const arcs = squareRingArcs(shares, ring, options);
    const plain = ringArcs(shares, ring.length, options);
    const problems: string[] = [];
    const visible = arcs.filter((arc) => arc.length > 0);
    visible.forEach((arc, index) => {
      if (arc.length < options.minArc - 1e-9) problems.push(`${shares}: segment ${index} is only ${arc.length} long`);
      const next = visible[index + 1];
      if (!next) return;
      for (const corner of ring.corners) {
        if (arc.offset + arc.length < corner + 3 - 1e-9 && next.offset > corner - 3 + 1e-9) {
          problems.push(`${shares}: the gap [${arc.offset + arc.length}, ${next.offset}] is on corner ${corner}`);
        }
      }
    });
    const lap = visible.reduce((sum, arc) => sum + arc.length + options.gap, 0);
    if (Math.abs(lap - ring.length) > 1e-6) problems.push(`${shares}: the lap is ${lap} long`);
    arcs.forEach((arc, index) => {
      const was = plain[index]!;
      const start = Math.abs(arc.offset - was.offset);
      const end = Math.abs(arc.offset + arc.length - (was.offset + was.length));
      if (start > 4 + 1e-9 || end > 4 + 1e-9) problems.push(`${shares}: segment ${index} moved ${Math.max(start, end)}`);
    });
    return problems;
  };

  it("never leaves a gap on a corner, never shortens a segment below the minimum, and never moves a boundary more than 4px, across many splits", () => {
    const problems: string[] = [];
    let total = 0;
    let moved = 0;
    const consider = (shares: number[]): void => {
      total++;
      problems.push(...problemsOf(shares));
      if (JSON.stringify(squareRingArcs(shares, ring, options)) !== JSON.stringify(ringArcs(shares, ring.length, options))) moved++;
    };
    for (let percent = 5; percent <= 95; percent += 0.5) consider([percent / 100, 1 - percent / 100]);
    for (let a = 10; a <= 80; a += 5) {
      for (let b = 10; a + b <= 90; b += 5) consider([a / 100, b / 100, 1 - a / 100 - b / 100]);
    }
    expect(problems).toEqual([]);
    // 不是空转：这些切法里确有缺口落在拐角上、被挪开了，也确有没落在拐角上、原样保留的。
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan(total);
  });
});

describe("shareText", () => {
  it("scales its precision with the size of the share", () => {
    expect(shareText(0.954)).toBe("95%");
    expect(shareText(0.1)).toBe("10%");
    expect(shareText(0.031)).toBe("3.1%");
    expect(shareText(0.0026)).toBe("0.3%");
    expect(shareText(0.0004)).toBe("<0.1%");
  });
});
