import { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TEST_CAPABILITIES } from "@shared/testing";
import type { HarnessId, HarnessInfo } from "@shared/types";
import { closeSettings, openSettings, setLang, store } from "../../lib/app";
import { SettingsWindow } from "./SettingsWindow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const harness = (id: HarnessId, status: HarnessInfo["status"]): HarnessInfo => ({
  id,
  displayName: id,
  runtime: "native",
  status,
  models: [{ id: "m-a", label: "Alpha", isDefault: true }],
  capabilities: TEST_CAPABILITIES,
  access: { read_only: null, full: null },
  checkedAt: "2026-01-01T00:00:00.000Z",
});

describe("设置窗口：外壳、分区导航、键盘与焦点", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const previous = store.get();

  beforeEach(() => {
    setLang("zh");
    store.set({ harnesses: [harness("codex", "ready"), harness("pi", "unavailable")], settings: { open: false, section: undefined }, toasts: [], archivedCount: undefined });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    // 触发处在窗口之外，像 Dock 上的“设置”按钮：用来验证焦点归还。
    act(() =>
      root.render(
        <>
          <button id="trigger" type="button">设置</button>
          <SettingsWindow />
        </>,
      ),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.replaceChildren();
    store.set({ harnesses: previous.harnesses, settings: previous.settings, lang: previous.lang, profiles: previous.profiles, archivedCount: previous.archivedCount });
  });

  const open = (section?: Parameters<typeof openSettings>[0]): void => void act(() => openSettings(section));
  const dialog = (): HTMLElement | null => document.body.querySelector<HTMLElement>('[role="dialog"]');
  const tabs = (): HTMLButtonElement[] => [...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const selectedTab = (): HTMLButtonElement => tabs().find((tab) => tab.getAttribute("aria-selected") === "true")!;
  const panel = (): HTMLElement => document.body.querySelector<HTMLElement>('[role="tabpanel"]')!;
  const key = (name: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
    act(() => void document.activeElement!.dispatchEvent(event));
    return event;
  };

  describe("外壳", () => {
    it("没打开时什么都不渲染；打开后是一个模态对话框，名字是“设置”，宽度 920", () => {
      expect(dialog()).toBeNull();
      open();
      expect(dialog()?.getAttribute("aria-label")).toBe("设置");
      expect(dialog()?.getAttribute("aria-modal")).toBe("true");
      expect(dialog()?.style.width).toBe("920px");
    });

    it("标题层级：窗口标题 h2“设置”，当前分区标题 h3；导航是 tablist，分区内容是它对应的 tabpanel", () => {
      open("executors");
      expect(dialog()!.querySelector("h2")?.textContent).toBe("设置");
      expect(dialog()!.querySelector("h3")?.textContent).toBe("执行端");
      const list = dialog()!.querySelector('[role="tablist"]');
      expect(list?.getAttribute("aria-label")).toBe("设置分区");
      expect(tabs().map((tab) => tab.querySelector(".settings-tab-label")?.textContent)).toEqual(["执行端", "角色", "通用", "历史"]);
      expect(dialog()!.querySelectorAll('[role="tabpanel"]')).toHaveLength(1);
      expect(panel().getAttribute("aria-labelledby")).toBe(selectedTab().id);
      for (const tab of tabs()) expect(tab.getAttribute("aria-controls")).toBe(panel().id);
    });

    it("导航小字是真实状态：执行端“1/2 可用”，没有角色时角色那一项不写小字，通用是当前语言的名字，服务不报已归档个数（老服务）时历史也不写小字；换语言后小字跟着变", () => {
      open();
      expect(tabs().map((tab) => tab.querySelector(".settings-tab-sub")?.textContent)).toEqual(["1/2 可用", undefined, "中文", undefined]);
      act(() => setLang("en"));
      expect(tabs().map((tab) => tab.querySelector(".settings-tab-sub")?.textContent)).toEqual(["1/2 ready", undefined, "English", undefined]);
    });

    it("服务报告了已归档个数时，历史那一项的小字是它（0 也如实写出）；换语言后跟着变", () => {
      act(() => store.set({ archivedCount: 3 }));
      open();
      expect(tabs()[3]!.querySelector(".settings-tab-sub")?.textContent).toBe("3 个已归档");
      act(() => store.set({ archivedCount: 0 }));
      expect(tabs()[3]!.querySelector(".settings-tab-sub")?.textContent).toBe("0 个已归档");
      act(() => setLang("en"));
      expect(tabs()[3]!.querySelector(".settings-tab-sub")?.textContent).toBe("0 archived");
      act(() => store.set({ archivedCount: undefined }));
      expect(tabs()[3]!.querySelector(".settings-tab-sub")).toBeNull();
    });

    it("有角色时，角色那一项的小字是“此刻能用的 / 全部”：角色指向的执行端不可用就不算", () => {
      // 默认夹具里两个访问级别都是 null（执行端落实不了），这里让 codex 能落实 Full Access，角色才有可能“能用”。
      const enforced = { level: "enforced", mechanism: "test" } as const;
      act(() =>
        store.set({
          harnesses: [{ ...harness("codex", "ready"), access: { read_only: enforced, full: enforced } }, harness("pi", "unavailable")],
          profiles: {
            entries: [
              { name: "build", harness: "codex" },
              { name: "scout", harness: "pi" },
            ],
          },
        }),
      );
      open();
      expect(tabs().map((tab) => tab.querySelector(".settings-tab-sub")?.textContent)).toEqual(["1/2 可用", "1/2 可用", "中文", undefined]);
      act(() => setLang("en"));
      expect(tabs().map((tab) => tab.querySelector(".settings-tab-sub")?.textContent)).toEqual(["1/2 ready", "1/2 ready", "English", undefined]);
    });

    it("没有执行端信息时，执行端那一项不写小字（不编一个“0/0”）", () => {
      act(() => store.set({ harnesses: [] }));
      open("executors");
      expect(tabs()[0]!.querySelector(".settings-tab-sub")).toBeNull();
    });

    it("界面语言切到英文：窗口标题、导航名、分区标题与关闭按钮的名字立即跟着变", () => {
      open("executors");
      act(() => setLang("en"));
      expect(dialog()?.getAttribute("aria-label")).toBe("Settings");
      expect(dialog()!.querySelector("h2")?.textContent).toBe("Settings");
      expect(dialog()!.querySelector("h3")?.textContent).toBe("Harnesses");
      expect(tabs().map((tab) => tab.querySelector(".settings-tab-label")?.textContent)).toEqual(["Harnesses", "Roles", "General", "History"]);
      expect(dialog()!.querySelector('[aria-label="Close"]')).not.toBeNull();
    });

    it("关闭按钮与 Esc 都走 closeSettings；Esc 只关设置窗口，不会漏到外面", () => {
      open();
      act(() => dialog()!.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click());
      expect(store.get().settings.open).toBe(false);

      open();
      const outer: string[] = [];
      const spy = (event: Event): void => void outer.push((event as KeyboardEvent).key);
      document.addEventListener("keydown", spy);
      const event = key("Escape");
      document.removeEventListener("keydown", spy);
      expect(store.get().settings.open).toBe(false);
      expect(event.defaultPrevented).toBe(true);
      expect(outer).toEqual([]);
    });

    it("点遮罩也关闭", () => {
      open();
      act(() => document.body.querySelector<HTMLElement>(".overlay-backdrop")!.click());
      expect(store.get().settings.open).toBe(false);
    });
  });

  describe("分区：默认、切换、记忆", () => {
    it("不指定分区时落在登记表的第一项（窗口里没有写死分区名）", () => {
      open();
      expect(selectedTab().querySelector(".settings-tab-label")?.textContent).toBe("执行端");
      expect(dialog()!.querySelector(".settings")?.getAttribute("data-section")).toBe("executors");
    });

    it("指定分区就直接落在那里：标题与内容都是它的；不属于它的操作（刷新）不出现", () => {
      open("general");
      expect(selectedTab().querySelector(".settings-tab-label")?.textContent).toBe("通用");
      expect(dialog()!.querySelector("h3")?.textContent).toBe("通用");
      expect(panel().querySelector('[role="radiogroup"]')).not.toBeNull();
      expect(dialog()!.querySelector('[aria-label="重新探测"]')).toBeNull();

      open("executors");
      expect(dialog()!.querySelector('[aria-label="重新探测"]')).not.toBeNull();
    });

    it("点导航切换分区：选中态与 roving tabindex 同步，store 里的 section 同步", () => {
      open("executors");
      expect(tabs().map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1]);
      act(() => tabs()[2]!.click());
      expect(store.get().settings).toEqual({ open: true, section: "general" });
      expect(tabs().map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "false", "true", "false"]);
      expect(tabs().map((tab) => tab.tabIndex)).toEqual([-1, -1, 0, -1]);
      expect(tabs().map((tab) => tab.hasAttribute("data-active"))).toEqual([false, false, true, false]);
      act(() => tabs()[1]!.click());
      expect(store.get().settings).toEqual({ open: true, section: "profiles" });
      expect(dialog()!.querySelector("h3")?.textContent).toBe("角色");
    });

    it("关掉再不带分区地打开：回到上次看的分区；显式指定则以指定的为准", () => {
      open("executors");
      act(() => tabs()[2]!.click());
      act(() => closeSettings());
      open();
      expect(selectedTab().querySelector(".settings-tab-label")?.textContent).toBe("通用");
      open("executors");
      expect(selectedTab().querySelector(".settings-tab-label")?.textContent).toBe("执行端");
    });

    it("换分区整块重建：内容容器不是同一个节点（滚动位置与分区自己的视图状态不带过去）", () => {
      open("executors");
      const before = document.body.querySelector(".settings-body");
      act(() => tabs()[1]!.click());
      const after = document.body.querySelector(".settings-body");
      expect(after).not.toBe(before);
      expect(after?.hasAttribute("data-scroll")).toBe(true);
    });

    it("section 是登记表里没有的值时，退回第一项而不是渲染空窗口", () => {
      act(() => store.set({ settings: { open: true, section: "gone" as never } }));
      expect(selectedTab().querySelector(".settings-tab-label")?.textContent).toBe("执行端");
    });
  });

  describe("键盘与焦点", () => {
    it("打开时焦点落在“当前选中的导航项”上，而不是第一个按钮（选中“通用”时也是）", () => {
      open("executors");
      expect(document.activeElement).toBe(selectedTab());
      act(() => closeSettings());
      open("general");
      expect(document.activeElement).toBe(selectedTab());
      expect(document.activeElement).toBe(tabs()[2]);
    });

    it("方向键移动并切换：下/右到下一项，上/左到上一项，两端环绕，Home/End 到两端；焦点跟着选中项走", () => {
      open("executors");
      key("ArrowDown");
      expect(store.get().settings.section).toBe("profiles");
      expect(document.activeElement).toBe(tabs()[1]);
      key("ArrowDown");
      expect(store.get().settings.section).toBe("general");
      expect(document.activeElement).toBe(tabs()[2]);
      key("ArrowDown");
      expect(store.get().settings.section).toBe("history");
      expect(document.activeElement).toBe(tabs()[3]);
      key("ArrowDown");
      expect(store.get().settings.section).toBe("executors");
      expect(document.activeElement).toBe(tabs()[0]);
      key("ArrowLeft");
      expect(store.get().settings.section).toBe("history");
      key("ArrowRight");
      expect(store.get().settings.section).toBe("executors");
      key("End");
      expect(store.get().settings.section).toBe("history");
      key("Home");
      expect(store.get().settings.section).toBe("executors");
      key("ArrowUp");
      expect(store.get().settings.section).toBe("history");
      key("ArrowUp");
      expect(store.get().settings.section).toBe("general");
      expect(document.activeElement).toBe(selectedTab());
    });

    it("带修饰键的方向键不处理（留给浏览器与宿主）", () => {
      open("executors");
      for (const init of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }]) {
        const event = key("ArrowDown", init);
        expect(event.defaultPrevented).toBe(false);
      }
      expect(store.get().settings.section).toBe("executors");
      expect(document.activeElement).toBe(tabs()[0]);
    });

    it("Tab 圈定：只有选中的导航项按得到 Tab，Shift+Tab 在窗口里第一个可 Tab 的元素上被圈回最后一个", () => {
      Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get: () => document.body });
      try {
        open("general");
        expect(tabs().map((tab) => tab.tabIndex)).toEqual([-1, -1, 0, -1]);
        // 窗口里最先按得到 Tab 的是选中的“通用”（其余导航项都是 -1），所以 Shift+Tab 必须被拦下并圈到最后一个。
        expect(document.activeElement).toBe(tabs()[2]);
        expect(key("Tab", { shiftKey: true }).defaultPrevented).toBe(true);
        expect(document.activeElement).not.toBe(tabs()[2]);
        expect(dialog()!.contains(document.activeElement)).toBe(true);
      } finally {
        Reflect.deleteProperty(HTMLElement.prototype, "offsetParent");
      }
    });

    it("Esc 关闭后焦点回到打开它的按钮", () => {
      const trigger = document.getElementById("trigger")!;
      act(() => trigger.focus());
      open("general");
      expect(dialog()!.contains(document.activeElement)).toBe(true);
      key("Escape");
      expect(store.get().settings.open).toBe(false);
      expect(document.activeElement).toBe(trigger);
    });

    it("点关闭按钮关闭，焦点同样回到打开它的按钮", () => {
      const trigger = document.getElementById("trigger")!;
      act(() => trigger.focus());
      open();
      act(() => dialog()!.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click());
      expect(document.activeElement).toBe(trigger);
    });

    it("打开期间背景不抢焦点：窗口之外没有任何元素是 document.activeElement", () => {
      open();
      expect(dialog()!.contains(document.activeElement)).toBe(true);
    });
  });

  describe("窄画布（宿主的窄侧栏）：同一份 DOM，由窗口自己的宽度决定怎么排（读 overlays.css 文本；真实量测在浏览器里做过）", () => {
    const css = readFileSync("src/web/styles/overlays.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const narrow = css.slice(css.indexOf("@container (max-width: 600px)"));

    it("窗口是 inline-size 容器，排布规则写在容器查询里，且只有这一处断点", () => {
      expect(css).toMatch(/\.settings\s*\{[^}]*container-type:\s*inline-size;/);
      expect(css.match(/@container/g)).toHaveLength(1);
    });

    it("≤ 600：框架纵排，导航横排并去掉小字，设置项上下排；没有横向滚动出口（nav 不设 overflow-x）", () => {
      expect(narrow).toMatch(/\.settings-frame\s*\{[^}]*flex-direction:\s*column;/);
      expect(narrow).toMatch(/\.settings-nav\s*\{[^}]*flex-direction:\s*row;/);
      expect(narrow).toMatch(/\.settings-tab-sub\s*\{\s*display:\s*none;/);
      expect(narrow).toMatch(/\.setting-row\s*\{[^}]*flex-direction:\s*column;/);
      expect(narrow).not.toMatch(/overflow-x/);
    });

    it("窗口高度固定为 min(680px, 100vh − 64px)，不随分区内容伸缩（切换分区时不跳动）", () => {
      expect(css).toMatch(/\.settings\s*\{[^}]*height:\s*min\(680px,\s*calc\(100vh - 64px\)\);/);
    });
  });
});
