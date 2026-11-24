import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang, store } from "../lib/app";
import { contextMenuNode } from "../lib/contextMenu";
import { agentNodeId } from "../scene/layout";
import { sessionIdOfNode } from "./NodeContextMenu";
import { MENU_SIZE, NODE_RECT, contextmenu, itemNamed, menuEl, menus, mountScene, press, sessionsFixture, summaryOf, type Scene } from "./NodeContextMenu.fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 画布节点右键菜单的测试之一：单个会话节点（弹出、与“···”一致、键盘与焦点、怎么收起、原生菜单何时放行）与 sessionIdOfNode。
// 多选与排列在 NodeContextMenu.multi.test.tsx，批量动作在 NodeContextMenu.batch.test.tsx；共用的夹具在 NodeContextMenu.fixtures.tsx。

/** 菜单的结构快照：逐项比较“···”与右键两个入口。 */
function snapshot(menu: HTMLElement) {
  return {
    label: menu.getAttribute("aria-label"),
    entries: [...menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="separator"]')].map((el) => ({
      role: el.getAttribute("role"),
      text: el.textContent,
      disabled: el.getAttribute("aria-disabled"),
      danger: el.hasAttribute("data-danger"),
      tip: el.getAttribute("data-tip"),
      icon: el.querySelector("svg path")?.getAttribute("d") ?? null,
    })),
  };
}

