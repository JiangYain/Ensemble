import { describe, expect, it } from "vitest";
import { planArchive, planUnarchive, type ArchiveTree } from "./archive";
import { parentFields } from "./lineage";

/**
 * 撤销归档：把一次归档实际变化的会话原样放回去（`planUnarchive` 的 `exact` 选项）。
 * 默认的取消归档是“整棵子树加上级链”，拿它做撤销会出错：A 下面的 B 更早就单独归档了，这次归档 A，回执里的 changed 只有 A，
 * 撤销时 planUnarchive(A) 却把 B 也恢复了——它不是这次归档的逆操作。没有 exact 的取消归档由 archive.test.ts 与
 * archive.multiparent.test.ts 守着，这里只在需要对照时才调用它。
 */

interface Spec {
  id: string;
  /** 有序的上级；第一个是主上级。 */
  parents?: string[];
  archived?: boolean;
}

/** 用几行内存表造一张会话图（会话都已结束）；数组次序就是创建次序，也就是下级的遍历次序。 */
function graphOf(specs: readonly Spec[]): ArchiveTree {
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  return {
    node: (id) => {
      const spec = byId.get(id);
      if (!spec) return undefined;
      return { id, ...parentFields(spec.parents ?? []), archived: spec.archived === true, finished: true, activityMs: 0 };
    },
    childrenOf: (id) => specs.filter((spec) => spec.parents?.includes(id)).map((spec) => spec.id),
    ids: () => specs.map((spec) => spec.id),
  };
}

/** 把这些会话的归档状态改成 `archived`：规则只算不写，写入由测试自己按它的结果做。 */
const withArchived = (specs: readonly Spec[], ids: readonly string[], archived: boolean): Spec[] =>
  specs.map((spec) => (ids.includes(spec.id) ? { ...spec, archived } : spec));

const archivedIn = (specs: readonly Spec[]): string[] =>
  specs
    .filter((spec) => spec.archived)
    .map((spec) => spec.id)
    .sort();

describe("the case the ordinary unarchive gets wrong as an undo", () => {
  // B 在 A 下面，更早就单独归档了；这次归档 A，只有 A 自己变。
  const before: Spec[] = [{ id: "A" }, { id: "B", parents: ["A"], archived: true }];

  it("archiving A changes A alone, since B was archived already", () => {
    expect(planArchive(graphOf(before), ["A"])).toEqual({ changed: ["A"], skipped: [] });
  });

  it("the ordinary unarchive of A brings B back too, so it is not the inverse of that archive", () => {
    const after = withArchived(before, ["A"], true);
    expect(planUnarchive(graphOf(after), ["A"]).changed).toEqual(["A", "B"]);
  });

  it("the exact unarchive of what the archive changed puts back exactly that: B stays archived", () => {
    const after = withArchived(before, ["A"], true);

    const undo = planUnarchive(graphOf(after), ["A"], { exact: true });

    expect(undo).toEqual({ changed: ["A"], skipped: [] });
    expect(archivedIn(withArchived(after, undo.changed, false))).toEqual(["B"]);
  });
});

describe("archive, then exact unarchive of what changed, leaves the world as it was", () => {
  // 菱形：R 是根，A 与 B 都跟随 R，J 同时跟随 A 与 B；这里 A 更早就归档了。
  const diamond: Spec[] = [{ id: "R" }, { id: "A", parents: ["R"], archived: true }, { id: "B", parents: ["R"] }, { id: "J", parents: ["A", "B"] }];

  const cases: { name: string; specs: Spec[]; named: string[]; changes: string[] }[] = [
    { name: "a chain archived from its top", specs: [{ id: "a" }, { id: "b", parents: ["a"] }, { id: "c", parents: ["b"] }], named: ["a"], changes: ["a", "b", "c"] },
    {
      name: "a branch that was archived earlier, below the one named",
      specs: [{ id: "a" }, { id: "b", parents: ["a"], archived: true }, { id: "c", parents: ["a"] }],
      named: ["a"],
      changes: ["a", "c"],
    },
    { name: "one child archived while its parent stays", specs: [{ id: "a" }, { id: "b", parents: ["a"] }], named: ["b"], changes: ["b"] },
    {
      name: "several roots in one request, one of them with a branch archived earlier",
      specs: [{ id: "x" }, { id: "y" }, { id: "z", parents: ["y"], archived: true }],
      named: ["x", "y"],
      changes: ["x", "y"],
    },
    { name: "a join whose other parent was archived earlier", specs: diamond, named: ["B"], changes: ["B", "J"] },
  ];

  for (const { name, specs, named, changes } of cases) {
    it(name, () => {
      const archive = planArchive(graphOf(specs), named);
      expect(archive.changed).toEqual(changes);
      const after = withArchived(specs, archive.changed, true);

      const undo = planUnarchive(graphOf(after), archive.changed, { exact: true });

      expect(undo).toEqual({ changed: archive.changed, skipped: [] });
      expect(archivedIn(withArchived(after, undo.changed, false))).toEqual(archivedIn(specs));
    });
  }
});

describe("the exact option", () => {
  const chain: Spec[] = [{ id: "p", archived: true }, { id: "c", parents: ["p"], archived: true }, { id: "g", parents: ["c"], archived: true }];

  it("restores only the sessions named: not what is below them, and not an archived session above them", () => {
    expect(planUnarchive(graphOf(chain), ["c"], { exact: true })).toEqual({ changed: ["c"], skipped: [] });
  });

  it("is off unless asked for: left out or switched off, it is the ordinary unarchive of the session, everything below it and the archived chain above it", () => {
    for (const options of [undefined, {}, { exact: false }]) {
      expect(planUnarchive(graphOf(chain), ["c"], options), JSON.stringify(options)).toEqual({ changed: ["p", "c", "g"], skipped: [] });
    }
  });

  it("answers not_found and not_archived like the ordinary unarchive, ignores repeats, and keeps the order named", () => {
    const specs: Spec[] = [{ id: "a", archived: true }, { id: "b" }, { id: "c", archived: true }];

    expect(planUnarchive(graphOf(specs), ["c", "ghost", "b", "a", "c"], { exact: true })).toEqual({
      changed: ["c", "a"],
      skipped: [
        { id: "ghost", reason: "not_found" },
        { id: "b", reason: "not_archived" },
      ],
    });
  });
});
