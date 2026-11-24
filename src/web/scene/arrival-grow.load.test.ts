import { describe, expect, it } from "vitest";
import { arrive, optionsOf, WINDOWS } from "./arrival.columns.fixtures";
import { moved, roots } from "./arrival.fixtures";
import { fitScale, layoutScene, MIN_ZOOM, type Area, type SceneLayout } from "./layout";
import { overlapsOf } from "./layout.fixtures";

/**
 * 载入后追加（LAYOUT6 的 B）：打开页面时已经有 7 / 24 / 40 个根会话（刷新后的规则网格），之后主 Agent 又一个个派来 30 个。
 * 以前列数从载入那一刻起就固定了，新卡只往下长（载入 7 个再来 30 个是 3 列 × 13 行，缩到 38%，同样 37 个刷新后是 6 列 × 7 行、66%）；
 * 现在追加的根会话与逐个到达用同一条规则，每一步都不挪已有的卡、不重叠，缩放不低于同样张数刷新后的排布（容差 1 个百分点），
 * 形状也不比刷新后高出一行以上。“刷新后”就是把前 k 个根会话一次交给 `layoutScene` 规划出来的那份。
 */

const KEY = "cursor:a";
/** 允许比刷新后低多少：1 个百分点。 */
const SLACK = 0.01;
const DESKTOP = WINDOWS.slice(0, 3);

/** 页面此刻的缩放：与引擎同口径（格点排布或全入画的布局带着标记，按全入画取景）。 */
const pageZoom = (layout: SceneLayout, area: Area): number => fitScale(layout.bounds, area, MIN_ZOOM, layout.grid === true || layout.fitAll === true);
const cardsOf = (layout: SceneLayout) => layout.nodes.filter((n) => n.kind === "agent");
const colsOf = (layout: SceneLayout): number => new Set(cardsOf(layout).map((n) => n.x)).size;
const rowsOf = (layout: SceneLayout): number => new Set(cardsOf(layout).map((n) => n.y)).size;

describe.each(DESKTOP)("载入后追加 30 个：$name", ({ area }) => {
  const options = optionsOf(area);

  for (const load of [7, 24, 40]) {
    it(`先载入 ${load} 个：每一步位移 0、不重叠，缩放不低于刷新后 − 1 个百分点，形状不比刷新后高出一行以上`, () => {
      const all = roots(KEY, load + 30);
      const steps = arrive(all, options, undefined, load);
      expect(steps).toHaveLength(31);
      steps.forEach((layout, i) => {
        const k = load + i;
        const fresh = layoutScene(all.slice(0, k), options);
        const before = steps[i - 1];
        if (before) expect(moved(before, layout), `第 ${k} 个到达：已有的卡动了`).toEqual([]);
        expect(overlapsOf(layout), `第 ${k} 个到达：重叠`).toEqual([]);
        expect(cardsOf(layout), `第 ${k} 个到达：会话卡张数`).toHaveLength(k);
        expect(pageZoom(layout, area), `第 ${k} 个到达：缩放（刷新后 ${pageZoom(fresh, area).toFixed(4)}）`).toBeGreaterThanOrEqual(pageZoom(fresh, area) - SLACK);
        expect(rowsOf(layout), `第 ${k} 个到达：行数（刷新后 ${rowsOf(fresh)}）`).toBeLessThanOrEqual(rowsOf(fresh) + 1);
      });
    });

    it(`先载入 ${load} 个：不再是“列数固定、一路往下”——追加到 ${load + 30} 个时列数比载入时多（以前不变），行数不超过列数加 2（以前行数是列数的 2 倍以上）`, () => {
      const all = roots(KEY, load + 30);
      const steps = arrive(all, options, undefined, load);
      const loaded = steps[0]!;
      const last = steps.at(-1)!;
      expect(colsOf(last), `列数：载入时 ${colsOf(loaded)}`).toBeGreaterThan(colsOf(loaded));
      // 旧：载入 7 个再来 30 个是 3 列 × 13 行（行数是列数的 4 倍多）；现在的形状接近方形。
      expect(rowsOf(last), "行数不超过列数加 2").toBeLessThanOrEqual(colsOf(last) + 2);
    });
  }
});
