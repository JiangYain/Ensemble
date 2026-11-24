import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MountOptions } from "./engine";
import { worldCamera } from "./engine-characterize.fixtures";
import { at, mountPair, pointer, selectBoth, stored } from "./engine.fixtures";

/**
 * 特征化测试：指针手势（平移、拖动节点、框选）的状态机——阈值、坐标换算、捕获、点击抑制、哪些目标被忽略。
 * 拆分引擎之前在旧实现上跑绿，拆分之后必须仍然全绿。数值都是旧实现跑出来的结果，不是推导。
 */
describe("canvas pointer gestures", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date", "setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
    localStorage.clear();
  });

  const settle = (): void => {
    vi.advanceTimersByTime(3000);
  };

  /** 配好的一对节点；再挂载一次，把回调交给引擎（`mountScene` 没有回调）。 */
  function mounted(options: Partial<MountOptions> = {}) {
    const rig = mountPair();
    rig.engine.mount({ viewport: rig.viewport, world: rig.world, pipes: { tube: rig.tube, dots: rig.dots }, ...options });
    return rig;
  }

  const click = (target: Element): MouseEvent => {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };

  it("pans 1:1 only after the pointer has moved 5px, and captures the pointer once", () => {
    const onCamera = vi.fn();
    const { engine, viewport, world } = mounted({ onCamera });
    try {
      const capture = vi.spyOn(viewport, "setPointerCapture");
      const release = vi.spyOn(viewport, "releasePointerCapture");
      expect(worldCamera(world)).toEqual({ x: 321, y: 345, k: 1 });
      pointer(viewport, "pointerdown", 100, 100, { ctrlKey: true });
      pointer(viewport, "pointermove", 103, 103, { ctrlKey: true });
      expect(viewport.dataset["panning"]).toBeUndefined();
      expect(engine.isUserMoved()).toBe(false);
      expect(capture).not.toHaveBeenCalled();
      // 越过阈值之后按“离按下点的总位移”平移，不是从越过的那一刻算起。
      pointer(viewport, "pointermove", 106, 100, { ctrlKey: true });
      expect(viewport.dataset["panning"]).toBe("");
      expect(worldCamera(world)).toEqual({ x: 327, y: 345, k: 1 });
      pointer(viewport, "pointermove", 160, 130, { ctrlKey: true });
      expect(worldCamera(world)).toEqual({ x: 381, y: 375, k: 1 });
      expect(engine.getCamera()).toEqual({ x: 381, y: 375, k: 1 });
      expect(engine.isUserMoved()).toBe(true);
      expect(capture.mock.calls).toEqual([[1]]);
      // 相机在拖动中是即时的，不需要任何帧；也不留下待走的弹簧。
      expect(vi.getTimerCount()).toBe(1);
      pointer(viewport, "pointerup", 160, 130, { ctrlKey: true });
      expect(viewport.dataset["panning"]).toBeUndefined();
      expect(release.mock.calls).toEqual([[1]]);
      // 上报只在缩放或“用户动过”变了才发：挂载时读到的 k=1、未动过，和上一次挂载上报的一样，不重发。
      expect(onCamera.mock.calls.map(([camera, moved]) => [camera.k, moved])).toEqual([[1, true]]);
    } finally {
      engine.unmount();
    }
  });

  it("starts a drag at exactly 5px of travel and not a hair before, for every kind of drag", () => {
    const { engine, viewport, agent } = mounted();
    try {
      // 3-4-5：恰好 5px 算起拖；√20 ≈ 4.47 不算。
      pointer(viewport, "pointerdown", 100, 100, { ctrlKey: true });
      pointer(viewport, "pointermove", 102, 104, { ctrlKey: true });
      expect(viewport.dataset["panning"]).toBeUndefined();
      pointer(viewport, "pointermove", 103, 104, { ctrlKey: true });
      expect(viewport.dataset["panning"]).toBe("");
      expect(engine.getCamera()).toEqual({ x: 324, y: 349, k: 1 });
      pointer(viewport, "pointerup", 103, 104, { ctrlKey: true });
      pointer(agent, "pointerdown", 400, 300);
      pointer(viewport, "pointermove", 402, 304);
      expect(agent.dataset["dragging"]).toBeUndefined();
      expect(at(agent)).toEqual({ x: 310, y: 14 });
      pointer(viewport, "pointermove", 403, 304);
      expect(agent.dataset["dragging"]).toBe("");
      expect(at(agent)).toEqual({ x: 313, y: 18 });
      pointer(viewport, "pointerup", 403, 304);
      pointer(viewport, "pointerdown", 900, 700, { shiftKey: true });
      pointer(viewport, "pointermove", 902, 704, { shiftKey: true });
      expect(viewport.dataset["selecting"]).toBeUndefined();
      pointer(viewport, "pointermove", 903, 704, { shiftKey: true });
      expect(viewport.dataset["selecting"]).toBe("");
      pointer(viewport, "pointerup", 903, 704, { shiftKey: true });
    } finally {
      engine.unmount();
    }
  });

  it("swallows the click that follows a pan, once, and lets it through after the tick", () => {
    const { engine, viewport, agent } = mounted();
    try {
      const clicked = vi.fn();
      agent.addEventListener("click", clicked);
      pointer(viewport, "pointerdown", 100, 100, { ctrlKey: true });
      pointer(viewport, "pointermove", 160, 130, { ctrlKey: true });
      pointer(viewport, "pointerup", 160, 130, { ctrlKey: true });
      const first = click(agent);
      expect(first.defaultPrevented).toBe(true);
      expect(clicked).not.toHaveBeenCalled();
      expect(click(agent).defaultPrevented).toBe(false);
      expect(clicked).toHaveBeenCalledTimes(1);
      // 不点的话，抑制也只活到下一个 tick。
      pointer(viewport, "pointerdown", 100, 100, { ctrlKey: true });
      pointer(viewport, "pointermove", 160, 130, { ctrlKey: true });
      pointer(viewport, "pointerup", 160, 130, { ctrlKey: true });
      vi.advanceTimersByTime(1);
      expect(click(agent).defaultPrevented).toBe(false);
      expect(clicked).toHaveBeenCalledTimes(2);
      // 按住 Ctrl 单击一下（没有移动）也吞掉随后的点击：macOS 上那是右键手势。
      pointer(agent, "pointerdown", 100, 100, { ctrlKey: true });
      pointer(agent, "pointerup", 100, 100, { ctrlKey: true });
      expect(click(agent).defaultPrevented).toBe(true);
      // 普通的单击（没有移动、没有修饰键）不被吞。
      vi.advanceTimersByTime(1);
      pointer(agent, "pointerdown", 100, 100);
      pointer(agent, "pointerup", 100, 100);
      expect(click(agent).defaultPrevented).toBe(false);
    } finally {
      engine.unmount();
    }
  });

  it("drags a node by the pointer delta, selects it on the first move and persists on release", () => {
    const onPositions = vi.fn();
    const onSelection = vi.fn();
    const { engine, viewport, agent } = mounted({ onPositions, onSelection });
    try {
      const capture = vi.spyOn(viewport, "setPointerCapture");
      pointer(agent, "pointerdown", 400, 300);
      expect(engine.getSelectedIds()).toEqual([]);
      pointer(viewport, "pointermove", 475, 345);
      expect(capture.mock.calls).toEqual([[1]]);
      expect(viewport.dataset["moving"]).toBe("");
      expect(agent.dataset["dragging"]).toBe("");
      expect(engine.getSelectedIds()).toEqual(["agent:one"]);
      expect(engine.getState()).toMatchObject({ selected: 1, canUndo: false });
      expect(at(agent)).toEqual({ x: 385, y: 59 });
      pointer(viewport, "pointermove", 500, 300);
      expect(at(agent)).toEqual({ x: 410, y: 14 });
      expect(stored()).toEqual({});
      pointer(viewport, "pointerup", 500, 300);
      expect(agent.dataset["dragging"]).toBeUndefined();
      expect(viewport.dataset["moving"]).toBeUndefined();
      expect(stored()).toEqual({ "agent:one": { x: 410, y: 14 } });
      expect(engine.getState()).toMatchObject({ selected: 1, canUndo: true, canRedo: false });
      expect(click(agent).defaultPrevented).toBe(true);
      // 每次移动通知一次“有手动位置”；收尾时不再通知。
      expect(onPositions.mock.calls).toEqual([[false], [true], [true]]);
      expect(onSelection.mock.calls).toEqual([[1]]);
    } finally {
      engine.unmount();
    }
  });

  it("converts the drag delta by the camera zoom captured at pointerdown", () => {
    const { engine, viewport, agent } = mounted();
    try {
      engine.zoomBy(0.5);
      settle();
      expect(engine.getCamera().k).toBe(0.5);
      pointer(agent, "pointerdown", 400, 300);
      pointer(viewport, "pointermove", 500, 350);
      pointer(viewport, "pointerup", 500, 350);
      expect(at(agent)).toEqual({ x: 510, y: 114 });
    } finally {
      engine.unmount();
    }
  });

  it("drags the whole selection together and records one history step", () => {
    const { engine, viewport, origin, agent } = mounted();
    try {
      selectBoth(engine);
      pointer(agent, "pointerdown", 400, 300);
      pointer(viewport, "pointermove", 450, 320);
      expect(at(origin)).toEqual({ x: 50, y: 50 });
      expect(at(agent)).toEqual({ x: 360, y: 34 });
      expect(engine.getSelectedIds()).toEqual(["origin:one", "agent:one"]);
      pointer(viewport, "pointerup", 450, 320);
      expect(Object.keys(stored())).toEqual(["origin:one", "agent:one"]);
      expect(engine.undo()).toBe(true);
      settle();
      expect(at(origin)).toEqual({ x: 0, y: 30 });
      expect(at(agent)).toEqual({ x: 310, y: 14 });
      expect(engine.getState()).toMatchObject({ canUndo: false, canRedo: true });
    } finally {
      engine.unmount();
    }
  });

  it("follows only the pointer that started the drag and ignores a second pointerdown meanwhile", () => {
    const { engine, viewport, agent } = mounted();
    try {
      pointer(agent, "pointerdown", 400, 300);
      pointer(viewport, "pointermove", 475, 345, { pointerId: 2 });
      expect(agent.dataset["dragging"]).toBeUndefined();
      pointer(viewport, "pointermove", 475, 345);
      expect(agent.dataset["dragging"]).toBe("");
      pointer(viewport, "pointerdown", 5, 5, { pointerId: 2 });
      expect(engine.getSelectedIds()).toEqual(["agent:one"]);
      pointer(viewport, "pointerup", 475, 345, { pointerId: 2 });
      expect(viewport.dataset["moving"]).toBe("");
      pointer(viewport, "pointerup", 475, 345);
      expect(viewport.dataset["moving"]).toBeUndefined();
      expect(at(agent)).toEqual({ x: 385, y: 59 });
    } finally {
      engine.unmount();
    }
  });

  it("leaves buttons and scene UI alone but still reads the modifier keys from the event", () => {
    const { engine, viewport, agent } = mounted();
    try {
      const button = document.createElement("button");
      agent.append(button);
      pointer(button, "pointerdown", 400, 300, { ctrlKey: true });
      expect(viewport.dataset["tool"]).toBe("pan");
      pointer(viewport, "pointermove", 475, 345, { ctrlKey: true });
      expect(viewport.dataset["panning"]).toBeUndefined();
      expect(viewport.dataset["moving"]).toBeUndefined();
      pointer(viewport, "pointerup", 475, 345);
      const ui = document.createElement("div");
      ui.dataset["sceneUi"] = "";
      viewport.append(ui);
      pointer(ui, "pointerdown", 400, 300);
      pointer(viewport, "pointermove", 475, 345);
      expect(viewport.dataset["moving"]).toBeUndefined();
      expect(viewport.dataset["tool"]).toBeUndefined();
      // 右键完全不碰：既不拖动，也不更新修饰键。
      pointer(agent, "pointerdown", 400, 300, { button: 2, ctrlKey: true });
      expect(viewport.dataset["tool"]).toBeUndefined();
      expect(engine.getSelectedIds()).toEqual([]);
    } finally {
      engine.unmount();
    }
  });

  it("clears the selection on a blank pointerdown but not on a link, and ignores middle clicks on nodes", () => {
    const { engine, viewport, world, agent } = mounted();
    try {
      const link = document.createElement("a");
      world.append(link);
      selectBoth(engine);
      pointer(link, "pointerdown", 5, 5);
      expect(engine.getSelectedIds()).toEqual(["origin:one", "agent:one"]);
      pointer(viewport, "pointerdown", 5, 5);
      pointer(viewport, "pointerup", 5, 5);
      expect(engine.getSelectedIds()).toEqual([]);
      // 中键：空白处开始平移并拦下浏览器默认的自动滚动；落在节点或链接上什么都不做。
      const blank = new PointerEvent("pointerdown", { pointerId: 1, button: 1, clientX: 100, clientY: 100, bubbles: true, cancelable: true });
      viewport.dispatchEvent(blank);
      expect(blank.defaultPrevented).toBe(true);
      pointer(viewport, "pointermove", 160, 130, { button: 1 });
      expect(engine.getCamera()).toEqual({ x: 381, y: 375, k: 1 });
      pointer(viewport, "pointerup", 160, 130, { button: 1 });
      const onNode = new PointerEvent("pointerdown", { pointerId: 1, button: 1, clientX: 100, clientY: 100, bubbles: true, cancelable: true });
      agent.dispatchEvent(onNode);
      expect(onNode.defaultPrevented).toBe(false);
      pointer(viewport, "pointermove", 300, 300, { button: 1 });
      expect(engine.getCamera()).toEqual({ x: 381, y: 375, k: 1 });
    } finally {
      engine.unmount();
    }
  });

  it("pans on a touch drag over blank canvas but drags the node when it starts on one", () => {
    const { engine, viewport, agent } = mounted();
    try {
      pointer(viewport, "pointerdown", 100, 100, { pointerType: "touch" });
      pointer(viewport, "pointermove", 160, 130, { pointerType: "touch" });
      pointer(viewport, "pointerup", 160, 130, { pointerType: "touch" });
      expect(engine.getCamera()).toEqual({ x: 381, y: 375, k: 1 });
      pointer(agent, "pointerdown", 400, 300, { pointerType: "touch" });
      pointer(viewport, "pointermove", 450, 300, { pointerType: "touch" });
      pointer(viewport, "pointerup", 450, 300, { pointerType: "touch" });
      expect(at(agent)).toEqual({ x: 360, y: 14 });
      expect(engine.getCamera()).toEqual({ x: 381, y: 375, k: 1 });
    } finally {
      engine.unmount();
    }
  });

  it("box-selects with Shift: the box shows while dragging, cancel restores, shift-click on a node toggles", () => {
    const { engine, viewport, origin, agent } = mounted();
    try {
      origin.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 30, width: 212, height: 112 });
      agent.getBoundingClientRect = () => DOMRect.fromRect({ x: 310, y: 14, width: 248, height: 144 });
      engine.toggleSelection("origin:one");
      pointer(viewport, "pointerdown", 300, 5, { shiftKey: true });
      expect(viewport.dataset["tool"]).toBe("select");
      pointer(viewport, "pointermove", 700, 400, { shiftKey: true });
      const box = viewport.querySelector<HTMLElement>(".scene-selection")!;
      expect(viewport.dataset["selecting"]).toBe("");
      expect(box.hidden).toBe(false);
      expect(box.style.left).toBe("300px");
      expect(box.style.width).toBe("400px");
      expect(engine.getSelectedIds()).toEqual(["origin:one", "agent:one"]);
      pointer(viewport, "pointercancel", 700, 400, { shiftKey: true });
      expect(engine.getSelectedIds()).toEqual(["origin:one"]);
      expect(viewport.dataset["selecting"]).toBeUndefined();
      expect(box.hidden).toBe(true);
      // 没动、落在节点上：切换这个节点的选中，并吞掉随后的点击。
      pointer(agent, "pointerdown", 400, 100, { shiftKey: true });
      pointer(agent, "pointerup", 400, 100, { shiftKey: true });
      expect(engine.getSelectedIds()).toEqual(["origin:one", "agent:one"]);
      expect(click(agent).defaultPrevented).toBe(true);
      // 空白处的 Shift 单击不吞点击。
      vi.advanceTimersByTime(1);
      pointer(viewport, "pointerdown", 900, 700, { shiftKey: true });
      pointer(viewport, "pointerup", 900, 700, { shiftKey: true });
      expect(click(viewport).defaultPrevented).toBe(false);
    } finally {
      engine.unmount();
    }
  });

  it("does not toggle a node for a Shift-click that was cancelled, not even for a moment, and leaves the next click alone", () => {
    const { engine, agent } = mounted();
    try {
      // 取消时选区会被放回按下之前的样子，“先切换、再放回”从最终结果上看不出来：要看订阅者有没有收到过通知。
      const members: number[] = [];
      const counts: number[] = [];
      engine.subscribeSelection(() => members.push(engine.getSelectedIds().length));
      engine.subscribe(() => counts.push(engine.getState().selected));
      pointer(agent, "pointerdown", 400, 100, { shiftKey: true });
      pointer(agent, "pointercancel", 400, 100, { shiftKey: true });
      expect(engine.getSelectedIds()).toEqual([]);
      expect(members).toEqual([]);
      expect(counts).toEqual([]);
      expect(click(agent).defaultPrevented).toBe(false);
    } finally {
      engine.unmount();
    }
  });

  it("blocks native dragging of nodes only", () => {
    const { engine, viewport, agent } = mounted();
    try {
      const onNode = new Event("dragstart", { bubbles: true, cancelable: true });
      agent.dispatchEvent(onNode);
      expect(onNode.defaultPrevented).toBe(true);
      const blank = new Event("dragstart", { bubbles: true, cancelable: true });
      viewport.dispatchEvent(blank);
      expect(blank.defaultPrevented).toBe(false);
    } finally {
      engine.unmount();
    }
  });

  it("drops a dragged node where it is when the window loses focus, records it, and does not swallow the next click", () => {
    const { engine, viewport, agent } = mounted();
    try {
      pointer(agent, "pointerdown", 400, 300);
      pointer(viewport, "pointermove", 450, 300);
      window.dispatchEvent(new Event("blur"));
      expect(agent.dataset["dragging"]).toBeUndefined();
      expect(viewport.dataset["moving"]).toBeUndefined();
      expect(stored()).toEqual({ "agent:one": { x: 360, y: 14 } });
      expect(engine.getState().canUndo).toBe(true);
      expect(click(agent).defaultPrevented).toBe(false);
    } finally {
      engine.unmount();
    }
  });
});
