/**
 * `engine*.test.ts` 共用的画布夹具，仅供测试使用（没有任何运行时代码引用它，不会被打进产物）：
 * 只有构造器和读取函数，不含断言，也不依赖 vitest。场景由传入的 `SceneLayout` 数据决定，没有开关参数；
 * 假定时器、matchMedia 之类的全局 mock 也不在这里装：它们属于用到它们的测试文件，在那里装、在那里拆。
 */

import { SceneEngine } from "./engine";
import { boundsOf, type LayoutEdge, type LayoutNode, type SceneLayout } from "./layout";

const SVG_NS = "http://www.w3.org/2000/svg";
const NONE = { left: 0, right: 0 };

/** 手动位置在 localStorage 里的键（持久化的格式，测试里写死，不引用 positions.ts）。 */
export const POSITIONS_KEY = "ensemble.canvas.positions.v1";

/** 默认的卡片：212×112（与 layout.ts 一致），除非 `extra` 另给。 */
export function node(id: string, x: number, y: number, extra: Partial<LayoutNode> = {}): LayoutNode {
  return { id, kind: "agent", x, y, w: 212, h: 112, overhang: NONE, ...extra };
}

export const origin = (id: string, x: number, y: number, extra: Partial<LayoutNode> = {}): LayoutNode => node(id, x, y, { kind: "origin", ...extra });

export const edge = (from: string, to: string, phase: LayoutEdge["phase"] = "running"): LayoutEdge => ({ id: `${from}>${to}`, from, to, phase });

/** 只有节点与连线的布局：外框取节点的包围盒，没有来源分组与 Folder 卡。 */
export const sceneOf = (nodes: LayoutNode[], edges: LayoutEdge[] = []): SceneLayout => ({ nodes, edges, bounds: boundsOf(nodes), origins: [], folders: [] });

export interface SceneRig {
  engine: SceneEngine;
  viewport: HTMLElement;
  world: HTMLElement;
  els: Map<string, HTMLElement>;
  /** `attach` 登记节点时 `engine.register` 给的注销函数，等于 React 里节点卸载时 ref 做的事。 */
  releases: Map<string, () => void>;
  tube: SVGGElement;
  dots: SVGGElement;
  /** 给后来加进来的节点放一个元素并登记（与 React 的 ref 一样先于布局）。 */
  attach: (id: string) => HTMLElement;
  /** 引擎卸载，视口从 body 上拿走；同一个测试里要再“访问”一次画布时用。 */
  dispose: () => void;
}

/** 按一份布局搭起视口、SVG 组与每个节点的元素，登记、挂载并把布局交给引擎。视口固定 1200 × 800。 */
export function mountScene(layout: SceneLayout): SceneRig {
  const viewport = document.createElement("div");
  const world = document.createElement("div");
  const svg = document.createElementNS(SVG_NS, "svg");
  const tube = document.createElementNS(SVG_NS, "g");
  const dots = document.createElementNS(SVG_NS, "g");
  svg.append(tube, dots);
  world.append(svg);
  viewport.append(world);
  document.body.append(viewport);
  Object.defineProperties(viewport, { clientWidth: { value: 1200, configurable: true }, clientHeight: { value: 800, configurable: true } });
  viewport.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: viewport.clientWidth, height: viewport.clientHeight });
  // 拖动时引擎向视口要指针捕获，happy-dom 没有对应实现：换成空操作。
  viewport.setPointerCapture = () => {};
  viewport.hasPointerCapture = () => true;
  viewport.releasePointerCapture = () => {};

  const engine = new SceneEngine();
  const els = new Map<string, HTMLElement>();
  const releases = new Map<string, () => void>();
  const attach = (id: string): HTMLElement => {
    const el = document.createElement("div");
    el.dataset["nodeId"] = id;
    world.append(el);
    els.set(id, el);
    releases.set(id, engine.register(id, el));
    return el;
  };
  for (const spec of layout.nodes) attach(spec.id);
  engine.mount({ viewport, world, pipes: { tube, dots } });
  engine.setLayout(layout);
  return {
    engine,
    viewport,
    world,
    els,
    releases,
    tube,
    dots,
    attach,
    dispose: () => {
      engine.unmount();
      viewport.remove();
    },
  };
}

/** 一个来源指向一个会话，运行中：最小的有连线的画布（外框 0..558 × 14..158）。 */
export const pairLayout: SceneLayout = sceneOf([origin("origin:one", 0, 30), node("agent:one", 310, 14, { w: 248, h: 144 })], [edge("origin:one", "agent:one")]);

/** 挂载 `pairLayout`，并把两个节点的元素取出来。 */
export function mountPair() {
  const rig = mountScene(pairLayout);
  return { ...rig, origin: rig.els.get("origin:one")!, agent: rig.els.get("agent:one")! };
}

export const selectBoth = (engine: SceneEngine): void => {
  engine.toggleSelection("origin:one");
  engine.toggleSelection("agent:one");
};

/** 在目标上触发一次指针事件（左键、指针 1），`options` 可覆盖修饰键、指针类型等。 */
export function pointer(target: Element, type: string, x: number, y: number, options: PointerEventInit = {}): void {
  target.dispatchEvent(new PointerEvent(type, { pointerId: 1, button: 0, clientX: x, clientY: y, bubbles: true, ...options }));
}

/** 节点元素此刻的位置（`translate` 里的像素值）。 */
export function at(el: HTMLElement): { x: number; y: number } {
  const [x, y] = el.style.translate.split(" ").map((part) => Number.parseFloat(part));
  return { x: x!, y: y! };
}

/** 持久化的手动位置。 */
export const stored = (): Record<string, { x: number; y: number }> => JSON.parse(localStorage.getItem(POSITIONS_KEY) ?? "{}");

/** 一条连线路径 `d` 里的全部数字（起点在前、终点在后）。 */
export const pathNumbers = (path: Element): number[] => (path.getAttribute("d") ?? "").match(/-?\d+(?:\.\d+)?/g)!.map(Number);
