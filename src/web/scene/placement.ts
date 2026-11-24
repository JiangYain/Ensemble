import { NODE, type LayoutNode } from "./layout";
import type { NodePosition } from "./positions";

/**
 * 新来的会话节点落在哪里。纯函数，不碰 DOM 与引擎：引擎只在布局变化时把“新来的是谁、别人在哪”交进来，拿到要记下的位置。
 *
 * 用户已经把画布整理过了：新节点应当接在他整理的结果后面，而不是掉回布局按“所有节点都在默认位置”算出的那个空位
 * （那里多半是一长列的最底部，或者已经被他拖过去的别的节点占着）。
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 浮点比较的容差：布局里相邻两行恰好隔 rowGap，边缘相碰不算挤在一起。 */
const EPS = 0.01;

/** a 是否挤进了 b 四周 gap 以内的范围（包括直接相交）。 */
const crowds = (a: Rect, b: Rect, gap: number): boolean =>
  a.x < b.x + b.w + gap - EPS && b.x - gap + EPS < a.x + a.w && a.y < b.y + b.h + gap - EPS && b.y - gap + EPS < a.y + a.h;

/**
 * 从参照位置 `from` 加上偏移 `offset` 起，找一个不挤着别人的落点：落点与 `occupied` 里的每个矩形都隔开至少 `gap`。
 * 挤着了就一直往下走（会话一列列从上往下排，新来的总在后面），每次落到那个障碍的下沿再隔 gap，保持行距的节奏；
 * 所以只会绕开真正挡路的节点，中间放得下的空档会被用上，不会比必要的多飞一步。输入不被修改。
 */
export function placeBeside(
  from: NodePosition,
  offset: { dx: number; dy: number },
  size: { w: number; h: number },
  occupied: readonly Rect[],
  gap: number = NODE.rowGap,
): NodePosition {
  const x = from.x + offset.dx;
  let y = from.y + offset.dy;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { x, y };
  // 每一步 y 都严格变大、障碍有限，一定收敛。
  for (;;) {
    let next = y;
    for (const other of occupied) if (crowds({ x, y, w: size.w, h: size.h }, other, gap)) next = Math.max(next, other.y + other.h + gap);
    if (next === y) return { x, y };
    y = next;
  }
}

const rectOf = (node: LayoutNode, at: NodePosition | undefined): Rect => ({ x: at?.x ?? node.x, y: at?.y ?? node.y, w: node.w, h: node.h });

/**
 * `node.anchor` 的偏移在这份布局里是不是真的成立（LAYOUT4 · W10）。
 * 锚点是“上级”（偏移朝右，就是布局里的实际相对位置）时总是成立。锚点是“上一个兄弟”（偏移几乎正下方，dx 只是错位）时只说了一件事：
 * 新卡该在它的下面——可是多列的格点里，新根会话的槽位在下一列、甚至下一行的最左一格，并不在上一个根会话的正下方，
 * 这时偏移只是个约定，照它去跟就会让后到的卡一张接一张沿着同一列往下堆：引擎把让开之后的落点也记进了手动位置
 * （与用户拖的放在同一张表里，这里分不出来），下一张卡的“上一个兄弟”就是这张被记下的卡，于是一路往下。
 * 偏移不成立的锚点不当参照，新卡回到布局给的槽位（被占了再让开）；槽位本来就在锚点正下方的（一列的排布、竖排的子会话）照旧跟。
 */
function describes(node: LayoutNode, anchor: LayoutNode): boolean {
  if (!node.anchor || Math.abs(node.anchor.dx) > node.w / 2) return true;
  return Math.abs(node.x - anchor.x) <= node.w / 2 && node.y > anchor.y;
}

/**
 * 谁是新来的：布局里不是早就知道的节点。`isKnown` 说某个节点是不是早就知道的——在画布上出现过，或者被视图过滤收起过
 * （收起的会话没有在画布上，但用户早就知道它们，重新显示出来不是“新到的”）。
 * 布局里一个节点都不是已知的时（页面刚打开）那是“现状”，不是“新来的”：返回空集。
 * 摆放新节点（arrivalsFor）与新节点落在视口外时的提示（arrivals.ts）共用这一份定义，不各算各的。
 */
