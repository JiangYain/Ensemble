import { describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@shared/types";
import { layoutScene, type SceneLayout } from "./layout";
import {
  chooseSide,
  copyCurve,
  createPipeElements,
  Curve,
  curvePath,
  DOWN,
  ease,
  gapOf,
  LEFT,
  mixCurve,
  opposite,
  pinCurve,
  pipePath,
  portX,
  portY,
  RIGHT,
  ROUTE,
  routeCurve,
  sameCurve,
  setPipe,
  setPipeFlow,
  UP,
  type PipeBox,
  type Point,
  type Side,
} from "./pipes";

const box = (x: number, y: number, w = 212, h = 112): PipeBox => ({ x, y, w, h });

const fmt = (value: number): string => (Math.round(value * 100) / 100).toString();

/** 本次改动之前的、从左到右的连线算法，原样抄在这里：默认布局里的每一条连线都必须与它逐字节相同。 */
function legacyForward(a: Point, b: Point): string {
  const handle = (b.x - a.x) / 2;
  return `M${fmt(a.x)} ${fmt(a.y)}C${fmt(a.x + handle)} ${fmt(a.y)} ${fmt(b.x - handle)} ${fmt(b.y)} ${fmt(b.x)} ${fmt(b.y)}`;
}

/** 固定种子的伪随机：测试可复现。 */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pointAt = (c: Curve, t: number): Point => {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const d = 3 * u * t * t;
  const e = t * t * t;
  return { x: a * c.x0 + b * c.x1 + d * c.x2 + e * c.x3, y: a * c.y0 + b * c.y1 + d * c.y2 + e * c.y3 };
};

const lengthOf = (c: Curve, steps = 400): number => {
  let total = 0;
  let last = pointAt(c, 0);
  for (let i = 1; i <= steps; i++) {
    const next = pointAt(c, i / steps);
    total += Math.hypot(next.x - last.x, next.y - last.y);
    last = next;
  }
  return total;
};

const numbersOf = (path: string): number[] => (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

const route = (s: PipeBox, t: PipeBox, side: Side): Curve => routeCurve(s, t, side, new Curve());

describe("pipePath · 水平的 S 形", () => {
  it("向右：与改动之前逐字节相同（默认布局的连线）", () => {
    expect(pipePath({ x: 100, y: 80 }, { x: 240, y: 160 })).toBe("M100 80C170 80 170 160 240 160");
    // 来源卡的出口 (212, 86) 到会话卡的入口 (310, 86)：默认布局里最常见的一条。
    expect(pipePath({ x: 212, y: 86 }, { x: 310, y: 86 })).toBe("M212 86C261 86 261 86 310 86");
    const next = random(7);
    for (let i = 0; i < 500; i++) {
      const a = { x: next() * 2000 - 1000, y: next() * 2000 - 1000 };
      const b = { x: a.x + 0.001 + next() * 1500, y: next() * 2000 - 1000 };
      expect(pipePath(a, b)).toBe(legacyForward(a, b));
    }
  });

  it("向左：是向右的左右镜像，平滑的 S 形，不再绕环", () => {
    expect(pipePath({ x: 300, y: 80 }, { x: 100, y: 80 })).toBe("M300 80C200 80 200 80 100 80");
    expect(pipePath({ x: 300, y: 40 }, { x: 100, y: 320 })).toBe("M300 40C200 40 200 320 100 320");
    const next = random(11);
    for (let i = 0; i < 200; i++) {
      const a = { x: next() * 1600 - 800, y: next() * 1600 - 800 };
      const b = { x: a.x - 0.01 - next() * 1200, y: next() * 1600 - 800 };
      const mirrored = legacyForward({ x: -a.x, y: a.y }, { x: -b.x, y: b.y });
      const expected = numbersOf(mirrored).map((value, index) => (index % 2 === 0 ? -value : value));
      const actual = numbersOf(pipePath(a, b));
      expect(actual.length).toBe(expected.length);
      actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 2));
      expect(pipePath(a, b)).toMatch(/^M/);
      expect((pipePath(a, b).match(/C/g) ?? []).length).toBe(1);
    }
  });

  it("水平方向上单调（落在两端之间的竖带里），不会绕到两端的后面", () => {
    for (const [a, b] of [
      [{ x: 300, y: 80 }, { x: 100, y: 200 }],
      [{ x: 100, y: 80 }, { x: 300, y: -400 }],
      [{ x: 0, y: 0 }, { x: -26, y: 900 }],
    ] as const) {
      const curve = new Curve();
      const dx = b.x - a.x;
      const handle = Math.abs(dx) / 2;
      const sign = dx < 0 ? -1 : 1;
      Object.assign(curve, { x0: a.x, y0: a.y, x1: a.x + sign * handle, y1: a.y, x2: b.x - sign * handle, y2: b.y, x3: b.x, y3: b.y });
      expect(pipePath(a, b)).toBe(curvePath(curve));
      let last: number = a.x;
      for (let i = 1; i <= 100; i++) {
        const x = pointAt(curve, i / 100).x;
        expect(sign * (x - last)).toBeGreaterThanOrEqual(-1e-9);
        last = x;
      }
    }
  });

  it("距离为 0、很远、点重合时仍给出有效的路径", () => {
    expect(pipePath({ x: 50, y: 0 }, { x: 50, y: 90 })).toBe("M50 0C50 0 50 90 50 90");
    expect(pipePath({ x: 7, y: 7 }, { x: 7, y: 7 })).toBe("M7 7C7 7 7 7 7 7");
    for (const path of [pipePath({ x: -1e9, y: 0 }, { x: 1e9, y: 5e8 }), pipePath({ x: 1e9, y: 0 }, { x: -1e9, y: -5e8 })]) {
      expect(path).not.toMatch(/NaN|Infinity/);
    }
  });
});

