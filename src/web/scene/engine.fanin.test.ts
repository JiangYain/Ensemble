import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@shared/types";
import { edge, mountScene, node, sceneOf, type SceneRig } from "./engine.fixtures";
import { agentNodeId, layoutScene, type LayoutEdge, type LayoutNode } from "./layout";
import { session } from "./layout.fixtures";
import { pipePath, pipePriority } from "./pipes";

/**
 * 汇聚（一个会话跟随几个上级）到了画布引擎这一层：每个上级到它各有一条线、各自从上级的出口出发，
 * 在同一个落点汇入，落点上只有一个方点。线的几何、方点的显隐都不为汇聚改动——这里只验证“几条线指向同一个节点”这种输入
 * 被如实画出来（对称的“从同一点扇出”见 engine.pipes.test.ts）。
 */

interface Harness extends SceneRig {
  relayout: (nodes?: LayoutNode[], edges?: LayoutEdge[]) => void;
}

function build(nodes: LayoutNode[], edges: LayoutEdge[]): Harness {
  const rig = mountScene(sceneOf(nodes, edges));
  let current = { nodes, edges };
  const relayout = (nextNodes: LayoutNode[] = current.nodes, nextEdges: LayoutEdge[] = current.edges): void => {
    current = { nodes: nextNodes, edges: nextEdges };
    rig.engine.setLayout(sceneOf(nextNodes, nextEdges));
  };
  return { ...rig, relayout };
}

const numbersOf = (text: string): number[] => (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
const pathsOf = (h: Harness): string[] => [...h.tube.querySelectorAll("path")].map((path) => path.getAttribute("d") ?? "");
const startOf = (d: string): [number, number] => {
  const n = numbersOf(d);
  return [n[0]!, n[1]!];
};
const endOf = (d: string): [number, number] => {
  const n = numbersOf(d);
  return [n.at(-2)!, n.at(-1)!];
};

/** 已点亮的方点所在的边（排序后）。 */
const lit = (el: HTMLElement): string[] =>
  [...el.querySelectorAll<HTMLElement>(":scope > .node-port[data-on]")].map((dot) => dot.getAttribute("data-side")!).sort();
const dotOf = (el: HTMLElement, side: string): HTMLElement => el.querySelector<HTMLElement>(`:scope > .node-port[data-side="${side}"]`)!;
const translateOf = (el: HTMLElement): [number, number] => {
  const [x, y] = el.style.translate.split(" ").map((part) => Number.parseFloat(part));
  return [x!, y!];
};
/** 方点中心（世界坐标）：节点位置 + 方点的落点变量。 */
const centreOf = (el: HTMLElement, side: string): [number, number] => {
  const [x, y] = translateOf(el);
  const dot = dotOf(el, side);
  return [x + Number.parseFloat(dot.style.getPropertyValue("--port-x")), y + Number.parseFloat(dot.style.getPropertyValue("--port-y"))];
};

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  localStorage.clear();
});

