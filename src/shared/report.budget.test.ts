import { beforeEach, describe, expect, it, vi } from "vitest";
import { cutMarkdown, REPORT_LIMITS, ReportBuilder } from "./report";
import * as reportFacts from "./report-facts";
import { REPORT_LABELS } from "./report-labels";
import * as reportSession from "./report-session";
import { build, family, fencesClosed, finish, options, render, say, startTask, taskMeta } from "./report.fixtures";
import type { Built } from "./report.fixtures";
import { AGENT, USER } from "./testing";
import type { ContextItem } from "./types";

/**
 * 报告的字符数上限：maxChars 逐档收紧、略去放不下的会话与最后的安全网，ReportBuilder 的分块用法，cutMarkdown，
 * 以及“每个会话的事实只整理一次、各档预算读同一份”（要观察 prepareReportSession 与 formatSession 怎么被调用，所以 vi.mock 在本文件）。
 * 报告其余部分的规则在 report.test.ts，会话事实本身在 report.facts.test.ts，共用的夹具在 report.fixtures.ts。
 */

// 拆分之后“每个会话的事实只整理一次、预算各档读同一份”只能靠观察 report.ts 怎么调用这两个函数来证明。
// 这里各包一层 vi.fn，实现原样透传：报告的内容与不包时完全一致，只是多了调用记录（用例之间在 beforeEach 里清空）。
vi.mock("./report-facts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./report-facts")>();
  return { ...original, prepareReportSession: vi.fn(original.prepareReportSession) };
});
vi.mock("./report-session", async (importOriginal) => {
  const original = await importOriginal<typeof import("./report-session")>();
  return { ...original, formatSession: vi.fn(original.formatSession) };
});

// ───────────────────────── 字符数上限 ─────────────────────────

/** 一棵很大的树：根加 40 个子会话。用来走预算耗尽的路径（根总是要读，其余整段略去）。 */
function bigTree(): { root: Built; all: Built[] } {
  const base = family()[2] as Built;
  const kids: Built[] = Array.from({ length: 40 }, (_, index) =>
    build(`ses_k${String(index).padStart(2, "0")}`, (log) => startTask(log, `kid ${index}`), {
      title: `Kid ${index}`,
      parentSessionId: "ses_root",
      depth: 1,
      createdAt: `2026-01-02T00:${String(index).padStart(2, "0")}:00.000Z`,
    }),
  );
  const root: Built = { events: base.events, summary: { ...base.summary, childIds: kids.map((kid) => kid.summary.id) } };
  return { root, all: [root, ...kids] };
}

/** 一个很大的单会话：1000 字符的委派原文、200 条命令、5 万字符的回答。几个描述块共用，用来走“逐档收紧”的路径。 */
function bigSession(): Built {
  const text = `BIG-TASK ${"x".repeat(1000)}`;
  return build(
    "ses_big",
    (log) => {
      startTask(log, text);
      for (let i = 1; i <= 200; i++) log.tool("run_1", `cmd-${String(i).padStart(3, "0")}`, "completed");
      say(log, "run_1", "A".repeat(50_000), "ans");
      finish(log, "run_1");
    },
    { title: "Big session", ...taskMeta(text) },
  );
}

