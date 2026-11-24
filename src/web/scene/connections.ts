import type { LayoutEdge } from "./layout";
import { NodePorts, type PortPhases } from "./ports";
import {
  chooseSide,
  copyCurve,
  createPipeElements,
  Curve,
  curvePath,
  ease,
  mixCurve,
  opposite,
  pinCurve,
  pipePriority,
  portX,
  portY,
  removePipe,
  ROUTE,
  routeCurve,
  sameCurve,
  setPipe,
  setPipeFlow,
  setPipePhase,
  type PipeBox,
  type PipeElements,
  type PipeGroups,
  type Side,
} from "./pipes";

/**
 * 连接层：画布上连线与端口方点的唯一所有者。引擎（engine.ts）只管节点怎么动，不碰连线；
 * 这里管每条线的 SVG 元素、走哪一边、换边的过渡，以及每个节点四条边上的方点（ports.ts）。
 * 连线只需要节点的位置与尺寸，所以引擎逐帧交进来的是只读的最小形状（ConnectionBody），这一层也不依赖引擎。
 */

/** 连线眼里的节点：此刻的位置（弹簧走到哪里）、正在走向的位置，以及尺寸。引擎的节点直接满足这个形状，逐帧传进来不分配对象。 */
export interface ConnectionBody {
  readonly x: number;
  readonly y: number;
  readonly tx: number;
  readonly ty: number;
  readonly w: number;
  readonly h: number;
}

/** 一条连线的渲染状态：元素、此刻走的边，以及换边时的过渡。 */
interface EdgeEntry {
  edge: LayoutEdge;
  els: PipeElements;
  /** 当前走的边（Side 的值）；-1 表示还没有选过。 */
  side: number;
  /** 最近一次画出来的曲线：换边时的过渡从它出发，所以画面上不会跳。 */
  shown: Curve;
  /** 过渡的起点：换边那一刻 shown 记成跟着两端节点的形式（见 pinCurve），之后随节点一起动。 */
  from: Curve;
  /** 过渡开始的时刻（performance.now 的时间轴，毫秒）；-1 表示没有在过渡。 */
  morphAt: number;
  /** 两端节点的方点登记（没注册的是 undefined）：节点登记有变时清空重取（见 rebind），逐帧不必再按 id 查。 */
  fromNode: NodeEntry | undefined;
  toNode: NodeEntry | undefined;
}

/** 一个已注册的节点元素：它的端口方点，以及本帧各边（下标是 Side 的值）上接着的连线里最活跃的阶段，undefined 的边没有连线、没有方点。 */
interface NodeEntry {
  ports: NodePorts;
  phases: PortPhases;
}

/**
 * 选边看的是节点正在走向的位置（布局的目标、或用户放下的位置），而不是弹簧此刻走到哪里：
 * 新节点从上游“长”出来、对齐与重排的途中，连线不会跟着途中的位置来回换边。拖动时两者本来就相同。
 */
function aim(body: ConnectionBody, out: PipeBox): PipeBox {
  out.x = body.tx;
  out.y = body.ty;
  out.w = body.w;
  out.h = body.h;
  return out;
}

/** 一条连线接在这个节点的这一边：方点落在这一边的落点上（没变就不写），最活跃的那条连线的阶段决定方点的颜色。 */
function attach(node: NodeEntry, body: ConnectionBody, side: Side, phase: LayoutEdge["phase"]): void {
  node.ports.place(side, portX(body, side), portY(body, side));
  const shown = node.phases[side];
  if (shown === undefined || pipePriority(phase) > pipePriority(shown)) node.phases[side] = phase;
}

export class ConnectionLayer {
  private groups: PipeGroups | undefined;
  private readonly edges = new Map<string, EdgeEntry>();
  private readonly nodes = new Map<string, NodeEntry>();
  /** 连线在 DOM 里的层叠顺序（边的 id 与阶段拼成的串）：没变就不重排。 */
  private orderKey = "";
  /** frame 逐帧复用的临时对象：选边用的两端位置、算出来的目标曲线、过渡中混合出来的曲线。 */
  private readonly aimFrom: PipeBox = { x: 0, y: 0, w: 0, h: 0 };
  private readonly aimTo: PipeBox = { x: 0, y: 0, w: 0, h: 0 };
  private readonly goal = new Curve();
  private readonly blend = new Curve();

  mount(groups: PipeGroups): void {
    this.groups = groups;
  }

  /** 连线都拆掉，方点跟着熄灭；节点元素还在（重新 mount 后 sync 与 frame 会按新的连线点亮），所以方点只熄灭、不拆。 */
  unmount(): void {
    for (const { els } of this.edges.values()) removePipe(els);
    this.edges.clear();
    this.orderKey = "";
    this.groups = undefined;
    for (const { ports } of this.nodes.values()) ports.reset();
  }