describe("chooseSide · 选边与滞回", () => {
  const s = box(0, 0);
  const SIDES: Side[] = [RIGHT, DOWN, LEFT, UP];

  it("目标在右边：走 RIGHT；默认布局里最窄的空隙（28）也在这一档，不论上一次走的是哪一边", () => {
    for (const prev of [-1, RIGHT, DOWN, LEFT, UP]) {
      expect(chooseSide(prev, s, box(240, 0)), `prev ${prev}`).toBe(RIGHT);
      expect(chooseSide(prev, s, box(304, 0)), `prev ${prev}`).toBe(RIGHT);
      expect(chooseSide(prev, s, box(304, 900)), `prev ${prev}`).toBe(RIGHT);
      expect(chooseSide(prev, s, box(304, -900)), `prev ${prev}`).toBe(RIGHT);
    }
    expect(212 + ROUTE.enterSide).toBeLessThan(240);
  });

  it("目标在左边：走 LEFT，出线在来源的左缘、进线在目标的右缘", () => {
    for (const prev of [-1, RIGHT, DOWN, LEFT, UP]) {
      expect(chooseSide(prev, s, box(-304, 0)), `prev ${prev}`).toBe(LEFT);
      expect(chooseSide(prev, s, box(-304, 40)), `prev ${prev}`).toBe(LEFT);
    }
  });

  it("目标在正上方 / 正下方（水平范围重叠）：走 UP / DOWN，横向有空隙时横向优先", () => {
    expect(chooseSide(-1, s, box(20, 200))).toBe(DOWN);
    expect(chooseSide(-1, s, box(-20, -200))).toBe(UP);
    expect(chooseSide(-1, s, box(0, 112 + ROUTE.enterStack))).toBe(DOWN);
    expect(chooseSide(-1, s, box(0, -112 - ROUTE.enterStack))).toBe(UP);
    // 目标虽然在很下面，但水平上已经让开了足够的空隙：照走横向。
    expect(chooseSide(-1, s, box(212 + ROUTE.enterSide, 600))).toBe(RIGHT);
    expect(chooseSide(-1, s, box(-212 - ROUTE.enterSide, 600))).toBe(LEFT);
  });

  it("横向的进入门槛与离开门槛不同：RIGHT 要空隙收窄到 6 以下才放弃，回来要宽到 24 才算", () => {
    // 目标在下方（竖向空隙 38，够走 DOWN），水平空隙 g 是变量。
    const at = (g: number): PipeBox => box(212 + g, 150);
    expect(chooseSide(-1, s, at(ROUTE.enterSide))).toBe(RIGHT);
    expect(chooseSide(-1, s, at(ROUTE.enterSide - 0.01))).toBe(DOWN);
    expect(chooseSide(RIGHT, s, at(ROUTE.leaveSide))).toBe(RIGHT);
    expect(chooseSide(RIGHT, s, at(ROUTE.leaveSide - 0.01))).toBe(DOWN);
    expect(chooseSide(DOWN, s, at(ROUTE.enterSide - 0.01))).toBe(DOWN);
    expect(chooseSide(DOWN, s, at(ROUTE.enterSide))).toBe(RIGHT);
    // 向左同理。
    const left = (g: number): PipeBox => box(-212 - g, 150);
    expect(chooseSide(LEFT, s, left(ROUTE.leaveSide))).toBe(LEFT);
    expect(chooseSide(LEFT, s, left(ROUTE.leaveSide - 0.01))).toBe(DOWN);
    expect(chooseSide(DOWN, s, left(ROUTE.enterSide - 0.01))).toBe(DOWN);
    expect(chooseSide(DOWN, s, left(ROUTE.enterSide))).toBe(LEFT);
  });

  it("纵向同样有两个门槛：DOWN / UP 要竖向空隙收窄到 4 以下才放弃，到 16 才会进入", () => {
    // 目标在右下方，横向空隙 20（比 6 宽、比 24 窄：横向不够格，也不会被放弃）；竖向空隙 v 是变量。
    const at = (v: number): PipeBox => box(232, 112 + v);
    expect(chooseSide(-1, s, at(ROUTE.enterStack))).toBe(DOWN);
    expect(chooseSide(-1, s, at(ROUTE.enterStack - 0.01))).toBe(RIGHT); // 竖向不够 16：退到“空隙最大的”，横向 20 更大
    expect(chooseSide(RIGHT, s, at(ROUTE.enterStack))).toBe(RIGHT); // 横向 20 ≥ 6：已经在走的 RIGHT 不放手
    expect(chooseSide(DOWN, s, at(ROUTE.leaveStack))).toBe(DOWN);
    expect(chooseSide(DOWN, s, at(ROUTE.leaveStack - 0.01))).toBe(RIGHT);
    expect(chooseSide(DOWN, s, at(ROUTE.enterStack - 0.01))).toBe(DOWN); // 回程：还没到 4，不翻
    const above = (v: number): PipeBox => box(232, -112 - v);
    expect(chooseSide(-1, s, above(ROUTE.enterStack))).toBe(UP);
    expect(chooseSide(-1, s, above(ROUTE.enterStack - 0.01))).toBe(RIGHT);
    expect(chooseSide(RIGHT, s, above(ROUTE.enterStack))).toBe(RIGHT);
    expect(chooseSide(UP, s, above(ROUTE.leaveStack))).toBe(UP);
    expect(chooseSide(UP, s, above(ROUTE.leaveStack - 0.01))).toBe(RIGHT);
    expect(chooseSide(UP, s, above(ROUTE.enterStack - 0.01))).toBe(UP);
  });

  it("沿水平方向来回扫过门槛：来回的切换点不同，停在门槛附近抖动不会来回翻", () => {
    // 目标在下方：从右向左，RIGHT → DOWN 发生在水平空隙 < 6（t.x < 218），再向左到空隙 ≥ 24（t.x ≤ -236）才变成 LEFT。
    const sweep = (xs: number[], first: number): number[] => {
      const sides: number[] = [];
      let prev = first;
      for (const x of xs) sides.push((prev = chooseSide(prev, s, box(x, 150))));
      return sides;
    };
    const range = (from: number, to: number): number[] => Array.from({ length: Math.abs(to - from) + 1 }, (_, i) => from + Math.sign(to - from) * i);

    const leftward = range(600, -600);
    const out = sweep(leftward, -1);
    const flipsAt = (xs: number[], sides: number[]): number[] => xs.filter((_, i) => i > 0 && sides[i] !== sides[i - 1]);
    expect(flipsAt(leftward, out)).toEqual([217, -236]);
    expect(out[0]).toBe(RIGHT);
    expect(out.at(-1)).toBe(LEFT);

    const rightward = range(-600, 600);
    const back = sweep(rightward, LEFT);
    // 回程：LEFT → DOWN 在 t.x = -217（左空隙 5 < 6），DOWN → RIGHT 在 t.x = 236（右空隙 24）。
    expect(flipsAt(rightward, back)).toEqual([-217, 236]);

    // 从右边过来，在 RIGHT → DOWN 的切换点（217 / 218）附近来回抖动：只翻一次。
    const near = sweep([600, 230, 219, 216, 221, 217, 224, 215, 226, 218, 214, 223, 217.5, 218.5], -1);
    expect(near.slice(0, 3)).toEqual([RIGHT, RIGHT, RIGHT]);
    expect(near.filter((side, i) => i > 0 && side !== near[i - 1]).length).toBe(1);
    expect(near.at(-1)).toBe(DOWN);
    // 从下方过来，在 DOWN → RIGHT 的切换点（236）附近来回抖动：同样只翻一次。
    const far = sweep([100, 230, 237, 235, 238, 234, 240, 233, 236, 232, 239, 235.5, 236.5], -1);
    expect(far.slice(0, 2)).toEqual([DOWN, DOWN]);
    expect(far.filter((side, i) => i > 0 && side !== far[i - 1]).length).toBe(1);
    expect(far.at(-1)).toBe(RIGHT);
  });

  it("两个节点叠在一起（四个方向都没有空隙）：保持上一次的走法；第一次走 RIGHT", () => {
    const over = box(60, 30);
    expect(chooseSide(-1, s, over)).toBe(RIGHT);
    for (const prev of SIDES) expect(chooseSide(prev, s, over), `prev ${prev}`).toBe(prev);
    expect(chooseSide(DOWN, s, box(0, 0))).toBe(DOWN);
    expect(chooseSide(-1, s, box(0, 0))).toBe(RIGHT);
  });

  it("没有哪一档够宽时，取空隙最大的方向（横向并列时优先）", () => {
    // 右空隙 10、下空隙 30（够 16）→ 下；右空隙 10、下空隙 10 → 右（横向优先）；全为正但都不够 → 取最大的。
    expect(chooseSide(-1, s, box(222, 142))).toBe(DOWN);
    expect(chooseSide(-1, s, box(222, 122))).toBe(RIGHT);
    expect(chooseSide(-1, s, box(-215, -120))).toBe(UP); // 左空隙 3、上空隙 8：都不够格，取大的
    expect(chooseSide(-1, s, box(-230, -105))).toBe(LEFT); // 左空隙 18、上空隙 -7
  });

  it("位置不是有限的数时保持原样，不抛错", () => {
    const bad = box(Number.NaN, 0);
    expect(chooseSide(LEFT, s, bad)).toBe(LEFT);
    expect(chooseSide(UP, bad, s)).toBe(UP);
    expect(chooseSide(-1, s, bad)).toBe(RIGHT);
    expect(chooseSide(DOWN, s, box(Infinity, 0))).toBe(DOWN);
  });
});

