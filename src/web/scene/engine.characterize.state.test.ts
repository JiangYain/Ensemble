import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SceneEngine } from "./engine";
import { at, edge, mountPair, node, origin, sceneOf, selectBoth } from "./engine.fixtures";

/**
 * 特征化测试：引擎对外的形状（成员的名字、种类、参数个数、引用是否稳定）、选中接口、登记、订阅与排布缩放。
 * 拆分引擎之前在旧实现上跑绿，拆分之后必须仍然全绿。
 */
describe("engine surface", () => {
  const METHODS: Readonly<Record<string, number>> = {
    mount: 1,
    unmount: 0,
    register: 2,
    switchSpace: 1,
    setLayout: 1,
    moveNode: 3,
    toggleSelection: 1,
    clearSelection: 0,
    selectAll: 0,
    onNodeContext: 1,
    align: 1,
    distribute: 1,
    undo: 0,
    redo: 0,
    resetLayout: 0,
    getCamera: 0,
    isUserMoved: 0,
    fit: 0,
    zoomBy: 1,
  };
  const ARROWS: Readonly<Record<string, number>> = {
    subscribe: 1,
    getState: 0,
    getSelectedIds: 0,
    subscribeSelection: 1,
    getFill: 1,
    subscribeFill: 1,
  };

  it("exposes the public methods on the prototype with their arity", () => {
    const engine = new SceneEngine();
    for (const [name, arity] of Object.entries(METHODS)) {
      const member: unknown = Reflect.get(SceneEngine.prototype, name);
      expect(typeof member, name).toBe("function");
      expect((member as { length: number }).length, name).toBe(arity);
      expect(Object.hasOwn(engine, name), name).toBe(false);
    }
  });

  it("exposes the subscription accessors as own arrow properties that work detached", () => {
    const engine = new SceneEngine();
    for (const [name, arity] of Object.entries(ARROWS)) {
      const member: unknown = Reflect.get(engine, name);
      expect(Object.hasOwn(engine, name), name).toBe(true);
      expect(typeof member, name).toBe("function");
      expect((member as { length: number }).length, name).toBe(arity);
      expect(Reflect.get(engine, name), name).toBe(member);
      expect(Reflect.has(SceneEngine.prototype, name), name).toBe(false);
    }
    const { getState, getSelectedIds, getFill, subscribe, subscribeSelection, subscribeFill } = engine;
    expect(getState()).toBe(engine.getState());
    expect(getSelectedIds()).toBe(engine.getSelectedIds());
    expect(getFill("all")).toBeUndefined();
    for (const subscribeTo of [subscribe, subscribeSelection, subscribeFill]) {
      const stop = subscribeTo(() => {});
      expect(typeof stop).toBe("function");
      stop();
    }
  });

  it("has a stable arrivals object and the selection member the component tests reach for", () => {
    const { engine } = mountPair();
    try {
      expect(Object.hasOwn(engine, "arrivals")).toBe(true);
      expect(engine.arrivals).toBe(engine.arrivals);
      expect(typeof engine.arrivals.getHints).toBe("function");
      expect(typeof engine.arrivals.subscribe).toBe("function");
      const reach = engine as unknown as { selection: { replace(ids: string[]): void } };
      expect(typeof reach.selection.replace).toBe("function");
      reach.selection.replace(["agent:one"]);
      expect(engine.getSelectedIds()).toEqual(["agent:one"]);
      expect(engine.getState().selected).toBe(1);
    } finally {
      engine.unmount();
    }
  });

  it("exports the engine class only as a runtime value", async () => {
    const exported = await import("./engine");
    expect(Object.keys(exported)).toEqual(["SceneEngine"]);
  });

  it("hands back the same state object until something changes", () => {
    const { engine } = mountPair();
    try {
      const first = engine.getState();
      engine.clearSelection();
      expect(engine.getState()).toBe(first);
      engine.toggleSelection("agent:one");
      const second = engine.getState();
      expect(second).not.toBe(first);
      expect(second).toEqual({ selected: 1, canUndo: false, canRedo: false });
      expect(engine.getState()).toBe(second);
    } finally {
      engine.unmount();
    }
  });
});

