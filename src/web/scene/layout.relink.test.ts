import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@shared/types";
import { agentNodeId, layoutScene, NODE, originNodeId } from "./layout";
import { node, overlapsOf, session } from "./layout.fixtures";

/** 摘要里的上级变了（服务端事后改挂）以后重新排版：不改 layout.ts，只验证它对这种输入的结果。 */
describe("布局：会话的上级事后变了", () => {
  const FIXES = ["f1", "f2", "f3", "f4"];
  const plain = (): SessionSummary[] => [session("review", "main", 1), ...FIXES.map((id, index) => session(id, "main", 2 + index))];
  const underReview = (ids: readonly string[]): SessionSummary[] =>
    plain().map((summary) => (ids.includes(summary.id) ? ({ ...summary, parentSessionId: "review", depth: 1 } as SessionSummary) : summary));
  const edgeSources = (sessions: SessionSummary[], id: string): string[] =>
    layoutScene(sessions).edges.filter((edge) => edge.to === agentNodeId(id)).map((edge) => edge.from);

  it("没有上级时，每个会话都连在来源卡上", () => {
    for (const id of ["review", ...FIXES]) expect(edgeSources(plain(), id), id).toEqual([originNodeId("main")]);
  });

  it("四个修复会话改挂到审阅会话下面：线从审阅会话连出，来源卡到它们的线消失，不重叠", () => {
    const layout = layoutScene(underReview(FIXES));
    for (const id of FIXES) expect(edgeSources(underReview(FIXES), id), id).toEqual([agentNodeId("review")]);
    expect(edgeSources(underReview(FIXES), "review")).toEqual([originNodeId("main")]);
    expect(layout.edges.filter((edge) => edge.from === originNodeId("main"))).toHaveLength(1);

    const review = node(layout, agentNodeId("review"));
    const fixes = FIXES.map((id) => node(layout, agentNodeId(id)));
    // 都在审阅会话的后一列（奇数位按错位向右），自上而下按创建先后排，审阅会话相对它们垂直居中。
    for (const fix of fixes) expect(fix.x).toBeGreaterThanOrEqual(review.x + review.w);
    expect(fixes.map((fix) => fix.y)).toEqual([...fixes.map((fix) => fix.y)].sort((a, b) => a - b));
    expect(review.y + review.h / 2).toBeCloseTo((fixes[0]!.y + (fixes[3]!.y + fixes[3]!.h)) / 2, 6);
    expect(fixes[1]!.x - fixes[0]!.x).toBe(NODE.stagger);
    expect(overlapsOf(layout)).toEqual([]);
  });

  it("只改挂其中两个：另外两个仍在来源卡下，所有节点互不重叠", () => {
    const sessions = underReview(["f2", "f4"]);
    expect(edgeSources(sessions, "f1")).toEqual([originNodeId("main")]);
    expect(edgeSources(sessions, "f2")).toEqual([agentNodeId("review")]);
    expect(edgeSources(sessions, "f3")).toEqual([originNodeId("main")]);
    expect(edgeSources(sessions, "f4")).toEqual([agentNodeId("review")]);
    expect(overlapsOf(layoutScene(sessions))).toEqual([]);
  });

  it("改回没有上级以后，整张布局与最初完全一致，没有残留的位置或连线", () => {
    const before = layoutScene(plain());
    layoutScene(underReview(FIXES));
    const after = layoutScene(plain());
    expect(after.nodes).toEqual(before.nodes);
    expect(after.edges).toEqual(before.edges);
  });

  it("改挂后，旧上级与新上级各自的子树独立排版", () => {
    const sessions = plain().map((summary) =>
      summary.id === "f1" ? ({ ...summary, parentSessionId: "f2", depth: 1 } as SessionSummary) : summary.id === "f3" ? ({ ...summary, parentSessionId: "review", depth: 1 } as SessionSummary) : summary,
    );
    const layout = layoutScene(sessions);
    expect(edgeSources(sessions, "f1")).toEqual([agentNodeId("f2")]);
    expect(edgeSources(sessions, "f3")).toEqual([agentNodeId("review")]);
    expect(overlapsOf(layout)).toEqual([]);
    // 子会话在上级的后一列。
    expect(node(layout, agentNodeId("f1")).x).toBeGreaterThan(node(layout, agentNodeId("f2")).x);
    expect(node(layout, agentNodeId("f3")).x).toBeGreaterThan(node(layout, agentNodeId("review")).x);
  });
});
