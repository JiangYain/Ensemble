import { afterEach, describe, expect, it } from "vitest";
import { toSummary } from "@shared/projection";
import { USER, testMeta } from "@shared/testing";
import type { ReasoningItem } from "@shared/types";
import { silentLogger } from "../logger";
import { shutdownTrackedEnvs, stateOf, until } from "../testing";
import { WAIT, assistants, completed, delegate, diagnostics, setup, tools, type LogLine } from "./codex.fixtures";

/**
 * Codex 适配器对着忠实的假 app-server 的主线用例：一次完整的回合、模型与推理档位、访问级别与沙箱、运行中纠偏与取消、失败的归类。
 * 提问与授权在 codex.questions.test.ts；条目映射、探测与续接在 codex.mapping.test.ts；假进程的启动与读时间线的小函数共用，在 codex.fixtures.ts。
 */

afterEach(shutdownTrackedEnvs);

/** 真正的会话进程带着 ENSEMBLE_PARENT_SESSION 启动；探测进程没有。 */
const launchOf = (lines: LogLine[]): LogLine | undefined => lines.find((line) => line.argv && line.parent);

describe("Codex adapter against a faithful fake app-server", () => {
  it("maps a full turn: reasoning summary, phases, shell, patches and per-run usage", async () => {
    const { env, log, requests } = setup();
    const { sessionId, messageId } = await delegate(env, { task: "Do the thing [fake:basic]" });
    await completed(env, sessionId);

    const state = stateOf(env, sessionId);
    const summary = toSummary(state);

    // 会话元数据来自 Codex 自己的 thread/start 响应：实际使用的模型、提供方和推理档位。
    expect(state.meta.model).toMatchObject({ resolved: "fake-default", label: "fake-default", provider: "openai" });
    expect(state.meta.effort).toBe("medium");
    expect(state.meta.nativeRef).toMatchObject({ kind: "codex-thread", id: "thr-fake-1" });
    expect(state.runs[0]?.nativeTurnId).toBe("turn-fake-1");

    expect(state.timeline.filter((item): item is ReasoningItem => item.type === "reasoning")).toEqual([
      expect.objectContaining({ text: "**Planning the work**", streaming: false }),
    ]);
    expect(assistants(env, sessionId).map((item) => [item.text, item.phase, item.streaming])).toEqual([
      ["I'll run a command and write a file.", "commentary", false],
      ["All done.", "final", false],
    ]);

    const items = tools(env, sessionId);
    expect(items.map((item) => [item.name, item.category, item.status, item.title])).toEqual([
      ["shell", "shell", "completed", "echo hello"],
      ["apply_patch", "write", "completed", "notes.txt"],
      ["apply_patch", "edit", "completed", "existing.txt"],
    ]);
    expect(items[0]?.output?.text).toBe("hello\r\n");
    expect(items[0]?.exitCode).toBe(0);
    expect(items[1]?.files).toEqual([expect.objectContaining({ path: "notes.txt", change: "created", addedLines: 2 })]);
    expect(items[2]?.files).toEqual([expect.objectContaining({ path: "existing.txt", change: "modified", addedLines: 1, removedLines: 1 })]);
    expect(items[2]?.input?.text).toContain("-this is old text");
    expect(summary.counters.files).toBe(2);

    // 用量是本次运行的累计增量：三次上报 × 110 个 token，缓存与推理单列。
    expect(summary.usage).toMatchObject({
      totalTokens: 330,
      inputTokens: 300,
      outputTokens: 30,
      cachedTokens: 120,
      reasoningTokens: 12,
      contextTokens: 110,
      contextWindow: 400_000,
    });

    // 用户在自己 Codex 配置里开启试验功能的提醒是常态，只作为普通信息记录，不当作告警。
    expect(diagnostics(env, sessionId)).toEqual([expect.objectContaining({ level: "info", code: "codex.warning" })]);

    const task = state.messages.find((message) => message.id === messageId);
    expect(task?.delivery.history.map((entry) => entry.stage)).toEqual(["recorded", "handed_off", "applied"]);

    // 启动参数与握手：只传 app-server；客户端身份与屏蔽的高流量通知；父会话信息写入环境。
    const lines = log();
    const launch = launchOf(lines);
    expect(launch?.argv).toEqual(["app-server"]);
    expect(launch?.parent).toBe(sessionId);
    expect(launch?.depth).toBe("0");
    const init = requests("initialize").at(-1);
    expect(init).toMatchObject({ clientInfo: { name: "ensemble", title: "Ensemble" }, capabilities: { experimentalApi: false } });
    expect(init?.capabilities.optOutNotificationMethods).toContain("turn/diff/updated");

    const threadStart = requests("thread/start")[0];
    expect(threadStart).toMatchObject({
      cwd: state.meta.cwd,
      // 被委派的会话默认 Full Access：无沙箱、从不等待授权。
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      model: "fake-default",
      ephemeral: false,
      serviceName: "ensemble",
    });
    expect(requests("thread/name/set")[0]).toMatchObject({ threadId: "thr-fake-1", name: expect.stringContaining("Ensemble · ") });

    const turnStart = requests("turn/start")[0];
    expect(turnStart).toMatchObject({
      threadId: "thr-fake-1",
      clientUserMessageId: messageId,
      model: "fake-default",
      summary: "auto",
      input: [{ type: "text", text: expect.stringContaining("Do the thing") }],
    });
    expect(turnStart).not.toHaveProperty("effort");
  });

  it("forwards an explicitly requested model and reasoning effort, and does not second-guess them", async () => {
    const { env, requests } = setup({ FAKE_CODEX_CONFIG_MODEL: "fake-default" });
    const { sessionId } = await delegate(env, { model: "fake-mini", effort: "low" });
    await completed(env, sessionId);
    expect(requests("thread/start")[0]).toMatchObject({ model: "fake-mini" });
    expect(requests("turn/start")[0]).toMatchObject({ model: "fake-mini", effort: "low" });
    expect(stateOf(env, sessionId).meta.effort).toBe("low");
  });

  it("maps the delegation's access level to a Codex sandbox and says honestly how it is enforced", async () => {
    const cases = [
      { access: "read_only", sandbox: "read-only", approvalPolicy: "never", level: "enforced" },
      { access: "full", sandbox: "danger-full-access", approvalPolicy: "never", level: "none" },
    ] as const;
    for (const expected of cases) {
      const { env, requests } = setup();
      const { sessionId } = await delegate(env, { access: expected.access });
      await completed(env, sessionId);
      expect(requests("thread/start")[0]).toMatchObject({ sandbox: expected.sandbox, approvalPolicy: expected.approvalPolicy });
      expect(stateOf(env, sessionId).meta.accessEnforcement?.level).toBe(expected.level);
    }
  });

  it("delegates with Full Access when no access level is given", async () => {
    const { env, requests } = setup();
    const { sessionId } = await delegate(env);
    await completed(env, sessionId);
    expect(stateOf(env, sessionId).meta.access).toBe("full");
    expect(requests("thread/start")[0]).toMatchObject({ sandbox: "danger-full-access", approvalPolicy: "never" });
    expect(requests("thread/resume")).toHaveLength(0);
  });

  it("does not claim enforcement when Windows' sandbox is not ready", async () => {
    const { env, executor } = setup({ FAKE_CODEX_OS: "windows", FAKE_CODEX_SANDBOX: "notConfigured" });
    const info = await executor.probe();
    expect(info.access.read_only).toMatchObject({ level: "none", mechanism: expect.stringContaining("notConfigured") });
    expect(info.access.full).toMatchObject({ level: "none", mechanism: expect.stringContaining("no sandbox") });

    const { sessionId } = await delegate(env, { access: "read_only" });
    await completed(env, sessionId);
    expect(stateOf(env, sessionId).meta.accessEnforcement?.level).toBe("none");
  });

  it("downgrades the claim when Codex applies a different sandbox than the one requested", async () => {
    const { env } = setup({ FAKE_CODEX_SANDBOX_TYPE: "dangerFullAccess" });
    const { sessionId } = await delegate(env, { access: "read_only" });
    await completed(env, sessionId);
    const state = stateOf(env, sessionId);
    expect(state.meta.accessEnforcement).toMatchObject({ level: "none", mechanism: expect.stringContaining("dangerFullAccess") });
    expect(diagnostics(env, sessionId).some((item) => item.code === "codex.sandbox_mismatch" && item.level === "warn")).toBe(true);
  });

  it("uses an available model when the configured default is not in Codex's catalog", async () => {
    // 用户配置里的默认模型（例如已下线）不在目录里时，直接使用会让每次委派都 model_not_found。
    const stale = setup({ FAKE_CODEX_CONFIG_MODEL: "retired-model" });
    const { sessionId } = await delegate(stale.env);
    await completed(stale.env, sessionId);
    expect(stale.requests("thread/start")[0]).toMatchObject({ model: "fake-default" });

    // 它在目录里时则尊重用户自己的选择。
    const valid = setup({ FAKE_CODEX_CONFIG_MODEL: "fake-mini" });
    const second = await delegate(valid.env);
    await completed(valid.env, second.sessionId);
    expect(valid.requests("thread/start")[0]).toMatchObject({ model: "fake-mini" });
  });

  it("explains the fallback in the timeline when the model had to be resolved live", async () => {
    const { env, executor } = setup({ FAKE_CODEX_CONFIG_MODEL: "retired-model" });
    // 不经过探测直接打开会话（没有缓存的默认模型）：适配器必须现场查询，并把回退告诉用户。
    const controller = new AbortController();
    const emitted: { kind: string; data: any }[] = [];
    const session = await executor.open({
      meta: testMeta({ harness: "codex", cwd: env.cwd, model: undefined }),
      emit: (draft) => emitted.push(draft as { kind: string; data: any }),
      fatal: () => undefined,
      log: silentLogger,
      signal: controller.signal,
    });
    try {
      expect(emitted.find((entry) => entry.kind === "diagnostic" && entry.data.code === "codex.default_model_unavailable")?.data.message).toContain("retired-model");
    } finally {
      controller.abort();
      await session.close();
    }
  });

  it("delivers prompts larger than the pipe buffer instead of treating back-pressure as a failure", async () => {
    const { env, requests } = setup();
    const task = `${"x".repeat(150_000)} [fake:plan]`;
    const { sessionId } = await delegate(env, { task });
    await completed(env, sessionId);
    expect(String(requests("turn/start")[0]?.input?.[0]?.text).length).toBeGreaterThanOrEqual(150_000);
  });
});

