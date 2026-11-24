import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { at, mountPair, mountScene, node, origin, pointer, sceneOf, selectBoth, stored } from "./engine.fixtures";

/**
 * 特征化测试：位置历史（撤销、重做、合并、上限）与对齐、分布在边界上的取舍。
 * 拆分引擎之前在旧实现上跑绿，拆分之后必须仍然全绿。
 */
describe("placement history", () => {
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

  it("keeps at most a hundred entries and drops the oldest", () => {
    const { engine } = mountPair();
    try {
      for (let i = 0; i < 105; i++) {
        engine.moveNode("agent:one", 1, 0);
        vi.advanceTimersByTime(1000);
      }
      expect(stored()["agent:one"]).toEqual({ x: 415, y: 14 });
      let undone = 0;
      while (engine.undo()) undone += 1;
      expect(undone).toBe(100);
      expect(stored()["agent:one"]).toEqual({ x: 315, y: 14 });
      expect(engine.getState()).toEqual({ selected: 1, canUndo: false, canRedo: true });
      let redone = 0;
      while (engine.redo()) redone += 1;
      expect(redone).toBe(100);
      expect(stored()["agent:one"]).toEqual({ x: 415, y: 14 });
      expect(engine.getState()).toEqual({ selected: 1, canUndo: true, canRedo: false });
    } finally {
      engine.unmount();
    }
  });

  it("forgets what could be redone as soon as something new is recorded", () => {
    const { engine } = mountPair();
    try {
      engine.moveNode("agent:one", 10, 0);
      vi.advanceTimersByTime(1000);
      engine.moveNode("agent:one", 10, 0);
      expect(engine.undo()).toBe(true);
      expect(engine.getState().canRedo).toBe(true);
      vi.advanceTimersByTime(1000);
      engine.moveNode("agent:one", 0, 5);
      expect(engine.getState()).toEqual({ selected: 1, canUndo: true, canRedo: false });
      expect(engine.redo()).toBe(false);
    } finally {
      engine.unmount();
    }
  });

  it("answers false and changes nothing when there is nothing to undo or redo", () => {
    const { engine } = mountPair();
    try {
      const state = engine.getState();
      expect(engine.undo()).toBe(false);
      expect(engine.redo()).toBe(false);
      expect(engine.getState()).toBe(state);
      expect(localStorage.getItem("ensemble.canvas.positions.v1")).toBeNull();
    } finally {
      engine.unmount();
    }
  });

  it("does not undo, redo or align while a drag is in progress", () => {
    const { engine, viewport, agent } = mountPair();
    try {
      engine.moveNode("agent:one", 10, 0);
      selectBoth(engine);
      pointer(agent, "pointerdown", 400, 300);
      pointer(viewport, "pointermove", 450, 300);
      expect(engine.undo()).toBe(false);
      expect(engine.redo()).toBe(false);
      expect(engine.align("top")).toBe(false);
      expect(engine.distribute("vertical")).toBe(false);
      expect(engine.getState().canUndo).toBe(true);
      pointer(viewport, "pointerup", 450, 300);
      expect(engine.undo()).toBe(true);
    } finally {
      engine.unmount();
    }
  });

  it("sends nodes back to where the layout puts them when the undone placement had none", () => {
    const { engine, agent } = mountPair();
    try {
      engine.moveNode("agent:one", 10, 0);
      settle();
      expect(at(agent)).toEqual({ x: 320, y: 14 });
      expect(engine.undo()).toBe(true);
      expect(stored()).toEqual({});
      settle();
      expect(at(agent)).toEqual({ x: 310, y: 14 });
      expect(engine.redo()).toBe(true);
      expect(stored()).toEqual({ "agent:one": { x: 320, y: 14 } });
      settle();
      expect(at(agent)).toEqual({ x: 320, y: 14 });
    } finally {
      engine.unmount();
    }
  });

  it("leaves a node where it is when the layout no longer knows where it belongs", () => {
    const { engine, agent } = mountPair();
    try {
      engine.moveNode("agent:one", 10, 0);
      settle();
      engine.setLayout(sceneOf([origin("origin:one", 0, 30)]));
      expect(engine.undo()).toBe(true);
      expect(stored()).toEqual({});
      settle();
      expect(at(agent)).toEqual({ x: 320, y: 14 });
    } finally {
      engine.unmount();
    }
  });

  it("aligns only what is selected, pins the ones already in place, and says no when nothing moves", () => {
    const { engine } = mountPair();
    try {
      expect(engine.align("top")).toBe(false);
      engine.toggleSelection("agent:one");
      expect(engine.align("top")).toBe(false);
      engine.toggleSelection("origin:one");
      expect(engine.align("top")).toBe(true);
      expect(stored()).toEqual({ "origin:one": { x: 0, y: 14 }, "agent:one": { x: 310, y: 14 } });
      expect(engine.align("top")).toBe(false);
      expect(engine.undo()).toBe(true);
      expect(engine.getState().canUndo).toBe(false);
      expect(stored()).toEqual({});
    } finally {
      engine.unmount();
    }
  });

  it("distributes only three or more nodes, and aligns by the targets rather than by where the spring is", () => {
    const { engine, attach } = mountPair();
    try {
      attach("agent:two");
      attach("agent:three");
      engine.setLayout(sceneOf([origin("origin:one", 0, 30), node("agent:one", 310, 14, { w: 248, h: 144 }), node("agent:two", 800, 14), node("agent:three", 1500, 14)]));
      selectBoth(engine);
      expect(engine.distribute("vertical")).toBe(false);
      engine.toggleSelection("agent:two");
      engine.toggleSelection("agent:three");
      expect(engine.distribute("vertical")).toBe(true);
      const first = stored();
      // 弹簧还没走：再来一次得到同样的结果，没有新的变化。
      expect(engine.distribute("vertical")).toBe(false);
      expect(stored()).toEqual(first);
      settle();
      expect(engine.distribute("vertical")).toBe(false);
    } finally {
      engine.unmount();
    }
  });

  it("aligns by where the nodes are heading, so an alignment right after another sees the first one's result", () => {
    const { engine } = mountPair();
    try {
      selectBoth(engine);
      expect(engine.align("left")).toBe(true);
      expect(stored()).toEqual({ "origin:one": { x: 0, y: 30 }, "agent:one": { x: 0, y: 14 } });
      // 弹簧一帧都还没走：外框取的是目标位置，不是弹簧此刻走到哪里，所以第二次只动纵向。
      expect(engine.align("top")).toBe(true);
      expect(stored()).toEqual({ "origin:one": { x: 0, y: 14 }, "agent:one": { x: 0, y: 14 } });
    } finally {
      engine.unmount();
    }
  });

  it("counts an alignment as a change only when a node moves by more than a hundredth of a pixel, on either axis", () => {
    // 间距取 2 的负整数次幂（浮点里精确）：1/128 比 0.01 小，1/64 比它大。
    const small = 2 ** -7;
    const large = 2 ** -6;
    const attempt = (a: { x: number; y: number }, b: { x: number; y: number }, mode: "left" | "top") => {
      const { engine } = mountScene(sceneOf([node("a", a.x, a.y), node("b", b.x, b.y)]));
      try {
        engine.toggleSelection("a");
        engine.toggleSelection("b");
        return { moved: engine.align(mode), canUndo: engine.getState().canUndo, stored: stored() };
      } finally {
        engine.unmount();
        localStorage.clear();
      }
    };
    expect(attempt({ x: 100, y: 0 }, { x: 100 + small, y: 300 }, "left")).toEqual({ moved: false, canUndo: false, stored: {} });
    expect(attempt({ x: 0, y: 100 }, { x: 400, y: 100 + small }, "top")).toEqual({ moved: false, canUndo: false, stored: {} });
    expect(attempt({ x: 100, y: 0 }, { x: 100 + large, y: 300 }, "left")).toEqual({
      moved: true,
      canUndo: true,
      stored: { a: { x: 100, y: 0 }, b: { x: 100, y: 300 } },
    });
    expect(attempt({ x: 0, y: 100 }, { x: 400, y: 100 + large }, "top")).toEqual({
      moved: true,
      canUndo: true,
      stored: { a: { x: 0, y: 100 }, b: { x: 400, y: 100 } },
    });
  });
});
