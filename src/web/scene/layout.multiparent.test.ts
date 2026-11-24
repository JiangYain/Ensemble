import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@shared/types";
import { agentNodeId, layoutScene, NODE, originNodeId, type SceneLayout } from "./layout";
import { node, overlapsOf, session } from "./layout.fixtures";

/**
 * 汇聚（一个会话跟随多个上级）在画布上的排布与连线，纯布局测试（引擎怎么把这些线画出来见 engine.fanin.test.ts）。
 * 约定（见 layout.ts）：汇聚的会话仍然只挂在画出来的第一个上级下面（排布与拖动锚点只跟这一个），
 * 列被推到同一个来源块里所有上级的右边，其余上级各多画一条线；没有汇聚的画布与原来一模一样。
 */

/** 一个会话：上级按先后给出（第一个是主上级）；多于一个时按服务端的写法多带 parentSessionIds。 */
const under = (id: string, order: number, parents: readonly string[], depth: number, origin = "main"): SessionSummary =>
  session(id, origin, order, { parentSessionId: parents[0]!, ...(parents.length > 1 ? { parentSessionIds: [...parents] } : {}), depth });

/** R 之下并行的 A、B，再由 J 汇总：菱形。 */
const diamond = (): SessionSummary[] => [session("r", "main", 1), under("a", 2, ["r"], 1), under("b", 3, ["r"], 1), under("j", 4, ["a", "b"], 2)];

/** J 的主上级 X 在第 0 列、另一个上级 A 在第 1 列：J 要被推到第 2 列。 */
const pushed = (join: readonly string[]): SessionSummary[] => [
  session("x", "main", 1),
  session("r", "main", 2),
  under("a", 3, ["r"], 1),
  under("j", 4, join, join.length > 1 ? 2 : 1),
];

const edgesInto = (layout: SceneLayout, id: string) => layout.edges.filter((edge) => edge.to === agentNodeId(id));
const sourcesOf = (layout: SceneLayout, id: string): string[] => edgesInto(layout, id).map((edge) => edge.from);
const at = (layout: SceneLayout, id: string) => node(layout, agentNodeId(id));
/** 每个节点的锚点都排在它自己之前（引擎按顺序放置的不变量，见 LayoutNode.anchor）。 */
const anchorsFirst = (layout: SceneLayout): boolean => {
  const index = new Map(layout.nodes.map((n, i) => [n.id, i]));
  return layout.nodes.every((n, i) => !n.anchor || index.get(n.anchor.id)! < i);
};
const COLUMN = NODE.agentW + NODE.stagger + NODE.childGap;

describe("布局：汇聚的连线", () => {
  it("每个上级到汇聚的会话各有一条线，树里的那条（第一个上级）排在最前，id 写成 上级>子会话", () => {
    const layout = layoutScene(diamond());

    expect(sourcesOf(layout, "j")).toEqual([agentNodeId("a"), agentNodeId("b")]);
    expect(edgesInto(layout, "j").map((edge) => edge.id)).toEqual([`${agentNodeId("a")}>${agentNodeId("j")}`, `${agentNodeId("b")}>${agentNodeId("j")}`]);
    // 其余会话仍然只有一条连入的线：来源连到根会话、上级连到子会话。
    expect(sourcesOf(layout, "r")).toEqual([originNodeId("main")]);
    expect(sourcesOf(layout, "a")).toEqual([agentNodeId("r")]);
    expect(sourcesOf(layout, "b")).toEqual([agentNodeId("r")]);
    expect(layout.edges).toHaveLength(5);
  });

  it("线的 id 彼此不同，都是“起点>终点”；线的阶段跟着汇聚的会话", () => {
    const sessions = diamond().map((summary) => (summary.id === "j" ? ({ ...summary, phase: "failed" } as SessionSummary) : summary));
    const layout = layoutScene(sessions);

    expect(new Set(layout.edges.map((edge) => edge.id)).size).toBe(layout.edges.length);
    for (const edge of layout.edges) expect(edge.id).toBe(`${edge.from}>${edge.to}`);
    for (const edge of edgesInto(layout, "j")) expect(edge.phase).toBe("failed");
    expect(edgesInto(layout, "a")[0]!.phase).toBe("running");
  });

  it("补的线排在所有树里的线之后（引擎按“第一条指向它的线”找上游，那一条始终是树里的）", () => {
    const layout = layoutScene(diamond());
    const extra = layout.edges.findIndex((edge) => edge.id === `${agentNodeId("b")}>${agentNodeId("j")}`);

    expect(extra).toBe(layout.edges.length - 1);
    expect(layout.edges.findIndex((edge) => edge.to === agentNodeId("j"))).toBe(layout.edges.findIndex((edge) => edge.id === `${agentNodeId("a")}>${agentNodeId("j")}`));
  });
});

