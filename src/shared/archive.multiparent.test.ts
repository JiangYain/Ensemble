import { describe, expect, it } from "vitest";
import { archiveNodeOf, archiveScopeOf, planArchive, planRetention, planUnarchive, subtreeOf, type ArchiveTree } from "./archive";
import { parentFields } from "./lineage";

/**
 * 汇聚（一个会话跟随多个上级）下的归档与留存规则。没有汇聚节点的数据上的行为由 archive.test.ts 守着，这里不重复。
 *
 * 常用的一张图（菱形）：R 是根，A 与 B 都跟随 R，J 同时跟随 A 与 B。
 */

const DAY = 86_400_000;
const NOW = Date.parse("2026-06-01T12:00:00.000Z");

interface Spec {
  id: string;
  /** 有序的上级；第一个是主上级。 */
  parents?: string[];
  /** 缺省 = 已结束 */
  finished?: boolean;
  archived?: boolean;
  /** 最后活动距现在多少天，缺省 30 */
  ageDays?: number;
}

/** 用几行内存表造一张会话图；数组次序就是创建次序，也就是下级的遍历次序。 */
function graphOf(specs: readonly Spec[]): ArchiveTree {
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  return {
    node: (id) => {
      const spec = byId.get(id);
      if (!spec) return undefined;
      return {
        id,
        ...parentFields(spec.parents ?? []),
        archived: spec.archived === true,
        finished: spec.finished !== false,
        activityMs: NOW - (spec.ageDays ?? 30) * DAY,
      };
    },
    childrenOf: (id) => specs.filter((spec) => spec.parents?.includes(id)).map((spec) => spec.id),
    ids: () => specs.map((spec) => spec.id),
  };
}

const diamond = (overrides: Partial<Record<"R" | "A" | "B" | "J", Partial<Spec>>> = {}): Spec[] => [
  { id: "R", ...overrides.R },
  { id: "A", parents: ["R"], ...overrides.A },
  { id: "B", parents: ["R"], ...overrides.B },
  { id: "J", parents: ["A", "B"], ...overrides.J },
];

describe("archiveNodeOf with several parents", () => {
  it("carries the whole parent set only when there is one, and the primary parent always", () => {
    const base = { id: "J", phase: "done" as const, messages: { total: 1, pending: 0 }, updatedAt: "2026-05-01T00:00:00.000Z" };
    const several = archiveNodeOf({ ...base, parentSessionId: "A", parentSessionIds: ["A", "B"] });
    expect(several).toMatchObject({ parentSessionId: "A", parentSessionIds: ["A", "B"] });
    const single = archiveNodeOf({ ...base, parentSessionId: "A" });
    expect(single.parentSessionId).toBe("A");
    expect("parentSessionIds" in single).toBe(false);
  });
});

describe("subtreeOf on a graph", () => {
  it("visits a session below two parents once", () => {
    const members = subtreeOf(graphOf(diamond()), "R");
    expect([...members].sort()).toEqual(["A", "B", "J", "R"]);
    expect(new Set(members).size).toBe(members.length);
  });
});

