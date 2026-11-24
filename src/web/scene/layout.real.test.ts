import { describe, expect, it } from "vitest";
import { fitScale, holdScale, layoutScene, MIN_ZOOM, type SceneLayout } from "./layout";
import { FIT_ALL_MIN_ZOOM, type Area } from "./layout-geometry";
import { overlapsOf } from "./layout.fixtures";
import { REAL_CANVASES, realSessions, type RealCanvas } from "./layout.real.fixtures";

/**
 * 六张真实画布（layout.real.fixtures.ts：123 / 60 / 42 / 40 / 25 / 8 个节点）× 三种窗口 × 默认排布与“重置节点布局”时的三种缩放：
 * 2026-11-22 用户反馈“排得不整齐、缩得很小、一条竖串”时手里的那几张。
 * 数字都是量出来的：断言的下限留了余量，跌破它说明排布退步了；各个格子的实测值见当时的验收表。
 */

/** 取景区域：1440×900、1920×1080、1280×720 的窗口扣掉侧栏与留白之后（与 Overview 的取景一致）。 */
const WINDOWS: readonly (readonly [string, Area])[] = [
  ["1440×900", { w: 1088, h: 710 }],
  ["1920×1080", { w: 1568, h: 890 }],
  ["1280×720", { w: 928, h: 530 }],
];

/** 重置时的缩放：100%、36%、20%；`undefined` 是默认排布（不给缩放上限）。 */
const MODES: readonly (number | undefined)[] = [undefined, 1, 0.36, 0.2];

const layoutOf = (canvas: RealCanvas, area: Area, zoom?: number): SceneLayout =>
  layoutScene(realSessions(canvas), { area, grid: true, hideContextNodes: true, ...(zoom === undefined ? {} : { zoom }) });

const rawScale = (layout: SceneLayout, area: Area): number => Math.min(area.w / layout.bounds.w, area.h / layout.bounds.h);

/** 统一网格上限：同样多张 248×112 的卡、行列距都取 24，在取景区域里排成最合适的 c × r 网格能得到的缩放，封顶 100%。 */
const uniformBound = (count: number, area: Area): number => {
  let best = 0;
  for (let c = 1; c <= count; c++) {
    const r = Math.ceil(count / c);
    best = Math.max(best, Math.min(1, area.w / (c * 248 + (c - 1) * 24), area.h / (r * 112 + (r - 1) * 24)));
  }
  return best;
};

const label = (canvas: RealCanvas, window: string, zoom?: number): string => `${canvas.name} · ${window} · ${zoom === undefined ? "默认" : `保持 ${Math.round(zoom * 100)}%`}`;

/** 会话 ≥ 12 个的五张：对外框形状与效率有要求；只有 7 个会话的 71e659dc 单独测。 */
const MANY = REAL_CANVASES.filter((canvas) => canvas.parents.length >= 12);

