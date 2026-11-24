import { describe, expect, it } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog } from "@shared/testing";
import type { SessionPhase, SessionSummary } from "@shared/types";
import { blockedBy, descendantsOf, pickArchivable, pickSelected, planSubtree } from "./archivePlan";

function summary(id: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  const log = new EventLog(id);
  log.created({ id, harness: "cursor", runtime: "native" });
  return { ...toSummary(replay(log.events)!), seq: 5, ...patch };
}

/** 创建时刻：数字越大创建得越晚（子树遍历与 changed 的次序由它决定）。 */
const at = (order: number): string => `2026-11-01T00:00:${String(order).padStart(2, "0")}.000Z`;

/** 一个会话：默认已完成、没有待确认的消息；`parent` 与 `phase` 是用例最常调的两项。 */
function node(id: string, order: number, patch: { parent?: string; phase?: SessionPhase; pending?: number } & Partial<SessionSummary> = {}): SessionSummary {
  const { parent, phase = "done", pending = 0, ...rest } = patch;
  return summary(id, {
    phase,
    messages: { total: 1, pending },
    createdAt: at(order),
    ...(parent !== undefined ? { parentSessionId: parent } : {}),
    ...rest,
  });
}

describe("blockedBy：挡着归档的最主要原因", () => {
  const member = (phase: SessionPhase, pending = 0) => ({ phase, messages: { total: 1, pending } });

  it("全部已结束：没有挡着的", () => {
    expect(blockedBy([member("done"), member("failed"), member("cancelled"), member("stopped"), member("lost")])).toBeUndefined();
    expect(blockedBy([])).toBeUndefined();
  });

  it("在工作的（启动中、排队、运行中）优先，数的是这一类会话数", () => {
    expect(blockedBy([member("running"), member("starting"), member("queued"), member("ready"), member("done", 1)])).toEqual({ reason: "working", n: 3 });
  });

  it("没有在工作的，就说待命的（会话还开着，不算已结束）", () => {
    expect(blockedBy([member("ready"), member("ready"), member("done", 2), member("done")])).toEqual({ reason: "idle", n: 2 });
  });

  it("只剩阶段已结束、但还有消息没被确认的：说消息未确认", () => {
    expect(blockedBy([member("done", 1), member("failed", 3), member("done")])).toEqual({ reason: "pending", n: 2 });
  });
});

describe("planSubtree：归档一个会话（连同整棵子树）的预判", () => {
  it("会话不在目录里（已归档或已删除）：没有预判", () => {
    expect(planSubtree([node("a", 1)], "ghost")).toBeUndefined();
  });

  it("单个已结束的会话：可以归档，没有下级", () => {
    expect(planSubtree([node("a", 1)], "a")).toEqual({ total: 1, descendants: 0, blocked: undefined });
  });

  it("下级也算：写明含几个下级；子树里有还在工作的，就给出原因", () => {
    const catalog = [node("r", 1), node("c", 2, { parent: "r" }), node("g", 3, { parent: "c", phase: "running" })];
    expect(planSubtree(catalog, "r")).toEqual({ total: 3, descendants: 2, blocked: { reason: "working", n: 1 } });
    // 下级自己的子树是干净的：它可以单独归档。
    expect(planSubtree([node("r", 1), node("c", 2, { parent: "r" })], "c")).toEqual({ total: 1, descendants: 0, blocked: undefined });
  });

  it("上级不在目录里的会话是根（与服务端同一个口径）", () => {
    const plan = planSubtree([node("c", 2, { parent: "gone" })], "c");
    expect(plan).toEqual({ total: 1, descendants: 0, blocked: undefined });
  });
});

