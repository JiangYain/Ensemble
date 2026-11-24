import { describe, expect, it } from "vitest";
import type { EventLog } from "@shared/testing";
import { cursorLine, ReadInputError, type ReadOutput } from "./read";
import { cmd, out, read, started, twoRuns } from "./read.fixtures";

/**
 * `read` 的增量读取（afterSeq）：只读游标之后的新进展，没有新进展时怎么说，游标超前时拒绝，放不下预算时怎样分页而不丢不重、还剩几条。
 * 放不下时“这一页停在哪”的边界规则（预算是闭区间、至少交出一条）另在 read.paging.test.ts 里逐条钉住。
 */

const lastSeq = (log: EventLog): number => log.events[log.events.length - 1]!.seq;

// ───────────────────────── afterSeq ─────────────────────────

describe("afterSeq", () => {
  it("answers with one line and the status line when nothing happened since", () => {
    const log = started();
    log.tool("r1", "c1", "completed", { title: "npm test", input: cmd("npm test"), exitCode: 0 });
    const latest = lastSeq(log);
    const result = read(log, { view: "commands", afterSeq: latest });
    const lines = result.text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(`No new events since #${latest}.`);
    expect(lines[1]).toMatch(/^• ses_test \[Pi\] /);
    expect(result.seq).toBe(latest);
    expect(result.remaining).toBeUndefined();
  });

  it("refuses a cursor beyond the latest event instead of treating it as zero", () => {
    const log = started();
    const latest = lastSeq(log);
    expect(() => read(log, { afterSeq: latest + 1 })).toThrow(new RegExp(`afterSeq ${latest + 1} is beyond the latest event of session ses_test \\(#${latest}\\)`));
    expect(() => read(log, { view: "errors", afterSeq: latest + 40 })).toThrow(ReadInputError);
  });

  it("returns only what is new, and hands back the cursor to continue from", () => {
    const log = started();
    log.tool("r1", "c1", "completed", { title: "npm test", input: cmd("npm test"), exitCode: 0 });
    const cursor = lastSeq(log);
    log.tool("r1", "c2", "completed", { title: "npm run lint", input: cmd("npm run lint"), exitCode: 0 });
    const latest = lastSeq(log);

    const page = read(log, { view: "commands", afterSeq: cursor });
    expect(page.text).toContain(`Since #${cursor} — 1 new or updated command (event #${latest}):`);
    expect(page.text).toContain("  2. ok · <1s · npm run lint");
    expect(page.text).not.toContain("npm test");
    expect(page.text).not.toContain("[updated]");
    expect(page.text.endsWith(cursorLine(latest, false))).toBe(true);
    expect(page.seq).toBe(latest);
  });

  it("shows an earlier item again, with its latest state, when it was updated after the cursor", () => {
    const log = started();
    log.tool("r1", "c1", "running", { title: "npm run lint", input: cmd("npm run lint") });
    const cursor = lastSeq(log);
    log.tool("r1", "c1", "completed", { title: "npm run lint", exitCode: 0 });

    const page = read(log, { view: "commands", afterSeq: cursor });
    expect(page.text).toContain("  1. ok · <1s · npm run lint [updated]");
    expect(page.text).toContain("1 new or updated command");
  });

  it("flags text that is still being written, and shows it again once it is finished", () => {
    const log = started();
    const cursor = lastSeq(log);
    log.push({ kind: "assistant.delta", data: { itemId: "a1", text: "Checking the lexer", phase: "commentary" } }, { runId: "r1" });

    const open = read(log, { view: "transcript", afterSeq: cursor });
    expect(open.text).toContain("Pi (commentary): Checking the lexer  [still being written]");

    log.push({ kind: "assistant.completed", data: { itemId: "a1", phase: "commentary" } }, { runId: "r1" });
    const closed = read(log, { view: "transcript", afterSeq: open.seq });
    expect(closed.text).toContain("Pi (commentary): Checking the lexer [updated]");
    expect(closed.text).not.toContain("still being written");
  });

  it("says when new events arrived but none of them changes the view asked for", () => {
    const log = started();
    log.tool("r1", "c1", "completed", { title: "npm test", input: cmd("npm test"), exitCode: 0 });
    const cursor = lastSeq(log);
    log.push({ kind: "usage.updated", data: { usage: { totalTokens: 10 } } }, { runId: "r1" });

    const page = read(log, { view: "commands", afterSeq: cursor });
    expect(page.text).toContain(`No new commands since #${cursor} (event #${cursor + 1} arrived, but none of them changes this view).`);
    expect(page.seq).toBe(cursor + 1);
  });

  it("starts from the beginning with afterSeq 0", () => {
    const page = read(twoRuns(), { view: "commands", afterSeq: 0 });
    expect(page.text).toMatch(/Since #0 — 4 new or updated commands \(events #1–#\d+\):/);
    expect(page.text).not.toContain("[updated]");
  });

  it("lists new errors oldest first, and does not count the unfinished-tools note as an error", () => {
    const page = read(twoRuns(), { view: "errors", afterSeq: 0 });
    expect(page.text).toMatch(/Since #0 — 2 new or updated errors \(events #1–#\d+\), oldest first:/);
    expect(page.text.indexOf("tool failed")).toBeLessThan(page.text.indexOf("note [warn]"));
    expect(page.text).toContain("Not counted above: 1 tool call never reported an end event");
  });

  it("shows only the errors that happened after the cursor", () => {
    const log = started();
    log.tool("r1", "c1", "failed", { title: "first failure", input: cmd("first"), exitCode: 1, error: "first went wrong" });
    const cursor = lastSeq(log);
    log.tool("r1", "c2", "failed", { title: "second failure", input: cmd("second"), exitCode: 3, error: "second went wrong" });
    const { text } = read(log, { view: "errors", afterSeq: cursor });
    expect(text).toContain("1 new or updated error (event #");
    expect(text).toContain("second failure");
    expect(text).not.toContain("first failure");
  });

  it("gives the result view a count of new events instead of a different layout", () => {
    const log = started();
    log.tool("r1", "c1", "completed", { title: "npm test", input: cmd("npm test"), exitCode: 0 });
    const cursor = lastSeq(log);
    log.tool("r1", "c2", "completed", { title: "npm run lint", input: cmd("npm run lint"), exitCode: 0 });
    log.push({ kind: "usage.updated", data: { usage: { totalTokens: 10 } } }, { runId: "r1" });
    const page = read(log, { afterSeq: cursor });
    expect(page.text).toContain(`\n2 new events since #${cursor}.\n`);
    expect(page.text.endsWith(cursorLine(lastSeq(log), false))).toBe(true);
  });

  describe("when the new entries do not fit the budget", () => {
    const manyCommands = (): { log: EventLog; cursor: number } => {
      const log = started();
      const cursor = lastSeq(log);
      for (let i = 1; i <= 12; i++) {
        log.tool("r1", `c${i}`, "completed", { title: `step ${i}`, input: cmd(`npm run step-${i} -- --flag-with-a-fairly-long-name`), exitCode: 0 });
      }
      log.push({ kind: "run.completed", data: {} }, { runId: "r1" });
      return { log, cursor };
    };

    it("keeps the earliest entries, says how many are not shown, and gives a cursor that continues without gaps or repeats", () => {
      const { log, cursor } = manyCommands();
      const seen: number[] = [];
      const pages: ReadOutput[] = [];
      let after = cursor;
      for (let turn = 0; turn < 30; turn++) {
        const page = read(log, { view: "commands", afterSeq: after, maxChars: 500 });
        if (page.text.startsWith("No new events since")) break;
        pages.push(page);
        for (const match of page.text.matchAll(/^ {2}(\d+)\. /gm)) seen.push(Number(match[1]));
        // 游标只会前进。
        expect(page.seq).toBeGreaterThan(after);
        after = page.seq;
      }

      expect(seen).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
      expect(pages.length).toBeGreaterThan(2);

      const first = pages[0]!;
      expect(first.remaining).toBeGreaterThan(0);
      expect(first.text).toMatch(/\(\d+ more commands? not shown to fit maxChars=500\.\)/);
      expect(first.text.endsWith(cursorLine(first.seq, true))).toBe(true);
      expect(first.text).toContain("  1. ");

      const last = pages[pages.length - 1]!;
      expect(last.remaining).toBeUndefined();
      expect(last.text.endsWith(cursorLine(last.seq, false))).toBe(true);
      expect(last.seq).toBe(lastSeq(log));
    });

    it("still hands over a single entry that is bigger than the whole budget, so the cursor always moves", () => {
      const log = started();
      const cursor = lastSeq(log);
      log.tool("r1", "c1", "failed", { title: "huge", input: cmd("huge"), exitCode: 1, output: out(Array.from({ length: 6 }, (_, i) => `line ${i} ${"y".repeat(230)}`).join("\n")) });
      log.tool("r1", "c2", "failed", { title: "second", input: cmd("second"), exitCode: 1, output: out("z".repeat(200)) });
      const page = read(log, { view: "commands", afterSeq: cursor, maxChars: 500 });
      expect(page.text).toContain("  1. failed (exit 1) · <1s · huge");
      expect(page.seq).toBeGreaterThan(cursor);
    });
  });
});

// ───────────────────────── afterSeq 分页：还剩几条 ─────────────────────────

describe("afterSeq paging: what is left", () => {
  it("states exactly how many entries the following pages still have to give", () => {
    const total = 12;
    const log = started();
    const cursor = lastSeq(log);
    for (let i = 1; i <= total; i++) {
      log.tool("r1", `c${i}`, "completed", { title: `step ${i}`, input: cmd(`npm run step-${i} -- --flag-with-a-fairly-long-name`), exitCode: 0 });
    }
    log.push({ kind: "run.completed", data: {} }, { runId: "r1" });

    let after = cursor;
    let seen = 0;
    for (let turn = 0; turn < 30; turn++) {
      const page = read(log, { view: "commands", afterSeq: after, maxChars: 500 });
      if (page.text.startsWith("No new events since")) break;
      seen += [...page.text.matchAll(/^ {2}(\d+)\. /gm)].length;
      expect(page.remaining ?? 0).toBe(total - seen);
      after = page.seq;
    }
    expect(seen).toBe(total);
  });
});