describe("routeCurve · 端点、方向与不穿过节点", () => {
  const s = box(0, 30);

  it("RIGHT：与改动之前逐字节相同（出线在来源右缘、进线在目标左缘）", () => {
    const t = box(310, 14, 248, 144);
    const curve = route(s, t, RIGHT);
    expect(curvePath(curve)).toBe("M212 86C261 86 261 86 310 86");
    expect(curvePath(curve)).toBe(legacyForward({ x: 0 + 212, y: 30 + 56 }, { x: 310, y: 14 + 72 }));
  });

  it("LEFT：左右镜像——出线在来源左缘、进线在目标右缘，与 pipePath 的向左一致", () => {
    const t = box(-304, 100);
    const curve = route(s, t, LEFT);
    expect({ x: curve.x0, y: curve.y0 }).toEqual({ x: 0, y: 86 });
    expect({ x: curve.x3, y: curve.y3 }).toEqual({ x: -304 + 212, y: 100 + 56 });
    expect(curvePath(curve)).toBe(pipePath({ x: 0, y: 86 }, { x: -92, y: 156 }));
    // 镜像：把来源和目标都沿竖线翻过去，向左的曲线就是向右的曲线。
    const mirrored = route(box(-212, 30), box(92, 100), RIGHT);
    expect(curve.x1 - curve.x0).toBeCloseTo(-(mirrored.x1 - mirrored.x0));
    expect(curve.x2 - curve.x3).toBeCloseTo(-(mirrored.x2 - mirrored.x3));
    expect(curve.y1 - curve.y0).toBeCloseTo(mirrored.y1 - mirrored.y0);
    expect(curve.y3 - curve.y2).toBeCloseTo(mirrored.y3 - mirrored.y2);
  });

  it("DOWN / UP：接在来源与目标上下边的中点，竖向的 S 形", () => {
    const below = box(20, 240);
    const down = route(s, below, DOWN);
    expect([down.x0, down.y0, down.x3, down.y3]).toEqual([106, 30 + 112, 20 + 106, 240]);
    expect([down.x1, down.y1]).toEqual([106, 142 + (240 - 142) / 2]);
    expect([down.x2, down.y2]).toEqual([126, 240 - (240 - 142) / 2]);
    const above = box(-30, -260);
    const up = route(s, above, UP);
    expect([up.x0, up.y0, up.x3, up.y3]).toEqual([106, 30, -30 + 106, -260 + 112]);
    expect(up.y1).toBe(30 - (30 - (-260 + 112)) / 2);
    expect(up.x1).toBe(106);
    expect(up.x2).toBe(76);
  });

  it("两端都垂直于各自的边：出线方向与 side 一致", () => {
    const targets: [Side, PipeBox][] = [
      [RIGHT, box(330, 90)],
      [LEFT, box(-330, -90)],
      [DOWN, box(10, 260)],
      [UP, box(-10, -260)],
    ];
    const heading = { [RIGHT]: [1, 0], [DOWN]: [0, 1], [LEFT]: [-1, 0], [UP]: [0, -1] } as const;
    for (const [side, t] of targets) {
      const c = route(s, t, side);
      const [ux, uy] = heading[side];
      // 第一段（来源端）与最后一段（目标端）的控制线：沿 side 的方向前进，且与它垂直的分量为 0——线从边的法线方向出来、从法线方向进去。
      for (const [vx, vy] of [
        [c.x1 - c.x0, c.y1 - c.y0],
        [c.x3 - c.x2, c.y3 - c.y2],
      ] as const) {
        expect(vx * ux + vy * uy, `${side}`).toBeGreaterThan(0);
        expect(vx * uy - vy * ux === 0, `${side}`).toBe(true);
      }
      expect(opposite(opposite(side))).toBe(side);
    }
  });

  it("落点来自同一组数：portX / portY 与曲线的端点逐位相同", () => {
    const a = box(40, 10);
    const b = box(700, 300, 248, 144);
    for (const side of [RIGHT, DOWN, LEFT, UP] as const) {
      const c = route(a, b, side);
      expect(c.x0).toBe(a.x + portX(a, side));
      expect(c.y0).toBe(a.y + portY(a, side));
      expect(c.x3).toBe(b.x + portX(b, opposite(side)));
      expect(c.y3).toBe(b.y + portY(b, opposite(side)));
    }
    // 落点就是四条边的中点，与卡片的尺寸有关、与别的无关（Agent 卡比来源卡宽、高度不同，各取各的）。
    const middles = (n: PipeBox): number[][] => ([UP, DOWN, LEFT, RIGHT] as const).map((side) => [portX(n, side), portY(n, side)] as number[]);
    expect(middles(a)).toEqual([[106, 0], [106, 112], [0, 56], [212, 56]]);
    expect(middles(b)).toEqual([[124, 0], [124, 144], [0, 72], [248, 72]]);
  });

  it("曲线始终落在两端之间的带子里、不进入两端的节点（随机摆放的节点对）", () => {
    const next = random(2026);
    const inside = (n: PipeBox, p: Point): boolean => p.x > n.x + 1e-6 && p.x < n.x + n.w - 1e-6 && p.y > n.y + 1e-6 && p.y < n.y + n.h - 1e-6;
    let checked = 0;
    for (let i = 0; i < 3000; i++) {
      const a = box(next() * 400 - 200, next() * 400 - 200, 120 + next() * 180, 60 + next() * 140);
      const b = box(next() * 1800 - 900, next() * 1400 - 700, 120 + next() * 180, 60 + next() * 140);
      const side = chooseSide(-1, a, b);
      if (gapOf(a, b, side) <= 0) continue;
      checked += 1;
      const curve = route(a, b, side);
      const horizontal = side === RIGHT || side === LEFT;
      const lo = Math.min(horizontal ? curve.x0 : curve.y0, horizontal ? curve.x3 : curve.y3);
      const hi = Math.max(horizontal ? curve.x0 : curve.y0, horizontal ? curve.x3 : curve.y3);
      for (let k = 0; k <= 64; k++) {
        const p = pointAt(curve, k / 64);
        const along = horizontal ? p.x : p.y;
        expect(along).toBeGreaterThanOrEqual(lo - 1e-6);
        expect(along).toBeLessThanOrEqual(hi + 1e-6);
        expect(inside(a, p)).toBe(false);
        expect(inside(b, p)).toBe(false);
      }
    }
    expect(checked).toBeGreaterThan(1500);
  });

  it("曲率小、路程短：向左 / 向上下的路程与向右镜像的相同，且接近直线距离", () => {
    const right = route(box(0, 0), box(320, 180), RIGHT);
    const left = route(box(0, 0), box(-320, 180), LEFT);
    expect(lengthOf(left)).toBeCloseTo(lengthOf(right), 6);
    for (const [curve, chord] of [
      [right, Math.hypot(right.x3 - right.x0, right.y3 - right.y0)],
      [route(box(0, 0), box(40, 300), DOWN), 0],
      [route(box(0, 0), box(-40, -300), UP), 0],
    ] as const) {
      const direct = chord || Math.hypot(curve.x3 - curve.x0, curve.y3 - curve.y0);
      expect(lengthOf(curve) / direct).toBeLessThan(1.2);
    }
    // 窄的空隙（刚过门槛）不会因此变得更弯：行程小，控制点离端点也近。
    const tight = route(box(0, 0), box(212 + ROUTE.enterSide, 400), RIGHT);
    expect(lengthOf(tight) / Math.hypot(tight.x3 - tight.x0, tight.y3 - tight.y0)).toBeLessThan(1.2);
  });

  it("没有空隙（节点叠在一起）时收成一条直线，不向外探出再绕回来", () => {
    const c = route(box(0, 0), box(50, 20), RIGHT);
    expect([c.x1, c.y1]).toEqual([c.x0, c.y0]);
    expect([c.x2, c.y2]).toEqual([c.x3, c.y3]);
    const d = route(box(0, 0), box(0, 0), DOWN);
    expect([d.x1, d.y1]).toEqual([d.x0, d.y0]);
    expect([d.x2, d.y2]).toEqual([d.x3, d.y3]);
  });

  it("零尺寸、同一点、很远的距离都不产生 NaN 或 Infinity", () => {
    const zero = box(10, 10, 0, 0);
    const huge = box(1e9, -1e9, 212, 112);
    for (const [a, b] of [
      [zero, zero],
      [zero, box(10, 10)],
      [box(0, 0), huge],
      [huge, box(0, 0)],
      [box(5, 5), box(5, 5)],
      [box(-1e9, 0), box(1e9, 0)],
    ] as const) {
      for (const side of [RIGHT, DOWN, LEFT, UP] as const) {
        const path = curvePath(route(a, b, side));
        expect(path, `${side}`).not.toMatch(/NaN|Infinity/);
        expect(path).toMatch(/^M-?[\d.]+ -?[\d.]+C(-?[\d.]+ -?[\d.]+ ){2}-?[\d.]+ -?[\d.]+$/);
      }
      const chosen = chooseSide(-1, a, b);
      expect([RIGHT, DOWN, LEFT, UP]).toContain(chosen);
    }
  });
});

