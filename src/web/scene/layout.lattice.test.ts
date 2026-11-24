import type { SessionSummary } from "@shared/types";
import { describe, expect, it } from "vitest";
import { agentNodeId, layoutScene, originNodeId, type LayoutNode, type SceneLayout } from "./layout";
import { cellsFor } from "./layout-cells";
import { NODE } from "./layout-geometry";
import { overlapsOf, session } from "./layout.fixtures";

/**
 * 格点排布落到 layoutScene 上的几条规矩（2026-11-22 排布重做时加的）：经典与格点怎么取舍的细节、同一套列距行距、
 * 紧凑模式的格距、锚点的约定。几百个合成用例上的不变量见 layout.invariants.test.ts，真实画布见 layout.real.test.ts。
 */

const AREA = { w: 1088, h: 610 };
const WIDE = { w: 1568, h: 890 };
const options = { area: AREA, grid: true, hideContextNodes: true } as const;

const singles = (key: string, count: number, from = 1): SessionSummary[] => Array.from({ length: count }, (_, i) => session(`${key}-${i + 1}`, key, from + i));

const agentsOf = (layout: SceneLayout): LayoutNode[] => layout.nodes.filter((node) => node.kind === "agent");
const sortedUnique = (values: readonly number[]): number[] => [...new Set(values)].sort((a, b) => a - b);
const steps = (values: readonly number[]): number[] => values.slice(1).map((value, i) => value - values[i]!);

describe("格点排布 · 经典还是格点", () => {
  it("五个根会话：经典排成一列只有 552 × 656，放得下却是取景区域宽高比的 0.48 倍的竖串，改排成规则网格（100% 放得下，没有 fitAll）", () => {
    const layout = layoutScene(singles("cursor:five", 5), { area: WIDE, grid: true, hideContextNodes: true });
    expect(layout.grid).toBe(true);
    expect(layout.fitAll).toBeUndefined();
    expect(sortedUnique(agentsOf(layout).map((node) => node.x)).length).toBeGreaterThanOrEqual(3);
    expect(layout.bounds.w).toBeLessThanOrEqual(WIDE.w);
    expect(layout.bounds.h).toBeLessThanOrEqual(WIDE.h);
  });

  it("两个根会话各带一个子会话：向右长的短树，放得下就保持经典，不为排而排", () => {
    const sessions = [
      session("a", "cursor:small", 1),
      session("a1", "cursor:small", 2, { parentSessionId: "a" }),
      session("b", "cursor:small", 3),
      session("b1", "cursor:small", 4, { parentSessionId: "b" }),
    ];
    const layout = layoutScene(sessions, { area: WIDE, grid: true, hideContextNodes: true });
    expect(layout.grid).toBeUndefined();
    expect(layout.fitAll).toBeUndefined();
    expect(overlapsOf(layout)).toEqual([]);
  });

  it("同样的输入、同样的选项，每次得到逐项相同的布局", () => {
    const sessions = [...singles("cursor:x", 30), session("p", "cursor:x", 50), ...Array.from({ length: 5 }, (_, i) => session(`k${i}`, "cursor:x", 60 + i, { parentSessionId: "p" }))];
    expect(layoutScene(sessions, options)).toEqual(layoutScene(sessions, options));
  });
});

