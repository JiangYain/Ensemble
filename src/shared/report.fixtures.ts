/**
 * 仅供测试使用：会话报告的几份测试（report.test.ts、report.budget.test.ts、report.facts.test.ts）共用的构造辅助——
 * 造一个会话（事件加摘要）、渲染、常用的运行写法，以及两份固定的数据：一次完整的运行（finished）与一棵任务树（family）。
 * 这里没有 describe / it，也没有 vi.mock：vi.mock 只对声明它的测试文件生效，要观察调用的文件（report.budget.test.ts）自己声明。
 */

import type { EnsembleEvent } from "./events";
import { replay, toSummary } from "./projection";
import { renderReport } from "./report";
import type { ReportOptions } from "./report";
import { EventLog } from "./testing";
import type { ContextItem, SessionMeta, SessionSummary } from "./types";

// ───────────────────────── 构造辅助 ─────────────────────────

export interface Built {
  summary: SessionSummary;
  events: EnsembleEvent[];
}

/** 造一个会话：先写 session.created，再交给 fill 追加事件；摘要由事件投影得到，与服务端算出来的是同一份。 */
export function build(id: string, fill: (log: EventLog) => void, meta: Partial<SessionMeta> = {}, childIds: string[] = []): Built {
  const log = new EventLog(id);
  log.created(meta);
  fill(log);
  const state = replay(log.events);
  if (!state) throw new Error("the fixture has no session.created event");
  return { summary: toSummary(state, childIds), events: log.events };
}

/**
 * 委派原文在两处出现：session.created 的 meta.task（报告“委派”一节引用的是它）与那条任务消息。
 * 测试里让两处是同一段文字，免得断言对着默认文案、却以为对着自己造的文字。
 */
export function taskMeta(text: string, context: ContextItem[] = []): Pick<SessionMeta, "task"> {
  return { task: { text, context, prompt: text } };
}

export function options(overrides: Partial<ReportOptions> = {}): ReportOptions {
  return { scope: "session", detail: "brief", lang: "en", exportedAt: "2026-03-01T12:00:00.000Z", version: "9.9.9", ...overrides };
}

export function render(sessions: readonly Built[], overrides: Partial<ReportOptions> = {}, rootId?: string): string {
  const root = rootId ?? sessions[0]?.summary.id;
  if (!root) throw new Error("no sessions to render");
  return renderReport({ ...options(overrides), rootId: root, sessions: sessions.map(({ summary, events }) => ({ summary, events })) });
}

/** 任务消息 + 第一次运行（已开始，任务消息已生效）。 */
export function startTask(log: EventLog, text = "Refactor the parser module"): void {
  log.message("msg_1", "task", text);
  log.run("run_1", 1, "msg_1");
  log.startRun("run_1");
  log.push({ kind: "message.delivery", data: { messageId: "msg_1", record: { stage: "applied", at: log.now() } } }, { runId: "run_1", source: "ensemble" });
}

export function say(log: EventLog, runId: string, text: string, itemId: string, phase: "commentary" | "final" = "final"): void {
  log.push({ kind: "assistant.completed", data: { itemId, text, phase } }, { runId });
}

export function finish(log: EventLog, runId: string): void {
  log.push({ kind: "run.completed", data: { stopReason: "end_turn" } }, { runId });
}

/** 报告里 Markdown 标题行（围栏代码块里的不算），按出现顺序。 */
export function headings(markdown: string): string[] {
  const out: string[] = [];
  let fence: number | undefined;
  for (const line of markdown.split("\n")) {
    const mark = /^\s*(`{3,})/.exec(line)?.[1]?.length;
    if (fence === undefined) {
      if (mark !== undefined) fence = mark;
      else if (/^#{1,6} /.test(line)) out.push(line);
    } else if (mark !== undefined && mark >= fence && /^\s*`+\s*$/.test(line)) {
      fence = undefined;
    }
  }
  return out;
}

/** 所有围栏都已闭合：被截断的报告不能留一个没关的代码块把后面的内容吞掉。 */
export function fencesClosed(markdown: string): boolean {
  let fence: number | undefined;
  for (const line of markdown.split("\n")) {
    const mark = /^\s*(`{3,})/.exec(line)?.[1]?.length;
    if (fence === undefined) {
      if (mark !== undefined) fence = mark;
    } else if (mark !== undefined && mark >= fence && /^\s*`+\s*$/.test(line)) {
      fence = undefined;
    }
  }
  return fence === undefined;
}

