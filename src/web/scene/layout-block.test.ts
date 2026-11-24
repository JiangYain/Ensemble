import { describe, expect, it } from "vitest";
import { anchorBlock, blockShapes, placeBlock, type BlockShape } from "./layout-block";
import { cellsFor, spanX, spanY } from "./layout-cells";
import { createFoldTree, type FoldTree } from "./layout-fold";
import { NODE, type LayoutNode } from "./layout-geometry";

/**
 * 一个来源块在格子里的外形与摆放（layout-block.ts）：全用合成的树，不经过 layoutScene。
 * 来源块 = 来源卡（树的根，下面的 id 都叫 "o"）加它名下的会话；来源卡在左边或在上面两种摆法。
 */

const kidsFrom =
  (tree: Record<string, readonly string[]>) =>
  (id: string): readonly string[] =>
    tree[id] ?? [];

/** 来源卡 "o" 名下 `count` 个互不相干的会话 s1、s2……。 */
const singles = (count: number): Record<string, string[]> => ({ o: Array.from({ length: count }, (_, i) => `s${i + 1}`) });

const treeOf = (tree: Record<string, readonly string[]>, maxWidth = 12): FoldTree => createFoldTree(kidsFrom(tree), maxWidth);

const ladder = (shapes: readonly BlockShape[]): [number, number, boolean][] => shapes.map((shape) => [shape.cols, shape.rows, shape.top]);

describe("blockShapes · 来源块能排成的各种外形", () => {
  it("只有一张来源卡的块（没有会话）是 1 × 1", () => {
    expect(blockShapes(treeOf({}), "o")).toEqual([{ cols: 1, rows: 1, top: false, inner: 0 }]);
  });

  it("7 个会话：宽升高降的阶梯；同样大小（3 × 4）时来源卡在上面的排前面，更宽之后来源卡在左边（少一整行比少一整列划算）", () => {
    // 来源卡在上面是 会话块的宽 × (高 + 1)，在左边是 (宽 + 1) × 高；两种混在一起，只留不被压过的，宽高都相同的取在上面的。
    expect(ladder(blockShapes(treeOf(singles(7)), "o"))).toEqual([
      [1, 8, true],
      [2, 5, true],
      [3, 4, true],
      [4, 3, true],
      [5, 2, false],
      [8, 1, false],
    ]);
  });

  it("任何树的阶梯都是宽度严格递增、高度严格递减", () => {
    for (const shape of [singles(24), { o: ["a", "b", "c", "d"], a: ["a1", "a2", "a3"], c: ["c1"] }]) {
      const shapes = blockShapes(treeOf(shape), "o");
      for (let i = 1; i < shapes.length; i++) {
        expect(shapes[i]!.cols).toBeGreaterThan(shapes[i - 1]!.cols);
        expect(shapes[i]!.rows).toBeLessThan(shapes[i - 1]!.rows);
      }
    }
  });
});

