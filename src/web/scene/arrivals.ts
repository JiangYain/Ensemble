import { fitPadding, type LayoutNode } from "./layout";
import { revealPan, standing, type Edge, type Size } from "./offscreen";
import type { Rect } from "./placement";

/**
 * 新到的会话落在视口之外时，在对应的边给一个提示（组件见 components/EdgeHints.tsx）。
 *
 * 相机是用户自己摆的，新会话不能把它抢走；但新节点出现在看不见的地方、用户毫无察觉也不行。
 * 这里只记“用户看着画布时新到的、还没被看见过的会话节点”，引擎只交出相机、视口与节点的落定位置，并替它平移相机。
 * “新到”的定义不在这里：引擎在布局变化时用 placement.ts 的 freshIds（摆放新节点用的同一份判断）算出 `fresh` 交进来。
 */

export interface ArrivalPort {
  /** 相机落定后的位置（弹簧还在走的时候也以终点为准：提示不跟着动画闪）。 */
  camera: Readonly<{ x: number; y: number; k: number }>;
  size(): Size;
  /** 节点落定后的世界矩形；引擎里没有这个节点（或还没放下）时为 undefined。 */
  box(id: string): Rect | undefined;
  /** 把相机平移 (dx, dy) 屏幕像素，不改缩放。 */
  panBy(dx: number, dy: number): void;
}

export interface EdgeHint {
  edge: Edge;
  /** 这条边之外还没被看见的新会话节点，离视口近的在前。 */
  ids: readonly string[];
}

/**
 * 相机变化时重算的最短间隔：拖动与动画里每一帧都会通知相机变了，没必要每帧都算；
 * 一次拖动中节点在视口里至少停留一帧以上，这个间隔比常见的快速甩动（约 3000px/s 扫过一张 248px 的卡）短。
 */
export const THROTTLE_MS = 64;

/** 提示在 DOM 里的顺序（也是 Tab 顺序）：顺时针，从上开始。 */
const EDGES: readonly Edge[] = ["top", "right", "bottom", "left"];

export class ArrivalWatch {
  private readonly port: ArrivalPort;
  /** 新到、还没被看见过的会话节点（按到达的先后）。看见过就永远移出：之后再拖走，也不再算“新到的”。 */
  private readonly pending = new Set<string>();
  /** 已经见过一份“现状”布局：第一份布局里的节点都是现状，不是新到的（首次载入、刷新、聚焦页回到概览）。 */
  private armed = false;
  private hints: readonly EdgeHint[] = [];
  private signature = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;
  private readonly listeners = new Set<() => void>();

  constructor(port: ArrivalPort) {
    this.port = port;
  }

  /** 给 useSyncExternalStore 用：提示没变时返回同一个数组。 */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getHints = (): readonly EdgeHint[] => this.hints;

  /**
   * 布局变了（引擎在 setLayout 的最后调用，相机已经取景完）。`fresh`：这次布局里新到的节点 id（包括非会话节点，这里只认会话）。
   * `replay`：容器重新挂载时引擎用旧布局重放的那一次，不是用户看着画布时发生的事，整个忽略（也不算“见过现状”）。
   */
  layoutChanged(nodes: readonly Pick<LayoutNode, "id" | "kind">[], fresh: ReadonlySet<string>, replay: boolean): void {
    if (replay) return;
    const agents = new Set<string>();
    for (const node of nodes) if (node.kind === "agent") agents.add(node.id);
    // 被删除、或被“隐藏未在工作的会话”收起的节点不提示。
    for (const id of [...this.pending]) if (!agents.has(id)) this.pending.delete(id);
    if (this.armed) for (const id of fresh) if (agents.has(id)) this.pending.add(id);
    this.armed = true;
    this.evaluate();
  }

  /** 相机（或节点位置）变了。引擎每一帧都会调用：没有待提示的节点时是空操作，否则最多每 THROTTLE_MS 算一次，最后一次变化一定会被算到。 */
  touch(): void {
    if (this.pending.size === 0) return;
    if (this.timer !== undefined) {
      this.dirty = true;
      return;
    }
    this.evaluate();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.dirty) return;
      this.dirty = false;
      this.touch();
    }, THROTTLE_MS);
  }

  /**
   * 点了某条边的提示：平移相机，把这条边上离视口最近的那个节点带进视口（四周留出取景用的留白），不改缩放。
   * 返回去的是哪个节点，没有这条边的提示时返回 undefined 且什么都不做。去过的节点算“看见了”，提示随之消失；
   * 其余还在视口外的留在提示里，再点一次去下一个。
   */
  go(edge: Edge): string | undefined {
    const id = this.hints.find((hint) => hint.edge === edge)?.ids[0];
    const box = id === undefined ? undefined : this.port.box(id);
    const size = this.port.size();
    if (id === undefined || !box || !(size.w > 0 && size.h > 0)) return undefined;
    const { dx, dy } = revealPan(box, this.port.camera, size, fitPadding(size.w));
    if (dx !== 0 || dy !== 0) this.port.panBy(dx, dy);
    this.pending.delete(id);
    this.evaluate(); // 同一次平移顺带带进视口的节点也算看见
    return id;
  }

  /** 画布卸载：什么都不留，下一份布局重新当作现状（聚焦页回到概览时不把期间新建的会话当作新到的）。 */
  reset(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.dirty = false;
    this.pending.clear();
    this.armed = false;
    this.publish([]);
  }

  private evaluate(): void {
    const size = this.port.size();
    // 视口还量不出来（侧栏刚展开、页面在后台）：不下结论，节点留着，也不把谁当作“看见过”。
    if (!(size.w > 0 && size.h > 0)) return;
    const found = new Map<Edge, { id: string; distance: number }[]>();
    for (const id of [...this.pending]) {
      const box = this.port.box(id);
      const at = box ? standing(box, this.port.camera, size) : undefined;
      if (!at || at.state === "visible") {
        this.pending.delete(id);
        continue;
      }
      if (at.state === "unknown") continue;
      const list = found.get(at.edge) ?? [];
      list.push({ id, distance: at.distance });
      found.set(at.edge, list);
    }
    this.publish(EDGES.flatMap((edge) => {
      const list = found.get(edge);
      return list ? [{ edge, ids: list.sort((a, b) => a.distance - b.distance).map((item) => item.id) }] : [];
    }));
  }

  private publish(next: readonly EdgeHint[]): void {
    const signature = next.map((hint) => `${hint.edge}:${hint.ids.join(",")}`).join("|");
    if (signature === this.signature) return;
    this.signature = signature;
    this.hints = next;
    for (const listener of [...this.listeners]) listener();
  }
}
