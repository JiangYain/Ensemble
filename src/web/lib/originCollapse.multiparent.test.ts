import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@shared/types";
import { agentNodeId, layoutScene, originNodeId } from "../scene/layout";
import { collapsedSessions, rootOriginKeys, sessionsPerOrigin } from "./originCollapse";
import { indexSessions } from "./sessionGraph";

/**
 * 汇聚（一个会话跟随多个上级）与“隐藏某个 Main Agent 的相关节点”：
 * 汇聚的会话按它第一个在列表里的上级归到一张来源卡名下（与布局一致），但只有它所有的上级都被收起时才跟着收起。
 * 没有汇聚的行为由 originCollapse.test.ts 守着，这里不重复。
 * 末尾是关系索引（sessionGraph）自己的断言：来源归属与折叠读的上级、下级都出自它，它没有单独的测试文件。
 */

/** 只带归属判断用得到的字段；上级按先后给出，多于一个时与服务端一样多带 parentSessionIds。 */
function s(id: string, extra: { origin?: string; parents?: readonly string[]; order?: number } = {}): SessionSummary {
  const parents = extra.parents ?? [];
  return {
    id,
    phase: "running",
    origin: { key: extra.origin ?? "o1" },
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, extra.order ?? 0)).toISOString(),
    ...(parents.length > 0 ? { parentSessionId: parents[0] } : {}),
    ...(parents.length > 1 ? { parentSessionIds: [...parents] } : {}),
  } as unknown as SessionSummary;
}

const entries = (map: ReadonlyMap<string, string>): [string, string][] => [...map].sort(([a], [b]) => (a < b ? -1 : 1));
const collapsed = (list: readonly SessionSummary[], ...keys: string[]): string[] => [...collapsedSessions(list, new Set(keys))].sort();

/** A 在来源 x 名下，B 在来源 y 名下，J 同时跟随它们两个。 */
const joined = (parents: readonly string[] = ["a", "b"]): SessionSummary[] => [
  s("a", { origin: "x", order: 1 }),
  s("b", { origin: "y", order: 2 }),
  s("j", { origin: "z", parents, order: 3 }),
];

describe("rootOriginKeys · 汇聚的会话画在哪张来源卡名下", () => {
  it("挂在它第一个在列表里的上级下面，不看自己的 origin，也不看别的上级", () => {
    expect(entries(rootOriginKeys(joined(["a", "b"])))).toEqual([["a", "x"], ["b", "y"], ["j", "x"]]);
    expect(entries(rootOriginKeys(joined(["b", "a"])))).toEqual([["a", "x"], ["b", "y"], ["j", "y"]]);
  });

  it("第一个上级不在列表里（已删除、或被过滤掉）：顺延到下一个；一个都不在就自己是根", () => {
    expect(entries(rootOriginKeys(joined(["gone", "b"])))).toEqual([["a", "x"], ["b", "y"], ["j", "y"]]);
    expect(entries(rootOriginKeys(joined(["gone", "missing"])))).toEqual([["a", "x"], ["b", "y"], ["j", "z"]]);
  });

  it("与布局一致：布局把汇聚的会话画在哪张来源卡后面，这里就把它归到哪个来源", () => {
    const list = joined(["b", "a"]);
    const layout = layoutScene(list);
    const keys = rootOriginKeys(list);
    // 汇聚的会话沿着树里的那条线（第一条指向它的线）回溯到一张来源卡。
    const upstream = new Map<string, string>();
    for (const edge of layout.edges) if (!upstream.has(edge.to)) upstream.set(edge.to, edge.from);
    for (const session of list) {
      let id = agentNodeId(session.id);
      while (upstream.has(id) && !id.startsWith("origin:")) id = upstream.get(id)!;
      expect(id, session.id).toBe(originNodeId(keys.get(session.id)!));
    }
  });

  it("数据里的环穿过汇聚的会话也不会死循环：环上的会话各自当根，其余照常", () => {
    // A 跟随 J，J 跟随 A 与 S：J → A → J 成环；S 与环无关。
    const list = [s("s", { origin: "y", order: 1 }), s("a", { origin: "x", parents: ["j"], order: 2 }), s("j", { origin: "z", parents: ["a", "s"], order: 3 })];

    expect(entries(rootOriginKeys(list))).toEqual([["a", "x"], ["j", "z"], ["s", "y"]]);
  });
});

