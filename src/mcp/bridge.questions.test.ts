/**
 * 主 Agent 看到并回复子会话的“提问”：status / wait / read 里的 question 块，send 的 questionId 回复，老服务的协商降级。
 * 提问是执行端遇到需求歧义、停下来等一个答案——不是授权；这里不测任何授权，授权请求由适配器当场应答（见 executors/*.test.ts）。
 * 执行端是 ManualExecutor（由测试决定何时提问、怎样受理回复），一律用临时目录当 ENSEMBLE_HOME，不碰这台机器上真实的数据。
 */
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { LIMITS } from "@shared/constants";
import type { QuestionPrompt } from "@shared/questions";
import { TEST_CAPABILITIES } from "@shared/testing";
import { ReplyRejected } from "../server/executors/types";
import { ManualExecutor, until, type ManualSession, type QuestionReply } from "../server/testing";
import { closeTestBridges, connectTestBridge, simulateOlderService, startTestService } from "./bridge.fixtures";

afterEach(closeTestBridges);

const CHOICE: QuestionPrompt[] = [
  {
    key: "pkg",
    text: "Which package should I update?",
    options: [{ label: "core", description: "the engine" }, { label: "web" }],
    multiple: false,
    custom: true,
  },
];
const TWO: QuestionPrompt[] = [
  { key: "a", header: "Scope", text: "Which package?", options: [{ label: "core" }, { label: "web" }], multiple: false, custom: false },
  { key: "b", text: "Which targets?", options: [{ label: "linux" }, { label: "win" }], multiple: true, custom: false },
];

/** 一个临时目录里的服务，加一个经内存传输连着它的桥与 MCP 客户端。`requested` 收着桥发出的每个请求的地址。 */
async function setup(exec: ManualExecutor) {
  const service = await startTestService({ homePrefix: "ensemble-mcp-questions-", executors: [exec], managerConfig: { duplicateWindowMs: 0 } });
  return { service, ...(await connectTestBridge(service)) };
}

type Harness = Awaited<ReturnType<typeof setup>>;

interface Rig extends Harness {
  exec: ManualExecutor;
  session: ManualSession;
  sessionId: string;
  runId: string;
  questionId: string;
}

/** 一个正在运行、并且停下来问了一个问题的会话（经 MCP 的 delegate 委派）。`reply: "unsupported"` = 这个执行端不接收对提问的回复。 */
async function asking(setupOptions: { reply?: QuestionReply | "unsupported"; prompts?: QuestionPrompt[] } = {}): Promise<Rig> {
  const exec = new ManualExecutor("pi");
  exec.autoStart = true;
  if (setupOptions.reply !== "unsupported") exec.questionReply = setupOptions.reply ?? true;
  const harness = await setup(exec);
  const delegated = await harness.call("delegate", { harness: "pi", task: "Build the service", cwd: tmpdir() });
  expect(delegated.isError, delegated.text).toBe(false);
  const sessionId = delegated.data?.["sessionId"] as string;
  const runId = delegated.data?.["runId"] as string;
  await until(() => harness.service.hub.summary(sessionId)?.phase === "running", 4000, "the run to start");
  const session = exec.sessions[0]!;
  const questionId = session.ask(runId, setupOptions.prompts ?? CHOICE);
  await until(() => harness.service.hub.summary(sessionId)?.attention?.some((item) => item.kind === "question") === true, 4000, "the question to be raised");
  return { ...harness, exec, session, sessionId, runId, questionId };
}

const openCount = (rig: Rig): number => rig.service.hub.summary(rig.sessionId)?.openQuestions ?? 0;

/** 不在写给主模型的提问文字里出现的词：提问不是授权。 */
const AUTHORIZATION_WORDS = /authori[sz]|permission|reject|deny|denied|consent/i;

