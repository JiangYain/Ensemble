import { changed, fail, finish, say, startRun } from "@shared/handoff.fixtures";
import { EventLog } from "@shared/testing";
import type { ContextItem, FileChange } from "@shared/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AT, CAP, FakeHub, HEAD, UP, answered, fake, prepare, ref, rejection, summaryOf, type Fake } from "./context-refs.fixtures";

/**
 * 会话引用的展开（二）：取不到的部分、拒绝与额度。取不到的部分写明原因，不留空也不编；拒绝都说明白，不悄悄丢内容；
 * 额度是一次委派最多引用多少个会话，以及每一块和合成后的整段提示各自的上限。
 * 注入文本在 context-refs.test.ts，合并与单块渲染在 context-refs.merge.test.ts；假中枢与造数据的辅助见 context-refs.fixtures.ts。
 */

const where = (id: string): string => `Ensemble session ${id} (page #/s/${id}, or the read tool)`;

// 取样时刻是注入文本的一部分：把日期定住，整段文字才能逐字断言。
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(AT) });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("prepareSessionContext：取不到的部分如实说，不留空也不编", () => {
  it("没有任何运行的会话：三样都是一句话，写明原因与当时的阶段，回执里是对应的事实", async () => {
    const upstream = fake(UP, { phase: "ready" });

    const prepared = await prepare(new FakeHub(upstream), [ref(UP, { include: ["result", "files", "error"] })]);

    const tail = [
      "#### Final answer",
      "None: this session has no runs (session phase at sampling: ready).",
      "",
      "#### Files changed",
      "None: no run in this session reported a file change (session phase at sampling: ready). Edits made through shell commands may not be reported.",
      "",
      "#### Last error",
      "None: no run or session failure was recorded (session phase at sampling: ready).",
    ].join("\n");
    expect(prepared.prompt.endsWith(tail)).toBe(true);
    expect(prepared.receipts[0]).toMatchObject({
      runCount: 0,
      result: { found: false, reason: "no_runs" },
      files: { total: 0, sent: 0 },
      error: { found: false },
    });
  });

  it.each(["ready", "done", "failed", "cancelled", "stopped", "lost"] as const)("阶段是 %s 的会话不算进行中，可以引用，回执写明当时的阶段", async (phase) => {
    const prepared = await prepare(new FakeHub(answered(UP, { phase })), [ref(UP)]);

    expect(prepared.receipts[0]?.phase).toBe(phase);
    expect(prepared.prompt).toContain(`phase "${phase}"`);
  });
});

