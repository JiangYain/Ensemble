import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneEngine } from "./engine";
import { wheel } from "./engine-characterize.fixtures";
import { cameraRun, nodeRun } from "./engine-characterize.springs";
import { mountPair, pointer, selectBoth, stored } from "./engine.fixtures";

/**
 * 特征化测试（补洞）：弹簧落定的那一帧做了两件事——位置精确吸到目标上、速度清零——相机与节点、横向与纵向各自有人守着。
 * 落定的条件是“距离 < 阈值且速度 < 阈值”，所以落定时位置总差一点点（相机约 0.004px）、速度还剩一点点（相机约 0.05px/s、节点约 0.03px/s）；
 * 这点残余在画面上看不出来（读数只写到 0.01px），只有“落定之后再飞一次”才露出来：落定前的残余没吸掉，下一次飞行就从偏了的位置起步；
 * 速度没清掉，下一次飞行就带着它出发。读数的精度不够，所以用两个办法读到弹簧此刻精确的位置：
 * 相机——在空白画布上按下并拖过 6px（触屏平移），相机跟着手走，`getCamera()` 就是按下那一刻相机的精确位置加 6px；
 * 节点——键盘微调从弹簧此刻的位置起算（`moveNode`），存进 localStorage 的就是它加上微调量。
 * 该有的数是 `engine-characterize.springs.ts` 里独立复算的同一条弹簧给的（从静止起步），不是从引擎里抄的；
 * 拆分之前的实现里这几处没有测试守着，是拆分之后补跑单行变异时才暴露的（见 HARDEN-E 报告）。
 */
describe("canvas springs, what landing leaves behind", () => {
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
      /** 时钟走 `ms` 毫秒，再跑一帧（帧的时间戳就是此刻的时钟）。 */
      tick: (ms = 16): void => {
        vi.advanceTimersByTime(ms);
        clock += ms;
        queue.shift()?.callback(clock);
      },
    };
  }

  type Clock = ReturnType<typeof frames>;

  /** 按 `ms` 一帧推进，直到帧循环停下（弹簧落定）；返回走了多少帧。 */
  const flyUntilSettled = (clock: Clock, ms: number): number => {
    let count = 0;
    while (clock.pending() > 0 && count < 3000) {
      clock.tick(ms);
      count++;
    }
    expect(clock.pending()).toBe(0);
    return count;
  };

  const ticks = (clock: Clock, ms: number, count: number): void => {
    for (let i = 0; i < count; i++) clock.tick(ms);
  };

  /** 相机此刻精确停在哪里（不动它：之后不再有帧）：触屏在空白画布上按下、拖过 6px，再抬起。 */
  function cameraNow(engine: SceneEngine, viewport: HTMLElement): { x: number; y: number; k: number } {
    pointer(viewport, "pointerdown", 100, 700, { pointerType: "touch" });
    pointer(viewport, "pointermove", 106, 700, { pointerType: "touch" });
    const { x, y, k } = engine.getCamera();
    pointer(viewport, "pointerup", 106, 700, { pointerType: "touch" });
    return { x: x - 6, y, k };
  }

  /** 相机被滚轮挪到偏离“适应”位置 (321, 345) 40px 的地方，再用“适应”飞回去（两根轴同样的位移，两根轴一起落定）。 */
  function flyBackToFit(clock: Clock, engine: SceneEngine, viewport: HTMLElement, ms: number): void {
    wheel(viewport, { deltaX: 40, deltaY: 40 });
    expect(engine.getCamera()).toEqual({ x: 281, y: 305, k: 1 });
    engine.fit();
    flyUntilSettled(clock, ms);
    expect(engine.getCamera()).toEqual({ x: 321, y: 345, k: 1 });
  }

  it("lands the camera exactly on its target, horizontally and vertically, not a hair short of it", () => {
    const clock = frames();
    const { engine, viewport } = mountPair();
    try {
      clock.tick();
      flyBackToFit(clock, engine, viewport, 16);
      expect(cameraNow(engine, viewport)).toEqual({ x: 321, y: 345, k: 1 });
    } finally {
      engine.unmount();
    }
  });

  it("starts the next camera flight from rest, not with the speed the last one landed with", () => {
    const clock = frames();
    const { engine, viewport } = mountPair();
    try {
      clock.tick();
      flyBackToFit(clock, engine, viewport, 16);
      // 缩放以视口中心为不动点，相机在 (321, 345)，所以两根轴都要飞；飞 10 帧、每帧 8ms，速度的残余影响最大的就是这段时间。
      engine.zoomBy(1.2);
      const target = { ...engine.getCamera() };
      ticks(clock, 8, 10);
      const expected = cameraRun({ x: 321, y: 345, k: 1 }, target, Array.from({ length: 10 }, () => 8)).last;
      const now = cameraNow(engine, viewport);
      expect(now.x).toBeCloseTo(expected.x, 7);
      expect(now.y).toBeCloseTo(expected.y, 7);
      expect(now.k).toBeCloseTo(expected.k, 9);
    } finally {
      engine.unmount();
    }
  });

  /**
   * 一个节点沿一根轴飞两程：对齐把它送走（第一程，每帧 8ms，走到落定），撤销把它送回来（第二程，每帧 4ms，飞 20 帧），
   * 然后键盘微调 10px，存下来的是弹簧此刻的位置加上微调量。第一程落定时剩下约 0.03px/s 的速度，第二程若带着它出发，
   * 飞到这一刻会差约 0.0008px。横向取 agent（向左对齐，310 → 0），纵向取来源（向上对齐，30 → 14）。
   */
  const FLIGHTS: readonly { name: string; id: string; align: "left" | "top"; from: number; to: number; nudge: [number, number]; axis: "x" | "y" }[] = [
    { name: "horizontally", id: "agent:one", align: "left", from: 0, to: 310, nudge: [10, 0], axis: "x" },
    { name: "vertically", id: "origin:one", align: "top", from: 14, to: 30, nudge: [0, 10], axis: "y" },
  ];

  it.each(FLIGHTS)("starts the next node flight from rest, not with the speed the last one landed with, $name", ({ id, align, from, to, nudge, axis }) => {
    const clock = frames();
    const { engine } = mountPair();
    try {
      clock.tick();
      selectBoth(engine);
      expect(engine.align(align)).toBe(true);
      flyUntilSettled(clock, 8);
      expect(engine.undo()).toBe(true);
      ticks(clock, 4, 20);
      engine.clearSelection();
      engine.moveNode(id, nudge[0], nudge[1]);
      const expected = nodeRun(from, to, Array.from({ length: 20 }, () => 4)).last;
      expect(stored()[id]![axis]).toBeCloseTo(expected + 10, 7);
    } finally {
      engine.unmount();
    }
  });
});
