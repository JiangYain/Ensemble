import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LIMITS, SERVICE_FEATURES, TOKEN_HEADER } from "@shared/constants";
import { handedOverText } from "@shared/handoff";
import type { DelegateResponse, ErrorBody, SessionDetail } from "@shared/protocol";
import { testOrigin } from "@shared/testing";
import type { ContextItem } from "@shared/types";
import { silentLogger } from "./logger";
import { startService, type RunningService } from "./service";
import { ManualExecutor, until } from "./testing";

/**
 * 会话引用在 HTTP 入口上：`POST /api/sessions` 接受 context 的第五种条目，带回执；
 * 拒绝时的状态码与错误体；请求体校验；伪造的取样事实被丢掉；health 公布 `context-session-ref`（桥据此判断服务认不认识这种条目）。
 * 展开本身在 context-refs.test.ts / context-refs.merge.test.ts（格式）与 context-refs.reject.test.ts（额度、取不到时的说明），整条路径在 manager.context-refs.test.ts。全部用临时状态目录。
 */

const running: RunningService[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()!.close("test");
});

const ANSWER = "Parser fixed.\nAll tests pass.";

async function boot(): Promise<{ service: RunningService; executor: ManualExecutor }> {
  const executor = new ManualExecutor("pi");
  executor.autoStart = true;
  const service = await startService({
    home: mkdtempSync(join(tmpdir(), "ensemble-home-")),
    port: 0,
    executors: [executor],
    log: silentLogger,
    webRoot: null,
    idleExitMs: 0,
    // 显式传入：不读测试进程自己的环境变量。
    env: {},
  });
  running.push(service);
  return { service, executor };
}

function api(service: RunningService) {
  const headers = { [TOKEN_HEADER]: service.token, "content-type": "application/json" };
  return {
    get: (path: string) => fetch(`${service.url}${path}`, { headers }),
    post: (path: string, body: unknown) => fetch(`${service.url}${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
    json: async <T>(response: Response) => (await response.json()) as T,
  };
}

function sessionOf(executor: ManualExecutor, sessionId: string) {
  const session = executor.sessions.find((candidate) => candidate.input.meta.id === sessionId);
  if (!session) throw new Error(`no executor session for ${sessionId}`);
  return session;
}

/** 直接用管理器派一个上游并让它跑完（上游怎么来的不是这里要测的）。 */
async function finishedUpstream(service: RunningService, executor: ManualExecutor, answer = ANSWER) {
  const upstream = await service.manager.delegate({ harness: "pi", task: "Fix the parser", title: "Fix the parser", cwd: tmpdir(), origin: testOrigin() });
  await until(() => service.hub.state(upstream.sessionId)?.status === "running", 4000, "the upstream to run");
  const session = sessionOf(executor, upstream.sessionId);
  session.emit({ kind: "assistant.delta", data: { itemId: "m1", text: answer, phase: "final" }, runId: upstream.runId });
  session.emit({ kind: "assistant.completed", data: { itemId: "m1" }, runId: upstream.runId });
  session.complete(upstream.runId);
  await until(() => service.hub.summary(upstream.sessionId)?.phase === "done", 4000, "the upstream to finish");
  return upstream;
}

const delegate = (client: ReturnType<typeof api>, context: unknown[], extra: Record<string, unknown> = {}) =>
  client.post("/api/sessions", { harness: "pi", task: "Review the fix", cwd: tmpdir(), context, ...extra });

describe("health 公布 context-session-ref", () => {
  it("桥据此决定能不能带 session 条目；老服务没有这一项，它的校验会对“session”回 Invalid discriminator value", async () => {
    const { service } = await boot();

    const health = await fetch(`${service.url}/api/health`);
    const body = (await health.json()) as { features?: string[] };

    expect(SERVICE_FEATURES).toContain("context-session-ref");
    expect(body.features).toContain("context-session-ref");
  });
});

describe("POST /api/sessions 带会话引用", () => {
  it("201：回执里每个引用一条；下游的提示与记录里是上游的原文与取样事实，页面读到的事件里也是", async () => {
    const { service, executor } = await boot();
    const client = api(service);
    const upstream = await finishedUpstream(service, executor);

    const response = await delegate(client, [{ kind: "session", sessionId: upstream.sessionId, include: ["result"], note: "Review this" }]);

    expect(response.status).toBe(201);
    const body = await client.json<DelegateResponse>(response);
    expect(body.contextRefs).toEqual([
      expect.objectContaining({
        sessionId: upstream.sessionId,
        include: ["result"],
        title: "Fix the parser",
        harness: "pi",
        phase: "done",
        runCount: 1,
        result: expect.objectContaining({ found: true, label: "final", runIndex: 1, chars: ANSWER.length }),
      }),
    ]);
    expect(body.contextRefs?.[0]).not.toHaveProperty("block");

    const meta = service.hub.state(body.sessionId)?.meta;
    expect(meta?.task.prompt).toContain(`\`\`\`text\n${ANSWER}\n\`\`\``);
    expect(meta?.task.prompt).toContain("Note from the delegating agent: Review this");

    // 页面读的是事件日志里 session.created 的 meta：取样事实与块的区间都在，用区间能取回当时交出去的原文。
    const detail = await client.json<SessionDetail>(await client.get(`/api/sessions/${body.sessionId}`));
    const createdEvent = detail.events.find((event) => event.kind === "session.created");
    if (createdEvent?.kind !== "session.created") throw new Error("session.created is missing");
    const item = createdEvent.data.meta.task.context[0];
    if (item?.kind !== "session") throw new Error("expected a session item");
    expect(item.sample).toMatchObject({ title: "Fix the parser", phase: "done", runCount: 1, block: { start: expect.any(Number), end: expect.any(Number) } });
    expect(handedOverText(createdEvent.data.meta.task.prompt, item)).toContain(ANSWER);
  });

  it("夹带的 sample 被校验丢掉：记录里的取样事实只来自服务端自己读到的", async () => {
    const { service, executor } = await boot();
    const client = api(service);
    const upstream = await finishedUpstream(service, executor);
    const forged = { at: "1999-01-01T00:00:00.000Z", title: "FORGED", harness: "codex", phase: "failed", runCount: 99 };

    const response = await delegate(client, [{ kind: "session", sessionId: upstream.sessionId, sample: forged }]);

    expect(response.status).toBe(201);
    const body = await client.json<DelegateResponse>(response);
    const item = service.hub.state(body.sessionId)?.meta.task.context[0];
    if (item?.kind !== "session") throw new Error("expected a session item");
    expect(item.sample).toMatchObject({ title: "Fix the parser", harness: "pi", phase: "done", runCount: 1 });
    expect(service.hub.state(body.sessionId)?.meta.task.prompt).not.toContain("FORGED");
  });

  it("没有 session 条目的委派照旧：201，没有 contextRefs，提示不含任何引用块", async () => {
    const { service } = await boot();
    const client = api(service);
    const context: ContextItem[] = [{ kind: "text", text: "plain" }];

    const response = await delegate(client, context);

    expect(response.status).toBe(201);
    const body = await client.json<DelegateResponse>(response);
    expect(body).not.toHaveProperty("contextRefs");
    expect(service.hub.state(body.sessionId)?.meta.task.prompt).not.toContain("### Session ");
  });
});

