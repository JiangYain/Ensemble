import { describe, expect, it } from "vitest";
import type { HandoffSample } from "./handoff";
import { replay, toSummary } from "./projection";
import { renderReport } from "./report";
import type { ReportLang } from "./report";
import { EventLog } from "./testing";
import type { ContextItem } from "./types";

/**
 * 报告里的“会话引用”这一行：只写引用了谁、当时取走了什么（取样时冻结在会话记录里的事实），
 * 被截断的部分明文写出，取不到的说“没有”，没有取样记录的老数据照实说；交出去的正文不在报告里。
 * 报告其余部分的规则在 report.test.ts。
 */

const UP = "ses_up";

const SAMPLE: HandoffSample = {
  at: "2026-03-04T05:06:07.000Z",
  title: "Fix the parser",
  harness: "codex",
  phase: "done",
  runCount: 1,
  result: { found: true, label: "final", runIndex: 1, chars: 29, sentChars: 29 },
  files: { total: 2, sent: 2 },
  error: { found: false },
};

/** 一个已经跑完的下游会话，委派时带着给定的上下文；返回整份 Markdown 报告。 */
function render(context: ContextItem[], lang: ReportLang = "en", prompt = "Review the fix"): string {
  const log = new EventLog("ses_down");
  log.created({ title: "Review the fix", cwd: "C:\\work\\demo", task: { text: "Review the fix", context, prompt } });
  log.message("msg_1", "task", "Review the fix");
  log.run("run_1", 1, "msg_1");
  log.startRun("run_1");
  log.push({ kind: "message.delivery", data: { messageId: "msg_1", record: { stage: "applied", at: log.now() } } }, { runId: "run_1", source: "ensemble" });
  log.push({ kind: "run.completed", data: { stopReason: "end_turn" } }, { runId: "run_1" });
  const state = replay(log.events);
  if (!state) throw new Error("the fixture has no session.created event");
  return renderReport({
    scope: "session",
    detail: "brief",
    lang,
    exportedAt: "2026-03-01T12:00:00.000Z",
    version: "9.9.9",
    rootId: "ses_down",
    sessions: [{ summary: toSummary(state, []), events: log.events }],
  });
}

const session = (sample: HandoffSample | undefined, extra: { sessionId?: string; include?: ("result" | "files" | "error")[] } = {}): ContextItem => ({
  kind: "session",
  sessionId: extra.sessionId ?? UP,
  ...(extra.include ? { include: extra.include } : {}),
  ...(sample ? { sample } : {}),
});

describe("报告里的会话引用", () => {
  it("一行写明引用了谁、取走了什么（字数、几个文件、有没有错误）、什么时候读的、当时是什么状态", () => {
    const markdown = render([session(SAMPLE, { include: ["result", "files", "error"] })]);

    expect(markdown).toContain(
      "- Session reference: `ses_up` “Fix the parser” — result 29 characters · 2 changed files · no error recorded · read 2026-03-04 05:06:07 UTC; session was done",
    );
  });

  it("只列请求过的部分：没有请求文件与错误，行里就没有它们", () => {
    const markdown = render([session({ ...SAMPLE, files: undefined, error: undefined }, { include: ["result"] })]);

    expect(markdown).toContain("- Session reference: `ses_up` “Fix the parser” — result 29 characters · read 2026-03-04 05:06:07 UTC; session was done");
    expect(markdown).not.toContain("2 changed files");
    expect(markdown).not.toContain("no error recorded");
  });

  it("被截断的部分明文写出：结果取了多少、文件列了多少、错误消息被截断；字数带千分位", () => {
    const markdown = render([
      session({
        ...SAMPLE,
        result: { found: true, label: "unlabeled", runIndex: 1, chars: 50_000, sentChars: 40_000 },
        files: { total: 203, sent: 200 },
        error: { found: true, code: "executor_exit", runIndex: 1, truncated: true },
      }),
    ]);

    expect(markdown).toContain(
      "— result cut to 40,000 of 50,000 characters · 200 of 203 changed files listed · last error `executor_exit`, message cut · read 2026-03-04 05:06:07 UTC; session was done",
    );
  });

  it("有错误但没被截断：只写错误码；取不到结果：说“没有可用的结果”，不写字数", () => {
    const markdown = render([session({ ...SAMPLE, result: { found: false, reason: "no_text" }, error: { found: true, code: "executor_exit", runIndex: 2 } })]);

    expect(markdown).toContain("— no result available · 2 changed files · last error `executor_exit` · read ");
    expect(markdown).not.toContain("message cut");
    expect(markdown).not.toContain("result 29");
  });

  it("没有取样记录（老数据，或记录被改过）：照实说，不编造当时拿到了什么", () => {
    const markdown = render([session(undefined, { sessionId: "ses_old" })]);

    expect(markdown).toContain("- Session reference: `ses_old` — no record of what was handed over");
    expect(markdown).not.toContain("; session was done");
  });

  it("标题里会被 Markdown 当成标记的字符都转义，不会改变报告的版式", () => {
    const markdown = render([session({ ...SAMPLE, title: "Fix *the* parser_v2 [WIP]\nsecond line" })]);

    expect(markdown).toContain("“Fix \\*the\\* parser\\_v2 \\[WIP\\] second line”");
  });

  it("中文报告用中文的措辞（版式与英文一致）", () => {
    const markdown = render([session(SAMPLE)], "zh");

    expect(markdown).toContain("- 会话引用: `ses_up` “Fix the parser” — 结果 29 个字符 · 2 个改动文件 · 没有错误记录 · 读取于 2026-03-04 05:06:07 UTC，会话当时的状态：已完成");
  });

  it("与别的上下文条目并列，按原来的顺序", () => {
    const markdown = render([{ kind: "file", path: "src/parser.ts", note: "entry point" }, session(SAMPLE), { kind: "url", url: "https://example.com/spec", title: "Spec" }]);

    const file = markdown.indexOf("- File: `src/parser.ts`");
    const reference = markdown.indexOf("- Session reference: `ses_up`");
    const url = markdown.indexOf("- URL: `https://example.com/spec`");
    expect(file).toBeGreaterThan(0);
    expect(reference).toBeGreaterThan(file);
    expect(url).toBeGreaterThan(reference);
  });

  it("交出去的正文不在报告里：报告只写事实（“委派”一节引用的是发起方的原文，不是展开后的提示）", () => {
    const prompt = "Review the fix\n\n### Session ses_up: Fix the parser\n```text\nHANDED-OVER-BODY\n```";
    const markdown = render([session({ ...SAMPLE, block: { start: 16, end: prompt.length } })], "en", prompt);

    expect(markdown).toContain("- Session reference: `ses_up`");
    expect(markdown).not.toContain("HANDED-OVER-BODY");
  });
});