describe("换边的过渡", () => {
  it("ease：起止为 0 与 1、单调、两端的斜率为 0", () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBe(0.5);
    let last = 0;
    for (let i = 1; i <= 100; i++) {
      const v = ease(i / 100);
      expect(v).toBeGreaterThan(last);
      last = v;
    }
    expect(ease(0.01)).toBeLessThan(0.001);
    expect(1 - ease(0.99)).toBeLessThan(0.001);
  });

  it("过渡的起点就是眼下画着的曲线，终点逐位等于新的曲线；两端跟着节点走", () => {
    const s = box(0, 0);
    const t = box(320, 40);
    const shown = route(s, t, RIGHT); // 画着的是 RIGHT
    const pinned = pinCurve(shown, s, t, new Curve());
    // 过渡期间节点又动了：旧曲线的两端跟着各自的节点平移，而不是留在原地。
    const moved = box(0, 0);
    const movedTarget = box(-260, 70);
    const goal = route(moved, movedTarget, LEFT);
    const start = mixCurve(pinned, goal, 0, s, t, new Curve());
    expect(sameCurve(start, shown)).toBe(true);
    const shifted = mixCurve(pinned, goal, 0, { ...s, x: 30, y: 20 }, { ...t, x: 350, y: 60 }, new Curve());
    expect(shifted.x0).toBe(shown.x0 + 30);
    expect(shifted.y0).toBe(shown.y0 + 20);
    expect(shifted.x3).toBe(shown.x3 + 30);
    expect(shifted.y3).toBe(shown.y3 + 20);
    const end = mixCurve(pinned, goal, 1, moved, movedTarget, new Curve());
    expect(sameCurve(end, goal)).toBe(true);
    expect(curvePath(end)).toBe(curvePath(goal));
  });

  it("相邻两帧的端点位移有上限：按 0.24 s、60 帧/秒走完，每帧不超过总位移的 1.5 倍均值", () => {
    const s = box(0, 0);
    const t = box(-300, 60);
    const shown = route(s, box(420, 60), RIGHT);
    const pinned = pinCurve(shown, s, t, new Curve());
    const goal = route(s, t, LEFT);
    const frames = Math.round(ROUTE.morph * 60);
    const out = new Curve();
    let last = copyCurve(shown, new Curve());
    let worst = 0;
    for (let frame = 1; frame <= frames; frame++) {
      mixCurve(pinned, goal, ease(frame / frames), s, t, out);
      worst = Math.max(worst, Math.hypot(out.x0 - last.x0, out.y0 - last.y0), Math.hypot(out.x3 - last.x3, out.y3 - last.y3));
      last = copyCurve(out, new Curve());
    }
    const total = Math.max(Math.hypot(goal.x0 - shown.x0, goal.y0 - shown.y0), Math.hypot(goal.x3 - shown.x3, goal.y3 - shown.y3));
    expect(total).toBeGreaterThan(200);
    expect(worst).toBeLessThanOrEqual((1.5 * total) / frames + 1e-9);
    // 没有过渡的话，端点会在一帧里跳完 total。
    expect(worst).toBeLessThan(total / 8);
  });
});

