import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { optionsOf, WINDOWS } from "./arrival.columns.fixtures";
import { agent, roots } from "./arrival.fixtures";
import { at, mountScene, stored, type SceneRig } from "./engine.fixtures";
import { layoutScene, type Area, type SceneLayout } from "./layout";

/**
 * 拖进“下一个空位”之后，后来的新卡继续按下一个空位填（LAYOUT4 · W10）：引擎、持有逻辑与 `placement.ts` 的接线。
 * 以前的现象：12 个根（3 列 × 4 行）载入后，用户把一张卡拖进下一个空位 (0, 680)，之后到达的卡全部沿第一列往下接
 * （(0, 816)、(0, 952)……），旁边的 (280, 680)、(560, 680) 空着。根因在 `planArrivals`：新卡的锚点是“上一个根会话”，
 * 引擎把让开之后的落点也记进了手动位置（与用户拖的同一张表），下一张卡就跟在这张被记下的卡下面，一路往下堆。
 * 现在锚点只在“偏移描述了布局里的真实几何”时才跟（见 `describes`）。读的是节点元素此刻的位置——用户眼前看到的。
 * LAYOUT6 起根会话先填空格、再长一行或另起一列（arrival-grow.ts），这个窗口里 12 个根之后的下一个空位是第四列的列顶 (840, 136)，
 * 不再是新一行的最左格 (0, 680)；下面各条按新的空位改写，守的还是同一件事：被拖进下一个空位的卡不被压、后来的卡不一路往下接。
 */

const AREA: Area = WINDOWS[0]!.area;
const OPTIONS = optionsOf(AREA);
const a = (n: number) => roots("cursor:a", n);
type Spot = { x: number; y: number };

const settle = (): void => {
  vi.advanceTimersByTime(4000);
};

/** 与页面一致：新节点先挂元素再交布局（带着取景区域），然后落定。 */
function show(rig: SceneRig, layout: SceneLayout): SceneLayout {
  for (const spec of layout.nodes) if (!rig.els.has(spec.id)) rig.attach(spec.id);
  rig.engine.setLayout(layout, false, AREA);
  settle();
  return layout;
}

const spotOf = (rig: SceneRig, id: string): Spot => at(rig.els.get(agent(id)) as HTMLElement);
const overlap = (p: Spot, q: Spot): boolean => p.x < q.x + 248 && q.x < p.x + 248 && p.y < q.y + 112 && q.y < p.y + 112;

