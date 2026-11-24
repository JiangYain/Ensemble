import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@shared/types";
import { edge, mountScene, node, origin, sceneOf, type SceneRig } from "./engine.fixtures";
import { layoutScene, type LayoutEdge, type LayoutNode } from "./layout";
import { pipePath, pipePriority, ROUTE } from "./pipes";

interface Harness extends SceneRig {
  /** 用同一批节点（或换一批）重新布局。 */
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
const onlyPath = (h: Harness): string => {
  const paths = pathsOf(h);
  expect(paths).toHaveLength(1);
  return paths[0]!;
};
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
const near = (a: [number, number], b: [number, number]): boolean => Math.abs(a[0] - b[0]) < 0.011 && Math.abs(a[1] - b[1]) < 0.011;

/**
 * 方点与连线端点互为充要：每个点亮的方点中心上都有某条连线的端点，每条连线的两个端点上都有点亮的方点。
 * 只在稳态（没有换边过渡）时成立。
 */
function expectDotsMatchPipes(h: Harness, where = ""): void {
  const ends: [number, number][] = pathsOf(h).flatMap((d) => [startOf(d), endOf(d)]);
  const centres: [number, number][] = [];
  for (const el of h.els.values()) for (const side of lit(el)) centres.push(centreOf(el, side));
  for (const c of centres) expect(ends.some((p) => near(p, c)), `${where} 方点 ${c} 上没有连线端点`).toBe(true);
  for (const p of ends) expect(centres.some((c) => near(p, c)), `${where} 端点 ${p} 上没有方点`).toBe(true);
}

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

describe("连线 · 默认的从左到右不变", () => {
  it("路径逐字节不变，方点只在连线接着的两个落点上，中心就是线端", () => {
    const h = build([origin("origin:one", 0, 30), node("agent:one", 310, 14, { h: 144 })], [edge("origin:one", "agent:one")]);
    try {
      expect(onlyPath(h)).toBe("M212 86C261 86 261 86 310 86");
      expect(lit(h.els.get("origin:one")!)).toEqual(["right"]);
      expect(lit(h.els.get("agent:one")!)).toEqual(["left"]);
      expect(centreOf(h.els.get("origin:one")!, "right")).toEqual([212, 86]);
      expect(centreOf(h.els.get("agent:one")!, "left")).toEqual([310, 86]);
      expect(dotOf(h.els.get("origin:one")!, "right").style.getPropertyValue("--port-x")).toBe("212px");
      expect(dotOf(h.els.get("origin:one")!, "right").style.getPropertyValue("--port-y")).toBe("56px");
      expect(dotOf(h.els.get("agent:one")!, "left").style.getPropertyValue("--port-x")).toBe("0px");
      expect(dotOf(h.els.get("agent:one")!, "left").style.getPropertyValue("--port-y")).toBe("72px");
      // 运行中：线的两端都是 teal；以前只有会话卡左边的那一个。
      expect(dotOf(h.els.get("agent:one")!, "left").getAttribute("data-phase")).toBe("running");
      expect(dotOf(h.els.get("origin:one")!, "right").getAttribute("data-phase")).toBe("running");
      expectDotsMatchPipes(h);
    } finally {
      h.engine.unmount();
    }
  });

  it("真实布局（多种形态 × 取景区域 × Git 分组）：每条连线逐字节同旧算法，方点只在真有连线接着的边上，中心在卡片外缘的竖直中点", () => {
    const session = (id: string, key: string, order: number, extra: Partial<SessionSummary> = {}, workspace?: string): SessionSummary =>
      ({
        id,
        origin: workspace === undefined ? { key } : { key, workspace },
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, order)).toISOString(),
        phase: "running",
        ...extra,
      }) as unknown as SessionSummary;
    const REPO = "C:\\Users\\alice\\Desktop\\Ensemble";
    const shapes: SessionSummary[][] = [
      [session("a", "codex", 1)],
      [session("a", "codex", 1), session("a1", "codex", 2, { parentSessionId: "a", phase: "done" }), session("a2", "codex", 3, { parentSessionId: "a1", phase: "failed" }), session("b", "codex", 4, { phase: "starting" })],
      [session("a", "codex", 1, {}, REPO), session("b", "cursor", 2, {}, REPO), session("c", "pi", 3, {}, REPO), session("d", "claude", 4, {}, "C:\\work\\other")],
      [session("a", "codex", 1, {}, REPO), session("a1", "codex", 2, { parentSessionId: "a" }, REPO), session("z", "cursor", 3), session("y", "pi", 4)],
    ];
    const gits: ReadonlyMap<string, string>[] = [new Map(), new Map([["codex", "repo"], ["cursor", "repo"], ["pi", "repo"]])];
    const areas = [undefined, { w: 1168, h: 656 }, { w: 480, h: 700 }];
    let edges = 0;
    for (const sessions of shapes) {
      for (const git of gits) {
        for (const area of areas) {
          const layout = layoutScene(sessions, { ...(area ? { area } : {}), git });
          const h = build(layout.nodes, layout.edges);
          try {
            const where = `${JSON.stringify([...git])} ${JSON.stringify(area)}`;
            const byId = new Map(layout.nodes.map((n) => [n.id, n]));
            const paths = pathsOf(h);
            const ordered = [...layout.edges].sort((a, b) => pipePriority(a.phase) - pipePriority(b.phase) || (a.id < b.id ? -1 : 1));
            expect(paths).toHaveLength(ordered.length);
            ordered.forEach((e, index) => {
              const from = byId.get(e.from)!;
              const to = byId.get(e.to)!;
              // 出线在来源右缘的竖直中点，进线在目标左缘的竖直中点。
              const a = { x: from.x + from.w, y: from.y + from.h / 2 };
              const b = { x: to.x, y: to.y + to.h / 2 };
              expect(paths[index], `${e.id} ${where}`).toBe(pipePath(a, b));
              edges += 1;
            });
            // 方点只在真有连线接着的边上：左边有进线才有、右边有出线才有；中心在卡片外缘、竖直中点。
            // 真实布局里每个会话卡都有进线，其余三种卡片都有出线。
            for (const n of layout.nodes) {
              const el = h.els.get(n.id)!;
              const left = layout.edges.some((e) => e.to === n.id);
              const right = layout.edges.some((e) => e.from === n.id);
              if (n.kind === "agent") expect(left, `${n.id} ${where}`).toBe(true);
              else expect(right, `${n.id} ${where}`).toBe(true);
              expect(lit(el), `${n.id} ${where}`).toEqual([...(left ? ["left"] : []), ...(right ? ["right"] : [])].sort());
              if (left) expect(centreOf(el, "left")).toEqual([n.x, n.y + n.h / 2]);
              if (right) expect(centreOf(el, "right")).toEqual([n.x + n.w, n.y + n.h / 2]);
              if (n.kind === "agent") {
                const incoming = layout.edges.find((e) => e.to === n.id)!;
                expect(dotOf(el, "left").getAttribute("data-phase"), `${n.id} ${where}`).toBe(incoming.phase);
              }
            }
            expectDotsMatchPipes(h, where);
          } finally {
            h.engine.unmount();
            document.body.replaceChildren();
          }
        }
      }
    }
    expect(edges).toBeGreaterThan(100);
  });
});

