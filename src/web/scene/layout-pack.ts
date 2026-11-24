import { within } from "./layout-fold";
import type { BlockShape, Offset } from "./layout-block";
import { GUTTER, spanX, spanY, type Cells } from "./layout-cells";
import type { Area } from "./layout-geometry";

/**
 * 来源块之上的整体排布（格点排布）：把一块块来源块（或共用 Folder / Git 卡的一组来源）分成几列竖排，
 * 每个来源块从它能排成的几种外形里选一种，使整体放进取景区域的缩放最大。全部在整数的列数与行数里算，换成像素见 layout-cells。
 * 本文件只做数字上的取舍：不认识会话，也不碰节点。
 */

/** 最多把来源块分成几列竖排：窄的形态在小缩放下可以并排很多列。 */
const MAX_STRIPS = 16;

/** 规划用的一个来源块：它能排成的几种外形（宽升高降），`key` 是来源的 key。 */
export interface PackMember {
  key: string;
  shapes: readonly BlockShape[];
}

/**
 * 规划用的一块：一组共用 Folder / Git 卡的来源（`members`，竖直叠放），`lead` 是左边为那些卡片让出的列数，
 * `weight` 是它的节点数（含来源卡）——用来在各列之间分摊，节点多的块占得多。
 */
export interface PackTile {
  lead: number;
  weight: number;
  members: readonly PackMember[];
}

/** 规划的结果：放得下的最大缩放（不封顶）、各列装了哪几块（`PackTile` 的序号，按先后），以及每个来源块采用的外形。 */
export interface PackPlan {
  scale: number;
  strips: number[][];
  picks: Map<string, BlockShape>;
}

/** 一块里各来源块叠起来的行数。 */
const tileRows = (rows: readonly number[]): number => rows.reduce((sum, r, i) => sum + r + (i > 0 ? GUTTER.rows : 0), 0);

/** 一列在宽度预算 `budget`（格）下的大小：各块里每个来源块取预算内最矮的外形。`cols` 不含左边为 Folder / Git 让出的 `lead`。 */
function stripSize(tiles: readonly PackTile[], list: readonly number[], budget: number): { cols: number; rows: number } {
  let cols = 0;
  let rows = 0;
  list.forEach((index, order) => {
    const shapes = (tiles[index] as PackTile).members.map((member) => within(member.shapes, budget) as BlockShape);
    for (const shape of shapes) cols = Math.max(cols, shape.cols);
    rows += (order > 0 ? GUTTER.rows : 0) + tileRows(shapes.map((shape) => shape.rows));
  });
  return { cols, rows };
}

/** 这一列的宽度预算再放宽一档：取列里所有来源块“比当前预算更宽的外形”中最窄的那个宽度；没有更宽的外形就是 undefined。 */
function widerBudget(tiles: readonly PackTile[], list: readonly number[], budget: number): number | undefined {
  let next = Infinity;
  for (const index of list) {
    for (const member of (tiles[index] as PackTile).members) {
      const wider = member.shapes.find((shape) => shape.cols > budget);
      if (wider) next = Math.min(next, wider.cols);
    }
  }
  return Number.isFinite(next) ? next : undefined;
}

/**
 * 把各块分成 `count` 列竖排并给每个来源块选外形，使整体放进 `area` 的缩放最大（`area.w / 总宽` 与 `area.h / 总高` 里较小的那个，不封顶）：
 * 1. 各块依次放进“节点数合计最少”的一列（保持各块原有的先后，不重排）；
 * 2. 每列的宽度预算从最窄的外形起步——所有块都取最窄、最高的形态；
 * 3. 反复把当前最高的那一列放宽一档（它的块可以换成更宽更矮的外形），直到它再也放不宽；每一步都算一次整体缩放，留下最大的一次。
 * 只放宽最高的那一列，是因为整体的高度由它决定，放宽别的列只会白白加宽、让缩放变小。
 */
