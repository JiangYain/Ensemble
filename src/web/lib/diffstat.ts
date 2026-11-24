import type { FileChange } from "@shared/types";

/** 一个文件变更里要画出来的行数；某一侧是 undefined 就不画那一侧。 */
export interface ShownDelta {
  added: number | undefined;
  removed: number | undefined;
}

function shown(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * 文件变更里值得画出来的行数——只写真实知道、且说明了问题的数字：
 * - 执行端没有上报（undefined）不是 0：不画，更不写成“+0”“−0”；
 * - 上报了 0 也不画：红色的“−0”只是噪音，另一侧的数字已经说明了这次改动。
 * 两侧都没有可画的数字时返回 undefined，调用方连外层的容器也不必渲染。
 */
export function shownDelta(file: Pick<FileChange, "addedLines" | "removedLines">): ShownDelta | undefined {
  const added = shown(file.addedLines);
  const removed = shown(file.removedLines);
  return added === undefined && removed === undefined ? undefined : { added, removed };
}

/** 累加两个可能没上报的行数：两个都没上报时仍是“未知”（undefined），不会变成 0。 */
export function addKnown(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}
