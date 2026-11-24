import { describe, expect, it } from "vitest";
import { dedupeIds, isAncestorOrSelf, layerOf, parentFields, parentIdsOf, reachableFrom, sameParentList, sameParentSet } from "./lineage";

/** 用一张“会话 → 上级”的内存表造出 parentsOf。 */
function parentsTable(table: Record<string, readonly string[]>): (id: string) => readonly string[] {
  return (id) => table[id] ?? [];
}

/** 反过来：每个会话的下级（先后就是传入的次序）。 */
function childrenTable(table: Record<string, readonly string[]>): (id: string) => readonly string[] {
  return (id) => Object.entries(table).flatMap(([child, parents]) => (parents.includes(id) ? [child] : []));
}

describe("dedupeIds", () => {
  it("keeps the first occurrence of every id, in the order given", () => {
    expect(dedupeIds(["b", "a", "b", "c", "a"])).toEqual(["b", "a", "c"]);
    expect(dedupeIds([])).toEqual([]);
  });
});

describe("parentIdsOf", () => {
  it("is empty when there is no node or no parent", () => {
    expect(parentIdsOf(undefined)).toEqual([]);
    expect(parentIdsOf({})).toEqual([]);
    expect(parentIdsOf({ parentSessionId: undefined, parentSessionIds: undefined })).toEqual([]);
  });

  it("reads the single parent of a session that was never converged on (old logs, old summaries, old services)", () => {
    expect(parentIdsOf({ parentSessionId: "ses_a" })).toEqual(["ses_a"]);
  });

  it("prefers the full ordered set and removes duplicates from it", () => {
    expect(parentIdsOf({ parentSessionId: "ses_a", parentSessionIds: ["ses_a", "ses_b", "ses_a", "ses_c"] })).toEqual(["ses_a", "ses_b", "ses_c"]);
  });

  it("falls back to the single field when the set is empty", () => {
    expect(parentIdsOf({ parentSessionId: "ses_a", parentSessionIds: [] })).toEqual(["ses_a"]);
  });
});

describe("parentFields", () => {
  it("writes nothing at all for no parent", () => {
    expect(parentFields([])).toEqual({});
  });

  it("writes only parentSessionId for one parent, with no parentSessionIds key at all", () => {
    const fields = parentFields(["ses_a"]);
    expect(fields).toEqual({ parentSessionId: "ses_a" });
    expect("parentSessionIds" in fields).toBe(false);
  });

  it("treats duplicates as one parent", () => {
    const fields = parentFields(["ses_a", "ses_a"]);
    expect(fields).toEqual({ parentSessionId: "ses_a" });
    expect("parentSessionIds" in fields).toBe(false);
  });

  it("writes the primary parent and the whole ordered set for two or more", () => {
    expect(parentFields(["ses_b", "ses_a", "ses_c"])).toEqual({ parentSessionId: "ses_b", parentSessionIds: ["ses_b", "ses_a", "ses_c"] });
  });

  it("round-trips through parentIdsOf", () => {
    for (const ids of [[], ["ses_a"], ["ses_a", "ses_b"], ["ses_c", "ses_a", "ses_b"]]) {
      expect(parentIdsOf(parentFields(ids))).toEqual(ids);
    }
  });
});