function pointerDown(target: Element, init: PointerEventInit = {}): void {
  act(() => {
    target.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, bubbles: true, cancelable: true, button: 2, ...init }));
  });
}

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

  // ───────────── 单个会话节点 ─────────────

  it("在会话节点上右键：拦下原生菜单，菜单在指针处弹出", () => {
    const event = contextmenu(scene.node("ses_done"), { clientX: 333, clientY: 222 });
    expect(event.defaultPrevented).toBe(true);
    const menu = menuEl();
    expect(menu.parentElement).toBe(document.body);
    expect(menu.style.left).toBe("333px");
    expect(menu.style.top).toBe("222px");
    expect(menu.getAttribute("aria-label")).toBe("会话操作");
    expect(menu.hasAttribute("data-ready")).toBe(true);
    // 与“···”同样的第一项获得焦点。
    expect(document.activeElement).toBe(itemNamed("打开会话"));
  });

  it("菜单内容与头部“···”逐项相同（四种会话各比一遍：名字、图标、分隔线、不可用与原因、危险标记）", () => {
    for (const id of ["ses_run", "ses_done", "ses_stop", "ses_queue"]) {
      const dots = scene.node(id).querySelector<HTMLButtonElement>(".a-menu")!;
      act(() => dots.click());
      const fromButton = snapshot(menuEl());
      press("Escape");
      expect(menus()).toHaveLength(0);

      contextmenu(scene.node(id));
      const fromContext = snapshot(menuEl());
      press("Escape");
      expect(fromContext, id).toEqual(fromButton);
      // 不是空菜单：打开、复制链接、复制 ID、中断、关闭、删除。
      expect(fromContext.entries.filter((entry) => entry.role === "menuitem").map((entry) => entry.text)).toEqual([
        "打开会话",
        "复制面板链接",
        "复制会话 ID",
        "中断当前运行",
        "关闭会话",
        "删除记录",
      ]);
    }
    // 不可用项带着原因（来自同一个 sessionMenuItems）。
    contextmenu(scene.node("ses_done"));
    expect(itemNamed("中断当前运行").getAttribute("aria-disabled")).toBe("true");
    expect(itemNamed("中断当前运行").getAttribute("data-tip")).toBe("当前没有正在进行的运行");
    expect(itemNamed("删除记录").hasAttribute("data-danger")).toBe(true);
    press("Escape");
    contextmenu(scene.node("ses_run"));
    expect(itemNamed("删除记录").getAttribute("data-tip")).toBe("运行中的会话不能删除，请先中断并关闭。");
  });

  it("节点上任何位置右键都触发：标题链接、“···”按钮本身、头部、正文", () => {
    const node = scene.node("ses_done");
    for (const target of [node.querySelector(".a-title")!, node.querySelector(".a-menu")!, node.querySelector(".a-head")!, node.querySelector(".a-inset")!, node]) {
      const event = contextmenu(target);
      expect(event.defaultPrevented).toBe(true);
      expect(menuEl().getAttribute("aria-label")).toBe("会话操作");
      press("Escape");
    }
  });

  it("右键不打开会话，也不改变选中", () => {
    const hash = location.hash;
    contextmenu(scene.node("ses_done"));
    expect(location.hash).toBe(hash);
    expect(scene.engine.getSelectedIds()).toEqual([]);
    act(() => scene.engine.toggleSelection(agentNodeId("ses_run")));
    press("Escape");
    contextmenu(scene.node("ses_done"));
    expect(scene.engine.getSelectedIds()).toEqual([agentNodeId("ses_run")]);
  });

  it("菜单打开期间节点保持悬停外观（data-menu-open），关闭后恢复；“···”菜单同样", () => {
    const node = scene.node("ses_done");
    expect(node.hasAttribute("data-menu-open")).toBe(false);
    contextmenu(node);
    expect(node.hasAttribute("data-menu-open")).toBe(true);
    // 别的节点不受影响。
    expect(scene.node("ses_run").hasAttribute("data-menu-open")).toBe(false);
    press("Escape");
    expect(node.hasAttribute("data-menu-open")).toBe(false);

    act(() => node.querySelector<HTMLButtonElement>(".a-menu")!.click());
    expect(node.hasAttribute("data-menu-open")).toBe(true);
    press("Escape");
    expect(node.hasAttribute("data-menu-open")).toBe(false);
  });

  it("Esc 关闭菜单并把焦点还给节点；选了一项同样把焦点还给节点，再执行动作", () => {
    const node = scene.node("ses_done");
    contextmenu(node);
    press("Escape");
    expect(menus()).toHaveLength(0);
    expect(document.activeElement).toBe(node);

    contextmenu(node);
    const focusAtSelect: (Element | null)[] = [];
    writeText.mockImplementation(async () => {
      focusAtSelect.push(document.activeElement);
    });
    act(() => itemNamed("复制会话 ID").click());
    expect(menus()).toHaveLength(0);
    expect(document.activeElement).toBe(node);
    expect(writeText).toHaveBeenCalledWith("ses_done");
    expect(focusAtSelect).toEqual([node]);
  });

  it("键盘：节点上按 ContextMenu 键或 Shift+F10，菜单放在节点左上角偏内；Esc 回到节点", () => {
    const node = scene.node("ses_done");
    const rect = node.getBoundingClientRect();
    for (const open of [() => press("ContextMenu", {}, node), () => press("F10", { shiftKey: true }, node)]) {
      node.focus();
      open();
      // 浏览器随后触发 contextmenu：坐标不可信（这里给了 0,0 与一个远处的值各一次）。
      const event = contextmenu(node, { button: 0, clientX: 0, clientY: 0 });
      expect(event.defaultPrevented).toBe(true);
      const menu = menuEl();
      expect(Number.parseFloat(menu.style.left)).toBe(rect.left + 14);
      expect(Number.parseFloat(menu.style.top)).toBe(rect.top + 14);
      expect(menu.getAttribute("role")).toBe("menu");
      expect(document.activeElement).toBe(itemNamed("打开会话"));
      press("Escape");
      expect(document.activeElement).toBe(node);
    }
    node.focus();
    press("ContextMenu", {}, node);
    contextmenu(node, { button: 0, clientX: 900, clientY: 700 });
    expect(Number.parseFloat(menuEl().style.left)).toBe(rect.left + 14);
    press("Escape");
  });

  it("键盘打开的菜单可以用方向键走完并选择；Tab 关闭", () => {
    const node = scene.node("ses_done");
    node.focus();
    press("ContextMenu", {}, node);
    contextmenu(node, { button: 0, clientX: 0, clientY: 0 });
    expect(document.activeElement).toBe(itemNamed("打开会话"));
    press("ArrowDown");
    expect(document.activeElement).toBe(itemNamed("复制面板链接"));
    press("End");
    expect(document.activeElement).toBe(itemNamed("删除记录"));
    press("Tab");
    expect(menus()).toHaveLength(0);
  });

  it("点外部、画布滚轮缩放与平移、resize、窗口失焦都会关闭菜单", () => {
    const node = scene.node("ses_done");
    const closesBy = (trigger: () => void): boolean => {
      contextmenu(node);
      expect(menus()).toHaveLength(1);
      act(trigger);
      return menus().length === 0;
    };
    expect(closesBy(() => scene.viewport.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })))).toBe(true);
    expect(closesBy(() => void scene.viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 60 })))).toBe(true);
    expect(closesBy(() => void scene.viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -40, ctrlKey: true })))).toBe(true);
    expect(closesBy(() => void window.dispatchEvent(new Event("resize")))).toBe(true);
    expect(closesBy(() => void window.dispatchEvent(new Event("blur")))).toBe(true);
  });

  it("菜单开着时再在别处点右键：换成新位置的菜单，不叠两层", () => {
    contextmenu(scene.node("ses_done"), { clientX: 120, clientY: 210 });
    expect(menuEl().style.left).toBe("120px");

    // 别的节点：右键的 pointerdown 先关掉旧菜单，随后的 contextmenu 在新位置开一个。
    pointerDown(scene.node("ses_run"));
    contextmenu(scene.node("ses_run"), { clientX: 520, clientY: 240 });
    expect(menus()).toHaveLength(1);
    expect(menuEl().style.left).toBe("520px");
    expect(menuEl().style.top).toBe("240px");
    expect(scene.node("ses_run").hasAttribute("data-menu-open")).toBe(true);
    expect(scene.node("ses_done").hasAttribute("data-menu-open")).toBe(false);

    // 同一个节点的另一个位置。
    pointerDown(scene.node("ses_run"));
    contextmenu(scene.node("ses_run"), { clientX: 600, clientY: 280 });
    expect(menus()).toHaveLength(1);
    expect(menuEl().style.left).toBe("600px");
  });

  it("即便 pointerdown 没有先关掉（例如直接触发 contextmenu），也只有一个菜单", () => {
    contextmenu(scene.node("ses_done"), { clientX: 120, clientY: 210 });
    contextmenu(scene.node("ses_run"), { clientX: 520, clientY: 240 });
    expect(menus()).toHaveLength(1);
    expect(menuEl().style.left).toBe("520px");
  });

  it("“···”菜单开着时在节点上右键（包括在“···”按钮上）：只剩右键菜单", () => {
    const node = scene.node("ses_done");
    const dots = node.querySelector<HTMLButtonElement>(".a-menu")!;
    act(() => dots.click());
    expect(menus()).toHaveLength(1);
    // 在“···”按钮自己上右键：按钮的按下不算“外部”，所以靠菜单互斥收起旧的。
    pointerDown(dots);
    contextmenu(dots, { clientX: 400, clientY: 250 });
    expect(menus()).toHaveLength(1);
    expect(menuEl().style.left).toBe("400px");
    expect(dots.getAttribute("aria-expanded")).toBe("false");
    // 节点的悬停外观由右键菜单接手，没有被“···”的关闭抹掉。
    expect(node.hasAttribute("data-menu-open")).toBe(true);
  });

  it("没有菜单的地方保持浏览器原生菜单：没有多选时的来源节点、画布空白、输入框", () => {
    const originEvent = contextmenu(scene.origin("o"));
    expect(originEvent.defaultPrevented).toBe(false);
    expect(menus()).toHaveLength(0);
    expect(contextmenu(scene.viewport).defaultPrevented).toBe(false);
    const input = document.createElement("input");
    document.body.append(input);
    expect(contextmenu(input).defaultPrevented).toBe(false);
    expect(menus()).toHaveLength(0);
    expect(scene.engine.getSelectedIds()).toEqual([]);
  });

  it("macOS 上 Ctrl+点击（触发 contextmenu 的平移手势）原样放行，不弹菜单", () => {
    const event = contextmenu(scene.node("ses_done"), { button: 0, ctrlKey: true });
    expect(event.defaultPrevented).toBe(false);
    expect(menus()).toHaveLength(0);
  });

  it("所指的会话被删除后，菜单自动收起，节点的悬停外观也恢复", () => {
    contextmenu(scene.node("ses_done"));
    const { ses_done: _gone, ...rest } = store.get().sessions;
    act(() => store.set({ sessions: rest }));
    expect(menus()).toHaveLength(0);
    expect(contextMenuNode.get().nodeId).toBeUndefined();
  });

  it("菜单里的项随会话状态实时更新（运行结束后“中断”变成不可用）", () => {
    contextmenu(scene.node("ses_run"));
    expect(itemNamed("中断当前运行").getAttribute("aria-disabled")).toBeNull();
    const finished = summaryOf("ses_run", { title: "运行中的会话", phase: "done", status: "idle", seq: 11 });
    act(() => store.set({ sessions: { ...store.get().sessions, ses_run: finished } }));
    expect(menus()).toHaveLength(1);
    expect(itemNamed("中断当前运行").getAttribute("aria-disabled")).toBe("true");
    expect(itemNamed("删除记录").getAttribute("aria-disabled")).toBeNull();
  });

  it("英文界面使用英文文案", () => {
    setLang("en");
    contextmenu(scene.node("ses_done"));
    expect(menuEl().getAttribute("aria-label")).toBe("Session actions");
    expect(itemNamed("Open session")).toBeTruthy();
    expect(itemNamed("Interrupt current run").getAttribute("data-tip")).toBe("No run is in progress");
  });

  it("窄视口里在右下角右键：菜单翻转后完整落在视口内", () => {
    setViewport(320, 480);
    contextmenu(scene.node("ses_done"), { clientX: 310, clientY: 470 });
    const menu = menuEl();
    expect(Number.parseFloat(menu.style.left)).toBeGreaterThanOrEqual(8);
    expect(Number.parseFloat(menu.style.left) + MENU_SIZE.width).toBeLessThanOrEqual(320 - 8);
    expect(Number.parseFloat(menu.style.top) + MENU_SIZE.height).toBeLessThanOrEqual(480 - 8);
  });
});

describe("sessionIdOfNode", () => {
  it("是 agentNodeId 的逆运算；其他节点没有会话", () => {
    expect(sessionIdOfNode(agentNodeId("ses_abc"))).toBe("ses_abc");
    expect(sessionIdOfNode(agentNodeId(""))).toBe("");
    expect(sessionIdOfNode("origin:codex:x")).toBeUndefined();
    expect(sessionIdOfNode("git:C:/repo")).toBeUndefined();
    expect(sessionIdOfNode("folder:C:/repo")).toBeUndefined();
  });
});
