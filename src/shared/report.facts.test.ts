import { describe, expect, it } from "vitest";
import type { EnsembleEvent } from "./events";
import { renderReport } from "./report";
import * as reportFacts from "./report-facts";
import type { Step } from "./report-facts";
import { REPORT_LABELS } from "./report-labels";
import { makeCtx } from "./report-markdown";
import { trimFor } from "./report-options";
import * as reportSession from "./report-session";
import { build, finish, finished, options, say, startTask } from "./report.fixtures";
import type { Built } from "./report.fixtures";
import { USER } from "./testing";

/**
 * 一个会话的事实（report-facts 的 prepareReportSession）：每次运行的回答、逐条列出的步骤与只计数的类别，文件与用量的统计，
 * 读不到日志时只剩概览；以及渲染只读这份事实——同一份事实在任何档位、任何顺序下渲染得到同样的文字，也不会被改动。
 * “整理一次、预算各档共用”要观察 prepareReportSession 与 formatSession 被调用了几次，那两条用例在 report.budget.test.ts（vi.mock 在那里）。
 */

// ───────────────────────── 会话的事实：整理一次，预算各档共用 ─────────────────────────

describe("the facts of a session", () => {
  /** 第一次运行的事实；测试里的会话都是以 session.created 开头、至少有一次运行的。 */
  function firstRun(built: Built, detail: "brief" | "full"): reportFacts.RunFacts {
    const run = reportFacts.prepareReportSession(built.summary, built.events, detail).history?.runs[0];
    if (!run) throw new Error("the fixture has no run to read");
    return run;
  }

  /** 逐条列出的步骤写成便于比较的标记：工具写调用编号，其余写类型。 */
  const marks = (steps: readonly Step[]): string[] => steps.map((step) => (step.kind === "tool" ? step.tool.callId : step.kind));

  it("lists the key steps in brief and every step in full, counts what it leaves out, and never repeats the answer as a step", () => {
    const built = finished();
    const brief = firstRun(built, "brief");
    const full = firstRun(built, "full");
    // brief：失败的命令、改文件的调用、MCP 调用；普通的读取、过程说明和推理只计数。
    expect(marks(brief.steps)).toEqual(["call_test", "call_edit", "call_mcp"]);
    expect(brief.skipped).toEqual({ tools: new Map([["read", 1]]), assistant: 1, diagnostics: 0, reasoning: 1, other: 0 });
    // full：每一次工具调用与助手文字都逐条列出，只有推理仍然只计数。
    expect(marks(full.steps)).toEqual(["assistant", "call_read", "call_test", "call_edit", "call_mcp"]);
    expect(full.skipped).toEqual({ tools: new Map(), assistant: 0, diagnostics: 0, reasoning: 1, other: 0 });
    for (const run of [brief, full]) {
      expect(run.answer?.item.text).toBe("The parser is refactored.\nAll 14 tests pass.");
      expect(run.answer?.final).toBe(true);
      expect(run.steps.some((step) => step.kind === "assistant" && step.item === run.answer?.item)).toBe(false);
      expect(run.plan?.entries.map((entry) => entry.text)).toEqual(["Read the parser", "Add tests"]);
    }
  });

  it("marks the answer of a run as not final when only a process comment was left", () => {
    const talky = build("ses_comment", (log) => {
      startTask(log);
      say(log, "run_1", "Working on it.", "a1", "commentary");
      finish(log, "run_1");
    });
    const run = firstRun(talky, "brief");
    expect(run.answer?.item.text).toBe("Working on it.");
    expect(run.answer?.final).toBe(false);
  });

  it("takes the last run that has started as the result run, and keeps a run that is still queued out of it", () => {
    const queued = build("ses_queued", (log) => {
      startTask(log);
      say(log, "run_1", "FIRST", "a1");
      finish(log, "run_1");
      log.message("msg_2", "follow_up", "Next", USER);
      log.run("run_2", 2, "msg_2", "follow_up");
    });
    const history = reportFacts.prepareReportSession(queued.summary, queued.events, "brief").history;
    expect(history?.runs.map((entry) => [entry.run.id, entry.run.status])).toEqual([
      ["run_1", "completed"],
      ["run_2", "queued"],
    ]);
    expect(history?.resultRun).toBe(history?.runs[0]);
  });

  it("keeps only counts and paths in the stats, with the files in the order they were first reported", () => {
    const built = finished();
    const { stats, history } = reportFacts.prepareReportSession(built.summary, built.events, "brief");
    expect(Object.keys(stats).sort()).toEqual(["events", "files", "partial", "usage"]);
    expect(stats.events).toBe(built.events.length);
    expect(stats.files).toEqual(["src/parser.ts", "src/new.ts"]);
    expect(stats.usage).toMatchObject({ input: 1200, output: 340, cached: 800, reasoning: 90, cost: 0.0123 });
    expect(stats.partial.size).toBe(0);
    // 报告里的文件清单则按路径排序，与首次出现的先后无关。
    expect(history?.filePaths).toEqual(["src/new.ts", "src/parser.ts"]);
  });

  it("still counts the files of a log that does not start with session.created, and writes only the overview for it", () => {
    const built = finished();
    const headless = built.events.slice(1);
    const { stats, history } = reportFacts.prepareReportSession(built.summary, headless, "brief");
    expect(history).toBeUndefined();
    expect(stats.events).toBe(headless.length);
    expect(stats.files).toEqual(["src/parser.ts", "src/new.ts"]);
    // 回放不了就没有状态，也就没有用量可汇总。
    expect(stats.usage).toEqual({});
    const markdown = renderReport({ ...options(), rootId: "ses_a", sessions: [{ summary: built.summary, events: headless }] });
    expect(markdown).toContain(REPORT_LABELS.en.noHistory);
  });

  it("treats a log that was never read exactly like an empty one", () => {
    const built = finished();
    const unread = reportFacts.prepareReportSession(built.summary, undefined, "brief");
    const empty = reportFacts.prepareReportSession(built.summary, [], "brief");
    expect(unread).toEqual(empty);
    expect(unread.history).toBeUndefined();
    expect(unread.stats).toEqual({ events: 0, usage: {}, partial: new Set(), files: [] });
    const rendered = (events: readonly EnsembleEvent[] | undefined): string =>
      renderReport({ ...options(), rootId: "ses_a", sessions: [{ summary: built.summary, events }] });
    expect(rendered(undefined)).toBe(rendered([]));
  });

  it("renders from the facts alone: the same facts give the same text at every level, in any order, and are never modified", () => {
    const built = finished();
    const prepared = reportFacts.prepareReportSession(built.summary, built.events, "full");
    const before = structuredClone(prepared);
    const ctx = makeCtx(options({ detail: "full" }), false, "");
    const renderAt = (levels: readonly number[]): string[] =>
      levels.map((level) => reportSession.formatSession(prepared, ctx, trimFor("full", level), level, 8_000));
    const ascending = renderAt([0, 1, 2, 3, 4]);
    const descending = renderAt([4, 3, 2, 1, 0]).reverse();
    expect(descending).toEqual(ascending);
    expect(prepared).toEqual(before);
  });
});
