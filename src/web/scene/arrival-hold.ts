import { Board } from "./arrival-board";
import { newColumn, type Stack } from "./arrival-columns";
import { growSlot } from "./arrival-grow";
import { gapOf, isFree, nearestFree, REACH, unionOf, type Point, type Steps } from "./arrival-slots";
import type { SceneLayout } from "./layout";
import { cellsFor } from "./layout-cells";
import { boundsOf, NODE, type Area, type LayoutNode } from "./layout-geometry";
import { placeBeside, type Rect } from "./placement";

/**
 * 已有的卡片原地不动，新来的卡放进下一个空位（LAYOUT2 · W4）。纯函数：不碰 DOM 与引擎，也不改 `layoutScene`——
 * 规划照旧每次整份重算（连线、锚点、取景标记都出自它），这里只决定“这一次的坐标用谁的”。
 *
 * 整体重排（`mode` 为 "full"，坐标就是规划自己给的）只在两类时候发生：
 *  a. 没有记忆：页面刚打开、换了空间、点了“重置节点布局”之后的第一次；
 *  b. 记忆不再成立（见 `mustRelayout`）：有卡消失了（归档、删除、“隐藏未在工作的会话”、隐藏相关节点）、重新出现了早就见过的卡
 *     （收起后再显示）、某个会话的上级变了（改挂、汇聚关系变化），或者卡的尺寸变了（窄侧栏与宽屏之间切换）。
 *     以上是 `holdLayout` 自己的判断。它返回 "full" 时，调用方 `HeldLayout.apply`（arrival-memory.ts）还会先试 `Snapshots.restore`（hold-restore.ts）：
 *     某份存档里的卡现在都还在、尺寸与上级没变时就用存档的位置——节点集合与存档一样是原样复原，多出来的新会话当新卡落进空位；
 *     一份都复原不了才真的整体重排、用规划自己的坐标。
 * 除此之外已有的每张卡一像素都不动——窗口尺寸变了、缩放上限变了也一样；相机怎么取景是引擎的事，不在这里。
 * 新来的根会话先填来源块里的空格，没有空格再向“让整体看得最全”的方向长一行或一列（LAYOUT6，规则见 arrival-grow.ts）；
 * 家族里竖排的子会话长到再接一张不如另起一列看得全时，下一张新卡落在右边新开的一列（LAYOUT3，判据见 arrival-columns.ts）。
 * 两者都要用到取景区域，但它只决定下一张新卡去哪，已有的卡照样不动。
 *
 * 用户拖过的卡也不在这里管：引擎对“参照被拖走了、或槽位被拖来的卡占着”的新卡本来就有一套（placement.ts 的 planArrivals，
 * 躲开并记下来），这里的结果是它的输入，两者不重复。
 */

/** 上一次排布：每个节点的位置与尺寸，以及每个会话节点的上级（委派连线的起点，树里的那个在最前）。 */
export interface AutoMemory {
  readonly rects: ReadonlyMap<string, Rect>;
  readonly parents: ReadonlyMap<string, string>;
  /** 这次排布是格点排布（会话成多列规则网格）还是经典的树：决定一格有多大（格点的节距，还是一张卡加空白）与取景口径。 */
  readonly grid: boolean;
  /**
   * 旧版本记下的“按一列满了另起一列往下长的来源块”（来源卡的 id）。LAYOUT6 起根会话按空格与整体比例长（arrival-grow.ts），不再读也不再写，
   * 只是原样带着，让旧的记忆（比如存下来的快照）还能被认出来。
   */
  readonly columns?: ReadonlySet<string>;
}

export interface Held {
  layout: SceneLayout;
  memory: AutoMemory;
  mode: "full" | "hold";
  /** `hold` 时这次新排的节点（按排布顺序）。 */
  added: readonly string[];
}

const rectOf = (node: LayoutNode): Rect => ({ x: node.x, y: node.y, w: node.w, h: node.h });

/** 上级的写法：委派连线的起点按连线顺序用逗号连起来（静态的归属连线不算——Folder、Git 卡的出现不改变任何会话的上级）。 */
function parentsOf(plan: SceneLayout): Map<string, string> {
  const found = new Map<string, string[]>();
  for (const edge of plan.edges) {
    if (edge.phase === "link") continue;
    const list = found.get(edge.to);
    if (list) list.push(edge.from);
    else found.set(edge.to, [edge.from]);
  }
  return new Map([...found].map(([id, from]) => [id, from.join(",")]));
}

