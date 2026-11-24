import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProfilesView } from "@shared/profiles";
import { applyProfiles, openSettings, setLang, store, type AppState } from "../../lib/app";
import { bindT } from "../../lib/i18n";
import { PROFILES_UNSUPPORTED } from "../../lib/profiles";
import { ProfilesSection, profilesSummary } from "./ProfilesSection";
import { SettingsWindow } from "./SettingsWindow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 设置 · 角色：新网页连着没有角色功能的老服务（快照里没有 `profiles`，live.ts 把“不支持”的标记放进 store）时的样子。
 * 与“有这项功能、只是还没建角色”分开：后者给编辑器和“添加角色”，前者只给一句如实的说明——
 * 否则用户会对着一个能点的“添加”忙半天，到保存时才在服务端的 404 上碰壁。导航项照旧留着，设置窗口的结构不随服务版本跳动。
 * 快照怎么变成标记见 lib/live.profiles.test.ts；分区在有功能时的样子见 ProfilesSection.test.tsx。
 */
const LEGACY_ZH = "当前连接的 Ensemble 服务版本较旧，不支持委派角色，所以这里没法添加或修改。更新并重启服务后再来。";
const LEGACY_EN =
  "The Ensemble service you're connected to is an older version that doesn't support delegation roles, so roles can't be added or changed here. Update and restart the service, then come back.";

describe("设置 · 角色：连着没有角色功能的老服务", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const previous = store.get();

  beforeEach(() => {
    setLang("zh");
    store.set({ toasts: [], confirm: undefined, harnesses: [], profiles: PROFILES_UNSUPPORTED, settings: { open: false, section: undefined } });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.replaceChildren();
    store.set({
      lang: previous.lang,
      toasts: previous.toasts,
      confirm: previous.confirm,
      harnesses: previous.harnesses,
      profiles: previous.profiles,
      settings: previous.settings,
    });
  });

  const renderSection = (): void => void act(() => root.render(<ProfilesSection />));
  const addButton = (): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>(".prof-foot button");

  describe("分区本身", () => {
    it("只有一句说明：没有编辑器、没有“添加角色”、没有表头与行，也没有“还没有角色”这种话（那是有功能时的空表）", () => {
      renderSection();
      expect(host.querySelector('[role="status"]')?.textContent).toBe(LEGACY_ZH);
      expect(host.querySelectorAll("button, input, select")).toHaveLength(0);
      for (const selector of [".prof", ".prof-table", ".prof-empty", ".prof-foot", ".prof-row", ".prof-cols", ".settings-intro"]) {
        expect(host.querySelector(selector), selector).toBeNull();
      }
      expect(host.textContent).toBe(LEGACY_ZH);
    });

    it("英文界面同样如实说明（中英词条成对）", () => {
      act(() => setLang("en"));
      renderSection();
      expect(host.querySelector('[role="status"]')?.textContent).toBe(LEGACY_EN);
      expect(host.textContent).not.toMatch(/[\u3400-\u9fff]/);
    });

    it("有功能的服务、角色表是空的：照旧是编辑器（“还没有角色”加“添加角色”）——与老服务分得开", () => {
      act(() => store.set({ profiles: { entries: [] } }));
      renderSection();
      expect(host.querySelector(".prof-empty")?.textContent).toBe("还没有角色。添加一个，主 Agent 就能按名字选用它。");
      expect(addButton()?.textContent).toBe("添加角色");
      expect(host.textContent).not.toContain("版本较旧");
    });

    it("设置文件读不了仍是“暂时不可用”（有这项功能），不是“老服务”", () => {
      act(() => store.set({ profiles: { entries: [], unavailable: "unreadable_file" } }));
      renderSection();
      expect(host.querySelector('[role="status"]')?.textContent).toBe("无法读取 settings.json，角色暂时不可用。恢复文件后重启 Ensemble。");
      expect(host.textContent).not.toContain("版本较旧");
    });

    it("同一个组件在两种形态之间来回切换也不出错（hook 都在分支之前）：服务升级后快照带来 profiles，换回老服务又变回说明", () => {
      renderSection();
      expect(host.textContent).toBe(LEGACY_ZH);

      act(() => applyProfiles({ entries: [] }));
      expect(host.textContent).not.toContain("版本较旧");
      expect(addButton()?.textContent).toBe("添加角色");

      act(() => store.set({ profiles: PROFILES_UNSUPPORTED }));
      expect(host.textContent).toBe(LEGACY_ZH);
      expect(addButton()).toBeNull();
    });

    it("界面语言在说明显示着的时候切换：立即换成另一种语言", () => {
      renderSection();
      expect(host.textContent).toBe(LEGACY_ZH);
      act(() => setLang("en"));
      expect(host.textContent).toBe(LEGACY_EN);
    });
  });

  describe("导航项下面的小字（profilesSummary）", () => {
    const state = (profiles: ProfilesView): AppState => ({ ...store.get(), profiles, harnesses: [] });

    it("没有角色功能：如实写“不可用”（中英文），不写“0 个角色”这类数", () => {
      expect(profilesSummary(state(PROFILES_UNSUPPORTED), bindT("zh"))).toBe("不可用");
      expect(profilesSummary(state(PROFILES_UNSUPPORTED), bindT("en"))).toBe("Unavailable");
    });

    it("有功能但还没有角色、或读不出来时仍不写：只有“老服务”才写不可用", () => {
      expect(profilesSummary(state({ entries: [] }), bindT("zh"))).toBeUndefined();
      expect(profilesSummary(state({ entries: [], unavailable: "unreadable_file" }), bindT("zh"))).toBeUndefined();
    });
  });

  describe("设置窗口里", () => {
    const tabs = (): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>('[role="tab"]')];
    const sub = (index: number): string | undefined => tabs()[index]?.querySelector(".settings-tab-sub")?.textContent ?? undefined;
    const panel = (): HTMLElement => document.body.querySelector<HTMLElement>('[role="tabpanel"]')!;

    beforeEach(() => {
      act(() => root.render(<SettingsWindow />));
    });

    it("“角色”这一项仍在导航里（窗口的结构不随服务版本跳动），小字写“不可用”，点进去是那句说明、没有“添加角色”", () => {
      act(() => openSettings("profiles"));
      expect(tabs().map((tab) => tab.querySelector(".settings-tab-label")?.textContent)).toEqual(["执行端", "角色", "通用", "历史"]);
      expect(sub(1)).toBe("不可用");
      expect(tabs()[1]!.getAttribute("aria-selected")).toBe("true");
      expect(panel().textContent).toContain(LEGACY_ZH);
      expect(panel().querySelector(".prof-foot")).toBeNull();
      expect([...panel().querySelectorAll("button")].map((button) => button.textContent)).not.toContain("添加角色");
    });

    it("换语言：小字与说明一起换", () => {
      act(() => openSettings("profiles"));
      act(() => setLang("en"));
      expect(tabs().map((tab) => tab.querySelector(".settings-tab-label")?.textContent)).toEqual(["Harnesses", "Roles", "General", "History"]);
      expect(sub(1)).toBe("Unavailable");
      expect(panel().textContent).toContain(LEGACY_EN);
    });

    it("服务升级之后（新的快照带着 profiles）：窗口开着也不用刷新，小字消失、说明换成编辑器", () => {
      act(() => openSettings("profiles"));
      expect(sub(1)).toBe("不可用");

      act(() => applyProfiles({ entries: [] }));
      expect(sub(1)).toBeUndefined();
      expect(panel().textContent).not.toContain("版本较旧");
      expect(panel().querySelector(".prof-foot button")?.textContent).toBe("添加角色");
    });
  });
});
