import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneEngine } from "./engine";
import { key, wheel, worldCamera } from "./engine-characterize.fixtures";
import { cameraRun, nodeRun } from "./engine-characterize.springs";
import { at, mountPair, mountScene, node, origin, pointer, sceneOf, selectBoth } from "./engine.fixtures";

/**
 * 特征化测试（补洞）：几个数值阈值——节点与相机的落定条件、单帧时间上限、起拖阈值——再多一道独立的防线。
 * 它们原来各只有一个测试守着（改一个数就只有那一个测试会红）；这里换一种几何、换一个入口各补一条，
 * 两个方向都能分得开：放宽一点与收紧一点都会让至少一条在这里变红。
 * “落定在第几帧”的数字是另行用纯计算脚本独立复算同一条弹簧得到的，不是从引擎里抄的；逐帧读数由 `engine-characterize.springs.ts` 复算。
 */
describe("canvas thresholds, second line of defence", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date", "setTimeout", "clearTimeout"] });
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
      /** 没有帧的一段时间。 */
      idle: (ms: number): void => {
        vi.advanceTimersByTime(ms);
        clock += ms;
      },
      tick: (ms = 16): void => {
        vi.advanceTimersByTime(ms);
        clock += ms;
        queue.shift()?.callback(clock);
      },
    };
  }

  /** 一直按 `ms` 毫秒一帧推进到帧循环停下，数出一共走了几帧。 */
  function countFrames(clock: ReturnType<typeof frames>, ms: number, limit = 3000): number {
    let count = 0;
    while (clock.pending() > 0 && count < limit) {
      clock.tick(ms);
      count++;
    }
    return count;
  }

  describe("node settling distance and speed (0.04)", () => {
    it("settles a node on the 243rd 3ms frame after an undo of 37px, not earlier and not later", () => {
      const clock = frames();
      const { engine, agent } = mountPair();
      try {
        clock.tick();
        engine.moveNode("agent:one", -37, 0);
        expect(at(agent)).toEqual({ x: 273, y: 14 });
        expect(clock.pending()).toBe(0);
        expect(engine.undo()).toBe(true);
        expect(countFrames(clock, 3)).toBe(243);
        expect(at(agent)).toEqual({ x: 310, y: 14 });
        // 与独立复算的弹簧逐帧一致，而不是只数了帧数。
        expect(nodeRun(273, 310, Array.from({ length: 400 }, () => 3)).settledAt).toBe(243);
      } finally {
        engine.unmount();
      }
    });

    it("settles a node on the 358th 2ms frame after an align of 29px, not earlier and not later", () => {
      const clock = frames();
      const rig = mountScene(sceneOf([origin("origin:one", 0, 43), node("agent:one", 310, 14, { w: 248, h: 144 })]));
      const { engine, els } = rig;
      try {
        clock.tick();
        selectBoth(engine);
        expect(engine.align("top")).toBe(true);
        expect(countFrames(clock, 2)).toBe(358);
        expect(els.get("origin:one")!.style.translate).toBe("0.00px 14.00px");
        expect(nodeRun(43, 14, Array.from({ length: 500 }, () => 2)).settledAt).toBe(358);
      } finally {
        engine.unmount();
      }
    });
  });

  describe("camera zoom settling distance (0.0004), in a viewport of another size", () => {
    /** 视口 900×600、相机放在视口中心（缩放的不动点）：x、y 不动，只有缩放在飞。 */
    function centered() {
      const clock = frames();
      const rig = mountPair();
      const { engine, viewport, world } = rig;
      Object.defineProperties(viewport, { clientWidth: { value: 900, configurable: true }, clientHeight: { value: 600, configurable: true } });
      clock.tick();
      wheel(viewport, { deltaX: 321 - 450, deltaY: 345 - 300 });
      expect(worldCamera(world)).toEqual({ x: 450, y: 300, k: 1 });
      return { clock, engine, world };
    }

    const ROWS: readonly { name: string; from: number; to: number; ms: number; frames: number }[] = [
      { name: "0.0005 away is not yet settled: the spring has to carry it in", from: 1, to: 0.9995, ms: 4, frames: 56 },
      { name: "0.0004 away less a hair is settled in the first frame", from: 1, to: 0.9996, ms: 4, frames: 1 },
      { name: "from a zoomed-out camera, 0.0005 away is not yet settled", from: 0.8, to: 0.7995, ms: 6, frames: 38 },
      { name: "from a zoomed-out camera, 0.0004 away less a hair is settled in the first frame", from: 0.8, to: 0.7996, ms: 6, frames: 1 },
    ];

    it.each(ROWS)("$name", ({ from, to, ms, frames: expected }) => {
      const { clock, engine, world } = centered();
      try {
        if (from !== 1) {
          engine.zoomBy(from);
          countFrames(clock, 16);
          expect(worldCamera(world)).toEqual({ x: 450, y: 300, k: from });
        }
        engine.zoomBy(to / from);
        expect(countFrames(clock, ms)).toBe(expected);
        expect(worldCamera(world)).toEqual({ x: 450, y: 300, k: Number(to.toFixed(4)) });
      } finally {
        engine.unmount();
      }
    });
  });

  describe("frame time step (at most 50ms)", () => {
    it("integrates the camera spring with a step capped at 50ms: a 200ms, a 45ms, a 55ms and a 70ms frame", () => {
      const clock = frames();
      const { engine, world } = mountPair();
      try {
        clock.tick();
        engine.zoomBy(1.5);
        const target = { ...engine.getCamera() };
        const dts = [200, 45, 55, 70, 50, ...Array.from({ length: 200 }, () => 16)];
        const expected = cameraRun({ x: 321, y: 345, k: 1 }, target, dts);
        expect(expected.settledAt).toBeGreaterThan(5);
        const rows: string[] = [];
        for (const ms of dts.slice(0, expected.settledAt)) {
          clock.tick(ms);
          rows.push(world.style.transform);
        }
        expect(rows).toEqual(expected.rows);
        expect(clock.pending()).toBe(0);
      } finally {
        engine.unmount();
      }
    });
  });

  describe("the frame clock is stamped when the loop wakes (and only when mounted)", () => {
    it("starts a camera flight after a long idle from the moment it was asked for, not from the last frame", () => {
      const clock = frames();
      const { engine, world } = mountPair();
      try {
        clock.tick();
        clock.idle(5000);
        engine.zoomBy(1.2);
        const expected = cameraRun({ x: 321, y: 345, k: 1 }, { ...engine.getCamera() }, Array.from({ length: 200 }, () => 16));
        const rows: string[] = [];
        for (let i = 0; i < 8; i++) {
          clock.tick(16);
          rows.push(world.style.transform);
        }
        expect(rows).toEqual(expected.rows.slice(0, 8));
        expect(rows[0]).toBe("translate3d(319.31px,344.67px,0) scale(1.0061)");
      } finally {
        engine.unmount();
      }
    });

    it("starts a node flight after a long idle from the moment it was asked for, not from the last frame", () => {
      const clock = frames();
      const { engine, agent } = mountPair();
      try {
        clock.tick();
        engine.moveNode("agent:one", -37, 0);
        clock.idle(5000);
        expect(engine.undo()).toBe(true);
        const expected = nodeRun(273, 310, Array.from({ length: 400 }, () => 16));
        const rows: string[] = [];
        for (let i = 0; i < 6; i++) {
          clock.tick(16);
          rows.push(agent.style.translate.split(" ")[0]!);
        }
        expect(rows).toEqual(expected.rows.slice(0, 6));
      } finally {
        engine.unmount();
      }
    });

    const UNMOUNTED: readonly { name: string; prepare: (engine: SceneEngine) => void; ask: (engine: SceneEngine) => boolean | undefined }[] = [
      { name: "an undo", prepare: (engine) => engine.moveNode("agent:one", 10, 0), ask: (engine) => engine.undo() },
      { name: "a redo", prepare: (engine) => { engine.moveNode("agent:one", 10, 0); engine.undo(); }, ask: (engine) => engine.redo() },
      { name: "a fit()", prepare: () => {}, ask: (engine) => void engine.fit() },
    ];

    it.each(UNMOUNTED)("does not queue a frame for $name that is asked for after the canvas was unmounted", ({ name, prepare, ask }) => {
      const clock = frames();
      const { engine } = mountPair();
      clock.tick();
      prepare(engine);
      countFrames(clock, 16);
      expect(clock.pending()).toBe(0);
      engine.unmount();
      // 历史还在（撤销 / 重做照常生效），只是没有挂载就没有帧：不能排下一帧去推一个没人看的弹簧。
      expect(ask(engine)).toBe(name === "a fit()" ? undefined : true);
      expect(clock.pending()).toBe(0);
    });
  });

  describe("drag threshold (5px) from other entry points", () => {
    interface Row {
      name: string;
      /** 按下：返回手势的落点要被哪个元素标记（视口上的 data-* 名字）。 */
      mark: "panning" | "selecting" | "moving";
      down: (rig: ReturnType<typeof mountPair>) => void;
      move: (rig: ReturnType<typeof mountPair>, dx: number, dy: number) => void;
      /** 不到 5px 的位移（4.9 多一点）与到了的位移（5 与 6 之间）。 */
      short: [number, number];
      long: [number, number];
    }

    const ROWS: readonly Row[] = [
      {
        name: "a touch pan on blank canvas", mark: "panning", short: [-4.99, 0], long: [-5, 0],
        down: ({ viewport }) => pointer(viewport, "pointerdown", 100, 100, { pointerType: "touch" }),
        move: ({ viewport }, dx, dy) => pointer(viewport, "pointermove", 100 + dx, 100 + dy, { pointerType: "touch" }),
      },
      {
        name: "a middle-button pan", mark: "panning", short: [0, 4.99], long: [0, 5.9],
        down: ({ viewport }) => pointer(viewport, "pointerdown", 100, 100, { button: 1 }),
        move: ({ viewport }, dx, dy) => pointer(viewport, "pointermove", 100 + dx, 100 + dy),
      },
      {
        name: "a Space-held pan", mark: "panning", short: [4, 2.9], long: [3, 4],
        down: ({ viewport }) => {
          key("keydown", { key: " ", code: "Space" });
          pointer(viewport, "pointerdown", 100, 100);
        },
        move: ({ viewport }, dx, dy) => pointer(viewport, "pointermove", 100 + dx, 100 + dy),
      },
      {
        name: "a touch drag of a node", mark: "moving", short: [0, -4.99], long: [0, -5],
        down: ({ agent }) => pointer(agent, "pointerdown", 700, 400, { pointerType: "touch" }),
        move: ({ viewport }, dx, dy) => pointer(viewport, "pointermove", 700 + dx, 400 + dy, { pointerType: "touch" }),
      },
      {
        name: "a Shift box-select", mark: "selecting", short: [3.5, 3.5], long: [3.6, 3.6],
        down: ({ viewport }) => pointer(viewport, "pointerdown", 100, 100, { shiftKey: true }),
        move: ({ viewport }, dx, dy) => pointer(viewport, "pointermove", 100 + dx, 100 + dy, { shiftKey: true }),
      },
    ];

    it.each(ROWS)("starts $name at 5px and not before", (row) => {
      const rig = mountPair();
      const { engine, viewport, agent } = rig;
      try {
        row.down(rig);
        row.move(rig, ...row.short);
        expect(viewport.dataset[row.mark]).toBeUndefined();
        expect(at(agent)).toEqual({ x: 310, y: 14 });
        row.move(rig, ...row.long);
        expect(viewport.dataset[row.mark]).toBe("");
        if (row.mark === "moving") expect(at(agent)).toEqual({ x: 310, y: 9 });
        pointer(viewport, "pointerup", 100, 100);
        expect(viewport.dataset[row.mark]).toBeUndefined();
      } finally {
        engine.unmount();
      }
    });
  });
});
