import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang, store } from "../lib/app";
import type { SceneEngine } from "../scene/engine";
import { CanvasScale } from "./CanvasScale";
import { Dock } from "./Dock";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("CanvasScale（画布右下角图纸比例尺）与轻量 Dock 状态层", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let previous: ReturnType<typeof store.get>;

  beforeEach(() => {
    previous = store.get();
    store.set({ conn: "live", harnesses: [], settings: { open: false, section: undefined } });
    setLang("zh");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    store.set(previous);
  });

  const render = (node: Parameters<typeof root.render>[0]): void => {
    act(() => root.render(node));
  };

  describe("CanvasScale 图纸比例尺", () => {
    it("包含缩小、缩放百分比、放大、适应画布；有东西可重排（拖过节点或排布已偏离规划）时才显示重置布局", () => {
      const zoomBy = vi.fn();
      const fit = vi.fn();
      const resetLayout = vi.fn();
      const engine = { zoomBy, fit, resetLayout } as unknown as SceneEngine;

      render(<CanvasScale engine={engine} zoom={0.85} moved={false} canReset={false} />);
      const group = host.querySelector(".canvas-scale");
      expect(group).not.toBeNull();
      expect(group!.getAttribute("aria-label")).toBe("画布缩放");
      expect(group!.querySelector(".scale-value")?.textContent).toBe("85%");
      expect(group!.querySelectorAll("button")).toHaveLength(3);

      act(() => group!.querySelector<HTMLButtonElement>('[aria-label="缩小"]')!.click());
      act(() => group!.querySelector<HTMLButtonElement>('[aria-label="放大"]')!.click());
      act(() => group!.querySelector<HTMLButtonElement>('[aria-label="适应画布（0）"]')!.click());
      expect(zoomBy).toHaveBeenCalledTimes(2);
      expect(fit).toHaveBeenCalledTimes(1);

      render(<CanvasScale engine={engine} zoom={1} moved canReset />);
      expect(host.querySelectorAll(".canvas-scale button")).toHaveLength(4);
      expect(host.querySelector('[aria-label="适应画布（0）"]')?.hasAttribute("data-active")).toBe(true);
      act(() => host.querySelector<HTMLButtonElement>('[aria-label="重置节点布局"]')!.click());
      expect(resetLayout).toHaveBeenCalledTimes(1);
    });
  });

  describe("Dock（已移除底部大胶囊，仅作轻量化状态提示与可选对齐条）", () => {
    it("不再渲染旧胶囊 nav.dock；连接正常时完全不渲染空壳", () => {
      render(<Dock tools={false} />);
      expect(host.querySelector("nav.dock")).toBeNull();
      expect(host.innerHTML).toBe("");
    });

    it.each([
      ["connecting", "连接中"],
      ["reconnecting", "重新连接中…"],
      ["offline", "连接已断开，重试中"],
    ] as const)("连接状态为 %s 时显示克制的 .status-notices（无胶囊工具栏）", (conn, text) => {
      store.set({ conn });
      render(<Dock tools={false} />);
      const notices = host.querySelector(".status-notices");
      expect(notices).not.toBeNull();
      expect(notices!.getAttribute("data-place")).toBe("floating");
      expect(notices!.querySelector(".status-note")?.textContent).toBe(text);
      expect(notices!.querySelector(".status-note")?.getAttribute("data-conn")).toBe(conn);
      expect(host.querySelector("nav.dock")).toBeNull();
    });

    it("连接状态提示是唯一的一条，且跟随中英文切换", () => {
      store.set({ conn: "offline" });
      render(<Dock tools={false} />);
      expect([...host.querySelectorAll(".status-note")].map((el) => el.textContent)).toEqual(["连接已断开，重试中"]);
      act(() => setLang("en"));
      render(<Dock tools={false} />);
      expect([...host.querySelectorAll(".status-note")].map((el) => el.textContent)).toEqual(["Disconnected, retrying"]);
    });

    it("传入 notices=false 时不重复渲染状态提示（侧栏展开时由侧栏内联展示）", () => {
      store.set({ conn: "offline" });
      render(<Dock tools={false} notices={false} />);
      expect(host.innerHTML).toBe("");
    });
  });
});
