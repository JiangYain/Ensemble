import { layerOf } from "@shared/lineage";
import type { SessionId } from "@shared/types";
import { placeKids, withKids, type FoldTree, type Spot } from "./layout-fold";

/**
 * 汇聚（一个会话有多个上级）怎么排。两条排法共用同一条规则：**汇聚会话所在的列严格大于它每一个上级所在的列**，
 * 连进来的线才都是从左往右、读得出“先有上级、后有它”；必要时多占一列、整体缩放略降，这是用户认可的代价。
 * 只有同一个来源块里的上级参与：不同来源块各有各的坐标，块与块之间的相对位置由整体排布另外决定，那里没有“左右”可比（连线照样画）。
 *
 * - 经典的树：每个会话的列取同一来源块里的最长链深度（`columnOf`），汇聚会话被推到所有上级的右边，它的子会话顺着往右排；
 * - 格点排布（`settleBlock`）：汇聚会话仍挂在第一个上级的家族里照常折（上级们的右边正好空着时一格都不用动）；
 *   落在某个上级左边或同一列的，连同它的子树从折叠里摘掉、重折（家族与格子重新紧凑，不留空洞），再放到所有上级的右边。
 * 没有汇聚时两张表都是空的，排布与没有这条规则时逐字相同。
 */
export interface Convergence {
  /** 经典排法里会话的列（没有汇聚时是空表，列就是树里的深度）。 */
  columnOf: Map<SessionId, number>;
  /** 汇聚会话 → 它在同一来源块里的全部上级（至少两个，第一个是主上级）；键值都是节点 id，按创建先后。 */
  joins: Map<string, string[]>;
}

export interface ConvergenceInput {
  /** 排进来的会话 id，按创建先后。 */
  ordered: readonly SessionId[];
  /** 每个会话画出来的上级（已去掉环上的连线），第一个是主上级。 */
  drawn: ReadonlyMap<SessionId, readonly SessionId[]>;
  /** 会话在树形排布里挂的上级（没有就是根）。 */
  layoutParentOf: ReadonlyMap<SessionId, SessionId>;
  /** 根会话的来源 key：来源块就按它划分。 */
  originKeyOf: (rootId: SessionId) => string;
  /** 会话 id → 画布节点 id。 */
  nodeId: (id: SessionId) => string;
}

export function convergence(input: ConvergenceInput): Convergence {
  const { ordered, drawn, layoutParentOf } = input;
  const columnOf = new Map<SessionId, number>();
  const joins = new Map<string, string[]>();
  if (!ordered.some((id) => (drawn.get(id)?.length ?? 0) > 1)) return { columnOf, joins };
  const blocks = new Map<SessionId, string>();
  /** 会话所在的来源块：顺着树里的上级一路上溯到根，取根会话的来源（与 roots 的分组一致）。 */
  const blockOf = (id: SessionId): string => {
    const trail: SessionId[] = [];
    let cursor: SessionId | undefined = id;
    let key: string | undefined;
    while (cursor !== undefined) {
      key = blocks.get(cursor);
      if (key !== undefined) break;
      trail.push(cursor);
      cursor = layoutParentOf.get(cursor);
    }
    // 上溯到头也没有记过：trail 的最后一个就是根会话。
    key ??= input.originKeyOf(trail[trail.length - 1] as SessionId);
    for (const member of trail) blocks.set(member, key);
    return key;
  };
  const parentsIn = (id: SessionId): SessionId[] => (drawn.get(id) ?? []).filter((parentId) => blockOf(parentId) === blockOf(id));
  for (const [id, column] of layerOf(ordered, parentsIn).depths) columnOf.set(id, column);
  for (const id of ordered) {
    const parents = parentsIn(id);
    if (parents.length > 1) joins.set(input.nodeId(id), parents.map(input.nodeId));
  }
  return { columnOf, joins };
}

/** 格点排布里每个汇聚会话的上级（节点 id）。 */
export type Joins = ReadonlyMap<string, readonly string[]>;

/**
 * 一个来源块里全部会话的格子（不含来源卡）：按 `inner` 宽的容器折好；有汇聚时再让汇聚会话落在所有上级的右边（见文件头）。
 * `moved` 是有没有汇聚会话被右移：没有时就是原来的折叠结果，一格不差。
 */
export function settleBlock(tree: FoldTree, originId: string, top: boolean, inner: number, joins?: Joins): { spots: Map<string, Spot>; moved: boolean } {
  const lay = (from: FoldTree): Map<string, Spot> => {
    const spots = new Map<string, Spot>();
    placeKids(from, originId, inner, top ? 0 : 1, top ? 1 : 0, spots);
    return spots;
  };
  const folded = lay(tree);
  if (!joins || joins.size === 0) return { spots: folded, moved: false };
  // 块的上缘与左缘：来源卡在上面时第 0 行是它，在左边时第 0 列是它，汇聚会话不能落进去。
  const edge: Edge = { row: top ? 1 : 0, col: top ? 0 : 1 };
  // 第一遍：哪些汇聚子树会被右移（在副本上试，原件留着取它们的相对形状）。
  const moved = enforceJoins(new Map(folded), joins, tree.kidsOf, edge);
  if (moved.length === 0) return { spots: folded, moved: false };
  // 第二遍：把它们摘掉重折，再放回所有上级的右边。
  const gone = new Set(moved);
  const spots = lay(withKids(tree, (id) => tree.kidsOf(id).filter((kid) => !gone.has(kid))));
  for (const id of moved) {
    const parents = (joins.get(id) ?? []).flatMap((parent) => spots.get(parent) ?? []);
    putSubtree(spots, shapeOf(folded, id, tree.kidsOf), Math.max(edge.col, columnAfter(parents)), meanRow(parents, edge.row), edge.row);
  }
  // 兜底：重折改变了列的分布，仍有没满足的就在原地右移（留下的空洞只在这种少见的情形里出现）。
  enforceJoins(spots, joins, tree.kidsOf, edge);
  return { spots, moved: true };
}

