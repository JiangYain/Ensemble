import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { key } from "./engine-characterize.fixtures";
import { at, mountPair, POSITIONS_KEY, pointer, stored } from "./engine.fixtures";

/**
 * 特征化测试：键盘修饰键、空格与失焦决定的“当前工具”（`data-tool`），以及方向键微调（`moveNode`）进历史的合并规则。
 * 拆分引擎之前在旧实现上跑绿，拆分之后必须仍然全绿。
 */
describe("canvas keyboard state", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    localStorage.clear();
  });

  it("picks the tool from Shift, Ctrl and Space with Shift winning, and follows the keys back up", () => {
    const { engine, viewport } = mountPair();
    try {
      expect(viewport.dataset["tool"]).toBeUndefined();
      key("keydown", { key: "Control", ctrlKey: true });
      expect(viewport.dataset["tool"]).toBe("pan");
      key("keydown", { key: "Shift", shiftKey: true, ctrlKey: true });
      expect(viewport.dataset["tool"]).toBe("select");
      key("keyup", { key: "Shift", ctrlKey: true });
      expect(viewport.dataset["tool"]).toBe("pan");
      key("keyup", { key: "Control" });
      expect(viewport.dataset["tool"]).toBeUndefined();
      // 不是修饰键本身的按键：按 `ctrlKey` / `shiftKey` 字段算。
      key("keydown", { key: "a", ctrlKey: true });
      expect(viewport.dataset["tool"]).toBe("pan");
      key("keyup", { key: "a" });
      expect(viewport.dataset["tool"]).toBeUndefined();
      key("keydown", { key: "ArrowLeft", shiftKey: true });
      expect(viewport.dataset["tool"]).toBe("select");
      key("keyup", { key: "ArrowLeft" });
      expect(viewport.dataset["tool"]).toBeUndefined();
    } finally {
      engine.unmount();
    }
  });

  it("holds the pan tool while Space is down, and only for a bare Space outside form-like targets", () => {
    const { engine, viewport } = mountPair();
    try {
      const space = key("keydown", { key: " ", code: "Space" });
      expect(space.defaultPrevented).toBe(true);
      expect(viewport.dataset["tool"]).toBe("pan");
      key("keyup", { key: " ", code: "Space" });
      expect(viewport.dataset["tool"]).toBeUndefined();
      // 只有 `key` 是空格也算（没有 code）。
      expect(key("keydown", { key: " " }).defaultPrevented).toBe(true);
      key("keyup", { key: " " });
      // 带着别的修饰键、或事件已经被别人处理过：不接。
      for (const init of [{ altKey: true }, { metaKey: true }, { ctrlKey: false, shiftKey: true }]) {
        const event = key("keydown", { key: " ", code: "Space", ...init });
        expect(event.defaultPrevented).toBe(false);
        key("keyup", { key: " ", code: "Space" });
      }
      document.body.addEventListener("keydown", (event) => event.preventDefault(), { once: true });
      const handled = key("keydown", { key: " ", code: "Space" }, document.body);
      expect(handled.defaultPrevented).toBe(true);
      expect(viewport.dataset["tool"]).toBeUndefined();
      // 表单、按钮、链接、可编辑区域、对话框与菜单里的空格归它们自己。
      const targets: HTMLElement[] = [];
      for (const tag of ["input", "textarea", "select", "button", "a"]) targets.push(document.createElement(tag));
      const editable = document.createElement("div");
      editable.setAttribute("contenteditable", "true");
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      const menu = document.createElement("div");
      menu.setAttribute("role", "menu");
      const inner = document.createElement("span");
      menu.append(inner);
      targets.push(editable, dialog, menu);
      document.body.append(...targets);
      for (const target of [...targets.filter((item) => item !== menu), inner]) {
        const event = key("keydown", { key: " ", code: "Space" }, target);
        expect(event.defaultPrevented).toBe(false);
        expect(viewport.dataset["tool"]).toBeUndefined();
      }
      // `contenteditable="false"` 不算可编辑。
      const fixed = document.createElement("div");
      fixed.setAttribute("contenteditable", "false");
      document.body.append(fixed);
      expect(key("keydown", { key: " ", code: "Space" }, fixed).defaultPrevented).toBe(true);
      expect(viewport.dataset["tool"]).toBe("pan");
    } finally {
      engine.unmount();
    }
  });

  it("forgets every held key when the window loses focus", () => {
    const { engine, viewport } = mountPair();
    try {
      key("keydown", { key: " ", code: "Space" });
      key("keydown", { key: "Shift", shiftKey: true });
      expect(viewport.dataset["tool"]).toBe("select");
      window.dispatchEvent(new Event("blur"));
      expect(viewport.dataset["tool"]).toBeUndefined();
      // 空格也一并松开了：之后一次不带修饰键的指针按下不再是平移。
      pointer(viewport, "pointerdown", 100, 100);
      pointer(viewport, "pointermove", 160, 130);
      pointer(viewport, "pointerup", 160, 130);
      expect(engine.getCamera()).toEqual({ x: 321, y: 345, k: 1 });
    } finally {
      engine.unmount();
    }
  });

  it("syncs the tool from the modifiers of pointer events while no drag is going on", () => {
    const { engine, viewport } = mountPair();
    try {
      pointer(viewport, "pointermove", 10, 10, { ctrlKey: true });
      expect(viewport.dataset["tool"]).toBe("pan");
      pointer(viewport, "pointermove", 10, 10, { ctrlKey: true, shiftKey: true });
      expect(viewport.dataset["tool"]).toBe("select");
      pointer(viewport, "pointermove", 10, 10);
      expect(viewport.dataset["tool"]).toBeUndefined();
    } finally {
      engine.unmount();
    }
  });

  it("merges a quick series of nudges into one history step, measured from the latest nudge", () => {
    const { engine, agent } = mountPair();
    try {
      engine.moveNode("agent:one", 10, 0);
      vi.advanceTimersByTime(999);
      engine.moveNode("agent:one", 10, 0);
      vi.advanceTimersByTime(999);
      engine.moveNode("agent:one", 10, 0);
      expect(at(agent).x).toBe(340);
      engine.undo();
      vi.advanceTimersByTime(3000);
      expect(at(agent).x).toBe(310);
      expect(engine.getState().canUndo).toBe(false);
    } finally {
      engine.unmount();
    }
  });

  it("starts a new history step once a full second has passed since the previous nudge", () => {
    const { engine, agent } = mountPair();
    try {
      engine.moveNode("agent:one", 10, 0);
      vi.advanceTimersByTime(1000);
      engine.moveNode("agent:one", 10, 0);
      engine.undo();
      vi.advanceTimersByTime(3000);
      expect(at(agent).x).toBe(320);
      expect(engine.getState()).toMatchObject({ canUndo: true, canRedo: true });
    } finally {
      engine.unmount();
    }
  });

  it("does not merge into an older nudge once something has been undone", () => {
    const { engine, agent } = mountPair();
    try {
      vi.setSystemTime(10_000);
      engine.moveNode("agent:one", 10, 0);
      vi.setSystemTime(11_500);
      engine.moveNode("agent:one", 10, 0);
      engine.undo();
      // 时间倒回到第一次微调之后不到一秒：窗口和键都对得上，但重做栈不空，必须另起一条。
      vi.setSystemTime(10_200);
      engine.moveNode("agent:one", 5, 0);
      expect(engine.getState()).toMatchObject({ canUndo: true, canRedo: false });
      engine.undo();
      vi.advanceTimersByTime(3000);
      expect(at(agent).x).toBe(320);
      engine.undo();
      vi.advanceTimersByTime(3000);
      expect(at(agent).x).toBe(310);
    } finally {
      engine.unmount();
    }
  });

  it("keeps nudges of different selections as separate steps", () => {
    const { engine } = mountPair();
    try {
      engine.moveNode("agent:one", 10, 0);
      engine.moveNode("origin:one", 10, 0);
      expect(engine.getSelectedIds()).toEqual(["origin:one"]);
      engine.undo();
      expect(engine.getState().canUndo).toBe(true);
      engine.undo();
      expect(engine.getState().canUndo).toBe(false);
    } finally {
      engine.unmount();
    }
  });

  it("pins a node with a zero nudge once, and records nothing for a nudge that changes nothing", () => {
    const { engine } = mountPair();
    try {
      engine.moveNode("agent:one", 0, 0);
      expect(engine.getState().canUndo).toBe(true);
      expect(stored()).toEqual({ "agent:one": { x: 310, y: 14 } });
      engine.moveNode("agent:one", 0, 0);
      engine.undo();
      expect(engine.getState().canUndo).toBe(false);
      expect(localStorage.getItem(POSITIONS_KEY)).toBeNull();
    } finally {
      engine.unmount();
    }
  });
});
