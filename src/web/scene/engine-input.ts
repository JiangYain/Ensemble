import { selectedBodies, type Body } from "./engine-body";
import { clamp, type CameraRig } from "./engine-camera";
import type { NodeContexts } from "./engine-context";
import type { Placement } from "./engine-history";
import type { Placements } from "./engine-placements";
import type { SceneSelection } from "./selection";

interface DraggedBody { body: Body; x: number; y: number }

type PointerDrag =
  | { kind: "pan"; id: number; sx: number; sy: number; cx: number; cy: number; moved: boolean; suppressTap: boolean }
  | { kind: "node"; id: number; sx: number; sy: number; scale: number; primary: Body; bodies: DraggedBody[]; before: Map<string, Placement>; moved: boolean }
  | { kind: "select"; id: number; sx: number; sy: number; nodeId: string | undefined; moved: boolean };

/** 输入层向引擎问的几件事（它不认识引擎本身）。 */
export interface InputPorts {
  bodies: ReadonlyMap<string, Body>;
  selection: Pick<SceneSelection, "begin" | "update" | "finish" | "has" | "only" | "toggle" | "clear">;
  camera: Pick<CameraRig, "camera" | "grab" | "dragTo" | "scrollBy" | "zoomAround">;
  placements: Pick<Placements, "snapshot" | "place" | "commit">;
  contexts: Pick<NodeContexts, "onKey" | "onMenu" | "reset">;
  viewport(): HTMLElement | undefined;
}

/**
 * 画布上的输入：平移、框选、拖动节点、滚轮平移与缩放、修饰键与空格带来的当前工具，以及右键。
 * 窗口与视口上的监听全部由 `attach` / `detach` 成对挂上、摘下（顺序固定，摘的时候用的是同一批函数引用）。
 */
export class CanvasInput {
  private ctrlDown = false;
  private shiftDown = false;
  private spaceDown = false;
  private drag: PointerDrag | undefined;
  private suppressClick = false;

  constructor(private readonly ports: InputPorts) {}

  /** 正在拖动、框选或平移（包括还没越过起拖阈值的）。 */
  get dragging(): boolean {
    return this.drag !== undefined;
  }

  /** 已经越过起拖阈值，手里正拿着画布或节点。 */
  get holding(): boolean {
    return this.drag?.moved === true;
  }

