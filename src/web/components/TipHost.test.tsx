import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TipHost } from "./ui";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 全局提示：显示中或等待显示时，目标的 data-tip 变了（点一下按钮、文案随状态翻转），提示要跟着换，
 * 不能留着点击之前的旧文案——点击之后恰好是用户在看提示的时候。
 */

describe("TipHost · 目标的 data-tip 在提示期间变了", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let button: HTMLButtonElement;
  let other: HTMLButtonElement;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    button = document.createElement("button");
    button.setAttribute("data-tip", "隐藏未在工作的会话");
    other = document.createElement("button");
    other.setAttribute("data-tip", "别的按钮");
    document.body.append(button, other);
    act(() => root.render(<TipHost />));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    button.remove();
    other.remove();
    vi.useRealTimers();
  });

  const tip = (): string | null => document.querySelector(".tip")?.textContent ?? null;
  const over = (el: Element): void => {
    act(() => {
      el.dispatchEvent(new Event("pointerover", { bubbles: true }));
    });
  };
  const wait = async (ms: number): Promise<void> => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };
  const retext = async (el: Element, text: string | null): Promise<void> => {
    await act(async () => {
      if (text === null) el.removeAttribute("data-tip");
      else el.setAttribute("data-tip", text);
      await vi.advanceTimersByTimeAsync(5);
    });
  };

  it("基线：悬停一会儿后显示目标当前的文案", async () => {
    over(button);
    expect(tip()).toBeNull();
    await wait(300);
    expect(tip()).toBe("隐藏未在工作的会话");
  });

  it("提示显示着，目标的文案变了：提示跟着换成新的", async () => {
    over(button);
    await wait(300);
    await retext(button, "显示全部会话（已隐藏 6 个）");
    expect(tip()).toBe("显示全部会话（已隐藏 6 个）");
  });

  it("点击的真实顺序：按下时提示收起、聚焦时又立刻打开（旧文案）、点击后状态翻转——最终显示新文案", async () => {
    over(button);
    await wait(300);
    // 真实浏览器里这是两个独立的任务（中间 React 已经渲染过），所以分两次 act，刚收起过的提示会立刻重新打开。
    act(() => {
      button.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(tip()).toBeNull();
    act(() => {
      button.dispatchEvent(new Event("focusin", { bubbles: true }));
    });
    expect(tip()).toBe("隐藏未在工作的会话");
    await retext(button, "显示全部会话（已隐藏 6 个）");
    expect(tip()).toBe("显示全部会话（已隐藏 6 个）");
  });

  it("还在等那 260ms 时文案就变了：打开时用的是新文案，不是悬停那一刻读到的", async () => {
    over(button);
    await wait(100);
    await retext(button, "显示全部会话");
    await wait(300);
    expect(tip()).toBe("显示全部会话");
  });

  it("文案被去掉了（目标不再有提示）：提示收起", async () => {
    over(button);
    await wait(300);
    await retext(button, null);
    expect(tip()).toBeNull();
  });

  it("换的是别的元素的文案：当前这条提示不受影响", async () => {
    over(button);
    await wait(300);
    await retext(other, "别的按钮（换了）");
    expect(tip()).toBe("隐藏未在工作的会话");
  });

  it("提示收起之后文案再变：不会凭空冒出一条提示", async () => {
    over(button);
    await wait(300);
    act(() => {
      button.dispatchEvent(new Event("pointerout", { bubbles: true }));
    });
    expect(tip()).toBeNull();
    await retext(button, "显示全部会话");
    await wait(400);
    expect(tip()).toBeNull();
  });
});
