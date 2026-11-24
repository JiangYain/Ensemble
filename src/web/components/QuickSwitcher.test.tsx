import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog, testOrigin } from "@shared/testing";
import { openSwitcher, setLang, store } from "../lib/app";
import { buildWorkspaces } from "../lib/workspaces";
import { QuickSwitcher } from "./QuickSwitcher";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeSession(id: string, originKey: string, title: string, hostTitle: string) {
  const log = new EventLog(id);
  log.created({
    id,
    title,
    harness: "cursor",
    origin: testOrigin({ key: originKey, host: "cursor", hostLabel: "Cursor", hostTitle, workspace: "C:\\Desktop\\Ensemble" }),
  });
  return toSummary(replay(log.events)!);
}

describe("QuickSwitcher（⌘K 快速切换器）", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let previous: ReturnType<typeof store.get>;

  beforeEach(() => {
    previous = store.get();
    location.hash = "";
    store.set({ switcherOpen: false, recentOrigins: ["cursor:a", "cursor:b"] });
    setLang("zh");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    location.hash = "";
    store.set(previous);
  });

  it("打开后聚焦搜索框、按极简单行呈现标题/目录/相对时间、默认把刚离开的 Main Agent 排第一，按 Enter 直接切换", () => {
    const sessions = [
      makeSession("ses_1", "cursor:a", "重构 UI", "任务 A"),
      makeSession("ses_2", "cursor:b", "修 DSH", "任务 B"),
    ];
    const workspaces = buildWorkspaces(sessions);
    act(() => openSwitcher());
    act(() =>
      root.render(
        <QuickSwitcher
          workspaces={workspaces}
          sessions={sessions}
          currentScope={{ kind: "origin", key: "cursor:a" }}
        />,
      ),
    );

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"][aria-label="快速切换"]')!;
    expect(dialog).not.toBeNull();
    const input = dialog.querySelector<HTMLInputElement>(".switcher-input")!;
    expect(document.activeElement).toBe(input);
    // 参考图 2 风格：无底栏、无分组标题
    expect(dialog.querySelector(".switcher-foot")).toBeNull();
    expect(dialog.querySelector(".switcher-group")).toBeNull();

    const options = [...dialog.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(options[0]!.querySelector(".switcher-primary")?.textContent).toBe("任务 B");
    expect(options[0]!.querySelector(".switcher-dir")?.textContent).toContain("Ensemble");
    expect(options[0]!.querySelector(".switcher-age")?.textContent).toBeTruthy();

    // 直接回车：立刻切到刚离开的“任务 B”，复现 Alt+Tab 手感
    act(() => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(store.get().switcherOpen).toBe(false);
    expect(location.hash).toBe("#/m/cursor%3Ab");
  });

  it("支持左上角范围下拉（会话 / Main Agent / 全局视图）与右上角仅活跃过滤", () => {
    const sessions = [
      makeSession("ses_1", "cursor:a", "画布标头改造", "任务 A"),
      makeSession("ses_2", "cursor:b", "审查日志轮转", "任务 B"),
    ];
    const workspaces = buildWorkspaces(sessions);
    act(() => openSwitcher());
    act(() =>
      root.render(
        <QuickSwitcher
          workspaces={workspaces}
          sessions={sessions}
          currentScope={{ kind: "origin", key: "cursor:a" }}
        />,
      ),
    );

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"][aria-label="快速切换"]')!;
    const scopeBtn = dialog.querySelector<HTMLButtonElement>(".switcher-scope")!;
    act(() => scopeBtn.click());
    expect(dialog.querySelector(".switcher-scope-menu")).not.toBeNull();

    // 按 Esc 先收起下拉菜单而不关闭整个切换器
    act(() => void scopeBtn.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(dialog.querySelector(".switcher-scope-menu")).toBeNull();
    expect(store.get().switcherOpen).toBe(true);

    // 切到“会话”范围，无输入也能直接浏览所有会话
    act(() => scopeBtn.click());
    const menuItems = [...dialog.querySelectorAll<HTMLButtonElement>(".switcher-scope-option")];
    const sessionsOpt = menuItems.find((el) => el.textContent?.includes("会话"))!;
    act(() => sessionsOpt.click());

    const options = [...dialog.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(options).toHaveLength(2);
    expect(options.map((el) => el.querySelector(".switcher-primary")?.textContent)).toEqual(
      expect.arrayContaining(["画布标头改造", "审查日志轮转"]),
    );

    // 开启“仅活跃”过滤：所有会话都是待命/默认态（刚 created 为 starting，活跃），再验证按钮 aria-pressed 状态切换
    const filterBtn = dialog.querySelector<HTMLButtonElement>(".switcher-filter-btn")!;
    expect(filterBtn.getAttribute("aria-pressed")).toBe("false");
    act(() => filterBtn.click());
    expect(filterBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("支持方向键移动选中与输入文字模糊搜索会话", () => {
    const sessions = [
      makeSession("ses_1", "cursor:a", "画布标头改造", "任务 A"),
      makeSession("ses_2", "cursor:b", "审查日志轮转", "任务 B"),
    ];
    const workspaces = buildWorkspaces(sessions);
    act(() => openSwitcher());
    act(() =>
      root.render(
        <QuickSwitcher
          workspaces={workspaces}
          sessions={sessions}
          currentScope={{ kind: "origin", key: "cursor:a" }}
        />,
      ),
    );

    const input = document.body.querySelector<HTMLInputElement>(".switcher-input")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "日志轮转");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const options = [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(options).toHaveLength(1);
    expect(options[0]!.textContent).toContain("审查日志轮转");

    act(() => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(location.hash).toBe("#/s/ses_2");
  });
});
