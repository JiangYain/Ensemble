import { describe, expect, it } from "vitest";
import { parentFields } from "@shared/lineage";
import { replay, toSummary } from "@shared/projection";
import { EventLog } from "@shared/testing";
import type { SessionPhase, SessionSummary } from "@shared/types";
import { descendantsOf, pickArchivable, pickSelected, planSubtree } from "./archivePlan";

/**
 * 汇聚（一个会话跟随多个上级）下，网页在点“归档”之前的预判。没有汇聚的会话的预判由 archivePlan.test.ts 守着，这里不重复。
 * 预判读的规则与服务端同一份（shared/archive）：汇聚的会话只有在它所有的上级都走时才随上级走；
 * 还跟随着别的未归档上级的，留在原处，也不挡着上级归档。
 *
 * 常用的一张图（菱形）：R 是根，A 与 B 都跟随 R，J 同时跟随 A 与 B。
 */

function summary(id: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  const log = new EventLog(id);
  log.created({ id, harness: "cursor", runtime: "native" });
  return { ...toSummary(replay(log.events)!), seq: 5, ...patch };
}

/** 创建时刻：数字越大创建得越晚。 */
const at = (order: number): string => `2026-11-01T00:00:${String(order).padStart(2, "0")}.000Z`;

/** 一个会话：默认已完成、没有待确认的消息；`parents` 是有序的上级（第一个是主上级）。 */
function node(id: string, order: number, patch: { parents?: string[]; phase?: SessionPhase } & Partial<SessionSummary> = {}): SessionSummary {
  const { parents = [], phase = "done", ...rest } = patch;
  return summary(id, { phase, messages: { total: 1, pending: 0 }, createdAt: at(order), ...parentFields(parents), ...rest });
}

const diamond = (phases: Partial<Record<"R" | "A" | "B" | "J", SessionPhase>> = {}): SessionSummary[] => [
  node("R", 1, { phase: phases.R ?? "done" }),
  node("A", 2, { parents: ["R"], phase: phases.A ?? "done" }),
  node("B", 3, { parents: ["R"], phase: phases.B ?? "done" }),
  node("J", 4, { parents: ["A", "B"], phase: phases.J ?? "done" }),
];

const sorted = (ids: readonly string[]): string[] => [...ids].sort();

describe("planSubtree：汇聚的会话只算真正会一起走的", () => {
  it("点根：整张图都走，下级个数里汇聚的会话只算一次", () => {
    expect(planSubtree(diamond(), "R")).toEqual({ total: 4, descendants: 3, blocked: undefined });
  });

  it("点其中一个上级：汇聚的会话还跟随着另一个没归档的上级，留在原处，不算下级个数", () => {
    expect(planSubtree(diamond(), "A")).toEqual({ total: 1, descendants: 0, blocked: undefined });
  });

  it("留在原处的汇聚的会话还在工作，不挡着上级归档；它会跟着走（点根）时才挡着", () => {
    const catalog = diamond({ J: "running" });

    expect(planSubtree(catalog, "A")).toEqual({ total: 1, descendants: 0, blocked: undefined });
    expect(planSubtree(catalog, "R")).toEqual({ total: 4, descendants: 3, blocked: { reason: "working", n: 1 } });
    expect(planSubtree(catalog, "J")).toEqual({ total: 1, descendants: 0, blocked: { reason: "working", n: 1 } });
  });

  it("另一个上级已经归档（不在未归档的目录里）：汇聚的会话随这一个上级走", () => {
    const catalog = [node("R", 1), node("A", 2, { parents: ["R"] }), node("J", 4, { parents: ["A", "B"] })];

    expect(planSubtree(catalog, "A")).toEqual({ total: 2, descendants: 1, blocked: undefined });
  });
});