describe("maxChars", () => {
  it("shrinks the quotes to fit, says so, and stays within the limit with every fence closed", () => {
    const markdown = render([bigSession()], { maxChars: 8_000 });
    expect(markdown.length).toBeLessThanOrEqual(8_000);
    expect(fencesClosed(markdown)).toBe(true);
    expect(markdown).toContain("To fit the 8,000-character limit this section was shortened");
    expect(markdown).toContain("1 session(s) were shortened");
    expect(markdown).toContain(`## ${REPORT_LABELS.en.notes}`);
    expect(markdown).toContain(`## ${REPORT_LABELS.en.result}`);
  });

  it("treats a limit below the minimum as the minimum", () => {
    const markdown = render([bigSession()], { maxChars: 100 });
    expect(markdown.length).toBeLessThanOrEqual(REPORT_LIMITS.minChars);
    expect(markdown).toContain(`## ${REPORT_LABELS.en.delegation}`);
  });

  it("does not shorten anything without a limit", () => {
    const markdown = render([bigSession()]);
    expect(markdown).not.toContain("this section was shortened");
    expect(markdown).not.toContain("Report cut here");
  });

  it("collapses the older runs of a session with many runs to one line each", () => {
    const talkative = build("ses_many", (log) => {
      for (let i = 1; i <= 30; i++) {
        const messageId = `msg_${i}`;
        const runId = `run_${i}`;
        log.message(messageId, i === 1 ? "task" : "follow_up", i === 1 ? "First task" : `Follow-up number ${i}`, i === 1 ? AGENT : USER);
        log.run(runId, i, messageId, i === 1 ? "task" : "follow_up");
        log.startRun(runId);
        say(log, runId, `Answer number ${i}`, `a${i}`);
        finish(log, runId);
      }
    });
    const markdown = render([talkative], { maxChars: 7_000 });
    expect(markdown.length).toBeLessThanOrEqual(7_000);
    expect(fencesClosed(markdown)).toBe(true);
    expect(markdown).toContain("earlier runs get one line each");
    expect(markdown).toMatch(/^- Run 1 — completed/m);
  });

  it("always renders the root session, even when the budget reserved for the head and tail alone exceeds the limit", () => {
    // 预留（reserveFor）只是给各会话划预算用的估计，比实际的头尾大得多：41 个会话、6000 的上限时它把正文预算吃光了，
    // 但真实的头尾（目录最多占 25%，且只有收下的会话进用量表）加上小小的根会话放得进上限——不需要安全网，也就不会有截断提示。
    const { all } = bigTree();
    const markdown = render(all, { scope: "tree", maxChars: REPORT_LIMITS.minChars }, "ses_root");
    expect(markdown.length).toBeLessThanOrEqual(REPORT_LIMITS.minChars);
    // 根的小标题在正文最前面：根整段都在（而不是整份只剩一串“没收录”的目录项）。
    expect(markdown).toContain("### 1 Root");
    expect(markdown).toContain("ROOT-TASK-MARKER");
    expect(markdown).toContain("Root answer");
    // 其余 40 个会话在目录里逐条标明没有收录；整份没有被截断，所以也没有截断提示。
    expect(markdown).toContain("| Sessions | 41 (40 not included) |");
    expect(markdown).toContain("not included (size limit)");
    expect(markdown).not.toContain("Report cut here");
    expect(fencesClosed(markdown)).toBe(true);
  });

  it("always renders the root session first, and cuts after it with a note when even its tightest section does not fit the limit", () => {
    // 根会话带 120 条上下文文件：这一节在最紧的一级里也放不进 6000 字符，只有最后的安全网能把整份压回上限。
    const context: ContextItem[] = Array.from({ length: 120 }, (_, index) => ({ kind: "file", path: `src/module-${index}/file-${index}.ts`, note: `why file ${index} matters` }));
    const { all } = bigTree();
    const root = build(
      "ses_root",
      (log) => {
        startTask(log, "ROOT-TASK-MARKER");
        say(log, "run_1", "Root answer", "a1");
        finish(log, "run_1");
      },
      { title: "Root", createdAt: "2026-01-01T00:00:00.000Z", ...taskMeta("ROOT-TASK-MARKER", context) },
      all.slice(1).map((kid) => kid.summary.id),
    );
    const markdown = render([root, ...all.slice(1)], { scope: "tree", maxChars: REPORT_LIMITS.minChars }, "ses_root");
    expect(markdown.length).toBeLessThanOrEqual(REPORT_LIMITS.minChars);
    // 根的小标题在正文最前面：不管最后的安全网从哪里裁，它都在（而不是整份只剩一串“没收录”的目录项）。
    expect(markdown).toContain("### 1 Root");
    expect(markdown).toContain("Report cut here");
    expect(fencesClosed(markdown)).toBe(true);
  });
});

