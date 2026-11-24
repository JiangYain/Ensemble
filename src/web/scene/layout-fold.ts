/**
 * 把一棵会话树“折”进整数格子：每个节点占一格，子会话们在父会话右边装进一个矩形，父会话在这个矩形左边那一列、竖直居中。
 * 折法只有两个自由度——子会话们并排的容器有多宽（`inner` 格）、每个子树各取哪种外形——其余都由规则定死，
 * 所以同一份输入永远折出同一个结果，也没有指数级的搜索：每个节点只试几十种容器宽度。
 *
 * 子会话们按创建先后依次装进容器（`pack`）：每个放在第一个放得下的位置——先找最靠上的一行，同一行里取最靠左的；
 * 单卡就是一行行从左到右排满，带子树的就按它自己的外形占一块。所以同一个父会话下的子会话先后关系看得出来，
 * 单卡之间各列的行数差不超过 1，带子树的各列最多差到最高那一块的高度。每个节点算出一份“外形的阶梯”（`Fold[]`）：
 * 越宽越矮，没有哪一种比另一种又宽又高；上一层按自己容器的宽度从中取最矮的那一种。
 *
 * 这里只有整数与树，不认识像素、卡片尺寸和会话数据（节点 id 是不透明的字符串）；换算成像素见 layout-cells，摆到节点上见 layout-block。
 */

/** 占 cols × rows 格。 */
export interface Span {
  cols: number;
  rows: number;
}

/** 左上角所在的格（列、行，从 0 起）。 */
export interface Spot {
  col: number;
  row: number;
}

/**
 * 一棵子树的一种折法：外形 cols × rows 格（含父会话自己那一列）；`inner` 是它的子会话们并排用的容器宽度（格数，叶子是 0）。
 * `stack` 是“竖排”：子会话们在父会话右边排成**一列**（一个挨一个，没有一个躲在另一个后面），父会话在这一列旁边竖直居中；
 * 外形整块都是它的——父会话那一列里没用到的格子也不让别家的卡落进来（见 `pack`）。只有 `FoldTree.column` 选中的小家族有这一项。
 */
export interface Fold extends Span {
  inner: number;
  stack?: true;
}

/** 一棵树与它的折法缓存：同一棵树的多次查询不重算。 */
export interface FoldTree {
  /** 一个节点的子节点（按创建先后）；叶子是空数组。 */
  kidsOf: (id: string) => readonly string[];
  /** 值得试的最宽容器（格数）：再宽的形态在缩放下限里也放不下。 */
  maxWidth: number;
  cache: Map<string, Folded>;
  /** 哪些节点的子会话竖排成一列（小家族）：参数是节点 id 与它的后代数（不含自己）；没给就一律按容器折。 */
  column?: (id: string, size: number) => boolean;
  /** 后代数的缓存（只有给了 `column` 才用）。 */
  sizes: Map<string, number>;
}

export interface Folded {
  /** 子会话们装成一块的各种外形（不含父会话那一列），宽升高降；叶子是空的。 */
  block: readonly Fold[];
  /** 这个节点连同子会话的各种外形（块的宽加一列父会话），宽升高降；叶子只有 1 × 1。 */
  shapes: readonly Fold[];
}

const LEAF: Fold = { cols: 1, rows: 1, inner: 0 };

export function createFoldTree(kidsOf: FoldTree["kidsOf"], maxWidth: number, column?: FoldTree["column"]): FoldTree {
  return { kidsOf, maxWidth: Math.max(1, Math.floor(maxWidth)), cache: new Map(), ...(column ? { column } : {}), sizes: new Map() };
}

/** 同一棵树换一份子节点（比如摘掉几个子树）：折法缓存与后代数缓存都是新的，别的设置照旧。 */
export function withKids(tree: FoldTree, kidsOf: FoldTree["kidsOf"]): FoldTree {
  return { ...tree, kidsOf, cache: new Map(), sizes: new Map() };
}

