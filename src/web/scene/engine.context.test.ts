import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeContextRequest, SceneEngine } from "./engine";
import { mountScene, node, pointer, sceneOf } from "./engine.fixtures";

/** 一排没有连线的节点；每个节点是带 data-node-id 的元素，与页面上的真实节点一样。 */
function mountNodes(ids: readonly string[]) {
  const row = sceneOf(ids.map((id, index) => node(id, index * 300, 0, { w: 248 })));
  const rig = mountScene({ ...row, bounds: { x: 0, y: 0, w: 1000, h: 112 } });
  for (const el of rig.els.values()) el.tabIndex = 0;
  return rig;
}

function contextmenu(target: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 50, ...init });
  target.dispatchEvent(event);
  return event;
}

const IDS = ["agent:a", "agent:b", "agent:c", "origin:o"] as const;

describe("选中集合的 id 暴露", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
  });

  it("按选中的先后给出 id；集合不变时返回同一个数组，变了才换", () => {
    const { engine } = mountNodes(IDS);
    try {
      expect(engine.getSelectedIds()).toEqual([]);
      engine.toggleSelection("agent:b");
      engine.toggleSelection("agent:a");
      const ids = engine.getSelectedIds();
      expect(ids).toEqual(["agent:b", "agent:a"]);
      expect(engine.getSelectedIds()).toBe(ids);
      // 取消再选同一个：集合变了，数组是新的。
      engine.toggleSelection("agent:b");
      expect(engine.getSelectedIds()).toEqual(["agent:a"]);
      expect(engine.getSelectedIds()).not.toBe(ids);
      engine.clearSelection();
      expect(engine.getSelectedIds()).toEqual([]);
    } finally {
      engine.unmount();
    }
  });

  it("成员变了就通知订阅者，哪怕数量没变；数量与历史的订阅不受影响", () => {
    const { engine } = mountNodes(IDS);
    try {
      engine.toggleSelection("agent:a");
      engine.toggleSelection("agent:b");
      const onSelection = vi.fn();
      const onState = vi.fn();
      const offSelection = engine.subscribeSelection(onSelection);
      const offState = engine.subscribe(onState);

      // 换成同样数量、不同成员的集合（框选时一个节点出框、另一个入框就是这样）。
      (engine as unknown as { selection: { replace(ids: string[]): void } }).selection.replace(["agent:a", "agent:c"]);
      expect(engine.getSelectedIds()).toEqual(["agent:a", "agent:c"]);
      expect(onSelection).toHaveBeenCalledTimes(1);
      expect(onState).not.toHaveBeenCalled();
      expect(engine.getState().selected).toBe(2);

      engine.toggleSelection("agent:c");
      expect(onSelection).toHaveBeenCalledTimes(2);
      expect(onState).toHaveBeenCalledTimes(1);

      // 没有变化就不通知。
      engine.clearSelection();
      engine.clearSelection();
      expect(onSelection).toHaveBeenCalledTimes(3);

      offSelection();
      offState();
      engine.toggleSelection("agent:a");
      expect(onSelection).toHaveBeenCalledTimes(3);
    } finally {
      engine.unmount();
    }
  });

  it("画布卸载时选中清空并通知", () => {
    const { engine } = mountNodes(IDS);
    engine.toggleSelection("agent:a");
    const listener = vi.fn();
    engine.subscribeSelection(listener);
    engine.unmount();
    expect(engine.getSelectedIds()).toEqual([]);
    expect(listener).toHaveBeenCalled();
  });
});

