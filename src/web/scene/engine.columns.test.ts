import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { optionsOf, WINDOWS } from "./arrival.columns.fixtures";
import { agent, roots } from "./arrival.fixtures";
import { at, mountScene, POSITIONS_KEY, stored, type SceneRig } from "./engine.fixtures";
import { layoutScene, MIN_ZOOM, type Area, type SceneLayout } from "./layout";
import { node } from "./layout.fixtures";

/**
 * 引擎与根会话到达时“先填空格、再长一行或另起一列”（LAYOUT6，规则见 arrival-grow.ts；此前是 LAYOUT3 · W6 的“竖排满了另起一列”）的接线：交给引擎的都是真实的 `layoutScene` 规划，取景区域是 Overview 交给 `setLayout` 的那份；
 * 读的是节点元素此刻的位置——用户眼前看到的。纯几何与持有逻辑的细节在 arrival-columns*.test.ts，这里只验引擎怎么用它。
 */

const KEY = "cursor:a";
const AREA: Area = WINDOWS[0]!.area;
const OPTIONS = optionsOf(AREA);
const a = (n: number) => roots(KEY, n);
type Spot = { x: number; y: number };

/** 让节点与相机的弹簧落定（新节点从上游“长”出来，要走一小会儿）。 */
const settle = (): void => {
  vi.advanceTimersByTime(4000);
};

/** 与页面一致：新节点先挂元素再交布局（带着取景区域），然后落定。 */
function show(rig: SceneRig, layout: SceneLayout, area?: Area): SceneLayout {
  for (const spec of layout.nodes) if (!rig.els.has(spec.id)) rig.attach(spec.id);
  rig.engine.setLayout(layout, false, area);
  settle();
  return layout;
}

const spotsOf = (rig: SceneRig, ids: readonly string[]): Map<string, Spot> => new Map(ids.map((id): [string, Spot] => [id, at(rig.els.get(id) as HTMLElement)]));
const idsOf = (layout: SceneLayout): string[] => layout.nodes.map((n) => n.id);
const drift = (before: Map<string, Spot>, after: Map<string, Spot>): string[] => [...before].filter(([id, p]) => after.get(id)?.x !== p.x || after.get(id)?.y !== p.y).map(([id]) => id);
const overlap = (p: Spot, q: Spot): boolean => p.x < q.x + 248 && q.x < p.x + 248 && p.y < q.y + 112 && q.y < p.y + 112;
const plannedSpots = (layout: SceneLayout, ids: readonly string[]): Map<string, Spot> => new Map(ids.map((id): [string, Spot] => [id, { x: node(layout, id).x, y: node(layout, id).y }]));

/** 第 `from` 到第 `to` 个根会话逐个到达，每一步都带着取景区域；返回最后一份规划。 */
function arriveRoots(rig: SceneRig, from: number, to: number, area: Area | undefined): SceneLayout {
  let last = layoutScene(a(from), OPTIONS);
  for (let k = from + 1; k <= to; k++) last = show(rig, layoutScene(a(k), OPTIONS), area);
  return last;
}