/** 把一份规划原样记下来。 */
export function memoryOf(plan: SceneLayout): AutoMemory {
  return { rects: new Map(plan.nodes.map((node) => [node.id, rectOf(node)])), parents: parentsOf(plan), grid: plan.grid === true };
}

/**
 * 记忆还能不能当这一次的前提：记忆里的节点在规划里都还在、尺寸没变、上级没变，
 * 而且多出来的节点都是真正的新卡（没见过的）。不满足就整体重排。
 */
function mustRelayout(plan: SceneLayout, now: AutoMemory, memory: AutoMemory, isKnown: (id: string) => boolean): boolean {
  for (const [id, rect] of memory.rects) {
    const next = now.rects.get(id);
    if (!next || next.w !== rect.w || next.h !== rect.h) return true;
    if (memory.parents.get(id) !== now.parents.get(id)) return true;
  }
  for (const node of plan.nodes) if (!memory.rects.has(node.id) && isKnown(node.id)) return true;
  return false;
}

/**
 * 规划里已有的会话卡与来源卡相对记忆整体平移了多少；有一张和别的不一样（规划把已有的卡重排了）就是 undefined。
 * 没有重排时规划自己给新卡的位置就是“下一个空位”（它按同一个格子、同样的列数排的），不必另外找。
 * Folder 与 Git 卡不参与判断：它们总是随着连着的来源数居中，来源一多就自己挪一段，不代表会话重排了。
 */
function shiftOf(plan: SceneLayout, memory: AutoMemory): Point | undefined {
  let shift: Point | undefined;
  for (const node of plan.nodes) {
    const rect = memory.rects.get(node.id);
    if (!rect || node.kind === "git" || node.kind === "folder") continue;
    const dx = node.x - rect.x;
    const dy = node.y - rect.y;
    if (!shift) shift = { x: dx, y: dy };
    else if (Math.abs(dx - shift.x) > 0.01 || Math.abs(dy - shift.y) > 0.01) return undefined;
  }
  return shift ?? { x: 0, y: 0 };
}

/**
 * 把 `x` 向右抬到不小于 `min` 的最近一列：整数个列距，所以抬过之后仍与原来的列对齐（不会落在两列之间）。
 * 汇聚会话要在上级的右边，而经典的树里它的理想位置（上一个兄弟的下面）与上级同一列，必须让开一整列。
 */
const raiseTo = (x: number, min: number, pitch: number): number => (x >= min - 0.01 ? x : x + Math.ceil((min - x) / pitch - 1e-9) * pitch);

/** 汇聚的会话要落在同一来源块里每个上级的右边：返回这条横向下限（没有上级约束就是 -Infinity）。 */
function rightOfParents(node: LayoutNode, board: Board): number {
  const own = board.familyOf(node.id)?.origin;
  let limit = -Infinity;
  for (const id of board.parents.get(node.id)?.split(",") ?? []) {
    const rect = board.rects.get(id);
    if (!rect || board.familyOf(id)?.origin !== own) continue;
    limit = Math.max(limit, rect.x + rect.w + NODE.rowGap);
  }
  return limit;
}

/** 一格的步长：格点排布是格子的节距，经典的树是一张卡加上列间、行间的空白。 */
function stepsOf(node: LayoutNode, memory: AutoMemory): Steps {
  const cells = cellsFor(node.w === NODE.agentWCompact);
  return memory.grid ? { x: cells.pitchX, y: cells.pitchY } : { x: node.w + cells.gapX, y: node.h + NODE.rowGap };
}

/**
 * 新卡若接在一竖排的下面（家族里竖排的子会话）：返回这一排。不是竖排时是 undefined——
 * 根会话不归这里（它们先填空格、再按整体比例长一行或一列，见 `growOf`）；汇聚会话有自己的横向下限，也不归这里；第一个子会话没有上一个兄弟。
 */
