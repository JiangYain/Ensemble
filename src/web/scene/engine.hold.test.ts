import type { SessionSummary } from "@shared/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agent, DESK, kidsOf, moved, NARROW, roots, spot } from "./arrival.fixtures";
import { at, mountScene, POSITIONS_KEY, stored, type SceneRig } from "./engine.fixtures";
import { layoutScene, type SceneLayout } from "./layout";
import { node, session } from "./layout.fixtures";
import { FIT_FLOOR } from "./layout-geometry";

/**
 * 引擎与“已有的卡原地不动、新卡进下一个空位”（arrival-hold.ts）的接线（LAYOUT2 · W4）：
 * 交给引擎的都是真实的 `layoutScene` 规划，读的是节点元素上此刻的位置——也就是用户眼前看到的。
 * 纯函数层的细节在 arrival-hold.test.ts 与 arrival-memory.test.ts，这里只验引擎怎么用它。
 */

const a = (n: number): SessionSummary[] => roots("cursor:a", n);
type Spot = { x: number; y: number };

/** 让节点与相机的弹簧落定（新节点从上游“长”出来，要走一小会儿）。 */
const settle = (): void => {
  vi.advanceTimersByTime(4000);
};

/** 与页面一致：布局里没有的节点卸载（元素注销），新节点先挂元素再交布局，然后落定。 */
function show(rig: SceneRig, layout: SceneLayout): SceneLayout {
  const keep = new Set(layout.nodes.map((n) => n.id));
  for (const [id, release] of [...rig.releases]) {
    if (keep.has(id)) continue;
    release();
    rig.releases.delete(id);
    rig.els.get(id)?.remove();
    rig.els.delete(id);
  }
  for (const spec of layout.nodes) if (!rig.els.has(spec.id)) rig.attach(spec.id);
  rig.engine.setLayout(layout);
  settle();
  return layout;
}

/** 画布上此刻每个节点的位置（节点元素的 `translate`）。 */
const spotsOf = (rig: SceneRig, ids: readonly string[]): Map<string, Spot> => new Map(ids.map((id): [string, Spot] => [id, at(rig.els.get(id) as HTMLElement)]));
/** 规划给每个节点的位置（没有持有逻辑时画布上应有的样子）。 */
const plannedSpots = (layout: SceneLayout, ids: readonly string[]): Map<string, Spot> => new Map(ids.map((id): [string, Spot] => [id, { x: node(layout, id).x, y: node(layout, id).y }]));
const idsOf = (layout: SceneLayout): string[] => layout.nodes.map((n) => n.id);
/** `before` 里位置在 `after` 中不一样的节点。 */
const drift = (before: Map<string, Spot>, after: Map<string, Spot>): string[] => [...before].filter(([id, p]) => after.get(id)?.x !== p.x || after.get(id)?.y !== p.y).map(([id]) => id);
const overlap = (p: Spot, q: Spot): boolean => p.x < q.x + 248 && q.x < p.x + 248 && p.y < q.y + 112 && q.y < p.y + 112;

