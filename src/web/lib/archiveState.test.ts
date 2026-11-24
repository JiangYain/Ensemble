import { afterEach, describe, expect, it } from "vitest";
import { replay, toSummary } from "@shared/projection";
import type { StateSnapshot } from "@shared/protocol";
import { EventLog } from "@shared/testing";
import type { SessionSummary } from "@shared/types";
import { beginListLoad, endListLoad, forgetPatch, mergeArchivedList, routeSummary, snapshotArchivePatch, summaryById, type ArchiveSlice } from "./archiveState";

function summary(id: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  const log = new EventLog(id);
  log.created({ id, harness: "cursor", runtime: "native" });
  return { ...toSummary(replay(log.events)!), seq: 5, ...patch };
}

const ARCHIVED_AT = "2026-11-20T08:00:00.000Z";
/** 已归档的摘要：序号不变（归档不是事件，不推进序号）。 */
const archived = (id: string, patch: Partial<SessionSummary> = {}): SessionSummary => summary(id, { archivedAt: ARCHIVED_AT, archivedBy: "user", ...patch });

const table = (...items: SessionSummary[]): Record<string, SessionSummary> => Object.fromEntries(items.map((item) => [item.id, item]));

function slice(patch: Partial<ArchiveSlice> = {}): ArchiveSlice {
  return { sessions: {}, archived: {}, archivedLoaded: false, archivedCount: 0, snapshotAt: undefined, ...patch };
}

const snapshotOf = (patch: Partial<StateSnapshot> = {}): StateSnapshot => ({
  rev: 0,
  serverTime: "2026-11-22T00:00:00.000Z",
  version: "test",
  protocol: 1,
  sessions: [],
  harnesses: [],
  capacity: { occupied: 0, max: 20, waiting: 0 },
  dev: false,
  ...patch,
});

// 模块里“读整份列表期间被推送碰过谁”是一份全局记录：每个用例结束都收掉，免得影响下一个。
afterEach(() => {
  endListLoad();
});

describe("summaryById：两张表都认", () => {
  it("未归档的在 sessions，已归档的在 archived，找不到就是 undefined", () => {
    const state = { sessions: table(summary("a")), archived: table(archived("b")) };
    expect(summaryById(state, "a")?.id).toBe("a");
    expect(summaryById(state, "b")?.id).toBe("b");
    expect(summaryById(state, "c")).toBeUndefined();
  });
});

