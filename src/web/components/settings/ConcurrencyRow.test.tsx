import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Capacity, ConcurrencySetting, SetConcurrencyResponse } from "@shared/protocol";
import { api } from "../../lib/api";
import { openSettings, store, type AppState } from "../../lib/app";
import { ConcurrencyRow } from "./ConcurrencyRow";
import { base, capacity, stored, type Held } from "./ConcurrencyRow.fixtures";
import { GeneralSection } from "./GeneralSection";
import { SettingsWindow } from "./SettingsWindow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 并发上限这一行的测试之一：外观（全部来自服务端给的数据）、此刻改不了、可访问性与语言、在“通用”分区与设置窗口里的衔接，以及 limits.css 的样式。
// 提交、不合法的草稿与步进钮在 ConcurrencyRow.commit.test.tsx，限制 / 不限制、恢复默认、失败与竞态在 ConcurrencyRow.modes.test.tsx；共用的样本在 ConcurrencyRow.fixtures.ts。

describe("设置 · 通用：并发上限（ConcurrencyRow）", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let held: Held[];
  const previous = store.get();

  beforeEach(() => {
    store.set({
      lang: "zh",
      conn: "live",
      concurrency: undefined,
      capacity: capacity(0),
      pendingConcurrency: undefined,
      toasts: [],
      settings: { open: false, section: undefined },
    });
    // 所有请求默认挂起：测试从不碰真实的 fetch，回执由 answer / refuse 决定。
    held = [];
    vi.spyOn(api, "setConcurrency").mockImplementation(
      (value) =>
        new Promise<SetConcurrencyResponse>((resolve, reject) => {
          held.push({ value, resolve, reject });
        }),
    );
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
      conn: previous.conn,
      concurrency: previous.concurrency,
      capacity: previous.capacity,
      pendingConcurrency: previous.pendingConcurrency,
      toasts: previous.toasts,
      settings: previous.settings,
    });
    vi.restoreAllMocks();
  });

  // ───────────────────────── 夹具与操作 ─────────────────────────

  const show = (setting: ConcurrencySetting, cap: Capacity, extra: Partial<AppState> = {}): void =>
    void act(() => {
      store.set({ concurrency: setting, capacity: cap, ...extra });
      root.render(<ConcurrencyRow />);
    });

  // 设置窗口是挂在 body 上的 portal，所以一律从 body 查，而不是只查 host。
  const label = (): string | undefined => document.body.querySelector(".setting-label")?.textContent ?? undefined;
  const radios = (): HTMLButtonElement[] => [...document.body.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  const checked = (): string[] => radios().filter((radio) => radio.getAttribute("aria-checked") === "true").map((radio) => radio.textContent ?? "");
  const input = (): HTMLInputElement | null => document.body.querySelector<HTMLInputElement>('input[role="spinbutton"]');
  const steps = (): HTMLButtonElement[] => [...document.body.querySelectorAll<HTMLButtonElement>(".concurrency-step")];
  const restore = (): HTMLButtonElement | null => document.body.querySelector<HTMLButtonElement>(".link-btn");
  /** 数字框下面的小字，一段一行（占用与等待、占用超限、来源），不含草稿不合法的那句。 */
  const lines = (): string[] => [...document.body.querySelectorAll("div.concurrency-meta > p")].map((line) => line.textContent ?? "");
  const sourceLine = (): string | undefined => lines().pop();

  const type = (text: string): void =>
    void act(() => {
      const field = input()!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, text);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });

  const press = (target: Element, name: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
    // 有的环境不认 KeyboardEventInit 里的 isComposing：补上，免得“组字期间”的用例空转。
    if (init.isComposing !== undefined && event.isComposing !== init.isComposing) Object.defineProperty(event, "isComposing", { value: init.isComposing });
    act(() => void target.dispatchEvent(event));
    return event;
  };

  // ───────────────────────── 外观：全部来自服务端给的数据 ─────────────────────────

  describe("外观", () => {
    it("服务没给这项设置（老服务、第一份快照还没到）：整行不出现，不拿“没给”当成“不限制”", () => {
      act(() => root.render(<ConcurrencyRow />));
      expect(host.innerHTML).toBe("");
    });

    it("有上限：单选停在“限制”，数字框是生效的数字，下面是实时的占用与等待、以及这个数字的来历", () => {
      show(base, capacity(20, 3, 1));
      expect(label()).toBe("并发上限");
      expect(radios().map((radio) => radio.textContent)).toEqual(["限制", "不限制"]);
      expect(checked()).toEqual(["限制"]);
      expect(radios().map((radio) => radio.hasAttribute("data-active"))).toEqual([true, false]);
      expect(input()?.value).toBe("20");
      expect(lines()).toEqual(["占用 3 · 等待 1", "未指定，沿用默认：20"]);
      expect(restore()).toBeNull();
    });

    it("不限制：没有数字框与步进钮；已经在这里指定过，所以有“恢复默认”", () => {
      show(stored("unlimited"), capacity(0, 2, 0));
      expect(checked()).toEqual(["不限制"]);
      expect(radios().map((radio) => radio.hasAttribute("data-active"))).toEqual([false, true]);
      expect(input()).toBeNull();
      expect(steps()).toHaveLength(0);
      expect(lines()).toEqual(["占用 2 · 等待 0", "已在这里指定 恢复默认（20）"]);
    });

    const sources: Array<[string, ConcurrencySetting, Capacity, string]> = [
      ["已在这里指定", stored(8), capacity(8), "已在这里指定 恢复默认（20）"],
      ["沿用环境变量", { source: "env", inherited: { max: 6, source: "env" } }, capacity(6), "未指定，沿用环境变量 ENSEMBLE_MAX_CONCURRENT_RUNS：6"],
      ["沿用环境变量（它本身是不限制）", { source: "env", inherited: { max: 0, source: "env" } }, capacity(0), "未指定，沿用环境变量 ENSEMBLE_MAX_CONCURRENT_RUNS：不限制"],
      ["沿用内置默认", base, capacity(20), "未指定，沿用默认：20"],
      ["启动服务的程序固定了它", { source: "startup", inherited: base.inherited }, capacity(2), "由启动服务的程序固定，这里不能修改"],
    ];

    it.each(sources)("来源：%s", (_name, setting, cap, line) => {
      show(setting, cap);
      expect(sourceLine()).toBe(line);
    });

    it("“恢复默认（N）”里的 N 是清掉指定之后会落到的值：环境变量或内置默认，环境变量是不限制就写不限制", () => {
      show(stored(8, { max: 6, source: "env" }), capacity(8));
      expect(restore()?.textContent).toBe("恢复默认（6）");
      act(() => store.set({ concurrency: stored(8, { max: 0, source: "env" }) }));
      expect(restore()?.textContent).toBe("恢复默认（不限制）");
    });

    it("占用与等待只在连接是“已连接”时显示：断线时那是过期的数，不显示", () => {
      show(base, capacity(20, 3, 1), { conn: "reconnecting" });
      expect(lines()).toEqual(["未指定，沿用默认：20"]);
      act(() => store.set({ conn: "live" }));
      expect(lines()).toEqual(["占用 3 · 等待 1", "未指定，沿用默认：20"]);
      act(() => store.set({ conn: "offline" }));
      expect(lines()).toEqual(["未指定，沿用默认：20"]);
    });

    it("占用与等待跟着服务端的推送实时更新（推送写进 store 就重绘）", () => {
      show(base, capacity(20, 3, 1));
      act(() => store.set({ capacity: capacity(20, 5, 0) }));
      expect(lines()[0]).toBe("占用 5 · 等待 0");
    });

    it("调低之后占用暂时高于上限：如实说明；没超、不限制、断线时都不这么说", () => {
      show(stored(2), capacity(2, 5, 3));
      expect(lines()).toEqual([
        "占用 5 · 等待 3",
        "占用已超过上限：正在运行的会话不受影响，名额随它们结束逐渐收回。",
        "已在这里指定 恢复默认（20）",
      ]);
      act(() => store.set({ capacity: capacity(2, 2, 3) }));
      expect(lines()).toEqual(["占用 2 · 等待 3", "已在这里指定 恢复默认（20）"]);
      act(() => store.set({ capacity: capacity(0, 5, 0), concurrency: stored("unlimited") }));
      expect(lines()).toEqual(["占用 5 · 等待 0", "已在这里指定 恢复默认（20）"]);
      act(() => store.set({ capacity: capacity(2, 5, 3), concurrency: stored(2), conn: "reconnecting" }));
      expect(lines()).toEqual(["已在这里指定 恢复默认（20）"]);
    });

    it("没有保存按钮：除了单选、步进钮与“恢复默认”，这一行里没有别的按钮", () => {
      show(stored(8), capacity(8));
      expect(document.body.querySelector("button:not([role='radio']):not(.concurrency-step):not(.link-btn)")).toBeNull();
    });
  });

  // ───────────────────────── 此刻改不了 ─────────────────────────

  describe("此刻改不了", () => {
    const locked: Array<[string, ConcurrencySetting, Capacity, string]> = [
      ["启动服务的程序固定了上限", { source: "startup", stored: 7, inherited: base.inherited }, capacity(2), "由启动服务的程序固定，这里不能修改"],
      [
        "设置文件读不出来",
        { source: "default", inherited: base.inherited, issue: "unreadable_file" },
        capacity(20),
        "无法读取 settings.json，暂时不能在这里修改；现在用的是 20。恢复文件后重启 Ensemble。",
      ],
    ];

    it.each(locked)("%s：单选、数字框、步进钮都禁用，不给恢复默认，原因写在下面", (_name, setting, cap, line) => {
      show(setting, cap);
      expect(radios().every((radio) => radio.disabled)).toBe(true);
      expect(input()?.disabled).toBe(true);
      expect(steps().every((step) => step.disabled)).toBe(true);
      expect(document.body.querySelector('[role="radiogroup"]')?.getAttribute("aria-disabled")).toBe("true");
      expect(restore()).toBeNull();
      expect(sourceLine()).toBe(line);
      // 显示的仍是服务端真正生效的数字。
      expect(input()?.value).toBe(String(cap.max));
    });

    it("可以改的时候单选组不带 aria-disabled", () => {
      show(base, capacity(20));
      expect(document.body.querySelector('[role="radiogroup"]')?.hasAttribute("aria-disabled")).toBe(false);
    });
  });

  // ───────────────────────── 可访问性与语言 ─────────────────────────

  describe("可访问性与语言", () => {
    it("单选组有名字与说明（说明包括下面的占用与来源）；步进钮与数字框互相指认", () => {
      show(base, capacity(20, 3, 1));
      const group = document.body.querySelector('[role="radiogroup"]')!;
      expect(document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent).toBe("并发上限");
      const described = group.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id));
      expect(described).toHaveLength(2);
      expect(described[0]?.textContent).toContain("同时运行的会话数上限");
      expect(described[1]?.textContent).toContain("占用 3 · 等待 1");

      const field = input()!;
      expect(field.getAttribute("role")).toBe("spinbutton");
      expect(field.getAttribute("aria-label")).toBe("最多同时运行的会话数");
      expect(field.getAttribute("aria-valuemin")).toBe("1");
      expect(field.getAttribute("aria-valuemax")).toBe("1000");
      expect(field.getAttribute("aria-valuenow")).toBe("20");
      expect(field.getAttribute("inputmode")).toBe("numeric");
      expect(steps().map((step) => step.getAttribute("aria-label"))).toEqual(["减少", "增加"]);
      expect(steps().map((step) => step.getAttribute("aria-controls"))).toEqual([field.id, field.id]);
    });

    it("草稿不合法的提示是 role=alert（读屏立即念出）", () => {
      show(base, capacity(20));
      type("0");
      expect(document.body.querySelector('[role="alert"]')).not.toBeNull();
    });

    it("界面语言切到英文：名字、单选、数字框、步进钮、来源与占用立即跟着变", () => {
      show(base, capacity(20, 3, 1));
      act(() => store.set({ lang: "en" }));
      expect(label()).toBe("Concurrent runs");
      expect(radios().map((radio) => radio.textContent)).toEqual(["Limit", "No limit"]);
      expect(input()?.getAttribute("aria-label")).toBe("Maximum concurrent sessions");
      expect(steps().map((step) => step.getAttribute("aria-label"))).toEqual(["Decrease", "Increase"]);
      expect(lines()).toEqual(["In use 3 · Waiting 1", "Not set here; using the default: 20"]);
      act(() => store.set({ concurrency: stored("unlimited", { max: 0, source: "env" }), capacity: capacity(0) }));
      expect(restore()?.textContent).toBe("Restore default (No limit)");
    });
  });

  // ───────────────────────── 在“通用”分区与设置窗口里 ─────────────────────────

  describe("衔接", () => {
    it("“通用”分区：语言一行在前，并发上限在后；服务没给这项设置时只剩语言一行", () => {
      act(() => root.render(<GeneralSection />));
      expect(document.body.querySelectorAll(".setting-row")).toHaveLength(1);
      expect(document.body.querySelector(".setting-row--concurrency")).toBeNull();

      act(() => store.set({ concurrency: base, capacity: capacity(20) }));
      const rows = [...document.body.querySelectorAll(".setting-row")];
      expect(rows).toHaveLength(2);
      expect(rows[0]?.classList.contains("setting-row--concurrency")).toBe(false);
      expect(rows[1]?.classList.contains("setting-row--concurrency")).toBe(true);
    });

    it("在设置窗口里：数字框有草稿时 Esc 只还原草稿，窗口不关；没有草稿时再按一次才关窗口", () => {
      act(() => {
        store.set({ concurrency: base, capacity: capacity(20) });
        root.render(<SettingsWindow />);
      });
      act(() => openSettings("general"));
      expect(store.get().settings.open).toBe(true);
      act(() => input()!.focus());

      type("99");
      const first = press(input()!, "Escape");
      expect(first.defaultPrevented).toBe(true);
      expect(store.get().settings.open).toBe(true);
      expect(input()?.value).toBe("20");

      press(input()!, "Escape");
      expect(store.get().settings.open).toBe(false);
    });
  });
});