describe("布局：汇聚的会话排在哪", () => {
  it("挂在第一个上级下面：拖动的锚点是它，而不是别的上级", () => {
    const layout = layoutScene(diamond());

    expect(at(layout, "j").anchor?.id).toBe(agentNodeId("a"));
    expect(anchorsFirst(layout)).toBe(true);
  });

  it("在所有上级的右边，与它们互不重叠", () => {
    const layout = layoutScene(diamond());
    const join = at(layout, "j");

    for (const parent of ["a", "b"]) expect(join.x, parent).toBeGreaterThanOrEqual(at(layout, parent).x + at(layout, parent).w);
    expect(overlapsOf(layout)).toEqual([]);
  });

  it("主上级所在的列比另一个上级浅时，被推到另一个上级的右边：比不汇聚时正好多一列", () => {
    const single = layoutScene(pushed(["x"]));
    const joined = layoutScene(pushed(["x", "a"]));

    // 不汇聚：J 就在 X 的后一列；汇聚：A 在第 1 列，J 被推到第 2 列。
    expect(at(single, "j").x - at(single, "x").x).toBe(COLUMN);
    expect(at(joined, "j").x - at(joined, "x").x).toBe(2 * COLUMN);
    expect(at(joined, "j").x).toBeGreaterThanOrEqual(at(joined, "a").x + at(joined, "a").w);
    // 仍挂在第一个上级下面：锚点是 X，不是 A。
    expect(at(joined, "j").anchor?.id).toBe(agentNodeId("x"));
    expect(sourcesOf(joined, "j")).toEqual([agentNodeId("x"), agentNodeId("a")]);
    expect(overlapsOf(joined)).toEqual([]);
    expect(anchorsFirst(joined)).toBe(true);
  });

  it("汇聚的会话的子会话顺着它被推到的那一列往右排", () => {
    const sessions = [...pushed(["x", "a"]), under("k", 5, ["j"], 3)];
    const layout = layoutScene(sessions);

    expect(at(layout, "k").x - at(layout, "j").x).toBe(COLUMN);
    expect(overlapsOf(layout)).toEqual([]);
  });

  it("主上级更深时不需要推：列就是树里的深度，不会多出空列", () => {
    // J 的主上级 A 在第 1 列，另一个上级 X 在第 0 列：J 本来就在第 2 列，汇聚什么都不改。
    const joined = layoutScene(pushed(["a", "x"]));
    const single = layoutScene(pushed(["a"]));

    expect(at(joined, "j").x - at(joined, "a").x).toBe(COLUMN);
    expect(at(joined, "j").x - at(joined, "a").x).toBe(at(single, "j").x - at(single, "a").x);
    expect(sourcesOf(joined, "j")).toEqual([agentNodeId("a"), agentNodeId("x")]);
  });
});

