import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog } from "@shared/testing";
import type { OriginSummary, SessionSummary } from "@shared/types";
import { COLLAPSED_ORIGINS_KEY, setLang, store } from "../lib/app";
import { contextMenuNode } from "../lib/contextMenu";
import { SceneEngine } from "../scene/engine";
import { originNodeId } from "../scene/layout";
import { NodeContextMenu } from "./NodeContextMenu";
import { OriginNode } from "./OriginNode";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Main Agent（来源卡）的右键菜单：隐藏 / 显示它的相关节点。
 * 真实的引擎 + 真实的来源卡（OriginNode）+ 菜单宿主挂在同一棵树里；会话来自 store，菜单里的数字数的就是它们。
 */

const SVG_NS = "http://www.w3.org/2000/svg";

const originOf = (key: string): OriginSummary => ({ key, kind: "agent", host: "cursor", hostLabel: "Cursor", workspace: `C:\\work\\${key}` });

function summaryOf(id: string, origin: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  const log = new EventLog(id);
  log.created({ id, title: `会话 ${id}`, harness: "cursor", runtime: "native" });
  return { ...toSummary(replay(log.events)!), origin: originOf(origin), ...patch };
}

/** 来源 o 名下 3 个会话（含一个嵌套的，它自己的 origin 是别的），来源 p 名下 1 个，来源 q 名下 1 个。 */
function sessionsFixture(): Record<string, SessionSummary> {
  const list = [
    summaryOf("o_1", "o", { phase: "running", status: "running", activeRunId: "r1", createdAt: "2026-01-01T00:00:01.000Z" }),
    summaryOf("o_2", "o", { phase: "done", status: "idle", createdAt: "2026-01-01T00:00:02.000Z" }),
    summaryOf("o_kid", "elsewhere", { parentSessionId: "o_2", phase: "done", status: "idle", createdAt: "2026-01-01T00:00:03.000Z" }),
    summaryOf("p_1", "p", { phase: "done", status: "idle", createdAt: "2026-01-01T00:00:04.000Z" }),
    summaryOf("q_1", "q", { phase: "done", status: "idle", createdAt: "2026-01-01T00:00:05.000Z" }),
  ];
  return Object.fromEntries(list.map((summary) => [summary.id, summary]));
}

interface Scene {
  engine: SceneEngine;
  viewport: HTMLElement;
  origin(key: string): HTMLElement;
  git: HTMLElement;
  dispose(): void;
}

const KEYS = ["o", "p", "q"];

function mountScene(): Scene {
  const viewport = document.createElement("div");
  viewport.className = "scene";
  const world = document.createElement("div");
  const host = document.createElement("div");
  const svg = document.createElementNS(SVG_NS, "svg");
  const tube = document.createElementNS(SVG_NS, "g");
  const dots = document.createElementNS(SVG_NS, "g");
  svg.append(tube, dots);
  const git = document.createElement("div");
  git.dataset["nodeId"] = "git:wt";
  git.tabIndex = 0;
  world.append(host, git);
  viewport.append(world, svg);
  document.body.append(viewport);
  Object.defineProperties(viewport, { clientWidth: { value: 1200, configurable: true }, clientHeight: { value: 800, configurable: true } });

  const engine = new SceneEngine();
  engine.register("git:wt", git);
  engine.mount({ viewport, world, pipes: { tube, dots } });

  const root = createRoot(host);
  act(() => {
    root.render(
      <>
        {KEYS.map((key) => (
          <OriginNode key={key} origin={originOf(key)} count={1} running={0} startedAt="2026-01-01T00:00:00.000Z" engine={engine} />
        ))}
        <NodeContextMenu engine={engine} />
      </>,
    );
  });
  engine.setLayout({
    nodes: [...KEYS.map(originNodeId), "git:wt"].map((id, index) => ({
      id,
      kind: id.startsWith("origin:") ? ("origin" as const) : ("git" as const),
      x: index * 300,
      y: 0,
      w: 212,
      h: 112,
      overhang: { left: 0, right: 0 },
    })),
    edges: [],
    bounds: { x: 0, y: 0, w: 1200, h: 112 },
    origins: [],
    folders: [],
  });
  return {
    engine,
    viewport,
    origin: (key) => viewport.querySelector<HTMLElement>(`[data-node-id="${originNodeId(key)}"]`)!,
    git,
    dispose() {
      act(() => root.unmount());
      engine.unmount();
      viewport.remove();
    },
  };
}

