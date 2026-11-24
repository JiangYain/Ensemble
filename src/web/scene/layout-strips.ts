import { fitScale, NODE, type Area, type LayoutNode } from "./layout-geometry";

/**
 * 来源块之上的整体排布（经典排法）：把一个个来源块（或共用 Folder / Git 卡的一组来源）分成几列竖排，按列数取舍（`arrange`、`planClassic`）。
 * 规划式排布（`LayoutOptions.grid`）换成格点排布时的分列见 layout-pack。
 * 这里只做数字上的取舍：块的尺寸来自 layout-scene-assemble.ts 的 assemble 摆好的节点，本文件不碰会话数据。
 */

/** 最多并排几列发起端。 */
const MAX_COLUMNS = 4;

/**
 * 一起摆放的最小单位：一个发起端，或共用同一张 Git / Folder 节点的几个发起端（连同那些节点）。
 * 组内自左向右是 Git 节点 → Folder 节点 → 来源节点 → 会话；前两列有就占位，没有就不占。
 */
export interface Cluster {
  nodes: LayoutNode[];
  width: number;
  height: number;
  /** 组的左边为 Git、Folder 节点让出的那几列的宽度（含间距），也就是来源节点在组内的 x；都没有是 0。已计入 width。 */
  lead: number;
  /** 组里的来源（来源的 key）：格点排布据此知道这一组由哪几个来源块拼成。 */
  keys: string[];
}

export interface Plan {
  columns: number;
  offsets: { x: number; y: number }[];
  width: number;
  height: number;
  scale: number;
}

/** 两套摆法划分出来的整体是否一一对应（同样的来源、同样的先后）：对得上，规划里的序号才能用在新摆出来的整体上。 */
export function sameClusters(a: readonly Cluster[], b: readonly Cluster[]): boolean {
  return a.length === b.length && a.every((cluster, i) => cluster.keys.length === b[i]!.keys.length && cluster.keys.every((key, j) => key === b[i]!.keys[j]));
}

/** 把若干组依次放进当前最矮的一列，返回每一列装了哪几组（组的序号，按先后）。 */
function assignColumns(clusters: readonly Cluster[], columns: number): number[][] {
  const members: number[][] = Array.from({ length: columns }, () => []);
  const heights: number[] = Array.from({ length: columns }, () => 0);
  clusters.forEach((cluster, index) => {
    let target = 0;
    for (let c = 1; c < columns; c++) if ((heights[c] as number) < (heights[target] as number)) target = c;
    (members[target] as number[]).push(index);
    heights[target] = (heights[target] as number) + (members[target]!.length > 1 ? NODE.groupGap : 0) + cluster.height;
  });
  return members;
}

/** 按“每一列装了哪几组”算出各组的偏移量与整体宽高：列从左到右、列内从上到下，列间隔 clusterGap、列内的组间隔 groupGap。 */
function placeColumns(
  clusters: readonly Cluster[],
  members: readonly (readonly number[])[],
): { offsets: { x: number; y: number }[]; width: number; height: number } {
  const columns = members.length;
  const heights = members.map((list) => list.reduce((sum, index, order) => sum + (order > 0 ? NODE.groupGap : 0) + (clusters[index] as Cluster).height, 0));

  // 同一列里各组的来源节点共用一条竖轴：列里只要有一组左边接着 Git 节点，没有的那些组也在左边留出同样的空位。
  const leads = members.map((list) => Math.max(0, ...list.map((index) => (clusters[index] as Cluster).lead)));
  const widths = members.map((list, column) => (leads[column] as number) + Math.max(0, ...list.map((index) => (clusters[index] as Cluster).width - (clusters[index] as Cluster).lead)));
  const offsets: { x: number; y: number }[] = Array.from({ length: clusters.length }, () => ({ x: 0, y: 0 }));
  let x = 0;
  members.forEach((list, column) => {
    let y = 0;
    for (const index of list) {
      offsets[index] = { x: x + (leads[column] as number) - (clusters[index] as Cluster).lead, y };
      y += (clusters[index] as Cluster).height + NODE.groupGap;
    }
    x += (widths[column] as number) + NODE.clusterGap;
  });

  const width = widths.reduce((sum, w) => sum + w, 0) + (columns - 1) * NODE.clusterGap;
  const height = Math.max(...heights);
  return { offsets, width, height };
}

/**
 * 把若干组摆成 columns 列：每组依次放进当前最矮的一列。
 * `raw` 为真时，`scale` 是“放得下的最大缩放”（宽高各自的比例取较小者，不封顶、不受可读下限约束），规划式排布用它比较各种列数与格点排布；
 * 否则是经典的自动取景比例（fitScale：不放大、只因太高而缩小时停在 FIT_FLOOR）。
 */
function planColumns(clusters: readonly Cluster[], columns: number, area: Area | undefined, raw = false): Plan {
  const { offsets, width, height } = placeColumns(clusters, assignColumns(clusters, columns));
  const scale = !area ? 1 : raw ? Math.min(area.w / width, area.h / height) : fitScale({ w: width, h: height }, area);
  return { columns, offsets, width, height, scale };
}

/** 把各组的偏移量写回它们的节点。 */
export function shiftClusters(clusters: readonly Cluster[], offsets: readonly { x: number; y: number }[]): void {
  clusters.forEach((cluster, index) => {
    const offset = offsets[index] as { x: number; y: number };
    for (const node of cluster.nodes) {
      node.x += offset.x;
      node.y += offset.y;
    }
  });
}

/** 选一种列数并把偏移量写回节点；比单列明显更大（至少 2%）才换成多列，避免无谓的并排。 */
export function arrange(clusters: readonly Cluster[], area: Area | undefined): void {
  if (clusters.length === 0) return;
  const maxColumns = area ? Math.min(clusters.length, MAX_COLUMNS) : 1;
  let best = planColumns(clusters, 1, area);
  for (let columns = 2; columns <= maxColumns; columns++) {
    const plan = planColumns(clusters, columns, area);
    if (plan.scale > best.scale * 1.02) best = plan;
  }
  shiftClusters(clusters, best.offsets);
}

/**
 * 规划式排布里的经典排法：在 1~MAX_COLUMNS 列里选一种。与 `arrange` 的区别有两处——
 * 比较用的是“放得下的最大缩放”而不是 fitScale（后者在太高时停在 FIT_FLOOR，等于不看高度，会让一长串来源挤成单列）；
 * 已经能在缩放上限 `cap` 下放进取景区域就不再增加列数（放得下就不为排而排）。多一列要明显更好（至少 2%）才换。
 */
export function planClassic(clusters: readonly Cluster[], area: Area, cap: number): Plan {
  const maxColumns = Math.min(clusters.length, MAX_COLUMNS);
  let best = planColumns(clusters, 1, area, true);
  for (let columns = 2; columns <= maxColumns && best.scale < cap; columns++) {
    const plan = planColumns(clusters, columns, area, true);
    if (plan.scale > best.scale * 1.02) best = plan;
  }
  return best;
}
