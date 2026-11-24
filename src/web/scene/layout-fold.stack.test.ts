import { describe, expect, it } from "vitest";
import { createFoldTree, foldOf, pack, placeFold, stacked, withKids, type Fold, type Spot } from "./layout-fold";

/**
 * 小家族的竖排折法（`FoldTree.column` 选中的节点，见 layout-fold）：全用合成的整数，不经过 layoutScene。
 * 规则只有三条：子会话们在父会话右边排成一列；整个矩形都是这一家的（别家的卡不进它父会话那一列的空格）；没有 `column` 时与原来逐位相同。
 */

const kidsFrom =
  (tree: Record<string, readonly string[]>) =>
  (id: string): readonly string[] =>
    tree[id] ?? [];

const fan = (count: number, root = "root"): Record<string, string[]> => ({ [root]: Array.from({ length: count }, (_, i) => `${root}-k${i + 1}`) });
const small = (limit: number) => (_id: string, size: number) => size <= limit;

describe("foldOf · 小家族竖排", () => {
  it("子会话们只有一种折法：一列，外形 2 × 子会话数，父会话那一列也整块占着（带 stack）", () => {
    const tree = createFoldTree(kidsFrom(fan(4)), 12, small(5));
    const { block, shapes } = foldOf(tree, "root");
    expect(block).toEqual([{ cols: 1, rows: 4, inner: 1, stack: true }]);
    expect(shapes).toEqual([{ cols: 2, rows: 4, inner: 1, stack: true }]);
  });

  it("后代数超过界线的是大扇出：照旧按容器折，有“更宽更矮”的多种外形，不带 stack", () => {
    const tree = createFoldTree(kidsFrom(fan(6)), 12, small(5));
    const { shapes } = foldOf(tree, "root");
    expect(shapes.length).toBeGreaterThan(1);
    expect(shapes.every((shape) => shape.stack === undefined)).toBe(true);
    // 与没有这条规则时逐位相同。
    expect(shapes).toEqual(foldOf(createFoldTree(kidsFrom(fan(6)), 12), "root").shapes);
  });

  it("界线按后代数（含子孙）算，不只是直接子会话：根带 2 个子会话、其中一个再带 4 个就是 6 个后代，不是小家族", () => {
    const shape = { root: ["a", "b"], a: ["a1", "a2", "a3", "a4"] };
    const tree = createFoldTree(kidsFrom(shape), 12, small(5));
    expect(foldOf(tree, "root").shapes.some((fold) => fold.stack)).toBe(false);
    // a 自己（4 个后代）仍是小家族：它的子会话竖成一列，大扇出里的小家族照样不让线穿卡。
    expect(foldOf(tree, "a").shapes).toEqual([{ cols: 2, rows: 4, inner: 1, stack: true }]);
  });

  it("嵌套的小家族：子会话自己带子会话时，每个子会话占自己的几行，外形按最宽的子会话算", () => {
    const shape = { root: ["a", "b"], a: ["a1", "a2"] };
    const tree = createFoldTree(kidsFrom(shape), 12, small(5));
    // a 是 2 × 2，b 是 1 × 1：竖着排成 3 行，宽取最宽的 2 列，父会话那一列再加 1。
    expect(foldOf(tree, "root").shapes).toEqual([{ cols: 3, rows: 3, inner: 2, stack: true }]);
  });

  it("只有一行时（单个子会话、一条链）竖排与容器折没有区别：外形与没有这条规则时逐位相同，不带 stack", () => {
    const chain = { root: ["a"], a: ["b"], b: ["c"] };
    for (const id of ["root", "a", "b"]) {
      expect(foldOf(createFoldTree(kidsFrom(chain), 12, small(5)), id)).toEqual(foldOf(createFoldTree(kidsFrom(chain), 12), id));
    }
  });

  it("没有 column 时一个字都没变：5 个叶子子会话仍是 1 × 5、2 × 3、3 × 2、5 × 1 四种折法（宽 4 被宽 3 压过）", () => {
    const tree = createFoldTree(kidsFrom(fan(5)), 10);
    expect(foldOf(tree, "root").block).toEqual([
      { cols: 1, rows: 5, inner: 1 },
      { cols: 2, rows: 3, inner: 2 },
      { cols: 3, rows: 2, inner: 3 },
      { cols: 5, rows: 1, inner: 5 },
    ]);
    expect(tree.column).toBeUndefined();
  });

  it("withKids 给同一棵树换一份子节点：折法缓存与后代数缓存都是新的（摘掉子树之后后代数重算）", () => {
    const base = createFoldTree(kidsFrom(fan(5)), 12, small(5));
    expect(foldOf(base, "root").shapes[0]?.stack).toBe(true);
    const grown = withKids(base, (id) => (id === "root" ? ["x1", "x2", "x3", "x4", "x5", "x6"] : []));
    expect(foldOf(grown, "root").shapes.some((fold) => fold.stack)).toBe(false);
    // 原来的那棵没有被动过。
    expect(foldOf(base, "root").shapes[0]?.stack).toBe(true);
  });
});

