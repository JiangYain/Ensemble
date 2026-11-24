import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { worldCamera } from "./engine-characterize.fixtures";
import { at, edge, mountPair, node, origin, pointer, POSITIONS_KEY, sceneOf, selectBoth } from "./engine.fixtures";

/**
 * 特征化测试：切换工作空间（`switchSpace`）——各空间自己的位置存储与相机记忆、切换时清掉什么、什么保留。
 * 拆分引擎之前在旧实现上跑绿，拆分之后必须仍然全绿。
 */
describe("canvas workspaces", () => {
  const SPACE_KEY = "ensemble.canvas.positions.v2:b";

  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    localStorage.clear();
  });

  const settle = (): void => {
    vi.advanceTimersByTime(3000);
  };

  const pair = () => sceneOf([origin("origin:one", 0, 30), node("agent:one", 310, 14, { w: 248, h: 144 })], [edge("origin:one", "agent:one")]);

  it("keeps manual positions per space, each under its own storage key", () => {
    const { engine, agent } = mountPair();
    try {
      engine.moveNode("agent:one", 10, 0);
      expect(JSON.parse(localStorage.getItem(POSITIONS_KEY) ?? "{}")).toEqual({ "agent:one": { x: 320, y: 14 } });
      engine.switchSpace("b");
      engine.setLayout(pair());
      expect(at(agent)).toEqual({ x: 310, y: 14 });
      engine.moveNode("agent:one", 50, 0);
      expect(JSON.parse(localStorage.getItem(SPACE_KEY) ?? "{}")).toEqual({ "agent:one": { x: 360, y: 14 } });
      expect(JSON.parse(localStorage.getItem(POSITIONS_KEY) ?? "{}")).toEqual({ "agent:one": { x: 320, y: 14 } });
      engine.switchSpace("all");
      engine.setLayout(pair());
      expect(at(agent)).toEqual({ x: 320, y: 14 });
      expect(agent.dataset["fresh"]).toBeUndefined();
    } finally {
      engine.unmount();
    }
  });

  it("remembers the camera of a space the user moved, and resets the camera of the others", () => {
    const { engine, world } = mountPair();
    try {
      engine.zoomBy(1.2);
      settle();
      const before = { ...engine.getCamera() };
      engine.switchSpace("b");
      expect(worldCamera(world)).toEqual({ x: 0, y: 0, k: 1 });
      expect(engine.getCamera()).toEqual({ x: 0, y: 0, k: 1 });
      expect(engine.isUserMoved()).toBe(false);
      engine.setLayout(pair());
      expect(engine.getCamera()).toEqual({ x: 321, y: 345, k: 1 });
      engine.switchSpace("all");
      expect(engine.getCamera()).toEqual(before);
      expect(worldCamera(world)).toEqual({ x: 265.2, y: 334, k: 1.2 });
      expect(engine.isUserMoved()).toBe(true);
      // 回到的空间里再来一份布局：相机归用户，不再取景。
      engine.setLayout(pair());
      expect(engine.getCamera()).toEqual(before);
      // 回到自动取景的空间：相机照旧是自动取景（k 回到取景值），而不是上一个空间的视角。
      engine.switchSpace("b");
      engine.setLayout(pair());
      expect(engine.isUserMoved()).toBe(false);
      expect(engine.getCamera()).toEqual({ x: 321, y: 345, k: 1 });
    } finally {
      engine.unmount();
    }
  });

  it("does not remember a camera that was moved while the space had no layout", () => {
    const { engine } = mountPair();
    try {
      engine.switchSpace("c");
      engine.zoomBy(2);
      expect(engine.isUserMoved()).toBe(true);
      engine.switchSpace("all");
      engine.switchSpace("c");
      expect(engine.getCamera()).toEqual({ x: 0, y: 0, k: 1 });
      expect(engine.isUserMoved()).toBe(false);
    } finally {
      engine.unmount();
    }
  });

  it("clears the selection and the history, and tells the host once each", () => {
    const { engine } = mountPair();
    const onPositions = vi.fn();
    const onCamera = vi.fn();
    try {
      selectBoth(engine);
      engine.moveNode("agent:one", 10, 0);
      expect(engine.getState()).toEqual({ selected: 2, canUndo: true, canRedo: false });
      engine.undo();
      expect(engine.getState()).toEqual({ selected: 2, canUndo: false, canRedo: true });
      const seen: unknown[] = [];
      engine.subscribe(() => seen.push({ ...engine.getState() }));
      const members = vi.fn();
      engine.subscribeSelection(members);
      engine.switchSpace("b");
      expect(engine.getState()).toEqual({ selected: 0, canUndo: false, canRedo: false });
      expect(engine.getSelectedIds()).toEqual([]);
      expect(seen).toEqual([{ selected: 0, canUndo: false, canRedo: true }, { selected: 0, canUndo: false, canRedo: false }]);
      expect(members).toHaveBeenCalledTimes(1);
      expect(onPositions).not.toHaveBeenCalled();
      expect(onCamera).not.toHaveBeenCalled();
      // 同一个空间再切一次什么都不发生。
      engine.switchSpace("b");
      expect(seen).toHaveLength(2);
    } finally {
      engine.unmount();
    }
  });

  it("tells the host how many manual positions the new space has, and reports the reset camera", () => {
    const rig = mountPair();
    const onPositions = vi.fn();
    const seen: [number, boolean][] = [];
    const onCamera = vi.fn((camera: { k: number }, moved: boolean) => {
      seen.push([camera.k, moved]);
    });
    rig.engine.mount({ viewport: rig.viewport, world: rig.world, pipes: { tube: rig.tube, dots: rig.dots }, onPositions, onCamera });
    try {
      rig.engine.zoomBy(1.2);
      expect(seen).toEqual([[1.2, true]]);
      localStorage.setItem(SPACE_KEY, JSON.stringify({ "agent:one": { x: 5, y: 6 } }));
      onPositions.mockClear();
      rig.engine.switchSpace("b");
      expect(onPositions.mock.calls).toEqual([[true]]);
      expect(seen).toEqual([[1.2, true], [1, false]]);
      rig.engine.switchSpace("all");
      expect(onPositions.mock.calls).toEqual([[true], [false]]);
    } finally {
      rig.engine.unmount();
    }
  });

  it("puts down a node that is being dragged, in the space it was dragged in", () => {
    const { engine, viewport, agent } = mountPair();
    try {
      pointer(agent, "pointerdown", 400, 300);
      pointer(viewport, "pointermove", 450, 300);
      engine.switchSpace("b");
      expect(viewport.dataset["moving"]).toBeUndefined();
      expect(agent.dataset["dragging"]).toBeUndefined();
      expect(JSON.parse(localStorage.getItem(POSITIONS_KEY) ?? "{}")).toEqual({ "agent:one": { x: 360, y: 14 } });
      expect(localStorage.getItem(SPACE_KEY)).toBeNull();
      // 之后这次拖动的松手事件不再有任何效果。
      pointer(viewport, "pointerup", 450, 300);
      expect(JSON.parse(localStorage.getItem(POSITIONS_KEY) ?? "{}")).toEqual({ "agent:one": { x: 360, y: 14 } });
    } finally {
      engine.unmount();
    }
  });

  it("forgets which nodes it had seen, so the first layout of the new space is the status quo and nothing is 'new'", () => {
    localStorage.setItem(SPACE_KEY, JSON.stringify({ "origin:one": { x: 500, y: 400 } }));
    const { engine, attach } = mountPair();
    try {
      const second = attach("agent:two");
      engine.switchSpace("b");
      engine.setLayout(sceneOf(
        [origin("origin:one", 0, 30), node("agent:one", 310, 14, { w: 248, h: 144 }), node("agent:two", 310, 180, { anchor: { id: "origin:one", dx: 310, dy: 150 } })],
        [edge("origin:one", "agent:one"), edge("origin:one", "agent:two")],
      ));
      expect(at(second)).toEqual({ x: 310, y: 180 });
      expect(JSON.parse(localStorage.getItem(SPACE_KEY) ?? "{}")).toEqual({ "origin:one": { x: 500, y: 400 } });
      settle();
      expect(at(second)).toEqual({ x: 310, y: 180 });
    } finally {
      engine.unmount();
    }
  });

  it("unplaces the registered nodes until the new space brings its own layout, and takes that layout as a fresh start", () => {
    const { engine, agent, origin: source } = mountPair();
    try {
      const orphan = document.createElement("div");
      const release = engine.register("agent:gone", orphan);
      engine.setLayout(sceneOf([origin("origin:one", 0, 30), node("agent:one", 310, 14, { w: 248, h: 144 }), node("agent:gone", 700, 14)], [edge("origin:one", "agent:one")]));
      release();
      engine.selectAll();
      expect(engine.getSelectedIds()).toEqual(["origin:one", "agent:one"]);
      engine.switchSpace("b");
      engine.selectAll();
      expect(engine.getSelectedIds()).toEqual([]);
      // 新空间的布局与旧空间不同：旧空间的记忆（已有的卡原地不动）不带过来，新布局整体生效。
      engine.setLayout(sceneOf([origin("origin:one", 0, 30), node("agent:one", 400, 14, { w: 248, h: 144 })], [edge("origin:one", "agent:one")]));
      settle();
      expect(at(agent)).toEqual({ x: 400, y: 14 });
      expect(at(source)).toEqual({ x: 0, y: 30 });
      expect(agent.dataset["fresh"]).toBeUndefined();
      engine.selectAll();
      expect(engine.getSelectedIds()).toEqual(["origin:one", "agent:one"]);
    } finally {
      engine.unmount();
    }
  });
});
