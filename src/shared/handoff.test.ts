import { describe, expect, it } from "vitest";
import {
  cutHead,
  DEFAULT_HANDOFF_PARTS,
  extractHandoff,
  handedOverText,
  hasSessionRefs,
  normalizeParts,
  requestedContext,
  type HandoffPart,
  type HandoffSample,
  type SessionContextItem,
} from "./handoff";
import { changed, fail, finish, say, startRun } from "./handoff.fixtures";
import { EventLog } from "./testing";
import type { ContextItem } from "./types";

function sample(over: Partial<HandoffSample> = {}): HandoffSample {
  return { at: "2026-01-02T03:04:05.000Z", title: "Upstream", harness: "codex", phase: "done", runCount: 1, ...over };
}

describe("extractHandoff：最终回答", () => {
  it("同一条文字的增量按顺序拼接，原文不裁剪、不改写", () => {
    const log = new EventLog();
    log.created();
    startRun(log, "run_1", 1);
    log.push({ kind: "assistant.delta", data: { itemId: "a", text: "Line one\n", phase: "final" } }, { runId: "run_1" });
    log.push({ kind: "assistant.delta", data: { itemId: "a", text: "  Line two  \n" } }, { runId: "run_1" });
    log.push({ kind: "assistant.completed", data: { itemId: "a" } }, { runId: "run_1" });
    finish(log, "run_1");

    expect(extractHandoff(log.events)).toEqual({
      runs: [{ index: 1, status: "completed" }],
      answer: { found: true, label: "final", runIndex: 1, text: "Line one\n  Line two  \n" },
      files: [],
      failure: undefined,
    });
  });

  it("执行端的 itemId 每次运行都从头编号，两次运行的文字互不串（投影会把它们并成一条）", () => {
    const log = new EventLog();
    log.created();
    startRun(log, "run_1", 1);
    say(log, "run_1", "item_0", "First run answer", "final");
    finish(log, "run_1");
    startRun(log, "run_2", 2);
    say(log, "run_2", "item_0", "Second run answer", "final");
    finish(log, "run_2");

    expect(extractHandoff(log.events).answer).toEqual({ found: true, label: "final", runIndex: 2, text: "Second run answer" });
  });

  it("同一次运行里 itemId 被复用：结束过的条目之后再来的增量是新的一条，取最后一条", () => {
    const log = new EventLog();
    log.created();
    startRun(log, "run_1", 1);
    say(log, "run_1", "item_0", "Early", "final");
    say(log, "run_1", "item_0", "Late", "final");
    finish(log, "run_1");

    expect(extractHandoff(log.events).answer).toEqual({ found: true, label: "final", runIndex: 1, text: "Late" });
  });

  it("completed 自带的完整文本优先于拼出来的；Claude 收尾时的二次完整文本继续更正同一条", () => {
    const log = new EventLog();
    log.created();
    startRun(log, "run_1", 1);
    log.push({ kind: "assistant.delta", data: { itemId: "m", text: "Hel" } }, { runId: "run_1" });
    log.push({ kind: "assistant.delta", data: { itemId: "m", text: "lo" } }, { runId: "run_1" });
    log.push({ kind: "assistant.completed", data: { itemId: "m", text: "Hello" } }, { runId: "run_1" });
    log.push({ kind: "assistant.completed", data: { itemId: "m", text: "Hello, world" } }, { runId: "run_1" });
    finish(log, "run_1");

    expect(extractHandoff(log.events).answer).toEqual({ found: true, label: "unlabeled", runIndex: 1, text: "Hello, world" });
  });

  it("completed 带的只有空白时不覆盖已经拼出来的文字", () => {
    const log = new EventLog();
    log.created();
    startRun(log, "run_1", 1);
    log.push({ kind: "assistant.delta", data: { itemId: "m", text: "Keep me", phase: "final" } }, { runId: "run_1" });
    log.push({ kind: "assistant.completed", data: { itemId: "m", text: "  \n" } }, { runId: "run_1" });
    finish(log, "run_1");

    expect(extractHandoff(log.events).answer).toMatchObject({ found: true, text: "Keep me" });
  });

  it("运行结束后补发的、只带 phase 的 completed 更正那一条的标记，而不是新开一条", () => {
    const log = new EventLog();
    log.created();
    startRun(log, "run_1", 1);
    log.push({ kind: "assistant.delta", data: { itemId: "m", text: "The answer" } }, { runId: "run_1" });
    log.push({ kind: "assistant.completed", data: { itemId: "m" } }, { runId: "run_1" });
    finish(log, "run_1");
    expect(extractHandoff(log.events).answer).toEqual({ found: true, label: "unlabeled", runIndex: 1, text: "The answer" });

    log.push({ kind: "assistant.completed", data: { itemId: "m", phase: "final" } }, { runId: "run_1" });
    expect(extractHandoff(log.events).answer).toEqual({ found: true, label: "final", runIndex: 1, text: "The answer" });
  });

  it("final 比同一次运行里更晚的过程说明和未标记文字优先", () => {
    const log = new EventLog();
    log.created();
    startRun(log, "run_1", 1);
    say(log, "run_1", "i1", "Result", "final");
    say(log, "run_1", "i2", "Wrapping up", "commentary");
    say(log, "run_1", "i3", "Trailing note");
    finish(log, "run_1");

    expect(extractHandoff(log.events).answer).toEqual({ found: true, label: "final", runIndex: 1, text: "Result" });
  });

  it("执行端不标 phase 时取最后一段未标记的文字，并如实标成 unlabeled；过程说明不会被当成结果", () => {
    const log = new EventLog();
    log.created();
    startRun(log, "run_1", 1);
    say(log, "run_1", "i1", "Looking at the code", "commentary");
    say(log, "run_1", "i2", "Done.");
    say(log, "run_1", "i3", "Now checking the tests", "commentary");
    finish(log, "run_1");

    expect(extractHandoff(log.events).answer).toEqual({ found: true, label: "unlabeled", runIndex: 1, text: "Done." });
  });

  it("只有过程说明时不退回任意一条文字，而是说明原因", () => {
    const log = new EventLog();
    log.created();
    startRun(log, "run_1", 1);
    say(log, "run_1", "i1", "Looking at the code", "commentary");
    finish(log, "run_1");

    expect(extractHandoff(log.events).answer).toEqual({ found: false, reason: "no_final" });
  });

  it("最新一次运行没有可取的就退回更早的，并说明跳过的是哪一次、它怎么结束的", () => {
    const log = new EventLog();
    log.created();
    startRun(log, "run_1", 1);
    say(log, "run_1", "item_0", "A", "final");
    finish(log, "run_1");
    startRun(log, "run_2", 2);
    say(log, "run_2", "item_0", "Trying again", "commentary");
    fail(log, "run_2", "executor_exit", "Process exited with code 1");

    expect(extractHandoff(log.events).answer).toEqual({
      found: true,
      label: "final",
      runIndex: 1,
      text: "A",
      latest: { index: 2, status: "failed" },
    });
  });

  it("更早的运行有 final、更晚的只有未标记文字：final 优先，同样说明跳过了最新一次", () => {
    const log = new EventLog();
    log.created();
    startRun(log, "run_1", 1);
    say(log, "run_1", "item_0", "Proper answer", "final");
    finish(log, "run_1");
    startRun(log, "run_2", 2);
    say(log, "run_2", "item_0", "Some later chatter");
    finish(log, "run_2");

    expect(extractHandoff(log.events).answer).toEqual({
      found: true,
      label: "final",
      runIndex: 1,
      text: "Proper answer",
      latest: { index: 2, status: "completed" },
    });
  });

  it("按运行序号而不是到达先后选取", () => {
    const log = new EventLog();
    log.created();
    // 序号 2 的运行先排队、先出文字；序号 1 的后到。
    log.message("msg_b", "follow_up", "b");
    log.run("run_b", 2, "msg_b", "follow_up");
    log.startRun("run_b");
    say(log, "run_b", "item_0", "From run two", "final");
    log.message("msg_a", "task", "a");
    log.run("run_a", 1, "msg_a", "task");
    log.startRun("run_a");
    say(log, "run_a", "item_0", "From run one", "final");

    const out = extractHandoff(log.events);
    expect(out.answer).toEqual({ found: true, label: "final", runIndex: 2, text: "From run two" });
    expect(out.runs.map((run) => run.index)).toEqual([1, 2]);
  });

  it("没有任何运行：no_runs", () => {
    const log = new EventLog();
    log.created();

    expect(extractHandoff(log.events)).toEqual({ runs: [], answer: { found: false, reason: "no_runs" }, files: [], failure: undefined });
  });

  it("有运行但没有任何文字：no_text；空白文字、没有 runId 的文字、认不出属于哪次运行的文字都不算", () => {
    const log = new EventLog();
    log.created();
    startRun(log, "run_1", 1);
    say(log, "run_1", "blank", "   \n", "final");
    log.push({ kind: "assistant.delta", data: { itemId: "orphan", text: "No run was active", phase: "final" } });
    say(log, "run_ghost", "ghost", "A run nobody queued", "final");
    finish(log, "run_1");

    expect(extractHandoff(log.events).answer).toEqual({ found: false, reason: "no_text" });
  });
});

