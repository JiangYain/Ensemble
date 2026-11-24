import type { SessionSummary } from "@shared/types";
import type { Area } from "./layout-geometry";

/**
 * 少量根会话不再排成“单列竖堆”（规划式排布的一条补充规则）。
 *
 * 经典排法里一个来源的根会话自上而下排成一列、来源卡在左边；会话少时那是树本来的样子，所以 `isSlender`（layout-plan）
 * 只拦宽高比太悬殊的竖串。可是 5 个根会话在 1440×900 下恰好落在阈值边上（外框宽高比是取景区域的 0.57 倍，阈值 0.55），
 * 于是排成一列竖堆；6 个起才是来源卡在上居中的整齐网格。同样的内容、差一个会话就换一种模样，用户看到的就是“竖到底、不整齐”。
 *
 * 这里补上直接的一条，不再靠宽高比的边界去碰运气：
 * - 取景区域是横屏（宽 ≥ 高）；
 * - 画布上只有一个来源（多个来源并排时，来源之间本来就是左右并列的列，不是“一列到底”）；
 * - 这个来源名下至少有 `MIN_STACKED` 个单卡根会话（没有子会话的根会话）。
 * 三条都满足时，经典排法放得下、外框又不够细长也不再直接保留，而是试格点网格（来源卡在上居中或在左，会话一行行排满）；网格同样要放得进缩放上限才换下经典排法（见 layout-scene-select 的 `planScene`）。竖屏（高 > 宽）里单列本来就贴着取景区域的形状，不受这条管。
 *
 * 为什么是 3：两个根会话上下并排，读作“一对”；三个起就是叠成一列，再多只是更长。带子会话的根会话不数——
 * 它向右长出去的子树让外框变宽，经典的树（来源 → 会话 → 子会话一路向右）本来就是横向展开的，仍由 `isSlender` 与“放得下”决定。
 */
export const MIN_STACKED = 3;

export function stacksSingles(
  area: Area,
  origins: number,
  roots: ReadonlyMap<string, readonly SessionSummary[]>,
  children: ReadonlyMap<string, unknown>,
): boolean {
  if (origins !== 1 || area.w < area.h) return false;
  for (const group of roots.values()) {
    let singles = 0;
    for (const root of group) if (!children.has(root.id)) singles += 1;
    if (singles >= MIN_STACKED) return true;
  }
  return false;
}