export function freshIds(nodes: readonly LayoutNode[], isKnown: (id: string) => boolean): Set<string> {
  const fresh = new Set<string>();
  let known = false;
  for (const node of nodes) {
    if (isKnown(node.id)) known = true;
    else fresh.add(node.id);
  }
  return known ? fresh : new Set();
}

/**
 * 引擎的入口：由 freshIds 得出谁是新来的（已有手动位置的不算：它们有自己的位置），再交给 planArrivals。
 * 用户一个节点都没摆过（`placed` 为空）时没有可接的：全部照布局，什么都不记。
 * 页面刚打开、布局里没有一个节点是已知的时也不规划：没摆过的节点不该被搬走。
 */
export function arrivalsFor(nodes: readonly LayoutNode[], placed: ReadonlyMap<string, NodePosition>, isKnown: (id: string) => boolean): Map<string, NodePosition> {
  if (placed.size === 0) return new Map();
  const fresh = freshIds(nodes, isKnown);
  for (const id of fresh) if (placed.has(id)) fresh.delete(id);
  return planArrivals(nodes, placed, fresh);
}

/**
 * 这一次布局里新来的会话节点各自落在哪里：只返回需要记下来（写进 positions）的那几个，其余的照布局原位。
 *
 * - 它的参照（`anchor`：同一父节点下上一个兄弟 / 第一个子会话的父节点 / 第一个根会话的来源卡）被用户摆放过时，
 *   落在参照“此刻的位置”加上 anchor 的偏移，再避开别的节点；这个位置要记下来，之后布局再变也不会把它带回默认槽位。
 *   “上一个兄弟”的偏移要在布局里真的成立（槽位就在它的正下方，见 `describes`），否则不当参照：多列的格点里跟着它走，
 *   会让一张被记下的让开落点带出后面所有的卡，沿同一列一路往下堆。
 * - 参照没被动过（没有手动位置）时，节点本来就在布局给的位置，不记：没有任何拖拽的原始状态下 positions 保持为空。
 *   只有这个默认槽位被用户拖来的节点占了，才往下避开（下面别的来源的节点也算障碍），并把避开后的位置记下来。
 *
 * - `nodes` 按布局顺序，锚点排在挂着它的节点前面：前一个新节点的落点是下一个的参照，同时来几个也互不重叠。
 * - `placed`：用户摆放过的位置（含之前记下的）。`fresh`：本次新来的节点 id，只有会话节点（kind 为 agent）在这里处理；
 *   还没轮到的新节点没有最终位置，不当作障碍。
 */
export function planArrivals(
  nodes: readonly LayoutNode[],
  placed: ReadonlyMap<string, NodePosition>,
  fresh: ReadonlySet<string>,
  gap: number = NODE.rowGap,
): Map<string, NodePosition> {
  const held = new Map(placed);
  const waiting = new Set(fresh);
  const planned = new Map<string, NodePosition>();
  const byId = new Map(nodes.map((node) => [node.id, node]));

  for (const node of nodes) {
    if (!waiting.has(node.id) || node.kind !== "agent" || held.has(node.id)) continue;
    waiting.delete(node.id);
    const others = nodes.filter((other) => other.id !== node.id && !waiting.has(other.id));
    const anchor = node.anchor ? byId.get(node.anchor.id) : undefined;
    const ref = node.anchor && (!anchor || describes(node, anchor)) ? held.get(node.anchor.id) : undefined;

    let spot: NodePosition;
    if (node.anchor && ref) {
      // 落点在没有规划过的地方：任何节点（含还在默认位置的）都可能挡路。
      spot = placeBeside(ref, node.anchor, node, others.map((other) => rectOf(other, held.get(other.id))), gap);
    } else {
      // 落点就是布局给的槽位：那里没有人，除非用户把别的节点拖了过来。
      const taken = others.filter((other) => held.has(other.id)).map((other) => rectOf(other, held.get(other.id)));
      if (placeBeside({ x: node.x, y: node.y }, { dx: 0, dy: 0 }, node, taken, gap).y === node.y) continue;
      // 槽位被占了，要往下让开：下面可能就是布局里排在后面的别的来源，这时任何节点都可能挡路。
      spot = placeBeside({ x: node.x, y: node.y }, { dx: 0, dy: 0 }, node, others.map((other) => rectOf(other, held.get(other.id))), gap);
    }
    held.set(node.id, spot);
    planned.set(node.id, spot);
  }
  return planned;
}
