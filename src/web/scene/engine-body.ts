import type { Box } from "./arrange";
import { boundsOf, type Bounds, type LayoutNode } from "./layout";
import type { SceneSelection } from "./selection";

/**
 * 引擎里的一个节点：此刻的位置与速度（弹簧走到哪里）、正在走向的位置、尺寸，以及它的元素。
 * 引擎的各部分共用同一批 `Body` 对象（按引用），只有这个文件里的函数知道它们怎么创建、怎么写到元素上。
 */
export interface Body {
  id: string;
  el: HTMLElement | null;
  x: number;
  y: number;
  vx: number;
  vy: number;
  tx: number;
  ty: number;
  w: number;
  h: number;
  placed: boolean;
}

/** 取这个 id 的节点；还没有就新建并登记（元素可以先于布局登记，布局也可以先于元素到达）。 */
export function bodyFor(bodies: Map<string, Body>, id: string): Body {
  const existing = bodies.get(id);
  if (existing) return existing;
  const body: Body = {
    id,
    el: null,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    tx: 0,
    ty: 0,
    w: 0,
    h: 0,
    placed: false,
  };
  bodies.set(id, body);
  return body;
}

/** 换了空间：还挂着元素的节点留下、等新布局重新落位，没有元素的丢掉。 */
export function resetBodies(bodies: Map<string, Body>): void {
  for (const [id, body] of [...bodies]) {
    if (body.el) body.placed = false;
    else bodies.delete(id);
  }
}

/** 这份布局里没有、元素也已经卸载的节点丢掉。 */
export function pruneBodies(bodies: Map<string, Body>, keep: ReadonlySet<string>): void {
  for (const [id, body] of [...bodies]) {
    if (!keep.has(id) && !body.el) bodies.delete(id);
  }
}

/** 用独立的 `translate` 属性定位：`transform` 与 `scale` 留给入场、悬停之类的动画使用，互不覆盖。 */
export function writeNode(body: Body): void {
  if (body.el) body.el.style.translate = `${body.x.toFixed(2)}px ${body.y.toFixed(2)}px`;
}

/** 所有节点正在走向的位置围成的外框（取景看的是它，而不是弹簧此刻走到哪里）。 */
export function targetBounds(nodes: readonly LayoutNode[], bodies: ReadonlyMap<string, Body>): Bounds {
  return boundsOf(nodes.map((node) => {
    const body = bodies.get(node.id);
    return body ? { ...node, x: body.tx, y: body.ty } : node;
  }));
}

/** 手里这个节点移动时一起动的那些：它在选中集合里就是整个集合，否则只有它自己。 */
export function selectedBodies(bodies: ReadonlyMap<string, Body>, selection: Pick<SceneSelection, "has">, primary: Body): Body[] {
  if (!selection.has(primary.id)) return [primary];
  return [...bodies.values()].filter((body) => body.placed && body.el && selection.has(body.id));
}

/** 以动画的“目标位置”为准，而不是此刻弹簧走到哪里：连点两次也得到同样的结果。 */
export function selectedBoxes(bodies: ReadonlyMap<string, Body>, selection: Pick<SceneSelection, "has">): Box[] {
  return [...bodies.values()]
    .filter((body) => body.placed && body.el && selection.has(body.id))
    .map((body) => ({ id: body.id, x: body.tx, y: body.ty, w: body.w, h: body.h }));
}