describe("placeBlock · 摆好一个来源块", () => {
  const cells = cellsFor(false);

  it("来源卡在上面：水平居中于整块的宽度，会话从第 2 行起，左缘与上缘都落在格子上", () => {
    const tree = treeOf(singles(7));
    const shape = blockShapes(tree, "o").find((candidate) => candidate.cols === 3 && candidate.top) as BlockShape;
    const placed = placeBlock(tree, "o", shape, cells);
    // 三列：整块宽 3 × 280 − 32 = 808；来源卡 212，居中是 (808 − 212) / 2 = 298。
    expect(placed.get("o")).toEqual({ x: 298, y: 0 });
    for (let i = 1; i <= 7; i++) {
      const at = placed.get(`s${i}`)!;
      expect(at.x % cells.pitchX).toBe(0);
      expect(at.y % cells.pitchY).toBe(0);
      expect(at.y).toBeGreaterThanOrEqual(cells.pitchY);
    }
  });

  it("来源卡在上面时居中且永远是整数像素（半个像素会让卡片里的文字发虚）：常规两列 158，紧凑两列 145", () => {
    const tree = treeOf(singles(4));
    const shape = blockShapes(tree, "o").find((candidate) => candidate.cols === 2 && candidate.top) as BlockShape;
    expect(placeBlock(tree, "o", shape, cells).get("o")?.x).toBe(158);
    expect(placeBlock(tree, "o", shape, cellsFor(true)).get("o")?.x).toBe(145);
    const wide = treeOf(singles(30));
    for (const grid of [cells, cellsFor(true)]) {
      for (const candidate of blockShapes(wide, "o")) {
        if (!candidate.top) continue;
        const x = placeBlock(wide, "o", candidate, grid).get("o")!.x;
        expect(Number.isInteger(x)).toBe(true);
        // 左右两边的空白相差不超过 1 像素。
        expect(Math.abs(x - (spanX(grid, candidate.cols) - grid.originW - x))).toBeLessThanOrEqual(1);
      }
    }
  });

  it("来源卡在左边：在最左一列、竖直居中（偶数行靠上半格），会话从第 2 列起", () => {
    // 5 个会话装进宽 2 的容器是 2 × 3，来源卡在左边就是 3 × 3：来源卡在第 floor((3 − 1) / 2) = 1 行。
    const tree = treeOf(singles(5));
    const placed = placeBlock(tree, "o", { cols: 3, rows: 3, top: false, inner: 2 }, cells);
    expect(placed.get("o")).toEqual({ x: 0, y: cells.pitchY });
    for (let i = 1; i <= 5; i++) expect(placed.get(`s${i}`)!.x).toBeGreaterThanOrEqual(cells.pitchX);
    // 偶数行：8 个会话装进宽 2 的容器是 2 × 4，来源卡在第 1 行（靠上半格）。
    const eight = treeOf(singles(8));
    expect(placeBlock(eight, "o", { cols: 3, rows: 4, top: false, inner: 2 }, cells).get("o")).toEqual({ x: 0, y: cells.pitchY });
  });

  it("没有会话的块：来源卡在原点，只有它一张", () => {
    const tree = treeOf({});
    const placed = placeBlock(tree, "o", blockShapes(tree, "o")[0] as BlockShape, cells);
    expect([...placed]).toEqual([["o", { x: 0, y: 0 }]]);
  });

  const trees: [string, Record<string, readonly string[]>][] = [
    ["7 个单会话", singles(7)],
    ["24 个单会话", singles(24)],
    ["带子树的混合", { o: ["a", "b", "c", "d", "e"], a: ["a1", "a2", "a3", "a4"], c: ["c1", "c2"], c1: ["c1x"] }],
    ["一个父会话带 11 个子会话", { o: ["p", "q"], p: Array.from({ length: 11 }, (_, i) => `k${i + 1}`) }],
  ];

  for (const compact of [false, true]) {
    for (const [name, shape] of trees) {
      it(`${compact ? "紧凑模式" : "常规模式"} · ${name}：每种外形摆完都在整数像素上、没有超出格数换算的宽高、互不重叠、每个节点只摆一次`, () => {
        const grid = cellsFor(compact);
        const tree = treeOf(shape);
        const total = new Set([...Object.keys(shape), ...Object.values(shape).flat()]).size;
        const sizeOf = (id: string): { w: number; h: number } => ({ w: id === "o" ? grid.originW : grid.agentW, h: NODE.agentH });
        for (const candidate of blockShapes(tree, "o")) {
          const placed = placeBlock(tree, "o", candidate, grid);
          expect(placed.size).toBe(total);
          const boxes = [...placed].map(([id, at]) => ({ id, ...at, ...sizeOf(id) }));
          for (const box of boxes) {
            expect(Number.isInteger(box.x) && Number.isInteger(box.y), box.id).toBe(true);
            expect(box.x + box.w).toBeLessThanOrEqual(spanX(grid, candidate.cols));
            expect(box.y + box.h).toBeLessThanOrEqual(spanY(grid, candidate.rows));
          }
          for (const [i, a] of boxes.entries()) {
            for (const b of boxes.slice(i + 1)) {
              expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h, `${a.id} × ${b.id}`).toBe(false);
            }
          }
        }
      });
    }
  }

  it("摆出来的外框正好是格数换算的宽高（常规模式、7 个单会话、来源卡在上面的 3 × 4）", () => {
    const tree = treeOf(singles(7));
    const shape = blockShapes(tree, "o").find((candidate) => candidate.cols === 3 && candidate.top) as BlockShape;
    const placed = placeBlock(tree, "o", shape, cells);
    const agents = [...placed].filter(([id]) => id !== "o").map(([, at]) => at);
    expect(Math.max(...agents.map((at) => at.x)) + cells.agentW).toBe(spanX(cells, 3));
    expect(Math.max(...agents.map((at) => at.y)) + NODE.agentH).toBe(spanY(cells, 4));
  });
});

describe("anchorBlock · 重写锚点", () => {
  const card = (id: string, x: number, y: number): LayoutNode => ({
    id,
    kind: id === "o" ? "origin" : "agent",
    x,
    y,
    w: id === "o" ? NODE.originW : NODE.agentW,
    h: NODE.agentH,
    overhang: { left: 0, right: 0 },
  });

  it("同一父下第一个以父为锚、偏移是布局里的实际相对位置；其余各挂在上一个兄弟下面，水平不错位、竖直只隔一个行距", () => {
    const nodes = [card("o", 0, 136), card("a", 280, 0), card("b", 280, 136), card("c", 280, 272), card("a1", 560, 0)];
    // 旧的锚点留在节点上：必须被覆盖。
    nodes[2]!.anchor = { id: "o", dx: 1, dy: 2 };
    anchorBlock(nodes, "o", kidsFrom({ o: ["a", "b", "c"], a: ["a1"] }));
    const anchors = new Map(nodes.map((node) => [node.id, node.anchor]));
    expect(anchors.get("o")).toBeUndefined();
    expect(anchors.get("a")).toEqual({ id: "o", dx: 280, dy: -136 });
    expect(anchors.get("b")).toEqual({ id: "a", dx: 0, dy: NODE.agentH + NODE.rowGap });
    expect(anchors.get("c")).toEqual({ id: "b", dx: 0, dy: NODE.agentH + NODE.rowGap });
    expect(anchors.get("a1")).toEqual({ id: "a", dx: 280, dy: 0 });
  });

  it("每个锚点都指向排在它自己之前的节点（引擎按顺序放置的不变量）", () => {
    const nodes = [card("o", 0, 0), card("a", 280, 0), card("a1", 560, 0), card("b", 280, 136)];
    anchorBlock(nodes, "o", kidsFrom({ o: ["a", "b"], a: ["a1"] }));
    const index = new Map(nodes.map((node, i) => [node.id, i]));
    for (const [i, node] of nodes.entries()) if (node.anchor) expect(index.get(node.anchor.id)!).toBeLessThan(i);
  });

  it("块里没有的节点（被隐藏的会话）不参与：锚点只会指向块里有的节点", () => {
    const nodes = [card("o", 0, 0), card("a", 280, 0), card("c", 280, 136)];
    anchorBlock(nodes, "o", kidsFrom({ o: ["a", "hidden", "c"] }));
    expect(nodes[2]!.anchor).toEqual({ id: "a", dx: 0, dy: NODE.agentH + NODE.rowGap });
  });
});
