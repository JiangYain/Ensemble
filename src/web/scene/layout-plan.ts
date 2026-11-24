import { blockShapes, placeBlock, type BlockShape, type Offset, type OriginPlacement } from "./layout-block";
import { cellsFor, GUTTER } from "./layout-cells";
import type { Joins } from "./layout-converge";
import { createFoldTree } from "./layout-fold";
import { FIT_ALL_MIN_ZOOM, NODE, type Area } from "./layout-geometry";
import { packOffsets, planPack, type PackPlan, type PackTile } from "./layout-pack";

/**
 * 格点排布的规划入口（规划式排布，见 `LayoutOptions.grid`）：经典的树放不下、放得下却是一条细长的竖串（见 `isSlender`）、
 * 或横屏里单个来源下叠着 3 个以上没有子会话的根会话（见 layout-stacked）时，试着把全部来源块改排成同一张格子里的规则网格——
 * 来源卡在上或在左，会话们按创建先后一行行装进去，父会话与它的子会话成块，
 * 来源块再按取景区域的宽高比分成几列竖排。在所有可能里取“放得下的缩放最大”的一种，所以外框的宽高比自然贴着取景区域。
 * 这里只做规划；摆出来核对后是否采用，由 layout-scene-select 的 `planScene` 决定。
 */

/** 一个来源块：来源的 key、来源卡的节点 id（树的根）。 */
export interface LatticeBlock {
  key: string;
  originId: string;
}

/** 经典排法里共用 Folder / Git 卡的一组来源：`lead` 是左边为那些卡片让出的列数（0 ~ 2），`weight` 是节点数。 */
export interface LatticeCluster {
  keys: readonly string[];
  lead: number;
  weight: number;
}

export interface LatticeInput {
  area: Area;
  compact: boolean;
  blocks: readonly LatticeBlock[];
  /** 节点的子节点（按创建先后）；来源卡的子节点是它的根会话。叶子是空数组。 */
  kidsOf: (id: string) => readonly string[];
  /** 整体的划分与经典排法一致：同样的来源、同样的先后（规划里的序号要用在新摆出来的整体上）。 */
  clusters: readonly LatticeCluster[];
  /** 汇聚会话 → 它在同一来源块里的全部上级（节点 id）：排布要让它在所有上级的右边（见 layout-converge）；没有汇聚时不给。 */
  joins?: Joins;
}

/** 规划的结果：整体放进取景区域的缩放（不封顶）、每一组的偏移，以及每个来源块里每张卡的位置。 */
export interface Lattice {
  scale: number;
  /** 来源卡与它左边的 Folder / Git 卡之间的水平间距（经典排法用 92）：左边每多一张卡就多一列。 */
  leadGap: number;
  /** 竖直叠放的来源块之间的间距。 */
  stackGap: number;
  /** 每一组（与 `LatticeInput.clusters` 同序）的偏移，像素。 */
  offsets: Offset[];
  /** 一个来源块里来源卡与每个会话节点的位置，以块的左上角为原点。 */
  positions: (key: string) => Map<string, Offset>;
}

/** 值得试的最宽容器（格数）：再宽的形态要缩到 FIT_ALL_MIN_ZOOM 以下才放得下。 */
const MAX_CONTAINER = 40;

/**
 * 小家族的界线：后代（子会话与它们的子孙）不超过这个数的会话，子会话们竖排成一列、整块都是它的（见 layout-fold 的 `Fold.stack`）——
 * 子会话竖排在父会话右边，线只走父会话与子会话之间那条 32px 的缝，不会从别的卡后面穿过；超过它的“大扇出”照旧按容器折（来源卡的会话也是）。
 * 取 5 的依据：竖排一列的高度是 行数 × 136 − 24，5 行 = 656px，放得进 1440×900 窗口的取景区域（710px），不必为它缩放；
 * 6 行就是 792px，要缩到 90%，这时按两列折更划算。6 块真实画布里，非来源的父会话的后代数要么不超过 4
 * （70b49d0d 最大 4，7295d4f1 有 14 个都是 1 ~ 2），要么不少于 11（299997f3 的 11、7295d4f1 的 21、7c1805af 的 16、88e325d7 的 37），
 * 没有一个落在 5 ~ 10 之间；界线取 4 ~ 10 的任何整数，这 6 块画布的排布都一样。
 */
