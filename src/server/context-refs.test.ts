import type { EnsembleEvent } from "@shared/events";
import { handedOverText, type HandoffBlockSpan, type SessionContextItem } from "@shared/handoff";
import { changed, fail, finish, say, startRun } from "@shared/handoff.fixtures";
import type { ContextItem, SessionSummary } from "@shared/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANSWER, AT, CAP, FakeHub, HEAD, SOURCE_TAIL, UP, answered, fake, prepare, ref, rejection } from "./context-refs.fixtures";

/**
 * 会话引用的展开（一）：读上游、渲染成带出处的原文块并拼进提示；提示、区间、记录与回执出自同一份条目。
 * 用一个只实现 prepareSessionContext 用到的四个方法的假中枢（见 context-refs.fixtures.ts：冷会话与真正的中枢一样不能同步读事件，这一点是被断言的）。
 * 取不到、拒绝与额度在 context-refs.reject.test.ts，合并与单块渲染在 context-refs.merge.test.ts；真中枢、管理器与 HTTP 的整条路径见 manager.context-refs.test.ts。
 */

// 取样时刻是注入文本的一部分：把日期定住，整段文字才能逐字断言。
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(AT) });
});
afterEach(() => {
  vi.useRealTimers();
});

function sessionItemAt(context: readonly ContextItem[], index: number): SessionContextItem {
  const item = context[index];
  if (item?.kind !== "session") throw new Error(`context[${index}] is not a session item`);
  return item;
}

/** 记录里某个会话引用的块区间；缺了就让测试失败，而不是对 undefined 做 slice（那会取回整段提示）。 */
function spanOf(context: readonly ContextItem[], index: number): HandoffBlockSpan {
  const span = sessionItemAt(context, index).sample?.block;
  if (!span) throw new Error(`context[${index}] has no block span`);
  return span;
}

