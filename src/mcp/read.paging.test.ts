import { describe, expect, it } from "vitest";
import { replay, toSummary } from "@shared/projection";
import type { SessionDetail } from "@shared/protocol";
import { EventLog } from "@shared/testing";
import type { Preview } from "@shared/types";
import { cursorLine, readOne, type DetailView, type ReadOutput } from "./read";

/**
 * `read` 增量读取（afterSeq）放不下时，read-page.ts 的 chooseStop 选“这一页的终点”。read.after-seq.test.ts 里的分页用例只看“游标连得上、一条不丢”，
 * 下面两条规则被改坏时它们不会变红，所以在这里单独钉住：
 * 1. 预算是闭区间：这一页的条目字数合计恰好等于预算，整页就放得下（二分里的 `<=`，改成 `<` 就会少放一条）；多一个字才放不下。
 * 2. 至少交出一条：afterSeq 之后头几件事不改变这个视角、紧接着的一条条目就比整个预算还大时，放得下的最大一页是空的；
 *    这时要找到第一个“有变化”的事件，把那一条单独交出来（第二段二分里的 `changed.length > 0`）——
 *    不能交一页空的，也不能（判断改成 `> 1` 之后）一口气交出后面所有的变化，超出预算。
 *
 * 条目的预算在 readOne 里是 Math.max(200, maxChars − 状态行 − 220)。maxChars 取 400：400 − 220 再减去状态行必定低于 200，
 * 预算恒为 200 的下限，与状态行有多长无关（取 500 的话，状态行不到 80 个字时预算会是 201 以上）。
 * 条目有几个字不靠心算：先用一次大预算的读取把每条命令的行量出来，再据此补足命令串的长度，让断言本身自洽。
 */

const BUDGET = 200;
const MAX_CHARS = 400;
const WIDE = 12_000;

const cmd = (text: string): Preview => ({ text, truncated: false, format: "text" });
const lastSeq = (log: EventLog): number => log.events[log.events.length - 1]!.seq;
const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

/** 一轮已经开始、还没有任何输出的会话（与 read.fixtures.ts 里的 started() 一样）；之后追加的事件序号依次是 lastSeq + 1、+ 2……。 */
function started(): EventLog {
  const log = new EventLog();
  log.created();
  log.message("m1", "task", "Work through the checklist");
  log.run("r1", 1, "m1");
  log.startRun("r1");
  return log;
}

function read(log: EventLog, view: DetailView, afterSeq: number, maxChars: number = MAX_CHARS): ReadOutput {
  const state = replay(log.events);
  if (!state) throw new Error("replay failed");
  const detail: SessionDetail = { summary: toSummary(state), events: log.events };
  return readOne(detail, state, { kind: "one", sessionId: detail.summary.id, view, maxChars, includeReasoning: false, afterSeq }, Date.parse(log.now()) + 5_000);
}

/** 输出里状态行（只有一行）之后的部分：标题、条目、“还有几条”和游标。 */
const rest = (output: ReadOutput): string[] => output.text.split("\n").slice(1);

// ───────────────────────── 预算是闭区间 ─────────────────────────

/** 一条命令的条目在 pageSince 里占的字数（排好版的一行，加一个换行）。从真正读出来的文字里量：序号、结局、耗时与分隔符各占几个字不靠心算。 */
function cost(text: string, number: number): number {
  const row = text.split("\n").find((line) => line.startsWith(`  ${number}. `));
  if (row === undefined) throw new Error(`command ${number} is not listed in:\n${text}`);
  return row.length + 1;
}

/** 命令各由一个 tool.updated 事件产生。cursor 是第一条命令之前的事件序号；costs 是各条命令的条目占的字数。 */
function commandLog(commands: readonly string[]): { log: EventLog; cursor: number; costs: number[] } {
  const log = started();
  const cursor = lastSeq(log);
  commands.forEach((command, index) => {
    log.tool("r1", `c${index + 1}`, "completed", { title: `step ${index + 1}`, input: cmd(command), exitCode: 0 });
  });
  const wide = read(log, "commands", cursor, WIDE).text;
  return { log, cursor, costs: commands.map((_, index) => cost(wide, index + 1)) };
}

/** 一对命令串，让它们的两个条目合计恰好占 `total` 个字：命令串之外的部分用一条一个字的命令量出来，剩下的字数平分给两条。 */
function pairTaking(total: number): [string, string] {
  const placeholder = "x";
  const fixed = commandLog([placeholder]).costs[0]! - placeholder.length;
  const room = total - 2 * fixed;
  const first = Math.floor(room / 2);
  return ["a".repeat(first), "b".repeat(room - first)];
}

const THIRD = "c".repeat(40);

