import { describe, expect, it } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog, testOrigin } from "@shared/testing";
import type { SessionPhase, SessionSummary } from "@shared/types";
import {
  createdOrder,
  flattenSessions,
  placeWindow,
  rootOrder,
  sameWindowMemory,
  type WindowMemory,
} from "./sessionOrder";

const T0 = Date.parse("2026-11-21T08:00:00.000Z");
const MINUTE = 60_000;

/** 在第 `minute` 分钟创建的会话；phase / updatedAt 随意改，用来证明它们不参与排序。 */
function make(
  id: string,
  minute: number,
  opts: { parent?: string; phase?: SessionPhase; updatedMinute?: number } = {},
): SessionSummary {
  const log = new EventLog(id, T0 + minute * MINUTE);
  log.created({
    title: id,
    harness: "cursor",
    createdAt: new Date(T0 + minute * MINUTE).toISOString(),
    origin: testOrigin({ key: "cursor:a", host: "cursor", hostLabel: "Cursor" }),
    ...(opts.parent ? { parentSessionId: opts.parent } : {}),
  });
  return {
    ...toSummary(replay(log.events)!),
    phase: opts.phase ?? "done",
    updatedAt: new Date(T0 + (opts.updatedMinute ?? minute) * MINUTE).toISOString(),
  };
}

const ids = (rows: readonly { session: SessionSummary }[]): string[] => rows.map((row) => row.session.id);
const depths = (rows: readonly { depth: number }[]): number[] => rows.map((row) => row.depth);

/** 一棵树加两个根：r1 最早创建，名下有 k1a、k1b（k1a 下还有 g）；r2、r3 在它之后创建。 */
const tree = (): SessionSummary[] => [
  make("r1", 1),
  make("r2", 2),
  make("r3", 3),
  make("k1a", 4, { parent: "r1" }),
  make("k1b", 5, { parent: "r1" }),
  make("g", 6, { parent: "k1a" }),
];

/** 同一批会话的几种入参顺序：原样、倒过来、轮转、交错。 */
function permutations<T>(list: readonly T[]): T[][] {
  const reversed = [...list].reverse();
  const rotated = [...list.slice(2), ...list.slice(0, 2)];
  const interleaved = [...list.filter((_, i) => i % 2 === 1), ...list.filter((_, i) => i % 2 === 0)];
  return [[...list], reversed, rotated, interleaved];
}

describe("createdOrder / rootOrder（列表视图与侧栏兄弟会话共用的顺序依据）", () => {
  it("先按创建时间（早的在前），同一时刻用 id 兜底；rootOrder 是它的反向", () => {
    const early = make("ses_b", 1);
    const late = make("ses_a", 2);
    expect(createdOrder(early, late)).toBeLessThan(0);
    expect(createdOrder(late, early)).toBeGreaterThan(0);

    const tieA = make("ses_a", 3);
    const tieB = make("ses_b", 3);
    expect(createdOrder(tieA, tieB)).toBeLessThan(0);
    expect(createdOrder(tieB, tieA)).toBeGreaterThan(0);
    expect(createdOrder(tieA, make("ses_a", 3))).toBe(0);

    expect(rootOrder(early, late)).toBeGreaterThan(0);
    expect(rootOrder(tieA, tieB)).toBeGreaterThan(0);
  });

  it("状态、最近更新时间不参与：即使最早创建的会话刚刚更新过，也还是排在更早的位置", () => {
    const early = make("ses_early", 1, { phase: "running", updatedMinute: 500 });
    const late = make("ses_late", 2, { phase: "done", updatedMinute: 2 });
    expect(createdOrder(early, late)).toBeLessThan(0);
  });
});

