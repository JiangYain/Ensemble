import type { SessionSummary } from "@shared/types";
import { describe, expect, it } from "vitest";
import { HeldLayout } from "./arrival-memory";
import { DESK, moved, NARROW, roots } from "./arrival.fixtures";
import { layoutScene, type LayoutOptions, type SceneLayout } from "./layout";
import { session } from "./layout.fixtures";

/**
 * 引擎持有的“上一次排布”（LAYOUT2 · W4）：重放原样放行、重置之后整体重排、隐藏再显示原样复原。
 * `stage` 模拟引擎的做法：先把规划交给 `apply`（此刻“早就知道的节点”是之前出现过的），之后才把这一批记成已知。
 */
function stage() {
  const held = new HeldLayout();
  const seen = new Set<string>();
  return {
    held,
    show(sessions: readonly SessionSummary[], options: LayoutOptions): { plan: SceneLayout; shown: SceneLayout } {
      const plan = layoutScene(sessions, options);
      const shown = held.apply(plan, (id) => seen.has(id));
      for (const node of plan.nodes) seen.add(node.id);
      return { plan, shown };
    },
  };
}

const a = (n: number): SessionSummary[] => roots("cursor:a", n);

describe("HeldLayout · 第一次与重放", () => {
  it("第一次就是规划本身；把交出去的布局原样再交进来（引擎重放）原样放行", () => {
    const { held, show } = stage();
    const first = show(a(8), DESK);
    expect(first.shown).toBe(first.plan);
    expect(held.apply(first.shown, () => true)).toBe(first.shown);
  });

  it("持有的布局（不同于规划的那个）被重放时也原样放行，而且不会被当成新的规划去改记忆", () => {
    const { held, show } = stage();
    show(a(40), DESK);
    const grown = show(a(60), NARROW);
    expect(grown.shown, "前提：持有的布局不是规划本身").not.toBe(grown.plan);
    expect(held.apply(grown.shown, () => true)).toBe(grown.shown);
    // 重放不是新规划：“重置”要拿到的仍是真正的原始规划，而不是持有的这个布局（否则重置就什么也不会重排）。
    expect(held.reset()).toBe(grown.plan);
    // 重放之后再长一张：仍相对“持有的布局”，已有的卡不动。
    const again = stage();
    again.show(a(40), DESK);
    const regrown = again.show(a(60), NARROW);
    again.held.apply(regrown.shown, () => true);
    const next = again.show(a(61), NARROW);
    expect(moved(regrown.shown, next.shown)).toEqual([]);
  });
});

describe("HeldLayout · reset（换空间、点“重置节点布局”）", () => {
  it("还没有过规划时没有东西可返回", () => {
    expect(new HeldLayout().reset()).toBeUndefined();
  });

  it("返回最近一次的原始规划；之后的第一次布局整体重排，坐标就是规划的", () => {
    const { held, show } = stage();
    show(a(60), DESK);
    const grown = show(a(61), NARROW);
    expect(moved(grown.plan, grown.shown).length, "前提：持有的坐标与规划不同").toBeGreaterThan(0);

    const raw = held.reset();
    expect(raw).toBe(grown.plan);
    expect(held.apply(raw as SceneLayout, () => true)).toBe(grown.plan);
    // 重置之后记忆是新的：再多一张卡，已有的卡以重排后的为准。
    const after = show(a(62), NARROW);
    expect(moved(grown.plan, after.shown)).toEqual([]);
  });

  it("重置之后快照也清空了：隐藏再显示不会把重置之前的排法找回来", () => {
    const { held, show } = stage();
    show(a(40), DESK);
    const grown = show(a(60), NARROW);
    held.reset();
    show(a(60), NARROW);
    show(a(45), NARROW);
    const back = show(a(60), NARROW);
    expect(moved(grown.shown, back.shown).length).toBeGreaterThan(0);
    expect(back.shown).toBe(back.plan);
  });
});

