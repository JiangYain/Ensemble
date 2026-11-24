import { extractHandoff } from "@shared/handoff";
import { changed, fail, finish, say, startRun } from "@shared/handoff.fixtures";
import { EventLog } from "@shared/testing";
import type { ContextItem, ModelRef } from "@shared/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeSessionRefs, renderSessionBlock, type RenderedSessionBlock, type SessionBlockInput } from "./context-refs";
import { AT, FakeHub, SOURCE_TAIL, UP, answered, prepare, ref } from "./context-refs.fixtures";

/**
 * 会话引用的展开（三）：同一个会话写了多次怎么合成一条（`mergeSessionRefs`），以及单个会话块怎么渲染（`renderSessionBlock`，直接给它一份交接取数，不经过中枢）。
 * 注入文本在 context-refs.test.ts，取不到、拒绝与额度在 context-refs.reject.test.ts；假中枢与造数据的辅助见 context-refs.fixtures.ts。
 */

// 取样时刻是注入文本的一部分：把日期定住，整段文字才能逐字断言。
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(AT) });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("mergeSessionRefs", () => {
  it("没有 session 条目：每一项原样返回", () => {
    const text: ContextItem = { kind: "text", text: "hello" };
    const file: ContextItem = { kind: "file", path: "a.ts" };

    const merged = mergeSessionRefs([text, file]);

    expect(merged[0]).toBe(text);
    expect(merged[1]).toBe(file);
  });

  it("规范形态：include 按固定顺序、note 去首尾空白（只有空白就不带）、丢掉传进来的 sample", () => {
    const merged = mergeSessionRefs([
      { kind: "session", sessionId: "ses_a", include: ["error", "result"], note: "  hi  ", sample: { at: AT, title: "T", harness: "codex", phase: "done", runCount: 1 } },
      { kind: "session", sessionId: "ses_b", note: "   " },
    ]);

    expect(merged).toStrictEqual([
      { kind: "session", sessionId: "ses_a", include: ["result", "error"], note: "hi" },
      { kind: "session", sessionId: "ses_b", include: ["result"] },
    ]);
  });

  it("同一个会话写了多次：合成一条放在第一次出现的位置，要的部分取并集，别的条目不动", () => {
    const between: ContextItem = { kind: "text", text: "between" };

    const merged = mergeSessionRefs([
      { kind: "session", sessionId: "ses_a", include: ["result"] },
      between,
      { kind: "session", sessionId: "ses_b" },
      { kind: "session", sessionId: "ses_a", include: ["files"] },
      { kind: "session", sessionId: "ses_a", include: ["error"] },
    ]);

    expect(merged).toStrictEqual([
      { kind: "session", sessionId: "ses_a", include: ["result", "files", "error"] },
      between,
      { kind: "session", sessionId: "ses_b", include: ["result"] },
    ]);
  });

  it("说明合在一起：相同的只留一份，不同的按出现的先后各占一行；只有一边有说明就用它", () => {
    expect(
      mergeSessionRefs([
        { kind: "session", sessionId: "ses_a", note: "same" },
        { kind: "session", sessionId: "ses_a", note: "same" },
      ]),
    ).toStrictEqual([{ kind: "session", sessionId: "ses_a", include: ["result"], note: "same" }]);

    expect(
      mergeSessionRefs([
        { kind: "session", sessionId: "ses_a", note: "one" },
        { kind: "session", sessionId: "ses_a", note: "two" },
        { kind: "session", sessionId: "ses_a", note: "three" },
      ]),
    ).toStrictEqual([{ kind: "session", sessionId: "ses_a", include: ["result"], note: "one\ntwo\nthree" }]);

    expect(
      mergeSessionRefs([
        { kind: "session", sessionId: "ses_a" },
        { kind: "session", sessionId: "ses_a", note: "later" },
      ]),
    ).toStrictEqual([{ kind: "session", sessionId: "ses_a", include: ["result"], note: "later" }]);
  });

  it("合并之后同一份回答在提示里只出现一遍", async () => {
    const prepared = await prepare(new FakeHub(answered(UP)), [ref(UP, { include: ["result"] }), ref(UP, { include: ["files"] }), ref(UP, { include: ["error"] })]);

    expect(prepared.prompt.split("### Session ses_up").length - 1).toBe(1);
    expect(prepared.receipts).toHaveLength(1);
    expect(prepared.receipts[0]?.include).toEqual(["result", "files", "error"]);
  });
});

