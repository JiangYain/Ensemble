import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { testMeta } from "@shared/testing";
import type { PlanItem, ReasoningItem } from "@shared/types";
import { silentLogger } from "../logger";
import { shutdownTrackedEnvs, stateOf, until } from "../testing";
import { CodexExecutor } from "./codex";
import { WAIT, assistants, completed, delegate, diagnostics, setup, tools } from "./codex.fixtures";

/**
 * Codex 适配器：把 Codex 自己报告的东西映射成 Ensemble 的视图——时间线条目（计划、思考摘要、命令输出、MCP 与网页搜索、自行开启的回合）、
 * 探测结果（账号、版本、模型目录与档位、访问级别）、续接原生线程时的会话与用量基线。
 * 主线用例、纠偏与失败在 codex.test.ts，提问与授权在 codex.questions.test.ts；假进程的启动与读时间线的小函数共用，在 codex.fixtures.ts。
 */

afterEach(shutdownTrackedEnvs);

describe("Codex adapter: item mapping", () => {
  it("projects plan updates onto one plan entry list per run", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Do two things [fake:plan]" });
    await completed(env, sessionId);
    const plans = stateOf(env, sessionId).timeline.filter((item): item is PlanItem => item.type === "plan");
    expect(plans).toHaveLength(1);
    expect(plans[0]?.entries).toEqual([
      { text: "Run echo one", status: "completed" },
      { text: "Run echo two", status: "completed" },
    ]);
  });

  it("assigns phases itself when the model gives none: the last block is the answer, the rest is narration", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Think out loud [fake:nophase]" });
    await completed(env, sessionId);
    expect(assistants(env, sessionId).map((item) => [item.text, item.phase])).toEqual([
      ["First thought.", "commentary"],
      ["Second thought.", "final"],
    ]);
  });

  it("does not manufacture an empty 'thinking' entry when summaries are switched off", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Be quiet [fake:silent]" });
    await completed(env, sessionId);
    expect(stateOf(env, sessionId).timeline.some((item) => item.type === "reasoning")).toBe(false);
    expect(assistants(env, sessionId).map((item) => item.text)).toEqual(["Quiet."]);
  });

  it("joins multi-part reasoning summaries and keeps summaries that only arrive at completion", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Think [fake:reasoning2]" });
    await completed(env, sessionId);
    const reasoning = stateOf(env, sessionId).timeline.filter((item): item is ReasoningItem => item.type === "reasoning");
    expect(reasoning.map((item) => [item.text, item.streaming])).toEqual([
      ["**First idea**\n\n**Second idea**", false],
      ["Only at completion", false],
    ]);
  });

  it("flushes the last burst of command output while the command is still running", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Build [fake:bigoutput]" });
    await until(() => tools(env, sessionId)[0]?.output?.text.includes("TAIL-MARKER") === true, WAIT, "trailing output flush");
    // 此时命令还在运行：输出是节流后的尾部刷新，不是命令结束时才给出的。
    expect(tools(env, sessionId)[0]?.status).toBe("running");

    await completed(env, sessionId);
    const build = tools(env, sessionId)[0]!;
    expect(build).toMatchObject({ status: "failed", exitCode: 2, error: "Exit code 2" });
    expect(build.output?.text).toBe("FULL-OUTPUT\n");
  });

  it("maps MCP tool calls, their progress, results and failures", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Search [fake:mcp]" });
    await completed(env, sessionId);
    const [search, fetch] = tools(env, sessionId);
    expect(search).toMatchObject({ name: "mcp__docs__search", category: "mcp", title: "docs / search", status: "completed", mcp: { server: "docs", tool: "search" } });
    expect(search?.input?.text).toContain("retry policy");
    expect(search?.output?.text).toBe("3 results");
    expect(fetch).toMatchObject({ name: "mcp__docs__fetch", status: "failed", error: "upstream returned 500" });
  });

  it("reports each failed MCP server once, without repeating the server name in the reason", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Get ready [fake:mcpfail]" });
    await completed(env, sessionId);
    const failures = diagnostics(env, sessionId).filter((item) => item.code === "codex.mcp_failed");
    expect(failures.map((item) => item.message)).toEqual([
      'MCP server "idalib" failed to start: MCP startup failed: Transport closed',
      'MCP server "docs" failed to start: spawn ENOENT',
    ]);
  });

  it("maps web searches", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Look it up [fake:websearch]" });
    await completed(env, sessionId);
    expect(tools(env, sessionId)).toEqual([
      expect.objectContaining({ name: "web_search", category: "web", title: "codex app-server protocol", status: "completed" }),
    ]);
  });

  it("flags turns Codex starts on its own instead of silently tracking or ignoring them", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Finish [fake:stray]" });
    await completed(env, sessionId);
    await until(() => diagnostics(env, sessionId).some((item) => item.code === "codex.unrequested_turn"), WAIT, "stray-turn diagnostic");
    expect(stateOf(env, sessionId).runs).toHaveLength(1);
  });
});

