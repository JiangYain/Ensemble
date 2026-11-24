import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { edge, mountPair, mountScene, node, origin, pairLayout, POSITIONS_KEY, sceneOf, stored } from "./engine.fixtures";
import { FIT_ALL_MIN_ZOOM } from "./layout";

/**
 * “重置节点布局”的相机与缩放：缩放是第一约束——排得进画面就保持用户当时的缩放、只平移；放不下才缩小，缩到刚好放下为止。
 * 布局怎么规划（缩放上限 `zoom`）见 layout.fill.test.ts；这里只看引擎：相机取景、保持缩放的寿命、按空间记忆、撤销。
 * 夹具的视口是 1200 × 800，扣掉 fitPadding（上 126、下 64、左右各 56）后取景区域是 1088 × 610。
 */
const ROOM = { w: 1088, h: 610, left: 56, top: 126 };
const ZOOM_OUT = 1 / 1.2;

/** 比 `pairLayout` 多一个会话：外框还是放得进取景区域，用来模拟“新会话到达”。 */
const biggerPair = sceneOf(
  [...pairLayout.nodes, node("agent:two", 310, 200, { w: 248, h: 144 })],
  [...pairLayout.edges, edge("origin:one", "agent:two")],
);

describe("canvas reset layout · 缩放是第一约束", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
  });

  it("内容放得下时保持用户当前的缩放，只把内容居中", () => {
    const { engine } = mountPair();
    try {
      engine.zoomBy(ZOOM_OUT);
      engine.moveNode("agent:one", 200, 150);
      const zoom = engine.getCamera().k;
      expect(zoom).toBeCloseTo(ZOOM_OUT, 6);

      engine.resetLayout();
      const camera = engine.getCamera();
      expect(camera.k).toBeCloseTo(zoom, 6);
      // 重置之后是自动取景，而不是用户视角。
      expect(engine.isUserMoved()).toBe(false);
      // 外框 0..558 × 14..158 的中心落在取景区域的正中。
      expect(camera.x + 279 * camera.k).toBeCloseTo(ROOM.left + ROOM.w / 2, 3);
      expect(camera.y + 86 * camera.k).toBeCloseTo(ROOM.top + ROOM.h / 2, 3);
    } finally {
      engine.unmount();
    }
  });

  it("放得下也不放大：缩放比 100% 大时同样保持", () => {
    const { engine } = mountPair();
    try {
      engine.zoomBy(1.2);
      const zoom = engine.getCamera().k;
      expect(zoom).toBeCloseTo(1.2, 6);
      engine.resetLayout();
      expect(engine.getCamera().k).toBeCloseTo(zoom, 6);
    } finally {
      engine.unmount();
    }
  });

  it("放不下才缩小，缩到刚好放下为止", () => {
    // 外框 3000 × 112：取景区域 1088 宽，100% 放不下，刚好放下是 1088 / 3000。
    const wide = sceneOf([origin("origin:a", 0, 0), node("agent:a", 2788, 0)], [edge("origin:a", "agent:a")]);
    const { engine } = mountScene(wide);
    try {
      engine.zoomBy(1.2);
      engine.resetLayout();
      expect(engine.getCamera().k).toBeCloseTo(ROOM.w / 3000, 6);
      expect(engine.isUserMoved()).toBe(false);
    } finally {
      engine.unmount();
    }
  });

  it("再宽也只缩到 FIT_ALL_MIN_ZOOM（全部入画优先于可读，但有下限），不再往下缩", () => {
    const huge = sceneOf([origin("origin:a", 0, 0), node("agent:a", 9788, 0)], [edge("origin:a", "agent:a")]);
    const { engine } = mountScene(huge);
    try {
      engine.resetLayout();
      expect(engine.getCamera().k).toBe(FIT_ALL_MIN_ZOOM);
    } finally {
      engine.unmount();
    }
  });

  it("重置之后相机仍是自动取景：之后的重新布局沿用保持的缩放，不跳回 100%", () => {
    const rig = mountPair();
    try {
      rig.engine.zoomBy(ZOOM_OUT);
      rig.engine.moveNode("agent:one", 40, 0);
      rig.engine.resetLayout();
      const zoom = rig.engine.getCamera().k;
      expect(zoom).toBeCloseTo(ZOOM_OUT, 6);

      rig.attach("agent:two");
      rig.engine.setLayout(biggerPair);
      expect(rig.engine.getCamera().k).toBeCloseTo(zoom, 6);
      expect(rig.engine.isUserMoved()).toBe(false);

      // 内容变少、放得下 100% 也不放大：保持住的缩放不因重新布局而变。
      rig.engine.setLayout(pairLayout);
      expect(rig.engine.getCamera().k).toBeCloseTo(zoom, 6);
    } finally {
      rig.engine.unmount();
    }
  });

  it("重置之后的重新布局放不下时照样缩到刚好放下，不超出画面", () => {
    const rig = mountPair();
    try {
      rig.engine.zoomBy(ZOOM_OUT);
      rig.engine.resetLayout();
      const far = sceneOf([...pairLayout.nodes, node("agent:far", 2800, 14)], [...pairLayout.edges, edge("origin:one", "agent:far")]);
      rig.attach("agent:far");
      rig.engine.setLayout(far);
      // 外框 0..3012：刚好放下是 1088 / 3012。
      expect(rig.engine.getCamera().k).toBeCloseTo(ROOM.w / 3012, 6);
    } finally {
      rig.engine.unmount();
    }
  });

  it("“适应”释放保持的缩放，回到按内容取景；排布缩放不动，节点不会因为点“适应”重新排", () => {
    const rig = mountPair();
    try {
      rig.engine.zoomBy(ZOOM_OUT);
      rig.engine.resetLayout();
      const zoom = rig.engine.getCamera().k;
      expect(rig.engine.getFill("all")).toBeCloseTo(zoom, 6);

      rig.engine.fit(false);
      expect(rig.engine.getCamera().k).toBe(1);
      expect(rig.engine.getFill("all")).toBeCloseTo(zoom, 6);

      // 上限已经释放：之后的重新布局按内容取景（放得下就是 100%）。
      rig.attach("agent:two");
      rig.engine.setLayout(biggerPair);
      expect(rig.engine.getCamera().k).toBe(1);
    } finally {
      rig.engine.unmount();
    }
  });

  it("重置之后用户一动相机，相机就归用户：之后的布局不再取景", () => {
    const rig = mountPair();
    try {
      rig.engine.zoomBy(ZOOM_OUT);
      rig.engine.resetLayout();
      rig.engine.zoomBy(1.2);
      expect(rig.engine.isUserMoved()).toBe(true);
      const before = { ...rig.engine.getCamera() };
      rig.attach("agent:two");
      rig.engine.setLayout(biggerPair);
      expect(rig.engine.getCamera()).toEqual(before);
    } finally {
      rig.engine.unmount();
    }
  });

  it("撤销只找回节点位置，相机原地不动", () => {
    const { engine } = mountPair();
    try {
      engine.moveNode("agent:one", 200, 150);
      expect(stored()["agent:one"]).toEqual({ x: 510, y: 164 });
      engine.zoomBy(ZOOM_OUT);
      engine.resetLayout();
      expect(localStorage.getItem(POSITIONS_KEY)).toBeNull();
      const camera = { ...engine.getCamera() };

      expect(engine.undo()).toBe(true);
      expect(stored()["agent:one"]).toEqual({ x: 510, y: 164 });
      expect(engine.getCamera()).toEqual(camera);
    } finally {
      engine.unmount();
    }
  });

  it("没有手动位置时重置同样有效：按此刻的缩放重新取景，不留历史", () => {
    const { engine } = mountPair();
    try {
      engine.zoomBy(ZOOM_OUT);
      const zoom = engine.getCamera().k;
      engine.resetLayout();
      expect(engine.getCamera().k).toBeCloseTo(zoom, 6);
      expect(engine.isUserMoved()).toBe(false);
      expect(engine.getState().canUndo).toBe(false);
    } finally {
      engine.unmount();
    }
  });
});

