import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog, testOrigin, USER } from "@shared/testing";
import type { SessionId, SessionSummary } from "@shared/types";
import { patchSummary, setLang, store } from "../lib/app";
import { SummaryPanel, TaskPanel } from "./Panels";

function logFor(id: SessionId, title: string, order: number): EventLog {
  const log = new EventLog(id);
  log.created({ title, origin: testOrigin({ key: "codex:origin", hostLabel: "Main Agent" }), createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, order)).toISOString() });
  return log;
}

const summaryOf = (log: EventLog, childIds: SessionId[] = []): SessionSummary => toSummary(replay(log.events)!, childIds);

function relink(log: EventLog, parentSessionId: SessionId | null, depth: number, previous: { parentSessionId?: SessionId; depth: number }): void {
  log.push({ kind: "session.relinked", data: { parentSessionId, depth, previous, cause: "self", by: USER } }, { source: "user" });
}

it("shows the new parent in the task panel and the moved session in the parent's child list, and tidies both on the way back", () => {
  const review = logFor("review", "代码质量审阅", 1);
  const fix = logFor("fix", "修复 R4：对话流", 2);
  const previous = store.get().sessions;
  setLang("zh");
  store.set({ sessions: { review: summaryOf(review), fix: summaryOf(fix) } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const renderPanels = (): void => {
    const sessions = store.get().sessions;
    act(() =>
      root.render(
        <>
          <section data-panel="fix">
            <TaskPanel state={replay(fix.events)!} summary={sessions["fix"]!} />
          </section>
          <section data-panel="review">
            <SummaryPanel state={replay(review.events)!} summary={sessions["review"]!} />
          </section>
        </>,
      ),
    );
  };
  const panel = (name: string): HTMLElement => container.querySelector<HTMLElement>(`[data-panel="${name}"]`)!;
  const parentLink = (): string | undefined => panel("fix").querySelector(".parent-link")?.textContent ?? undefined;
  const children = (): string[] => [...panel("review").querySelectorAll(".children .child-title")].map((title) => title.textContent ?? "");
  const originCard = (): string => panel("fix").querySelector(".origin-card-title")?.textContent ?? "";

  try {
    renderPanels();
    expect(parentLink()).toBeUndefined();
    expect(children()).toEqual([]);
    expect(originCard()).toBe("由 Main Agent 派发");

    relink(fix, "review", 1, { depth: 0 });
    act(() => {
      patchSummary(summaryOf(fix));
      patchSummary(summaryOf(review, ["fix"]));
    });
    renderPanels();
    expect(parentLink()).toContain("上级会话");
    expect(parentLink()).toContain("代码质量审阅");
    expect(children()).toEqual(["修复 R4：对话流"]);
    // 发起端仍是 Main Agent：这一行是事实，不会因为有了上级会话而变。
    expect(originCard()).toBe("由 Main Agent 派发");
    expect(panel("fix").textContent).not.toContain("上级会话的记录已不存在");

    relink(fix, null, 0, { parentSessionId: "review", depth: 1 });
    act(() => {
      patchSummary(summaryOf(fix));
      patchSummary(summaryOf(review, []));
    });
    renderPanels();
    expect(parentLink()).toBeUndefined();
    expect(children()).toEqual([]);
    expect(panel("fix").textContent).not.toContain("上级会话的记录已不存在");
    expect(originCard()).toBe("由 Main Agent 派发");
  } finally {
    act(() => root.unmount());
    container.remove();
    store.set({ sessions: previous });
    vi.unstubAllGlobals();
  }
});
