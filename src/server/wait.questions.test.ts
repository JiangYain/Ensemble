import { afterEach, describe, expect, it } from "vitest";
import type { EventDraft } from "@shared/events";
import type { QuestionPrompt } from "@shared/questions";
import { testMeta } from "@shared/testing";
import type { AttentionItem, Run } from "@shared/types";
import { makeTrackedEnv, shutdownTrackedEnvs, type TestEnv } from "./testing";
import { waitForSessions } from "./wait";

afterEach(shutdownTrackedEnvs);

const AT = "2026-01-01T00:00:00.000Z";
const PROMPTS: QuestionPrompt[] = [{ key: "db", text: "Which database should the service use?", multiple: false, custom: true }];

/** 一个在运行的会话（只写日志里的事件：这里测的是 wait 怎么读“值得留意”，不涉及真实的执行端）。 */
function open(env: TestEnv, sessionId: string): void {
  const draft = (payload: unknown, runId?: string): EventDraft => ({ ...(payload as object), at: AT, source: "ensemble", ...(runId ? { runId } : {}) }) as EventDraft;
  env.hub.emit(sessionId, draft({ kind: "session.created", data: { meta: testMeta({ id: sessionId, createdAt: AT }) } }));
  const run: Run = { id: `${sessionId}_run`, sessionId, index: 1, trigger: "task", messageId: "msg_none", status: "queued", queuedAt: AT, steerCount: 0 };
  env.hub.emit(sessionId, draft({ kind: "run.queued", data: { run } }));
  env.hub.emit(sessionId, draft({ kind: "run.started", data: {} }, run.id));
}

const question = (questionId: string): AttentionItem => ({ kind: "question", since: "2026-01-01T00:00:05.000Z", questionId, prompts: PROMPTS });
const quiet = (since: string): AttentionItem => ({ kind: "quiet", since, seq: 3 });
const signal = (): AbortSignal => new AbortController().signal;

function waiting(sessions = ["ses_a"]) {
  const env = makeTrackedEnv([]);
  for (const id of sessions) open(env, id);
  return { env, deps: { hub: env.hub, notices: env.notices } };
}

describe("wait: a question is a request, told once", () => {
  it("returns at once for a question that was already open when wait began and this caller has not been told about", async () => {
    const { env, deps } = waiting();
    env.hub.setAttention("ses_a", [question("qst_1")]);
    const response = await waitForSessions(deps, { sessionIds: ["ses_a"], timeoutMs: 5_000, originKey: "codex:thr_1" }, signal());
    expect(response.reason).toBe("attention");
    expect(response.raised).toEqual([{ sessionId: "ses_a", item: question("qst_1") }]);
    expect(response.sessions[0]?.attention).toEqual([question("qst_1")]);
  });

  it("wakes a wait that is already running, the moment the question is asked", async () => {
    const { env, deps } = waiting();
    const pending = waitForSessions(deps, { sessionIds: ["ses_a"], timeoutMs: 5_000, originKey: "codex:thr_1" }, signal());
    env.hub.setAttention("ses_a", [question("qst_1")]);
    const response = await pending;
    expect(response.reason).toBe("attention");
    expect(response.raised?.map(({ item }) => (item.kind === "question" ? item.questionId : item.kind))).toEqual(["qst_1"]);
  });

  it("treats the question as known once it has been told: the next wait does not return at once, but still carries it with the summary", async () => {
    const { env, deps } = waiting();
    env.hub.setAttention("ses_a", [question("qst_1")]);
    const request = { sessionIds: ["ses_a"], timeoutMs: 30, originKey: "codex:thr_1" };
    expect((await waitForSessions(deps, request, signal())).reason).toBe("attention");
    expect(env.notices.wasTold("codex:thr_1", "qst_1")).toBe(true);

    const again = await waitForSessions(deps, request, signal());
    expect(again.reason).toBe("timeout");
    expect(again.raised).toBeUndefined();
    expect(again.sessions[0]?.attention).toEqual([question("qst_1")]);
  });

  it("keeps the record per caller: another origin has not been told yet", async () => {
    const { env, deps } = waiting();
    env.hub.setAttention("ses_a", [question("qst_1")]);
    await waitForSessions(deps, { sessionIds: ["ses_a"], timeoutMs: 30, originKey: "codex:thr_1" }, signal());
    const other = await waitForSessions(deps, { sessionIds: ["ses_a"], timeoutMs: 30, originKey: "cursor:conv_2" }, signal());
    expect(other.reason).toBe("attention");
  });

  it("callers with no origin share one record", async () => {
    const { env, deps } = waiting();
    env.hub.setAttention("ses_a", [question("qst_1")]);
    expect((await waitForSessions(deps, { sessionIds: ["ses_a"], timeoutMs: 30 }, signal())).reason).toBe("attention");
    expect((await waitForSessions(deps, { sessionIds: ["ses_a"], timeoutMs: 30 }, signal())).reason).toBe("timeout");
  });

  it("wakes again for a different question in the same session", async () => {
    const { env, deps } = waiting();
    const request = { sessionIds: ["ses_a"], timeoutMs: 5_000, originKey: "codex:thr_1" };
    env.hub.setAttention("ses_a", [question("qst_1")]);
    await waitForSessions(deps, request, signal());

    const pending = waitForSessions(deps, request, signal());
    env.hub.setAttention("ses_a", [question("qst_1"), question("qst_2")]);
    const response = await pending;
    expect(response.reason).toBe("attention");
    expect(response.raised?.map(({ item }) => (item.kind === "question" ? item.questionId : item.kind))).toEqual(["qst_2"]);
  });

  it("does not count a response nobody received as told: the caller that went away still sees the question next time", async () => {
    const { env, deps } = waiting();
    env.hub.setAttention("ses_a", [question("qst_1")]);
    const gone = new AbortController();
    gone.abort();
    await waitForSessions(deps, { sessionIds: ["ses_a"], timeoutMs: 5_000, originKey: "codex:thr_1" }, gone.signal);
    expect(env.notices.wasTold("codex:thr_1", "qst_1")).toBe(false);

    const next = await waitForSessions(deps, { sessionIds: ["ses_a"], timeoutMs: 5_000, originKey: "codex:thr_1" }, signal());
    expect(next.reason).toBe("attention");
  });
});

