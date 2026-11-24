import { describe, expect, it } from "vitest";
import { createFoldTree, foldOf, pack, parentRow, pareto, placeFold, placeKids, within, type Fold, type Span, type Spot } from "./layout-fold";

/**
 * 把一棵会话树折进整数格子（layout-fold.ts）：全用合成的整数，不经过 layoutScene、不认识像素。
 * 整张画布的结果由 layout.invariants.test.ts 与 layout.real.test.ts 管；这里只管折法本身的规则。
 */

const kidsFrom =
  (tree: Record<string, readonly string[]>) =>
  (id: string): readonly string[] =>
    tree[id] ?? [];

/** 一个父会话带 `count` 个叶子子会话。 */
const fan = (count: number): Record<string, string[]> => ({ root: Array.from({ length: count }, (_, i) => `k${i + 1}`) });

const one: Span = { cols: 1, rows: 1 };

describe("pareto · 只留“更宽才更矮”的外形", () => {
  it("按宽度由窄到宽，高度严格递减；被压过的（又宽又不矮）去掉", () => {
    const frontier = pareto([
      { cols: 3, rows: 5 },
      { cols: 1, rows: 9 },
      { cols: 2, rows: 5 },
      { cols: 4, rows: 4 },
      { cols: 6, rows: 4 },
    ]);
    expect(frontier).toEqual([
      { cols: 1, rows: 9 },
      { cols: 2, rows: 5 },
      { cols: 4, rows: 4 },
    ]);
  });

  it("宽高都相同的取排在前面的：调用方把更想要的放在前面", () => {
    const first = { cols: 3, rows: 4, tag: "top" };
    const second = { cols: 3, rows: 4, tag: "left" };
    expect(pareto([first, second])).toEqual([first]);
    expect(pareto([second, first])).toEqual([second]);
  });

  it("空的是空的", () => {
    expect(pareto([])).toEqual([]);
  });
});

describe("within · 宽度不超过上限里最矮的一种", () => {
  const ladder: Fold[] = [
    { cols: 2, rows: 6, inner: 1 },
    { cols: 4, rows: 3, inner: 3 },
    { cols: 7, rows: 2, inner: 6 },
  ];

  it("取最后一个放得下的；恰好等于上限也放得下", () => {
    expect(within(ladder, 2)).toBe(ladder[0]);
    expect(within(ladder, 3)).toBe(ladder[0]);
    expect(within(ladder, 4)).toBe(ladder[1]);
    expect(within(ladder, 99)).toBe(ladder[2]);
  });

  it("连最窄的都放不下是 undefined", () => {
    expect(within(ladder, 1)).toBeUndefined();
    expect(within([], 5)).toBeUndefined();
  });
});

describe("parentRow · 父会话在块里的哪一行", () => {
  it("竖直居中，行数是偶数时靠上半格", () => {
    expect([1, 2, 3, 4, 5, 6].map((rows) => parentRow({ cols: 2, rows }))).toEqual([0, 0, 1, 1, 2, 2]);
  });
});