describe("collapsedSessions · 汇聚的会话要所有上级都被收起才跟着收起", () => {
  it("只收起其中一个上级所在的来源：汇聚的会话留着（它还有上级画在外面）", () => {
    expect(collapsed(joined(), "x")).toEqual(["a"]);
    // 它的第一个上级在 x、隐藏 y 时：它本来也不在 y 名下，更不会被收起。
    expect(collapsed(joined(), "y")).toEqual(["b"]);
  });

  it("所有上级所在的来源都被收起：它跟着收起", () => {
    expect(collapsed(joined(), "x", "y")).toEqual(["a", "b", "j"]);
  });

  it("两个上级在同一个来源名下：收起这一个来源就够了", () => {
    const list = [s("a", { origin: "x", order: 1 }), s("b", { origin: "x", order: 2 }), s("j", { origin: "x", parents: ["a", "b"], order: 3 })];

    expect(collapsed(list, "x")).toEqual(["a", "b", "j"]);
  });

  it("留下的汇聚会话名下的后代同样留着：只因它才被收起的，不单独收起", () => {
    const list = [...joined(), s("k", { origin: "x", parents: ["j"], order: 4 })];

    // k 在 j 下面、归到 x；j 因为还跟随着 y 的 b 而留着，k 跟着留着。
    expect(collapsed(list, "x")).toEqual(["a"]);
    expect(collapsed(list, "x", "y")).toEqual(["a", "b", "j", "k"]);
  });

  it("汇聚的会话留下，会让以它为上级的汇聚会话也跟着留下，与列表里的先后无关", () => {
    // J1 跟随 A（x）与 B（y）；J2 跟随 C（x）与 J1。收起 x 时：J1 因 B 留下，J2 因 J1 留下。
    const base = [
      s("a", { origin: "x", order: 1 }),
      s("b", { origin: "y", order: 2 }),
      s("c", { origin: "x", order: 3 }),
      s("j1", { origin: "x", parents: ["a", "b"], order: 4 }),
      s("j2", { origin: "x", parents: ["c", "j1"], order: 5 }),
    ];

    expect(collapsed(base, "x")).toEqual(["a", "c"]);
    // 先写后依赖的（j2 排在 j1 前面）要多算一轮才收敛，结果一样。
    const reversed = [base[0]!, base[1]!, base[2]!, base[4]!, base[3]!];
    expect(collapsed(reversed, "x")).toEqual(["a", "c"]);
    expect(collapsed(base, "x", "y")).toEqual(["a", "b", "c", "j1", "j2"]);
  });

  it("数据里的环穿过汇聚的会话：算得完，结果合理", () => {
    const list = [s("s", { origin: "y", order: 1 }), s("a", { origin: "x", parents: ["j"], order: 2 }), s("j", { origin: "z", parents: ["a", "s"], order: 3 })];

    expect(collapsed(list, "x")).toEqual(["a"]);
    // j 自己的来源 z 被收起，但它跟随的 a、s 都在外面：留着。
    expect(collapsed(list, "z")).toEqual([]);
  });

  it("没有隐藏任何来源：什么都不收，列表里有没有汇聚都一样", () => {
    expect(collapsedSessions(joined(), new Set()).size).toBe(0);
    expect(collapsedSessions(joined(), new Set(["gone"])).size).toBe(0);
  });
});

describe("sessionsPerOrigin · 来源卡上的数是隐藏它时真的会收起的个数", () => {
  it("汇聚的会话还跟随着别的来源下的会话时，不算在任何一张卡名下：收起一张卡收不起它", () => {
    const counts = sessionsPerOrigin(joined());

    expect(Object.fromEntries(counts)).toEqual({ x: 1, y: 1 });
  });

  it("两个上级在同一张卡名下：算在这张卡名下", () => {
    const list = [s("a", { origin: "x", order: 1 }), s("b", { origin: "x", order: 2 }), s("j", { origin: "x", parents: ["a", "b"], order: 3 })];

    expect(Object.fromEntries(sessionsPerOrigin(list))).toEqual({ x: 3 });
  });

  it("没有汇聚的列表与原来一样：合计等于会话总数", () => {
    const list = [s("a", { origin: "x", order: 1 }), s("a1", { origin: "x", parents: ["a"], order: 2 }), s("b", { origin: "y", order: 3 })];
    const counts = sessionsPerOrigin(list);

    expect(Object.fromEntries(counts)).toEqual({ x: 2, y: 1 });
    expect([...counts.values()].reduce((sum, n) => sum + n, 0)).toBe(list.length);
  });
});

