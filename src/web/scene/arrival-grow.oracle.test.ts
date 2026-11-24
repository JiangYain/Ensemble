import { describe, expect, it } from "vitest";
import { arrive, optionsOf, WINDOWS } from "./arrival.columns.fixtures";
import { roots } from "./arrival.fixtures";
import type { Area, SceneLayout } from "./layout";
import { cellsFor, spanX, spanY } from "./layout-cells";
import { NODE } from "./layout-geometry";

/**
 * 根会话到达规则的独立算术参照（LAYOUT6）：不引用 arrival-grow.ts、arrival-hold.ts 的任何东西，
 * 只用“格子数 → 外框尺寸 → 看得全的比例”的算术把规则推一遍（与编排者的 o-bbff-sim.ts 同一个思路），
 * 再核对真实的持有路径（`HeldLayout.apply` 带取景区域）每一步的形状与看得全的比例。
 * 规则的文字：外框里还有空格就按阅读顺序（先行后列）填；没有空格，比较“新开一行”与“新开一列”之后整体看得全的比例，
 * 另一个高出 0.0005 以上才算更全；持平（LAYOUT8）就看形状——长出来之后这个来源块（只算它自己的会话卡，不含来源卡）的宽高比
 * 与取景区域的宽高比，取对数比的绝对值更小的；新开一列的形状要比新开一行好出 0.05 以上才选它，不然仍新开一行。
 * 卡的尺寸、格距、间距都从 layout-geometry / layout-cells 取，不写魔数。
 */

const KEY = "cursor:a";
/** 规则文字里“持平”的容差（比例相差不足它算一样全）。 */
const TIE = 0.0005;
/** 规则文字里“形状一样像”的容差：两个块的宽高比与取景区域的宽高比，对数比相差不足它（约 5%）算一样像。 */
const SHAPE_TIE = 0.05;
/** 参照与真实之间允许的差：0.5 个百分点。 */
const TOLERANCE = 0.005;
const DESKTOP = WINDOWS.slice(0, 3);
const cells = cellsFor(false);

interface Grid {
  cols: number;
  rows: number;
}
type Geometry = (cols: number, rows: number) => { w: number; h: number };

/** A：来源卡在左边，第一列会话在来源卡右边隔一道 `originGap`；外框 = 来源卡与间距加 cols 列宽、rows 行高。 */
const leftOrigin: Geometry = (cols, rows) => ({ w: NODE.originW + NODE.originGap + spanX(cells, cols), h: spanY(cells, rows) });
/** B：来源卡在顶部居中；外框 = cols 列宽、来源卡那一行加 rows 行高。 */
const topOrigin: Geometry = (cols, rows) => ({ w: spanX(cells, cols), h: spanY(cells, rows + 1) });
/** 这个来源块自己的会话卡占 `cols` 列 × `rows` 行时的外框（不含来源卡）。 */
const blockOf: Geometry = (cols, rows) => ({ w: spanX(cells, cols), h: spanY(cells, rows) });
const shownOf = (box: { w: number; h: number }, area: Area): number => Math.min(1, area.w / box.w, area.h / box.h);
/** `box` 的宽高比离取景区域的宽高比有多远：对数比的绝对值，越小越像。 */
const unlikeOf = (box: { w: number; h: number }, area: Area): number => Math.abs(Math.log(box.w / box.h / (area.w / area.h)));

/**
 * 从 `start`（已有 `cards` 张，按阅读顺序占满前 `cards` 格）起逐张到达，直到 `to` 张：每一张填第一个空格；没有空格就在
 * 新开一行与新开一列之间取更全的（高出 `TIE` 才算更全），持平就看形状（新开一列要好出 `SHAPE_TIE` 以上才选它）。
 * 返回每一张到达之后的形状与看得全的比例。
 */
function simulate(start: Grid & { cards: number }, to: number, geometry: Geometry, area: Area): Map<number, Grid & { shown: number }> {
  let { cols, rows } = start;
  const taken = new Set(Array.from({ length: start.cards }, (_, i) => `${i % cols},${Math.floor(i / cols)}`));
  const out = new Map<number, Grid & { shown: number }>([[start.cards, { cols, rows, shown: shownOf(geometry(cols, rows), area) }]]);
  for (let cards = start.cards + 1; cards <= to; cards++) {
    let cell: [number, number] | undefined;
    for (let r = 0; r < rows && !cell; r++) for (let c = 0; c < cols && !cell; c++) if (!taken.has(`${c},${r}`)) cell = [c, r];
    if (!cell) {
      const column = shownOf(geometry(cols + 1, rows), area);
      const row = shownOf(geometry(cols, rows + 1), area);
      const tied = Math.abs(column - row) <= TIE;
      const byColumn = tied ? unlikeOf(blockOf(cols + 1, rows), area) < unlikeOf(blockOf(cols, rows + 1), area) - SHAPE_TIE : column > row;
      cell = byColumn ? [cols, 0] : [0, rows];
      if (byColumn) cols++;
      else rows++;
    }
    taken.add(`${cell[0]},${cell[1]}`);
    out.set(cards, { cols, rows, shown: shownOf(geometry(cols, rows), area) });
  }
  return out;
}

