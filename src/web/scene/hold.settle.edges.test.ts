import type { SessionSummary } from "@shared/types";
import { describe, expect, it } from "vitest";
import { HeldLayout } from "./arrival-memory";
import { moved } from "./arrival.fixtures";
import { layoutScene, type Area, type SceneLayout } from "./layout";
import { REAL_CANVASES, realSessions } from "./layout.real.fixtures";

/**
 * 暂定整体重排（W13）的两条边界：变异检查里没有测试盯住的两处（VLAYOUT3 · V3-11 的 MA4 / MA5）。
 * 做法与 hold.window.test.ts 相同：直接驱动 `HeldLayout`，时钟是假的。
 */
const FINAL: Area = { w: 1088, h: 704 };
const TRANSIENT: Area = { w: 1328, h: 656 };
const AT_800: Area = { w: 688, h: 656 };
const WIDE_SHORT: Area = { w: 1328, h: 704 }; // 宽外壳里的另一个区域：88e325d7 在 1328×704 下的规划与 1088×704 不同

const planOf = (sessions: readonly SessionSummary[], area: Area): SceneLayout => layoutScene(sessions, { area, grid: true, hideContextNodes: true });
const positionsOf = (layout: SceneLayout): string[] => layout.nodes.map((n) => `${n.id}@${n.x},${n.y}`);

function stage(sessions: readonly SessionSummary[]) {
  let now = 0;
  const held = new HeldLayout(() => now);
  const seen = new Set<string>();
  return {
    held,
    show(area: Area, at: number, list: readonly SessionSummary[] = sessions): { plan: SceneLayout; shown: SceneLayout } {
      now = at;
      const plan = planOf(list, area);
      const shown = held.apply(plan, (id) => seen.has(id), area);
      for (const node of plan.nodes) seen.add(node.id);
      return { plan, shown };
    },
  };
}

const sessionsOf = (name: string): readonly SessionSummary[] => realSessions(REAL_CANVASES.find((c) => c.name === name)!);

describe("暂定整体重排的边界", () => {
  it("暂定窗口内同一个区域重复到来（比如状态更新引起的重排）不消耗修正次数：随后的最终区域仍被修正到与刷新一致", () => {
    const sessions = sessionsOf("88e325d7");
    const run = stage(sessions);
    run.show(FINAL, 0);
    run.show(AT_800, 1000);
    run.show(TRANSIENT, 2000); // 尺寸体系翻转：暂定
    run.show(TRANSIENT, 2005);
    run.show(TRANSIENT, 2010);
    run.show(TRANSIENT, 2015);
    const back = run.show(FINAL, 2030);
    expect(positionsOf(back.shown)).toEqual(positionsOf(planOf(sessions, FINAL)));
  });

  it("暂定窗口内某个会话的上级变了：暂定作废，之后窗口内的区域变化原地不动", () => {
    const sessions = sessionsOf("88e325d7");
    const run = stage(sessions);
    run.show(FINAL, 0);
    run.show(AT_800, 1000);
    run.show(TRANSIENT, 2000); // 尺寸体系翻转：暂定
    const idx = sessions.findIndex((s) => s.parentSessionId);
    expect(idx, "前提：这块画布里有带上级的会话").toBeGreaterThanOrEqual(0);
    const reparented = sessions.map((s, i) => {
      if (i !== idx) return s;
      const { parentSessionId: _a, parentSessionIds: _b, ...rest } = s;
      return rest as SessionSummary;
    });
    const changed = run.show(FINAL, 2100, reparented);
    expect(positionsOf(planOf(reparented, WIDE_SHORT)), "前提：规划随区域变").not.toEqual(positionsOf(planOf(reparented, FINAL)));
    const after = run.show(WIDE_SHORT, 2200, reparented);
    expect(moved(changed.shown, after.shown)).toEqual([]);
  });
});