describe("Codex adapter: live intervention", () => {
  it("reports a steering message as applied only after Codex echoes it into the thread", async () => {
    const { env, requests } = setup();
    const { sessionId } = await delegate(env, { task: "Work carefully [fake:hold]" });
    await until(() => tools(env, sessionId).length > 0, WAIT, "first tool");

    const result = await env.manager.send(sessionId, { text: "Skip the slow part", author: USER });
    expect(result.kind).toBe("steer");
    await until(
      () => stateOf(env, sessionId).messages.find((message) => message.id === result.messageId)?.delivery.stage === "applied",
      WAIT,
      "steer applied",
    );
    const message = stateOf(env, sessionId).messages.find((entry) => entry.id === result.messageId)!;
    expect(message.delivery.history.map((entry) => entry.stage)).toEqual(["recorded", "handed_off", "queued", "applied"]);
    expect(message.delivery.history[2]).toMatchObject({ queuedBy: "harness", reason: "turn_boundary" });
    expect(message.delivery.evidence).toContain("clientId matches");

    await completed(env, sessionId);
    expect(assistants(env, sessionId).at(-1)?.text).toBe("Adjusted: Skip the slow part");
    expect(requests("turn/steer")).toEqual([
      expect.objectContaining({ threadId: "thr-fake-1", expectedTurnId: "turn-fake-1", clientUserMessageId: result.messageId }),
    ]);
  });

  it("keeps the delivery history in true order even when Codex's echo arrives in the same chunk as the steer response", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Work carefully [fake:fast]" });
    await until(() => tools(env, sessionId).length > 0, WAIT, "first tool");

    const result = await env.manager.send(sessionId, { text: "Quick fix", author: USER });
    await completed(env, sessionId);
    const message = stateOf(env, sessionId).messages.find((entry) => entry.id === result.messageId)!;
    expect(message.delivery.stage).toBe("applied");
    expect(message.delivery.history.map((entry) => entry.stage)).toEqual(["recorded", "handed_off", "queued", "applied"]);
    expect(assistants(env, sessionId).at(-1)?.text).toBe("Fast steer seen: Quick fix");
  });

  it("falls back to a follow-up run when Codex says the turn can no longer be steered", async () => {
    const { env } = setup({ FAKE_CODEX_STEER_REJECT: "1" });
    const { sessionId } = await delegate(env, { task: "Work carefully [fake:hold]" });
    await until(() => tools(env, sessionId).length > 0, WAIT, "first tool");

    const result = await env.manager.send(sessionId, { text: "Please also check b.txt", author: USER });
    await until(() => stateOf(env, sessionId).runs[1]?.status === "completed", WAIT, "follow-up run completed");
    const state = stateOf(env, sessionId);
    expect(state.runs.map((run) => run.status)).toEqual(["completed", "completed"]);
    const message = state.messages.find((entry) => entry.id === result.messageId)!;
    expect(message.delivery.stage).toBe("applied");
    expect(message.delivery.history[1]).toMatchObject({ stage: "queued", queuedBy: "ensemble" });
    expect(message.delivery.history[1]?.evidence).toContain("codex rejected turn/steer");
  });

  it("cancels cleanly: interrupts the turn, reports cancelled (not failed) and stays usable", async () => {
    const { env, requests } = setup();
    const { sessionId } = await delegate(env, { task: "Keep going [fake:long]" });
    await until(() => tools(env, sessionId).length > 0, WAIT, "tool running");

    await env.manager.cancel(sessionId, USER);
    await until(() => stateOf(env, sessionId).runs[0]?.status === "cancelled", WAIT, "run cancelled");

    const state = stateOf(env, sessionId);
    expect(state.runs[0]?.error).toBeUndefined();
    expect(state.status).toBe("idle");
    expect(requests("turn/interrupt")).toEqual([{ threadId: "thr-fake-1", turnId: "turn-fake-1" }]);
    // Codex 不会再为被中断的命令上报结束事件，所以由适配器明确记为“已取消”，而不是留在“运行中”。
    expect(tools(env, sessionId).map((item) => item.status)).toEqual(["cancelled"]);

    const next = await env.manager.send(sessionId, { text: "Do something small", author: USER });
    expect(next.kind).toBe("follow_up");
    await until(() => stateOf(env, sessionId).runs[1]?.status === "completed", WAIT, "follow-up run");
    expect(requests("turn/start")).toHaveLength(2);
  });
});

