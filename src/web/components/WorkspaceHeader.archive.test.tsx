import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@shared/types";
import { setLang, store } from "../lib/app";
import { archiveUi } from "../lib/archive";
import { stubApi, summary } from "../lib/archive.fixtures";
import { buildWorkspaces } from "../lib/workspaces";
import { WorkspaceHeader, type WorkspaceHeaderProps } from "./WorkspaceHeader";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 第 n 秒创建（数字越大越新）。 */
const at = (second: number): string => new Date(Date.UTC(2026, 10, 1, 0, 0, second)).toISOString();
const finished = (id: string, patch: Partial<SessionSummary> = {}): SessionSummary => summary(id, { phase: "done", createdAt: at(1), ...patch });
const working = (id: string, patch: Partial<SessionSummary> = {}): SessionSummary => summary(id, { phase: "running", createdAt: at(1), ...patch });

describe("WorkspaceHeader · “归档已完成会话”", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const previous = store.get();

  beforeEach(() => {
    setLang("zh");
    store.set({ archivedCount: 3, confirm: undefined, toasts: [] });
    archiveUi.set({ list: { status: "idle" }, busy: 0 });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    store.set(previous);
    archiveUi.set({ list: { status: "idle" }, busy: 0 });
  });

  const show = (list: readonly SessionSummary[], extra: Partial<WorkspaceHeaderProps> = {}): void =>
    act(() => root.render(<WorkspaceHeader scope={{ kind: "all" }} allWorkspaces={buildWorkspaces(list)} scopedSessions={list} allSessions={list} {...extra} />));
  const button = (): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>(".ws-archive-btn");
  const badge = (): string | undefined => button()?.querySelector(".ws-filter-count")?.textContent ?? undefined;
  const tip = (): string => button()?.getAttribute("data-tip") ?? "";

  it("入口在页头的视图选项区（.ws-head-actions），不在只显示文字与图标的 .ws-head-line 那一行", () => {
    show([finished("a")]);
    expect(button()).not.toBeNull();
    expect(host.querySelector(".ws-head-actions .ws-archive-btn")).not.toBeNull();
    expect(host.querySelector(".ws-head-line .ws-archive-btn")).toBeNull();
    expect(host.querySelector(".ws-head-line button")).toBeNull();
  });

  it("单个 Main Agent 空间里同样在视图选项区；那一行仍然没有按钮", () => {
    const list = [finished("a")];
    const workspace = buildWorkspaces(list)[0]!;
    show(list, { scope: { kind: "origin", key: workspace.key }, workspace });
    expect(host.querySelector(".ws-head-actions .ws-archive-btn")).not.toBeNull();
    expect(host.querySelector(".ws-head-line button")).toBeNull();
  });

  it("没有这个入口的三种情况：老服务不报已归档个数、“进行中”视图、当前范围里没有会话", () => {
    act(() => store.set({ archivedCount: undefined }));
    show([finished("a")]);
    expect(button()).toBeNull();

    act(() => store.set({ archivedCount: 3 }));
    show([finished("a")], { scope: { kind: "active" } });
    expect(button()).toBeNull();

    show([]);
    expect(button()).toBeNull();
  });

  it("入口随服务能力出现与消失：快照里的 archivedCount 一变，按钮跟着变", () => {
    show([finished("a")]);
    expect(button()).not.toBeNull();
    act(() => store.set({ archivedCount: undefined }));
    expect(button()).toBeNull();
    act(() => store.set({ archivedCount: 0 }));
    expect(button()).not.toBeNull();
  });

  it("有可归档的：写着数量（实际会移出视图的会话数，含随上级走的下级），说明里写明留下的原因；aria-label 与可见文字一致，说明同时给悬停和读屏", () => {
    const list = [
      finished("r", { createdAt: at(1) }),
      finished("c", { createdAt: at(2), parentSessionId: "r" }),
      finished("x", { createdAt: at(3) }),
      working("w", { createdAt: at(4) }),
    ];
    show(list);
    const archive = button()!;
    expect(archive.getAttribute("aria-label")).toBe("归档已完成会话");
    expect(archive.querySelector(".ws-action-label")?.textContent).toBe("归档已完成会话");
    expect(archive.hasAttribute("aria-disabled")).toBe(false);
    expect(badge()).toBe("3");

    const lines = tip().split("\n");
    expect(lines).toEqual([
      "归档 3 个已结束的会话（失败、已中断、已关闭、已失联也算已结束；整棵任务树都结束了才会归档）",
      "还有 1 个会话在工作，等它们结束后才能归档",
    ]);
    expect(archive.getAttribute("aria-description")).toBe(tip());
  });

  it("下级还在工作：整棵树（含已结束的上级）都不挑；没有别的可挑时按钮禁用并写明真实原因，不显示数量", () => {
    show([finished("r", { createdAt: at(1) }), working("c", { parentSessionId: "r", createdAt: at(2) })]);
    const archive = button()!;
    expect(archive.getAttribute("aria-disabled")).toBe("true");
    expect(badge()).toBeUndefined();
    expect(tip()).toBe("还有 1 个会话在工作，等它们结束后才能归档");
    // aria-disabled 不拦截键盘聚焦：按钮还是个 button，没有 disabled 属性。
    expect(archive.disabled).toBe(false);
  });

  it("上级还在工作、下级已结束：下级自己的子树结束了，可以单独归档（与服务端 planArchive 同一条规则）", () => {
    show([working("r", { createdAt: at(1) }), finished("c", { parentSessionId: "r", createdAt: at(2) })]);
    expect(button()!.hasAttribute("aria-disabled")).toBe(false);
    expect(badge()).toBe("1");
    expect(tip().split("\n")).toEqual([
      "归档 1 个已结束的会话（失败、已中断、已关闭、已失联也算已结束；整棵任务树都结束了才会归档）",
      "还有 1 个会话在工作，等它们结束后才能归档",
    ]);
  });

  it("待命（ready）不算已结束：原因写“在待命”；消息没被确认的已结束会话写“消息没有被确认”", () => {
    show([summary("a", { phase: "ready" })]);
    expect(button()!.getAttribute("aria-disabled")).toBe("true");
    expect(tip()).toBe("还有 1 个会话在待命（还开着，不算已结束），关闭后才能归档");

    show([summary("b", { phase: "done", messages: { ...summary("b").messages, pending: 2 } })]);
    expect(tip()).toBe("还有 1 个会话的消息没有被确认，处理完才能归档");
  });

  it("禁用时点击什么都不会发生（aria-disabled 不拦点击，由处理函数自己判断）", () => {
    show([working("a")]);
    act(() => button()!.click());
    expect(store.get().confirm).toBeUndefined();
  });

  it("点击：先问一次（写明实际归档几个），确认之后才发请求；名单是最上层的会话，不含随上级走的下级", async () => {
    const calls = stubApi(() => ({ body: { changed: ["r", "c", "x"], skipped: [] } }));
    show([finished("r", { createdAt: at(1) }), finished("c", { createdAt: at(2), parentSessionId: "r" }), finished("x", { createdAt: at(3) })]);

    act(() => button()!.click());
    const request = store.get().confirm!;
    expect(request.title).toBe("归档这 3 个会话？");
    expect(request.confirmLabel).toBe("归档 3 个会话");
    expect(request.body).toContain("其中包含 1 个随上级一起归档的下级会话");
    expect(calls).toEqual([]);

    await act(async () => {
      await request.onConfirm();
    });
    expect(calls).toEqual([{ method: "POST", path: "/api/sessions/archive", body: { ids: ["r", "x"] } }]);
  });

  it("有归档在途时按钮禁用并写明原因，在途结束后恢复；是随状态实时变的，不是打开时定下的", () => {
    show([finished("a")]);
    expect(button()!.hasAttribute("aria-disabled")).toBe(false);

    act(() => archiveUi.set({ busy: 1 }));
    expect(button()!.getAttribute("aria-disabled")).toBe("true");
    expect(tip()).toBe("上一个归档操作还在进行");
    act(() => button()!.click());
    expect(store.get().confirm).toBeUndefined();

    act(() => archiveUi.set({ busy: 0 }));
    expect(button()!.hasAttribute("aria-disabled")).toBe(false);
    expect(badge()).toBe("1");
  });

  it("数量超过 99 写成 99+（与“仅工作中”的数量徽标同一个写法）", () => {
    const many = Array.from({ length: 120 }, (_, index) => finished(`s${String(index).padStart(3, "0")}`, { createdAt: at(index) }));
    show(many);
    expect(badge()).toBe("99+");
    // 说明里写的仍是真实数字。
    expect(tip()).toContain("归档 120 个已结束的会话");
  });

  it("没有可挑的、也没有谁在挡着（例如范围里只剩已经归档的）：写“没有可以归档的会话”，不编造“还在工作”之类的原因", () => {
    // 已归档的会话本不该出现在未归档的目录里；万一出现，页头不能因此说出一个并不存在的原因。
    show([finished("a", { archivedAt: "2026-11-20T08:00:00.000Z", archivedBy: "user" })]);
    expect(button()!.getAttribute("aria-disabled")).toBe("true");
    expect(tip()).toBe("没有可以归档的会话：整棵任务树里的会话都结束了才能归档");
  });

  it("英文界面", () => {
    setLang("en");
    show([finished("a")]);
    expect(button()!.getAttribute("aria-label")).toBe("Archive finished sessions");
    act(() => archiveUi.set({ busy: 1 }));
    expect(tip()).toBe("Another archive action is still in progress");
  });
});
