import { bodyFor, writeNode, type Body } from "./engine-body";
import type { LayoutEdge, SceneLayout } from "./layout";
import type { NodePosition } from "./positions";

/** 一份布局交给引擎之后，逐个节点落位所需要的一切。 */
export interface NodePlacing {
  bodies: Map<string, Body>;
  /** 手动位置：新来的节点被记下的落点也写进这张表。 */
  positions: Map<string, NodePosition>;
  /** 这次布局里新来的会话落在哪（placement.ts 的 arrivalsFor）。 */
  arrivals: ReadonlyMap<string, NodePosition>;
  /** 容器第一次拿到布局：节点直接到位，不从上游“长”出来。 */
  first: boolean;
  reducedMotion: boolean;
}

/** 节点的上游：指向它的第一条连线（多个上级汇聚时排在最前的一条始终是树里的那条，见 layout-types.ts）的起点，要已经落位。 */
function sourceOf(bodies: ReadonlyMap<string, Body>, id: string, edges: readonly LayoutEdge[]): Body | undefined {
  const edge = edges.find((candidate) => candidate.to === id);
  const body = edge ? bodies.get(edge.from) : undefined;
  return body?.placed ? body : undefined;
}

/**
 * 按布局给每个节点定目标位置（手动位置优先，其次新来者的落点，最后是布局原位），还没落位的节点立即落位，
 * 新节点从它的上游“长”出来。返回这份布局里的全部节点 id（`keep`），以及这次是否记下了新的手动位置（`anchored`，要存）。
 */
export function placeNodes(layout: SceneLayout, state: NodePlacing): { keep: Set<string>; anchored: boolean } {
  const { bodies, positions, arrivals, first, reducedMotion } = state;
  const keep = new Set<string>();
  let anchored = false;
  for (const node of layout.nodes) {
    keep.add(node.id);
    const body = bodyFor(bodies, node.id);
    body.w = node.w;
    body.h = node.h;
    let position = positions.get(node.id);
    const arrival = !position && !body.placed ? arrivals.get(node.id) : undefined;
    if (arrival) {
      // 新来的会话：参照被用户摆放过，落在参照旁边（避开别的节点），并记住这个位置，之后布局再变也不会把它带回默认槽位。
      position = arrival;
      positions.set(node.id, arrival);
      anchored = true;
    } else if (!position && !body.placed && node.anchor && node.kind !== "agent") {
      // 挂在别的节点旁边的新节点（Git、Folder 节点）：锚点若被用户挪走过，就紧挨着它出现，并记住这个位置；
      // 落回布局原位，多半会压在已经挪过去的别的东西上。
      const near = positions.get(node.anchor.id);
      if (near) {
        position = { x: near.x + node.anchor.dx, y: near.y + node.anchor.dy };
        positions.set(node.id, position);
        anchored = true;
      }
    }
    body.tx = position?.x ?? node.x;
    body.ty = position?.y ?? node.y;
    if (!body.placed) {
      // 记下来的落点也从上游“长”出来；只有页面保存的旧位置（或第一次布局）才直接到位。
      const source = (position && !arrival) || first || reducedMotion ? undefined : sourceOf(bodies, node.id, layout.edges);
      if (source) {
        // 新节点从它的上游节点“长”出来：起点在上游的出口附近，弹簧把它送到位。
        body.x = source.x + source.w * 0.4;
        body.y = source.y + (source.h - node.h) / 2;
      } else {
        body.x = body.tx;
        body.y = body.ty;
      }
      body.vx = 0;
      body.vy = 0;
      body.placed = true;
      writeNode(body);
      if (source && body.el) body.el.dataset["fresh"] = "";
    }
  }
  return { keep, anchored };
}