describe("tools and instructions", () => {
  it("lets `send` carry a reply to a question, and no longer requires `text`", async () => {
    const { client } = await setup(new ManualExecutor("pi"));
    const send = (await client.listTools()).tools.find((tool) => tool.name === "send")!;
    const properties = send.inputSchema.properties as Record<string, { description?: string }>;
    expect(send.inputSchema.required).toEqual(["sessionId"]);
    for (const name of ["text", "questionId", "answer", "answers", "decline"]) expect(properties, name).toHaveProperty(name);
    expect(send.description).toContain("question");
    expect(properties["questionId"]?.description).toContain("question");
    // 八个工具不变：回复提问是 send 的可选参数，不是第九个工具。
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(["cancel", "delegate", "harnesses", "open_panel", "read", "send", "status", "wait"]);
  });

  it("tells the model in the instructions that a session may ask, how to reply, and what happens if nobody does", async () => {
    const { client } = await setup(new ManualExecutor("pi"));
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("may stop to ask a question");
    expect(instructions).toContain("`questionId`");
    expect(instructions).toContain("`decline: true`");
    expect(instructions).toContain(`after ${Math.round(LIMITS.question.timeoutMs / 60_000)} minutes`);
    // 授权的说法不变：被委派的会话不会停下来要批准。
    expect(instructions).toContain("never stop to ask anyone for approval");
  });

  it("describes `wait` and `status` as showing questions", async () => {
    const { client } = await setup(new ManualExecutor("pi"));
    const tools = (await client.listTools()).tools;
    expect(tools.find((tool) => tool.name === "wait")?.description).toContain("asks a question");
    expect(tools.find((tool) => tool.name === "wait")?.description).toContain("even with `attention: false`");
    expect(tools.find((tool) => tool.name === "status")?.description).toContain("`question` block");
  });
});

