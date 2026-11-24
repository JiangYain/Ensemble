import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MountOptions } from "./engine";
import { wheel, worldCamera } from "./engine-characterize.fixtures";
import { mountPair } from "./engine.fixtures";

/**
 * 特征化测试：滚轮（平移、Shift 横移、Ctrl / ⌘ 缩放）与相机缩放接口 `zoomBy` 的数值、边界与上报。
 * 拆分引擎之前在旧实现上跑绿，拆分之后必须仍然全绿。视口固定 1200 × 800，配对布局的相机停在 (321, 345) × 1。
 */
describe("canvas wheel and zoom", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    localStorage.clear();
  });

  function mounted(options: Partial<MountOptions> = {}) {
    const rig = mountPair();
    rig.engine.mount({ viewport: rig.viewport, world: rig.world, pipes: { tube: rig.tube, dots: rig.dots }, ...options });
    return rig;
  }

  it("pans by the wheel delta immediately, claims the camera and reports it once", () => {
    const onCamera = vi.fn();
    const { engine, viewport, world } = mounted({ onCamera });
    try {
      const event = wheel(viewport, { deltaX: 10, deltaY: 40 });
      expect(event.defaultPrevented).toBe(true);
      expect(worldCamera(world)).toEqual({ x: 311, y: 305, k: 1 });
      expect(engine.getCamera()).toEqual({ x: 311, y: 305, k: 1 });
      expect(engine.isUserMoved()).toBe(true);
      wheel(viewport, { deltaY: 5 });
      expect(onCamera.mock.calls.map(([camera, moved]) => [camera.k, moved])).toEqual([[1, true]]);
    } finally {
      engine.unmount();
    }
  });

  it("scales line and page deltas by 16 and 400", () => {
    const { engine, viewport, world } = mounted();
    try {
      wheel(viewport, { deltaY: 2, deltaMode: 1 });
      expect(worldCamera(world)).toEqual({ x: 321, y: 313, k: 1 });
      wheel(viewport, { deltaX: 1, deltaMode: 2 });
      expect(worldCamera(world)).toEqual({ x: -79, y: 313, k: 1 });
    } finally {
      engine.unmount();
    }
  });

  it("turns a vertical wheel with Shift into a horizontal pan, unless the wheel already has a horizontal part", () => {
    const { engine, viewport, world } = mounted();
    try {
      wheel(viewport, { deltaY: 30, shiftKey: true });
      expect(worldCamera(world)).toEqual({ x: 291, y: 345, k: 1 });
      wheel(viewport, { deltaX: 5, deltaY: 30, shiftKey: true });
      expect(worldCamera(world)).toEqual({ x: 286, y: 315, k: 1 });
    } finally {
      engine.unmount();
    }
  });

  it("leaves the wheel to scrollable overlays", () => {
    const { engine, viewport, world } = mounted();
    try {
      const panel = document.createElement("div");
      panel.dataset["scroll"] = "";
      const row = document.createElement("span");
      panel.append(row);
      viewport.append(panel);
      const event = wheel(row, { deltaY: 40 });
      expect(event.defaultPrevented).toBe(false);
      expect(worldCamera(world)).toEqual({ x: 321, y: 345, k: 1 });
      expect(engine.isUserMoved()).toBe(false);
    } finally {
      engine.unmount();
    }
  });

  it("zooms around the pointer with Ctrl or Meta, by exp(-0.012·delta) with the delta clamped to ±60", () => {
    const { engine, viewport, world } = mounted();
    try {
      const event = wheel(viewport, { ctrlKey: true, deltaY: -30, clientX: 600, clientY: 400 });
      expect(event.defaultPrevented).toBe(true);
      const factor = Math.exp(0.36);
      expect(engine.getCamera().k).toBeCloseTo(factor, 12);
      expect(engine.getCamera().x).toBeCloseTo(600 - (600 - 321) * factor, 9);
      expect(engine.getCamera().y).toBeCloseTo(400 - (400 - 345) * factor, 9);
      // 立即到位：不等任何一帧，世界层已经是新相机。
      expect(worldCamera(world)).toEqual({ x: 200.1, y: 321.17, k: 1.4333 });
      expect(engine.isUserMoved()).toBe(true);
      // 超出 ±60 的增量按 ±60 算，缩放上限 1.6。
      wheel(viewport, { metaKey: true, deltaY: -500, clientX: 600, clientY: 400 });
      expect(engine.getCamera().k).toBe(1.6);
      wheel(viewport, { ctrlKey: true, deltaY: 500, clientX: 600, clientY: 400 });
      expect(engine.getCamera().k).toBeCloseTo(1.6 * Math.exp(-0.72), 12);
    } finally {
      engine.unmount();
    }
  });

  it("keeps the world point under the pointer fixed while zooming and stops at the lower limit", () => {
    const { engine, viewport } = mounted();
    try {
      const px = 250;
      const py = 120;
      const before = engine.getCamera();
      const world = { x: (px - before.x) / before.k, y: (py - before.y) / before.k };
      wheel(viewport, { ctrlKey: true, deltaY: 40, clientX: px, clientY: py });
      const after = engine.getCamera();
      expect((px - after.x) / after.k).toBeCloseTo(world.x, 9);
      expect((py - after.y) / after.k).toBeCloseTo(world.y, 9);
      for (let i = 0; i < 6; i++) wheel(viewport, { ctrlKey: true, deltaY: 100, clientX: px, clientY: py });
      expect(engine.getCamera().k).toBe(0.16);
    } finally {
      engine.unmount();
    }
  });

  it("scales a line-mode zoom delta before clamping it", () => {
    const { engine, viewport } = mounted();
    try {
      wheel(viewport, { ctrlKey: true, deltaY: -2, deltaMode: 1, clientX: 0, clientY: 0 });
      expect(engine.getCamera().k).toBeCloseTo(Math.exp(32 * 0.012), 12);
    } finally {
      engine.unmount();
    }
  });

  it("reports the camera only when the zoom moved by 0.004 or the user-moved flag flipped", () => {
    const onCamera = vi.fn();
    const { engine, viewport } = mounted({ onCamera });
    try {
      const nudge = (): void => {
        wheel(viewport, { ctrlKey: true, deltaY: -0.2, clientX: 0, clientY: 0 });
      };
      nudge();
      nudge();
      expect(onCamera).toHaveBeenCalledTimes(1);
      nudge();
      expect(onCamera).toHaveBeenCalledTimes(2);
      expect(onCamera.mock.calls.map(([, moved]) => moved)).toEqual([true, true]);
      expect(engine.getCamera().k).toBeCloseTo(Math.exp(0.0024 * 3), 12);
    } finally {
      engine.unmount();
    }
  });

  it("zoomBy aims the spring at the viewport center and the world layer follows frame by frame", () => {
    const { engine, world } = mounted();
    try {
      const live = engine.getCamera();
      engine.zoomBy(1.2);
      expect(live).toBe(engine.getCamera());
      expect(live.k).toBe(1.2);
      expect(live.x).toBeCloseTo(600 - (600 - 321) * 1.2, 9);
      expect(live.y).toBeCloseTo(400 - (400 - 345) * 1.2, 9);
      expect(worldCamera(world)).toEqual({ x: 321, y: 345, k: 1 });
      vi.advanceTimersByTime(16);
      const first = worldCamera(world);
      expect(first.k).toBeGreaterThan(1);
      expect(first.k).toBeLessThan(1.2);
      vi.advanceTimersByTime(3000);
      expect(worldCamera(world)).toEqual({ x: 265.2, y: 334, k: 1.2 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      engine.unmount();
    }
  });

  it("cuts a camera that is still zooming to its target on all three axes when the wheel pans it", () => {
    const { engine, viewport, world } = mounted();
    try {
      engine.zoomBy(1.2);
      vi.advanceTimersByTime(32);
      const flying = worldCamera(world);
      expect(flying.k).toBeGreaterThan(1);
      expect(flying.k).toBeLessThan(1.2);
      wheel(viewport, { deltaX: 10, deltaY: 20 });
      expect(worldCamera(world)).toEqual({ x: 255.2, y: 314, k: 1.2 });
      vi.advanceTimersByTime(3000);
      expect(worldCamera(world)).toEqual({ x: 255.2, y: 314, k: 1.2 });
    } finally {
      engine.unmount();
    }
  });

  it("zoomBy clamps to the zoom limits and does nothing once unmounted", () => {
    const { engine, world } = mounted();
    try {
      engine.zoomBy(10);
      expect(engine.getCamera().k).toBe(1.6);
      engine.zoomBy(0.001);
      expect(engine.getCamera().k).toBe(0.16);
      vi.advanceTimersByTime(3000);
      expect(worldCamera(world).k).toBe(0.16);
      engine.unmount();
      engine.zoomBy(2);
      expect(engine.getCamera().k).toBe(0.16);
    } finally {
      engine.unmount();
    }
  });
});
