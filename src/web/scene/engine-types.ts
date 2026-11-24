import type { PipeGroups } from "./pipes";

/**
 * 画布引擎对外的类型（由 engine.ts 原样重新导出，使用方的导入不必改）。
 * 引擎内部各部分之间传递的类型（`Body` 等）不在这里：它们不对外。
 */

export interface Camera {
  x: number;
  y: number;
  k: number;
}

export interface MountOptions {
  viewport: HTMLElement;
  world: HTMLElement;
  pipes: PipeGroups;
  padding?: { top: number; right: number; bottom: number; left: number };
  onCamera?: (camera: Readonly<Camera>, userMoved: boolean) => void;
  onPositions?: (custom: boolean) => void;
  /** 每次布局之后：现在的排布与全新规划不同（见 HeldLayout.drifted），“重新排列”有东西可排。 */
  onArrangement?: (drifted: boolean) => void;
  onSelection?: (count: number) => void;
}

/** 界面（对齐条）订阅的引擎状态：和节点位置、选中与历史有关的那几项。 */
export interface EngineState {
  selected: number;
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * 右键（以及键盘上的 ContextMenu 键、Shift+F10）落在某个节点上时，引擎交给界面的描述。
 * 引擎只判断“菜单该作用于谁”，不知道菜单里有什么。
 */
export interface NodeContextRequest {
  /** 被点的节点。 */
  nodeId: string;
  /** 它的元素：宿主用来定位（键盘触发时）和在菜单关闭后归还焦点。 */
  el: HTMLElement;
  /**
   * 菜单的作用范围：
   * - `selection`：被点的节点属于“选中 ≥2 个”的集合，菜单作用于整个集合，选中不变；
   * - `node`：其余情况，菜单只作用于被点的这一个节点。
   */
  scope: "node" | "selection";
  /** 作用的节点 id。`selection` 时是选中集合的快照。 */
  ids: readonly string[];
  /** 指针位置（视口坐标）；键盘触发时没有可靠的坐标，为 undefined，由宿主把菜单放到节点的合理位置。 */
  point: { x: number; y: number } | undefined;
}

/** 返回 true 表示宿主已经为它打开了菜单：引擎才会拦下浏览器的原生菜单；返回 false 则原样放行。 */
export type NodeContextHandler = (request: NodeContextRequest) => boolean;
