import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Camera } from "./engine";
import { wheel, worldCamera } from "./engine-characterize.fixtures";
import { boundsOf, fitCamera, fitPadding } from "./layout";
import { mountPair, mountScene, node, pairLayout, pointer, sceneOf, selectBoth } from "./engine.fixtures";

/**
 * 特征化测试：相机取景（`fit` 与布局变化时的自动取景）、窗口尺寸变化、`isUserMoved` 的归属、上报。
 * 拆分引擎之前在旧实现上跑绿，拆分之后必须仍然全绿；参考值直接用 `layout.ts` 里的 `fitCamera`，只验证引擎怎么用它。
 */

const VIEW = { w: 1200, h: 800 };

/** 一排 18 张卡片：整排比取景区域宽得多，“放不下”的三种取景方式会得到三个不同的缩放。 */
const row = (count: number) => Array.from({ length: count }, (_, i) => node(`row:${i}`, i * 300, 14));

describe("canvas camera", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
    localStorage.clear();
  });

  const settle = (): void => {
    vi.advanceTimersByTime(3000);
  };

  it("fits the layout bounds into the viewport minus the padding, snapping to it on the first layout", () => {
    const layout = sceneOf(row(18));
    const rig = mountScene(layout);
    try {
      const expected = fitCamera(boundsOf(layout.nodes), VIEW, fitPadding(VIEW.w), false, undefined);
      expect(expected.k).toBe(0.3);
      expect(rig.engine.getCamera()).toEqual(expected);
      expect(worldCamera(rig.world).k).toBe(0.3);
      expect(rig.engine.isUserMoved()).toBe(false);
    } finally {
      rig.engine.unmount();
    }
  });

  it("fits everything in view when the layout asks for it (fitAll, grid) or when fit() is told to", () => {
    const wide = fitCamera(boundsOf(row(18)), VIEW, fitPadding(VIEW.w), true, undefined);
    expect(wide.k).toBeCloseTo(1088 / 5312, 12);
    for (const flags of [{ fitAll: true }, { grid: true }]) {
      const rig = mountScene({ ...sceneOf(row(18)), ...flags });
      try {
        expect(rig.engine.getCamera()).toEqual(wide);
      } finally {
        rig.engine.unmount();
      }
    }
    const rig = mountScene(sceneOf(row(18)));
    try {
      rig.engine.fit(false, true);
      expect(rig.engine.getCamera()).toEqual(wide);
      expect(worldCamera(rig.world).k).toBeCloseTo(wide.k, 4);
      rig.engine.fit(false);
      expect(rig.engine.getCamera().k).toBe(0.3);
    } finally {
      rig.engine.unmount();
    }
  });

  it("uses the padding handed to mount() instead of the default one", () => {
    const rig = mountScene(sceneOf(row(18)));
    try {
      const padding = { top: 10, right: 20, bottom: 30, left: 40 };
      rig.engine.mount({ viewport: rig.viewport, world: rig.world, pipes: { tube: rig.tube, dots: rig.dots }, padding });
      expect(rig.engine.getCamera()).toEqual(fitCamera(boundsOf(row(18)), VIEW, padding, false, undefined));
    } finally {
      rig.engine.unmount();
    }
  });

  it("holds the zoom the user saw after a reset, and fit() releases that hold", () => {
    const rig = mountScene(sceneOf(row(18)));
    try {
      const bounds = boundsOf(row(18));
      expect(rig.engine.getCamera().k).toBe(0.3);
      rig.engine.resetLayout();
      expect(rig.engine.getFill("all")).toBe(0.3);
      expect(rig.engine.getCamera()).toEqual(fitCamera(bounds, VIEW, fitPadding(VIEW.w), false, 0.3));
      expect(rig.engine.getCamera().k).toBeCloseTo(1088 / 5312, 12);
      expect(rig.engine.isUserMoved()).toBe(false);
      rig.engine.fit(false);
      expect(rig.engine.getCamera()).toEqual(fitCamera(bounds, VIEW, fitPadding(VIEW.w), false, undefined));
    } finally {
      rig.engine.unmount();
    }
  });

  it("refits animated when a later layout changes the bounds, and leaves a user-moved camera alone", () => {
    const rig = mountScene(sceneOf(row(2)));
    try {
      expect(rig.engine.getCamera().k).toBe(1);
      const bigger = sceneOf(row(18));
      rig.engine.setLayout(bigger);
      const expected = fitCamera(boundsOf(bigger.nodes), VIEW, fitPadding(VIEW.w), false, undefined);
      expect(rig.engine.getCamera()).toEqual(expected);
      expect(worldCamera(rig.world).k).toBe(1);
      settle();
      expect(worldCamera(rig.world).k).toBeCloseTo(0.3, 4);
      wheel(rig.viewport, { deltaX: 10 });
      const kept = { ...rig.engine.getCamera() };
      rig.engine.setLayout(sceneOf(row(3)));
      expect(rig.engine.getCamera()).toEqual(kept);
      rig.engine.fit(false);
      expect(rig.engine.getCamera()).toEqual(fitCamera(boundsOf(row(3)), VIEW, fitPadding(VIEW.w), false, undefined));
    } finally {
      rig.engine.unmount();
    }
  });

  it("keeps the camera across an unmount and puts it back on the world layer when mounted again", () => {
    const rig = mountPair();
    rig.engine.zoomBy(1.2);
    settle();
    expect(worldCamera(rig.world)).toEqual({ x: 265.2, y: 334, k: 1.2 });
    const before = { ...rig.engine.getCamera() };
    rig.engine.unmount();
    expect(rig.world.style.transform).toBe("");
    expect(rig.engine.getCamera()).toEqual(before);
    rig.engine.mount({ viewport: rig.viewport, world: rig.world, pipes: { tube: rig.tube, dots: rig.dots } });
    expect(worldCamera(rig.world)).toEqual({ x: 265.2, y: 334, k: 1.2 });
    expect(rig.engine.isUserMoved()).toBe(true);
    rig.engine.unmount();
  });

  describe("resizing the viewport", () => {
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

    it("refits animated when the camera is automatic", () => {
      const rig = mountObserved();
      try {
        resizeTo(rig.viewport, 600, 400);
        const expected = fitCamera(boundsOf(pairLayout.nodes), { w: 600, h: 400 }, fitPadding(600), false, undefined);
        expect(rig.engine.getCamera()).toEqual(expected);
        expect(worldCamera(rig.world)).toEqual({ x: 321, y: 345, k: 1 });
        settle();
        expect(worldCamera(rig.world).k).toBeCloseTo(expected.k, 4);
      } finally {
        rig.engine.unmount();
      }
    });

    it("keeps the world point at the viewport center when the user has moved the camera", () => {
      const rig = mountObserved();
      try {
        wheel(rig.viewport, { deltaX: 10, deltaY: 20 });
        resizeTo(rig.viewport, 600, 400);
        expect(rig.engine.getCamera()).toEqual({ x: 311 - 300, y: 325 - 200, k: 1 });
        expect(worldCamera(rig.world)).toEqual({ x: 11, y: 125, k: 1 });
        resizeTo(rig.viewport, 600, 400);
        expect(rig.engine.getCamera()).toEqual({ x: 11, y: 125, k: 1 });
      } finally {
        rig.engine.unmount();
      }
    });

    it("does not shift the camera when the viewport was hidden, and a hide-and-show counts as hidden before", () => {
      const rig = mountObserved();
      try {
        wheel(rig.viewport, { deltaX: 10, deltaY: 20 });
        resizeTo(rig.viewport, 0, 0);
        expect(rig.engine.getCamera()).toEqual({ x: 311, y: 325, k: 1 });
        resizeTo(rig.viewport, 1200, 800);
        expect(rig.engine.getCamera()).toEqual({ x: 311, y: 325, k: 1 });
        resizeTo(rig.viewport, 1000, 800);
        expect(rig.engine.getCamera()).toEqual({ x: 211, y: 325, k: 1 });
      } finally {
        rig.engine.unmount();
      }
    });

    it("ignores resizes while no layout has been given for the current space", () => {
      const rig = mountObserved();
      try {
        rig.engine.switchSpace("elsewhere");
        resizeTo(rig.viewport, 600, 400);
        expect(rig.engine.getCamera()).toEqual({ x: 0, y: 0, k: 1 });
        expect(worldCamera(rig.world)).toEqual({ x: 0, y: 0, k: 1 });
      } finally {
        rig.engine.unmount();
      }
    });
  });

  describe("who owns the camera", () => {
    const actions: [string, (rig: ReturnType<typeof mountPair>) => void][] = [
      ["wheel pan", ({ viewport }) => void wheel(viewport, { deltaY: 10 })],
      ["wheel zoom", ({ viewport }) => void wheel(viewport, { ctrlKey: true, deltaY: -10 })],
      ["zoomBy", ({ engine }) => engine.zoomBy(1.1)],
      ["pan drag", ({ viewport }) => {
        pointer(viewport, "pointerdown", 100, 100, { ctrlKey: true });
        pointer(viewport, "pointermove", 160, 130, { ctrlKey: true });
        pointer(viewport, "pointerup", 160, 130, { ctrlKey: true });
      }],
      ["node drag", ({ viewport, agent }) => {
        pointer(agent, "pointerdown", 400, 300);
        pointer(viewport, "pointermove", 450, 300);
        pointer(viewport, "pointerup", 450, 300);
      }],
      ["nudge", ({ engine }) => engine.moveNode("agent:one", 10, 0)],
      ["align", ({ engine }) => {
        selectBoth(engine);
        engine.align("left");
      }],
      ["undo", ({ engine }) => {
        engine.moveNode("agent:one", 10, 0);
        engine.fit(false);
        engine.undo();
      }],
    ];

    it.each(actions)("%s hands the camera to the user", (_name, act) => {
      const rig = mountPair();
      try {
        expect(rig.engine.isUserMoved()).toBe(false);
        act(rig);
        expect(rig.engine.isUserMoved()).toBe(true);
      } finally {
        rig.engine.unmount();
      }
    });

    it("keeps a plain click, a right button press and a drag that never started out of it, and fit() and reset give it back", () => {
      const rig = mountPair();
      try {
        pointer(rig.agent, "pointerdown", 400, 300);
        pointer(rig.viewport, "pointermove", 402, 301);
        pointer(rig.viewport, "pointerup", 402, 301);
        pointer(rig.viewport, "pointerdown", 100, 100, { button: 2, ctrlKey: true });
        pointer(rig.viewport, "pointerup", 100, 100, { button: 2 });
        expect(rig.engine.isUserMoved()).toBe(false);
        rig.engine.zoomBy(1.1);
        expect(rig.engine.isUserMoved()).toBe(true);
        rig.engine.fit();
        expect(rig.engine.isUserMoved()).toBe(false);
        rig.engine.moveNode("agent:one", 10, 0);
        rig.engine.resetLayout();
        expect(rig.engine.isUserMoved()).toBe(false);
      } finally {
        rig.engine.unmount();
      }
    });
  });

  it("hands the camera to the user when a hint is followed to a node out of view, so later layouts leave it alone", () => {
    const rig = mountPair();
    try {
      rig.attach("agent:far");
      rig.engine.setLayout(sceneOf([...pairLayout.nodes, node("agent:far", 5000, 14)], pairLayout.edges));
      const hints = (): string[] => rig.engine.arrivals.getHints().map((hint) => `${hint.edge}:${hint.ids.join(",")}`);
      expect(hints()).toEqual(["right:agent:far"]);
      expect(rig.engine.isUserMoved()).toBe(false);
      expect(rig.engine.arrivals.go("right")).toBe("agent:far");
      expect(rig.engine.isUserMoved()).toBe(true);
      expect(hints()).toEqual([]);
      const camera = { ...rig.engine.getCamera() };
      rig.attach("agent:more");
      rig.engine.setLayout(sceneOf([...pairLayout.nodes, node("agent:far", 5000, 14), node("agent:more", 5400, 14)], pairLayout.edges));
      expect(rig.engine.getCamera()).toEqual(camera);
    } finally {
      rig.engine.unmount();
    }
  });

  it("reports the camera to the host when the zoom or the user-moved flag changes, and only then", () => {
    const rig = mountPair();
    // 宿主收到的是活的相机对象：每次回调当场记下缩放，不能事后再读。
    const seen: [number, boolean][] = [];
    const onCamera = vi.fn((camera: Readonly<Camera>, moved: boolean) => {
      seen.push([Number(camera.k.toFixed(4)), moved]);
    });
    rig.engine.mount({ viewport: rig.viewport, world: rig.world, pipes: { tube: rig.tube, dots: rig.dots }, onCamera });
    try {
      const reported = (): [number, boolean][] => [...seen];
      rig.engine.fit(false);
      expect(reported()).toEqual([]);
      rig.engine.zoomBy(1.2);
      expect(reported()).toEqual([[1.2, true]]);
      rig.engine.zoomBy(1.001);
      expect(reported()).toEqual([[1.2, true]]);
      rig.engine.fit(false);
      expect(reported()).toEqual([[1.2, true], [1, false]]);
      rig.engine.setLayout(sceneOf(row(18)));
      expect(reported().at(-1)).toEqual([0.3, false]);
      // 上报给宿主的是引擎里那个活的相机对象，不是拷贝。
      expect(onCamera.mock.calls[0]![0]).toBe(rig.engine.getCamera());
    } finally {
      rig.engine.unmount();
    }
  });

  // 回归：点一张卡进聚焦页、再用浏览器后退，画布（Overview）卸载又重新挂载，引擎和相机原样留着，宿主却是新的——
  // 它的缩放读数从 100%、自动取景起步，不记得上一个宿主听到过什么。这里的用例不是拆分之前的特征（旧实现就有这个缺陷），是修复之后加的。
  // 修复有两半：卸载时缓存回到新宿主的起点（`detach()`，下面前两条守它），挂载时先上报一次（`mount()`，第三条守它，用户动过的相机只有这一条路通知新宿主）。
  describe("a host that mounts again (back from the focus page)", () => {
    /** 在引擎上再挂一个宿主，等于 Overview 重新挂载一次；宿主收到的是活的相机对象，每次回调当场记下缩放。 */
    const mountHost = (rig: ReturnType<typeof mountScene>): [number, boolean][] => {
      const seen: [number, boolean][] = [];
      rig.engine.mount({
        viewport: rig.viewport,
        world: rig.world,
        pipes: { tube: rig.tube, dots: rig.dots },
        onCamera: (camera, moved) => {
          seen.push([Number(camera.k.toFixed(4)), moved]);
        },
      });
      return seen;
    };

    it("is told where the automatic camera stands even though the last host had heard that very zoom", () => {
      const rig = mountScene(sceneOf(row(2)));
      try {
        const first = mountHost(rig);
        // 相机在 100%、自动取景：新宿主的读数本来就是这样，不重发。
        expect(first).toEqual([]);
        rig.engine.setLayout(sceneOf(row(18)));
        expect(first).toEqual([[0.3, false]]);
        // 点一张卡进聚焦页：画布卸载，相机停在 30% 留在引擎里。
        rig.engine.unmount();
        expect(rig.engine.getCamera().k).toBe(0.3);
        // 后退：新宿主挂上来，读数是 100%。它必须被通知，不能被“缩放没变”吞掉：挂载时的上报与回放布局的上报都先过缓存，缓存没回到起点就两路都被挡住。
        const second = mountHost(rig);
        expect(second).toEqual([[0.3, false]]);
        // 通知过之后照旧只在变化时才发。
        rig.engine.fit(false);
        expect(second).toEqual([[0.3, false]]);
      } finally {
        rig.engine.unmount();
      }
    });

    it("is told the camera of the space it is switched to, even though the last host had heard that very camera", () => {
      const rig = mountPair();
      try {
        const first = mountHost(rig);
        rig.engine.zoomBy(1.2);
        // “all” 的视角（120%、用户动过）被记下；b 里也放大到 120%，第一个宿主最后听到的就是它。
        rig.engine.switchSpace("b");
        rig.engine.zoomBy(1.2);
        expect(first.at(-1)).toEqual([1.2, true]);
        rig.engine.unmount();
        const second = mountHost(rig);
        // 换回 “all”：取回的相机与第一个宿主最后听到的一样；新宿主的读数要对，缓存得先回到它的起点（没有 `detach()` 的重置，挂载与换空间两路都被挡住，这里是空的）。
        rig.engine.switchSpace("all");
        expect(second.at(-1)).toEqual([1.2, true]);
      } finally {
        rig.engine.unmount();
      }
    });

    it("is told the camera the user moved too, when it mounts again in the same space", () => {
      const rig = mountPair();
      try {
        mountHost(rig);
        rig.engine.zoomBy(1.2);
        // 点一张卡进聚焦页：相机停在用户放大后的 120%（用户动过）。
        rig.engine.unmount();
        // 后退：同一个空间。用户动过的相机重新挂载时既不取景（回放布局不会上报）也不换空间，新宿主挂上来就得听到它，读数与“适应”的状态才对；只听一次。
        expect(mountHost(rig)).toEqual([[1.2, true]]);
      } finally {
        rig.engine.unmount();
      }
    });
  });
});
