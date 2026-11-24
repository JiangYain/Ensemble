import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wheel, worldCamera } from "./engine-characterize.fixtures";
import { cameraRun } from "./engine-characterize.springs";
import { mountPair } from "./engine.fixtures";

/**
 * 特征化测试（补洞）：相机在飞行中途被“截断”——滚轮平移、立即落定、换空间——以及弹簧落定那一帧要把速度一并清掉；
 * 还有默认会走弹簧的 `fit()`、和视口某一边缩成 0 的尺寸变化。
 * 这些在拆分之前的实现里就没有测试守着，是拆分之后补跑 60 个单行变异时才暴露的（见 HARDEN-E 报告）。
 * 数值是未改动的引擎跑出来的结果；逐帧读数另由独立的参考弹簧（`engine-characterize.springs.ts`）复算。
 */
describe("canvas camera cuts and clean restarts", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
  });
  afterEach(() => {
    // 先还原全局替身再还原定时器：反过来会把假的 requestAnimationFrame 留在全局上。
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.replaceChildren();
    localStorage.clear();
  });

  /** 手动推进的帧：`requestAnimationFrame` 只排队，由测试按指定的间隔触发；`performance.now()` 跟着同一个时钟。 */
  function frames() {
    let nextId = 1;
    let clock = 0;
    const queue: { id: number; callback: FrameRequestCallback }[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback): number => {
      const id = nextId++;
      queue.push({ id, callback });
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number): void => {
      const index = queue.findIndex((item) => item.id === id);
      if (index >= 0) queue.splice(index, 1);
    });
    return {
      pending: () => queue.length,
      tick: (ms = 16): void => {
        vi.advanceTimersByTime(ms);
        clock += ms;
        queue.shift()?.callback(clock);
      },
    };
  }

  /** 引擎里的相机（目标）按世界层 `transform` 的写法取整，好与 `worldCamera` 读出来的比。 */
  const written = (camera: { x: number; y: number; k: number }): { x: number; y: number; k: number } => ({
    x: Number(camera.x.toFixed(2)),
    y: Number(camera.y.toFixed(2)),
    k: Number(camera.k.toFixed(4)),
  });

  describe("a flight cut short", () => {
    it("stops the spring dead when the wheel scrolls the camera in mid-flight", () => {
      const clock = frames();
      const { engine, viewport, world } = mountPair();
      try {
        clock.tick();
        engine.zoomBy(1.2);
        clock.tick();
        clock.tick();
        const mid = worldCamera(world);
        expect(mid.k).toBeGreaterThan(1);
        expect(mid.k).toBeLessThan(1.2);
        wheel(viewport, { deltaX: 10, deltaY: 20 });
        expect(worldCamera(world)).toEqual({ x: 255.2, y: 314, k: 1.2 });
        // 滚轮把相机一步放到目标上，弹簧原来的速度不能留着，否则下一帧又把相机从目标上拉走。
        clock.tick();
        clock.tick();
        expect(worldCamera(world)).toEqual({ x: 255.2, y: 314, k: 1.2 });
        expect(clock.pending()).toBe(0);
      } finally {
        engine.unmount();
      }
    });

    it.each([
      { name: "fit(false)", cut: ({ engine }: ReturnType<typeof mountPair>) => engine.fit(false) },
      { name: "a Ctrl-wheel zoom", cut: ({ viewport }: ReturnType<typeof mountPair>) => void wheel(viewport, { ctrlKey: true, deltaY: -10, clientX: 600, clientY: 400 }) },
    ])("stops the spring dead when $name puts the camera on its target in mid-flight", ({ cut }) => {
      const clock = frames();
      const rig = mountPair();
      const { engine, world } = rig;
      try {
        clock.tick();
        engine.zoomBy(1.2);
        clock.tick();
        clock.tick();
        const mid = worldCamera(world);
        expect(mid.k).toBeGreaterThan(1);
        expect(mid.k).toBeLessThan(1.2);
        cut(rig);
        const cutTo = written(engine.getCamera());
        expect(cutTo).not.toEqual({ x: 265.2, y: 334, k: 1.2 });
        expect(worldCamera(world)).toEqual(cutTo);
        clock.tick();
        clock.tick();
        expect(worldCamera(world)).toEqual(cutTo);
        expect(clock.pending()).toBe(0);
      } finally {
        engine.unmount();
      }
    });

    it("stops the spring dead when the canvas switches to a space it has no camera for, in mid-flight", () => {
      const clock = frames();
      const { engine, world } = mountPair();
      try {
        clock.tick();
        engine.zoomBy(1.2);
        clock.tick();
        clock.tick();
        expect(worldCamera(world).k).toBeGreaterThan(1);
        engine.switchSpace("elsewhere");
        expect(worldCamera(world)).toEqual({ x: 0, y: 0, k: 1 });
        clock.tick();
        clock.tick();
        expect(worldCamera(world)).toEqual({ x: 0, y: 0, k: 1 });
        expect(clock.pending()).toBe(0);
      } finally {
        engine.unmount();
      }
    });

    it("stops the spring dead when the canvas comes back to a space whose camera was moved by the user, in mid-flight", () => {
      const clock = frames();
      const { engine, world } = mountPair();
      try {
        clock.tick();
        engine.zoomBy(1.2);
        for (let i = 0; i < 400 && clock.pending() > 0; i++) clock.tick();
        expect(worldCamera(world)).toEqual({ x: 265.2, y: 334, k: 1.2 });
        engine.switchSpace("elsewhere");
        engine.zoomBy(1.3);
        clock.tick();
        clock.tick();
        const mid = worldCamera(world);
        expect(mid.k).toBeGreaterThan(1);
        expect(mid.k).toBeLessThan(1.3);
        // 回到默认空间：取回它记下的、用户摆过的相机；“elsewhere”里飞到一半的速度不能带过来。
        engine.switchSpace("all");
        expect(worldCamera(world)).toEqual({ x: 265.2, y: 334, k: 1.2 });
        clock.tick();
        clock.tick();
        expect(worldCamera(world)).toEqual({ x: 265.2, y: 334, k: 1.2 });
        expect(clock.pending()).toBe(0);
      } finally {
        engine.unmount();
      }
    });
  });

  it("starts the next flight from rest: the zoom speed left in the frame the spring settled is cleared with it", () => {
    const clock = frames();
    const { engine, viewport, world } = mountPair();
    try {
      clock.tick();
      // 相机落在视口中心：缩放的不动点，x、y 一点都不动，只有缩放在飞。
      wheel(viewport, { deltaX: 321 - 600, deltaY: 345 - 400 });
      expect(worldCamera(world)).toEqual({ x: 600, y: 400, k: 1 });
      engine.zoomBy(1.01771);
      // 50ms 一帧，第 12 帧落定；这一帧里缩放速度还有约 0.00095，离阈值 0.001 只差一点点。
      const first = cameraRun({ x: 600, y: 400, k: 1 }, { x: 600, y: 400, k: 1.01771 }, Array.from({ length: 100 }, () => 50));
      expect(first.settledAt).toBe(12);
      let count = 0;
      while (clock.pending() > 0 && count < 100) {
        clock.tick(50);
        count++;
      }
      expect(count).toBe(12);
      expect(world.style.transform).toBe("translate3d(600.00px,400.00px,0) scale(1.0177)");
      // 第二次飞行必须从静止出发：逐帧读数与独立复算的弹簧一一相同（带着残余速度出发的话，有几行读数会差一个末位）。
      engine.zoomBy(1.2 / 1.01771);
      const expected = cameraRun({ x: 600, y: 400, k: 1.01771 }, { ...engine.getCamera() }, Array.from({ length: 400 }, () => 8));
      expect(expected.settledAt).toBe(104);
      const rows: string[] = [];
      while (clock.pending() > 0 && rows.length < 400) {
        clock.tick(8);
        rows.push(world.style.transform);
      }
      expect(rows).toEqual(expected.rows);
      expect(rows.at(-1)).toBe("translate3d(600.00px,400.00px,0) scale(1.2000)");
    } finally {
      engine.unmount();
    }
  });

  it("flies fit() through the spring when it is given no arguments, and cuts only when asked not to animate", () => {
    const clock = frames();
    const { engine, viewport, world } = mountPair();
    try {
      clock.tick();
      wheel(viewport, { deltaX: 100, deltaY: 50 });
      expect(worldCamera(world)).toEqual({ x: 221, y: 295, k: 1 });
      engine.fit();
      expect(engine.getCamera()).toEqual({ x: 321, y: 345, k: 1 });
      // 目标已经回到取景的位置，画面还没动：要等弹簧一帧一帧送过去。
      expect(worldCamera(world)).toEqual({ x: 221, y: 295, k: 1 });
      expect(clock.pending()).toBe(1);
      clock.tick();
      const early = worldCamera(world);
      expect(early.x).toBeGreaterThan(221);
      expect(early.x).toBeLessThan(321);
      for (let i = 0; i < 400 && clock.pending() > 0; i++) clock.tick();
      expect(worldCamera(world)).toEqual({ x: 321, y: 345, k: 1 });
      // 对照：明说不要动画，就一步到位。
      wheel(viewport, { deltaX: 100, deltaY: 50 });
      engine.fit(false);
      expect(worldCamera(world)).toEqual({ x: 321, y: 345, k: 1 });
    } finally {
      engine.unmount();
    }
  });

  describe("a resize that leaves one dimension at zero", () => {
    let resize: (() => void) | undefined;

    function mountObserved() {
      class Observer {
        constructor(callback: ResizeObserverCallback) {
          resize = () => callback([], this as unknown as ResizeObserver);
        }
        observe(): void {}
        disconnect(): void {}
      }
      vi.stubGlobal("ResizeObserver", Observer);
      return mountPair();
    }

    const resizeTo = (viewport: HTMLElement, width: number, height: number): void => {
      Object.defineProperties(viewport, { clientWidth: { value: width, configurable: true }, clientHeight: { value: height, configurable: true } });
      resize?.();
    };

    const COLLAPSED = [
      { name: "width", width: 0, height: 800 },
      { name: "height", width: 1200, height: 0 },
    ];

    it.each(COLLAPSED)("leaves a camera the user moved alone when the viewport loses its $name, also when it comes back", ({ width, height }) => {
      const rig = mountObserved();
      try {
        wheel(rig.viewport, { deltaX: 10, deltaY: 20 });
        resizeTo(rig.viewport, width, height);
        expect(rig.engine.getCamera()).toEqual({ x: 311, y: 325, k: 1 });
        expect(worldCamera(rig.world)).toEqual({ x: 311, y: 325, k: 1 });
        // 回来的这一次也不平移：上一次的尺寸（有一边是 0）算“之前不可见”。
        resizeTo(rig.viewport, 1200, 800);
        expect(rig.engine.getCamera()).toEqual({ x: 311, y: 325, k: 1 });
        expect(worldCamera(rig.world)).toEqual({ x: 311, y: 325, k: 1 });
      } finally {
        rig.engine.unmount();
      }
    });

    it.each(COLLAPSED)("does not refit an automatic camera when the viewport loses its $name", ({ width, height }) => {
      const rig = mountObserved();
      try {
        expect(rig.engine.getCamera()).toEqual({ x: 321, y: 345, k: 1 });
        resizeTo(rig.viewport, width, height);
        expect(rig.engine.getCamera()).toEqual({ x: 321, y: 345, k: 1 });
        expect(worldCamera(rig.world)).toEqual({ x: 321, y: 345, k: 1 });
        expect(rig.engine.isUserMoved()).toBe(false);
      } finally {
        rig.engine.unmount();
      }
    });
  });
});