describe("真实画布 · 排布", () => {
  it("六张画布都在，节点数与记录一致（含来源卡）", () => {
    expect(REAL_CANVASES.map((canvas) => canvas.name)).toEqual(["70b49d0d", "7295d4f1", "299997f3", "88e325d7", "7c1805af", "71e659dc"]);
    expect(REAL_CANVASES.map((canvas) => canvas.parents.length + 1)).toEqual([123, 60, 42, 40, 25, 8]);
  });

  it("所有格子都排成规则网格、没有任何两张卡重叠", () => {
    for (const canvas of REAL_CANVASES) {
      for (const [window, area] of WINDOWS) {
        for (const zoom of MODES) {
          const layout = layoutOf(canvas, area, zoom);
          expect(layout.grid, label(canvas, window, zoom)).toBe(true);
          expect(overlapsOf(layout), label(canvas, window, zoom)).toEqual([]);
        }
      }
    }
  });

  it("全部节点都在取景里：默认排布按“全部入画”的缩放，保持缩放按保持后的缩放（允许量化取景区域的 1.5%）", () => {
    for (const canvas of REAL_CANVASES) {
      for (const [window, area] of WINDOWS) {
        for (const zoom of MODES) {
          const layout = layoutOf(canvas, area, zoom);
          const shown = zoom === undefined ? fitScale(layout.bounds, area, MIN_ZOOM, true) : holdScale(layout.bounds, area, zoom);
          expect(layout.bounds.w * shown, label(canvas, window, zoom)).toBeLessThanOrEqual(area.w * 1.0151);
          expect(layout.bounds.h * shown, label(canvas, window, zoom)).toBeLessThanOrEqual(area.h * 1.0151);
        }
      }
    }
  });

  it("重置时保持当前缩放：放得下一个百分点都不缩；放不下才缩到刚好放下，最低 16%", () => {
    for (const canvas of REAL_CANVASES) {
      for (const [window, area] of WINDOWS) {
        for (const hold of [1, 0.36, 0.2]) {
          const layout = layoutOf(canvas, area, hold);
          const raw = rawScale(layout, area);
          const shown = holdScale(layout.bounds, area, hold);
          if (raw >= hold * 0.985) expect(shown, label(canvas, window, hold)).toBe(hold);
          else expect(shown, label(canvas, window, hold)).toBeCloseTo(Math.max(FIT_ALL_MIN_ZOOM, raw), 9);
        }
      }
    }
  });

  it("缩放不会比统一网格上限差太多：五张多会话的画布 ≥ 80%（实测 84% ~ 100%），70b49d0d（原来 84% ~ 87%）不退步", () => {
    for (const canvas of MANY) {
      for (const [window, area] of WINDOWS) {
        const layout = layoutOf(canvas, area, 1);
        const scale = Math.min(1, rawScale(layout, area));
        const ratio = scale / uniformBound(canvas.parents.length + 1, area);
        expect(ratio, `${label(canvas, window, 1)}：缩放 ${(scale * 100).toFixed(0)}%`).toBeGreaterThanOrEqual(canvas.name === "70b49d0d" ? 0.9 : 0.8);
      }
    }
  });

  it("外框的宽高比贴着取景区域：会话多的五张都在 0.7 ~ 1/0.7 倍之内（实测 0.88 ~ 1.20）", () => {
    for (const canvas of MANY) {
      for (const [window, area] of WINDOWS) {
        const layout = layoutOf(canvas, area);
        const ratio = layout.bounds.w / layout.bounds.h / (area.w / area.h);
        expect(ratio, label(canvas, window)).toBeGreaterThanOrEqual(0.7);
        expect(ratio, label(canvas, window)).toBeLessThanOrEqual(1 / 0.7);
      }
    }
  });

  it("没有一张画布排成一条竖串：列数不少于 4（71e659dc 的 7 个单卡是 3 列加居中的来源卡，数列数时来源卡占一个横坐标）", () => {
    for (const canvas of REAL_CANVASES) {
      for (const [window, area] of WINDOWS) {
        const layout = layoutOf(canvas, area);
        const columns = new Set(layout.nodes.map((node) => node.x)).size;
        expect(columns, label(canvas, window)).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it("71e659dc（只有 7 个根会话）保持原来的样子：来源卡居中在最上面，7 个会话排成三列、每列 3 + 2 + 2 张（与改版前的截图一致），三种窗口下都是 100% 缩放", () => {
    const canvas = REAL_CANVASES.find((candidate) => candidate.name === "71e659dc")!;
    for (const [window, area] of WINDOWS) {
      const layout = layoutOf(canvas, area);
      const origin = layout.nodes.find((node) => node.kind === "origin")!;
      const agents = layout.nodes.filter((node) => node.kind === "agent");
      const perColumn = new Map<number, number>();
      for (const agent of agents) perColumn.set(agent.x, (perColumn.get(agent.x) ?? 0) + 1);
      expect([...perColumn].sort((a, b) => a[0] - b[0]).map(([, count]) => count), window).toEqual([3, 2, 2]);
      expect(Math.min(...agents.map((agent) => agent.y)) - origin.y, window).toBe(136);
      const left = Math.min(...agents.map((agent) => agent.x));
      const right = Math.max(...agents.map((agent) => agent.x + agent.w));
      expect(origin.x + origin.w / 2, window).toBe((left + right) / 2);
      expect(layout.fitAll, window).toBeUndefined();
    }
  });
});
