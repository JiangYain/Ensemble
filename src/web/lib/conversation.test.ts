import { describe, expect, it } from "vitest";
import type { ReasoningItem, ToolCategory, ToolItem, ToolStatus } from "@shared/types";
import { isNearBottom, limitState, mixLabels, restoreDraft, turnLeads, workStats, type RowKind } from "./conversation";

const T0 = Date.parse("2026-11-15T10:00:00.000Z");
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

function tool(id: string, category: ToolCategory, status: ToolStatus, at = 0, updated = at): ToolItem {
  return { type: "tool", id, callId: id, name: category, category, title: id, status, startedAt: iso(at), at: iso(at), updatedAt: iso(updated) };
}

function thought(id: string, streaming: boolean, at = 0, updated = at): ReasoningItem {
  return { type: "reasoning", id, text: "先想一想", streaming, at: iso(at), updatedAt: iso(updated) };
}

describe("工作组汇总", () => {
  it("只数工具调用，推理不算步骤；失败数单独统计", () => {
    const stats = workStats([thought("r1", false), tool("t1", "read", "completed"), tool("t2", "shell", "failed"), tool("t3", "read", "completed")]);
    expect(stats.tools).toBe(3);
    expect(stats.failed).toBe(1);
    expect(stats.running).toBe(false);
  });

  it("类别按次数从多到少，次数相同按先出现的在前", () => {
    const stats = workStats([tool("a", "shell", "completed"), tool("b", "read", "completed"), tool("c", "read", "completed"), tool("d", "web", "completed"), tool("e", "search", "completed")]);
    expect(stats.mix).toEqual([
      ["read", 2],
      ["shell", 1],
      ["web", 1],
      ["search", 1],
    ]);
  });

  it("有步骤在进行，或推理还在流式输出，就算进行中", () => {
    expect(workStats([tool("t1", "read", "running")]).running).toBe(true);
    expect(workStats([thought("r1", true)]).running).toBe(true);
    expect(workStats([thought("r1", false), tool("t1", "read", "completed")]).running).toBe(false);
  });

  it("耗时是首个条目开始到最后一个条目最近一次更新；没有工具调用时不给", () => {
    expect(workStats([tool("t1", "read", "completed", 0, 1500), tool("t2", "read", "completed", 2000, 5000)]).durationMs).toBe(5000);
    expect(workStats([thought("r1", false, 0, 900)]).durationMs).toBeUndefined();
    expect(workStats([]).durationMs).toBeUndefined();
  });

  it("时间戳解析不出来时不编造耗时", () => {
    const broken = { ...tool("t1", "read", "completed"), updatedAt: "not a time" };
    expect(workStats([broken]).durationMs).toBeUndefined();
  });
});

describe("发言的起点", () => {
  const leads = (...kinds: RowKind[]): boolean[] => turnLeads(kinds);

  it("派发方消息之后执行端的第一条内容是起点，同一段里后面的不再署名", () => {
    expect(leads("message", "run", "work", "assistant", "work", "assistant")).toEqual([false, false, true, false, false, false]);
  });

  it("每条派发方消息都开启新的一段", () => {
    expect(leads("message", "work", "assistant", "message", "work", "message", "assistant")).toEqual([false, true, false, false, true, false, true]);
  });

  it("运行分隔线与诊断夹在中间不打断，也不算执行端的发言", () => {
    expect(leads("message", "assistant", "run", "diagnostic", "assistant")).toEqual([false, true, false, false, false]);
    expect(leads("message", "diagnostic", "run", "plan")).toEqual([false, false, false, true]);
  });

  it("没有派发方消息打头（更早的行被收起）时，第一条执行端内容照样署名", () => {
    expect(leads("work", "assistant")).toEqual([true, false]);
    expect(leads("plan")).toEqual([true]);
  });

  it("提问是执行端开口说的话：同一段里跟在工作组后面不再署名；它自己打头时由它署名", () => {
    expect(leads("message", "run", "work", "question", "work")).toEqual([false, false, true, false, false]);
    expect(leads("message", "run", "question")).toEqual([false, false, true]);
    expect(leads("message", "question", "message", "question")).toEqual([false, true, false, true]);
  });
});

describe("按动词合并类别", () => {
  const verbs: Record<string, string> = { read: "读取", write: "写入", edit: "写入", shell: "运行" };

  it("共用同一个动词的类别合并计数", () => {
    expect(
      mixLabels(
        [
          ["write", 3],
          ["edit", 2],
          ["shell", 2],
        ],
        (category) => verbs[category] ?? category,
      ),
    ).toEqual([
      ["写入", 5],
      ["运行", 2],
    ]);
  });

  it("合并后重新按次数排序，次数相同保持先出现的在前", () => {
    expect(
      mixLabels(
        [
          ["read", 2],
          ["write", 1],
          ["shell", 2],
          ["edit", 2],
        ],
        (category) => verbs[category] ?? category,
      ),
    ).toEqual([
      ["写入", 3],
      ["读取", 2],
      ["运行", 2],
    ]);
  });

  it("没有步骤时是空的", () => {
    expect(mixLabels([], (category: string) => category)).toEqual([]);
  });
});

describe("贴底判断", () => {
  it("离底部不到阈值算在底部", () => {
    // 距离底部 47px：不到 48px。
    expect(isNearBottom({ scrollTop: 953, clientHeight: 500, scrollHeight: 1500 }, 48)).toBe(true);
    expect(isNearBottom({ scrollTop: 1000, clientHeight: 500, scrollHeight: 1500 }, 48)).toBe(true);
  });

  it("刚好等于阈值已经不算（用户确实离开了底部）", () => {
    // 距离底部恰好 48px，以及 49px、很远。
    expect(isNearBottom({ scrollTop: 952, clientHeight: 500, scrollHeight: 1500 }, 48)).toBe(false);
    expect(isNearBottom({ scrollTop: 951, clientHeight: 500, scrollHeight: 1500 }, 48)).toBe(false);
    expect(isNearBottom({ scrollTop: 0, clientHeight: 500, scrollHeight: 1500 }, 48)).toBe(false);
  });

  it("内容比视口矮时永远在底部", () => {
    expect(isNearBottom({ scrollTop: 0, clientHeight: 500, scrollHeight: 320 }, 48)).toBe(true);
  });
});

describe("输入长度", () => {
  it("超过上限才算超限，刚好等于上限仍可发送", () => {
    expect(limitState(50_000, 50_000).over).toBe(false);
    expect(limitState(50_001, 50_000).over).toBe(true);
  });

  it("达到 90% 开始提示字数", () => {
    expect(limitState(44_999, 50_000).near).toBe(false);
    expect(limitState(45_000, 50_000).near).toBe(true);
    expect(limitState(0, 50_000).near).toBe(false);
  });
});

describe("发送失败后放回原文", () => {
  it("输入框还是空的：原样放回", () => {
    expect(restoreDraft("", "原文")).toBe("原文");
    expect(restoreDraft("  \n", "原文")).toBe("原文");
  });

  it("用户已经写了新的内容：两段都留下，失败的在前", () => {
    expect(restoreDraft("新的", "原文")).toBe("原文\n\n新的");
  });

  it("新内容里已经包含原文（用户自己贴回去了）：不重复", () => {
    expect(restoreDraft("原文，再补一句", "原文")).toBe("原文，再补一句");
  });
});