describe("连线元素的写入缓存", () => {
  const groups = () => {
    const ns = "http://www.w3.org/2000/svg";
    return { tube: document.createElementNS(ns, "g"), dots: document.createElementNS(ns, "g") };
  };

  it("路径没变就不再碰 DOM；变了才写", () => {
    const els = createPipeElements(groups());
    const writes = [els.tube, els.fine, ...els.packets].map((el) => vi.spyOn(el, "setAttribute"));
    setPipe(els, "M0 0C1 1 2 2 3 3");
    const first = writes.map((spy) => spy.mock.calls.filter(([name]) => name === "d").length);
    expect(first).toEqual(first.map(() => 1));
    setPipe(els, "M0 0C1 1 2 2 3 3");
    expect(writes.map((spy) => spy.mock.calls.filter(([name]) => name === "d").length)).toEqual(first);
    setPipe(els, "M0 0C1 1 2 2 4 4");
    expect(writes.map((spy) => spy.mock.calls.filter(([name]) => name === "d").length)).toEqual(first.map(() => 2));
    expect(els.tube.getAttribute("d")).toBe("M0 0C1 1 2 2 4 4");
    expect(els.packets.every((packet) => packet.getAttribute("d") === "M0 0C1 1 2 2 4 4")).toBe(true);
  });

  it("渐变端点按两位小数取整后比较：没变不写，变了四个属性一起写", () => {
    const els = createPipeElements(groups());
    const spy = vi.spyOn(els.gradient, "setAttribute");
    setPipeFlow(els, 1.001, 2, 3, 4);
    expect(spy).toHaveBeenCalledTimes(4);
    setPipeFlow(els, 1.002, 2.001, 3, 4.0004);
    expect(spy).toHaveBeenCalledTimes(4);
    setPipeFlow(els, 212.345, 86, -40, 99.9);
    expect(spy).toHaveBeenCalledTimes(8);
    expect(["x1", "y1", "x2", "y2"].map((name) => els.gradient.getAttribute(name))).toEqual(["212.35", "86", "-40", "99.9"]);
  });
});

