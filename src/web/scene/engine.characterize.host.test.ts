import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountPair, pointer, selectBoth, stored } from "./engine.fixtures";

/**
 * 特征化测试：宿主能看到的东西（`onCamera`、`onPositions`、`onArrangement`、`onSelection` 与各订阅）按什么顺序发生，
 * 以及每一次回调发生时引擎已经做完了什么（相机归谁、位置存了没有、会话卡元素写到哪、连线路径跟上了没有）。
 * 这些顺序不写在任何文档里，却是界面（对齐条、缩放读数、侧栏提示）依赖的现状；拆分引擎之前在旧实现上跑绿，拆分之后必须仍然全绿。
 */
describe("what the host sees, and in which order", () => {
  /** 会话卡在 (x, y) 时来源卡到它的那条连线路径（来源卡在 (0,30)，宽 212、高 112；会话卡高 144）。 */
  const PIPE = {
    home: "M212 86C261 86 261 86 310 86",
    x320: "M212 86C266 86 266 86 320 86",
    x330: "M212 86C271 86 271 86 330 86",
    x360y34: "M212 86C286 86 286 106 360 106",
    x380y44: "M212 86C296 86 296 116 380 116",
  };

  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    localStorage.clear();
  });

  /** 挂上全部回调与订阅；每一条记录都带着“此刻”的样子：相机是否归用户、存下了哪些位置、会话卡元素写到哪、连线路径是否已经跟上。 */
  function watched() {
    const rig = mountPair();
    const { engine } = rig;
    const log: string[] = [];
    const path = (): string => rig.tube.querySelector("path")?.getAttribute("d") ?? "none";
    const now = (): string => `um=${engine.isUserMoved() ? 1 : 0} saved=${Object.keys(stored()).sort().join("+") || "-"} agent=${rig.agent.style.translate} pipe=${path()}`;
    const state = (): string => {
      const { selected, canUndo, canRedo } = engine.getState();
      return `${selected}${canUndo ? "u" : "-"}${canRedo ? "r" : "-"}`;
    };
    engine.mount({
      viewport: rig.viewport,
      world: rig.world,
      pipes: { tube: rig.tube, dots: rig.dots },
      onCamera: (camera, moved) => log.push(`camera k=${camera.k.toFixed(2)} moved=${moved} ${now()}`),
      onPositions: (custom) => log.push(`positions ${custom} ${now()}`),
      onArrangement: (drifted) => log.push(`arrangement ${drifted}`),
      onSelection: (count) => log.push(`selection ${count}`),
    });
    engine.subscribe(() => log.push(`state ${state()} ${now()}`));
    engine.subscribeSelection(() => log.push(`members [${engine.getSelectedIds().join(",")}]`));
    log.length = 0;
    return { ...rig, log, now };
  }

  it("keeps the order of a keyboard nudge: selection, camera, positions (not yet saved), history", () => {
    const { engine, log } = watched();
    try {
      engine.moveNode("agent:one", 10, 0);
      expect([...log]).toEqual([
        `state 1-- um=0 saved=- agent=310.00px 14.00px pipe=${PIPE.home}`,
        "members [agent:one]",
        "selection 1",
        `camera k=1.00 moved=true um=1 saved=- agent=320.00px 14.00px pipe=${PIPE.x320}`,
        `positions true um=1 saved=- agent=320.00px 14.00px pipe=${PIPE.x320}`,
        `state 1u- um=1 saved=agent:one agent=320.00px 14.00px pipe=${PIPE.x320}`,
      ]);
      log.length = 0;
      // 紧接着的第二下合并进同一条历史：只有位置变，状态不再通知。
      engine.moveNode("agent:one", 10, 0);
      expect([...log]).toEqual([`positions true um=1 saved=agent:one agent=330.00px 14.00px pipe=${PIPE.x330}`]);
    } finally {
      engine.unmount();
    }
  });

  it("keeps the order of a pointer drag: selection on the first move, positions on every move, history on release", () => {
    const { engine, viewport, agent, log } = watched();
    try {
      pointer(agent, "pointerdown", 400, 300);
      expect([...log]).toEqual([]);
      pointer(viewport, "pointermove", 450, 320);
      expect([...log]).toEqual([
        `state 1-- um=0 saved=- agent=310.00px 14.00px pipe=${PIPE.home}`,
        "members [agent:one]",
        "selection 1",
        `camera k=1.00 moved=true um=1 saved=- agent=360.00px 34.00px pipe=${PIPE.x360y34}`,
        `positions true um=1 saved=- agent=360.00px 34.00px pipe=${PIPE.x360y34}`,
      ]);
      log.length = 0;
      pointer(viewport, "pointermove", 470, 330);
      expect([...log]).toEqual([`positions true um=1 saved=- agent=380.00px 44.00px pipe=${PIPE.x380y44}`]);
      log.length = 0;
      pointer(viewport, "pointerup", 470, 330);
      expect([...log]).toEqual([`state 1u- um=1 saved=agent:one agent=380.00px 44.00px pipe=${PIPE.x380y44}`]);
    } finally {
      engine.unmount();
    }
  });

  it("keeps the order of an alignment: positions saved, then camera, then history", () => {
    const { engine, log } = watched();
    try {
      selectBoth(engine);
      log.length = 0;
      expect(engine.align("top")).toBe(true);
      // 连线要等下一帧才跟上：对齐只改目标位置，不重算连线。
      expect([...log]).toEqual([
        `positions true um=1 saved=agent:one+origin:one agent=310.00px 14.00px pipe=${PIPE.home}`,
        `camera k=1.00 moved=true um=1 saved=agent:one+origin:one agent=310.00px 14.00px pipe=${PIPE.home}`,
        `state 2u- um=1 saved=agent:one+origin:one agent=310.00px 14.00px pipe=${PIPE.home}`,
      ]);
      log.length = 0;
      // 撤销：位置先收回并存下（没有手动位置了），再通知历史。
      expect(engine.undo()).toBe(true);
      expect([...log]).toEqual([
        `positions false um=1 saved=- agent=310.00px 14.00px pipe=${PIPE.home}`,
        `state 2-r um=1 saved=- agent=310.00px 14.00px pipe=${PIPE.home}`,
      ]);
      log.length = 0;
      expect(engine.redo()).toBe(true);
      expect([...log]).toEqual([
        `positions true um=1 saved=agent:one+origin:one agent=310.00px 14.00px pipe=${PIPE.home}`,
        `state 2u- um=1 saved=agent:one+origin:one agent=310.00px 14.00px pipe=${PIPE.home}`,
      ]);
    } finally {
      engine.unmount();
    }
  });

  it("keeps the order of a reset: positions cleared and saved, arrangement, camera back to automatic", () => {
    const { engine, log } = watched();
    try {
      engine.moveNode("agent:one", 10, 0);
      log.length = 0;
      engine.resetLayout();
      // 历史里已经有一条（canUndo 早就是真），清除位置再记一条不改变状态，所以没有 state 通知。
      expect([...log]).toEqual([
        `positions false um=1 saved=- agent=320.00px 14.00px pipe=${PIPE.x320}`,
        "arrangement false",
        `camera k=1.00 moved=false um=0 saved=- agent=320.00px 14.00px pipe=${PIPE.x320}`,
      ]);
      expect(engine.getState().canUndo).toBe(true);
    } finally {
      engine.unmount();
    }
  });

  it("leaves the history alone when a reset has nothing to clear", () => {
    const { engine, log } = watched();
    try {
      // 没有手动位置时重置：没有可记的变化，也没有历史通知。
      engine.resetLayout();
      expect([...log]).toEqual([`positions false um=0 saved=- agent=310.00px 14.00px pipe=${PIPE.home}`, "arrangement false"]);
      expect(engine.getState().canUndo).toBe(false);
    } finally {
      engine.unmount();
    }
  });

  it("keeps the order of a remount: arrangement from the replay, then the position count", () => {
    const rig = mountPair();
    const log: string[] = [];
    try {
      rig.engine.moveNode("agent:one", 10, 0);
      rig.engine.mount({
        viewport: rig.viewport,
        world: rig.world,
        pipes: { tube: rig.tube, dots: rig.dots },
        onCamera: (camera, moved) => log.push(`camera k=${camera.k.toFixed(2)} moved=${moved}`),
        onPositions: (custom) => log.push(`positions ${custom}`),
        onArrangement: (drifted) => log.push(`arrangement ${drifted}`),
        onSelection: (count) => log.push(`selection ${count}`),
      });
      // 修复缩放读数缺陷时有意改的，不是拆分之前的特征：新宿主一挂上来先听到引擎手里的相机（这里是用户动过的，k=1、moved=true），
      // 以前重新挂载时用户动过的相机一次都不上报。相机在起点（100%、自动取景）的仍不重发（见 camera.test 里的 “a host that mounts again”）。
      expect([...log]).toEqual(["camera k=1.00 moved=true", "arrangement false", "positions true"]);
    } finally {
      rig.engine.unmount();
    }
  });

  it("keeps the order of an unmount: pipes gone before the state is told, then the members, and no host selection callback", () => {
    const { engine, log } = watched();
    selectBoth(engine);
    log.length = 0;
    engine.unmount();
    expect([...log]).toEqual(["state 0-- um=0 saved=- agent=310.00px 14.00px pipe=none", "members []"]);
  });

  it("hands the camera to the host as the live target object", () => {
    const rig = mountPair();
    const seen: unknown[] = [];
    try {
      rig.engine.mount({
        viewport: rig.viewport,
        world: rig.world,
        pipes: { tube: rig.tube, dots: rig.dots },
        onCamera: (camera) => seen.push(camera),
      });
      rig.engine.zoomBy(1.2);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toBe(rig.engine.getCamera());
    } finally {
      rig.engine.unmount();
    }
  });
});
