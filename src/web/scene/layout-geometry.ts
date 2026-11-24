/**
 * 画布布局的尺寸、外框与取景：只有常量与纯函数，不读会话数据，也不依赖排布的其余部分。
 * layout-cells、layout-block、layout-pack、layout-plan、layout-strips、layout 都读它，它不读它们——所以几何量放在这里不会和排布互相引用成环。
 * 对外的出口仍是 layout.ts：它把这里的名字原样重新导出，使用方不必改导入。
 */

/**
 * 画布节点的尺寸（世界坐标，CSS 像素）。
 * 与 styles/scene.css 中的节点尺寸保持一致。
 */
export const NODE = {
  agentW: 248,
  /** 与来源卡、Git 卡、Folder 卡同高：同一行里四种卡片上下边缘对齐，管线接口落在同一条中线上。 */
  agentH: 112,
  originW: 212,
  originH: 112,
  /** Git 节点与来源节点同宽同高：两张卡上下对齐时共用同一条列轴与同一套版式。 */
  gitW: 212,
  gitH: 112,
  /** Folder 节点同样与来源节点同宽同高：Git、Folder、来源三列的卡片摆在一起时共用同一套版式。 */
  folderW: 212,
  folderH: 112,
  agentWCompact: 208,
  /**
   * 紧凑模式的来源卡宽度。再宽就会拉低 320px 侧栏里的取景比例（守卫测试要求 ≥ 0.72），所以不靠加宽来装日期：
   * 紧凑模式下卡片改用更短的数字日期、并收窄内边距（见 scene.css 与 OriginNode）。
   */
  originWCompact: 150,
  /** 同一列里相邻两个会话的竖直间距。 */
  rowGap: 24,
  /** 同一列中相邻会话的水平错位。 */
  stagger: 24,
  /** 发起端与第一列会话的水平间距。 */
  originGap: 92,
  /** 父子会话两列之间的水平间距。 */
  childGap: 92,
  /** 窄画布（例如宿主的浏览器侧栏）上收紧后的间距，同时取消错位。 */
  originGapCompact: 28,
  childGapCompact: 48,
  groupGap: 56,
  /** 多个发起端并排摆放时，相邻两列之间的空白。 */
  clusterGap: 88,
} as const;

/** 低于这个宽度的取景区域使用收紧的水平间距。 */
const COMPACT_BELOW = 720;
/** 取景区域是否按紧凑模式排布（布局、样式与卡片内的写法共用这一个判定）。 */
export function isCompact(area: Area | undefined): boolean {
  return area !== undefined && area.w < COMPACT_BELOW;
}

export const MIN_ZOOM = 0.3;
/**
 * 多列规则网格或显式完整取景时允许缩小的下限，确保几十上百个节点也能均匀规则地一屏装下。
 * 退路：缩到这个下限仍放不下（成百上千个节点）时不再往下缩——再小，卡片上的字就完全看不见了。
 * 这时排布仍是能排出的最紧凑的那一种（`fitAll` 为真），取景停在下限，放不下的部分留在画面外，由用户平移去看；
 * 这是缩放下限对“全部节点入画”的唯一让步，不会为了硬塞而让节点重叠或被截断。
 */
export const FIT_ALL_MIN_ZOOM = 0.16;
/**
 * 自动取景时，仅仅因为内容太高而缩小的下限：再往下缩，文字就读不清了，
 * 不如保持可读的比例，让用户上下滚动。宽度不够则不受此限（左右不宜出现看不全的内容）。
 */
export const FIT_FLOOR = 0.72;

/**
 * 保持缩放取景（`holdScale`）时容许内容比取景区域大这么一点（1.5%）：Overview 把取景区域量化到 16px，
 * 差出来的那几个像素落在四周的留白里，不该因此把“保持的缩放”少掉一个百分点。
 */
const HOLD_SLACK = 0.985;

export interface Area {
  w: number;
  h: number;
}

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** 自动取景时四周留出的空白；顶部给空间标头与视图控制让位，底部只需给极小比例尺与对齐条留白。 */
export function fitPadding(viewportWidth: number): Padding {
  return viewportWidth < 640 ? { top: 96, right: 20, bottom: 56, left: 20 } : { top: 126, right: 56, bottom: 64, left: 56 };
}

/** 视口扣除四周留白后，真正用来放内容的区域。 */
export function fitArea(viewportW: number, viewportH: number): Area {
  const pad = fitPadding(viewportW);
  return { w: Math.max(120, viewportW - pad.left - pad.right), h: Math.max(120, viewportH - pad.top - pad.bottom) };
}