function planStripCount(tiles: readonly PackTile[], count: number, area: Area, cells: Cells): PackPlan {
  const strips: number[][] = Array.from({ length: count }, () => []);
  const load = Array.from({ length: count }, () => 0);
  tiles.forEach((tile, index) => {
    let target = 0;
    for (let s = 1; s < count; s++) if ((load[s] as number) < (load[target] as number)) target = s;
    (strips[target] as number[]).push(index);
    load[target] = (load[target] as number) + tile.weight;
  });
  const leads = strips.map((list) => Math.max(0, ...list.map((index) => (tiles[index] as PackTile).lead)));
  const budgets = strips.map((list) => Math.max(...list.flatMap((index) => (tiles[index] as PackTile).members.map((member) => (member.shapes[0] as BlockShape).cols))));

  let best: { scale: number; budgets: number[] } | undefined;
  for (;;) {
    const sizes = strips.map((list, s) => stripSize(tiles, list, budgets[s] as number));
    const cols = sizes.reduce((sum, size, s) => sum + (leads[s] as number) + size.cols, 0) + (count - 1) * GUTTER.cols;
    const rows = Math.max(...sizes.map((size) => size.rows));
    const scale = Math.min(area.w / spanX(cells, cols), area.h / spanY(cells, rows));
    if (!best || scale > best.scale) best = { scale, budgets: [...budgets] };
    let tallest = 0;
    for (let s = 1; s < count; s++) if ((sizes[s] as { rows: number }).rows > (sizes[tallest] as { rows: number }).rows) tallest = s;
    const wider = widerBudget(tiles, strips[tallest] as number[], budgets[tallest] as number);
    if (wider === undefined) break;
    budgets[tallest] = wider;
  }

  const chosen = best as { scale: number; budgets: number[] };
  const picks = new Map<string, BlockShape>();
  strips.forEach((list, s) => {
    for (const index of list) for (const member of (tiles[index] as PackTile).members) picks.set(member.key, within(member.shapes, chosen.budgets[s] as number) as BlockShape);
  });
  return { scale: chosen.scale, strips, picks };
}

/**
 * 在 1 到 MAX_STRIPS 列里选整体缩放最大的一种分法；缩放只差 1% 以内时取列数少的（少一道并排就少一道断层）。没有块可排就是 undefined。
 * 注意这里的缩放是“放得下的最大缩放”，没有封顶：多种分法都超过缩放上限时，取最大的那个，就是与取景区域长宽比最贴合的一种。
 */
export function planPack(tiles: readonly PackTile[], area: Area, cells: Cells): PackPlan | undefined {
  let best: PackPlan | undefined;
  const limit = Math.min(tiles.length, MAX_STRIPS);
  for (let count = 1; count <= limit; count++) {
    const plan = planStripCount(tiles, count, area, cells);
    if (!best || plan.scale > best.scale * 1.01) best = plan;
  }
  return best;
}

/**
 * 每一块（`PackTile`，与 `tiles` 同序）在整体里的偏移（像素）：列从左到右、列内从上到下，列与列、块与块之间只隔格子之间的空白（见 GUTTER）。
 * 同一列里各块的来源卡共用一条竖轴：列里只要有一块左边接着 Folder / Git 卡，没有的那些块也在左边留出同样的空位。
 */
export function packOffsets(plan: PackPlan, tiles: readonly PackTile[], cells: Cells): Offset[] {
  const offsets: Offset[] = Array.from({ length: tiles.length }, () => ({ x: 0, y: 0 }));
  let col = 0;
  for (const list of plan.strips) {
    const lead = Math.max(0, ...list.map((index) => (tiles[index] as PackTile).lead));
    let width = 0;
    let row = 0;
    list.forEach((index, order) => {
      const tile = tiles[index] as PackTile;
      const shapes = tile.members.map((member) => plan.picks.get(member.key) as BlockShape);
      for (const shape of shapes) width = Math.max(width, shape.cols);
      row += order > 0 ? GUTTER.rows : 0;
      offsets[index] = { x: (col + lead - tile.lead) * cells.pitchX, y: row * cells.pitchY };
      row += tileRows(shapes.map((shape) => shape.rows));
    });
    col += lead + width + GUTTER.cols;
  }
  return offsets;
}
