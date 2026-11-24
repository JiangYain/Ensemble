import type { SessionSummary } from "@shared/types";
import { describe, expect, it } from "vitest";
import { holdLayout, memoryOf } from "./arrival-hold";
import { crowds } from "./arrival-slots";
import { arrive, optionsOf, shapeOf, WINDOWS } from "./arrival.columns.fixtures";
import { agent, DESK as GRID, join, kidsOf, moved, rectsOf, roots, spot } from "./arrival.fixtures";
import { layoutScene, type SceneLayout } from "./layout";
import { node, overlapsOf } from "./layout.fixtures";
import { Curve, chooseSide, routeCurve, type PipeBox } from "./pipes";

/**
 * 汇聚会话（有多个上级）的落点（LAYOUT4 · W9 与 W11 · M03）：落在所有上级的右边、不在来源块第一排会话卡之上；
 * 右边附近没有空位时开一列到所有卡的右边、顶与第一排对齐；经典树里整列对齐。
 * 汇入线穿卡数用真实的连线路径（pipes.ts 的 `chooseSide` + `routeCurve`）采样数出来，与 `.tmp\layout-work\l4-converge.ts` 同一套算法。
 * 坐标与穿卡数是现状的描述；断言的主体是“不动已有的卡、不重叠、不在第一排之上、在所有上级的右边”。
 */

const KEY = "cursor:a";
const DESK = optionsOf(WINDOWS[0]!.area);
const COMPACT = optionsOf(WINDOWS[4]!.area);

const boxOf = (layout: SceneLayout, id: string): PipeBox => {
  const found = node(layout, agent(id));
  return { x: found.x, y: found.y, w: found.w, h: found.h };
};

/** 一条汇入线（上级 → `to`）穿过几张别的会话卡（不含两端）。 */
function crossings(layout: SceneLayout, from: string, to: string): number {
  const s = boxOf(layout, from);
  const t = boxOf(layout, to);
  const curve = routeCurve(s, t, chooseSide(-1, s, t), new Curve());
  const hit = new Set<string>();
  for (let i = 1; i < 200; i++) {
    const k = i / 200;
    const u = 1 - k;
    const x = u * u * u * curve.x0 + 3 * u * u * k * curve.x1 + 3 * u * k * k * curve.x2 + k * k * k * curve.x3;
    const y = u * u * u * curve.y0 + 3 * u * u * k * curve.y1 + 3 * u * k * k * curve.y2 + k * k * k * curve.y3;
    for (const n of layout.nodes) {
      if (n.kind !== "agent" || n.id === agent(from) || n.id === agent(to)) continue;
      if (x > n.x && x < n.x + n.w && y > n.y && y < n.y + n.h) hit.add(n.id);
    }
  }
  return hit.size;
}
const totalCrossings = (layout: SceneLayout, parents: readonly string[]): number => parents.reduce((sum, id) => sum + crossings(layout, id, "C"), 0);

/** 在 `before` 排布的右边（所有上级之右）每个空格试一遍，汇入线穿卡合计最少是多少（扫描的格子与间距和 `l4-converge.ts` 的 SCAN 一样）。 */
function bestPossible(before: SceneLayout, parents: readonly string[]): number {
  const cards = before.nodes.filter((n) => n.kind === "agent");
  const size = { w: cards[0]!.w, h: cards[0]!.h };
  const pitch = { x: size.w + (size.w < 220 ? 24 : 32), y: size.h + (size.w < 220 ? 16 : 24) };
  const minX = Math.max(...parents.map((id) => boxOf(before, id).x + boxOf(before, id).w)) + 24;
  const top = Math.min(...cards.map((n) => n.y));
  const left = Math.min(...cards.map((n) => n.x));
  let best = Infinity;
  for (let i = 0; i < 12; i++) {
    for (let j = 0; j < 14; j++) {
      const at = { x: left + i * pitch.x, y: top + j * pitch.y };
      if (at.x < minX || rectsOf(before).some((other) => crowds({ ...at, ...size }, other, 24))) continue;
      const withC = { ...before, nodes: [...before.nodes, { ...cards[0]!, id: agent("C"), x: at.x, y: at.y }] } as SceneLayout;
      best = Math.min(best, totalCrossings(withC, parents));
    }
  }
  return best;
}

/** `base` 之后来一个汇聚会话 C（上级是 `parents`）：一次载入（刷新后）或逐个到达，返回 C 到达前后的两份排布。 */
function land(base: readonly SessionSummary[], parents: readonly string[], options = DESK, mode: "load" | "arrive" = "load") {
  const joined = join("C", KEY, 900, [...parents]);
  const steps = arrive([...base, joined], options, undefined, mode === "load" ? base.length : 1);
  return { before: steps.at(-2)!, after: steps.at(-1)!, joined };
}