/** 带工作目录的会话（用来排出 Folder 与 Git 节点）。 */
const session = (id: string, origin: string, order: number, extra: Partial<SessionSummary> = {}, workspace?: string): SessionSummary =>
  ({
    id,
    origin: workspace === undefined ? { key: origin } : { key: origin, workspace },
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, order)).toISOString(),
    phase: "running",
    ...extra,
  }) as unknown as SessionSummary;

describe("默认布局的连线不变", () => {
  const REPO = "C:\\Users\\alice\\Desktop\\Ensemble";
  const OTHER = "C:\\work\\other";
  const shapes: SessionSummary[][] = [
    [session("a", "codex", 1)],
    [session("a", "codex", 1), session("b", "codex", 2), session("c", "codex", 3), session("d", "codex", 4)],
    [session("a", "codex", 1), session("a1", "codex", 2, { parentSessionId: "a" }), session("a2", "codex", 3, { parentSessionId: "a1" }), session("b", "codex", 4)],
    [session("a", "codex", 1, {}, REPO), session("b", "cursor", 2, {}, REPO), session("c", "pi", 3, {}, REPO), session("d", "claude", 4, {}, OTHER)],
    [session("a", "codex", 1, {}, REPO), session("a1", "codex", 2, { parentSessionId: "a" }, REPO), session("z", "cursor", 3), session("y", "pi", 4)],
  ];
  const gits: ReadonlyMap<string, string>[] = [new Map(), new Map([["codex", "repo"], ["cursor", "repo"], ["pi", "repo"]]), new Map([["codex", "r1"], ["claude", "r2"]])];
  const areas = [undefined, { w: 1168, h: 656 }, { w: 1800, h: 900 }, { w: 480, h: 700 }, { w: 1400, h: 656 }];

  it("每一条边在引擎里都走 RIGHT，路径与旧算法逐字节相同（所有布局形态 × 取景区域 × Git 分组）", () => {
    let edges = 0;
    let links = 0;
    const kinds = new Set<string>();
    for (const sessions of shapes) {
      for (const git of gits) {
        for (const area of areas) {
          const layout: SceneLayout = layoutScene(sessions, { ...(area ? { area } : {}), git });
          const byId = new Map(layout.nodes.map((node) => [node.id, node]));
          for (const node of layout.nodes) kinds.add(node.kind);
          for (const edge of layout.edges) {
            if (edge.phase === "link") links += 1;
            const from = byId.get(edge.from)!;
            const to = byId.get(edge.to)!;
            const where = `${edge.id} ${JSON.stringify([...git])} ${JSON.stringify(area)}`;
            for (const prev of [-1, RIGHT, DOWN, LEFT, UP]) expect(chooseSide(prev, from, to), `${where} prev ${prev}`).toBe(RIGHT);
            // 出线在来源右缘的竖直中点，进线在目标左缘的竖直中点。
            const a = { x: from.x + from.w, y: from.y + from.h / 2 };
            const b = { x: to.x, y: to.y + to.h / 2 };
            expect(curvePath(route(from, to, RIGHT)), where).toBe(legacyForward(a, b));
            expect(pipePath(a, b), where).toBe(legacyForward(a, b));
            edges += 1;
          }
        }
      }
    }
    expect(edges).toBeGreaterThan(150);
    // 静态的归属连线（Git → Folder → 来源）也在里面。
    expect(links).toBeGreaterThan(20);
    expect([...kinds].sort()).toEqual(["agent", "folder", "git", "origin"]);
  });
});
