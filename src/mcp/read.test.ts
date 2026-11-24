import { describe, expect, it } from "vitest";
import { EventLog, USER } from "@shared/testing";
import { renderResult, renderTranscript } from "./format";
import { BATCH_LIMIT, cursorLine, parseReadArgs, ReadInputError } from "./read";
import { cmd, read, snapshot, started, twoRuns } from "./read.fixtures";

/**
 * `read` 的入口与单个会话的读取：参数怎样解析（parseReadArgs）、原有的 result 与 transcript 视角保持原样、runIndex 把读取限定到一轮、files 视角。
 * 其余按主题分在 read.errors-commands / read.after-seq / read.batch 三个文件里；共用的造数据辅助在 read.fixtures.ts。
 */

// ───────────────────────── 参数 ─────────────────────────

describe("parseReadArgs", () => {
  it("reads one session in the default view, trimming the id", () => {
    expect(parseReadArgs({ sessionId: "  ses_a " })).toEqual({ kind: "one", sessionId: "ses_a", view: "result", maxChars: 12_000, includeReasoning: false });
  });

  it("carries view, runIndex, afterSeq and the budget through", () => {
    expect(parseReadArgs({ sessionId: "ses_a", view: "errors", runIndex: 2, afterSeq: 40, maxChars: 3000, includeReasoning: true })).toEqual({
      kind: "one",
      sessionId: "ses_a",
      view: "errors",
      runIndex: 2,
      afterSeq: 40,
      maxChars: 3000,
      includeReasoning: true,
    });
  });

  it("clamps the budget to what the tool schema allows", () => {
    expect(parseReadArgs({ sessionId: "s", maxChars: 10 })).toMatchObject({ maxChars: 500 });
    expect(parseReadArgs({ sessionId: "s", maxChars: 10_000_000 })).toMatchObject({ maxChars: 40_000 });
  });

  it("needs a session id, and refuses to guess between one session and several", () => {
    expect(() => parseReadArgs({})).toThrow(/Pass `sessionId`/);
    expect(() => parseReadArgs({ sessionId: "  " })).toThrow(/Pass `sessionId`/);
    expect(() => parseReadArgs({ sessionId: "ses_a", sessionIds: ["ses_b"] })).toThrow(/either `sessionId`.*or `sessionIds`/);
  });

  it("rejects a runIndex or afterSeq that cannot be right, saying what is expected", () => {
    for (const runIndex of [0, -1, 1.5]) expect(() => parseReadArgs({ sessionId: "s", runIndex })).toThrow(/`runIndex` must be a whole number from 1/);
    for (const afterSeq of [-1, 2.5]) expect(() => parseReadArgs({ sessionId: "s", afterSeq })).toThrow(/`afterSeq` must be a whole number from 0/);
  });

  it("collects several sessions in input order, dropping duplicates and blanks, with a budget that grows with the count", () => {
    expect(parseReadArgs({ sessionIds: ["ses_b", " ses_a ", "ses_b", "  "] })).toEqual({ kind: "many", sessionIds: ["ses_b", "ses_a"], maxChars: 4000, ignored: 2 });
    expect(parseReadArgs({ sessionIds: ["ses_a"], maxChars: 6000 })).toMatchObject({ maxChars: 6000 });
  });

  it("keeps batch reads to the default view: no other view, run, cursor or reasoning", () => {
    expect(() => parseReadArgs({ sessionIds: ["a"], view: "errors" })).toThrow(/cannot be combined with view="errors"/);
    expect(() => parseReadArgs({ sessionIds: ["a"], runIndex: 1 })).toThrow(/`runIndex`/);
    expect(() => parseReadArgs({ sessionIds: ["a"], afterSeq: 3 })).toThrow(/`afterSeq`/);
    expect(() => parseReadArgs({ sessionIds: ["a"], includeReasoning: true })).toThrow(/`includeReasoning`/);
    expect(parseReadArgs({ sessionIds: ["a"], view: "result" })).toMatchObject({ kind: "many" });
  });

  it("limits one call to BATCH_LIMIT sessions and needs at least one", () => {
    const many = Array.from({ length: BATCH_LIMIT + 1 }, (_, index) => `ses_${index}`);
    expect(() => parseReadArgs({ sessionIds: many })).toThrow(`takes at most ${BATCH_LIMIT} sessions`);
    expect(() => parseReadArgs({ sessionIds: [" ", ""] })).toThrow(/no session id/);
    expect(parseReadArgs({ sessionIds: many.slice(0, BATCH_LIMIT) })).toMatchObject({ kind: "many", maxChars: 40_000 });
  });
});

// ───────────────────────── 原有视角保持不变 ─────────────────────────

describe("the views that existed before", () => {
  it("keeps the default result exactly as it was, adding only the cursor line", () => {
    const built = snapshot(twoRuns());
    const now = Date.parse(built.log.now()) + 5_000;
    const result = read(built, {}, now);
    const seq = built.state.seq;
    expect(result.text).toBe(`${renderResult(built.state, built.detail.summary, { maxChars: 12_000, now })}\ncursor: #${seq} — pass afterSeq=${seq} to read only what happens after this`);
    expect(result.seq).toBe(seq);
    expect(result.view).toBe("result");
    expect(result.runIndex).toBeUndefined();
  });

  it("keeps the default transcript exactly as it was, adding only the cursor line", () => {
    const built = snapshot(twoRuns());
    const result = read(built, { view: "transcript" });
    expect(result.text).toBe(`${renderTranscript(built.state, built.detail.summary, { maxChars: 12_000, includeReasoning: false })}\n${cursorLine(built.state.seq, false)}`);
  });
});

