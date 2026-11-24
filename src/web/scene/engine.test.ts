import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountPair, pairLayout, pointer } from "./engine.fixtures";

/** 引擎的挂载、布局更新与视口（取景、平移手势、光标）；节点移动、历史与锚点各在 `engine.<主题>.test.ts` 里。 */
describe("canvas viewport", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => { document.body.replaceChildren(); localStorage.clear(); });

  it("updates the connection state when the run completes", () => {
    const { engine, tube } = mountPair();
    const styles = document.createElement("style");
    styles.textContent = readFileSync("src/web/styles/scene.css", "utf8");
    document.head.append(styles);
    try {
      const path = tube.querySelector("path")!;
      expect(path.dataset.phase).toBe("running");
      expect(getComputedStyle(path).getPropertyValue("stroke-dasharray")).toContain("5");
      engine.setLayout({ ...pairLayout, edges: [{ ...pairLayout.edges[0]!, phase: "done" }] });
      expect(tube.querySelector("path")).toBe(path);
      expect(path.dataset.phase).toBe("done");
      expect(getComputedStyle(path).getPropertyValue("stroke-dasharray")).not.toContain("5");
    } finally {
      styles.remove();
      engine.unmount();
    }
  });

  it("keeps the same canvas center when a manually arranged view is resized", () => {
    let resize: (() => void) | undefined;
    class Observer {
      constructor(callback: ResizeObserverCallback) {
        resize = () => callback([], this as unknown as ResizeObserver);
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("ResizeObserver", Observer);
    const { engine, viewport } = mountPair();
    try {
      engine.moveNode("agent:one", 10, 0);
      const before = { ...engine.getCamera() };
      Object.defineProperties(viewport, { clientWidth: { value: 600, configurable: true }, clientHeight: { value: 400, configurable: true } });
      resize?.();
      const after = engine.getCamera();
      expect((600 / 2 - after.x) / after.k).toBeCloseTo((1200 / 2 - before.x) / before.k);
      expect((400 / 2 - after.y) / after.k).toBeCloseTo((800 / 2 - before.y) / before.k);
    } finally {
      engine.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("pans only while Ctrl is held and restores the cursor when the key is released", () => {
    const { engine, viewport, agent } = mountPair();
    try {
      const before = { ...engine.getCamera() };
      pointer(viewport, "pointerdown", 100, 100);
      pointer(viewport, "pointermove", 160, 130);
      pointer(viewport, "pointerup", 160, 130);
      expect(engine.getCamera()).toEqual(before);
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }));
      expect(viewport.dataset.tool).toBe("pan");
      const position = agent.style.translate;
      pointer(agent, "pointerdown", 100, 100, { ctrlKey: true });
      pointer(viewport, "pointermove", 160, 130, { ctrlKey: true });
      pointer(viewport, "pointerup", 160, 130, { ctrlKey: true });
      expect(agent.style.translate).toBe(position);
      expect(engine.getCamera().x).toBeCloseTo(before.x + 60);
      expect(engine.getCamera().y).toBeCloseTo(before.y + 30);
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }));
      expect(viewport.dataset.tool).toBeUndefined();
    } finally {
      engine.unmount();
    }
  });

  it("pans with Space without intercepting spaces in form fields", () => {
    const { engine, viewport, agent } = mountPair();
    try {
      const before = { ...engine.getCamera() };
      const down = new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true });
      window.dispatchEvent(down);
      expect(down.defaultPrevented).toBe(true);
      expect(viewport.dataset.tool).toBe("pan");
      const position = agent.style.translate;
      pointer(agent, "pointerdown", 100, 100);
      pointer(viewport, "pointermove", 140, 120);
      pointer(viewport, "pointerup", 140, 120);
      expect(agent.style.translate).toBe(position);
      expect(engine.getCamera().x).toBeCloseTo(before.x + 40);
      window.dispatchEvent(new KeyboardEvent("keyup", { key: " ", code: "Space" }));
      expect(viewport.dataset.tool).toBeUndefined();
      const input = document.createElement("input");
      document.body.append(input);
      const typed = new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true });
      input.dispatchEvent(typed);
      expect(typed.defaultPrevented).toBe(false);
      expect(viewport.dataset.tool).toBeUndefined();
    } finally {
      engine.unmount();
    }
  });

  it("uses the ordinary cursor on nodes until a modifier is held", () => {
    const { engine, viewport, agent } = mountPair();
    const styles = document.createElement("style");
    styles.textContent = readFileSync("src/web/styles/scene.css", "utf8");
    document.head.append(styles);
    viewport.className = "scene";
    agent.className = "node";
    const link = document.createElement("a");
    agent.append(link);
    try {
      expect(getComputedStyle(viewport).cursor).toBe("default");
      expect(getComputedStyle(agent).cursor).toBe("default");
      // 节点里的链接仍是手形：它们自己管点击。
      expect(getComputedStyle(link).cursor).toBe("pointer");
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }));
      expect(viewport.dataset.tool).toBe("pan");
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true }));
      expect(viewport.dataset.tool).toBe("select");
    } finally {
      styles.remove();
      engine.unmount();
    }
  });
});