export const SMALL_FAMILY = 5;

/** 来源卡的两种摆法；同样大时在上面的排前面（与原来的网格形态一致）。 */
const PLACEMENTS: readonly OriginPlacement[] = ["top", "left"];

export function planLattice(input: LatticeInput): Lattice | undefined {
  const { area, blocks, clusters } = input;
  const cells = cellsFor(input.compact);
  const origins = new Map(blocks.map((block) => [block.key, block.originId]));
  const originIds = new Set(origins.values());
  // 小家族（见 SMALL_FAMILY）的子会话竖排成一列；来源卡的“子会话”是根会话，是整张画布的网格，不在此列。
  const tree = createFoldTree(
    input.kidsOf,
    Math.min(MAX_CONTAINER, Math.floor((area.w / FIT_ALL_MIN_ZOOM + cells.gapX) / cells.pitchX)),
    (id, size) => size <= SMALL_FAMILY && !originIds.has(id),
  );

  // 整张画布的来源卡用同一种摆法（全部空间里不再有的在上、有的在左）：按摆法各规划一遍，整体缩放更大的采用，一样大取在上面的。
  // 只有一个来源块时没有“统一”可言，仍让它在两种摆法里自己取最优（见 blockShapes，打平时取更窄的）——单来源画布的排布与统一之前逐字相同；
  // 多个来源块时统一的代价是整体缩放可能比各挑各的略小。
  const placements: readonly (OriginPlacement | undefined)[] = blocks.length === 1 ? [undefined] : PLACEMENTS;
  let chosen: { plan: PackPlan; tiles: PackTile[] } | undefined;
  for (const placement of placements) {
    const shapes = new Map(blocks.map((block) => [block.key, blockShapes(tree, block.originId, placement, input.joins)]));
    const tiles: PackTile[] = clusters.map((cluster) => ({
      lead: cluster.lead,
      weight: cluster.weight,
      members: cluster.keys.map((key) => ({ key, shapes: shapes.get(key) as BlockShape[] })),
    }));
    const plan = planPack(tiles, area, cells);
    if (plan && (!chosen || plan.scale > chosen.plan.scale)) chosen = { plan, tiles };
  }
  if (!chosen) return undefined;
  const { plan, tiles } = chosen;
  return {
    scale: plan.scale,
    leadGap: cells.pitchX - NODE.folderW,
    stackGap: cells.gapY + GUTTER.rows * cells.pitchY,
    offsets: packOffsets(plan, tiles, cells),
    positions: (key) => placeBlock(tree, origins.get(key) as string, plan.picks.get(key) as BlockShape, cells, input.joins),
  };
}

/** 会话数达到这个数才算“多”，对外框的形状要求更严（见 `isSlender`）。 */
const MANY = 12;

/**
 * 经典的树放得下缩放上限、但外框是不是一条细长的串：整体的宽高比与取景区域的宽高比相差太多。
 * 会话多（≥ MANY）时两个方向都要在 0.7 ~ 1.43 倍之内；会话少时只看竖串（< 0.55 倍：五六个会话叠成一列），
 * 横向的短串（来源 → 会话 → 子会话 一路向右）是树本来的样子，放得下就不去动它。
 */
export function isSlender(box: Area, area: Area, count: number): boolean {
  if (box.w <= 0 || box.h <= 0) return false;
  const ratio = box.w / box.h / (area.w / area.h);
  return count >= MANY ? ratio < 0.7 || ratio > 1 / 0.7 : ratio < 0.55;
}