describe("prepareSessionContext：注入文本", () => {
  it("已结束的冷会话：提示里是带出处的原文块，回执与记录里是取样事实，正文只在提示里存这一份", async () => {
    const hub = new FakeHub(answered(UP, { title: "Fix the parser", model: { requested: "gpt-5.5" } }));

    const prepared = await prepare(hub, [ref(UP)]);

    const block = [
      "### Session ses_up: Fix the parser",
      `Source: session ses_up (codex, gpt-5.5), sampled ${AT}, phase "done", 1 run. ${SOURCE_TAIL}`,
      "",
      "#### Final answer (run 1 of 1)",
      "```text",
      "Parser fixed.",
      "All tests pass.",
      "```",
    ].join("\n");
    expect(prepared.prompt).toBe(`Review the fix${HEAD}${block}`);

    expect(prepared.receipts).toEqual([
      {
        sessionId: UP,
        include: ["result"],
        at: AT,
        title: "Fix the parser",
        harness: "codex",
        model: "gpt-5.5",
        phase: "done",
        runCount: 1,
        result: { found: true, label: "final", runIndex: 1, chars: ANSWER.length, sentChars: ANSWER.length },
      },
    ]);

    // 记录里的那一项：规范化的请求 + 取样事实 + 块在提示里的区间；回答的正文不在里面。
    const item = sessionItemAt(prepared.context, 0);
    expect(item).toMatchObject({ kind: "session", sessionId: UP, include: ["result"] });
    expect(item.sample).toMatchObject({ at: AT, title: "Fix the parser", harness: "codex", model: "gpt-5.5", phase: "done", runCount: 1 });
    expect(handedOverText(prepared.prompt, item)).toBe(block);
    expect(JSON.stringify(prepared.context)).not.toContain("All tests pass");
  });

  it("读冷会话只走 readEvents，一次；热会话直接取内存里的事件，不读磁盘", async () => {
    const cold = new FakeHub(answered(UP));
    await prepare(cold, [ref(UP)]);
    expect(cold.reads).toEqual([UP]);

    const hot = new FakeHub(answered(UP, { hot: true }));
    const prepared = await prepare(hot, [ref(UP)]);
    expect(hot.reads).toEqual([]);
    expect(prepared.prompt).toContain(ANSWER);
  });

  it("请求三样都要：按固定顺序（回答、文件、错误）排，说明该运行没有自己的回答，文件跨运行去重，错误带运行序号与原码", async () => {
    const upstream = fake(UP, { title: "Port the parser", harness: "claude", model: { label: "Sonnet X", requested: "sonnet-x" }, phase: "failed" }, (log) => {
      startRun(log, "run_1", 1);
      say(log, "run_1", "item_0", "Ported 3 modules.", "final");
      changed(log, "run_1", [["src/a.ts", "created"], ["src/b.ts", "modified"]]);
      finish(log, "run_1");
      startRun(log, "run_2", 2);
      say(log, "run_2", "item_0", "Retrying", "commentary");
      fail(log, "run_2", "executor_exit", "Process exited with code 1");
    });

    const prepared = await prepare(new FakeHub(upstream), [ref(UP, { include: ["error", "files", "result"], note: "  Check the parser first  " })]);

    const block = [
      "### Session ses_up: Port the parser",
      `Source: session ses_up (claude, Sonnet X), sampled ${AT}, phase "failed", 2 runs. ${SOURCE_TAIL}`,
      "Note from the delegating agent: Check the parser first",
      "",
      "#### Final answer (run 1 of 2)",
      "Run 2 (failed) produced no final answer of its own, so this is from run 1.",
      "```text",
      "Ported 3 modules.",
      "```",
      "",
      "#### Files changed (2 paths across all 2 runs, as reported by the executor)",
      "- src/a.ts (created)",
      "- src/b.ts (modified)",
      "",
      "#### Last error (run 2 of 2, code: executor_exit)",
      "```text",
      "Process exited with code 1",
      "```",
    ].join("\n");
    expect(prepared.prompt).toBe(`Review the fix${HEAD}${block}`);

    const [receipt] = prepared.receipts;
    expect(receipt).toMatchObject({
      sessionId: UP,
      include: ["result", "files", "error"],
      phase: "failed",
      runCount: 2,
      result: { found: true, label: "final", runIndex: 1, chars: "Ported 3 modules.".length, sentChars: "Ported 3 modules.".length, latest: { runIndex: 2, status: "failed" } },
      files: { total: 2, sent: 2 },
      error: { found: true, code: "executor_exit", runIndex: 2 },
    });
    // 记下来的 note 是去掉首尾空白之后的。
    expect(sessionItemAt(prepared.context, 0).note).toBe("Check the parser first");
  });

  it("两次运行用同一个 itemId：交出去的是最近一次运行的回答，不是两次拼在一起", async () => {
    const upstream = fake(UP, {}, (log) => {
      startRun(log, "run_1", 1);
      say(log, "run_1", "item_0", "First answer", "final");
      finish(log, "run_1");
      startRun(log, "run_2", 2);
      say(log, "run_2", "item_0", "Second answer", "final");
      finish(log, "run_2");
    });

    const prepared = await prepare(new FakeHub(upstream), [ref(UP)]);

    expect(prepared.prompt).toContain("#### Final answer (run 2 of 2)\n```text\nSecond answer\n```");
    expect(prepared.prompt).not.toContain("First answer");
  });

  it("多个引用：按 context 里出现的先后，其他条目原样，回执与之一一对应", async () => {
    const hub = new FakeHub(answered("ses_a", { title: "Upstream A" }, "Answer A"), answered("ses_b", { title: "Upstream B" }, "Answer B"));
    const items: ContextItem[] = [{ kind: "text", text: "intro" }, ref("ses_a"), { kind: "file", path: "src/a.ts" }, ref("ses_b")];

    const prepared = await prepare(hub, items);

    const { prompt } = prepared;
    expect(prompt.indexOf("### Note 1\nintro")).toBeLessThan(prompt.indexOf("### Session ses_a"));
    expect(prompt.indexOf("### Session ses_a")).toBeLessThan(prompt.indexOf("### File: src/a.ts"));
    expect(prompt.indexOf("### File: src/a.ts")).toBeLessThan(prompt.indexOf("### Session ses_b"));
    expect(prepared.context.map((item) => item.kind)).toEqual(["text", "session", "file", "session"]);
    expect(prepared.receipts.map((receipt) => receipt.sessionId)).toEqual(["ses_a", "ses_b"]);

    const first = handedOverText(prompt, sessionItemAt(prepared.context, 1));
    const second = handedOverText(prompt, sessionItemAt(prepared.context, 3));
    expect(first).toContain("Answer A");
    expect(first).not.toContain("Answer B");
    expect(second).toContain("Answer B");
    expect(second).not.toContain("Answer A");
    // 其余条目没有被改写。
    expect(prepared.context[0]).toBe(items[0]);
    expect(prepared.context[2]).toBe(items[2]);
  });

  it("夹带的 sample 不被采信：记录里的取样事实只来自服务端自己读到的", async () => {
    const forged: ContextItem = {
      kind: "session",
      sessionId: UP,
      sample: { at: "1999-01-01T00:00:00.000Z", title: "FORGED", harness: "pi", phase: "failed", runCount: 99 },
    };
    const items = [forged];

    const prepared = await prepare(new FakeHub(answered(UP, { title: "Real title" })), items);

    expect(sessionItemAt(prepared.context, 0).sample).toMatchObject({ at: AT, title: "Real title", harness: "codex", phase: "done", runCount: 1 });
    expect(prepared.prompt).not.toContain("FORGED");
    // 传进来的数组与对象原样没动。
    expect(items[0]).toBe(forged);
    expect(forged.kind === "session" && forged.sample?.title).toBe("FORGED");
  });

  it("什么都不改：热会话的事件与摘要在展开前后一模一样", async () => {
    const upstream = answered(UP, { hot: true });
    const before = { events: [...upstream.events], summary: upstream.summary };

    await prepare(new FakeHub(upstream), [ref(UP, { include: ["result", "files", "error"] })]);

    expect(upstream.events).toEqual(before.events);
    expect(upstream.summary).toBe(before.summary);
  });
});