describe("flattenSessions", () => {
  it("根会话新→旧；子会话紧跟在上级之后、旧→新，逐级加深", () => {
    const rows = flattenSessions(tree());
    expect(ids(rows)).toEqual(["r3", "r2", "r1", "k1a", "g", "k1b"]);
    expect(depths(rows)).toEqual([0, 0, 0, 1, 2, 1]);
  });

  it("与会话状态、最近更新时间、传入数组的顺序都无关", () => {
    const base = flattenSessions(tree());

    // 每个会话换一个状态，最近更新时间拉到各不相同的远处——最早创建的 r1 反而“最近更新”。
    const phases: SessionPhase[] = ["running", "failed", "ready", "queued", "starting", "cancelled"];
    const churned = tree().map((session, index) => ({
      ...session,
      phase: phases[index]!,
      updatedAt: new Date(T0 + (900 - index * 120) * MINUTE).toISOString(),
    }));
    expect(churned.map((s) => s.phase)).not.toEqual(tree().map((s) => s.phase));

    for (const input of [...permutations(tree()), ...permutations(churned)]) {
      const rows = flattenSessions(input);
      expect(ids(rows)).toEqual(ids(base));
      expect(depths(rows)).toEqual(depths(base));
    }
  });

  it("同一时刻创建的会话用 id 兜底：根里 id 大的在上，子会话里 id 小的在前，与入参顺序无关", () => {
    const sessions = [
      make("root_a", 1),
      make("root_b", 1),
      make("kid_b", 2, { parent: "root_a" }),
      make("kid_a", 2, { parent: "root_a" }),
    ];
    for (const input of permutations(sessions)) {
      const rows = flattenSessions(input);
      expect(ids(rows)).toEqual(["root_b", "root_a", "kid_a", "kid_b"]);
      expect(depths(rows)).toEqual([0, 0, 1, 1]);
    }
  });

  it("数据环（含自己当自己的上级）：每个会话恰好出现一次，结果与入参顺序无关", () => {
    // a 与 b 互为上级，s 的上级是自己，c 是正常的根。
    const sessions = [make("a", 1, { parent: "b" }), make("b", 2, { parent: "a" }), make("c", 3), make("s", 4, { parent: "s" })];
    const base = flattenSessions(sessions);
    expect([...ids(base)].sort()).toEqual(["a", "b", "c", "s"]);
    // 环上最新创建的当根，其余挂在它下面；兜底遍历同样按确定的次序走。
    expect(ids(base)).toEqual(["c", "s", "b", "a"]);
    expect(depths(base)).toEqual([0, 0, 0, 1]);

    for (const input of permutations(sessions)) {
      expect(ids(flattenSessions(input))).toEqual(ids(base));
    }
  });

  it("上级不在列表里（已删除、或被过滤掉）的子会话当根，按自己的创建时间排", () => {
    const rows = flattenSessions([make("r1", 1), make("r2", 2), make("orphan", 5, { parent: "gone" })]);
    expect(ids(rows)).toEqual(["orphan", "r2", "r1"]);
    expect(depths(rows)).toEqual([0, 0, 0]);
  });

  it("不改传入的数组", () => {
    const input = tree();
    const before = ids(input.map((session) => ({ session })));
    flattenSessions(input);
    expect(ids(input.map((session) => ({ session })))).toEqual(before);
  });
});

