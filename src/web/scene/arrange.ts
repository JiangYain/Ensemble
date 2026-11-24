import type { NodePosition } from "./positions";

/**
 * 多选后的对齐与等距分布：只做几何计算，不碰 DOM，也不关心节点是什么。
 * 入参是节点的“目标位置”与尺寸（世界坐标），返回每个节点的新位置；是否真的变了、怎么动画由引擎决定。
 */

export type AlignMode = "left" | "hcenter" | "right" | "top" | "vmiddle" | "bottom";
export type DistributeAxis = "horizontal" | "vertical";

export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 落在整数像素上：存下来的坐标稳定，边缘也不会出现半像素的发虚。 */
const snap = (value: number): number => Math.round(value);

function extent(boxes: readonly Box[]): { left: number; right: number; top: number; bottom: number } {
  return {
    left: Math.min(...boxes.map((box) => box.x)),
    right: Math.max(...boxes.map((box) => box.x + box.w)),
    top: Math.min(...boxes.map((box) => box.y)),
    bottom: Math.max(...boxes.map((box) => box.y + box.h)),
  };
}

/** 以选中节点的整体外框为基准对齐：少于两个节点没有可对齐的对象，返回空。 */
export function alignBoxes(boxes: readonly Box[], mode: AlignMode): Map<string, NodePosition> {
  const result = new Map<string, NodePosition>();
  if (boxes.length < 2) return result;
  const { left, right, top, bottom } = extent(boxes);
  for (const box of boxes) {
    let { x, y } = box;
    if (mode === "left") x = left;
    else if (mode === "hcenter") x = (left + right) / 2 - box.w / 2;
    else if (mode === "right") x = right - box.w;
    else if (mode === "top") y = top;
    else if (mode === "vmiddle") y = (top + bottom) / 2 - box.h / 2;
    else y = bottom - box.h;
    result.set(box.id, { x: snap(x), y: snap(y) });
  }
  return result;
}

/**
 * 等距分布：整体外框不变，节点之间的空隙相等，顺序按中心位置排。
 * 至少三个节点才有“中间的”可分布；各节点比外框还宽时空隙为负，等同于均匀重叠。
 */
export function distributeBoxes(boxes: readonly Box[], axis: DistributeAxis): Map<string, NodePosition> {
  const result = new Map<string, NodePosition>();
  if (boxes.length < 3) return result;
  const horizontal = axis === "horizontal";
  const start = (box: Box): number => (horizontal ? box.x : box.y);
  const size = (box: Box): number => (horizontal ? box.w : box.h);
  const ordered = [...boxes].sort((a, b) => start(a) + size(a) / 2 - (start(b) + size(b) / 2) || (a.id < b.id ? -1 : 1));
  const { left, right, top, bottom } = extent(boxes);
  const from = horizontal ? left : top;
  const span = (horizontal ? right : bottom) - from;
  const gap = (span - ordered.reduce((sum, box) => sum + size(box), 0)) / (ordered.length - 1);
  let cursor = from;
  for (const box of ordered) {
    result.set(box.id, horizontal ? { x: snap(cursor), y: box.y } : { x: box.x, y: snap(cursor) });
    cursor += size(box) + gap;
  }
  return result;
}