describe("连线 · 目标在来源的左边 / 上方 / 下方", () => {
  it("目标在左边：从来源的左缘出发、进入目标的右缘，是向右的镜像 S 形；方点跟着换到左右两边", () => {
    const h = build([origin("origin:one", 400, 30), node("agent:one", 0, 14, { w: 248, h: 144 })], [edge("origin:one", "agent:one")]);
    try {
      expect(onlyPath(h)).toBe("M400 86C324 86 324 86 248 86");
      expect(lit(h.els.get("origin:one")!)).toEqual(["left"]);
      expect(lit(h.els.get("agent:one")!)).toEqual(["right"]);
      expect(centreOf(h.els.get("origin:one")!, "left")).toEqual([400, 86]);
      expect(centreOf(h.els.get("agent:one")!, "right")).toEqual([248, 86]);
      // 流动的点沿来源 → 目标走：渐变从来源端（右）指向目标端（左）。
      const gradient = h.dots.querySelector("linearGradient")!;
      expect([gradient.getAttribute("x1"), gradient.getAttribute("x2")]).toEqual(["400", "248"]);
      expectDotsMatchPipes(h);
    } finally {
      h.engine.unmount();
    }
  });

  it("目标在正下方 / 正上方（水平范围重叠）：走上下边的中点，竖向的 S 形", () => {
    const below = build([origin("origin:one", 0, 30), node("agent:one", 20, 300)], [edge("origin:one", "agent:one")]);
    try {
      expect(onlyPath(below)).toBe("M106 142C106 221 126 221 126 300");
      expect(lit(below.els.get("origin:one")!)).toEqual(["bottom"]);
      expect(lit(below.els.get("agent:one")!)).toEqual(["top"]);
      expectDotsMatchPipes(below);
    } finally {
      below.engine.unmount();
      document.body.replaceChildren();
    }
    const above = build([origin("origin:one", 0, 30), node("agent:one", 20, -300)], [edge("origin:one", "agent:one")]);
    try {
      expect(onlyPath(above)).toBe("M106 30C106 -79 126 -79 126 -188");
      expect(lit(above.els.get("origin:one")!)).toEqual(["top"]);
      expect(lit(above.els.get("agent:one")!)).toEqual(["bottom"]);
      expectDotsMatchPipes(above);
    } finally {
      above.engine.unmount();
    }
  });

  it("布局里没有进线的节点被连线接到左边时：方点落在左缘的竖直中点上", () => {
    // Git 卡左边平时没有连线；来源在它的右边时，从 Git 的左缘出发。
    const h = build([node("git:one", 500, 30, { kind: "git" }), origin("origin:one", 0, 30)], [edge("git:one", "origin:one", "link")]);
    try {
      expect(onlyPath(h)).toBe("M500 86C356 86 356 86 212 86");
      expect(lit(h.els.get("git:one")!)).toEqual(["left"]);
      expect(lit(h.els.get("origin:one")!)).toEqual(["right"]);
      expect(dotOf(h.els.get("git:one")!, "left").style.getPropertyValue("--port-y")).toBe("56px");
      expectDotsMatchPipes(h);
    } finally {
      h.engine.unmount();
    }
  });

  it("同一个落点上有几条连线：从同一点扇出，方点只有一个", () => {
    const h = build(
      [origin("origin:one", 0, 30), node("a", 400, -200), node("b", 400, 30), node("c", 400, 260)],
      [edge("origin:one", "a"), edge("origin:one", "b"), edge("origin:one", "c")],
    );
    try {
      const paths = pathsOf(h);
      expect(paths).toHaveLength(3);
      for (const d of paths) expect(startOf(d)).toEqual([212, 86]);
      expect(lit(h.els.get("origin:one")!)).toEqual(["right"]);
      expect(h.els.get("origin:one")!.querySelectorAll(".node-port[data-on]")).toHaveLength(1);
      for (const id of ["a", "b", "c"]) expect(lit(h.els.get(id)!)).toEqual(["left"]);
      expectDotsMatchPipes(h);
    } finally {
      h.engine.unmount();
    }
  });
});

