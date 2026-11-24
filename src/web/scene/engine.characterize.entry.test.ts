import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { worldCamera } from "./engine-characterize.fixtures";
import { at, mountPair, pointer, selectBoth, stored } from "./engine.fixtures";

/**
 * 特征化测试（补洞）：几个入口上的小角落——键盘微调从哪里起算、还没落位的节点、菜单里的按下。
 * 拆分之前的实现里这几条没有测试守着，是拆分之后补跑单行变异时才暴露的（见 HARDEN-E 报告）。数值是未改动的引擎跑出来的结果。
 */
describe("canvas entry points, the remaining corners", () => {
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

  it("nudges a node from where it is right now, not from where it is heading", () => {
    const { engine, agent } = mountPair();
    try {
      vi.advanceTimersByTime(16);
      selectBoth(engine);
      expect(engine.align("left")).toBe(true);
      // 向左对齐：agent 从 310 走向 0；飞到一半时用键盘微调 10px。
      vi.advanceTimersByTime(48);
      const flying = at(agent).x;
      expect(flying).toBeGreaterThan(100);
      expect(flying).toBeLessThan(300);
      engine.clearSelection();
      engine.moveNode("agent:one", 10, 0);
      expect(at(agent).x).toBeCloseTo(flying + 10, 1);
      expect(stored()["agent:one"]!.x).toBeCloseTo(flying + 10, 1);
      expect(stored()["agent:one"]!.y).toBe(14);
    } finally {
      engine.unmount();
    }
  });

  it("ignores moveNode for a node that has an element but no place on the canvas yet", () => {
    const rig = mountPair();
    const { engine } = rig;
    try {
      rig.attach("agent:late");
      engine.moveNode("agent:late", 10, 0);
      expect(engine.getSelectedIds()).toEqual([]);
      expect(engine.getState()).toEqual({ selected: 0, canUndo: false, canRedo: false });
      expect(stored()).toEqual({});
      // 对照：落了位的节点照常被选中、被挪动。
      engine.moveNode("agent:one", 10, 0);
      expect(engine.getSelectedIds()).toEqual(["agent:one"]);
      expect(stored()).toEqual({ "agent:one": { x: 320, y: 14 } });
    } finally {
      engine.unmount();
    }
  });

  it("leaves pointerdowns inside a menu to the menu: the selection stays and no pan starts", () => {
    const { engine, viewport, world } = mountPair();
    try {
      const menu = document.createElement("div");
      menu.setAttribute("role", "menu");
      const item = document.createElement("span");
      menu.append(item);
      viewport.append(menu);
      selectBoth(engine);
      // 空白处的普通按下会清掉选中；菜单里的按下归菜单。
      pointer(item, "pointerdown", 100, 100);
      expect(engine.getSelectedIds()).toEqual(["origin:one", "agent:one"]);
      pointer(item, "pointerup", 100, 100);
      pointer(item, "pointerdown", 100, 100, { ctrlKey: true });
      pointer(viewport, "pointermove", 160, 130, { ctrlKey: true });
      expect(viewport.dataset["panning"]).toBeUndefined();
      expect(worldCamera(world)).toEqual({ x: 321, y: 345, k: 1 });
      pointer(viewport, "pointerup", 160, 130, { ctrlKey: true });
      // 对照：同样的按下落在空白画布上，选中被清掉。
      pointer(viewport, "pointerdown", 100, 100);
      expect(engine.getSelectedIds()).toEqual([]);
    } finally {
      engine.unmount();
    }
  });
});
