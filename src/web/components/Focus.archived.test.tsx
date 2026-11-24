import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replay, toSummary, type SessionState } from "@shared/projection";
import { EventLog } from "@shared/testing";
import type { SessionSummary } from "@shared/types";
import { setLang, store } from "../lib/app";
import { archiveUi } from "../lib/archive";
import { ARCHIVED_AT, stubApi } from "../lib/archive.fixtures";
import { dateMinute } from "../lib/text";
import { Focus } from "./Focus";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 一个会话的真实投影（状态与摘要同一份事件），再用 patch 盖掉要测的字段。 */
function sessionOf(id: string, patch: Partial<SessionSummary> = {}): { state: SessionState; summary: SessionSummary } {
  const log = new EventLog(id);
  log.created({ id, harness: "cursor", runtime: "native", title: `标题 ${id}` });
  const state = replay(log.events);
  if (!state) throw new Error("missing session state");
  return { state, summary: { ...toSummary(state), ...patch } };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("Focus：已归档的会话", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const previous = store.get();

  beforeEach(() => {
    setLang("zh");
    location.hash = "";
    store.set({ sessions: {}, archived: {}, archivedCount: 1, detail: undefined, toasts: [], settings: { open: false, section: undefined }, confirm: undefined, switcherOpen: false });
    archiveUi.set({ list: { status: "idle" }, busy: 0 });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    location.hash = "";
    vi.unstubAllGlobals();
    store.set(previous);
    archiveUi.set({ list: { status: "idle" }, busy: 0 });
  });

  /** 把会话放进它该在的那张表（未归档的在 sessions，已归档的在 archived），并读好详情，再打开聚焦页。 */
  const open = (one: { state: SessionState; summary: SessionSummary }, table: "sessions" | "archived"): void => {
    const entry = { [one.summary.id]: one.summary };
    store.set(table === "sessions" ? { sessions: entry } : { archived: entry });
    store.set({ detail: { id: one.summary.id, state: one.state, rev: 0, loading: false } });
    act(() => root.render(<Focus id={one.summary.id} />));
  };
  const back = (): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>(".head-top .btn--back");
  const chips = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(".head-chips .chip")];
  const unarchiveButton = (): HTMLButtonElement | undefined => [...host.querySelectorAll<HTMLButtonElement>(".focus-head button")].find((button) => button.textContent === "取消归档");

  it("只在已归档表里的会话也能打开：页头有“已归档”标记，返回按钮写“已归档”，下面钉着一条说明", () => {
    open(sessionOf("ses_arch", { phase: "done", archivedAt: ARCHIVED_AT, archivedBy: "user" }), "archived");

    // 不在 sessions 里不等于“不存在”：页头画出来了，没有落到“找不到这个会话”的占位里。
    expect(host.querySelector(".focus-head")).not.toBeNull();
    expect(back()?.textContent).toBe("已归档");
    const chip = chips().find((candidate) => candidate.textContent === "已归档");
    expect(chip?.getAttribute("data-tip")).toBe("这个会话已归档：不在画布、侧栏与列表里，记录原样保留。");

    const banner = host.querySelector(".banner--archived");
    expect(banner?.getAttribute("role")).toBe("status");
    expect(banner?.textContent).toBe(
      `这个会话已于 ${dateMinute(ARCHIVED_AT, "zh", true)} 归档：不在画布、侧栏与列表里，记录原样保留。取消归档会连同它的下级和仍在归档中的上级一起恢复；给它发送消息也会先取消归档。`,
    );
    // 归档不是“已不存在”：不会出现那条琥珀色的提示。
    expect(host.querySelector(".banner--amber")).toBeNull();
  });

  it("留存策略自动归档的，说明里如实写是留存策略归档的", () => {
    open(sessionOf("ses_auto", { phase: "done", archivedAt: ARCHIVED_AT, archivedBy: "retention" }), "archived");
    expect(host.querySelector(".banner--archived")?.textContent?.startsWith(`留存策略已于 ${dateMinute(ARCHIVED_AT, "zh", true)} 自动归档了这个会话`)).toBe(true);
  });

  it("页头里有“取消归档”按钮，悬停说明写明会一并恢复什么；点一下按会话 id 请求", async () => {
    const calls = stubApi(() => ({ body: { changed: ["ses_arch"], skipped: [] } }));
    open(sessionOf("ses_arch", { phase: "done", archivedAt: ARCHIVED_AT, archivedBy: "user" }), "archived");

    const button = unarchiveButton()!;
    expect(button.getAttribute("data-tip")).toBe("取消归档：连同它的下级和仍在归档中的上级一起恢复");
    await act(async () => {
      button.click();
      await settle();
    });
    expect(calls).toEqual([{ method: "POST", path: "/api/sessions/unarchive", body: { ids: ["ses_arch"] } }]);
  });

  it("有归档操作在途：按钮禁用并标忙，在途结束后恢复", () => {
    open(sessionOf("ses_arch", { phase: "done", archivedAt: ARCHIVED_AT, archivedBy: "user" }), "archived");
    act(() => archiveUi.set({ busy: 1 }));
    expect(unarchiveButton()!.disabled).toBe(true);
    expect(unarchiveButton()!.getAttribute("aria-busy")).toBe("true");
    act(() => archiveUi.set({ busy: 0 }));
    expect(unarchiveButton()!.disabled).toBe(false);
    expect(unarchiveButton()!.hasAttribute("aria-busy")).toBe(false);
  });

  it("返回按钮与 Esc 回到“已归档”视图，不是某个画布", () => {
    open(sessionOf("ses_arch", { phase: "done", archivedAt: ARCHIVED_AT, archivedBy: "user" }), "archived");
    act(() => back()!.click());
    expect(location.hash).toBe("#/archived");

    location.hash = "";
    act(() => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(location.hash).toBe("#/archived");
  });

  it("对照：没有归档的会话没有标记、说明与“取消归档”按钮，返回按钮仍是“全部会话”", () => {
    open(sessionOf("ses_live", { phase: "done" }), "sessions");
    expect(back()?.textContent).toBe("全部会话");
    expect(chips().some((chip) => chip.textContent === "已归档")).toBe(false);
    expect(host.querySelector(".banner--archived")).toBeNull();
    expect(unarchiveButton()).toBeUndefined();
  });

  it("英文界面", () => {
    setLang("en");
    open(sessionOf("ses_arch", { phase: "done", archivedAt: ARCHIVED_AT, archivedBy: "user" }), "archived");
    expect(back()?.textContent).toBe("Archived");
    expect(host.querySelector(".banner--archived")?.textContent?.startsWith("Archived ")).toBe(true);
    expect([...host.querySelectorAll<HTMLButtonElement>(".focus-head button")].some((button) => button.textContent === "Unarchive")).toBe(true);
  });
});