describe("extractHandoff：运行状态", () => {
  it("状态随事件推进，以第一个终态事件为准", () => {
    const log = new EventLog();
    log.created();
    log.message("msg_1", "task", "go");
    log.run("run_1", 1, "msg_1");
    expect(extractHandoff(log.events).runs).toEqual([{ index: 1, status: "queued" }]);

    log.push({ kind: "run.starting", data: {} }, { runId: "run_1" });
    expect(extractHandoff(log.events).runs).toEqual([{ index: 1, status: "starting" }]);

    log.startRun("run_1");
    expect(extractHandoff(log.events).runs).toEqual([{ index: 1, status: "running" }]);

    finish(log, "run_1");
    expect(extractHandoff(log.events).runs).toEqual([{ index: 1, status: "completed" }]);

    // 终态之后再来的失败不改状态，也不算一条失败记录。
    fail(log, "run_1", "late", "Too late");
    const out = extractHandoff(log.events);
    expect(out.runs).toEqual([{ index: 1, status: "completed" }]);
    expect(out.failure).toBeUndefined();
  });

  it("被取消的运行记成 cancelled；终态事件认不出属于哪次运行时忽略，不抛错", () => {
    const log = new EventLog();
    log.created();
    startRun(log, "run_1", 1);
    log.push({ kind: "run.cancelled", data: {} }, { runId: "run_1" });
    finish(log, "run_ghost");
    log.push({ kind: "run.completed", data: {} });

    expect(extractHandoff(log.events).runs).toEqual([{ index: 1, status: "cancelled" }]);
  });
});

