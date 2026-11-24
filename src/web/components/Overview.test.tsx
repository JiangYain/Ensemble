import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog, testOrigin } from "@shared/testing";
import { store } from "../lib/app";
import { SceneEngine } from "../scene/engine";
import { Overview } from "./Overview";

it("renders a nested delegation under its parent without a separate origin card", () => {
  const childLog = new EventLog("ses_child");
  childLog.created({ id: "ses_child", parentSessionId: "ses_parent", origin: testOrigin({ key: "pi:native-parent", host: "pi", hostLabel: "Pi" }) });
  const parentLog = new EventLog("ses_parent");
  parentLog.created({ id: "ses_parent", origin: testOrigin({ key: "codex:origin" }) });
  const child = toSummary(replay(childLog.events)!);
  const parent = toSummary(replay(parentLog.events)!);
  const previous = store.get().sessions;
  store.set({ sessions: { [parent.id]: parent, [child.id]: child } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  try {
    act(() => root.render(<Overview />));

    expect(container.querySelector(".canvas-meta")?.textContent).toBe("Ensemble");
    expect([...container.querySelectorAll(".node.origin")].map((node) => node.getAttribute("data-host"))).toEqual(["codex"]);
    expect(container.querySelectorAll(".node").length).toBe(3);
  } finally {
    act(() => root.unmount());
    container.remove();
    store.set({ sessions: previous });
    vi.unstubAllGlobals();
  }
});

it("binds Ctrl/⌘+A, Ctrl/⌘+Z, Ctrl/⌘+Shift+Z and Ctrl+Y on the canvas, and leaves text fields and other combinations alone", () => {
  const engine = new SceneEngine();
  const selectAll = vi.spyOn(engine, "selectAll");
  const undo = vi.spyOn(engine, "undo");
  const redo = vi.spyOn(engine, "redo");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const press = (init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  };
  try {
    act(() => root.render(<Overview engine={engine} />));

    expect(press({ key: "a", ctrlKey: true }).defaultPrevented).toBe(true);
    expect(selectAll).toHaveBeenCalledTimes(1);
    expect(press({ key: "A", metaKey: true }).defaultPrevented).toBe(true);
    expect(selectAll).toHaveBeenCalledTimes(2);

    expect(press({ key: "z", ctrlKey: true }).defaultPrevented).toBe(true);
    expect(press({ key: "z", metaKey: true }).defaultPrevented).toBe(true);
    expect(undo).toHaveBeenCalledTimes(2);
    expect(redo).not.toHaveBeenCalled();

    expect(press({ key: "Z", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(press({ key: "Z", metaKey: true, shiftKey: true }).defaultPrevented).toBe(true);
    expect(press({ key: "y", ctrlKey: true }).defaultPrevented).toBe(true);
    expect(redo).toHaveBeenCalledTimes(3);
    expect(undo).toHaveBeenCalledTimes(2);

    // macOS 上 ⌘Y 是别的意思（例如浏览器的“历史记录”），不当作重做；其他组合键、Alt 组合同样不拦。
    for (const init of [{ key: "y", metaKey: true }, { key: "c", ctrlKey: true }, { key: "a", ctrlKey: true, altKey: true }]) {
      expect(press(init).defaultPrevented).toBe(false);
    }
    expect(selectAll).toHaveBeenCalledTimes(2);
    expect(redo).toHaveBeenCalledTimes(3);

    // 在输入框里 Ctrl+A / Ctrl+Z 是文本编辑，不能被画布抢走。
    const input = document.createElement("input");
    container.append(input);
    expect(press({ key: "a", ctrlKey: true }, input).defaultPrevented).toBe(false);
    expect(press({ key: "z", ctrlKey: true }, input).defaultPrevented).toBe(false);
    expect(selectAll).toHaveBeenCalledTimes(2);
    expect(undo).toHaveBeenCalledTimes(2);

    // 弹层打开时画布不响应快捷键。
    const open = store.get().switcherOpen;
    store.set({ switcherOpen: true });
    try {
      expect(press({ key: "a", ctrlKey: true }).defaultPrevented).toBe(false);
      expect(selectAll).toHaveBeenCalledTimes(2);
    } finally {
      store.set({ switcherOpen: open });
    }
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("设置窗口开着时，画布的单键快捷键（0、f、+、=、-、_、Esc）与 Ctrl/⌘ 组合键都不响应；关上后恢复", () => {
  const engine = new SceneEngine();
  const calls = {
    fit: vi.spyOn(engine, "fit"),
    zoomBy: vi.spyOn(engine, "zoomBy"),
    clearSelection: vi.spyOn(engine, "clearSelection"),
    selectAll: vi.spyOn(engine, "selectAll"),
    undo: vi.spyOn(engine, "undo"),
  };
  const total = (): number => Object.values(calls).reduce((sum, spy) => sum + spy.mock.calls.length, 0);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const previous = store.get();
  const press = (init: KeyboardEventInit): void => {
    act(() => void document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })));
  };
  const KEYS: KeyboardEventInit[] = [{ key: "0" }, { key: "f" }, { key: "+" }, { key: "=" }, { key: "-" }, { key: "_" }, { key: "Escape" }, { key: "a", ctrlKey: true }, { key: "z", metaKey: true }];
  try {
    act(() => root.render(<Overview engine={engine} />));

    store.set({ settings: { open: true, section: undefined } });
    for (const init of KEYS) press(init);
    expect(total()).toBe(0);

    store.set({ settings: { open: false, section: undefined } });
    for (const init of KEYS) press(init);
    expect(total()).toBe(KEYS.length);
  } finally {
    act(() => root.unmount());
    container.remove();
    store.set({ settings: previous.settings });
    vi.unstubAllGlobals();
  }
});