describe("拖进“下一个空位”之后：后来的卡继续按下一个空位填", () => {
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

  /** 12 个根一次载入（刷新后的现状），用户把 `victim` 拖到 `to`，之后第 13 到 `last` 个根逐个到达。返回每个根最终的位置。 */
  function run(victim: string, to: Spot | undefined, last: number): Map<string, Spot> {
    rig = mountScene(layoutScene(a(12), OPTIONS));
    settle();
    if (to) {
      const home = spotOf(rig, victim);
      rig.engine.moveNode(agent(victim), to.x - home.x, to.y - home.y);
      settle();
    }
    let ids = a(12).map((s) => s.id);
    for (let n = 13; n <= last; n++) {
      const before = new Map(ids.map((id): [string, Spot] => [id, spotOf(rig as SceneRig, id)]));
      show(rig, layoutScene(a(n), OPTIONS));
      for (const [id, spot] of before) expect(spotOf(rig, id), `第 ${n} 个到达时 ${id} 动了`).toEqual(spot);
      ids = a(n).map((s) => s.id);
    }
    return new Map(ids.map((id): [string, Spot] => [id, spotOf(rig as SceneRig, id)]));
  }

  // LAYOUT6：下一个空位不再是“第一列下面的新一行”（旧：(0, 680)）。12 个根把外框撑到 808 × 656，窗口 1088 × 710：
  // 再长一行（高 792）整体要缩到约 90%，另起第四列（宽 1088）恰好放得下、仍是 100%，所以第 13 个落在第四列的列顶 (840, 136)。
  it("前提：12 个根是 3 列 × 4 行，下一个空位在 (840, 136)——第四列的列顶", () => {
    const spots = run("r12", undefined, 12);
    expect(new Set([...spots.values()].map((p) => p.x))).toEqual(new Set([0, 280, 560]));
    expect(Math.max(...[...spots.values()].map((p) => p.y))).toBe(544);
    expect(run("r12", undefined, 13).get("r13")).toEqual({ x: 840, y: 136 });
  });

  for (const victim of ["r12", "r1"]) {
    it(`把 ${victim} 拖进 (840, 136) 之后再来 8 个根：不压拖进来的卡，让到它下面的新卡之后，下一行的空位一格一格填、不是一路往下接`, () => {
      const spots = run(victim, { x: 840, y: 136 }, 20);
      expect(spots.get(victim), "被拖的卡留在用户放的地方").toEqual({ x: 840, y: 136 });
      const fresh = Array.from({ length: 8 }, (_, i) => `r${13 + i}`);
      const placed = fresh.map((id) => spots.get(id) as Spot);
      for (const [i, id] of fresh.entries()) {
        for (const [other, spot] of spots) if (other !== id) expect(overlap(placed[i]!, spot), `${id} 压在 ${other} 上`).toBe(false);
      }
      const byColumn = new Map<number, number>();
      for (const spot of placed) byColumn.set(spot.x, (byColumn.get(spot.x) ?? 0) + 1);
      expect([...byColumn.keys()].sort((p, q) => p - q), "新卡用到的列").toEqual([0, 280, 560, 840]);
      // 旧：每列新增不超过 3 张（三列、下一个空位是新一行的最左格）。现在被拖的卡占的是新列的列顶，新列的四个格子（再让一格）
      // 都得有新卡来填，所以新列最多接 5 张；以前的一条竖到底是 8 张。
      expect(Math.max(...byColumn.values()), "任何一列新增的张数（以前一条竖到底是 8 张）").toBeLessThanOrEqual(5);
      // r13 本该落的槽位 (840, 136) 被拖来的卡占了，让到它下面；之后每一张的槽位 (840, 272)、(840, 408)、(840, 544) 恰好是前一张让开后的落点，
      // 依次再让一格——都在新列里，一格不乱；新的一行开出来之后（r17 起）槽位是 (0, 680)、(280, 680)、(560, 680)，一格一格填，没有谁沿着第四列往下接。
      expect(spots.get("r13")).toEqual({ x: 840, y: 272 });
      expect(spots.get("r14")).toEqual({ x: 840, y: 408 });
      expect(spots.get("r15")).toEqual({ x: 840, y: 544 });
      expect(spots.get("r16")).toEqual({ x: 840, y: 680 });
      expect(spots.get("r17")).toEqual({ x: 0, y: 680 });
      expect(spots.get("r18")).toEqual({ x: 280, y: 680 });
      expect(spots.get("r19")).toEqual({ x: 560, y: 680 });
      expect(spots.get("r20")).toEqual({ x: 840, y: 816 });
    });
  }

  it("被拖的是最后一张时：它留下的空格（560, 544）没有被占，也没有谁一条竖到底", () => {
    const spots = run("r12", { x: 840, y: 136 }, 20);
    const ys = [...spots.values()].filter((p) => p.x === 0).map((p) => p.y).sort((p, q) => p - q);
    // 旧：第一列自上而下 [136, 272, 408, 544, 680, 816, 952, 1088]（8 张，被拖的卡在 (0, 680)）；现在第一列只有原来的 4 张加新的一行里的一张。
    expect(ys, "第一列自上而下").toEqual([136, 272, 408, 544, 680]);
    expect([...spots.values()].some((p) => p.x === 560 && p.y === 544), "它留下的空格没有被占").toBe(false);
    expect(new Set([...spots.values()].map((p) => `${p.x},${p.y}`)).size, "没有两张卡在同一格").toBe(spots.size);
  });

  it("普通拖动：拖到不与任何格子重合的地方，之后到达的新卡与没拖时的位置逐点相同，也不被记成手动位置", () => {
    const plain = run("r12", undefined, 20);
    rig?.dispose();
    document.body.replaceChildren();
    localStorage.clear();
    const dragged = run("r12", { x: 1800, y: 60 }, 20);
    expect(dragged.get("r12")).toEqual({ x: 1800, y: 60 });
    for (let n = 13; n <= 20; n++) expect(dragged.get(`r${n}`), `r${n}`).toEqual(plain.get(`r${n}`));
    expect(Object.keys(stored()), "只有被拖的那张是手动位置，新卡落在布局给的槽位上、没有被记下").toEqual([agent("r12")]);
  });
});
