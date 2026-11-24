import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { toSummary } from "@shared/projection";
import { USER, testMeta } from "@shared/testing";
import { silentLogger } from "../logger";
import { delegatorFor, itemsOf, makeTrackedEnv, shutdownTrackedEnvs, stateOf, until, type TestEnv } from "../testing";
import { PiExecutor } from "./pi";

const FAKE_PI = fileURLToPath(new URL("../../../test/fixtures/fake-pi.mjs", import.meta.url));
const WAIT = 12_000;

interface LogLine {
  argv?: string[];
  cwd?: string;
  parent?: string | null;
  depth?: string | null;
  command?: { type: string; [key: string]: unknown };
}

function setup(extraEnv: NodeJS.ProcessEnv = {}) {
  const logFile = join(mkdtempSync(join(tmpdir(), "ensemble-fakepi-log-")), "log.jsonl");
  writeFileSync(logFile, "");
  const executor = new PiExecutor({ cli: FAKE_PI, env: { ...process.env, FAKE_PI_LOG: logFile, ...extraEnv } });
  const env = makeTrackedEnv([executor]);
  const log = (): LogLine[] =>
    readFileSync(logFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LogLine);
  return { env, executor, log };
}

afterEach(shutdownTrackedEnvs);

const delegate = delegatorFor("pi");

/** 管理器委派前会先探测（--version / 探测用 RPC），真正的会话进程是带 --name 的那次启动。 */
const launchOf = (lines: LogLine[]): LogLine | undefined => lines.find((line) => line.argv?.includes("--name"));

const tools = (env: TestEnv, sessionId: string) => itemsOf(env, sessionId, "tool");

