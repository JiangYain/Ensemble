import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionSummary } from "@shared/types";
import { setLang, store, type Route } from "./app";
import { archivedSummary, summary } from "./archive.fixtures";
import { bindT } from "./i18n";
import { useEmptiedSpace } from "./useEmptiedSpace";
import { buildWorkspaces, workspaceDisplayTitle, type WorkspaceItem, type WorkspaceScope } from "./workspaces";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = "cursor:a";
const B = "cursor:b";
const t = bindT("zh");

/** 把一份摘要放进某个来源（Main Agent）名下：其余字段（宿主、标签……）沿用夹具的。 */
const inOrigin = (base: SessionSummary, key: string): SessionSummary => ({ ...base, origin: { ...base.origin, key } });
const live = (id: string, key: string): SessionSummary => inOrigin(summary(id, { phase: "done" }), key);
const shelved = (id: string, key: string): SessionSummary => inOrigin(archivedSummary(id), key);

const scopeOf = (key: string): WorkspaceScope => ({ kind: "origin", key });
const overviewOf = (key: string): Route => ({ kind: "overview", scope: scopeOf(key) });
const hashOf = (key: string): string => `#/m/${encodeURIComponent(key)}`;
const titleOf = (items: readonly WorkspaceItem[], key: string): string => workspaceDisplayTitle(items.find((item) => item.key === key)!, t);

interface ProbeProps {
  route: Route;
  scope: WorkspaceScope;
  workspaces: readonly WorkspaceItem[];
  ready: boolean;
}

function Probe({ route, scope, workspaces, ready }: ProbeProps): null {
  useEmptiedSpace(route, scope, workspaces, ready);
  return null;
}

