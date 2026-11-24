import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { LIMITS } from "@shared/constants";
import { ManualExecutor, until } from "../server/testing";
import { explainError } from "./bridge";
import { closeTestBridges, connectTestBridge, simulateOlderService, startTestService } from "./bridge.fixtures";
import { ServiceError } from "./client";

/**
 * 会话引用（`delegate` 的 `context` 里的 `session` 条目）在 MCP 这一层：工具说明怎么教主模型、回执写什么、
 * 错误给什么下一步、以及新桥遇到老服务时的样子。条目怎么展开、取不到时怎么说（服务端）在 context-refs.test.ts、context-refs.reject.test.ts（取不到、拒绝与额度）、context-refs.merge.test.ts 与 manager.context-refs.test.ts，
 * 回执文字的逐行规则在 format-context.test.ts。这里用真服务（临时状态目录、假执行端）与进程内的 MCP 客户端，从不碰真实数据。
 */

afterEach(closeTestBridges);

interface Setup {
  /** 把服务写下的 service.json 改成老服务写的样子：没有 features 字段（老服务不认识 session 条目）。 */
  old?: boolean;
}

async function setup(options: Setup = {}) {
  const executor = new ManualExecutor("pi");
  executor.autoStart = true;
  const service = await startTestService({ homePrefix: "ensemble-mcp-context-", executors: [executor], env: {} });
  // 模拟老服务：在桥发出第一个请求之前改（它在第一次请求时才读 service.json）。
  if (options.old) simulateOlderService(service);
  return { service, executor, ...(await connectTestBridge(service)) };
}

type Harness = Awaited<ReturnType<typeof setup>>;

const ANSWER = "Parser fixed.\nAll tests pass.";
const TITLE = "Fix the parser";

/** 经 MCP 派发一个上游会话（还在运行）。 */
async function runningUpstream(h: Harness): Promise<{ sessionId: string; runId: string }> {
  const started = await h.call("delegate", { harness: "pi", task: "Fix the parser", title: TITLE, cwd: tmpdir() });
  expect(started.isError).toBe(false);
  const sessionId = started.data?.["sessionId"] as string;
  const runId = started.data?.["runId"] as string;
  await until(() => h.service.hub.summary(sessionId)?.phase === "running", 4000, "the upstream to run");
  return { sessionId, runId };
}

/** 让上游改一个文件、给出最终回答并正常结束。 */
async function finishedUpstream(h: Harness): Promise<{ sessionId: string; runId: string }> {
  const upstream = await runningUpstream(h);
  const session = h.executor.sessions.find((candidate) => candidate.input.meta.id === upstream.sessionId);
  if (!session) throw new Error("no executor session for the upstream");
  session.emit({ kind: "file.changed", data: { files: [{ path: "src/parser.ts", change: "modified" }] }, runId: upstream.runId });
  session.emit({ kind: "assistant.delta", data: { itemId: "m1", text: ANSWER, phase: "final" }, runId: upstream.runId });
  session.emit({ kind: "assistant.completed", data: { itemId: "m1" }, runId: upstream.runId });
  session.complete(upstream.runId);
  await until(() => h.service.hub.summary(upstream.sessionId)?.phase === "done", 4000, "the upstream to finish");
  return upstream;
}

const downstream = (context: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  harness: "pi",
  task: "Review the fix",
  cwd: tmpdir(),
  context,
  ...extra,
});

describe("工具说明怎么教主模型", () => {
  it("delegate 的说明与 context 参数：直接引用上游，别读了再转述；上游不能还在运行；数字取自常量", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const delegate = tools.find((tool) => tool.name === "delegate")!;

    expect(delegate.description).toContain("put `{ kind: \"session\", sessionId }` in `context` instead of reading its output and retelling it");
    expect(delegate.description).toContain("copies that session's real final answer from its own record into the new session's prompt, verbatim");
    expect(delegate.description).toContain("The referenced session must not be running; the reply says exactly what was taken.");

    const properties = delegate.inputSchema.properties as Record<string, { description?: string }>;
    expect(properties["context"]?.description).toContain("`session` references that hand over another session's output without you retelling it");
    expect(properties["context"]?.description).toContain(`at most ${LIMITS.contextSession.maxRefs} different sessions`);
    expect(properties["context"]?.description).toContain(`cut at ${LIMITS.contextSession.maxResultChars} characters and the reply says so`);

    // 条目的结构也在 schema 里：session 条目有 sessionId，include 只认这三样。
    const schema = JSON.stringify(properties["context"]);
    expect(schema).toContain('"sessionId"');
    expect(schema).toContain('"result","files","error"');
  });

  it("服务级说明里也有这一条（每个会话开头都会读到），并说明 follows 仍决定连线", async () => {
    const { client } = await setup();

    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("put `{ kind: \"session\", sessionId }` in `delegate`'s `context`");
    expect(instructions).toContain("instead of reading it and retelling it");
    expect(instructions).toContain("`follows` still decides how the panel draws the connection");
  });

  it("工具数量不变：引用是 delegate 的一种上下文，不是新工具", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();

    expect(tools).toHaveLength(8);
  });
});

