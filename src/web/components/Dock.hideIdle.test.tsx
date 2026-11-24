import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionPhase, SessionSummary } from "@shared/types";
import { HIDE_IDLE_KEY, setHideIdle, setLang, store } from "../lib/app";
import { buildWorkspaces } from "../lib/workspaces";
import { WorkspaceHeader } from "./WorkspaceHeader";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 空间标头右上角的“仅工作中”数据过滤开关：存在条件、aria-pressed、数量、提示、持久化与中英文。 */

const session = (id: string, phase: SessionPhase, parent?: string): SessionSummary =>
  ({
    id,
    title: id,
    phase,
    status: phase,
    harness: "cursor",
    runtime: "native",
    cwd: "C:\\proj",
    origin: { key: "cursor:conv-1", kind: "agent", host: "cursor", hostLabel: "Cursor", evidence: [] },
    createdAt: "2026-11-16T00:00:00.000Z",
    updatedAt: "2026-11-16T00:00:00.000Z",
    runCount: 1,
    counters: { steps: 0, failures: 0, files: 0, interventions: 0 },
    messages: { total: 1, pending: 0 },
    seq: 1,
    ...(parent ? { parentSessionId: parent } : {}),
  }) as unknown as SessionSummary;

describe("WorkspaceHeader · 隐藏未在工作的会话（仅工作中开关）", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let previous: ReturnType<typeof store.get>;

  beforeEach(() => {
    previous = store.get();
    localStorage.removeItem(HIDE_IDLE_KEY);
    store.set({ conn: "live", harnesses: [], sessions: {}, hideIdle: false, viewMode: "canvas" });
    setLang("zh");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    store.set(previous);
    localStorage.removeItem(HIDE_IDLE_KEY);
  });

  const renderHeader = (
    list: SessionSummary[],
    scope: { kind: "origin"; key: string } | { kind: "active" } | { kind: "all" } = { kind: "origin", key: "cursor:conv-1" },
  ): void => {
    const workspaces = buildWorkspaces(list);
    const workspace = scope.kind === "origin" ? workspaces.find((w) => w.key === scope.key) : undefined;
    act(() =>
      root.render(
        <WorkspaceHeader
          scope={scope}
          {...(workspace ? { workspace } : {})}
          allWorkspaces={workspaces}
          scopedSessions={list}
          allSessions={list}
        />,
      ),
    );
  };

  const button = (): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>(".ws-filter-btn");
  const count = (): string | undefined => button()?.querySelector(".ws-filter-count")?.textContent ?? undefined;

  it("在单空间与全部空间显示，在「全部活跃」空间不重复显示", () => {
    const list = [session("a", "done")];
    renderHeader(list, { kind: "origin", key: "cursor:conv-1" });
    expect(button()).not.toBeNull();
    renderHeader(list, { kind: "all" });
    expect(button()).not.toBeNull();
    renderHeader(list, { kind: "active" });
    expect(button()).toBeNull();
  });

  it("默认关着：aria-pressed 为 false，没有 data-active，aria-label 稳定为“隐藏未在工作的会话”", () => {
    renderHeader([session("a", "done")]);
    expect(button()!.getAttribute("aria-pressed")).toBe("false");
    expect(button()!.hasAttribute("data-active")).toBe(false);
    expect(button()!.getAttribute("aria-label")).toBe("隐藏未在工作的会话");
  });

  it("点击翻转状态并写进 localStorage；再点一次翻回来", () => {
    renderHeader([session("a", "done")]);
    act(() => button()!.click());
    expect(store.get().hideIdle).toBe(true);
    expect(localStorage.getItem(HIDE_IDLE_KEY)).toBe("1");
    expect(button()!.getAttribute("aria-pressed")).toBe("true");
    expect(button()!.hasAttribute("data-active")).toBe(true);

    act(() => button()!.click());
    expect(store.get().hideIdle).toBe(false);
    expect(localStorage.getItem(HIDE_IDLE_KEY)).toBe("0");
    expect(button()!.getAttribute("aria-pressed")).toBe("false");
  });

  it("待命（ready）算工作中，不会被收起；有工作中子会话的已完成祖先也保留、不计入被收起数", () => {
    act(() => setHideIdle(true));
    renderHeader([
      session("done1", "done"),
      session("failed1", "failed"),
      session("ready1", "ready"),
      session("parent_done", "done"),
      session("child_run", "running", "parent_done"),
    ]);
    // 只有 done1 和 failed1 会被收起（ready1 算工作中，parent_done 为保真父子关系保留）
    expect(count()).toBe("2");
    expect(button()!.getAttribute("data-tip")).toContain("已隐藏 2 个");
    expect(button()!.getAttribute("data-tip")).toContain("待命的会话算工作中");
    expect(button()!.getAttribute("data-tip")).toContain("有工作中子会话的上级会保留");
  });

  it("关闭时不显示角标数字，打开且超过 99 个时显示 99+（确切数字在提示里）", () => {
    const many = Array.from({ length: 105 }, (_, i) => session(`s_${i}`, "done"));
    renderHeader(many);
    expect(count()).toBeUndefined();
    expect(button()!.getAttribute("data-tip")).toContain("可收起 105 个");

    act(() => setHideIdle(true));
    renderHeader(many);
    expect(count()).toBe("99+");
    expect(button()!.getAttribute("data-tip")).toContain("已隐藏 105 个");
  });

  it("英文界面同步翻译提示与可访问描述", () => {
    setLang("en");
    renderHeader([session("a", "done")]);
    expect(button()!.getAttribute("aria-label")).toBe("Hide sessions that aren't working");
    expect(button()!.getAttribute("data-tip")).toContain("1 can be hidden");
    expect(button()!.getAttribute("aria-description")).toBe(button()!.getAttribute("data-tip"));
  });
});