describe("extractHandoff：改动过的文件", () => {
  it("所有运行的 file.changed 取并集，按路径去重：顺序是第一次出现的先后，类型是最后一次上报的", () => {
    const log = new EventLog();
    log.created();
    startRun(log, "run_1", 1);
    changed(log, "run_1", [["src/a.ts", "created"], ["src/b.ts", "modified"]]);
    finish(log, "run_1");
    startRun(log, "run_2", 2);
    changed(log, "run_2", [["src/b.ts", "deleted"], ["src/c.ts", "modified"]]);
    changed(log, "run_2", [["src/a.ts", "modified"]]);
    finish(log, "run_2");

    expect(extractHandoff(log.events).files).toEqual([
      { path: "src/a.ts", change: "modified" },
      { path: "src/b.ts", change: "deleted" },
      { path: "src/c.ts", change: "modified" },
    ]);
  });

  it("没有路径的条目不计入；没有任何文件事件就是空清单", () => {
    const log = new EventLog();
    log.created();
    startRun(log, "run_1", 1);
    expect(extractHandoff(log.events).files).toEqual([]);

    changed(log, "run_1", [["", "modified"], ["src/x.ts", "created"]]);
    expect(extractHandoff(log.events).files).toEqual([{ path: "src/x.ts", change: "created" }]);
  });
});

