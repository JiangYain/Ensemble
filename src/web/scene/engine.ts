import { alignBoxes, distributeBoxes, type AlignMode, type DistributeAxis } from "./arrange";
import { HeldLayout } from "./arrival-memory";
import { ArrivalWatch } from "./arrivals";
import { ConnectionLayer } from "./connections";
import { bodyFor, pruneBodies, resetBodies, selectedBodies, selectedBoxes, targetBounds, writeNode, type Body } from "./engine-body";
import { CameraRig } from "./engine-camera";
import { NodeContexts } from "./engine-context";
import { FrameLoop, MotionPreference } from "./engine-frame";
import { CanvasInput } from "./engine-input";
import { placeNodes } from "./engine-layout";
import { Placements } from "./engine-placements";
import { Signal, StateCell } from "./engine-signal";
import type { Camera, EngineState, MountOptions, NodeContextHandler } from "./engine-types";
import type { Area, SceneLayout } from "./layout";
import { arrivalsFor, freshIds } from "./placement";
import { SceneSelection } from "./selection";

export type { Camera, EngineState, MountOptions, NodeContextHandler, NodeContextRequest } from "./engine-types";

/**
 * 画布引擎：用弹簧让节点平滑地走向布局目标位置，管线跟着节点实时重算；
 * 相机支持拖拽平移、滚轮/触控板平移、捏合或 Ctrl+滚轮缩放，以及自动取景。
 * 全部通过直接修改 style/attribute 完成，不触发 React 重渲染。
 *
 * 生命周期：节点元素先于画布容器挂载（React 子组件的 ref 先执行），
 * 所以 register 可以在 mount 之前调用，mount 之后才开始响应交互与取景。
 *
 * 这个类只把各部分（相机、输入、帧循环、手动位置与历史、右键、一份布局如何落位，各在 engine-*.ts 里）接在一起，并定下它们之间的先后顺序；
 * 各部分互相不认识，只通过自己声明的小接口向这里要东西。互相引用的几个字段写明类型，免得类型要由初始值推出来而绕圈（TS7022）。
 */
export class SceneEngine {
  private readonly bodies = new Map<string, Body>();
  private readonly selection = new SceneSelection(() => this.bodies.values());
  /** 连线与端口方点归它：引擎只在布局变化与每一帧交给它节点的位置。 */
  private readonly connections = new ConnectionLayer();
  private readonly rig: CameraRig = new CameraRig({
    mounted: () => this.mounted,
    wide: () => this.layout?.grid === true || this.layout?.fitAll === true,
    framed: () => this.hasLayout,
    reducedMotion: () => this.motion.reduced,
    wake: () => this.frames.wake(),
    applied: () => this.arrivals.touch(),
  });
  private readonly placements: Placements = new Placements(this.bodies, {
    dragging: () => this.input.dragging,
    homeOf: (id) => {
      const home = this.layout?.nodes.find((node) => node.id === id);
      return home ? { x: home.x, y: home.y } : undefined;
    },
    placed: () => this.placed(),
    settled: () => this.settled(),
    historyChanged: () => this.status.patch({ canUndo: this.placements.canUndo, canRedo: this.placements.canRedo }),
  });
  /** 画布上出现过、或被视图过滤收起过的节点：它们再出现不是“新到的”，不按新节点重新放置（见 placement.ts）。 */
  private readonly known = new Set<string>();
  /** 新到的会话落在视口之外时的提示（见 arrivals.ts）：引擎只交出相机、视口与节点的落定位置，并替它平移相机。 */
  readonly arrivals = new ArrivalWatch({
    camera: this.rig.target,
    size: () => ({ w: this.mounted?.viewport.clientWidth ?? 0, h: this.mounted?.viewport.clientHeight ?? 0 }),
    box: (id) => { const body = this.bodies.get(id); return body?.placed ? { x: body.tx, y: body.ty, w: body.w, h: body.h } : undefined; },
    panBy: (dx, dy) => this.rig.panBy(dx, dy),
  });
  private hasLayout = false;
  private readonly motion = new MotionPreference();
  private mounted: MountOptions | undefined;
  private layout: SceneLayout | undefined;
  private readonly status = new StateCell();
  private readonly selectionSignal = new Signal();
  private readonly contexts = new NodeContexts({
    bodies: this.bodies,
    selection: this.selection,
    dragging: () => this.input.dragging,
  });
  private readonly input: CanvasInput = new CanvasInput({
    bodies: this.bodies,
    selection: this.selection,
    camera: this.rig,
    placements: this.placements,
    contexts: this.contexts,
    viewport: () => this.mounted?.viewport,
  });
  private readonly frames: FrameLoop = new FrameLoop({
    bodies: this.bodies,
    mounted: () => this.mounted !== undefined,
    reducedMotion: () => this.motion.reduced,
    holding: () => this.input.holding,
    stepCamera: (steps, h) => this.rig.step(steps, h),
    pipes: (now) => this.pipes(now),
  });
  /**
   * 各空间“重置节点布局”时记下的排布缩放：布局以它为缩放上限来规划（layoutScene 的 `zoom`，Overview 订阅它并重算布局），
   * 重置之后新会话到达、“仅工作中”或来源折叠、窗口尺寸变化引起的重新布局都沿用它，既不跳回按 100% 排的旧形态，也不改变保持住的缩放。
   * 只放内存、按空间分开：它是“这一次我想在这个缩放下把全部节点看全”的临时意图，不是节点位置那样的用户作品——
   * 换了窗口大小或重新打开页面就不再成立，所以不写 localStorage（刷新后回到按 100% 排的默认排布）；各空间的相机本来就各自记忆，它跟着走。
   * 失效：同一空间下一次重置会覆盖它；“适应”（`fit`）只动相机、不动它——点“适应”不该让节点重新排一遍。
   */
  private readonly fills = new Map<string, number>();
  private readonly fillSignal = new Signal();
  /** 已有的卡原地不动、新卡落进空位：Overview 每次给的都是整份新规划，坐标用谁的由它定（见 arrival-memory.ts）；重置、换空间、排布缩放变了就忘掉。 */
  private readonly held = new HeldLayout();