describe("routeSummary：推来的摘要放进它该去的那张表", () => {
  it("未归档的会话收到新摘要：原地更新，数量不变", () => {
    const state = slice({ sessions: table(summary("a")), archivedCount: 2 });
    const next = summary("a", { seq: 6, title: "新标题" });
    const patch = routeSummary(state, next);
    expect(patch.sessions?.["a"]).toBe(next);
    expect(patch.archived).toBeUndefined();
    expect(patch.archivedCount).toBeUndefined();
  });

  it("序号更小的摘要是过期的：什么也不改", () => {
    const state = slice({ sessions: table(summary("a", { seq: 7 })) });
    expect(routeSummary(state, summary("a", { seq: 6 }))).toEqual({});
    const cold = slice({ archived: table(archived("b", { seq: 7 })) });
    expect(routeSummary(cold, archived("b", { seq: 6 }))).toEqual({});
  });

  it("归档不改序号：序号相同、带 archivedAt 的摘要照收，会话从未归档表挪到已归档表，数量加一", () => {
    const state = slice({ sessions: table(summary("a"), summary("b")), archivedCount: 2 });
    const next = archived("a");
    const patch = routeSummary(state, next);
    expect(Object.keys(patch.sessions ?? {})).toEqual(["b"]);
    expect(patch.archived?.["a"]).toBe(next);
    expect(patch.archivedCount).toBe(3);
  });

  it("已读全已归档列表时，数量就是表的大小（不靠加减）", () => {
    const state = slice({ sessions: table(summary("a")), archived: table(archived("b")), archivedLoaded: true, archivedCount: 1 });
    const patch = routeSummary(state, archived("a"));
    expect(Object.keys(patch.archived ?? {}).sort()).toEqual(["a", "b"]);
    expect(patch.archivedCount).toBe(2);
  });

  it("取消归档：序号相同、不带 archivedAt 的摘要照收，会话挪回未归档表，数量减一", () => {
    const state = slice({ archived: table(archived("a"), archived("b")), archivedCount: 2 });
    const next = summary("a");
    const patch = routeSummary(state, next);
    expect(patch.sessions?.["a"]).toBe(next);
    expect(Object.keys(patch.archived ?? {})).toEqual(["b"]);
    expect(patch.archivedCount).toBe(1);
  });

  it("取消归档不会让数量变成负数", () => {
    const state = slice({ archived: table(archived("a")), archivedCount: 0 });
    expect(routeSummary(state, summary("a")).archivedCount).toBe(0);
  });

  it("已归档的会话收到新的已归档摘要：只更新那一张表，数量不变", () => {
    const state = slice({ archived: table(archived("a")), archivedCount: 1 });
    const next = archived("a", { seq: 6 });
    const patch = routeSummary(state, next);
    expect(patch.sessions).toBeUndefined();
    expect(patch.archived?.["a"]).toBe(next);
    expect(patch.archivedCount).toBe(1);
  });

  it("一份没加载过的已归档会话的摘要：进已归档表，数量不再加（它早就算在快照的数里了）", () => {
    const state = slice({ archivedCount: 4 });
    const patch = routeSummary(state, archived("a"));
    expect(patch.sessions).toBeUndefined();
    expect(Object.keys(patch.archived ?? {})).toEqual(["a"]);
    expect(patch.archivedCount).toBe(4);
  });

  it("两张表里都没有、也没有归档标记：比快照新的是新会话，数量不动", () => {
    const state = slice({ archivedCount: 3, snapshotAt: "2026-11-22T00:00:00.000Z" });
    const next = summary("a", { createdAt: "2026-11-22T00:00:05.000Z" });
    const patch = routeSummary(state, next);
    expect(patch.sessions?.["a"]).toBe(next);
    expect(patch.archivedCount).toBeUndefined();
  });

  it("两张表里都没有、也没有归档标记：比快照早创建的，只能是此前归档着、刚被取消归档的（例如主 Agent 给它发了消息），数量减一", () => {
    const state = slice({ archivedCount: 3, snapshotAt: "2026-11-22T00:00:00.000Z" });
    const next = summary("a", { createdAt: "2026-11-01T00:00:00.000Z" });
    const patch = routeSummary(state, next);
    expect(patch.sessions?.["a"]).toBe(next);
    expect(patch.archivedCount).toBe(2);
  });

  it("没有快照时间（还没收到过快照）时不猜：当作新会话", () => {
    const state = slice({ archivedCount: 3 });
    const patch = routeSummary(state, summary("a", { createdAt: "2026-11-01T00:00:00.000Z" }));
    expect(patch.archivedCount).toBeUndefined();
  });

  it("老服务（不报已归档个数）：个数一直是 undefined，不会被凭空算出一个数", () => {
    const state = slice({ sessions: table(summary("a")), archivedCount: undefined });
    const patch = routeSummary(state, archived("a"));
    expect(patch.archivedCount).toBeUndefined();
    expect(Object.keys(patch.archived ?? {})).toEqual(["a"]);
  });
});

describe("forgetPatch：会话被删除", () => {
  it("未归档的：只从 sessions 里去掉，数量不动", () => {
    const state = slice({ sessions: table(summary("a"), summary("b")), archivedCount: 2 });
    const patch = forgetPatch(state, "a");
    expect(Object.keys(patch.sessions ?? {})).toEqual(["b"]);
    expect(patch.archivedCount).toBeUndefined();
  });

  it("已归档的：从已归档表里去掉，数量减一；已读全时数量就是表的大小", () => {
    const loose = slice({ archived: table(archived("a"), archived("b")), archivedCount: 5 });
    expect(forgetPatch(loose, "a")).toMatchObject({ archivedCount: 4 });
    expect(Object.keys(forgetPatch(loose, "a").archived ?? {})).toEqual(["b"]);

    const complete = slice({ archived: table(archived("a"), archived("b")), archivedLoaded: true, archivedCount: 2 });
    expect(forgetPatch(complete, "a")).toMatchObject({ archivedCount: 1 });
  });

  it("认不出的 id：什么也不改（不知道它算没算在个数里）", () => {
    expect(forgetPatch(slice({ archivedCount: 3 }), "ghost")).toEqual({});
  });
});

