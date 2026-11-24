import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@shared/types";
import { store } from "./app";
import { archiveUi } from "./archive";
import { archivedSummary, stubApi, summary } from "./archive.fixtures";
import { endListLoad } from "./archiveState";
import { useRelated } from "./useRelated";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Related = ReturnType<typeof useRelated>;

function Probe({ of, out }: { of: Pick<SessionSummary, "parentSessionId" | "childIds">; out: { current: Related | undefined } }): null {
  out.current = useRelated(of);
  return null;
}

const ids = (list: readonly SessionSummary[] | undefined): string[] => (list ?? []).map((one) => one.id);

describe("useRelated：上级与下级的摘要（未归档与已归档两张表都认）", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let out: { current: Related | undefined };
  const previous = store.get();

  beforeEach(() => {
    store.set({ sessions: {}, archived: {}, archivedLoaded: false, archivedCount: undefined, toasts: [] });
    archiveUi.set({ list: { status: "idle" }, busy: 0 });
    out = { current: undefined };
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    endListLoad();
    vi.unstubAllGlobals();
    store.set(previous);
    archiveUi.set({ list: { status: "idle" }, busy: 0 });
  });

  const show = async (of: Pick<SessionSummary, "parentSessionId" | "childIds">): Promise<void> => {
    await act(async () => {
      root.render(<Probe of={of} out={out} />);
    });
    // 让后台的读取（只经过微任务的假 fetch）走完，并把由此产生的更新提交。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  it("上级在未归档表、下级在已归档表（整棵都已结束的下级可以先于上级被归档）：两张表都认", async () => {
    store.set({
      sessions: { p: summary("p", { phase: "running", childIds: ["c1", "c2"] }), c1: summary("c1", { parentSessionId: "p" }) },
      archived: { c2: archivedSummary("c2", { parentSessionId: "p" }) },
      archivedLoaded: true,
      archivedCount: 1,
    });
    await show({ parentSessionId: undefined, childIds: ["c1", "c2"] });
    expect(out.current?.parent).toBeUndefined();
    expect(ids(out.current?.children)).toEqual(["c1", "c2"]);
  });

  it("已归档的会话的上级还开着：上级也找得到", async () => {
    store.set({ sessions: { p: summary("p", { phase: "running" }) }, archived: { c: archivedSummary("c", { parentSessionId: "p" }) }, archivedLoaded: true, archivedCount: 1 });
    await show({ parentSessionId: "p", childIds: [] });
    expect(out.current?.parent?.id).toBe("p");
  });

  it("认不出下级、服务说确有已归档的会话、而列表还没读：在后台读一遍，读回来就认得了", async () => {
    store.set({ sessions: { p: summary("p", { phase: "running", childIds: ["c"] }) }, archivedCount: 1 });
    const calls = stubApi(() => ({ body: { sessions: [archivedSummary("c", { parentSessionId: "p" })] } }));
    await show({ parentSessionId: undefined, childIds: ["c"] });
    expect(calls).toEqual([{ method: "GET", path: "/api/sessions?archived=only" }]);
    expect(ids(out.current?.children)).toEqual(["c"]);
    expect(store.get().archivedLoaded).toBe(true);
  });

  it("认不出上级也一样（已归档的上级、已归档的会话是它的下级）", async () => {
    store.set({ sessions: { c: summary("c", { phase: "running", parentSessionId: "p" }) }, archivedCount: 1 });
    const calls = stubApi(() => ({ body: { sessions: [archivedSummary("p", { childIds: ["c"] })] } }));
    await show({ parentSessionId: "p", childIds: [] });
    expect(calls).toHaveLength(1);
    expect(out.current?.parent?.id).toBe("p");
  });

  it("不读的三种情况：服务没说有已归档的会话（个数是 0 或老服务不报）、列表已经读全、什么都认得出", async () => {
    const calls = stubApi(() => ({ body: { sessions: [] } }));
    const unresolved = { parentSessionId: undefined, childIds: ["gone"] };

    // 组件已经挂着、订阅着状态：状态变化要在 act 里做，更新才会在断言之前提交。
    const change = (patch: Parameters<typeof store.set>[0]): void => act(() => store.set(patch));

    change({ archivedCount: 0 });
    await show(unresolved);
    change({ archivedCount: undefined });
    await show(unresolved);
    change({ archivedCount: 2, archivedLoaded: true });
    await show(unresolved);

    // 什么都认得出：先在“已读全”的状态下把会话补上、换成认得出的属性，最后才把“还没读”放回来。
    // 不能一步到位：组件还挂着认不出的 "gone" 时，状态一旦成了“有已归档、没读、认不出”，那恰恰是该读的情形（上一个用例）。
    const resolved = { parentSessionId: undefined, childIds: ["c"] };
    change({ sessions: { c: summary("c") } });
    await show(resolved);
    change({ archivedLoaded: false });
    await show(resolved);

    expect(calls).toEqual([]);
  });

  it("读取失败不打扰：没有提示，认不出的仍然认不出，也不会反复重试", async () => {
    store.set({ sessions: { p: summary("p", { phase: "running", childIds: ["c"] }) }, archivedCount: 1 });
    const calls = stubApi(() => ({ status: 500, body: { error: { code: "internal", message: "boom" } } }));
    await show({ parentSessionId: undefined, childIds: ["c"] });
    expect(calls).toHaveLength(1);
    expect(out.current?.children).toEqual([]);
    expect(store.get().toasts).toEqual([]);
  });

  it("关系变了（上级被事后改挂）：用新的摘要重新解析，不读到旧结果", async () => {
    store.set({
      sessions: { p1: summary("p1", { phase: "running" }), p2: summary("p2", { phase: "running" }), c: summary("c", { parentSessionId: "p1" }) },
      archivedLoaded: true,
      archivedCount: 0,
    });
    await show({ parentSessionId: "p1", childIds: [] });
    expect(out.current?.parent?.id).toBe("p1");
    await show({ parentSessionId: "p2", childIds: [] });
    expect(out.current?.parent?.id).toBe("p2");
  });
});
