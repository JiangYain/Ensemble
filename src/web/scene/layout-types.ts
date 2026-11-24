import type { OriginSummary, SessionId, SessionPhase } from "@shared/types";
import type { FolderGroup } from "../lib/folder";
import type { Area, Bounds, LayoutNode } from "./layout-geometry";
import type { Cluster } from "./layout-strips";

/**
 * 画布布局的类型与节点 id。对外的那部分（`LayoutEdge`、`LayoutFolder`、`SceneLayout`、`LayoutOptions` 与四个 id 函数）由 layout.ts 原样重新导出，使用方的导入不必改；
 * `OriginGroup`、`Built`、`Sink`、`Assembly` 只是排布各步之间传递的中间产物，不对外。
 * 排布的各步（layout-model、layout-tree、layout-workspace、layout-scene-assemble、layout-scene-select）都读这个文件；它自己只引用 layout-geometry 与 layout-strips 的类型，不引用别的排布模块。
 */

export interface LayoutEdge {
  id: string;
  from: string;
  to: string;
  /**
   * 委派连线跟着会话的阶段；"link" 是静态的归属关系（Git 节点 → Folder 节点 → 来源节点）：一根不带流动点的实线。
   * 一张卡连着几个下游，就有几条 link，各自独立。
   * 一个会话有多个上级（汇聚）时，每个上级到它各有一条委派连线，id 都是 `上级节点>子会话节点`；指向同一个会话的连线里，
   * 排在最前的一条始终是树里的那条（引擎据此找它的上游，见 engine-layout.ts 的 sourceOf）。
   */
  phase: SessionPhase | "link";
}

/** 画布上排了的一张 Folder 卡：一个真实的目录，和连着它的来源。 */
export interface LayoutFolder extends FolderGroup {
  id: string;
}

export interface SceneLayout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  bounds: Bounds;
  origins: OriginGroup[];
  /** 画出来的 Folder 卡，与 `nodes` 里 kind 为 "folder" 的节点一一对应；紧凑的取景区域里不画，是空的。 */
  folders: LayoutFolder[];
  /**
   * 被视图过滤（`LayoutOptions.visible`）收起、没排进 `nodes` 的会话节点的 id；没有会话被收起时不带这一项。
   * 它们是用户早就知道的会话：引擎靠它分清“新到的会话”和“收起后重新出现的会话”，后者不按新节点重新放置（见 placement.ts）。
   */
  hidden?: ReadonlySet<string>;
  /** 本次布局用了格点排布（会话成多列规则网格；经典的树放不下、或是一条细长的竖串时才会这样，见 `LayoutOptions.grid`）；取景时允许缩小以一屏装下全部节点。 */
  grid?: boolean;
  /**
   * 规划式排布（`LayoutOptions.grid`）排完后，内容在 100% 缩放下仍放不下：取景必须缩小。取景据此按“全部节点在画面内”缩（以 FIT_ALL_MIN_ZOOM 为下限），
   * 而不是在可读下限 FIT_FLOOR 处停住、让用户上下滚动。放得下（或不是规划式排布）就没有这一项。
   */
  fitAll?: boolean;
}

export interface OriginGroup {
  /**
   * 来源摘要：取这个来源名下最近一个带工作目录的会话的（都没有就取第一个）。
   * 工作目录只有宿主报告的、或那次委派显式传入的 cwd 两种出处，没传 cwd 的委派没有——所以来源的工作目录是“它最近一次知道的”，
   * 而不是某一次委派的快照；一次都没有就是未知。
   */
  origin: OriginSummary;
  count: number;
  running: number;
  /** 这个发起端第一次委派的时间（它所有委派会话里最早的创建时间）。 */
  startedAt: string;
  /** 宿主给这段对话起的标题：取这个发起端最近一次委派时读到的（对话中途改名，以后一次为准）；一次都没读到就没有。 */
  hostTitle?: string;
  /** 它的工作目录已经画成了左边的 Folder 节点（Folder 的 key）：来源卡正文不再重复目录行。没有画（没有工作目录、紧凑模式）就没有，卡片保留目录行。 */
  folder?: string;
  /** 它的 Git 节点所属的工作树（经由 Folder 节点或直接相连）；没有画 Git 节点（读不到 Git、紧凑模式）就没有。 */
  worktree?: string;
}

