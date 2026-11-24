import { describe, expect, it } from "vitest";
import { cellsFor } from "./layout-cells";
import { NODE } from "./layout-geometry";
import { isSlender, planLattice, type LatticeCluster, type LatticeInput } from "./layout-plan";

/**
 * 格点排布的规划入口（layout-plan.ts）：合成的树与取景区域，不经过 layoutScene。
 * layoutScene 里“经典还是格点”的取舍在 layout.lattice.test.ts 里测，这里只测规划本身与细长判断。
 */

const kidsFrom =
  (tree: Record<string, readonly string[]>) =>
  (id: string): readonly string[] =>
    tree[id] ?? [];

const singles = (count: number): Record<string, string[]> => ({ o: Array.from({ length: count }, (_, i) => `s${i + 1}`) });

const one = (weight: number): LatticeCluster[] => [{ keys: ["o"], lead: 0, weight }];

const plan = (tree: Record<string, readonly string[]>, extra: Partial<LatticeInput> = {}) =>
  planLattice({
    area: { w: 1088, h: 610 },
    compact: false,
    blocks: [{ key: "o", originId: "o" }],
    kidsOf: kidsFrom(tree),
    clusters: one(Object.keys(tree).length + 1),
    ...extra,
  });

describe("isSlender · 经典的树放得下时它是不是一条细长的串", () => {
  // 取景区域宽高比 2。
  const area = { w: 1000, h: 500 };

  it("会话少（不足 12）：只有竖串才算，比取景区域窄到 0.55 倍以下；横向的短串是树本来的样子，不算", () => {
    expect(isSlender({ w: 100, h: 300 }, area, 5)).toBe(true);
    expect(isSlender({ w: 215, h: 200 }, area, 5)).toBe(true); // 1.075 / 2 = 0.5375
    expect(isSlender({ w: 220, h: 200 }, area, 5)).toBe(false); // 1.1 / 2 = 0.55，不小于 0.55
    expect(isSlender({ w: 300, h: 100 }, area, 5)).toBe(false); // 3 / 2 = 1.5：又宽又矮，不算
  });

  it("会话多（12 个起）：两个方向都要在 0.7 ~ 1 / 0.7 倍之内，窄了宽了都算", () => {
    expect(isSlender({ w: 240, h: 200 }, area, 12)).toBe(true); // 1.2 / 2 = 0.6
    expect(isSlender({ w: 280, h: 200 }, area, 12)).toBe(false); // 0.7
    expect(isSlender({ w: 400, h: 200 }, area, 12)).toBe(false); // 1.0
    expect(isSlender({ w: 284, h: 100 }, area, 12)).toBe(false); // 2.84 / 2 = 1.42
    expect(isSlender({ w: 288, h: 100 }, area, 12)).toBe(true); // 2.88 / 2 = 1.44
    expect(isSlender({ w: 288, h: 100 }, area, 11)).toBe(false); // 少一个就回到“只看竖串”
  });

  it("外框没有宽或没有高（空画布）不算细长", () => {
    expect(isSlender({ w: 0, h: 100 }, area, 20)).toBe(false);
    expect(isSlender({ w: 100, h: 0 }, area, 20)).toBe(false);
  });
});

describe("planLattice · 规划", () => {
  it("没有可排的组：没有结果", () => {
    expect(plan(singles(3), { clusters: [] })).toBeUndefined();
  });

  it("一个来源块：给出放进取景区域的缩放，来源卡与每个会话各有一个位置，整体偏移在原点", () => {
    const lattice = plan(singles(7))!;
    expect(lattice.scale).toBeGreaterThan(0);
    expect(lattice.offsets).toEqual([{ x: 0, y: 0 }]);
    const placed = lattice.positions("o");
    expect([...placed.keys()].sort()).toEqual(["o", "s1", "s2", "s3", "s4", "s5", "s6", "s7"]);
  });

  it("来源卡与左边 Folder / Git 卡的间距、竖直叠放的间距都按当前模式的格距给（常规 68 / 24，紧凑 20 / 16）", () => {
    const regular = plan(singles(3))!;
    expect(regular.leadGap).toBe(cellsFor(false).pitchX - NODE.folderW);
    expect(regular.stackGap).toBe(24);
    const compact = plan(singles(3), { compact: true })!;
    expect(compact.leadGap).toBe(cellsFor(true).pitchX - NODE.folderW);
    expect(compact.stackGap).toBe(16);
  });

  it("取景区域越窄，会话排得越窄（容器宽度受取景宽度除以最小缩放的限制），再多的会话也不会排成比这更宽", () => {
    // 宽 300：300 / 0.16 = 1875 像素，最多放 floor((1875 + 32) / 280) = 6 列。
    const lattice = plan(singles(60), { area: { w: 300, h: 4000 }, clusters: one(61) })!;
    const xs = [...lattice.positions("o").values()].map((at) => at.x);
    expect(Math.max(...xs)).toBeLessThanOrEqual(6 * 280);
  });

  it("相同的输入得到相同的位置（规划不依赖调用次数与先后）", () => {
    const tree = { o: ["a", "b", "c", "d", "e"], a: ["a1", "a2", "a3"], c: ["c1"], c1: ["c1x", "c1y"] };
    const read = () => JSON.stringify([...plan(tree)!.positions("o")]);
    expect(read()).toBe(read());
  });

  it("共用 Folder / Git 卡的几个来源排成一组：只有一个整体偏移，每个来源块各有自己的位置", () => {
    const lattice = planLattice({
      area: { w: 1088, h: 610 },
      compact: false,
      blocks: [
        { key: "x", originId: "ox" },
        { key: "y", originId: "oy" },
      ],
      kidsOf: kidsFrom({ ox: ["a", "b"], oy: ["c"] }),
      clusters: [{ keys: ["x", "y"], lead: 2, weight: 7 }],
    })!;
    expect(lattice.offsets).toHaveLength(1);
    expect([...lattice.positions("x").keys()].sort()).toEqual(["a", "b", "ox"]);
    expect([...lattice.positions("y").keys()].sort()).toEqual(["c", "oy"]);
  });

  it("每个节点只摆一次、位置都是整数像素；深一些的树里，子会话总在父会话的右边（来源卡在上面时除外：它的会话在它下面）", () => {
    const tree = { o: ["a", "b", "c"], a: ["a1", "a2"], a1: ["a1x"], b: ["b1"] };
    const placed = plan(tree)!.positions("o");
    expect(placed.size).toBe(8);
    for (const at of placed.values()) expect(Number.isInteger(at.x) && Number.isInteger(at.y)).toBe(true);
    for (const [parent, kids] of Object.entries(tree)) {
      if (parent === "o") continue;
      for (const kid of kids) expect(placed.get(kid)!.x).toBeGreaterThan(placed.get(parent)!.x);
    }
  });
});
