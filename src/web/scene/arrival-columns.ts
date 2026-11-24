import { gapOf, isFree, unionOf, type Point, type Size, type Steps } from "./arrival-slots";
import type { Area } from "./layout-geometry";
import type { Rect } from "./placement";

/**
 * 竖排的一列“满了就另起一列”（LAYOUT3 · W6 / W6b；LAYOUT4 · W7 改了新列的落点）。纯函数：只有几何，不认识会话、来源或引擎。
 *
 * LAYOUT6 起根会话不再走这条判据：根会话的落点由 arrival-grow.ts 决定（先填外框里的空格，没有空格再比较新开一行与新开一列哪个让整体看得更全）；
 * 这里只剩家族里竖排的子会话（arrival-hold.ts 的 `columnOf` → `newColumn`）。下面“为什么要有它”里凡说到“来源卡右边那一列根会话 / 一列的格点排布”的，
 * 是 LAYOUT3~4 的背景，现在由 arrival-grow.ts 承担（当时用来找“根会话的下一格”的 `nextSlot` / `nextCell` 已随之删除）。
 *
 * 为什么要有它：已有的卡一像素不动、新卡放进下一个空位（arrival-hold.ts）之后，持有的排布里凡是“一张接一张往下排”的一列——
 * 经典的树里来源卡右边的那一列根会话、一列的格点排布、家族里竖排的子会话——会随着会话一个个到达无限往下长，
 * 同一份数据刷新之后却是多列的整齐网格。几十个会话逐个到达（主 Agent 连着派发一批并行子会话）就是一条竖到底，大半的卡落在视口之外。
 *
 * “满”的判据：新卡接在这一列下面，还是落在右边新开的一列，哪一种让**整个排布在取景区域里看得全的比例**更高，就取哪一种
 * （比例 = 宽比、高比取小、封顶 100%；用的是全部卡的外框，不只这一列）。新开一列只在严格更高时才开，持平就接在下面。
 * 为什么是它，而不是“一列不超过取景区域在 100% 缩放下的高度”这类固定高度：
 * - 开一列的代价随取景区域变：宽屏上多一列几乎不花什么（1920×1080 的取景区域里 2 列仍是 100%），列早早就开；
 *   窄屏、竖屏、紧凑模式里多一列要把整体缩得很小（288 宽的取景区域里 2 列只剩约 40%），而多接几行只是缩小一点，列就该开得晚。
 *   固定高度对两头都不对：窄的地方过早换列、缩放掉得比旧行为还低（紧凑模式 8 个根 48% → 25%）；
 * - 它没有写死的比例或行数，不拿“放得下 100%”当目标：自动取景本来就会把整体缩到看全为止，目标是看全的比例最高；
 * - 一个后果：随着排布变宽，缩放降低，视口里放得下的高度变多，后开的列会比前面的列更高（一级一级往上的台阶），
 *   而不是每列一样高——已有的卡不能挪，这是让几十个会话仍在视口里的办法（固定高度的话 60 个根是 12 列 × 5 行，约一半在视口之外）。
 * - 下限：一列至少有 `MIN_ROWS` 张才允许另起，取景区域极矮时不至于每列只有一两张。
 *
 * 新列：列顶与第一列的顶对齐，横向紧挨在这些兄弟与它们全部后代的右边，只隔一道列间空白（格点里相邻两列的节距）。
 * 不给每一列预留一整列“子会话巷”：编排者对真实数据的统计是 184 个根里只有 41 个带过子会话，104 个根的直接子会话里有 57 个到达时，
 * 它的上级之后已经出现了新根——预留的巷对多数根是浪费，对多数子会话又来不及，代价是每一列根会话之间白白隔出一列
 * （单来源逐个到达 40 个根：1440×900 里实时取景只有 42%，同一批刷新后是 66%）。
 * 紧挨着的那一格被占了（多个来源并排、别家的整块区域、家族里已长出的后代）就开到所有卡的右边，顶仍与第一列对齐，
 * 仍由同一条判据决定开不开（不开就按原来的规则往下接）；那一格也被占了就不另起。
 * 之后到达的卡接着往新列下面填，满了再开下一列。
 * 已有的卡一张都不挪；取景区域只决定下一张新卡去哪，窗口变了也不会让已有的卡动。
 */
export const MIN_ROWS = 3;

/** 比例比较的容差：差在这以内算持平。 */
const EPS = 1e-9;

/** 新卡要接在哪一竖排下面：这一排的现状。 */
export interface Stack {
  /** 新卡本来要接在它下面的那一张（上一个兄弟）。 */
  readonly ref: Rect;
  /** 同一个上级名下已经摆好的会话卡（含 `ref`），可能分在好几列里。 */
  readonly siblings: readonly Rect[];
  /** 这些卡连同它们全部后代的卡：新的一列要在它们全部的右边。 */
  readonly scope: readonly Rect[];
}

/** 外框 `box` 在取景区域 `area` 里看得全的最大比例：宽比、高比取小，封顶 100%。 */
const shownAt = (box: Rect, area: Area): number => Math.min(1, area.w / box.w, area.h / box.h);

/**
 * 这一竖排满了，下一张卡另起一列时的落点；不到下限、新列的位置被占了、接在下面看得更全或一样全都是 undefined（调用方按原来的规则接在下面）。
 * `below` 是不另起新列时它会落的位置（接在 `ref` 下面、躲开挡路的卡之后）；`bounds` 是现有全部卡的外框；
 * `steps.x` 是相邻两列的列距（左缘到左缘，新列与前一列之间就隔 `steps.x - size.w` 的空白），`steps.y` 是行距。
 */
export function newColumn(
  stack: Stack,
  below: Point,
  size: Size,
  steps: Steps,
  area: Area,
  obstacles: readonly Rect[],
  bounds: Rect,
): Point | undefined {
  const here = stack.siblings.filter((rect) => Math.abs(rect.x - stack.ref.x) < size.w / 2);
  if (here.length < MIN_ROWS) return undefined;
  // 第一列的顶：最靠左的那一列里最高的一张；之后每一列都与它对齐，所以也是所有兄弟里最高的。
  const left = Math.min(...stack.siblings.map((rect) => rect.x));
  const top = Math.min(...stack.siblings.filter((rect) => Math.abs(rect.x - left) < size.w / 2).map((rect) => rect.y));
  const box = unionOf(stack.scope);
  if (!box) return undefined;
  const space = steps.x - size.w;
  const gap = gapOf(size, steps);
  // 先试紧挨着的那一格；被占了就开到所有卡的右边（线会长一些，但不会再有一条竖到底）。
  const beside = { x: box.x + box.w + space, y: top };
  const at = isFree(beside, size, obstacles, gap) ? beside : { x: bounds.x + bounds.w + space, y: top };
  if (!isFree(at, size, obstacles, gap)) return undefined;
  const spread = (point: Point): number => shownAt(unionOf([bounds, { x: point.x, y: point.y, w: size.w, h: size.h }]) ?? bounds, area);
  return spread(at) > spread(below) + EPS ? at : undefined;
}
