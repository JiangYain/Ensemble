import { describe, expect, it } from "vitest";
import type { BlockShape } from "./layout-block";
import { cellsFor, spanX, spanY } from "./layout-cells";
import { packOffsets, planPack, type PackTile } from "./layout-pack";

/**
 * 来源块之上的整体排布（layout-pack.ts）：全用合成的外形阶梯（宽升高降），不经过 layoutScene。
 * 这一层只做数字上的取舍：分几列竖排、每个来源块取哪种外形、各块偏移多少格。
 */

const cells = cellsFor(false);

/** 一个来源块的外形阶梯：每项 [列数, 行数]（宽升高降），摆法与容器宽度对这一层没有意义。 */
const ladder = (...pairs: [number, number][]): BlockShape[] => pairs.map(([cols, rows]) => ({ cols, rows, top: false, inner: Math.max(0, cols - 1) }));

const tile = (key: string, shapes: BlockShape[], weight = 10, lead = 0): PackTile => ({ lead, weight, members: [{ key, shapes }] });

/** 整体放进取景区域的缩放（不封顶）：与 planPack 内部同一个量。 */
const scaleOf = (area: { w: number; h: number }, cols: number, rows: number): number => Math.min(area.w / spanX(cells, cols), area.h / spanY(cells, rows));

describe("planPack · 选分列的方式与每个来源块的外形", () => {
  it("没有块可排：没有结果", () => {
    expect(planPack([], { w: 1000, h: 600 }, cells)).toBeUndefined();
  });

  it("只有一个块：取放得下的缩放最大的那种外形，缩放就是宽高各自比例的较小者", () => {
    const shapes = ladder([2, 9], [4, 5], [6, 3], [9, 2]);
    const area = { w: 1088, h: 610 };
    const plan = planPack([tile("k", shapes)], area, cells)!;
    expect(plan.strips).toEqual([[0]]);
    expect(plan.picks.get("k")).toBe(shapes[1]);
    expect(plan.scale).toBeCloseTo(scaleOf(area, 4, 5), 9);
    // 其余外形都更小。
    for (const [cols, rows] of [[2, 9], [6, 3], [9, 2]] as const) expect(scaleOf(area, cols, rows)).toBeLessThan(plan.scale);
  });

  it("取景区域又宽又矮时多分几列并排，又窄又高时少分几列，每个块恰好排一次、同一列里保持原有先后", () => {
    const shapes = ladder([3, 5], [6, 3]);
    const tiles = [tile("a", shapes), tile("b", shapes), tile("c", shapes), tile("d", shapes)];
    const wide = planPack(tiles, { w: 6000, h: 500 }, cells)!;
    const tall = planPack(tiles, { w: 500, h: 6000 }, cells)!;
    expect(wide.strips.length).toBeGreaterThan(tall.strips.length);
    for (const plan of [wide, tall]) {
      expect(plan.strips.flat().sort()).toEqual([0, 1, 2, 3]);
      for (const strip of plan.strips) expect(strip).toEqual([...strip].sort((a, b) => a - b));
      expect([...plan.picks.keys()].sort()).toEqual(["a", "b", "c", "d"]);
    }
  });

  it("结果的缩放与它选的分法一致：没有哪一种单列分法比它更大", () => {
    const shapes = ladder([2, 6], [3, 4], [4, 3], [6, 2]);
    const tiles = [tile("a", shapes, 12), tile("b", shapes, 12)];
    const area = { w: 1088, h: 610 };
    const plan = planPack(tiles, area, cells)!;
    // 单列叠放：两个块各取最矮的外形，宽取较宽的那个。
    let oneStrip = 0;
    for (const [cols, rows] of [[2, 6], [3, 4], [4, 3], [6, 2]] as const) oneStrip = Math.max(oneStrip, scaleOf(area, cols, rows * 2));
    expect(plan.scale).toBeGreaterThanOrEqual(oneStrip - 1e-9);
  });
});

describe("packOffsets · 每一块在整体里的偏移", () => {
  it("同一列里上下叠放：下一块从上一块的最后一行之后起，左缘对齐", () => {
    const tiles = [tile("a", ladder([4, 3])), tile("b", ladder([4, 2]))];
    // 又窄又高的区域：只会分成一列。
    const plan = planPack(tiles, { w: 600, h: 6000 }, cells)!;
    expect(plan.strips).toEqual([[0, 1]]);
    expect(packOffsets(plan, tiles, cells)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 3 * cells.pitchY },
    ]);
  });

  it("分成两列：第二列从第一列的最右一列之后起，顶部对齐", () => {
    const tiles = [tile("a", ladder([3, 6])), tile("b", ladder([3, 6]))];
    // 又宽又矮：单列要 12 行，两列并排是 6 列 × 6 行。
    const plan = planPack(tiles, { w: 3000, h: 800 }, cells)!;
    expect(plan.strips).toEqual([[0], [1]]);
    expect(packOffsets(plan, tiles, cells)).toEqual([
      { x: 0, y: 0 },
      { x: 3 * cells.pitchX, y: 0 },
    ]);
  });

  it("一列里只要有一块左边接着 Folder / Git 卡（lead），没有的那些块也在左边留出同样的空位，来源卡共用一条竖轴", () => {
    const tiles = [tile("a", ladder([3, 3]), 10, 2), tile("b", ladder([3, 2]), 10, 0)];
    const plan = planPack(tiles, { w: 600, h: 6000 }, cells)!;
    expect(plan.strips).toEqual([[0, 1]]);
    const [a, b] = packOffsets(plan, tiles, cells);
    expect(a).toEqual({ x: 0, y: 0 });
    expect(b).toEqual({ x: 2 * cells.pitchX, y: 3 * cells.pitchY });
  });

  it("一块里有几个来源块（共用 Folder / Git 卡的几个来源）时竖直叠放，总行数是它们的行数之和", () => {
    const together: PackTile = {
      lead: 1,
      weight: 20,
      members: [
        { key: "x", shapes: ladder([3, 2]) },
        { key: "y", shapes: ladder([3, 4]) },
      ],
    };
    const plan = planPack([together], { w: 1088, h: 610 }, cells)!;
    expect(plan.picks.get("x")).toMatchObject({ cols: 3, rows: 2 });
    expect(plan.picks.get("y")).toMatchObject({ cols: 3, rows: 4 });
    // 整体：1 列 lead + 3 列，6 行。
    expect(plan.scale).toBeCloseTo(scaleOf({ w: 1088, h: 610 }, 4, 6), 9);
  });
});
