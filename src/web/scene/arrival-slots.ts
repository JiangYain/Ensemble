import type { Rect } from "./placement";

/**
 * 新卡在“已有卡片原地不动”的画布上找落点：只有纯几何，不认识会话、来源或引擎（LAYOUT2 · W4）。
 * 所有函数都不修改传入的东西；障碍是一组矩形（别的卡，以及被一家人占着的整块区域）。
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

/** 候选位置之间的步长：格点排布里就是一格的宽与高。 */
export interface Steps {
  x: number;
  y: number;
}

/** 浮点比较的容差：相邻两格恰好隔一个空白，边缘相碰不算挤在一起。 */
const EPS = 0.01;

/**
 * 找最近的空位时往外找多远（以步长计）。
 * 一屏装得下的规则网格里，会话周围 6 格之内通常有空位；找不到就说明这个区域是满的，由调用方退到“放在所有卡的下面”：
 * 再往外找，找到的位置离它该去的地方太远，已经不是“最近”了。
 */
export const REACH = 6;

/** `a` 是否挤进了 `b` 四周 `gap` 以内的范围（含直接相交）。 */
export const crowds = (a: Rect, b: Rect, gap: number): boolean =>
  a.x < b.x + b.w + gap - EPS && b.x - gap + EPS < a.x + a.w && a.y < b.y + b.h + gap - EPS && b.y - gap + EPS < a.y + a.h;

/** 两张卡之间至少要留的空白：取一格里横向与纵向空白中较小的那个，格点排布里相邻两格恰好满足。 */
export const gapOf = (size: Size, steps: Steps): number => Math.max(0, Math.min(steps.x - size.w, steps.y - size.h));

/** 在 `at` 放一张 `size` 的卡，是否与 `obstacles` 里的每一个都隔开了 `gap`。 */
export function isFree(at: Point, size: Size, obstacles: readonly Rect[], gap: number): boolean {
  const rect = { x: at.x, y: at.y, w: size.w, h: size.h };
  for (const other of obstacles) if (crowds(rect, other, gap)) return false;
  return true;
}

interface Offset {
  i: number;
  j: number;
}

/** 候选偏移（以步长计）按离原点由近到远排好：同样远时先下后上、先右后左，同一份步长只排一次。 */
const sorted = new Map<string, readonly Offset[]>();

function offsets(steps: Steps, reach: number): readonly Offset[] {
  const key = `${steps.x}x${steps.y}/${reach}`;
  const known = sorted.get(key);
  if (known) return known;
  const all: Offset[] = [];
  for (let j = -reach; j <= reach; j++) for (let i = -reach; i <= reach; i++) all.push({ i, j });
  const distance = ({ i, j }: Offset): number => (i * steps.x) ** 2 + (j * steps.y) ** 2;
  all.sort((a, b) => distance(a) - distance(b) || Number(a.j < 0) - Number(b.j < 0) || Number(a.i < 0) - Number(b.i < 0) || a.j - b.j || a.i - b.i);
  sorted.set(key, all);
  return all;
}

/**
 * 离 `ideal` 最近的空位：候选是 `ideal` 加上整数个步长，在 `reach` 步以内找最近的一个。
 * `minX` 是候选的横向下限（汇聚的会话必须落在所有上级的右边），`minY` 是纵向下限（会话卡不落在所属来源块第一排之上，
 * 否则整块空着的上沿会被它占去，悬在来源卡上方）；一个都没有就返回 undefined。
 * 候选都落在以 `ideal` 为原点的格子上，所以 `ideal` 在格点上时落点也在格点上，不会与规则网格错开半格。
 */
export function nearestFree(ideal: Point, size: Size, obstacles: readonly Rect[], steps: Steps, minX = -Infinity, reach = REACH, minY = -Infinity): Point | undefined {
  const gap = gapOf(size, steps);
  for (const { i, j } of offsets(steps, reach)) {
    const at = { x: ideal.x + i * steps.x, y: ideal.y + j * steps.y };
    if (at.x < minX - EPS || at.y < minY - EPS) continue;
    if (isFree(at, size, obstacles, gap)) return at;
  }
  return undefined;
}

/** 一组矩形的外框；空组返回 undefined。 */
export function unionOf(rects: Iterable<Rect>): Rect | undefined {
  let box: { x0: number; y0: number; x1: number; y1: number } | undefined;
  for (const r of rects) {
    box = box
      ? { x0: Math.min(box.x0, r.x), y0: Math.min(box.y0, r.y), x1: Math.max(box.x1, r.x + r.w), y1: Math.max(box.y1, r.y + r.h) }
      : { x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h };
  }
  return box ? { x: box.x0, y: box.y0, w: box.x1 - box.x0, h: box.y1 - box.y0 } : undefined;
}
