import { describe, expect, it } from "vitest";
import { holdLayout, memoryOf } from "./arrival-hold";
import type { Point } from "./arrival-slots";
import { optionsOf, shapeOf, WINDOWS } from "./arrival.columns.fixtures";
import { agent, moved, roots, spot } from "./arrival.fixtures";
import { layoutScene, type Area, type SceneLayout } from "./layout";
import { node, overlapsOf } from "./layout.fixtures";

/**
 * `yields`（arrival-hold.ts）的两个条件各自单独成立的情形：规划给新根会话的落点 `planned` 与它该去的那一格 `grown`，
 *   竖直相差超过 0.01（不在同一行）或横向相差不小于半张卡宽（不在同一列），任何一个成立就让位给 `grown`；两个都不成立（同一行、同一列）才沿用规划。
 * arrival-hold.rules.test.ts 的 N7 里规划的落点与 `grown` 总是既不同行、又不同列，把 `||` 的任意一半拿掉它都照样全绿：
 * 这里用真实的规划，只改新卡 r6 的坐标，把两半分开。
 */

const KEY = "cursor:a";
const compact = WINDOWS[4]!.area;
const tall: Area = { w: compact.w, h: 3000 };
const five = layoutScene(roots(KEY, 5), optionsOf(tall));
const known = new Set(five.nodes.map((n) => n.id));
const first = spot(five, agent("r1"));
const half = node(five, agent("r1")).w / 2;

/** 紧凑格点一格：232 × 128（卡 208 × 112，横向空白 24、纵向空白 16）。 */
const COLUMN = 232;
const ROW = 128;
/** r6 在窄区域里该去的一格：右边新开的一列、顶与第一排对齐。 */
const BESIDE: Point = { x: first.x + COLUMN, y: first.y };
/** r6 在高区域里该去的一格：这一列的下一格（规划本来也把它排在这里）。 */
const BELOW: Point = { x: first.x, y: first.y + 5 * ROW };

/** 真实的规划（r6 排在这一列的下一格），只把 r6 的坐标改成 `to`：已有的卡、连线、锚点都原样。 */
function planWith(to: Point): SceneLayout {
  const plan = layoutScene(roots(KEY, 6), optionsOf(tall));
  return { ...plan, nodes: plan.nodes.map((n) => (n.id === agent("r6") ? { ...n, x: to.x, y: to.y } : n)) };
}

function hold(to: Point, area: Area) {
  const plan = planWith(to);
  return { plan, held: holdLayout(plan, memoryOf(five), (id) => known.has(id), area) };
}

describe("yields：规划的落点与该去的那一格，竖直、横向两个条件各自单独成立", () => {
  it("前提：规划本来把 r6 排在这一列的下一格；窄区域里它该去右边新开的一列，高区域里就是这一格", () => {
    expect(spot(layoutScene(roots(KEY, 6), optionsOf(tall)), agent("r6"))).toEqual(BELOW);
    expect(half, "紧凑卡 208 宽").toBe(104);
    expect(spot(hold(BELOW, compact).held.layout, agent("r6"))).toEqual(BESIDE);
    expect(spot(hold(BELOW, tall).held.layout, agent("r6"))).toEqual(BELOW);
  });

  it("竖直相同、横向差一整列（规划把 r6 排在同一行、隔了一列）：横向这一半单独成立，也让位——落在该去的那一格", () => {
    const planned: Point = { x: BESIDE.x + COLUMN, y: BESIDE.y };
    const { plan, held } = hold(planned, compact);
    expect(spot(plan, agent("r6")), "前提：规划给的落点与该去的那一格只差横向").toEqual(planned);
    expect(held.mode).toBe("hold");
    expect(held.added).toEqual([agent("r6")]);
    expect(spot(held.layout, agent("r6"))).toEqual(BESIDE);
    expect(moved(five, held.layout)).toEqual([]);
    expect(shapeOf(held.layout)).toEqual([5, 1]);
    expect(overlapsOf(held.layout)).toEqual([]);
  });

  it("横向相同、竖直差两行（规划把 r6 排在同一列、隔了两行）：竖直这一半单独成立，也让位——落在该去的那一格", () => {
    const planned: Point = { x: BELOW.x, y: BELOW.y + 2 * ROW };
    const { plan, held } = hold(planned, tall);
    expect(spot(plan, agent("r6")), "前提：规划给的落点与该去的那一格只差竖直").toEqual(planned);
    expect(held.mode).toBe("hold");
    expect(held.added).toEqual([agent("r6")]);
    expect(spot(held.layout, agent("r6"))).toEqual(BELOW);
    expect(moved(five, held.layout)).toEqual([]);
    expect(shapeOf(held.layout)).toEqual([6]);
    expect(overlapsOf(held.layout)).toEqual([]);
  });

  it("同一行、同一列（横向只差 24，不到半张卡宽）：不让位，沿用规划给的坐标——持有的结果就是这份规划本身", () => {
    const planned: Point = { x: BESIDE.x + 24, y: BESIDE.y };
    const { plan, held } = hold(planned, compact);
    expect(held.mode).toBe("hold");
    expect(held.layout).toBe(plan);
    expect(spot(held.layout, agent("r6"))).toEqual(planned);
    expect(overlapsOf(held.layout)).toEqual([]);
  });

  it.each([
    [-1, false],
    [0, true],
  ])("半张卡宽是一条界线：横向差（半张卡宽 + %i）个像素时让位 = %s（正好半张卡宽就算不同列）", (delta, yields) => {
    const planned: Point = { x: BESIDE.x + half + delta, y: BESIDE.y };
    const { held } = hold(planned, compact);
    expect(spot(held.layout, agent("r6"))).toEqual(yields ? BESIDE : planned);
  });
});
