import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_CAPABILITIES } from "@shared/testing";
import type { HarnessId, HarnessInfo, ModelInfo } from "@shared/types";
import { api } from "../../lib/api";
import { setLang, store } from "../../lib/app";
import { SettingsWindow } from "./SettingsWindow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const models = (count: number, prefix = "m"): ModelInfo[] => Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}`, label: `${prefix.toUpperCase()} ${index}`, ...(index === 0 ? { isDefault: true } : {}) }));

const harness = (id: HarnessId, patch: Partial<HarnessInfo> = {}): HarnessInfo => ({
  id,
  displayName: id,
  runtime: "native",
  status: "ready",
  version: "1.0.0",
  models: models(3, id),
  capabilities: TEST_CAPABILITIES,
  access: { read_only: { level: "enforced", mechanism: "sandbox" }, full: null },
  checkedAt: "2026-01-01T00:00:00.000Z",
  ...patch,
});

/** 六个执行端，覆盖各种形态：就绪、60+ 个模型、需要设置（带安装命令）、不可用、检测中、没有模型目录。 */
const SIX = (): HarnessInfo[] => [
  harness("cursor"),
  harness("codex", { models: models(64, "x") }),
  harness("pi", { status: "needs_setup", models: [], setup: { code: "codex_login_required", message: "Sign in.", command: "pi login" } }),
  harness("claude", { status: "unavailable", models: [], setup: { code: "probe_failed", message: "spawn ENOENT" } }),
  harness("opencode", { status: "checking", models: [] }),
  harness("fixture", { runtime: "fixture", models: [] }),
];

