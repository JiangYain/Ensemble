import { describe, expect, it } from "vitest";
import { replay, toSummary } from "@shared/projection";
import type { DelegateResponse } from "@shared/protocol";
import { EventLog } from "@shared/testing";
import type { SessionMeta, SessionSummary } from "@shared/types";
import { renderDelegateOutput } from "./delegate-output";
import type { ParentChoice, PreparedDelegation } from "./delegate-request";

/**
 * 委派回执（renderDelegateOutput）：回执只陈述构造请求时留下的事实，不再自己判断条件。
 * 这里按事实造出输入，断言每个事实对应的那一行；措辞里不属于“某个事实”的部分只用片段断言，免得统一措辞时牵连这里。
 * 请求怎么构造出这些事实见 delegate-request.test.ts。
 */

const PANEL = "http://127.0.0.1:47821/#/sessions/ses_new";

function summaryOf(id: string, meta: Partial<SessionMeta> = {}): SessionSummary {
  const log = new EventLog(id);
  log.created(meta);
  const state = replay(log.events);
  if (!state) throw new Error("replay failed");
  return toSummary(state);
}

/** 上级的摘要：标题直接写在摘要上，不依赖投影怎么取标题。 */
const session = (id: string, title: string): SessionSummary => ({ ...summaryOf(id), title });

const NO_PARENTS: ParentChoice = { followed: [], inferred: undefined, wanted: [], recorded: [] };

function prepared(overrides: Partial<PreparedDelegation> = {}): PreparedDelegation {
  return { body: { task: "Do the thing", cwd: "C:\\work\\demo" }, cwdSource: "argument", parents: NO_PARENTS, declaredNotRecorded: false, ...overrides };
}

function created(overrides: Partial<DelegateResponse> = {}): DelegateResponse {
  return { sessionId: "ses_new", runId: "run_1", messageId: "msg_1", summary: summaryOf("ses_new"), ...overrides };
}

const linesOf = (text: string): string[] => text.split("\n");
const lineStarting = (text: string, prefix: string): string | undefined => linesOf(text).find((line) => line.startsWith(prefix));

const NEXT_STEP = "Next: open the panel URL in your browser tool if you have one, so the user can watch and steer. Use `wait` when you need the result.";

describe("renderDelegateOutput：新建了会话", () => {
  it("第一行说明委派给了谁、会话与运行编号；详情里有面板地址；结尾是下一步", () => {
    const { text } = renderDelegateOutput(prepared(), created(), PANEL);
    const lines = linesOf(text);

    expect(lines[0]).toMatch(/^Delegated to Pi — session ses_new, run run_1\./);
    expect(lines).toContain(`    panel: ${PANEL}`);
    expect(lines.at(-3)).toBe("    workspace source: argument");
    expect(lines.at(-2)).toBe("");
    expect(lines.at(-1)).toBe(NEXT_STEP);
  });

  it("结构化结果：没有角色与会话引用的回执时只有这几个键", () => {
    const plain = renderDelegateOutput(prepared(), created(), PANEL);

    expect(Object.keys(plain.data ?? {}).sort()).toEqual(["harness", "panelUrl", "phase", "runId", "sessionId"]);
    expect(plain.data).toMatchObject({ sessionId: "ses_new", runId: "run_1", panelUrl: PANEL, harness: "pi" });
  });

  it("工作目录的出处：显式传的与宿主报告的只写出处；退回桥的进程目录才提醒“要是不是你指的项目就显式传 cwd”", () => {
    const explicit = renderDelegateOutput(prepared({ cwdSource: "argument" }), created(), PANEL).text;
    expect(linesOf(explicit)).toContain("    workspace source: argument");

    const reported = renderDelegateOutput(prepared({ cwdSource: "host-roots" }), created(), PANEL).text;
    expect(linesOf(reported)).toContain("    workspace source: the workspace folder reported by the host");

    const fallback = renderDelegateOutput(prepared({ cwdSource: "bridge-directory" }), created(), PANEL).text;
    const line = lineStarting(fallback, "    workspace source: ");
    expect(line).toContain("the bridge process directory");
    expect(line).toContain("pass `cwd` explicitly");
  });

  it("自报的对话标识老服务存不了：多一行说明；没有这回事就没有这一行", () => {
    const noted = renderDelegateOutput(prepared({ declaredNotRecorded: true }), created(), PANEL).text;
    expect(lineStarting(noted, "    note: ")).toContain("cannot store `conversationId` as a session reference");

    const plain = renderDelegateOutput(prepared(), created(), PANEL).text;
    expect(lineStarting(plain, "    note: ")).toBeUndefined();
  });

  it("并发名额满了、会话在排队：第一句不说“已在后台工作”，而是说明在排队、什么时候开始；别的阶段仍是原来那一句", () => {
    const queued = renderDelegateOutput(prepared(), created({ summary: { ...summaryOf("ses_new"), phase: "queued" } }), PANEL);

    expect(linesOf(queued.text)[0]).toBe(
      "Delegated to Pi — session ses_new, run run_1. It is queued: the concurrent-run limit is full, so it starts when a slot frees up. You do not need to poll.",
    );
    expect(queued.text).not.toContain("working in the background");
    expect(queued.data).toMatchObject({ sessionId: "ses_new", runId: "run_1", phase: "queued" });

    const working = renderDelegateOutput(prepared(), created({ summary: { ...summaryOf("ses_new"), phase: "running" } }), PANEL).text;
    expect(linesOf(working)[0]).toBe("Delegated to Pi — session ses_new, run run_1. It is working in the background; you do not need to poll.");
  });
});