describe("wait: attention=false", () => {
  it("still wakes for a question, because it is a request rather than a sign of trouble", async () => {
    const { env, deps } = waiting();
    const pending = waitForSessions(deps, { sessionIds: ["ses_a"], timeoutMs: 5_000, attention: false, originKey: "codex:thr_1" }, signal());
    env.hub.setAttention("ses_a", [question("qst_1")]);
    const response = await pending;
    expect(response.reason).toBe("attention");
    expect(response.raised?.map(({ item }) => item.kind)).toEqual(["question"]);
  });

  it("does not wake for anything else, and reports only the question when both appear together", async () => {
    const { env, deps } = waiting();
    const quietOnly = waitForSessions(deps, { sessionIds: ["ses_a"], timeoutMs: 40, attention: false, originKey: "codex:thr_1" }, signal());
    env.hub.setAttention("ses_a", [quiet("2026-01-01T00:04:00.000Z")]);
    expect((await quietOnly).reason).toBe("timeout");

    const both = waitForSessions(deps, { sessionIds: ["ses_a"], timeoutMs: 5_000, attention: false, originKey: "codex:thr_1" }, signal());
    env.hub.setAttention("ses_a", [question("qst_1"), quiet("2026-01-01T00:05:00.000Z")]);
    const response = await both;
    expect(response.raised?.map(({ item }) => item.kind)).toEqual(["question"]);
  });
});

describe("wait: a caller that does not know about questions (an older bridge)", () => {
  it("is never woken for one, and never sees it in the summaries it gets back", async () => {
    const { env, deps } = waiting();
    const legacy = { ...deps, questions: false };
    env.hub.setAttention("ses_a", [question("qst_1")]);
    const response = await waitForSessions(legacy, { sessionIds: ["ses_a"], timeoutMs: 40, originKey: "codex:thr_1" }, signal());
    expect(response.reason).toBe("timeout");
    expect(response.raised).toBeUndefined();
    expect("attention" in (response.sessions[0] ?? {})).toBe(false);
    expect(env.notices.wasTold("codex:thr_1", "qst_1")).toBe(false);
  });

  it("still hears about everything else, with the question left out of the list", async () => {
    const { env, deps } = waiting();
    const legacy = { ...deps, questions: false };
    const pending = waitForSessions(legacy, { sessionIds: ["ses_a"], timeoutMs: 5_000 }, signal());
    env.hub.setAttention("ses_a", [question("qst_1"), quiet("2026-01-01T00:04:00.000Z")]);
    const response = await pending;
    expect(response.reason).toBe("attention");
    expect(response.raised?.map(({ item }) => item.kind)).toEqual(["quiet"]);
    expect(response.sessions[0]?.attention?.map((item) => item.kind)).toEqual(["quiet"]);
  });
});

describe("NoticeCenter: what each caller has been told", () => {
  it("remembers the newest questions and forgets the oldest once the list gets long", () => {
    const { env } = waiting();
    const ids = Array.from({ length: 500 }, (_, index) => `qst_${index}`);
    env.notices.markTold("codex:thr_1", ids);
    expect(env.notices.wasTold("codex:thr_1", "qst_0")).toBe(false);
    expect(env.notices.wasTold("codex:thr_1", "qst_499")).toBe(true);
    // 别的发起端各记各的，不受影响。
    expect(env.notices.wasTold("cursor:conv_2", "qst_499")).toBe(false);
  });
});