describe("引擎：根会话一个个到达，先填空格、再长一行或另起一列", () => {
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

  it("交了取景区域：第 6 个根会话落在第二列的第三格，前 5 个一像素不动，也不写进手动位置；第二列是第 3 个另起的、紧挨着第一列", () => {
    rig = mountScene(layoutScene(a(1), OPTIONS));
    settle();
    const five = arriveRoots(rig, 1, 5, AREA);
    const ids = idsOf(five);
    const before = spotsOf(rig, ids);
    // 旧：前 5 个竖成一列（r5 在 (304, 544)），第 6 个另起一列落在 (584, 0)；现在两种长法一样全时按形状长（LAYOUT8），前 5 个是 3 行 × 2 列。
    expect(before.get(agent("r5")), "前提：前 5 个是 3 行 × 2 列，r5 在第一列第三行").toEqual({ x: 304, y: 272 });
    expect(before.get(agent("r3")), "新列紧挨着上一列：列距就是格距（280）").toEqual({ x: 304 + 280, y: 0 });

    show(rig, layoutScene(a(6), OPTIONS), AREA);
    expect(drift(before, spotsOf(rig, ids))).toEqual([]);
    expect(at(rig.els.get(agent("r6")) as HTMLElement), "第二列的第三格").toEqual({ x: 304 + 280, y: 272 });
    expect(localStorage.getItem(POSITIONS_KEY)).toBeNull();
  });

  it("不交取景区域（改动前的调用）：仍接在上一个的下面，一列到底", () => {
    rig = mountScene(layoutScene(a(1), OPTIONS));
    settle();
    arriveRoots(rig, 1, 6, undefined);
    show(rig, layoutScene(a(7), OPTIONS), undefined);
    expect(at(rig.els.get(agent("r7")) as HTMLElement)).toEqual({ x: 304, y: 816 });
  });

  it("一路到达 20 个：每一步已有的卡都不动，长成四列（6、6、6、2）", () => {
    rig = mountScene(layoutScene(a(1), OPTIONS));
    settle();
    let ids = idsOf(layoutScene(a(1), OPTIONS));
    for (let n = 2; n <= 20; n++) {
      const before = spotsOf(rig, ids);
      const layout = show(rig, layoutScene(a(n), OPTIONS), AREA);
      expect(drift(before, spotsOf(rig, ids)), `r${n}`).toEqual([]);
      ids = idsOf(layout);
    }
    // 第 3 个另起第二列 (584, 0)，第 6 个填它的第三格；第 11 个另起第三列（两列各排满 5 行之后）。
    expect(at(rig.els.get(agent("r3")) as HTMLElement)).toEqual({ x: 584, y: 0 });
    expect(at(rig.els.get(agent("r6")) as HTMLElement)).toEqual({ x: 584, y: 272 });
    expect(at(rig.els.get(agent("r11")) as HTMLElement)).toEqual({ x: 864, y: 0 });
    // 旧：r17 另起第四列 (1144, 0)、r20 在 (1144, 3 * 136)（形状 5、5、6、4）。现在先填空格：16 个长第六行（从最左起），
    // 17、18 个补满这一行，第 19 个才另起第四列、20 个接在它下面。
    expect(at(rig.els.get(agent("r16")) as HTMLElement)).toEqual({ x: 304, y: 680 });
    expect(at(rig.els.get(agent("r17")) as HTMLElement)).toEqual({ x: 584, y: 680 });
    expect(at(rig.els.get(agent("r19")) as HTMLElement)).toEqual({ x: 1144, y: 0 });
    expect(at(rig.els.get(agent("r20")) as HTMLElement)).toEqual({ x: 1144, y: 136 });
  });

  it("用户拖到新卡落点上的卡当作障碍：新卡避开它并记下位置，其余的卡（含被拖的）不动", () => {
    rig = mountScene(layoutScene(a(1), OPTIONS));
    settle();
    const five = arriveRoots(rig, 1, 5, AREA);
    // 第 6 个根会话要去的格子：第二列的第三格（旧：新列的顶 (584, 0)）。持有的排布不认用户拖的位置，规则照旧给这一格，由引擎避开。
    const slot = { x: 584, y: 272 };
    const home = at(rig.els.get(agent("r1")) as HTMLElement);
    rig.engine.moveNode(agent("r1"), slot.x - home.x, slot.y - home.y);
    settle();
    const ids = idsOf(five);
    const before = spotsOf(rig, ids);
    expect(before.get(agent("r1"))).toEqual(slot);

    show(rig, layoutScene(a(6), OPTIONS), AREA);
    expect(drift(before, spotsOf(rig, ids))).toEqual([]);
    const placed = at(rig.els.get(agent("r6")) as HTMLElement);
    expect(overlap(placed, slot), "新卡压在了被拖来的卡上").toBe(false);
    expect(stored()[agent("r6")]).toEqual(placed);
  });

  it("“重置节点布局”：所有卡回到规划的整体排布（与全新规划一致），长出来的几列不再持有", () => {
    rig = mountScene(layoutScene(a(1), OPTIONS));
    settle();
    const grown = arriveRoots(rig, 1, 20, AREA);
    const ids = idsOf(grown);
    const plan = layoutScene(a(20), OPTIONS);
    expect(drift(plannedSpots(plan, ids), spotsOf(rig, ids)).length, "前提：长出来的排布与规划不同").toBeGreaterThan(0);

    rig.engine.resetLayout();
    settle();
    expect(drift(plannedSpots(plan, ids), spotsOf(rig, ids))).toEqual([]);
  });

  it("相机：没动过时自动取景照旧，缩放落在可读范围里；用户动过之后再开两列，相机不会自己跳", () => {
    rig = mountScene(layoutScene(a(1), OPTIONS));
    settle();
    arriveRoots(rig, 1, 7, AREA);
    const auto = rig.engine.getCamera().k;
    expect(auto).toBeGreaterThanOrEqual(MIN_ZOOM - 1e-9);
    expect(auto).toBeLessThanOrEqual(1);

    rig.engine.zoomBy(0.9);
    settle();
    const mine = { ...rig.engine.getCamera() };
    expect(rig.engine.isUserMoved()).toBe(true);
    for (let k = 8; k <= 20; k++) show(rig, layoutScene(a(k), OPTIONS), AREA);
    expect(at(rig.els.get(agent("r19")) as HTMLElement), "前提：第四列开出来了（r7 时是两列，之后又开了两列）").toEqual({ x: 1144, y: 0 });
    expect(rig.engine.getCamera()).toEqual(mine);
  });
});
