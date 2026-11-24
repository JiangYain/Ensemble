import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { Capacity, ConcurrencySetting, SetConcurrencyResponse } from "@shared/protocol";
import { api } from "../../lib/api";
import { store, type AppState } from "../../lib/app";
import { ConcurrencyRow } from "./ConcurrencyRow";
import { base, capacity, reply, stored, tick, type Held } from "./ConcurrencyRow.fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 并发上限这一行的测试之二：提交——Enter、失焦、步进钮与方向键都即时生效；不合法的草稿与 Esc；步进钮与方向键的细节。
// 外观、此刻改不了、可访问性、衔接与样式在 ConcurrencyRow.test.tsx，限制 / 不限制、恢复默认、失败与竞态在 ConcurrencyRow.modes.test.tsx；共用的样本在 ConcurrencyRow.fixtures.ts。

describe("设置 · 通用：并发上限（ConcurrencyRow）", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let setConcurrency: MockInstance<typeof api.setConcurrency>;
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
    setConcurrency = vi.spyOn(api, "setConcurrency").mockImplementation(
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

  /** 第 index 条请求回来了。 */
  const answer = (index: number, response: SetConcurrencyResponse): Promise<void> =>
    act(async () => {
      held[index]!.resolve(response);
      await tick();
    });

  /** 到目前为止发出的请求体（按顺序）。 */
  const sent = (): unknown[] => setConcurrency.mock.calls.map(([value]) => value);

  // 设置窗口是挂在 body 上的 portal，所以一律从 body 查，而不是只查 host。
  const input = (): HTMLInputElement | null => document.body.querySelector<HTMLInputElement>('input[role="spinbutton"]');
  const steps = (): HTMLButtonElement[] => [...document.body.querySelectorAll<HTMLButtonElement>(".concurrency-step")];
  const problem = (): string | undefined => document.body.querySelector('[role="alert"]')?.textContent ?? undefined;
  /** 数字框下面的小字，一段一行（占用与等待、占用超限、来源），不含草稿不合法的那句。 */
  const lines = (): string[] => [...document.body.querySelectorAll("div.concurrency-meta > p")].map((line) => line.textContent ?? "");
  const sourceLine = (): string | undefined => lines().pop();

  const click = (element: Element | null | undefined): void => void act(() => (element as HTMLElement).click());

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

  /** 数字框失焦（React 的 onBlur 听的是 focusout）。 */
  const leave = (): void => void act(() => void input()!.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));

  // ───────────────────────── 提交 ─────────────────────────

  describe("提交：Enter、失焦、步进钮与方向键都即时生效", () => {
    it("Enter 提交：发一次请求；在途时界面先显示要的值，回执回来后以服务端为准", async () => {
      show(base, capacity(20));
      type("8");
      expect(input()?.value).toBe("8");
      expect(sent()).toEqual([]);

      const event = press(input()!, "Enter");
      expect(event.defaultPrevented).toBe(true);
      expect(sent()).toEqual([8]);
      // 在途：数字、来源与“恢复默认”都已按用户要的值显示。
      expect(input()?.value).toBe("8");
      expect(input()?.getAttribute("aria-valuenow")).toBe("8");
      expect(sourceLine()).toBe("已在这里指定 恢复默认（20）");

      await answer(0, reply(8, stored(8)));
      expect(input()?.value).toBe("8");
      expect(store.get().pendingConcurrency).toBeUndefined();
      expect(store.get().capacity).toEqual(capacity(8));
    });

    it("失焦也提交", () => {
      show(base, capacity(20));
      type("12");
      leave();
      expect(sent()).toEqual([12]);
      expect(input()?.value).toBe("12");
    });

    it("两侧的空白忽略", () => {
      show(base, capacity(20));
      type(" 8 ");
      press(input()!, "Enter");
      expect(sent()).toEqual([8]);
    });

    it("与生效的数字相同：不发请求，草稿收回，框里仍是生效的数字", () => {
      show(base, capacity(20));
      type("2");
      type("20");
      press(input()!, "Enter");
      expect(sent()).toEqual([]);
      expect(input()?.value).toBe("20");
    });

    it("没有动过草稿就按 Enter 或失焦：什么也不发", () => {
      show(base, capacity(20));
      press(input()!, "Enter");
      leave();
      expect(sent()).toEqual([]);
    });

    it("输入法组字期间的 Enter / Esc / 方向键不当作操作，草稿原样留着", () => {
      show(base, capacity(20));
      type("8");
      for (const name of ["Enter", "Escape", "ArrowUp", "ArrowDown"]) {
        expect(press(input()!, name, { isComposing: true }).defaultPrevented).toBe(false);
      }
      expect(sent()).toEqual([]);
      expect(input()?.value).toBe("8");
    });
  });

  // ───────────────────────── 不合法的草稿与 Esc ─────────────────────────

  describe("不合法的草稿：只在下面写一句话，不发请求，不改任何已生效的值", () => {
    it.each(["", "   ", "0", "-1", "2.5", "1001", "abc"])("草稿 %j", (text) => {
      show(base, capacity(20));
      type(text);
      expect(problem()).toBe("请输入 1–1000 的整数；现在仍是 20。");
      expect(input()?.getAttribute("aria-invalid")).toBe("true");
      expect(input()?.getAttribute("aria-describedby")).toBe(document.body.querySelector('[role="alert"]')?.id);

      press(input()!, "Enter");
      leave();
      expect(sent()).toEqual([]);
      // 草稿留着让用户改；已生效的值与在途状态都没动。
      expect(input()?.value).toBe(text);
      expect(problem()).toBeDefined();
      expect(store.get().pendingConcurrency).toBeUndefined();
      expect(store.get().capacity).toEqual(capacity(20));
    });

    it("改成合法的数：提示消失，aria-invalid 与 aria-describedby 一起撤掉，Enter 提交", () => {
      show(base, capacity(20));
      type("abc");
      type("9");
      expect(problem()).toBeUndefined();
      expect(input()?.hasAttribute("aria-invalid")).toBe(false);
      expect(input()?.hasAttribute("aria-describedby")).toBe(false);
      press(input()!, "Enter");
      expect(sent()).toEqual([9]);
    });

    it("英文界面的提示也写明范围与现值", () => {
      show(base, capacity(20));
      act(() => store.set({ lang: "en" }));
      type("0");
      expect(problem()).toBe("Enter a whole number from 1 to 1000. It is still 20.");
    });

    it("Esc 还原草稿：框回到生效的数字，提示消失；这一下 Esc 不再往外走（不会顺手关掉窗口）", () => {
      show(base, capacity(20));
      type("99x");
      const outer = vi.fn();
      document.addEventListener("keydown", outer);
      const event = press(input()!, "Escape");
      document.removeEventListener("keydown", outer);
      expect(event.defaultPrevented).toBe(true);
      expect(outer).not.toHaveBeenCalled();
      expect(input()?.value).toBe("20");
      expect(problem()).toBeUndefined();
      expect(sent()).toEqual([]);
    });

    it("合法但还没提交的草稿，Esc 一样还原、不发请求", () => {
      show(base, capacity(20));
      type("8");
      press(input()!, "Escape");
      expect(input()?.value).toBe("20");
      expect(sent()).toEqual([]);
    });

    it("没有草稿时 Esc 原样往外走（交给外层关窗口），不拦下", () => {
      show(base, capacity(20));
      const outer = vi.fn();
      document.addEventListener("keydown", outer);
      const event = press(input()!, "Escape");
      document.removeEventListener("keydown", outer);
      expect(event.defaultPrevented).toBe(false);
      expect(outer).toHaveBeenCalledTimes(1);
    });
  });

  // ───────────────────────── 步进钮与方向键 ─────────────────────────

  describe("步进钮与方向键", () => {
    it("每按一次提交一次；请求在途时再按，从界面显示的值继续，只发最新的", async () => {
      show(base, capacity(20));
      click(steps()[1]);
      expect(sent()).toEqual([21]);
      expect(input()?.value).toBe("21");

      click(steps()[1]);
      click(steps()[1]);
      // 第一条还没回来：后面的只记最新的，界面先显示它。
      expect(sent()).toEqual([21]);
      expect(input()?.value).toBe("23");

      await answer(0, reply(21, stored(21)));
      expect(sent()).toEqual([21, 23]);
      // 前一条的回执已经应用，但最新的改动还没确认：界面不回退到 21。
      expect(input()?.value).toBe("23");

      await answer(1, reply(23, stored(23)));
      expect(input()?.value).toBe("23");
      expect(store.get().pendingConcurrency).toBeUndefined();
    });

    it("减号与加号各自加减一", async () => {
      show(base, capacity(20));
      click(steps()[0]);
      expect(sent()).toEqual([19]);
      await answer(0, reply(19, stored(19)));
      click(steps()[1]);
      expect(sent()).toEqual([19, 20]);
    });

    it("到 1 或 1000 就停：对应的步进钮禁用", () => {
      show(stored(1), capacity(1));
      expect(steps().map((step) => step.disabled)).toEqual([true, false]);
      act(() => store.set({ concurrency: stored(1000), capacity: capacity(1000) }));
      expect(steps().map((step) => step.disabled)).toEqual([false, true]);
    });

    it("↑ ↓ 在数字框里加减一并拦下默认行为（不移动光标）；带修饰键的不处理", async () => {
      show(base, capacity(20));
      const up = press(input()!, "ArrowUp");
      expect(up.defaultPrevented).toBe(true);
      expect(sent()).toEqual([21]);
      await answer(0, reply(21, stored(21)));

      const down = press(input()!, "ArrowDown");
      expect(down.defaultPrevented).toBe(true);
      expect(sent()).toEqual([21, 20]);

      const shifted = press(input()!, "ArrowUp", { shiftKey: true });
      expect(shifted.defaultPrevented).toBe(false);
      expect(sent()).toEqual([21, 20]);
    });

    it("已经在下限还按 ↓：不发请求，但仍拦下默认行为", () => {
      show(stored(1), capacity(1));
      const down = press(input()!, "ArrowDown");
      expect(down.defaultPrevented).toBe(true);
      expect(sent()).toEqual([]);
    });

    it("草稿合法时从草稿出发加减", () => {
      show(base, capacity(20));
      type("8");
      press(input()!, "ArrowUp");
      expect(sent()).toEqual([9]);
      expect(input()?.value).toBe("9");
    });

    it("草稿不合法时从生效的数字出发，并收回这份草稿", () => {
      show(base, capacity(20));
      type("abc");
      press(input()!, "ArrowUp");
      expect(sent()).toEqual([21]);
      expect(problem()).toBeUndefined();
      expect(input()?.value).toBe("21");
    });
  });
});
