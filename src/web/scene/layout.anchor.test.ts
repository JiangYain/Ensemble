import type { SessionId, SessionSummary } from "@shared/types";
import { describe, expect, it } from "vitest";
import { agentNodeId, layoutScene, NODE, originNodeId, type LayoutNode, type SceneLayout } from "./layout";
import { inDir, node, REPO, sessionsOfThreeOrigins, session } from "./layout.fixtures";

/**
 * 会话节点的锚点（新会话出现时，参照被用户挪走过就落在参照旁边）：
 * 参照是同一父下的上一个兄弟 / 父会话 / 来源卡，只取布局里实际存在的节点。
 */

const wide = { w: 1800, h: 900 };
const compactArea = { w: 400, h: 700 };
const ROW = NODE.agentH + NODE.rowGap;
const sid = (id: string): SessionId => id as SessionId;
const agent = (id: string): string => agentNodeId(sid(id));
const child = (id: string, origin: string, order: number, parent: string): SessionSummary => session(id, origin, order, { parentSessionId: sid(parent) });
const anchorOf = (layout: SceneLayout, id: string): NonNullable<LayoutNode["anchor"]> => {
  const anchor = node(layout, id).anchor;
  if (!anchor) throw new Error(`${id} 没有锚点`);
  return anchor;
};
/** 锚点加偏移得到的位置。 */
const resolved = (layout: SceneLayout, id: string): { x: number; y: number } => {
  const anchor = anchorOf(layout, id);
  const target = node(layout, anchor.id);
  return { x: target.x + anchor.dx, y: target.y + anchor.dy };
};
const posOf = (layout: SceneLayout, id: string): { x: number; y: number } => {
  const n = node(layout, id);
  return { x: n.x, y: n.y };
};

