import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog, testOrigin } from "@shared/testing";
import { App } from "./app";
import {
  closeSettings,
  openSettings,
  setLang,
  setRailCollapsed,
  store,
} from "./lib/app";
import { ARCHIVED_AT } from "./lib/archive.fixtures";

// 测试里没有服务：不订阅实时流，也不让路由模块去读取详情；路由与连接状态直接由 store 提供。
vi.mock("./lib/live", () => ({ startLive: () => () => {} }));
vi.mock("./lib/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/app")>()),
  startRouting: () => () => {},
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeSession(id: string, originKey: string, title: string, hostTitle?: string) {
  const log = new EventLog(id);
  log.created({
    id,
    title,
    harness: "cursor",
    runtime: "native",
    model: { label: "DeepSeek V4.1 Flash 1017" },
    origin: testOrigin({ key: originKey, host: "cursor", hostLabel: "Cursor", ...(hostTitle ? { hostTitle } : {}) }),
  });
  const state = replay(log.events);
  if (!state) throw new Error("missing session state");
  return { state, summary: toSummary(state) };
}

describe("App：方案 A 工作空间骨架（左侧栏 + 窄屏顶栏 + ⌘K 快切器 + 无底部胶囊）", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let previous: ReturnType<typeof store.get>;
  const origWidth = window.innerWidth;
  const s1 = makeSession("ses_a", "cursor:conv-a", "重构侧栏", "重构 Ensemble UI");
  const s2 = makeSession("ses_b", "cursor:conv-b", "排查 OpenCode", "修复 OpenCode 探测");

  const setViewportWidth = (width: number): void => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: width });
    act(() => void window.dispatchEvent(new Event("resize")));
  };

  beforeEach(() => {
    previous = store.get();
    localStorage.clear();
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1280 });
    store.set({
      ready: true,
      conn: "live",
      route: { kind: "overview" },
      sessions: { [s1.summary.id]: s1.summary, [s2.summary.id]: s2.summary },
      detail: undefined,
      harnesses: [],
      toasts: [],
      settings: { open: false, section: undefined },
      confirm: undefined,
      railCollapsed: false,
      switcherOpen: false,
      viewMode: "canvas",
      lastWorkspace: undefined,
      recentOrigins: [],
    });
    setLang("zh");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: origWidth });
    store.set(previous);
    localStorage.clear();
  });

  const mount = (): void => {
    act(() => root.render(<App />));
  };
  const goSession = (): void => {
    act(() =>
      store.set({
        route: { kind: "session", id: s1.summary.id },
        detail: { id: s1.summary.id, state: s1.state, rev: 0, loading: false },
      }),
    );
  };
  const app = (): HTMLElement => host.querySelector<HTMLElement>(".app")!;

  it("宽屏概览：显示极简左侧栏、空间标头与右下角图纸比例尺，彻底移除旧底部胶囊 nav.dock", () => {
    mount();
    expect(app().getAttribute("data-view")).toBe("overview");
    expect(app().getAttribute("data-rail")).toBe("open");
    expect(host.querySelector("nav.dock")).toBeNull();
    expect(host.querySelector(".rail-panel")).not.toBeNull();
    expect(host.querySelector(".rail-kbd-btn")).toBeNull();
    // 底栏只有“设置”：委派由主 Agent 通过 MCP 工具发起，页面不提供“新建委派”的入口。
    expect([...host.querySelectorAll(".rail-foot button")].map((button) => button.className)).toEqual(["rail-settings"]);
    expect(host.querySelector(".ws-head")).not.toBeNull();
    expect(host.querySelector(".canvas-scale")).not.toBeNull();
    expect(host.querySelector(".ws-topbar")).toBeNull();
  });

  it("按 Main Agent 独立画布：首次打开落入单个 Main Agent，画布只渲染该空间的会话而不是把所有 Main Agent 混在一张图里", () => {
    mount();
    const agentCards = host.querySelectorAll(".node.agent");
    expect(agentCards).toHaveLength(1);
    // 单空间下 Git / Folder 节点不再画在画布上
    expect(host.querySelectorAll(".node.folder")).toHaveLength(0);
    expect(host.querySelectorAll(".node.git")).toHaveLength(0);
  });

  it("宽屏收起侧栏（按钮或 Ctrl/⌘+B）后页面不换样子：没有顶栏、.app 不带 data-topbar，只在左上角留一个只带图标的“展开侧栏”按钮，点它展开", () => {
    const expandButtons = (): HTMLButtonElement[] => [...host.querySelectorAll<HTMLButtonElement>('button[aria-label^="展开侧栏"]')];
    mount();
    expect(host.querySelector(".rail-panel")).not.toBeNull();
    expect(app().getAttribute("data-rail")).toBe("open");
    expect(expandButtons()).toHaveLength(0);
    const collapseButton = host.querySelector<HTMLButtonElement>(".rail-brand .rail-ico-btn")!;
    expect(collapseButton.getAttribute("aria-label")).toMatch(/^收起侧栏/);

    // 收起只带来横向的变化：没有 44px 的顶栏，也没有 data-topbar，页面的纵向几何与侧栏展开时一致。
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true })));
    expect(store.get().railCollapsed).toBe(true);
    expect(host.querySelector(".rail-panel")).toBeNull();
    expect(host.querySelector(".ws-topbar")).toBeNull();
    expect(app().hasAttribute("data-topbar")).toBe(false);
    expect(app().getAttribute("data-rail")).toBe("collapsed");

    // 整页只有这一个控件：不带文字、工作空间切换、设置与品牌字样；图标与侧栏头部的“收起”是同一个，弹层打开时随外壳一起 inert。
    expect(host.querySelectorAll(".rail-ico-btn")).toHaveLength(1);
    expect(expandButtons()).toHaveLength(1);
    const expand = expandButtons()[0]!;
    expect(expand.getAttribute("aria-label")).toMatch(/^展开侧栏（(Ctrl\+B|⌘B)）$/);
    expect(expand.getAttribute("data-tip")).toBe(expand.getAttribute("aria-label"));
    expect(expand.textContent).toBe("");
    expect(expand.innerHTML).toBe(collapseButton.innerHTML);
    expect(expand.hasAttribute("data-modal-inert")).toBe(true);

    // 聚焦页上同样有，而且换页时是同一个元素（不重挂，位置不跳）；聚焦页同样没有顶栏。
    goSession();
    expect(app().getAttribute("data-view")).toBe("session");
    expect(host.querySelector(".focus")).not.toBeNull();
    expect(host.querySelector(".ws-topbar")).toBeNull();
    expect(app().hasAttribute("data-topbar")).toBe(false);
    expect(expandButtons()).toHaveLength(1);
    expect(expandButtons()[0]).toBe(expand);

    // 点它展开侧栏，按钮随之消失；再点侧栏头部的按钮收起，回到同一个样子。
    act(() => expand.click());
    expect(store.get().railCollapsed).toBe(false);
    expect(host.querySelector(".rail-panel")).not.toBeNull();
    expect(app().getAttribute("data-rail")).toBe("open");
    expect(expandButtons()).toHaveLength(0);
    act(() => host.querySelector<HTMLButtonElement>(".rail-brand .rail-ico-btn")!.click());
    expect(store.get().railCollapsed).toBe(true);
    expect(host.querySelector(".rail-panel")).toBeNull();
    expect(host.querySelector(".ws-topbar")).toBeNull();
    expect(expandButtons()).toHaveLength(1);
  });

  it("窄屏（< 860px）没有侧栏可收可展：仍是顶栏（品牌字样 + 工作空间切换 + 设置），右端只有“设置”，没有展开按钮；收起的偏好不会让它冒出来", () => {
    mount();
    setViewportWidth(520);
    expect(host.querySelector(".rail-panel")).toBeNull();
    expect(host.querySelector(".ws-topbar")).not.toBeNull();
    expect(app().hasAttribute("data-topbar")).toBe(true);
    expect(app().getAttribute("data-rail")).toBe("none");
    expect(host.querySelector(".ws-topbar-brand")?.textContent).toBe("Ensemble");
    // 顶栏右端只有“设置”，没有“新建委派”的入口；整页没有“展开侧栏”。
    expect([...host.querySelectorAll(".ws-topbar-right button")].map((button) => button.getAttribute("aria-label"))).toEqual(["设置"]);
    expect(host.querySelector('button[aria-label^="展开侧栏"]')).toBeNull();

    // 宽屏下收起过侧栏、再窄下来：偏好还在，但窄屏照旧是顶栏，不出现展开按钮，Ctrl/⌘+B 也不生效。
    act(() => setRailCollapsed(true));
    expect(host.querySelector(".ws-topbar")).not.toBeNull();
    expect(app().getAttribute("data-rail")).toBe("none");
    expect(host.querySelector('button[aria-label^="展开侧栏"]')).toBeNull();
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true })));
    expect(store.get().railCollapsed).toBe(true);

    // 回到宽屏：收起的状态还在，顶栏消失，只剩展开按钮。
    setViewportWidth(1280);
    expect(host.querySelector(".ws-topbar")).toBeNull();
    expect(app().hasAttribute("data-topbar")).toBe(false);
    expect(app().getAttribute("data-rail")).toBe("collapsed");
    expect(host.querySelectorAll('button[aria-label^="展开侧栏"]')).toHaveLength(1);
  });

  it("窗口越过 860px 时外壳在同一个微任务里换好（侧栏 ↔ 顶栏）：不等调度器的宏任务，画布量取视口之前就是终态（LAYOUT7 · W13）", async () => {
    mount();
    expect(app().getAttribute("data-rail")).toBe("open");
    // 事件不包 act：act 会替 React 把所有更新冲刷干净，看不出外壳是不是赶在布局与 ResizeObserver 之前换好的。
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    env.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 800 });
      window.dispatchEvent(new Event("resize"));
      await Promise.resolve();
      expect(app().getAttribute("data-rail")).toBe("none");
      expect(host.querySelector(".rail-panel")).toBeNull();
      expect(host.querySelector(".ws-topbar")).not.toBeNull();

      Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1440 });
      window.dispatchEvent(new Event("resize"));
      await Promise.resolve();
      expect(app().getAttribute("data-rail")).toBe("open");
      expect(host.querySelector(".rail-panel")).not.toBeNull();
      expect(host.querySelector(".ws-topbar")).toBeNull();
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = true;
    }
  });

  it("⌘K / Ctrl+K 打开快速切换器，再次按关闭；概览里按 N 不打开任何弹层", () => {
    mount();
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })));
    expect(store.get().switcherOpen).toBe(true);
    expect(document.body.querySelector('[role="dialog"][aria-label="快速切换"]')).not.toBeNull();

    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })));
    expect(store.get().switcherOpen).toBe(false);

    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "n", bubbles: true })));
    expect(store.get().switcherOpen).toBe(false);
    expect(store.get().settings.open).toBe(false);
    expect(store.get().confirm).toBeUndefined();
  });

  it("聚焦页：宽屏保留左侧栏并展开兄弟会话，连接异常在无侧栏时以轻量 .status-notices 显示", () => {
    mount();
    goSession();
    expect(app().getAttribute("data-view")).toBe("session");
    expect(host.querySelector(".focus")).not.toBeNull();
    expect(host.querySelector(".rail-panel")).not.toBeNull();
    expect(host.querySelector(".rail-siblings")).not.toBeNull();
    expect(host.querySelector("nav.dock")).toBeNull();

    // 侧栏收起时，聚焦页上连接状态以轻量浮角条呈现
    act(() => setRailCollapsed(true));
    act(() => store.set({ conn: "reconnecting" }));
    expect(host.querySelector('.status-notices[data-place="floating"] .status-note')?.textContent).toBe("重新连接中…");
    act(() => store.set({ conn: "live" }));
    expect(host.querySelector(".status-notices")).toBeNull();
  });

  it("弹层独立性：打开的设置窗口不受路由变化影响", () => {
    mount();
    act(() => openSettings("general"));
    expect(document.body.querySelector('[role="dialog"][aria-label="设置"]')).not.toBeNull();
    goSession();
    expect(store.get().settings).toEqual({ open: true, section: "general" });
    expect(document.body.querySelector('[role="dialog"][aria-label="设置"]')).not.toBeNull();
    act(() => closeSettings());
  });

  // 钩子本身的规则由 lib/useEmptiedSpace.test.tsx 守着；这里守的是 app.tsx 交给它什么：
  // 空间消失的同一次渲染里 currentScope 就已经按回退规则换成了别的空间，要是把它交给钩子，钩子永远等不到“看着的空间没了”，
  // 地址栏停在 #/m/<已经没有的空间>，提示也不会出现。
  it("正看着的 Main Agent 空间被归档清空：地址栏改到回退后的空间，并用提示说明去向", () => {
    const keyA = s1.summary.origin.key;
    const keyB = s2.summary.origin.key;
    location.hash = "";
    try {
      act(() => store.set({ route: { kind: "overview", scope: { kind: "origin", key: keyA } } }));
      mount();
      // 看着的时候什么都不会发生。
      expect(location.hash).toBe("");
      expect(store.get().toasts).toEqual([]);

      // A 名下唯一的会话归档了：未归档的会话里算不出这个空间；归档时服务端推来的摘要在已归档表里（提示据此确认“确实是归档”）。
      act(() =>
        store.set({
          sessions: { [s2.summary.id]: s2.summary },
          archived: { [s1.summary.id]: { ...s1.summary, archivedAt: ARCHIVED_AT, archivedBy: "user" } },
        }),
      );

      expect(location.hash).toBe(`#/m/${encodeURIComponent(keyB)}`);
      expect(store.get().lastWorkspace).toEqual({ kind: "origin", key: keyB });
      expect(store.get().toasts.at(-1)).toMatchObject({ tone: "info", text: expect.stringContaining("名下的会话都已归档，已切换到") });
    } finally {
      location.hash = "";
    }
  });
});