describe("Codex adapter: failures", () => {
  it("classifies a usage limit as rate-limited, keeps the raw message and records the retry that preceded it", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Do it [fake:error]" });
    await until(() => stateOf(env, sessionId).runs[0]?.status === "failed", WAIT, "run failed");
    const run = stateOf(env, sessionId).runs[0]!;
    expect(run.error).toMatchObject({ code: "rate_limited", message: expect.stringContaining("usage limit") });
    // 用量上限不是“稍后自动恢复”的瞬时错误：不能标成可重试。
    expect(run.error?.retryable).toBeUndefined();
    expect(diagnostics(env, sessionId).some((item) => item.code === "codex.retrying" && item.level === "warn")).toBe(true);
    // 失败的是运行，不是会话。
    expect(stateOf(env, sessionId).status).toBe("idle");
  });

  it("surfaces an unsupported model as model_not_found even though Codex files it under a generic bad request", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Do it [fake:modelerror]", model: "gpt-6.1-sol" });
    await until(() => stateOf(env, sessionId).runs[0]?.status === "failed", WAIT, "run failed");
    expect(stateOf(env, sessionId).runs[0]?.error).toMatchObject({ code: "model_not_found", message: expect.stringContaining("gpt-6.1-sol") });
  });

  it("fails the run and the session when the Codex process dies mid-run", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Crash [fake:crash]" });
    await until(() => stateOf(env, sessionId).status === "failed", WAIT, "session failed");
    const run = stateOf(env, sessionId).runs[0]!;
    expect(run.status).toBe("failed");
    expect(run.error?.code).toBe("process_exited");
    expect(run.error?.message).toContain("code 7");
  });
});