describe("ReportBuilder", () => {
  it("stops asking for events once the budget is gone, but always wants the root's", () => {
    const { root, all } = bigTree();
    const builder = new ReportBuilder("ses_root", all.map((entry) => entry.summary), options({ scope: "tree", maxChars: REPORT_LIMITS.minChars }));
    expect(builder.order[0]?.id).toBe("ses_root");
    expect(builder.order).toHaveLength(41);
    expect(builder.wantsEvents()).toBe(true);
    builder.add("ses_root", root.events);
    expect(builder.wantsEvents()).toBe(false);
    for (const summary of builder.order.slice(1)) builder.add(summary.id, undefined);
    const markdown = builder.build();
    expect(markdown.length).toBeLessThanOrEqual(REPORT_LIMITS.minChars);
    expect(markdown).toContain(REPORT_LABELS.en.dirOmitted);
  });

  it("insists on getting the sessions in its own order", () => {
    const sessions = family();
    const builder = new ReportBuilder("ses_root", sessions.map((entry) => entry.summary), options({ scope: "tree" }));
    expect(() => builder.add("ses_g", [])).toThrow(/expected session ses_root next/);
  });

  it("needs the root to be among the summaries", () => {
    const sessions = family();
    expect(() => new ReportBuilder("ses_nope", sessions.map((entry) => entry.summary), options())).toThrow(/ses_nope/);
  });

  it("gives the same text as the one-shot renderer", () => {
    const sessions = family();
    const builder = new ReportBuilder("ses_root", sessions.map((entry) => entry.summary), options({ scope: "tree" }));
    const events = new Map(sessions.map((entry) => [entry.summary.id, entry.events] as const));
    for (const summary of builder.order) builder.add(summary.id, events.get(summary.id));
    expect(builder.build()).toBe(render(sessions, { scope: "tree" }, "ses_root"));
  });
});

describe("cutMarkdown", () => {
  it("returns text that already fits unchanged", () => {
    expect(cutMarkdown("aa\nbb", 100)).toBe("aa\nbb");
  });

  it("cuts at a line boundary", () => {
    expect(cutMarkdown("aa\nbb\ncc", 6)).toBe("aa\nbb");
  });

  it("closes a fence that the cut left open", () => {
    expect(cutMarkdown("```text\nline1\nline2\nline3\n```", 20)).toBe("```text\nline1\n```");
  });
});

// ───────────────────────── 会话的事实：整理一次，预算各档共用 ─────────────────────────

// 这两条原来与 report.facts.test.ts 里的用例同属 describe("the facts of a session")：它们要观察 prepareReportSession 与 formatSession 的调用，
// 又要用本文件的 bigSession / bigTree，所以放在这里；describe 的名字与用例标题都没有改。
describe("the facts of a session", () => {
  beforeEach(() => {
    vi.mocked(reportFacts.prepareReportSession).mockClear();
    vi.mocked(reportSession.formatSession).mockClear();
  });

  it("prepares a session once however many tightening levels it takes, and every level reads the same facts", () => {
    render([bigSession()], { maxChars: 8_000 });
    const prepare = vi.mocked(reportFacts.prepareReportSession);
    const format = vi.mocked(reportSession.formatSession);
    expect(prepare).toHaveBeenCalledTimes(1);
    // 第 0 档（基础上限）里仅回答就有三万字符，放不进这份预算：至少还试了第 1 档；档位按 0、1、2… 的顺序逐级试。
    const levels = format.mock.calls.map((call) => call[3]);
    expect(levels.length).toBeGreaterThan(1);
    expect(levels).toEqual(levels.map((_, index) => index));
    const prepared = prepare.mock.results[0]?.value;
    expect(prepared).toBeDefined();
    for (const call of format.mock.calls) expect(call[0]).toBe(prepared);
  });

  it("tries all five levels on the root against one set of facts, and prepares nothing for the sessions the budget has no room for", () => {
    const { all } = bigTree();
    render(all, { scope: "tree", maxChars: REPORT_LIMITS.minChars }, "ses_root");
    const prepare = vi.mocked(reportFacts.prepareReportSession);
    const format = vi.mocked(reportSession.formatSession);
    // 41 个会话、6000 字符的上限：为头尾预留的估计值（8520）已经超过上限，正文预算为 0。
    // 根会话仍要渲染；其余 40 个在整理事实之前就被略去，它们的事件根本不会被回放。
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]?.[0].id).toBe("ses_root");
    // 份额是 0，没有哪一档放得进：五档都试过，读的是同一份事实。
    expect(format.mock.calls.map((call) => call[3])).toEqual([0, 1, 2, 3, 4]);
    const prepared = prepare.mock.results[0]?.value;
    for (const call of format.mock.calls) expect(call[0]).toBe(prepared);
  });
});