describe("delegate：引用一个已结束的会话", () => {
  it("回执写明取到了什么（取自第几次运行、字数、几个路径），结构化结果带着同样的事实；下游的提示里是上游的原文", async () => {
    const h = await setup();
    const upstream = await finishedUpstream(h);

    const result = await h.call<{ sessionId: string; contextRefs: unknown[] }>(
      "delegate",
      downstream([{ kind: "session", sessionId: upstream.sessionId, include: ["result", "files"], note: "Review this" }]),
    );

    expect(result.isError).toBe(false);
    expect(result.text).toContain("    context from a session, copied verbatim from its own record into the new session's prompt:");
    expect(result.text).toContain(`      ${upstream.sessionId} “${TITLE}” (pi; done when read): result: final answer, ${ANSWER.length} chars, run 1 of 1; files: 1 path`);
    // 回执在详情之后、工作区那一行之前。
    expect(result.text.indexOf("context from a session")).toBeGreaterThan(result.text.indexOf("Delegated to "));
    expect(result.text.indexOf("context from a session")).toBeLessThan(result.text.indexOf("workspace source:"));

    expect(result.data?.["contextRefs"]).toHaveLength(1);
    expect(result.data?.["contextRefs"][0]).toMatchObject({
      sessionId: upstream.sessionId,
      include: ["result", "files"],
      title: TITLE,
      harness: "pi",
      phase: "done",
      runCount: 1,
      result: { found: true, label: "final", runIndex: 1, chars: ANSWER.length, sentChars: ANSWER.length },
      files: { total: 1, sent: 1 },
    });

    // 下游会话的提示里是上游自己的原文（不是主模型转述的），并带着主模型写的备注。
    const prompt = h.service.hub.state(result.data?.["sessionId"] as string)?.meta.task.prompt ?? "";
    expect(prompt).toContain(`### Session ${upstream.sessionId}: ${TITLE}\n`);
    expect(prompt).toContain(`\`\`\`text\n${ANSWER}\n\`\`\``);
    expect(prompt).toContain("#### Files changed (1 path across all 1 run, as reported by the executor)\n- src/parser.ts (modified)");
    expect(prompt).toContain("Note from the delegating agent: Review this");
  });

  it("引用不会自己连线：没有传 follows，页面上这两个会话就没有承接关系，回执里也没有 follows / nested 一行", async () => {
    const h = await setup();
    const upstream = await finishedUpstream(h);

    const result = await h.call("delegate", downstream([{ kind: "session", sessionId: upstream.sessionId }]));

    expect(result.isError).toBe(false);
    expect(h.service.hub.summary(result.data?.["sessionId"] as string)?.parentSessionId).toBeUndefined();
    expect(result.text).not.toContain("follows session");
    expect(result.text).not.toContain("nested under");
  });

  it("没有引用的委派：回执里没有这一块，结构化结果里也没有 contextRefs（老写法不受影响）", async () => {
    const h = await setup();

    const result = await h.call("delegate", downstream([{ kind: "text", title: "Background", text: "The parser is in src/parser.ts" }]));

    expect(result.isError).toBe(false);
    expect(result.text).not.toContain("context from");
    expect(result.data).not.toHaveProperty("contextRefs");
  });
});

describe("delegate：不能引用的会话，拒绝时给出下一步", () => {
  it("上游还在运行：点名 id 与阶段，让主模型去 wait 它，而不是立刻重试；什么都没有创建", async () => {
    const h = await setup();
    const upstream = await runningUpstream(h);

    const result = await h.call("delegate", downstream([{ kind: "session", sessionId: upstream.sessionId }]));

    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      `Session ${upstream.sessionId} (running) is still in progress, so its output is not final and cannot be handed over yet. Wait for it to finish, then delegate again. ` +
        `Call \`wait\` with \`sessionIds\` ["${upstream.sessionId}"] until it has finished, then call \`delegate\` again with the same \`context\`.`,
    );
    expect(h.service.hub.allSummaries()).toHaveLength(1);
  });

  it("引用不存在的会话：点名 id，出路是 status 查有效的 id 再改正或去掉这一项", async () => {
    const h = await setup();

    const result = await h.call("delegate", downstream([{ kind: "session", sessionId: "ses_nope" }]));

    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      "Session ses_nope referenced in context does not exist. " +
        'Call `status` with scope "all" to list valid session ids, then correct that `context` item or remove it.',
    );
    expect(h.service.hub.allSummaries()).toHaveLength(0);
  });

  it("引用太多个不同的会话：服务端的说明原样给出（已经写明上限和怎么改）", async () => {
    const h = await setup();
    const many = Array.from({ length: LIMITS.contextSession.maxRefs + 1 }, (_, index) => ({ kind: "session", sessionId: `ses_${index}` }));

    const result = await h.call("delegate", downstream(many));

    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      `context references ${many.length} different sessions; a delegation can reference at most ${LIMITS.contextSession.maxRefs}. Reference only the sessions this work really depends on.`,
    );
    expect(h.service.hub.allSummaries()).toHaveLength(0);
  });
});

