import { describe, expect, it } from "vitest";
import {
  archiveNodeOf,
  isFinishedSession,
  planArchive,
  planRetention,
  planUnarchive,
  retentionFault,
  subtreeOf,
  type ArchiveTree,
} from "./archive";
import { LIMITS } from "./constants";
import type { SessionPhase, SessionSummary } from "./types";

const DAY = 86_400_000;
const NOW = Date.parse("2026-06-01T12:00:00.000Z");

interface Spec {
  id: string;
  parent?: string;
  /** 缺省 = 已结束 */
  finished?: boolean;
  archived?: boolean;
  /** 最后活动距现在多少天，缺省 30 */
  ageDays?: number;
  /** 直接给毫秒（覆盖 ageDays），例如 Infinity 表示读不懂的时间 */
  activityMs?: number;
}

/** 用几行内存表构造一棵会话树；数组次序就是创建次序，也就是子会话的遍历次序。 */
function treeOf(specs: readonly Spec[]): ArchiveTree {
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  return {
    node: (id) => {
      const spec = byId.get(id);
      if (!spec) return undefined;
      return {
        id,
        parentSessionId: spec.parent,
        archived: spec.archived === true,
        finished: spec.finished !== false,
        activityMs: spec.activityMs ?? NOW - (spec.ageDays ?? 30) * DAY,
      };
    },
    childrenOf: (id) => specs.filter((spec) => spec.parent === id).map((spec) => spec.id),
    ids: () => specs.map((spec) => spec.id),
  };
}

function summaryOf(patch: Partial<Pick<SessionSummary, "phase" | "updatedAt" | "archivedAt" | "parentSessionId">> & { pending?: number } = {}): SessionSummary {
  const { pending = 0, ...rest } = patch;
  return {
    id: "ses_a",
    phase: "done",
    updatedAt: "2026-05-01T00:00:00.000Z",
    messages: { total: 1, pending },
    ...rest,
  } as SessionSummary;
}

describe("isFinishedSession", () => {
  it("counts done, failed, cancelled, stopped and lost as finished", () => {
    for (const phase of ["done", "failed", "cancelled", "stopped", "lost"] as const) {
      expect(isFinishedSession(summaryOf({ phase })), phase).toBe(true);
    }
  });

  it("does not count ready or any in-progress phase", () => {
    const unfinished: SessionPhase[] = ["ready", "starting", "queued", "running"];
    for (const phase of unfinished) expect(isFinishedSession(summaryOf({ phase })), phase).toBe(false);
  });

  it("does not count a session that still has a message nobody has confirmed, whatever its phase", () => {
    expect(isFinishedSession(summaryOf({ phase: "done", pending: 1 }))).toBe(false);
    expect(isFinishedSession(summaryOf({ phase: "lost", pending: 2 }))).toBe(false);
  });
});