export interface LayoutOptions {
  /** 可用于取景的像素区域（已扣除四周留白）。给出后，会按它选择并排的列数与间距；不给则单列。 */
  area?: Area;
  /**
   * 来源（来源的 key）→ 它的工作目录所在的 Git 工作树（工作树的 key，由 lib/git 的 groupGit 按真实根目录给出，这里当作不透明的字符串）。
   * 指向同一个工作树的来源共用左边的一张 Git 节点；工作树不同就是不同的节点。Git 节点连到包含它的 Folder 节点，
   * 来源的目录没有画成 Folder（读不到工作目录）时才直接连到来源。
   * 这张表是已经解析好的关系：同一个目录（同一张 Folder 卡）的来源要么都在表里、指向同一个工作树，要么都不在（读不到、读数矛盾）；
   * 对不上的卡布局不画 Git 归属，不会替它挑一个。
   * 不在这张表里的来源左边没有 Git 节点。紧凑的取景区域（宿主的浏览器侧栏）放不下多出来的一列，那里不画 Git 节点。
   *
   * Folder 节点不需要表：它只取决于来源自己带着的工作目录（`OriginSummary.workspace`），由布局直接从会话里得出。
   */
  git?: ReadonlyMap<string, string>;
  /**
   * 只排这些会话（视图过滤，见 lib/workFilter）；不给就全排。给出时调用方保证它对祖先封闭（留下的会话，它的父会话、汇聚时它的所有上级也在里面），
   * 否则子会话会被当成根、看起来直接挂在来源上（汇聚的会话只缺一部分上级时，缺的那几条连线不画）。传入的 `sessions` 仍是全部会话：来源卡上的会话数、运行数、起始时间与宿主标题
   * 按全部会话算，被收起的会话不会让卡片上的数字变小；没有任何会话留下的来源没有卡片，它的 Folder、Git 卡也随之不排。
   */
  visible?: ReadonlySet<SessionId>;
  /**
   * 被用户隐藏了“相关节点”的来源（来源的 key，见 lib/originCollapse）。调用方把它名下的会话从 `visible` 里拿掉；
   * 布局保证这样的来源仍有一张来源卡（只有卡片本身，没有会话），否则用户没处把它再打开。
   * 它在这一刻没有任何会话画出来、也就是隐藏已经完成时，它自己成一组：不再和别的来源共用 Folder / Git 卡，也不带着它们
   * （Folder、Git 是“它的相关节点”，隐藏就是一起收起；别的来源还在用的卡片照旧留着，只是不再连到它）。
   * 它还有会话画着（正在淡出）时按普通来源排，等淡出结束再收成一张卡，两件事不叠在一起。
   * 不在 `sessions` 里的 key（来源已经没有会话了）忽略。
   */
  collapsed?: ReadonlySet<string>;
  /**
   * 隐藏画布左侧的 Folder 与 Git 上下文卡片（单 Main Agent 独立画布和「全部活跃」视图使用）：
   * 这些信息已经升格到画布左上角的编辑部空间标头，画布本身回归纯粹的委派拓扑。
   */
  hideContextNodes?: boolean;
  /**
   * 规划式排布（Overview 的空间视图使用；要同时给出 `area` 才生效）：目标是让全部节点（会话、来源卡、全部空间里的 Folder / Git 卡）
   * 在取景区域里整齐地一屏放下，而不是一律排成自上而下的竖串。
   * - 先按经典排法（来源按取景区域的形状在 1~4 列里并排）看能不能在缩放上限 `zoom` 下整个放进取景区域；放得下、且外框不是一条细长的竖串
   *   就保持经典形态，会话少时仍是左到右的树，不为排而排；
   * - 放不下、或放得下却是细长的竖串时，全部来源改排成同一张格子里的规则网格（见 layout-plan）：来源卡在上或在左，会话按创建先后一行行装进去，
   *   父会话与它的子会话成块，来源块再按取景区域的宽高比分成几列竖排；在所有可能里取“能放下的缩放最大”的一种，所以外框贴着取景区域的形状；
   *   这时 `grid` 为真；
   * - 排完内容在 100% 缩放下仍放不下，`fitAll` 为真，取景据此缩小到全部节点入画。
   * 同一套规划既用于默认排布，也用于“重置节点布局”之后（引擎只多给一个 `zoom`），所以两者不会各排各的。
   * 不给 `grid`（或没有 `area`）是原来的经典排法，行为不变。
   */
  grid?: boolean;
  /**
   * 规划式排布用的缩放上限，也就是取景的放大倍数（默认 1，限制在 FIT_ALL_MIN_ZOOM 与 1.6 之间）：排布要让全部节点在这个缩放下放进取景区域，
   * 放不下才退到“能放下的最大缩放”。用户点“重置节点布局”时，引擎把当时的缩放记下来由这里使用（见 SceneEngine.resetLayout）。只在 `grid` 为真时有效。
   */
  zoom?: number;
}

export const originNodeId = (key: string): string => `origin:${key}`;
/** Git 节点以工作树为单位：id 只取决于工作树，不随指向它的来源的先后、增减而变。 */
export const gitNodeId = (worktree: string): string => `git:${worktree}`;
/** Folder 节点以目录为单位：id 只取决于规范化后的目录（见 lib/folder 的 directoryKey），不随来源的先后、增减而变。 */
export const folderNodeId = (key: string): string => `folder:${key}`;
export const agentNodeId = (id: SessionId): string => `agent:${id}`;

/** 盒子之外没有伸出部分的节点（`LayoutNode.overhang`）共用这一个对象。 */
export const NO_OVERHANG = { left: 0, right: 0 } as const;

/** 一个发起端排好的一组：来源节点、它的会话，以自己的左上角为原点。 */
export interface Built {
  summary: OriginGroup;
  origin: LayoutNode;
  nodes: LayoutNode[];
  width: number;
  height: number;
}

/** 摆放时节点与连线的去处：`assemble` 每次从头摆一套，各用各的一份。 */
export interface Sink {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
}

/** 一套摆好的节点：每个来源一块（`items`）、整体的划分（`clusters`），以及要交给 SceneLayout 的节点、连线与 Folder 卡。 */
export interface Assembly {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  folders: LayoutFolder[];
  items: Built[];
  clusters: Cluster[];
}
