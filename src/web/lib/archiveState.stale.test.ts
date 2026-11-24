import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replay, toSummary } from "@shared/projection";
import type { SessionDetail } from "@shared/protocol";
import { EventLog } from "@shared/testing";
import type { SessionSummary } from "@shared/types";
import { loadDetail, patchSummary, store } from "./app";
import { ARCHIVED_AT, deferred, stubApi } from "./archive.fixtures";
import { beginListLoad, endListLoad, forgetPatch, routeSummary, watchTouched, type ArchiveSlice } from "./archiveState";

/**
 * 详情回执与推送谁新谁旧：归档标记不占序号，序号比不出先后，只能看“请求在途期间推送碰过没有”。
 * 修复之前，详情请求没有这份保护：服务端先取摘要、后读事件，回执一路上要花时间，期间 SSE 推来的归档 / 取消归档，
 * 会被迟到的旧回执（序号相同，只是归档标记是旧的）盖回去——会话被挪回它刚离开的那张表，已归档的个数也跟着错。
 */

/** 摘要取自真实的投影：序号与 `detailOf` 里的事件一致，回执落下来之后不会为了补事件而再发请求。 */
function summaryOf(id: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  const log = new EventLog(id);
  log.created({ id, harness: "cursor", runtime: "native", title: id });
  return { ...toSummary(replay(log.events)!), ...patch };
}

function detailOf(id: string, patch: Partial<SessionSummary> = {}): SessionDetail {
  const log = new EventLog(id);
  log.created({ id, harness: "cursor", runtime: "native", title: id });
  return { summary: { ...toSummary(replay(log.events)!), ...patch }, events: log.events };
}

const ARCHIVE_MARK: Partial<SessionSummary> = { archivedAt: ARCHIVED_AT, archivedBy: "user" };

function slice(patch: Partial<ArchiveSlice> = {}): ArchiveSlice {
  return { sessions: {}, archived: {}, archivedLoaded: false, archivedCount: 0, snapshotAt: undefined, ...patch };
}

const table = (...items: SessionSummary[]): Record<string, SessionSummary> => Object.fromEntries(items.map((item) => [item.id, item]));

describe("watchTouched：请求在途期间谁被推送碰过", () => {
  it("推送与删除碰过的 id 都记下；开始之前的、stop 之后的不记", () => {
    routeSummary(slice({ sessions: table(summaryOf("early")) }), summaryOf("early", { seq: 9 }));
    const watch = watchTouched();
    routeSummary(slice({ sessions: table(summaryOf("a")) }), summaryOf("a", { seq: 9 }));
    forgetPatch(slice({ archived: table(summaryOf("b", ARCHIVE_MARK)) }), "b");
    watch.stop();
    routeSummary(slice({ sessions: table(summaryOf("late")) }), summaryOf("late", { seq: 9 }));

    expect([...watch.touched].sort()).toEqual(["a", "b"]);
  });

  it("几个在途的请求各记各的，互不影响，也与整份列表的读取并存；stop 可以重复调用", () => {
    beginListLoad();
    const first = watchTouched();
    routeSummary(slice({ sessions: table(summaryOf("a")) }), summaryOf("a", { seq: 9 }));
    const second = watchTouched();
    routeSummary(slice({ sessions: table(summaryOf("b")) }), summaryOf("b", { seq: 9 }));
    first.stop();
    first.stop();
    routeSummary(slice({ sessions: table(summaryOf("c")) }), summaryOf("c", { seq: 9 }));
    second.stop();

    expect([...first.touched]).toEqual(["a", "b"]);
    expect([...second.touched]).toEqual(["b", "c"]);
    expect([...endListLoad()].sort()).toEqual(["a", "b", "c"]);
  });

  it("过期而被忽略的摘要不算“碰过”：它没有改变任何东西", () => {
    const watch = watchTouched();
    routeSummary(slice({ sessions: table(summaryOf("a", { seq: 7 })) }), summaryOf("a", { seq: 6 }));
    watch.stop();

    expect(watch.touched.size).toBe(0);
  });
});

describe("详情回执遇上期间的推送", () => {
  const previous = store.get();
  const loading = (id: string): void => store.set({ route: { kind: "session", id }, detail: { id, state: undefined, rev: 0, loading: true } });

  /** 详情请求停在半路，直到放行；放行时回的是 `reply`。 */
  function holdDetail(reply: SessionDetail): () => void {
    const gate = deferred();
    stubApi(async () => {
      await gate.promise;
      return { body: reply };
    });
    return gate.resolve;
  }

  beforeEach(() => {
    store.set({
      ready: true,
      conn: "live",
      sessions: {},
      archived: {},
      archivedLoaded: false,
      archivedCount: 0,
      retention: undefined,
      snapshotAt: undefined,
      detail: undefined,
      route: { kind: "overview" },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    endListLoad();
    store.set(previous);
  });

  it("期间推送把它取消了归档：迟到的旧回执（还写着已归档）不能把它挪回已归档表", async () => {
    store.set({ archived: { x: summaryOf("x", ARCHIVE_MARK) }, archivedCount: 1 });
    loading("x");
    const release = holdDetail(detailOf("x", ARCHIVE_MARK));

    const loaded = loadDetail("x");
    patchSummary(summaryOf("x"));
    expect(store.get().sessions["x"]).toBeDefined();
    release();
    await loaded;

    // 事件照常读好了，只是回执里的旧摘要没有被用。
    expect(store.get().detail).toMatchObject({ id: "x", loading: false });
    expect(store.get().sessions["x"]?.archivedAt).toBeUndefined();
    expect(store.get().archived["x"]).toBeUndefined();
    expect(store.get().archivedCount).toBe(0);
  });

  it("反过来，期间推送把它归档了：迟到的旧回执（还写着未归档）不能把它挪回未归档表", async () => {
    store.set({ sessions: { x: summaryOf("x") }, archivedCount: 0 });
    loading("x");
    const release = holdDetail(detailOf("x"));

    const loaded = loadDetail("x");
    patchSummary(summaryOf("x", ARCHIVE_MARK));
    expect(store.get().archived["x"]).toBeDefined();
    release();
    await loaded;

    expect(store.get().detail).toMatchObject({ id: "x", loading: false });
    expect(store.get().archived["x"]?.archivedAt).toBe(ARCHIVED_AT);
    expect(store.get().sessions["x"]).toBeUndefined();
    expect(store.get().archivedCount).toBe(1);
  });

  it("期间被推送碰过的只是别的会话：回执里的摘要照用", async () => {
    store.set({ archivedCount: 3 });
    loading("x");
    const release = holdDetail(detailOf("x", ARCHIVE_MARK));

    const loaded = loadDetail("x");
    patchSummary(summaryOf("y"));
    release();
    await loaded;

    expect(store.get().archived["x"]?.archivedAt).toBe(ARCHIVED_AT);
    expect(store.get().archivedCount).toBe(3);
  });

  it("推送在请求发出之前就到了：回执是在它之后取的，照用", async () => {
    store.set({ sessions: { x: summaryOf("x") }, archivedCount: 0 });
    patchSummary(summaryOf("x"));
    loading("x");
    stubApi(() => ({ body: detailOf("x", ARCHIVE_MARK) }));

    await loadDetail("x");

    expect(store.get().archived["x"]?.archivedAt).toBe(ARCHIVED_AT);
    expect(store.get().sessions["x"]).toBeUndefined();
    expect(store.get().archivedCount).toBe(1);
  });
});