describe("renderDelegateOutput：上级", () => {
  it("没有上级：没有 follows / nested 行", () => {
    const { text } = renderDelegateOutput(prepared(), created(), PANEL);

    expect(lineStarting(text, "    follows ")).toBeUndefined();
    expect(lineStarting(text, "    nested under ")).toBeUndefined();
  });

  it("点名了一个：写出它的编号与标题", () => {
    const parents: ParentChoice = { followed: [session("ses_a", "Review the parser")], inferred: undefined, wanted: ["ses_a"], recorded: ["ses_a"] };

    const line = lineStarting(renderDelegateOutput(prepared({ parents }), created(), PANEL).text, "    follows session ");

    expect(line).toContain("ses_a");
    expect(line).toContain("“Review the parser”");
    expect(line).not.toContain("not nested under");
  });

  it("点名了一个、同时推断出另一个：说明没有采用推断的；推断的就是点名的那个时不说", () => {
    const overridden: ParentChoice = { followed: [session("ses_a", "A")], inferred: "ses_x", wanted: ["ses_a"], recorded: ["ses_a"] };
    const line = lineStarting(renderDelegateOutput(prepared({ parents: overridden }), created(), PANEL).text, "    follows session ");
    expect(line).toContain("not nested under session ses_x");
    expect(line).toContain("`follows` takes precedence");

    const same: ParentChoice = { followed: [session("ses_a", "A")], inferred: "ses_a", wanted: ["ses_a"], recorded: ["ses_a"] };
    const quiet = lineStarting(renderDelegateOutput(prepared({ parents: same }), created(), PANEL).text, "    follows session ");
    expect(quiet).not.toContain("not nested under");
  });

  it("点名了几个、都记录了：一行写出各自的编号与标题，没有老服务的说明", () => {
    const parents: ParentChoice = {
      followed: [session("ses_a", "A"), session("ses_b", "B")],
      inferred: undefined,
      wanted: ["ses_a", "ses_b"],
      recorded: ["ses_a", "ses_b"],
    };

    const { text } = renderDelegateOutput(prepared({ parents }), created(), PANEL);

    const line = lineStarting(text, "    follows 2 sessions: ");
    expect(line).toContain("ses_a “A”, ses_b “B”");
    expect(lineStarting(text, "    note: ")).toBeUndefined();
  });

  it("点名了几个、老服务只记录了第一个：说明记录了哪一个、其余没有连上", () => {
    const parents: ParentChoice = {
      followed: [session("ses_a", "A"), session("ses_b", "B")],
      inferred: undefined,
      wanted: ["ses_a", "ses_b"],
      recorded: ["ses_a"],
    };

    const note = lineStarting(renderDelegateOutput(prepared({ parents }), created(), PANEL).text, "    note: ");

    expect(note).toContain("recorded only the first of them (ses_a)");
    expect(note).toContain("the others are not linked in the panel");
  });

  it("没点名、只是推断出承接：写它接在谁后面", () => {
    const parents: ParentChoice = { followed: [], inferred: "ses_p", wanted: ["ses_p"], recorded: ["ses_p"] };

    const { text } = renderDelegateOutput(prepared({ parents }), created(), PANEL);

    expect(linesOf(text)).toContain("    nested under session ses_p");
    expect(lineStarting(text, "    follows ")).toBeUndefined();
  });
});

describe("renderDelegateOutput：服务命中了重复委派", () => {
  const duplicate = (ageMs: number): DelegateResponse => created({ duplicate: { ageMs } });

  it("不说成“已委派”，也不带请求的事实：没有工作目录出处、上级、说明与下一步", () => {
    const { text } = renderDelegateOutput(
      prepared({ cwdSource: "bridge-directory", declaredNotRecorded: true, parents: { followed: [session("ses_a", "A")], inferred: "ses_x", wanted: ["ses_a"], recorded: ["ses_a"] } }),
      duplicate(4_000),
      PANEL,
    );

    expect(text.startsWith("Not delegated again:")).toBe(true);
    expect(text).toContain("4 s ago");
    expect(text).toContain("session ses_new");
    expect(text).toContain("allowDuplicate: true");
    expect(text).toContain(`    panel: ${PANEL}`);
    expect(text).not.toContain("Delegated to");
    expect(text).not.toContain("workspace source:");
    expect(text).not.toContain("follows");
    expect(text).not.toContain("note:");
    expect(text).not.toContain("Next:");
  });

  it("不到一秒写 just now；结构化结果仍是真实存在的那个会话，并标明重复与它的年龄", () => {
    const { text, data } = renderDelegateOutput(prepared(), duplicate(400), PANEL);

    expect(text).toContain("was created just now as session ses_new");
    expect(data).toMatchObject({ sessionId: "ses_new", runId: "run_1", panelUrl: PANEL, harness: "pi", duplicate: true, duplicateAgeSeconds: 0 });
  });

  it("年龄按四舍五入取整秒", () => {
    expect(renderDelegateOutput(prepared(), duplicate(4_400), PANEL).data).toMatchObject({ duplicateAgeSeconds: 4 });
    expect(renderDelegateOutput(prepared(), duplicate(4_600), PANEL).data).toMatchObject({ duplicateAgeSeconds: 5 });
  });
});
