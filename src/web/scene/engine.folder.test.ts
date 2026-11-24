import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { at, edge, mountScene, node, origin, pathNumbers, POSITIONS_KEY, sceneOf, stored } from "./engine.fixtures";

/** Git → Folder → 来源：Folder 是独立的节点，与 Git 节点一样可拖、可保存、首次出现时按锚点放。 */
describe("canvas folder node", () => {
  const COLUMN = 212 + 92;
  const scene = sceneOf(
    [
      origin("origin:one", 2 * COLUMN, 30),
      node("folder:one", COLUMN, 30, { kind: "folder", anchor: { id: "origin:one", dx: -COLUMN, dy: 0 } }),
      node("git:one", 0, 30, { kind: "git", anchor: { id: "folder:one", dx: -COLUMN, dy: 0 } }),
    ],
    [edge("git:one", "folder:one", "link"), edge("folder:one", "origin:one", "link")],
  );
  /** 两条连线的端点：引擎按边 id 排序绘制，所以按起点从左到右取（先 Git → Folder，再 Folder → 来源）。 */
  const pipesOf = (tube: Element): number[][] => [...tube.querySelectorAll("path")].map(pathNumbers).sort((a, b) => a[0]! - b[0]!);

  beforeEach(() => localStorage.clear());
  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
  });

  it("puts new folder and git nodes at their layout spots when nothing was moved, and stores nothing", () => {
    const { engine, els } = mountScene(scene);
    try {
      expect(at(els.get("git:one")!)).toEqual({ x: 0, y: 30 });
      expect(at(els.get("folder:one")!)).toEqual({ x: COLUMN, y: 30 });
      expect(at(els.get("origin:one")!)).toEqual({ x: 2 * COLUMN, y: 30 });
      expect(localStorage.getItem(POSITIONS_KEY)).toBeNull();
    } finally {
      engine.unmount();
    }
  });

  it("anchors the chain: with only the origin moved earlier, the folder lands beside it and the git node beside the folder; both spots are remembered and restored", () => {
    localStorage.setItem(POSITIONS_KEY, JSON.stringify({ "origin:one": { x: 900, y: 260 } }));
    const first = mountScene(scene);
    try {
      expect(at(first.els.get("origin:one")!)).toEqual({ x: 900, y: 260 });
      expect(at(first.els.get("folder:one")!)).toEqual({ x: 900 - COLUMN, y: 260 });
      expect(at(first.els.get("git:one")!)).toEqual({ x: 900 - 2 * COLUMN, y: 260 });
      expect(stored()["folder:one"]).toEqual({ x: 900 - COLUMN, y: 260 });
      expect(stored()["git:one"]).toEqual({ x: 900 - 2 * COLUMN, y: 260 });
    } finally {
      first.dispose();
    }

    // 下一次访问：`folder:` 也是会被保存与读回的节点，位置原样恢复。
    const second = mountScene(scene);
    try {
      expect(at(second.els.get("folder:one")!)).toEqual({ x: 900 - COLUMN, y: 260 });
      expect(at(second.els.get("git:one")!)).toEqual({ x: 900 - 2 * COLUMN, y: 260 });
    } finally {
      second.engine.unmount();
    }
  });

  it("keeps an already saved git position when a folder node first appears (existing layouts are not scrambled); the folder is placed beside the origin", () => {
    // 升级前：只有来源与 Git 被移动过（那时还没有 Folder 节点）。
    localStorage.setItem(POSITIONS_KEY, JSON.stringify({ "origin:one": { x: 900, y: 260 }, "git:one": { x: 12, y: 345 } }));
    const { engine, els } = mountScene(scene);
    try {
      expect(at(els.get("git:one")!)).toEqual({ x: 12, y: 345 });
      expect(at(els.get("origin:one")!)).toEqual({ x: 900, y: 260 });
      expect(at(els.get("folder:one")!)).toEqual({ x: 900 - COLUMN, y: 260 });
      expect(stored()["git:one"]).toEqual({ x: 12, y: 345 });
      expect(stored()["folder:one"]).toEqual({ x: 900 - COLUMN, y: 260 });
    } finally {
      engine.unmount();
    }
  });

  it("keeps the folder's own saved position over the anchor, and hangs the git node off the folder's actual spot", () => {
    localStorage.setItem(POSITIONS_KEY, JSON.stringify({ "origin:one": { x: 900, y: 260 }, "folder:one": { x: 100, y: 500 } }));
    const { engine, els } = mountScene(scene);
    try {
      expect(at(els.get("folder:one")!)).toEqual({ x: 100, y: 500 });
      expect(at(els.get("git:one")!)).toEqual({ x: 100 - COLUMN, y: 500 });
      expect(stored()["folder:one"]).toEqual({ x: 100, y: 500 });
    } finally {
      engine.unmount();
    }
  });

  it("does not drag an already placed folder along when the origin is moved later", () => {
    const { engine, els } = mountScene(scene);
    try {
      engine.moveNode("origin:one", 100, 0);
      engine.setLayout(scene);
      expect(at(els.get("origin:one")!).x).toBe(2 * COLUMN + 100);
      expect(at(els.get("folder:one")!)).toEqual({ x: COLUMN, y: 30 });
      expect(stored()["folder:one"]).toBeUndefined();
    } finally {
      engine.unmount();
    }
  });

  it("draws both link pipes as static lines: git right edge → folder left edge, folder right edge → origin left edge, all on one midline", () => {
    const { engine, tube } = mountScene(scene);
    try {
      expect([...tube.querySelectorAll("path")].map((pipe) => pipe.getAttribute("data-phase"))).toEqual(["link", "link"]);
      const [gitToFolder, folderToOrigin] = pipesOf(tube) as [number[], number[]];
      expect(gitToFolder.slice(0, 2)).toEqual([212, 86]);
      expect(gitToFolder.slice(-2)).toEqual([COLUMN, 86]);
      expect(folderToOrigin.slice(0, 2)).toEqual([COLUMN + 212, 86]);
      expect(folderToOrigin.slice(-2)).toEqual([2 * COLUMN, 86]);
    } finally {
      engine.unmount();
    }
  });

  it("moving the folder (keyboard nudge) moves only its own two pipe ends; the git node and the origin stay, and the spot is remembered", () => {
    const { engine, tube, els } = mountScene(scene);
    try {
      engine.moveNode("folder:one", 0, 80);
      expect(at(els.get("folder:one")!)).toEqual({ x: COLUMN, y: 110 });
      expect(at(els.get("git:one")!)).toEqual({ x: 0, y: 30 });
      expect(at(els.get("origin:one")!)).toEqual({ x: 2 * COLUMN, y: 30 });
      const [gitToFolder, folderToOrigin] = pipesOf(tube) as [number[], number[]];
      expect(gitToFolder.slice(0, 2)).toEqual([212, 86]);
      expect(gitToFolder.slice(-2)).toEqual([COLUMN, 166]);
      expect(folderToOrigin.slice(0, 2)).toEqual([COLUMN + 212, 166]);
      expect(folderToOrigin.slice(-2)).toEqual([2 * COLUMN, 86]);
      expect(stored()["folder:one"]).toEqual({ x: COLUMN, y: 110 });
    } finally {
      engine.unmount();
    }
  });

  it("fit frames the folder node together with the rest, wherever it was dragged", () => {
    const { engine } = mountScene(scene);
    try {
      engine.fit(false);
      expect(engine.getCamera().k).toBe(1);
      // 横向拖远：取景范围把它算进去，只能缩小来容纳（纵向超出则保留 0.72 的下限、靠滚动，见 fitScale）。
      engine.moveNode("folder:one", -3000, 0);
      expect(engine.isUserMoved()).toBe(true);
      engine.fit(false);
      expect(engine.isUserMoved()).toBe(false);
      expect(engine.getCamera().k).toBeLessThan(0.5);
    } finally {
      engine.unmount();
    }
  });
});