describe("prepareSessionContext：拒绝（都说明白，不悄悄丢内容）", () => {
  it("引用的会话不存在：点名，一次说全，不读任何日志", async () => {
    const hub = new FakeHub(answered(UP));

    const one = await rejection(prepare(hub, [ref("ses_ghost")]));
    expect(one.code).toBe("not_found");
    expect(one.message).toBe("Session ses_ghost referenced in context does not exist.");
    expect(one.details).toEqual({ via: "context", sessionIds: ["ses_ghost"] });

    const several = await rejection(prepare(hub, [ref("ses_x"), ref(UP), ref("ses_y")]));
    expect(several.message).toBe("Sessions ses_x, ses_y referenced in context do not exist.");
    expect(several.details).toEqual({ via: "context", sessionIds: ["ses_x", "ses_y"] });
    expect(hub.reads).toEqual([]);
  });

  it.each(["starting", "queued", "running"] as const)("引用的会话是 %s：拒绝，点名并写明阶段，不读任何日志", async (phase) => {
    const hub = new FakeHub(answered(UP, { phase }));

    const error = await rejection(prepare(hub, [ref(UP)]));

    expect(error.code).toBe("context_session_active");
    expect(error.status).toBe(409);
    expect(error.message).toBe(
      `Session ses_up (${phase}) is still in progress, so its output is not final and cannot be handed over yet. Wait for it to finish, then delegate again.`,
    );
    expect(error.details).toEqual({ via: "context", sessions: [{ sessionId: UP, phase }] });
    expect(hub.reads).toEqual([]);
  });

  it("好几个会话都还在进行：一次点名全部，不是改一个再撞下一个", async () => {
    const hub = new FakeHub(answered("ses_a", { phase: "running" }), answered("ses_b", { phase: "queued" }), answered("ses_c"));

    const error = await rejection(prepare(hub, [ref("ses_a"), ref("ses_b"), ref("ses_c")]));

    expect(error.message).toBe(
      "Sessions ses_a (running), ses_b (queued) are still in progress, so their output is not final and cannot be handed over yet. Wait for them to finish, then delegate again.",
    );
    expect(error.details).toEqual({
      via: "context",
      sessions: [
        { sessionId: "ses_a", phase: "running" },
        { sessionId: "ses_b", phase: "queued" },
      ],
    });
  });

  it("不存在与进行中同时出现：先说不存在", async () => {
    const hub = new FakeHub(answered("ses_a", { phase: "running" }));

    const error = await rejection(prepare(hub, [ref("ses_a"), ref("ses_ghost")]));

    expect(error.code).toBe("not_found");
  });

  it("读冷会话的期间，另一个已经定稿的引用又开始运行了：读完之后重新核对，照样拒绝", async () => {
    const cold = answered("ses_a");
    const hot = answered("ses_b", { hot: true });
    const hub = new FakeHub(cold, hot);
    hub.onRead = () => {
      hot.summary = { ...hot.summary, phase: "running" };
    };

    const error = await rejection(prepare(hub, [ref("ses_a"), ref("ses_b")]));

    expect(error.code).toBe("context_session_active");
    expect(error.details).toEqual({ via: "context", sessions: [{ sessionId: "ses_b", phase: "running" }] });
  });

  it("读冷会话的期间它又有了新事件：重读，交出去的是读完那一刻的最新内容，阶段与事件取自同一个时刻", async () => {
    const log = new EventLog(UP);
    log.created();
    startRun(log, "run_1", 1);
    say(log, "run_1", "item_0", "old answer", "final");
    finish(log, "run_1");
    const session: Fake = { summary: summaryOf(UP, {}, log.events.length), events: [...log.events], hot: false };
    const hub = new FakeHub(session);
    hub.onRead = () => {
      if (hub.reads.length !== 1) return;
      // 第一次读返回的是旧日志；读完之后上游又写了一条新的最终回答。
      say(log, "run_1", "item_1", "new answer", "final");
      session.events = [...log.events];
      session.summary = { ...session.summary, seq: log.events.length };
    };

    const prepared = await prepare(hub, [ref(UP)]);

    expect(hub.reads).toEqual([UP, UP]);
    expect(prepared.prompt).toContain("new answer");
    expect(prepared.prompt).not.toContain("old answer");
  });

  it("上游一直在变、读几次都对不上：拒绝并说明，不拿旧日志去配新的阶段", async () => {
    const session = answered(UP);
    const hub = new FakeHub(session);
    hub.onRead = () => {
      session.summary = { ...session.summary, seq: session.summary.seq + 1 };
    };

    const error = await rejection(prepare(hub, [ref(UP)]));

    expect(error.code).toBe("conflict");
    expect(error.message).toBe(`Session ${UP} kept changing while its record was being read. Try again in a moment.`);
    expect(error.details).toEqual({ via: "context", sessionIds: [UP] });
    expect(hub.reads).toHaveLength(4);
  });

  it("日志读不出来（一条事件都没有）：说是读不出来，不说“这个会话什么都没有”", async () => {
    const session = answered(UP);
    session.events = [];
    const hub = new FakeHub(session);

    const error = await rejection(prepare(hub, [ref(UP)]));

    expect(error.code).toBe("internal");
    expect(error.message).toBe(`The record of session ${UP} could not be read, so nothing can be handed over from it.`);
    expect(error.details).toEqual({ via: "context", sessionId: UP });
  });
});

