import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { worldCamera } from "./engine-characterize.fixtures";
import { at, edge, mountPair, mountScene, node, pairLayout, pointer, POSITIONS_KEY, sceneOf, selectBoth } from "./engine.fixtures";

/**
 * 特征化测试：帧循环——弹簧积分的数值、时间步长的夹取与细分、停帧条件、一帧里写 DOM 的顺序、减少动效。
 * 拆分引擎之前在旧实现上跑绿，拆分之后必须仍然全绿。弹簧的参考值（刚度 240 / 阻尼 27 / 阈值 0.04，相机 170 / 26）
 * 是另行用纯计算脚本独立复算过的：旧实现的数值与它逐帧一致，这里的字面量与下面的参考积分器都是那份结果。
 */

const NODE_STIFFNESS = 240;
const NODE_DAMPING = 27;
const NODE_EPS = 0.04;
const CAMERA_STIFFNESS = 170;
const CAMERA_DAMPING = 26;

interface Spied {
  mock: { calls: readonly (readonly unknown[])[]; invocationCallOrder: readonly number[] };
}

/** 一个 spy 里对某个属性（或属性名参数）的全部写入：带上全局调用序号，几个目标的写入可以合成一条时间线。 */
const writesTo = (spy: Spied, label: string, property: string): { order: number; text: string }[] =>
  spy.mock.calls.flatMap((args, i) => (args[0] === property ? [{ order: spy.mock.invocationCallOrder[i]!, text: label }] : []));

const inOrder = (writes: readonly { order: number; text: string }[]): string[] => [...writes].sort((a, b) => a.order - b.order).map((entry) => entry.text);

/** 一帧该走几个子步、每步多长：帧间隔夹在 1ms 到 50ms 之间，再按 1/120 秒细分。 */
function stepsOf(ms: number): { steps: number; h: number } {
  const dt = Math.min(0.05, Math.max(0.001, ms / 1000));
  const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
  return { steps, h: dt / steps };
}

/** 参考积分器：一个节点沿一根轴走向目标；返回每帧之后写出来的位置串，到位时的那一帧精确落在目标上。 */
function referenceNode(from: number, to: number, dts: readonly number[]): { rows: string[]; settledAt: number | undefined } {
  let x = from;
  let v = 0;
  const rows: string[] = [];
  for (const [index, ms] of dts.entries()) {
    const { steps, h } = stepsOf(ms);
    for (let i = 0; i < steps; i++) {
      v += (-NODE_STIFFNESS * (x - to) - NODE_DAMPING * v) * h;
      x += v * h;
    }
    const settled = Math.abs(x - to) < NODE_EPS && Math.abs(v) < NODE_EPS;
    if (settled) {
      x = to;
      v = 0;
    }
    rows.push(`${x.toFixed(2)}px`);
    if (settled) return { rows, settledAt: index + 1 };
  }
  return { rows, settledAt: undefined };
}

/** 参考积分器：相机三个分量一起走向目标。 */
function referenceCamera(from: { x: number; y: number; k: number }, to: { x: number; y: number; k: number }, dts: readonly number[]): { rows: string[]; settledAt: number | undefined } {
  const cam = { ...from };
  const v = { x: 0, y: 0, k: 0 };
  const rows: string[] = [];
  for (const [index, ms] of dts.entries()) {
    const { steps, h } = stepsOf(ms);
    for (let i = 0; i < steps; i++) {
      v.x += (-CAMERA_STIFFNESS * (cam.x - to.x) - CAMERA_DAMPING * v.x) * h;
      v.y += (-CAMERA_STIFFNESS * (cam.y - to.y) - CAMERA_DAMPING * v.y) * h;
      v.k += (-CAMERA_STIFFNESS * (cam.k - to.k) - CAMERA_DAMPING * v.k) * h;
      cam.x += v.x * h;
      cam.y += v.y * h;
      cam.k += v.k * h;
    }
    const settled =
      Math.abs(cam.x - to.x) < 0.05 && Math.abs(cam.y - to.y) < 0.05 && Math.abs(cam.k - to.k) < 0.0004 &&
      Math.abs(v.x) < 0.05 && Math.abs(v.y) < 0.05 && Math.abs(v.k) < 0.001;
    if (settled) Object.assign(cam, to);
    rows.push(`translate3d(${cam.x.toFixed(2)}px,${cam.y.toFixed(2)}px,0) scale(${cam.k.toFixed(4)})`);
    if (settled) return { rows, settledAt: index + 1 };
  }
  return { rows, settledAt: undefined };
}