  /** 节点元素先于画布容器挂载，所以 mount 之前就可以注册。返回的函数在元素卸载时调用：只拿走这个元素自己的方点。 */
  register(id: string, el: HTMLElement): () => void {
    const known = this.nodes.get(id);
    if (known?.ports.host !== el) {
      known?.ports.dispose();
      this.nodes.set(id, { ports: new NodePorts(el), phases: [undefined, undefined, undefined, undefined] });
      this.rebind();
    }
    return () => {
      const current = this.nodes.get(id);
      if (current?.ports.host !== el) return;
      current.ports.dispose();
      this.nodes.delete(id);
      this.rebind();
    };
  }

  private rebind(): void {
    for (const entry of this.edges.values()) {
      entry.fromNode = undefined;
      entry.toNode = undefined;
    }
  }

  /** 布局变了：让连线的集合与层叠顺序同边一致。留下来的连线不动元素、选好的边与过渡，只更新阶段。 */
  sync(next: readonly LayoutEdge[]): void {
    const groups = this.groups;
    if (!groups) return;
    const keep = new Set<string>();
    for (const edge of next) {
      keep.add(edge.id);
      const existing = this.edges.get(edge.id);
      if (existing) {
        existing.edge = edge;
        setPipePhase(existing.els, edge.phase);
      } else {
        const els = createPipeElements(groups);
        setPipePhase(els, edge.phase);
        const shown = new Curve();
        shown.x0 = Number.NaN; // 还没画过：第一次一定会写
        this.edges.set(edge.id, { edge, els, side: -1, shown, from: new Curve(), morphAt: -1, fromNode: undefined, toNode: undefined });
      }
    }
    for (const [id, entry] of [...this.edges]) {
      if (!keep.has(id)) {
        removePipe(entry.els);
        this.edges.delete(id);
      }
    }
    this.restack(groups);
  }

  /** 活跃的管线放在上层。只在顺序真的变了的时候才重排 DOM。 */
  private restack(groups: PipeGroups): void {
    const ordered = [...this.edges.values()].sort((a, b) => pipePriority(a.edge.phase) - pipePriority(b.edge.phase) || (a.edge.id < b.edge.id ? -1 : 1));
    const key = ordered.map((entry) => `${entry.edge.id}:${entry.edge.phase}`).join("|");
    if (key === this.orderKey) return;
    this.orderKey = key;
    for (const entry of ordered) {
      groups.tube.appendChild(entry.els.tube);
      groups.dots.appendChild(entry.els.fine);
      for (const packet of entry.els.packets) groups.dots.appendChild(packet);
    }
  }

  /**
   * 按两端节点此刻的位置重算所有连线，并让端口方点跟上。返回是否还有连线停在换边的过渡里（要继续排下一帧）。
   * 每条连线 O(1)：选一次边（带滞回，见 chooseSide）、算一段曲线、没变就不写 DOM；不读任何布局信息。
   * 方点只落在连线接着的那几条边上：落点（随布局或尺寸变化）与显隐都在这里更新，两者都是没变就不写；没有连线的边不写落点。
   */
  frame(bodies: ReadonlyMap<string, ConnectionBody>, now: number, reducedMotion: boolean): boolean {
    for (const node of this.nodes.values()) node.phases.fill(undefined);
    let busy = false;
    for (const entry of this.edges.values()) {
      const { edge } = entry;
      const from = bodies.get(edge.from);
      const to = bodies.get(edge.to);
      if (!from || !to) continue;
      const fromNode = (entry.fromNode ??= this.nodes.get(edge.from));
      const toNode = (entry.toNode ??= this.nodes.get(edge.to));

      const side = chooseSide(entry.side, aim(from, this.aimFrom), aim(to, this.aimTo));
      const goal = routeCurve(from, to, side, this.goal);
      if (side !== entry.side) {
        // 换边：从眼下画着的曲线滑到新的那条，端点不跳。第一次选边与“减少动效”时直接到位。
        if (entry.side >= 0 && !reducedMotion) {
          pinCurve(entry.shown, from, to, entry.from);
          entry.morphAt = now;
        } else {
          entry.morphAt = -1;
        }
        entry.side = side;
      }
      let shown = goal;
      if (entry.morphAt >= 0) {
        const k = (now - entry.morphAt) / (ROUTE.morph * 1000);
        if (k >= 1) {
          entry.morphAt = -1;
        } else {
          shown = mixCurve(entry.from, goal, ease(k > 0 ? k : 0), from, to, this.blend);
          busy = true;
        }
      }
      if (!sameCurve(shown, entry.shown)) {
        copyCurve(shown, entry.shown);
        setPipe(entry.els, curvePath(shown));
        setPipeFlow(entry.els, shown.x0, shown.y0, shown.x3, shown.y3);
      }
      if (fromNode) attach(fromNode, from, side, edge.phase);
      if (toNode) attach(toNode, to, opposite(side), edge.phase);
    }
    for (const node of this.nodes.values()) node.ports.apply(node.phases);
    return busy;
  }
}
