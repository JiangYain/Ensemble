import type { SessionSummary } from "@shared/types";
import { describe, expect, it } from "vitest";
import { layoutScene, type Area, type SceneLayout } from "./layout";
import { session } from "./layout.fixtures";

/**
 * 规划式排布里“经典排法与格点排布二选一”的两条门槛（layout-scene-select.ts 的 `tryLattice`）：
 *  · 经典的树放不进缩放上限时，格点要比它的缩放**明显更大（超过 1%）**才换；
 *  · 经典的树放得进缩放上限（只是细长、或是一列单卡）时，格点也得放得进缩放上限才换，不能拿一个要缩小才放得下的网格换掉一个放得下的树。
 * layout.fill.test.ts、layout.stacked.test.ts 里格点与经典总是差得很远，两条门槛的边界没人守着：
 * 把 `* 1.01` 改成 `* 1.0`，或把 `real >= cap` 整个换成“放得下就直接换”，旧套件都照样全绿。
 * 下面的数字都是实测：格点与经典的缩放之比随取景区域的宽度线性变化，每个像素差约 0.1%~0.3%，一两个像素就能跨过边界。
 */

const KEY = "cursor:a";
const options = { grid: true, hideContextNodes: true } as const;

const rawScale = (layout: SceneLayout, area: Area): number => Math.min(area.w / layout.bounds.w, area.h / layout.bounds.h);
const distinct = (values: readonly number[]): number => new Set(values).size;
const columnsOf = (layout: SceneLayout): number => distinct(layout.nodes.filter((n) => n.kind === "agent").map((n) => n.x));

/** 同一来源名下 `count` 个互不相干的根会话。 */
const singles = (count: number): SessionSummary[] => Array.from({ length: count }, (_, i) => session(`s${i + 1}`, KEY, i + 1));

/** `rootsN` 个根会话，每个带 `kidsN` 个子会话。 */
function forest(rootsN: number, kidsN: number): SessionSummary[] {
  const out: SessionSummary[] = [];
  let order = 1;
  for (let r = 1; r <= rootsN; r++) {
    out.push(session(`r${r}`, KEY, order++));
    for (let k = 1; k <= kidsN; k++) out.push(session(`r${r}k${k}`, KEY, order++, { parentSessionId: `r${r}` }));
  }
  return out;
}

describe("layoutScene · 经典放不下时，格点要明显更大（超过 1%）才换", () => {
  // 3 个根会话各带 2 个子会话（共 9 个），取景区域高 720、默认缩放上限 1：经典的树放不进 100%（缩放约 0.90）。
  // 格点放得进的缩放恒为 0.9091（高度受限：720 / 792）；经典的缩放随宽度变（宽度受限，宽 811 起也到 0.9091）：
  // 宽度每少一个像素，格点相对经典就多大约 0.13%——宽 803 是 0.99%，802 是 1.11%。
  const sessions = forest(3, 2);
  const at = (w: number): SceneLayout => layoutScene(sessions, { area: { w, h: 720 }, ...options });

  it.each([
    [810, "0.11%"],
    [807, "0.48%"],
    [803, "0.99%"],
  ])("宽 %i：格点只比经典大 %s（不到 1%）：保持经典的树", (w) => {
    const layout = at(w);
    expect(layout.grid).toBeUndefined();
    expect(layout.fitAll, "前提：经典在 100% 下放不下，走的是“要明显更大”这一条").toBe(true);
    expect(rawScale(layout, { w, h: 720 })).toBeLessThan(0.9091);
  });

  it.each([
    [802, "1.11%"],
    [800, "1.36%"],
    [798, "1.62%"],
  ])("宽 %i：格点比经典大 %s（超过 1%）：换成格点", (w) => {
    const layout = at(w);
    expect(layout.grid).toBe(true);
    expect(layout.fitAll).toBe(true);
    expect(rawScale(layout, { w, h: 720 })).toBeCloseTo(0.9091, 4);
  });

  it("宽 811 ~ 822：经典也到 0.9091，与格点一样大，更不换", () => {
    for (const w of [811, 816, 822]) {
      const layout = at(w);
      expect(layout.grid, `宽 ${w}`).toBeUndefined();
      expect(rawScale(layout, { w, h: 720 }), `宽 ${w}`).toBeCloseTo(0.9091, 4);
    }
  });
});

describe("layoutScene · 经典放得下时，格点也得放得下缩放上限才换", () => {
  // 3 个单卡根会话：横屏（宽 ≥ 高）里它们不保留成一列，要试格点（见 layout.stacked.test.ts）。
  // 经典的一列宽 386、高 384；格点最窄的一种形态宽 440——取景区域比 440 窄、又放得下经典的一列（高 ≥ 384、宽 ≥ 高才是横屏）时，
  // 格点放不进 100%，而经典放得进：保持经典的一列。宽 440 正好放得进（缩放恰为 1），就换。
  const sessions = singles(3);
  const at = (w: number, h: number, zoom?: number): SceneLayout => layoutScene(sessions, { area: { w, h }, ...options, ...(zoom === undefined ? {} : { zoom }) });

  it.each([400, 420, 439])("取景区域 %i × 400：经典的一列放得进 100%，格点最窄也要 440 宽、放不进：保持经典的一列", (w) => {
    const layout = at(w, 400);
    expect(layout.grid).toBeUndefined();
    expect(layout.fitAll).toBeUndefined();
    expect(columnsOf(layout)).toBe(1);
    expect(rawScale(layout, { w, h: 400 }), "经典的一列放得进 100%").toBeGreaterThanOrEqual(1);
  });

  it.each([440, 460])("取景区域 %i × 400：格点放得进 100%（宽 440 正好是 1）：换成格点", (w) => {
    const layout = at(w, 400);
    expect(layout.grid).toBe(true);
    expect(layout.fitAll).toBeUndefined();
    expect(columnsOf(layout), "不再是一列").toBeGreaterThan(1);
    expect(rawScale(layout, { w, h: 400 })).toBeGreaterThanOrEqual(1);
    if (w === 440) expect(layout.bounds.w, "前提：格点最窄的形态就是 440 宽").toBe(440);
  });

  it.each([
    [672, false],
    [704, true],
  ])("缩放上限 1.6、取景区域 %i × 640：格点放得进 1.6 倍才换（440 × 1.6 = 704）= %s", (w, swaps) => {
    const layout = at(w, 640, 1.6);
    expect(layout.grid).toBe(swaps ? true : undefined);
    expect(rawScale(layout, { w, h: 640 }), "放得进缩放上限").toBeGreaterThanOrEqual(1.6);
  });
});
