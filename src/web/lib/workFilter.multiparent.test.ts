import { describe, expect, it } from "vitest";
import type { SessionPhase, SessionSummary } from "@shared/types";
import { agentNodeId, layoutScene } from "../scene/layout";
import { filterWorking, settle, type Drawn, type Linger } from "./workFilter";

/**
 * 汇聚（一个会话跟随多个上级）与“只看正在工作的会话”：祖先链要沿着每一个上级走，离场也要等它的每一个上级都不再被需要之后。
 * 没有汇聚的行为由 workFilter.test.ts 守着，这里不重复。
 */

/** 只带过滤用得到的字段；上级按先后给出，多于一个时与服务端一样多带 parentSessionIds。 */
function s(id: string, phase: SessionPhase, order: number, parents: readonly string[] = []): SessionSummary {
  return {
    id,
    phase,
    origin: { key: "o1" },
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, order)).toISOString(),
    ...(parents.length > 0 ? { parentSessionId: parents[0] } : {}),
    ...(parents.length > 1 ? { parentSessionIds: [...parents] } : {}),
  } as unknown as SessionSummary;
}

const sorted = (set: ReadonlySet<string>): string[] => [...set].sort();

describe("filterWorking · 汇聚", () => {
  it("汇聚的会话在工作：每一个上级的祖先链都留下（都是上下文），不只是主上级那一条", () => {
    const list = [
      s("g1", "done", 1),
      s("g2", "done", 2),
      s("p1", "done", 3, ["g1"]),
      s("p2", "done", 4, ["g2"]),
      s("j", "running", 5, ["p1", "p2"]),
      s("x", "done", 6),
    ];
    const result = filterWorking(list);

    expect(sorted(result.visible)).toEqual(["g1", "g2", "j", "p1", "p2"]);
    expect(sorted(result.context)).toEqual(["g1", "g2", "p1", "p2"]);
    expect(sorted(result.hidden)).toEqual(["x"]);
  });

  it("菱形：共同的祖先只算一次，上下文里没有重复也没有遗漏", () => {
    const list = [s("r", "done", 1), s("a", "done", 2, ["r"]), s("b", "done", 3, ["r"]), s("j", "running", 4, ["a", "b"])];
    const result = filterWorking(list);

    expect(sorted(result.visible)).toEqual(["a", "b", "j", "r"]);
    expect(sorted(result.context)).toEqual(["a", "b", "r"]);
    expect(result.hidden.size).toBe(0);
  });

  it("汇聚的会话已经结束：它的上级不会因为它而被拉进来，只有自己在工作的才留下", () => {
    const list = [s("p1", "running", 1), s("p2", "done", 2), s("j", "done", 3, ["p1", "p2"])];
    const result = filterWorking(list);

    expect(sorted(result.visible)).toEqual(["p1"]);
    expect(result.context.size).toBe(0);
    expect(sorted(result.hidden)).toEqual(["j", "p2"]);
  });

  it("一个上级在工作、汇聚的会话在运行：在工作的上级自己不算上下文，已结束的那个才算", () => {
    const result = filterWorking([s("p1", "running", 1), s("p2", "done", 2), s("j", "running", 3, ["p1", "p2"])]);

    expect(sorted(result.visible)).toEqual(["j", "p1", "p2"]);
    expect(sorted(result.context)).toEqual(["p2"]);
  });

  it("有的上级已经不在列表里（已删除）：链在那里截止，其余上级照常留下", () => {
    const result = filterWorking([s("p2", "done", 1), s("j", "running", 2, ["gone", "p2"])]);

    expect(sorted(result.visible)).toEqual(["j", "p2"]);
    expect(sorted(result.context)).toEqual(["p2"]);
  });

  it("数据里的环穿过汇聚的会话也不会死循环，环上其余会话作为上下文留下", () => {
    // a 跟随 j，j 跟随 a 与 s：j → a → j 成环；a 在工作。
    const result = filterWorking([s("s", "done", 1), s("a", "running", 2, ["j"]), s("j", "done", 3, ["a", "s"])]);

    expect(sorted(result.visible)).toEqual(["a", "j", "s"]);
    expect(sorted(result.context)).toEqual(["j", "s"]);
  });

  it("留下的集合对祖先封闭：布局据此排出来，汇聚的会话每个上级到它的线都在", () => {
    const list = [
      s("g1", "done", 1),
      s("g2", "done", 2),
      s("p1", "done", 3, ["g1"]),
      s("p2", "done", 4, ["g2"]),
      s("j", "running", 5, ["p1", "p2"]),
      s("x", "done", 6),
    ];
    const { visible } = filterWorking(list);
    const layout = layoutScene(list, { visible });

    expect(layout.nodes.some((node) => node.id === agentNodeId("x"))).toBe(false);
    expect(layout.edges.filter((edge) => edge.to === agentNodeId("j")).map((edge) => edge.from)).toEqual([agentNodeId("p1"), agentNodeId("p2")]);
    for (const id of ["p1", "p2", "g1", "g2"]) expect(layout.edges.filter((edge) => edge.to === agentNodeId(id)), id).toHaveLength(1);
  });
});