describe("pack · 按先后装进容器，每个放在第一个放得下的位置", () => {
  it("单格的外形一行行从左到右排满", () => {
    const { spots, cols, rows } = pack(Array.from({ length: 7 }, () => one), 3);
    expect(spots).toEqual([
      { col: 0, row: 0 }, { col: 1, row: 0 }, { col: 2, row: 0 },
      { col: 0, row: 1 }, { col: 1, row: 1 }, { col: 2, row: 1 },
      { col: 0, row: 2 },
    ]);
    expect([cols, rows]).toEqual([3, 3]);
  });

  it("单格的外形装满后，各列的行数最多差 1", () => {
    for (const [count, width] of [[20, 6], [23, 5], [41, 7], [9, 4]] as const) {
      const { spots } = pack(Array.from({ length: count }, () => one), width);
      const perColumn = new Map<number, number>();
      for (const spot of spots) perColumn.set(spot.col, (perColumn.get(spot.col) ?? 0) + 1);
      const counts = [...perColumn.values()];
      expect(Math.max(...counts) - Math.min(...counts), `${count} 个装进 ${width} 列`).toBeLessThanOrEqual(1);
    }
  });

  it("带子会话的外形占一整块；它左边那一列里没被它自己占着的格子，后面的兄弟会落进去", () => {
    // 3 × 3 的块：父会话在第 1 行（最左一列的正中），子会话们占右边两列三行。
    const block: Span = { cols: 3, rows: 3 };
    const { spots, cols, rows } = pack([block, one, one, one], 3);
    expect(spots[0]).toEqual({ col: 0, row: 0 });
    // 第一个单格落在父会话上面，第二个落在父会话下面（最靠上、最靠左的空位），第三个只能放在块的下面。
    expect(spots[1]).toEqual({ col: 0, row: 0 });
    expect(spots[2]).toEqual({ col: 0, row: 2 });
    expect(spots[3]).toEqual({ col: 0, row: 3 });
    expect([cols, rows]).toEqual([3, 4]);
  });

  it("放不下的外形（比容器宽）把容器撑宽到它，不会丢", () => {
    const { spots, cols } = pack([{ cols: 5, rows: 2 }, one], 3);
    expect(spots).toHaveLength(2);
    expect(cols).toBe(5);
  });

  it("任何外形组合里，每一格最多被一个外形占着：自己那一格加右边的整个矩形互不相交", () => {
    // 确定的伪随机（Park–Miller，乘积不超过 2^53）：同一个种子永远同一组外形。
    let seed = 7;
    const next = (limit: number): number => {
      seed = (seed * 48271) % 2147483647;
      return seed % limit;
    };
    for (let round = 0; round < 40; round++) {
      const items: Span[] = Array.from({ length: 1 + next(12) }, () => ({ cols: 1 + next(4), rows: 1 + next(5) }));
      const width = 1 + next(6);
      const { spots, cols, rows } = pack(items, width);
      const taken = new Set<string>();
      items.forEach((item, index) => {
        const spot = spots[index] as Spot;
        const cells = [`${spot.col},${spot.row + parentRow(item)}`];
        for (let r = spot.row; r < spot.row + item.rows; r++) for (let c = spot.col + 1; c < spot.col + item.cols; c++) cells.push(`${c},${r}`);
        for (const cell of cells) {
          expect(taken.has(cell), `第 ${round} 组：格 ${cell} 被占了两次`).toBe(false);
          taken.add(cell);
        }
        expect(spot.col + item.cols).toBeLessThanOrEqual(cols);
        expect(spot.row + item.rows).toBeLessThanOrEqual(rows);
      });
    }
  });
});

describe("foldOf · 一个节点的各种折法", () => {
  it("叶子：只有 1 × 1，没有子会话的块", () => {
    const tree = createFoldTree(kidsFrom({}), 10);
    expect(foldOf(tree, "leaf")).toEqual({ block: [], shapes: [{ cols: 1, rows: 1, inner: 0 }] });
  });

  it("一个父会话带 7 个叶子：越宽越矮的阶梯，每一级的块是父会话那一列之外的容器", () => {
    const tree = createFoldTree(kidsFrom(fan(7)), 20);
    const { block, shapes } = foldOf(tree, "root");
    // 容器宽 1、2、3、4（其余宽度与 4 一样矮，被压掉）、7。
    expect(block.map((fold) => [fold.cols, fold.rows])).toEqual([[1, 7], [2, 4], [3, 3], [4, 2], [7, 1]]);
    // 整个节点的外形 = 块的宽加上父会话自己那一列。
    expect(shapes.map((fold) => [fold.cols, fold.rows])).toEqual([[2, 7], [3, 4], [4, 3], [5, 2], [8, 1]]);
    expect(shapes.map((fold) => fold.inner)).toEqual(block.map((fold) => fold.inner));
  });

  it("容器宽度受 maxWidth 限制：再宽的形态不试", () => {
    const tree = createFoldTree(kidsFrom(fan(30)), 4);
    const widest = foldOf(tree, "root").block.at(-1) as Fold;
    expect(widest.cols).toBeLessThanOrEqual(4);
    expect(widest.rows).toBe(Math.ceil(30 / 4));
  });

  it("每个子树至少要放得下它最窄的外形：容器不会比最窄的孙辈还窄", () => {
    // 根 → a → a1 → a1x：一路向右的链，最窄也要 3 列（a、a1、a1x）加根自己那一列。
    const tree = createFoldTree(kidsFrom({ root: ["a"], a: ["a1"], a1: ["a1x"] }), 10);
    const { shapes } = foldOf(tree, "root");
    expect(shapes).toEqual([{ cols: 4, rows: 1, inner: 3 }]);
  });

  it("结果带缓存：同一个节点再问返回同一个对象", () => {
    const tree = createFoldTree(kidsFrom(fan(5)), 10);
    expect(foldOf(tree, "root")).toBe(foldOf(tree, "root"));
    expect(foldOf(tree, "k1")).toBe(foldOf(tree, "k1"));
  });
});