describe("HeldLayout · 隐藏再显示：原样复原", () => {
  /** 持有的排布（40 个格点排布里长出 20 个、取景换成了竖屏）不同于规划，才看得出“复原”与“重排”的差别。 */
  function grownArrangement() {
    const run = stage();
    run.show(a(40), DESK);
    const grown = run.show(a(60), NARROW);
    expect(grown.shown, "前提：持有的排布不是规划本身").not.toBe(grown.plan);
    return { ...run, grown };
  }

  it("少了一些卡（整体重排），再显示回来：回到隐藏之前的排布，而不是换成规划的", () => {
    const { show, grown } = grownArrangement();
    const hidden = show(a(45), NARROW);
    expect(hidden.shown).toBe(hidden.plan);
    const back = show(a(60), NARROW);
    expect(moved(grown.shown, back.shown)).toEqual([]);
    expect(moved(back.plan, back.shown).length, "前提：复原的排布与规划不同").toBeGreaterThan(0);
  });

  it("某个会话的上级变了：快照不再成立，用规划", () => {
    const { show } = grownArrangement();
    show(a(45), NARROW);
    const reparented = [...a(59), session("r60", "cursor:a", 60, { parentSessionId: "r1" })];
    const back = show(reparented, NARROW);
    expect(back.shown).toBe(back.plan);
  });

  it("节点集合变了（隐藏期间多了一张没见过的卡）：用隐藏之前的快照复原，新卡落进下一个空位，不整体重排", () => {
    const { show, grown } = grownArrangement();
    show(a(45), NARROW);
    const back = show(a(61), NARROW);
    // 61 张里有 60 张是快照里的：没有 61 张的快照，但 60 张的那份节点全在规划里，快照之外的那一张当新卡（LAYOUT5 · W12，细节见 hold.restore.test.ts）。
    expect(moved(grown.shown, back.shown)).toEqual([]);
    expect(back.shown).not.toBe(back.plan);
  });

  it("快照只记最近 8 份：隔了 7 份别的排布仍能复原，隔了 8 份就被挤掉了", () => {
    for (const [others, restored] of [[7, true], [8, false]] as const) {
      const { show, grown } = grownArrangement();
      for (let size = 1; size <= others; size++) show(a(size), NARROW);
      const back = show(a(60), NARROW);
      expect(moved(grown.shown, back.shown).length === 0, `隔了 ${others} 份`).toBe(restored);
    }
  });
});

describe("HeldLayout · drifted：“重新排列”有没有东西可排", () => {
  it("还没有过规划、第一次布局、规划没有重排已有的卡（交出去的就是规划本身）都是 false", () => {
    const { held, show } = stage();
    expect(held.drifted).toBe(false);
    show(a(7), DESK);
    expect(held.drifted).toBe(false);
    const stable = show(a(8), DESK);
    expect(stable.shown, "前提：规划没有重排已有的卡").toBe(stable.plan);
    expect(held.drifted).toBe(false);
  });

  it("持有的布局与规划不同才是 true；重放原样放行时不变；重置之后又是 false，下一次整体规划也是 false", () => {
    const { held, show } = stage();
    show(a(40), DESK);
    const grown = show(a(60), NARROW);
    expect(grown.shown, "前提：持有的布局不是规划本身").not.toBe(grown.plan);
    expect(held.drifted).toBe(true);
    held.apply(grown.shown, () => true);
    expect(held.drifted).toBe(true);
    held.reset();
    expect(held.drifted).toBe(false);
    show(a(60), NARROW);
    expect(held.drifted).toBe(false);
  });

  it("隐藏再显示复原出来的排布不同于规划：仍是持有的排布，true；隐藏期间的整体重排是 false", () => {
    const { held, show } = stage();
    show(a(40), DESK);
    show(a(60), NARROW);
    show(a(45), NARROW);
    expect(held.drifted).toBe(false);
    const back = show(a(60), NARROW);
    expect(back.shown, "前提：复原的排布与规划不同").not.toBe(back.plan);
    expect(held.drifted).toBe(true);
  });
});