describe("POST /api/sessions 带会话引用被拒绝", () => {
  it("上游还在运行：409 context_session_active，点名并写明阶段，没有创建会话", async () => {
    const { service } = await boot();
    const client = api(service);
    const upstream = await service.manager.delegate({ harness: "pi", task: "Fix the parser", cwd: tmpdir(), origin: testOrigin() });
    await until(() => service.hub.state(upstream.sessionId)?.status === "running", 4000, "the upstream to run");
    const before = service.hub.sessionIds().length;

    const response = await delegate(client, [{ kind: "session", sessionId: upstream.sessionId }]);

    expect(response.status).toBe(409);
    const body = await client.json<ErrorBody>(response);
    expect(body.error.code).toBe("context_session_active");
    expect(body.error.message).toContain(`${upstream.sessionId} (running)`);
    expect(body.error.details).toEqual({ via: "context", sessions: [{ sessionId: upstream.sessionId, phase: "running" }] });
    expect(service.hub.sessionIds()).toHaveLength(before);
  });

  it("引用的会话不存在：404 not_found，点名", async () => {
    const { service } = await boot();
    const client = api(service);

    const response = await delegate(client, [{ kind: "session", sessionId: "ses_nope" }]);

    expect(response.status).toBe(404);
    const body = await client.json<ErrorBody>(response);
    expect(body.error).toMatchObject({ code: "not_found", details: { via: "context", sessionIds: ["ses_nope"] } });
    expect(service.hub.sessionIds()).toHaveLength(0);
  });

  it("引用太多或提示太长：422 context_too_large", async () => {
    const { service, executor } = await boot();
    const client = api(service);
    const upstream = await finishedUpstream(service, executor);

    const tooMany = await delegate(
      client,
      Array.from({ length: LIMITS.contextSession.maxRefs + 1 }, (_, index) => ({ kind: "session", sessionId: `ses_other_${index}` })),
    );
    expect(tooMany.status).toBe(422);
    expect((await client.json<ErrorBody>(tooMany)).error.code).toBe("context_too_large");

    const tooLong = await delegate(client, [{ kind: "session", sessionId: upstream.sessionId }], { task: "t".repeat(LIMITS.maxTaskChars) });
    expect(tooLong.status).toBe(422);
    expect((await client.json<ErrorBody>(tooLong)).error).toMatchObject({ code: "context_too_large", details: { via: "context", maxPromptChars: LIMITS.contextSession.maxPromptChars } });
  });

  it.each([
    ["include 里有不认识的取值", { kind: "session", sessionId: "ses_a", include: ["bogus"] }],
    ["include 为空数组", { kind: "session", sessionId: "ses_a", include: [] }],
    ["缺少 sessionId", { kind: "session" }],
    ["sessionId 为空", { kind: "session", sessionId: "" }],
    ["note 超长", { kind: "session", sessionId: "ses_a", note: "n".repeat(2_001) }],
  ])("请求体不合规（%s）：400 invalid_request，没有创建会话", async (_name, item) => {
    const { service } = await boot();
    const client = api(service);

    const response = await delegate(client, [item]);

    expect(response.status).toBe(400);
    expect((await client.json<ErrorBody>(response)).error.code).toBe("invalid_request");
    expect(service.hub.sessionIds()).toHaveLength(0);
  });
});