describe("placeKids · placeFold · 摆出来的与试算的一致", () => {
  const tree = {
    root: ["a", "b", "c", "d"],
    a: ["a1", "a2", "a3"],
    c: ["c1"],
  };

  it("每个节点占一格、互不重叠；父会话在子会话的左边，竖直居中（偶数行靠上半格）", () => {
    const folds = createFoldTree(kidsFrom(tree), 6);
    for (const fold of foldOf(folds, "root").shapes) {
      const spots = new Map<string, Spot>();
      placeFold(folds, "root", fold, 0, 0, spots);
      expect(spots.size).toBe(9);
      expect(new Set([...spots.values()].map((spot) => `${spot.col},${spot.row}`)).size).toBe(9);
      for (const spot of spots.values()) {
        expect(spot.col).toBeLessThan(fold.cols);
        expect(spot.row).toBeLessThan(fold.rows);
      }
      const root = spots.get("root") as Spot;
      expect(root.col).toBe(0);
      expect(root.row).toBe(parentRow(fold));
      for (const kid of tree.root) expect((spots.get(kid) as Spot).col).toBeGreaterThan(root.col);
      for (const kid of tree.a) expect((spots.get(kid) as Spot).col).toBeGreaterThan((spots.get("a") as Spot).col);
    }
  });

  it("外形的左上角可以不在原点：位置整体平移", () => {
    const folds = createFoldTree(kidsFrom(tree), 6);
    const fold = foldOf(folds, "root").shapes[0] as Fold;
    const at = new Map<string, Spot>();
    const shifted = new Map<string, Spot>();
    placeFold(folds, "root", fold, 0, 0, at);
    placeFold(folds, "root", fold, 3, 5, shifted);
    for (const [id, spot] of at) expect(shifted.get(id)).toEqual({ col: spot.col + 3, row: spot.row + 5 });
  });

  it("placeKids 只摆子会话（不含父会话自己），从给定的容器左上角起", () => {
    const folds = createFoldTree(kidsFrom(fan(6)), 6);
    const spots = new Map<string, Spot>();
    placeKids(folds, "root", 3, 1, 0, spots);
    expect([...spots.keys()]).toEqual(["k1", "k2", "k3", "k4", "k5", "k6"]);
    expect(spots.get("k1")).toEqual({ col: 1, row: 0 });
    expect(spots.get("k4")).toEqual({ col: 1, row: 1 });
  });

  it("同一棵树、同样的宽度永远折出同样的结果", () => {
    const folds = createFoldTree(kidsFrom(tree), 6);
    const fold = foldOf(folds, "root").shapes.at(-1) as Fold;
    const first = new Map<string, Spot>();
    const second = new Map<string, Spot>();
    placeFold(folds, "root", fold, 0, 0, first);
    placeFold(createFoldTree(kidsFrom(tree), 6), "root", fold, 0, 0, second);
    expect([...second]).toEqual([...first]);
  });
});
