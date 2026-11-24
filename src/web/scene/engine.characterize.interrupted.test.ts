import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { key, worldCamera } from "./engine-characterize.fixtures";
import { at, mountPair, pointer, stored } from "./engine.fixtures";

/**
 * 特征化测试（补洞）：拖动节点的途中被打断——指针取消、画布卸载——以及卸载之后手势状态（按住的空格）不残留；
 * 另外钉住“拖动之后吞掉的那一次点击”只活到下一个定时器回合（0ms），不是再晚一毫秒。
 * 打断一律是“就地放下”：节点留在被拖到的地方，存进 localStorage，记进撤销历史（与窗口失焦时一样），并且不吞下一次点击。
 * 拆分之前的实现里只有失焦这一种打断有测试守着，其余是拆分之后补跑单行变异时才暴露的（见 HARDEN-E 报告）。数值是未改动的引擎跑出来的结果。
 */
describe("canvas gestures that are cut short", () => {
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

  const click = (target: Element): MouseEvent => {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };

  it("puts a dragged node down where it is on pointercancel, saves and records it, and leaves the next click alone", () => {
    const { engine, viewport, agent } = mountPair();
    const release = vi.spyOn(viewport, "releasePointerCapture");
    try {
      pointer(agent, "pointerdown", 400, 300);
      pointer(viewport, "pointermove", 450, 300);
      expect(agent.dataset["dragging"]).toBe("");
      expect(viewport.dataset["moving"]).toBe("");
      expect(at(agent)).toEqual({ x: 360, y: 14 });
      expect(stored()).toEqual({});
      expect(engine.getState()).toEqual({ selected: 1, canUndo: false, canRedo: false });
      // 别的指针取消不算：手里的节点还在手里。
      pointer(viewport, "pointercancel", 450, 300, { pointerId: 2 });
      expect(agent.dataset["dragging"]).toBe("");
      expect(viewport.dataset["moving"]).toBe("");
      expect(release).not.toHaveBeenCalled();
      expect(stored()).toEqual({});
      pointer(viewport, "pointercancel", 450, 300);
      expect(agent.dataset["dragging"]).toBeUndefined();
      expect(viewport.dataset["moving"]).toBeUndefined();
      expect(release.mock.calls).toEqual([[1]]);
      expect(at(agent)).toEqual({ x: 360, y: 14 });
      expect(stored()).toEqual({ "agent:one": { x: 360, y: 14 } });
      expect(engine.getState()).toEqual({ selected: 1, canUndo: true, canRedo: false });
      // 取消不是抬起：不吞随后的点击；手已经放下，之后的移动不再拖节点。
      expect(click(agent).defaultPrevented).toBe(false);
      pointer(viewport, "pointermove", 520, 340);
      expect(at(agent)).toEqual({ x: 360, y: 14 });
      // 记进了历史：撤销回到布局给的位置，手动位置也一并清掉。
      expect(engine.undo()).toBe(true);
      settle();
      expect(at(agent)).toEqual({ x: 310, y: 14 });
      expect(stored()).toEqual({});
    } finally {
      engine.unmount();
    }
  });

  it("puts a dragged node down where it is when the canvas unmounts, saves and records it, and a pointerup that comes later does nothing", () => {
    const { engine, viewport, world, tube, dots, agent } = mountPair();
    const release = vi.spyOn(viewport, "releasePointerCapture");
    pointer(agent, "pointerdown", 400, 300);
    pointer(viewport, "pointermove", 450, 300);
    expect(agent.dataset["dragging"]).toBe("");
    expect(viewport.dataset["moving"]).toBe("");
    engine.unmount();
    expect(agent.dataset["dragging"]).toBeUndefined();
    expect(viewport.dataset["moving"]).toBeUndefined();
    expect(release.mock.calls).toEqual([[1]]);
    expect(at(agent)).toEqual({ x: 360, y: 14 });
    expect(stored()).toEqual({ "agent:one": { x: 360, y: 14 } });
    expect(engine.getState()).toEqual({ selected: 0, canUndo: true, canRedo: false });
    // 监听已经摘掉：随后到的 pointermove / pointerup / click 都不再与引擎有关。
    pointer(viewport, "pointermove", 500, 340);
    pointer(viewport, "pointerup", 500, 340);
    expect(at(agent)).toEqual({ x: 360, y: 14 });
    expect(release.mock.calls).toEqual([[1]]);
    expect(click(agent).defaultPrevented).toBe(false);
    // 再挂载：位置与历史都还在。
    engine.mount({ viewport, world, pipes: { tube, dots } });
    try {
      expect(at(agent)).toEqual({ x: 360, y: 14 });
      expect(engine.getState()).toEqual({ selected: 0, canUndo: true, canRedo: false });
      expect(engine.undo()).toBe(true);
      settle();
      expect(at(agent)).toEqual({ x: 310, y: 14 });
    } finally {
      engine.unmount();
    }
  });

  it("forgets a held Space key when the canvas unmounts: after the next mount the plain tool is back and a drag does not pan", () => {
    const { engine, viewport, world, tube, dots } = mountPair();
    try {
      key("keydown", { key: " ", code: "Space" });
      expect(viewport.dataset["tool"]).toBe("pan");
      engine.unmount();
      expect(viewport.dataset["tool"]).toBeUndefined();
      engine.mount({ viewport, world, pipes: { tube, dots } });
      // 随便一个键的事件都会按“此刻按住了什么”刷新当前工具：空格是挂载之前按下的，不该还算数。
      key("keydown", { key: "a", code: "KeyA" });
      expect(viewport.dataset["tool"]).toBeUndefined();
      pointer(viewport, "pointerdown", 100, 100);
      pointer(viewport, "pointermove", 160, 130);
      expect(viewport.dataset["panning"]).toBeUndefined();
      expect(worldCamera(world)).toEqual({ x: 321, y: 345, k: 1 });
      pointer(viewport, "pointerup", 160, 130);
    } finally {
      engine.unmount();
    }
  });

  it("lets a click through again in the very next timer turn after a drag (0ms), not a millisecond later", () => {
    const { engine, viewport, agent } = mountPair();
    try {
      pointer(agent, "pointerdown", 400, 300);
      pointer(viewport, "pointermove", 450, 300);
      pointer(viewport, "pointerup", 450, 300);
      vi.advanceTimersByTime(0);
      expect(click(agent).defaultPrevented).toBe(false);
      // 对照：同一回合里的点击仍被吞掉，而且只吞一次。
      pointer(agent, "pointerdown", 400, 300);
      pointer(viewport, "pointermove", 450, 300);
      pointer(viewport, "pointerup", 450, 300);
      expect(click(agent).defaultPrevented).toBe(true);
      expect(click(agent).defaultPrevented).toBe(false);
    } finally {
      engine.unmount();
    }
  });
});
