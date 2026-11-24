import { describe, expect, it } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog, testOrigin } from "@shared/testing";
import type { SessionSummary } from "@shared/types";
import { flattenSessions } from "./sessionOrder";

/**
 * 汇聚（一个会话跟随多个上级）在列表视图 / 侧栏兄弟会话里的顺序：会话只出现一次，挂在它的上级里第一个在列表里的下面。
 * 行序仍只取决于创建先后与 id，与入参顺序无关；没有汇聚的列表由 sessionOrder.test.ts 守着，这里不重复。
 */

const T0 = Date.parse("2026-11-21T08:00:00.000Z");
const MINUTE = 60_000;

/** 在第 `minute` 分钟创建的会话；上级按先后给出，多于一个时与服务端一样多带 parentSessionIds。 */
function make(id: string, minute: number, parents: readonly string[] = []): SessionSummary {
  const log = new EventLog(id, T0 + minute * MINUTE);
  log.created({
    title: id,
    harness: "cursor",
    createdAt: new Date(T0 + minute * MINUTE).toISOString(),
    origin: testOrigin({ key: "cursor:a", host: "cursor", hostLabel: "Cursor" }),
    ...(parents.length > 0 ? { parentSessionId: parents[0]! } : {}),
    ...(parents.length > 1 ? { parentSessionIds: [...parents] } : {}),
  });
  return { ...toSummary(replay(log.events)!), phase: "done" };
}

const ids = (rows: readonly { session: SessionSummary }[]): string[] => rows.map((row) => row.session.id);
const depths = (rows: readonly { depth: number }[]): number[] => rows.map((row) => row.depth);

/** 同一批会话的几种入参顺序：原样、倒过来、轮转、交错。 */
function permutations<T>(list: readonly T[]): T[][] {
  const reversed = [...list].reverse();
  const rotated = [...list.slice(2), ...list.slice(0, 2)];
  const interleaved = [...list.filter((_, i) => i % 2 === 1), ...list.filter((_, i) => i % 2 === 0)];
  return [[...list], reversed, rotated, interleaved];
}

/** R 之下并行的 A、B，再由 J 汇总：菱形。 */
const diamond = (join: readonly string[] = ["a", "b"]): SessionSummary[] => [make("r", 1), make("a", 2, ["r"]), make("b", 3, ["r"]), make("j", 4, join)];

describe("flattenSessions：汇聚的会话", () => {
  it("只出现一次，挂在第一个上级下面：与那个上级的子会话一样按创建先后排，紧跟在它下方", () => {
    const rows = flattenSessions(diamond());

    // J 在 A 的下面（A 的唯一子会话，缩进再深一级），然后才是 R 的第二个子会话 B。
    expect(ids(rows)).toEqual(["r", "a", "j", "b"]);
    expect(depths(rows)).toEqual([0, 1, 2, 1]);
    expect(ids(rows).filter((id) => id === "j")).toHaveLength(1);
  });

  it("主上级是哪个，它就在哪个下面：列出上级的先后决定位置", () => {
    const rows = flattenSessions(diamond(["b", "a"]));

    expect(ids(rows)).toEqual(["r", "a", "b", "j"]);
    expect(depths(rows)).toEqual([0, 1, 1, 2]);
  });

  it("与入参顺序无关", () => {
    const base = ids(flattenSessions(diamond()));

    for (const input of permutations(diamond())) {
      const rows = flattenSessions(input);
      expect(ids(rows)).toEqual(base);
      expect(depths(rows)).toEqual(depths(flattenSessions(diamond())));
    }
  });

  it("与会话状态、最近更新时间无关：汇聚的会话结束了、上级换了状态，行也不换位", () => {
    const base = flattenSessions(diamond());
    const churned = diamond().map((session, index) => ({
      ...session,
      phase: (index % 2 === 0 ? "running" : "failed") as SessionSummary["phase"],
      updatedAt: new Date(T0 + (900 - index * 100) * MINUTE).toISOString(),
    }));

    expect(ids(flattenSessions(churned))).toEqual(ids(base));
    expect(depths(flattenSessions(churned))).toEqual(depths(base));
  });

  it("主上级不在列表里（已删除、或被过滤掉）时顺延到下一个在列表里的上级", () => {
    const rows = flattenSessions(diamond().filter((session) => session.id !== "a"));

    expect(ids(rows)).toEqual(["r", "b", "j"]);
    expect(depths(rows)).toEqual([0, 1, 2]);
  });

  it("所有上级都不在列表里时当根，按自己的创建时间排（新→旧）", () => {
    const rows = flattenSessions([make("r", 1), make("j", 4, ["gone", "missing"])]);

    expect(ids(rows)).toEqual(["j", "r"]);
    expect(depths(rows)).toEqual([0, 0]);
  });

  it("跟随几个根会话：挂在第一个的下面，不在别的根下面重复出现", () => {
    const rows = flattenSessions([make("x", 1), make("y", 2), make("j", 3, ["y", "x"])]);

    expect(ids(rows)).toEqual(["y", "j", "x"]);
    expect(depths(rows)).toEqual([0, 1, 0]);
  });

  it("汇聚的会话自己也有子会话：它们跟着它走，缩进逐级加深", () => {
    const rows = flattenSessions([...diamond(), make("k", 5, ["j"])]);

    expect(ids(rows)).toEqual(["r", "a", "j", "k", "b"]);
    expect(depths(rows)).toEqual([0, 1, 2, 3, 1]);
  });

  it("数据环里夹着汇聚：每个会话恰好出现一次，结果与入参顺序无关", () => {
    // A 跟随 J，J 跟随 A 与 S：J → A → J 成环；S 是正常的根。
    const sessions = [make("s", 1), make("a", 2, ["j"]), make("j", 3, ["a", "s"])];
    const base = flattenSessions(sessions);

    expect([...ids(base)].sort()).toEqual(["a", "j", "s"]);
    expect(ids(base)).toEqual(["s", "j", "a"]);
    for (const input of permutations(sessions)) expect(ids(flattenSessions(input))).toEqual(ids(base));
  });

  it("不改传入的数组", () => {
    const input = diamond();
    const before = input.map((session) => session.id);

    flattenSessions(input);

    expect(input.map((session) => session.id)).toEqual(before);
  });
});
