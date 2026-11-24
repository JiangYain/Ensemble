import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@shared/types";
import { store } from "./app";
import { archiveUi } from "./archive";
import { archivedSummary, stubApi, summary } from "./archive.fixtures";
import { endListLoad } from "./archiveState";
import { useRelated } from "./useRelated";

/**
 * 汇聚（一个会话跟随多个上级）时的 useRelated：`parent` 仍是主上级，`parents` 是所有认得出的上级（有序、含主上级），
 * `missingParents` 是认不出的那几个的 id。单上级与没有上级的行为由 useRelated.test.tsx 守着，这里只补汇聚与两者的对应关系。
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Of = Parameters<typeof useRelated>[0];
type Related = ReturnType<typeof useRelated>;

function Probe({ of, out }: { of: Of; out: { current: Related | undefined } }): null {
  out.current = useRelated(of);
  return null;
}

const ids = (list: readonly SessionSummary[] | undefined): string[] => (list ?? []).map((one) => one.id);

describe("useRelated：汇聚的上级", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let out: { current: Related | undefined };
  const previous = store.get();

  beforeEach(() => {
    store.set({ sessions: {}, archived: {}, archivedLoaded: true, archivedCount: 0, toasts: [] });
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

  const show = async (of: Of): Promise<void> => {
    await act(async () => {
      root.render(<Probe of={of} out={out} />);
    });
    // 让后台的读取（只经过微任务的假 fetch）走完，并把由此产生的更新提交。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  const running = (...list: string[]): Record<string, SessionSummary> => Object.fromEntries(list.map((id) => [id, summary(id, { phase: "running" })]));

  it("parents 是所有的上级，先后与记录的一致；parent 是第一个（主上级）", async () => {
    store.set({ sessions: running("p1", "p2", "p3") });

    await show({ parentSessionId: "p2", parentSessionIds: ["p2", "p3", "p1"], childIds: [] });

    expect(out.current?.parent?.id).toBe("p2");
    expect(ids(out.current?.parents)).toEqual(["p2", "p3", "p1"]);
    expect(out.current?.missingParents).toEqual([]);
  });

  it("上级一个在未归档表、一个在已归档表：两张表都认，先后不变", async () => {
    store.set({ sessions: running("p1"), archived: { p2: archivedSummary("p2") } });

    await show({ parentSessionId: "p1", parentSessionIds: ["p1", "p2"], childIds: [] });
    expect(ids(out.current?.parents)).toEqual(["p1", "p2"]);

    await show({ parentSessionId: "p2", parentSessionIds: ["p2", "p1"], childIds: [] });
    expect(out.current?.parent?.id).toBe("p2");
    expect(ids(out.current?.parents)).toEqual(["p2", "p1"]);
    expect(out.current?.missingParents).toEqual([]);
  });

  it("认不出的上级单独列在 missingParents 里，认得出的照常；主上级认不出时 parent 是空、其余仍在 parents 里", async () => {
    store.set({ sessions: running("p1") });

    await show({ parentSessionId: "p1", parentSessionIds: ["p1", "gone"], childIds: [] });
    expect(out.current?.parent?.id).toBe("p1");
    expect(ids(out.current?.parents)).toEqual(["p1"]);
    expect(out.current?.missingParents).toEqual(["gone"]);

    await show({ parentSessionId: "gone", parentSessionIds: ["gone", "p1", "also-gone"], childIds: [] });
    expect(out.current?.parent).toBeUndefined();
    expect(ids(out.current?.parents)).toEqual(["p1"]);
    expect(out.current?.missingParents).toEqual(["gone", "also-gone"]);
  });

  it("单上级：parents 就是 [parent]，认不出时是空、missingParents 是那一个；没有上级时两个都是空", async () => {
    store.set({ sessions: running("p1") });

    await show({ parentSessionId: "p1", childIds: [] });
    expect(ids(out.current?.parents)).toEqual(["p1"]);
    expect(out.current?.parent?.id).toBe("p1");
    expect(out.current?.missingParents).toEqual([]);

    await show({ parentSessionId: "gone", childIds: [] });
    expect(out.current?.parents).toEqual([]);
    expect(out.current?.parent).toBeUndefined();
    expect(out.current?.missingParents).toEqual(["gone"]);

    await show({ parentSessionId: undefined, childIds: [] });
    expect(out.current?.parents).toEqual([]);
    expect(out.current?.missingParents).toEqual([]);
  });

  it("认不出上级、服务说确有已归档的会话、而列表还没读：在后台读一遍，读回来就都认得了", async () => {
    store.set({ sessions: running("p1"), archivedLoaded: false, archivedCount: 1 });
    const calls = stubApi(() => ({ body: { sessions: [archivedSummary("p2")] } }));

    await show({ parentSessionId: "p1", parentSessionIds: ["p1", "p2"], childIds: [] });

    expect(calls).toEqual([{ method: "GET", path: "/api/sessions?archived=only" }]);
    expect(ids(out.current?.parents)).toEqual(["p1", "p2"]);
    expect(out.current?.missingParents).toEqual([]);
  });

  it("所有上级都认得出：不去读已归档列表，哪怕服务说有已归档的会话", async () => {
    store.set({ sessions: running("p1", "p2"), archivedLoaded: false, archivedCount: 3 });
    const calls = stubApi(() => ({ body: { sessions: [] } }));

    await show({ parentSessionId: "p1", parentSessionIds: ["p1", "p2"], childIds: [] });

    expect(calls).toEqual([]);
    expect(ids(out.current?.parents)).toEqual(["p1", "p2"]);
  });

  it("关系变了（事后改挂，汇聚变回单上级再换成另一组）：用新的集合重新解析，不读到旧结果", async () => {
    store.set({ sessions: running("p1", "p2", "p3") });

    await show({ parentSessionId: "p1", parentSessionIds: ["p1", "p2"], childIds: [] });
    expect(ids(out.current?.parents)).toEqual(["p1", "p2"]);

    await show({ parentSessionId: "p2", childIds: [] });
    expect(ids(out.current?.parents)).toEqual(["p2"]);
    expect(out.current?.parent?.id).toBe("p2");

    await show({ parentSessionId: "p3", parentSessionIds: ["p3", "p1"], childIds: [] });
    expect(ids(out.current?.parents)).toEqual(["p3", "p1"]);
  });

  it("下级照旧：汇聚的会话的下级、以及它是上级之一的那些下级都认得", async () => {
    store.set({ sessions: { ...running("p1"), k1: summary("k1"), k2: summary("k2") } });

    await show({ parentSessionId: "p1", parentSessionIds: ["p1", "p2"], childIds: ["k1", "k2", "gone"] });

    expect(ids(out.current?.children)).toEqual(["k1", "k2"]);
    expect(out.current?.missingParents).toEqual(["p2"]);
  });
});
