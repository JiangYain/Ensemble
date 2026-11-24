import type { SessionSummary } from "@shared/types";
import { anchorBlock } from "./layout-block";
import { boundsOf, NODE, type LayoutNode } from "./layout-geometry";
import type { SceneModel } from "./layout-model";
import type { Lattice } from "./layout-plan";
import type { Cluster } from "./layout-strips";
import type { LayoutDims, SceneTree } from "./layout-tree";
import { agentNodeId, NO_OVERHANG, originNodeId, type Assembly, type Built, type LayoutFolder, type LayoutOptions, type Sink } from "./layout-types";
import { workspaceClusters, type WorkspaceSettings } from "./layout-workspace";

/**
 * 排布的第三步：把模型与树摆成一整套节点与连线（还没有排列到画布上）。
 * 每个来源一组（经典的树或格点），汇聚的补线，再按 Folder / Git 归成整体；被隐藏的来源只有一张来源卡。
 * 排列与选哪种排法是下一步的事（layout-scene-select），它会为格点排法再调用一次 `assemble`。
 */

/** 排布一次要用的一切：选项、尺寸、模型、树（子树高度的缓存在树里，经典排法与格点排法两次摆放共用）。 */
export interface SceneContext {
  readonly options: LayoutOptions;
  readonly dims: LayoutDims;
  readonly model: SceneModel;
  readonly tree: SceneTree;
}

/**
 * 把全部来源摆成一套：每个来源一组（给了 `lattice` 就按格点，否则是经典的树），再按 Folder / Git 归成整体。
 * 每次调用都从头摆出一套全新的节点——经典排法与格点排法互不共用节点，谁被采用都不会带着别人的位置偏移。
 * 返回的整体还没有排列到各列里（偏移量见 arrange 与 Lattice.offsets）。
 */
export function assemble(scene: SceneContext, lattice?: Lattice): Assembly {
  const out: Sink = { nodes: [], edges: [] };
  const { items, chipItems } = buildItems(scene, out, lattice);
  addJoinEdges(scene.model, out);
  const folders: LayoutFolder[] = [];
  const grouped = workspaceClusters(
    items.filter((item) => !chipItems.has(item)),
    out,
    folders,
    workspaceSettings(scene, lattice),
  );
  const clusters = chipItems.size === 0 ? grouped : withChips(items, chipItems, grouped);
  return { nodes: out.nodes, edges: out.edges, folders, items, clusters };
}

/** 按来源的先后逐个来源摆好：有会话的排成一组，被隐藏的只有一张来源卡。 */
function buildItems(scene: SceneContext, out: Sink, lattice: Lattice | undefined): { items: Built[]; chipItems: Set<Built> } {
  const { order, roots } = scene.model;
  const items: Built[] = [];
  const chipItems = new Set<Built>();
  for (const { key } of order) {
    const group = roots.get(key);
    if (!group) {
      const chip = buildChip(scene, key, out);
      items.push(chip);
      chipItems.add(chip);
      continue;
    }
    items.push(buildBlock(scene, key, group, out, lattice));
  }
  return { items, chipItems };
}

/** 被隐藏的来源：只有一张来源卡。 */
function buildChip(scene: SceneContext, key: string, out: Sink): Built {
  const { originW } = scene.dims;
  const origin: LayoutNode = { id: originNodeId(key), kind: "origin", x: 0, y: 0, w: originW, h: NODE.originH, overhang: NO_OVERHANG };
  out.nodes.push(origin);
  return { summary: scene.model.byOrigin.get(key)!, origin, nodes: [origin], width: originW, height: NODE.originH };
}

/**
 * 把一个有会话的来源排成一组（以自己的左上角为原点）：没有 `lattice` 是经典的树——来源卡在最左、居中于它的根会话，会话向右；
 * 有 `lattice` 是格点排布：节点与连线仍按经典的次序生成（先后与经典一致），位置与锚点再按格点重写（见 layout-plan）。
 */
