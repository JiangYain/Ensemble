import { describe, expect, it } from "vitest";
import type { EventPayload } from "./events";
import { SYSTEM_ACTOR } from "./questions";
import type { QuestionAsk } from "./questions";
import { renderReport } from "./report";
import { REPORT_LABELS } from "./report-labels";
import type { ReportLabelKey } from "./report-labels";
import { build, family, fencesClosed, finish, finished, headings, NOTE, options, render, say, startTask, TASK, taskMeta } from "./report.fixtures";
import type { Built } from "./report.fixtures";
import { AGENT, USER } from "./testing";

/**
 * 单个会话与任务树的报告内容：骨架、委派与上下文、步骤与计数、各种结局、多次运行、执行端的提问、读不到的会话、版式、语言与确定性。
 * 字符数上限与 ReportBuilder 在 report.budget.test.ts，会话事实的整理在 report.facts.test.ts（这三份共用 report.fixtures.ts 里的夹具）；
 * 汇聚与会话引用在 report.multiparent.test.ts 与 report.context.test.ts，那两份有各自的夹具。
 */

// ───────────────────────── 单个会话 ─────────────────────────

describe("a finished single-run session", () => {
  it("has the fixed skeleton, in order", () => {
    const markdown = render([finished()]);
    expect(markdown.startsWith("# Session report: Refactor the parser\n")).toBe(true);
    expect(markdown).toContain("Exported 2026-03-01 12:00:00 UTC by Ensemble 9.9.9 · scope=session · detail=brief");
    const labels = REPORT_LABELS.en;
    const expected = [labels.overview, labels.delegation, labels.process, labels.files, labels.result, labels.usage, labels.notes].map((name) => `## ${name}`);
    const found = headings(markdown);
    const positions = expected.map((heading) => found.indexOf(heading));
    expect(positions.every((position) => position >= 0), `headings found: ${found.join(" | ")}`).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(found).toContain(`### ${labels.context}`);
    expect(found.some((heading) => /^### Run 1 — completed/.test(heading))).toBe(true);
  });

  it("quotes the delegation text and the context items verbatim", () => {
    const markdown = render([finished()]);
    expect(markdown).toContain(`\`\`\`text\n${TASK}\n\`\`\``);
    expect(markdown).toContain("- File: `src/parser.ts` — entry point");
    expect(markdown).toContain("- URL: `https://example.com/spec` — Spec");
    expect(markdown).toContain(`- Text: Notes — ${NOTE.length} characters`);
    expect(markdown).toContain(`  \`\`\`text\n  ${NOTE}\n  \`\`\``);
  });

  it("lists the key steps of a run and counts what it leaves out", () => {
    const markdown = render([finished()]);
    // 失败的命令：状态、退出码与错误都来自事件。
    // 时刻只写到秒、不带时区标记（“生成说明”里写明时间均为 UTC）。
    expect(markdown).toMatch(/- \d\d:\d\d:\d\d — Command: `npm test` — failed — exit code 1 — error: `2 tests failed`/);
    expect(markdown).toMatch(/File change: `src\/parser\.ts` \(modified\)/);
    expect(markdown).toContain("MCP call: `docs / search`");
    // 普通的读取调用、过程说明和推理不逐条列出，只计数。
    expect(markdown).toContain("1 other tool calls (read 1)");
    expect(markdown).toContain("1 assistant messages");
    expect(markdown).toContain("1 reasoning blocks (never included)");
    expect(markdown).not.toContain("Looking at the parser first.");
    expect(markdown).toContain("- [x] Read the parser");
    expect(markdown).toContain("- [ ] Add tests (in progress)");
  });

  it("never includes reasoning content, in either detail level", () => {
    const built = finished();
    expect(render([built])).not.toContain("SECRET-REASONING-TEXT");
    expect(render([built], { detail: "full" })).not.toContain("SECRET-REASONING-TEXT");
  });

  it("lists changed files once per path with the change types and how often they were reported", () => {
    const markdown = render([finished()]);
    expect(markdown).toContain("- `src/new.ts` — created");
    expect(markdown).toContain("- `src/parser.ts` — modified ×2");
    expect(markdown.indexOf("- `src/new.ts`")).toBeLessThan(markdown.indexOf("- `src/parser.ts` — modified"));
  });

  it("gives the last run's final answer as the result, and the usage per run", () => {
    const markdown = render([finished()]);
    expect(markdown).toContain(`Final answer of run 1 (verbatim):\n\n\`\`\`text\nThe parser is refactored.\nAll 14 tests pass.\n\`\`\``);
    expect(markdown).toMatch(/\| Run 1 \| 1,200 \| 340 \| 800 \| 90 \| \$0\.0123 \| [^|]+ \|/);
  });

  it("says plainly when nothing was reported", () => {
    const quiet = build("ses_q", (log) => {
      startTask(log);
      finish(log, "run_1");
    });
    const markdown = render([quiet]);
    expect(markdown).toContain("| Run 1 | not reported | not reported | not reported | not reported | not reported |");
    expect(markdown).toContain(REPORT_LABELS.en.noAnswer);
    expect(markdown).toContain(REPORT_LABELS.en.noFiles);
  });

  it("ends with the generation notes, including the no-redaction disclosure", () => {
    const markdown = render([finished()]);
    const labels = REPORT_LABELS.en;
    expect(markdown).toContain(labels.nFacts);
    expect(markdown).toContain(labels.nExcluded);
    expect(markdown).toContain(labels.nVerbatim);
    expect(markdown).toContain("Source: Ensemble 9.9.9, exported 2026-03-01 12:00:00 UTC;");
    expect(markdown.endsWith("\n")).toBe(true);
  });
});

describe("brief and full", () => {
  it("lists tool input and output, every tool call and assistant message only with detail=full", () => {
    const built = finished();
    const brief = render([built]);
    const full = render([built], { detail: "full" });
    expect(brief).not.toContain("OUTPUT-MARKER");
    expect(brief).not.toContain(`${REPORT_LABELS.en.toolOutput}:`);
    expect(brief).not.toContain("Looking at the parser first.");
    expect(full).toContain("OUTPUT-MARKER");
    expect(full).toContain(`${REPORT_LABELS.en.toolOutput}:`);
    expect(full).toContain(`${REPORT_LABELS.en.toolInput}:`);
    expect(full).toContain("npm test -- --run");
    expect(full).toContain("Looking at the parser first.");
    expect(full).toMatch(/Tool call: `read` — `src\/parser\.ts`/);
    expect(full).toContain("scope=session · detail=full");
  });

  it("caps the steps of a run in brief by keeping the first and the last half and counting the middle", () => {
    const busy = build("ses_busy", (log) => {
      startTask(log);
      for (let i = 1; i <= 200; i++) log.tool("run_1", `cmd-${String(i).padStart(3, "0")}`, "completed");
      finish(log, "run_1");
    });
    const brief = render([busy]);
    expect(brief).toContain("cmd-001");
    expect(brief).toContain("cmd-020");
    expect(brief).not.toContain("cmd-021");
    expect(brief).not.toContain("cmd-180");
    expect(brief).toContain("cmd-181");
    expect(brief).toContain("cmd-200");
    expect(brief).toContain("… 160 more steps not listed");
    const full = render([busy], { detail: "full" });
    expect(full).toContain("cmd-100");
    expect(full).not.toContain("more steps not listed");
  });

  it("states how much of an over-long quote was cut instead of cutting silently", () => {
    const long = build("ses_long", (log) => {
      startTask(log);
      say(log, "run_1", "A".repeat(50_000), "ans");
      finish(log, "run_1");
    });
    const markdown = render([long]);
    expect(markdown).toContain("(truncated: 20,000 more characters not shown)");
    expect(markdown).not.toContain("A".repeat(30_001));
  });
});

describe("outcomes other than success", () => {
  it("reports a failed run with its real error, not an answer", () => {
    const failed = build("ses_f", (log) => {
      startTask(log);
      log.push({ kind: "run.failed", data: { error: { code: "model_not_found", message: "The model does not exist" } } }, { runId: "run_1" });
    });
    const markdown = render([failed]);
    expect(markdown).toContain("Error: `model_not_found` — The model does not exist");
    expect(markdown).toContain("Run 1 failed: `model_not_found` The model does not exist");
    expect(markdown).toContain(REPORT_LABELS.en.noAnswer);
  });

  it("reports a cancelled run with who cancelled it and why", () => {
    const cancelled = build("ses_c", (log) => {
      startTask(log);
      log.push({ kind: "run.cancelled", data: { by: USER, note: "Wrong direction" } }, { runId: "run_1" });
    });
    const markdown = render([cancelled]);
    expect(markdown).toContain("Cancelled by You (user): Wrong direction");
    expect(markdown).toContain("Run 1 was cancelled.");
  });

  it("reports a lost or stopped session in the session-level events", () => {
    const lost = build("ses_l", (log) => {
      startTask(log);
      log.push({ kind: "session.status", data: { status: "lost", reason: "restarted" } }, { source: "ensemble" });
    });
    const markdown = render([lost]);
    expect(markdown).toContain(`### ${REPORT_LABELS.en.sessionEvents}`);
    expect(markdown).toMatch(/Session status: `lost` — reason `restarted`/);

    const stopped = build("ses_s", (log) => {
      startTask(log);
      log.push({ kind: "session.status", data: { status: "stopped" } }, { source: "ensemble" });
    });
    expect(render([stopped])).toMatch(/Session status: `stopped`/);
  });

  it("says a run still in progress has no final answer yet", () => {
    const running = build("ses_r", (log) => {
      startTask(log);
      say(log, "run_1", "Halfway there.", "a1");
    });
    const markdown = render([running]);
    expect(markdown).toContain("When this report was exported, run 1 was running; there is no final answer yet.");
    expect(markdown).toContain("Last assistant message of run 1 (not marked as the final answer, verbatim):");
  });
});

describe("several runs, steering and follow-ups", () => {
  function conversation(): Built {
    return build("ses_m", (log) => {
      startTask(log, "First task");
      say(log, "run_1", "FIRST-ANSWER", "a1");
      finish(log, "run_1");
      log.message("msg_2", "follow_up", "Now add tests", USER);
      log.run("run_2", 2, "msg_2", "follow_up");
      log.startRun("run_2");
      log.push({ kind: "message.delivery", data: { messageId: "msg_2", record: { stage: "applied", at: log.now() } } }, { runId: "run_2", source: "ensemble" });
      log.message("msg_s", "steer", "Use the async API", USER, "run_2");
      log.push({ kind: "message.delivery", data: { messageId: "msg_s", record: { stage: "handed_off", at: log.now() } } }, { runId: "run_2", source: "ensemble" });
      log.push({ kind: "message.delivery", data: { messageId: "msg_s", record: { stage: "applied", at: log.now() } } }, { runId: "run_2", source: "ensemble" });
      say(log, "run_2", "SECOND-ANSWER", "a2");
      finish(log, "run_2");
    });
  }

  it("takes the result from the last run and keeps earlier answers under their own run", () => {
    const markdown = render([conversation()]);
    expect(markdown).toContain("Final answer of run 2 (verbatim):\n\n```text\nSECOND-ANSWER\n```");
    expect(markdown).toContain("Final answer of this run (verbatim):\n\n```text\nFIRST-ANSWER\n```");
    expect(markdown.indexOf("FIRST-ANSWER")).toBeLessThan(markdown.indexOf("SECOND-ANSWER"));
    expect(markdown).toMatch(/^### Run 2 — completed/m);
  });

  it("lists follow-up and steer messages with who sent them and how far they got", () => {
    const markdown = render([conversation()]);
    expect(markdown).toContain("Follow-up message from You (user) — applied");
    expect(markdown).toContain("Steer message from You (user) — applied");
    // 消息是列表项的一部分，引用块缩进两格。
    expect(markdown).toContain("  ```text\n  Now add tests\n  ```");
    expect(markdown).toContain("  ```text\n  Use the async API\n  ```");
  });
});

describe("questions the executor asked", () => {
  const ask: QuestionAsk = {
    id: "q1",
    prompts: [{ key: "db", header: "Database", text: "Which database should I use?", options: [{ label: "Postgres" }, { label: "SQLite" }], multiple: false, custom: true }],
  };

  it("lists the question, its options, the answer and who gave it", () => {
    const asked = build("ses_qa", (log) => {
      startTask(log);
      log.push({ kind: "question.asked", data: { question: ask } }, { runId: "run_1" });
      log.push({ kind: "question.resolved", data: { questionId: "q1", outcome: "answered", by: AGENT, answers: [["Postgres"]], delivery: "handed_off" } }, { runId: "run_1" });
    });
    const markdown = render([asked]);
    expect(markdown).toMatch(/- \d\d:\d\d:\d\d — Question from the executor — answered by Codex \(agent\) at \d\d:\d\d:\d\d — reply handed to the executor/);
    expect(markdown).toContain("  Database:");
    expect(markdown).toContain("  ```text\n  Which database should I use?\n  ```");
    expect(markdown).toContain("  Options: `Postgres`, `SQLite`");
    expect(markdown).toContain("  Answer: `Postgres`");
  });

  it("says when a question was left unanswered or expired, with the reason that was recorded", () => {
    const open = build("ses_qo", (log) => {
      startTask(log);
      log.push({ kind: "question.asked", data: { question: ask } }, { runId: "run_1" });
    });
    expect(render([open])).toContain("no answer had been given when exported");

    const expired = build("ses_qe", (log) => {
      startTask(log);
      log.push({ kind: "question.asked", data: { question: ask } }, { runId: "run_1" });
      log.push({ kind: "question.resolved", data: { questionId: "q1", outcome: "expired", by: SYSTEM_ACTOR, reason: "timeout", note: "Nobody answered; assume and continue." } }, { runId: "run_1" });
    });
    const markdown = render([expired]);
    expect(markdown).toMatch(/expired at \d\d:\d\d:\d\d: no one answered in time/);
    expect(markdown).toContain("  Note sent to the executor:");
    expect(markdown).toContain("Nobody answered; assume and continue.");
  });

  it("quotes a long free-text answer instead of squeezing it into one line", () => {
    const answer = "Use Postgres 16 with pgvector,\nand keep SQLite only for the tests.";
    const asked = build("ses_qt", (log) => {
      startTask(log);
      log.push({ kind: "question.asked", data: { question: ask } }, { runId: "run_1" });
      log.push({ kind: "question.resolved", data: { questionId: "q1", outcome: "answered", by: USER, answers: [[answer]] } }, { runId: "run_1" });
    });
    const markdown = render([asked]);
    expect(markdown).toContain("  Answer:\n\n  ```text\n  Use Postgres 16 with pgvector,\n  and keep SQLite only for the tests.\n  ```");
  });
});

describe("empty and unreadable sessions", () => {
  it("renders a session that has not started any run", () => {
    const empty = build("ses_e", () => undefined);
    const markdown = render([empty]);
    expect(markdown).toContain(REPORT_LABELS.en.noRuns);
    expect(markdown).toContain(REPORT_LABELS.en.resultNoRun);
    expect(markdown).toContain(REPORT_LABELS.en.noUsageRuns);
    expect(markdown).toContain(REPORT_LABELS.en.noFiles);
  });

  it("renders the overview and says so when the history could not be read", () => {
    const built = finished();
    const markdown = renderReport({ ...options(), rootId: "ses_a", sessions: [{ summary: built.summary, events: undefined }] });
    expect(markdown).toContain(REPORT_LABELS.en.noHistory);
    expect(markdown).toContain("| Session | `ses_a` |");
    expect(markdown).not.toContain(`## ${REPORT_LABELS.en.delegation}`);
  });

  it("ignores events of a kind it does not know", () => {
    const withFuture = build("ses_x", (log) => {
      startTask(log);
      log.push({ kind: "future.thing", data: { anything: 1 } } as unknown as EventPayload);
      say(log, "run_1", "Still fine.", "a1");
      finish(log, "run_1");
    });
    expect(() => render([withFuture])).not.toThrow();
    expect(render([withFuture])).toContain("Still fine.");
  });

  it("gives the same report for an archived session as for the same session before it was archived", () => {
    const built = finished();
    const archived: Built = { ...built, summary: { ...built.summary, archivedAt: "2026-02-01T00:00:00.000Z", archivedBy: "user" } };
    expect(render([archived])).toBe(render([built]));
  });
});

// ───────────────────────── 任务树 ─────────────────────────

describe("a task tree", () => {
  it("numbers the sessions in tree order and indents the directory by depth", () => {
    const markdown = render(family(), { scope: "tree" }, "ses_root");
    expect(markdown.startsWith("# Task tree report: Root\n")).toBe(true);
    const found = headings(markdown);
    const sessions = found.filter((heading) => heading.startsWith("### "));
    expect(sessions).toEqual(["### 1 Root", "### 1.1 Child C", "### 1.2 Child B", "### 1.2.1 Grandchild"]);
    expect(found).toContain(`## ${REPORT_LABELS.en.tree}`);
    expect(found).toContain(`## ${REPORT_LABELS.en.usageAll}`);
    expect(markdown).toMatch(/^- 1 Root — Pi · done · .+ · `ses_root`$/m);
    expect(markdown).toMatch(/^ {2}- 1\.1 Child C — /m);
    expect(markdown).toMatch(/^ {2}- 1\.2 Child B — /m);
    expect(markdown).toMatch(/^ {4}- 1\.2\.1 Grandchild — /m);
    expect(markdown).toContain("| Sessions | 4 |");
    expect(markdown).toContain("ROOT-TASK-MARKER");
    expect(markdown).toContain("Grandchild task");
    // 四个会话各上报 100 / 10：合计 400 / 40，没有星号（星号表示只合计了部分会话上报的数字）。
    expect(markdown).toMatch(/\| Total \| 400 \| 40 \|/);
    expect(markdown).not.toContain("Sum of the figures that were reported");
  });

  it("with scope=session shows only the session and says its children are not included", () => {
    const markdown = render(family(), { scope: "session" }, "ses_root");
    expect(markdown.startsWith("# Session report: Root\n")).toBe(true);
    expect(markdown).toContain("| Child sessions | 2 (not included; use scope=tree) |");
    expect(markdown).not.toContain("Child C");
  });

  it("takes only the subtree of the session it is asked about", () => {
    const markdown = render(family(), { scope: "tree" }, "ses_b");
    expect(markdown).toContain("### 1 Child B");
    expect(markdown).toContain("### 1.1 Grandchild");
    expect(markdown).not.toContain("ROOT-TASK-MARKER");
    expect(markdown).not.toContain("Child C");
  });

  it("is the same whatever order the sessions are handed in", () => {
    const sessions = family();
    expect(render([...sessions].reverse(), { scope: "tree" }, "ses_root")).toBe(render(sessions, { scope: "tree" }, "ses_root"));
  });
});

// ───────────────────────── 版式 ─────────────────────────

describe("markdown hygiene", () => {
  it("keeps the title on one line and escapes what Markdown would treat as markup", () => {
    const built = build("ses_t", () => undefined, { title: "A | B\n# not a heading *x*" });
    const first = render([built]).split("\n")[0];
    expect(first).toBe("# Session report: A | B # not a heading \\*x\\*");
  });

  it("uses a fence longer than any backtick run inside the quoted text", () => {
    const tricky = "Use ```js\ncode\n``` carefully <script>alert(1)</script>";
    const built = build("ses_k", (log) => startTask(log, tricky), taskMeta(tricky));
    const markdown = render([built]);
    expect(markdown).toContain(`\`\`\`\`text\n${tricky}\n\`\`\`\``);
    expect(fencesClosed(markdown)).toBe(true);
    expect(headings(markdown).some((heading) => heading.includes("script"))).toBe(false);
  });

  it("escapes pipes in table cells and shows control characters as visible symbols", () => {
    const text = "bell\u0007here";
    const built = build("ses_p", () => undefined, { cwd: "C:\\work|dir", ...taskMeta(text) });
    const markdown = render([built]);
    expect(markdown).toContain("`C:\\work\\|dir`");
    expect(markdown).toContain("bell\u2407here");
    expect(markdown).not.toContain("\u0007");
  });

  it("wraps inline code that itself contains backticks", () => {
    const built = build("ses_i", (log) => {
      startTask(log);
      log.tool("run_1", "call_1", "completed", { title: "echo `date`" });
      finish(log, "run_1");
    });
    expect(render([built])).toContain("Command: `` echo `date` ``");
  });
});

describe("language", () => {
  it("translates only the fixed labels, never the quoted content", () => {
    const markdown = render([finished()], { lang: "zh" });
    expect(markdown.startsWith("# 会话报告：Refactor the parser\n")).toBe(true);
    expect(markdown).toContain(`## ${REPORT_LABELS.zh.overview}`);
    expect(markdown).toContain(REPORT_LABELS.zh.nVerbatim);
    expect(markdown).not.toContain("## Overview");
    expect(markdown).toContain(`\`\`\`text\n${TASK}\n\`\`\``);
    expect(markdown).toContain("The parser is refactored.");
  });

  it("keeps both label tables aligned: same keys, same placeholders", () => {
    const keys = Object.keys(REPORT_LABELS.en) as ReportLabelKey[];
    expect(Object.keys(REPORT_LABELS.zh).sort()).toEqual([...keys].sort());
    const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? "").sort();
    for (const key of keys) {
      expect(placeholders(REPORT_LABELS.zh[key]), `placeholders of ${key}`).toEqual(placeholders(REPORT_LABELS.en[key]));
    }
  });
});

describe("determinism", () => {
  it("renders the same input to the same text, and different export times differ only where the time is written", () => {
    const built = finished();
    expect(render([built])).toBe(render([built]));
    const later = render([built], { exportedAt: "2026-03-02T08:30:00.000Z" });
    expect(later).toContain("Exported 2026-03-02 08:30:00 UTC");
    const normalize = (text: string): string => text.replace(/\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC/g, "<time>");
    expect(normalize(later)).toBe(normalize(render([built])));
  });
});
