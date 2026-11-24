import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountScene, node, pointer, sceneOf, type SceneRig } from "./engine.fixtures";
import type { SceneLayout } from "./layout";

/**
 * 引擎与“视口外提示”（arrivals.ts）的接线：什么算新到、相机怎么平移、哪些时刻重算。
 * 夹具视口 1200×800；只有一个节点时取景把相机摆在 (494, 352)，缩放 1。纯计算的细节在 offscreen.test.ts 与 arrivals.test.ts。
 */

const a = node("agent:a", 0, 0);
const far = (id: string, x: number, y = 100) => node(id, x, y);
const edges = (rig: SceneRig) => rig.engine.arrivals.getHints().map((hint) => `${hint.edge}:${hint.ids.join(",")}`);

/** 用户的一次平移：和真实手势一样走视口上的滚轮事件，之后相机归用户，不再自动取景。 */
const wheel = (rig: SceneRig, deltaX: number, deltaY = 0): void => {
  rig.viewport.dispatchEvent(new WheelEvent("wheel", { deltaX, deltaY, bubbles: true, cancelable: true }));
};

/** 与页面一致：先给新节点挂元素，再交布局。 */
const show = (rig: SceneRig, layout: SceneLayout): void => {
  for (const spec of layout.nodes) if (!rig.els.has(spec.id)) rig.attach(spec.id);
  rig.engine.setLayout(layout);
};

describe("引擎：新到的会话落在视口之外时的提示", () => {
  let rig: SceneRig | undefined;
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
  });
  afterEach(() => {
    rig?.dispose();
    rig = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
    localStorage.clear();
  });

  it("首次载入：第一份布局里哪怕有节点在视口之外，也不提示", () => {
    rig = mountScene(sceneOf([a, far("agent:far", 5000)]));
    wheel(rig, 1);
    expect(edges(rig)).toEqual([]);
  });

  it("用户动过相机之后新来一个落在视口外的会话：提示在它所在的边；落在视口里的不提示", () => {
    rig = mountScene(sceneOf([a]));
    wheel(rig, 1);
    show(rig, sceneOf([a, far("agent:near", 300, 150), far("agent:far", 3000)]));
    expect(edges(rig)).toEqual(["right:agent:far"]);
  });

  it("来源卡等非会话节点落在视口外不提示", () => {
    rig = mountScene(sceneOf([a]));
    wheel(rig, 1);
    show(rig, sceneOf([a, node("origin:x", 3000, 100, { kind: "origin" })]));
    expect(edges(rig)).toEqual([]);
  });

  it("隐藏开关收起的会话再显示不算新到的；同一次布局里真正新的那个才提示", () => {
    // b 一开始就在视口之外（4000）：再显示时持有逻辑复原隐藏之前的排布（LAYOUT5 · W12），b 原位不动，c 落在规划给的空位上；
    // 以前 b 起初在 400、再显示整体重排才把它们都挪到 4000，现在不会再挪。
    rig = mountScene(sceneOf([a, far("agent:b", 4000)]));
    show(rig, { ...sceneOf([a]), hidden: new Set(["agent:b"]) });
    wheel(rig, 1);
    show(rig, sceneOf([a, far("agent:b", 4000), far("agent:c", 4000, 400)]));
    expect(edges(rig)).toEqual(["right:agent:c"]);
  });

  it("“重置节点布局”不算新到：已知的节点不提示", () => {
    rig = mountScene(sceneOf([a, far("agent:b", 4000)]));
    wheel(rig, 1);
    rig.engine.resetLayout();
    expect(edges(rig)).toEqual([]);
  });

  it("容器重新挂载（聚焦页回到概览）：期间新建的会话不算新到，提示也不带过去", () => {
    rig = mountScene(sceneOf([a]));
    wheel(rig, 1);
    show(rig, sceneOf([a, far("agent:early", 3000)]));
    expect(edges(rig)).toEqual(["right:agent:early"]);

    rig.engine.unmount();
    expect(edges(rig)).toEqual([]);
    rig.engine.mount({ viewport: rig.viewport, world: rig.world, pipes: { tube: rig.tube, dots: rig.dots } });
    show(rig, sceneOf([a, far("agent:early", 3000), far("agent:whileAway", 3000, 400)]));
    wheel(rig, 1);
    expect(edges(rig)).toEqual([]);

    // 回到概览之后再来的才算。
    show(rig, sceneOf([a, far("agent:early", 3000), far("agent:whileAway", 3000, 400), far("agent:later", 3000, 800)]));
    expect(edges(rig)).toEqual(["right:agent:later"]);
  });

  it("节点被删除（布局里不再有它）：提示去掉", () => {
    rig = mountScene(sceneOf([a]));
    wheel(rig, 1);
    show(rig, sceneOf([a, far("agent:far", 3000)]));
    expect(edges(rig)).toHaveLength(1);
    show(rig, sceneOf([a]));
    expect(edges(rig)).toEqual([]);
  });

  it("用户平移 / 缩放让节点进入视口：提示消失，相机之后再移开也不回来", () => {
    rig = mountScene(sceneOf([a]));
    wheel(rig, 1);
    show(rig, sceneOf([a, far("agent:far", 3000)]));
    expect(edges(rig)).toEqual(["right:agent:far"]);

    wheel(rig, 2500); // 把画布往左拖，节点滑进视口
    expect(edges(rig)).toEqual([]);
    vi.advanceTimersByTime(500);
    wheel(rig, -2500);
    vi.advanceTimersByTime(500);
    expect(edges(rig)).toEqual([]);
  });

  it("以相机的落定位置为准、而不是弹簧此刻走到哪里：提示不跟着动画闪", () => {
    rig = mountScene(sceneOf([a]));
    wheel(rig, 1);
    show(rig, sceneOf([a, far("agent:near", 900)]));
    expect(edges(rig)).toEqual(["right:agent:near"]);
    // 缩小两档（-）：终点上节点已经露出来了（落定的缩放 0.69），而第一帧过后画面还几乎没动。
    rig.engine.zoomBy(1 / 1.2);
    rig.engine.zoomBy(1 / 1.2);
    vi.advanceTimersByTime(20);
    expect(Number(/scale\(([\d.]+)\)/.exec(rig.world.style.transform)?.[1])).toBeGreaterThan(0.95);
    expect(edges(rig)).toEqual([]);
  });
});