describe("布局：没有汇聚的画布与原来一样", () => {
  it("一棵普通的树：列距与错位就是原来的数字，每个会话只有一条连入的线，没有补的线", () => {
    const layout = layoutScene([session("r", "main", 1), under("a", 2, ["r"], 1), under("b", 3, ["r"], 1), under("c", 4, ["a"], 2)]);

    expect(at(layout, "a").x - at(layout, "r").x).toBe(COLUMN);
    expect(at(layout, "b").x - at(layout, "a").x).toBe(NODE.stagger);
    expect(at(layout, "c").x - at(layout, "a").x).toBe(COLUMN);
    for (const id of ["r", "a", "b", "c"]) expect(edgesInto(layout, id), id).toHaveLength(1);
    expect(layout.edges).toHaveLength(4);
  });

  it("手写的只含一个 id 的集合就是单上级（服务端不会写出这种数据，布局也不被它骗到）", () => {
    const plain = layoutScene(pushed(["x"]));
    const oneId = layoutScene(pushed(["x"]).map((summary) => (summary.id === "j" ? ({ ...summary, parentSessionIds: ["x"] } as SessionSummary) : summary)));

    expect(oneId.nodes).toEqual(plain.nodes);
    expect(oneId.edges).toEqual(plain.edges);
  });

  it("上级字段只有 parentSessionId（老摘要、老日志重放出来的）：与单上级一样排", () => {
    const sessions = diamond().map((summary) => {
      if (summary.id !== "j") return summary;
      const { parentSessionIds: _dropped, ...rest } = summary;
      return rest as SessionSummary;
    });
    const layout = layoutScene(sessions);

    expect(sourcesOf(layout, "j")).toEqual([agentNodeId("a")]);
    expect(layout.edges).toHaveLength(4);
    expect(at(layout, "j").x - at(layout, "a").x).toBe(COLUMN);
  });
});

describe("布局：汇聚的上级在别的来源，或被视图过滤收起", () => {
  it("上级在另一个来源名下：多画一条跨来源的线，会话仍排在主上级的来源块里，不重叠", () => {
    const sessions = [session("r", "main", 1), session("x", "other", 2), under("j", 3, ["r", "x"], 1, "main")];
    const layout = layoutScene(sessions);

    expect(sourcesOf(layout, "j")).toEqual([agentNodeId("r"), agentNodeId("x")]);
    expect(at(layout, "j").x).toBeGreaterThanOrEqual(at(layout, "r").x + at(layout, "r").w);
    expect(at(layout, "j").anchor?.id).toBe(agentNodeId("r"));
    // 两张来源卡、三个会话；线：两条来源到根会话、一条树里的、一条跨来源补的。
    expect(layout.nodes).toHaveLength(5);
    expect(layout.edges).toHaveLength(4);
    expect(overlapsOf(layout)).toEqual([]);
    expect(anchorsFirst(layout)).toBe(true);
  });

  it("主上级在另一个来源时，会话也排在它那一块：来源块由树里的上级一路上溯到的根会话决定", () => {
    const sessions = [session("r", "main", 1), session("x", "other", 2), under("j", 3, ["x", "r"], 1, "main")];
    const layout = layoutScene(sessions);

    expect(at(layout, "j").anchor?.id).toBe(agentNodeId("x"));
    expect(at(layout, "j").x).toBeGreaterThanOrEqual(at(layout, "x").x + at(layout, "x").w);
    expect(sourcesOf(layout, "j")).toEqual([agentNodeId("x"), agentNodeId("r")]);
    expect(overlapsOf(layout)).toEqual([]);
  });

  it("视图过滤只留下一部分上级：缺的那条线不画，会话挂到还在画布上的第一个上级下面", () => {
    const layout = layoutScene(diamond(), { visible: new Set(["r", "b", "j"]) });

    expect(layout.nodes.some((n) => n.id === agentNodeId("a"))).toBe(false);
    expect(sourcesOf(layout, "j")).toEqual([agentNodeId("b")]);
    expect(at(layout, "j").anchor?.id).toBe(agentNodeId("b"));
    expect(layout.edges).toHaveLength(3);
    expect(overlapsOf(layout)).toEqual([]);
  });

  it("所有上级都被收起时，它当作根会话，直接连在来源上（调用方本来应当保证留下的会话对祖先封闭，这里只验证不会出错）", () => {
    const layout = layoutScene(diamond(), { visible: new Set(["r", "j"]) });

    expect(sourcesOf(layout, "j")).toEqual([originNodeId("main")]);
    expect(sourcesOf(layout, "r")).toEqual([originNodeId("main")]);
    expect(layout.edges).toHaveLength(2);
    expect(overlapsOf(layout)).toEqual([]);
  });
});

