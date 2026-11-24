import type { SessionSummary } from "@shared/types";
import { boundsOf } from "./layout-geometry";
import { buildModel, hiddenAgentIds } from "./layout-model";
import { assemble, type SceneContext } from "./layout-scene-assemble";
import { arrangeScene } from "./layout-scene-select";
import { layoutDims, SceneTree } from "./layout-tree";
import type { LayoutOptions, SceneLayout } from "./layout-types";

// 公开的出口仍是这个文件：尺寸、取景与外框搬到了 layout-geometry，类型与节点 id 搬到了 layout-types，这里原样重新导出，使用方的导入不必改。
export { boundsOf, fitArea, fitCamera, fitPadding, fitScale, FIT_ALL_MIN_ZOOM, FIT_FLOOR, holdScale, isCompact, MIN_ZOOM, NODE } from "./layout-geometry";
export type { Area, Bounds, LayoutNode, Padding } from "./layout-geometry";
export { agentNodeId, folderNodeId, gitNodeId, originNodeId } from "./layout-types";
export type { LayoutEdge, LayoutFolder, LayoutOptions, SceneLayout } from "./layout-types";

/**
 * 宽幅树形布局：发起端在最左，被委派的会话按嵌套深度向右排列。
 * 同一发起端的会话纵向堆叠（奇数位向右错开），
 * 有子会话的节点相对其子树垂直居中；
 * 会话可以有多个上级（汇聚）：它仍然只挂在画出来的第一个上级下面（排布与拖动锚点都只跟这一个），列被推到同一来源块里所有上级的右边，
 * 其余上级各多画一条连线（见 layout-model 的 `columnOf` 与 layout-scene-assemble 里的补线）；没有汇聚的画布与原来一模一样；
 * 多个发起端各成一组，按取景区域的形状在 1~4 列里选一种摆法，让内容尽量不被缩小；
 * 工作目录相同的发起端共用左边的一张 Folder 节点，目录在同一个 Git 工作树里的再共用最左边的一张 Git 节点，
 * 它们合成一个整体，叠放在同一列里（见 layout-workspace 的 workspaceClusters）。
 *
 * 给了 `grid` 与 `area`（Overview 的空间视图）时改走规划式排布（见 `LayoutOptions.grid`）：同一个来源仍然先排成上面的树，
 * 整体放不下缩放上限 `zoom`、或放得下却是一条细长的竖串（或横屏里单个来源下叠着 3 个以上没有子会话的根会话，见 layout-stacked）时，
 * 试着把全部来源排成同一张格子里的规则网格（layout-plan），摆出来核对过才采用，对不上就仍是经典的树（见 layout-scene-select 的 `planScene`）。
 * 默认的排布与“重置节点布局”之后的排布共用这一条路径，只差引擎传来的 `zoom`。
 *
 * 一次排布分四步，各步在自己的模块里：
 *   1. 尺寸（layout-tree 的 `layoutDims`）与模型（layout-model 的 `buildModel`）：谁挂在谁下面、哪些来源、先后如何；
 *   2. 树（layout-tree 的 `SceneTree`）：量子树高度、摆根会话与嵌套的子会话；
 *   3. 摆放（layout-scene-assemble 的 `assemble`）：每个来源摆成一组，再按 Folder / Git 归成整体；
 *   4. 排列（layout-scene-select 的 `arrangeScene`）：按取景区域选经典排法或格点排法，把各组排列到画布上。
 */
export function layoutScene(sessions: readonly SessionSummary[], options: LayoutOptions = {}): SceneLayout {
  const dims = layoutDims(options);
  const model = buildModel(sessions, options);
  const scene: SceneContext = { options, dims, model, tree: new SceneTree(model, dims) };

  const base = assemble(scene);
  const { chosen, usedGrid, fitAll } = arrangeScene(scene, base);

  const hidden = hiddenAgentIds(sessions, options.visible);
  return {
    nodes: chosen.nodes,
    edges: chosen.edges,
    bounds: boundsOf(chosen.nodes),
    origins: model.origins,
    folders: chosen.folders,
    ...(hidden?.size ? { hidden } : {}),
    ...(usedGrid ? { grid: true } : {}),
    ...(fitAll ? { fitAll: true } : {}),
  };
}