/** 真实布局里会话卡占的列数与行数（左缘、上缘各自去重）。 */
function gridOf(layout: SceneLayout): Grid {
  const cards = layout.nodes.filter((n) => n.kind === "agent");
  return { cols: new Set(cards.map((n) => n.x)).size, rows: new Set(cards.map((n) => n.y)).size };
}

const actualShown = (layout: SceneLayout, area: Area): number => shownOf(layout.bounds, area);

describe("A 从空来：第 1 个根会话起逐个到达，每一步的形状与看得全的比例与算术参照一致（来源卡在左边）", () => {
  // 编排者表里的线（页面缩放表里 N = 40、60 的目标，全入画口径）：1440×900 65.1% / 53.1%，1920×1080 83.6% / 70.3%，1280×720 49.8% / 41.6%。
  const ANCHORS: Record<string, readonly [number, number]> = { "1440×900": [0.651, 0.531], "1920×1080": [0.836, 0.703], "1280×720": [0.498, 0.416] };

  for (const { name, area } of DESKTOP) {
    it(`${name}：1 → 60 个，每一步形状一致、看得全的比例相差 < 0.5 个百分点`, () => {
      const steps = arrive(roots(KEY, 60), optionsOf(area));
      const expected = simulate({ cols: 1, rows: 1, cards: 1 }, 60, leftOrigin, area);
      steps.forEach((layout, i) => {
        const n = i + 1;
        const want = expected.get(n)!;
        expect(gridOf(layout), `第 ${n} 个到达：列数与行数`).toEqual({ cols: want.cols, rows: want.rows });
        expect(Math.abs(actualShown(layout, area) - want.shown), `第 ${n} 个到达：看得全的比例（参照 ${want.shown.toFixed(4)}）`).toBeLessThan(TOLERANCE);
      });
      const [at40, at60] = ANCHORS[name]!;
      expect(Math.abs(actualShown(steps[39]!, area) - at40), "N = 40").toBeLessThan(0.001);
      expect(Math.abs(actualShown(steps[59]!, area) - at60), "N = 60").toBeLessThan(0.001);
    });
  }
});

describe("B 载入后追加：打开页面时已有 N 个根会话（刷新后的网格），之后逐个再来 30 个（来源卡在顶部居中）", () => {
  // 编排者表里的线（载入 7 / 24 / 40 个再追加 30 个之后的看得全的比例，也是同样张数刷新后的比例）。
  const FINAL: Record<string, readonly [number, number, number]> = {
    "1440×900": [0.66, 0.564, 0.493],
    "1920×1080": [0.836, 0.742, 0.666],
    "1280×720": [0.498, 0.442, 0.397],
  };

  for (const { name, area } of DESKTOP) {
    [7, 24, 40].forEach((load, index) => {
      it(`${name}，先载入 ${load} 个再追加 30 个：每一步形状一致、看得全的比例相差 < 0.5 个百分点`, () => {
        const steps = arrive(roots(KEY, load + 30), optionsOf(area), undefined, load);
        // 载入的那一步是规划排好的网格（列数由规划定），把它当起点；之后每一步都由参照推。
        const start = gridOf(steps[0]!);
        expect(start.cols * start.rows, "载入的网格装得下载入的这些根").toBeGreaterThanOrEqual(load);
        const expected = simulate({ ...start, cards: load }, load + 30, topOrigin, area);
        steps.forEach((layout, i) => {
          const n = load + i;
          const want = expected.get(n)!;
          expect(gridOf(layout), `第 ${n} 个：列数与行数`).toEqual({ cols: want.cols, rows: want.rows });
          expect(Math.abs(actualShown(layout, area) - want.shown), `第 ${n} 个：看得全的比例（参照 ${want.shown.toFixed(4)}）`).toBeLessThan(TOLERANCE);
        });
        expect(Math.abs(actualShown(steps.at(-1)!, area) - FINAL[name]![index]!), "追加 30 个之后").toBeLessThan(0.001);
      });
    });
  }
});
