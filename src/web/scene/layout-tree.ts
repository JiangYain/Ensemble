import type { SessionId, SessionSummary } from "@shared/types";
import { isCompact, NODE, type LayoutNode } from "./layout-geometry";
import type { SceneModel } from "./layout-model";
import { agentNodeId, NO_OVERHANG, originNodeId, type LayoutOptions, type Sink } from "./layout-types";

/**
 * 排布的第二步：经典的树。量出每棵子树的高度，把一个来源名下的根会话连同嵌套的子会话逐棵摆好（节点与连线写进调用方给的 `Sink`），
 * 并给出“节点 id → 子节点 id”的索引（格点排布按它折树）。只读 `SceneModel` 与尺寸，不读别的排布结果。
 */

/** 排布用到的尺寸：紧凑的取景区域用一套更小的。 */
export interface LayoutDims {
  readonly compact: boolean;
  readonly originGap: number;
  readonly childGap: number;
  readonly originW: number;
  readonly agentW: number;
  /** 同一列里奇数位向右错开的距离；规划式排布与紧凑的取景区域里是 0。 */
  readonly stagger: number;
}

export function layoutDims(options: LayoutOptions): LayoutDims {
  const { area } = options;
  const compact = isCompact(area);
  return {
    compact,
    originGap: compact ? NODE.originGapCompact : NODE.originGap,
    childGap: compact ? NODE.childGapCompact : NODE.childGap,
    originW: compact ? NODE.originWCompact : NODE.originW,
    agentW: compact ? NODE.agentWCompact : NODE.agentW,
    // 错位（奇数位向右让 24px）只属于不规划的经典排法；规划式排布里同一列的卡左缘必须在同一个 x 上（见 layout-stacked 的说明）。
    stagger: compact || (options.grid && area) ? 0 : NODE.stagger,
  };
}

/** 会话节点相对上一个兄弟的锚点：紧挨着下方（水平照布局里的错位，竖直只隔一个行距）。为什么不照搬布局偏移见 LayoutNode.anchor。 */
const beneath = (sibling: LayoutNode, node: LayoutNode): NonNullable<LayoutNode["anchor"]> => ({ id: sibling.id, dx: node.x - sibling.x, dy: sibling.h + NODE.rowGap });

/** 一次排布里的树：子树高度只量一次（经典排法与格点排法两套节点共用同一份），节点 id 的子节点索引只在要排格点时才建。 */
export class SceneTree {
  // Once the graph is acyclic, measure each subtree once and place it using those measurements.
  private readonly heights = new Map<SessionId, number>();
  private kidNodes: Map<string, string[]> | undefined;

  constructor(
    private readonly model: SceneModel,
    private readonly dims: LayoutDims,
  ) {}

  /**
   * 把一个来源名下的根会话（连同各自嵌套的子会话）逐棵摆好，根会话自上而下排成一列（相邻的水平错位 `stagger`）；
   * `extent` 是这一列的总高度。
   */
  placeRoots(group: readonly SessionSummary[], out: Sink): { rootNodes: LayoutNode[]; extent: number } {
    let cursor = 0;
    const rootNodes: LayoutNode[] = [];
    group.forEach((root, index) => {
      const rootNode = this.place(out, root, 0, cursor, index);
      const before = rootNodes[index - 1];
      if (before) rootNode.anchor = beneath(before, rootNode);
      rootNodes.push(rootNode);
      cursor += this.heightOf(root) + NODE.rowGap;
    });
    return { rootNodes, extent: cursor - NODE.rowGap };
  }

  // 节点 id → 它的子节点的 id（按创建先后；来源卡的子节点是它的根会话）：格点排布按它折树，只在要排格点时才建。
  readonly kidsOf = (id: string): readonly string[] => {
    if (!this.kidNodes) {
      this.kidNodes = new Map();
      for (const [parent, list] of this.model.children) this.kidNodes.set(agentNodeId(parent), list.map((kid) => agentNodeId(kid.id)));
      for (const [key, list] of this.model.roots) this.kidNodes.set(originNodeId(key), list.map((root) => agentNodeId(root.id)));
    }
    return this.kidNodes.get(id) ?? [];
  };

  private stackHeight(siblings: readonly SessionSummary[]): number {
    return siblings.reduce((sum, child) => sum + this.heightOf(child), 0) + Math.max(0, siblings.length - 1) * NODE.rowGap;
  }

  private heightOf(session: SessionSummary): number {
    const cached = this.heights.get(session.id);
    if (cached !== undefined) return cached;
    const height = Math.max(NODE.agentH, this.stackHeight(this.model.children.get(session.id) ?? []));
    this.heights.set(session.id, height);
    return height;
  }

  // 节点与连线写进 `out`。
  private place(out: Sink, session: SessionSummary, depth: number, top: number, index: number): LayoutNode {
    const { originW, originGap, agentW, childGap, stagger } = this.dims;
    const { children, columnOf } = this.model;
    const block = this.heightOf(session);
    const colGapW = agentW + stagger + childGap;
    // 列：没有汇聚时就是树里的深度；上级不止一个的会话被推到所有上级的右边（见 columnOf），它的子会话顺着往右排。
    const column = columnOf.get(session.id) ?? depth;
    const node: LayoutNode = {
      id: agentNodeId(session.id),
      kind: "agent",
      x: originW + originGap + column * colGapW + (index % 2) * stagger,
      y: top + (block - NODE.agentH) / 2,
      w: agentW,
      h: NODE.agentH,
      overhang: NO_OVERHANG,
    };
    out.nodes.push(node);
    const kids = children.get(session.id) ?? [];
    if (kids.length > 0) {
      let cursor = top + (block - this.stackHeight(kids)) / 2;
      let before: LayoutNode | undefined;
      kids.forEach((kid, kidIndex) => {
        const child = this.place(out, kid, column + 1, cursor, kidIndex);
        child.anchor = before ? beneath(before, child) : { id: node.id, dx: child.x - node.x, dy: child.y - node.y };
        before = child;
        out.edges.push({ id: `${node.id}>${agentNodeId(kid.id)}`, from: node.id, to: agentNodeId(kid.id), phase: kid.phase });
        cursor += this.heightOf(kid) + NODE.rowGap;
      });
    }
    return node;
  }
}
