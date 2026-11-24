import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog, testOrigin, USER } from "@shared/testing";
import type { SessionId, SessionSummary } from "@shared/types";
import { patchSummary, store } from "../lib/app";
import { SceneEngine } from "../scene/engine";
import { agentNodeId, originNodeId, type SceneLayout } from "../scene/layout";
import { node, overlapsOf } from "../scene/layout.fixtures";
import { Overview } from "./Overview";

const ORIGIN = testOrigin({ key: "codex:origin" });

function logFor(id: SessionId, order: number): EventLog {
  const log = new EventLog(id);
  log.created({ title: id, origin: ORIGIN, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, order)).toISOString() });
  return log;
}

/** 服务端在 hub 里按事件算出的摘要：这里用同一份投影，childIds 由调用者给出（来自 hub 的 children 表）。 */
const summaryOf = (log: EventLog, childIds: SessionId[] = []): SessionSummary => toSummary(replay(log.events)!, childIds);

function relink(log: EventLog, parentSessionId: SessionId | null, depth: number, previous: { parentSessionId?: SessionId; depth: number }): void {
  log.push({ kind: "session.relinked", data: { parentSessionId, depth, previous, cause: "self", by: USER } }, { source: "user" });
}

it("redraws the line from the new parent when a session is moved under another one, and back again", () => {
  const review = logFor("review", 1);
  const fix = logFor("fix", 2);
  const other = logFor("other", 3);
  const previous = store.get().sessions;
  store.set({ sessions: { review: summaryOf(review), fix: summaryOf(fix), other: summaryOf(other) } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const engine = new SceneEngine();
  const setLayout = vi.spyOn(engine, "setLayout");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const layout = (): SceneLayout => setLayout.mock.lastCall![0];
  const edgesInto = (id: SessionId): string[] => layout().edges.filter((edge) => edge.to === agentNodeId(id)).map((edge) => edge.from);
  const drawnAgents = (): string[] => [...container.querySelectorAll(".node.agent")].map((element) => element.getAttribute("data-node-id")!);
  /** 服务端会推送被改会话、旧上级、新上级三份摘要。 */
  const push = (...summaries: SessionSummary[]): void => {
    act(() => {
      for (const summary of summaries) patchSummary(summary);
    });
  };

  try {
    act(() => root.render(<Overview engine={engine} />));
    const before = layout();
    const origin = originNodeId(ORIGIN.key);
    for (const id of ["review", "fix", "other"]) expect(edgesInto(id), id).toEqual([origin]);

    // fix 改挂到 review 下：线从 review 连出，来源卡到 fix 的那条消失；review 的子会话挪到它后一列。
    relink(fix, "review", 1, { depth: 0 });
    push(summaryOf(fix), summaryOf(review, ["fix"]));
    expect(edgesInto("fix")).toEqual([agentNodeId("review")]);
    expect(edgesInto("review")).toEqual([origin]);
    expect(edgesInto("other")).toEqual([origin]);
    // 列宽随取景区域的大小（紧凑或常规）而不同，这里只认“在 review 的右边一列”。
    const reviewNode = node(layout(), agentNodeId("review"));
    expect(node(layout(), agentNodeId("fix")).x).toBeGreaterThanOrEqual(reviewNode.x + reviewNode.w);
    expect(overlapsOf(layout())).toEqual([]);
    expect(drawnAgents().sort()).toEqual(["agent:fix", "agent:other", "agent:review"]);

    // 再从 review 挪到 other：旧上级不再连它，新上级连它。
    relink(fix, "other", 1, { parentSessionId: "review", depth: 1 });
    push(summaryOf(fix), summaryOf(review, []), summaryOf(other, ["fix"]));
    expect(edgesInto("fix")).toEqual([agentNodeId("other")]);
    expect(layout().edges.some((edge) => edge.from === agentNodeId("review"))).toBe(false);
    expect(overlapsOf(layout())).toEqual([]);

    // 改回没有上级：回到来源卡下，整张布局与最初完全一致（没有残留、也不会跳到别处）。
    relink(fix, null, 0, { parentSessionId: "other", depth: 1 });
    push(summaryOf(fix), summaryOf(other, []));
    expect(edgesInto("fix")).toEqual([origin]);
    expect(layout().nodes).toEqual(before.nodes);
    expect(layout().edges).toEqual(before.edges);
    expect(drawnAgents().sort()).toEqual(["agent:fix", "agent:other", "agent:review"]);
  } finally {
    act(() => root.unmount());
    container.remove();
    store.set({ sessions: previous });
    vi.unstubAllGlobals();
  }
});