describe("节点上的右键：目标判断与选择语义", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
  });

  const collect = (engine: SceneEngine, accept: boolean | ((request: NodeContextRequest) => boolean) = true) => {
    const requests: NodeContextRequest[] = [];
    const off = engine.onNodeContext((request) => {
      requests.push(request);
      return typeof accept === "function" ? accept(request) : accept;
    });
    return { requests, off };
  };

  it("没有多选时：菜单只作用于被点的节点，带着指针位置；处理者接管就拦下原生菜单，选中不动", () => {
    const { engine, els } = mountNodes(IDS);
    try {
      const { requests } = collect(engine);
      const event = contextmenu(els.get("agent:b")!, { clientX: 123, clientY: 77 });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ nodeId: "agent:b", scope: "node", ids: ["agent:b"], point: { x: 123, y: 77 } });
      expect(requests[0]!.el).toBe(els.get("agent:b"));
      expect(event.defaultPrevented).toBe(true);
      expect(engine.getSelectedIds()).toEqual([]);

      // 只选了一个、右键在另一个节点上：仍是单个节点，选中不动。
      engine.toggleSelection("agent:a");
      contextmenu(els.get("agent:c")!);
      expect(requests[1]).toMatchObject({ nodeId: "agent:c", scope: "node", ids: ["agent:c"] });
      expect(engine.getSelectedIds()).toEqual(["agent:a"]);
    } finally {
      engine.unmount();
    }
  });

  it("点到子元素（链接、按钮）也算点在节点上", () => {
    const { engine, els } = mountNodes(IDS);
    try {
      const link = document.createElement("a");
      const button = document.createElement("button");
      els.get("agent:a")!.append(link, button);
      const { requests } = collect(engine);
      expect(contextmenu(link).defaultPrevented).toBe(true);
      expect(contextmenu(button).defaultPrevented).toBe(true);
      expect(requests.map((request) => request.nodeId)).toEqual(["agent:a", "agent:a"]);
    } finally {
      engine.unmount();
    }
  });

  it("右键在“选中 ≥2 个”的集合里的任一节点（含非会话节点）上：作用于整个集合，选中不变", () => {
    const { engine, els } = mountNodes(IDS);
    try {
      engine.toggleSelection("agent:a");
      engine.toggleSelection("origin:o");
      engine.toggleSelection("agent:b");
      const before = engine.getSelectedIds();
      const { requests } = collect(engine);

      const onOrigin = contextmenu(els.get("origin:o")!);
      expect(requests[0]).toMatchObject({ nodeId: "origin:o", scope: "selection", ids: ["agent:a", "origin:o", "agent:b"] });
      expect(onOrigin.defaultPrevented).toBe(true);
      contextmenu(els.get("agent:a")!);
      expect(requests[1]).toMatchObject({ nodeId: "agent:a", scope: "selection" });
      expect(engine.getSelectedIds()).toBe(before);
    } finally {
      engine.unmount();
    }
  });

  it("右键在多选集合之外的节点上、处理者接管：选中集合变成它（菜单对象与高亮对象一致）", () => {
    const { engine, els } = mountNodes(IDS);
    try {
      engine.toggleSelection("agent:a");
      engine.toggleSelection("agent:b");
      collect(engine);
      const event = contextmenu(els.get("agent:c")!);
      expect(event.defaultPrevented).toBe(true);
      expect(engine.getSelectedIds()).toEqual(["agent:c"]);
      expect(els.get("agent:a")!.hasAttribute("data-selected")).toBe(false);
      expect(els.get("agent:c")!.hasAttribute("data-selected")).toBe(true);
    } finally {
      engine.unmount();
    }
  });

  it("处理者不接管（比如没有菜单的来源节点）：原生菜单照常出现，选中原样不动", () => {
    const { engine, els } = mountNodes(IDS);
    try {
      engine.toggleSelection("agent:a");
      engine.toggleSelection("agent:b");
      const before = engine.getSelectedIds();
      const { requests } = collect(engine, (request) => request.nodeId.startsWith("agent:"));
      const event = contextmenu(els.get("origin:o")!);
      expect(requests[0]).toMatchObject({ nodeId: "origin:o", scope: "node" });
      expect(event.defaultPrevented).toBe(false);
      expect(engine.getSelectedIds()).toBe(before);
    } finally {
      engine.unmount();
    }
  });

  it("没有处理者、画布空白处、注销之后、卸载之后：都不拦", () => {
    const { engine, viewport, els } = mountNodes(IDS);
    try {
      expect(contextmenu(els.get("agent:a")!).defaultPrevented).toBe(false);
      const { requests, off } = collect(engine);
      expect(contextmenu(viewport).defaultPrevented).toBe(false);
      expect(contextmenu(document.body).defaultPrevented).toBe(false);
      expect(requests).toHaveLength(0);
      off();
      expect(contextmenu(els.get("agent:a")!).defaultPrevented).toBe(false);
      expect(requests).toHaveLength(0);
      collect(engine);
      engine.unmount();
      expect(contextmenu(els.get("agent:a")!).defaultPrevented).toBe(false);
    } finally {
      engine.unmount();
    }
  });

  it("macOS 上 Ctrl+点击（button 0 + ctrlKey）是平移手势，不当右键；Windows 的 Ctrl+右键（button 2）仍是右键", () => {
    const { engine, els } = mountNodes(IDS);
    try {
      const { requests } = collect(engine);
      expect(contextmenu(els.get("agent:a")!, { button: 0, ctrlKey: true }).defaultPrevented).toBe(false);
      expect(requests).toHaveLength(0);
      expect(contextmenu(els.get("agent:a")!, { button: 2, ctrlKey: true }).defaultPrevented).toBe(true);
      expect(requests).toHaveLength(1);
    } finally {
      engine.unmount();
    }
  });

  it("键盘（ContextMenu 键、Shift+F10）触发时不用坐标；别的按键、指针操作都会清掉这个标记", () => {
    const { engine, els } = mountNodes(IDS);
    try {
      const { requests } = collect(engine);
      const key = (init: KeyboardEventInit): void => {
        window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
      };
      const node = els.get("agent:a")!;

      key({ key: "ContextMenu" });
      contextmenu(node, { button: 0, clientX: 310, clientY: 200 });
      expect(requests[0]!.point).toBeUndefined();

      key({ key: "F10", shiftKey: true });
      contextmenu(node, { button: 0, clientX: 310, clientY: 200 });
      expect(requests[1]!.point).toBeUndefined();

      // 标记只用一次：下一次右键又是指针。
      contextmenu(node, { clientX: 15, clientY: 25 });
      expect(requests[2]!.point).toEqual({ x: 15, y: 25 });

      // 没有 Shift 的 F10、别的键：不是菜单键。
      key({ key: "F10" });
      contextmenu(node, { clientX: 16, clientY: 26 });
      expect(requests[3]!.point).toEqual({ x: 16, y: 26 });

      // 按了菜单键但事件没来，之后用鼠标右键：pointerdown 清掉标记。
      key({ key: "ContextMenu" });
      pointer(node, "pointerdown", 20, 30, { button: 2 });
      contextmenu(node, { clientX: 20, clientY: 30 });
      expect(requests[4]!.point).toEqual({ x: 20, y: 30 });

      // 浏览器给了 (0,0) 的坐标、又没有按键记录：也当作键盘。
      contextmenu(node, { button: 0, clientX: 0, clientY: 0 });
      expect(requests[5]!.point).toBeUndefined();
    } finally {
      engine.unmount();
    }
  });

  it("右键不会移动节点、不会改变选中、不会开始拖动，也不会吞掉随后的点击", () => {
    const { engine, viewport, els } = mountNodes(IDS);
    try {
      const node = els.get("agent:a")!;
      engine.toggleSelection("agent:b");
      const before = node.style.translate;
      const selection = engine.getSelectedIds();
      const click = vi.fn();
      node.addEventListener("click", click);

      pointer(node, "pointerdown", 40, 50, { button: 2 });
      pointer(viewport, "pointermove", 140, 150, { button: 2 });
      pointer(viewport, "pointerup", 140, 150, { button: 2 });
      expect(node.style.translate).toBe(before);
      expect(engine.getSelectedIds()).toBe(selection);
      expect(engine.isUserMoved()).toBe(false);
      expect(localStorage.getItem("ensemble.canvas.positions.v1")).toBeNull();
      expect(viewport.dataset["moving"]).toBeUndefined();
      expect(viewport.dataset["panning"]).toBeUndefined();

      node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(click).toHaveBeenCalledTimes(1);
    } finally {
      engine.unmount();
    }
  });

  it("正在拖动节点时不弹菜单", () => {
    const { engine, viewport, els } = mountNodes(IDS);
    try {
      const { requests } = collect(engine);
      const node = els.get("agent:a")!;
      pointer(node, "pointerdown", 40, 50);
      pointer(viewport, "pointermove", 140, 150);
      expect(contextmenu(node).defaultPrevented).toBe(false);
      expect(requests).toHaveLength(0);
      pointer(viewport, "pointerup", 140, 150);
      expect(contextmenu(node).defaultPrevented).toBe(true);
    } finally {
      engine.unmount();
    }
  });

  it("不是画布登记过的节点（没有对应元素、未布局）不处理", () => {
    const { engine } = mountNodes(IDS);
    try {
      const { requests } = collect(engine);
      const stray = document.createElement("div");
      stray.dataset["nodeId"] = "agent:unknown";
      document.querySelector("div")!.append(stray);
      expect(contextmenu(stray).defaultPrevented).toBe(false);
      expect(requests).toHaveLength(0);
    } finally {
      engine.unmount();
    }
  });
});