describe("设置 · 执行端：卡片列表（折叠、键盘、多种状态）", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const previous = store.get();

  beforeEach(() => {
    setLang("zh");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.replaceChildren();
    store.set({ harnesses: previous.harnesses, settings: previous.settings, toasts: [], pendingModelSettings: {} });
    vi.restoreAllMocks();
  });

  const show = (infos: HarnessInfo[]): void => {
    store.set({ harnesses: infos, settings: { open: true, section: "executors" }, toasts: [] });
    act(() => root.render(<SettingsWindow />));
  };
  /** 卡片按 store 里 harnesses 的顺序渲染，所以按下标取。 */
  const ORDER = ["cursor", "codex", "pi", "claude", "opencode", "fixture"];
  const cards = (): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>(".hcard")];
  const card = (id: string): HTMLElement => cards()[ORDER.indexOf(id)]!;
  const toggleOf = (id: string): HTMLElement => card(id).querySelector<HTMLElement>(".hcard-toggle")!;
  const isOpen = (id: string): boolean => card(id).hasAttribute("data-open");
  const rowCount = (): number => document.body.querySelectorAll(".mrow").length;
  const key = (name: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
    act(() => void document.activeElement!.dispatchEvent(event));
    return event;
  };

  describe("折叠", () => {
    it("六个执行端：只有第一个默认展开；收起的头部已经带着状态与“已开放 n / 总数”", () => {
      show(SIX());
      expect(cards()).toHaveLength(6);
      expect(ORDER.map(isOpen)).toEqual([true, false, false, false, false, false]);
      expect(card("codex").querySelector(".hcard-sub")?.textContent).toContain("已开放 64 / 64 个模型");
      expect(card("codex").querySelector(".chip")?.textContent).toContain("可用");
    });

    it("只有展开的才渲染模型行：64 个模型的执行端收起时一行都不渲染（折叠的列表不进 DOM）", () => {
      show(SIX());
      expect(rowCount()).toBe(3);
      act(() => toggleOf("codex").click());
      expect(rowCount()).toBe(3 + 64);
      act(() => toggleOf("cursor").click());
      expect(rowCount()).toBe(64);
    });

    it("开合钮是 h4 里的按钮：aria-expanded 跟随，展开时 aria-controls 指向面板，收起时不带", () => {
      show(SIX());
      const first = toggleOf("cursor");
      expect(first.tagName).toBe("BUTTON");
      expect(first.closest("h4")).not.toBeNull();
      expect(first.getAttribute("aria-expanded")).toBe("true");
      expect(document.getElementById(first.getAttribute("aria-controls")!)?.classList.contains("hcard-panel")).toBe(true);
      act(() => first.click());
      expect(first.getAttribute("aria-expanded")).toBe("false");
      expect(first.hasAttribute("aria-controls")).toBe(false);
      expect(isOpen("cursor")).toBe(false);
    });

    it("用户开合过之后以用户的为准：列表刷新（新数组、新检测时间）不会把卡片重新折回默认", () => {
      show(SIX());
      act(() => toggleOf("codex").click());
      act(() => toggleOf("cursor").click());
      expect(ORDER.map(isOpen)).toEqual([false, true, false, false, false, false]);
      act(() => store.set({ harnesses: SIX().map((info) => ({ ...info, checkedAt: "2026-01-02T00:00:00.000Z" })) }));
      expect(ORDER.map(isOpen)).toEqual([false, true, false, false, false, false]);
    });

    it("不可展开的卡片（检测中：没有模型也没有提示）头部不是按钮：没有箭头、没有 aria-expanded、不在 Tab 顺序里", () => {
      show(SIX());
      const head = toggleOf("opencode");
      expect(head.tagName).toBe("SPAN");
      expect(head.hasAttribute("aria-expanded")).toBe(false);
      expect(head.hasAttribute("tabindex")).toBe(false);
      expect(card("opencode").querySelector(".hcard-chevron")).toBeNull();
      expect(card("opencode").querySelector(".chip")?.textContent).toContain("检测中");
      // 就绪但目录读不到的执行端仍可展开（里面说明没有读到模型）。
      expect(toggleOf("fixture").tagName).toBe("BUTTON");
    });
  });

  describe("各种状态", () => {
    it("需要设置：展开后给出提示与可复制的命令，没有模型区块；头部不写“已开放”", () => {
      show(SIX());
      act(() => toggleOf("pi").click());
      expect(card("pi").querySelector(".hcard-setup")).not.toBeNull();
      expect(card("pi").querySelector(".cmd code")?.textContent).toBe("pi login");
      expect(card("pi").querySelector('[aria-label="复制命令"]')).not.toBeNull();
      expect(card("pi").querySelector(".mrow")).toBeNull();
      expect(card("pi").querySelector(".hcard-sub")?.textContent).not.toContain("已开放");
      expect(card("pi").querySelector(".chip")?.textContent).toContain("需要设置");
    });

    it("不可用：标着检测时间与原因，状态是“不可用”", () => {
      show(SIX());
      act(() => toggleOf("claude").click());
      expect(card("claude").querySelector(".chip")?.textContent).toContain("不可用");
      expect(card("claude").querySelector(".hcard-sub")?.textContent).toMatch(/检测/);
      expect(card("claude").querySelector(".hcard-setup")?.textContent).toContain("spawn ENOENT");
    });

    it("状态靠结构区分，不靠颜色：可用是实心方块，需要设置与不可用是空心方块，检测中是框里带一道推移带子的方块（也是同一个 .status-pip，窗口里没有圆形的转圈）；可用不再用 teal（它与“不可用”的红是同一个朱砂色相）", () => {
      show(SIX());
      const pip = (id: string): string | null | undefined => card(id).querySelector(".status-pip")?.getAttribute("data-status");
      const tone = (id: string): string | null | undefined => card(id).querySelector(".hcard-toggle > .chip")?.getAttribute("data-tone");
      expect(["cursor", "pi", "claude", "opencode"].map(pip)).toEqual(["ready", "needs_setup", "unavailable", "checking"]);
      // 检测中与别的状态是同一种元素（同一个 8×8、同一条中线、同一套网格），不再是全局的 .spinner；整个设置窗口里一个转圈也没有。
      expect(card("opencode").querySelector(".spinner")).toBeNull();
      expect(document.body.querySelector(".settings .spinner")).toBeNull();
      // 标记是纯装饰：每种状态的标记都 aria-hidden，读屏读的是后面的词（检测中也一样，词没有丢）。
      expect(ORDER.map((id) => card(id).querySelector(".status-pip")?.getAttribute("aria-hidden"))).toEqual(ORDER.map(() => "true"));
      expect(card("opencode").querySelector(".chip")?.textContent).toBe("检测中");
      expect(["cursor", "pi", "claude", "opencode"].map(tone)).toEqual(["neutral", "amber", "red", "neutral"]);
    });

    it("模拟执行端带“模拟执行”标（与卡片头其余部分同在名字旁）", () => {
      show(SIX());
      expect(card("fixture").querySelector(".hcard-name .chip")?.textContent).toBe("模拟执行");
      expect(card("cursor").querySelector(".hcard-name .chip")).toBeNull();
    });

    it("空列表：只有一句“还没有执行端信息。”，没有说明段与卡片；刷新按钮仍在窗口标题行上", () => {
      show([]);
      expect(cards()).toHaveLength(0);
      expect(document.body.querySelector(".settings-body")?.textContent).toBe("还没有执行端信息。");
      expect(document.body.querySelector(".settings-intro")).toBeNull();
      expect(document.body.querySelector('[aria-label="重新探测"]')).not.toBeNull();
    });

    it("列表来自 store：多一个执行端就多一张卡片，不需要改任何代码（没有写死的执行端清单）", () => {
      show(SIX().slice(0, 2));
      expect(cards()).toHaveLength(2);
      act(() => store.set({ harnesses: SIX() }));
      expect(cards()).toHaveLength(6);
    });

    it("英文界面：状态、已开放摘要与说明都是英文，布局类名不变", () => {
      setLang("en");
      show(SIX());
      expect(card("codex").querySelector(".hcard-sub")?.textContent).toContain("64 / 64 models open");
      expect(card("pi").querySelector(".chip")?.textContent).toContain("Needs setup");
      expect(document.body.querySelector(".settings-intro")).not.toBeNull();
    });
  });

  describe("键盘", () => {
    it("上下键在能开合的卡片头之间走（跳过检测中那个不可展开的），到头不环绕；左右键不处理", () => {
      show(SIX());
      act(() => toggleOf("cursor").focus());
      key("ArrowDown");
      expect(document.activeElement).toBe(toggleOf("codex"));
      key("ArrowDown");
      expect(document.activeElement).toBe(toggleOf("pi"));
      key("ArrowDown");
      expect(document.activeElement).toBe(toggleOf("claude"));
      key("ArrowDown");
      expect(document.activeElement).toBe(toggleOf("fixture"));
      key("ArrowDown");
      expect(document.activeElement).toBe(toggleOf("fixture"));
      key("ArrowUp");
      expect(document.activeElement).toBe(toggleOf("claude"));
      key("Home");
      expect(document.activeElement).toBe(toggleOf("cursor"));
      key("End");
      expect(document.activeElement).toBe(toggleOf("fixture"));
      expect(key("ArrowRight").defaultPrevented).toBe(false);
    });

    it("Enter / 空格由原生 button 转成 click，这里直接 click 验证开合；焦点在开合后仍在同一个钮上", () => {
      show(SIX());
      act(() => toggleOf("codex").focus());
      act(() => toggleOf("codex").click());
      expect(isOpen("codex")).toBe(true);
      expect(document.activeElement).toBe(toggleOf("codex"));
    });

    it("展开 64 个模型的执行端：上下键在勾选行之间走，不会漏到卡片头的上下键处理", () => {
      show(SIX());
      act(() => toggleOf("codex").click());
      const inputs = (): HTMLInputElement[] => [...card("codex").querySelectorAll<HTMLInputElement>(".mrow-input")];
      expect(inputs()).toHaveLength(64);
      act(() => inputs()[0]!.focus());
      key("ArrowDown");
      expect(document.activeElement).toBe(inputs()[1]);
      key("ArrowDown");
      expect(document.activeElement).toBe(inputs()[2]);
      key("ArrowUp");
      expect(document.activeElement).toBe(inputs()[1]);
      key("End");
      expect(document.activeElement).toBe(inputs()[63]);
      key("Home");
      expect(document.activeElement).toBe(inputs()[0]);
    });
  });

  describe("重新探测（窗口标题行上的操作）", () => {
    it("点击期间禁用并转圈；返回后更新列表并提示“已重新探测”；调用的是 refresh=true", async () => {
      let finish!: (value: { harnesses: HarnessInfo[] }) => void;
      const spy = vi.spyOn(api, "harnesses").mockImplementation(() => new Promise((resolve) => void (finish = resolve)));
      show(SIX().slice(0, 1));
      const button = (): HTMLButtonElement => document.body.querySelector<HTMLButtonElement>('[aria-label="重新探测"]')!;
      act(() => button().click());
      expect(spy).toHaveBeenCalledWith(true);
      expect(button().disabled).toBe(true);
      expect(button().classList.contains("is-spinning")).toBe(true);
      // 探测期间再点不会再发请求
      act(() => button().click());
      expect(spy).toHaveBeenCalledTimes(1);

      await act(async () => finish({ harnesses: SIX() }));
      expect(button().disabled).toBe(false);
      expect(button().classList.contains("is-spinning")).toBe(false);
      expect(cards()).toHaveLength(6);
      expect(store.get().toasts.at(-1)?.text).toBe("已重新探测");
    });

    it("失败时按钮恢复可点，列表不变，也不提示“已重新探测”", async () => {
      vi.spyOn(api, "harnesses").mockRejectedValue(new Error("boom"));
      show(SIX().slice(0, 2));
      const button = (): HTMLButtonElement => document.body.querySelector<HTMLButtonElement>('[aria-label="重新探测"]')!;
      await act(async () => button().click());
      expect(button().disabled).toBe(false);
      expect(cards()).toHaveLength(2);
      expect(store.get().toasts.some((toast) => toast.text === "已重新探测")).toBe(false);
    });
  });
});
