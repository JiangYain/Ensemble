import type { SessionSummary } from "@shared/types";
import { describe, expect, it } from "vitest";
import { HeldLayout } from "./arrival-memory";
import { COMPACT, DESK, moved, NARROW, roots } from "./arrival.fixtures";
import { driftsFromPlan } from "./hold-drift";
import { layoutScene, type LayoutOptions, type SceneLayout } from "./layout";

/**
 * “重置节点布局”按钮什么时候该出现（LAYOUT5 · W15）：持有的排布与同一次的全新规划按**内容**不一样，才算漂移。
 *
 * 用户看到的现象是第一次到达之后按钮就出现。根因不是“引用不等而内容相等”——`holdLayout` 在没有任何坐标不同时返回的就是规划本身，
 * 引用比较与内容比较在持有的排布里本来就一致；真正的原因是第二个根会话到来时，规划把来源卡居中到两个会话之间（y 差 68），
 * 持有的排布里来源卡留在原位，两张会话卡却与规划逐像素相同：按钮是为一张来源卡出现的。
 * 现在只比会话卡（来源、Folder、Git 卡的位置是跟着会话居中出来的，见 hold-drift.ts），于是这一步不漂移。
 */

const a = (n: number): SessionSummary[] => roots("cursor:a", n);

/** 与引擎的做法一致：先把规划交给 `apply`（此刻“早就知道的节点”是之前出现过的），之后才把这一批记成已知。 */
function stage(area?: LayoutOptions["area"]) {
  const held = new HeldLayout();
  const seen = new Set<string>();
  return {
    held,
    show(sessions: readonly SessionSummary[], options: LayoutOptions): { plan: SceneLayout; shown: SceneLayout } {
      const plan = layoutScene(sessions, options);
      const shown = held.apply(plan, (id) => seen.has(id), area ?? options.area);
      for (const node of plan.nodes) seen.add(node.id);
      return { plan, shown };
    },
  };
}

/** 与规划位置不同的会话卡。 */
const agentsMoved = (plan: SceneLayout, shown: SceneLayout): string[] => moved(plan, shown).filter((id) => id.startsWith("agent:"));