describe("引擎：已有的卡原地不动，新卡进下一个空位", () => {
  let rig: SceneRig | undefined;
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
  });
  afterEach(() => {
    rig?.dispose();
    rig = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
    localStorage.clear();
  });

  it("追加根会话：已有的卡一像素不动，新卡落在下一格；规划换了取景把格子排成别的样子也一样，也不写进手动位置", () => {
    const first = layoutScene(a(60), DESK);
    rig = mountScene(first);
    settle();
    const ids = idsOf(first);
    const before = spotsOf(rig, ids);
    const next = layoutScene(a(61), NARROW);
    expect(moved(first, next).length, "前提：规划把已有的卡排到了别处").toBeGreaterThan(0);

    show(rig, next);
    expect(drift(before, spotsOf(rig, ids))).toEqual([]);
    const last = before.get(agent("r60")) as Spot;
    expect(at(rig.els.get(agent("r61")) as HTMLElement)).toEqual({ x: last.x + 280, y: last.y });
    expect(localStorage.getItem(POSITIONS_KEY)).toBeNull();
  });

  it("一张接一张地追加：每一步已有的卡都不动", () => {
    rig = mountScene(layoutScene(a(60), DESK));
    settle();
    let ids = idsOf(layoutScene(a(60), DESK));
    for (let n = 61; n <= 70; n++) {
      const before = spotsOf(rig, ids);
      const layout = show(rig, layoutScene(a(n), n % 2 ? DESK : NARROW));
      expect(drift(before, spotsOf(rig, ids)), `r${n}`).toEqual([]);
      ids = idsOf(layout);
    }
  });

  it("子会话长在已有的家族里：接在上一个子会话的下面，家族外的卡不动", () => {
    const family = (kids: number): SessionSummary[] => [...a(5), session("f", "cursor:a", 9), ...kidsOf("cursor:a", "f", kids, 10)];
    const first = layoutScene(family(5), DESK);
    rig = mountScene(first);
    settle();
    const ids = idsOf(first);
    const before = spotsOf(rig, ids);
    const next = layoutScene([...family(5), session("k6", "cursor:a", 40, { parentSessionId: "f" })], DESK);
    expect(moved(first, next).length, "前提：规划把家族重新折了一遍").toBeGreaterThan(5);

    show(rig, next);
    expect(drift(before, spotsOf(rig, ids))).toEqual([]);
    const last = before.get(agent("k5")) as Spot;
    expect(at(rig.els.get(agent("k6")) as HTMLElement)).toEqual({ x: last.x, y: last.y + 136 });
  });

  it("“重置节点布局”：所有卡回到规划的整体排布（与全新规划一致），不再持有此前的位置", () => {
    rig = mountScene(layoutScene(a(60), DESK));
    settle();
    const next = show(rig, layoutScene(a(61), NARROW));
    const ids = idsOf(next);
    expect(drift(plannedSpots(next, ids), spotsOf(rig, ids)).length, "前提：持有的位置与规划不同").toBeGreaterThan(0);

    rig.engine.resetLayout();
    settle();
    expect(drift(plannedSpots(next, ids), spotsOf(rig, ids))).toEqual([]);
  });

  it("点“重置节点布局”之后排布缩放变了：Overview 带着新缩放重算的规划整体采用，不被持有", () => {
    // 三个来源 6 / 7 / 5 个会话：缩放上限 0.5 时规划换成了另一种排法（别的缩放下与默认的一样）。
    const sessions = [...roots("cursor:a", 6, 1, "a"), ...roots("cursor:b", 7, 100, "b"), ...roots("cursor:c", 5, 200, "c")];
    const first = layoutScene(sessions, DESK);
    rig = mountScene(first);
    settle();
    rig.engine.resetLayout();
    settle();
    const zoomed = layoutScene(sessions, { ...DESK, zoom: 0.5 });
    expect(moved(first, zoomed).length, "前提：缩放上限不同，规划也不同").toBeGreaterThan(0);

    show(rig, zoomed);
    const ids = idsOf(zoomed);
    expect(drift(plannedSpots(zoomed, ids), spotsOf(rig, ids))).toEqual([]);
  });

  it("切换空间：新空间的第一份布局整体排，不沿用上一个空间的排布", () => {
    rig = mountScene(layoutScene(a(60), DESK));
    settle();
    const grown = show(rig, layoutScene(a(61), NARROW));
    const ids = idsOf(grown);
    expect(drift(plannedSpots(grown, ids), spotsOf(rig, ids)).length, "前提：持有的位置与规划不同").toBeGreaterThan(0);

    rig.engine.switchSpace("cursor:other");
    const other = show(rig, layoutScene(a(61), NARROW));
    expect(drift(plannedSpots(other, ids), spotsOf(rig, ids))).toEqual([]);
  });

  it("隐藏一部分会话再显示回来：回到隐藏之前的排布，而不是换成规划的另一种排法", () => {
    const sessions = a(60);
    rig = mountScene(layoutScene(a(40), DESK));
    settle();
    const grown = show(rig, layoutScene(sessions, NARROW));
    const ids = idsOf(grown);
    const before = spotsOf(rig, ids);

    const visible = new Set(sessions.slice(0, 45).map((s) => s.id));
    show(rig, layoutScene(sessions, { ...NARROW, visible }));
    const back = show(rig, layoutScene(sessions, NARROW));
    expect(drift(before, spotsOf(rig, ids))).toEqual([]);
    expect(drift(plannedSpots(back, ids), before).length, "前提：复原的排布与规划不同").toBeGreaterThan(0);
  });

  it("用户拖到下一格上的卡当作障碍：新卡避开它并记下位置，其余的卡（含被拖的）不动", () => {
    const first = layoutScene(a(60), DESK);
    rig = mountScene(first);
    settle();
    const slot = spot(first, agent("r60"));
    const target = { x: slot.x + 280, y: slot.y };
    const home = at(rig.els.get(agent("r1")) as HTMLElement);
    rig.engine.moveNode(agent("r1"), target.x - home.x, target.y - home.y);
    settle();
    const ids = idsOf(first);
    const before = spotsOf(rig, ids);
    expect(before.get(agent("r1"))).toEqual(target);

    show(rig, layoutScene(a(61), DESK));
    expect(drift(before, spotsOf(rig, ids))).toEqual([]);
    const placed = at(rig.els.get(agent("r61")) as HTMLElement);
    expect(overlap(placed, target)).toBe(false);
    expect(stored()[agent("r61")]).toEqual(placed);
  });

  it("聚焦页回到概览（画布卸载再挂载）：沿用持有的排布，不会被换成规划的", () => {
    rig = mountScene(layoutScene(a(60), DESK));
    settle();
    const grown = show(rig, layoutScene(a(61), NARROW));
    const ids = idsOf(grown);
    const before = spotsOf(rig, ids);

    rig.engine.unmount();
    rig.engine.mount({ viewport: rig.viewport, world: rig.world, pipes: { tube: rig.tube, dots: rig.dots } });
    settle();
    expect(drift(before, spotsOf(rig, ids))).toEqual([]);

    // 重放不是新规划：此后点“重置节点布局”，拿到的仍是真正的规划，所有卡回到规划的排布。
    rig.engine.resetLayout();
    settle();
    expect(drift(plannedSpots(grown, ids), spotsOf(rig, ids))).toEqual([]);
  });

  it("页面刷新（新的引擎、没有记忆）：整体重排，坐标就是全新规划的——已知后果：可以与实时追加出来的排布不同", () => {
    rig = mountScene(layoutScene(a(60), DESK));
    settle();
    const next = show(rig, layoutScene(a(61), NARROW));
    const ids = idsOf(next);
    const live = spotsOf(rig, ids);
    rig.dispose();

    rig = mountScene(next);
    settle();
    const refreshed = spotsOf(rig, ids);
    expect(drift(plannedSpots(next, ids), refreshed)).toEqual([]);
    expect(drift(live, refreshed).length).toBeGreaterThan(0);
  });

  it("onArrangement：持有的排布与规划不同时通知 true（没拖过节点也要能点“重新排列”），点重置之后通知 false；规划本身稳定时不会误报 true", () => {
    rig = mountScene(layoutScene(a(7), DESK));
    settle();
    const onArrangement = vi.fn();
    rig.engine.unmount();
    rig.engine.mount({ viewport: rig.viewport, world: rig.world, pipes: { tube: rig.tube, dots: rig.dots }, onArrangement });
    settle();

    const stable = show(rig, layoutScene(a(8), DESK));
    expect(drift(plannedSpots(stable, idsOf(stable)), spotsOf(rig, idsOf(stable))), "前提：画布上的位置就是规划的").toEqual([]);
    expect(onArrangement).toHaveBeenCalled();
    expect(onArrangement.mock.calls.every(([drifted]) => drifted === false)).toBe(true);

    show(rig, layoutScene(a(60), DESK));
    const grown = show(rig, layoutScene(a(61), NARROW));
    const ids = idsOf(grown);
    expect(drift(plannedSpots(grown, ids), spotsOf(rig, ids)).length, "前提：画布上的位置与规划的不同").toBeGreaterThan(0);
    expect(onArrangement).toHaveBeenLastCalledWith(true);

    rig.engine.resetLayout();
    settle();
    expect(drift(plannedSpots(grown, ids), spotsOf(rig, ids))).toEqual([]);
    expect(onArrangement).toHaveBeenLastCalledWith(false);
  });

  it("onArrangement：画布卸载再挂载时引擎重放持有的排布，也要把有没有东西可排告诉新挂上来的一方（聚焦页回到概览）", () => {
    // 重放就发生在 mount 里：此时页面还没有交来新的规划，拿到的只能是持有的排布自己的状态。
    rig = mountScene(layoutScene(a(60), DESK));
    settle();
    show(rig, layoutScene(a(61), NARROW));
    const drifted = vi.fn();
    rig.engine.unmount();
    rig.engine.mount({ viewport: rig.viewport, world: rig.world, pipes: { tube: rig.tube, dots: rig.dots }, onArrangement: drifted });
    expect(drifted, "排布与规划不同：挂载时通知一次").toHaveBeenCalledTimes(1);
    expect(drifted).toHaveBeenLastCalledWith(true);

    rig.dispose();
    rig = mountScene(layoutScene(a(8), DESK));
    settle();
    const calm = vi.fn();
    rig.engine.unmount();
    rig.engine.mount({ viewport: rig.viewport, world: rig.world, pipes: { tube: rig.tube, dots: rig.dots }, onArrangement: calm });
    expect(calm, "排布就是规划本身：挂载时通知一次").toHaveBeenCalledTimes(1);
    expect(calm).toHaveBeenLastCalledWith(false);
  });

  it("取景跟着持有的排布走：一列经典排布长到几十个，缩放停在可读下限，不会缩到“全部入画”那么小", () => {
    rig = mountScene(layoutScene(a(1), DESK));
    settle();
    const plan = layoutScene(a(43), DESK);
    expect(plan.fitAll, "前提：规划要求全部入画").toBe(true);

    show(rig, plan);
    expect(rig.engine.getCamera().k).toBeGreaterThanOrEqual(FIT_FLOOR - 1e-9);
  });
});