describe("pickArchivable：汇聚的会话", () => {
  it("整张图都已结束：只选根，汇聚的会话随上级一起走", () => {
    const range = diamond();
    const pick = pickArchivable(range, range);

    expect(pick.ids).toEqual(["R"]);
    expect(sorted(pick.changed)).toEqual(["A", "B", "J", "R"]);
    expect(pick.carried).toBe(3);
    expect(pick.kept).toBe(0);
    expect(pick.blocked).toBeUndefined();
  });

  it("汇聚的会话还在工作：它会随上级一起走，所以上级都不能归档，留下的原因是它在工作", () => {
    const range = diamond({ J: "running" });
    const pick = pickArchivable(range, range);

    expect(pick.changed).toEqual([]);
    expect(pick.kept).toBe(4);
    expect(pick.carried).toBe(0);
    expect(pick.blocked).toEqual({ reason: "working", n: 1 });
  });

  it("一个上级还在工作：已结束的那个上级与汇聚的会话各自被点名（汇聚的会话不会随它走），在工作的整张图保留", () => {
    const range = diamond({ B: "running" });
    const pick = pickArchivable(range, range);

    expect(pick.ids).toEqual(["A", "J"]);
    expect(pick.changed).toEqual(["A", "J"]);
    expect(pick.carried).toBe(0);
    expect(pick.kept).toBe(2);
    expect(pick.blocked).toEqual({ reason: "working", n: 1 });
  });

  it("范围里只有汇聚的会话的一部分上级：它要自己被点名", () => {
    const catalog = diamond();
    const pick = pickArchivable([catalog[1]!, catalog[3]!], catalog);

    expect(pick.ids).toEqual(["A", "J"]);
    expect(pick.changed).toEqual(["A", "J"]);
    expect(pick.kept).toBe(0);
  });

  it("范围里有汇聚的会话的全部上级（根不在范围里）：只点名上级，汇聚的会话随它们一起走", () => {
    const catalog = diamond();
    const pick = pickArchivable([catalog[1]!, catalog[2]!, catalog[3]!], catalog);

    expect(pick.ids).toEqual(["A", "B"]);
    expect(sorted(pick.changed)).toEqual(["A", "B", "J"]);
    expect(pick.carried).toBe(1);
    expect(pick.kept).toBe(0);
  });
});

describe("pickSelected：汇聚的会话", () => {
  it("只选一个上级：只归档它，汇聚的会话留在原处（回执的 kept 会如实说）", () => {
    const catalog = diamond();
    const pick = pickSelected([catalog[1]!], catalog);

    expect(pick).toEqual({ ids: ["A"], changed: ["A"], kept: 0, carried: 0, blocked: undefined });
  });

  it("把汇聚的会话的所有上级一起选上：它随它们一起走，算作“随上级一起归档”的那一个", () => {
    const catalog = diamond();
    const pick = pickSelected([catalog[1]!, catalog[2]!], catalog);

    expect(pick.ids).toEqual(["A", "B"]);
    expect(sorted(pick.changed)).toEqual(["A", "B", "J"]);
    expect(pick.carried).toBe(1);
    expect(pick.kept).toBe(0);
    expect(pick.blocked).toBeUndefined();
  });

  it("上级都选上、而汇聚的会话还在工作：谁也不归档，原因是它在工作", () => {
    const catalog = diamond({ J: "running" });
    const pick = pickSelected([catalog[1]!, catalog[2]!], catalog);

    expect(pick.changed).toEqual([]);
    expect(pick.kept).toBe(2);
    expect(pick.blocked).toEqual({ reason: "working", n: 1 });
  });

  it("选的就是汇聚的会话：它自己总会归档，不看它的上级", () => {
    const catalog = diamond();
    const pick = pickSelected([catalog[3]!], catalog);

    expect(pick).toEqual({ ids: ["J"], changed: ["J"], kept: 0, carried: 0, blocked: undefined });
  });
});

describe("descendantsOf：汇聚的会话只数一次", () => {
  it("一个会话经由两个上级都够得到，下级个数里只有一份", () => {
    const known = new Map([
      ["A", summary("A", { childIds: ["J"] })],
      ["B", summary("B", { childIds: ["J"] })],
      ["J", summary("J", { childIds: [] })],
    ]);

    expect(descendantsOf({ id: "R", childIds: ["A", "B"] }, (id) => known.get(id))).toEqual({ count: 3, complete: true });
  });

  it("数据里出现环也会停（不把自己数进去）", () => {
    const known = new Map([["Y", summary("Y", { childIds: ["X"] })]]);

    expect(descendantsOf({ id: "X", childIds: ["Y"] }, (id) => known.get(id))).toEqual({ count: 1, complete: true });
  });
});