  attach(viewport: HTMLElement): void {
    window.addEventListener("keydown", this.ports.contexts.onKey, true);
    window.addEventListener("keydown", this.onModifier);
    window.addEventListener("keyup", this.onModifier);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);
    viewport.addEventListener("pointerdown", this.onPointerDown);
    viewport.addEventListener("click", this.onClickCapture, true);
    viewport.addEventListener("dragstart", this.onDragStart);
    viewport.addEventListener("wheel", this.onWheel, { passive: false });
    viewport.addEventListener("contextmenu", this.ports.contexts.onMenu);
  }

  /** 摘掉 `attach` 挂上的监听；还没挂载过（没有视口）时只摘窗口上的。 */
  detach(viewport: HTMLElement | undefined): void {
    window.removeEventListener("keydown", this.ports.contexts.onKey, true);
    window.removeEventListener("keydown", this.onModifier);
    window.removeEventListener("keyup", this.onModifier);
    window.removeEventListener("blur", this.onBlur);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
    if (viewport) {
      delete viewport.dataset["tool"];
      viewport.removeEventListener("pointerdown", this.onPointerDown);
      viewport.removeEventListener("click", this.onClickCapture, true);
      viewport.removeEventListener("dragstart", this.onDragStart);
      viewport.removeEventListener("wheel", this.onWheel);
      viewport.removeEventListener("contextmenu", this.ports.contexts.onMenu);
    }
  }

  /** 放下手里正拿着的东西（取消）。 */
  cancel(): void {
    this.finishDrag(true);
  }

  /** 卸载的最后：忘掉拖动与按住的修饰键。 */
  reset(): void {
    this.drag = undefined;
    this.ctrlDown = false;
    this.shiftDown = false;
    this.spaceDown = false;
  }

  private readonly onModifier = (event: KeyboardEvent): void => {
    const down = event.type === "keydown";
    this.ctrlDown = event.key === "Control" ? down : event.ctrlKey;
    this.shiftDown = event.key === "Shift" ? down : event.shiftKey;
    if (event.code === "Space" || event.key === " ") {
      if (!down) this.spaceDown = false;
      else {
        const target = event.target instanceof Element ? event.target : undefined;
        const editable = target?.closest("input,textarea,select,button,a,[contenteditable]:not([contenteditable='false']),[role='dialog'],[role='menu']");
        if (!event.defaultPrevented && !editable && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
          this.spaceDown = true;
          event.preventDefault();
        }
      }
    }
    this.updateTool();
  };

  private readonly onBlur = (): void => {
    this.ctrlDown = false;
    this.shiftDown = false;
    this.spaceDown = false;
    this.updateTool();
    this.finishDrag(true);
  };

  private updateTool(): void {
    const viewport = this.ports.viewport();
    if (!viewport) return;
    if (this.shiftDown) viewport.dataset["tool"] = "select";
    else if (this.ctrlDown || this.spaceDown) viewport.dataset["tool"] = "pan";
    else delete viewport.dataset["tool"];
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    // 任何指针操作都说明接下来的 contextmenu 不再是键盘来的。
    this.ports.contexts.reset();
    if (this.drag) return;
    if (event.button !== 0 && event.button !== 1) return;
    this.ctrlDown = event.ctrlKey;
    this.shiftDown = event.shiftKey;
    this.updateTool();
    const target = event.target as Element | null;
    if (target?.closest("[data-scene-ui],button,input,textarea,select,[role='menu']")) return;
    const node = target?.closest<HTMLElement>("[data-node-id]");
    const body = node ? this.ports.bodies.get(node.dataset["nodeId"] ?? "") : undefined;
    if (event.button === 0 && event.shiftKey) {
      this.ports.selection.begin(event.clientX, event.clientY);
      this.drag = { kind: "select", id: event.pointerId, sx: event.clientX, sy: event.clientY, nodeId: body?.id, moved: false };
      return;
    }
    if (event.ctrlKey || this.spaceDown || event.button === 1 || (event.pointerType === "touch" && !node)) {
      if (event.button === 1 && (node || target?.closest("a"))) return;
      if (event.button === 1) event.preventDefault();
      this.drag = { kind: "pan", id: event.pointerId, sx: event.clientX, sy: event.clientY,
        cx: this.ports.camera.camera.x, cy: this.ports.camera.camera.y, moved: false, suppressTap: event.ctrlKey || this.spaceDown };
      return;
    }
    if (body && event.button === 0) {
      const bodies = selectedBodies(this.ports.bodies, this.ports.selection, body).map((item) => ({ body: item, x: item.x, y: item.y }));
      this.drag = { kind: "node", id: event.pointerId, sx: event.clientX, sy: event.clientY,
        scale: this.ports.camera.camera.k, primary: body, bodies, before: this.ports.placements.snapshot(bodies.map((item) => item.body.id)), moved: false };
      return;
    }
    if (!node && !target?.closest("a")) this.ports.selection.clear();
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag) {
      if (this.ctrlDown !== event.ctrlKey || this.shiftDown !== event.shiftKey) {
        this.ctrlDown = event.ctrlKey;
        this.shiftDown = event.shiftKey;
        this.updateTool();
      }
      return;
    }
    if (drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.sx;
    const dy = event.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    if (!drag.moved) {
      drag.moved = true;
      const viewport = this.ports.viewport();
      viewport?.setPointerCapture(event.pointerId);
      if (drag.kind === "pan" && viewport) viewport.dataset["panning"] = "";
      if (drag.kind === "select" && viewport) viewport.dataset["selecting"] = "";
      if (drag.kind === "node") {
        if (viewport) viewport.dataset["moving"] = "";
        if (!this.ports.selection.has(drag.primary.id)) this.ports.selection.only(drag.primary.id);
        for (const { body } of drag.bodies) if (body.el) body.el.dataset["dragging"] = "";
      }
      if (drag.kind !== "select") this.ports.camera.grab();
    }
    if (drag.kind === "select") {
      this.ports.selection.update(event.clientX, event.clientY);
      return;
    }
    if (drag.kind === "node") {
      this.ports.placements.place(drag.bodies.map(({ body, x, y }) => ({ body, position: { x: x + dx / drag.scale, y: y + dy / drag.scale } })));
      return;
    }
    this.ports.camera.dragTo(drag.cx + dx, drag.cy + dy);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || drag.id !== event.pointerId) return;
    this.finishDrag(event.type === "pointercancel");
  };

  private finishDrag(cancelled: boolean): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = undefined;
    if (drag.kind === "node" && drag.moved) {
      for (const { body } of drag.bodies) if (body.el) delete body.el.dataset["dragging"];
      this.ports.placements.commit(drag.before, drag.bodies.map((item) => item.body.id));
    }
    if (drag.kind === "select") {
      if (!cancelled && !drag.moved && drag.nodeId) this.ports.selection.toggle(drag.nodeId);
      this.ports.selection.finish(cancelled);
    }
    if (!cancelled && (drag.moved || (drag.kind === "select" && drag.nodeId) || (drag.kind === "pan" && drag.suppressTap))) this.suppressNextClick();
    const viewport = this.ports.viewport();
    if (viewport) {
      delete viewport.dataset["panning"];
      delete viewport.dataset["selecting"];
      delete viewport.dataset["moving"];
      if (viewport.hasPointerCapture(drag.id)) viewport.releasePointerCapture(drag.id);
    }
  }

  private suppressNextClick(): void {
    this.suppressClick = true;
    setTimeout(() => { this.suppressClick = false; }, 0);
  }

  private readonly onClickCapture = (event: MouseEvent): void => {
    if (!this.suppressClick) return;
    this.suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  };

  private readonly onDragStart = (event: DragEvent): void => {
    if ((event.target as Element | null)?.closest("[data-node-id]")) event.preventDefault();
  };

  private readonly onWheel = (event: WheelEvent): void => {
    const target = event.target as Element | null;
    // 面板、菜单等可滚动的浮层里的滚轮归它们自己。
    if (target?.closest("[data-scroll]")) return;
    const viewport = this.ports.viewport();
    if (!viewport) return;
    event.preventDefault();
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
    const rect = viewport.getBoundingClientRect();
    if (event.ctrlKey || event.metaKey) {
      const delta = clamp(event.deltaY * scale, -60, 60);
      this.ports.camera.zoomAround(event.clientX - rect.left, event.clientY - rect.top, Math.exp(-delta * 0.012), true);
      return;
    }
    const horizontal = event.shiftKey && event.deltaX === 0;
    const dx = (horizontal ? event.deltaY : event.deltaX) * scale;
    const dy = (horizontal ? 0 : event.deltaY) * scale;
    this.ports.camera.scrollBy(dx, dy);
  };
}