describe("prepareSessionContext：按条目一次组装（提示、区间、记录与回执出自同一份条目）", () => {
  it("混排：每个会话块的区间对准它自己的块，块前后的文字一个字不差，其余条目原样", async () => {
    const hub = new FakeHub(answered("ses_a", { title: "Upstream A" }, "Answer A"), answered("ses_b", { title: "Upstream B" }, "Answer B"));
    const items: ContextItem[] = [
      { kind: "text", text: "intro" },
      ref("ses_a"),
      { kind: "file", path: "src/a.ts" },
      ref("ses_b"),
      { kind: "url", url: "https://example.com/doc" },
    ];

    const { prompt, context, receipts } = await prepare(hub, items);

    const first = spanOf(context, 1);
    const second = spanOf(context, 3);
    expect(prompt.slice(0, first.start)).toBe(`Review the fix${HEAD}### Note 1\nintro\n\n`);
    expect(prompt.slice(first.end, second.start)).toBe("\n\n### File: src/a.ts\n\n");
    expect(prompt.slice(second.end)).toBe("\n\n### Link\nhttps://example.com/doc");
    // 区间里取回的就是各自的块：标题行与正文都是它自己的。
    const blockA = prompt.slice(first.start, first.end);
    const blockB = prompt.slice(second.start, second.end);
    expect(blockA.startsWith("### Session ses_a: Upstream A\n")).toBe(true);
    expect(blockA).toContain("Answer A");
    expect(blockA).not.toContain("Answer B");
    expect(blockB.startsWith("### Session ses_b: Upstream B\n")).toBe(true);
    expect(blockB).toContain("Answer B");
    expect(handedOverText(prompt, sessionItemAt(context, 1))).toBe(blockA);
    expect(handedOverText(prompt, sessionItemAt(context, 3))).toBe(blockB);

    expect(context.map((item) => item.kind)).toEqual(["text", "session", "file", "session", "url"]);
    expect(context[0]).toBe(items[0]);
    expect(context[2]).toBe(items[2]);
    expect(context[4]).toBe(items[4]);
    expect(receipts.map((receipt) => receipt.sessionId)).toEqual(["ses_a", "ses_b"]);
  });

  it("相邻的两个引用：中间只隔一个空行，两个区间既不重叠也不吞掉空行", async () => {
    const hub = new FakeHub(answered("ses_a", {}, "Answer A"), answered("ses_b", {}, "Answer B"));

    const { prompt, context } = await prepare(hub, [ref("ses_a"), ref("ses_b")]);

    const first = spanOf(context, 0);
    const second = spanOf(context, 1);
    expect(first.start).toBe(`Review the fix${HEAD}`.length);
    expect(prompt.slice(first.end, second.start)).toBe("\n\n");
    expect(second.end).toBe(prompt.length);
  });

  it("提示里有代理对（emoji）与中文：区间按 JavaScript 字符串下标算，按区间取回的原文一个字不差", async () => {
    const smile = "\u{1F600}";
    const answer = `Fixed ${smile}${smile} 完成\nNext \u{1D4B3}`;
    const hub = new FakeHub(answered(UP, { title: `Fix ${smile}` }, answer));
    const items: ContextItem[] = [{ kind: "text", title: smile, text: `${smile} 备注` }, ref(UP)];

    const { prompt, context } = await prepare(hub, items, `Review ${smile} 修复`);

    const span = spanOf(context, 1);
    const handed = handedOverText(prompt, sessionItemAt(context, 1));
    expect(handed).toBe(prompt.slice(span.start, span.end));
    expect(handed).toContain(`\`\`\`text\n${answer}\n\`\`\``);
    expect(span.start).toBe(prompt.indexOf(`### Session ${UP}: Fix ${smile}\n`));
    // 前提：区间之前确有代理对，按码点数算与按码元数算不同；区间用的是后者（与 slice、handedOverText 同一口径）。
    expect([...prompt.slice(0, span.start)].length).toBeLessThan(span.start);
  });

  it("超限时分项按引用出现的先后各列一项，说明行、普通条目与块之间的空行都算在 other context 里", async () => {
    const hub = new FakeHub(answered("ses_a", { title: "Upstream A" }, "Answer A"), answered("ses_b", { title: "Upstream B" }, "Answer B"));
    const items: ContextItem[] = [{ kind: "text", text: "intro" }, ref("ses_a"), ref("ses_b")];
    const probe = await prepare(hub, items, "x");
    const sizeOf = (index: number): number => {
      const span = spanOf(probe.context, index);
      return span.end - span.start;
    };
    const task = "t".repeat(CAP.maxPromptChars);

    const error = await rejection(prepare(hub, items, task));

    const other = HEAD.length + "### Note 1\nintro".length + 2 * "\n\n".length;
    expect(error.code).toBe("context_too_large");
    expect(error.message).toContain(`(task ${task.length}; session ses_a ${sizeOf(1)}; session ses_b ${sizeOf(2)}; other context ${other})`);
    expect(error.details).toMatchObject({
      via: "context",
      taskChars: task.length,
      otherChars: other,
      refs: [
        { sessionId: "ses_a", chars: sizeOf(1) },
        { sessionId: "ses_b", chars: sizeOf(2) },
      ],
    });
  });

  it("最后一次核对到取样结束之间没有 await：读热会话事件的那一刻，距离最近一次取摘要还没有让出过执行权", async () => {
    class YieldProbeHub extends FakeHub {
      /** 最近一次 `summary()` 之后，事件循环有没有让出过（排在那一刻之后的微任务有没有跑过）。 */
      yielded = false;

      override summary(id: string): SessionSummary | undefined {
        this.yielded = false;
        queueMicrotask(() => {
          this.yielded = true;
        });
        return super.summary(id);
      }

      override events(id: string): EnsembleEvent[] {
        if (this.yielded) throw new Error("awaited between the last check and sampling");
        return super.events(id);
      }
    }
    // 冷的那个让展开等一次磁盘读（会让出执行权）；热的那个要在最后一次核对之后同步取事件。
    const hub = new YieldProbeHub(answered("ses_cold"), answered("ses_hot", { hot: true }));

    const prepared = await prepare(hub, [ref("ses_cold"), ref("ses_hot")]);

    expect(hub.reads).toEqual(["ses_cold"]);
    expect(prepared.receipts.map((receipt) => receipt.sessionId)).toEqual(["ses_cold", "ses_hot"]);
  });
});