describe("settle · 汇聚的会话离场", () => {
  const NOW = 10_000;
  const EXIT = 240;
  const idle = (): boolean => false;
  const working = [s("p1", "running", 1), s("p2", "running", 2), s("j", "running", 3, ["p1", "p2"])];
  const finished = [s("p1", "done", 1), s("p2", "done", 2), s("j", "done", 3, ["p1", "p2"])];
  const rule = (sessions: readonly SessionSummary[]) => filterWorking(sessions).visible;
  const first = (sessions: readonly SessionSummary[]): Drawn => {
    const settled = settle({ sessions, rule: rule(sessions), prev: undefined, operated: idle, now: NOW, exitMs: EXIT });
    return { drawn: settled.drawn, linger: settled.linger };
  };

  it("汇聚的会话被操作着：它的每一个上级都留着（不只是主上级），免得它看起来少了几个上级；松手后一起淡出", () => {
    const prev = first(working);
    const operated = (id: string): boolean => id === "j";
    const held = settle({ sessions: finished, rule: rule(finished), prev, operated, now: NOW, exitMs: EXIT });

    expect(sorted(held.held)).toEqual(["j", "p1", "p2"]);
    expect(held.leaving.size).toBe(0);

    const fading = settle({ sessions: finished, rule: rule(finished), prev: held, operated: idle, now: NOW + 500, exitMs: EXIT });
    expect(sorted(fading.leaving)).toEqual(["j", "p1", "p2"]);
    for (const id of ["j", "p1", "p2"]) expect(fading.linger.get(id), id).toBe(NOW + 500);
  });

  it("没人操作：三个一起淡出，到时间一起离开", () => {
    const prev = first(working);
    const fading = settle({ sessions: finished, rule: rule(finished), prev, operated: idle, now: NOW, exitMs: EXIT });

    expect(sorted(fading.leaving)).toEqual(["j", "p1", "p2"]);
    const gone = settle({ sessions: finished, rule: rule(finished), prev: fading, operated: idle, now: NOW + EXIT, exitMs: EXIT });
    expect((gone.drawn as Set<string>).size).toBe(0);
    expect(gone.linger.size).toBe(0);
  });

  it("某个上级被操作着、汇聚的会话没人碰：会话照常淡出离开，被操作的上级留着，另一个上级跟着淡出", () => {
    const prev = first(working);
    const operated = (id: string): boolean => id === "p2";
    const held = settle({ sessions: finished, rule: rule(finished), prev, operated, now: NOW, exitMs: EXIT });

    expect(sorted(held.held)).toEqual(["p2"]);
    expect(sorted(held.leaving)).toEqual(["j", "p1"]);

    const later = settle({ sessions: finished, rule: rule(finished), prev: held, operated, now: NOW + EXIT, exitMs: EXIT });
    expect(sorted(later.drawn as Set<string>)).toEqual(["p2"]);
  });

  it("上级比汇聚的会话更早开始淡出时，每一个上级都要等它离开之后才离开", () => {
    const linger = new Map<string, Linger>([
      ["p1", NOW],
      ["p2", NOW],
      ["j", NOW + 100],
    ]);
    const prev: Drawn = { drawn: new Set(["p1", "p2", "j"]), linger };

    const mid = settle({ sessions: finished, rule: rule(finished), prev, operated: idle, now: NOW + 250, exitMs: EXIT });
    expect(sorted(mid.drawn as Set<string>)).toEqual(["j", "p1", "p2"]);

    const end = settle({ sessions: finished, rule: rule(finished), prev: { drawn: mid.drawn, linger: mid.linger }, operated: idle, now: NOW + 340, exitMs: EXIT });
    expect((end.drawn as Set<string>).size).toBe(0);
  });
});