function columnOf(node: LayoutNode, board: Board): Stack | undefined {
  if (node.kind !== "agent" || (board.parents.get(node.id) ?? "").includes(",")) return undefined;
  return board.familyOf(node.id)?.root === node.id ? undefined : board.stackOf(node);
}

/** 这张新卡本来落在 `below`；这一列满了而右边空着，就是右边新开的一列里的落点，否则 undefined（见 arrival-columns.ts）。新列与前一列的列距就是一格的宽。 */
function asideOf(node: LayoutNode, stack: Stack, below: Point, board: Board, memory: AutoMemory, area: Area): Point | undefined {
  const bounds = unionOf(board.cards);
  if (!bounds) return undefined;
  return newColumn(stack, below, { w: node.w, h: node.h }, stepsOf(node, memory), area, board.obstaclesFor(node), bounds);
}

/**
 * 新根会话的落点（先填空格、再按整体比例长一行或一列，规则见 arrival-grow.ts）：格子取自这一次之前就已摆好的根会话卡。
 * 来源块里还没有（新来源整块是规划排好的，它的第一个根会话也一样）、或哪一边都长不出去（第一格都被占了）时是 undefined，调用方照原来的办法找位置；
 * 不是根会话（子会话、汇聚会话、Folder 与 Git 卡）也是 undefined。
 */
function growOf(node: LayoutNode, board: Board, memory: AutoMemory, area?: Area): Point | undefined {
  const family = node.kind === "agent" ? board.familyOf(node.id) : undefined;
  if (!family || family.root !== node.id || (board.parents.get(node.id) ?? "").includes(",")) return undefined;
  const roots = board.rootsOf(family.origin, (id) => memory.rects.has(id));
  const block = board.blockOf(family.origin);
  const frame = unionOf(board.cards);
  if (!frame || roots.length === 0) return undefined;
  const floor = Math.min(...block.map((rect) => rect.y));
  const ref = node.anchor ? board.rects.get(node.anchor.id) : undefined;
  const align = ref && node.anchor ? ref.x + node.anchor.dx : undefined;
  return growSlot({ size: { w: node.w, h: node.h }, steps: stepsOf(node, memory), roots, block, frame, obstacles: board.obstaclesFor(node), floor, area, align });
}

/**
 * 规划把已有的卡重排了、没法信它给的位置时，一张新卡落在哪里。依次试：
 *  1. 根会话：先填来源块里的空格，没有空格再长一行或一列（`growOf`）；那里没有落点才照下面 2、3 找；
 *  2. 有参照的（子会话、Folder 与 Git 卡，以及 1 里没找到落点的根会话）：参照此刻的位置加规划给的偏移（子会话是它的父会话右边，或上一个兄弟的下面）；
 *     这一格被占了：格点排布里找最近的空位（汇聚会话不越过上级的右边），经典的树里沿这一列往下让；
 *  3. 都不行：放到所有卡与各家整块区域的下面，横向靠着该去的位置。永远放得下，代价是离它该去的地方远一些。
 * 其中 2 找到落点之后，若这张卡接在一竖排的下面、这一列满了而右边空着，改落在右边新开的一列（`asideOf`；要给了取景区域才知道“满”）。
 * 已有的卡一张都不会被挪。
 */
