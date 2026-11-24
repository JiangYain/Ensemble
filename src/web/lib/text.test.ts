import { describe, expect, it } from "vitest";
import { replay, toSummary } from "@shared/projection";
import type { QuestionPrompt } from "@shared/questions";
import { EventLog, USER } from "@shared/testing";
import type { AttentionItem } from "@shared/types";
import { bindT } from "./i18n";
import { activityLabel, attentionText, attentionTip, dateMinute, plainLine, subtitleOf } from "./text";

/** 用本地时间构造，测试不依赖运行机器的时区。 */
const local = (year: number, month: number, day: number, hour: number, minute: number, second = 0): Date => new Date(year, month - 1, day, hour, minute, second);

describe("dateMinute", () => {
  it("中文写成 年月日 + 时分，月日不补零", () => {
    expect(dateMinute(local(2026, 11, 14, 17, 50, 22).toISOString(), "zh")).toBe("2026年11月14日 17:50");
    expect(dateMinute(local(2026, 3, 5, 9, 7).toISOString(), "zh")).toBe("2026年3月5日 09:07");
  });

  it("英文写成 月 日, 年 + 时分", () => {
    expect(dateMinute(local(2026, 11, 14, 17, 50, 22).toISOString(), "en")).toBe("Nov 14, 2026 17:50");
    expect(dateMinute(local(2026, 3, 5, 9, 7).toISOString(), "en")).toBe("Mar 5, 2026 09:07");
  });

  it("不显示秒，零点附近是 00:05 而不是 24:05", () => {
    expect(dateMinute(local(2026, 11, 14, 0, 5, 59).toISOString(), "zh")).toBe("2026年11月14日 00:05");
  });

  it("跨年也带完整年份，和“现在”无关", () => {
    expect(dateMinute(local(2025, 12, 31, 23, 30).toISOString(), "zh")).toBe("2025年12月31日 23:30");
  });

  it("short 写法：同样完整的年月日 + 时分，数字补零、两种语言一样", () => {
    expect(dateMinute(local(2026, 11, 14, 17, 50, 22).toISOString(), "zh", true)).toBe("2026-11-14 17:50");
    expect(dateMinute(local(2026, 3, 5, 9, 7).toISOString(), "en", true)).toBe("2026-03-05 09:07");
  });

  it("short 写法的位数固定，上下排开的日期逐位对齐；也明显短于长写法", () => {
    const wide = dateMinute(local(2026, 11, 14, 17, 50).toISOString(), "zh");
    const a = dateMinute(local(2026, 3, 5, 9, 7).toISOString(), "zh", true);
    const b = dateMinute(local(2026, 12, 31, 23, 59).toISOString(), "zh", true);
    expect(a.length).toBe(b.length);
    expect(a.length).toBeLessThan(wide.length);
  });

  it("无法解析的时间返回空串", () => {
    expect(dateMinute("not a date", "zh", true)).toBe("");
    expect(dateMinute("not a date", "zh")).toBe("");
  });
});

/** a 的每个字符都按顺序出现在 b 里：只删字符、不增不改。 */
function isSubsequence(a: string, b: string): boolean {
  let at = 0;
  for (const ch of b) if (at < a.length && a[at] === ch) at++;
  return at === a.length;
}

