/**
 * `arrival-*.test.ts` 共用的测试数据与几何读取（LAYOUT2 · W4），仅供测试使用：只有构造器和取值函数，不含断言，也不依赖 vitest。
 * 前提都用真实的 `layoutScene` 规划来造——“上一次排布”是它给的，“这一次的规划”也是它给的，持有的结果与规划的差别才是被测的东西。
 */

import type { SessionSummary } from "@shared/types";
import type { Point } from "./arrival-slots";
import type { LayoutOptions, SceneLayout } from "./layout";
import { node, session } from "./layout.fixtures";
import type { Rect } from "./placement";

export const DESK: LayoutOptions = { area: { w: 1088, h: 610 }, grid: true, hideContextNodes: true };
export const NARROW: LayoutOptions = { area: { w: 720, h: 1000 }, grid: true, hideContextNodes: true };
/** 宿主浏览器侧栏那样窄的区域：卡片用紧凑尺寸。 */
export const COMPACT: LayoutOptions = { area: { w: 288, h: 544 }, grid: true, hideContextNodes: true };

/** `n` 个根会话（创建先后从 `from` 起，id 是 `前缀` 加序号）。 */
export const roots = (key: string, n: number, from = 1, prefix = "r"): SessionSummary[] => Array.from({ length: n }, (_, i) => session(`${prefix}${i + 1}`, key, from + i));
/** `parent` 名下的 `n` 个子会话 k1…kn。 */
export const kidsOf = (key: string, parent: string, n: number, from: number): SessionSummary[] =>
  Array.from({ length: n }, (_, i) => session(`k${i + 1}`, key, from + i, { parentSessionId: parent }));
/** 有多个上级的会话：第一个上级是主上级。 */
export const join = (id: string, key: string, order: number, parents: string[]): SessionSummary => session(id, key, order, { parentSessionId: parents[0], parentSessionIds: parents });

export const agent = (id: string): string => `agent:${id}`;
export const spot = (layout: SceneLayout, id: string): Point => {
  const found = node(layout, id);
  return { x: found.x, y: found.y };
};
export const bottomOf = (layout: SceneLayout): number => Math.max(...layout.nodes.map((n) => n.y + n.h));
export const rectsOf = (layout: SceneLayout, except?: string): Rect[] => layout.nodes.filter((n) => n.id !== except).map(({ x, y, w, h }) => ({ x, y, w, h }));
export const columnsOf = (layout: SceneLayout): number => new Set(layout.nodes.filter((n) => n.kind === "agent").map((n) => n.x)).size;

/** 上一份布局里位置变了（或没了）的节点：持有时它必须是空的。 */
export const moved = (before: SceneLayout, after: SceneLayout): string[] =>
  before.nodes
    .filter((n) => {
      const next = after.nodes.find((m) => m.id === n.id);
      return !next || next.x !== n.x || next.y !== n.y;
    })
    .map((n) => n.id);