describe("HeldLayout.drifted · 按内容判断（只看会话卡）", () => {
  it("1 个、2 个根逐个到达：不漂移——n=2 时只有来源卡与规划不同（规划把它居中到两个会话之间），会话卡逐像素相同", () => {
    const { held, show } = stage();
    const one = show(a(1), DESK);
    expect(one.shown, "n=1 就是规划本身").toBe(one.plan);
    expect(held.drifted).toBe(false);

    const two = show(a(2), DESK);
    expect(moved(two.plan, two.shown), "前提：持有的排布不是规划本身，不同的只有来源卡").toEqual(["origin:cursor:a"]);
    expect(two.shown).not.toBe(two.plan);
    expect(held.drifted, "对象引用不等、内容（会话卡）相等").toBe(false);
  });

  it("再来一个根（3 个）：规划换成格点排布，持有的是一竖列——会话卡的位置确实与规划不同，漂移", () => {
    const { held, show } = stage();
    show(a(1), DESK);
    show(a(2), DESK);
    const three = show(a(3), DESK);
    expect(agentsMoved(three.plan, three.shown).length, "前提：会话卡与规划不同").toBeGreaterThan(0);
    expect(held.drifted).toBe(true);
  });

  it("逐个到达到另起新列：每一步 drifted 恰好等于“有会话卡与规划不同”（三种取景区域、各 40 步）", () => {
    for (const [name, options] of [["宽屏", DESK], ["竖屏", NARROW], ["紧凑", COMPACT]] as const) {
      const { held, show } = stage();
      let drifts = 0;
      for (let n = 1; n <= 40; n++) {
        const step = show(a(n), options);
        const differs = agentsMoved(step.plan, step.shown).length > 0;
        expect(held.drifted, `${name} n=${n}`).toBe(differs);
        if (differs) drifts++;
      }
      expect(drifts, `${name}：这 40 步里持有的排布确实偏离过规划`).toBeGreaterThan(0);
    }
  });

  it("整体重排之后不漂移：重置之后的下一次布局、卡的尺寸体系翻转（紧凑 ↔ 宽屏）引起的整体重排", () => {
    const { held, show } = stage();
    show(a(40), DESK);
    const grown = show(a(60), NARROW);
    expect(held.drifted, "前提：先漂移").toBe(true);
    expect(held.reset()).toBe(grown.plan);
    expect(held.drifted).toBe(false);
    held.apply(grown.plan, () => true);
    expect(held.drifted).toBe(false);

    const flip = stage();
    flip.show(a(20), COMPACT);
    flip.show(a(21), COMPACT);
    const wide = flip.show(a(21), DESK);
    expect(wide.shown, "前提：尺寸体系变了，整体重排，交出去的就是规划").toBe(wide.plan);
    expect(flip.held.drifted).toBe(false);
  });

  it("隐藏再显示：隐藏期间的整体重排不漂移；复原出来的排布若不同于规划，漂移回来；复原的就是规划本身，则不漂移", () => {
    const drifting = stage();
    drifting.show(a(40), DESK);
    drifting.show(a(60), NARROW);
    expect(drifting.held.drifted).toBe(true);
    const hidden = drifting.show(a(45), NARROW);
    expect(hidden.shown).toBe(hidden.plan);
    expect(drifting.held.drifted).toBe(false);
    const back = drifting.show(a(60), NARROW);
    expect(agentsMoved(back.plan, back.shown).length, "前提：复原的排布与规划不同").toBeGreaterThan(0);
    expect(drifting.held.drifted).toBe(true);

    const calm = stage();
    const full = calm.show(a(8), DESK);
    calm.show(a(5), DESK);
    const restored = calm.show(a(8), DESK);
    expect(moved(full.shown, restored.shown), "前提：复原得与隐藏前一样").toEqual([]);
    expect(calm.held.drifted).toBe(false);
  });

  it("引擎重放交出去的布局（同一个对象再交进来）：原样放行，drifted 不变；reset 之后是 false", () => {
    const { held, show } = stage();
    show(a(40), DESK);
    const grown = show(a(60), NARROW);
    expect(held.drifted).toBe(true);
    expect(held.apply(grown.shown, () => true)).toBe(grown.shown);
    expect(held.drifted, "重放不重新判断").toBe(true);

    const calm = stage();
    const settled = calm.show(a(8), DESK);
    expect(calm.held.apply(settled.shown, () => true)).toBe(settled.shown);
    expect(calm.held.drifted).toBe(false);

    held.reset();
    expect(held.drifted).toBe(false);
  });
});

describe("driftsFromPlan · 纯函数", () => {
  const plan = layoutScene(a(6), DESK);

  it("同一个对象、或坐标逐个相同的另一个对象：不漂移", () => {
    expect(driftsFromPlan(plan, plan)).toBe(false);
    expect(driftsFromPlan({ ...plan, nodes: plan.nodes.map((node) => ({ ...node })) }, plan)).toBe(false);
  });

  it("任何一张会话卡的 x 或 y 不同：漂移", () => {
    const first = plan.nodes.findIndex((node) => node.kind === "agent");
    for (const [dx, dy] of [[4, 0], [0, 4]] as const) {
      const nodes = plan.nodes.map((node, i) => (i === first ? { ...node, x: node.x + dx, y: node.y + dy } : node));
      expect(driftsFromPlan({ ...plan, nodes }, plan), `(${dx}, ${dy})`).toBe(true);
    }
  });

  it("只有来源卡的位置不同：不漂移（它是跟着会话居中出来的）", () => {
    const nodes = plan.nodes.map((node) => (node.kind === "origin" ? { ...node, y: node.y + 68 } : node));
    expect(driftsFromPlan({ ...plan, nodes }, plan)).toBe(false);
  });

  it("节点对不上（个数不同、或同一位置上的 id 不同）：漂移", () => {
    expect(driftsFromPlan({ ...plan, nodes: plan.nodes.slice(1) }, plan)).toBe(true);
    const swapped = plan.nodes.map((node, i) => (i === 0 ? { ...node, id: `${node.id}-other` } : node));
    expect(driftsFromPlan({ ...plan, nodes: swapped }, plan)).toBe(true);
  });
});
