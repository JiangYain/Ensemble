import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SceneEngine } from "./engine";
import { wheel, worldCamera } from "./engine-characterize.fixtures";
import { at, mountPair, node, origin, pointer, sceneOf, selectBoth } from "./engine.fixtures";

/**
 * 特征化测试：相机弹簧“什么时候算落定”的六个条件各自说了算的场景，以及弹簧与手（拖动、手放）、卸载之间的几处衔接。
 * 拆分引擎之前在旧实现上跑绿，拆分之后必须仍然全绿。表里的 `frames`（弹簧在第几帧落定、帧循环停下）
 * 是另行用纯计算脚本独立复算同一条弹簧得到的，不是从引擎里抄的。
 */
describe("canvas spring settling and hand-over", () => {
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
      /** 时钟走 `ms` 毫秒，再跑一帧（帧的时间戳就是此刻的时钟）。 */
      tick: (ms = 16): void => {
        vi.advanceTimersByTime(ms);
        clock += ms;
        queue.shift()?.callback(clock);
      },
    };
  }

  /**
   * 视口中心 (600, 400) 是 `zoomBy` 的不动点：先用滚轮把相机滚到 `at`，相机落在中心的那根轴上就一点不动，
   * 剩下的条件里谁最后满足、谁就决定弹簧在哪一帧落定。`ms` 是帧间隔（1ms 是引擎允许的最短一帧，50ms 是最长）。
   */
  const SETTLE: readonly { name: string; at: readonly [number, number]; factor: number; ms: number; frames: number }[] = [
    { name: "zoom distance (0.0004)", at: [600, 400], factor: 1.00045, ms: 1, frames: 214 },
    { name: "zoom speed (0.001)", at: [600, 400], factor: 1.000237, ms: 50, frames: 3 },
    { name: "horizontal distance (0.05)", at: [321, 400], factor: 1.0002, ms: 1, frames: 313 },
    { name: "vertical distance (0.05)", at: [600, 125], factor: 1.0002, ms: 1, frames: 311 },
    { name: "vertical speed (0.05)", at: [600, 200], factor: 1.5, ms: 16, frames: 67 },
    { name: "horizontal speed (0.05)", at: [100, 400], factor: 1.5, ms: 16, frames: 73 },
    // 目标只比相机多走一点点、刚好落在距离阈值之内：第一帧就该落定。阈值收紧一点（0.0003 / 0.04）就要多走几十甚至几百帧。
    { name: "zoom distance, started just inside it (0.0004)", at: [600, 400], factor: 1.00035, ms: 16, frames: 1 },
    { name: "horizontal distance, started just inside it (0.05)", at: [321, 400], factor: 1.00016, ms: 1, frames: 1 },
    { name: "vertical distance, started just inside it (0.05)", at: [600, 125], factor: 1.00016, ms: 1, frames: 1 },
  ];

  it.each(SETTLE)("settles the camera on the frame its own $name allows, and stops asking for frames then", ({ at: [x, y], factor, ms, frames: expected }) => {
    const clock = frames();
    const { engine, viewport } = mountPair();
    try {
      clock.tick();
      expect(clock.pending()).toBe(0);
      wheel(viewport, { deltaX: 321 - x, deltaY: 345 - y });
      expect(engine.getCamera()).toEqual({ x, y, k: 1 });
      expect(clock.pending()).toBe(0);
      engine.zoomBy(factor);
      let count = 0;
      while (clock.pending() > 0 && count < 2000) {
        clock.tick(ms);
        count++;
      }
      expect(count).toBe(expected);
    } finally {
      engine.unmount();
    }
  });

  /**
   * 节点的弹簧：布局把一个节点的目标挪开 `dx` / `dy` 个像素，之后按 `ms` 毫秒一帧推进，数到帧循环停下。
   * 每根轴各有“距离 < 0.04”与“速度 < 0.04”两个条件，`frames` 同样是另行用纯计算脚本复算同一条弹簧得到的。
   * 1ms 一帧时，16px 的位移里两个条件都在说话（放宽任何一个都会提前落定）；后四行是刚好落在阈值之内的位移，第一帧就该落定，
   * 阈值收紧一点（0.03）就要多走几十帧。
   */
  const NODE_SETTLE: readonly { name: string; dx: number; dy: number; ms: number; frames: number }[] = [
    { name: "horizontal distance and speed (0.04), from 16px", dx: 16, dy: 0, ms: 1, frames: 686 },
    { name: "vertical distance and speed (0.04), from 16px", dx: 0, dy: 16, ms: 1, frames: 686 },
    { name: "horizontal distance, started just inside it (0.04)", dx: 0.035, dy: 0, ms: 1, frames: 1 },
    { name: "vertical distance, started just inside it (0.04)", dx: 0, dy: 0.035, ms: 1, frames: 1 },
    { name: "horizontal speed, started just inside it (0.04)", dx: 0.02, dy: 0, ms: 8, frames: 1 },
    { name: "vertical speed, started just inside it (0.04)", dx: 0, dy: 0.02, ms: 8, frames: 1 },
  ];

  it.each(NODE_SETTLE)("settles a node on the frame its own $name allows, and stops asking for frames then", ({ dx, dy, ms, frames: expected }) => {
    const clock = frames();
    const { engine, viewport, agent } = mountPair();
    try {
      clock.tick();
      // 相机归用户：之后换布局不会去取景，帧循环里只剩这个节点在动。
      wheel(viewport, { deltaX: 1, deltaY: 0 });
      expect(clock.pending()).toBe(0);
      engine.setLayout(sceneOf([origin("origin:one", 0, 30), node("agent:one", 310 + dx, 14 + dy, { w: 248, h: 144 })]));
      let count = 0;
      while (clock.pending() > 0 && count < 2000) {
        clock.tick(ms);
        count++;
      }
      expect(count).toBe(expected);
      expect(at(agent).x).toBeCloseTo(310 + dx, 1);
      expect(at(agent).y).toBeCloseTo(14 + dy, 1);
    } finally {
      engine.unmount();
    }
  });

  it("restarts a camera that was grabbed in mid-flight from rest, not with the speed it had", () => {
    const clock = frames();
    const { engine, viewport, world, agent } = mountPair();
    try {
      clock.tick();
      engine.zoomBy(1.2);
      clock.tick();
      clock.tick();
      expect(worldCamera(world)).toEqual({ x: 316.15, y: 344.04, k: 1.0174 });
      // 手抓住一个节点拖了一下：相机就停在手抓住它的地方，弹簧原来的速度不能留着。
      pointer(agent, "pointerdown", 400, 300);
      pointer(viewport, "pointermove", 450, 300);
      pointer(viewport, "pointerup", 450, 300);
      expect(worldCamera(world)).toEqual({ x: 316.15, y: 344.04, k: 1.0174 });
      engine.zoomBy(1.5);
      const rows: string[] = [];
      for (let i = 0; i < 3; i++) {
        clock.tick();
        rows.push(world.style.transform);
      }
      expect(rows).toEqual([
        "translate3d(311.85px,343.20px,0) scale(1.0328)",
        "translate3d(303.81px,341.61px,0) scale(1.0616)",
        "translate3d(293.73px,339.62px,0) scale(1.0978)",
      ]);
    } finally {
      engine.unmount();
    }
  });

  it("does not spring the camera while a node is being dragged, even when its target moves meanwhile, and nothing wakes it on release", () => {
    const clock = frames();
    const { engine, viewport, world, agent } = mountPair();
    try {
      clock.tick();
      pointer(agent, "pointerdown", 400, 300);
      pointer(viewport, "pointermove", 450, 300);
      const held = worldCamera(world);
      engine.zoomBy(1.5);
      expect(engine.getCamera().k).toBe(1.5);
      clock.tick();
      clock.tick();
      expect(worldCamera(world)).toEqual(held);
      pointer(viewport, "pointerup", 450, 300);
      clock.tick();
      expect(worldCamera(world)).toEqual(held);
      expect(clock.pending()).toBe(0);
    } finally {
      engine.unmount();
    }
  });

  it("asks for no frames while it is not mounted, before the first mount and after an unmount", () => {
    const clock = frames();
    const bare = new SceneEngine();
    bare.fit();
    bare.zoomBy(1.2);
    expect(clock.pending()).toBe(0);
    const { engine } = mountPair();
    try {
      clock.tick();
      engine.unmount();
      engine.fit();
      expect(clock.pending()).toBe(0);
    } finally {
      engine.unmount();
    }
  });

  it("stops a node dead when the user places it by hand in the middle of its spring", () => {
    const clock = frames();
    const { engine, agent } = mountPair();
    try {
      clock.tick();
      selectBoth(engine);
      expect(engine.align("left")).toBe(true);
      for (let i = 0; i < 6; i++) clock.tick();
      expect(at(agent).x).toBeGreaterThan(0);
      expect(at(agent).x).toBeLessThan(310);
      engine.moveNode("agent:one", 10, 0);
      const placed = agent.style.translate;
      clock.tick();
      clock.tick();
      expect(agent.style.translate).toBe(placed);
      expect(clock.pending()).toBe(0);
    } finally {
      engine.unmount();
    }
  });
});