  // ───────────────────────── 生命周期 ─────────────────────────

  mount(options: MountOptions): void {
    this.unmount();
    this.mounted = options;
    this.connections.mount(options.pipes);
    this.motion.attach();

    const { viewport } = options;
    this.selection.mount(viewport, (count) => {
      this.status.patch({ selected: count });
      this.selectionSignal.notify();
      options.onSelection?.(count);
    });
    this.input.attach(viewport);
    this.rig.watch(viewport);
    this.rig.apply();
    // 新宿主一挂上来就先听到引擎手里的相机，包括相机没变的、用户动过的（后者重新挂载时既不取景也未必换空间，之后没有上报）；与下面的 onPositions 同理。
    // 相机在起点（100%、自动取景）的不重发：detach() 已把缓存放回新宿主的起点。
    this.rig.report();
    // 容器挂载时布局可能早就算好了（重放：不是用户看着画布时发生的，不产生“新到”的提示）。
    if (this.layout) this.setLayout(this.layout, true);
    options.onPositions?.(this.placements.count > 0);
  }

  unmount(): void {
    this.input.cancel();
    this.frames.cancel();
    this.motion.detach();
    this.input.detach(this.mounted?.viewport);
    this.rig.detach();
    this.connections.unmount();
    this.selection.unmount();
    this.arrivals.reset();
    this.status.patch({ selected: 0 });
    this.contexts.reset();
    this.selectionSignal.notify();
    this.mounted = undefined;
    this.hasLayout = false;
    this.input.reset();
  }

  // ───────────────────────── 节点与布局 ─────────────────────────

  register(id: string, el: HTMLElement): () => void {
    const body = bodyFor(this.bodies, id);
    const release = this.connections.register(id, el);
    body.el = el;
    this.selection.sync(id, el);
    if (body.placed) writeNode(body);
    return () => {
      release();
      const current = this.bodies.get(id);
      if (current && current.el === el) current.el = null;
    };
  }

  /**
   * 切换画布所属的工作空间（例如从一个 Main Agent 切到另一个）。
   * 各自独立记忆相机视角；切过去后清空选区、撤销栈与旧空间的视口外到达提示，保留仍挂在 DOM 里的节点引用。
   */
  switchSpace(nextKey: string): void {
    if (nextKey === this.placements.space) return;
    this.input.cancel();
    if (this.hasLayout) this.rig.remember(this.placements.space);
    this.placements.open(nextKey);
    this.selection.clear();
    // 重置之后新空间的第一份布局就是“现状”（不提示、并开始计新到）；它不是重放，不能当重放跳过——那会把新空间里到的第一个会话也当成现状吞掉。
    this.arrivals.reset();
    this.known.clear();
    this.held.reset();
    this.placements.forget();
    this.status.patch({ canUndo: false, canRedo: false });
    resetBodies(this.bodies);
    this.rig.recall(nextKey);
    this.hasLayout = false;
    this.rig.apply();
    this.rig.report();
    this.mounted?.onPositions?.(this.placements.count > 0);
  }

