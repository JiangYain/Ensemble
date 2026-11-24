import { growSlot, type GrowInput } from "./arrival-grow";
import { unionOf, type Point, type Size, type Steps } from "./arrival-slots";
import type { Area } from "./layout-geometry";
import type { Rect } from "./placement";

/**
 * `growSlot` 的纯几何用例共用的夹具（arrival-grow*.test.ts）：只有矩形与取景区域，不认识会话、来源或引擎。
 * 一格 248 × 112，步长 280 × 136，卡与卡之间最少隔 24（`gapOf`）；`at(列, 行)` 是第 `列` 列第 `行` 行那一格上的卡。
 */

export const SIZE: Size = { w: 248, h: 112 };
export const STEPS: Steps = { x: 280, y: 136 };
export const at = (col: number, row: number, steps: Steps = STEPS, size: Size = SIZE): Rect => ({ x: col * steps.x, y: row * steps.y, ...size });
/** 一块格点：`shape[i]` 是第 `i` 列的张数（都从第一排起，自上而下排满）。 */
export const gridOf = (shape: readonly number[]): Rect[] => shape.flatMap((rows, col) => Array.from({ length: rows }, (_, row) => at(col, row)));
export const WIDE_SHORT: Area = { w: 1000, h: 300 };
export const TALL_NARROW: Area = { w: 560, h: 1000 };
export const HUGE: Area = { w: 5000, h: 5000 };

export interface Scene {
  roots: readonly Rect[];
  /** 这个来源块里的子会话卡（块的范围要算上它们，它们自己也是障碍）。 */
  kids?: readonly Rect[];
  /** 不属于这个来源块的卡（来源卡、别的来源块的卡）：只进外框与障碍。 */
  others?: readonly Rect[];
  /** 只是障碍、不算卡的矩形（待用格、别家的整块区域）。 */
  reserved?: readonly Rect[];
  area?: Area;
  align?: number;
  steps?: Steps;
  size?: Size;
}

export function slot({ roots, kids = [], others = [], reserved = [], area, align, steps = STEPS, size = SIZE }: Scene): Point | undefined {
  const block = [...roots, ...kids];
  const cards = [...block, ...others];
  const input: GrowInput = { size, steps, roots, block, frame: unionOf(cards) as Rect, obstacles: [...cards, ...reserved], floor: Math.min(...block.map((rect) => rect.y)), area, align };
  return growSlot(input);
}

/** 一直取下一个落点并把它放进去，返回前 `n` 个落点。 */
export function fill(roots: Rect[], n: number, extra: Omit<Scene, "roots"> = {}): (Point | undefined)[] {
  const picked: (Point | undefined)[] = [];
  for (let i = 0; i < n; i++) {
    const next = slot({ roots, ...extra });
    picked.push(next);
    if (next) roots.push({ ...next, ...SIZE });
  }
  return picked;
}