describe("连线 · 端口方点的显隐与颜色", () => {
  it("颜色取接着的连线里最活跃的阶段（running > failed > starting/queued > done > 其余）；连线拆掉，方点熄灭", () => {
    const nodes = [origin("origin:one", 0, 30), node("a", 400, -200), node("b", 400, 30), node("c", 400, 260)];
    const h = build(nodes, [edge("origin:one", "a", "done"), edge("origin:one", "b", "running"), edge("origin:one", "c", "failed")]);
    try {
      const right = dotOf(h.els.get("origin:one")!, "right");
      expect(right.getAttribute("data-phase")).toBe("running");
      h.relayout(nodes, [edge("origin:one", "a", "done"), edge("origin:one", "c", "failed")]);
      expect(right.getAttribute("data-phase")).toBe("failed");
      h.relayout(nodes, [edge("origin:one", "a", "done"), edge("origin:one", "c", "queued")]);
      expect(right.getAttribute("data-phase")).toBe("queued");
      h.relayout(nodes, [edge("origin:one", "a", "done"), edge("origin:one", "c", "link")]);
      expect(right.getAttribute("data-phase")).toBe("done");
      h.relayout(nodes, [edge("origin:one", "c", "link")]);
      expect(right.getAttribute("data-phase")).toBe("link");
      // c 没有连线进来了（其余节点也是）：它的方点熄灭。
      expect(lit(h.els.get("a")!)).toEqual([]);
      expect(lit(h.els.get("b")!)).toEqual([]);
      expect(lit(h.els.get("c")!)).toEqual(["left"]);
      h.relayout(nodes, []);
      for (const el of h.els.values()) expect(lit(el)).toEqual([]);
      expect(pathsOf(h)).toEqual([]);
      h.relayout(nodes, [edge("origin:one", "a", "done")]);
      expect(lit(h.els.get("origin:one")!)).toEqual(["right"]);
      expect(lit(h.els.get("a")!)).toEqual(["left"]);
    } finally {
      h.engine.unmount();
    }
  });

  it("节点上、下、左、右的方点各管一边：同一个节点同时接着几条边时，各自点亮", () => {
    // 中间的来源：右边连着会话，左边被 Git 接着，下面还有一个叠在下方的会话。
    const nodes = [node("git:one", -420, 30, { kind: "git" }), origin("origin:one", 0, 30), node("agent", 400, 30), node("below", 20, 300)];
    const h = build(nodes, [edge("git:one", "origin:one", "link"), edge("origin:one", "agent"), edge("origin:one", "below", "failed")]);
    try {
      expect(lit(h.els.get("origin:one")!)).toEqual(["bottom", "left", "right"]);
      expect(dotOf(h.els.get("origin:one")!, "left").getAttribute("data-phase")).toBe("link");
      expect(dotOf(h.els.get("origin:one")!, "right").getAttribute("data-phase")).toBe("running");
      expect(dotOf(h.els.get("origin:one")!, "bottom").getAttribute("data-phase")).toBe("failed");
      expect(lit(h.els.get("below")!)).toEqual(["top"]);
      expectDotsMatchPipes(h);
    } finally {
      h.engine.unmount();
    }
  });
});