/** 一个节点的后代数（不含自己）。 */
function sizeOf(tree: FoldTree, id: string): number {
  const known = tree.sizes.get(id);
  if (known !== undefined) return known;
  let size = 0;
  for (const kid of tree.kidsOf(id)) size += 1 + sizeOf(tree, kid);
  tree.sizes.set(id, size);
  return size;
}

/** 竖排：每个外形占自己的行，全部在同一列（第 0 列）自上而下排；宽取最宽的那个。 */
export function stacked(items: readonly Span[]): { spots: Spot[]; cols: number; rows: number } {
  let rows = 0;
  let cols = 0;
  const spots = items.map((item): Spot => {
    const spot = { col: 0, row: rows };
    rows += item.rows;
    cols = Math.max(cols, item.cols);
    return spot;
  });
  return { spots, cols, rows };
}

/**
 * 只留下“更宽才更矮”的外形：按宽度由窄到宽排列，高度严格递减。宽高都相同的取排在前面的（调用方把更想要的放在前面）。
 */
export function pareto<T extends Span>(list: readonly T[]): T[] {
  const sorted = [...list].sort((a, b) => a.cols - b.cols || a.rows - b.rows);
  const frontier: T[] = [];
  let lowest = Infinity;
  for (const shape of sorted) {
    if (shape.rows < lowest) {
      frontier.push(shape);
      lowest = shape.rows;
    }
  }
  return frontier;
}

/** 宽度不超过 `width` 的外形里最矮的一种（阶梯按宽升高降，取最后一个放得下的）；连最窄的都放不下是 undefined。 */
export function within<T extends Span>(shapes: readonly T[], width: number): T | undefined {
  let found: T | undefined;
  for (const shape of shapes) {
    if (shape.cols > width) break;
    found = shape;
  }
  return found;
}

/** 一个外形里，它自己（父会话）所在的那一行：最左一列、竖直居中，行数是偶数时靠上半格。 */
export const parentRow = (item: Span): number => Math.floor((item.rows - 1) / 2);

/**
 * 把一串外形按先后装进宽 `width` 格的容器，向下生长：每个放在“第一个放得下的位置”——先找最靠上的一行，同一行里取最靠左的。
 * 一个外形实际占着的格：它自己那一格（最左一列的 `parentRow`），加上右边子会话们的整个矩形——矩形里排不满的格子也算占着，
 * 别家的卡不会混进一家的子会话里。它左边那一列里除了自己的其余格子是空的，后面的兄弟会落进去
 * （来源下的单会话与一棵树的父会话上下并排，正是经典的树里“根会话一列”的样子）。
 * 单格的外形就是一行行从左到右排满。容器放不下的外形（比 `width` 宽）会把容器撑宽到它，不会丢。
 * 竖排的外形（`stack`）整个矩形都是它占着，包括父会话那一列里的其余格子：别家的卡不会落在它的父会话上下紧挨着——
 * 那样父会话发出的线会像是从旁边那张卡出来的。
 */
export function pack(items: readonly (Span & { stack?: true })[], width: number): { spots: Spot[]; cols: number; rows: number } {
  const total = Math.max(width, ...items.map((item) => item.cols));
  const taken = new Uint8Array(total * Math.max(1, items.reduce((sum, item) => sum + item.rows, 0)));
  const spots: Spot[] = [];
  let cols = 0;
  let rows = 0;
  const fits = (item: Span & { stack?: true }, col: number, row: number): boolean => {
    // 竖排的外形整个矩形都要空着；别的外形只要自己那一格与右边的矩形空着。
    if (!item.stack && taken[(row + parentRow(item)) * total + col]) return false;
    for (let r = row; r < row + item.rows; r++) for (let c = item.stack ? col : col + 1; c < col + item.cols; c++) if (taken[r * total + c]) return false;
    return true;
  };
  // 放在所有已占格子的下面一定放得下，所以这个循环总会 return。
  const firstFit = (item: Span & { stack?: true }): Spot => {
    for (let row = 0; ; row++) {
      for (let col = 0; col + item.cols <= total; col++) if (fits(item, col, row)) return { col, row };
    }
  };
  for (const item of items) {
    const spot = firstFit(item);
    spots.push(spot);
    if (!item.stack) taken[(spot.row + parentRow(item)) * total + spot.col] = 1;
    for (let r = spot.row; r < spot.row + item.rows; r++) for (let c = item.stack ? spot.col : spot.col + 1; c < spot.col + item.cols; c++) taken[r * total + c] = 1;
    cols = Math.max(cols, spot.col + item.cols);
    rows = Math.max(rows, spot.row + item.rows);
  }
  return { spots, cols, rows };
}