/** 落点的共同要求：已有的卡不动、不重叠、不在第一排会话卡之上、在每个上级的右边。 */
function expectSane(before: SceneLayout, after: SceneLayout, parents: readonly string[], label: string): void {
  expect(moved(before, after), `${label}：已有的卡动了`).toEqual([]);
  expect(overlapsOf(after), `${label}：重叠`).toEqual([]);
  const top = Math.min(...before.nodes.filter((n) => n.kind === "agent").map((n) => n.y));
  expect(spot(after, agent("C")).y, `${label}：C 悬在第一排之上`).toBeGreaterThanOrEqual(top);
  for (const id of parents) expect(spot(after, agent("C")).x, `${label}：C 不在 ${id} 的右边`).toBeGreaterThan(boxOf(after, id).x + boxOf(after, id).w);
}

describe("24 个根 + C 接在 r2、r11、r21 后面（桌面 1440×900）", () => {
  const parents = ["r2", "r11", "r21"];
  const all = roots(KEY, 24);

  it("一次载入后来 C：落在第一排之下、所有上级的右边（旧：(560, −136)，来源卡所在行的上方，穿卡 8）", () => {
    const { before, after } = land(all, parents);
    expectSane(before, after, parents, "载入后来");
    expect(spot(after, agent("C"))).toEqual({ x: 560, y: 816 });
    expect(spot(before, agent("r2"))).toEqual({ x: 280, y: 136 });
    expect(Math.min(...before.nodes.filter((n) => n.kind === "agent").map((n) => n.y)), "第一排的顶").toBe(136);
  });

  it("汇入线穿卡合计 4：右边每个空格里最少也是 4，没有哪个落点能做到 ≤ 2；刷新后整份重排才是 0", () => {
    const { before, after } = land(all, parents);
    expect(totalCrossings(after, parents)).toBe(4);
    expect(bestPossible(before, parents), "所有上级右边的空格里穿卡最少的").toBe(4);
    const fresh = layoutScene([...all, join("C", KEY, 900, parents)], DESK);
    expect(spot(fresh, agent("C")), "对照：刷新后整份重排，C 在第一排").toEqual({ x: 560, y: 136 });
    expect(totalCrossings(fresh, parents)).toBe(0);
  });

  it("逐个到达到 24 个再来 C：同样不在第一排之上，在所有上级的右边", () => {
    const { before, after } = land(all, parents, DESK, "arrive");
    expectSane(before, after, parents, "逐个到达后来");
    expect(spot(after, agent("C"))).toEqual({ x: 1424, y: 136 });
  });

  it("紧凑模式（288×544）：一次载入与逐个到达都不在第一排之上、在所有上级的右边", () => {
    for (const mode of ["load", "arrive"] as const) {
      const { before, after } = land(all, parents, COMPACT, mode);
      expectSane(before, after, parents, `紧凑 ${mode}`);
    }
    expect(spot(land(all, parents, COMPACT).after, agent("C"))).toEqual({ x: 696, y: 768 });
  });
});

describe("规模不同的格点：12 个根、5 个根", () => {
  it("12 个根 + C(r2, r6, r10)：载入与逐个到达都在第一排之下、所有上级之右", () => {
    const parents = ["r2", "r6", "r10"];
    const loaded = land(roots(KEY, 12), parents);
    expectSane(loaded.before, loaded.after, parents, "12 载入");
    expect(spot(loaded.after, agent("C"))).toEqual({ x: 840, y: 544 });
    const arrived = land(roots(KEY, 12), parents, DESK, "arrive");
    expectSane(arrived.before, arrived.after, parents, "12 逐个");
    expect(spot(arrived.after, agent("C"))).toEqual({ x: 864, y: 544 });
    expect(totalCrossings(arrived.after, parents)).toBe(4);
  });

  it("5 个根 + C(r1, r3, r5)：载入时与刷新后同一个格子、穿卡 0；逐个到达时 5 个根是 3 行 × 2 列，汇入线穿卡 2（这个排布里最少 1）", () => {
    const parents = ["r1", "r3", "r5"];
    const { before, after } = land(roots(KEY, 5), parents);
    expectSane(before, after, parents, "5 载入");
    expect(spot(after, agent("C"))).toEqual({ x: 280, y: 408 });
    expect(spot(layoutScene([...roots(KEY, 5), join("C", KEY, 900, parents)], DESK), agent("C"))).toEqual({ x: 280, y: 408 });
    expect(totalCrossings(after, parents)).toBe(0);
    const arrived = land(roots(KEY, 5), parents, DESK, "arrive");
    expectSane(arrived.before, arrived.after, parents, "5 逐个");
    // 旧：逐个到达时 5 个根竖成一列（[5]），r1、r3、r5 在同一列，汇入线从这一列的右边出去，穿卡 0。
    // LAYOUT8 起两种长法一样全时按形状长，5 个根是 3 行 × 2 列（[3, 2]）：r1 与 r3 在同一行，r1 → C 的线要从 r3 的卡上过去。
    // 汇聚会话的落点规则（所有上级之右的第一个空格）没有改，穿卡数从来不是它的目标；这个排布里右边每个空格最少也要穿 1 张，做不到 0。
    expect(shapeOf(arrived.before), "前提：5 个根是 3 行 × 2 列").toEqual([3, 2]);
    expect(spot(arrived.after, agent("C"))).toEqual({ x: 864, y: 272 });
    expect(totalCrossings(arrived.after, parents)).toBe(2);
    expect(bestPossible(arrived.before, parents), "所有上级右边的空格里穿卡最少的").toBe(1);
  });
});