describe("连线 · 拖动时换边：滞回、过渡、减少动效", () => {
  const source = (): LayoutNode => origin("origin:one", 0, 30);
  /** 目标在来源的右下方：竖向空隙 38（够走 DOWN），横向的位置由测试挪动。 */
  const target = (x: number): LayoutNode => node("agent:one", x, 180);

  const moveTo = (h: Harness, x: number): void => {
    const [current] = translateOf(h.els.get("agent:one")!);
    h.engine.moveNode("agent:one", x - current, 0);
  };
  const sideOfSource = (h: Harness): string => lit(h.els.get("origin:one")!).join("+");

  it("向左拖过去：RIGHT → DOWN 在水平空隙 < 6（x = 217），再到空隙 ≥ 24（x = -236）才变 LEFT；回程的切换点是 -217 与 236", () => {
    const h = build([source(), target(600)], [edge("origin:one", "agent:one")]);
    try {
      moveTo(h, 240);
      expect(sideOfSource(h)).toBe("right");
      const flips: [number, string][] = [];
      let last = sideOfSource(h);
      for (let x = 240; x >= -300; x -= 1) {
        moveTo(h, x);
        const side = sideOfSource(h);
        if (side !== last) flips.push([x, `${last}>${side}`]);
        last = side;
      }
      expect(flips).toEqual([
        [217, "right>bottom"],
        [-236, "bottom>left"],
      ]);
      const back: [number, string][] = [];
      for (let x = -300; x <= 600; x += 1) {
        moveTo(h, x);
        const side = sideOfSource(h);
        if (side !== last) back.push([x, `${last}>${side}`]);
        last = side;
      }
      expect(back).toEqual([
        [-217, "left>bottom"],
        [236, "bottom>right"],
      ]);
    } finally {
      h.engine.unmount();
    }
  });

  it("停在切换点附近来回抖动：连线只换一次边，不会闪", () => {
    const h = build([source(), target(600)], [edge("origin:one", "agent:one")]);
    try {
      const seen: string[] = [];
      for (const x of [230, 219, 216, 221, 217, 224, 215, 226, 218, 214, 223, 217.5, 218.5, 219.5, 216.5]) {
        moveTo(h, x);
        seen.push(sideOfSource(h));
      }
      const flips = seen.filter((side, i) => i > 0 && side !== seen[i - 1]).length;
      expect(flips).toBe(1);
      expect(seen[0]).toBe("right");
      expect(seen.at(-1)).toBe("bottom");
    } finally {
      h.engine.unmount();
    }
  });

  it("换边的过渡：第一帧端点不跳，之后每帧位移不超过总位移均值的 1.5 倍，0.24 s 后与新路线逐位相同", () => {
    const h = build([source(), target(240)], [edge("origin:one", "agent:one")]);
    try {
      expect(sideOfSource(h)).toBe("right");
      expect(onlyPath(h)).toBe(pipePath({ x: 212, y: 86 }, { x: 240, y: 236 }));
      const before = onlyPath(h);
      moveTo(h, 217); // 越过门槛：RIGHT → DOWN
      expect(sideOfSource(h)).toBe("bottom");
      const first = onlyPath(h);
      // 这一刻画面上的曲线就是上一帧画着的那条（端点没有跳），过渡才刚开始。
      expect(startOf(first)).toEqual(startOf(before));
      expect(endOf(first)).toEqual(endOf(before));

      const frames: string[] = [first];
      for (let i = 0; i < 24; i++) {
        vi.advanceTimersByTime(16);
        frames.push(onlyPath(h));
      }
      const steps = Math.round((ROUTE.morph * 1000) / 16);
      const total = Math.max(Math.hypot(106 - 212, 142 - 86), Math.hypot(323 - 240, 180 - 236));
      let worst = 0;
      for (let i = 1; i < frames.length; i++) {
        const [ax, ay] = startOf(frames[i - 1]!);
        const [bx, by] = startOf(frames[i]!);
        const [cx, cy] = endOf(frames[i - 1]!);
        const [dx, dy] = endOf(frames[i]!);
        worst = Math.max(worst, Math.hypot(bx - ax, by - ay), Math.hypot(dx - cx, dy - cy));
      }
      // 总位移约 120；没有过渡的话一帧就跳完。
      expect(worst).toBeLessThanOrEqual((1.5 * total) / steps + 1);
      expect(worst).toBeLessThan(total / 5);
      // 过渡结束：与新路线（DOWN，来源下缘中点 → 目标上缘中点）逐位相同。
      expect(frames.at(-1)).toBe("M106 142C106 161 323 161 323 180");
      expect(frames[Math.round(steps / 2)]).not.toBe(frames.at(-1));
      expectDotsMatchPipes(h);
    } finally {
      h.engine.unmount();
    }
  });

  it("过渡期间节点继续被拖动：两端始终贴着各自的节点，没有 NaN", () => {
    const h = build([source(), target(240)], [edge("origin:one", "agent:one")]);
    try {
      moveTo(h, 217);
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(16);
        moveTo(h, 217 - i * 7);
        expect(onlyPath(h)).not.toMatch(/NaN|Infinity/);
      }
      vi.advanceTimersByTime(1000);
      const [x] = translateOf(h.els.get("agent:one")!);
      expect(x).toBe(182);
      expect(onlyPath(h)).toBe(`M106 142C106 161 ${x + 106} 161 ${x + 106} 180`);
    } finally {
      h.engine.unmount();
    }
  });

  it("过渡中又换边：从眼下画着的曲线接着过渡，不回跳", () => {
    const h = build([source(), target(240)], [edge("origin:one", "agent:one")]);
    try {
      moveTo(h, 217); // RIGHT → DOWN，过渡开始
      vi.advanceTimersByTime(48);
      const mid = onlyPath(h);
      moveTo(h, 240); // 在过渡中途：DOWN → RIGHT（水平空隙 28 ≥ 24）
      expect(sideOfSource(h)).toBe("right");
      const after = onlyPath(h);
      expect(startOf(after)).toEqual(startOf(mid));
      expect(endOf(after)).toEqual(endOf(mid));
      vi.advanceTimersByTime(1000);
      expect(onlyPath(h)).toBe(pipePath({ x: 212, y: 86 }, { x: 240, y: 236 }));
    } finally {
      h.engine.unmount();
    }
  });

  it("减少动效：换边直接到位，没有过渡", () => {
    const media = { matches: true, media: "", onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() };
    vi.spyOn(window, "matchMedia").mockReturnValue(media as unknown as MediaQueryList);
    const h = build([source(), target(240)], [edge("origin:one", "agent:one")]);
    try {
      moveTo(h, 217);
      expect(sideOfSource(h)).toBe("bottom");
      expect(onlyPath(h)).toBe("M106 142C106 161 323 161 323 180");
      expectDotsMatchPipes(h);
    } finally {
      h.engine.unmount();
    }
  });

  it("稳态下方点与线端始终重合（扫过 8 个方向、近与远）", () => {
    const h = build([source(), target(600)], [edge("origin:one", "agent:one")]);
    try {
      const spots: [number, number][] = [
        [700, 30], [700, 330], [240, 400], [-10, 400], [-420, 330], [-420, 30], [-420, -330], [10, -330], [700, -330],
        [330, 40], [-130, 200], [-130, -140], [330, -140], [250, 30], [-250, 30],
      ];
      for (const [x, y] of spots) {
        const [cx, cy] = translateOf(h.els.get("agent:one")!);
        h.engine.moveNode("agent:one", x - cx, y - cy);
        vi.advanceTimersByTime(600);
        expect(onlyPath(h), `${x},${y}`).not.toMatch(/NaN|Infinity/);
        expectDotsMatchPipes(h, `${x},${y}`);
      }
    } finally {
      h.engine.unmount();
    }
  });
});

