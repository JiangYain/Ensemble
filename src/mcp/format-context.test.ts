import type { ContextRefReceipt } from "@shared/handoff";
import { describe, expect, it } from "vitest";
import { renderContextRefs } from "./format-context";

/**
 * `delegate` 回执里“这次交接了什么”的文字：写给主模型看的英文，一行一件事，只陈述事实（取到了什么、取自第几次运行、被截断没有），
 * 不加评价与建议。每个分支各有一条，字符串逐字断言——这些字每次引用都会进主模型的上下文，措辞变了要有人注意到。
 */

const AT = "2026-03-04T05:06:07.000Z";

function receipt(over: Partial<ContextRefReceipt> = {}): ContextRefReceipt {
  return { sessionId: "ses_up", include: ["result"], at: AT, title: "Fix the parser", harness: "codex", phase: "done", runCount: 1, ...over };
}

const HEADER_ONE = "    context from a session, copied verbatim from its own record into the new session's prompt:";
const HEADER_MANY = (n: number): string => `    context from ${n} sessions, copied verbatim from their own record into the new session's prompt:`;

describe("renderContextRefs", () => {
  it("没有引用就什么都不输出（调用方可以直接展开）", () => {
    expect(renderContextRefs([])).toEqual([]);
  });

  it("三样都取：一行总述，一行一个会话；写明取自第几次运行、跳过了哪一次、几个路径、哪次运行的什么错误", () => {
    const lines = renderContextRefs([
      receipt({
        include: ["result", "files", "error"],
        runCount: 2,
        result: { found: true, label: "final", runIndex: 1, chars: 29, sentChars: 29, latest: { runIndex: 2, status: "failed" } },
        files: { total: 2, sent: 2 },
        error: { found: true, code: "executor_exit", runIndex: 2 },
      }),
    ]);

    expect(lines).toEqual([
      HEADER_ONE,
      "      ses_up “Fix the parser” (codex; done when read): result: final answer, 29 chars, run 1 of 2; run 2 (failed) had none; files: 2 paths; error: executor_exit in run 2",
    ]);
  });

  it("只写请求了的部分", () => {
    const lines = renderContextRefs([receipt({ result: { found: true, label: "final", runIndex: 1, chars: 5, sentChars: 5 } })]);

    expect(lines[1]).toBe("      ses_up “Fix the parser” (codex; done when read): result: final answer, 5 chars, run 1 of 1");
  });

  it("没有标 final 的文字、被截断的文字：照实说“最后一条消息，没有标成最终回答”与交出去了多少", () => {
    const lines = renderContextRefs([receipt({ result: { found: true, label: "unlabeled", runIndex: 1, chars: 50_000, sentChars: 40_000 } })]);

    expect(lines[1]).toContain("result: last message, not marked final, first 40000 of 50000 chars (truncated), run 1 of 1");
  });

  it.each([
    ["no_runs", "result: none (the session has no runs)"],
    ["no_text", "result: none (its runs wrote no assistant text)"],
    ["no_final", "result: none (all its messages were progress notes, none marked final)"],
  ] as const)("取不到结果（%s）：写明原因，不留空", (reason, phrase) => {
    const lines = renderContextRefs([receipt({ result: { found: false, reason } })]);

    expect(lines[1]).toBe(`      ses_up “Fix the parser” (codex; done when read): ${phrase}`);
  });

  it("文件清单：没有、一个、被截断（列了几个、一共多少）", () => {
    const filesLine = (files: { total: number; sent: number }): string | undefined => renderContextRefs([receipt({ include: ["files"], files })])[1];

    expect(filesLine({ total: 0, sent: 0 })).toContain("): files: none reported");
    expect(filesLine({ total: 1, sent: 1 })).toContain("): files: 1 path");
    expect(filesLine({ total: 1, sent: 1 })).not.toContain("1 paths");
    expect(filesLine({ total: 203, sent: 200 })).toContain("): files: 200 of 203 paths listed");
  });

  it("错误：没有、某次运行的、会话级的、消息被截断的", () => {
    const errorLine = (error: NonNullable<ContextRefReceipt["error"]>): string | undefined => renderContextRefs([receipt({ include: ["error"], error })])[1];

    expect(errorLine({ found: false })).toContain("): error: none recorded");
    expect(errorLine({ found: true, code: "boom", runIndex: 1 })).toContain("): error: boom in run 1");
    expect(errorLine({ found: true, code: "spawn_failed" })).toContain("): error: spawn_failed (session-level)");
    expect(errorLine({ found: true, code: "boom", runIndex: 1, truncated: true })).toContain("): error: boom in run 1, message truncated");
  });

  it("多个会话：总述写个数，一个会话一行，顺序与回执一致", () => {
    const lines = renderContextRefs([
      receipt({ sessionId: "ses_a", title: "Upstream A", result: { found: true, label: "final", runIndex: 1, chars: 3, sentChars: 3 } }),
      receipt({ sessionId: "ses_b", title: "Upstream B", harness: "claude", phase: "failed", result: { found: false, reason: "no_text" } }),
    ]);

    expect(lines).toEqual([
      HEADER_MANY(2),
      "      ses_a “Upstream A” (codex; done when read): result: final answer, 3 chars, run 1 of 1",
      "      ses_b “Upstream B” (claude; failed when read): result: none (its runs wrote no assistant text)",
    ]);
  });

  it("标题里的换行与连续空白压成一个空格，太长的截断（回执一行就是一行）", () => {
    const lines = renderContextRefs([receipt({ title: "Line one\n  Line two", result: { found: false, reason: "no_runs" } }), receipt({ sessionId: "ses_b", title: "T".repeat(70), result: { found: false, reason: "no_runs" } })]);

    expect(lines[1]).toContain("“Line one Line two”");
    expect(lines[2]).toContain(`“${"T".repeat(59)}…”`);
  });
});