describe("engine selection and registration", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    localStorage.clear();
  });

  it("selects every placed node that has an element, in registration order", () => {
    const rig = mountPair();
    try {
      rig.engine.setLayout(sceneOf([origin("origin:one", 0, 30), node("agent:one", 310, 14, { w: 248, h: 144 }), node("agent:bare", 700, 14)], [edge("origin:one", "agent:one")]));
      rig.engine.register("agent:unplaced", document.createElement("div"));
      rig.engine.selectAll();
      expect(rig.engine.getSelectedIds()).toEqual(["origin:one", "agent:one"]);
      expect(rig.engine.getState().selected).toBe(2);
      expect(rig.origin.hasAttribute("data-selected")).toBe(true);
      expect(rig.agent.hasAttribute("data-selected")).toBe(true);
      const same = rig.engine.getSelectedIds();
      rig.engine.selectAll();
      expect(rig.engine.getSelectedIds()).toBe(same);
    } finally {
      rig.engine.unmount();
    }
  });

  it("toggles placed nodes only, element or not, and ignores the ones it does not know", () => {
    const rig = mountPair();
    try {
      rig.engine.setLayout(sceneOf([origin("origin:one", 0, 30), node("agent:one", 310, 14, { w: 248, h: 144 }), node("agent:bare", 700, 14)], [edge("origin:one", "agent:one")]));
      rig.engine.toggleSelection("agent:bare");
      expect(rig.engine.getSelectedIds()).toEqual(["agent:bare"]);
      rig.engine.toggleSelection("nope");
      rig.engine.register("agent:unplaced", document.createElement("div"));
      rig.engine.toggleSelection("agent:unplaced");
      expect(rig.engine.getSelectedIds()).toEqual(["agent:bare"]);
      rig.engine.toggleSelection("agent:one");
      expect(rig.engine.getSelectedIds()).toEqual(["agent:bare", "agent:one"]);
      rig.engine.toggleSelection("agent:bare");
      expect(rig.engine.getSelectedIds()).toEqual(["agent:one"]);
      rig.engine.clearSelection();
      expect(rig.engine.getSelectedIds()).toEqual([]);
      expect(rig.agent.hasAttribute("data-selected")).toBe(false);
    } finally {
      rig.engine.unmount();
    }
  });

  it("drops the selection of nodes that left the layout", () => {
    const rig = mountPair();
    try {
      selectBoth(rig.engine);
      rig.engine.setLayout(sceneOf([origin("origin:one", 0, 30)]));
      expect(rig.engine.getSelectedIds()).toEqual(["origin:one"]);
      expect(rig.engine.getState().selected).toBe(1);
    } finally {
      rig.engine.unmount();
    }
  });

  it("marks, positions and releases the elements it is handed", () => {
    const rig = mountPair();
    try {
      rig.engine.toggleSelection("agent:one");
      const replacement = document.createElement("div");
      const release = rig.engine.register("agent:one", replacement);
      expect(replacement.hasAttribute("data-selected")).toBe(true);
      expect(at(replacement)).toEqual({ x: 310, y: 14 });
      // 旧元素的注销不能把新元素摘掉。
      rig.releases.get("agent:one")!();
      rig.engine.selectAll();
      expect(rig.engine.getSelectedIds()).toEqual(["origin:one", "agent:one"]);
      release();
      rig.engine.selectAll();
      expect(rig.engine.getSelectedIds()).toEqual(["origin:one"]);
      // 节点还在布局里：没有元素也还能点选。
      rig.engine.toggleSelection("agent:one");
      expect(rig.engine.getSelectedIds()).toEqual(["origin:one", "agent:one"]);
    } finally {
      rig.engine.unmount();
    }
  });

  it("registers elements before it is mounted, and places them when the layout arrives", () => {
    const engine = new SceneEngine();
    const el = document.createElement("div");
    engine.register("agent:early", el);
    expect(el.style.translate).toBe("");
    engine.setLayout(sceneOf([node("agent:early", 40, 50)]));
    expect(el.style.translate).toBe("");
    expect(engine.getState()).toEqual({ selected: 0, canUndo: false, canRedo: false });
    const viewport = document.createElement("div");
    const world = document.createElement("div");
    const tube = document.createElementNS("http://www.w3.org/2000/svg", "g");
    const dots = document.createElementNS("http://www.w3.org/2000/svg", "g");
    Object.defineProperties(viewport, { clientWidth: { value: 1200, configurable: true }, clientHeight: { value: 800, configurable: true } });
    document.body.append(viewport);
    engine.mount({ viewport, world, pipes: { tube, dots } });
    try {
      expect(at(el)).toEqual({ x: 40, y: 50 });
      expect(engine.getCamera().k).toBe(1);
    } finally {
      engine.unmount();
    }
  });
});