const menus = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role="menu"]')];
const menuEl = (): HTMLElement => {
  const found = menus();
  if (found.length !== 1) throw new Error(`应该恰好有一个菜单，实际 ${found.length} 个`);
  return found[0]!;
};
const items = (): string[] => [...menuEl().querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => item.textContent ?? "");
const itemNamed = (name: string | RegExp): HTMLElement => {
  const found = [...menuEl().querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => (typeof name === "string" ? item.textContent === name : name.test(item.textContent ?? "")));
  if (!found) throw new Error(`菜单里没有：${String(name)}（现有：${items().join(" / ")}）`);
  return found;
};

function contextmenu(target: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 140, clientY: 230, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}
function press(name: string, init: KeyboardEventInit = {}, target: EventTarget = document.activeElement ?? document.body): void {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));
  });
}

describe("来源（Main Agent）节点的右键菜单", () => {
  let scene: Scene;

  beforeEach(() => {
    setLang("zh");
    localStorage.clear();
    store.set({ sessions: sessionsFixture(), ready: true, toasts: [], confirm: undefined, collapsedOrigins: new Set() });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("menu") ? 240 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("menu") ? 120 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("menu")) return DOMRect.fromRect({ x: 0, y: 0, width: 240, height: 120 });
      if (this.dataset["nodeId"]) return DOMRect.fromRect({ x: 100, y: 200, width: 212, height: 112 });
      return DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
    });
    scene = mountScene();
  });

  afterEach(() => {
    scene.dispose();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    store.set({ sessions: {}, collapsedOrigins: new Set() });
    contextMenuNode.set({ nodeId: undefined });
  });

  it("在来源卡上右键：拦下原生菜单，菜单只有一项“隐藏相关节点”，数的是它名下整棵树（含嵌套的）", () => {
    const event = contextmenu(scene.origin("o"), { clientX: 333, clientY: 222 });
    expect(event.defaultPrevented).toBe(true);
    expect(menuEl().getAttribute("aria-label")).toBe("Main Agent 操作");
    expect(menuEl().style.left).toBe("333px");
    // o 名下是 o_1、o_2 和挂在 o_2 下的嵌套会话 o_kid（它自己的 origin 是别的，也算 o 的）。
    expect(items()).toEqual(["隐藏相关节点（3 个会话）"]);
    expect(itemNamed(/隐藏相关节点/).querySelector("svg path")?.getAttribute("d")).toBeTruthy();
    // 别的来源数的是自己的。
    press("Escape");
    contextmenu(scene.origin("p"));
    expect(items()).toEqual(["隐藏相关节点（1 个会话）"]);
  });

  it("点“隐藏相关节点”：这个来源被记为隐藏、写进浏览器偏好；菜单关闭，焦点回到来源卡；读屏播报", () => {
    scene.origin("o").focus();
    contextmenu(scene.origin("o"));
    act(() => itemNamed(/隐藏相关节点/).click());
    expect(menus()).toHaveLength(0);
    expect([...store.get().collapsedOrigins]).toEqual(["o"]);
    expect(JSON.parse(localStorage.getItem(COLLAPSED_ORIGINS_KEY)!)).toEqual(["o"]);
    expect(document.activeElement).toBe(scene.origin("o"));
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe("已隐藏这个 Main Agent 的相关节点（3 个会话）");
    // 只动了这一个：别的来源与会话本身都没变。
    expect(store.get().sessions["o_1"]!.phase).toBe("running");
    expect(store.get().collapsedOrigins.has("p")).toBe(false);
  });

  it("已经隐藏的来源：同一项变成“显示相关节点”，点了恢复", () => {
    act(() => store.set({ collapsedOrigins: new Set(["o"]) }));
    contextmenu(scene.origin("o"));
    expect(items()).toEqual(["显示相关节点（3 个会话）"]);
    act(() => itemNamed(/显示相关节点/).click());
    expect(store.get().collapsedOrigins.size).toBe(0);
    expect(JSON.parse(localStorage.getItem(COLLAPSED_ORIGINS_KEY)!)).toEqual([]);
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe("已显示这个 Main Agent 的相关节点（3 个会话）");
  });

  it("别的 Main Agent 也被隐藏着：多一项“全部显示”（数的是还存在的），点了全部恢复", () => {
    act(() => store.set({ collapsedOrigins: new Set(["p", "q", "gone"]) }));
    contextmenu(scene.origin("o"));
    // gone 已经没有会话，不算。
    expect(items()).toEqual(["隐藏相关节点（3 个会话）", "全部显示（2 个 Main Agent 的相关节点已隐藏）"]);
    act(() => itemNamed(/^全部显示/).click());
    expect(store.get().collapsedOrigins.size).toBe(0);
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe("已显示全部 2 个 Main Agent 的相关节点");
  });

  it("只有它自己被隐藏时没有“全部显示”：不必多一项指向同一个动作", () => {
    act(() => store.set({ collapsedOrigins: new Set(["o"]) }));
    contextmenu(scene.origin("o"));
    expect(items()).toEqual(["显示相关节点（3 个会话）"]);
  });

  it("英文界面：文案与单复数", () => {
    act(() => setLang("en"));
    contextmenu(scene.origin("p"));
    expect(items()).toEqual(["Hide related nodes (1 session)"]);
    press("Escape");
    contextmenu(scene.origin("o"));
    expect(items()).toEqual(["Hide related nodes (3 sessions)"]);
    expect(menuEl().getAttribute("aria-label")).toBe("Main Agent actions");
  });

  it("菜单开着的时候来源卡保持悬停外观；关闭后恢复", () => {
    contextmenu(scene.origin("o"));
    expect(scene.origin("o").hasAttribute("data-menu-open")).toBe(true);
    expect(scene.origin("p").hasAttribute("data-menu-open")).toBe(false);
    press("Escape");
    expect(scene.origin("o").hasAttribute("data-menu-open")).toBe(false);
  });

  it("键盘：来源卡上按 ContextMenu 键或 Shift+F10 打开同一个菜单，放在卡片左上角偏内；Esc 回到卡片", () => {
    const node = scene.origin("o");
    node.focus();
    press("ContextMenu", {}, node);
    const event = contextmenu(node, { button: 0, clientX: 0, clientY: 0 });
    expect(event.defaultPrevented).toBe(true);
    expect(Number.parseFloat(menuEl().style.left)).toBe(100 + 14);
    expect(Number.parseFloat(menuEl().style.top)).toBe(200 + 14);
    expect(document.activeElement).toBe(itemNamed(/隐藏相关节点/));
    press("Escape");
    expect(document.activeElement).toBe(node);
    // 回车选择：键盘用户一路走得通。
    press("F10", { shiftKey: true }, node);
    contextmenu(node, { button: 0, clientX: 0, clientY: 0 });
    press("Enter");
    expect([...store.get().collapsedOrigins]).toEqual(["o"]);
  });

  it("来源已经没有会话：不接管，浏览器的原生菜单照常出现（没有什么可隐藏的）", () => {
    const sessions = { ...store.get().sessions };
    delete sessions["q_1"];
    act(() => store.set({ sessions }));
    const event = contextmenu(scene.origin("q"));
    expect(event.defaultPrevented).toBe(false);
    expect(menus()).toHaveLength(0);
  });

  it("Git、Folder 这类节点仍然没有菜单，交还给浏览器", () => {
    const event = contextmenu(scene.git);
    expect(event.defaultPrevented).toBe(false);
    expect(menus()).toHaveLength(0);
  });

  it("菜单开着时它的来源没了（会话都被删了）：菜单自己收起", () => {
    contextmenu(scene.origin("q"));
    expect(menus()).toHaveLength(1);
    const sessions = { ...store.get().sessions };
    delete sessions["q_1"];
    act(() => store.set({ sessions }));
    expect(menus()).toHaveLength(0);
    // 不只是菜单画没了：菜单的状态也一并清掉（卡片不再停在“菜单打开”的悬停外观上，等于没有悬着的菜单）。
    expect(scene.origin("q").hasAttribute("data-menu-open")).toBe(false);
    expect(contextMenuNode.get().nodeId).toBeUndefined();
  });

  it("来源在选中 ≥2 个的集合里：仍是多选菜单，不是来源菜单（选中不变）", () => {
    act(() => {
      scene.engine.toggleSelection(originNodeId("o"));
      scene.engine.toggleSelection(originNodeId("p"));
    });
    contextmenu(scene.origin("o"));
    expect(menuEl().getAttribute("aria-label")).toBe("已选择 2 个节点");
    expect(items().some((text) => text.includes("隐藏相关节点"))).toBe(false);
    expect(scene.engine.getSelectedIds()).toHaveLength(2);
  });
});
