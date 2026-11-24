/**
 * 事件序列上的两个纯函数，不碰任何状态（EventHub 的读与写各用一个）：
 * `sliceEvents` 按序号区间切出读取结果；`sameStream` 判断两段流式增量是不是同一条流（合并窗口里能不能拼接）。
 */

import type { EnsembleEvent } from "@shared/events";
import type { DeltaDraft, ReadEventsOptions } from "./hub-types";

/** 取 afterSeq 之后的事件，limit 给出时只要最后 N 条；总是返回新数组。序号在日志里严格递增，所以用二分找起点。 */
export function sliceEvents(list: readonly EnsembleEvent[], options: ReadEventsOptions): EnsembleEvent[] {
  const after = options.afterSeq ?? 0;
  let start = 0;
  if (after > 0) {
    let high = list.length;
    while (start < high) {
      const middle = (start + high) >>> 1;
      if ((list[middle]?.seq ?? 0) <= after) start = middle + 1;
      else high = middle;
    }
  }
  const limit = options.limit;
  const from = limit !== undefined && list.length - start > limit ? list.length - limit : start;
  return list.slice(from);
}

export function sameStream(a: DeltaDraft, b: DeltaDraft): boolean {
  if (a.kind !== b.kind || a.runId !== b.runId) return false;
  if (a.data.itemId !== b.data.itemId) return false;
  if (a.kind === "assistant.delta" && b.kind === "assistant.delta") return a.data.phase === b.data.phase;
  return true;
}
