import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLang, store } from "../../lib/app";
import { detectLang } from "../../lib/i18n";
import { GeneralSection, generalSummary } from "./GeneralSection";
import { SettingsWindow } from "./SettingsWindow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("设置 · 通用：界面语言", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const previous = store.get();

  beforeEach(() => {
    localStorage.removeItem("ensemble.lang");
    setLang("zh");
    document.documentElement.lang = "";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.replaceChildren();
    store.set({ settings: previous.settings, lang: previous.lang });
    localStorage.removeItem("ensemble.lang");
  });

  const render = (): void => void act(() => root.render(<GeneralSection />));
  const radios = (): HTMLButtonElement[] => [...document.body.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  const group = (): HTMLElement => document.body.querySelector<HTMLElement>('[role="radiogroup"]')!;
  const checked = (): string[] => radios().filter((radio) => radio.getAttribute("aria-checked") === "true").map((radio) => radio.textContent!);
  const key = (name: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
    act(() => void document.activeElement!.dispatchEvent(event));
    return event;
  };

  it("一项设置：单选组里是各语言自己的名字“中文”“English”（不随界面语言翻译），当前语言被选中", () => {
    render();
    expect(radios().map((radio) => radio.textContent)).toEqual(["中文", "English"]);
    expect(checked()).toEqual(["中文"]);
    act(() => setLang("en"));
    expect(radios().map((radio) => radio.textContent)).toEqual(["中文", "English"]);
    expect(checked()).toEqual(["English"]);
  });

  it("可访问性：radiogroup 有名字（双语标签，认得出自己语言的人都找得到）和说明；每个选项标着自己的语言（读屏用对的口音）", () => {
    render();
    const label = document.getElementById(group().getAttribute("aria-labelledby")!);
    expect(label?.textContent).toBe("语言 / Language");
    expect(document.getElementById(group().getAttribute("aria-describedby")!)?.textContent).toBe("只保存在这个浏览器里，选中即生效。");
    expect(radios().map((radio) => radio.getAttribute("lang"))).toEqual(["zh-CN", "en"]);
    act(() => setLang("en"));
    expect(document.getElementById(group().getAttribute("aria-labelledby")!)?.textContent).toBe("语言 / Language");
  });

  it("说明只讲“这个浏览器”：不说所有宿主共用（语言存在 localStorage，不是服务端设置）", () => {
    render();
    expect(document.body.textContent).toContain("这个浏览器");
    expect(document.body.textContent).not.toMatch(/所有宿主|共用|同步/);
    act(() => setLang("en"));
    expect(document.body.textContent).toContain("this browser");
    expect(document.body.textContent).not.toMatch(/all hosts|shared|sync/i);
  });

  it("点选即生效：没有保存按钮；store、localStorage（ensemble.lang）与 <html lang> 都由 setLang 一处维护", () => {
    render();
    expect(document.body.querySelector("button:not([role='radio'])")).toBeNull();
    act(() => radios()[1]!.click());
    expect(store.get().lang).toBe("en");
    expect(localStorage.getItem("ensemble.lang")).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(checked()).toEqual(["English"]);
    // 说明文字立即换成英文
    expect(document.body.textContent).toContain("Saved in this browser only");
    act(() => radios()[0]!.click());
    expect(store.get().lang).toBe("zh");
    expect(localStorage.getItem("ensemble.lang")).toBe("zh");
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("roving tabindex：只有选中的那个在 Tab 顺序里", () => {
    render();
    expect(radios().map((radio) => radio.tabIndex)).toEqual([0, -1]);
    act(() => setLang("en"));
    expect(radios().map((radio) => radio.tabIndex)).toEqual([-1, 0]);
  });

  it("方向键移动并选中：左/上到前一个，右/下到后一个，两端环绕；焦点跟着走", () => {
    render();
    act(() => radios()[0]!.focus());
    key("ArrowRight");
    expect(store.get().lang).toBe("en");
    expect(document.activeElement).toBe(radios()[1]);
    key("ArrowDown");
    expect(store.get().lang).toBe("zh");
    expect(document.activeElement).toBe(radios()[0]);
    key("ArrowLeft");
    expect(store.get().lang).toBe("en");
    key("End");
    expect(store.get().lang).toBe("en");
    key("Home");
    expect(store.get().lang).toBe("zh");
    key("ArrowUp");
    expect(store.get().lang).toBe("en");
  });

  it("带修饰键的方向键不处理", () => {
    render();
    act(() => radios()[0]!.focus());
    for (const init of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }]) {
      expect(key("ArrowRight", init).defaultPrevented).toBe(false);
    }
    expect(store.get().lang).toBe("zh");
  });

  it("导航小字：当前语言自己的名字", () => {
    expect(generalSummary({ ...store.get(), lang: "zh" })).toBe("中文");
    expect(generalSummary({ ...store.get(), lang: "en" })).toBe("English");
  });

  describe("在设置窗口里：整窗文字立即换语言，并在重新挂载（相当于刷新页面）后保持", () => {
    it("切到 English：标题、导航、分区标题、说明全部跟着变；再从 detectLang 读回仍是 English", () => {
      act(() => store.set({ settings: { open: true, section: "general" } }));
      act(() => root.render(<SettingsWindow />));
      const dialog = (): HTMLElement => document.body.querySelector<HTMLElement>('[role="dialog"]')!;
      expect(dialog().getAttribute("aria-label")).toBe("设置");
      act(() => dialog().querySelectorAll<HTMLButtonElement>('[role="radio"]')[1]!.click());
      expect(dialog().getAttribute("aria-label")).toBe("Settings");
      expect(dialog().querySelector("h3")?.textContent).toBe("General");
      expect(dialog().textContent).toContain("Saved in this browser only. Applies as soon as you choose.");
      // 刷新页面后由 detectLang 读 ensemble.lang 决定初始语言：读回来仍是 English。
      expect(detectLang()).toBe("en");
    });
  });
});