describe("sameParentList / sameParentSet", () => {
  it("a list differs when only the order differs (the first one is the primary parent), a set does not", () => {
    expect(sameParentList(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameParentList(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameParentSet(["a", "b"], ["b", "a"])).toBe(true);
  });

  it("both tell different sizes and different members apart", () => {
    expect(sameParentList(["a"], ["a", "b"])).toBe(false);
    expect(sameParentSet(["a"], ["a", "b"])).toBe(false);
    expect(sameParentSet(["a", "b"], ["a", "c"])).toBe(false);
    expect(sameParentSet([], [])).toBe(true);
    expect(sameParentList([], [])).toBe(true);
  });
});

describe("reachableFrom", () => {
  it("counts a session reachable along two paths (a diamond) once, and never the start itself", () => {
    const kids = childrenTable({ b: ["a"], c: ["a"], d: ["b", "c"] });
    expect(reachableFrom(["a"], kids)).toEqual(["b", "c", "d"]);
  });

  it("walks from several starts without repeating anything they share", () => {
    const kids = childrenTable({ d: ["b", "c"], e: ["d"] });
    expect(reachableFrom(["b", "c"], kids)).toEqual(["d", "e"]);
  });

  it("stops on a data cycle and does not report the start as reached", () => {
    const kids = childrenTable({ b: ["a"], a: ["b"] });
    expect(reachableFrom(["a"], kids)).toEqual(["b"]);
  });

  it("is empty for a session with nothing below it", () => {
    expect(reachableFrom(["a"], () => [])).toEqual([]);
    expect(reachableFrom([], childrenTable({ b: ["a"] }))).toEqual([]);
  });
});

describe("isAncestorOrSelf", () => {
  // d 跟随 b 与 c，b 与 c 都跟随 a。
  const parents = parentsTable({ d: ["b", "c"], b: ["a"], c: ["a"] });

  it("is true for the session itself and for an ancestor along any of the chains", () => {
    expect(isAncestorOrSelf("d", "d", parents)).toBe(true);
    expect(isAncestorOrSelf("b", "d", parents)).toBe(true);
    expect(isAncestorOrSelf("c", "d", parents)).toBe(true);
    expect(isAncestorOrSelf("a", "d", parents)).toBe(true);
  });

  it("is false for a descendant, a sibling and an unrelated session", () => {
    expect(isAncestorOrSelf("d", "a", parents)).toBe(false);
    expect(isAncestorOrSelf("c", "b", parents)).toBe(false);
    expect(isAncestorOrSelf("z", "d", parents)).toBe(false);
  });

  it("terminates on a data cycle", () => {
    const loop = parentsTable({ x: ["y"], y: ["x"] });
    expect(isAncestorOrSelf("z", "x", loop)).toBe(false);
    expect(isAncestorOrSelf("y", "x", loop)).toBe(true);
  });
});

describe("layerOf", () => {
  it("makes a chain one level deeper at every step and puts the parents first", () => {
    const { depths, order, cyclic } = layerOf(["a", "b", "c"], parentsTable({ b: ["a"], c: ["b"] }));
    expect([...depths]).toEqual([["a", 0], ["b", 1], ["c", 2]]);
    expect(order).toEqual(["a", "b", "c"]);
    expect(cyclic).toEqual([]);
  });

  it("takes the longest chain for a session that follows several (a join sits below the deepest parent)", () => {
    // a → b → c，并且 c 还直接跟随 a：最长的链是 a → b → c。
    const { depths } = layerOf(["a", "b", "c"], parentsTable({ b: ["a"], c: ["a", "b"] }));
    expect(depths.get("c")).toBe(2);
  });

  it("counts a diamond once and puts the join one level below the deeper branch", () => {
    const { depths, order } = layerOf(["a", "b", "c", "d", "e"], parentsTable({ b: ["a"], c: ["a"], d: ["b", "c"], e: ["d"] }));
    expect(depths.get("d")).toBe(2);
    expect(depths.get("e")).toBe(3);
    expect(order).toHaveLength(5);
    expect(new Set(order).size).toBe(5);
  });

  it("puts every parent before its children whatever order the nodes are handed in", () => {
    const { order } = layerOf(["c", "b", "a"], parentsTable({ b: ["a"], c: ["a", "b"] }));
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("measures a parent outside the set by the depth it is known to have, and ignores one that is not known", () => {
    const { depths } = layerOf(
      ["x", "y"],
      parentsTable({ x: ["out1", "out2"], y: ["gone"] }),
      (id) => ({ out1: 3, out2: 1 })[id as "out1" | "out2"],
    );
    expect(depths.get("x")).toBe(4);
    expect(depths.get("y")).toBe(0);
  });

  it("ignores a session listing itself as a parent and a parent listed twice", () => {
    const { depths, order } = layerOf(["a", "b"], parentsTable({ a: ["a"], b: ["a", "a"] }));
    expect(depths.get("a")).toBe(0);
    expect(depths.get("b")).toBe(1);
    expect(order).toEqual(["a", "b"]);
  });

  it("reports sessions on a data cycle instead of looping, and leaves them out of the order", () => {
    const { order, cyclic } = layerOf(["r", "a", "b"], parentsTable({ a: ["r", "b"], b: ["a"] }));
    expect(order).toEqual(["r"]);
    expect(cyclic).toEqual(["a", "b"]);
  });

  it("handles a very long chain without recursion", () => {
    const ids = Array.from({ length: 5000 }, (_, index) => `s${index}`);
    const table: Record<string, string[]> = {};
    ids.forEach((id, index) => {
      if (index > 0) table[id] = [`s${index - 1}`];
    });
    const { depths, cyclic } = layerOf(ids, parentsTable(table));
    expect(depths.get("s4999")).toBe(4999);
    expect(cyclic).toEqual([]);
  });
});