describe("隐藏一个 Main Agent 之后的画布：汇聚的会话留着，线只剩画着的上级", () => {
  it("J 的第一个上级被收起、另一个还在：J 画在剩下的上级下面，只有那一条线", () => {
    const list = joined();
    const hidden = collapsedSessions(list, new Set(["x"]));
    const visible = new Set(list.filter((session) => !hidden.has(session.id)).map((session) => session.id));
    const layout = layoutScene(list, { visible, collapsed: new Set(["x"]) });

    expect([...hidden]).toEqual(["a"]);
    // 被隐藏的来源只剩一张卡（恢复的入口）；J 没有被收起，挂到 B 下面。
    expect(layout.nodes.some((node) => node.id === originNodeId("x"))).toBe(true);
    expect(layout.nodes.some((node) => node.id === agentNodeId("a"))).toBe(false);
    expect(layout.edges.filter((edge) => edge.to === agentNodeId("j")).map((edge) => edge.from)).toEqual([agentNodeId("b")]);
    expect(layout.nodes.find((node) => node.id === agentNodeId("j"))?.anchor?.id).toBe(agentNodeId("b"));
  });
});

describe("主上级缺失、另一个上级还在 · 来源归属与折叠一起顺延到那个上级", () => {
  it("只剩一个上级在列表里：与单上级的会话一样，跟着那个上级归属、一起收起", () => {
    // J 的主上级 gone 不在列表里（已删除、或被过滤掉），B 在 y 名下：J 画在 B 下面，归到 y（不看自己的 origin z）。
    const list = [s("b", { origin: "y", order: 2 }), s("j", { origin: "z", parents: ["gone", "b"], order: 3 })];

    expect(entries(rootOriginKeys(list))).toEqual([["b", "y"], ["j", "y"]]);
    expect(collapsed(list, "y")).toEqual(["b", "j"]);
    // 它自己的 origin 在这里不起作用：收起 z 什么也收不起。
    expect(collapsed(list, "z")).toEqual([]);
    expect(Object.fromEntries(sessionsPerOrigin(list))).toEqual({ y: 2 });
  });

  it("还有两个上级在列表里：归到顺延后的第一个，要两个来源都收起才跟着收起", () => {
    const list = joined(["gone", "a", "b"]);

    expect(entries(rootOriginKeys(list))).toEqual([["a", "x"], ["b", "y"], ["j", "x"]]);
    expect(collapsed(list, "x")).toEqual(["a"]);
    expect(collapsed(list, "y")).toEqual(["b"]);
    expect(collapsed(list, "x", "y")).toEqual(["a", "b", "j"]);
    expect(Object.fromEntries(sessionsPerOrigin(list))).toEqual({ x: 1, y: 1 });
  });

  it("顺延后的汇聚会话名下的后代跟着它：它留着，后代也留着", () => {
    const list = [...joined(["gone", "a", "b"]), s("k", { origin: "w", parents: ["j"], order: 4 })];

    expect(entries(rootOriginKeys(list))).toEqual([["a", "x"], ["b", "y"], ["j", "x"], ["k", "x"]]);
    expect(collapsed(list, "x")).toEqual(["a"]);
    expect(collapsed(list, "x", "y")).toEqual(["a", "b", "j", "k"]);
    expect(Object.fromEntries(sessionsPerOrigin(list))).toEqual({ x: 1, y: 1 });
  });

  it("上级被过滤掉之后的集合另算：汇聚的会话归到还在的那个上级，不再是汇聚", () => {
    const full = joined();
    // 只看 B 与 J（A 被过滤掉了），与整份列表各算各的。
    const filtered = full.filter((session) => session.id !== "a");

    expect(entries(rootOriginKeys(full))).toEqual([["a", "x"], ["b", "y"], ["j", "x"]]);
    expect(entries(rootOriginKeys(filtered))).toEqual([["b", "y"], ["j", "y"]]);
    expect(collapsed(full, "y")).toEqual(["b"]);
    expect(collapsed(filtered, "y")).toEqual(["b", "j"]);
  });
});

