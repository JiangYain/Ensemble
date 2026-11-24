import { readFileSync } from "node:fs";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Modal } from "./Modal";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EXIT_MS = 160;

describe("Modal：焦点丢到 body 上之后的 Esc 兜底，与退出样式", () => {
  let host: HTMLDivElement;
  let root: Root;
  const onClose = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
    onClose.mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const BUTTONS = (
    <>
      <button id="first" type="button">甲</button>
      <button id="second" type="button">乙</button>
    </>
  );
  const render = (modals: ReactNode): void => void act(() => root.render(modals));
  const show = (open: boolean): void =>
    render(
      <Modal open={open} onClose={onClose} label="测试">
        {BUTTONS}
      </Modal>,
    );
  const wait = (ms: number): void => void act(() => void vi.advanceTimersByTime(ms));
  const active = (): Element | null => document.activeElement;
  /** 真实 Chrome 里，刚按过的按钮随即被禁用或移除，焦点就回到 body。 */
  const lose = (): void => void act(() => (active() as HTMLElement).blur());
  const key = (name: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
    act(() => void active()!.dispatchEvent(event));
    return event;
  };

  describe("焦点丢到 body 上（面板收不到按键）", () => {
    it("Esc 仍能关掉对话框，且只关一次", () => {
      show(true);
      lose();
      expect(active()).toBe(document.body);
      const event = key("Escape");
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(event.defaultPrevented).toBe(true);
      key("Escape", { isComposing: true });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("焦点在面板里时仍只关一次（面板自己处理了，兜底不重复）", () => {
      show(true);
      key("Escape");
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("别处已经处理过的 Esc（比如菜单先收起）不再兜底关对话框", () => {
      show(true);
      lose();
      const handled = (event: Event): void => event.preventDefault();
      document.body.addEventListener("keydown", handled);
      try {
        key("Escape");
        expect(onClose).not.toHaveBeenCalled();
      } finally {
        document.body.removeEventListener("keydown", handled);
      }
    });

    it("关闭之后（含退出动画期间）不再响应；重新打开又恢复", () => {
      show(true);
      show(false);
      lose();
      key("Escape");
      wait(EXIT_MS + 1);
      key("Escape");
      expect(onClose).not.toHaveBeenCalled();
      show(true);
      lose();
      key("Escape");
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("层叠的对话框：只关最上面（后打开）的那个，它收起之后才轮到下面那个", () => {
      const closeBottom = vi.fn();
      const closeTop = vi.fn();
      const stack = (top: boolean): void =>
        render(
          <>
            <Modal open onClose={closeBottom} label="下层">{BUTTONS}</Modal>
            <Modal open={top} onClose={closeTop} label="上层"><button type="button">上层按钮</button></Modal>
          </>,
        );
      stack(false);
      stack(true);
      lose();
      key("Escape");
      expect(closeTop).toHaveBeenCalledTimes(1);
      expect(closeBottom).not.toHaveBeenCalled();
      stack(false);
      lose();
      key("Escape");
      expect(closeTop).toHaveBeenCalledTimes(1);
      expect(closeBottom).toHaveBeenCalledTimes(1);
    });
  });

  it("退出样式用关键帧：入场 animation 结束后停在终值，同一次样式更新里改成 transition 不会起算（真实 Chrome 里面板一帧消失），不能退回 animation: none + transition", () => {
    const css = readFileSync("src/web/styles/overlays.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (selector: string) => css.match(new RegExp(`${selector.replace(/[[\].]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
    const panelExit = rule(".overlay[data-closing] .overlay-panel");
    const backdropExit = rule(".overlay[data-closing] .overlay-backdrop");
    expect(panelExit).toMatch(/animation:\s*dialog-out\s+0\.16s[^;]*\bboth\b/);
    expect(backdropExit).toMatch(/animation:\s*backdrop-out\s+0\.16s[^;]*\bboth\b/);
    expect(panelExit + backdropExit).not.toMatch(/animation:\s*none|transition/);
    expect(css).toMatch(/@keyframes dialog-out\s*\{\s*to\s*\{[^}]*opacity:\s*0/);
    expect(css).toMatch(/@keyframes backdrop-out\s*\{\s*to\s*\{[^}]*opacity:\s*0/);
  });
});