describe("布局：数据异常时仍然排得出来", () => {
  it("汇聚的会话与它的上级互相指向：排布结束，每个会话都有位置，环上的线不画，不重叠", () => {
    // A 说它跟随 J，J 说它跟随 A 与 S：J → A → J 成环；S 与环无关。
    const sessions = [session("s", "main", 1), under("a", 2, ["j"], 1), under("j", 3, ["a", "s"], 2)];
    const layout = layoutScene(sessions);

    for (const id of ["s", "a", "j"]) expect(layout.nodes.some((n) => n.id === agentNodeId(id)), id).toBe(true);
    // 环上的两条线都去掉：A 当作根，J 只剩 S 这一个上级。
    expect(sourcesOf(layout, "a")).toEqual([originNodeId("main")]);
    expect(sourcesOf(layout, "j")).toEqual([agentNodeId("s")]);
    expect(layout.edges).toHaveLength(3);
    expect(overlapsOf(layout)).toEqual([]);
  });

  it("一个会话把自己列为上级之一：那一条被忽略，其余照常", () => {
    const layout = layoutScene([session("r", "main", 1), under("j", 2, ["j", "r"], 1)]);

    expect(sourcesOf(layout, "j")).toEqual([agentNodeId("r")]);
    expect(overlapsOf(layout)).toEqual([]);
  });

  it("上级里有已经不存在的会话：不画那一条，其余照常", () => {
    const layout = layoutScene([session("r", "main", 1), under("j", 2, ["gone", "r"], 1)]);

    expect(sourcesOf(layout, "j")).toEqual([agentNodeId("r")]);
    expect(layout.edges).toHaveLength(2);
  });
});

describe("布局：规划式排布（grid）里的汇聚", () => {
  const options = { area: { w: 1088, h: 610 }, grid: true, hideContextNodes: true } as const;

  it("来源很多、排成多列网格时，汇聚的线一条不少，节点不重叠，锚点仍在前", () => {
    const sessions = [
      ...Array.from({ length: 20 }, (_, index) => session(`s${index + 1}`, "cursor:big", index + 1)),
      session("r", "cursor:big", 21),
      under("a", 22, ["r"], 1, "cursor:big"),
      under("b", 23, ["r"], 1, "cursor:big"),
      under("j", 24, ["a", "b"], 2, "cursor:big"),
    ];
    const layout = layoutScene(sessions, options);

    expect(sourcesOf(layout, "j")).toEqual([agentNodeId("a"), agentNodeId("b")]);
    for (const summary of sessions) if (summary.id !== "j") expect(edgesInto(layout, summary.id), summary.id).toHaveLength(1);
    expect(layout.edges).toHaveLength(sessions.length + 1);
    expect(overlapsOf(layout)).toEqual([]);
    expect(anchorsFirst(layout)).toBe(true);
  });

  it("会话少、放得下时仍是经典的树，汇聚的会话在上级的右边", () => {
    // 菱形排成树要 1280 宽：取景区域够宽才放得下（1088 宽时排布会换成网格，那是上一个测试走的路）。
    const layout = layoutScene(diamond(), { ...options, area: { w: 1600, h: 800 } });

    expect(layout.grid).toBeUndefined();
    expect(at(layout, "j").x).toBeGreaterThanOrEqual(at(layout, "b").x + at(layout, "b").w);
    expect(sourcesOf(layout, "j")).toEqual([agentNodeId("a"), agentNodeId("b")]);
    expect(overlapsOf(layout)).toEqual([]);
  });
});
