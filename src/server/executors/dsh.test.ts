import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { USER } from "@shared/testing";
import { delegatorFor, itemsOf, shutdownTrackedEnvs, stateOf, until, type TestEnv } from "../testing";
import { packagedFake, setup } from "./dsh.fakes";

afterEach(shutdownTrackedEnvs);

const WAIT = 15_000;
const delegate = delegatorFor("dsh");

const completed = (env: TestEnv, sessionId: string, index = 0) =>
  until(() => stateOf(env, sessionId).runs[index]?.status === "completed", WAIT, `run ${index + 1} completed`);
const failed = (env: TestEnv, sessionId: string) => until(() => stateOf(env, sessionId).runs[0]?.status === "failed", WAIT, "run failed");
const diagnostics = (env: TestEnv, sessionId: string) => itemsOf(env, sessionId, "diagnostic");

describe("DSH 适配器：运行与事件映射（假 dsh 按真实抓包回放 ACP）", () => {
  it("一次运行：投递三阶段、dsh 实际采用的模型与档位、会话标识、上下文用量、启动参数与权限环境", async () => {
    const { env, launches, requests } = setup();
    const { sessionId, messageId } = await delegate(env, { task: "Hello" });
    await completed(env, sessionId);
    const state = stateOf(env, sessionId);
    expect(state.messages.find((message) => message.id === messageId)?.delivery.history.map((entry) => entry.stage)).toEqual(["recorded", "handed_off", "applied"]);
    expect(state.meta.nativeRef).toMatchObject({ kind: "dsh-session" });
    expect(state.meta.model).toMatchObject({ resolved: "deepseek-official/deepseek-v4-flash", label: "deepseek-v4-flash", provider: "deepseek-official" });
    expect(state.meta.effort).toBe("high");
    expect(itemsOf(env, sessionId, "assistant").map((item) => item.text)).toEqual(["Done (turn 1)."]);
    // dsh 只报上下文占用，不编造输入、输出的 token 数。
    expect(state.usageByRun[state.runs[0]!.id]).toEqual({ contextTokens: 3201, contextWindow: 1_000_000 });

    const [launch] = launches();
    expect(launch).toMatchObject({ permission: "danger-full-access", parent: sessionId, depth: "0" });
    expect(launch?.args?.slice(-2)).toEqual(["--profile", "acp"]);
    expect(launch?.args).not.toContain("--patch");
    // 沙箱的工作区根取自进程的工作目录。
    expect(realpathSync.native(launch!.cwd!)).toBe(realpathSync.native(env.cwd));
    expect(requests("session/new")[0]).toMatchObject({ cwd: env.cwd, mcpServers: [] });
    expect(requests("session/prompt")[0]).toMatchObject({ prompt: [{ type: "text", text: expect.stringContaining("Hello") }] });
  });

  it("工具、文件变更、退出码、待办计划、推理与助手文字的阶段，都来自 dsh 上报的事件", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Go [fake:tools] [fake:think]" });
    await completed(env, sessionId);
    const tools = itemsOf(env, sessionId, "tool");
    expect(tools.map((tool) => [tool.name, tool.category, tool.status])).toEqual([
      ["write", "write", "completed"],
      ["edit", "edit", "completed"],
      // dsh 对非零退出码仍报 completed；与其它适配器一致，这里记为失败并带上退出码。
      ["pwsh", "shell", "failed"],
      ["read", "read", "failed"],
      ["todo_write", "plan", "completed"],
    ]);
    expect(tools[0]).toMatchObject({ title: "out/hello.txt", files: [{ path: "out/hello.txt", change: "created", addedLines: 3 }] });
    expect(tools[1]).toMatchObject({ files: [{ path: "out/hello.txt", change: "modified", addedLines: 1, removedLines: 1 }] });
    expect(tools[2]).toMatchObject({ exitCode: 3, error: "Exit code 3" });
    expect(tools[3]?.error).toContain("ENOENT");
    expect(itemsOf(env, sessionId, "plan")[0]?.entries).toEqual([
      { text: "Write the file", status: "completed" },
      { text: "Run the tests", status: "in_progress" },
    ]);
    // dsh 不给文字的阶段：最后一块视为最终回答，其余是过程说明。
    expect(itemsOf(env, sessionId, "assistant").map((item) => [item.text, item.phase, item.streaming])).toEqual([
      ["Working on it.", "commentary", false],
      ["All done.", "final", false],
    ]);
    expect(itemsOf(env, sessionId, "reasoning").map((item) => [item.text, item.streaming])).toEqual([["Thinking about it.", false]]);
    expect(stateOf(env, sessionId).runs[0]).toMatchObject({ status: "completed", stopReason: "end_turn" });
  });

  it("没有任何更新就结束的运行也要有开始，并且如实标为完成", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Nothing [fake:empty]" });
    await completed(env, sessionId);
    expect(stateOf(env, sessionId).runs[0]?.startedAt).toBeDefined();
    expect(itemsOf(env, sessionId, "assistant")).toHaveLength(0);
  });

  it("DSH 以 max_tokens 之类的原因结束一轮时，如实记下停止原因并给出提示", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Long [fake:stop:max_tokens]" });
    await completed(env, sessionId);
    expect(stateOf(env, sessionId).runs[0]?.stopReason).toBe("max_tokens");
    expect(diagnostics(env, sessionId).find((item) => item.code === "dsh.stop_reason")).toMatchObject({ level: "warn", message: expect.stringContaining("max_tokens") });
  });
});