describe("useEmptiedSpace：正看着的 Main Agent 空间被归档清空", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const previous = store.get();

  beforeEach(() => {
    setLang("zh");
    location.hash = "";
    localStorage.clear();
    store.set({ ready: true, route: overviewOf(A), archived: {}, lastWorkspace: undefined, switcherOpen: false, toasts: [] });
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

  const show = (props: ProbeProps): void => act(() => root.render(<Probe {...props} />));
  const lastToast = (): { tone: string; text: string } | undefined => store.get().toasts.at(-1);

  it("看着它、它又从有变无：地址改到回退的空间（排第一的），并用一条提示说明东西去了哪里", () => {
    const before = buildWorkspaces([live("a1", A), live("b1", B)]);
    show({ route: overviewOf(A), scope: scopeOf(A), workspaces: before, ready: true });
    // 看着的时候什么都不会发生。
    expect(location.hash).toBe("");
    expect(store.get().toasts).toEqual([]);

    // A 名下的会话全部归档：它从未归档的会话里算不出来了；归档时服务端推来的摘要在已归档表里。
    act(() => store.set({ archived: { a1: shelved("a1", A) } }));
    const after = buildWorkspaces([live("b1", B)]);
    show({ route: overviewOf(A), scope: scopeOf(A), workspaces: after, ready: true });

    expect(location.hash).toBe(hashOf(B));
    expect(lastToast()).toMatchObject({
      tone: "info",
      text: `「${titleOf(before, A)}」名下的会话都已归档，已切换到「${titleOf(after, B)}」`,
    });
  });

  it("回退用的是同一套规则：先回上次看的空间", () => {
    const before = buildWorkspaces([live("a1", A), live("b1", B)]);
    show({ route: overviewOf(A), scope: scopeOf(A), workspaces: before, ready: true });
    act(() => store.set({ archived: { a1: shelved("a1", A) }, lastWorkspace: { kind: "all" } }));
    show({ route: overviewOf(A), scope: scopeOf(A), workspaces: buildWorkspaces([live("b1", B)]), ready: true });
    expect(location.hash).toBe("#/all");
    expect(lastToast()?.text).toBe(`「${titleOf(before, A)}」名下的会话都已归档，已切换到「全部空间」`);
  });

  it("恰好是最后一个空间：回退到“全部空间”，地址不再停在一个看不到的空间上", () => {
    const before = buildWorkspaces([live("a1", A)]);
    show({ route: overviewOf(A), scope: scopeOf(A), workspaces: before, ready: true });
    act(() => store.set({ archived: { a1: shelved("a1", A) } }));
    show({ route: overviewOf(A), scope: scopeOf(A), workspaces: [], ready: true });
    expect(location.hash).toBe("#/all");
    expect(lastToast()?.text).toBe(`「${titleOf(before, A)}」名下的会话都已归档，已切换到「全部空间」`);
  });

  it("没有这个空间的已归档会话（会话是被删除的，不是归档）：只改地址，不说“都已归档”这句假话", () => {
    show({ route: overviewOf(A), scope: scopeOf(A), workspaces: buildWorkspaces([live("a1", A), live("b1", B)]), ready: true });
    show({ route: overviewOf(A), scope: scopeOf(A), workspaces: buildWorkspaces([live("b1", B)]), ready: true });
    expect(location.hash).toBe(hashOf(B));
    expect(store.get().toasts).toEqual([]);
  });

  it("已归档表里只有别的空间的会话：同样不说", () => {
    show({ route: overviewOf(A), scope: scopeOf(A), workspaces: buildWorkspaces([live("a1", A), live("b1", B)]), ready: true });
    act(() => store.set({ archived: { z: shelved("z", B) } }));
    show({ route: overviewOf(A), scope: scopeOf(A), workspaces: buildWorkspaces([live("b1", B)]), ready: true });
    expect(location.hash).toBe(hashOf(B));
    expect(store.get().toasts).toEqual([]);
  });

  it("直链打开一个本来就不存在的空间（过期的书签）：不算“被清空”，沿用原来的静默回退", () => {
    store.set({ archived: { a1: shelved("a1", A) } });
    show({ route: overviewOf(A), scope: scopeOf(A), workspaces: buildWorkspaces([live("b1", B)]), ready: true });
    expect(location.hash).toBe("");
    expect(store.get().toasts).toEqual([]);
  });

  it("快照还没到：空的 workspaces 不代表“被清空”，什么都不认定", () => {
    show({ route: overviewOf(A), scope: scopeOf(A), workspaces: [], ready: false });
    expect(location.hash).toBe("");
    // 快照到了、空间在：只是记下它的样子。
    show({ route: overviewOf(A), scope: scopeOf(A), workspaces: buildWorkspaces([live("a1", A)]), ready: true });
    expect(location.hash).toBe("");
    expect(store.get().toasts).toEqual([]);
  });

  it("不在概览页的某个 Main Agent 空间上（“已归档”视图、聚焦页、全部空间、进行中）：不涉及", () => {
    const both = buildWorkspaces([live("a1", A), live("b1", B)]);
    const onlyB = buildWorkspaces([live("b1", B)]);
    store.set({ archived: { a1: shelved("a1", A) } });

    // 页面把“上次看的空间”当作 scope 交过来（已归档视图、聚焦页）；全部空间与进行中的 scope 本身就不是某个 Main Agent。
    const pages: Array<{ route: Route; scope: WorkspaceScope }> = [
      { route: { kind: "archived" }, scope: scopeOf(A) },
      { route: { kind: "session", id: "a1" }, scope: scopeOf(A) },
      { route: { kind: "overview", scope: { kind: "all" } }, scope: { kind: "all" } },
      { route: { kind: "overview", scope: { kind: "active" } }, scope: { kind: "active" } },
    ];
    for (const page of pages) {
      show({ ...page, workspaces: both, ready: true });
      show({ ...page, workspaces: onlyB, ready: true });
    }

    expect(location.hash).toBe("");
    expect(store.get().toasts).toEqual([]);
  });

  it("英文界面的提示也是英文", () => {
    setLang("en");
    const en = bindT("en");
    const before = buildWorkspaces([live("a1", A), live("b1", B)]);
    show({ route: overviewOf(A), scope: scopeOf(A), workspaces: before, ready: true });
    act(() => store.set({ archived: { a1: shelved("a1", A) } }));
    const after = buildWorkspaces([live("b1", B)]);
    show({ route: overviewOf(A), scope: scopeOf(A), workspaces: after, ready: true });
    expect(lastToast()?.text).toBe(
      en("archive.spaceGone", { name: workspaceDisplayTitle(before.find((item) => item.key === A)!, en), target: workspaceDisplayTitle(after[0]!, en) }),
    );
    expect(lastToast()?.text.startsWith("Every session under")).toBe(true);
  });
});