/** 块里汇聚会话能用的最上一行与最左一列。 */
interface Edge {
  row: number;
  col: number;
}

/** 一个格子的键：行与列都远小于 4096。 */
const cellKey = (col: number, row: number): number => row * 4096 + col;

const columnAfter = (parents: readonly Spot[]): number => parents.reduce((most, spot) => Math.max(most, spot.col + 1), 0);
const meanRow = (parents: readonly Spot[], fallback: number): number =>
  parents.length === 0 ? fallback : Math.round(parents.reduce((sum, spot) => sum + spot.row, 0) / parents.length);

/** 一棵子树里每个成员相对根的列、行偏移。 */
function shapeOf(spots: ReadonlyMap<string, Spot>, id: string, kidsOf: (id: string) => readonly string[]): Offsets {
  const root = spots.get(id) as Spot;
  return subtree(spots, id, kidsOf).map((member) => {
    const at = spots.get(member) as Spot;
    return { member, dc: at.col - root.col, dr: at.row - root.row };
  });
}

type Offsets = readonly { member: string; dc: number; dr: number }[];

/** `id` 与它的子孙里排了位置的那些（树里的挂法，`id` 在最前）。 */
function subtree(spots: ReadonlyMap<string, Spot>, id: string, kidsOf: (id: string) => readonly string[]): string[] {
  const group: string[] = [];
  const walk = (member: string): void => {
    if (!spots.has(member)) return;
    group.push(member);
    for (const kid of kidsOf(member)) walk(kid);
  };
  walk(id);
  return group;
}

/**
 * 把一个来源块里违反“汇聚会话在所有上级右边”的会话，连同它整棵子树（按树里的挂法）整块右移到最右一个上级的右边一列：
 * 没有违反的、与它们不相干的一格都不动。`spots` 原地改写，返回被右移的汇聚会话（按创建先后）。
 * `joins` 按创建先后给出，上级一定先于它的子会话摆好（上级只会在更早的汇聚会话那里被右移），所以一遍就够。
 */
function enforceJoins(spots: Map<string, Spot>, joins: Joins, kidsOf: (id: string) => readonly string[], edge: Edge): string[] {
  const moved: string[] = [];
  for (const [id, parents] of joins) {
    const here = spots.get(id);
    if (!here) continue;
    const found = parents.flatMap((parent) => spots.get(parent) ?? []);
    const need = columnAfter(found);
    if (here.col >= need) continue;
    const shape = shapeOf(spots, id, kidsOf);
    for (const { member } of shape) spots.delete(member);
    putSubtree(spots, shape, need, meanRow(found, edge.row), edge.row);
    moved.push(id);
  }
  return moved;
}

/**
 * 把一棵子树（`shape`：每个成员相对根的列、行偏移）放到根在第 `col` 列的位置，行从 `wanted` 起上下交替往外找第一处整棵子树都空着的：
 * 线从左往右、尽量不用绕远；`col` 落在块的右边缘外（新多出来的一列）时这一列整列都是空的，通常第一行就放得下。
 * 实在没有空位就放到所有卡的下面（一定放得下，只多占几行）。块的上缘 `floor` 不会被突破。
 * 一个来源块里有几个汇聚会话时这个选择不保证整体最优：线可能从别的卡后面穿过（上级与它隔着 ≥ 2 列时本来就避不开）——
 * 规则保证的是“列在所有上级的右边”，不是“线不穿卡”；只隔一列时线走在 32px 的缝里，不会穿卡。
 */
function putSubtree(spots: Map<string, Spot>, shape: Offsets, col: number, wanted: number, floor: number): void {
  const taken = new Set<number>();
  let bottom = floor - 1;
  for (const at of spots.values()) {
    taken.add(cellKey(at.col, at.row));
    bottom = Math.max(bottom, at.row);
  }
  const fits = (row: number): boolean => shape.every(({ dc, dr }) => row + dr >= floor && !taken.has(cellKey(col + dc, row + dr)));
  const highest = Math.min(...shape.map(({ dr }) => dr));
  const reach = bottom - floor + shape.length + 1;
  const choose = (): number => {
    for (let step = 0; step <= reach; step++) {
      if (fits(wanted + step)) return wanted + step;
      if (step > 0 && fits(wanted - step)) return wanted - step;
    }
    // 实在没有空位：放到所有别的卡下面（子树最靠上的一行紧接在最下面一行后面）。
    return bottom + 1 - highest;
  };
  const row = choose();
  for (const { member, dc, dr } of shape) spots.set(member, { col: col + dc, row: row + dr });
}
