import { describe, expect, it } from "vitest";
import { replay, toSummary, type SessionState } from "@shared/projection";
import type { SessionDetail } from "@shared/protocol";
import { EventLog } from "@shared/testing";
import type { Preview } from "@shared/types";
import { renderResult, renderTranscript } from "./format";
import { readOne, renderBatch, type BatchOutcome } from "./read";

/**
 * MCP 输出里的截断点不能把 emoji（UTF-16 里是一对代理项）切成两半：
 * `result` 视图的回答、`transcript` 里每段回答、`commands` 视图里的命令原文、批量读取里的结论，各有一处。
 * 同时核对“还剩多少字符”这个数是按实际没显示的算出来的。
 */

/** 孤立的代理项：高位后面不是低位，或低位前面不是高位。不带 u 标志，按码元匹配。 */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** 😀 在 UTF-16 里是 D83D DE00 两个码元。 */
const EMOJI = "\u{1F600}";

const cmd = (text: string): Preview => ({ text, truncated: false, format: "text" });

interface Built {
  log: EventLog;
  state: SessionState;
  detail: SessionDetail;
}

function snapshot(log: EventLog): Built {
  const state = replay(log.events);
  if (!state) throw new Error("replay failed");
  return { log, state, detail: { summary: toSummary(state), events: log.events } };
}

/** 一轮已经开始、还没有任何输出的会话。 */
function started(): EventLog {
  const log = new EventLog();
  log.created();
  log.message("m1", "task", "Work through the checklist");
  log.run("r1", 1, "m1");
  log.startRun("r1");
  return log;
}

/** 一轮已经结束、给出了最终回答的会话（回答原文就是 `answer`）。 */
function finishedWith(answer: string): EventLog {
  const log = new EventLog("ses_e");
  log.created({ title: "Emoji job" });
  log.message("m1", "task", "Write the report");
  log.run("r1", 1, "m1");
  log.startRun("r1");
  log.push({ kind: "assistant.delta", data: { itemId: "a1", text: answer, phase: "final" } }, { runId: "r1" });
  log.push({ kind: "assistant.completed", data: { itemId: "a1", phase: "final" } }, { runId: "r1" });
  log.push({ kind: "run.completed", data: {} }, { runId: "r1" });
  return log;
}

const outcome = (log: EventLog): BatchOutcome => ({ id: log.sessionId, detail: snapshot(log).detail });

describe("result view", () => {
  const more = 'use view="transcript" for the full record';

  it("does not leave half an emoji at the cut, and counts what was really left out", () => {
    // maxChars 1000 → 回答预算 400 个码元；下标 399 是第一个 emoji 的高位代理，在 400 处一刀下去会切开它。
    const answer = `${"a".repeat(399)}${EMOJI.repeat(300)}`;
    const { state } = snapshot(finishedWith(answer));
    const text = renderResult(state, toSummary(state), { maxChars: 1000 });
    // 留下 399 个码元；总长 999，没显示的是 600 个（含让出去的那半个字符）。
    expect(text).toContain(`${"a".repeat(399)}\n… (600 more characters; ${more})`);
    expect(LONE.test(text)).toBe(false);
  });

  it("cuts exactly where it always did when the cut falls between two emoji", () => {
    const answer = `${"a".repeat(400)}${EMOJI.repeat(300)}`;
    const { state } = snapshot(finishedWith(answer));
    const text = renderResult(state, toSummary(state), { maxChars: 1000 });
    expect(text).toContain(`${"a".repeat(400)}\n… (600 more characters; ${more})`);
    expect(LONE.test(text)).toBe(false);
  });
});

describe("transcript view", () => {
  it("clips a long assistant message at 1500 characters without splitting an emoji", () => {
    // 下标 1498 是 emoji 的高位代理，留 1499 个码元（1500 减去省略号）会切开它。
    const answer = `${"a".repeat(1498)}${EMOJI.repeat(100)}`;
    const { state } = snapshot(finishedWith(answer));
    const text = renderTranscript(state, toSummary(state), { maxChars: 8000 });
    expect(text).toContain(`Pi: ${"a".repeat(1498)}…`);
    expect(LONE.test(text)).toBe(false);
  });
});

describe("commands view", () => {
  it("does not split an emoji at the 500-character cut of a long command, and counts the characters left out", () => {
    const log = started();
    // "echo " 之后 494 个 x，下标 499 是 emoji 的高位代理，留 500 个码元会切开它；留下 499 个，总长 601，所以是 +102。
    const command = `echo ${"x".repeat(494)}${EMOJI}${"y".repeat(100)}`;
    log.tool("r1", "c1", "completed", { title: "echo", input: cmd(command), exitCode: 0 });
    const { detail, state } = snapshot(log);
    const at = Date.parse(log.now()) + 5_000;
    const { text } = readOne(detail, state, { kind: "one", sessionId: detail.summary.id, view: "commands", maxChars: 12_000, includeReasoning: false }, at);
    expect(text).toContain(`  1. ok · <1s · echo ${"x".repeat(494)}… (+102 chars)`);
    expect(LONE.test(text)).toBe(false);
  });
});

describe("batch read", () => {
  const now = Date.parse("2026-01-01T00:10:00.000Z");

  it("cuts a conclusion without splitting an emoji wherever the cut falls, and states the number really left out", () => {
    // 结论前面垫 0 到 3 个普通字符，让最终的截点在“一对的中间”与“两对之间”两种位置上都出现：
    // 截点的位置只由预算决定，与回答自己无关，所以奇偶不同的垫法里至少有一种会切在一对中间。
    for (let lead = 0; lead < 4; lead++) {
      const answer = `${"b".repeat(lead)}${EMOJI.repeat(1500)}`;
      const { text } = renderBatch([outcome(finishedWith(answer))], { maxChars: 2000, now });
      const label = `lead=${lead}`;
      const match = / {4}conclusion:\n {6}([^\n]*)\n {6}… \((\d+) more characters; read ses_e on its own/.exec(text);
      if (!match) throw new Error(`the conclusion was not cut (${label}):\n${text}`);
      const kept = match[1] ?? "";
      expect(LONE.test(text), label).toBe(false);
      expect(kept.length, label).toBeGreaterThan(100);
      expect(answer.startsWith(kept), label).toBe(true);
      expect(Number(match[2]), label).toBe(answer.length - kept.length);
    }
  });
});
