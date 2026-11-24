import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { at, edge, mountScene, node, origin, pathNumbers, POSITIONS_KEY, pointer, sceneOf, stored } from "./engine.fixtures";
import type { SceneLayout } from "./layout";

/** 相邻两列左缘的距离：一张卡片宽加上列间距（layout-geometry.ts 里 NODE 的 originGap）。 */
const SHIFT = 212 + 92;

beforeEach(() => localStorage.clear());
afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("canvas git node anchoring", () => {
  const layout = sceneOf(
    [node("git:one", 0, 30, { kind: "git", anchor: { id: "origin:one", dx: -SHIFT, dy: 0 } }), origin("origin:one", SHIFT, 30)],
    [edge("git:one", "origin:one", "link")],
  );

  it("puts a new git node at its layout spot when its origin has not been moved, and stores nothing", () => {
    const { engine, els } = mountScene(layout);
    try {
      expect(at(els.get("git:one")!)).toEqual({ x: 0, y: 30 });
      expect(at(els.get("origin:one")!)).toEqual({ x: SHIFT, y: 30 });
      expect(localStorage.getItem(POSITIONS_KEY)).toBeNull();
    } finally {
      engine.unmount();
    }
  });

  it("puts a new git node next to its origin when the origin was moved earlier, and remembers that spot", () => {
    localStorage.setItem(POSITIONS_KEY, JSON.stringify({ "origin:one": { x: 640, y: 260 } }));
    const first = mountScene(layout);
    try {
      expect(at(first.els.get("origin:one")!)).toEqual({ x: 640, y: 260 });
      expect(at(first.els.get("git:one")!)).toEqual({ x: 640 - SHIFT, y: 260 });
      expect(stored()["git:one"]).toEqual({ x: 640 - SHIFT, y: 260 });
    } finally {
      first.dispose();
    }
    // 下一次访问：位置原样恢复（`git:` 也是会被保存的节点）。
    const second = mountScene(layout);
    try {
      expect(at(second.els.get("git:one")!)).toEqual({ x: 640 - SHIFT, y: 260 });
    } finally {
      second.engine.unmount();
    }
  });

  it("keeps the git node's own saved position over the anchor", () => {
    localStorage.setItem(POSITIONS_KEY, JSON.stringify({ "origin:one": { x: 640, y: 260 }, "git:one": { x: 12, y: 345 } }));
    const { engine, els } = mountScene(layout);
    try {
      expect(at(els.get("git:one")!)).toEqual({ x: 12, y: 345 });
      expect(stored()["git:one"]).toEqual({ x: 12, y: 345 });
    } finally {
      engine.unmount();
    }
  });

  it("does not drag an already placed git node along when the origin is moved later", () => {
    const { engine, els } = mountScene(layout);
    try {
      engine.moveNode("origin:one", 100, 0);
      engine.setLayout(layout);
      expect(at(els.get("origin:one")!).x).toBe(SHIFT + 100);
      expect(at(els.get("git:one")!)).toEqual({ x: 0, y: 30 });
      expect(stored()["git:one"]).toBeUndefined();
    } finally {
      engine.unmount();
    }
  });

  it("draws the link pipe from the git node's right edge to the origin's left edge without flow dots", () => {
    const { engine, els } = mountScene(layout);
    try {
      const tube = document.querySelector("svg g path");
      expect(tube?.getAttribute("data-phase")).toBe("link");
      expect(tube?.getAttribute("d")).toMatch(/^M\s*212(\.\d+)?[ ,]+86/);
      expect(els.size).toBe(2);
    } finally {
      engine.unmount();
    }
  });
});