describe("limits.css：并发上限这一行的样式（读文本；真实量测要在浏览器里做）", () => {
  const css = readFileSync("src/web/styles/limits.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const main = readFileSync("src/web/main.tsx", "utf8");

  it("在 main.tsx 里紧跟 overlays.css 引入：行样式要晚于设置窗口的主样式", () => {
    const overlays = main.indexOf('import "./styles/overlays.css";');
    const limits = main.indexOf('import "./styles/limits.css";');
    expect(overlays).toBeGreaterThan(-1);
    expect(limits).toBeGreaterThan(overlays);
  });

  it("窄窗口只有一处容器查询断点（由窗口自己的宽度决定，不量宽度、不用脚本）", () => {
    expect(css.match(/@container/g)).toHaveLength(1);
    expect(css).toMatch(/@container \(max-width: 880px\)/);
  });

  it("尺寸取 4px 网格：宽、高、间距、行高的像素值都是 4 的倍数", () => {
    const values = [...css.matchAll(/\b(?:width|height|gap|line-height)\s*:\s*(\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1]));
    expect(values.length).toBeGreaterThan(8);
    expect(values.filter((value) => value % 4 !== 0)).toEqual([]);
  });

  it("颜色只取自 token：没有写死的十六进制色值与 rgb / hsl", () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
  });
});