describe("右边附近没有空位：开一列到所有卡的右边、顶与第一排对齐，不放到别处", () => {
  it("225 个根排满的格点（15 × 15），C 接在最后一行最左的 r211 与最右的 r225 后面：右边（r225 之右）没有格子，落在最右一列的右边，y 是第一排的顶", () => {
    const sessions = roots(KEY, 225);
    const base = layoutScene(sessions, GRID);
    const cards = base.nodes.filter((n) => n.kind === "agent");
    const parents = ["r211", "r225"];
    const joined = join("C", KEY, 900, parents);
    const plan = layoutScene([...sessions, joined], GRID);
    const anchor = node(plan, agent("C")).anchor!;
    const known = new Set(base.nodes.map((n) => n.id));
    const held = holdLayout(plan, memoryOf(base), (id) => known.has(id));
    expect(moved(base, held.layout)).toEqual([]);
    const right = Math.max(...cards.map((n) => n.x + n.w));
    const top = Math.min(...cards.map((n) => n.y));
    expect(spot(base, agent("r225")), "前提：r225 就在最右一列、最后一行").toEqual({ x: right - 248, y: Math.max(...cards.map((n) => n.y)) });
    const ideal = { x: spot(base, anchor.id).x + anchor.dx, y: spot(base, anchor.id).y + anchor.dy };
    expect(ideal, "前提：规划给的理想位置（第一个上级右边一格）远在左下角，落点不是理想位置碰巧在那里").toEqual({ x: 280, y: 2040 });
    expect(spot(held.layout, agent("C")), "最右边那一列的右边一道空隙，顶与第一排对齐").toEqual({ x: right + 32, y: top });
    expectSane(base, held.layout, parents, "225");
  });
});

describe("上级之一是另一个根的子会话", () => {
  it("格点（24 个根 + r1 的子会话 k1）：C(r2, r11, k1) 在所有上级的右边、第一排之下，已有的卡不动", () => {
    const parents = ["r2", "r11", "k1"];
    const { before, after } = land([...roots(KEY, 24), ...kidsOf(KEY, "r1", 1, 100)], parents);
    expectSane(before, after, parents, "k1 是上级之一");
    expect(spot(after, agent("C"))).toEqual({ x: 1400, y: 136 });
  });

  it("逐个到达、紧凑模式也一样", () => {
    const parents = ["r2", "r11", "k1"];
    const base = [...roots(KEY, 24), ...kidsOf(KEY, "r1", 1, 100)];
    for (const [options, mode] of [[DESK, "arrive"], [COMPACT, "load"], [COMPACT, "arrive"]] as const) {
      const { before, after } = land(base, parents, options, mode);
      expectSane(before, after, parents, `k1 是上级之一 ${mode}`);
    }
  });
});

describe("经典树里汇聚会话的整列对齐（M03）", () => {
  /** 经典树：n 个根（n ≤ 3 时规划仍是经典的）与 r1 的子会话 k1；C 接在 r_n 与 k1 后面。 */
  const classic = (rootCount: number) => {
    const base = [...roots(KEY, rootCount), ...kidsOf(KEY, "r1", 1, 100)];
    const parents = [`r${rootCount}`, "k1"];
    return { ...land(base, parents, DESK, "load"), parents };
  };

  // 探针：不按整列抬时 924 变成 916、1144 变成 916，卡落在两列之间。
  const CASES = [
    { roots: 1, x: 924, y: 136 },
    { roots: 2, x: 1144, y: 136 },
    { roots: 3, x: 1144, y: 272 },
  ] as const;

  for (const { roots: rootCount, x, y } of CASES) {
    it(`${rootCount} 个根 + k1，C 接在 r${rootCount} 与 k1 后面：x=${x}，与已有的某一列相差整数个列距（280）`, () => {
      const { before, after, parents } = classic(rootCount);
      expect(before.grid, "前提：规划是经典树").not.toBe(true);
      expectSane(before, after, parents, `经典树 ${rootCount} 个根`);
      expect(spot(after, agent("C"))).toEqual({ x, y });
      const placed = spot(after, agent("C")).x;
      const columns = new Set(before.nodes.filter((n) => n.kind === "agent").map((n) => n.x));
      expect([...columns].some((column) => (placed - column) % 280 === 0), `x=${placed} 与 ${[...columns].join("、")} 都不差整数个列距`).toBe(true);
    });
  }

  it("两个根、C 接在 r1 与 r2 后面（没有子会话）：与刷新后同一个格子", () => {
    const { before, after } = land(roots(KEY, 2), ["r1", "r2"]);
    expectSane(before, after, ["r1", "r2"], "经典树两个根");
    expect(spot(after, agent("C"))).toEqual({ x: 644, y: 0 });
    expect(spot(layoutScene([...roots(KEY, 2), join("C", KEY, 900, ["r1", "r2"])], DESK), agent("C"))).toEqual({ x: 644, y: 0 });
  });
});