describe("新桥遇到老服务", () => {
  it("带 session 条目：在请求服务之前就拦住并说明，不会静默去掉条目再发（给出的是桥的说明，不是服务端的 not_found）", async () => {
    const h = await setup({ old: true });

    const result = await h.call("delegate", downstream([{ kind: "session", sessionId: "ses_whatever" }]));

    expect(result.isError).toBe(true);
    expect(result.text).toContain("The running Ensemble service is older than this plugin and does not know `session` references in `context`, so it would reject them.");
    expect(result.text).toContain("Ask the user to restart the Ensemble service, or call `delegate` again with `text` or `file` context instead");
    expect(result.text).not.toContain("does not exist");
    expect(h.service.hub.allSummaries()).toHaveLength(0);
  });

  it("session 条目与别的条目混在一起也一样整条拦住（不挑出其余四种先发）", async () => {
    const h = await setup({ old: true });

    const result = await h.call("delegate", downstream([{ kind: "text", title: "Background", text: "plain" }, { kind: "session", sessionId: "ses_whatever" }]));

    expect(result.isError).toBe(true);
    expect(result.text).toContain("older than this plugin");
    expect(h.service.hub.allSummaries()).toHaveLength(0);
  });

  it("其余四种上下文照常：老服务上委派带 text 的条目，会话建出来，回执里没有引用那一块", async () => {
    const h = await setup({ old: true });

    const result = await h.call("delegate", downstream([{ kind: "text", title: "Background", text: "plain" }]));

    expect(result.isError).toBe(false);
    expect(result.text).not.toContain("context from");
    expect(h.service.hub.allSummaries()).toHaveLength(1);
    expect(h.service.hub.state(result.data?.["sessionId"] as string)?.meta.task.context).toEqual([{ kind: "text", title: "Background", text: "plain" }]);
  });
});

describe("explainError：会话引用的几种拒绝", () => {
  it("not_found：来自 context 的，给出改正或去掉那一项的出路；别处的 not_found 仍是原来的话", () => {
    const viaContext = new ServiceError("not_found", "Session ses_x referenced in context does not exist.", 404, { via: "context", sessionIds: ["ses_x"] });
    const elsewhere = new ServiceError("not_found", "Session ses_x does not exist.", 404);

    expect(explainError(viaContext)).toBe(
      'Session ses_x referenced in context does not exist. Call `status` with scope "all" to list valid session ids, then correct that `context` item or remove it.',
    );
    expect(explainError(elsewhere)).toBe("Session ses_x does not exist. Call `status` to list valid session ids.");
  });

  it("context_session_active：一个会话说 “it has”，多个说 “they have”，都带着 sessionIds 的 JSON；没有明细时不写 sessionIds", () => {
    const one = new ServiceError("context_session_active", "Session ses_a (running) is still in progress.", 409, { via: "context", sessions: [{ sessionId: "ses_a", phase: "running" }] });
    const two = new ServiceError("context_session_active", "Sessions ses_a (running), ses_b (queued) are still in progress.", 409, {
      via: "context",
      sessions: [
        { sessionId: "ses_a", phase: "running" },
        { sessionId: "ses_b", phase: "queued" },
      ],
    });
    const bare = new ServiceError("context_session_active", "Sessions are still in progress.", 409);

    expect(explainError(one)).toBe('Session ses_a (running) is still in progress. Call `wait` with `sessionIds` ["ses_a"] until it has finished, then call `delegate` again with the same `context`.');
    expect(explainError(two)).toBe(
      'Sessions ses_a (running), ses_b (queued) are still in progress. Call `wait` with `sessionIds` ["ses_a","ses_b"] until they have finished, then call `delegate` again with the same `context`.',
    );
    expect(explainError(bare)).toBe("Sessions are still in progress. Call `wait` until they have finished, then call `delegate` again with the same `context`.");
  });

  it("context_too_large：服务端的说明已经写明各部分的大小和怎么改小，原样给出，不再叠加别的话", () => {
    const message = "The task and its context come to 250000 characters, over the limit of 200000 for a delegation that references sessions (task 100; session ses_a 249000; other context 900). Narrow `include`.";

    expect(explainError(new ServiceError("context_too_large", message, 422, { via: "context" }))).toBe(message);
  });
});
