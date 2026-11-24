import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askConfirm, setLang, store } from "../lib/app";
import { MenuButton, type MenuItem } from "./Menu";
import { Modal, type ModalProps } from "./Modal";
import { ConfirmDialog } from "./Overlays";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EXIT_MS = 160;

describe("Modal：初始聚焦、焦点圈定与归还、背景 inert、退出动画", () => {
  let host: HTMLDivElement;
  let root: Root;
  const matchMedia = window.matchMedia;
  const onClose = vi.fn();

  beforeEach(() => {
    // 帧与定时器都由测试推进：想靠“下一帧再聚焦”的实现，在这里一帧也等不到。
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
    Reflect.deleteProperty(HTMLElement.prototype, "offsetParent");
    window.matchMedia = matchMedia;
  });

  const BUTTONS = (
    <>
      <button id="first" type="button">甲</button>
      <button id="second" type="button">乙</button>
      <button id="third" type="button">丙</button>
    </>
  );

  /** 带一块背景（和应用里的 .stage 一样标了 data-modal-inert）与它里面的触发按钮，对话框门户到 body。 */
  const scene = (modals: ReactNode): ReactNode => (
    <>
      <div id="stage" data-modal-inert>
        <button id="trigger" type="button">打开</button>
      </div>
      {modals}
    </>
  );
  const show = (open: boolean, props: Partial<ModalProps> = {}, body: ReactNode = BUTTONS): void => {
    act(() =>
      root.render(
        scene(
          <Modal open={open} onClose={onClose} label="测试" {...props}>
            {body}
          </Modal>,
        ),
      ),
    );
  };
  const wait = (ms: number): void => void act(() => void vi.advanceTimersByTime(ms));

  const byId = (id: string): HTMLElement => document.getElementById(id)!;
  const trigger = (): HTMLElement => byId("trigger");
  const stage = (): HTMLElement => byId("stage");
  const overlay = (): HTMLElement | null => document.querySelector<HTMLElement>(".overlay");
  const panel = (): HTMLElement | null => document.querySelector<HTMLElement>(".overlay-panel");
  const active = (): Element | null => document.activeElement;

  const key = (name: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
    act(() => void active()!.dispatchEvent(event));
    return event;
  };
  const focusTrigger = (): void => void act(() => trigger().focus());
  /** Tab 圈定只算“可见”的元素（offsetParent 非 null）；happy-dom 没有布局，这里显式让所有元素可见。 */
  const layOut = (): void => void Object.defineProperty(HTMLElement.prototype, "offsetParent", { configurable: true, get: () => document.body });

  describe("初始聚焦", () => {
    it("open 变真的那一次提交里，面板已挂上、焦点已在里面——不推进任何一帧", () => {
      show(false);
      focusTrigger();
      show(true);
      expect(panel()).not.toBeNull();
      expect(active()).toBe(byId("first"));
    });

    it("首次挂载时就是打开的：同样不等帧", () => {
      show(true);
      expect(active()).toBe(byId("first"));
    });

    it("优先级一：initialFocus 选择器命中的元素", () => {
      show(false);
      show(true, { initialFocus: "#second" });
      expect(active()).toBe(byId("second"));
    });

    it("优先级二：选择器没命中（或没给）就聚焦第一个可聚焦元素，跳过禁用项", () => {
      show(false);
      show(true, { initialFocus: "#nowhere" }, (
        <>
          <button id="off" type="button" disabled>停</button>
          <a id="link" href="#x">链</a>
          <button id="after" type="button">后</button>
        </>
      ));
      expect(active()).toBe(byId("link"));
    });

    it("优先级三：里面没有任何可聚焦元素时聚焦面板自身（tabIndex=-1，Esc 仍可用）", () => {
      show(false);
      show(true, {}, <p>只有文字</p>);
      expect(active()).toBe(panel());
      key("Escape");
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("面板的语义：portal 到 body、role=dialog、aria-modal、aria-label", () => {
      show(true, { label: "示例对话框", width: 660 });
      const dialog = panel()!;
      expect(dialog.parentElement?.parentElement).toBe(document.body);
      expect(host.contains(dialog)).toBe(false);
      expect(dialog.getAttribute("role")).toBe("dialog");
      expect(dialog.getAttribute("aria-modal")).toBe("true");
      expect(dialog.getAttribute("aria-label")).toBe("示例对话框");
      expect(dialog.style.width).toBe("660px");
    });
  });

  describe("键盘与遮罩", () => {
    it("Esc 关闭并不再向外冒泡；输入法组字期间不关", () => {
      const outer = vi.fn();
      document.addEventListener("keydown", outer);
      try {
        show(true);
        key("Escape", { isComposing: true });
        expect(onClose).not.toHaveBeenCalled();
        const event = key("Escape");
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(event.defaultPrevented).toBe(true);
        expect(outer).toHaveBeenCalledTimes(1); // 只有组字期间那一次落到了外面，真正关闭的那次被拦下了
      } finally {
        document.removeEventListener("keydown", outer);
      }
    });

    it("点遮罩关闭；点面板里面不关", () => {
      show(true);
      act(() => byId("second").click());
      expect(onClose).not.toHaveBeenCalled();
      act(() => document.querySelector<HTMLElement>(".overlay-backdrop")!.click());
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("Tab / Shift+Tab 在面板内首尾循环；在中间不拦截", () => {
      layOut();
      show(true);
      expect(active()).toBe(byId("first"));

      expect(key("Tab").defaultPrevented).toBe(false);
      act(() => byId("third").focus());
      expect(key("Tab").defaultPrevented).toBe(true);
      expect(active()).toBe(byId("first"));

      expect(key("Tab", { shiftKey: true }).defaultPrevented).toBe(true);
      expect(active()).toBe(byId("third"));
      act(() => byId("second").focus());
      expect(key("Tab", { shiftKey: true }).defaultPrevented).toBe(false);
    });

    it("tabIndex = -1 的按钮不算首尾：roving tabindex 里没选中的几项不会让圈定漏掉（唯一按得到 Tab 的元素两个方向都被圈回自己）", () => {
      layOut();
      show(true, {}, (
        <>
          <button id="off-first" type="button" tabIndex={-1}>甲</button>
          <button id="only" type="button">乙</button>
          <button id="off-last" type="button" tabIndex={-1}>丙</button>
        </>
      ));
      act(() => byId("only").focus());
      expect(key("Tab").defaultPrevented).toBe(true);
      expect(active()).toBe(byId("only"));
      expect(key("Tab", { shiftKey: true }).defaultPrevented).toBe(true);
      expect(active()).toBe(byId("only"));
    });

    it("面板里没有可聚焦元素时 Tab 不会把焦点带出去", () => {
      layOut();
      show(true, {}, <p>只有文字</p>);
      expect(key("Tab").defaultPrevented).toBe(true);
      expect(active()).toBe(panel());
    });
  });

  describe("关闭：inert 与焦点归还", () => {
    it("打开期间背景 inert；关闭时先解除 inert，再把焦点还给触发处", () => {
      show(false);
      focusTrigger();
      show(true);
      expect(stage().inert).toBe(true);

      const inertWhenFocused: boolean[] = [];
      trigger().addEventListener("focus", () => inertWhenFocused.push(stage().inert));
      show(false);
      expect(inertWhenFocused).toEqual([false]);
      expect(active()).toBe(trigger());
      expect(stage().inert).toBe(false);
    });

    it("触发处在对话框打开期间被移除时，关闭不报错，也不去聚焦已脱离文档的元素", () => {
      show(false);
      focusTrigger();
      show(true);
      const gone = trigger();
      const focusGone = vi.spyOn(gone, "focus");
      act(() => gone.remove());
      expect(() => show(false)).not.toThrow();
      expect(focusGone).not.toHaveBeenCalled();
      wait(EXIT_MS + 1);
      expect(panel()).toBeNull();
    });

    const pair = (a: boolean, b: boolean): void =>
      void act(() =>
        root.render(
          scene(
            <>
              <Modal open={a} onClose={onClose} label="甲">{<button id="in-a" type="button">A</button>}</Modal>
              <Modal open={b} onClose={onClose} label="乙">{<button id="in-b" type="button">B</button>}</Modal>
            </>,
          ),
        ),
      );

    it("多个对话框同时打开：最后一个关闭之后才解除背景 inert", () => {
      pair(true, false);
      pair(true, true);
      expect(stage().inert).toBe(true);
      pair(true, false);
      expect(stage().inert).toBe(true);
      pair(false, false);
      expect(stage().inert).toBe(false);
    });

    it("同一次提交里一个关、一个开（对话框关掉的同时打开另一个，例如设置窗口开着时打开快速切换器）：焦点进入后开的，背景保持 inert，计数不丢也不重复", () => {
      pair(false, false);
      focusTrigger();
      pair(true, false);
      expect(active()).toBe(byId("in-a"));

      pair(false, true);
      expect(active()).toBe(byId("in-b"));
      expect(stage().inert).toBe(true);

      pair(false, false);
      expect(active()).toBe(trigger());
      expect(stage().inert).toBe(false);
      pair(true, false);
      expect(stage().inert).toBe(true);
      pair(false, false);
      expect(stage().inert).toBe(false);
    });
  });

  describe("退出动画", () => {
    it("关闭后面板保留到退出动画播完（data-closing），之后才卸载", () => {
      show(true);
      expect(overlay()!.hasAttribute("data-closing")).toBe(false);
      show(false);
      expect(overlay()!.hasAttribute("data-closing")).toBe(true);
      wait(EXIT_MS - 1);
      expect(panel()).not.toBeNull();
      wait(2);
      expect(panel()).toBeNull();
    });

    it("用户偏好减少动态效果：关闭后立即卸载，不等退出动画", () => {
      window.matchMedia = ((query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList) as typeof window.matchMedia;
      show(true);
      show(false);
      wait(0);
      expect(panel()).toBeNull();
    });

    it("退出动画期间重新打开：沿用同一块面板，不再 closing，焦点重新进入面板；之后正常关闭仍还给触发处", () => {
      show(false);
      focusTrigger();
      show(true);
      const before = panel();
      show(false);
      wait(EXIT_MS / 2);
      show(true);
      expect(panel()).toBe(before);
      expect(overlay()!.hasAttribute("data-closing")).toBe(false);
      expect(panel()!.contains(active())).toBe(true);
      wait(EXIT_MS * 5);
      expect(panel()).toBe(before);

      show(false);
      expect(active()).toBe(trigger());
      wait(EXIT_MS + 1);
      expect(panel()).toBeNull();
    });

    it("卸载整个组件（打开状态下）：解除背景 inert", () => {
      show(true);
      expect(stage().inert).toBe(true);
      act(() => root.render(scene(null)));
      expect(stage().inert).toBe(false);
    });
  });

  it("反复快速开关 20 次：每次焦点都进面板，关闭后回到触发处，inert 不残留", () => {
    show(false);
    for (let i = 0; i < 20; i += 1) {
      focusTrigger();
      show(true);
      expect(panel()!.contains(active())).toBe(true);
      expect(stage().inert).toBe(true);
      show(false);
      expect(active()).toBe(trigger());
      expect(stage().inert).toBe(false);
      // 有的轮次让退出动画播完，有的轮次在动画中途就重开。
      wait(i % 3 === 0 ? EXIT_MS + 1 : 20);
    }
    wait(EXIT_MS + 1);
    expect(panel()).toBeNull();
  });
});

describe("从菜单打开确认框", () => {
  let host: HTMLDivElement;
  let root: Root;
  const onConfirm = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
    setLang("zh");
    onConfirm.mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const items: MenuItem[] = [
      {
        id: "remove",
        label: "删除记录",
        icon: "trash",
        danger: true,
        onSelect: () => askConfirm({ title: "删除这条记录？", confirmLabel: "删除", tone: "danger", onConfirm }),
      },
    ];
    act(() =>
      root.render(
        <>
          <div id="stage" data-modal-inert>
            <MenuButton items={items} label="会话操作" />
          </div>
          <ConfirmDialog />
        </>,
      ),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.replaceChildren();
    store.set({ confirm: undefined });
    vi.useRealTimers();
  });

  const menuButton = (): HTMLButtonElement => host.querySelector<HTMLButtonElement>("button[aria-haspopup]")!;
  const press = (name: string): void => {
    act(() => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })));
  };

  it("选中菜单项：确认框立即接住焦点（取消键）；Esc 关闭后焦点回到菜单按钮，不执行动作", () => {
    act(() => menuButton().click());
    expect(document.activeElement).toBe(document.querySelector('[role="menuitem"]'));
    act(() => document.querySelector<HTMLElement>('[role="menuitem"]')!.click());

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-label")).toBe("删除这条记录？");
    expect(document.activeElement).toBe(dialog.querySelector("[data-autofocus]"));
    expect(document.getElementById("stage")!.inert).toBe(true);

    press("Escape");
    expect(document.activeElement).toBe(menuButton());
    expect(document.getElementById("stage")!.inert).toBe(false);
    act(() => void vi.advanceTimersByTime(200));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
