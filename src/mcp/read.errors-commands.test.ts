import { describe, expect, it } from "vitest";
import { USER } from "@shared/testing";
import { cmd, out, read, started, twoRuns } from "./read.fixtures";

/**
 * `read` 的 errors 与 commands 两个视角：失败出在哪一轮、哪个事件；shell 命令的结局、编号与汇总行。
 * 汇总行与它下面的列表出自同一次遍历，所以数汇总行的那个用例放在其余 commands 用例旁边（原先在 read.test.ts 的最后）。
 */

// ───────────────────────── errors ─────────────────────────

describe("errors view", () => {
  it("shows only real failures, newest first, each with its run and event number", () => {
    const log = twoRuns();
    const failure = log.events.find((event) => event.kind === "tool.updated" && event.data.callId === "c3")!;
    const { text } = read(log, { view: "errors" });
    expect(text).toMatch(/Errors \(2\), newest first — the most recent was \d+s ago:/);

    const failedAt = text.indexOf("tool failed: shell `npm run build` (exit 2, <1s)");
    const warnedAt = text.indexOf("note [warn] rate_limited: Rate limited; retrying in 2s");
    expect(failedAt).toBeGreaterThan(-1);
    expect(warnedAt).toBeGreaterThan(-1);
    // 最新的排在最前面。
    expect(warnedAt).toBeLessThan(failedAt);

    expect(text).toContain(`run 2 · #${failure.seq} · `);
    expect(text).toContain("build exited with code 2");
    expect(text).toContain("error TS2322: Type mismatch.");
    expect(text).not.toContain("only informational");
    expect(text).not.toMatch(/stuck|hung|frozen/i);
  });

  it("mentions tools that never reported an end event on a line of their own, and does not count them as errors", () => {
    const { text } = read(twoRuns(), { view: "errors" });
    expect(text).toContain("Not counted above: 1 tool call never reported an end event");
    expect(text).toContain("npm run lint");
    expect(text).toContain("that alone is not an error");
    expect(text).toContain("Errors (2)");
  });

  it("says so, with the session's status, when nothing failed", () => {
    const log = started();
    log.tool("r1", "c1", "completed", { title: "npm test", input: cmd("npm test"), exitCode: 0 });
    log.push({ kind: "run.completed", data: {} }, { runId: "r1" });
    const lines = read(log, { view: "errors" }).text.split("\n");
    expect(lines[0]).toMatch(/^• ses_test \[Pi\] .* — done/);
    expect(lines[1]).toBe("No errors recorded: no failed tool calls, no warning or error notes, no failed runs, no undelivered messages.");
    expect(lines[2]).toMatch(/^cursor: #\d+ — /);
  });

  it("counts a command that finished with a non-zero exit code, in the commands view as well", () => {
    const log = started();
    log.tool("r1", "c1", "completed", { title: "grep needle", input: cmd("grep needle src"), exitCode: 1, output: out("") });
    expect(read(log, { view: "errors" }).text).toContain("tool failed: shell `grep needle` (exit 1, <1s)");
    expect(read(log, { view: "commands" }).text).toContain("Shell commands: 1 in total — 0 ok, 1 failed.");
  });

  it("covers failed runs, undelivered messages and an error the session itself recorded", () => {
    const log = started();
    const steer = log.message("m2", "steer", "Skip the slow part", USER, "r1");
    log.push(
      { kind: "message.delivery", data: { messageId: steer.id, record: { stage: "failed", at: log.now(), error: { code: "harness_rejected", message: "The harness refused the message." } } } },
      { runId: "r1" },
    );
    log.push({ kind: "run.failed", data: { error: { code: "rate_limited", message: "Usage limit reached." } } }, { runId: "r1" });
    log.push({ kind: "session.status", data: { status: "idle", error: { code: "executor_crashed", message: "The executor process exited unexpectedly." } } });
    const { text } = read(log, { view: "errors" });
    expect(text).toContain("Session error: [executor_crashed] The executor process exited unexpectedly.");
    expect(text).toContain("run failed: [rate_limited] Usage limit reached.");
    expect(text).toContain("correction m2 was not delivered: [harness_rejected] The harness refused the message.");
    // 失败的运行已经带着同一段错误时，会话级的错误不再重复一遍。
    expect(text.match(/Usage limit reached/g)).toHaveLength(1);
    expect(text).toContain("Errors (2), newest first");
  });
});

// ───────────────────────── commands ─────────────────────────

describe("commands view", () => {
  it("lists shell commands with their outcome, numbered across the whole session", () => {
    const { text } = read(twoRuns(), { view: "commands" });
    expect(text).toContain("Shell commands: 4 in total — 2 ok, 1 failed, 1 not finished.");
    expect(text).toContain("  1. run 1 · ok · <1s · npm test");
    expect(text).toContain("  2. run 2 · failed (exit 2) · <1s · npm run build");
    expect(text).toContain("  3. run 2 · ok · <1s · npm test");
    expect(text).toContain("  4. run 2 · not finished · npm run lint");
    // 失败的命令带着错误文字与输出末尾。
    expect(text).toContain("       build exited with code 2");
    expect(text).toContain("       src/lexer.ts(9,2): error TS2322: Type mismatch.");
    // 编辑类的调用不是命令。
    expect(text).not.toContain("src/parser.ts");
  });

  it("keeps the numbering when only one run is shown", () => {
    const { text } = read(twoRuns(), { view: "commands", runIndex: 2 });
    expect(text).toContain("Shell commands in run 2: 3 in total — 1 ok, 1 failed, 1 not finished.");
    expect(text).toContain("  2. failed (exit 2) · <1s · npm run build");
    expect(text).toContain("  4. not finished · npm run lint");
    expect(text).not.toContain("  1. ");
    expect(text).not.toContain("run 2 ·");
  });

  it("reads the command out of JSON input, and falls back to the title when there is none", () => {
    const log = started();
    log.tool("r1", "c1", "completed", {
      title: "Bash",
      input: { text: JSON.stringify({ command: "pytest -x tests/", description: "run the tests" }), truncated: false, format: "json" },
      exitCode: 0,
    });
    log.tool("r1", "c2", "completed", { title: "dir C:\\work", exitCode: 0 });
    const { text } = read(log, { view: "commands" });
    expect(text).toContain("  1. ok · <1s · pytest -x tests/");
    expect(text).toContain("  2. ok · <1s · dir C:\\work");
    expect(text).not.toContain("description");
  });

  it("gives a long command more room than the transcript does, and says how much was cut", () => {
    const log = started();
    const command = `echo ${"x".repeat(700)}`;
    log.tool("r1", "c1", "completed", { title: "echo", input: cmd(command), exitCode: 0 });
    const { text } = read(log, { view: "commands" });
    expect(text).toContain(`  1. ok · <1s · echo ${"x".repeat(495)}… (+${command.length - 500} chars)`);
  });

  it("says so when the session ran no shell command", () => {
    const log = started();
    log.tool("r1", "c1", "completed", { name: "edit", category: "edit", title: "src/a.ts" });
    expect(read(log, { view: "commands" }).text).toContain("No shell command calls were recorded for this session.");
  });
});

// ───────────────────────── commands：汇总行与列表同出一次遍历 ─────────────────────────

describe("commands view: the summary counts the commands it lists", () => {
  it("counts ok, failed, cancelled and not finished commands, and agrees with the lines below it", () => {
    const log = started();
    log.tool("r1", "c1", "completed", { title: "npm test", input: cmd("npm test"), exitCode: 0 });
    log.tool("r1", "c2", "completed", { title: "grep needle", input: cmd("grep needle src"), exitCode: 1 });
    log.tool("r1", "c3", "completed", { title: "sleep 60", input: cmd("sleep 60"), status: "cancelled" });
    log.tool("r1", "c4", "running", { title: "npm run lint", input: cmd("npm run lint") });

    const { text } = read(log, { view: "commands" });

    expect(text).toContain("Shell commands: 4 in total — 1 ok, 1 failed, 1 cancelled, 1 not finished.");
    expect(text.match(/^ {2}\d+\. /gm)).toHaveLength(4);
    expect(text).toContain("  3. cancelled · <1s · sleep 60");
  });
});