/** 几个来源共用一张 Git 节点：一个出口、几条各自独立的连线。 */
describe("canvas shared git node", () => {
  const PITCH = 112 + 56;

  /** 来源自上而下叠放，Git 节点落在首尾两个来源的中线之间（与 layoutScene 给出的几何一致）。 */
  function layoutOf(keys: readonly string[]): SceneLayout {
    const middle = ((keys.length - 1) * PITCH) / 2;
    const git = node("git:shared", 0, middle, { kind: "git", anchor: { id: `origin:${keys[0]}`, dx: -SHIFT, dy: middle } });
    const origins = keys.map((key, index) => origin(`origin:${key}`, SHIFT, index * PITCH));
    return sceneOf([git, ...origins], origins.map((source) => edge(git.id, source.id, "link")));
  }

  const pipesOf = (tube: Element): SVGPathElement[] => [...tube.querySelectorAll("path")];
  const start = (path: Element): number[] => pathNumbers(path).slice(0, 2);
  const end = (path: Element): number[] => pathNumbers(path).slice(-2);

  it("draws one static pipe per origin, all leaving the git node's single output port and each ending at its own origin", () => {
    const { engine, tube, els } = mountScene(layoutOf(["a", "b", "c"]));
    try {
      const pipes = pipesOf(tube);
      expect(pipes.map((pipe) => pipe.getAttribute("data-phase"))).toEqual(["link", "link", "link"]);
      // Git 节点在 (0, 168)：出口 (212, 224)；三个来源的入口分别是 (304, 56 | 224 | 392)。
      expect(at(els.get("git:shared")!)).toEqual({ x: 0, y: PITCH });
      expect(pipes.map(start)).toEqual([[212, 224], [212, 224], [212, 224]]);
      expect(pipes.map(end)).toEqual([[304, 56], [304, 224], [304, 392]]);
    } finally {
      engine.unmount();
    }
  });

  it("moving the shared git node (keyboard nudge) moves the start of every pipe and leaves each origin's end where it was", () => {
    const { engine, tube, els } = mountScene(layoutOf(["a", "b"]));
    try {
      expect(pipesOf(tube).map(start)).toEqual([[212, 140], [212, 140]]);
      engine.moveNode("git:shared", 0, 80);
      expect(at(els.get("git:shared")!)).toEqual({ x: 0, y: 84 + 80 });
      expect(pipesOf(tube).map(start)).toEqual([[212, 220], [212, 220]]);
      expect(pipesOf(tube).map(end)).toEqual([[304, 56], [304, 224]]);
      expect(at(els.get("origin:a")!)).toEqual({ x: SHIFT, y: 0 });
    } finally {
      engine.unmount();
    }
  });

  it("dragging the shared git node with the pointer drags every pipe's start along, and remembers the position", () => {
    const { engine, tube, els, viewport } = mountScene(layoutOf(["a", "b"]));
    try {
      const before = at(els.get("git:shared")!);
      pointer(els.get("git:shared")!, "pointerdown", 100, 300);
      pointer(viewport, "pointermove", 180, 360);
      pointer(viewport, "pointerup", 180, 360);
      const moved = at(els.get("git:shared")!);
      expect(moved).not.toEqual(before);
      const pipes = pipesOf(tube);
      expect(pipes.map(start)).toEqual([[moved.x + 212, moved.y + 56], [moved.x + 212, moved.y + 56]]);
      expect(pipes.map(end)).toEqual([[304, 56], [304, 224]]);
      expect(JSON.parse(localStorage.getItem(POSITIONS_KEY) ?? "{}")["git:shared"]).toEqual(moved);
    } finally {
      engine.unmount();
    }
  });

  it("restores the shared git node's saved position on the next visit: every pipe starts from there", () => {
    localStorage.setItem(POSITIONS_KEY, JSON.stringify({ "git:shared": { x: 40, y: 500 } }));
    const { engine, tube, els } = mountScene(layoutOf(["a", "b", "c"]));
    try {
      expect(at(els.get("git:shared")!)).toEqual({ x: 40, y: 500 });
      expect(pipesOf(tube).map(start)).toEqual([[252, 556], [252, 556], [252, 556]]);
      expect(pipesOf(tube).map(end)).toEqual([[304, 56], [304, 224], [304, 392]]);
    } finally {
      engine.unmount();
    }
  });

  it("keeps the git node and the other pipes when an origin leaves, and grows a new pipe for an origin that joins", () => {
    const { engine, tube, els, attach } = mountScene(layoutOf(["a", "b", "c"]));
    try {
      const [toA, , toC] = pipesOf(tube);
      const git = els.get("git:shared")!;

      engine.setLayout(layoutOf(["a", "c"]));
      // 离开的来源只拿走它自己的那条线；留下的线是原来的元素，没有被拆掉重建。
      const left = pipesOf(tube);
      expect(left).toHaveLength(2);
      expect(left[0]).toBe(toA);
      expect(left[1]).toBe(toC);
      expect(els.get("git:shared")).toBe(git);

      const joined = attach("origin:d");
      engine.setLayout(layoutOf(["a", "c", "d"]));
      expect(pipesOf(tube)).toHaveLength(3);
      expect(pipesOf(tube).every((pipe) => pipe.getAttribute("data-phase") === "link")).toBe(true);
      // 新来源从 Git 节点“长”出来；Git 节点本身不是新节点，没有入场动画。
      expect(joined.dataset["fresh"]).toBe("");
      expect(git.dataset["fresh"]).toBeUndefined();
      // 每条线仍然从同一个出口出发。
      const starts = new Set(pipesOf(tube).map((pipe) => start(pipe).join(",")));
      expect(starts.size).toBe(1);
    } finally {
      engine.unmount();
    }
  });

  it("fit frames the shared git node together with the origins, wherever it was dragged", () => {
    const { engine } = mountScene(layoutOf(["a", "b", "c"]));
    try {
      engine.fit(false);
      // 整组 516 × 448，放得进 1200 × 800 的取景区域，不缩小。
      expect(engine.getCamera().k).toBe(1);
      engine.moveNode("git:shared", -3000, 0);
      expect(engine.isUserMoved()).toBe(true);
      engine.fit(false);
      expect(engine.isUserMoved()).toBe(false);
      expect(engine.getCamera().k).toBeLessThan(0.5);
    } finally {
      engine.unmount();
    }
  });
});
