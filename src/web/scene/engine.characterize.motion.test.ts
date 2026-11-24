import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SceneEngine } from "./engine";
import { wheel, worldCamera } from "./engine-characterize.fixtures";
import { at, mountPair, selectBoth } from "./engine.fixtures";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * 特征化测试（补洞）：“减少动效”偏好——卸载之后它还剩什么、change 事件怎么读、中途打开时飞行中的节点怎样落地。
 * 这几处在拆分之前的实现里就没有测试守着，是拆分之后补跑 60 个单行变异时才暴露的（见 HARDEN-E 报告）。
 * 数值是未改动的引擎跑出来的结果。
 */
describe("canvas reduced-motion preference, the remaining corners", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
  });
  afterEach(() => {
    // 先还原全局替身再还原定时器：反过来会把假的 requestAnimationFrame 留在全局上。
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
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

  /** 可以随时改的“减少动效”偏好：`matches` 读的是一个变量，`change` 改变量并发出 change 事件，`poke` 只发事件。 */
  function preference(initial: boolean) {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    vi.spyOn(window, "matchMedia").mockReturnValue(media);
    let current = initial;
    Object.defineProperty(media, "matches", { get: () => current, configurable: true });
    return {
      change: (value: boolean): void => {
        current = value;
        media.dispatchEvent(new Event("change"));
      },
      poke: (): void => {
        media.dispatchEvent(new Event("change"));
      },
    };
  }

  /** 没给过布局、也没登记过节点的最小画布：只有视口、世界层与管线组。（有布局时重新挂载会按布局取景，盖住相机原来的位置。） */
  function bare() {
    const viewport = document.createElement("div");
    const world = document.createElement("div");
    const svg = document.createElementNS(SVG_NS, "svg");
    const tube = document.createElementNS(SVG_NS, "g");
    const dots = document.createElementNS(SVG_NS, "g");
    svg.append(tube, dots);
    world.append(svg);
    viewport.append(world);
    document.body.append(viewport);
    Object.defineProperties(viewport, { clientWidth: { value: 1200, configurable: true }, clientHeight: { value: 800, configurable: true } });
    viewport.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 1200, height: 800 });
    const engine = new SceneEngine();
    return { engine, viewport, world, mount: (): void => engine.mount({ viewport, world, pipes: { tube, dots } }) };
  }

  it("lands a node exactly on its target, with no speed left, when reduced motion is switched on during a vertical flight", () => {
    const pref = preference(false);
    const clock = frames();
    const { engine, origin } = mountPair();
    try {
      clock.tick();
      selectBoth(engine);
      // 向上对齐：来源卡从 y=30 走向 y=14，横向不动、只有纵向在飞（横向的飞行由 frame 的特征化测试守着）。
      expect(engine.align("top")).toBe(true);
      clock.tick();
      clock.tick();
      clock.tick();
      const flying = at(origin);
      expect(flying.x).toBe(0);
      expect(flying.y).toBeGreaterThan(14);
      expect(flying.y).toBeLessThan(30);
      pref.change(true);
      clock.tick();
      // 剩下的纵向速度要在落地的这一帧一并清掉，否则节点会带着它从目标上滑出去，还要再飞好几帧。
      expect(origin.style.translate).toBe("0.00px 14.00px");
      expect(clock.pending()).toBe(0);
    } finally {
      engine.unmount();
    }
  });

  it("keeps springing nodes when a change event arrives while the query still does not match", () => {
    const pref = preference(false);
    const clock = frames();
    const { engine, agent } = mountPair();
    try {
      clock.tick();
      selectBoth(engine);
      expect(engine.align("left")).toBe(true);
      clock.tick();
      pref.poke();
      clock.tick();
      // 事件本身不说明偏好变了：引擎读的是事件之后的 `matches`，仍是“不减少”，节点接着走弹簧。
      expect(at(agent).x).toBeGreaterThan(0);
      expect(at(agent).x).toBeLessThan(310);
      expect(clock.pending()).toBe(1);
    } finally {
      engine.unmount();
    }
  });

  it("goes back to springs when the preference is switched off again", () => {
    const pref = preference(false);
    const clock = frames();
    const { engine, agent } = mountPair();
    try {
      clock.tick();
      pref.change(true);
      selectBoth(engine);
      expect(engine.align("left")).toBe(true);
      clock.tick();
      expect(agent.style.translate).toBe("0.00px 14.00px");
      expect(clock.pending()).toBe(0);
      pref.change(false);
      expect(engine.undo()).toBe(true);
      clock.tick();
      expect(at(agent).x).toBeGreaterThan(0);
      expect(at(agent).x).toBeLessThan(310);
      expect(clock.pending()).toBe(1);
    } finally {
      engine.unmount();
    }
  });

  it.each([
    { reduced: true, camera: { x: 0, y: 0, k: 1 } },
    { reduced: false, camera: { x: -100, y: -50, k: 1 } },
  ])("answers a fit() asked while unmounted with the last known preference (reduced: $reduced), and the next mount shows the result", ({ reduced, camera }) => {
    preference(reduced);
    const { engine, viewport, world, mount } = bare();
    mount();
    wheel(viewport, { deltaX: 100, deltaY: 50 });
    expect(worldCamera(world)).toEqual({ x: -100, y: -50, k: 1 });
    engine.unmount();
    // 卸载只摘掉监听，不清掉最近一次的结果：偏好减少动效时相机直接落到取景的位置，否则还留在原处等弹簧（没有挂载就没有帧）。
    engine.fit();
    expect(engine.getCamera()).toEqual({ x: 0, y: 0, k: 1 });
    mount();
    expect(worldCamera(world)).toEqual(camera);
    engine.unmount();
  });
});