describe("plainLine：把 Markdown 摘要收成单行纯文本", () => {
  it("去掉围栏与紧贴在围栏后的语言名，代码本身保留（服务端的摘要已压成一行时也一样）", () => {
    expect(plainLine("```ts export class ParseError extends Error { } ``` 完成")).toBe("export class ParseError extends Error { } 完成");
    expect(plainLine("```ts\nexport class A {}\n```\n之后的说明")).toBe("export class A {} 之后的说明");
    expect(plainLine("~~~bash\nnpm test\n~~~")).toBe("npm test");
    // 围栏后隔着空格的是代码本身，不是语言名。
    expect(plainLine("``` ts is a language ```")).toBe("ts is a language");
    // 只剩一个收尾围栏（摘要是回复的尾部）。
    expect(plainLine("…} ``` > 旧的方法仍然保留")).toBe("…} > 旧的方法仍然保留");
  });

  it("去掉行内标记：行内代码、粗体、斜体、删除线、链接与图片的语法、标题的 #", () => {
    expect(plainLine("`src/a.ts` 是**新增**的，*只*读 token")).toBe("src/a.ts 是新增的，只读 token");
    expect(plainLine("见[这次提交](https://example.com/commit/abc123)和![截图](a.png \"标题\")")).toBe("见这次提交和截图");
    expect(plainLine("~~旧方案~~ 改用新方案")).toBe("旧方案 改用新方案");
    expect(plainLine("## 改了什么 ### 测试")).toBe("改了什么 测试");
    expect(plainLine("**`ParseError`** 带上了位置")).toBe("ParseError 带上了位置");
    expect(plainLine("[**重点**](https://x.y)")).toBe("重点");
  });

  it("不是标记的字符不动：路径通配、乘号、标识符里的下划线、C#、#5、行内代码里看起来像标记的东西", () => {
    for (const text of ["src/**/a.ts and lib/**/b.ts", "**/a.ts,**/b.ts", "匹配 *.ts,*.js 两种", "2 * 3 * 4", "snake_case_name 和 __init__", "C# 与 F#", "见 #5", "a | b | c", "1. 第一步 - 第二步"]) {
      expect(plainLine(text), text).toBe(text);
    }
    // 行内代码里的内容原样保留，不会被当成标记再处理一遍。
    expect(plainLine("`__init__` 与 `**kwargs`")).toBe("__init__ 与 **kwargs");
  });

  it("只删标记，不增不改：结果的每个字符都按顺序出自原文（压平空白之后）", () => {
    const samples = [
      "```ts export class ParseError extends Error { constructor(message: string) { super(message); } } ``` > 旧的 `parseLegacy` 仍然保留，见[这次提交](https://example.com/commit/abc123)。",
      "## 改了什么 - `src/parser/lexer.ts`：新增，**只负责**切 token；*保留*了位置信息 | 用例组 | 新增 |",
      "纯文本的一句话，没有任何标记。",
      "…tail of a long reply ``` ```bash npm run test ``` **done**",
    ];
    for (const sample of samples) {
      const flat = sample.replace(/\s+/g, " ").trim();
      const plain = plainLine(sample);
      expect(isSubsequence(plain, flat), plain).toBe(true);
      expect(plain.length).toBeLessThan(flat.length + 1);
      expect(plain).not.toContain("```");
      expect(plain).not.toContain("**");
    }
    // 没有标记的文本原样返回（只压平空白）。
    expect(plainLine("  纯文本\n两行  ")).toBe("纯文本 两行");
  });

  it("只有标记、没有内容时返回空串", () => {
    expect(plainLine("``` ```")).toBe("");
    expect(plainLine("")).toBe("");
  });
});