describe("extractHandoff：最后一次失败", () => {
  it("取失败记录原样的错误码与消息，带上是第几次运行；执行端的原始 detail 不进来", () => {
    const log = new EventLog();
    log.created();
    startRun(log, "run_1", 1);
    fail(log, "run_1", "executor_exit", "Process exited with code 1", "stack trace that must stay out");

    const out = extractHandoff(log.events);
    expect(out.runs).toEqual([{ index: 1, status: "failed" }]);
    expect(out.failure).toStrictEqual({ code: "executor_exit", message: "Process exited with code 1", runIndex: 1 });
  });

  it("多次失败取最后一次；后面的运行成功了也不抹掉更早的失败记录", () => {
    const log = new EventLog();
    log.created();
    startRun(log, "run_1", 1);
    fail(log, "run_1", "first_code", "first");
    startRun(log, "run_2", 2);
    fail(log, "run_2", "second_code", "second");
    expect(extractHandoff(log.events).failure).toStrictEqual({ code: "second_code", message: "second", runIndex: 2 });

    startRun(log, "run_3", 3);
    finish(log, "run_3");
    expect(extractHandoff(log.events).failure).toStrictEqual({ code: "second_code", message: "second", runIndex: 2 });
  });

  it("会话级的失败与某次运行的失败原因完全相同时，算在那次运行头上", () => {
    const log = new EventLog();
    log.created();
    startRun(log, "run_1", 1);
    fail(log, "run_1", "x", "boom");
    log.push({ kind: "session.status", data: { status: "failed", error: { code: "x", message: "boom" } } });

    expect(extractHandoff(log.events).failure).toStrictEqual({ code: "x", message: "boom", runIndex: 1 });
  });

  it("没有对应运行的会话级失败如实不带运行序号；码相同但消息不同也不硬认", () => {
    const only = new EventLog();
    only.created();
    only.push({ kind: "session.status", data: { status: "failed", error: { code: "spawn_failed", message: "Executor did not start" } } });
    expect(extractHandoff(only.events).failure).toStrictEqual({ code: "spawn_failed", message: "Executor did not start" });

    const mismatch = new EventLog();
    mismatch.created();
    startRun(mismatch, "run_1", 1);
    fail(mismatch, "run_1", "x", "a");
    mismatch.push({ kind: "session.status", data: { status: "failed", error: { code: "x", message: "b" } } });
    expect(extractHandoff(mismatch.events).failure).toStrictEqual({ code: "x", message: "b" });
  });

  it("一次都没有失败过就没有失败记录；不带 error 的 session.status 不算", () => {
    const log = new EventLog();
    log.created();
    startRun(log, "run_1", 1);
    log.push({ kind: "session.status", data: { status: "idle" } });
    finish(log, "run_1");

    expect(extractHandoff(log.events).failure).toBeUndefined();
  });
});

describe("normalizeParts / hasSessionRefs", () => {
  it("没写或写空取默认；规范顺序、去重", () => {
    expect(normalizeParts(undefined)).toEqual(["result"]);
    expect(normalizeParts([])).toEqual(["result"]);
    expect(normalizeParts(["error", "result", "error"])).toEqual(["result", "error"]);
    expect(normalizeParts(["error", "files", "result"])).toEqual(["result", "files", "error"]);
    expect(normalizeParts(["files"])).toEqual(["files"]);
  });

  it("认不出的取值丢掉，全丢光了回到默认", () => {
    expect(normalizeParts(["bogus"] as unknown as HandoffPart[])).toEqual(["result"]);
    expect(normalizeParts(["bogus", "files"] as unknown as HandoffPart[])).toEqual(["files"]);
  });

  it("返回的是副本：调用方改它不会改坏默认值", () => {
    const parts = normalizeParts(undefined);
    parts.push("files");

    expect(normalizeParts(undefined)).toEqual(["result"]);
    expect(DEFAULT_HANDOFF_PARTS).toEqual(["result"]);
  });

  it("hasSessionRefs 只看有没有 session 项", () => {
    const text: ContextItem = { kind: "text", text: "hello" };
    const ref: ContextItem = { kind: "session", sessionId: "ses_a" };

    expect(hasSessionRefs(undefined)).toBe(false);
    expect(hasSessionRefs([])).toBe(false);
    expect(hasSessionRefs([text, { kind: "file", path: "a.ts" }])).toBe(false);
    expect(hasSessionRefs([text, ref])).toBe(true);
  });
});

