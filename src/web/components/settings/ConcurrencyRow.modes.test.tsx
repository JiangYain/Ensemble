import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { LIMITS } from "@shared/constants";
import type { Capacity, ConcurrencySetting, SetConcurrencyResponse } from "@shared/protocol";
import { ApiError, api } from "../../lib/api";
import { store, type AppState } from "../../lib/app";
import { ConcurrencyRow } from "./ConcurrencyRow";
import { base, capacity, reply, stored, tick, type Held } from "./ConcurrencyRow.fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 并发上限这一行的测试之三：限制 / 不限制的切换、恢复默认，以及请求失败、竞态与别处（另一个标签页）改了设置之后的表现。
// 外观、此刻改不了、可访问性、衔接与样式在 ConcurrencyRow.test.tsx，提交、不合法的草稿与步进在 ConcurrencyRow.commit.test.tsx；共用的样本在 ConcurrencyRow.fixtures.ts。

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

  /** 第 index 条请求失败了。 */
  const refuse = (index: number, error: Error): Promise<void> =>
    act(async () => {
      held[index]!.reject(error);
      await tick();
    });

  /** 到目前为止发出的请求体（按顺序）。 */
  const sent = (): unknown[] => setConcurrency.mock.calls.map(([value]) => value);

  // 设置窗口是挂在 body 上的 portal，所以一律从 body 查，而不是只查 host。
  const radios = (): HTMLButtonElement[] => [...document.body.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  const checked = (): string[] => radios().filter((radio) => radio.getAttribute("aria-checked") === "true").map((radio) => radio.textContent ?? "");
  const input = (): HTMLInputElement | null => document.body.querySelector<HTMLInputElement>('input[role="spinbutton"]');
  const steps = (): HTMLButtonElement[] => [...document.body.querySelectorAll<HTMLButtonElement>(".concurrency-step")];
  const restore = (): HTMLButtonElement | null => document.body.querySelector<HTMLButtonElement>(".link-btn");
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

  // ───────────────────────── 限制 / 不限制 ─────────────────────────

  describe("限制 / 不限制", () => {
    it("切到“不限制”：发 \"unlimited\"，界面先显示不限制（数字框随之消失）", () => {
      show(base, capacity(20));
      click(radios()[1]);
      expect(sent()).toEqual(["unlimited"]);
      expect(checked()).toEqual(["不限制"]);
      expect(input()).toBeNull();
    });

    it("从“不限制”切回“限制”：回到这次打开以来最近看到的数字，而不是一个陌生的默认值", async () => {
      show(stored(7), capacity(7));
      click(radios()[1]);
      await answer(0, reply(0, stored("unlimited")));
      expect(checked()).toEqual(["不限制"]);

      click(radios()[0]);
      expect(sent()).toEqual(["unlimited", 7]);
      expect(checked()).toEqual(["限制"]);
      expect(input()?.value).toBe("7");
    });

    it("一直是“不限制”、从没见过数字：回到“恢复默认”会落到的上限", () => {
      show(stored("unlimited", { max: 12, source: "env" }), capacity(0));
      click(radios()[0]);
      expect(sent()).toEqual([12]);
    });

    it("默认本身也不限制、又没见过数字：用内置默认，而不是一个空框", () => {
      show(stored("unlimited", { max: 0, source: "env" }), capacity(0));
      click(radios()[0]);
      expect(sent()).toEqual([LIMITS.maxConcurrentRuns]);
    });

    it("点已选中的那一项什么也不做", () => {
      show(base, capacity(20));
      click(radios()[0]);
      expect(sent()).toEqual([]);
      act(() => store.set({ concurrency: stored("unlimited"), capacity: capacity(0) }));
      click(radios()[1]);
      expect(sent()).toEqual([]);
    });

    it("单选组的方向键：焦点移到另一项并选中（选中即提交），到头环绕", () => {
      show(base, capacity(20));
      act(() => radios()[0]!.focus());
      const event = press(radios()[0]!, "ArrowRight");
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(radios()[1]);
      expect(sent()).toEqual(["unlimited"]);
    });

    it("roving tabindex：只有选中的那一项在 Tab 顺序里", () => {
      show(base, capacity(20));
      expect(radios().map((radio) => radio.tabIndex)).toEqual([0, -1]);
      act(() => store.set({ concurrency: stored("unlimited"), capacity: capacity(0) }));
      expect(radios().map((radio) => radio.tabIndex)).toEqual([-1, 0]);
    });
  });

  // ───────────────────────── 恢复默认 ─────────────────────────

  describe("恢复默认", () => {
    it("没在这里指定过：没有这个按钮", () => {
      show(base, capacity(20));
      expect(restore()).toBeNull();
    });

    it("发 null；在途时先显示它会落到的值与来源，按钮随之消失（不会重复点）", async () => {
      show(stored(8, { max: 6, source: "env" }), capacity(8));
      expect(restore()?.textContent).toBe("恢复默认（6）");
      click(restore());
      expect(sent()).toEqual([null]);
      expect(input()?.value).toBe("6");
      expect(sourceLine()).toBe("未指定，沿用环境变量 ENSEMBLE_MAX_CONCURRENT_RUNS：6");
      expect(restore()).toBeNull();

      await answer(0, reply(6, { source: "env", inherited: { max: 6, source: "env" } }));
      expect(input()?.value).toBe("6");
      expect(restore()).toBeNull();
      expect(store.get().pendingConcurrency).toBeUndefined();
    });

    it("文件里的值无效：照常能改（用户正是在修它），说明写出现在用的是什么，并给恢复默认", () => {
      show({ source: "default", inherited: base.inherited, issue: "invalid_value" }, capacity(20));
      expect(radios().every((radio) => !radio.disabled)).toBe(true);
      expect(sourceLine()).toBe("文件里的值无效，现在用的是 20。在这里重新设置后才会覆盖它。 恢复默认（20）");
      click(restore());
      expect(sent()).toEqual([null]);
    });
  });

  // ───────────────────────── 失败、竞态与别处的变化 ─────────────────────────

  describe("失败、竞态与别处的变化", () => {
    it("服务拒绝或网络失败：提示一次，数字框回到服务端当前的值", async () => {
      show(base, capacity(20));
      type("8");
      press(input()!, "Enter");
      expect(input()?.value).toBe("8");

      await refuse(0, new ApiError("conflict", "The concurrency limit was fixed by the process that started this service.", 409));
      expect(input()?.value).toBe("20");
      expect(store.get().pendingConcurrency).toBeUndefined();
      const toasts = store.get().toasts;
      expect(toasts).toHaveLength(1);
      expect(toasts[0]).toMatchObject({ tone: "error" });
      expect(toasts[0]!.text).toContain("没能保存并发上限");
    });

    it("失败不卡住后面的修改", async () => {
      show(base, capacity(20));
      click(steps()[1]);
      await refuse(0, new Error("offline"));
      click(steps()[1]);
      expect(sent()).toEqual([21, 21]);
      await answer(1, reply(21, stored(21)));
      expect(input()?.value).toBe("21");
    });

    it("别处（另一个标签页）改成了“不限制”：数字框消失，没提交的草稿一并作废", () => {
      show(base, capacity(20));
      type("8");
      act(() => store.set({ capacity: capacity(0), concurrency: stored("unlimited") }));
      expect(input()).toBeNull();
      expect(checked()).toEqual(["不限制"]);
      act(() => store.set({ capacity: capacity(20), concurrency: base }));
      expect(input()?.value).toBe("20");
    });

    it("别处改了数字：没有草稿时数字框跟着变；有草稿时先不动用户正在输入的，Esc 之后看到新的数", () => {
      show(base, capacity(20));
      act(() => store.set({ capacity: capacity(12), concurrency: stored(12) }));
      expect(input()?.value).toBe("12");

      type("8");
      act(() => store.set({ capacity: capacity(5), concurrency: stored(5) }));
      expect(input()?.value).toBe("8");
      press(input()!, "Escape");
      expect(input()?.value).toBe("5");
    });
  });
});