describe("renderSessionBlock", () => {
  function render(build: (log: EventLog) => void, over: Partial<SessionBlockInput> = {}): RenderedSessionBlock {
    const log = new EventLog(UP);
    log.created();
    build(log);
    return renderSessionBlock({
      sessionId: UP,
      include: ["result", "files", "error"],
      note: undefined,
      summary: { title: "Upstream task", harness: "codex", phase: "done" },
      extract: extractHandoff(log.events),
      at: AT,
      ...over,
    });
  }

  it("有运行但没有任何文字：说“没有一次运行写过文字”，只有请求的部分才有对应的事实", () => {
    const out = render(
      (log) => {
        startRun(log, "run_1", 1);
        finish(log, "run_1");
        startRun(log, "run_2", 2);
        finish(log, "run_2");
      },
      { include: ["result"] },
    );

    expect(out.block).toContain("#### Final answer\nNone: none of its 2 runs wrote any assistant text (session phase at sampling: done).");
    expect(out.sample.result).toEqual({ found: false, reason: "no_text" });
    expect(out.sample.files).toBeUndefined();
    expect(out.sample.error).toBeUndefined();
  });

  it("文字全是过程说明：说明过程说明不当作回答，不退回去交一条过程说明", () => {
    const out = render(
      (log) => {
        startRun(log, "run_1", 1);
        say(log, "run_1", "i1", "Looking around", "commentary");
        finish(log, "run_1");
      },
      { include: ["result"] },
    );

    expect(out.block).toContain(
      "#### Final answer\nNone: it wrote messages, but every one was marked as a progress note (commentary) and none as a final answer; "
        + "progress notes are not passed on as an answer (session phase at sampling: done).",
    );
    expect(out.block).not.toContain("Looking around");
    expect(out.sample.result).toEqual({ found: false, reason: "no_final" });
  });

  it("执行端不标 final：标题写“最后一条消息”，并说明它不保证是结论", () => {
    const out = render(
      (log) => {
        startRun(log, "run_1", 1);
        say(log, "run_1", "i1", "Done.");
        finish(log, "run_1");
      },
      { include: ["result"] },
    );

    expect(out.block).toContain(
      "#### Last message (run 1 of 1)\n"
        + "This session never marked any message as its final answer, so this is simply the last message it wrote; it may not be a conclusion.\n"
        + "```text\nDone.\n```",
    );
    expect(out.sample.result).toEqual({ found: true, label: "unlabeled", runIndex: 1, chars: 5, sentChars: 5 });
  });

  it("未标记的文字来自更早的运行：先说跳过了最新一次，再说它不保证是结论", () => {
    const out = render(
      (log) => {
        startRun(log, "run_1", 1);
        say(log, "run_1", "i1", "Done.");
        finish(log, "run_1");
        startRun(log, "run_2", 2);
        finish(log, "run_2");
      },
      { include: ["result"] },
    );

    expect(out.block).toContain(
      "#### Last message (run 1 of 2)\n"
        + "Run 2 (completed) produced no message of its own, so this is from run 1.\n"
        + "This session never marked any message as its final answer",
    );
    expect(out.sample.result).toMatchObject({ found: true, label: "unlabeled", runIndex: 1, latest: { runIndex: 2, status: "completed" } });
  });

  it("原文里有反引号：围栏比原文里最长的一串再长一格，原文一个字都不动", () => {
    const tricky = "Use:\n```js\nrun()\n```\nDone";
    const wide = "a `````b";
    const answer = (text: string) => (log: EventLog) => {
      startRun(log, "run_1", 1);
      say(log, "run_1", "i1", text, "final");
      finish(log, "run_1");
    };

    expect(render(answer(tricky), { include: ["result"] }).block).toContain("````text\nUse:\n```js\nrun()\n```\nDone\n````");
    expect(render(answer(wide), { include: ["result"] }).block).toContain("``````text\na `````b\n``````");
    expect(render(answer("plain"), { include: ["result"] }).block).toContain("```text\nplain\n```");
  });

  it("标题、路径、错误码里的换行与连续空白压成一个空格，不打乱块的结构；记录里的错误码仍是原样", () => {
    const out = render(
      (log) => {
        startRun(log, "run_1", 1);
        changed(log, "run_1", [["src/a\n  b.ts", "modified"]]);
        fail(log, "run_1", "weird  code\n", "msg");
      },
      { summary: { title: "Line one\n  Line two", harness: "codex", phase: "failed" } },
    );

    expect(out.block.startsWith("### Session ses_up: Line one Line two\nSource: ")).toBe(true);
    expect(out.block).toContain("- src/a b.ts (modified)");
    expect(out.block).toContain("#### Last error (run 1 of 1, code: weird code)");
    expect(out.sample.error).toEqual({ found: true, code: "weird  code\n", runIndex: 1 });
  });

  it("没有标题时标题行不带冒号", () => {
    const out = render(() => undefined, { include: ["result"], summary: { title: "   ", harness: "codex", phase: "ready" } });

    expect(out.block.startsWith("### Session ses_up\nSource: session ses_up (codex), sampled ")).toBe(true);
  });

  it("会话级的失败：标题写 session-level；消息为空时写“(no message)”", () => {
    const out = render(
      (log) => {
        log.push({ kind: "session.status", data: { status: "failed", error: { code: "spawn_failed", message: "" } } });
      },
      { include: ["error"], summary: { title: "Upstream task", harness: "codex", phase: "failed" } },
    );

    expect(out.block).toContain("#### Last error (session-level, code: spawn_failed)\n```text\n(no message)\n```");
    expect(out.sample.error).toEqual({ found: true, code: "spawn_failed" });
  });

  it("发起端的说明原样放在来源之后（多行也不改）", () => {
    const out = render(() => undefined, { include: ["result"], note: "line1\nline2" });

    expect(out.block).toContain(`${SOURCE_TAIL}\nNote from the delegating agent: line1\nline2\n\n#### Final answer`);
  });

  it("模型名优先用显示名，其次实际用的，最后是请求的；没有模型就不写", () => {
    const modelOf = (model: ModelRef | undefined) => render(() => undefined, { include: ["result"], summary: { title: "T", harness: "codex", phase: "ready", ...(model ? { model } : {}) } });

    expect(modelOf({ requested: "r", resolved: "s", label: "L" }).block).toContain("(codex, L)");
    expect(modelOf({ requested: "r", resolved: "s" }).block).toContain("(codex, s)");
    expect(modelOf({ requested: "r" }).block).toContain("(codex, r)");
    expect(modelOf(undefined).block).toContain("(codex),");
    expect(modelOf({ requested: "r", resolved: "s", label: "L" }).sample.model).toBe("L");
    expect(modelOf(undefined).sample).not.toHaveProperty("model");
  });
});