describe("snapshotArchivePatch：快照里的归档部分", () => {
  it("老服务的快照没有 archivedCount：整套归档状态清空，界面上不出现任何归档入口", () => {
    const patch = snapshotArchivePatch({ archived: table(archived("x")) }, snapshotOf({ sessions: [summary("a")] }));
    expect(Object.keys(patch.sessions)).toEqual(["a"]);
    expect(patch.archived).toEqual({});
    expect(patch.archivedCount).toBeUndefined();
    expect(patch.retention).toBeUndefined();
    expect(patch.snapshotAt).toBe("2026-11-22T00:00:00.000Z");
  });

  it("新服务的快照：个数与留存策略以快照为准，快照时间记下来", () => {
    const patch = snapshotArchivePatch({ archived: {} }, snapshotOf({ archivedCount: 7, retention: { keepDays: 30, keepCount: null } }));
    expect(patch.archivedCount).toBe(7);
    expect(patch.retention).toEqual({ keepDays: 30, keepCount: null });
    expect(patch.snapshotAt).toBe("2026-11-22T00:00:00.000Z");
  });

  it("断线期间被取消归档的会话现在在未归档列表里：从已归档表里去掉，一个会话只在一张表里", () => {
    const patch = snapshotArchivePatch(
      { archived: table(archived("x"), archived("y")) },
      snapshotOf({ sessions: [summary("x")], archivedCount: 1 }),
    );
    expect(Object.keys(patch.sessions)).toEqual(["x"]);
    expect(Object.keys(patch.archived)).toEqual(["y"]);
  });
});

describe("mergeArchivedList：整份已归档列表读回来了", () => {
  it("读到的都收下，标记为已读全，数量就是表的大小", () => {
    const merged = mergeArchivedList({ sessions: {}, archived: {} }, [archived("a"), archived("b")], new Set());
    expect(Object.keys(merged.archived).sort()).toEqual(["a", "b"]);
    expect(merged.archivedLoaded).toBe(true);
    expect(merged.archivedCount).toBe(2);
  });

  it("已经在未归档表里的 id 不收：一个会话只在一张表里", () => {
    const merged = mergeArchivedList({ sessions: table(summary("a")), archived: {} }, [archived("a"), archived("b")], new Set());
    expect(Object.keys(merged.archived)).toEqual(["b"]);
    expect(merged.archivedCount).toBe(1);
  });

  it("读取期间被推送碰过的 id 以推送为准：回执里还写着已归档，推送刚把它取消了，就不能改回去", () => {
    const merged = mergeArchivedList({ sessions: {}, archived: {} }, [archived("a"), archived("b")], new Set(["a"]));
    expect(Object.keys(merged.archived)).toEqual(["b"]);
  });

  it("读取期间推送来的已归档会话（回执里没有它）不会因为合并而丢失", () => {
    const pushed = archived("p", { seq: 9 });
    const merged = mergeArchivedList({ sessions: {}, archived: table(pushed) }, [archived("a")], new Set(["p"]));
    expect(merged.archived["p"]).toBe(pushed);
    expect(merged.archivedCount).toBe(2);
  });

  it("读到的比已有的更旧（序号更小）时不覆盖", () => {
    const newer = archived("a", { seq: 9, title: "新" });
    const merged = mergeArchivedList({ sessions: {}, archived: table(newer) }, [archived("a", { seq: 5, title: "旧" })], new Set());
    expect(merged.archived["a"]).toBe(newer);
  });
});

describe("读列表期间的“推送优先”记录", () => {
  it("读取期间被推送、快照或删除碰过的 id 都会被记下，结束时一次交出并清空", () => {
    beginListLoad();
    routeSummary(slice({ sessions: table(summary("a")) }), summary("a", { seq: 6 }));
    forgetPatch(slice({ archived: table(archived("b")) }), "b");
    snapshotArchivePatch({ archived: {} }, snapshotOf({ sessions: [summary("c")], archivedCount: 0 }));
    const touched = endListLoad();
    expect([...touched].sort()).toEqual(["a", "b", "c"]);
    expect(endListLoad().size).toBe(0);
  });

  it("没有读取在途时什么也不记", () => {
    routeSummary(slice({ sessions: table(summary("a")) }), summary("a", { seq: 6 }));
    expect(endListLoad().size).toBe(0);
  });

  it("过期而被忽略的摘要不算“碰过”：它没有改变任何东西", () => {
    beginListLoad();
    routeSummary(slice({ sessions: table(summary("a", { seq: 7 })) }), summary("a", { seq: 6 }));
    expect(endListLoad().size).toBe(0);
  });
});