describe("pickArchivable：页头“归档已完成会话”与“归档整个空间”共用的选取", () => {
  it("整棵树都已结束：只选最上层，下级随它一起归档（carried）", () => {
    const range = [node("r", 1), node("c1", 2, { parent: "r" }), node("c2", 3, { parent: "r", phase: "failed" })];
    const pick = pickArchivable(range, range);
    expect(pick.ids).toEqual(["r"]);
    expect(pick.changed).toEqual(["r", "c1", "c2"]);
    expect(pick.carried).toBe(2);
    expect(pick.kept).toBe(0);
    expect(pick.blocked).toBeUndefined();
  });

  it("上级还在工作：整棵树不动上级，但已经干净的下级可以单独归档；留下的原因是上级在工作", () => {
    const range = [node("r", 1, { phase: "running" }), node("c", 2, { parent: "r" })];
    const pick = pickArchivable(range, range);
    expect(pick.ids).toEqual(["c"]);
    expect(pick.changed).toEqual(["c"]);
    expect(pick.kept).toBe(1);
    expect(pick.carried).toBe(0);
    expect(pick.blocked).toEqual({ reason: "working", n: 1 });
  });

  it("什么都不能归档：没有选中的会话，原因给出来（菜单项禁用时写的就是它）", () => {
    const range = [node("w", 1, { phase: "running" })];
    const pick = pickArchivable(range, range);
    expect(pick.ids).toEqual([]);
    expect(pick.changed).toEqual([]);
    expect(pick.kept).toBe(1);
    expect(pick.blocked).toEqual({ reason: "working", n: 1 });
  });

  it("待命（ready）不算已结束：它不能归档，名下已结束的下级照样可以", () => {
    const range = [node("r", 1, { phase: "ready" }), node("c", 2, { parent: "r" })];
    const pick = pickArchivable(range, range);
    expect(pick.ids).toEqual(["c"]);
    expect(pick.blocked).toEqual({ reason: "idle", n: 1 });
  });

  it("阶段已结束但还有消息没被确认的，也不算已结束", () => {
    const range = [node("r", 1, { pending: 1 })];
    const pick = pickArchivable(range, range);
    expect(pick.changed).toEqual([]);
    expect(pick.blocked).toEqual({ reason: "pending", n: 1 });
  });

  it("范围只是目录的一部分：子树要在全部会话里找，下级不在范围里也一并带走", () => {
    const catalog = [node("r", 1), node("c", 2, { parent: "r" }), node("other", 3)];
    const pick = pickArchivable([catalog[0]!], catalog);
    expect(pick.ids).toEqual(["r"]);
    expect(pick.changed).toEqual(["r", "c"]);
    expect(pick.carried).toBe(1);
  });

  it("几棵互不相干的树：已结束的各选各的，还在工作的整棵保留", () => {
    const range = [
      node("r1", 1),
      node("r2", 2),
      node("w", 3, { phase: "running" }),
      node("wc", 4, { parent: "w", phase: "running" }),
    ];
    const pick = pickArchivable(range, range);
    expect(pick.ids).toEqual(["r1", "r2"]);
    expect(pick.kept).toBe(2);
    expect(pick.blocked).toEqual({ reason: "working", n: 2 });
  });

  it("已经带归档标记的会话不再被选", () => {
    const range = [node("a", 1, { archivedAt: "2026-11-20T00:00:00.000Z" })];
    expect(pickArchivable(range, range).ids).toEqual([]);
  });
});

describe("pickSelected：多选里的“归档所选”", () => {
  it("选中一个已结束的上级：它的整棵子树一起走，下级算 carried", () => {
    const catalog = [node("r", 1), node("c", 2, { parent: "r" })];
    const pick = pickSelected([catalog[0]!], catalog);
    expect(pick.ids).toEqual(["r"]);
    expect(pick.changed).toEqual(["r", "c"]);
    expect(pick.carried).toBe(1);
    expect(pick.kept).toBe(0);
  });

  it("上级与下级都被选中：不重复计数，也不把被选中的下级算成 carried", () => {
    const catalog = [node("r", 1), node("c", 2, { parent: "r" })];
    const pick = pickSelected(catalog, catalog);
    expect(pick.changed).toEqual(["r", "c"]);
    expect(pick.carried).toBe(0);
    expect(pick.kept).toBe(0);
  });

  it("选中的会话还在工作：没有可归档的，原因是它在工作", () => {
    const catalog = [node("w", 1, { phase: "running" })];
    const pick = pickSelected(catalog, catalog);
    expect(pick.changed).toEqual([]);
    expect(pick.kept).toBe(1);
    expect(pick.blocked).toEqual({ reason: "working", n: 1 });
  });
});

describe("descendantsOf：名下有几个下级（含已归档的）", () => {
  const entry = (id: string, childIds: string[] = []) => summary(id, { childIds });

  it("没有下级", () => {
    expect(descendantsOf(entry("a"), () => undefined)).toEqual({ count: 0, complete: true });
  });

  it("沿 childIds 一级一级往下数", () => {
    const known = new Map([entry("b", ["c"]), entry("c")].map((item) => [item.id, item]));
    expect(descendantsOf(entry("a", ["b"]), (id) => known.get(id))).toEqual({ count: 2, complete: true });
  });

  it("有的下级找不到摘要（没加载）：只能算一个、没法往下数，并标明数字不完整", () => {
    const known = new Map([entry("b")].map((item) => [item.id, item]));
    expect(descendantsOf(entry("a", ["b", "x"]), (id) => known.get(id))).toEqual({ count: 2, complete: false });
  });

  it("数据里有环也不会死循环", () => {
    const known = new Map([entry("a", ["b"]), entry("b", ["a"])].map((item) => [item.id, item]));
    expect(descendantsOf(entry("a", ["b"]), (id) => known.get(id))).toEqual({ count: 1, complete: true });
  });
});