describe("连线 · 弹簧动画与新节点", () => {
  it("新节点从上游“长”出来的过程中，连线不换边，方点不闪", () => {
    const first = [origin("origin:one", 0, 30), node("a", 310, 30)];
    const h = build(first, [edge("origin:one", "a")]);
    try {
      const next = [...first, node("b", 310, 430), node("c", 310, 560)];
      h.attach("b");
      h.attach("c");
      h.relayout(next, [edge("origin:one", "a"), edge("origin:one", "b"), edge("origin:one", "c")]);
      const seen = new Set<string>();
      for (let i = 0; i < 60; i++) {
        seen.add(lit(h.els.get("origin:one")!).join("+"));
        seen.add(lit(h.els.get("b")!).join("+"));
        for (const d of pathsOf(h)) expect(d).not.toMatch(/NaN|Infinity/);
        vi.advanceTimersByTime(16);
      }
      expect([...seen].sort()).toEqual(["left", "right"]);
      expect(pathsOf(h)).toContain("M212 86C261 86 261 486 310 486");
    } finally {
      h.engine.unmount();
    }
  });
});

describe("连线 · 复用、卸载与写入", () => {
  it("节点元素卸载：它的方点一并拿走；换一个元素注册，方点跟着连线重新点亮", () => {
    const h = build([origin("origin:one", 0, 30), node("agent:one", 310, 14)], [edge("origin:one", "agent:one")]);
    try {
      const old = h.els.get("agent:one")!;
      expect(old.querySelectorAll(".node-port")).toHaveLength(4);
      h.releases.get("agent:one")!();
      expect(old.querySelectorAll(".node-port")).toHaveLength(0);
      const fresh = document.createElement("div");
      fresh.dataset["nodeId"] = "agent:one";
      document.body.append(fresh);
      h.engine.register("agent:one", fresh);
      expect(fresh.querySelectorAll(".node-port")).toHaveLength(4);
      h.relayout();
      expect(lit(fresh)).toEqual(["left"]);
      expect(centreOf(fresh, "left")).toEqual([310, 70]);
    } finally {
      h.engine.unmount();
    }
  });

  it("同一个元素重复注册不会重复放方点", () => {
    const h = build([origin("origin:one", 0, 30), node("agent:one", 310, 14)], [edge("origin:one", "agent:one")]);
    try {
      const el = h.els.get("agent:one")!;
      h.engine.register("agent:one", el);
      h.engine.register("agent:one", el);
      expect(el.querySelectorAll(".node-port")).toHaveLength(4);
    } finally {
      h.engine.unmount();
    }
  });

  it("引擎卸载：连线拆掉，方点熄灭；节点元素还在，重新挂载后再点亮", () => {
    const nodes = [origin("origin:one", 0, 30), node("agent:one", 310, 14)];
    const h = build(nodes, [edge("origin:one", "agent:one")]);
    const el = h.els.get("agent:one")!;
    expect(lit(el)).toEqual(["left"]);
    h.engine.unmount();
    expect(lit(el)).toEqual([]);
    expect(lit(h.els.get("origin:one")!)).toEqual([]);
    expect(el.querySelectorAll(".node-port")).toHaveLength(4);
    expect(pathsOf(h)).toEqual([]);
  });

  it("没有变化就不写 DOM：重复布局、挪动无关的节点，连线的 d 与渐变都不再被写", () => {
    const nodes = [origin("origin:one", 0, 30), node("agent:one", 310, 14), node("lonely", 0, 600)];
    const h = build(nodes, [edge("origin:one", "agent:one")]);
    try {
      const path = h.tube.querySelector("path")!;
      const gradient = h.dots.querySelector("linearGradient")!;
      const pathWrites = vi.spyOn(path, "setAttribute");
      const gradientWrites = vi.spyOn(gradient, "setAttribute");
      const dWrites = (): number => pathWrites.mock.calls.filter(([name]) => name === "d").length;
      for (let i = 0; i < 5; i++) h.relayout();
      expect(dWrites()).toBe(0);
      expect(gradientWrites).not.toHaveBeenCalled();
      h.engine.moveNode("lonely", 40, 0);
      vi.advanceTimersByTime(100);
      expect(dWrites()).toBe(0);
      expect(gradientWrites).not.toHaveBeenCalled();
      h.engine.moveNode("agent:one", 0, 30);
      expect(dWrites()).toBe(1);
      expect(gradientWrites).toHaveBeenCalledTimes(4); // 端点变了：四个属性一起写
      vi.advanceTimersByTime(100);
      expect(dWrites()).toBe(1);
    } finally {
      h.engine.unmount();
    }
  });

  it("节点叠在一起、尺寸为 0、位置重合：不抛错，路径里没有 NaN，两端仍落在方点上", () => {
    const h = build(
      [origin("origin:one", 100, 100), node("same", 100, 100), node("zero", 100, 100, { w: 0, h: 0 }), node("part", 180, 120)],
      [edge("origin:one", "same"), edge("origin:one", "zero"), edge("origin:one", "part"), edge("zero", "same")],
    );
    try {
      for (const d of pathsOf(h)) {
        expect(d).not.toMatch(/NaN|Infinity/);
        expect(d).toMatch(/^M-?[\d.]+ -?[\d.]+C(-?[\d.]+ -?[\d.]+ ){2}-?[\d.]+ -?[\d.]+$/);
      }
      expectDotsMatchPipes(h);
      for (const gradient of [...h.dots.querySelectorAll("linearGradient")]) {
        for (const name of ["x1", "y1", "x2", "y2"]) expect(Number.isFinite(Number(gradient.getAttribute(name)))).toBe(true);
      }
    } finally {
      h.engine.unmount();
    }
  });
});