describe("引擎：点击提示后的平移", () => {
  let rig: SceneRig | undefined;
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
  });
  afterEach(() => {
    rig?.dispose();
    rig = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
    localStorage.clear();
  });

  const arrive = (): SceneRig => {
    const built = mountScene(sceneOf([a]));
    wheel(built, 1);
    show(built, sceneOf([a, far("agent:far", 3000)]));
    return built;
  };

  it("平移相机把节点带进视口，右缘离视口右缘正好是取景留白；缩放不变，提示消失，相机归用户", () => {
    rig = arrive();
    const before = { ...rig.engine.getCamera() };
    expect(rig.engine.arrivals.go("right")).toBe("agent:far");
    const after = rig.engine.getCamera();
    expect(after.k).toBe(before.k);
    expect(after.y).toBe(before.y);
    // 节点 (3000, 100)、宽 212：屏幕上的右缘 = 3000 + 212 + x，要落在 1200 − 56。
    expect(after.x + 3000 + 212).toBe(1200 - 56);
    expect(edges(rig)).toEqual([]);
    expect(rig.engine.isUserMoved()).toBe(true);
  });

  it("画面平滑地走过去（走的是相机自己的弹簧），不是一步跳到；走完后与目标重合", () => {
    rig = arrive();
    const start = rig.world.style.transform;
    rig.engine.arrivals.go("right");
    expect(rig.world.style.transform).toBe(start);
    vi.advanceTimersByTime(50);
    expect(rig.world.style.transform).not.toBe(start);
    vi.advanceTimersByTime(3000);
    const target = rig.engine.getCamera();
    expect(rig.world.style.transform).toBe(`translate3d(${target.x.toFixed(2)}px,${target.y.toFixed(2)}px,0) scale(${target.k.toFixed(4)})`);
  });

  it("减少动态效果：直接到位", () => {
    const media = { matches: true, media: "", onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() };
    vi.spyOn(window, "matchMedia").mockReturnValue(media as unknown as MediaQueryList);
    rig = arrive();
    rig.engine.arrivals.go("right");
    const target = rig.engine.getCamera();
    expect(rig.world.style.transform).toBe(`translate3d(${target.x.toFixed(2)}px,${target.y.toFixed(2)}px,0) scale(${target.k.toFixed(4)})`);
  });

  it("平移期间用户再拖动画布：立即让位，停在手下的位置，弹簧不再往原来的终点拉", () => {
    rig = arrive();
    const start = rig.world.style.transform;
    rig.engine.arrivals.go("right");
    const final = { ...rig.engine.getCamera() };
    vi.advanceTimersByTime(60);
    const midway = rig.world.style.transform;
    expect(midway).not.toBe(start);
    pointer(rig.viewport, "pointerdown", 500, 500, { ctrlKey: true });
    pointer(rig.viewport, "pointermove", 520, 500, { ctrlKey: true });
    const held = rig.world.style.transform;
    pointer(rig.viewport, "pointerup", 520, 500);
    vi.advanceTimersByTime(3000);
    expect(rig.world.style.transform).toBe(held);
    const target = rig.engine.getCamera();
    expect(target.x).not.toBe(final.x);
    expect(held).toBe(`translate3d(${target.x.toFixed(2)}px,${target.y.toFixed(2)}px,0) scale(${target.k.toFixed(4)})`);
  });

  it("平移期间用户滚动画布：动画立即结束，不再继续走", () => {
    rig = arrive();
    rig.engine.arrivals.go("right");
    vi.advanceTimersByTime(60);
    wheel(rig, 5);
    const settled = rig.world.style.transform;
    vi.advanceTimersByTime(3000);
    expect(rig.world.style.transform).toBe(settled);
  });

  it("平移不选中任何节点、不动手动位置", () => {
    rig = arrive();
    rig.engine.arrivals.go("right");
    expect(rig.engine.getState().selected).toBe(0);
    expect(localStorage.getItem("ensemble.canvas.positions.v1")).toBeNull();
  });
});