function buildBlock(scene: SceneContext, key: string, group: readonly SessionSummary[], out: Sink, lattice?: Lattice): Built {
  const { originW } = scene.dims;
  const firstNode = out.nodes.length;
  const { rootNodes, extent } = scene.tree.placeRoots(group, out);
  const first = rootNodes[0];
  const last = rootNodes[rootNodes.length - 1];
  const centerY = first && last ? (first.y + (last.y + last.h)) / 2 : extent / 2;
  const origin: LayoutNode = {
    id: originNodeId(key),
    kind: "origin",
    x: 0,
    y: centerY - NODE.originH / 2,
    w: originW,
    h: NODE.originH,
    overhang: NO_OVERHANG,
  };
  // 来源卡排在它的会话前面：第一个根会话以它为锚点，锚点要先于挂着它的节点（见 LayoutNode.anchor）。
  out.nodes.splice(firstNode, 0, origin);
  if (first) first.anchor = { id: origin.id, dx: first.x - origin.x, dy: first.y - origin.y };
  for (const root of group) out.edges.push({ id: `${origin.id}>${agentNodeId(root.id)}`, from: origin.id, to: agentNodeId(root.id), phase: root.phase });

  const own = out.nodes.slice(firstNode);
  if (lattice) {
    const at = lattice.positions(key);
    for (const node of own) {
      const to = at.get(node.id);
      if (to) {
        node.x = to.x;
        node.y = to.y;
      }
    }
    anchorBlock(own, origin.id, scene.tree.kidsOf);
  }
  // 发起端比只有一两个会话的子树更高时会冒出顶部：整组下移，让组的上缘回到 0。
  const box = boundsOf(own);
  for (const node of own) {
    node.x -= box.x;
    node.y -= box.y;
  }
  return { summary: scene.model.byOrigin.get(key)!, origin, nodes: own, width: box.w, height: box.h };
}

function addJoinEdges({ ordered, drawn }: SceneModel, out: Sink): void {
  // 汇聚：会话除了树里挂着的那个上级，其余画出来的上级各多一条连线（id 与树里的连线同一个写法：上级>子会话）。
  // 只是多连几条线：节点不动；上级与子会话可以在别的树、别的来源块里（块、单元都是刚性地整体挪动，线跟着节点走）。
  // 排在所有树里的连线之后：引擎按“第一条指向它的连线”找上游节点，那一条始终是树里的。
  for (const session of ordered) {
    for (const parentId of (drawn.get(session.id) ?? []).slice(1)) {
      out.edges.push({ id: `${agentNodeId(parentId)}>${agentNodeId(session.id)}`, from: agentNodeId(parentId), to: agentNodeId(session.id), phase: session.phase });
    }
  }
}

function workspaceSettings({ options, dims }: SceneContext, lattice: Lattice | undefined): WorkspaceSettings {
  // 紧凑的取景区域或单空间视图（目录与 Git 已升格到顶部标头）不在画布左侧排 Folder 与 Git 节点。
  const showContextNodes = !dims.compact && !options.hideContextNodes;
  return {
    git: showContextNodes ? options.git : undefined,
    drawFolders: showContextNodes,
    gap: lattice ? lattice.leadGap : dims.originGap,
    stackGap: lattice ? lattice.stackGap : NODE.groupGap,
  };
}

/**
 * 把“只有一张卡”的来源按原来的先后放回各组之间：`built` 是全部来源的先后，`grouped` 是其余来源按 Folder / Git 归成的组
 * （每组的第一个节点是它第一个成员的来源节点，据此认出这一组排在哪）。
 */
function withChips(built: readonly Built[], chips: ReadonlySet<Built>, grouped: readonly Cluster[]): Cluster[] {
  const byFirst = new Map(grouped.map((cluster) => [cluster.nodes[0]!.id, cluster]));
  const out: Cluster[] = [];
  for (const item of built) {
    if (chips.has(item)) {
      out.push({ nodes: item.nodes, width: item.width, height: item.height, lead: 0, keys: [item.summary.origin.key] });
      continue;
    }
    const cluster = byFirst.get(item.origin.id);
    if (cluster) out.push(cluster);
  }
  return out;
}