describe("Codex adapter probing", () => {
  it("reports account, version, models, per-model efforts and the default from Codex itself", async () => {
    const { executor } = setup();
    const info = await executor.probe();
    expect(info).toMatchObject({ status: "ready", runtime: "native", version: "9.9.9", account: "ChatGPT plus", defaultModel: "fake-default" });
    const standard = info.models.find((model) => model.id === "fake-default");
    expect(standard).toMatchObject({ label: "Fake Default", efforts: ["low", "medium", "high"], defaultEffort: "medium", isDefault: true });
    // 只有一个档位的模型不展示推理档位选择。
    expect(info.models.find((model) => model.id === "fake-mini")?.efforts).toBeUndefined();
    expect(info.access.read_only?.level).toBe("enforced");
    expect(info.access.full?.level).toBe("none");
    // 尚未在真实环境之外验证过的能力不能被标成 live。
    expect(info.capabilities.steer).toMatchObject({ support: "yes", mode: "turn_boundary" });
  });

  it("marks the model Ensemble will actually use as the default, not the one Codex's catalog flags", async () => {
    const { executor } = setup({ FAKE_CODEX_CONFIG_MODEL: "fake-mini" });
    const info = await executor.probe();
    expect(info.defaultModel).toBe("fake-mini");
    expect(info.models.find((model) => model.id === "fake-mini")?.isDefault).toBe(true);
    expect(info.models.find((model) => model.id === "fake-default")?.isDefault).toBeUndefined();
  });

  it("needs setup when Codex is not signed in", async () => {
    const info = await setup({ FAKE_CODEX_ACCOUNT: "none" }).executor.probe();
    expect(info.status).toBe("needs_setup");
    expect(info.setup).toMatchObject({ code: "codex_login_required", command: "codex login" });
  });

  it("needs setup when Codex offers no models", async () => {
    const info = await setup({ FAKE_CODEX_MODELS: "none" }).executor.probe();
    expect(info.status).toBe("needs_setup");
    expect(info.setup?.code).toBe("codex_no_models");
  });

  it("is honest when Codex is not installed", async () => {
    const info = await new CodexExecutor({ bin: join(tmpdir(), "definitely-missing", "codex.mjs") }).probe();
    expect(info.status).toBe("unavailable");
    expect(info.setup).toMatchObject({ code: "codex_not_found", command: "npm install -g @openai/codex" });
  });
});

describe("Codex adapter resuming", () => {
  async function openResumed(executor: CodexExecutor, id: string, emitted: { kind: string; data: any }[] = []) {
    const controller = new AbortController();
    const session = await executor.open({
      meta: testMeta({ harness: "codex", cwd: tmpdir(), model: undefined }),
      resume: { kind: "codex-thread", id },
      emit: (draft) => emitted.push(draft as { kind: string; data: any }),
      fatal: () => undefined,
      log: silentLogger,
      signal: controller.signal,
    });
    return { session, controller };
  }

  it("reopens the native thread without replaying history and measures usage from the resumed baseline", async () => {
    const { executor, requests } = setup({ FAKE_CODEX_RESUME_TOTAL: "5000" });
    const emitted: { kind: string; data: any }[] = [];
    const { session, controller } = await openResumed(executor, "thr-fake-7", emitted);
    try {
      expect(session.nativeRef).toMatchObject({ kind: "codex-thread", id: "thr-fake-7" });
      expect(requests("thread/resume")[0]).toMatchObject({ threadId: "thr-fake-7", excludeTurns: true });
      // 恢复的线程保留它原来的名字，不能被重命名。
      expect(requests("thread/name/set")).toHaveLength(0);

      await session.startRun({ runId: "run_a", messageId: "msg_a", prompt: "Continue [fake:basic]", trigger: "task" });
      await until(() => emitted.some((entry) => entry.kind === "run.completed"), WAIT, "run completed");
      const usage = [...emitted].reverse().find((entry) => entry.kind === "usage.updated")?.data as { usage: { totalTokens: number } };
      // 累计值里包含恢复前的 5000，本次运行只应该算自己的 330。
      expect(usage.usage.totalTokens).toBe(330);
    } finally {
      controller.abort();
      await session.close();
    }
  });

  it("fails with a specific code when the native thread no longer exists", async () => {
    const { executor } = setup();
    await expect(openResumed(executor, "unknown-thread")).rejects.toMatchObject({ code: "resume_failed" });
  });
});