describe("engine subscriptions", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    localStorage.clear();
  });

  it("notifies state listeners only when the state really changed, and from a snapshot of them", () => {
    const { engine } = mountPair();
    try {
      const seen: string[] = [];
      let stopSecond: () => void = () => {};
      let stopThird: () => void = () => {};
      const first = (): void => {
        seen.push("first");
        stopSecond();
        stopThird = engine.subscribe(third);
      };
      const second = (): void => {
        seen.push("second");
      };
      const third = (): void => {
        seen.push("third");
      };
      engine.subscribe(first);
      stopSecond = engine.subscribe(second);
      engine.toggleSelection("agent:one");
      expect(seen).toEqual(["first", "second"]);
      engine.clearSelection();
      expect(seen).toEqual(["first", "second", "first", "third"]);
      // 退订之后同一轮里不会再被叫到；`first` 又把它订了回来，下一轮才轮到它。
      stopThird();
      engine.toggleSelection("agent:one");
      expect(seen).toEqual(["first", "second", "first", "third", "first"]);
      // 同一个函数订阅两次只算一次，退订一次就没了。
      const once = vi.fn();
      const stop = engine.subscribe(once);
      engine.subscribe(once);
      engine.clearSelection();
      expect(once).toHaveBeenCalledTimes(1);
      stop();
      engine.toggleSelection("agent:one");
      expect(once).toHaveBeenCalledTimes(1);
    } finally {
      engine.unmount();
    }
  });

  it("notifies selection listeners when the members change even though the count does not", () => {
    const { engine } = mountPair();
    try {
      const members = vi.fn();
      const counts = vi.fn();
      engine.subscribeSelection(members);
      engine.subscribe(counts);
      engine.toggleSelection("agent:one");
      engine.toggleSelection("agent:one");
      engine.toggleSelection("origin:one");
      expect(members).toHaveBeenCalledTimes(3);
      expect(counts).toHaveBeenCalledTimes(3);
      // 成员换了、数量没变：只有成员订阅被通知。
      const reach = engine as unknown as { selection: { replace(ids: string[]): void } };
      reach.selection.replace(["agent:one"]);
      expect(members).toHaveBeenCalledTimes(4);
      expect(counts).toHaveBeenCalledTimes(3);
      expect(engine.getSelectedIds()).toEqual(["agent:one"]);
    } finally {
      engine.unmount();
    }
  });

  it("iterates selection listeners from a snapshot too", () => {
    const { engine } = mountPair();
    try {
      const seen: string[] = [];
      let stopSecond: () => void = () => {};
      engine.subscribeSelection(() => {
        seen.push("first");
        stopSecond();
      });
      stopSecond = engine.subscribeSelection(() => seen.push("second"));
      engine.toggleSelection("agent:one");
      expect(seen).toEqual(["first", "second"]);
      engine.toggleSelection("agent:one");
      expect(seen).toEqual(["first", "second", "first"]);
    } finally {
      engine.unmount();
    }
  });
});

describe("engine fill (the layout zoom remembered by the reset)", () => {
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

  it("remembers the zoom a reset saw, per space, and tells the subscribers only when it changed", () => {
    const { engine } = mountPair();
    try {
      const seen = vi.fn();
      engine.subscribeFill(seen);
      expect(engine.getFill("all")).toBeUndefined();
      engine.zoomBy(1.2);
      settle();
      engine.resetLayout();
      expect(engine.getFill("all")).toBe(1.2);
      expect(seen).toHaveBeenCalledTimes(1);
      settle();
      engine.resetLayout();
      expect(seen).toHaveBeenCalledTimes(1);
      expect(engine.getFill("all")).toBe(1.2);
      engine.zoomBy(0.5);
      settle();
      engine.resetLayout();
      expect(engine.getFill("all")).toBeCloseTo(0.6, 12);
      expect(seen).toHaveBeenCalledTimes(2);
      engine.switchSpace("b");
      expect(engine.getFill("b")).toBeUndefined();
      engine.setLayout(sceneOf([origin("origin:one", 0, 30), node("agent:one", 310, 14, { w: 248, h: 144 })], [edge("origin:one", "agent:one")]));
      engine.resetLayout();
      expect(engine.getFill("b")).toBe(1);
      expect(engine.getFill("all")).toBeCloseTo(0.6, 12);
      expect(seen).toHaveBeenCalledTimes(3);
    } finally {
      engine.unmount();
    }
  });

  it("forgets the held arrangement before it tells the subscribers, so they get a full relayout", () => {
    const { engine, agent } = mountPair();
    try {
      engine.subscribeFill(() => {
        engine.setLayout(sceneOf([origin("origin:one", 0, 30), node("agent:one", 400, 14, { w: 248, h: 144 })], [edge("origin:one", "agent:one")]));
      });
      engine.resetLayout();
      settle();
      expect(at(agent)).toEqual({ x: 400, y: 14 });
    } finally {
      engine.unmount();
    }
  });

  it("iterates fill listeners from a snapshot and lets them unsubscribe", () => {
    const { engine } = mountPair();
    try {
      const seen: string[] = [];
      let stopSecond: () => void = () => {};
      engine.subscribeFill(() => {
        seen.push("first");
        stopSecond();
      });
      stopSecond = engine.subscribeFill(() => seen.push("second"));
      engine.zoomBy(1.2);
      settle();
      engine.resetLayout();
      expect(seen).toEqual(["first", "second"]);
      engine.zoomBy(1.2);
      settle();
      engine.resetLayout();
      expect(seen).toEqual(["first", "second", "first"]);
    } finally {
      engine.unmount();
    }
  });
});
