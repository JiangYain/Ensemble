import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACCEPTS_HEADER, LIMITS, SERVICE_FEATURES, TOKEN_HEADER } from "@shared/constants";
import type { DelegateResponse, ErrorBody, HealthBody, QuestionResolvedResponse, SessionDetail, WaitResponse } from "@shared/protocol";
import type { QuestionPrompt } from "@shared/questions";
import { testOrigin } from "@shared/testing";
import type { SessionSummary } from "@shared/types";
import { ReplyRejected } from "./executors/types";
import { silentLogger } from "./logger";
import { startService, type RunningService } from "./service";
import { ManualExecutor, until, type ManualSession, type QuestionReply } from "./testing";

const running: RunningService[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()!.close("test");
});

const CHOICE: QuestionPrompt[] = [
  {
    key: "pkg",
    text: "Which package should I update?",
    options: [{ label: "core", description: "the engine" }, { label: "web" }],
    multiple: false,
    custom: true,
  },
];
const CLOSED: QuestionPrompt[] = [{ key: "mode", text: "Which mode?", options: [{ label: "fast" }, { label: "safe" }], multiple: false, custom: false }];

/** 一律用临时目录当 ENSEMBLE_HOME：不碰这台机器上真实的数据。 */
async function boot(exec: ManualExecutor): Promise<RunningService> {
  const service = await startService({
    home: mkdtempSync(join(tmpdir(), "ensemble-home-")),
    port: 0,
    executors: [exec],
    log: silentLogger,
    webRoot: null,
    idleExitMs: 0,
    managerConfig: { duplicateWindowMs: 0 },
  });
  running.push(service);
  return service;
}

function api(service: RunningService) {
  const headers = { [TOKEN_HEADER]: service.token, "content-type": "application/json" };
  return {
    get: (path: string, extra: Record<string, string> = {}) => fetch(`${service.url}${path}`, { headers: { ...headers, ...extra } }),
    post: (path: string, body: unknown, extra: Record<string, string> = {}) =>
      fetch(`${service.url}${path}`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body) }),
    json: async <T>(response: Response) => (await response.json()) as T,
  };
}

/** 浏览器里别的网页发来的写请求会带这样的 Origin；MCP 桥与脚本不带。 */
const FOREIGN = { origin: "https://evil.example.com" };
/** 认识“提问”的桥（新桥）与不认识的桥（老桥）：网页不带 x-ensemble-client，永远不算老桥。 */
const NEW_BRIDGE = { "x-ensemble-client": "mcp", [ACCEPTS_HEADER]: "session-questions" };
const OLD_BRIDGE = { "x-ensemble-client": "mcp" };
const ORIGIN_KEY = testOrigin().key;

interface Rig {
  service: RunningService;
  client: ReturnType<typeof api>;
  exec: ManualExecutor;
  session: ManualSession;
  sessionId: string;
  runId: string;
  questionId: string;
}

/** 一个正在运行、并且停下来问了一个问题的会话。`bridge` = 像 MCP 桥那样委派（有一个主 Agent 来源）。 */
async function asking(setup: { reply?: QuestionReply | "unsupported"; prompts?: QuestionPrompt[]; bridge?: boolean } = {}): Promise<Rig> {
  const exec = new ManualExecutor("pi");
  exec.autoStart = true;
  if (setup.reply !== "unsupported") exec.questionReply = setup.reply ?? true;
  const service = await boot(exec);
  const client = api(service);
  const response = await client.post(
    "/api/sessions",
    { harness: "pi", task: "Build the service", cwd: tmpdir(), ...(setup.bridge ? { origin: testOrigin() } : {}) },
    setup.bridge ? OLD_BRIDGE : {},
  );
  expect(response.status).toBe(201);
  const { sessionId, runId } = await client.json<DelegateResponse>(response);
  await until(() => service.hub.summary(sessionId)?.phase === "running", 4000, "the run to start");
  const session = exec.sessions[0]!;
  const questionId = session.ask(runId, setup.prompts ?? CHOICE);
  // 摘要里的“值得留意”由监督者算：提问落地后立刻就有。
  await until(() => service.hub.summary(sessionId)?.attention?.some((item) => item.kind === "question") === true, 4000, "the question to be raised");
  return { service, client, exec, session, sessionId, runId, questionId };
}

