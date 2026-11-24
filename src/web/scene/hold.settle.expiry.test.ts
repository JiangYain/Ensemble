import type { SessionSummary } from "@shared/types";
import { describe, expect, it } from "vitest";
import { HeldLayout } from "./arrival-memory";
import { moved } from "./arrival.fixtures";
import { layoutScene, type Area, type SceneLayout } from "./layout";
import { REAL_CANVASES, realSessions } from "./layout.real.fixtures";

/**
 * 暂定的整体重排（hold-settle.ts）的时间窗守的是“外壳切换时的一两帧、几十毫秒”这个量级，而不是某个具体的常量：
 * hold.window.test.ts 拿 `SETTLE_MS` 本身与它加 1 当边界，常量改成什么它都跟着走——把 600 改成 600000，整个套件仍然全绿，
 * 于是用户隔了几分钟再拖动窗口，已有的卡也会被重新排一遍。这里写死毫秒数：
 * 过渡的两次量取之间（几十毫秒）必须还能校正；翻转一秒以后区域再变（用户在拖动窗口、折叠侧栏），已有的卡必须原地不动。
 */

const FINAL: Area = { w: 1088, h: 704 }; // 1440×900 的窗口、宽外壳（侧栏 240）
const AT_800: Area = { w: 688, h: 656 }; // 800×900，窄外壳（顶栏）：宽 688 < 720 → 紧凑
const TRANSIENT: Area = { w: 1328, h: 656 }; // 800 → 1440 时外壳还没换好的第一次量取
const LATER: Area = { w: 1248, h: 656 }; // 翻转之后区域又变成的另一个宽屏值

const planOf = (sessions: readonly SessionSummary[], area: Area): SceneLayout => layoutScene(sessions, { area, grid: true, hideContextNodes: true });
const positionsOf = (layout: SceneLayout): string[] => layout.nodes.map((n) => `${n.id}@${n.x},${n.y}`);

/** 照引擎的做法驱动 `HeldLayout`（时钟由测试拨）：1440 → 800 → 过渡值翻转，过了 `wait` 毫秒区域再变成 LATER。 */
function afterFlip(wait: number) {
  const sessions = realSessions(REAL_CANVASES.find((canvas) => canvas.name === "70b49d0d")!);
  let now = 0;
  const held = new HeldLayout(() => now);
  const seen = new Set<string>();
  const show = (area: Area, at: number): { plan: SceneLayout; shown: SceneLayout } => {
    now = at;
    const plan = planOf(sessions, area);
    const shown = held.apply(plan, (id) => seen.has(id), area);
    for (const node of plan.nodes) seen.add(node.id);
    return { plan, shown };
  };
  show(FINAL, 0);
  show(AT_800, 1000);
  const flipped = show(TRANSIENT, 2000);
  const later = show(LATER, 2000 + wait);
  return { sessions, flipped, later };
}

describe("暂定的时间窗：写死的毫秒数守住量级", () => {
  it.each([16, 100, 300])("翻转之后 %ims（过渡的第二次量取）区域变了：校正，用这一次的规划", (wait) => {
    const { sessions, flipped, later } = afterFlip(wait);
    expect(positionsOf(planOf(sessions, LATER)), "前提：规划随区域变").not.toEqual(positionsOf(flipped.shown));
    expect(later.shown).toBe(later.plan);
  });

  it.each([1_000, 5_000, 60_000])("翻转之后 %ims（用户在拖动窗口）区域变了：已有的卡原地不动", (wait) => {
    const { sessions, flipped, later } = afterFlip(wait);
    expect(positionsOf(planOf(sessions, LATER)), "前提：规划随区域变").not.toEqual(positionsOf(flipped.shown));
    expect(later.shown).not.toBe(later.plan);
    expect(moved(flipped.shown, later.shown)).toEqual([]);
  });
});