describe("连线 · 用户截图里的场景：节点拖到各自来源的左边", () => {
  it("会话 ← Main Agent(Codex) ← Git ← …，Git → Main Agent(Cursor) → 会话：每条线一个平滑的 S，端点都落在方点上，没有环", () => {
    const sessions = [0, 1, 2, 3].map((i) => node(`s${i}`, 0, i * 130));
    const nodes = [
      ...sessions,
      origin("origin:codex", 300, 195),
      node("git:one", 600, 195, { kind: "git" }),
      origin("origin:cursor", 900, 195),
      ...[0, 1, 2, 3].map((i) => node(`c${i}`, 1200, i * 130)),
    ];
    const edges = [
      ...sessions.map((s) => edge("origin:codex", s.id)),
      edge("git:one", "origin:codex", "link"),
      edge("git:one", "origin:cursor", "link"),
      ...[0, 1, 2, 3].map((i) => edge("origin:cursor", `c${i}`, "done")),
    ];
    const h = build(nodes, edges);
    try {
      const paths = pathsOf(h);
      expect(paths).toHaveLength(edges.length);
      // Git → Codex：Codex 在 Git 的左边：从 Git 的左缘出发，进入 Codex 的右缘。
      expect(paths).toContain("M600 251C556 251 556 251 512 251");
      // Git → Cursor：照旧向右。
      expect(paths).toContain("M812 251C856 251 856 251 900 251");
      // Codex → 会话：会话在 Codex 的左边。
      for (const s of sessions) expect(paths).toContain(pipePath({ x: 300, y: 251 }, { x: s.x + 212, y: s.y + 56 }));
      // Cursor → 会话：照旧向右（起点是 Cursor 来源卡的右缘 x = 1112）。
      expect(paths.filter((d) => startOf(d)[0] === 1112)).toHaveLength(4);
      for (const d of paths) {
        expect(d).not.toMatch(/NaN|Infinity/);
        expect((d.match(/C/g) ?? []).length, d).toBe(1);
      }
      expect(lit(h.els.get("origin:codex")!)).toEqual(["left", "right"]);
      expect(lit(h.els.get("git:one")!)).toEqual(["left", "right"]);
      expect(lit(h.els.get("origin:cursor")!)).toEqual(["left", "right"]);
      expect(lit(h.els.get("s0")!)).toEqual(["right"]);
      expect(lit(h.els.get("c0")!)).toEqual(["left"]);
      expectDotsMatchPipes(h);
    } finally {
      h.engine.unmount();
    }
  });
});