describe("placeFold · 竖排摆出来的位置", () => {
  const place = (tree: Record<string, readonly string[]>, fold: Fold): Map<string, Spot> => {
    const out = new Map<string, Spot>();
    placeFold(createFoldTree(kidsFrom(tree), 12, small(5)), "root", fold, 0, 0, out);
    return out;
  };

  it("子会话们在父会话右边一列、一行一个，父会话竖直居中（偶数行时靠上半格）", () => {
    const tree = fan(4);
    const fold = foldOf(createFoldTree(kidsFrom(tree), 12, small(5)), "root").shapes[0] as Fold;
    const spots = place(tree, fold);
    expect([...spots.entries()]).toEqual([
      ["root", { col: 0, row: 1 }],
      ["root-k1", { col: 1, row: 0 }],
      ["root-k2", { col: 1, row: 1 }],
      ["root-k3", { col: 1, row: 2 }],
      ["root-k4", { col: 1, row: 3 }],
    ]);
  });

  it("嵌套：带子会话的子会话占自己的几行，它的子会话在再右一列，别的子会话不会插进它的行里", () => {
    const tree = { root: ["a", "b"], a: ["a1", "a2"] };
    const fold = foldOf(createFoldTree(kidsFrom(tree), 12, small(5)), "root").shapes[0] as Fold;
    const spots = place(tree, fold);
    expect(spots.get("a")).toEqual({ col: 1, row: 0 });
    expect(spots.get("a1")).toEqual({ col: 2, row: 0 });
    expect(spots.get("a2")).toEqual({ col: 2, row: 1 });
    expect(spots.get("b")).toEqual({ col: 1, row: 2 });
    expect(spots.get("root")).toEqual({ col: 0, row: 1 });
  });

  it("摆出来的外形与试算一致：占的列数、行数就是 Fold 的 cols、rows", () => {
    for (const count of [2, 3, 4, 5]) {
      const tree = fan(count);
      const fold = foldOf(createFoldTree(kidsFrom(tree), 12, small(5)), "root").shapes[0] as Fold;
      const spots = [...place(tree, fold).values()];
      expect(Math.max(...spots.map((spot) => spot.col)) + 1).toBe(fold.cols);
      expect(Math.max(...spots.map((spot) => spot.row)) + 1).toBe(fold.rows);
    }
  });
});

describe("pack · 竖排的外形整个矩形都占着", () => {
  const family: Fold = { cols: 2, rows: 3, inner: 1, stack: true };
  const plain: Fold = { cols: 2, rows: 3, inner: 1 };

  it("别家的单卡不会落进竖排外形的父会话那一列（上下紧挨着父会话的格子）", () => {
    const { spots } = pack([family, { cols: 1, rows: 1, inner: 0 }, { cols: 1, rows: 1, inner: 0 }], 3);
    expect(spots[0]).toEqual({ col: 0, row: 0 });
    // 家族占 (0..1) × (0..2)：单卡只能落在第 2 列（右边的空列），而不是父会话上方 / 下方那几个格子。
    expect(spots[1]).toEqual({ col: 2, row: 0 });
    expect(spots[2]).toEqual({ col: 2, row: 1 });
  });

  it("竖排的外形排在单卡后面：整个矩形（含父会话那一格）都要空着，不会压在已有的卡上", () => {
    const small: Fold = { cols: 2, rows: 2, inner: 1, stack: true };
    const { spots } = pack([{ cols: 1, rows: 1, inner: 0 }, small], 2);
    expect(spots[0]).toEqual({ col: 0, row: 0 });
    expect(spots[1]).toEqual({ col: 0, row: 1 });
  });

  it("没有 stack 的外形照旧：后面的兄弟会落进父会话那一列的空格里（来源下的单会话与一棵树的父会话上下并排）", () => {
    // plain 的父会话在第 1 行（3 行居中），它正上方的 (0, 0) 是空的，单卡落在那里。
    const { spots } = pack([plain, { cols: 1, rows: 1, inner: 0 }], 2);
    expect(spots[0]).toEqual({ col: 0, row: 0 });
    expect(spots[1]).toEqual({ col: 0, row: 0 });
  });

  it("没有 stack 的几种外形混装的结果是确定的字面值（与加竖排之前逐位相同）", () => {
    const leaf: Fold = { cols: 1, rows: 1, inner: 0 };
    const wide: Fold = { cols: 3, rows: 2, inner: 2 };
    expect(pack([plain, plain, leaf, wide], 4)).toEqual({
      spots: [
        { col: 0, row: 0 },
        { col: 2, row: 0 },
        { col: 0, row: 0 },
        { col: 0, row: 3 },
      ],
      cols: 4,
      rows: 5,
    });
  });
});

describe("stacked · 竖排", () => {
  it("每个外形占自己的行，全在第 0 列；宽取最宽的", () => {
    expect(
      stacked([
        { cols: 1, rows: 1 },
        { cols: 3, rows: 2 },
        { cols: 2, rows: 4 },
      ]),
    ).toEqual({
      spots: [
        { col: 0, row: 0 },
        { col: 0, row: 1 },
        { col: 0, row: 3 },
      ],
      cols: 3,
      rows: 7,
    });
  });

  it("空的是空的", () => {
    expect(stacked([])).toEqual({ spots: [], cols: 0, rows: 0 });
  });
});
