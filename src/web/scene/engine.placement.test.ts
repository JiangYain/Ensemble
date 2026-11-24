import type { SessionId, SessionSummary } from "@shared/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SceneEngine } from "./engine";
import { agentNodeId, layoutScene, NODE, originNodeId, type Area, type SceneLayout } from "./layout";
import { session } from "./layout.fixtures";

/**
 * 新会话出现的位置：参照（同一父下的上一个兄弟 / 父会话 / 来源卡）被用户摆放过，新节点就落在它此刻位置的下方，
 * 并像手动位置一样记下来；没有任何拖拽时照布局默认位置、什么都不记。纯函数的细节在 placement.test.ts，这里只验引擎的接线。
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const KEY = "ensemble.canvas.positions.v1";
const ROW = NODE.agentH + NODE.rowGap;

type Spot = { x: number; y: number };
const sid = (id: string): SessionId => id as SessionId;
const id = (n: number | string): string => agentNodeId(sid(typeof n === "number" ? `s${n}` : n));
const roots = (count: number): SessionSummary[] => Array.from({ length: count }, (_, i) => session(`s${i + 1}`, "codex", i + 1));
const kid = (name: string, order: number, parent: string): SessionSummary => session(name, "codex", order, { parentSessionId: sid(parent) });

function build(options: { area?: Area } = {}) {
  const viewport = document.createElement("div");
  const world = document.createElement("div");
  const svg = document.createElementNS(SVG_NS, "svg");
  const tube = document.createElementNS(SVG_NS, "g");
  const dots = document.createElementNS(SVG_NS, "g");
  svg.append(tube, dots);
  world.append(svg);
  viewport.append(world);
  document.body.append(viewport);
  Object.defineProperties(viewport, { clientWidth: { value: 1200, configurable: true }, clientHeight: { value: 800, configurable: true } });
  viewport.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 1200, height: 800 });
  const engine = new SceneEngine();
  const els = new Map<string, HTMLElement>();
  const offs = new Map<string, () => void>();
  const onPositions = vi.fn();
  const mountOptions = { viewport, world, pipes: { tube, dots }, onPositions };
  engine.mount(mountOptions);

  /** 与页面一致：先把这一批会话要用的节点挂上，再交布局（React 的子节点先于 Overview 的布局副作用挂载）。 */
  const show = (sessions: readonly SessionSummary[], visible?: ReadonlySet<SessionId>): SceneLayout => {
    const layout = layoutScene(sessions, { ...(options.area ? { area: options.area } : {}), ...(visible ? { visible } : {}) });
    const keep = new Set(layout.nodes.map((n) => n.id));
    for (const [nodeId, off] of [...offs]) {
      if (keep.has(nodeId)) continue;
      off();
      offs.delete(nodeId);
      els.get(nodeId)?.remove();
      els.delete(nodeId);
    }
    for (const node of layout.nodes) {
      if (els.has(node.id)) continue;
      const el = document.createElement("div");
      el.dataset["nodeId"] = node.id;
      world.append(el);
      els.set(node.id, el);
      offs.set(node.id, engine.register(node.id, el));
    }
    engine.setLayout(layout);
    return layout;
  };
  const at = (nodeId: string): Spot => {
    const [x, y] = els.get(nodeId)!.style.translate.split(" ").map((part) => Number.parseFloat(part));
    return { x: x!, y: y! };
  };
  return { engine, els, show, at, onPositions, remount: () => { engine.unmount(); engine.mount(mountOptions); } };
}

type Rig = ReturnType<typeof build>;
const stored = (): Record<string, Spot> => JSON.parse(localStorage.getItem(KEY) ?? "{}");
const settle = (): void => {
  vi.advanceTimersByTime(3000);
};
const rectOf = (rig: Rig, nodeId: string, w: number = NODE.agentW, h: number = NODE.agentH) => ({ ...rig.at(nodeId), w, h });
const overlap = (a: ReturnType<typeof rectOf>, b: ReturnType<typeof rectOf>): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const onlyAgents = (layout: SceneLayout): string[] => layout.nodes.filter((n) => n.kind === "agent").map((n) => n.id);