describe("格点排布 · 同一套列距与行距", () => {
  it("24 个单卡：相邻两列的左缘相差正好 280（卡宽 248 加列距 32），相邻两行的上缘相差正好 136（卡高 112 加行距 24）", () => {
    const layout = layoutScene(singles("cursor:big", 24), options);
    expect(layout.grid).toBe(true);
    const agents = agentsOf(layout);
    expect(steps(sortedUnique(agents.map((node) => node.x)))).toEqual(Array(4).fill(280));
    expect(steps(sortedUnique(agents.map((node) => node.y)))).toEqual(Array(4).fill(136));
  });

  it("每张会话卡的宽高都一样，来源卡紧贴它所在格子的左缘（比会话卡窄）或居中在整块的宽度里", () => {
    const layout = layoutScene(singles("cursor:big", 24), options);
    for (const node of agentsOf(layout)) expect([node.w, node.h]).toEqual([NODE.agentW, NODE.agentH]);
    const origin = layout.nodes.find((node) => node.kind === "origin")!;
    expect(origin.w).toBe(NODE.originW);
    const left = Math.min(...agentsOf(layout).map((node) => node.x));
    const right = Math.max(...agentsOf(layout).map((node) => node.x + node.w));
    expect(origin.x + origin.w / 2).toBe((left + right) / 2);
  });

  it("紧凑模式（取景区域宽不足 720）：卡宽 208、列距 24、行距 16，列与行同样整齐", () => {
    const narrow = { w: 288, h: 544 };
    const layout = layoutScene(singles("cursor:big", 24), { area: narrow, grid: true });
    expect(layout.grid).toBe(true);
    const cells = cellsFor(true);
    expect(cells).toMatchObject({ agentW: 208, gapX: 24, gapY: 16, pitchX: 232, pitchY: 128 });
    const agents = agentsOf(layout);
    for (const node of agents) expect(node.w).toBe(208);
    const xs = sortedUnique(agents.map((node) => node.x));
    const ys = sortedUnique(agents.map((node) => node.y));
    expect(new Set(steps(xs)).size).toBe(1);
    expect(steps(xs)[0]).toBe(232);
    expect(new Set(steps(ys)).size).toBe(1);
    expect(steps(ys)[0]).toBe(128);
    expect(overlapsOf(layout)).toEqual([]);
  });
});

describe("格点排布 · 父子与锚点", () => {
  // 20 个单卡加一个带 6 个子会话的父会话：格点排布，父会话与它的子会话成块。
  const sessions = [...singles("cursor:mix", 20), session("parent", "cursor:mix", 30), ...Array.from({ length: 6 }, (_, i) => session(`kid${i + 1}`, "cursor:mix", 40 + i, { parentSessionId: "parent" }))];

  it("子会话在父会话的右边，隔的是整数列；同一个父下的子会话互不重叠", () => {
    const layout = layoutScene(sessions, options);
    expect(layout.grid).toBe(true);
    const parent = layout.nodes.find((node) => node.id === agentNodeId("parent"))!;
    const { pitchX } = cellsFor(false);
    for (let i = 1; i <= 6; i++) {
      const kid = layout.nodes.find((node) => node.id === agentNodeId(`kid${i}`))!;
      expect(kid.x - parent.x).toBeGreaterThanOrEqual(pitchX);
      expect((kid.x - parent.x) % pitchX).toBe(0);
    }
    expect(overlapsOf(layout)).toEqual([]);
  });

  it("锚点：同一个父下第一个子会话以父会话为锚、偏移是布局里的实际相对位置；其余各以上一个兄弟为锚、挂在它正下方一个行距", () => {
    const layout = layoutScene(sessions, options);
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));
    const parent = byId.get(agentNodeId("parent"))!;
    const first = byId.get(agentNodeId("kid1"))!;
    expect(first.anchor).toEqual({ id: parent.id, dx: first.x - parent.x, dy: first.y - parent.y });
    for (let i = 2; i <= 6; i++) {
      const kid = byId.get(agentNodeId(`kid${i}`))!;
      expect(kid.anchor).toEqual({ id: agentNodeId(`kid${i - 1}`), dx: 0, dy: NODE.agentH + NODE.rowGap });
    }
    // 来源卡名下的根会话同理：第一个以来源卡为锚，其余以上一个根会话为锚。
    const origin = byId.get(originNodeId("cursor:mix"))!;
    const firstRoot = byId.get(agentNodeId("cursor:mix-1"))!;
    expect(firstRoot.anchor).toEqual({ id: origin.id, dx: firstRoot.x - origin.x, dy: firstRoot.y - origin.y });
    expect(byId.get(agentNodeId("cursor:mix-2"))!.anchor).toEqual({ id: firstRoot.id, dx: 0, dy: NODE.agentH + NODE.rowGap });
  });
});