const answerPath = (rig: Pick<Rig, "sessionId" | "questionId">, questionId = rig.questionId): string =>
  `/api/sessions/${rig.sessionId}/questions/${questionId}/answer`;
const declinePath = (rig: Pick<Rig, "sessionId" | "questionId">, questionId = rig.questionId): string =>
  `/api/sessions/${rig.sessionId}/questions/${questionId}/decline`;

const errorOf = async (rig: Rig, response: Response): Promise<ErrorBody["error"]> => (await rig.client.json<ErrorBody>(response)).error;

const openCount = (rig: Rig): number => rig.service.hub.summary(rig.sessionId)?.openQuestions ?? 0;
const resolvedEvents = (rig: Rig) => rig.service.hub.events(rig.sessionId).filter((event) => event.kind === "question.resolved");

describe("POST /api/sessions/:id/questions/:questionId/answer", () => {
  it("hands the answer to the harness and answers with the outcome and the session's new summary", async () => {
    const rig = await asking();
    const response = await rig.client.post(answerPath(rig), { answer: "web" });
    expect(response.status).toBe(200);

    const body = await rig.client.json<QuestionResolvedResponse>(response);
    expect(body).toMatchObject({
      questionId: rig.questionId,
      status: "answered",
      outcome: { by: { kind: "user", label: "You" }, answers: [["web"]], delivery: "handed_off" },
    });
    expect(body.summary.id).toBe(rig.sessionId);
    expect(body.summary.openQuestions).toBeUndefined();
    expect(body.summary.phase).toBe("running");
    expect(rig.session.replies).toEqual([{ kind: "answer", questionId: rig.questionId, answers: [["web"]] }]);
    expect(resolvedEvents(rig)).toHaveLength(1);
    // 回答后，提问不再出现在“值得留意”里。
    await until(() => rig.service.hub.summary(rig.sessionId)?.attention === undefined, 4000, "the question to leave attention");
  });

  it("takes several parts as `answers`, one entry per question", async () => {
    const rig = await asking({
      prompts: [
        { key: "a", text: "Which package?", options: [{ label: "core" }, { label: "web" }], multiple: false, custom: false },
        { key: "b", text: "Which targets?", options: [{ label: "linux" }, { label: "win" }], multiple: true, custom: false },
      ],
    });
    const response = await rig.client.post(answerPath(rig), { answers: ["web", ["linux", "win"]] });
    expect(response.status).toBe(200);
    expect((await rig.client.json<QuestionResolvedResponse>(response)).outcome.answers).toEqual([["web"], ["linux", "win"]]);
  });

  it("signs it as the delegating agent only when an MCP bridge sends its originKey; otherwise it is the user", async () => {
    const rig = await asking({ bridge: true });
    const more = [rig.session.ask(rig.runId, CHOICE), rig.session.ask(rig.runId, CHOICE)];
    await until(() => openCount(rig) === 3, 4000, "three open questions");

    const byBridge = await rig.client.post(answerPath(rig), { answer: "web", originKey: ORIGIN_KEY }, OLD_BRIDGE);
    expect((await rig.client.json<QuestionResolvedResponse>(byBridge)).outcome.by).toEqual({ kind: "agent", label: "Codex", originKey: ORIGIN_KEY });
    expect(resolvedEvents(rig)[0]).toMatchObject({ source: "origin" });

    // 没有 originKey 的桥调用、没有桥标头却带了 originKey 的调用：都不冒充主 Agent。
    const noKey = await rig.client.post(answerPath(rig, more[0]), { answer: "web" }, OLD_BRIDGE);
    expect((await rig.client.json<QuestionResolvedResponse>(noKey)).outcome.by).toEqual({ kind: "user", label: "You" });
    const pageWithKey = await rig.client.post(answerPath(rig, more[1]), { answer: "web", originKey: ORIGIN_KEY });
    expect((await rig.client.json<QuestionResolvedResponse>(pageWithKey)).outcome.by).toEqual({ kind: "user", label: "You" });
  });

  it("tells the delegating agent about the user's answer as an intervention, but not about its own", async () => {
    const rig = await asking({ bridge: true });
    const second = rig.session.ask(rig.runId, CHOICE);
    await until(() => openCount(rig) === 2, 4000, "two open questions");

    await rig.client.post(answerPath(rig, second), { answer: "core", originKey: ORIGIN_KEY }, OLD_BRIDGE);
    expect(rig.service.notices.peek(ORIGIN_KEY)).toEqual([]);

    await rig.client.post(answerPath(rig), { answer: "web" });
    const notices = rig.service.notices.peek(ORIGIN_KEY);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: "intervention", sessionId: rig.sessionId, text: "web" });
  });

  it("lets only the first of two simultaneous answers in; the other is a 409 and sends nothing to the harness", async () => {
    const rig = await asking();
    const gate = Promise.withResolvers<boolean>();
    rig.exec.questionReply = () => gate.promise;

    const first = rig.client.post(answerPath(rig), { answer: "web" });
    await until(() => rig.session.replies.length === 1, 4000, "the first answer to reach the harness");
    const second = await rig.client.post(answerPath(rig), { answer: "core" }, OLD_BRIDGE);
    expect(second.status).toBe(409);
    expect(await errorOf(rig, second)).toMatchObject({ code: "conflict", details: { questionId: rig.questionId, status: "open" } });
    expect(rig.session.replies).toHaveLength(1);

    gate.resolve(true);
    const winner = await first;
    expect(winner.status).toBe(200);
    expect((await rig.client.json<QuestionResolvedResponse>(winner)).outcome.answers).toEqual([["web"]]);
    expect(resolvedEvents(rig)).toHaveLength(1);
  });

  it("answers 409 with the standing outcome once the question already has one", async () => {
    const rig = await asking();
    expect((await rig.client.post(answerPath(rig), { answer: "web" })).status).toBe(200);

    const late = await rig.client.post(answerPath(rig), { answer: "core" });
    expect(late.status).toBe(409);
    const error = await errorOf(rig, late);
    expect(error.code).toBe("conflict");
    expect(error.message).toContain("already answered by You");
    expect(error.details).toMatchObject({ questionId: rig.questionId, status: "answered", resolvedBy: "You", resolvedByKind: "user" });
    expect(typeof error.details?.["resolvedAt"]).toBe("string");

    const decline = await rig.client.post(declinePath(rig), {});
    expect(decline.status).toBe(409);
    expect((await errorOf(rig, decline)).details).toMatchObject({ status: "answered" });
    expect(rig.session.replies).toHaveLength(1);
  });

  it("answers 409 not_waiting when the harness no longer waits, and records the question as expired instead of answered", async () => {
    const rig = await asking({ reply: false });
    const response = await rig.client.post(answerPath(rig), { answer: "web" });
    expect(response.status).toBe(409);
    expect((await errorOf(rig, response)).details).toEqual({ questionId: rig.questionId, status: "expired", reason: "not_waiting" });

    expect(openCount(rig)).toBe(0);
    const detail = await rig.client.json<SessionDetail>(await rig.client.get(`/api/sessions/${rig.sessionId}`));
    const resolved = detail.events.filter((event) => event.kind === "question.resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ data: { outcome: "expired", reason: "not_waiting", delivery: "not_waiting" } });
    expect(rig.service.notices.peek(ORIGIN_KEY)).toEqual([]);
  });

  it("answers 400 and keeps the question open when the harness rejects the reply itself", async () => {
    const rig = await asking({ reply: new ReplyRejected("that option is not in my list") });
    const response = await rig.client.post(answerPath(rig), { answer: "web" });
    expect(response.status).toBe(400);
    const error = await errorOf(rig, response);
    expect(error.code).toBe("invalid_request");
    expect(error.message).toContain("The harness did not accept this reply: that option is not in my list");
    expect(openCount(rig)).toBe(1);
  });

  it("answers 422 question_unsupported for a harness that cannot take replies, leaving the question open", async () => {
    const rig = await asking({ reply: "unsupported" });
    const response = await rig.client.post(answerPath(rig), { answer: "web" });
    expect(response.status).toBe(422);
    expect(await errorOf(rig, response)).toMatchObject({ code: "question_unsupported" });
    const decline = await rig.client.post(declinePath(rig), {});
    expect(decline.status).toBe(422);
    expect(openCount(rig)).toBe(1);
  });

  it("answers 404 for a session or a question that does not exist", async () => {
    const rig = await asking();
    const noSession = await rig.client.post(`/api/sessions/ses_missing/questions/${rig.questionId}/answer`, { answer: "web" });
    expect(noSession.status).toBe(404);
    expect(await errorOf(rig, noSession)).toMatchObject({ code: "not_found" });
    const noQuestion = await rig.client.post(answerPath(rig, "qst_missing"), { answer: "web" });
    expect(noQuestion.status).toBe(404);
    expect((await errorOf(rig, noQuestion)).message).toContain("has no question qst_missing");
    const noDecline = await rig.client.post(declinePath(rig, "qst_missing"), {});
    expect(noDecline.status).toBe(404);
    expect(openCount(rig)).toBe(1);
  });

  it("answers 400 invalid_request, naming the problem, for an answer that does not fit, and the question stays open", async () => {
    const rig = await asking({ prompts: CLOSED });
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ answer: 5 }, "answer"],
      [{ answers: [] }, "answers"],
      [{ answers: "safe" }, "answers"],
      [{ answer: "x".repeat(LIMITS.question.maxAnswerChars + 1) }, "answer"],
      [{}, "No answer was given"],
      [{ answer: "safe", answers: ["safe"] }, "not both"],
      [{ answers: ["fast", "safe"] }, "2 answers were given"],
      [{ answer: "slow" }, 'must be one of the options ("fast", "safe")'],
      [{ answer: "  " }, "no answer"],
      [{ answer: ["fast", "safe"] }, "single answer"],
    ];
    for (const [body, hint] of bad) {
      const response = await rig.client.post(answerPath(rig), body);
      expect(response.status, JSON.stringify(body).slice(0, 60)).toBe(400);
      const error = await errorOf(rig, response);
      expect(error.code, JSON.stringify(body).slice(0, 60)).toBe("invalid_request");
      expect(error.message, JSON.stringify(body).slice(0, 60)).toContain(hint);
    }
    expect(openCount(rig)).toBe(1);
    expect(rig.session.replies).toEqual([]);
    expect((await rig.client.post(answerPath(rig), { answer: "safe" })).status).toBe(200);
  });

  it("answers 400 for a name in the URL that is not valid percent-encoding", async () => {
    const rig = await asking();
    const response = await rig.client.post(`/api/sessions/${rig.sessionId}/questions/%E0%A4%A/answer`, { answer: "web" });
    expect(response.status).toBe(400);
    expect(await errorOf(rig, response)).toMatchObject({ code: "invalid_request" });
  });

  it("requires the token, and refuses a write from another web page", async () => {
    const rig = await asking();
    const anonymous = await fetch(`${rig.service.url}${answerPath(rig)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: "web" }) });
    expect(anonymous.status).toBe(403);
    expect(await errorOf(rig, anonymous)).toMatchObject({ code: "invalid_token" });

    const foreign = await rig.client.post(answerPath(rig), { answer: "web" }, FOREIGN);
    expect(foreign.status).toBe(403);
    expect(await errorOf(rig, foreign)).toMatchObject({ code: "forbidden" });
    const foreignDecline = await rig.client.post(declinePath(rig), {}, FOREIGN);
    expect(foreignDecline.status).toBe(403);

    expect(openCount(rig)).toBe(1);
    expect(rig.session.replies).toEqual([]);
    const sameOrigin = await rig.client.post(answerPath(rig), { answer: "web" }, { origin: rig.service.url });
    expect(sameOrigin.status).toBe(200);
  });
});

describe("POST /api/sessions/:id/questions/:questionId/decline", () => {
  it("tells the harness to use its own judgment and records the decline, with only the user's own note", async () => {
    const rig = await asking();
    const response = await rig.client.post(declinePath(rig), { note: "Pick whatever is simplest" });
    expect(response.status).toBe(200);

    const body = await rig.client.json<QuestionResolvedResponse>(response);
    expect(body).toMatchObject({
      questionId: rig.questionId,
      status: "declined",
      outcome: { by: { kind: "user", label: "You" }, note: "Pick whatever is simplest", delivery: "handed_off" },
    });
    expect(body.outcome.answers).toBeUndefined();
    expect(body.summary.openQuestions).toBeUndefined();

    const [reply] = rig.session.replies;
    expect(reply).toMatchObject({ kind: "decline", questionId: rig.questionId });
    expect(reply?.kind === "decline" ? reply.note : "").toContain("They added: Pick whatever is simplest");
  });

  it("needs no body at all, and records no note when none was given", async () => {
    const rig = await asking();
    const response = await fetch(`${rig.service.url}${declinePath(rig)}`, { method: "POST", headers: { [TOKEN_HEADER]: rig.service.token } });
    expect(response.status).toBe(200);
    const body = await rig.client.json<QuestionResolvedResponse>(response);
    expect(body.status).toBe("declined");
    expect(body.outcome.note).toBeUndefined();
  });

  it("refuses an empty or oversized note with 400, and the question stays open", async () => {
    const rig = await asking();
    for (const note of ["", "x".repeat(LIMITS.question.maxAnswerChars + 1)]) {
      const response = await rig.client.post(declinePath(rig), { note });
      expect(response.status).toBe(400);
      expect(await errorOf(rig, response)).toMatchObject({ code: "invalid_request" });
    }
    expect(openCount(rig)).toBe(1);
  });

  it("is told a 409 when the answer got there first, and the other way round", async () => {
    const first = await asking();
    expect((await first.client.post(answerPath(first), { answer: "web" })).status).toBe(200);
    const lost = await first.client.post(declinePath(first), {});
    expect(lost.status).toBe(409);
    expect((await errorOf(first, lost)).details).toMatchObject({ status: "answered" });

    const second = await asking();
    expect((await second.client.post(declinePath(second), {})).status).toBe(200);
    const late = await second.client.post(answerPath(second), { answer: "web" });
    expect(late.status).toBe(409);
    expect(await errorOf(second, late)).toMatchObject({ details: { status: "declined", resolvedByKind: "user" } });
  });
});

describe("what an MCP bridge that does not know about questions is shown", () => {
  const summaryOf = async (rig: Rig, headers: Record<string, string>): Promise<SessionSummary> =>
    (await rig.client.json<SessionDetail>(await rig.client.get(`/api/sessions/${rig.sessionId}`, headers))).summary;
  const listedOf = async (rig: Rig, headers: Record<string, string>): Promise<SessionSummary> => {
    const { sessions } = await rig.client.json<{ sessions: SessionSummary[] }>(await rig.client.get("/api/sessions", headers));
    return sessions.find((entry) => entry.id === rig.sessionId)!;
  };
  const wait = (rig: Rig, headers: Record<string, string>, extra: Record<string, unknown> = {}): Promise<WaitResponse> =>
    rig.client.post("/api/wait", { sessionIds: [rig.sessionId], timeoutMs: 150, originKey: ORIGIN_KEY, ...extra }, headers).then((response) => rig.client.json<WaitResponse>(response));

  it("shows the question in the summary to the web page and to a bridge that declared it, and hides it from an older bridge", async () => {
    const rig = await asking({ bridge: true });
    for (const headers of [{}, NEW_BRIDGE]) {
      for (const summary of [await summaryOf(rig, headers), await listedOf(rig, headers)]) {
        expect(summary.openQuestions).toBe(1);
        expect(summary.attention).toEqual([
          expect.objectContaining({ kind: "question", questionId: rig.questionId, prompts: [expect.objectContaining({ text: "Which package should I update?" })] }),
        ]);
      }
    }
    // 老桥会把没见过的种类渲染成 `attention: undefined`：给它的摘要里没有提问。
    for (const summary of [await summaryOf(rig, OLD_BRIDGE), await listedOf(rig, OLD_BRIDGE)]) {
      expect(summary.attention).toBeUndefined();
    }
  });

  it("wakes a bridge that declared questions once per question, and never an older bridge", async () => {
    const rig = await asking({ bridge: true });

    const old = await wait(rig, OLD_BRIDGE);
    expect(old.reason).toBe("timeout");
    expect(old.raised).toBeUndefined();
    expect(old.sessions[0]?.attention).toBeUndefined();

    const woken = await wait(rig, NEW_BRIDGE);
    expect(woken.reason).toBe("attention");
    expect(woken.raised).toEqual([{ sessionId: rig.sessionId, item: expect.objectContaining({ kind: "question", questionId: rig.questionId }) }]);

    // 已经告知过：同一个提问不会让每次 wait 都立刻返回，它仍在摘要里。
    const again = await wait(rig, NEW_BRIDGE);
    expect(again.reason).toBe("timeout");
    expect(again.raised).toBeUndefined();
    expect(again.sessions[0]?.openQuestions).toBe(1);
  });

  it("wakes for a question even with attention=false, and each origin is told on its own", async () => {
    const rig = await asking({ bridge: true });
    const first = await wait(rig, NEW_BRIDGE, { attention: false });
    expect(first.reason).toBe("attention");
    expect(first.raised).toHaveLength(1);
    expect((await wait(rig, NEW_BRIDGE, { attention: false })).reason).toBe("timeout");

    const other = await wait(rig, NEW_BRIDGE, { attention: false, originKey: "cursor:other" });
    expect(other.reason).toBe("attention");
  });

  it("stops waking once the question has an ending", async () => {
    const rig = await asking({ bridge: true });
    // 以主 Agent 自己的名义回答：这样不会另有一条“用户介入”的通知，wait 的结果只取决于提问还在不在。
    const answered = await rig.client.post(answerPath(rig), { answer: "web", originKey: ORIGIN_KEY }, NEW_BRIDGE);
    expect(answered.status).toBe(200);
    const response = await wait(rig, NEW_BRIDGE);
    expect(response.reason).toBe("timeout");
    expect(response.raised).toBeUndefined();
  });

  it("returns for the user's answer as the intervention it is, not as a question", async () => {
    const rig = await asking({ bridge: true });
    expect((await rig.client.post(answerPath(rig), { answer: "web" })).status).toBe(200);
    const response = await wait(rig, NEW_BRIDGE);
    expect(response.reason).toBe("notice");
    expect(response.raised).toBeUndefined();
  });
});

describe("negotiating the feature", () => {
  it("advertises session-questions in /api/health, so a service without it is recognisable by its absence", async () => {
    const rig = await asking();
    expect(SERVICE_FEATURES).toContain("session-questions");
    const health = (await (await fetch(`${rig.service.url}/api/health`)).json()) as HealthBody & { features?: string[] };
    expect(health.features).toContain("session-questions");
  });
});