describe("archiveScopeOf: what goes along when one session is named", () => {
  const sorted = (ids: readonly string[]): string[] => [...ids].sort();

  it("is the whole subtree for the root of the diamond, each session once", () => {
    const scope = archiveScopeOf(graphOf(diamond()), "R");
    expect(sorted(scope)).toEqual(["A", "B", "J", "R"]);
    expect(scope[0]).toBe("R");
    expect(new Set(scope).size).toBe(scope.length);
  });

  it("leaves out a join that still follows a live parent, and does not look at whether it has finished", () => {
    expect(archiveScopeOf(graphOf(diamond()), "A")).toEqual(["A"]);
    expect(archiveScopeOf(graphOf(diamond({ J: { finished: false } })), "A")).toEqual(["A"]);
  });

  it("takes the join when its other parent was archived already", () => {
    expect(sorted(archiveScopeOf(graphOf(diamond({ B: { archived: true } })), "A"))).toEqual(["A", "J"]);
  });

  it("is the named join alone when it is the one named", () => {
    expect(archiveScopeOf(graphOf(diamond()), "J")).toEqual(["J"]);
  });

  it("is the plain subtree where nothing joins (the shape every older session has)", () => {
    const chain = graphOf([{ id: "R" }, { id: "C", parents: ["R"] }, { id: "G", parents: ["C"] }, { id: "S", parents: ["R"] }]);
    expect(sorted(archiveScopeOf(chain, "R"))).toEqual(sorted(subtreeOf(chain, "R")));
    expect(sorted(archiveScopeOf(chain, "R"))).toEqual(["C", "G", "R", "S"]);
    expect(sorted(archiveScopeOf(chain, "C"))).toEqual(["C", "G"]);
  });

  it("terminates on a data cycle", () => {
    const cycle = graphOf([{ id: "X", parents: ["Y"] }, { id: "Y", parents: ["X"] }]);
    expect(sorted(archiveScopeOf(cycle, "X"))).toEqual(["X", "Y"]);
  });

  it("is exactly the set planArchive archives when only that session is named (the page's forecast and the service cannot drift)", () => {
    const graphs: Spec[][] = [
      diamond(),
      diamond({ B: { archived: true } }),
      diamond({ J: { finished: false } }),
      [{ id: "R" }, { id: "C", parents: ["R"] }, { id: "G", parents: ["C"] }],
    ];
    for (const specs of graphs) {
      const tree = graphOf(specs);
      for (const spec of specs) {
        if (spec.archived === true) continue;
        const goes = archiveScopeOf(tree, spec.id).filter((id) => tree.node(id)?.archived !== true);
        const changed = planArchive(tree, [spec.id]).changed;
        // 被拦住（范围里有没结束的）时服务端什么也不归档；没有被拦时与预判的范围一致。
        const blocked = archiveScopeOf(tree, spec.id).some((id) => tree.node(id)?.finished === false);
        expect(sorted(changed)).toEqual(blocked ? [] : sorted(goes));
      }
    }
  });
});

describe("planArchive with a join", () => {
  it("archives the whole diamond once when its root is named, whichever way the join is reached", () => {
    const result = planArchive(graphOf(diamond()), ["R"]);
    expect([...result.changed].sort()).toEqual(["A", "B", "J", "R"]);
    expect(new Set(result.changed).size).toBe(result.changed.length);
    expect(result.skipped).toEqual([]);
    expect("kept" in result).toBe(false);
  });

  it("leaves a join where it is when only one of its parents goes, and says whom it still follows", () => {
    const result = planArchive(graphOf(diamond()), ["A"]);
    expect(result.changed).toEqual(["A"]);
    expect(result.skipped).toEqual([]);
    expect(result.kept).toEqual([{ id: "J", follows: ["B"] }]);
  });

  it("takes the join along when all of its parents are named in the same request", () => {
    const result = planArchive(graphOf(diamond()), ["A", "B"]);
    expect([...result.changed].sort()).toEqual(["A", "B", "J"]);
    expect("kept" in result).toBe(false);
  });

  it("takes the join along when its other parent was archived already", () => {
    const result = planArchive(graphOf(diamond({ B: { archived: true } })), ["A"]);
    expect([...result.changed].sort()).toEqual(["A", "J"]);
    expect("kept" in result).toBe(false);
  });

  it("does not let a join that stays behind (it still belongs to a live parent) block the archive", () => {
    // J 还在工作，但 B 没有归档，J 不会随 A 走——它不算被藏起来，A 照常归档。
    const result = planArchive(graphOf(diamond({ J: { finished: false } })), ["A"]);
    expect(result.changed).toEqual(["A"]);
    expect(result.skipped).toEqual([]);
    expect(result.kept).toEqual([{ id: "J", follows: ["B"] }]);
  });

  it("refuses with `active` when the join would go along and is still working", () => {
    const result = planArchive(graphOf(diamond({ J: { finished: false } })), ["A", "B"]);
    expect(result.changed).toEqual([]);
    expect(result.skipped).toEqual([
      { id: "A", reason: "active" },
      { id: "B", reason: "active" },
    ]);
  });

  it("reports a session that is already archived and one that does not exist, as before", () => {
    const result = planArchive(graphOf(diamond({ A: { archived: true } })), ["A", "nope"]);
    expect(result.changed).toEqual([]);
    expect(result.skipped).toEqual([
      { id: "A", reason: "already" },
      { id: "nope", reason: "not_found" },
    ]);
  });

  it("does not loop on a data cycle (two sessions that follow each other)", () => {
    const result = planArchive(graphOf([{ id: "X", parents: ["Y"] }, { id: "Y", parents: ["X"] }]), ["X"]);
    expect(result.skipped).toEqual([]);
    expect([...result.changed].sort()).toEqual(["X", "Y"]);
  });
});