describe("archiveNodeOf", () => {
  it("reads the archive mark, the parent and the last activity from a summary", () => {
    const node = archiveNodeOf(summaryOf({ archivedAt: "2026-05-02T00:00:00.000Z", parentSessionId: "ses_p" }));
    expect(node).toEqual({
      id: "ses_a",
      parentSessionId: "ses_p",
      archived: true,
      finished: true,
      activityMs: Date.parse("2026-05-01T00:00:00.000Z"),
    });
    expect(archiveNodeOf(summaryOf()).archived).toBe(false);
  });

  it("treats a timestamp it cannot read as activity that never ages out", () => {
    expect(archiveNodeOf(summaryOf({ updatedAt: "not a time" })).activityMs).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("subtreeOf", () => {
  it("lists a session before its descendants, siblings in creation order", () => {
    const tree = treeOf([{ id: "a" }, { id: "b", parent: "a" }, { id: "c", parent: "a" }, { id: "d", parent: "b" }, { id: "e" }]);
    expect(subtreeOf(tree, "a")).toEqual(["a", "b", "d", "c"]);
    expect(subtreeOf(tree, "e")).toEqual(["e"]);
  });

  it("stops on a loop in malformed data instead of running forever", () => {
    const tree = treeOf([{ id: "a", parent: "b" }, { id: "b", parent: "a" }]);
    expect(subtreeOf(tree, "a")).toEqual(["a", "b"]);
  });
});

describe("planArchive", () => {
  it("archives a finished session together with everything below it", () => {
    const tree = treeOf([{ id: "root" }, { id: "kid", parent: "root" }, { id: "grandkid", parent: "kid" }, { id: "other" }]);
    expect(planArchive(tree, ["root"])).toEqual({ changed: ["root", "kid", "grandkid"], skipped: [] });
  });

  it("skips the whole subtree as active when any member has not finished", () => {
    const tree = treeOf([
      { id: "root" },
      { id: "busy", parent: "root", finished: false },
      { id: "fine" },
    ]);
    expect(planArchive(tree, ["root", "fine"])).toEqual({ changed: ["fine"], skipped: [{ id: "root", reason: "active" }] });
  });

  it("can archive a finished branch while its parent is still working", () => {
    const tree = treeOf([{ id: "parent", finished: false }, { id: "branch", parent: "parent" }]);
    expect(planArchive(tree, ["branch"])).toEqual({ changed: ["branch"], skipped: [] });
  });

  it("answers already, not_found and active per id, in the order asked", () => {
    const tree = treeOf([{ id: "done", archived: true }, { id: "busy", finished: false }, { id: "ok" }]);
    expect(planArchive(tree, ["done", "missing", "busy", "ok"])).toEqual({
      changed: ["ok"],
      skipped: [
        { id: "done", reason: "already" },
        { id: "missing", reason: "not_found" },
        { id: "busy", reason: "active" },
      ],
    });
  });

  it("does not report a descendant as skipped when it was archived together with an ancestor named earlier", () => {
    const tree = treeOf([{ id: "root" }, { id: "kid", parent: "root" }]);
    expect(planArchive(tree, ["root", "kid", "root"])).toEqual({ changed: ["root", "kid"], skipped: [] });
  });

  it("leaves members that are already archived out of the changes", () => {
    const tree = treeOf([{ id: "root" }, { id: "old", parent: "root", archived: true }, { id: "new", parent: "root" }]);
    expect(planArchive(tree, ["root"])).toEqual({ changed: ["root", "new"], skipped: [] });
  });

  it("does nothing for an empty request", () => {
    expect(planArchive(treeOf([{ id: "a" }]), [])).toEqual({ changed: [], skipped: [] });
  });
});

describe("planUnarchive", () => {
  it("brings back the session, its archived descendants and the archived chain above it, root first", () => {
    const tree = treeOf([
      { id: "root", archived: true },
      { id: "mid", parent: "root", archived: true },
      { id: "leaf", parent: "mid", archived: true },
      { id: "twin", parent: "root", archived: true },
    ]);
    expect(planUnarchive(tree, ["mid"])).toEqual({ changed: ["root", "mid", "leaf"], skipped: [] });
  });

  it("leaves ancestors that are not archived alone", () => {
    const tree = treeOf([{ id: "root" }, { id: "kid", parent: "root", archived: true }, { id: "leaf", parent: "kid", archived: true }]);
    expect(planUnarchive(tree, ["kid"])).toEqual({ changed: ["kid", "leaf"], skipped: [] });
  });

  it("answers not_archived and not_found per id, and does not unarchive the parents of a session that was never archived", () => {
    const tree = treeOf([{ id: "root", archived: true }, { id: "visible", parent: "root" }]);
    expect(planUnarchive(tree, ["visible", "missing"])).toEqual({
      changed: [],
      skipped: [
        { id: "visible", reason: "not_archived" },
        { id: "missing", reason: "not_found" },
      ],
    });
  });

  it("stops the ancestor chain where a parent no longer exists", () => {
    const tree = treeOf([{ id: "orphan", parent: "removed", archived: true }]);
    expect(planUnarchive(tree, ["orphan"])).toEqual({ changed: ["orphan"], skipped: [] });
  });

  it("lists each session once when the request names several of the same family", () => {
    const tree = treeOf([{ id: "root", archived: true }, { id: "kid", parent: "root", archived: true }]);
    expect(planUnarchive(tree, ["kid", "root", "kid"])).toEqual({ changed: ["root", "kid"], skipped: [] });
  });
});

describe("planRetention", () => {
  const off = { keepDays: null, keepCount: null };

  it("does nothing when both limits are null", () => {
    expect(planRetention(treeOf([{ id: "a", ageDays: 1000 }]), off, NOW)).toEqual([]);
  });

  it("keepDays archives finished trees whose last activity is older than that many days", () => {
    const tree = treeOf([{ id: "stale", ageDays: 31 }, { id: "recent", ageDays: 29 }, { id: "edge", ageDays: 30 }]);
    // 恰好 30 天的不算“早于”30 天。
    expect(planRetention(tree, { keepDays: 30, keepCount: null }, NOW)).toEqual(["stale"]);
  });

  it("measures a tree by its most recent member, so a fresh child keeps an old root", () => {
    const tree = treeOf([{ id: "root", ageDays: 90 }, { id: "kid", parent: "root", ageDays: 2 }, { id: "alone", ageDays: 90 }]);
    expect(planRetention(tree, { keepDays: 30, keepCount: null }, NOW)).toEqual(["alone"]);
  });

  it("never picks a tree with a working member, however old the rest of it is", () => {
    const tree = treeOf([{ id: "root", ageDays: 400 }, { id: "busy", parent: "root", ageDays: 400, finished: false }]);
    expect(planRetention(tree, { keepDays: 7, keepCount: 1 }, NOW)).toEqual([]);
  });

  it("keepCount keeps the most recently active trees and archives the finished rest", () => {
    const tree = treeOf([{ id: "c", ageDays: 30 }, { id: "a", ageDays: 1 }, { id: "d", ageDays: 40 }, { id: "b", ageDays: 5 }]);
    expect(planRetention(tree, { keepDays: null, keepCount: 2 }, NOW)).toEqual(["c", "d"]);
  });

  it("lets a tree that is still working take up a slot without ever being archived itself", () => {
    const tree = treeOf([{ id: "busy", ageDays: 0, finished: false }, { id: "x", ageDays: 1 }, { id: "y", ageDays: 2 }]);
    expect(planRetention(tree, { keepDays: null, keepCount: 2 }, NOW)).toEqual(["y"]);
  });

  it("does not count trees that are already archived", () => {
    const tree = treeOf([{ id: "gone", ageDays: 1, archived: true }, { id: "x", ageDays: 2 }, { id: "y", ageDays: 3 }]);
    expect(planRetention(tree, { keepDays: null, keepCount: 1 }, NOW)).toEqual(["y"]);
  });

  it("counts trees, not sessions: children never take a slot of their own", () => {
    const tree = treeOf([
      { id: "a", ageDays: 1 },
      { id: "a1", parent: "a", ageDays: 1 },
      { id: "a2", parent: "a", ageDays: 1 },
      { id: "b", ageDays: 2 },
    ]);
    expect(planRetention(tree, { keepDays: null, keepCount: 2 }, NOW)).toEqual([]);
  });

  it("archives a tree that breaks either limit (the two limits add up, they do not both have to apply)", () => {
    const tree = treeOf([{ id: "a", ageDays: 1 }, { id: "b", ageDays: 2 }, { id: "c", ageDays: 3 }, { id: "d", ageDays: 100 }]);
    // keepCount 3 挡下 d（第 4 名）；keepDays 30 也挡下 d：并集仍然只有 d。
    expect(planRetention(tree, { keepDays: 30, keepCount: 3 }, NOW)).toEqual(["d"]);
    // keepDays 单独看 c 不算旧，但 keepCount 2 把它排在名额之外。
    expect(planRetention(tree, { keepDays: 30, keepCount: 2 }, NOW)).toEqual(["c", "d"]);
  });

  it("treats a session whose parent is gone as a root of its own", () => {
    const tree = treeOf([{ id: "orphan", parent: "removed", ageDays: 90 }]);
    expect(planRetention(tree, { keepDays: 30, keepCount: null }, NOW)).toEqual(["orphan"]);
  });

  it("breaks ties between equally recent trees by id so the result is deterministic", () => {
    const tree = treeOf([{ id: "b", ageDays: 10 }, { id: "a", ageDays: 10 }, { id: "c", ageDays: 10 }]);
    expect(planRetention(tree, { keepDays: null, keepCount: 1 }, NOW)).toEqual(["b", "c"]);
  });

  it("never ages out a tree whose time it cannot read, and ranks it as the most recent", () => {
    const tree = treeOf([{ id: "unknown", activityMs: Number.POSITIVE_INFINITY }, { id: "old", ageDays: 400 }]);
    expect(planRetention(tree, { keepDays: 30, keepCount: null }, NOW)).toEqual(["old"]);
    expect(planRetention(tree, { keepDays: null, keepCount: 1 }, NOW)).toEqual(["old"]);
  });
});

describe("retentionFault", () => {
  it("accepts null and whole numbers from 1 up to the limit", () => {
    expect(retentionFault("keepDays", null)).toBeUndefined();
    expect(retentionFault("keepCount", null)).toBeUndefined();
    expect(retentionFault("keepDays", 1)).toBeUndefined();
    expect(retentionFault("keepDays", LIMITS.retention.maxKeepDays)).toBeUndefined();
    expect(retentionFault("keepCount", LIMITS.retention.maxKeepCount)).toBeUndefined();
  });

  it("rejects zero, negatives, fractions, numbers past the limit and anything that is not a number", () => {
    const bad: unknown[] = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "7", true, undefined, [], {}];
    for (const value of bad) expect(retentionFault("keepDays", value), String(value)).toEqual(expect.any(String));
    expect(retentionFault("keepDays", LIMITS.retention.maxKeepDays + 1)).toContain(String(LIMITS.retention.maxKeepDays));
    expect(retentionFault("keepCount", LIMITS.retention.maxKeepCount + 1)).toContain(String(LIMITS.retention.maxKeepCount));
  });

  it("names the field it is complaining about", () => {
    expect(retentionFault("keepDays", 0)).toContain("keepDays");
    expect(retentionFault("keepCount", 0)).toContain("keepCount");
  });
});