describe("会话节点的锚点", () => {
  it("只有一个会话：锚点是来源卡，偏移就是布局里两者的相对位置", () => {
    const layout = layoutScene([session("a", "codex", 1)], { area: wide });
    const anchor = anchorOf(layout, agent("a"));
    expect(anchor.id).toBe(originNodeId("codex"));
    expect(resolved(layout, agent("a"))).toEqual(posOf(layout, agent("a")));
  });

  it("同一来源的根会话：第一个挂在来源卡上，其余各挂在上一个根会话下方，水平照布局里的错位左右交替", () => {
    const sessions = [1, 2, 3, 4, 5].map((n) => session(`s${n}`, "codex", n));
    const layout = layoutScene(sessions, { area: wide });
    expect(anchorOf(layout, agent("s1")).id).toBe(originNodeId("codex"));
    for (const n of [2, 3, 4, 5]) {
      const anchor = anchorOf(layout, agent(`s${n}`));
      expect(anchor.id, `s${n}`).toBe(agent(`s${n - 1}`));
      // 叶子会话之间，“紧挨着下方”正好就是布局里的实际偏移。
      expect(resolved(layout, agent(`s${n}`)), `s${n}`).toEqual(posOf(layout, agent(`s${n}`)));
      expect(anchor.dy).toBe(ROW);
    }
    expect(anchorOf(layout, agent("s2")).dx).toBe(NODE.stagger);
    expect(anchorOf(layout, agent("s3")).dx).toBe(-NODE.stagger);
    expect(anchorOf(layout, agent("s4")).dx).toBe(NODE.stagger);
  });

  it("紧凑画布没有错位：dx 为 0，新节点在参照的正下方", () => {
    const sessions = [1, 2, 3].map((n) => session(`s${n}`, "codex", n));
    const layout = layoutScene(sessions, { area: compactArea });
    for (const n of [2, 3]) {
      expect(anchorOf(layout, agent(`s${n}`))).toEqual({ id: agent(`s${n - 1}`), dx: 0, dy: ROW });
      expect(resolved(layout, agent(`s${n}`))).toEqual(posOf(layout, agent(`s${n}`)));
    }
  });

  it("子会话：第一个子会话挂在父会话上（偏移是布局里的实际位置），第二个起挂在上一个子会话下方", () => {
    const sessions = [session("p1", "codex", 1), session("p2", "codex", 2), child("c1", "codex", 3, "p2"), child("c2", "codex", 4, "p2"), child("c3", "codex", 5, "p2")];
    const layout = layoutScene(sessions, { area: wide });
    expect(anchorOf(layout, agent("c1")).id).toBe(agent("p2"));
    expect(resolved(layout, agent("c1"))).toEqual(posOf(layout, agent("c1")));
    // 子会话在父会话右边的下一列（p2 是第二个根，自己向右错了一个 stagger，子会话那一列没有错位）。
    expect(anchorOf(layout, agent("c1")).dx).toBe(NODE.agentW + NODE.childGap);
    expect(anchorOf(layout, agent("c2"))).toEqual({ id: agent("c1"), dx: NODE.stagger, dy: ROW });
    expect(anchorOf(layout, agent("c3"))).toEqual({ id: agent("c2"), dx: -NODE.stagger, dy: ROW });
    for (const id of ["c2", "c3"]) expect(resolved(layout, agent(id))).toEqual(posOf(layout, agent(id)));
  });

  it("只有一个子会话的子树和叶子一样高：下一个根会话照样落在紧下方", () => {
    const layout = layoutScene([session("p1", "codex", 1), child("c1", "codex", 2, "p1"), session("p2", "codex", 3)], { area: wide });
    expect(anchorOf(layout, agent("p2"))).toEqual({ id: agent("p1"), dx: NODE.stagger, dy: ROW });
    expect(resolved(layout, agent("p2"))).toEqual(posOf(layout, agent("p2")));
  });

  it("上一个兄弟带着更高的子树：竖直只隔一个行距，不照搬布局里让开子树的那一段（兄弟被拖走时子树不一定跟着走）", () => {
    const sessions = [session("p1", "codex", 1), child("k1", "codex", 2, "p1"), child("k2", "codex", 3, "p1"), child("k3", "codex", 4, "p1"), session("p2", "codex", 5)];
    const layout = layoutScene(sessions, { area: wide });
    const p1 = posOf(layout, agent("p1"));
    const p2 = posOf(layout, agent("p2"));
    const anchor = anchorOf(layout, agent("p2"));
    expect(anchor).toEqual({ id: agent("p1"), dx: NODE.stagger, dy: ROW });
    // 布局里 p2 在整棵子树下面（p1 在自己子树的正中），比“紧下方”低得多。
    const stack = 3 * NODE.agentH + 2 * NODE.rowGap;
    expect(p2.y - p1.y).toBe(stack + NODE.rowGap - (stack - NODE.agentH) / 2);
    expect(p2.y - p1.y).toBeGreaterThan(ROW);
  });

  it("多个来源：每个来源的第一个根会话挂在自己的来源卡上，参照不会跨来源", () => {
    const layout = layoutScene(sessionsOfThreeOrigins, { area: wide });
    expect(anchorOf(layout, agent("a1")).id).toBe(originNodeId("codex"));
    expect(anchorOf(layout, agent("b1")).id).toBe(originNodeId("cursor"));
    expect(anchorOf(layout, agent("c1")).id).toBe(originNodeId("console"));
    expect(anchorOf(layout, agent("a2")).id).toBe(agent("a1"));
    expect(anchorOf(layout, agent("a3")).id).toBe(agent("a2"));
    expect(anchorOf(layout, agent("b2")).id).toBe(agent("b1"));
    // 来源并排、整组被平移之后，偏移仍然对得上（整组一起平移，组内相对位置不变）。
    for (const id of ["a1", "a2", "a3", "b1", "b2", "c1"]) expect(resolved(layout, agent(id)), id).toEqual(posOf(layout, agent(id)));
  });

  it("锚点只会是布局里实际存在的节点，并且排在挂着它的节点前面（引擎按顺序逐个处理）", () => {
    const sessions = [...sessionsOfThreeOrigins, child("a1k", "codex", 7, "a1"), child("a1k2", "codex", 8, "a1")];
    const withGit = sessions.map((s) => ({ ...s, origin: { ...s.origin, workspace: REPO } }) as SessionSummary);
    for (const layout of [
      layoutScene(sessions, { area: wide }),
      layoutScene(sessions, { area: compactArea }),
      layoutScene(withGit, { area: wide, git: new Map([["codex", "repo"], ["cursor", "repo"], ["console", "repo"]]) }),
    ]) {
      const order = new Map(layout.nodes.map((n, i) => [n.id, i]));
      for (const n of layout.nodes) {
        if (!n.anchor) continue;
        expect(order.has(n.anchor.id), `${n.id} 的锚点 ${n.anchor.id} 不在布局里`).toBe(true);
        expect(order.get(n.anchor.id)!, `${n.id} 的锚点 ${n.anchor.id}`).toBeLessThan(order.get(n.id)!);
      }
    }
  });

  it("每个会话节点都有锚点（来源卡、Folder、Git 没有会话的那种锚点）", () => {
    const layout = layoutScene(sessionsOfThreeOrigins, { area: wide });
    for (const n of layout.nodes) {
      if (n.kind === "agent") expect(n.anchor, n.id).toBeDefined();
      if (n.kind === "origin") expect(n.anchor, n.id).toBeUndefined();
    }
  });

  it("被收起的会话不在布局里，也就不会成为参照：新节点的参照是布局里实际存在的上一个兄弟", () => {
    const sessions = [1, 2, 3, 4].map((n) => session(`s${n}`, "codex", n));
    const visible = new Set<SessionId>([sid("s1"), sid("s3"), sid("s4")]);
    const layout = layoutScene(sessions, { area: wide, visible });
    expect(layout.nodes.some((n) => n.id === agent("s2"))).toBe(false);
    expect(anchorOf(layout, agent("s3")).id).toBe(agent("s1"));
    expect(anchorOf(layout, agent("s4")).id).toBe(agent("s3"));
    for (const n of layout.nodes) if (n.anchor) expect(layout.nodes.some((other) => other.id === n.anchor!.id), n.id).toBe(true);
    // 收起的是第一个：剩下的第一个改挂在来源卡上。
    const hiddenFirst = layoutScene(sessions, { area: wide, visible: new Set<SessionId>([sid("s2"), sid("s3")]) });
    expect(anchorOf(hiddenFirst, agent("s2")).id).toBe(originNodeId("codex"));
    expect(anchorOf(hiddenFirst, agent("s3")).id).toBe(agent("s2"));
  });

  it("hidden：被视图过滤收起的会话节点 id（引擎据此认出“收起后重新出现”不是新到的）；没有会话被收起时不带这一项", () => {
    const sessions = [1, 2, 3, 4].map((n) => session(`s${n}`, "codex", n));
    const some = layoutScene(sessions, { area: wide, visible: new Set<SessionId>([sid("s1"), sid("s3")]) });
    expect(some.hidden).toEqual(new Set([agent("s2"), agent("s4")]));
    // 收起的会话从 nodes 里没了，但仍列在 hidden 里；两者合起来正好是全部会话。
    const drawn = new Set(some.nodes.filter((n) => n.kind === "agent").map((n) => n.id));
    expect(new Set([...drawn, ...some.hidden!])).toEqual(new Set(sessions.map((s) => agent(s.id))));
    for (const id of some.hidden!) expect(drawn.has(id)).toBe(false);
    // 没有收起任何会话：不给 visible、给“全部”、没有会话，都不带（所以与不过滤时的布局逐项相等）。
    expect("hidden" in layoutScene(sessions, { area: wide })).toBe(false);
    expect("hidden" in layoutScene(sessions, { area: wide, visible: new Set(sessions.map((s) => s.id)) })).toBe(false);
    expect("hidden" in layoutScene([], { visible: new Set() })).toBe(false);
    // 全部收起：节点一个都没有，hidden 是全部。
    const none = layoutScene(sessions, { area: wide, visible: new Set() });
    expect(none.nodes).toEqual([]);
    expect(none.hidden).toEqual(new Set(sessions.map((s) => agent(s.id))));
  });

  it("有 Folder / Git 节点时会话的锚点不变：只和同一来源里的会话、来源卡有关", () => {
    const sessions = [inDir("a", "o1", 1, REPO), inDir("b", "o1", 2, REPO)];
    const plain = layoutScene(sessions, { area: wide });
    const linked = layoutScene(sessions, { area: wide, git: new Map([["o1", "repo"]]) });
    for (const id of ["a", "b"]) expect(anchorOf(linked, agent(id))).toEqual(anchorOf(plain, agent(id)));
  });

  it("父子互指等异常数据：每个会话仍有位置，锚点不指向自己", () => {
    const layout = layoutScene([child("x", "codex", 1, "y"), child("y", "codex", 2, "x")], { area: wide });
    for (const n of layout.nodes) if (n.anchor) expect(n.anchor.id).not.toBe(n.id);
    expect(layout.nodes.filter((n) => n.kind === "agent")).toHaveLength(2);
  });
});
