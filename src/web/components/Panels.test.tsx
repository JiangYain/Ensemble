import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog, USER, testOrigin } from "@shared/testing";
import type { AttentionItem } from "@shared/types";
import { setLang } from "../lib/app";
import { onReveal } from "../lib/reveal";
import { InfoPanel, SummaryPanel, TaskPanel } from "./Panels";

it("renders the exact sent prompt as readable text with one copy action", () => {
  const prompt = `请只读走查当前项目。${"很长的路径和上下文".repeat(30)}\n\n  保留缩进与原始内容。`;
  const log = new EventLog("ses_prompt");
  log.created({ task: { text: "请只读走查", context: [], prompt } });
  const state = replay(log.events);
  if (!state) throw new Error("missing session state");

  setLang("zh");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(<TaskPanel state={state} summary={toSummary(state)} />));
    const toggle = [...host.querySelectorAll<HTMLButtonElement>(".section-toggle")]
      .find((button) => button.textContent?.includes("实际发给执行端的提示"));
    expect(toggle).toBeDefined();
    act(() => toggle!.click());
    const section = toggle!.closest("section")!;
    expect(section.querySelector(".task-text")?.textContent).toBe(prompt);
    expect(section.querySelector("pre")).toBeNull();
    expect(section.querySelectorAll('button[aria-label="复制完整提示"]')).toHaveLength(1);
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("keeps simulated sessions identifiable without showing native implementation badges", () => {
  const nativeLog = new EventLog("ses_native");
  nativeLog.created({ harness: "cursor", runtime: "native" });
  const fixtureLog = new EventLog("ses_fixture");
  fixtureLog.created({ harness: "cursor", runtime: "fixture" });
  const native = replay(nativeLog.events);
  const fixture = replay(fixtureLog.events);
  if (!native || !fixture) throw new Error("missing session state");
  setLang("zh");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(<InfoPanel state={native} summary={toSummary(native)} />));
    expect(host.textContent).not.toContain("原生接入");
    act(() => root.render(<InfoPanel state={fixture} summary={toSummary(fixture)} />));
    expect(host.textContent).toContain("模拟执行");
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("keeps each message record to one line and scrolls the timeline to the message on click instead of expanding", () => {
  const log = new EventLog("ses_messages");
  log.created();
  log.message("msg_task", "task", "请只读走查当前项目，并列出所有未实现的功能。");
  const steer = log.message("msg_steer", "steer", "不要改任何文件，只汇报发现。", USER);
  log.push({ kind: "message.delivery", data: { messageId: steer.id, record: { stage: "failed", at: log.now(), error: { code: "executor_exited", message: "执行端已退出" } } } });
  const state = replay(log.events);
  if (!state) throw new Error("missing session state");

  setLang("zh");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(<SummaryPanel state={state} summary={toSummary(state)} />));
    const section = [...host.querySelectorAll("section")].find((el) => el.querySelector(".msg-log"))!;
    const rows = [...section.querySelectorAll<HTMLElement>(".msg-log > li")];
    expect(rows).toHaveLength(2);

    // 只有一行摘要：看不到正文，也看不到投递状态的文字；不是展开收起的按钮。
    for (const row of rows) {
      expect(row.querySelector(".msg-log-body")).toBeNull();
      expect(row.querySelector("button")!.hasAttribute("aria-expanded")).toBe(false);
    }
    expect(section.textContent).not.toContain("不要改任何文件");
    expect(section.textContent).not.toContain("请只读走查当前项目");

    // 投递失败的状态不用定位过去也能从小方块读到。
    expect(rows[1]!.querySelector(".stage-dot")?.getAttribute("data-stage")).toBe("failed");
    expect(rows[1]!.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("投递失败");

    // 点击只发出“定位到这条消息”的请求，行本身不变。
    const requested: string[] = [];
    const off = onReveal((id) => requested.push(id));
    const before = section.innerHTML;
    act(() => rows[1]!.querySelector<HTMLButtonElement>(".msg-log-head")!.click());
    off();
    expect(requested).toEqual(["msg_steer"]);
    expect(section.innerHTML).toBe(before);
    expect(rows[1]!.querySelector(".msg-log-head")!.getAttribute("data-tip")).toBe("在时间线中定位");
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

function renderSummary(usage: Record<string, number>, body: (host: HTMLElement) => void): void {
  const log = new EventLog("ses_usage");
  log.created();
  log.push({ kind: "usage.updated", data: { usage } }, { runId: "run_1" });
  const state = replay(log.events);
  if (!state) throw new Error("missing session state");
  setLang("zh");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(<SummaryPanel state={state} summary={toSummary(state)} />));
    body(host);
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
}

it("draws usage as a ring whose legend carries the exact split, leaving only cost and context in the list", () => {
  renderSummary(
    { inputTokens: 6_300_000, cachedTokens: 6_200_000, outputTokens: 218_000, reasoningTokens: 201_000, costUsd: 0.5, contextTokens: 50_000, contextWindow: 200_000 },
    (host) => {
      const usage = host.querySelector(".usage")!;
      expect(usage).not.toBeNull();
      expect(usage.querySelector(".usage-total-value")?.textContent).toBe("6.5M");
      expect([...usage.querySelectorAll(".usage-row")].map((row) => row.textContent)).toEqual(["缓存命中6.2M", "新输入100k", "推理201k", "其余输出17k"]);
      // 环上每一段都和图例一一对应，悬停提示带完整数字与占比。
      expect([...usage.querySelectorAll(".usage-seg")].map((seg) => seg.getAttribute("data-seg"))).toEqual(["cached", "input", "reasoning", "output"]);
      expect(usage.querySelector('.usage-seg[data-seg="reasoning"]')?.getAttribute("data-tip")).toMatch(/^推理\n201,000 tokens · 3\.1%$/);
      // 构成已经画在环里，列表里不再重复，只剩费用和上下文占用。
      const list = host.querySelector(".usage + .kvs")!;
      expect([...list.querySelectorAll("dt")].map((dt) => dt.textContent)).toEqual(["费用", "上下文占用"]);
    },
  );
});

it("highlights the matching ring segment while a legend row is hovered", () => {
  renderSummary({ inputTokens: 1000, cachedTokens: 600, outputTokens: 100 }, (host) => {
    const usage = host.querySelector<HTMLElement>(".usage")!;
    const dimmed = (): Array<string | null> => [...usage.querySelectorAll(".usage-seg[data-dim]")].map((seg) => seg.getAttribute("data-seg"));
    expect(dimmed()).toEqual([]);
    const row = usage.querySelectorAll<HTMLElement>(".usage-row")[1]!;
    act(() => {
      row.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    });
    expect(usage.getAttribute("data-hot")).toBe("input");
    expect(dimmed()).toEqual(["cached", "output"]);
    expect(row.hasAttribute("data-active")).toBe(true);
    act(() => {
      row.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));
    });
    expect(dimmed()).toEqual([]);
  });
});

it("falls back to the plain list instead of drawing a misleading ring when the numbers don't fit the field meanings", () => {
  renderSummary({ inputTokens: 100, cachedTokens: 150, outputTokens: 10 }, (host) => {
    expect(host.querySelector(".usage")).toBeNull();
    const labels = [...host.querySelectorAll(".kvs--tight dt")].map((dt) => dt.textContent);
    expect(labels).toEqual(["输入", "缓存命中", "输出"]);
  });
});

it("opens the summary panel with its first section, with no stats strip above it", () => {
  renderSummary({ inputTokens: 1000 }, (host) => {
    const stack = host.querySelector(".panel-stack")!;
    expect(host.querySelector(".stats, .stat, .stat-value, .stat-label")).toBeNull();
    // 面板的第一块就是“进度”分区：上面没有任何孤立的统计行或多余的分隔。
    const first = stack.firstElementChild!;
    expect(first.tagName).toBe("SECTION");
    expect(first.querySelector(".section-title")?.textContent).toBe("进度");
    expect([...stack.children].every((child) => child.tagName === "SECTION")).toBe(true);
  });
});

it("lists what is worth a look at the top of the summary, as plain facts, and leaves the panel unchanged when there is nothing", () => {
  const log = new EventLog("ses_attention");
  log.created();
  const state = replay(log.events);
  if (!state) throw new Error("missing session state");
  setLang("zh");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    const base = toSummary(state);
    act(() => root.render(<SummaryPanel state={state} summary={base} />));
    expect(host.querySelector(".attn-list")).toBeNull();

    const since = new Date(Date.now() - 5 * 60_000).toISOString();
    const attention: AttentionItem[] = [
      { kind: "quiet", since, seq: 4 },
      { kind: "shared_file", since, path: "C:/work/demo/src/engine.ts", withSessionIds: ["ses_other"] },
    ];
    act(() => root.render(<SummaryPanel state={state} summary={{ ...base, attention }} />));
    const section = host.querySelector("section")!;
    expect(section.querySelector(".attn-list")).not.toBeNull();
    expect(section.textContent).toContain("值得留意");
    const rows = [...section.querySelectorAll(".attn-list > li")].map((row) => row.textContent);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^已 5m 0\ds 没有收到任何事件，也没有进行中的工具调用$/);
    expect(rows[1]).toContain("engine.ts 也被另 1 个运行中的会话写过");
    // 只陈述事实：没有“卡住”“失败”这类判断。
    expect(section.textContent).not.toMatch(/卡住|失败|错误/);
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("lists a question that is waiting for an answer as one plain line: what was asked and for how long, with no verdict", () => {
  const log = new EventLog("ses_attention_question");
  log.created();
  const state = replay(log.events);
  if (!state) throw new Error("missing session state");
  setLang("zh");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    const base = toSummary(state);
    const since = new Date(Date.now() - 3 * 60_000).toISOString();
    const attention: AttentionItem[] = [
      { kind: "question", since, questionId: "qst_1", prompts: [{ key: "db", text: "Which database should the service use?", multiple: false, custom: true }] },
      { kind: "quiet", since, seq: 4 },
    ];
    act(() => root.render(<SummaryPanel state={state} summary={{ ...base, attention }} />));
    const rows = [...host.querySelectorAll(".attn-list > li")].map((row) => row.textContent ?? "");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^提问待回答：“Which database should the service use\?”（已等待 3m 0\ds）$/);
    expect(rows[0]).not.toMatch(/卡住|失败|错误/);
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it("file changes show only the line counts the executor really reported: no red “−0”, no “+0”, and an unreported side is never written as 0", () => {
  const log = new EventLog("ses_files");
  log.created();
  const message = log.message("msg_1", "task", "改几个文件");
  log.run("run_1", 1, message.id);
  log.startRun("run_1");
  const touch = (callId: string, files: Array<{ path: string; change: "created" | "modified" | "deleted"; addedLines?: number; removedLines?: number }>): void => {
    log.tool("run_1", callId, "completed", { category: "edit", title: callId });
    log.push({ kind: "file.changed", data: { callId, files } }, { runId: "run_1" });
  };
  touch("c1", [{ path: "src/only-added.ts", change: "modified", addedLines: 12, removedLines: 0 }]);
  touch("c2", [{ path: "src/only-removed.ts", change: "deleted", removedLines: 41 }]);
  touch("c3", [{ path: "src/both.ts", change: "modified", addedLines: 5, removedLines: 3 }]);
  touch("c4", [{ path: "src/unreported.ts", change: "modified" }]);
  touch("c5", [{ path: "src/zero.ts", change: "modified", addedLines: 0, removedLines: 0 }]);
  // 同一个文件多次修改：行数累加；只上报了一侧的，另一侧始终是“未知”。
  touch("c6", [{ path: "src/twice.ts", change: "created", addedLines: 10 }]);
  touch("c7", [{ path: "src/twice.ts", change: "modified", addedLines: 4, removedLines: 2 }]);
  touch("c8", [{ path: "src/twice-unreported.ts", change: "modified" }]);
  touch("c9", [{ path: "src/twice-unreported.ts", change: "modified" }]);
  const state = replay(log.events);
  if (!state) throw new Error("missing session state");
  setLang("zh");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(<SummaryPanel state={state} summary={toSummary(state)} />));
    const rows = [...host.querySelectorAll(".files > li")].map((row) => ({
      path: row.querySelector(".file-path")?.textContent,
      stat: [...row.querySelectorAll(".file-stat i")].map((mark) => `${mark.getAttribute("data-sign")}:${mark.textContent}`),
      hasStat: row.querySelector(".file-stat") !== null,
    }));
    expect(rows).toEqual([
      { path: "src/only-added.ts", stat: ["add:+12"], hasStat: true },
      { path: "src/only-removed.ts", stat: ["del:−41"], hasStat: true },
      { path: "src/both.ts", stat: ["add:+5", "del:−3"], hasStat: true },
      { path: "src/unreported.ts", stat: [], hasStat: false },
      { path: "src/zero.ts", stat: [], hasStat: false },
      { path: "src/twice.ts", stat: ["add:+14", "del:−2"], hasStat: true },
      { path: "src/twice-unreported.ts", stat: [], hasStat: false },
    ]);
    expect(host.querySelector(".files")?.textContent).not.toMatch(/[+−]0(?!\d)/);
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

describe("TaskPanel 的来源卡", () => {
  const ID = "4706e0d9-12d7-4b10-a784-5d3416b186a9";
  const DIR = "C:\\Users\\alice\\Desktop\\Ensemble";

  /** 渲染一个带指定来源的委派的任务面板，返回来源卡。 */
  function originCard(origin: Parameters<typeof testOrigin>[0], run: (card: HTMLElement) => void): void {
    const log = new EventLog("ses_origin_card");
    log.created({ origin: testOrigin(origin) });
    const state = replay(log.events);
    if (!state) throw new Error("missing session state");
    setLang("zh");
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() => root.render(<TaskPanel state={state} summary={toSummary(state)} />));
      run(host.querySelector<HTMLElement>(".origin-card")!);
    } finally {
      act(() => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  }

  it("会话标识是 Agent 自报的：和标识写在同一行，并说明 Ensemble 无法核对；宿主交出的标识没有这一句", () => {
    originCard({ key: `cursor:${ID}`, host: "cursor", hostLabel: "Cursor", sessionRef: { id: ID, kind: "conversation", source: "declared" } }, (card) => {
      const sub = card.querySelector(".origin-card-sub")!;
      expect(sub.textContent).toContain("对话");
      expect(sub.querySelector(".mono")?.getAttribute("data-tip")).toBe(ID);
      const tag = [...sub.querySelectorAll("span")].find((span) => span.textContent === "由 Agent 自报");
      expect(tag).toBeDefined();
      expect(tag!.getAttribute("data-tip")).toContain("Ensemble 无法核对");
    });
    originCard({ sessionRef: { id: ID, kind: "conversation", source: "env" } }, (card) => {
      expect(card.querySelector(".origin-card-sub")?.textContent).not.toContain("自报");
    });
  });

  it("工作区带着来历：宿主的对话记录、宿主报告的与委派时传入的 cwd 在提示里各自注明", () => {
    originCard({ workspace: DIR, workspaceSource: "host-record" }, (card) => {
      expect(card.querySelector(".origin-card-ws")?.getAttribute("data-tip")).toBe(`工作区: ${DIR}（宿主的对话记录）`);
    });
    originCard({ workspace: DIR, workspaceSource: "delegate-cwd" }, (card) => {
      expect(card.querySelector(".origin-card-ws")?.getAttribute("data-tip")).toBe(`工作区: ${DIR}（委派时传入的 cwd）`);
    });
    originCard({ workspace: DIR, workspaceSource: "mcp-roots" }, (card) => {
      expect(card.querySelector(".origin-card-ws")?.getAttribute("data-tip")).toBe(`工作区: ${DIR}（宿主报告）`);
    });
  });

  it("Agent 发起的来源没有工作区：写“工作区: 未知”，不拿别的目录顶替；控制台来源本来没有，不写这一行", () => {
    originCard({}, (card) => {
      const row = card.querySelector(".origin-card-ws")!;
      expect(row.textContent).toBe("工作区: 未知");
      expect(row.getAttribute("data-tip")).toBe("未知（宿主没有报告工作区，委派时也没有传 cwd）");
    });
    originCard({ kind: "user", host: "console", hostLabel: "Ensemble" }, (card) => {
      expect(card.querySelector(".origin-card-ws")).toBeNull();
    });
  });
});
