import { describe, expect, it } from "vitest";
import type { EnsembleEvent } from "./events";
import { parentFields } from "./lineage";
import { replay, toSummary } from "./projection";
import { ReportBuilder, renderReport } from "./report";
import type { ReportOptions } from "./report";
import { EventLog } from "./testing";
import type { SessionMeta, SessionSummary } from "./types";

/**
 * 汇聚（一个会话跟随多个上级）在会话报告里的样子：任务树里只展开一次，别的上级写在它自己的字段表里。
 * 没有汇聚节点的任务树由 report.test.ts 守着，这里只管菱形。
 *
 *        R
 *       / \
 *      A   B
 *       \ /
 *        J     （J 同时跟随 A 与 B）
 */

interface Built {
  summary: SessionSummary;
  events: EnsembleEvent[];
}

function build(id: string, title: string, createdAt: string, meta: Partial<SessionMeta> = {}, childIds: string[] = []): Built {
  const log = new EventLog(id);
  log.created({ title, createdAt, ...meta });
  log.message("msg_1", "task", `${title} task`);
  log.run("run_1", 1, "msg_1");
  log.startRun("run_1");
  log.push({ kind: "assistant.completed", data: { itemId: "a1", text: `${title} answer`, phase: "final" } }, { runId: "run_1" });
  log.push({ kind: "run.completed", data: { stopReason: "end_turn" } }, { runId: "run_1" });
  const state = replay(log.events);
  if (!state) throw new Error("the fixture has no session.created event");
  return { summary: toSummary(state, childIds), events: log.events };
}

function options(overrides: Partial<ReportOptions> = {}): ReportOptions {
  return { scope: "tree", detail: "brief", lang: "en", exportedAt: "2026-03-01T12:00:00.000Z", version: "9.9.9", ...overrides };
}

function render(sessions: readonly Built[], rootId: string, overrides: Partial<ReportOptions> = {}): string {
  return renderReport({ ...options(overrides), rootId, sessions: sessions.map(({ summary, events }) => ({ summary, events })) });
}

function diamond(): Built[] {
  return [
    build("ses_r", "Root", "2026-01-01T00:00:00.000Z", { depth: 0 }, ["ses_a", "ses_b"]),
    build("ses_a", "Alpha", "2026-01-01T00:01:00.000Z", { depth: 1, ...parentFields(["ses_r"]) }, ["ses_j"]),
    build("ses_b", "Beta", "2026-01-01T00:02:00.000Z", { depth: 1, ...parentFields(["ses_r"]) }, ["ses_j"]),
    build("ses_j", "Join", "2026-01-01T00:03:00.000Z", { depth: 2, ...parentFields(["ses_a", "ses_b"]) }),
  ];
}

const sessionHeadings = (markdown: string): string[] => markdown.split("\n").filter((line) => line.startsWith("### "));

describe("a task tree with a join", () => {
  it("expands the join once, under the first of its parents that is in the report", () => {
    const markdown = render(diamond(), "ses_r");
    expect(sessionHeadings(markdown)).toEqual(["### 1 Root", "### 1.1 Alpha", "### 1.1.1 Join", "### 1.2 Beta"]);
    expect(markdown).toMatch(/^ {2}- 1\.1 Alpha — /m);
    expect(markdown).toMatch(/^ {4}- 1\.1\.1 Join — /m);
    expect(markdown).toMatch(/^ {2}- 1\.2 Beta — /m);
  });

  it("counts the join once in the overview", () => {
    expect(render(diamond(), "ses_r")).toContain("| Sessions | 4 |");
  });

  it("names the other parents in the join's own field table, with their titles", () => {
    const markdown = render(diamond(), "ses_r");
    expect(markdown).toContain("| Parent session | `ses_a` |");
    expect(markdown).toContain("| Also follows | Beta (`ses_b`) |");
    // 只有汇聚的会话才有这一行。
    expect(markdown.match(/\| Also follows \|/g)).toHaveLength(1);
  });

  it("is the same whatever order the sessions are handed in", () => {
    const sessions = diamond();
    expect(render([...sessions].reverse(), "ses_r")).toBe(render(sessions, "ses_r"));
  });

  it("puts the join under its next parent when the first one is not part of the report", () => {
    // 以 B 为根：J 的第一个上级 A 不在报告里，J 就挂在 B 下面；字段表仍然如实写着它的主上级与其余上级。
    const sessions = diamond().filter((entry) => entry.summary.id !== "ses_r" && entry.summary.id !== "ses_a");
    const markdown = render(sessions, "ses_b");
    expect(sessionHeadings(markdown)).toEqual(["### 1 Beta", "### 1.1 Join"]);
    expect(markdown).toContain("| Parent session | `ses_a` |");
    expect(markdown).toContain("| Also follows | Beta (`ses_b`) |");
  });

  it("writes only the id of a followed session that is neither in the report nor given a title", () => {
    // 以 A 为根：B 不在报告里，也没有人告诉它 B 的标题。
    const sessions = diamond().filter((entry) => entry.summary.id === "ses_a" || entry.summary.id === "ses_j");
    const markdown = render(sessions, "ses_a");
    expect(sessionHeadings(markdown)).toEqual(["### 1 Alpha", "### 1.1 Join"]);
    expect(markdown).toContain("| Also follows | `ses_b` |");
  });

  it("uses the title it was given for a followed session outside the report, without expanding it", () => {
    const sessions = diamond().filter((entry) => entry.summary.id === "ses_a" || entry.summary.id === "ses_j");
    const markdown = render(sessions, "ses_a", { references: { ses_b: "Beta" } });
    expect(markdown).toContain("| Also follows | Beta (`ses_b`) |");
    expect(sessionHeadings(markdown)).toEqual(["### 1 Alpha", "### 1.1 Join"]);
  });

  it("with scope=session still tells which other sessions the join follows", () => {
    const markdown = render(diamond(), "ses_j", { scope: "session" });
    expect(markdown.startsWith("# Session report: Join\n")).toBe(true);
    expect(markdown).toContain("| Parent session | `ses_a` |");
    expect(markdown).toContain("| Also follows | Beta (`ses_b`) |");
  });

  it("walks the order of a join once through the builder as well", () => {
    const builder = new ReportBuilder("ses_r", diamond().map((entry) => entry.summary), options());
    expect(builder.order.map((summary) => summary.id)).toEqual(["ses_r", "ses_a", "ses_j", "ses_b"]);
  });

  it("does not loop when the data says two sessions follow each other", () => {
    const sessions = [
      build("ses_x", "X", "2026-01-01T00:00:00.000Z", { depth: 1, ...parentFields(["ses_y"]) }),
      build("ses_y", "Y", "2026-01-01T00:01:00.000Z", { depth: 1, ...parentFields(["ses_x"]) }),
    ];
    const markdown = render(sessions, "ses_x");
    expect(sessionHeadings(markdown)).toEqual(["### 1 X", "### 1.1 Y"]);
  });
});