describe("DSH 适配器：模型与推理档位", () => {
  it("委派时选定的模型与档位在 dsh 里真的生效（先模型、后档位），并落到会话元数据上", async () => {
    const { env, requests } = setup({ FAKE_DSH_MODELS: "multi" });
    const { sessionId } = await delegate(env, { model: "deepseek-official/deepseek-v4-pro", effort: "high" });
    await completed(env, sessionId);
    expect(requests("session/set_config_option")).toEqual([
      expect.objectContaining({ configId: "model", value: '["deepseek-official","deepseek-v4-pro"]' }),
      expect.objectContaining({ configId: "reasoning_effort", value: "high" }),
    ]);
    expect(stateOf(env, sessionId).meta).toMatchObject({ model: { requested: "deepseek-official/deepseek-v4-pro", resolved: "deepseek-official/deepseek-v4-pro" }, effort: "high" });
  });

  it("只给模型名也认（名字在目录里唯一时），不指定就沿用 dsh 的默认且不改任何配置", async () => {
    const named = setup({ FAKE_DSH_MODELS: "multi" });
    const first = await delegate(named.env, { model: "plain" });
    await completed(named.env, first.sessionId);
    expect(stateOf(named.env, first.sessionId).meta.model?.resolved).toBe("local/plain");

    const plain = setup();
    const second = await delegate(plain.env);
    await completed(plain.env, second.sessionId);
    expect(plain.requests("session/set_config_option")).toHaveLength(0);
  });

  it("要求的模型不存在时明说并列出可用的，不悄悄改用默认模型", async () => {
    const { env, requests } = setup({ FAKE_DSH_MODELS: "multi" });
    const { sessionId } = await delegate(env, { model: "deepseek-official/not-a-model" });
    await failed(env, sessionId);
    expect(stateOf(env, sessionId).runs[0]?.error).toMatchObject({ code: "model_not_found", message: expect.stringContaining("deepseek-official/deepseek-v4-pro") });
    expect(requests("session/prompt")).toHaveLength(0);
  });

  it("档位不属于当前模型时说明可选的档位，而不是让 dsh 报 -32602", async () => {
    const { env, requests } = setup();
    const { sessionId } = await delegate(env, { effort: "turbo" });
    await failed(env, sessionId);
    expect(stateOf(env, sessionId).runs[0]?.error).toMatchObject({ code: "invalid_request", message: expect.stringContaining("off, low, high, max") });
    expect(requests("session/set_config_option")).toHaveLength(0);
  });
});

describe("DSH 适配器：纠偏与后续消息", () => {
  it("运行中的纠偏排到这一轮结束后作为新的运行发送（dsh 一次只收一个 prompt）", async () => {
    const { env, requests } = setup();
    const { sessionId } = await delegate(env, { task: "Wait [fake:slow]" });
    await until(() => stateOf(env, sessionId).runs[0]?.status === "running", WAIT);
    const queued = await env.manager.send(sessionId, { text: "Use a different approach", mode: "steer", author: USER });
    const state = stateOf(env, sessionId);
    await until(() => state.runs[1]?.status === "completed", WAIT, "second run");
    expect(queued.runId).toBe(state.runs[1]?.id);
    expect(state.messages.find((message) => message.id === queued.messageId)?.delivery.history.map((entry) => entry.stage)).toEqual(["recorded", "queued", "handed_off", "applied"]);
    expect(state.runs.map((run) => run.status)).toEqual(["completed", "completed"]);
    expect(requests("session/prompt")).toHaveLength(2);
    // 同一个 dsh 会话继续：第二轮看到的是它自己累计的状态。
    expect(itemsOf(env, sessionId, "assistant").map((item) => item.text)).toEqual(["Working.", "Done (turn 1).", "Done (turn 2)."]);
  });

  it("session/prompt 在整轮结束前没有任何应答：没有证据之前不记“已生效”，第一轮就失败时也从没生效过", async () => {
    const { env } = setup();
    const { sessionId, messageId } = await delegate(env, { task: "Go [fake:error401]" });
    await failed(env, sessionId);
    const state = stateOf(env, sessionId);
    expect(state.runs[0]?.startedAt).toBeUndefined();
    expect(state.messages.find((message) => message.id === messageId)?.delivery.history.map((entry) => entry.stage)).toEqual(["recorded", "handed_off", "failed"]);
  });
});