describe("placeWindow（兄弟会话超过上限时的可见窗口）", () => {
  const LIMIT = 6;
  const pad = (n: number): string => String(n).padStart(2, "0");
  /** r00 … r{n-1}，下标就是它在稳定顺序里的位置。 */
  const rows = (n: number): { id: string }[] => Array.from({ length: n }, (_, i) => ({ id: `r${pad(i)}` }));
  const rowIds = (list: readonly { id: string }[]): string[] => list.map((row) => row.id);
  const span = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => `r${pad(from + i)}`);

  it("总数不超过上限：全部显示，没有隐藏，也不留记忆（哪怕传进来一份旧记忆）", () => {
    const stale: WindowMemory = { first: "r03", index: 3 };
    for (const n of [0, 1, 5, 6]) {
      const win = placeWindow(rows(n), n > 0 ? "r00" : undefined, stale, LIMIT);
      expect(rowIds(win.rows)).toEqual(rowIds(rows(n)));
      expect(win.hidden).toBe(0);
      expect(win.memory).toBeUndefined();
    }
  });

  it("当前会话在前 6 个里（或没有当前会话）：窗口贴着顶端，隐藏数是总数减 6", () => {
    for (const current of ["r00", "r03", "r05", undefined]) {
      const win = placeWindow(rows(12), current, undefined, LIMIT);
      expect(rowIds(win.rows)).toEqual(span(0, 5));
      expect(win.hidden).toBe(6);
      expect(win.memory).toBeUndefined();
    }
    expect(placeWindow(rows(7), "r00", undefined, LIMIT).hidden).toBe(1);
  });

  it("当前会话在前 6 个之外：窗口是连续的一段，只移到刚好看见它（它是最后一行），不是“前 5 个 + 隔着一段的当前”", () => {
    const win = placeWindow(rows(12), "r09", undefined, LIMIT);
    expect(rowIds(win.rows)).toEqual(span(4, 9));
    expect(win.hidden).toBe(6);
    expect(win.memory).toEqual({ first: "r04", index: 4 });
    expect(rowIds(win.rows)).not.toEqual([...span(0, 4), "r09"]);

    // 刚好落在第 7 个：只滑一格。
    expect(rowIds(placeWindow(rows(12), "r06", undefined, LIMIT).rows)).toEqual(span(1, 6));
  });

  it("在窗口里换当前会话，窗口不动", () => {
    const first = placeWindow(rows(12), "r09", undefined, LIMIT);
    for (const current of span(4, 9)) {
      const win = placeWindow(rows(12), current, first.memory, LIMIT);
      expect(rowIds(win.rows)).toEqual(span(4, 9));
      expect(sameWindowMemory(win.memory, first.memory)).toBe(true);
    }
  });

  it("当前会话落到窗口上方：窗口上移到它成为第一行，只移这么多；到了最顶上就回到贴顶端", () => {
    const from: WindowMemory = { first: "r04", index: 4 };
    const up = placeWindow(rows(12), "r02", from, LIMIT);
    expect(rowIds(up.rows)).toEqual(span(2, 7));
    expect(up.memory).toEqual({ first: "r02", index: 2 });

    const top = placeWindow(rows(12), "r00", from, LIMIT);
    expect(rowIds(top.rows)).toEqual(span(0, 5));
    expect(top.memory).toBeUndefined();
  });

  it("当前会话落到窗口下方：窗口下移到它成为最后一行，只移这么多", () => {
    const from: WindowMemory = { first: "r02", index: 2 };
    const down = placeWindow(rows(12), "r11", from, LIMIT);
    expect(rowIds(down.rows)).toEqual(span(6, 11));
    expect(down.hidden).toBe(6);
    expect(down.memory).toEqual({ first: "r06", index: 6 });

    // 刚好落在窗口的下一行：只滑一格。
    expect(rowIds(placeWindow(rows(12), "r08", from, LIMIT).rows)).toEqual(span(3, 8));
  });

  it("窗口贴着顶端时，新会话出现在顶部：窗口仍留在顶端，看得到新来的", () => {
    const top = placeWindow(rows(12), "r01", undefined, LIMIT);
    const grown = [{ id: "new" }, ...rows(12)];
    const win = placeWindow(grown, "r01", top.memory, LIMIT);
    expect(rowIds(win.rows)).toEqual(["new", ...span(0, 4)]);
    expect(win.hidden).toBe(7);
    expect(win.memory).toBeUndefined();
  });

  it("窗口贴着顶端、当前在最后一行时来了新会话：窗口只滑一格保住当前，窗口里还是原来那几个会话", () => {
    const top = placeWindow(rows(12), "r05", undefined, LIMIT);
    expect(rowIds(top.rows)).toEqual(span(0, 5));

    const once = placeWindow([{ id: "n1" }, ...rows(12)], "r05", top.memory, LIMIT);
    expect(rowIds(once.rows)).toEqual(span(0, 5));
    expect(once.memory).toEqual({ first: "r00", index: 1 });

    const twice = placeWindow([{ id: "n2" }, { id: "n1" }, ...rows(12)], "r05", once.memory, LIMIT);
    expect(rowIds(twice.rows)).toEqual(span(0, 5));
    expect(twice.memory).toEqual({ first: "r00", index: 2 });
    expect(twice.hidden).toBe(8);
  });

  it("窗口不在顶端时，上面插入新行：窗口里的会话不变（按第一行是谁锚定，不按下标）", () => {
    const from: WindowMemory = { first: "r04", index: 4 };
    const grown = [{ id: "n2" }, { id: "n1" }, ...rows(12)];
    const win = placeWindow(grown, "r06", from, LIMIT);
    expect(rowIds(win.rows)).toEqual(span(4, 9));
    expect(win.hidden).toBe(8);
    expect(win.memory).toEqual({ first: "r04", index: 6 });
  });

  it("窗口的第一行被删掉：用上次的下标兜底，窗口大致留在原处", () => {
    const from: WindowMemory = { first: "r04", index: 4 };
    const without = rows(12).filter((row) => row.id !== "r04");
    const win = placeWindow(without, "r07", from, LIMIT);
    expect(rowIds(win.rows)).toEqual(["r05", "r06", "r07", "r08", "r09", "r10"]);
    expect(win.memory).toEqual({ first: "r05", index: 4 });
  });

  it("列表缩短：窗口收拢到末尾，始终是满的", () => {
    const from: WindowMemory = { first: "r06", index: 6 };
    const win = placeWindow(rows(8), "r07", from, LIMIT);
    expect(rowIds(win.rows)).toEqual(span(2, 7));
    expect(win.hidden).toBe(2);
    expect(win.memory).toEqual({ first: "r02", index: 2 });
  });

  it("当前会话不在列表里（还没加载到）：窗口不动", () => {
    const from: WindowMemory = { first: "r04", index: 4 };
    expect(rowIds(placeWindow(rows(12), "ghost", from, LIMIT).rows)).toEqual(span(4, 9));
    expect(rowIds(placeWindow(rows(12), "ghost", undefined, LIMIT).rows)).toEqual(span(0, 5));
  });

  it("幂等：把输出的记忆再传回去，得到同一个窗口（渲染里据此更新 state 不会反复触发）", () => {
    const cases: { n: number; current: string | undefined; memory: WindowMemory | undefined }[] = [
      { n: 12, current: "r09", memory: undefined },
      { n: 12, current: "r02", memory: { first: "r04", index: 4 } },
      { n: 12, current: "r11", memory: { first: "r02", index: 2 } },
      { n: 8, current: "r07", memory: { first: "r06", index: 6 } },
      { n: 12, current: "r05", memory: undefined },
      { n: 5, current: "r04", memory: { first: "r03", index: 3 } },
    ];
    for (const { n, current, memory } of cases) {
      const once = placeWindow(rows(n), current, memory, LIMIT);
      const again = placeWindow(rows(n), current, once.memory, LIMIT);
      expect(rowIds(again.rows)).toEqual(rowIds(once.rows));
      expect(sameWindowMemory(again.memory, once.memory)).toBe(true);
    }
  });

  it("挑哪几行与会话状态、最近更新时间无关：同一份先后与当前会话，状态全变了窗口也一样", () => {
    const created = Array.from({ length: 10 }, (_, i) => make(`ses_${pad(i)}`, i + 1));
    const churned = created.map((session, index) => ({
      ...session,
      phase: (index % 2 === 0 ? "running" : "failed") as SessionPhase,
      updatedAt: new Date(T0 + (999 - index) * MINUTE).toISOString(),
    }));
    const place = (list: SessionSummary[]) =>
      placeWindow(
        flattenSessions(list).map((row) => row.session),
        "ses_01",
        undefined,
        LIMIT,
      );

    const before = place(created);
    const after = place(churned);
    expect(rowIds(after.rows)).toEqual(rowIds(before.rows));
    // 新→旧排列时第 9 行是 ses_01，所以窗口是第 4 到第 9 行。
    expect(rowIds(before.rows)).toEqual(["ses_06", "ses_05", "ses_04", "ses_03", "ses_02", "ses_01"]);
    expect(before.hidden).toBe(4);
  });
});

describe("sameWindowMemory", () => {
  it("都没有记忆算相同；有无不同、第一行或下标不同都算不同", () => {
    expect(sameWindowMemory(undefined, undefined)).toBe(true);
    expect(sameWindowMemory({ first: "a", index: 2 }, { first: "a", index: 2 })).toBe(true);
    expect(sameWindowMemory(undefined, { first: "a", index: 2 })).toBe(false);
    expect(sameWindowMemory({ first: "a", index: 2 }, undefined)).toBe(false);
    expect(sameWindowMemory({ first: "a", index: 2 }, { first: "b", index: 2 })).toBe(false);
    expect(sameWindowMemory({ first: "a", index: 2 }, { first: "a", index: 3 })).toBe(false);
  });
});
