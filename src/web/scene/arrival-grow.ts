import { gapOf, isFree, unionOf, type Point, type Size, type Steps } from "./arrival-slots";
import type { Area } from "./layout-geometry";
import type { Rect } from "./placement";

/**
 * 新根会话怎么长：先填空格，没有空格再向“让整体看得最全”的方向长一行或一列（LAYOUT6）。纯函数：只有几何，
 * 不认识会话、来源、引擎与 `Board`；障碍、第一排的顶、取景区域都由调用方（arrival-hold.ts）给。
 *
 * 为什么换掉“一列满了另起一列”（arrival-columns.ts 的判据 G，现在只留给家族里的子会话）：它把根会话当成一条竖排，
 * 只盯着“接在下面还是另起一列”，所以——从空白一个个到达时，大窗口里一条竖排长到 5 行才开第二列，第二列只在底下那几行往下填，
 * 整体比同一批刷新后的多列网格缩得小得多；刷新载入之后再追加更糟：载入时的列数就是它的列数，之后一律“填满一行再换行”，
 * 一个 7 张的块追加 30 张就是 3 列 × 13 行，缩到 38%，同一批刷新后是 66%。两种顺序的根源是同一个：
 * 它不看已有的空格，也不在“再长一行”与“再长一列”之间比较。
 *
 * 规则（格子 = 已有根会话卡所在的列、第一排起每隔一个步长的行；列的左缘取自已有的根会话卡）：
 *  1. 候选的格子都是“放得下”的：不压障碍、不在来源块第一排之上；
 *  2. 先填空格：来源块自己范围以内（最右一列、最下一行以内，整张卡落在范围里才算）放得下的第一个，按阅读顺序（先上后下、每行从左到右）；
 *     这些格子本来就在外框里，填它不让整体变大；别的来源块里的空格不算——那是别人的地方；
 *     经典的树里奇数行错开一小段，块的右缘比一列宽出那一小段，不会因此多出一列“空格”；
 *  3. 没有空格才长：新开一行（块下面一行的最左一格）或新开一列（块右边一列的顶格，与第一排对齐，紧挨着整块的右缘、
 *     只隔一道列间空白），哪一个让全部卡的外框在取景区域里看得全的比例（宽比、高比取小，封顶 100%）更高就取哪一个；
 *  4. 持平（差不到 0.05 个百分点，比如窗口大到两种长法都能 100%）看形状（LAYOUT8 · W1）：长出来之后这个来源块——它名下全部的会话卡加上新卡，不含来源卡与别的来源块——
 *     宽高比与取景区域的宽高比取对数比，哪一种离得近就取哪一种，让块长成取景区域的形状；两种差不到 `ASPECT_TIE`（约 5%，肉眼看是同一个形状）仍长一行：
 *     行比列更接近阅读顺序，也不抢右边别人要用的地方。以前一律长一行，宽屏里 3~6 个根竖成一条、7 个根 [5,2] 之类，右边大片空着，窗口越宽越明显。
 *     为什么只看块而不是全部卡的外框：外框里含来源卡（经典的树里它在左边，多占一整列宽）与别的来源块，按它比，1440×900 里 3 个根仍竖成一条；
 *     块是这一步真正在长的东西。它只在持平时说话，“看得全”的比例（规则 3）有高下时照旧由它决定，所以不会为了好看把缩放降下来；
 *  5. 一边放不下（第一格被别的来源块、别家的整块区域占着）就长另一边，两边都放不下返回 undefined，由调用方照原来的办法找位置；
 *  6. 没有取景区域：不比较，只填空格；没有空格就新开一行，放不下才新开一列；
 *  7. 来源块里还没有根会话卡（格子无从谈起）返回 undefined。
 * 经典的树（“全部空间”视图）里奇偶行错开一小段：规划给这张新卡的横坐标（`align`）与落点在同一列、而且放得下，就沿用它，保持那个节奏。
 * 已有的卡一张不挪；取景区域只决定下一张新卡去哪，窗口变了也不会让已有的卡动。
 */

/** 浮点比较的容差（与 arrival-slots.ts 一致）。 */
const EPS = 0.01;

/** 取整个数步长时的容差：坐标恰好落在格线上，不被浮点误差多算一格。 */
const SLACK = 1e-6;

/** “看得全”的比例相差不到这些（0.05 个百分点）算持平。 */
const TIE = 5e-4;

/** 持平时比形状：两个块与取景区域的宽高比，差在这以内（对数比，0.05 约 5%）算一样像——肉眼看是同一个形状，长一行。 */
const ASPECT_TIE = 0.05;

export interface GrowInput {
  /** 一张卡的尺寸。 */
  size: Size;
  /** 一格的步长：格点排布是格子的节距，经典的树是一张卡加上列间、行间的空白。 */
  steps: Steps;
  /** 这个来源块里已有的根会话卡：格子的列与第一排的顶都从它们读。 */
  roots: readonly Rect[];
  /** 这个来源块里已有的全部会话卡（含子会话、汇聚会话）：块往右、往下伸到哪里。 */
  block: readonly Rect[];
  /** 此刻全部卡的外框（含来源卡与别的来源块）。 */
  frame: Rect;
  /** 落点要躲开的矩形：别的卡、别家的整块区域、待用格；间隔取 `gapOf(size, steps)`。 */
  obstacles: readonly Rect[];
  /** 来源块第一排会话卡的顶：任何落点都不在它之上。 */
  floor: number;
  /** 取景区域；不给就不比较两种长法（见规则 6）。 */
  area?: Area;
  /** 规划给这张新卡的横坐标：落点与它在同一列（左缘相差不到半张卡宽）、而且放得下，就沿用它——经典的树里奇偶行错开的那一小段。 */
  align?: number;
}