describe("DSH 适配器：失败与授权", () => {
  it("上游鉴权失败：这一轮失败并保留 dsh 的原话，会话还能继续下一轮", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Go [fake:error401]" });
    await failed(env, sessionId);
    expect(stateOf(env, sessionId).runs[0]?.error).toMatchObject({ code: "auth_failed", message: expect.stringContaining("Incorrect API key") });
    // 失败的是运行，不是会话。
    expect(stateOf(env, sessionId).status).toBe("idle");
    const next = await env.manager.send(sessionId, { text: "Try again", author: USER });
    await until(() => stateOf(env, sessionId).runs.find((run) => run.id === next.runId)?.status === "completed", WAIT, "next run");
  });

  it("dsh 进程在运行中退出：运行与会话都失败，并带上退出码", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Crash [fake:die]" });
    await until(() => stateOf(env, sessionId).status === "failed", WAIT, "session failed");
    const run = stateOf(env, sessionId).runs[0]!;
    expect(run.status).toBe("failed");
    expect(run.error?.code).toBe("process_exited");
    expect(run.error?.message).toContain("code 3");
  });

  it.each([
    ["full", "danger-full-access", "allow-once", "dsh.approval_granted", "completed"],
    ["read_only", "read-only", "reject-once", "dsh.approval_declined", "failed"],
  ] as const)("兜底的授权请求（%s）：不等人，只选一次性的选项并留下诊断", async (access, mode, optionId, code, toolStatus) => {
    const { env, log, launches } = setup();
    const { sessionId } = await delegate(env, { task: "Go [fake:perm]", access });
    await completed(env, sessionId);
    expect(launches()[0]?.permission).toBe(mode);
    const answer = log().find((entry) => entry.type === "response" && entry.result?.outcome);
    expect(answer?.result).toEqual({ outcome: { outcome: "selected", optionId } });
    expect(diagnostics(env, sessionId).some((item) => item.code === code)).toBe(true);
    expect(itemsOf(env, sessionId, "tool")[0]?.status).toBe(toolStatus);
  });

  it("dsh 发来 Ensemble 不处理的请求：明确拒绝并留下说明，运行不受影响", async () => {
    const { env, log } = setup();
    const { sessionId } = await delegate(env, { task: "Ask [fake:srvreq]" });
    await completed(env, sessionId);
    expect(log().find((entry) => entry.type === "response" && entry.error)?.error?.code).toBe(-32601);
    expect(diagnostics(env, sessionId).find((item) => item.code === "dsh.unsupported_request")).toMatchObject({ level: "info", message: expect.stringContaining("fs/read_text_file") });
  });
});

describe("DSH 适配器：环境", () => {
  it("嵌套委派：子会话的 dsh 进程带着父会话与深度，供它里面的 Ensemble 插件挂回正确的父会话", async () => {
    const { env, launches } = setup();
    const parent = await delegate(env, { task: "Parent" });
    await completed(env, parent.sessionId);
    const child = await delegate(env, { task: "Child", parentSessionId: parent.sessionId });
    await completed(env, child.sessionId);
    expect(launches().map((launch) => [launch.parent, launch.depth])).toEqual([
      [parent.sessionId, "0"],
      [child.sessionId, "1"],
    ]);
  });

  it("包声明的 Node 版本高于当前时留下说明，但照常运行（声明与实测有出入时以实测为准）", async () => {
    const { env } = setup({}, { bin: packagedFake(">=99.0.0") });
    const { sessionId } = await delegate(env);
    await completed(env, sessionId);
    expect(diagnostics(env, sessionId).find((item) => item.code === "dsh.node_version")).toMatchObject({ level: "info", message: expect.stringContaining(">=99.0.0") });
  });

  it("包声明的 Node 版本满足要求时不打扰", async () => {
    const { env } = setup({}, { bin: packagedFake(">=18.0.0") });
    const { sessionId } = await delegate(env);
    await completed(env, sessionId);
    expect(diagnostics(env, sessionId).some((item) => item.code === "dsh.node_version")).toBe(false);
  });
});