describe("canvas reset layout · 排布缩放按空间记忆", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
  });

  it("重置记下此刻的缩放并通知订阅者；缩放没变就不重复通知", () => {
    const { engine } = mountPair();
    const listener = vi.fn();
    const off = engine.subscribeFill(listener);
    try {
      expect(engine.getFill("all")).toBeUndefined();
      engine.zoomBy(ZOOM_OUT);
      engine.resetLayout();
      expect(engine.getFill("all")).toBeCloseTo(ZOOM_OUT, 6);
      expect(listener).toHaveBeenCalledTimes(1);

      // 保持住了缩放：再重置一次，缩放没变，不通知（Overview 不必白白重排一遍）。
      engine.resetLayout();
      expect(listener).toHaveBeenCalledTimes(1);

      engine.zoomBy(ZOOM_OUT);
      engine.resetLayout();
      expect(engine.getFill("all")).toBeCloseTo(ZOOM_OUT * ZOOM_OUT, 6);
      expect(listener).toHaveBeenCalledTimes(2);

      off();
      engine.zoomBy(1.2);
      engine.resetLayout();
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      off();
      engine.unmount();
    }
  });

  it("每个空间各记各的：别的空间没有重置过就是 undefined，也不带着保持的缩放", () => {
    const rig = mountPair();
    try {
      rig.engine.zoomBy(ZOOM_OUT);
      rig.engine.resetLayout();
      const zoom = rig.engine.getCamera().k;
      expect(rig.engine.getFill("origin:x")).toBeUndefined();

      // 切到另一个空间：没有保持的缩放，按内容取景（放得下就是 100%）。
      rig.engine.switchSpace("origin:x");
      rig.engine.setLayout(pairLayout);
      expect(rig.engine.getCamera().k).toBe(1);
      expect(rig.engine.getFill("origin:x")).toBeUndefined();

      // 切回来：这个空间的相机是自动取景，第一次布局仍按它保持缩放。
      rig.engine.switchSpace("all");
      rig.engine.setLayout(pairLayout);
      expect(rig.engine.getCamera().k).toBeCloseTo(zoom, 6);
      expect(rig.engine.getFill("all")).toBeCloseTo(zoom, 6);
    } finally {
      rig.engine.unmount();
    }
  });
});