/** 外框 `box` 在取景区域 `view` 里看得全的最大比例：宽比、高比取小，封顶 100%。 */
const shownAt = (box: Rect, view: Area): number => Math.min(1, view.w / box.w, view.h / box.h);

/** `box` 的宽高比与取景区域 `view` 的宽高比差多远：取对数比的绝对值，越小越像（宽一倍与窄一倍一样远）。 */
const unlikeness = (box: Rect, view: Area): number => Math.abs(Math.log(box.w / box.h / (view.w / view.h)));

/**
 * 候选的列（左缘，从左到右）：根会话卡所在的列（左缘相差不到半张卡宽的算同一列，经典的树里奇数位错开一小段），
 * 加上来源块范围以内其余的格点列——子会话那几列里没被占的格子也是空格。
 */
function columnsOf(roots: readonly Rect[], size: Size, steps: Steps, span: Rect): number[] {
  const own: number[] = [];
  for (const x of roots.map((rect) => rect.x).sort((a, b) => a - b)) {
    const last = own[own.length - 1];
    if (last === undefined || x - last >= size.w / 2) own.push(x);
  }
  const left = own[0] as number;
  const across = Math.max(1, Math.floor((span.x + span.w - left - size.w) / steps.x + SLACK) + 1);
  const lattice = Array.from({ length: across }, (_, c) => left + c * steps.x).filter((x) => own.every((at) => Math.abs(at - x) >= size.w / 2));
  return [...own, ...lattice].sort((a, b) => a - b);
}

/** 新来的根会话落在哪；没有合适的落点是 undefined。 */
export function growSlot(input: GrowInput): Point | undefined {
  const { size, steps, roots, block, frame, obstacles, floor, area, align } = input;
  const base = unionOf(roots);
  const span = unionOf(block);
  if (!base || !span) return undefined;
  const xs = columnsOf(roots, size, steps, span);
  const gap = gapOf(size, steps);
  // 每一行只从全部障碍里挑一次：有可能与这一行的格子挤在一起的（高度上够得着的）才逐个比，格子再多也不对着全部障碍。
  const lanes = new Map<number, readonly Rect[]>();
  const laneOf = (y: number): readonly Rect[] => {
    const known = lanes.get(y);
    if (known) return known;
    const lane = obstacles.filter((other) => other.y < y + size.h + gap && other.y + other.h + gap > y);
    lanes.set(y, lane);
    return lane;
  };
  const open = (at: Point): boolean => isFree(at, size, laneOf(at.y), gap);
  const snap = (at: Point): Point => (align !== undefined && Math.abs(align - at.x) < size.w / 2 && open({ x: align, y: at.y }) ? { x: align, y: at.y } : at);
  const rows = Math.max(1, Math.floor((span.y + span.h - base.y - size.h) / steps.y + SLACK) + 1);
  // 外框顶以下的第一行：它可以在第一排之上（来源卡所在的那一行），那一行由 `floor` 挡掉。
  const first = Math.min(0, Math.ceil((frame.y - base.y) / steps.y - SLACK));

  for (let r = first; r < rows; r++) {
    const y = base.y + r * steps.y;
    if (y < floor - EPS) continue;
    for (const x of xs) if (open({ x, y })) return snap({ x, y });
  }

  // 新的一行从最左放得下的一格起（最左一格若是别家子列的待用格，就从它右边起）；新的一列只认列顶那一格——
  // 列顶被占的多半是并排的另一个来源块，整列都放不下。
  const below = xs.map((x) => ({ x, y: base.y + rows * steps.y })).find(open);
  const beside = { x: Math.max((xs[xs.length - 1] as number) + steps.x, span.x + span.w + steps.x - size.w), y: base.y };
  const wider = open(beside) ? beside : undefined;
  if (!below || !wider || !area) {
    const only = below ?? wider;
    return only && snap(only);
  }
  const card = (at: Point): Rect => ({ x: at.x, y: at.y, w: size.w, h: size.h });
  const shown = (at: Point): number => shownAt(unionOf([frame, card(at)]) ?? frame, area);
  const onRight = shown(wider);
  const onBottom = shown(below);
  if (onRight > onBottom + TIE) return snap(wider);
  if (onBottom > onRight + TIE) return snap(below);
  // 持平：看长出来之后这个来源块的形状（块自己的会话卡加新卡，不含来源卡与别的来源块）哪个更像取景区域。
  const unlike = (at: Point): number => unlikeness(unionOf([...block, card(at)]) ?? card(at), area);
  return snap(unlike(wider) < unlike(below) - ASPECT_TIE ? wider : below);
}