  setLayout(layout: SceneLayout, replay = false, area?: Area): void {
    const isKnown = (id: string): boolean => this.known.has(id) || this.bodies.get(id)?.placed === true;
    layout = this.held.apply(layout, isKnown, area);
    this.layout = layout;
    if (!this.mounted) return;
    this.mounted.onArrangement?.(this.held.drifted);
    const first = !this.hasLayout;
    const fresh = freshIds(layout.nodes, isKnown);
    const arrivals = arrivalsFor(layout.nodes, this.placements.positions, isKnown);
    for (const id of [...layout.nodes.map((n) => n.id), ...(layout.hidden ?? [])]) this.known.add(id);

    const { keep, anchored } = placeNodes(layout, { bodies: this.bodies, positions: this.placements.positions, arrivals, first, reducedMotion: this.motion.reduced });
    if (anchored) this.placements.save();
    pruneBodies(this.bodies, keep);
    this.selection.retain(keep);

    this.connections.sync(layout.edges);
    this.updateBounds();
    this.hasLayout = true;
    this.rig.follow(first);
    this.pipes(performance.now());
    this.frames.wake();
    this.arrivals.layoutChanged(layout.nodes, fresh, replay);
  }

  private updateBounds(): void {
    this.rig.setBounds(targetBounds(this.layout?.nodes ?? [], this.bodies));
  }

  /** 连线跟着节点此刻的位置重算。返回是否还有连线停在换边的过渡里（要继续排下一帧）。 */
  private pipes(now: number): boolean {
    return this.connections.frame(this.bodies, now, this.motion.reduced);
  }

  /** 用户把节点放到了新位置（拖动中的每一步、方向键微调）之后：相机归用户，外框与连线跟着重算。 */
  private placed(): void {
    this.rig.claim();
    this.updateBounds();
    if (this.pipes(performance.now())) this.frames.wake();
    this.rig.report();
    this.mounted?.onPositions?.(true);
  }

  /** 位置改好之后的收尾：弹簧自己把节点送过去，管线随帧重算；相机不动，不触发自动取景。 */
  private settled(): void {
    this.rig.claim();
    this.updateBounds();
    this.placements.save();
    this.mounted?.onPositions?.(this.placements.count > 0);
    this.rig.report();
    this.frames.wake();
  }

  /** Keyboard alternative to dragging a focused node. */
  moveNode(id: string, dx: number, dy: number): void {
    const body = this.bodies.get(id);
    if (!body?.placed) return;
    if (!this.selection.has(id)) this.selection.only(id);
    this.placements.nudge(selectedBodies(this.bodies, this.selection, body), dx, dy);
  }

  toggleSelection(id: string): void {
    if (this.bodies.get(id)?.placed) this.selection.toggle(id);
  }

  clearSelection(): void {
    this.selection.clear();
  }

  selectAll(): void {
    this.selection.replace([...this.bodies.values()].filter((body) => body.placed && body.el).map((body) => body.id));
  }

  // ───────────────────────── 订阅 ─────────────────────────

  /** 给 useSyncExternalStore 用：状态没变时返回同一个对象。 */
  readonly subscribe = this.status.subscribe;

  readonly getState = (): EngineState => this.status.get();

  /**
   * 选中的节点 id（按选中的先后）。`getState().selected` 只有数量，要知道“选了谁”看这里；
   * 选中集合不变时返回同一个数组，可以直接交给 useSyncExternalStore。
   */
  readonly getSelectedIds = (): readonly string[] => this.selection.list();

  /** 选中集合的成员变了（哪怕数量没变）就通知。与 `subscribe` 分开：对齐条只关心数量与历史，不必为成员变化重绘。 */
  readonly subscribeSelection = this.selectionSignal.subscribe;

  /** 某个空间“重置节点布局”记下的排布缩放（见 `fills`）；没重置过就是 undefined。给 useSyncExternalStore 用：数值没变时返回同一个值。 */
  readonly getFill = (space: string): number | undefined => this.fills.get(space);