describe("canvas frame loop", () => {
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

  /** 手动推进的帧：`requestAnimationFrame` 只排队，由测试按指定的时间戳触发；`performance.now()` 跟着同一个时钟。 */
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
    const run = (now: number): void => {
      queue.shift()?.callback(now);
    };
    return {
      pending: () => queue.length,
      run,
      /** 没有帧的一段时间。 */
      idle: (ms: number): void => {
        vi.advanceTimersByTime(ms);
        clock += ms;
      },
      /** 时钟走 `ms` 毫秒，再跑一帧（帧的时间戳就是此刻的时钟）。 */
      tick: (ms = 16): void => {
        vi.advanceTimersByTime(ms);
        clock += ms;
        run(clock);
      },
      now: () => clock,
    };
  }

  /** 挂好一对节点、跑掉布局触发的那一帧、选中两个并向左对齐：agent 从 310 走向 0。 */
  function aligned() {
    const clock = frames();
    const rig = mountPair();
    clock.tick();
    expect(clock.pending()).toBe(0);
    selectBoth(rig.engine);
    expect(rig.engine.align("left")).toBe(true);
    return { clock, ...rig };
  }

  it("integrates a node spring frame by frame and snaps onto the target in the frame it settles", () => {
    const { clock, engine, agent } = aligned();
    try {
      expect(clock.pending()).toBe(1);
      const rows: string[] = [];
      for (let i = 0; i < 200 && clock.pending() > 0; i++) {
        clock.tick(16);
        rows.push(agent.style.translate);
      }
      const reference = referenceNode(310, 0, Array.from({ length: 200 }, () => 16));
      expect(reference.settledAt).toBe(52);
      expect(rows).toEqual(reference.rows.map((row) => `${row} 14.00px`));
      expect(rows.slice(0, 4)).toEqual(["296.82px 14.00px", "272.52px 14.00px", "242.71px 14.00px", "211.14px 14.00px"]);
      // 弹簧欠阻尼：越过目标一点点再回来；最后一帧精确落在目标上，之后不再排帧。
      expect(rows.slice(26, 31)).toEqual(["0.01px 14.00px", "-0.08px 14.00px", "-0.12px 14.00px", "-0.15px 14.00px", "-0.15px 14.00px"]);
      expect(rows.at(-1)).toBe("0.00px 14.00px");
      expect(rows).toHaveLength(52);
      expect(clock.pending()).toBe(0);
      expect(at(agent)).toEqual({ x: 0, y: 14 });
    } finally {
      engine.unmount();
    }
  });

  it("stamps the clock when it wakes up, so the first frame after an idle spell is a normal one", () => {
    const clock = frames();
    const { engine, agent } = mountPair();
    try {
      clock.tick();
      clock.idle(5000);
      selectBoth(engine);
      engine.align("left");
      clock.tick(16);
      expect(agent.style.translate).toBe("296.82px 14.00px");
    } finally {
      engine.unmount();
    }
  });

  it("clamps the frame interval to 1–50 ms and splits it into steps of at most 1/120 s", () => {
    const { clock, engine, agent } = aligned();
    try {
      const base = clock.now();
      const stamps = [1000, 1000, 995, 1003, 1052, 1102, 1153, 1170];
      const seen: string[] = [];
      for (const stamp of stamps) {
        clock.run(base + stamp);
        seen.push(agent.style.translate);
      }
      expect(seen).toEqual([
        "238.28px 14.00px",
        "236.34px 14.00px",
        "234.40px 14.00px",
        "218.59px 14.00px",
        "129.72px 14.00px",
        "67.23px 14.00px",
        "31.50px 14.00px",
        "23.65px 14.00px",
      ]);
      expect(stepsOf(50).steps).toBe(6);
      expect(stepsOf(17).steps).toBe(3);
      expect(clock.pending()).toBe(1);
    } finally {
      engine.unmount();
    }
  });

  it("springs the camera toward its target, settles within its own thresholds and stops requesting frames", () => {
    const clock = frames();
    const { engine, world } = mountPair();
    try {
      clock.tick();
      engine.zoomBy(1.2);
      const rows: string[] = [];
      for (let i = 0; i < 300 && clock.pending() > 0; i++) {
        clock.tick(16);
        rows.push(world.style.transform);
      }
      const reference = referenceCamera({ x: 321, y: 345, k: 1 }, { x: 600 - (600 - 321) * 1.2, y: 400 - (400 - 345) * 1.2, k: 1.2 }, Array.from({ length: 300 }, () => 16));
      expect(reference.settledAt).toBe(64);
      expect(rows).toEqual(reference.rows);
      expect(rows[0]).toBe("translate3d(319.31px,344.67px,0) scale(1.0061)");
      expect(rows.at(-1)).toBe("translate3d(265.20px,334.00px,0) scale(1.2000)");
      expect(clock.pending()).toBe(0);
    } finally {
      engine.unmount();
    }
  });

  it("writes nodes in registration order, then the world layer, then the pipes, once per frame", () => {
    const { clock, engine, origin, agent, world, tube } = aligned();
    try {
      engine.zoomBy(1.2);
      const path = tube.querySelector("path")!;
      const originWrites = vi.spyOn(origin.style, "setProperty");
      const agentWrites = vi.spyOn(agent.style, "setProperty");
      const worldWrites = vi.spyOn(world.style, "setProperty");
      const pathWrites = vi.spyOn(path, "setAttribute");
      clock.tick();
      expect(inOrder([
        ...writesTo(originWrites, "origin:translate", "translate"),
        ...writesTo(agentWrites, "agent:translate", "translate"),
        ...writesTo(worldWrites, "world:transform", "transform"),
        ...writesTo(pathWrites, "path:d", "d"),
      ])).toEqual(["origin:translate", "agent:translate", "world:transform", "path:d"]);
    } finally {
      engine.unmount();
    }
  });

  it("walks the bodies in registration order and skips elements that are not in the layout", () => {
    const clock = frames();
    const rig = mountScene(sceneOf([]));
    try {
      const b = rig.attach("b");
      const a = rig.attach("a");
      const c = rig.attach("c");
      rig.engine.setLayout(sceneOf([node("a", 0, 0), node("b", 300, 0)]));
      const aSpy = vi.spyOn(a.style, "setProperty");
      const bSpy = vi.spyOn(b.style, "setProperty");
      const cSpy = vi.spyOn(c.style, "setProperty");
      clock.tick();
      expect(inOrder([...writesTo(bSpy, "b", "translate"), ...writesTo(aSpy, "a", "translate")])).toEqual(["b", "a"]);
      expect(cSpy).not.toHaveBeenCalled();
      expect(c.style.translate).toBe("");
    } finally {
      rig.engine.unmount();
    }
  });

  it("asks for at most one frame at a time however often it is woken", () => {
    const clock = frames();
    const { engine } = mountPair();
    try {
      clock.tick();
      expect(clock.pending()).toBe(0);
      engine.zoomBy(1.1);
      engine.zoomBy(1.1);
      engine.moveNode("agent:one", 5, 0);
      engine.setLayout(pairLayout);
      expect(clock.pending()).toBe(1);
    } finally {
      engine.unmount();
    }
  });

  it("keeps requesting frames while only the camera is still moving, and drops the request on unmount", () => {
    const clock = frames();
    const { engine } = mountPair();
    clock.tick();
    engine.zoomBy(1.2);
    clock.tick();
    expect(clock.pending()).toBe(1);
    engine.unmount();
    expect(clock.pending()).toBe(0);
  });

  it("freezes the camera spring while a node is being dragged", () => {
    const clock = frames();
    const { engine, viewport, world, agent } = mountPair();
    try {
      clock.tick();
      engine.zoomBy(1.2);
      clock.tick();
      clock.tick();
      const mid = worldCamera(world);
      expect(mid.k).toBeGreaterThan(1);
      expect(mid.k).toBeLessThan(1.2);
      pointer(agent, "pointerdown", 400, 300);
      pointer(viewport, "pointermove", 450, 300);
      // 拖动一开始相机的目标就停在此刻的位置，之后的帧不再动它。
      expect(engine.getCamera().k).toBeCloseTo(mid.k, 3);
      expect(engine.getCamera().x).toBeCloseTo(mid.x, 1);
      clock.tick();
      clock.tick();
      expect(worldCamera(world)).toEqual(mid);
      pointer(viewport, "pointerup", 450, 300);
      clock.tick();
      clock.tick();
      expect(worldCamera(world)).toEqual(mid);
      expect(engine.isUserMoved()).toBe(true);
      expect(clock.pending()).toBe(0);
    } finally {
      engine.unmount();
    }
  });

  it("snaps nodes onto their targets and applies camera changes at once when reduced motion is on", () => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    vi.spyOn(window, "matchMedia").mockReturnValue(media);
    const { clock, engine, agent, world } = aligned();
    try {
      clock.tick();
      expect(at(agent).x).toBeGreaterThan(200);
      Object.defineProperty(media, "matches", { value: true, configurable: true });
      media.dispatchEvent(new Event("change"));
      clock.tick();
      expect(agent.style.translate).toBe("0.00px 14.00px");
      expect(clock.pending()).toBe(0);
      engine.zoomBy(1.2);
      expect(worldCamera(world)).toEqual({ x: 265.2, y: 334, k: 1.2 });
    } finally {
      engine.unmount();
    }
  });

  it("grows a new node out of its upstream node, and not when reduced motion is on or the position is stored", () => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    vi.spyOn(window, "matchMedia").mockReturnValue(media);
    localStorage.setItem(POSITIONS_KEY, JSON.stringify({ "agent:stored": { x: 700, y: 300 } }));
    const clock = frames();
    const rig = mountPair();
    const { engine } = rig;
    try {
      clock.tick();
      const more = (id: string, x: number): ReturnType<typeof node> => node(id, x, 14, { w: 248, h: 144 });
      const link = (id: string): ReturnType<typeof edge> => edge("agent:one", id);
      const grown = rig.attach("agent:two");
      engine.setLayout(sceneOf([...pairLayout.nodes, more("agent:two", 620)], [...pairLayout.edges, link("agent:two")]));
      expect(grown.dataset["fresh"]).toBe("");
      expect(at(grown)).toEqual({ x: 409.2, y: 14 });
      for (let i = 0; i < 300 && clock.pending() > 0; i++) clock.tick();
      expect(at(grown)).toEqual({ x: 620, y: 14 });
      const stored = rig.attach("agent:stored");
      engine.setLayout(sceneOf([...pairLayout.nodes, more("agent:two", 620), more("agent:stored", 900)], [...pairLayout.edges, link("agent:two"), link("agent:stored")]));
      expect(stored.dataset["fresh"]).toBeUndefined();
      expect(at(stored)).toEqual({ x: 700, y: 300 });
      Object.defineProperty(media, "matches", { value: true, configurable: true });
      media.dispatchEvent(new Event("change"));
      const calm = rig.attach("agent:calm");
      engine.setLayout(sceneOf([...pairLayout.nodes, more("agent:two", 620), more("agent:stored", 900), more("agent:calm", 1200)], [...pairLayout.edges, link("agent:two"), link("agent:stored"), link("agent:calm")]));
      expect(calm.dataset["fresh"]).toBeUndefined();
      expect(at(calm)).toEqual({ x: 1200, y: 14 });
    } finally {
      engine.unmount();
    }
  });
});