describe("requestedContext", () => {
  it("session 项只剩“要的是什么”：sessionId、规范化的 include、去掉首尾空白的 note；取样结果不参与", () => {
    const out = requestedContext([
      {
        kind: "session",
        sessionId: "ses_a",
        include: ["error", "result"],
        note: "  see this  ",
        sample: sample({ result: { found: true, label: "final", runIndex: 1, chars: 5, sentChars: 5 } }),
      },
    ]);

    expect(out).toEqual([{ kind: "session", sessionId: "ses_a", include: ["result", "error"], note: "see this" }]);
    expect(out[0]).not.toHaveProperty("sample");
  });

  it("没写 include 就是默认；note 只有空白就不带", () => {
    const [item] = requestedContext([{ kind: "session", sessionId: "ses_a", note: "   " }]);

    expect(item).toStrictEqual({ kind: "session", sessionId: "ses_a", include: ["result"] });
  });

  it("没有 session 项的上下文逐项原样返回（旧会话的比较结果与以前完全一致）", () => {
    const text: ContextItem = { kind: "text", text: "hello" };
    const file: ContextItem = { kind: "file", path: "a.ts", note: "n" };
    const out = requestedContext([text, file]);

    expect(out[0]).toBe(text);
    expect(out[1]).toBe(file);
  });

  it("同样的请求在不同时刻取样，规范化之后相等", () => {
    const early = requestedContext([{ kind: "session", sessionId: "ses_a", sample: sample({ at: "2026-01-01T00:00:00.000Z" }) }]);
    const late = requestedContext([{ kind: "session", sessionId: "ses_a", include: ["result"], sample: sample({ at: "2026-02-02T00:00:00.000Z", phase: "failed" }) }]);

    expect(early).toEqual(late);
  });
});

describe("cutHead", () => {
  it("不超限原样返回", () => {
    expect(cutHead("abc", 3)).toEqual({ text: "abc", omitted: 0 });
    expect(cutHead("", 0)).toEqual({ text: "", omitted: 0 });
  });

  it("超限从头保留，报告省略了多少字符", () => {
    expect(cutHead("abcdef", 4)).toEqual({ text: "abcd", omitted: 2 });
  });

  it("上限为 0 时什么都不留", () => {
    expect(cutHead("abc", 0)).toEqual({ text: "", omitted: 3 });
  });

  it("不把一个代理对（emoji）从中间切开", () => {
    const text = "ab\u{1F600}cd"; // 😀 占两个 UTF-16 码元：下标 2 与 3
    expect(text.length).toBe(6);

    expect(cutHead(text, 3)).toEqual({ text: "ab", omitted: 4 });
    expect(cutHead(text, 4)).toEqual({ text: "ab\u{1F600}", omitted: 2 });
  });
});

describe("handedOverText", () => {
  const block = [
    "### Session ses_a: Upstream",
    "Source: session ses_a (codex), sampled 2026-01-02T03:04:05.000Z.",
    "",
    "#### Final answer (run 1 of 1)",
    "```text",
    "Hello",
    "```",
  ].join("\n");
  const prompt = `Do the thing\n\n---\nContext provided with this task:\n\n${block}`;
  const start = prompt.indexOf("### Session");

  function ref(over: Partial<SessionContextItem> = {}): SessionContextItem {
    return { kind: "session", sessionId: "ses_a", sample: sample({ block: { start, end: prompt.length } }), ...over };
  }

  it("按记下的区间取回当时交出去的原文", () => {
    expect(handedOverText(prompt, ref())).toBe(block);
  });

  it("标题行没有标题（上游没有名字）时同样认得", () => {
    const untitled = "### Session ses_a\nSource: session ses_a (codex).";

    expect(handedOverText(untitled, ref({ sample: sample({ block: { start: 0, end: untitled.length } }) }))).toBe(untitled);
  });

  it("没有取样或没有区间时没有原文", () => {
    expect(handedOverText(prompt, { kind: "session", sessionId: "ses_a" })).toBeUndefined();
    expect(handedOverText(prompt, ref({ sample: sample() }))).toBeUndefined();
  });

  it("区间越界、倒置、为空或不是整数时不展示", () => {
    const bad = [
      { start: -1, end: 10 },
      { start, end: prompt.length + 1 },
      { start: 10, end: 10 },
      { start: 12, end: 5 },
      { start: 1.5, end: 9 },
      { start: 0, end: Number.NaN },
    ];

    for (const span of bad) {
      expect(handedOverText(prompt, ref({ sample: sample({ block: span }) }))).toBeUndefined();
    }
  });

  it("标题对不上就不展示，不展示一段错位的文字", () => {
    // 编号不同。
    expect(handedOverText(prompt, ref({ sessionId: "ses_b" }))).toBeUndefined();

    // 编号恰好是另一个编号的开头。
    const other = "### Session ses_ab: Other\nSource: session ses_ab (codex).";
    expect(handedOverText(other, ref({ sample: sample({ block: { start: 0, end: other.length } }) }))).toBeUndefined();

    // 提示在前面被改过，区间整体错位了。
    expect(handedOverText(`X${prompt}`, ref())).toBeUndefined();
  });
});