describe("afterSeq paging: the budget is a closed interval", () => {
  it("takes both entries when they add up to exactly the budget, and leaves the third for the next page", () => {
    const [first, second] = pairTaking(BUDGET);
    const { log, cursor, costs } = commandLog([first, second, THIRD]);
    // 前提：前两条合计恰好等于预算，三条一起放不下。
    expect(sum(costs.slice(0, 2))).toBe(BUDGET);
    expect(sum(costs)).toBeGreaterThan(BUDGET);

    const page = read(log, "commands", cursor);
    expect(rest(page)).toEqual([
      `Since #${cursor} — 2 new or updated commands (events #${cursor + 1}–#${cursor + 2}):`,
      `  1. ok · <1s · ${first}`,
      `  2. ok · <1s · ${second}`,
      `(1 more command not shown to fit maxChars=${MAX_CHARS}.)`,
      cursorLine(cursor + 2, true),
    ]);
    expect(page.seq).toBe(cursor + 2);
    expect(page.remaining).toBe(1);

    const next = read(log, "commands", page.seq);
    expect(rest(next)).toEqual([
      `Since #${page.seq} — 1 new or updated command (event #${cursor + 3}):`,
      `  3. ok · <1s · ${THIRD}`,
      cursorLine(cursor + 3, false),
    ]);
    expect(next.seq).toBe(lastSeq(log));
    expect(next.remaining).toBeUndefined();
  });

  it("leaves out the second entry when the two would be one character over the budget", () => {
    const [first, second] = pairTaking(BUDGET + 1);
    const { log, cursor, costs } = commandLog([first, second, THIRD]);
    expect(sum(costs.slice(0, 2))).toBe(BUDGET + 1);

    const page = read(log, "commands", cursor);
    expect(rest(page)).toEqual([
      `Since #${cursor} — 1 new or updated command (event #${cursor + 1}):`,
      `  1. ok · <1s · ${first}`,
      `(2 more commands not shown to fit maxChars=${MAX_CHARS}.)`,
      cursorLine(cursor + 1, true),
    ]);
    expect(page.seq).toBe(cursor + 1);
    expect(page.remaining).toBe(2);

    const next = read(log, "commands", page.seq);
    expect(rest(next)).toEqual([
      `Since #${page.seq} — 2 new or updated commands (events #${cursor + 2}–#${cursor + 3}):`,
      `  2. ok · <1s · ${second}`,
      `  3. ok · <1s · ${THIRD}`,
      cursorLine(cursor + 3, false),
    ]);
    expect(next.seq).toBe(lastSeq(log));
    expect(next.remaining).toBeUndefined();
  });

  it("does not split a page when everything adds up to exactly the budget", () => {
    const [first, second] = pairTaking(BUDGET);
    const { log, cursor, costs } = commandLog([first, second]);
    expect(sum(costs)).toBe(BUDGET);

    const page = read(log, "commands", cursor);
    expect(rest(page)).toEqual([
      `Since #${cursor} — 2 new or updated commands (events #${cursor + 1}–#${cursor + 2}):`,
      `  1. ok · <1s · ${first}`,
      `  2. ok · <1s · ${second}`,
      cursorLine(cursor + 2, false),
    ]);
    expect(page.seq).toBe(lastSeq(log));
    expect(page.remaining).toBeUndefined();
  });
});

// ───────────────────────── 至少交出一条 ─────────────────────────

const LONG = `long ${"x".repeat(600)}`;
const SHORT = [2, 3, 4].map((n) => `short ${n} ${"s".repeat(40)}`);

/**
 * afterSeq 之后依次是：`quiet` 件不改变转录的事（usage.updated 只记用量，不进时间线）、一条比整个预算大得多的助手文字、三条短的。
 * 文字都是由一个 assistant.completed 带着全文一次给出的，同一条目不会在两个时刻有不同的文字，“还剩几条”只数没给出的那几条。
 */
function longAfterQuiet(quiet: number): { log: EventLog; cursor: number } {
  const log = started();
  const cursor = lastSeq(log);
  for (let i = 0; i < quiet; i++) {
    log.push({ kind: "usage.updated", data: { usage: { totalTokens: 10 + i } } }, { runId: "r1" });
  }
  [LONG, ...SHORT].forEach((text, index) => {
    log.push({ kind: "assistant.completed", data: { itemId: `a${index + 1}`, text, phase: "final" } }, { runId: "r1" });
  });
  return { log, cursor };
}

describe("afterSeq paging: a page always carries at least one entry", () => {
  it.each([1, 3, 6])(
    "hands over the first entry that changes the view, alone, when it is bigger than the whole budget and %d event(s) that change nothing come first",
    (quiet) => {
      const { log, cursor } = longAfterQuiet(quiet);
      const at = cursor + quiet + 1; // 带着长文字的那个事件
      // 前提：大预算读一次，四条助手文字就是全部的新条目——那几件事确实没有改变转录。
      expect(rest(read(log, "transcript", cursor, WIDE))[0]).toBe(`Since #${cursor} — 4 new or updated entries (events #${cursor + 1}–#${at + 3}):`);

      const page = read(log, "transcript", cursor);
      expect(rest(page)).toEqual([
        `Since #${cursor} — 1 new or updated entry (events #${cursor + 1}–#${at}):`,
        `Pi: ${LONG}`,
        `(3 more entries not shown to fit maxChars=${MAX_CHARS}.)`,
        cursorLine(at, true),
      ]);
      expect(page.seq).toBe(at);
      expect(page.remaining).toBe(3);

      const next = read(log, "transcript", page.seq);
      expect(rest(next)).toEqual([
        `Since #${at} — 3 new or updated entries (events #${at + 1}–#${at + 3}):`,
        ...SHORT.map((text) => `Pi: ${text}`),
        cursorLine(at + 3, false),
      ]);
      expect(next.seq).toBe(lastSeq(log));
      expect(next.remaining).toBeUndefined();
    },
  );
});
