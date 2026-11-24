import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLang, store } from "../lib/app";
import { summary } from "../lib/archive.fixtures";
import { buildWorkspaces } from "../lib/workspaces";
import { WorkspaceRail, WorkspaceTopBar, type WorkspaceRailProps } from "./WorkspaceRail";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sessions = [summary("a", { phase: "done" })];
const ORIGIN = sessions[0]!.origin.key;

describe("WorkspaceRail · 底部的“已归档”行与窄屏顶栏", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let previous: ReturnType<typeof store.get>;

  beforeEach(() => {
    previous = store.get();
    localStorage.clear();
    location.hash = "";
    setLang("zh");
    store.set({ archivedCount: undefined });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    location.hash = "";
    localStorage.clear();
    store.set(previous);
  });

  const render = (extra: Partial<WorkspaceRailProps> = {}): void =>
    act(() =>
      root.render(<WorkspaceRail workspaces={buildWorkspaces(sessions)} sessions={sessions} currentScope={{ kind: "all" }} {...extra} />),
    );
  const archivedRow = (): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>(".rail-archived button");
  const current = (): Element[] => [...host.querySelectorAll('[aria-current="page"]')];
  const titleOf = (element: Element | null | undefined): string | undefined => element?.querySelector(".rail-item-title")?.textContent ?? undefined;

  it("服务不报已归档个数（老服务，没有归档）：没有这一行", () => {
    store.set({ archivedCount: undefined });
    render();
    expect(host.querySelector(".rail-archived")).toBeNull();
  });

  it("一个都没有归档：没有这一行（不为空的东西留位置）", () => {
    store.set({ archivedCount: 0 });
    render();
    expect(host.querySelector(".rail-archived")).toBeNull();
  });

  it("有归档：安静地写着“已归档”和个数，不高亮；点它进入已归档视图", () => {
    store.set({ archivedCount: 5 });
    render();
    const row = archivedRow()!;
    expect(titleOf(row)).toBe("已归档");
    expect(row.querySelector(".rail-count")?.textContent).toBe("5");
    expect(row.hasAttribute("data-active")).toBe(false);
    expect(row.getAttribute("aria-current")).toBeNull();

    act(() => row.click());
    expect(location.hash).toBe("#/archived");
  });

  it("位置：在可滚动的 Main Agent 列表之后、底栏之前，和“进行中 / 最近”不混在一起", () => {
    store.set({ archivedCount: 2 });
    render();
    const scroll = host.querySelector(".rail-scroll")!;
    expect(scroll.nextElementSibling).toBe(host.querySelector(".rail-archived"));
    expect(host.querySelector(".rail-scroll .rail-archived")).toBeNull();
    expect(host.querySelector(".rail-nav")?.contains(host.querySelector(".rail-archived"))).toBe(true);
  });

  it("在已归档视图里：只有这一行高亮；“全部活跃 / 全部空间 / 各 Main Agent”一个都不高亮，哪怕 currentScope 还停在上一次的空间", () => {
    store.set({ archivedCount: 5 });
    render({ currentScope: { kind: "origin", key: ORIGIN }, archivedActive: true });
    const marked = current();
    expect(marked).toHaveLength(1);
    expect(titleOf(marked[0])).toBe("已归档");
    expect(host.querySelectorAll("[data-active]")).toHaveLength(1);
    expect(host.querySelector(".rail-entry .rail-item[data-active]")).toBeNull();
  });

  it("对照：不在已归档视图时，当前空间照常高亮，“已归档”行不高亮", () => {
    store.set({ archivedCount: 5 });
    render({ currentScope: { kind: "origin", key: ORIGIN } });
    const marked = current();
    expect(marked).toHaveLength(1);
    expect(marked[0]?.closest(".rail-entry")).not.toBeNull();
    expect(archivedRow()?.hasAttribute("data-active")).toBe(false);
  });

  it("在已归档视图里、而它恰好空了（刚取消归档最后一条）：入口仍在，免得页面还在而入口消失", () => {
    store.set({ archivedCount: 0 });
    render({ archivedActive: true });
    const row = archivedRow()!;
    expect(row).not.toBeNull();
    expect(row.querySelector(".rail-count")?.textContent).toBe("0");
    expect(row.getAttribute("aria-current")).toBe("page");
  });

  it("个数跟着服务端报告的数变（SSE 推来新的个数）", () => {
    store.set({ archivedCount: 5 });
    render();
    expect(archivedRow()?.querySelector(".rail-count")?.textContent).toBe("5");
    act(() => store.set({ archivedCount: 6 }));
    expect(archivedRow()?.querySelector(".rail-count")?.textContent).toBe("6");
    act(() => store.set({ archivedCount: 0 }));
    expect(archivedRow()).toBeNull();
  });

  it("英文界面", () => {
    setLang("en");
    store.set({ archivedCount: 3 });
    render();
    expect(titleOf(archivedRow())).toBe("Archived");
  });

  describe("窄屏顶栏", () => {
    it("在已归档视图里，快切入口写“已归档”；否则写当前空间", () => {
      act(() => root.render(<WorkspaceTopBar currentScope={{ kind: "all" }} archived />));
      expect(host.querySelector(".ws-topbar-name")?.textContent).toBe("已归档");

      act(() => root.render(<WorkspaceTopBar currentScope={{ kind: "all" }} />));
      expect(host.querySelector(".ws-topbar-name")?.textContent).toBe("全部空间");

      act(() => root.render(<WorkspaceTopBar currentScope={{ kind: "active" }} />));
      expect(host.querySelector(".ws-topbar-name")?.textContent).toBe("全部活跃");
    });

    it("点开仍是切换空间的快切器（用来离开已归档这一页），不是别的东西", () => {
      store.set({ switcherOpen: false });
      act(() => root.render(<WorkspaceTopBar currentScope={{ kind: "all" }} archived />));
      act(() => host.querySelector<HTMLButtonElement>(".ws-topbar-switch")!.click());
      expect(store.get().switcherOpen).toBe(true);
    });
  });
});
