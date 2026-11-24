import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang, store } from "../lib/app";
import { contextMenuNode } from "../lib/contextMenu";
import { agentNodeId } from "../scene/layout";
import { MENU_SIZE, NODE_RECT, contextmenu, itemNamed, menuEl, menus, mountScene, press, sessionsFixture, type Scene } from "./NodeContextMenu.fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 画布节点右键菜单的测试之二：选中多个节点之后的多选菜单（对齐、分布、撤销与重做、取消选择，以及选中集合变化时菜单怎么收）。
// 单个会话节点在 NodeContextMenu.test.tsx，批量动作在 NodeContextMenu.batch.test.tsx；共用的夹具在 NodeContextMenu.fixtures.tsx。

describe("画布节点的右键菜单", () => {
  let scene: Scene;
  let writeText: ReturnType<typeof vi.fn>;
  const sizes = { width: window.innerWidth, height: window.innerHeight };

  const setViewport = (width: number, height: number): void => {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
    Object.defineProperty(window, "innerHeight", { value: height, configurable: true, writable: true });
  };

  beforeEach(() => {
    setLang("zh");
    localStorage.clear();
    store.set({ toasts: [], confirm: undefined });
    setViewport(1200, 800);
    writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    // 菜单按布局尺寸摆位置（包围盒在入场动画起点是缩小的，见 Menu.tsx）。
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("menu") ? MENU_SIZE.width : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("menu") ? MENU_SIZE.height : 0;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("menu")) return DOMRect.fromRect({ x: 0, y: 0, width: MENU_SIZE.width * 0.98, height: MENU_SIZE.height * 0.98 });
      const id = this.dataset["nodeId"];
      if (id) {
        const order = [...document.querySelectorAll("[data-node-id]")].indexOf(this);
        return DOMRect.fromRect(NODE_RECT(Math.max(0, order)));
      }
      return DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
    });
    scene = mountScene(sessionsFixture());
  });

  afterEach(() => {
    scene.dispose();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    store.set({ sessions: {}, toasts: [], confirm: undefined });
    contextMenuNode.set({ nodeId: undefined });
    setViewport(sizes.width, sizes.height);
  });

  // ───────────── 多选 ─────────────

  const select = (...ids: string[]): void => {
    act(() => {
      for (const id of ids) scene.engine.toggleSelection(id);
    });
  };
  const run = agentNodeId("ses_run");
  const done = agentNodeId("ses_done");
  const stopped = agentNodeId("ses_stop");
  const queued = agentNodeId("ses_queue");

  it("选中 ≥2 个后，在其中任一节点上右键：多选菜单，写明作用范围，选中不变", () => {
    select(run, done, stopped);
    const before = scene.engine.getSelectedIds();
    const event = contextmenu(scene.node("ses_done"));
    expect(event.defaultPrevented).toBe(true);
    const menu = menuEl();
    expect(menu.getAttribute("aria-label")).toBe("已选择 3 个节点");
    const groups = [...menu.querySelectorAll<HTMLElement>('[role="group"]')];
    expect(groups.map((group) => document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent)).toEqual(["已选择 3 个节点", "其中 3 个会话"]);
    expect(scene.engine.getSelectedIds()).toBe(before);
    expect(contextMenuNode.get().nodeId).toBeUndefined();
  });

  it("多选菜单的第一组：六种对齐、两种分布、撤销、重做（图标行）与取消选择；名字与对齐条一致", () => {
    select(run, done, stopped);
    contextmenu(scene.node("ses_run"));
    const names = [...menuEl().querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => item.getAttribute("aria-label") ?? item.textContent);
    expect(names.slice(0, 11)).toEqual([
      "左对齐",
      "水平居中",
      "右对齐",
      "顶对齐",
      "垂直居中",
      "底对齐",
      "水平等距分布",
      "垂直等距分布",
      expect.stringMatching(/^撤销（(Ctrl\+|⌘)Z）（没有可撤销的位置变动）$/),
      expect.stringMatching(/^重做（(Ctrl\+|⌘)Shift\+Z）（没有可重做的位置变动）$/),
      "取消选择（Esc）",
    ]);
    expect(menuEl().querySelectorAll(".menu-row")).toHaveLength(2);
  });

  it("多选里含非会话节点：它也能触发多选菜单；会话组只数会话", () => {
    select(run, "origin:o", done);
    expect(contextmenu(scene.origin("o")).defaultPrevented).toBe(true);
    expect(menuEl().getAttribute("aria-label")).toBe("已选择 3 个节点");
    expect(itemNamed(/^复制会话 ID/).textContent).toBe("复制会话 ID（2 个）");
    press("Escape");
    expect(document.activeElement).toBe(scene.origin("o"));
  });

  it("选中的全是非会话节点：只有排列这一组，没有会话组", () => {
    select("origin:o", "origin:p");
    contextmenu(scene.origin("p"));
    expect(menuEl().querySelectorAll('[role="group"]')).toHaveLength(1);
    expect(menuEl().textContent).not.toContain("会话");
    expect(menuEl().textContent).not.toContain("删除记录");
  });

  it("分布在选中不足 3 个时不可用，原因写在名字与悬停提示里，点击无效；够 3 个才可用", () => {
    select(run, done);
    const engine = scene.engine;
    const distribute = vi.spyOn(engine, "distribute").mockReturnValue(true);
    contextmenu(scene.node("ses_run"));
    const horizontal = itemNamed("水平等距分布（至少选 3 个）");
    expect(horizontal.getAttribute("aria-disabled")).toBe("true");
    expect(horizontal.getAttribute("data-tip")).toBe("水平等距分布（至少选 3 个）");
    act(() => horizontal.click());
    expect(distribute).not.toHaveBeenCalled();
    expect(menus()).toHaveLength(1);
    press("Escape");

    select(stopped);
    contextmenu(scene.node("ses_run"));
    const enabled = itemNamed("水平等距分布");
    expect(enabled.hasAttribute("aria-disabled")).toBe(false);
    act(() => enabled.click());
    expect(distribute).toHaveBeenCalledWith("horizontal");
    expect(menus()).toHaveLength(0);
  });

  it("对齐走引擎的同一个方法：结果播报给读屏软件，焦点回到被点的节点", () => {
    select(run, done, stopped);
    const align = vi.spyOn(scene.engine, "align").mockReturnValueOnce(true).mockReturnValueOnce(false);
    const live = (): string | null => document.querySelector(".sr-only[aria-live]:last-of-type")?.textContent ?? null;
    contextmenu(scene.node("ses_done"));
    act(() => itemNamed("水平居中").click());
    expect(align).toHaveBeenLastCalledWith("hcenter");
    expect(document.activeElement).toBe(scene.node("ses_done"));
    expect(live()).toBe("水平居中：3 个节点");
    contextmenu(scene.node("ses_done"));
    act(() => itemNamed("左对齐").click());
    expect(align).toHaveBeenLastCalledWith("left");
    expect(live()).toBe("左对齐：位置没有变化");
  });

  it("撤销与重做：没有历史时不可用；对齐之后可用，点了交给引擎", () => {
    select(run, done);
    contextmenu(scene.node("ses_run"));
    expect(itemNamed(/^撤销/).getAttribute("aria-disabled")).toBe("true");
    expect(itemNamed(/^重做/).getAttribute("aria-disabled")).toBe("true");
    // 真实地对齐一次：两个节点原本一个在 x=0、一个在 x=300，左对齐会移动其中一个并记入历史。
    act(() => itemNamed("左对齐").click());
    contextmenu(scene.node("ses_run"));
    const undoItem = itemNamed(/^撤销/);
    expect(undoItem.hasAttribute("aria-disabled")).toBe(false);
    expect(undoItem.getAttribute("aria-label")).toMatch(/^撤销（(Ctrl\+|⌘)Z）$/);
    const undo = vi.spyOn(scene.engine, "undo");
    act(() => undoItem.click());
    expect(undo).toHaveBeenCalledTimes(1);
    contextmenu(scene.node("ses_run"));
    expect(itemNamed(/^重做/).hasAttribute("aria-disabled")).toBe(false);
  });

  it("取消选择清空选中", () => {
    select(run, done);
    contextmenu(scene.node("ses_run"));
    act(() => itemNamed("取消选择（Esc）").click());
    expect(scene.engine.getSelectedIds()).toEqual([]);
  });

  it("选中集合变了，多选菜单的对象已经失效：收起来，不抢焦点", () => {
    select(run, done, stopped);
    contextmenu(scene.node("ses_run"));
    expect(menus()).toHaveLength(1);
    select(stopped);
    expect(menus()).toHaveLength(0);
    // 集合成员变了但数量没变的情形：同样失效。
    select(stopped);
    contextmenu(scene.node("ses_run"));
    act(() => (scene.engine as unknown as { selection: { replace(ids: string[]): void } }).selection.replace([run, queued]));
    expect(menus()).toHaveLength(0);
  });

  it("右键落在多选之外的会话节点上：选中集合变成它，弹出它自己的菜单（与“···”一致），多选里的其他节点不受影响", () => {
    select(run, done);
    const event = contextmenu(scene.node("ses_queue"));
    expect(event.defaultPrevented).toBe(true);
    expect(scene.engine.getSelectedIds()).toEqual([queued]);
    expect(scene.node("ses_run").hasAttribute("data-selected")).toBe(false);
    expect(scene.node("ses_queue").hasAttribute("data-selected")).toBe(true);
    expect(menuEl().getAttribute("aria-label")).toBe("会话操作");
    // 菜单只作用于它：不是多选菜单，没有对齐。
    expect(menuEl().querySelector(".menu-row")).toBeNull();
    // 这时菜单没有被“选中变了”误关。
    expect(menus()).toHaveLength(1);
    expect(scene.node("ses_queue").hasAttribute("data-menu-open")).toBe(true);
  });

  it("右键落在多选之外的来源节点上：没有菜单，原生菜单照常出现，多选原样不动", () => {
    select(run, done);
    const before = scene.engine.getSelectedIds();
    const event = contextmenu(scene.origin("o"));
    expect(event.defaultPrevented).toBe(false);
    expect(menus()).toHaveLength(0);
    expect(scene.engine.getSelectedIds()).toBe(before);
  });
});