describe("Pi adapter against a faithful fake RPC process", () => {
  it("maps parallel tool calls, file changes, phases and per-run usage", async () => {
    const { env, log } = setup();
    writeFileSync(join(env.cwd, "existing.txt"), "old\n");
    const { sessionId, messageId } = await delegate(env, { task: "Write some files [fake:parallel]" });
    await until(() => stateOf(env, sessionId).runs[0]?.status === "completed", WAIT, "run completed");

    const state = stateOf(env, sessionId);
    const summary = toSummary(state);

    // 会话元数据来自 Pi 自己的 get_state，而不是请求值。
    expect(state.meta.model).toMatchObject({ resolved: "fake/fake-model", label: "Fake Model", provider: "fake" });
    expect(state.meta.effort).toBe("medium");
    expect(state.meta.nativeRef).toMatchObject({ kind: "pi-session", id: "fake-session-1" });

    const items = tools(env, sessionId);
    expect(items.map((t) => [t.name, t.category, t.status])).toEqual([
      ["write", "write", "completed"],
      ["write", "write", "completed"],
      ["bash", "shell", "completed"],
    ]);
    expect(items[0]?.title).toBe("new.txt");
    expect(items[2]?.title).toBe("echo done");
    expect(items[2]?.output?.text).toBe("done\n");

    // “新建 vs 覆盖”要在工具运行之前判定，而不是事后检查。
    expect(items[0]?.files).toEqual([{ path: "new.txt", change: "created", addedLines: 1 }]);
    expect(items[1]?.files).toEqual([{ path: "existing.txt", change: "modified" }]);
    expect(summary.counters.files).toBe(2);

    const assistants = state.timeline.filter((item) => item.type === "assistant");
    expect(assistants.map((a) => [a.type === "assistant" ? a.text : "", a.type === "assistant" ? a.phase : ""])).toEqual([
      ["I'll do all three.", "commentary"],
      ["All finished.", "final"],
    ]);

    // 用量是本次运行相对基线的增量：两条助手消息 × (100 输入 + 10 输出 + 50 缓存)。
    // Pi 的输入不含缓存，Ensemble 的输入含缓存：(100 + 50) × 2 = 300，缓存 100 是其中一部分，输入 + 输出 = Pi 的 total 320。
    expect(summary.usage).toMatchObject({ inputTokens: 300, outputTokens: 20, cachedTokens: 100, totalTokens: 320, costUsd: 0.002, contextTokens: 1234, contextWindow: 100000 });

    const task = state.messages.find((m) => m.id === messageId);
    expect(task?.delivery.history.map((h) => h.stage)).toEqual(["recorded", "handed_off", "applied"]);

    // 启动参数与环境：名称、离线、不信任项目内文件；父会话信息写入环境。
    const launch = launchOf(log());
    expect(launch?.argv).toEqual(expect.arrayContaining(["--mode", "rpc", "--offline", "--no-approve", "--name"]));
    expect(launch?.argv).not.toContain("--tools");
    expect(launch?.parent).toBe(sessionId);
    expect(launch?.depth).toBe("0");
  });

  it("delivers prompts larger than the pipe buffer instead of treating back-pressure as a failure", async () => {
    const { env, log } = setup();
    const { sessionId } = await delegate(env, { task: `${"x".repeat(150_000)} [fake:parallel]` });
    await until(() => stateOf(env, sessionId).runs[0]?.status === "completed", WAIT, "run completed");
    const prompt = log().find((line) => line.command?.type === "prompt");
    expect(String(prompt?.command?.["message"]).length).toBeGreaterThanOrEqual(150_000);
  });

  it("reports a steering message as applied only after Pi echoes it into the conversation", async () => {
    const { env, log } = setup();
    const { sessionId } = await delegate(env, { task: "Work carefully [fake:hold]" });
    await until(() => tools(env, sessionId).length > 0, WAIT, "first tool");

    const result = await env.manager.send(sessionId, { text: "Skip the slow part", author: USER });
    expect(result.kind).toBe("steer");
    await until(
      () => stateOf(env, sessionId).messages.find((m) => m.id === result.messageId)?.delivery.stage === "applied",
      WAIT,
      "steer applied",
    );
    const message = stateOf(env, sessionId).messages.find((m) => m.id === result.messageId)!;
    expect(message.delivery.history.map((h) => h.stage)).toEqual(["recorded", "handed_off", "queued", "applied"]);
    expect(message.delivery.history[2]).toMatchObject({ queuedBy: "harness", reason: "turn_boundary" });
    expect(message.delivery.evidence).toContain("message_start(user)");

    await until(() => stateOf(env, sessionId).runs[0]?.status === "completed", WAIT, "run completed");
    expect(log().filter((l) => l.command?.type === "steer")).toHaveLength(1);
  });

  it("uses weaker, clearly-labelled evidence when the queue drains but the echo never arrives", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Work [fake:slowsteer]" });
    await until(() => tools(env, sessionId).length > 0, WAIT, "first tool");
    const result = await env.manager.send(sessionId, { text: "Please also check b.txt", author: USER });
    await until(() => stateOf(env, sessionId).runs[0]?.status === "completed", WAIT, "run completed");
    const message = stateOf(env, sessionId).messages.find((m) => m.id === result.messageId)!;
    expect(message.delivery.stage).toBe("applied");
    expect(message.delivery.evidence).toContain("no matching user message echo");
  });

  it("cancels cleanly: clears Pi's queue before aborting and reports cancelled, not failed", async () => {
    const { env, log } = setup();
    const { sessionId } = await delegate(env, { task: "Keep polling [fake:long]" });
    await until(() => tools(env, sessionId).length > 1, WAIT, "tools running");

    await env.manager.cancel(sessionId, USER);
    await until(() => stateOf(env, sessionId).runs[0]?.status === "cancelled", WAIT, "run cancelled");

    const state = stateOf(env, sessionId);
    expect(state.runs[0]?.status).toBe("cancelled");
    expect(state.runs[0]?.error).toBeUndefined();
    expect(state.status).toBe("idle");
    const types = log().flatMap((l) => (l.command ? [l.command.type] : []));
    expect(types.indexOf("clear_queue")).toBeGreaterThan(-1);
    expect(types.indexOf("clear_queue")).toBeLessThan(types.indexOf("abort"));
    // 被中止的工具是“已取消”，不是“失败”。
    expect(tools(env, sessionId).some((t) => t.status === "cancelled")).toBe(true);
    expect(tools(env, sessionId).some((t) => t.status === "failed")).toBe(false);

    // 取消之后会话仍可继续使用。
    const next = await env.manager.send(sessionId, { text: "Do something small", author: USER });
    expect(next.kind).toBe("follow_up");
    await until(() => stateOf(env, sessionId).runs[1]?.status === "completed", WAIT, "follow-up run");
  });

  it("does not let a delayed clear_queue reply interrupt the next Pi run", async () => {
    const { env, log } = setup({ FAKE_PI_DELAY_CLEAR_QUEUE: "1" });
    const { sessionId } = await delegate(env, { task: "May finish while cancelling [fake:late-clear]" });
    await until(() => env.hub.summary(sessionId)?.phase === "running", WAIT);
    const cancelling = env.manager.cancel(sessionId, USER);
    await until(() => log().some((line) => line.command?.type === "clear_queue"), WAIT);
    await env.manager.send(sessionId, { text: "Complete the next task", mode: "follow_up", author: USER });
    await cancelling;
    await until(() => stateOf(env, sessionId).runs[1]?.endedAt !== undefined, WAIT);
    expect(stateOf(env, sessionId).runs.map((run) => run.status)).toEqual(["completed", "completed"]);
  });

  it("classifies provider errors and keeps the raw message", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Read a file [fake:error]" });
    await until(() => stateOf(env, sessionId).runs[0]?.status === "failed", WAIT, "run failed");
    const run = stateOf(env, sessionId).runs[0]!;
    expect(run.error).toMatchObject({ code: "rate_limited", retryable: true });
    expect(run.error?.message).toContain("429");
    // 失败的是运行，不是会话：会话仍可继续交代。
    expect(stateOf(env, sessionId).status).toBe("idle");
  });

  it("marks a failing bash command with its exit code", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Run it [fake:fail-bash]" });
    await until(() => stateOf(env, sessionId).runs[0]?.status === "completed", WAIT, "run completed");
    const bash = tools(env, sessionId)[0]!;
    expect(bash.status).toBe("failed");
    expect(bash.exitCode).toBe(3);
    expect(bash.error).toContain("exited with code 3");
  });

  it("fails the run and the session when the Pi process dies mid-run", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Crash [fake:crash]" });
    await until(() => stateOf(env, sessionId).status === "failed", WAIT, "session failed");
    const run = stateOf(env, sessionId).runs[0]!;
    expect(run.status).toBe("failed");
    expect(run.error?.code).toBe("process_exited");
    expect(run.error?.message).toContain("code 3");
  });

  it("cancels extension dialogs instead of hanging, and says so in the timeline", async () => {
    const { env, log } = setup();
    const { sessionId } = await delegate(env, { task: "Ask me [fake:dialog]" });
    await until(() => stateOf(env, sessionId).runs[0]?.status === "completed", WAIT, "run completed");
    const diagnostics = stateOf(env, sessionId).timeline.filter((item) => item.type === "diagnostic");
    expect(diagnostics).toEqual([
      expect.objectContaining({ level: "warn", code: "pi.extension_dialog", message: expect.stringContaining("Allow dangerous command?") }),
    ]);
    const response = log().find((l) => l.command?.type === "extension_ui_response");
    expect(response?.command).toMatchObject({ id: "dlg-1", cancelled: true });
  });

  it("surfaces Pi's own startup error when the model does not exist", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { model: "fake/nonexistent-model" });
    await until(() => stateOf(env, sessionId).status === "failed", WAIT, "session failed");
    const run = stateOf(env, sessionId).runs[0]!;
    expect(run.status).toBe("failed");
    expect(run.error?.code).toBe("model_not_found");
    expect(run.error?.message).toContain('Model "fake/nonexistent-model" not found');
  });

  it("enforces read-only access through Pi's tool allowlist", async () => {
    const { env, log } = setup();
    const { sessionId } = await delegate(env, { access: "read_only" });
    await until(() => stateOf(env, sessionId).runs[0]?.status === "completed", WAIT, "run completed");
    const argv = launchOf(log())?.argv ?? [];
    expect(argv[argv.indexOf("--tools") + 1]).toBe("read,grep,find,ls");
    expect(stateOf(env, sessionId).meta.accessEnforcement?.level).toBe("enforced");
  });

  it("runs with Full Access by default and does not claim a sandbox Pi cannot provide", async () => {
    const { env, log } = setup();
    const { sessionId } = await delegate(env);
    await until(() => stateOf(env, sessionId).runs[0]?.status === "completed", WAIT, "run completed");
    expect(stateOf(env, sessionId).meta.access).toBe("full");
    expect(stateOf(env, sessionId).meta.accessEnforcement?.level).toBe("none");
    expect(launchOf(log())?.argv ?? []).not.toContain("--tools");
  });

  it("forwards requested model and thinking level to Pi", async () => {
    const { env, log } = setup();
    const { sessionId } = await delegate(env, { model: "fake/other-model", effort: "high" });
    await until(() => stateOf(env, sessionId).runs[0]?.status === "completed", WAIT, "run completed");
    const argv = launchOf(log())?.argv ?? [];
    expect(argv[argv.indexOf("--model") + 1]).toBe("fake/other-model");
    expect(argv[argv.indexOf("--thinking") + 1]).toBe("high");
  });
});