describe("端口方点的样式契约（scene.css）", () => {
  const css = readFileSync("src/web/styles/scene.css", "utf8");

  it(".node-port：6×6 方点，中心压在落点上（left / top 减 4px = 1px 边框 + 3px 半边长），熄灭时不可见", () => {
    const rule = /^\.node-port \{([^}]*)\}/m.exec(css);
    expect(rule).not.toBeNull();
    const body = rule![1]!;
    expect(body).toMatch(/position:\s*absolute/);
    expect(body).toMatch(/left:\s*calc\(var\(--port-x[^)]*\)\s*-\s*4px\)/);
    expect(body).toMatch(/top:\s*calc\(var\(--port-y[^)]*\)\s*-\s*4px\)/);
    expect(body).toMatch(/width:\s*6px/);
    expect(body).toMatch(/height:\s*6px/);
    expect(body).toMatch(/border:\s*1px solid #bcbcbc/);
    expect(body).not.toMatch(/border-radius/); // 方点：没有圆角声明（守卫见 lib/corner-system.test.ts），默认就是直角
    expect(body).toMatch(/background:\s*#fff/);
    expect(body).toMatch(/opacity:\s*0/);
    expect(body).toMatch(/pointer-events:\s*none/);
    expect(css).toMatch(/\.node-port\[data-on\]\s*\{[^}]*opacity:\s*1/);
    expect(css).toMatch(/\.node-port\[data-phase="running"\]\s*\{[^}]*var\(--teal\)/);
    expect(css).toMatch(/\.node-port\[data-phase="failed"\]\s*\{[^}]*var\(--red\)/);
  });

  it("端口方点只由 .node-port 画：节点自己的伪元素不再画端口", () => {
    for (const selector of [".agent::before", ".origin::after", ".git::after", ".folder::after"]) {
      expect(css.includes(selector), selector).toBe(false);
    }
  });
});
