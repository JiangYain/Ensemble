import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { at, mountPair, mountScene, node, pairLayout, POSITIONS_KEY, pointer, sceneOf, selectBoth, stored } from "./engine.fixtures";

describe("canvas node movement", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => { document.body.replaceChildren(); localStorage.clear(); });

  it("drags a node, updates its connection, preserves it on relayout, and suppresses the drag click", () => {
    const { engine, viewport, agent, tube } = mountPair();
    try {
      const before = agent.style.translate;
      const pipe = tube.querySelector("path")!;
      const oldPath = pipe.getAttribute("d");
      const click = vi.fn();
      agent.addEventListener("click", click);
      pointer(agent, "pointerdown", 400, 300);
      pointer(viewport, "pointermove", 475, 345);
      pointer(viewport, "pointerup", 475, 345);
      agent.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(agent.style.translate).not.toBe(before);
      expect(pipe.getAttribute("d")).not.toBe(oldPath);
      expect(click).not.toHaveBeenCalled();
      const moved = agent.style.translate;
      engine.setLayout(pairLayout);
      expect(agent.style.translate).toBe(moved);
    } finally {
      engine.unmount();
    }
  });

  it("restores dragged positions on the next visit and resets them on request", () => {
    const first = mountPair();
    pointer(first.agent, "pointerdown", 400, 300);
    pointer(first.viewport, "pointermove", 480, 360);
    pointer(first.viewport, "pointerup", 480, 360);
    const moved = first.agent.style.translate;
    first.dispose();

    const second = mountPair();
    try {
      expect(second.agent.style.translate).toBe(moved);
      second.engine.resetLayout();
      // The node can animate back, but its stored position is cleared immediately.
      expect(localStorage.getItem("ensemble.canvas.positions.v1")).toBeNull();
    } finally {
      second.engine.unmount();
    }
  });

  it("box-selects nodes with Shift and drags the selected nodes together", () => {
    const { engine, viewport, origin, agent, tube } = mountPair();
    try {
      origin.getBoundingClientRect = () => DOMRect.fromRect({ x: 100, y: 100, width: 100, height: 80 });
      agent.getBoundingClientRect = () => DOMRect.fromRect({ x: 300, y: 100, width: 100, height: 80 });
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true }));
      expect(viewport.dataset.tool).toBe("select");
      pointer(viewport, "pointerdown", 80, 80, { shiftKey: true });
      pointer(viewport, "pointermove", 420, 200, { shiftKey: true });
      expect(origin.hasAttribute("data-selected")).toBe(true);
      expect(agent.hasAttribute("data-selected")).toBe(true);
      pointer(viewport, "pointerup", 420, 200, { shiftKey: true });
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift" }));
      expect(viewport.dataset.tool).toBeUndefined();

      const originBefore = origin.style.translate;
      const agentBefore = agent.style.translate;
      const oldPath = tube.querySelector("path")?.getAttribute("d");
      pointer(agent, "pointerdown", 320, 120);
      pointer(viewport, "pointermove", 380, 150);
      pointer(viewport, "pointerup", 380, 150);
      expect(origin.style.translate).not.toBe(originBefore);
      expect(agent.style.translate).not.toBe(agentBefore);
      const coordinates = (value: string): number[] => value.split(" ").map((part) => Number.parseFloat(part));
      const [originX, originY] = coordinates(origin.style.translate);
      const [agentX, agentY] = coordinates(agent.style.translate);
      const [oldOriginX, oldOriginY] = coordinates(originBefore);
      const [oldAgentX, oldAgentY] = coordinates(agentBefore);
      expect(originX! - oldOriginX!).toBeCloseTo(agentX! - oldAgentX!);
      expect(originY! - oldOriginY!).toBeCloseTo(agentY! - oldAgentY!);
      expect(tube.querySelector("path")?.getAttribute("d")).not.toBe(oldPath);
      const saved = JSON.parse(localStorage.getItem("ensemble.canvas.positions.v1") ?? "{}");
      expect(Object.keys(saved).sort()).toEqual(["agent:one", "origin:one"]);
      engine.clearSelection();
      expect(origin.hasAttribute("data-selected")).toBe(false);
      expect(agent.hasAttribute("data-selected")).toBe(false);
    } finally {
      engine.unmount();
    }
  });

  it("Shift-click toggles selection without opening the node", () => {
    const { engine, viewport, origin, agent } = mountPair();
    const click = vi.fn();
    agent.addEventListener("click", click);
    try {
      pointer(agent, "pointerdown", 320, 120, { shiftKey: true });
      pointer(agent, "pointerup", 320, 120, { shiftKey: true });
      agent.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }));
      expect(agent.hasAttribute("data-selected")).toBe(true);
      expect(click).not.toHaveBeenCalled();
      pointer(origin, "pointerdown", 120, 120, { shiftKey: true });
      pointer(origin, "pointerup", 120, 120, { shiftKey: true });
      origin.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }));
      expect(origin.hasAttribute("data-selected")).toBe(true);
      pointer(agent, "pointerdown", 320, 120, { shiftKey: true });
      pointer(agent, "pointerup", 320, 120, { shiftKey: true });
      agent.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }));
      expect(agent.hasAttribute("data-selected")).toBe(false);
      pointer(viewport, "pointerdown", 20, 20);
      expect(origin.hasAttribute("data-selected")).toBe(false);
    } finally {
      engine.unmount();
    }
  });

  it("cancels a box selection on focus loss and restores the original selection", () => {
    const { engine, viewport, origin, agent } = mountPair();
    try {
      origin.getBoundingClientRect = () => DOMRect.fromRect({ x: 100, y: 100, width: 100, height: 80 });
      agent.getBoundingClientRect = () => DOMRect.fromRect({ x: 300, y: 100, width: 100, height: 80 });
      engine.toggleSelection("agent:one");
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true }));
      pointer(viewport, "pointerdown", 80, 80, { shiftKey: true });
      pointer(viewport, "pointermove", 220, 200, { shiftKey: true });
      expect(origin.hasAttribute("data-selected")).toBe(true);
      window.dispatchEvent(new Event("blur"));
      expect(origin.hasAttribute("data-selected")).toBe(false);
      expect(agent.hasAttribute("data-selected")).toBe(true);
      expect(viewport.dataset.tool).toBeUndefined();
      expect(viewport.querySelector<HTMLElement>(".scene-selection")?.hidden).toBe(true);
    } finally {
      engine.unmount();
    }
  });

  it("moves a selected group with keyboard movement and keeps touch panning on the background", () => {
    const { engine, viewport, origin, agent } = mountPair();
    try {
      engine.toggleSelection("origin:one");
      engine.toggleSelection("agent:one");
      const originBefore = Number.parseFloat(origin.style.translate);
      const agentBefore = Number.parseFloat(agent.style.translate);
      engine.moveNode("agent:one", 10, 0);
      expect(Number.parseFloat(origin.style.translate)).toBeCloseTo(originBefore + 10);
      expect(Number.parseFloat(agent.style.translate)).toBeCloseTo(agentBefore + 10);
      const camera = { ...engine.getCamera() };
      pointer(viewport, "pointerdown", 100, 100, { pointerType: "touch" });
      pointer(viewport, "pointermove", 130, 120, { pointerType: "touch" });
      pointer(viewport, "pointerup", 130, 120, { pointerType: "touch" });
      expect(engine.getCamera().x).toBeCloseTo(camera.x + 30);
    } finally {
      engine.unmount();
    }
  });

  it("finishes a pointer gesture released outside the canvas", () => {
    const { engine, viewport, agent } = mountPair();
    try {
      pointer(agent, "pointerdown", 320, 120);
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, button: 0, clientX: 320, clientY: 120 }));
      const before = agent.style.translate;
      pointer(agent, "pointerdown", 320, 120);
      pointer(viewport, "pointermove", 360, 140);
      pointer(viewport, "pointerup", 360, 140);
      expect(agent.style.translate).not.toBe(before);
    } finally {
      engine.unmount();
    }
  });
});