describe("Pi adapter probing and resuming", () => {
  it("reports models, default and per-model thinking levels from Pi itself", async () => {
    const { executor } = setup();
    const info = await executor.probe();
    expect(info.status).toBe("ready");
    expect(info.runtime).toBe("native");
    expect(info.defaultModel).toBe("fake/fake-model");
    const fake = info.models.find((m) => m.id === "fake/fake-model");
    // thinkingLevelMap 里 null 的档位不可选；max 只有映射里出现才支持。
    expect(fake?.efforts).toEqual(["off", "low", "high", "max"]);
    expect(fake?.isDefault).toBe(true);
    expect(info.models.find((m) => m.id === "fake/plain")?.efforts).toBeUndefined();
    expect(info.access.read_only?.level).toBe("enforced");
    expect(info.access.full?.level).toBe("none");
    expect(Object.keys(info.access)).toEqual(["read_only", "full"]);
  });

  it("is honest when Pi is not installed", async () => {
    const info = await new PiExecutor({ cli: join(tmpdir(), "definitely-missing", "cli.js") }).probe();
    expect(info.status).toBe("unavailable");
    expect(info.setup).toMatchObject({ code: "pi_not_found", command: "npm install -g @earendil-works/pi-coding-agent" });
  });

  it("reopens a native session by file path and measures usage from the resumed baseline", async () => {
    const { executor, log } = setup({ FAKE_PI_STATS_JUMP: "1000" });
    const emitted: { kind: string; data: unknown; runId?: string }[] = [];
    const controller = new AbortController();
    const meta = testMeta({ harness: "pi", cwd: tmpdir() });
    const session = await executor.open({
      meta,
      resume: { kind: "pi-session", id: "old-session", path: "C:\\sessions\\old.jsonl" },
      emit: (draft) => emitted.push(draft as { kind: string; data: unknown; runId?: string }),
      fatal: () => undefined,
      log: silentLogger,
      signal: controller.signal,
    });
    try {
      const argv = launchOf(log())?.argv ?? [];
      expect(argv[argv.indexOf("--session") + 1]).toBe("C:\\sessions\\old.jsonl");

      await session.startRun({ runId: "run_a", messageId: "msg_a", prompt: "Continue [fake:parallel]", trigger: "task" });
      await until(() => emitted.some((e) => e.kind === "run.completed"), WAIT, "run completed");
      const usage = [...emitted].reverse().find((e) => e.kind === "usage.updated")?.data as { usage: { totalTokens: number } };
      // 累计值里包含恢复前的 3000，本次运行只应该算自己的 320。
      expect(usage.usage.totalTokens).toBe(320);
    } finally {
      controller.abort();
      await session.close();
    }
  });
});