describe("prepareSessionContext：额度", () => {
  it(`一次委派最多引用 ${CAP.maxRefs} 个不同的会话，在读任何日志之前就拒绝；同一个会话写多少次都只算一个`, async () => {
    const tooMany: ContextItem[] = Array.from({ length: CAP.maxRefs + 1 }, (_, index) => ref(`ses_${index}`));

    const hub = new FakeHub();
    const error = await rejection(prepare(hub, tooMany));
    expect(error.code).toBe("context_too_large");
    expect(error.status).toBe(422);
    expect(error.message).toBe(
      `context references ${CAP.maxRefs + 1} different sessions; a delegation can reference at most ${CAP.maxRefs}. Reference only the sessions this work really depends on.`,
    );
    expect(error.details).toEqual({ via: "context", refs: CAP.maxRefs + 1, maxRefs: CAP.maxRefs });

    const repeated: ContextItem[] = Array.from({ length: CAP.maxRefs + 2 }, () => ref(UP));
    const prepared = await prepare(new FakeHub(answered(UP)), repeated);
    expect(prepared.context).toHaveLength(1);
  });

  it("回答超过上限：只交出开头的部分，写明交了多少、省略了多少、去哪里读全文，回执里的字符数与之一致", async () => {
    const omitted = 50;
    const long = "x".repeat(CAP.maxResultChars + omitted);

    const prepared = await prepare(new FakeHub(answered(UP, {}, long)), [ref(UP)]);

    expect(prepared.prompt).toContain(
      `\`\`\`text\n${"x".repeat(CAP.maxResultChars)}\n\`\`\`\n`
        + `[Truncated: only the first ${CAP.maxResultChars} of ${long.length} characters are included (${omitted} omitted). Full text: ${where(UP)}.]`,
    );
    expect(prepared.prompt).not.toContain("x".repeat(CAP.maxResultChars + 1));
    expect(prepared.receipts[0]?.result).toEqual({ found: true, label: "final", runIndex: 1, chars: long.length, sentChars: CAP.maxResultChars });
  });

  it("文件太多：只列上限以内的，写明一共多少个、列了几个、去哪里看全部", async () => {
    const total = CAP.maxFiles + 3;
    const upstream = fake(UP, {}, (log) => {
      startRun(log, "run_1", 1);
      changed(
        log,
        "run_1",
        Array.from({ length: total }, (_, index): [string, FileChange["change"]] => [`src/file-${String(index).padStart(3, "0")}.ts`, "modified"]),
      );
      finish(log, "run_1");
    });

    const prepared = await prepare(new FakeHub(upstream), [ref(UP, { include: ["files"] })]);

    expect(prepared.prompt).toContain(`#### Files changed (${total} paths across all 1 run, as reported by the executor)`);
    expect(prepared.prompt).toContain("- src/file-000.ts (modified)");
    expect(prepared.prompt).toContain(`- src/file-${String(CAP.maxFiles - 1).padStart(3, "0")}.ts (modified)`);
    expect(prepared.prompt).not.toContain(`src/file-${String(CAP.maxFiles).padStart(3, "0")}.ts`);
    expect(prepared.prompt).toContain(`- … 3 more not listed (${CAP.maxFiles} of ${total} shown). Full list: ${where(UP)}.`);
    expect(prepared.receipts[0]?.files).toEqual({ total, sent: CAP.maxFiles });
  });

  it("错误消息太长：同样截断并写明，回执里标出被截断了", async () => {
    const message = "e".repeat(CAP.maxErrorChars + 10);
    const upstream = fake(UP, { phase: "failed" }, (log) => {
      startRun(log, "run_1", 1);
      fail(log, "run_1", "boom", message);
    });

    const prepared = await prepare(new FakeHub(upstream), [ref(UP, { include: ["error"] })]);

    expect(prepared.prompt).toContain("#### Last error (run 1 of 1, code: boom)");
    expect(prepared.prompt).toContain(
      `[Truncated: only the first ${CAP.maxErrorChars} of ${message.length} characters are included (10 omitted). Full text: ${where(UP)}.]`,
    );
    expect(prepared.receipts[0]?.error).toEqual({ found: true, code: "boom", runIndex: 1, truncated: true });
  });

  it("合成后的提示按字符数卡总额：恰好等于上限放行，多一个字符就拒绝，并分项说明", async () => {
    const hub = new FakeHub(answered(UP));
    const probe = await prepare(hub, [ref(UP)], "x");
    const blockLength = probe.prompt.length - "x".length - HEAD.length;
    const exact = "t".repeat(CAP.maxPromptChars - HEAD.length - blockLength);

    const accepted = await prepare(hub, [ref(UP)], exact);
    expect(accepted.prompt).toHaveLength(CAP.maxPromptChars);

    const error = await rejection(prepare(hub, [ref(UP)], `${exact}t`));
    expect(error.code).toBe("context_too_large");
    expect(error.message).toContain(`come to ${CAP.maxPromptChars + 1} characters, over the limit of ${CAP.maxPromptChars} for a delegation that references sessions`);
    expect(error.message).toContain(`(task ${exact.length + 1}; session ses_up ${blockLength}; other context ${HEAD.length})`);
    expect(error.message).toContain("Narrow `include`, drop a reference, shorten the task, or point to a file instead of pasting its content.");
    expect(error.details).toMatchObject({
      via: "context",
      chars: CAP.maxPromptChars + 1,
      maxPromptChars: CAP.maxPromptChars,
      taskChars: exact.length + 1,
      otherChars: HEAD.length,
      refs: [{ sessionId: UP, chars: blockLength }],
    });
  });
});
