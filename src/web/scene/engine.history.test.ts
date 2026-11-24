import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { at, mountPair, POSITIONS_KEY, pointer, selectBoth, stored } from "./engine.fixtures";

describe("canvas history", () => {
  beforeEach(() => {
    localStorage.clear();
    // 弹簧靠 requestAnimationFrame 推进；假定时器让测试能把它走完，也让历史的合并窗口可控。
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

  it("undoes and redoes an alignment, and a new action clears the redo branch", () => {
    const { engine, origin, agent } = mountPair();
    try {
      selectBoth(engine);
      expect(engine.getState()).toMatchObject({ selected: 2, canUndo: false, canRedo: false });
      engine.align("left");
      settle();
      expect(engine.getState()).toMatchObject({ canUndo: true, canRedo: false });

      expect(engine.undo()).toBe(true);
      settle();
      expect(at(agent)).toEqual({ x: 310, y: 14 });
      expect(at(origin)).toEqual({ x: 0, y: 30 });
      // 撤销后回到“没有手动位置”，持久化的位置也一并清掉。
      expect(localStorage.getItem(POSITIONS_KEY)).toBeNull();
      expect(engine.getState()).toMatchObject({ canUndo: false, canRedo: true });

      expect(engine.redo()).toBe(true);
      settle();
      expect(at(agent).x).toBe(0);
      expect(stored()["agent:one"]).toEqual({ x: 0, y: 14 });

      engine.undo();
      settle();
      engine.align("right");
      expect(engine.getState().canRedo).toBe(false);
      expect(engine.redo()).toBe(false);
    } finally {
      engine.unmount();
    }
  });

  it("records drags, so one undo puts the dragged node back", () => {
    const { engine, viewport, agent } = mountPair();
    try {
      pointer(agent, "pointerdown", 400, 300);
      pointer(viewport, "pointermove", 475, 345);
      pointer(viewport, "pointerup", 475, 345);
      settle();
      expect(at(agent)).not.toEqual({ x: 310, y: 14 });
      expect(engine.getState().canUndo).toBe(true);
      engine.undo();
      settle();
      expect(at(agent)).toEqual({ x: 310, y: 14 });
      expect(localStorage.getItem(POSITIONS_KEY)).toBeNull();
    } finally {
      engine.unmount();
    }
  });

  it("merges rapid keyboard nudges into one history step but not slow ones", () => {
    const { engine, agent } = mountPair();
    try {
      engine.moveNode("agent:one", 10, 0);
      engine.moveNode("agent:one", 10, 0);
      engine.moveNode("agent:one", 10, 0);
      expect(at(agent).x).toBe(340);
      engine.undo();
      settle();
      expect(at(agent).x).toBe(310);
      expect(engine.getState().canUndo).toBe(false);

      engine.redo();
      settle();
      vi.advanceTimersByTime(1500);
      engine.moveNode("agent:one", 10, 0);
      engine.undo();
      settle();
      // 隔了一阵再按方向键是另一步：只退回最后这一下。
      expect(at(agent).x).toBe(340);
      expect(engine.getState().canUndo).toBe(true);
    } finally {
      engine.unmount();
    }
  });

  it("makes “reset layout” undoable", () => {
    const { engine, agent } = mountPair();
    try {
      engine.moveNode("agent:one", 40, 0);
      vi.advanceTimersByTime(1500);
      engine.resetLayout();
      settle();
      expect(at(agent)).toEqual({ x: 310, y: 14 });
      expect(localStorage.getItem(POSITIONS_KEY)).toBeNull();
      engine.undo();
      settle();
      expect(at(agent).x).toBe(350);
      expect(stored()["agent:one"]?.x).toBe(350);
    } finally {
      engine.unmount();
    }
  });

  it("keeps at most 100 history steps", () => {
    const { engine, agent } = mountPair();
    try {
      for (let i = 0; i < 105; i++) {
        engine.moveNode("agent:one", 1, 0);
        vi.advanceTimersByTime(1100);
      }
      let steps = 0;
      while (engine.undo()) steps++;
      settle();
      expect(steps).toBe(100);
      expect(at(agent).x).toBe(310 + 5);
    } finally {
      engine.unmount();
    }
  });
});
