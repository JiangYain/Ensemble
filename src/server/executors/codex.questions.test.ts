import { afterEach, describe, expect, it } from "vitest";
import { toSummary } from "@shared/projection";
import { USER } from "@shared/testing";
import { itemsOf, shutdownTrackedEnvs, stateOf, until, type TestEnv } from "../testing";
import { WAIT, assistants, completed, delegate, diagnostics, setup, tools, type LogLine, type Params } from "./codex.fixtures";

/**
 * Codex 适配器：没有授权闸门，以及业务提问。授权请求（线程以 approvalPolicy=never 启动，本不该再收到）当场自己应答、从不变成提问；
 * 提问则中继给委派方、等回复并按 Codex 期望的形状答回，取消或停止时记为过期，机密类提问整个不转交。
 * 其余用例在 codex.test.ts 与 codex.mapping.test.ts；假进程的启动与读时间线的小函数共用，在 codex.fixtures.ts。
 */

afterEach(shutdownTrackedEnvs);

const questionsOf = (env: TestEnv, sessionId: string) => itemsOf(env, sessionId, "question");
/** 等到提问落进时间线、还在待回答。 */
const asked = async (env: TestEnv, sessionId: string) => {
  await until(() => questionsOf(env, sessionId).some((question) => question.status === "open"), WAIT, "question asked");
  return questionsOf(env, sessionId)[0]!;
};