function slotFor(node: LayoutNode, board: Board, memory: AutoMemory, area?: Area): Rect {
  const at = (point: Point): Rect => ({ x: point.x, y: point.y, w: node.w, h: node.h });
  const grown = growOf(node, board, memory, area);
  if (grown) return at(grown);
  const size = { w: node.w, h: node.h };
  const steps = stepsOf(node, memory);
  const family = node.kind === "agent" ? board.familyOf(node.id) : undefined;
  const obstacles = board.obstaclesFor(node);
  // 所属来源块第一排会话卡的顶：任何会话卡（含汇聚会话、子会话）都不落在它之上。
  const block = family ? board.blockOf(family.origin) : [];
  const floor = block.length > 0 ? Math.min(...block.map((rect) => rect.y)) : -Infinity;
  const ref = node.anchor ? board.rects.get(node.anchor.id) : undefined;
  const ideal = ref && node.anchor ? { x: ref.x + node.anchor.dx, y: ref.y + node.anchor.dy } : undefined;
  const column = columnOf(node, board);
  /** 落点定了：满了就改去右边新开的一列。 */
  const settle = (spot: Point): Rect => at((column && area ? asideOf(node, column, spot, board, memory, area) : undefined) ?? spot);

  const minX = rightOfParents(node, board);
  const all = unionOf(obstacles);
  if (ideal) {
    // 规划给的理想位置若在第一排之上（比如上级在第一排、而规划把它的子会话居中摆在上级两边），也落回第一排。
    const wanted = { x: ideal.x, y: Math.max(ideal.y, floor) };
    if (memory.grid) {
      const spot = isFree(wanted, size, obstacles, gapOf(size, steps)) && wanted.x >= minX ? wanted : nearestFree(wanted, size, obstacles, steps, minX, REACH, floor);
      if (spot) return settle(spot);
      // 汇聚会话附近没有空位（格子在所有上级右边都满了）：开一列到所有卡的右边，顶与第一排对齐，列里已有卡就往下接；
      // 不会放到别处、更不会悬在第一排之上。普通的子会话照旧落到所有卡的下面（下面的收尾）。
      if (family && (board.parents.get(node.id) ?? "").includes(",")) return at(placeBeside({ x: Math.max((all ? all.x + all.w : node.x) + (steps.x - size.w), minX), y: floor }, { dx: 0, dy: 0 }, size, obstacles, gapOf(size, steps)));
    } else {
      return settle(placeBeside({ x: raiseTo(wanted.x, minX, steps.x), y: wanted.y }, { dx: 0, dy: 0 }, size, obstacles, gapOf(size, steps)));
    }
  }
  return at({ x: raiseTo(ideal?.x ?? all?.x ?? node.x, minX, steps.x), y: (all ? all.y + all.h : node.y) + NODE.rowGap });
}

/**
 * 新来源（来源卡是新的）带着它名下新来的会话与 Folder、Git 卡：它们的相对位置照规划（那是一个排好的来源块），
 * 整块放到所有已有的卡下面、左缘对齐；返回这一整块的节点 id。`open` 是还没有落点的新节点。
 */
function placeCluster(origin: LayoutNode, plan: SceneLayout, board: Board, open: ReadonlySet<string>): string[] {
  const near = new Map<string, string[]>();
  for (const edge of plan.edges) {
    if (!open.has(edge.from) || !open.has(edge.to)) continue;
    near.set(edge.from, [...(near.get(edge.from) ?? []), edge.to]);
    near.set(edge.to, [...(near.get(edge.to) ?? []), edge.from]);
  }
  const members = new Set([origin.id]);
  for (const id of members) for (const next of near.get(id) ?? []) members.add(next);
  const group = plan.nodes.filter((node) => members.has(node.id));
  const box = unionOf(group.map(rectOf));
  const all = unionOf(board.cards);
  if (!box) return [];
  const dx = (all?.x ?? box.x) - box.x;
  const dy = all ? all.y + all.h + NODE.groupGap - box.y : 0;
  for (const node of group) board.put(node.id, { x: node.x + dx, y: node.y + dy, w: node.w, h: node.h });
  return group.map((node) => node.id);
}

/**
 * 规划给新卡的位置 `planned` 要不要让位给 ③：新根会话按 `growOf` 该去别处；或它接在一竖排的下面、而这一列满了（`asideOf`）。
 * 根会话有 `growOf` 的落点时只看它：规划给的是同一行、同一列（左缘相差不到半张卡宽，比如经典的树里奇偶行错开的一小段）就不让位，沿用规划的坐标；
 * 它没有落点时，与别的卡一样看竖排。没有取景区域就没有什么可比的：一律沿用规划给的位置。
 */
function yields(node: LayoutNode, planned: Point, board: Board, memory: AutoMemory, area?: Area): boolean {
  if (area === undefined) return false;
  const grown = growOf(node, board, memory, area);
  if (grown) return Math.abs(grown.y - planned.y) > 0.01 || Math.abs(grown.x - planned.x) >= node.w / 2;
  const column = columnOf(node, board);
  return column !== undefined && asideOf(node, column, planned, board, memory, area) !== undefined;
}