describe("连线 · 汇聚：几个上级连到同一个会话", () => {
  it("各从自己的右缘出发，在会话左缘的同一个落点汇入，那里只有一个方点", () => {
    // 212 × 112 的默认卡片：a、b 的出口在 (212, -144) 与 (212, 316)，j 的入口在 (400, 86)。
    const h = build([node("a", 0, -200), node("b", 0, 260), node("j", 400, 30)], [edge("a", "j"), edge("b", "j")]);
    try {
      const paths = pathsOf(h);
      expect(paths).toHaveLength(2);
      for (const d of paths) expect(endOf(d)).toEqual([400, 86]);
      expect(paths.map(startOf).sort((p, q) => p[1] - q[1])).toEqual([
        [212, -144],
        [212, 316],
      ]);
      expect(lit(h.els.get("j")!)).toEqual(["left"]);
      expect(h.els.get("j")!.querySelectorAll(".node-port[data-on]")).toHaveLength(1);
      expect(centreOf(h.els.get("j")!, "left")).toEqual([400, 86]);
      for (const id of ["a", "b"]) expect(lit(h.els.get(id)!), id).toEqual(["right"]);
    } finally {
      h.engine.unmount();
    }
  });

  it("方点的颜色取接着的几条线里最活跃的阶段：汇聚的会话在运行，上级已经结束，落点仍是运行的颜色", () => {
    const h = build([node("a", 0, -200), node("b", 0, 260), node("j", 400, 30)], [edge("a", "j", "done"), edge("b", "j", "running")]);
    try {
      expect(dotOf(h.els.get("j")!, "left").getAttribute("data-phase")).toBe("running");
    } finally {
      h.engine.unmount();
    }
  });

  it("少了一个上级（那条线拆掉）：落点上的方点留着、那个上级的出口方点熄灭，剩下的那条不变", () => {
    const nodes = [node("a", 0, -200), node("b", 0, 260), node("j", 400, 30)];
    const h = build(nodes, [edge("a", "j"), edge("b", "j")]);
    try {
      const before = pathsOf(h).find((d) => startOf(d)[1] === -144);
      h.relayout(nodes, [edge("a", "j")]);

      expect(pathsOf(h)).toEqual([before]);
      expect(lit(h.els.get("j")!)).toEqual(["left"]);
      expect(lit(h.els.get("a")!)).toEqual(["right"]);
      expect(lit(h.els.get("b")!)).toEqual([]);
      h.relayout(nodes, []);
      expect(pathsOf(h)).toEqual([]);
      expect(lit(h.els.get("j")!)).toEqual([]);
    } finally {
      h.engine.unmount();
    }
  });
});

describe("连线 · 汇聚：真实的布局", () => {
  const sessionsOf = (...extra: SessionSummary[]): SessionSummary[] => [session("r", "main", 1), ...extra];
  const under = (id: string, order: number, parents: readonly string[], depth: number): SessionSummary =>
    session(id, "main", order, { parentSessionId: parents[0]!, ...(parents.length > 1 ? { parentSessionIds: [...parents] } : {}), depth });

  const scenes: Record<string, SessionSummary[]> = {
    // R 之下并行的 A、B，再由 J 汇总。
    diamond: sessionsOf(under("a", 2, ["r"], 1), under("b", 3, ["r"], 1), under("j", 4, ["a", "b"], 2)),
    // J 的主上级 X 在第 0 列、另一个上级 A 在第 1 列：J 被推到第 2 列。
    pushed: [session("x", "main", 1), session("r", "main", 2), under("a", 3, ["r"], 1), under("j", 4, ["x", "a"], 2)],
  };
  const areas = [undefined, { w: 1168, h: 656 }, { w: 480, h: 700 }];

  for (const [name, sessions] of Object.entries(scenes)) {
    it(`${name}：每条线（含补的那条）逐字节同默认的从左到右算法，汇聚的会话左边只有一个方点`, () => {
      for (const area of areas) {
        const layout = layoutScene(sessions, area ? { area } : {});
        const h = build(layout.nodes, layout.edges);
        try {
          const where = JSON.stringify(area);
          const byId = new Map(layout.nodes.map((n) => [n.id, n]));
          const paths = pathsOf(h);
          const ordered = [...layout.edges].sort((a, b) => pipePriority(a.phase) - pipePriority(b.phase) || (a.id < b.id ? -1 : 1));
          expect(paths, where).toHaveLength(layout.edges.length);
          ordered.forEach((e, index) => {
            const from = byId.get(e.from)!;
            const to = byId.get(e.to)!;
            expect(paths[index], `${e.id} ${where}`).toBe(pipePath({ x: from.x + from.w, y: from.y + from.h / 2 }, { x: to.x, y: to.y + to.h / 2 }));
          });
          const join = byId.get(agentNodeId("j"))!;
          expect(layout.edges.filter((e) => e.to === join.id), where).toHaveLength(2);
          expect(lit(h.els.get(join.id)!), where).toEqual(["left"]);
          expect(centreOf(h.els.get(join.id)!, "left"), where).toEqual([join.x, join.y + join.h / 2]);
        } finally {
          h.engine.unmount();
          document.body.replaceChildren();
        }
      }
    });
  }
});
