import { spanX, type Cells } from "./layout-cells";
import { settleBlock, type Joins } from "./layout-converge";
import { foldOf, parentRow, pareto, type FoldTree, type Span, type Spot } from "./layout-fold";
import { NODE, type LayoutNode } from "./layout-geometry";

/**
 * 一个来源块（来源卡加它名下全部会话）在格子里的外形。来源卡有两种摆法：
 * - 在左边（`top` 为假）：来源卡在最左一列、竖直居中，会话们在右边——经典的树的形态，按格子排整齐了；
 * - 在上面（`top` 为真）：来源卡在第一行、水平居中于下面的会话块，会话们在它下面。会话多、块偏宽时，它比“多出一整列”省得多。
 * `inner` 是会话们并排用的容器宽度（见 layout-fold）。
 */
export interface BlockShape extends Span {
  top: boolean;
  inner: number;
}

/** 来源卡的摆法：在块的上方（独占第一行）或在块的左边（独占最左一列）。 */
export type OriginPlacement = "top" | "left";

/**
 * 一个来源块能排成的各种外形：宽升高降（见 pareto）。只有一张来源卡的块是 1 × 1。
 * `only` 指定摆法时只给这一种摆法的外形——整张画布的来源卡必须用同一种摆法（见 layout-plan 的 `planLattice`），由它按摆法各规划一遍再比；
 * 不指定时两种摆法混在一起取不被压过的（同样大小时在上面的排前面），这是单个块自己的最优。
 * 两种摆法给来源卡的都是“专用的一行 / 一列”：来源卡不会压住任何一张会话卡，只是占掉的格子不同（在上面多一行，在左边多一列）。
 */
export function blockShapes(tree: FoldTree, originId: string, only?: OriginPlacement, joins?: Joins): BlockShape[] {
  const { block } = foldOf(tree, originId);
  if (block.length === 0) return [{ cols: 1, rows: 1, top: only === "top", inner: 0 }];
  const left = block.map((fold): BlockShape => ({ cols: fold.cols + 1, rows: fold.rows, top: false, inner: fold.inner }));
  const top = block.map((fold): BlockShape => ({ cols: fold.cols, rows: fold.rows + 1, top: true, inner: fold.inner }));
  // 同样大小时来源卡在上面的排前面：与原来的网格形态（来源卡居中在最上）一致，会话少的画布不会因为改了排法而换了模样。
  const shapes = only === "top" ? pareto(top) : only === "left" ? pareto(left) : pareto([...top, ...left]);
  // 汇聚会话右移之后块可能更宽、更高：外形要按右移之后的实际占格算（装箱按它留位置），再重新取不被压过的。
  return joins && hasJoin(tree, originId, joins) ? pareto(shapes.map((shape) => measured(tree, originId, shape, joins))) : shapes;
}

/** 来源块里有没有汇聚会话（沿树往下找）。 */
function hasJoin(tree: FoldTree, originId: string, joins: Joins): boolean {
  const stack = [originId];
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    if (joins.has(id)) return true;
    stack.push(...tree.kidsOf(id));
  }
  return false;
}

/** 汇聚会话移到所有上级右边之后的实际外形：来源卡的摆法与容器宽度不变，宽高按实际占格重新量（见 layout-converge 的 `settleBlock`）。 */
function measured(tree: FoldTree, originId: string, shape: BlockShape, joins: Joins): BlockShape {
  const { spots, moved } = settleBlock(tree, originId, shape.top, shape.inner, joins);
  if (!moved) return shape;
  let cols = shape.top ? 0 : 1;
  let rows = shape.top ? 1 : 0;
  for (const spot of spots.values()) {
    cols = Math.max(cols, spot.col + 1);
    rows = Math.max(rows, spot.row + 1);
  }
  return { ...shape, cols, rows };
}

/** 块内的位置（像素，以块的左上角为原点）。 */
export interface Offset {
  x: number;
  y: number;
}

/**
 * 按 `shape` 摆好一个来源块：来源卡与它名下每个会话的位置（节点 id → 像素，以块的左上角为原点）。
 * 会话卡左缘贴着格子的左缘；来源卡在左边时同样，在上面时水平居中于整块的宽度（取整，半个像素会让卡片里的文字发虚）。
 */
export function placeBlock(tree: FoldTree, originId: string, shape: BlockShape, cells: Cells, joins?: Joins): Map<string, Offset> {
  const at = new Map<string, Offset>();
  const px = (spot: Spot): Offset => ({ x: spot.col * cells.pitchX, y: spot.row * cells.pitchY });
  if (shape.inner === 0) {
    at.set(originId, { x: 0, y: 0 });
    return at;
  }
  at.set(originId, shape.top ? { x: Math.round((spanX(cells, shape.cols) - cells.originW) / 2), y: 0 } : px({ col: 0, row: parentRow(shape) }));
  for (const [id, spot] of settleBlock(tree, originId, shape.top, shape.inner, joins).spots) at.set(id, px(spot));
  return at;
}

/**
 * 重写一个来源块里每个会话节点的锚点（新会话出现时，参照被用户挪走过就落在参照旁边，见 LayoutNode.anchor）：
 * 同一父下第一个是父节点（根会话是来源卡），偏移是布局里的实际相对位置；其余各挂在上一个兄弟下面，水平不错位（格点排布没有错位），
 * 竖直只隔一个行距。`nodes` 是这一块的节点（来源卡在最前、父在子之前），锚点只会指向其中的节点。
 */
export function anchorBlock(nodes: readonly LayoutNode[], originId: string, kidsOf: (id: string) => readonly string[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const chain = (parentId: string): void => {
    const parent = byId.get(parentId);
    if (!parent) return;
    let before: LayoutNode | undefined;
    for (const id of kidsOf(parentId)) {
      const kid = byId.get(id);
      if (!kid) continue;
      kid.anchor = before ? { id: before.id, dx: 0, dy: before.h + NODE.rowGap } : { id: parent.id, dx: kid.x - parent.x, dy: kid.y - parent.y };
      before = kid;
      chain(id);
    }
  };
  chain(originId);
}
