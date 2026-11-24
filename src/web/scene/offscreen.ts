import type { Padding } from "./layout";
import type { Rect } from "./placement";

/**
 * 节点在视口之内还是之外、在哪条边之外，以及把它带回视口要平移多少。纯函数，不碰 DOM 与引擎：
 * 调用方交进来世界坐标的矩形、相机与视口尺寸（屏幕像素）。
 */

export type Edge = "top" | "right" | "bottom" | "left";
export interface Size { w: number; h: number }

/** 在屏幕上至少露出这么多（CSS 像素）才算看得见：不到 1px 的一条边谁也看不见，也免得浮点误差让结论在边界上来回翻。 */
export const VISIBLE_PX = 1;

export type Standing =
  | { state: "visible" }
  /** `edge`：它在视口的哪一边之外；`distance`：它离视口最近的一点有多远（屏幕像素）。 */
  | { state: "outside"; edge: Edge; distance: number }
  /** 视口量不出来（尺寸为 0、数值不是有限的）：给不出结论，调用方不能当成“看不见”。 */
  | { state: "unknown" };

/** 相机：世界坐标平移 (x, y)、缩放 k 之后得到屏幕坐标（与引擎的 Camera 同形）。 */
interface View { x: number; y: number; k: number }

export function toScreen(rect: Rect, camera: View): Rect {
  return { x: rect.x * camera.k + camera.x, y: rect.y * camera.k + camera.y, w: rect.w * camera.k, h: rect.h * camera.k };
}

const finite = (...values: number[]): boolean => values.every(Number.isFinite);

/**
 * 只要露出 VISIBLE_PX 就是看得见的（一小部分也算）：露出来的那一块本身就是线索，再给提示是重复；
 * “完全在视口之外”才有这条边界，规则一句话说得清。
 *
 * 在哪条边：每条轴上取离视口更远的那一侧（正数 = 还差这么远进视口，负数 = 已经有这么多在视口里）。
 * 只有一条轴在外，就是那条轴的那一侧；两条轴都在外（斜角）归到离得更远的那条轴，一样远时归左右。
 */
export function standing(rect: Rect, camera: View, size: Size): Standing {
  const s = toScreen(rect, camera);
  if (!finite(s.x, s.y, s.w, s.h, size.w, size.h) || size.w <= 0 || size.h <= 0) return { state: "unknown" };
  const right = s.x - size.w;
  const left = -(s.x + s.w);
  const below = s.y - size.h;
  const above = -(s.y + s.h);
  const gx = Math.max(right, left);
  const gy = Math.max(below, above);
  const outX = gx > -VISIBLE_PX;
  const outY = gy > -VISIBLE_PX;
  if (!outX && !outY) return { state: "visible" };
  const horizontal = outX && (!outY || gx >= gy);
  const edge: Edge = horizontal ? (right >= left ? "right" : "left") : below >= above ? "bottom" : "top";
  return { state: "outside", edge, distance: Math.hypot(Math.max(gx, 0), Math.max(gy, 0)) };
}

/** 一条轴上：让 [start, start + len] 落进 [lead, total − trail] 所需的最小位移；放不下就对齐起点，留白把视口吃光了就居中。 */
function slide(start: number, len: number, total: number, lead: number, trail: number): number {
  const room = total - lead - trail;
  if (room <= 0) return (total - len) / 2 - start;
  if (len > room || start < lead) return lead - start;
  if (start + len > total - trail) return total - trail - (start + len);
  return 0;
}

/**
 * 把节点带进视口要平移相机多少（屏幕像素，不涉及缩放）：最小位移，让整张卡落在留白之内。
 * 最小位移而不是居中：用户的相机是自己摆的，只把它挪到“刚好看得见”，其余的画面尽量原样留着。
 */
export function revealPan(rect: Rect, camera: View, size: Size, pad: Padding): { dx: number; dy: number } {
  const s = toScreen(rect, camera);
  if (!finite(s.x, s.y, s.w, s.h, size.w, size.h) || size.w <= 0 || size.h <= 0) return { dx: 0, dy: 0 };
  return { dx: slide(s.x, s.w, size.w, pad.left, pad.right), dy: slide(s.y, s.h, size.h, pad.top, pad.bottom) };
}