/** 把 size 放进 area 的自动取景比例（不放大，不超过 1）。`fitAll` 为真时允许突破 FIT_FLOOR 以把所有节点完整装进视口。 */
export function fitScale(size: Area, area: Area, min: number = MIN_ZOOM, fitAll = false): number {
  if (size.w <= 0 || size.h <= 0) return 1;
  const byWidth = area.w / size.w;
  const byHeight = area.h / size.h;
  if (fitAll) return Math.min(1, Math.max(Math.min(min, FIT_ALL_MIN_ZOOM), Math.min(byWidth, byHeight)));
  return Math.min(1, Math.max(min, Math.min(byWidth, Math.max(byHeight, FIT_FLOOR))));
}

/**
 * 保持缩放 `hold` 的取景比例：内容放得下就是 `hold` 本身（不放大，也不缩小）；放不下才缩到刚好放下的最大比例。
 * 不受 FIT_FLOOR 约束——“全部节点在画面内”优先于可读——最低到 FIT_ALL_MIN_ZOOM；再放不下就停在这个下限（内容会超出画面，由用户平移）。
 * 内容只比区域大不到 1.5% 时仍按 `hold`（见 HOLD_SLACK）。
 */
export function holdScale(size: Area, area: Area, hold: number): number {
  const wanted = Math.max(FIT_ALL_MIN_ZOOM, hold);
  if (size.w <= 0 || size.h <= 0) return wanted;
  const fits = Math.min(area.w / size.w, area.h / size.h);
  return fits >= wanted * HOLD_SLACK ? wanted : Math.max(FIT_ALL_MIN_ZOOM, fits);
}

/**
 * 自动取景的相机：把 bounds 放进扣掉留白的视口里（缩放见 fitScale）；放得下就居中，放不下就对齐左上留白。视口或内容没有尺寸时回到原点。
 * 给了 `hold` 就改按保持缩放取景（见 holdScale），`fitAll` 不再起作用：引擎在用户点“重置节点布局”之后用它，把用户当时的缩放留住。
 */
export function fitCamera(bounds: Bounds, viewport: Area, pad: Padding, fitAll = false, hold?: number): { x: number; y: number; k: number } {
  if (bounds.w <= 0 || bounds.h <= 0 || viewport.w <= 0 || viewport.h <= 0) return { x: 0, y: 0, k: 1 };
  const availW = Math.max(120, viewport.w - pad.left - pad.right);
  const availH = Math.max(120, viewport.h - pad.top - pad.bottom);
  const room = { w: availW, h: availH };
  const k = hold !== undefined ? holdScale(bounds, room, hold) : fitScale(bounds, room, MIN_ZOOM, fitAll);
  // 保持缩放时容许的那点溢出（HOLD_SLACK）也算放得下：居中摆，溢出的部分左右（上下）均分，落在四周的留白里。
  const slack = hold !== undefined ? 1 / HOLD_SLACK : 1;
  const contentW = bounds.w * k;
  const contentH = bounds.h * k;
  const x = contentW <= availW * slack ? pad.left + (availW - contentW) / 2 - bounds.x * k : pad.left - bounds.x * k;
  const y = contentH <= availH * slack ? pad.top + (availH - contentH) / 2 - bounds.y * k : pad.top - bounds.y * k;
  return { x, y, k };
}

export interface LayoutNode {
  id: string;
  kind: "origin" | "agent" | "git" | "folder";
  x: number;
  y: number;
  w: number;
  h: number;
  /** 节点盒子之外伸出的部分，取景时要算进去。 */
  overhang: { left: number; right: number };
  /**
   * 这个节点是挂在另一个节点旁边的。它第一次出现时，如果锚点已经被用户挪到别处，
   * 就按锚点保存的位置加上这个偏移来放，而不是落回布局原位——那里多半已经是别的东西了。
   * - Folder 节点之于来源节点、Git 节点之于它连着的第一个节点（几个来源共用一张卡时取排在最前的那个）：
   *   偏移就是布局里两者的实际相对位置。
   * - 会话节点：同一父节点下紧邻它的上一个兄弟（根会话是同一来源的上一个根）；它是第一个时是它的父会话（根会话是来源卡）。
   *   对第一个子会话 / 第一个根会话，偏移是布局里的实际相对位置；对有上一个兄弟的，水平照布局里的错位，
   *   竖直只隔一个行距（紧挨着下方）——布局里让开兄弟子树的那一段不照搬：兄弟被拖走时，它的子树不一定跟着走。
   *   参照只取布局里实际存在的节点（被过滤掉的会话不参与排布，也就不会成为参照）。
   * 锚点节点总是排在 `SceneLayout.nodes` 里这个节点的前面：锚点自己也是这样挂着的（Git → Folder → 来源，
   * 或者同一父下的兄弟一个接一个）时，引擎逐个处理，锚点先得到位置，挂在它旁边的节点才能接着放。
   */
  anchor?: { id: string; dx: number; dy: number };
}

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 计算取景需要包含的节点外框。 */
export function boundsOf(nodes: readonly LayoutNode[]): Bounds {
  if (nodes.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x - node.overhang.left);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.w + node.overhang.right);
    maxY = Math.max(maxY, node.y + node.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