/** 一个节点的全部折法（带缓存）。 */
export function foldOf(tree: FoldTree, id: string): Folded {
  const known = tree.cache.get(id);
  if (known) return known;
  const kids = tree.kidsOf(id);
  let folded: Folded;
  if (kids.length === 0) {
    folded = { block: [], shapes: [LEAF] };
  } else if (tree.column?.(id, sizeOf(tree, id))) {
    // 小家族：子会话们竖排成一列，只有这一种外形（没有“更宽更矮”的选择）；每个子会话取自己最窄的外形（小家族的子树也是小家族，本来就只有一种）。
    const items = kids.map((kid) => (foldOf(tree, kid).shapes[0] as Fold));
    const { cols, rows } = stacked(items);
    // 只有一行时（单个子会话或一条链）竖排与容器折没有任何区别：不带 stack，外形与没有这条规则时逐位相同。
    const fold: Fold = rows > 1 ? { cols, rows, inner: cols, stack: true } : { cols, rows, inner: cols };
    folded = { block: [fold], shapes: [{ ...fold, cols: cols + 1 }] };
  } else {
    const kidShapes = kids.map((kid) => foldOf(tree, kid).shapes);
    // 容器至少要宽到放得下每个子树最窄的外形；宽过“所有子树都排成一行”就不再有新形态。
    const narrowest = Math.max(...kidShapes.map((shapes) => (shapes[0] as Fold).cols));
    const widest = kidShapes.reduce((sum, shapes) => sum + (shapes.at(-1) as Fold).cols, 0);
    const found: Fold[] = [];
    for (let width = narrowest; width <= Math.max(narrowest, Math.min(tree.maxWidth, widest)); width++) {
      const items = kidShapes.map((shapes) => within(shapes, width) as Fold);
      const { cols, rows } = pack(items, width);
      found.push({ cols, rows, inner: width });
    }
    const block = pareto(found);
    folded = { block, shapes: block.map((fold) => ({ cols: fold.cols + 1, rows: fold.rows, inner: fold.inner })) };
  }
  tree.cache.set(id, folded);
  return folded;
}

/**
 * 把 `id` 的子会话们按宽 `inner` 的容器摆好，容器的左上角在 (col, row)；位置记在 `out`（含子孙）。
 * 重新把每个子树取成容器宽度里最矮的外形再装一遍——与试算时是同一个确定的过程，所以摆出来的外形与试算一致。
 * `stack` 是竖排（见 `Fold.stack`）：子会话们不装箱，自上而下排成一列。
 */
export function placeKids(tree: FoldTree, id: string, inner: number, col: number, row: number, out: Map<string, Spot>, stack = false): void {
  const kids = tree.kidsOf(id);
  const items = kids.map((kid) => within(foldOf(tree, kid).shapes, inner) as Fold);
  const { spots } = stack ? stacked(items) : pack(items, inner);
  kids.forEach((kid, index) => {
    const spot = spots[index] as Spot;
    placeFold(tree, kid, items[index] as Fold, col + spot.col, row + spot.row, out);
  });
}

/** 把 `id` 按 `fold` 摆好，外形的左上角在 (col, row)：它自己在最左一列、竖直居中（偶数行时靠上半格），子会话们在右边。 */
export function placeFold(tree: FoldTree, id: string, fold: Fold, col: number, row: number, out: Map<string, Spot>): void {
  if (fold.inner === 0) {
    out.set(id, { col, row });
    return;
  }
  out.set(id, { col, row: row + parentRow(fold) });
  placeKids(tree, id, fold.inner, col + 1, row, out, fold.stack === true);
}