describe("planUnarchive with a join", () => {
  const allArchived = (): Spec[] => diamond({ R: { archived: true }, A: { archived: true }, B: { archived: true }, J: { archived: true } });

  it("brings back every archived parent of a join together with it, parents first", () => {
    const result = planUnarchive(graphOf(allArchived()), ["J"]);
    expect(result.changed).toEqual(["R", "A", "B", "J"]);
    expect(result.skipped).toEqual([]);
  });

  it("brings back the join and its other archived parent when only one parent is named", () => {
    const result = planUnarchive(graphOf(allArchived()), ["A"]);
    expect(result.changed).toEqual(["R", "B", "A", "J"]);
  });

  it("brings back the whole subtree below the named root exactly once", () => {
    const result = planUnarchive(graphOf(allArchived()), ["R"]);
    expect([...result.changed].sort()).toEqual(["A", "B", "J", "R"]);
    expect(new Set(result.changed).size).toBe(result.changed.length);
  });

  it("does not touch an ancestor that was never archived", () => {
    const result = planUnarchive(graphOf(diamond({ A: { archived: true }, J: { archived: true } })), ["J"]);
    expect(result.changed).toEqual(["A", "J"]);
  });

  it("still says `not_archived` for a named session that is not archived", () => {
    expect(planUnarchive(graphOf(diamond({ J: { archived: true } })), ["A"]).skipped).toEqual([{ id: "A", reason: "not_archived" }]);
  });
});

describe("planRetention with a join", () => {
  it("treats the roots joined by a session as one task graph: archived together, once it is old enough", () => {
    const tree = graphOf([{ id: "R1" }, { id: "R2" }, { id: "J", parents: ["R1", "R2"] }]);
    expect(planRetention(tree, { keepDays: 10, keepCount: null }, NOW)).toEqual(["R1", "R2"]);
  });

  it("uses the newest activity anywhere in the graph, so one recent session keeps the whole graph", () => {
    const tree = graphOf([{ id: "R1" }, { id: "R2" }, { id: "J", parents: ["R1", "R2"], ageDays: 1 }]);
    expect(planRetention(tree, { keepDays: 10, keepCount: null }, NOW)).toEqual([]);
  });

  it("never archives a graph that has a working member, wherever it is", () => {
    const tree = graphOf([{ id: "R1" }, { id: "R2", finished: false }, { id: "J", parents: ["R1", "R2"] }]);
    expect(planRetention(tree, { keepDays: 10, keepCount: null }, NOW)).toEqual([]);
  });

  it("counts a connected graph as one against keepCount, however many roots it has", () => {
    const tree = graphOf([
      { id: "R1", ageDays: 40 },
      { id: "R2", ageDays: 40 },
      { id: "J", parents: ["R1", "R2"], ageDays: 40 },
      { id: "G", ageDays: 1 },
    ]);
    // 两个“任务图”：G 和 R1/R2/J；留两个就一个也不归档，留一个就归档更久远的那个图（它的两个根一起）。
    expect(planRetention(tree, { keepDays: null, keepCount: 2 }, NOW)).toEqual([]);
    expect(planRetention(tree, { keepDays: null, keepCount: 1 }, NOW)).toEqual(["R1", "R2"]);
  });

  it("skips a graph whose roots are all archived already", () => {
    const tree = graphOf([{ id: "R1", archived: true }, { id: "R2", archived: true }, { id: "J", parents: ["R1", "R2"], archived: true }]);
    expect(planRetention(tree, { keepDays: 1, keepCount: null }, NOW)).toEqual([]);
  });
});