describe("seeing a question", () => {
  it("`status` lists it as a block with the question, the options and the exact reply to send; the session stays running", async () => {
    const rig = await asking();
    const status = await rig.call("status", { sessionIds: [rig.sessionId] });
    expect(status.isError, status.text).toBe(false);
    expect(status.text).toMatch(new RegExp(`question ${rig.questionId}: Pi has been waiting( for \\S+)? for an answer`));
    expect(status.text).toContain("Which package should I update?");
    expect(status.text).toContain('options (pick one, or write your own): "core" — the engine | "web"');
    expect(status.text).toContain(`reply with \`send\`: { sessionId: "${rig.sessionId}", questionId: "${rig.questionId}", answer:`);
    expect(status.text).toContain("decline: true");
    expect(status.text).not.toMatch(AUTHORIZATION_WORDS);
    // 提问不是一个新的阶段：会话仍然是“运行中”，只是多了一个待回答的提问。
    expect(status.data?.["sessions"]).toEqual([
      expect.objectContaining({ id: rig.sessionId, phase: "running", attention: [expect.objectContaining({ kind: "question", questionId: rig.questionId })] }),
    ]);
  });

  it("`wait` returns for it at once, says it is a question to answer rather than a fact to check, and names it in the data", async () => {
    const rig = await asking();
    const started = Date.now();
    const waited = await rig.call("wait", { sessionIds: [rig.sessionId], timeoutSeconds: 30 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(waited.isError, waited.text).toBe(false);
    expect(waited.text).toContain(`Session ${rig.sessionId} is asking a question and waiting for an answer`);
    expect(waited.text).not.toContain("newly show");
    expect(waited.text).toContain(`question ${rig.questionId}:`);
    expect(waited.text).toContain("Which package should I update?");
    expect(waited.data).toMatchObject({
      reason: "attention",
      raised: [{ sessionId: rig.sessionId, kind: "question", questionId: rig.questionId }],
    });
    expect(waited.text).not.toMatch(AUTHORIZATION_WORDS);
  });

  it("`wait` tells you once: the next wait does not return for the same question, though `status` keeps showing it", async () => {
    const rig = await asking();
    expect((await rig.call("wait", { sessionIds: [rig.sessionId], timeoutSeconds: 30 })).data?.["reason"]).toBe("attention");

    const again = await rig.call("wait", { sessionIds: [rig.sessionId], timeoutSeconds: 1 });
    expect(again.data?.["reason"]).toBe("timeout");
    expect(again.data).not.toHaveProperty("raised");
    expect(again.text).toContain("Timed out after 1s — nothing has finished yet.");
    // 仍在等回答：摘要里照旧列着它，主 Agent 不会因为“只通知一次”就看不到。
    expect(again.text).toContain(`question ${rig.questionId}:`);
    expect((await rig.call("status", { sessionIds: [rig.sessionId] })).text).toContain(`question ${rig.questionId}:`);
  });

  it("`wait` returns for a question even with attention=false, because the session is waiting for the answer", async () => {
    const rig = await asking();
    const waited = await rig.call("wait", { sessionIds: [rig.sessionId], timeoutSeconds: 30, attention: false });
    expect(waited.data).toMatchObject({ reason: "attention", raised: [{ kind: "question", questionId: rig.questionId }] });
  });

  it("`read` puts the open question in front of the answer, and the transcript records how it ends", async () => {
    const rig = await asking();
    const result = await rig.call("read", { sessionId: rig.sessionId });
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toContain(`question ${rig.questionId}:`);
    expect(result.text).toContain("Which package should I update?");

    const open = await rig.call("read", { sessionId: rig.sessionId, view: "transcript" });
    expect(open.text).toContain(`question ${rig.questionId} from Pi [waiting for an answer]: Which package should I update?`);

    expect((await rig.call("send", { sessionId: rig.sessionId, questionId: rig.questionId, answer: "web" })).isError).toBe(false);
    const closed = await rig.call("read", { sessionId: rig.sessionId, view: "transcript" });
    expect(closed.text).toMatch(new RegExp(`question ${rig.questionId} from Pi \\[answered by .+; handed to the harness\\]: Which package should I update\\? → web`));
    // 回答之后它不再是待回答的提问。
    expect((await rig.call("read", { sessionId: rig.sessionId })).text).not.toContain(`question ${rig.questionId}: Pi has been waiting`);
  });

  it("`harnesses` says honestly whether a harness's questions are relayed", async () => {
    const plain = await setup(new ManualExecutor("pi"));
    const none = await plain.call("harnesses");
    expect(none.text).toContain("no question relay");
    expect((none.data?.["harnesses"] as { id: string; questionRelay: string }[]).find((entry) => entry.id === "pi")?.questionRelay).toBe("no");

    const relaying = await setup(new ManualExecutor("pi", { capabilities: { ...TEST_CAPABILITIES, question: { support: "yes", verification: "declared" } } }));
    const some = await relaying.call("harnesses");
    expect(some.text).toContain("question relay (declared)");
    expect((some.data?.["harnesses"] as { id: string; questionRelay: string }[]).find((entry) => entry.id === "pi")?.questionRelay).toBe("yes");
  });
});

describe("replying with `send`", () => {
  it("answers a question: normalises the label, hands it to the harness, and says it was accepted but not confirmed acted on", async () => {
    const rig = await asking();
    const result = await rig.call("send", { sessionId: rig.sessionId, questionId: rig.questionId, answer: "WEB" });
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toContain(`Answered question ${rig.questionId} (web). Pi has accepted it; it has not confirmed it acted on it.`);
    expect(result.data).toEqual({ questionId: rig.questionId, status: "answered", delivery: "handed_off", phase: "running" });
    expect(rig.session.replies).toEqual([{ kind: "answer", questionId: rig.questionId, answers: [["web"]] }]);
    expect(openCount(rig)).toBe(0);
    // 回复的是提问，不是一条消息：服务端没有收到任何 messages 请求。
    expect(rig.requested.filter((url) => url.includes("/messages"))).toEqual([]);
    expect(result.text).not.toMatch(AUTHORIZATION_WORDS);
  });

  it("answers a question with several parts using `answers`, one entry each", async () => {
    const rig = await asking({ prompts: TWO });
    const result = await rig.call("send", { sessionId: rig.sessionId, questionId: rig.questionId, answers: ["web", ["linux", "win"]] });
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toContain(`Answered question ${rig.questionId} (web / linux, win).`);
    expect(rig.session.replies[0]).toMatchObject({ kind: "answer", answers: [["web"], ["linux", "win"]] });
  });

  it("declines: the session is told to use its own judgment, with the model's own note passed on", async () => {
    const rig = await asking();
    const result = await rig.call("send", { sessionId: rig.sessionId, questionId: rig.questionId, decline: true, text: "Pick whatever is simplest" });
    expect(result.isError, result.text).toBe(false);
    expect(result.text).toContain(
      `Declined question ${rig.questionId}: Pi was told you chose not to answer and to use its own judgment (your note: "Pick whatever is simplest").`,
    );
    expect(result.data).toMatchObject({ questionId: rig.questionId, status: "declined", delivery: "handed_off" });
    const [reply] = rig.session.replies;
    expect(reply).toMatchObject({ kind: "decline", questionId: rig.questionId });
    expect(reply?.kind === "decline" ? reply.note : "").toContain("They added: Pick whatever is simplest");

    const bare = await asking();
    const withoutNote = await bare.call("send", { sessionId: bare.sessionId, questionId: bare.questionId, decline: true });
    expect(withoutNote.text).toContain(`Declined question ${bare.questionId}: Pi was told you chose not to answer and to use its own judgment.`);
    expect(withoutNote.text).not.toContain("your note");
  });

  it("is told plainly when someone got there first: a second reply is an error naming the standing outcome", async () => {
    const rig = await asking();
    expect((await rig.call("send", { sessionId: rig.sessionId, questionId: rig.questionId, answer: "web" })).isError).toBe(false);
    const late = await rig.call("send", { sessionId: rig.sessionId, questionId: rig.questionId, answer: "core" });
    expect(late.isError).toBe(true);
    expect(late.text).toContain("already answered");
    expect(rig.session.replies).toHaveLength(1);
  });

  it("is told when the harness no longer waits: the reply was not delivered, and the question is recorded as expired", async () => {
    const rig = await asking({ reply: false });
    const result = await rig.call("send", { sessionId: rig.sessionId, questionId: rig.questionId, answer: "web" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("no longer waiting for this question");
    expect(result.text).toContain("the reply was not delivered");
    expect(openCount(rig)).toBe(0);
    const transcript = await rig.call("read", { sessionId: rig.sessionId, view: "transcript" });
    expect(transcript.text).toContain("[expired — the harness stopped waiting for it; no answer was delivered]");
  });

  it("says the harness rejected the reply and that the question is still open, so the model can try again", async () => {
    const rig = await asking({ reply: new ReplyRejected("that option is not in my list") });
    const result = await rig.call("send", { sessionId: rig.sessionId, questionId: rig.questionId, answer: "web" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("The harness did not accept this reply: that option is not in my list");
    expect(openCount(rig)).toBe(1);
  });

  it("sends the model to the user when a harness cannot take replies to its questions", async () => {
    const rig = await asking({ reply: "unsupported" });
    const result = await rig.call("send", { sessionId: rig.sessionId, questionId: rig.questionId, answer: "web" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("cannot receive replies to its questions");
    expect(result.text).toContain("tell the user — they can see the question in the panel");
    expect(openCount(rig)).toBe(1);
  });

  it("shows the answer's own problem, naming the options, and leaves the question open", async () => {
    const rig = await asking({ prompts: [{ key: "mode", text: "Which mode?", options: [{ label: "fast" }, { label: "safe" }], multiple: false, custom: false }] });
    const result = await rig.call("send", { sessionId: rig.sessionId, questionId: rig.questionId, answer: "slow" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('must be one of the options ("fast", "safe")');
    expect(openCount(rig)).toBe(1);
    expect(rig.session.replies).toEqual([]);
  });

  it("answers a session or question that does not exist with the usual way out", async () => {
    const rig = await asking();
    const noSession = await rig.call("send", { sessionId: "ses_missing", questionId: rig.questionId, answer: "web" });
    expect(noSession.isError).toBe(true);
    expect(noSession.text).toContain("Call `status` to list valid session ids.");
    const noQuestion = await rig.call("send", { sessionId: rig.sessionId, questionId: "qst_missing", answer: "web" });
    expect(noQuestion.isError).toBe(true);
    expect(noQuestion.text).toContain("has no question qst_missing");
    expect(openCount(rig)).toBe(1);
  });

  it("refuses an unclear reply before it reaches the service, in words the model can act on", async () => {
    const rig = await asking();
    const base = { sessionId: rig.sessionId };
    const before = rig.requested.length;
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...base, questionId: rig.questionId }, /Say what to do with the question/],
      [{ ...base, questionId: rig.questionId, answer: "web", decline: true }, /Pass only one of `answer`, `answers` and `decline: true`/],
      [{ ...base, questionId: rig.questionId, answer: "web", answers: ["web"] }, /Pass only one of/],
      [{ ...base, questionId: rig.questionId, answer: "web", text: "also this" }, /`text` is not used when answering a question/],
      [{ ...base, answer: "web" }, /only go with `questionId`/],
      [{ ...base, decline: true }, /only go with `questionId`/],
      [{ ...base }, /`text` is required/],
    ];
    for (const [args, message] of cases) {
      const result = await rig.call("send", args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(result.text, JSON.stringify(args)).toMatch(message);
    }
    // 一个请求也没有发出去，提问仍待回答。
    expect(rig.requested.slice(before).filter((url) => url.includes("/questions/") || url.includes("/messages"))).toEqual([]);
    expect(rig.session.replies).toEqual([]);
    expect(openCount(rig)).toBe(1);
  });

  it("still sends an ordinary message when no questionId is given", async () => {
    const rig = await asking();
    const result = await rig.call("send", { sessionId: rig.sessionId, text: "Please also add tests" });
    expect(result.isError, result.text).toBe(false);
    expect(rig.requested.some((url) => url.includes("/messages"))).toBe(true);
    // 补充消息不是对提问的回答：提问仍待回答。
    expect(openCount(rig)).toBe(1);
  });
});

describe("an older service that does not know about questions", () => {
  it("is not sent a reply that could only fail: the model is told to point the user at the panel", async () => {
    const exec = new ManualExecutor("pi");
    exec.autoStart = true;
    exec.questionReply = true;
    const harness = await setup(exec);
    // 模拟老服务：service.json 里没有 features 字段（桥在第一次请求时才读它）。
    expect(simulateOlderService(harness.service), "the new service advertises question replies").toContain("session-questions");

    const delegated = await harness.call("delegate", { harness: "pi", task: "Build the service", cwd: tmpdir() });
    expect(delegated.isError, delegated.text).toBe(false);
    const sessionId = delegated.data?.["sessionId"] as string;

    const result = await harness.call("send", { sessionId, questionId: "qst_any", answer: "web" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/older than this plugin and cannot take replies to questions/);
    expect(result.text).toContain("they can answer in the panel");
    expect(result.text).toContain(harness.service.url);
    expect(result.text).toContain("restart Ensemble");
    expect(harness.requested.filter((url) => url.includes("/questions/"))).toEqual([]);

    // 降级只影响回复提问这一件事：普通消息照常。
    const plain = await harness.call("send", { sessionId, text: "A normal message" });
    expect(plain.isError, plain.text).toBe(false);
  });
});