export const TASK = "Refactor the parser module\nKeep the public API stable";
export const NOTE = "Use `async` where possible";

/** 一次完整运行：有命令（成功与失败）、读取、改文件、MCP、计划、用量、推理与最终回答。 */
export function finished(): Built {
  return build(
    "ses_a",
    (log) => {
      startTask(log, TASK);
      say(log, "run_1", "Looking at the parser first.", "a_note", "commentary");
      log.push({ kind: "reasoning.delta", data: { itemId: "r1", text: "SECRET-REASONING-TEXT" } }, { runId: "run_1" });
      log.push({ kind: "reasoning.completed", data: { itemId: "r1" } }, { runId: "run_1" });
      log.tool("run_1", "call_read", "completed", { name: "read", category: "read", title: "src/parser.ts" });
      log.tool("run_1", "call_test", "failed", {
        title: "npm test",
        exitCode: 1,
        error: "2 tests failed",
        input: { text: "npm test -- --run", truncated: false },
        output: { text: "FAIL OUTPUT-MARKER\n2 failed", truncated: false },
      });
      log.tool("run_1", "call_edit", "completed", { name: "edit", category: "edit", title: "src/parser.ts" });
      log.push({ kind: "file.changed", data: { callId: "call_edit", files: [{ path: "src/parser.ts", change: "modified", addedLines: 12, removedLines: 3 }, { path: "src/new.ts", change: "created" }] } }, { runId: "run_1" });
      log.push({ kind: "file.changed", data: { callId: "call_edit", files: [{ path: "src/parser.ts", change: "modified" }] } }, { runId: "run_1" });
      log.tool("run_1", "call_mcp", "completed", { name: "mcp__docs__search", category: "mcp", title: "search", mcp: { server: "docs", tool: "search" } });
      log.push({ kind: "plan.updated", data: { entries: [{ text: "Read the parser", status: "completed" }, { text: "Add tests", status: "in_progress" }] } }, { runId: "run_1" });
      log.push({ kind: "usage.updated", data: { usage: { inputTokens: 1200, outputTokens: 340, cachedTokens: 800, reasoningTokens: 90, costUsd: 0.0123 } } }, { runId: "run_1" });
      say(log, "run_1", "The parser is refactored.\nAll 14 tests pass.", "a_final");
      finish(log, "run_1");
    },
    {
      title: "Refactor the parser",
      cwd: "C:\\work\\demo",
      ...taskMeta(TASK, [
        { kind: "file", path: "src/parser.ts", note: "entry point" },
        { kind: "url", url: "https://example.com/spec", title: "Spec" },
        { kind: "text", title: "Notes", text: NOTE },
      ]),
    },
  );
}

// ───────────────────────── 任务树 ─────────────────────────

export function family(): Built[] {
  // 每个会话都上报同样的用量（输入 100、输出 10）：合计行才不会因为“只有部分会话上报”而带星号。
  const reportUsage = (log: EventLog): void => {
    log.push({ kind: "usage.updated", data: { usage: { inputTokens: 100, outputTokens: 10 } } }, { runId: "run_1" });
  };
  const root = build(
    "ses_root",
    (log) => {
      startTask(log, "ROOT-TASK-MARKER");
      reportUsage(log);
      say(log, "run_1", "Root answer", "a1");
      finish(log, "run_1");
    },
    { title: "Root", createdAt: "2026-01-01T00:00:00.000Z", ...taskMeta("ROOT-TASK-MARKER") },
    ["ses_b", "ses_c"],
  );
  const child = (id: string, title: string, createdAt: string, parent: string, depth: number, kids: string[] = []): Built =>
    build(
      id,
      (log) => {
        startTask(log, `${title} task`);
        reportUsage(log);
        say(log, "run_1", `${title} answer`, "a1");
        finish(log, "run_1");
      },
      { title, createdAt, parentSessionId: parent, depth, ...taskMeta(`${title} task`) },
      kids,
    );
  // 故意打乱输入顺序：C 比 B 先创建，所以排在 B 前面。
  return [
    child("ses_g", "Grandchild", "2026-01-01T00:03:00.000Z", "ses_b", 2),
    child("ses_b", "Child B", "2026-01-01T00:02:00.000Z", "ses_root", 1, ["ses_g"]),
    root,
    child("ses_c", "Child C", "2026-01-01T00:01:00.000Z", "ses_root", 1),
  ];
}