// ───────────────────────── runIndex ─────────────────────────

describe("runIndex", () => {
  it("narrows the result to one run: its answer, files and usage, under a line saying which run it is", () => {
    const first = read(twoRuns(), { runIndex: 1 });
    expect(first.runIndex).toBe(1);
    expect(first.text).toMatch(/\nRun 1 of 2 · completed in \d+s\n/);
    expect(first.text).toContain("Final answer:\nFirst run: parser audited.");
    expect(first.text).not.toContain("Second run");
    expect(first.text).toContain("Files changed (1):\n  - modified src/parser.ts +10 −2");
    expect(first.text).toContain("Usage (run 1): 1.0k tokens");

    const second = read(twoRuns(), { runIndex: 2 });
    expect(second.text).toContain("Final answer:\nSecond run: lexer audited.");
    expect(second.text).toContain("Files changed (2):");
    expect(second.text).toContain("Usage (run 2): 500 tokens");
  });

  it("limits the transcript, the commands, the files and the errors to that run", () => {
    const first = read(twoRuns(), { view: "transcript", runIndex: 1 }).text;
    expect(first).toContain("Run 1 of 2 · completed");
    expect(first).toContain("task → Pi");
    expect(first).toContain("shell: npm test → ok");
    expect(first).not.toContain("Now audit the lexer too");
    expect(first).not.toContain("npm run build");

    const second = read(twoRuns(), { view: "transcript", runIndex: 2 }).text;
    expect(second).toContain("Now audit the lexer too");
    expect(second).toContain("shell: npm run build → failed (exit 2)");
    expect(second).not.toContain("task → Pi");

    expect(read(twoRuns(), { view: "files", runIndex: 1 }).text).not.toContain("lexer");
    expect(read(twoRuns(), { view: "commands", runIndex: 1 }).text).not.toContain("npm run build");
    expect(read(twoRuns(), { view: "errors", runIndex: 1 }).text).toContain("No errors recorded for run 1:");
  });

  it("says what the valid range is instead of falling back to another run", () => {
    expect(() => read(twoRuns(), { runIndex: 3 })).toThrow("runIndex 3 is out of range: session ses_test has 2 runs (valid: 1..2).");
    expect(() => read(twoRuns(), { runIndex: 3 })).toThrow(ReadInputError);
    expect(() => read(started(), { runIndex: 2 })).toThrow("session ses_test has 1 run (valid: 1).");
    const none = new EventLog();
    none.created();
    expect(() => read(none, { runIndex: 1 })).toThrow("session ses_test has no runs yet.");
  });

  it("can read a run that is queued and has not produced any events yet", () => {
    const log = twoRuns();
    // 在第二轮之后再追加一条消息：它的运行排队中，还没有任何事件。
    log.message("m3", "follow_up", "One more check", USER);
    log.run("r3", 3, "m3", "follow_up");
    const queued = read(log, { view: "transcript", runIndex: 3 }).text;
    expect(queued).toContain("Run 3 of 3 · queued, not started yet");
    expect(queued).toContain("One more check");
  });
});

// ───────────────────────── files ─────────────────────────

describe("files view", () => {
  it("lists each changed file once, adding up the edits and naming the runs that wrote it", () => {
    const { text } = read(twoRuns(), { view: "files" });
    expect(text).toContain("Files changed (2) — as reported by the harness (edits made inside shell commands are not tracked); line counts add up each edit:");
    expect(text).toContain("  - modified src/parser.ts +13 −3 (2 edits, runs 1, 2)");
    expect(text).toContain("  - created src/lexer.ts +30 −0 (run 2)");
    // 只列清单，不带 diff。
    expect(text).not.toMatch(/^@@|^\+\+\+|^---/m);
  });

  it("shows what one run changed without the run labels", () => {
    expect(read(twoRuns(), { view: "files", runIndex: 1 }).text).toContain("Files changed (1)");
    expect(read(twoRuns(), { view: "files", runIndex: 1 }).text).toContain("  - modified src/parser.ts +10 −2\n");
    const second = read(twoRuns(), { view: "files", runIndex: 2 }).text;
    expect(second).toContain("  - modified src/parser.ts +3 −1");
    expect(second).toContain("  - created src/lexer.ts +30 −0");
    expect(second).not.toContain("(run");
  });

  it("keeps a file that was created and then edited as created", () => {
    const log = started();
    log.tool("r1", "c1", "completed", { name: "edit", category: "edit", title: "a.ts" });
    log.push({ kind: "file.changed", data: { callId: "c1", files: [{ path: "src/a.ts", change: "created", addedLines: 20 }] } }, { runId: "r1" });
    log.tool("r1", "c2", "completed", { name: "edit", category: "edit", title: "a.ts" });
    log.push({ kind: "file.changed", data: { callId: "c2", files: [{ path: "src/a.ts", change: "modified", addedLines: 2, removedLines: 1 }] } }, { runId: "r1" });
    expect(read(log, { view: "files" }).text).toContain("  - created src/a.ts +22 −1 (2 edits)");
  });

  it("says so when no file change was reported", () => {
    const log = started();
    log.tool("r1", "c1", "completed", { title: "npm test", input: cmd("npm test"), exitCode: 0 });
    expect(read(log, { view: "files" }).text).toContain("No file changes were reported for this session (edits made inside shell commands are not tracked).");
  });
});