  /** 排布缩放变了就通知：Overview 据此带着新的缩放上限重算布局。与 `subscribe` 分开：对齐条不关心它，不必为它重绘。 */
  readonly subscribeFill = this.fillSignal.subscribe;

  /** 记下一个空间的排布缩放；数值没变就不通知（重置两次、缩放相同，不该白白重排一遍）。 */
  private setFill(space: string, zoom: number): void {
    if (this.fills.get(space) === zoom) return;
    this.fills.set(space, zoom);
    this.held.reset();
    this.fillSignal.notify();
  }

  /**
   * 注册右键处理：画布上任何节点被右键、或带着焦点按下 ContextMenu 键 / Shift+F10 时，引擎先判断菜单的作用范围，
   * 再问处理者要不要接管。处理者返回 false（不为这个节点开菜单）时，浏览器的原生菜单照常出现，选中也原样不动。
   */
  onNodeContext(handler: NodeContextHandler): () => void {
    return this.contexts.add(handler);
  }

  // ───────────────────────── 对齐与分布 ─────────────────────────

  /** 以选中节点的整体外框为基准对齐；返回是否真的挪动了节点（已经对齐、或选中不足两个都返回 false）。 */
  align(mode: AlignMode): boolean {
    return this.placements.arrange(alignBoxes(selectedBoxes(this.bodies, this.selection), mode));
  }

  /** 等距分布：整体外框不变、空隙相等。至少选中三个节点才有效。 */
  distribute(axis: DistributeAxis): boolean {
    return this.placements.arrange(distributeBoxes(selectedBoxes(this.bodies, this.selection), axis));
  }

  // ───────────────────────── 撤销与重做 ─────────────────────────

  undo(): boolean {
    return this.placements.undo();
  }

  redo(): boolean {
    return this.placements.redo();
  }

  /**
   * 清除全部手动位置，让节点回到布局给的位置，并把相机收到“全部节点在画面内”。
   * 缩放是第一约束：先记下用户此刻看到的缩放 `keep`（相机的目标缩放，也就是缩放读数显示的那个），布局以它为上限重新规划
   * （`fills` → Overview → layoutScene 的 `zoom`），相机也按它取景（`autoCap`）：排得进画面就只平移、缩放原样不动；
   * 放不下才缩小，而且只缩到刚好放下（下限 FIT_ALL_MIN_ZOOM，见 layout-geometry.ts 的 holdScale；“全部节点入画”优先于可读）。
   *
   * 这里要定下的边界：
   * - 相机：重置之后是“自动取景”（`userMoved` 为假）而不是用户视角——排好的节点应当居中在画面里，之后新会话到达、窗口变化时也要跟着取景；
   *   用户一旦平移、缩放或拖动节点，相机就归用户（与平时一致）。自动取景带着缩放上限 `autoCap`，所以后续的重新布局不会改变保持住的缩放。
   * - 参数存放与失效：`autoCap` 与 `fills` 都只在内存里（失效规则见 `fills` 的说明）；“适应”（`fit`）释放 `autoCap`、回到按内容取景，但不动排布。
   * - 撤销与减少动效：只有节点位置进撤销栈（Ctrl+Z 找回手动位置），相机不在历史里、撤销后原地不动（见 settled）；落定方式没变（`CameraRig.settle`：偏好减少动效时直接落定，否则走弹簧）。
   */
  resetLayout(): void {
    const keep = this.rig.target.k;
    this.placements.clear();
    this.mounted?.onPositions?.(false);
    this.rig.release(keep);
    // 先用手头的规划整体重排并收好相机（排布缩放没变时 Overview 不会再给新规划）；缩放变了它随后按新缩放重算替换，两次取景同一个上限，不会来回跳。
    const plan = this.held.reset() ?? this.layout;
    if (plan) this.setLayout(plan);
    this.setFill(this.placements.space, keep);
  }

  // ───────────────────────── 相机 ─────────────────────────

  getCamera(): Readonly<Camera> {
    return this.rig.target;
  }

  isUserMoved(): boolean {
    return this.rig.userMoved;
  }

  fit(animate = true, fitAll = false): void {
    this.rig.fit(animate, fitAll);
  }

  zoomBy(factor: number): void {
    this.rig.zoomBy(factor);
  }
}
