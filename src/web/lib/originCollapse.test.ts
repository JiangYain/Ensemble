import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@shared/types";
import { layoutScene, originNodeId, agentNodeId } from "../scene/layout";
import { collapsedSessions, rootOriginKeys, sessionsPerOrigin } from "./originCollapse";

/** 只带归属判断用得到的字段；createdAt 按先后（第几秒）给，layoutScene 也读得了。 */
function s(id: string, extra: { origin?: string; parent?: string; order?: number } = {}): SessionSummary {
  return {
    id,
    phase: "running",
    origin: { key: extra.origin ?? "o1" },
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, extra.order ?? 0)).toISOString(),
    ...(extra.parent ? { parentSessionId: extra.parent } : {}),
  } as unknown as SessionSummary;
}

const entries = (map: ReadonlyMap<string, string>): [string, string][] => [...map].sort(([a], [b]) => (a < b ? -1 : 1));

describe("rootOriginKeys · 会话画在哪张来源卡名下", () => {
  it("根会话归到自己的来源；子孙跟着根走，不看自己的 origin（嵌套委派的发起端可能是别的 Harness）", () => {
    const list = [
      s("a", { origin: "x", order: 1 }),
      s("a1", { origin: "child-host", parent: "a", order: 2 }),
      s("a11", { origin: "other", parent: "a1", order: 3 }),
      s("b", { origin: "y", order: 4 }),
    ];
    expect(entries(rootOriginKeys(list))).toEqual([["a", "x"], ["a1", "x"], ["a11", "x"], ["b", "y"]]);
  });

  it("与布局一致：布局把某个会话画在哪张来源卡后面，这里就把它归到哪个来源", () => {
    const list = [
      s("a", { origin: "x", order: 1 }),
      s("a1", { origin: "z", parent: "a", order: 2 }),
      s("b", { origin: "y", order: 3 }),
      s("b1", { origin: "x", parent: "b", order: 4 }),
    ];
    const layout = layoutScene(list);
    const keys = rootOriginKeys(list);
    // 布局里每个会话节点都沿连线回溯到一张来源卡；这张卡就是归属。
    const upstream = new Map(layout.edges.map((edge) => [edge.to, edge.from]));
    for (const session of list) {
      let id = agentNodeId(session.id);
      while (upstream.has(id) && !id.startsWith("origin:")) id = upstream.get(id)!;
      expect(id).toBe(originNodeId(keys.get(session.id)!));
    }
  });

  it("父会话不在列表里（已删除）：这个会话自己是根", () => {
    const list = [s("orphan", { origin: "x", parent: "gone" }), s("kid", { origin: "y", parent: "orphan" })];
    expect(entries(rootOriginKeys(list))).toEqual([["kid", "x"], ["orphan", "x"]]);
  });

  it("数据异常的环不会死循环：环上的会话各自当根，挂在环外的后代归到进入环的那个会话", () => {
    const list = [
      s("c1", { origin: "x", parent: "c2", order: 1 }),
      s("c2", { origin: "y", parent: "c1", order: 2 }),
      s("tail", { origin: "z", parent: "c2", order: 3 }),
      s("self", { origin: "w", parent: "self", order: 4 }),
    ];
    expect(entries(rootOriginKeys(list))).toEqual([["c1", "x"], ["c2", "y"], ["self", "w"], ["tail", "y"]]);
  });

  it("每个会话都有归属，与传入顺序无关（子先于父也一样）", () => {
    const list = [s("c", { parent: "b", order: 3 }), s("b", { parent: "a", order: 2 }), s("a", { origin: "x", order: 1 })];
    expect(entries(rootOriginKeys(list))).toEqual([["a", "x"], ["b", "x"], ["c", "x"]]);
    expect(entries(rootOriginKeys([...list].reverse()))).toEqual([["a", "x"], ["b", "x"], ["c", "x"]]);
  });
});

describe("collapsedSessions / sessionsPerOrigin", () => {
  const list = [
    s("a", { origin: "x", order: 1 }),
    s("a1", { parent: "a", origin: "x", order: 2 }),
    s("b", { origin: "y", order: 3 }),
    s("b1", { parent: "b", origin: "x", order: 4 }),
  ];

  it("收起的是被隐藏的来源名下整棵树，别的来源不受影响", () => {
    expect([...collapsedSessions(list, new Set(["x"]))].sort()).toEqual(["a", "a1"]);
    expect([...collapsedSessions(list, new Set(["y"]))].sort()).toEqual(["b", "b1"]);
    expect([...collapsedSessions(list, new Set(["x", "y"]))].sort()).toEqual(["a", "a1", "b", "b1"]);
  });

  it("没有隐藏任何来源、或隐藏的来源已经不存在：什么都不收", () => {
    expect(collapsedSessions(list, new Set()).size).toBe(0);
    expect(collapsedSessions(list, new Set(["gone"])).size).toBe(0);
  });

  it("每张来源卡名下的会话数含嵌套的，合计等于会话总数", () => {
    const counts = sessionsPerOrigin(list);
    expect(Object.fromEntries(counts)).toEqual({ x: 2, y: 2 });
    expect([...counts.values()].reduce((sum, n) => sum + n, 0)).toBe(list.length);
  });
});