describe("indexSessions · 会话关系索引", () => {
  const ids = (list: readonly SessionSummary[]): string[] => list.map((session) => session.id);

  it("上级：有序、去重、只留这一批里有的；主上级不在时第一个上级顺延到下一个", () => {
    const graph = indexSessions(joined(["gone", "b", "a", "b"]));

    expect(graph.parentsOf("j")).toEqual(["b", "a"]);
    expect(graph.firstParentOf("j")).toBe("b");
    expect(graph.parentsOf("a")).toEqual([]);
    expect(graph.firstParentOf("a")).toBeUndefined();
    // 不在这一批里的会话没有上级，也不会因为问了它就多出什么。
    expect(graph.parentsOf("nobody")).toEqual([]);
    expect(graph.firstParentOf("nobody")).toBeUndefined();
  });

  it("按 id 查摘要只含这一批里的会话；sessions 就是传入的数组，先后不变", () => {
    const list = joined();
    const graph = indexSessions(list);

    expect(graph.sessions).toBe(list);
    expect(graph.byId.size).toBe(3);
    expect(graph.byId.get("j")).toBe(list[2]);
    expect(graph.byId.has("gone")).toBe(false);
  });

  it("两张下级表：树里的下级只在第一个上级名下，全部下级在每个上级名下都有；都是早的在前，与传入先后无关", () => {
    // 故意把传入的先后打乱：k3 与 j 排在它们的上级前面。
    const list = [
      s("k3", { parents: ["r"], order: 4 }),
      s("r", { order: 1 }),
      s("j", { parents: ["k1", "k2"], order: 5 }),
      s("k2", { parents: ["r"], order: 3 }),
      s("k1", { parents: ["r"], order: 2 }),
    ];
    const graph = indexSessions(list);

    expect(ids(graph.treeChildrenOf("r"))).toEqual(["k1", "k2", "k3"]);
    expect(ids(graph.childrenOf("r"))).toEqual(["k1", "k2", "k3"]);
    // j 跟随 k1 与 k2：树里只挂在 k1 下面，全部下级里 k1 与 k2 名下各有一份。
    expect(ids(graph.treeChildrenOf("k1"))).toEqual(["j"]);
    expect(ids(graph.treeChildrenOf("k2"))).toEqual([]);
    expect(ids(graph.childrenOf("k1"))).toEqual(["j"]);
    expect(ids(graph.childrenOf("k2"))).toEqual(["j"]);
    // 没有下级、或不在这一批里：空。
    expect(ids(graph.treeChildrenOf("j"))).toEqual([]);
    expect(ids(graph.childrenOf("nobody"))).toEqual([]);
  });

  it("同一时刻创建的下级用 id 兜底，结果与传入的先后无关", () => {
    const forward = [s("r", { order: 1 }), s("ka", { parents: ["r"], order: 2 }), s("kb", { parents: ["r"], order: 2 })];
    const backward = [forward[0]!, forward[2]!, forward[1]!];

    for (const list of [forward, backward]) {
      const graph = indexSessions(list);

      expect(ids(graph.treeChildrenOf("r"))).toEqual(["ka", "kb"]);
      expect(ids(graph.childrenOf("r"))).toEqual(["ka", "kb"]);
    }
  });

  it("索引只描述传入的这一批：过滤之后的集合另建一份，第一个上级是那一批里排在最前的", () => {
    const full = indexSessions(joined());
    const filtered = indexSessions(joined().filter((session) => session.id !== "a"));

    expect(full.firstParentOf("j")).toBe("a");
    expect(filtered.firstParentOf("j")).toBe("b");
    expect(filtered.parentsOf("j")).toEqual(["b"]);
    // 整份里 j 只挂在 a 下面（b 名下只有“全部下级”里的一份）；过滤掉 a 之后它挂到 b 下面。
    expect(ids(full.treeChildrenOf("b"))).toEqual([]);
    expect(ids(full.childrenOf("b"))).toEqual(["j"]);
    expect(ids(filtered.treeChildrenOf("b"))).toEqual(["j"]);
  });

  it("会话指向自己（数据异常）：原样保留，不替各个视图决定怎么收尾", () => {
    const graph = indexSessions([s("x", { parents: ["x"] })]);

    expect(graph.parentsOf("x")).toEqual(["x"]);
    expect(graph.firstParentOf("x")).toBe("x");
    expect(ids(graph.treeChildrenOf("x"))).toEqual(["x"]);
    expect(ids(graph.childrenOf("x"))).toEqual(["x"]);
  });

  it("不改传入的数组与摘要：冻结的输入照样能建索引", () => {
    const list = Object.freeze(joined().map((session) => Object.freeze(session)));
    const graph = indexSessions(list);

    expect(ids(graph.childrenOf("a"))).toEqual(["j"]);
    expect(ids(list)).toEqual(["a", "b", "j"]);
  });
});
