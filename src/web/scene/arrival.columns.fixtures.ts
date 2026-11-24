/**
 * `arrival-columns*.test.ts` 与相关测试共用的测试数据（LAYOUT3 · W6 / W6b），仅供测试使用：只有构造器和取值函数，不含断言，也不依赖 vitest。
 * “逐个到达”都经过引擎持有的那条路（`HeldLayout.apply`，`known` 的记法与引擎一致：出现过的节点都记下），并带着取景区域——
 * 与 Overview 交给引擎的一样：规划用的那份区域（同样的数值）。
 */

import type { SessionSummary } from "@shared/types";
import { HeldLayout } from "./arrival-memory";
import { layoutScene, type Area, type LayoutNode, type LayoutOptions, type SceneLayout } from "./layout";

/**
 * 五种取景区域：三个桌面窗口、一个竖屏、一个窄区域（紧凑模式，卡片用紧凑尺寸）。
 * 数值是 Overview 把视口扣掉留白、再量化到 16px 之后的取景区域（1440×900 的视口 → 1088×710，依此类推）。
 */
export const WINDOWS: readonly { name: string; area: Area }[] = [
  { name: "1440×900", area: { w: 1088, h: 710 } },
  { name: "1920×1080", area: { w: 1568, h: 890 } },
  { name: "1280×720", area: { w: 928, h: 530 } },
  { name: "竖屏 720×1000", area: { w: 720, h: 1000 } },
  { name: "窄区域 288×544", area: { w: 288, h: 544 } },
];

/** 空间视图（单个来源）的规划选项：带取景区域、规划式排布。 */
export const optionsOf = (area: Area): LayoutOptions => ({ area, grid: true, hideContextNodes: true });

/**
 * 交给持有逻辑的取景区域：不指定就是规划用的那份（Overview 的做法）；换成别的（比如很矮的）用来单独看“满”的判据，
 * "none" 是改动前的调用——不给取景区域，一直往下接。
 */
export type View = Area | "none";

/**
 * 页面逐个收到会话：每次给全部会话，规划出新的排布，交给持有逻辑。
 * `show` 可以临时换一份规划选项（窗口变了）；取景区域跟着这份选项走，除非 `view` 固定了它。
 * `known` 与引擎一致：展示过的节点都记着。
 */
export function holder(options: LayoutOptions, view?: View): { held: HeldLayout; known: ReadonlySet<string>; show: (sessions: readonly SessionSummary[], at?: LayoutOptions) => SceneLayout } {
  const held = new HeldLayout();
  const known = new Set<string>();
  return {
    held,
    known,
    show: (sessions, at = options) => {
      const shown = view ?? at.area ?? "none";
      const layout = held.apply(layoutScene(sessions, at), (id) => known.has(id), shown === "none" ? undefined : shown);
      for (const node of layout.nodes) known.add(node.id);
      return layout;
    },
  };
}

export const agentsOf = (layout: SceneLayout): LayoutNode[] => layout.nodes.filter((n) => n.kind === "agent");

/** 会话卡按左缘分列（从左到右），每一列自上而下。 */
export function columnsIn(layout: SceneLayout): { x: number; cards: LayoutNode[] }[] {
  const byX = new Map<number, LayoutNode[]>();
  for (const card of agentsOf(layout)) byX.set(card.x, [...(byX.get(card.x) ?? []), card]);
  return [...byX]
    .sort((a, b) => a[0] - b[0])
    .map(([x, cards]) => ({ x, cards: cards.sort((a, b) => a.y - b.y) }));
}

/** 每一列的张数，从左到右（`columnsIn` 的缩写，断言里一眼看得出形状）。 */
export const shapeOf = (layout: SceneLayout): number[] => columnsIn(layout).map((column) => column.cards.length);

/** 逐个到达 `all`（第 k 步时页面有前 k 个会话）：返回每一步的布局。`from` > 1 时前 `from` 个会话一次到齐（刷新后载入），之后才逐个到达，只返回载入之后的每一步。 */
export function arrive(all: readonly SessionSummary[], options: LayoutOptions, view?: View, from = 1): SceneLayout[] {
  const { show } = holder(options, view);
  const steps: SceneLayout[] = [];
  for (let k = from; k <= all.length; k++) steps.push(show(all.slice(0, k)));
  return steps;
}

/** 逐个到达时，第一次出现第二列是第几个会话到达的（从 1 数）；一直只有一列就是 undefined。 */
export function firstSecondColumn(steps: readonly SceneLayout[]): number | undefined {
  const index = steps.findIndex((layout) => columnsIn(layout).length > 1);
  return index < 0 ? undefined : index + 1;
}