describe("subtitleOf：页头与画布卡片共用的副标题", () => {
  const t = bindT("zh");

  /** 一个已完成的会话，最后一条回复是 reply。 */
  function done(reply: string) {
    const log = new EventLog("ses_sub");
    log.created({ harness: "pi" });
    const message = log.message("msg_1", "task", "做点什么");
    log.run("run_1", 1, message.id);
    log.startRun("run_1");
    log.push({ kind: "assistant.delta", data: { itemId: "a1", text: reply, phase: "final" } }, { runId: "run_1" });
    log.push({ kind: "assistant.completed", data: { itemId: "a1" } }, { runId: "run_1" });
    log.push({ kind: "run.completed", data: { stopReason: "end_turn" } }, { runId: "run_1" });
    log.push({ kind: "session.status", data: { status: "idle" } }, { source: "ensemble" });
    const state = replay(log.events);
    if (!state) throw new Error("replay produced no state");
    return toSummary(state);
  }

  it("已完成：取自执行端最后一条回复，显示前去掉围栏与行内标记，是单行纯文本", () => {
    const summary = done("改好了：\n\n```ts\nexport class ParseError extends Error {}\n```\n\n详见[这次提交](https://example.com/c/1)，**旧的** `parseLegacy` 仍保留。");
    expect(summary.phase).toBe("done");
    const text = subtitleOf(summary, t);
    expect(text).toBe("改好了： export class ParseError extends Error {} 详见这次提交，旧的 parseLegacy 仍保留。");
    expect(text).not.toMatch(/[`*\[\]]/);
    expect(text).not.toContain("\n");
  });

  it("回复以围栏开头时不再显示成 ```ts export class …", () => {
    const text = subtitleOf(done("```ts\nexport class ParseError extends Error {}\n```"), t);
    expect(text).toBe("export class ParseError extends Error {}");
  });

  it("回复里只有标记、清理后什么都不剩：退回“已完成”，不显示空白", () => {
    expect(subtitleOf(done("```\n```"), t)).toBe("已完成");
  });

  it("很长的回复仍截成 90 个字符以内、末尾带省略号", () => {
    const text = subtitleOf(done(`**${"很长的结论".repeat(20)}**`), t);
    expect(text.length).toBeLessThanOrEqual(90);
    expect(text.endsWith("…")).toBe(true);
    expect(text).not.toContain("*");
  });
});

describe("提问在文字里的呈现", () => {
  const t = bindT("zh");
  const SINCE = "2026-01-01T00:00:00.000Z";
  const prompts = (text: string): QuestionPrompt[] => [{ key: "q", text, options: [{ label: "SQLite" }, { label: "PostgreSQL" }], multiple: false, custom: true }];

  /** 一个正在运行、并停下来问了一个问题的会话；`answer` 为真时，问题随后得到了回答。 */
  function session(answer: boolean) {
    const log = new EventLog("ses_ask");
    log.created({ harness: "codex" });
    const message = log.message("msg_1", "task", "做点什么");
    log.run("run_1", 1, message.id);
    log.startRun("run_1");
    log.ask("qst_1", prompts("Which database should the service use?"), "run_1");
    if (answer) log.settle({ questionId: "qst_1", outcome: "answered", by: USER, answers: [["SQLite"]], delivery: "handed_off" }, "run_1");
    const state = replay(log.events);
    if (!state) throw new Error("replay produced no state");
    return toSummary(state);
  }

  const item = (text: string): AttentionItem => ({ kind: "question", questionId: "qst_1", prompts: prompts(text), since: SINCE });
  const FIVE_MINUTES_LATER = Date.parse(SINCE) + 5 * 60_000;

  it("提问待回答时会话仍在运行（没有新的阶段），副标题直说“等待回答”，不再写“执行中”", () => {
    const summary = session(false);
    expect(summary.phase).toBe("running");
    expect(summary.openQuestions).toBe(1);
    expect(subtitleOf(summary, t)).toBe("等待回答");
    expect(subtitleOf(summary, bindT("en"))).toBe("Waiting for an answer");
  });

  it("问题有了回答，副标题回到执行端真实上报的活动", () => {
    const summary = session(true);
    expect(summary.phase).toBe("running");
    expect(summary.openQuestions).toBeUndefined();
    expect(subtitleOf(summary, t)).toBe(activityLabel(summary.activity.kind, t));
    expect(subtitleOf(summary, t)).not.toBe("等待回答");
  });

  it("值得留意里的提问：写出第一个问题的一句摘要与等待时长，只陈述事实", () => {
    const text = attentionText(item("Which database should the service use?"), FIVE_MINUTES_LATER, t);
    expect(text).toContain("提问待回答：“Which database should the service use?”");
    expect(text).toContain("已等待");
    expect(text).not.toMatch(/卡住|失败|异常/);
  });

  it("问题很长或带换行时收成单行，并截断", () => {
    const multiline = attentionText(item("first line\n\n  second   line"), FIVE_MINUTES_LATER, t);
    expect(multiline).toContain("“first line second line”");
    expect(multiline).not.toContain("\n");

    const long = attentionText(item("word ".repeat(200)), FIVE_MINUTES_LATER, t);
    expect(long).toContain("…");
    expect(long.length).toBeLessThan(200);
  });

  it("悬停提示：一行标题，加每条事实一行", () => {
    const lines = attentionTip([item("Which database?")], FIVE_MINUTES_LATER, t).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(attentionText(item("Which database?"), FIVE_MINUTES_LATER, t));
  });
});
