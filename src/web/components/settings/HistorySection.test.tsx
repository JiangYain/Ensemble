import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { RetentionResponse, RetentionSettings } from "@shared/protocol";
import { ApiError, api } from "../../lib/api";
import { setLang, store } from "../../lib/app";
import { summary } from "../../lib/archive.fixtures";
import { bindT } from "../../lib/i18n";
import { dateMinute } from "../../lib/text";
import { HistorySection, historySummary } from "./HistorySection";
import { SettingsWindow } from "./SettingsWindow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Field = keyof RetentionSettings;

const none: RetentionSettings = { keepDays: null, keepCount: null };
const reply = (retention: RetentionSettings, lastSweep?: { at: string; archived: number }): RetentionResponse => ({ retention, ...(lastSweep ? { lastSweep } : {}) });
const SWEEP_AT = "2026-11-21T08:00:00.000Z";

/** 让已经就绪的 Promise 链都跑完。 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** 一次挂起的保存请求：由测试决定什么时候回来、回什么。 */
interface Held {
  body: RetentionSettings;
  resolve(response: RetentionResponse): void;
  reject(error: Error): void;
}

describe("设置 · 历史（HistorySection）", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let readSpy: MockInstance<typeof api.retention>;
  let writeSpy: MockInstance<typeof api.setRetention>;
  let held: Held[];
  const previous = store.get();

  beforeEach(() => {
    setLang("zh");
    location.hash = "";
    store.set({
      sessions: { a: summary("a"), b: summary("b") },
      archivedCount: 3,
      retention: undefined,
      toasts: [],
      settings: { open: true, section: "history" },
    });
    held = [];
    // 所有请求都不碰真实的 fetch：读取默认回“没有任何留存”，保存全部挂起，回执由 answer / refuse 决定。
    readSpy = vi.spyOn(api, "retention").mockImplementation(async () => reply(none));
    writeSpy = vi.spyOn(api, "setRetention").mockImplementation(
      (body) =>
        new Promise<RetentionResponse>((resolve, reject) => {
          held.push({ body, resolve, reject });
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
    location.hash = "";
    vi.restoreAllMocks();
    store.set({
      sessions: previous.sessions,
      archivedCount: previous.archivedCount,
      retention: previous.retention,
      toasts: [],
      settings: previous.settings,
      lang: previous.lang,
    });
  });

  // ───────────────────────── 夹具与操作 ─────────────────────────

  const mount = async (): Promise<void> => {
    await act(async () => {
      root.render(<HistorySection />);
    });
    await act(async () => {
      await tick();
    });
  };
  const answer = (index: number, response: RetentionResponse): Promise<void> =>
    act(async () => {
      held[index]!.resolve(response);
      await tick();
    });
  const refuse = (index: number, error: Error): Promise<void> =>
    act(async () => {
      held[index]!.reject(error);
      await tick();
    });

  const row = (field: Field): HTMLElement => host.querySelector<HTMLElement>(`.retention-row[data-field="${field}"]`)!;
  const toggle = (field: Field): HTMLInputElement => row(field).querySelector<HTMLInputElement>("input.retention-input")!;
  const box = (field: Field): HTMLInputElement => row(field).querySelector<HTMLInputElement>("input.retention-field")!;
  const unit = (field: Field): string | undefined => row(field).querySelector(".retention-unit")?.textContent ?? undefined;
  const problem = (field: Field): string | undefined => row(field).querySelector(".retention-problem")?.textContent ?? undefined;
  const isOn = (field: Field): boolean => row(field).hasAttribute("data-on");
  const sweepLine = (): string | undefined => host.querySelector(".history-sweep")?.textContent ?? undefined;
  const errorLine = (): string | undefined => host.querySelector(".history-error")?.textContent ?? undefined;

  const click = (element: Element | null | undefined): void => void act(() => (element as HTMLElement).click());
  const type = (input: HTMLInputElement, text: string): void =>
    void act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  /** 数字框失焦（React 的 onBlur 听的是 focusout）。 */
  const leave = (input: HTMLInputElement): void => void act(() => void input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  const press = (target: Element, name: string): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
    act(() => void target.dispatchEvent(event));
    return event;
  };
  const sent = (): RetentionSettings[] => writeSpy.mock.calls.map(([body]) => body);

  // ───────────────────────── 导航小字与老服务 ─────────────────────────

  it("导航小字：服务报告的已归档个数；老服务不报就没有这行", () => {
    const t = bindT("zh");
    expect(historySummary({ ...store.get(), archivedCount: 3 }, t)).toBe("3 个已归档");
    expect(historySummary({ ...store.get(), archivedCount: 0 }, t)).toBe("0 个已归档");
    expect(historySummary({ ...store.get(), archivedCount: undefined }, t)).toBeUndefined();
    expect(historySummary({ ...store.get(), archivedCount: 3 }, bindT("en"))).toBe("3 archived");
  });

  it("老服务（不报已归档个数）：只写一句说明，不画控件，也不去读留存策略", async () => {
    store.set({ archivedCount: undefined });
    await mount();
    expect(host.textContent).toContain("当前运行的服务还不支持归档");
    expect(host.querySelector(".retention-row")).toBeNull();
    expect(host.querySelector("button")).toBeNull();
    expect(readSpy).not.toHaveBeenCalled();
  });

  // ───────────────────────── 会话数与“查看已归档” ─────────────────────────

  it("会话一行：未归档与已归档的个数，写明归档不删除；“查看已归档”关掉设置窗口并进入已归档视图", async () => {
    await mount();
    const note = host.querySelector(".setting-note")?.textContent;
    expect(note).toBe("2 个未归档，3 个已归档。已归档的会话不再出现在画布、侧栏与列表里；记录原样保留，随时可以取消归档。");
    const view = [...host.querySelectorAll("button")].find((button) => button.textContent === "查看已归档");
    expect(view).toBeDefined();
    click(view);
    expect(store.get().settings.open).toBe(false);
    expect(location.hash).toBe("#/archived");
  });

  // ───────────────────────── 读取 ─────────────────────────

  it("打开分区时读一次留存策略；服务给了上次清扫就写出来，没有就没有这一行", async () => {
    readSpy.mockImplementation(async () => reply({ keepDays: 30, keepCount: null }, { at: SWEEP_AT, archived: 4 }));
    await mount();
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(sweepLine()).toBe(`上次清扫：${dateMinute(SWEEP_AT, "zh", true)}，归档了 4 个会话`);

    act(() => root.unmount());
    root = createRoot(host);
    readSpy.mockImplementation(async () => reply(none));
    await mount();
    expect(sweepLine()).toBeUndefined();
  });

  it("各项与服务端一致：开着的有数字，关着的是空的、数字框不可用；都关着就是“不自动归档”（默认）", async () => {
    readSpy.mockImplementation(async () => reply({ keepDays: 30, keepCount: null }));
    await mount();
    expect(isOn("keepDays")).toBe(true);
    expect(toggle("keepDays").checked).toBe(true);
    expect(box("keepDays").value).toBe("30");
    expect(box("keepDays").disabled).toBe(false);
    expect(unit("keepDays")).toBe("天");

    expect(isOn("keepCount")).toBe(false);
    expect(toggle("keepCount").checked).toBe(false);
    expect(box("keepCount").value).toBe("");
    expect(box("keepCount").disabled).toBe(true);
    expect(unit("keepCount")).toBe("棵任务树");
  });

  it("读不到：写“读取不到留存策略”，原因是服务给的真实错误，没有控件", async () => {
    readSpy.mockImplementation(async () => {
      throw new ApiError("internal", "boom", 500);
    });
    await mount();
    expect(host.querySelector(".retention-row")).toBeNull();
    expect(host.querySelector(".history-loading")?.textContent).toBe("读取不到留存策略");
    expect(errorLine()).toBeTruthy();
  });

  it("读到之前写“正在读取”，不画控件", async () => {
    let release!: (response: RetentionResponse) => void;
    readSpy.mockImplementation(() => new Promise<RetentionResponse>((resolve) => (release = resolve)));
    await mount();
    expect(host.querySelector(".history-loading")?.textContent).toBe("正在读取留存策略…");
    expect(host.querySelector(".retention-row")).toBeNull();
    await act(async () => {
      release(reply(none));
      await tick();
    });
    expect(host.querySelectorAll(".retention-row")).toHaveLength(2);
  });

  // ───────────────────────── 打开开关与提交 ─────────────────────────

  it("打开开关不提交任何东西，也没有预填的数字；光标进数字框；框是空的就失焦＝没打开，开关自己弹回去", async () => {
    await mount();
    click(toggle("keepCount"));
    expect(isOn("keepCount")).toBe(true);
    expect(box("keepCount").disabled).toBe(false);
    expect(box("keepCount").value).toBe("");
    expect(document.activeElement).toBe(box("keepCount"));
    expect(problem("keepCount")).toBeUndefined();
    expect(writeSpy).not.toHaveBeenCalled();

    leave(box("keepCount"));
    expect(isOn("keepCount")).toBe(false);
    expect(toggle("keepCount").checked).toBe(false);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("输入过程中不发请求；失焦才提交，整份替换（另一项用此刻的值）；在途时数字框只读、列表标忙", async () => {
    readSpy.mockImplementation(async () => reply({ keepDays: 30, keepCount: null }));
    await mount();
    click(toggle("keepCount"));
    type(box("keepCount"), "5");
    type(box("keepCount"), "50");
    expect(writeSpy).not.toHaveBeenCalled();

    leave(box("keepCount"));
    expect(sent()).toEqual([{ keepDays: 30, keepCount: 50 }]);
    expect(host.querySelector('.setting-list[aria-busy="true"]')).not.toBeNull();
    expect(box("keepCount").readOnly).toBe(true);
    expect(box("keepDays").readOnly).toBe(true);

    await answer(0, reply({ keepDays: 30, keepCount: 50 }, { at: SWEEP_AT, archived: 2 }));
    expect(host.querySelector('.setting-list[aria-busy="true"]')).toBeNull();
    expect(box("keepCount").readOnly).toBe(false);
    expect(box("keepCount").value).toBe("50");
    expect(isOn("keepCount")).toBe(true);
    expect(store.get().retention).toEqual({ keepDays: 30, keepCount: 50 });
    expect(sweepLine()).toBe(`上次清扫：${dateMinute(SWEEP_AT, "zh", true)}，归档了 2 个会话`);
    expect(errorLine()).toBeUndefined();
  });

  it("Enter 也提交；数字没变就不发请求", async () => {
    readSpy.mockImplementation(async () => reply({ keepDays: 30, keepCount: null }));
    await mount();
    type(box("keepDays"), "30");
    press(box("keepDays"), "Enter");
    expect(writeSpy).not.toHaveBeenCalled();

    type(box("keepDays"), "7");
    const event = press(box("keepDays"), "Enter");
    expect(event.defaultPrevented).toBe(true);
    expect(sent()).toEqual([{ keepDays: 7, keepCount: null }]);
  });

  it("关掉开关立刻提交“不限”（null）", async () => {
    readSpy.mockImplementation(async () => reply({ keepDays: 30, keepCount: 8 }));
    await mount();
    click(toggle("keepDays"));
    expect(sent()).toEqual([{ keepDays: null, keepCount: 8 }]);
  });

  it("Esc 还原草稿：不提交；刚打开的开关弹回去，已生效的数字回到服务端的值", async () => {
    readSpy.mockImplementation(async () => reply({ keepDays: 30, keepCount: null }));
    await mount();
    click(toggle("keepCount"));
    type(box("keepCount"), "9");
    const armed = press(box("keepCount"), "Escape");
    expect(armed.defaultPrevented).toBe(true);
    expect(isOn("keepCount")).toBe(false);

    type(box("keepDays"), "9");
    const edited = press(box("keepDays"), "Escape");
    expect(edited.defaultPrevented).toBe(true);
    expect(box("keepDays").value).toBe("30");
    expect(writeSpy).not.toHaveBeenCalled();

    // 没有草稿时 Esc 不被这里截走（交给外层，设置窗口才能照常关闭）。
    const idle = press(box("keepDays"), "Escape");
    expect(idle.defaultPrevented).toBe(false);
  });

  it("在设置窗口里：框里有草稿时 Esc 只还原草稿，窗口不关；没有草稿时再按一次才关窗口", async () => {
    readSpy.mockImplementation(async () => reply({ keepDays: 30, keepCount: null }));
    await act(async () => {
      store.set({ settings: { open: true, section: "history" } });
      root.render(<SettingsWindow />);
    });
    await act(async () => {
      await tick();
    });
    // 设置窗口是挂在 body 上的 portal，所以从 body 查。
    const field = document.body.querySelector<HTMLInputElement>('.retention-row[data-field="keepDays"] input.retention-field')!;
    expect(field.value).toBe("30");
    act(() => field.focus());

    type(field, "99");
    const first = press(field, "Escape");
    expect(first.defaultPrevented).toBe(true);
    expect(store.get().settings.open).toBe(true);
    expect(field.value).toBe("30");

    press(field, "Escape");
    expect(store.get().settings.open).toBe(false);
  });

  // ───────────────────────── 不合法的值 ─────────────────────────

  it("不合法（空了已生效的数、0、小数、夹杂文字、超出上限）：只在下面写一句话，不提交，也不替用户改写他输入的字", async () => {
    readSpy.mockImplementation(async () => reply({ keepDays: 30, keepCount: null }));
    await mount();

    // 判范围走 shared 的 retentionFault（服务端用的同一个）；“1e2”“30天”这类夹杂文字的写法在它之前就被拦下，不被悄悄读成 100 或 30。
    for (const text of ["", "0", "1.5", "abc", "-3", "3651", "1e2", "30天", "99999999999999999999"]) {
      type(box("keepDays"), text);
      expect(problem("keepDays")).toBe("请输入 1 到 3650 之间的整数；这一项还没有保存。");
      expect(box("keepDays").getAttribute("aria-invalid")).toBe("true");
      expect(box("keepDays").value).toBe(text);
      leave(box("keepDays"));
      expect(writeSpy).not.toHaveBeenCalled();
    }

    // 合法之后提示消失。
    type(box("keepDays"), "3650");
    expect(problem("keepDays")).toBeUndefined();
    expect(box("keepDays").getAttribute("aria-invalid")).toBeNull();

    click(toggle("keepCount"));
    type(box("keepCount"), "10001");
    expect(problem("keepCount")).toBe("请输入 1 到 10000 之间的整数；这一项还没有保存。");
    leave(box("keepCount"));
    expect(writeSpy).not.toHaveBeenCalled();
  });

  // ───────────────────────── 保存失败与在途 ─────────────────────────

  it("保存失败：原因是服务给的真实错误，写在分区底部；回到服务端当前的样子", async () => {
    await mount();
    click(toggle("keepDays"));
    type(box("keepDays"), "7");
    leave(box("keepDays"));
    expect(sent()).toEqual([{ keepDays: 7, keepCount: null }]);

    await refuse(0, new ApiError("invalid_request", "keepDays must be at least 1", 400));
    expect(errorLine()).toContain("keepDays must be at least 1");
    expect(host.querySelector(".history-error")?.getAttribute("role")).toBe("alert");
    expect(isOn("keepDays")).toBe(false);
    expect(box("keepDays").value).toBe("");
    expect(store.get().retention).toEqual(none);
  });

  it("有一次保存在途时不接受新的提交：另一项的开关点了也不发第二个请求", async () => {
    await mount();
    click(toggle("keepDays"));
    type(box("keepDays"), "7");
    leave(box("keepDays"));
    expect(writeSpy).toHaveBeenCalledTimes(1);

    click(toggle("keepCount"));
    expect(isOn("keepCount")).toBe(false);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    await answer(0, reply({ keepDays: 7, keepCount: null }));
  });

  // ───────────────────────── 文案 ─────────────────────────

  it("文案写明只归档不删除、保存会立刻清扫一次、有会话在工作的任务树不会被归档", async () => {
    await mount();
    const intro = host.querySelector(".history-intro")?.textContent ?? "";
    expect(intro).toContain("不会删除任何记录");
    expect(intro).toContain("保存后立刻清扫一次");
    expect(intro).toContain("还有会话在工作时，整棵树都不会被归档");
    expect(intro).toContain("都不开启就不会自动归档（默认）");
  });

  it("英文界面：单位跟着数字选单复数，说明与错误是英文", async () => {
    setLang("en");
    readSpy.mockImplementation(async () => reply({ keepDays: 1, keepCount: 2 }));
    await mount();
    expect(unit("keepDays")).toBe("day");
    expect(unit("keepCount")).toBe("task trees");

    type(box("keepDays"), "30");
    expect(unit("keepDays")).toBe("days");
    type(box("keepCount"), "1");
    expect(unit("keepCount")).toBe("task tree");

    type(box("keepDays"), "0");
    expect(problem("keepDays")).toBe("Enter a whole number from 1 to 3650. This hasn't been saved.");
    expect(host.querySelector(".history-intro")?.textContent).toContain("never deletes any record");
  });
});