describe("新会话在引擎里的出现位置", () => {
  let rig: Rig | undefined;
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
  });
  afterEach(() => {
    rig?.engine.unmount();
    rig = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.replaceChildren();
    localStorage.clear();
  });

  it("没有任何拖拽：新节点落在布局默认位置，什么都不写，“重置布局”也不会无故出现", () => {
    rig = build();
    rig.show(roots(3));
    settle();
    const layout = rig.show(roots(4));
    settle();
    const home = layout.nodes.find((n) => n.id === id(4))!;
    expect(rig.at(id(4))).toEqual({ x: home.x, y: home.y });
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(rig.onPositions.mock.calls.every(([custom]) => custom === false)).toBe(true);
  });

  it("参照被拖走：新节点出现在它此刻位置的下方（沿用布局的错位），位置写进 positions", () => {
    rig = build();
    const before = rig.show(roots(3));
    settle();
    rig.engine.moveNode(id(3), 500, -60);
    settle();
    const dragged = rig.at(id(3));
    const home3 = before.nodes.find((n) => n.id === id(3))!;
    expect(dragged).toEqual({ x: home3.x + 500, y: home3.y - 60 });

    const after = rig.show(roots(4));
    settle();
    const home4 = after.nodes.find((n) => n.id === id(4))!;
    expect(home4.x - home3.x).toBe(NODE.stagger);
    expect(rig.at(id(4))).toEqual({ x: dragged.x + NODE.stagger, y: dragged.y + ROW });
    expect(stored()[id(4)]).toEqual({ x: dragged.x + NODE.stagger, y: dragged.y + ROW });
    expect(rig.onPositions.mock.calls.at(-1)?.[0]).toBe(true);
  });

  it("参照被拖到上、下、左三个方向：新节点总在拖后位置的下一格，不会回到布局槽位", () => {
    for (const [dx, dy] of [[0, -450], [0, 700], [-420, 0]] as const) {
      rig = build();
      rig.show(roots(3));
      settle();
      rig.engine.moveNode(id(3), dx, dy);
      settle();
      const dragged = rig.at(id(3));
      rig.show(roots(4));
      settle();
      const spot = rig.at(id(4));
      // 拖回原列上方时会压着别的会话，往下让；其余方向原样落在下一格。
      if (dx === 0 && dy < 0) {
        for (const n of [1, 2, 3]) expect(overlap(rectOf(rig, id(4)), rectOf(rig, id(n))), `s${n}`).toBe(false);
      } else {
        expect(spot).toEqual({ x: dragged.x + NODE.stagger, y: dragged.y + ROW });
      }
      rig.engine.unmount();
      document.body.replaceChildren();
      localStorage.clear();
    }
    rig = undefined;
  });

  it("不动已有的节点：用户摆放过的位置一个像素都不变，没摆过的兄弟也留在原位（不会被重新挂到参照旁边）", () => {
    rig = build();
    rig.show(roots(4));
    settle();
    rig.engine.moveNode(id(1), 300, 40);
    rig.engine.moveNode(id(3), 600, 0);
    settle();
    const ids = [id(1), id(2), id(3), id(4)];
    const before = new Map(ids.map((nodeId) => [nodeId, rig!.at(nodeId)]));
    const saved = JSON.stringify(stored());

    rig.show(roots(5));
    settle();
    for (const nodeId of ids) expect(rig.at(nodeId), nodeId).toEqual(before.get(nodeId));
    // s4 本来就在、没摆过，参照 s3 被拖走也不影响它；新来的 s5 的参照是 s4（没摆过），所以照默认槽位、不记。
    const stash = JSON.parse(saved) as Record<string, Spot>;
    expect(stored()).toEqual(stash);
  });

  it("参照没被动过、但默认槽位被拖来的节点占着：往下避开，不压住它，并记下来", () => {
    rig = build();
    const layout = rig.show(roots(3));
    settle();
    const home4 = layoutScene(roots(4)).nodes.find((n) => n.id === id(4))!;
    const s1 = layout.nodes.find((n) => n.id === id(1))!;
    // 把 s1 拖到 s4 的默认槽位上。
    rig.engine.moveNode(id(1), home4.x - s1.x, home4.y - s1.y);
    settle();
    rig.show(roots(4));
    settle();
    expect(overlap(rectOf(rig, id(4)), rectOf(rig, id(1)))).toBe(false);
    expect(rig.at(id(4)).y).toBe(home4.y + NODE.agentH + NODE.rowGap);
    expect(stored()[id(4)]).toEqual(rig.at(id(4)));
  });

  it("同时来两个：互不重叠，第二个跟在第一个下面，也不压任何已有节点", () => {
    rig = build();
    rig.show(roots(3));
    settle();
    rig.engine.moveNode(id(3), 480, 0);
    settle();
    const layout = rig.show(roots(5));
    settle();
    const a = rectOf(rig, id(4));
    const b = rectOf(rig, id(5));
    expect(overlap(a, b)).toBe(false);
    expect(b.y - a.y).toBe(ROW);
    for (const other of onlyAgents(layout).filter((n) => n !== id(4) && n !== id(5))) expect(overlap(a, rectOf(rig, other)), other).toBe(false);
    expect(Object.keys(stored()).sort()).toEqual([id(3), id(4), id(5)].sort());
  });

  it("落点记进 positions 之后就是“用户摆放”的：布局再变（又来一个会话、状态变化）它也不会跟着默认槽位跳走", () => {
    rig = build();
    rig.show(roots(3));
    settle();
    rig.engine.moveNode(id(3), 500, 0);
    settle();
    rig.show(roots(4));
    settle();
    const landed = rig.at(id(4));
    rig.show(roots(5));
    settle();
    rig.show([...roots(5).slice(0, 4), { ...roots(5)[4]!, phase: "done" } as SessionSummary]);
    settle();
    expect(rig.at(id(4))).toEqual(landed);
  });

  it("不进撤销历史：撤销只退回用户自己的拖拽，新节点留在记下来的位置", () => {
    rig = build();
    rig.show(roots(3));
    settle();
    rig.engine.moveNode(id(3), 500, 0);
    settle();
    rig.show(roots(4));
    settle();
    const landed = rig.at(id(4));
    expect(rig.engine.getState().canUndo).toBe(true);
    expect(rig.engine.undo()).toBe(true);
    settle();
    // 撤销的是 s3 的那一次拖拽；再撤就没有了：新节点的落点不是一步历史。
    expect(rig.engine.undo()).toBe(false);
    expect(rig.engine.getState().canUndo).toBe(false);
    expect(rig.at(id(4))).toEqual(landed);
    expect(stored()[id(4)]).toEqual(landed);
  });

  it("刷新（重新挂载）后位置保持，之后再来一个仍接在它后面", () => {
    rig = build();
    rig.show(roots(3));
    settle();
    rig.engine.moveNode(id(3), 500, 0);
    settle();
    rig.show(roots(4));
    settle();
    const snapshot = new Map(onlyAgents(layoutScene(roots(4))).map((nodeId) => [nodeId, rig!.at(nodeId)]));
    rig.engine.unmount();
    document.body.replaceChildren();

    rig = build();
    rig.show(roots(4));
    settle();
    for (const [nodeId, spot] of snapshot) expect(rig.at(nodeId), nodeId).toEqual(spot);
    // 刷新后的第一次布局不搬任何节点，也不新增记录。
    expect(Object.keys(stored()).sort()).toEqual([id(3), id(4)].sort());

    rig.show(roots(5));
    settle();
    const four = snapshot.get(id(4))!;
    expect(rig.at(id(5))).toEqual({ x: four.x - NODE.stagger, y: four.y + ROW });
    expect(stored()[id(5)]).toEqual(rig.at(id(5)));
  });

  it("页面刚打开时没摆过的节点不被搬走：此前来的会话照默认槽位，即使它的上一个兄弟被拖走过", () => {
    localStorage.setItem(KEY, JSON.stringify({ [id(3)]: { x: 1500, y: 20 } }));
    rig = build();
    const layout = rig.show(roots(4));
    settle();
    const home4 = layout.nodes.find((n) => n.id === id(4))!;
    expect(rig.at(id(3))).toEqual({ x: 1500, y: 20 });
    expect(rig.at(id(4))).toEqual({ x: home4.x, y: home4.y });
    expect(Object.keys(stored())).toEqual([id(3)]);
  });

  it("离开聚焦页再回到总览（重新挂载、节点都还在）：这期间来的会话同样接在被拖走的上一个节点后面", () => {
    rig = build();
    rig.show(roots(3));
    settle();
    rig.engine.moveNode(id(3), 500, 0);
    settle();
    const dragged = rig.at(id(3));
    rig.remount();
    rig.show(roots(4));
    settle();
    expect(rig.at(id(4))).toEqual({ x: dragged.x + NODE.stagger, y: dragged.y + ROW });
    expect(stored()[id(4)]).toEqual(rig.at(id(4)));
  });

  it("子会话：父会话被拖走后，第一个子会话在它右边，第二个在第一个下面", () => {
    rig = build();
    const base = [session("p1", "codex", 1), session("p2", "codex", 2)];
    rig.show(base);
    settle();
    rig.engine.moveNode(id("p2"), 200, 420);
    settle();
    const parent = rig.at(id("p2"));
    const one = layoutScene([...base, kid("c1", 3, "p2")]);
    const c1home = one.nodes.find((n) => n.id === id("c1"))!;
    const p2home = one.nodes.find((n) => n.id === id("p2"))!;
    rig.show([...base, kid("c1", 3, "p2")]);
    settle();
    expect(rig.at(id("c1"))).toEqual({ x: parent.x + (c1home.x - p2home.x), y: parent.y + (c1home.y - p2home.y) });
    rig.show([...base, kid("c1", 3, "p2"), kid("c2", 4, "p2")]);
    settle();
    expect(rig.at(id("c2")).y - rig.at(id("c1")).y).toBe(ROW);
    expect(Math.abs(rig.at(id("c2")).x - rig.at(id("c1")).x)).toBe(NODE.stagger);
    expect(overlap(rectOf(rig, id("c1")), rectOf(rig, id("c2")))).toBe(false);
  });

  it("紧凑画布（没有错位）：新节点在被拖走的参照正下方", () => {
    rig = build({ area: { w: 400, h: 700 } });
    rig.show(roots(3));
    settle();
    rig.engine.moveNode(id(3), 60, -500);
    settle();
    const dragged = rig.at(id(3));
    rig.show(roots(4));
    settle();
    expect(rig.at(id(4)).x).toBe(dragged.x);
    for (const n of [1, 2, 3]) expect(overlap(rectOf(rig, id(4), NODE.agentWCompact), rectOf(rig, id(n), NODE.agentWCompact)), `s${n}`).toBe(false);
  });

  it("节点被删掉再出现：记下来的位置还在，原样回到那里", () => {
    rig = build();
    rig.show(roots(3));
    settle();
    rig.engine.moveNode(id(3), 500, 0);
    settle();
    rig.show(roots(4));
    settle();
    const landed = rig.at(id(4));
    rig.show(roots(3));
    settle();
    rig.show(roots(4));
    settle();
    expect(rig.at(id(4))).toEqual(landed);
  });

  describe("视图过滤：收起的会话不是新到的会话", () => {
    const only = (...names: string[]): ReadonlySet<SessionId> => new Set(names.map(sid));
    const homeOf = (layout: SceneLayout, nodeId: string): Spot => {
      const found = layout.nodes.find((n) => n.id === nodeId)!;
      return { x: found.x, y: found.y };
    };

    it("拖过某个节点后，收起它后面的兄弟再显示：兄弟回到布局默认位置，不被摆到被拖节点旁边，别的节点一动不动，什么都没多记", () => {
      rig = build();
      rig.show(roots(5));
      settle();
      rig.engine.moveNode(id(3), 500, 0);
      settle();
      const dragged = rig.at(id(3));
      const written = localStorage.getItem(KEY);
      const was = Object.fromEntries([1, 2, 3].map((n) => [n, rig!.at(id(n))]));

      rig.show(roots(5), only("s1", "s2", "s3"));
      settle();
      expect(rig.els.has(id(4))).toBe(false);
      const full = rig.show(roots(5));
      settle();

      for (const n of [4, 5]) expect(rig.at(id(n)), `s${n} 回到默认位置`).toEqual(homeOf(full, id(n)));
      expect(rig.at(id(3))).toEqual(dragged);
      for (const n of [1, 2]) expect(rig.at(id(n)), `s${n} 不动`).toEqual(was[n]);
      expect(localStorage.getItem(KEY)).toBe(written);
      expect(Object.keys(stored())).toEqual([id(3)]);
    });

    it("页面一打开就收着（这些会话从没在画布上出现过）：之后显示出来同样不算新到的", () => {
      localStorage.setItem(KEY, JSON.stringify({ [id(3)]: { x: 1400, y: 90 } }));
      rig = build();
      rig.show(roots(5), only("s1", "s2", "s3"));
      settle();
      const written = localStorage.getItem(KEY);
      const full = rig.show(roots(5));
      settle();
      for (const n of [4, 5]) expect(rig.at(id(n)), `s${n}`).toEqual(homeOf(full, id(n)));
      expect(rig.at(id(3))).toEqual({ x: 1400, y: 90 });
      expect(localStorage.getItem(KEY)).toBe(written);
    });

    it("收着的时候来了真正的新会话：照常落在它的参照旁边并记下来；收起的会话显示出来仍回默认位置，新来的那个不动", () => {
      rig = build();
      rig.show(roots(5));
      settle();
      rig.engine.moveNode(id(3), 500, 0);
      settle();
      const dragged = rig.at(id(3));
      rig.show(roots(5), only("s1", "s2", "s3"));
      settle();

      rig.show(roots(6), only("s1", "s2", "s3", "s6"));
      settle();
      const landed = rig.at(id(6));
      expect(landed).toEqual({ x: dragged.x + NODE.stagger, y: dragged.y + ROW });
      expect(stored()[id(6)]).toEqual(landed);

      const full = rig.show(roots(6));
      settle();
      for (const n of [4, 5]) expect(rig.at(id(n)), `s${n}`).toEqual(homeOf(full, id(n)));
      expect(rig.at(id(6))).toEqual(landed);
      expect(rig.at(id(3))).toEqual(dragged);
    });

    it("收起再显示的过程中，节点从上游“长”出来的入场动效照旧（只是终点是默认位置）", () => {
      rig = build();
      rig.show(roots(5));
      settle();
      rig.engine.moveNode(id(3), 500, 0);
      settle();
      rig.show(roots(5), only("s1", "s2", "s3"));
      settle();
      const full = rig.show(roots(5));
      expect(rig.els.get(id(4))!.dataset["fresh"]).toBe("");
      settle();
      expect(rig.at(id(4))).toEqual(homeOf(full, id(4)));
    });
  });

  it("重置布局之后：位置清空，再来的新节点照默认槽位、不再记录", () => {
    rig = build();
    rig.show(roots(3));
    settle();
    rig.engine.moveNode(id(3), 500, 0);
    settle();
    rig.show(roots(4));
    settle();
    rig.engine.resetLayout();
    settle();
    expect(localStorage.getItem(KEY)).toBeNull();
    const layout = rig.show(roots(5));
    settle();
    const home5 = layout.nodes.find((n) => n.id === id(5))!;
    expect(rig.at(id(5))).toEqual({ x: home5.x, y: home5.y });
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  describe("出现动效", () => {
    it("从上游“长”出来：起点在来源卡的出口附近、终点是新落点；第一帧就在起点，不会先出现在旧槽位", () => {
      rig = build();
      const base = rig.show(roots(3));
      settle();
      rig.engine.moveNode(id(3), 500, 0);
      settle();
      const origin = base.nodes.find((n) => n.id === originNodeId("codex"))!;
      const next = layoutScene(roots(4));
      const slot = next.nodes.find((n) => n.id === id(4))!;
      rig.show(roots(4));

      const el = rig.els.get(id(4))!;
      expect(el.dataset["fresh"]).toBe("");
      const start = rig.at(id(4));
      const originNow = rig.at(originNodeId("codex"));
      expect(start.x).toBeCloseTo(originNow.x + origin.w * 0.4, 1);
      expect(Math.hypot(start.x - slot.x, start.y - slot.y)).toBeGreaterThan(100);
      const target = { x: rig.at(id(3)).x + NODE.stagger, y: rig.at(id(3)).y + ROW };
      expect(Math.hypot(start.x - target.x, start.y - target.y)).toBeGreaterThan(100);
      settle();
      expect(rig.at(id(4))).toEqual(target);
    });

    it("减少动效：直接到位，没有入场标记", () => {
      const media = { matches: true, media: "", onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() };
      vi.spyOn(window, "matchMedia").mockReturnValue(media as unknown as MediaQueryList);
      rig = build();
      rig.show(roots(3));
      rig.engine.moveNode(id(3), 500, 0);
      const dragged = rig.at(id(3));
      rig.show(roots(4));
      // 一步都没推进：已经在落点上。
      expect(rig.at(id(4))).toEqual({ x: dragged.x + NODE.stagger, y: dragged.y + ROW });
      expect(rig.els.get(id(4))!.dataset["fresh"]).toBeUndefined();
    });

    it("没有拖拽时的出现动效不变：仍然从上游长出来，落在默认槽位", () => {
      rig = build();
      rig.show(roots(3));
      settle();
      const layout = rig.show(roots(4));
      expect(rig.els.get(id(4))!.dataset["fresh"]).toBe("");
      settle();
      const home = layout.nodes.find((n) => n.id === id(4))!;
      expect(rig.at(id(4))).toEqual({ x: home.x, y: home.y });
    });
  });
});
