import type { LayoutEdge, SceneLayout } from "./layout";
import { chooseSide, Curve, routeCurve, type PipeBox } from "./pipes";

/**
 * 一条连线按真实的选边（`chooseSide`）与曲线（`routeCurve`）算法采样成折线点：测试用它判断连线有没有从别的卡片上面经过。
 * 默认的排布里连线都是三次贝塞尔的 S 形，端点在两张卡的左右边中点。
 */
export function samplePipe(from: PipeBox, to: PipeBox, samples = 64): { x: number; y: number }[] {
  const curve = routeCurve(from, to, chooseSide(-1, from, to), new Curve());
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const u = 1 - t;
    const [a, b, c, d] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    points.push({ x: a * curve.x0 + b * curve.x1 + c * curve.x2 + d * curve.x3, y: a * curve.y0 + b * curve.y1 + c * curve.y2 + d * curve.y3 });
  }
  return points;
}

/**
 * 穿过非端点卡片的委派连线，写成“上级>子会话 穿过 卡”（节点 id）；卡片四周各缩进 1px，擦边不算。
 * `include` 挑要看的连线（默认全部委派连线，不含 Folder / Git 的 link）。
 */
export function crossingsOf(layout: SceneLayout, include: (edge: LayoutEdge) => boolean = () => true): string[] {
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  const found: string[] = [];
  for (const edge of layout.edges) {
    if (edge.phase === "link" || !include(edge)) continue;
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    const points = samplePipe(from, to);
    for (const card of layout.nodes) {
      if (card.id === from.id || card.id === to.id) continue;
      if (points.some((p) => p.x > card.x + 1 && p.x < card.x + card.w - 1 && p.y > card.y + 1 && p.y < card.y + card.h - 1)) {
        found.push(`${edge.from}>${edge.to} 穿过 ${card.id}`);
      }
    }
  }
  return found;
}
