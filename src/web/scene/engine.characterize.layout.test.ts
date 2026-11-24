import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boundsOf, fitCamera, fitPadding, type LayoutNode, type SceneLayout } from "./layout";
import { at, edge, mountPair, mountScene, node, origin, pairLayout, sceneOf, stored } from "./engine.fixtures";

/**
 * 特征化测试：一份布局进来之后引擎对每个节点做了什么——放在哪、从哪“长”出来、谁算新来的、哪些节点的记录被留下或丢掉、取景看的是什么。
 * 拆分引擎之前在旧实现上跑绿，拆分之后必须仍然全绿。
 */
describe("applying a layout", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    localStorage.clear();
  });

  const settle = (): void => {
    vi.advanceTimersByTime(3000);
  };
  const seed = (positions: Record<string, { x: number; y: number }>): void => {
    localStorage.setItem("ensemble.canvas.positions.v1", JSON.stringify(positions));
  };
  const withHidden = (layout: SceneLayout, ids: string[]): SceneLayout => ({ ...layout, hidden: new Set(ids) });
  const AGENT = { w: 248, h: 144 };

  describe("new nodes grow out of their upstream", () => {
    const grown = (edges: ReturnType<typeof edge>[]): { rig: ReturnType<typeof mountPair>; el: HTMLElement } => {
      const rig = mountPair();
      rig.attach("agent:two");
      const el = rig.attach("agent:three");
      rig.engine.setLayout(sceneOf([origin("origin:one", 0, 30), node("agent:one", 310, 14, AGENT), node("agent:two", 700, 14), node("agent:three", 1000, 14)], edges));
      return { rig, el };
    };

    it("starts at the first upstream edge's node and marks the element as fresh", () => {
      const { rig, el } = grown([edge("origin:one", "agent:one"), edge("agent:one", "agent:three"), edge("agent:two", "agent:three")]);
      try {
        expect(at(el)).toEqual({ x: 409.2, y: 30 });
        expect(el.dataset["fresh"]).toBe("");
        settle();
        expect(at(el)).toEqual({ x: 1000, y: 14 });
        expect(el.dataset["fresh"]).toBe("");
      } finally {
        rig.engine.unmount();
      }
    });

    it("takes the first edge that points at it, whatever order the others come in", () => {
      const { rig, el } = grown([edge("origin:one", "agent:one"), edge("agent:two", "agent:three"), edge("agent:one", "agent:three")]);
      try {
        expect(at(el)).toEqual({ x: 784.8, y: 14 });
        expect(el.dataset["fresh"]).toBe("");
      } finally {
        rig.engine.unmount();
      }
    });

    it("does not grow when the first upstream is not on the canvas, even if a later one is", () => {
      const { rig, el } = grown([edge("origin:one", "agent:one"), edge("agent:ghost", "agent:three"), edge("agent:one", "agent:three")]);
      try {
        expect(at(el)).toEqual({ x: 1000, y: 14 });
        expect(el.dataset["fresh"]).toBeUndefined();
      } finally {
        rig.engine.unmount();
      }
    });

    it("does not grow the very first layout, nodes that have a saved position, or nodes whose element comes later", () => {
      seed({ "agent:three": { x: 1200, y: 300 } });
      const rig = mountPair();
      rig.attach("agent:two");
      const saved = rig.attach("agent:three");
      try {
        rig.engine.setLayout(sceneOf([origin("origin:one", 0, 30), node("agent:one", 310, 14, AGENT), node("agent:two", 700, 14), node("agent:three", 1000, 14)], [edge("agent:one", "agent:two"), edge("agent:one", "agent:three")]));
        expect(at(saved)).toEqual({ x: 1200, y: 300 });
        expect(saved.dataset["fresh"]).toBeUndefined();
        expect(at(rig.els.get("agent:two")!)).toEqual({ x: 409.2, y: 30 });
        // 元素晚于布局才登记：登记时按已经算好的位置写下来，不再“长”。
        const late = document.createElement("div");
        rig.engine.setLayout(sceneOf([origin("origin:one", 0, 30), node("agent:one", 310, 14, AGENT), node("agent:two", 700, 14), node("agent:three", 1000, 14), node("agent:four", 1300, 14)], [edge("agent:one", "agent:four")]));
        rig.engine.register("agent:four", late);
        expect(at(late)).toEqual({ x: 409.2, y: 30 });
        expect(late.dataset["fresh"]).toBeUndefined();
      } finally {
        rig.engine.unmount();
      }
    });
  });

  describe("who counts as new", () => {
    const L1 = (hidden: string[]): SceneLayout => withHidden(sceneOf([origin("origin:one", 0, 30), node("agent:one", 310, 14, AGENT)], [edge("origin:one", "agent:one")]), hidden);
    const L2 = sceneOf(
      [origin("origin:one", 0, 30), node("agent:one", 310, 14, AGENT), node("agent:two", 310, 180, { anchor: { id: "origin:one", dx: 310, dy: 150 } })],
      [edge("origin:one", "agent:one"), edge("origin:one", "agent:two")],
    );

    it("puts a new node beside its anchor once the user has moved the anchor", () => {
      seed({ "origin:one": { x: 500, y: 400 } });
      const rig = mountScene(L1([]));
      const el = rig.attach("agent:two");
      try {
        rig.engine.setLayout(L2);
        // 记下来的落点也从上游“长”出来：此刻在来源卡旁边，弹簧再把它送到记下的位置。
        expect(at(el)).toEqual({ x: 584.8, y: 400 });
        expect(stored()["agent:two"]).toEqual({ x: 810, y: 550 });
        settle();
        expect(at(el)).toEqual({ x: 810, y: 550 });
      } finally {
        rig.engine.unmount();
      }
    });

    it("does not treat a node the view filter had hidden as new when it comes back", () => {
      seed({ "origin:one": { x: 500, y: 400 } });
      const rig = mountScene(L1(["agent:two"]));
      const el = rig.attach("agent:two");
      try {
        rig.engine.setLayout(L2);
        expect(stored()["agent:two"]).toBeUndefined();
        settle();
        expect(at(el)).toEqual({ x: 310, y: 180 });
      } finally {
        rig.engine.unmount();
      }
    });

    it("treats the first layout of a fresh space as the status quo, even with manual positions around", () => {
      seed({ "origin:one": { x: 500, y: 400 } });
      const rig = mountScene(L2);
      try {
        expect(at(rig.els.get("agent:two")!)).toEqual({ x: 310, y: 180 });
        expect(stored()).toEqual({ "origin:one": { x: 500, y: 400 } });
      } finally {
        rig.engine.unmount();
      }
    });

    it("puts a new git or folder node beside an anchor the user moved, and remembers it", () => {
      seed({ "origin:one": { x: 500, y: 400 } });
      const rig = mountScene(sceneOf([origin("origin:one", 0, 30), node("agent:one", 310, 14, AGENT)], [edge("origin:one", "agent:one")]));
      const git = rig.attach("git:one");
      const free = rig.attach("folder:free");
      try {
        const next: LayoutNode[] = [
          origin("origin:one", 0, 30),
          node("agent:one", 310, 14, AGENT),
          node("git:one", 300, 0, { kind: "git", anchor: { id: "origin:one", dx: 120, dy: -40 } }),
          node("folder:free", 700, 600, { kind: "folder", anchor: { id: "agent:one", dx: 10, dy: 10 } }),
        ];
        rig.engine.setLayout(sceneOf(next, [edge("origin:one", "agent:one")]));
        expect(at(git)).toEqual({ x: 620, y: 360 });
        expect(git.dataset["fresh"]).toBeUndefined();
        expect(at(free)).toEqual({ x: 700, y: 600 });
        expect(stored()["git:one"]).toEqual({ x: 620, y: 360 });
        expect(stored()["folder:free"]).toBeUndefined();
      } finally {
        rig.engine.unmount();
      }
    });
  });

  describe("which records survive", () => {
    it("keeps the record of a node that left the layout while its element is registered, and drops the others", () => {
      const rig = mountPair();
      try {
        rig.engine.setLayout(sceneOf([origin("origin:one", 0, 30), node("agent:bare", 700, 14)]));
        rig.engine.toggleSelection("agent:bare");
        expect(rig.engine.getSelectedIds()).toEqual(["agent:bare"]);
        rig.engine.setLayout(sceneOf([origin("origin:one", 0, 30)]));
        // 没有元素的 agent:bare 随布局一起走了；有元素的 agent:one 的记录还在，仍然是“已放下”的节点。
        expect(rig.engine.getSelectedIds()).toEqual([]);
        rig.engine.toggleSelection("agent:bare");
        expect(rig.engine.getSelectedIds()).toEqual([]);
        rig.engine.toggleSelection("agent:one");
        expect(rig.engine.getSelectedIds()).toEqual(["agent:one"]);
        rig.engine.selectAll();
        expect(rig.engine.getSelectedIds()).toEqual(["origin:one", "agent:one"]);
        // 再把它请回布局：它还是已放下的，不当新来的（不从上游“长”；位置沿用隐藏之前的排布，见 hold-restore.ts）。
        rig.engine.setLayout(sceneOf([origin("origin:one", 0, 30), node("agent:one", 500, 14, AGENT)], [edge("origin:one", "agent:one")]));
        settle();
        expect(at(rig.agent)).toEqual({ x: 310, y: 14 });
        expect(rig.agent.dataset["fresh"]).toBeUndefined();
        // 元素注销之后下一份布局才把它清掉。
        rig.releases.get("agent:one")!();
        rig.engine.setLayout(sceneOf([origin("origin:one", 0, 30)]));
        rig.engine.toggleSelection("agent:one");
        expect(rig.engine.getSelectedIds()).toEqual(["origin:one"]);
      } finally {
        rig.engine.unmount();
      }
    });

    it("sizes every body from the layout, so alignment sees the new size", () => {
      const rig = mountPair();
      try {
        rig.engine.setLayout(sceneOf([origin("origin:one", 0, 30), node("agent:one", 310, 14, { w: 300, h: 60 })], [edge("origin:one", "agent:one")]));
        rig.engine.toggleSelection("origin:one");
        rig.engine.toggleSelection("agent:one");
        expect(rig.engine.align("bottom")).toBe(true);
        // 新的高度（60）进了计算：两张卡的下沿对齐在来源卡的下沿（30 + 112）。
        expect(stored()).toEqual({ "origin:one": { x: 0, y: 30 }, "agent:one": { x: 310, y: 82 } });
      } finally {
        rig.engine.unmount();
      }
    });
  });

  describe("what the camera frames", () => {
    const VIEW = { w: 1200, h: 800 };

    it("frames the positions the nodes are heading for, not the ones the layout asked for", () => {
      seed({ "agent:one": { x: 1000, y: 14 } });
      const rig = mountPair();
      try {
        const expected = fitCamera(boundsOf([origin("origin:one", 0, 30), node("agent:one", 1000, 14, AGENT)]), VIEW, fitPadding(1200), false, undefined);
        expect(rig.engine.getCamera()).toEqual(expected);
      } finally {
        rig.engine.unmount();
      }
    });

    it("keeps framing the targets after a nudge, once the camera is handed back", () => {
      const rig = mountPair();
      try {
        rig.engine.moveNode("agent:one", 600, 0);
        rig.engine.fit(false);
        const expected = fitCamera(boundsOf([origin("origin:one", 0, 30), node("agent:one", 910, 14, AGENT)]), VIEW, fitPadding(1200), false, undefined);
        expect(rig.engine.getCamera()).toEqual(expected);
        expect(expected).not.toEqual(fitCamera(pairLayout.bounds, VIEW, fitPadding(1200), false, undefined));
      } finally {
        rig.engine.unmount();
      }
    });
  });
});