describe("Codex adapter: no approval gate, and questions", () => {
  const answers = (lines: LogLine[]): Params[] => lines.flatMap((line) => (line.response?.result ? [line.response.result] : []));

  // 线程以 approvalPolicy=never 启动，Codex 不应再发授权请求；这里模拟“仍然收到了”的例外情况，
  // 适配器必须当场自己应答，会话不会停下来等人——Full Access 放行，只读拒绝。
  it("answers a stray command approval by itself in a Full Access session and never waits", async () => {
    const { env, log } = setup();
    const { sessionId } = await delegate(env, { task: "Write out.txt [fake:approval]" });
    await completed(env, sessionId);

    expect(answers(log())).toContainEqual({ decision: "accept" });
    expect(assistants(env, sessionId).at(-1)?.text).toBe("DONE (written)");
    expect(tools(env, sessionId)[0]?.status).toBe("completed");
    expect(stateOf(env, sessionId).status).toBe("idle");
    expect(diagnostics(env, sessionId).find((item) => item.code === "codex.approval_granted")).toMatchObject({
      level: "info",
      message: expect.stringContaining("Set-Content -LiteralPath .\\out.txt -Value hello"),
    });
  });

  it("declines a stray command approval by itself in a read-only session and says so", async () => {
    const { env, log } = setup();
    const { sessionId } = await delegate(env, { task: "Write out.txt [fake:approval]", access: "read_only" });
    await completed(env, sessionId);

    expect(answers(log())).toContainEqual({ decision: "decline" });
    expect(assistants(env, sessionId).at(-1)?.text).toBe("DONE (declined)");
    expect(tools(env, sessionId)[0]?.status).toBe("cancelled");
    expect(diagnostics(env, sessionId).find((item) => item.code === "codex.approval_declined")).toMatchObject({ level: "warn" });
  });

  it.each([
    { access: "full", decision: "accept", answer: "WRITTEN", files: 1, code: "codex.approval_granted" },
    { access: "read_only", decision: "decline", answer: "SKIPPED", files: 0, code: "codex.approval_declined" },
  ] as const)("answers a stray file-change approval itself ($access) and only counts what was really written", async ({ access, decision, answer, files, code }) => {
    const { env, log } = setup();
    const { sessionId } = await delegate(env, { task: "Write outside [fake:fileapproval]", access });
    await completed(env, sessionId);

    expect(answers(log())).toContainEqual({ decision });
    expect(assistants(env, sessionId).at(-1)?.text).toBe(answer);
    expect(toSummary(stateOf(env, sessionId)).counters.files).toBe(files);
    expect(diagnostics(env, sessionId).some((item) => item.code === code && item.message.includes("outside.txt"))).toBe(true);
  });

  it.each([
    { access: "full", granted: { network: { enabled: true } }, answer: "GRANTED", code: "codex.approval_granted" },
    { access: "read_only", granted: {}, answer: "NOT GRANTED", code: "codex.approval_declined" },
  ] as const)("grants only what was asked for in a $access session, and nothing in a read-only one", async ({ access, granted, answer, code }) => {
    const { env, log } = setup();
    const { sessionId } = await delegate(env, { task: "Install a package [fake:permissions]", access });
    await completed(env, sessionId);

    expect(answers(log())).toContainEqual({ permissions: granted, scope: "turn" });
    expect(assistants(env, sessionId).at(-1)?.text).toBe(answer);
    expect(diagnostics(env, sessionId).some((item) => item.code === code && item.message.includes("Needs network access"))).toBe(true);
  });

  // 授权请求在任何情况下都不等人，也从不变成提问——提问是另一回事（见下面的用例）。
  it.each(["full", "read_only"] as const)("never turns a stray approval request into a question (%s): it is answered on the spot", async (access) => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Write out.txt [fake:approval]", access });
    await completed(env, sessionId);
    expect(questionsOf(env, sessionId)).toEqual([]);
    expect(toSummary(stateOf(env, sessionId)).openQuestions).toBeUndefined();
  });

  it("relays a blocking question to the delegator, keeps the run waiting, and answers in the shape Codex expects", async () => {
    const { env, log } = setup();
    const { sessionId } = await delegate(env, { task: "Update the package [fake:question]" });
    const question = await asked(env, sessionId);

    // 问题原样呈现（含 Codex 给的标题）；回合还在等，会话没有因此换成别的阶段，也没有“无法中继”的诊断。
    expect(question.prompts).toEqual([{ key: "q1", header: "Scope", text: "Which package should I update?", multiple: false, custom: true }]);
    expect(stateOf(env, sessionId).runs[0]?.status).toBe("running");
    expect(toSummary(stateOf(env, sessionId)).openQuestions).toBe(1);
    expect(diagnostics(env, sessionId).some((item) => item.code === "codex.question_unanswered")).toBe(false);
    expect(answers(log())).toEqual([]);

    const resolved = await env.manager.answerQuestion(sessionId, question.questionId, { answer: "The web package" }, USER);
    expect(resolved).toMatchObject({ status: "answered", outcome: { by: USER, delivery: "handed_off", answers: [["The web package"]] } });
    await completed(env, sessionId);

    // 回复的形状是推断的（见 codex-questions.ts）；假 Codex 把它收到的原样写进了最终文字。
    expect(answers(log())).toContainEqual({ answers: { q1: { answers: ["The web package"] } } });
    expect(assistants(env, sessionId).at(-1)?.text).toBe('Got an answer: {"answers":{"q1":{"answers":["The web package"]}}}');
    expect(questionsOf(env, sessionId)[0]).toMatchObject({ status: "answered" });
    expect(toSummary(stateOf(env, sessionId)).openQuestions).toBeUndefined();
  });

  it("keys each reply by Codex's own question id, checks labels, and leaves the question open after a bad answer", async () => {
    const { env, log } = setup();
    const { sessionId } = await delegate(env, { task: "Update the packages [fake:questions]" });
    const question = await asked(env, sessionId);
    expect(question.prompts).toEqual([
      { key: "scope", header: "Scope", text: "Which package should I update?", options: [{ label: "core", description: "The core package" }, { label: "web", description: "The web package" }], multiple: false, custom: false },
      { key: "note", header: "Note", text: "Anything else I should know?", multiple: false, custom: true },
    ]);

    // 第一个问题只能选固定选项：选项以外的回答是调用方的错，提问仍在等。
    await expect(env.manager.answerQuestion(sessionId, question.questionId, { answers: ["mobile", "none"] }, USER)).rejects.toMatchObject({ code: "invalid_request" });
    expect(questionsOf(env, sessionId)[0]?.status).toBe("open");
    expect(answers(log())).toEqual([]);

    await env.manager.answerQuestion(sessionId, question.questionId, { answers: ["WEB", "No, that is all"] }, USER);
    await completed(env, sessionId);
    expect(answers(log())).toContainEqual({ answers: { scope: { answers: ["web"] }, note: { answers: ["No, that is all"] } } });
  });

  it("declining answers Codex with an error and an explanation, so the model assumes and continues", async () => {
    const { env, log } = setup();
    const { sessionId } = await delegate(env, { task: "Update the package [fake:question]" });
    const question = await asked(env, sessionId);

    const resolved = await env.manager.declineQuestion(sessionId, question.questionId, undefined, USER);
    expect(resolved).toMatchObject({ status: "declined", outcome: { by: USER, delivery: "handed_off" } });
    await completed(env, sessionId);
    const refusal = log().find((line) => line.response?.error?.code === -32000);
    expect(refusal?.response?.error?.message).toContain("chose not to answer this question");
    expect(assistants(env, sessionId).at(-1)?.text).toContain("Proceeding with an assumption (Whoever delegated this task chose not to answer");
    expect(questionsOf(env, sessionId)[0]).toMatchObject({ status: "declined" });
  });

  it("lets only the first of two simultaneous replies win; the other is told who got there first", async () => {
    const { env, log } = setup();
    const { sessionId } = await delegate(env, { task: "Update the package [fake:question]" });
    const question = await asked(env, sessionId);

    const results = await Promise.allSettled([
      env.manager.answerQuestion(sessionId, question.questionId, { answer: "core" }, USER),
      env.manager.answerQuestion(sessionId, question.questionId, { answer: "web" }, { kind: "agent", label: "Main agent" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(lost?.reason).toMatchObject({ code: "conflict" });
    await completed(env, sessionId);
    // Codex 只收到一次回复。
    expect(answers(log())).toHaveLength(1);
  });

  it("records a question as expired (cancelled) when the run is cancelled while it is open, and refuses a late answer", async () => {
    const { env, log } = setup();
    const { sessionId } = await delegate(env, { task: "Update the package [fake:question]" });
    const question = await asked(env, sessionId);

    await env.manager.cancel(sessionId, USER);
    await until(() => stateOf(env, sessionId).runs[0]?.status === "cancelled", WAIT, "run cancelled");
    expect(questionsOf(env, sessionId)[0]).toMatchObject({ status: "expired", outcome: { by: { kind: "system" }, reason: "cancelled" } });
    await expect(env.manager.answerQuestion(sessionId, question.questionId, { answer: "web" }, USER)).rejects.toMatchObject({ code: "conflict" });
    // 已经没有人在等：没有任何回复被写给 Codex。
    expect(answers(log())).toEqual([]);
  });

  it("records the question as expired (session closed) when the session is stopped while it is open", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Update the package [fake:question]" });
    await asked(env, sessionId);
    await env.manager.stop(sessionId, USER);
    expect(questionsOf(env, sessionId)[0]).toMatchObject({ status: "expired", outcome: { reason: "session_closed" } });
    expect(toSummary(stateOf(env, sessionId)).openQuestions).toBeUndefined();
  });

  it("never relays a question that asks for a secret: Codex is told it cannot, and nothing about it opens", async () => {
    const { env, log } = setup();
    const { sessionId } = await delegate(env, { task: "Call the API [fake:secret]" });
    await completed(env, sessionId);
    expect(questionsOf(env, sessionId)).toEqual([]);
    expect(diagnostics(env, sessionId).find((item) => item.code === "codex.question_secret")).toMatchObject({ level: "warn", message: expect.stringContaining("does not relay secrets") });
    expect(log().find((line) => line.response?.error?.code === -32000)?.response?.error?.message).toContain("secret value");
    expect(assistants(env, sessionId).at(-1)?.text).toContain("Proceeding with an assumption");
    // 诊断里也不带问题正文，免得把用户要被问的东西留在日志里。
    expect(JSON.stringify(stateOf(env, sessionId).timeline)).not.toContain("Paste your API token");
  });

  it("keeps the old refusal when nobody is waiting for the answer (isBlocking=false)", async () => {
    const { env, log } = setup();
    const { sessionId } = await delegate(env, { task: "Update the package [fake:nonblocking]" });
    await completed(env, sessionId);
    expect(questionsOf(env, sessionId)).toEqual([]);
    expect(diagnostics(env, sessionId).find((item) => item.code === "codex.question_unanswered")).toMatchObject({
      level: "warn",
      message: expect.stringContaining("Which package should I update?"),
    });
    expect(log().some((line) => line.response?.error?.code === -32000)).toBe(true);
    expect(assistants(env, sessionId).at(-1)?.text).toContain("Proceeding with an assumption");
  });

  it("cancels MCP elicitations it cannot answer and says so", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Search the docs [fake:elicit]" });
    await completed(env, sessionId);
    expect(diagnostics(env, sessionId).find((item) => item.code === "codex.elicitation_cancelled")).toMatchObject({
      level: "warn",
      message: expect.stringContaining('"docs"'),
    });
    expect(assistants(env, sessionId).at(-1)?.text).toBe("elicitation action: cancel");
  });
});