/**
 * 这一次布局的坐标用谁的：没有记忆、或记忆不再成立时用规划的（整体重排）；否则已有节点用记忆里的位置，新节点依次这样落位：
 *  ① 规划没有把已有的卡重排（只是多了新卡），它给新卡的位置只要没压住别的卡就用它；
 *     例外（`yields`，要给了取景区域）：规划不知道哪里还有空格，也不知道哪一种长法让整体看得更全——新根会话按 `growOf` 长，规划给的位置若不是那一格就让位；
 *     接在一竖排下面的子会话，这一列满了（`asideOf`）也让位，规划给的位置会让这一列接着往下长。
 *     让位的这张卡与排在它后面的卡都留给 ③，逐张落位（排在后面的子会话要看到它的上级此刻真正的位置）。
 *  ② 新来源（来源卡是新的）整块放到所有卡的下面；
 *  ③ 其余的找空位（见 `slotFor`）。
 * `area` 是画布取景区域，只用来比较新根会话长一行还是一列、判断竖排的子会话列“满”没满（见 arrival-grow.ts、arrival-columns.ts）；
 * 不给就没有什么可比的：规划给的位置没压住别的卡就照用（根会话与子会话一样），规划用不了才落到 ③——那时根会话只填空格、没有空格长一行，子会话一直往下接。
 * 返回的布局只换了节点坐标与外框，连线、来源、Folder、取景标记都是规划的。
 */
export function holdLayout(plan: SceneLayout, memory: AutoMemory | undefined, isKnown: (id: string) => boolean, area?: Area): Held {
  const now = memoryOf(plan);
  if (!memory || mustRelayout(plan, now, memory, isKnown)) return { layout: plan, memory: now, mode: "full", added: [] };

  const sample = plan.nodes.find((node) => node.kind === "agent");
  const board = new Board(plan, now.parents, new Map(plan.nodes.map((node) => [node.id, node.kind])), sample ? stepsOf(sample, memory).y : 0);
  for (const node of plan.nodes) {
    const rect = memory.rects.get(node.id);
    if (rect) board.put(node.id, rect);
  }
  const fresh = plan.nodes.filter((node) => !memory.rects.has(node.id));
  const placed = new Set<string>();

  const shift = shiftOf(plan, memory);
  if (shift) {
    for (const node of fresh) {
      const planned = { x: node.x - shift.x, y: node.y - shift.y, w: node.w, h: node.h };
      // 规划给的位置也不能占别家的待用格（见 Board.holesFor）：那是别家子列的下一格。
      if (!isFree(planned, planned, [...board.cards, ...board.holesFor(node)], 0)) continue;
      if (yields(node, planned, board, memory, area)) break;
      board.put(node.id, planned);
      placed.add(node.id);
    }
  }
  for (const node of fresh) {
    if (node.kind !== "origin" || placed.has(node.id)) continue;
    const open = new Set(fresh.map((n) => n.id).filter((id) => !placed.has(id)));
    for (const id of placeCluster(node, plan, board, open)) placed.add(id);
  }
  for (const node of fresh) {
    if (placed.has(node.id)) continue;
    board.put(node.id, slotFor(node, board, memory, area));
    placed.add(node.id);
  }

  const nodes = plan.nodes.map((node) => {
    const rect = board.rects.get(node.id);
    return rect && (rect.x !== node.x || rect.y !== node.y) ? { ...node, x: rect.x, y: rect.y } : node;
  });
  const next: AutoMemory = {
    rects: new Map(nodes.map((node) => [node.id, rectOf(node)])),
    parents: now.parents,
    grid: memory.grid,
    ...(memory.columns ? { columns: memory.columns } : {}),
  };
  // 坐标与规划完全一致：就是规划本身。否则取景的标记要跟着“持有的这个排布”走，而不是规划的——
  // 经典的一列排布不能被当成格点排布缩到“全部入画”（那样比整体重排前缩得更小）。
  if (nodes.every((node, i) => node === plan.nodes[i])) return { layout: plan, memory: next, mode: "hold", added: fresh.map((node) => node.id) };
  const layout: SceneLayout = { ...plan, nodes, bounds: boundsOf(nodes) };
  if (memory.grid) layout.grid = true;
  else {
    delete layout.grid;
    delete layout.fitAll;
  }
  return { layout, memory: next, mode: "hold", added: fresh.map((node) => node.id) };
}