describe("canvas selection, alignment and distribution", () => {
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

  it("aligns the selection to the group's edge, pins every selected node and moves the pipe with it", () => {
    const { engine, origin, agent, tube } = mountPair();
    try {
      selectBoth(engine);
      const oldPath = tube.querySelector("path")!.getAttribute("d");
      expect(engine.align("left")).toBe(true);
      settle();
      expect(at(origin)).toEqual({ x: 0, y: 30 });
      expect(at(agent)).toEqual({ x: 0, y: 14 });
      // origin 本来就在最左，也要固定住：之后重新布局不会把它排走。
      expect(stored()).toEqual({ "origin:one": { x: 0, y: 30 }, "agent:one": { x: 0, y: 14 } });
      expect(tube.querySelector("path")!.getAttribute("d")).not.toBe(oldPath);

      engine.setLayout({ ...pairLayout, nodes: pairLayout.nodes.map((placed) => ({ ...placed, x: placed.x + 50 })) });
      settle();
      expect(at(agent)).toEqual({ x: 0, y: 14 });
    } finally {
      engine.unmount();
    }
  });

  it("right alignment uses each node's own width", () => {
    const { engine, origin, agent } = mountPair();
    try {
      selectBoth(engine);
      // 外框 0..558：origin(212 宽)落在 346，agent(248 宽)本来就贴着右缘。
      expect(engine.align("right")).toBe(true);
      settle();
      expect(at(origin).x).toBe(346);
      expect(at(agent).x).toBe(310);
    } finally {
      engine.unmount();
    }
  });

  it("horizontal-center alignment puts both centers on the group's midline", () => {
    const { engine, origin, agent } = mountPair();
    try {
      selectBoth(engine);
      // 外框 0..558，中线 279。
      expect(engine.align("hcenter")).toBe(true);
      settle();
      expect(at(origin).x + 212 / 2).toBe(279);
      expect(at(agent).x + 248 / 2).toBe(279);
      // 再来一次：基准是现在的外框，而且已经居中，不会再动。
      expect(engine.align("hcenter")).toBe(false);
    } finally {
      engine.unmount();
    }
  });

  it("top and bottom alignment move nodes vertically only", () => {
    const { engine, origin, agent } = mountPair();
    try {
      selectBoth(engine);
      expect(engine.align("bottom")).toBe(true);
      settle();
      // 外框 y：14..158。
      expect(at(origin).y + 112).toBe(158);
      expect(at(agent).y + 144).toBe(158);
      expect(at(agent).x).toBe(310);
      expect(engine.align("top")).toBe(true);
      settle();
      expect(at(origin).y).toBe(14);
      expect(at(agent).y).toBe(14);
    } finally {
      engine.unmount();
    }
  });

  it("returns false and records nothing when the selection is already aligned or too small", () => {
    const { engine } = mountPair();
    try {
      engine.toggleSelection("agent:one");
      expect(engine.align("left")).toBe(false);
      selectBoth(engine);
      // 这组布局本来就是垂直居中的。
      expect(engine.align("vmiddle")).toBe(false);
      expect(localStorage.getItem(POSITIONS_KEY)).toBeNull();
      expect(engine.getState().canUndo).toBe(false);
    } finally {
      engine.unmount();
    }
  });

  it("distributes at least three nodes with equal gaps, keeping the outer edges", () => {
    // 一排没有连线的节点：分布要多于两个才有“中间的”。
    const { engine, els } = mountScene(
      sceneOf([node("a", 0, 0, { w: 100, h: 40 }), node("b", 150, 10, { w: 60, h: 40 }), node("c", 400, 0, { w: 100, h: 40 })]),
    );
    try {
      engine.toggleSelection("a");
      engine.toggleSelection("b");
      expect(engine.distribute("horizontal")).toBe(false);
      engine.toggleSelection("c");
      expect(engine.distribute("horizontal")).toBe(true);
      settle();
      expect(at(els.get("a")!)).toEqual({ x: 0, y: 0 });
      expect(at(els.get("b")!)).toEqual({ x: 220, y: 10 });
      expect(at(els.get("c")!)).toEqual({ x: 400, y: 0 });
      // 已经等距时再来一次什么也不做。
      expect(engine.distribute("horizontal")).toBe(false);
    } finally {
      engine.unmount();
    }
  });

  it("selects every placed node, reports state changes to subscribers, and keeps the state object stable otherwise", () => {
    const { engine } = mountPair();
    try {
      const listener = vi.fn();
      const unsubscribe = engine.subscribe(listener);
      const idle = engine.getState();
      expect(idle.selected).toBe(0);
      engine.selectAll();
      expect(engine.getState().selected).toBe(2);
      expect(listener).toHaveBeenCalledTimes(1);
      engine.selectAll();
      expect(listener).toHaveBeenCalledTimes(1);
      engine.clearSelection();
      expect(engine.getState().selected).toBe(0);
      expect(listener).toHaveBeenCalledTimes(2);
      unsubscribe();
      engine.selectAll();
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      engine.unmount();
    }
  });

  it("refuses to arrange or undo while a node is being dragged", () => {
    const { engine, viewport, agent, origin } = mountPair();
    try {
      selectBoth(engine);
      pointer(agent, "pointerdown", 400, 300);
      pointer(viewport, "pointermove", 475, 345);
      expect(engine.align("left")).toBe(false);
      expect(engine.undo()).toBe(false);
      pointer(viewport, "pointerup", 475, 345);
      settle();
      expect(at(origin).x).not.toBe(0);
    } finally {
      engine.unmount();
    }
  });
});
