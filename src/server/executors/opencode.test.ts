import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { toSummary } from "@shared/projection";
import { USER, testMeta } from "@shared/testing";
import { silentLogger } from "../logger";
import { delegatorFor, itemsOf, makeTrackedEnv, shutdownTrackedEnvs, stateOf, until, type TestEnv } from "../testing";
import { HarnessStartError } from "./common";
import { OpenCodeExecutor } from "./opencode";

const FAKE_OC = fileURLToPath(new URL("../../../test/fixtures/fake-opencode.mjs", import.meta.url));
const WAIT = 15_000;
const LEAKED_KEY = "sk-live-SHOULD-NEVER-LEAK-0123456789";
const LEAKED_BEARER = "abcdefgh12345678";

interface LogLine {
  kind: "start" | "request" | "interrupt";
  /** 仅 interrupt：中断到达假服务的那一刻，哪些 shell 进程还活着。 */
  aliveShells?: number[];
  method?: string;
  path?: string;
  body?: Record<string, unknown>;
  argv?: string[];
  cwd?: string;
  parent?: string | null;
  depth?: string | null;
  passwordSet?: boolean;
}

const cleanups: (() => void)[] = [];
afterEach(async () => {
  await shutdownTrackedEnvs();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function setup(extraEnv: NodeJS.ProcessEnv = {}, bin = FAKE_OC) {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-fakeoc-"));
  const files = { log: join(dir, "log.jsonl"), db: join(dir, "db.json"), pids: join(dir, "pids.jsonl") };
  writeFileSync(files.log, "");
  writeFileSync(files.pids, "");
  const executor = new OpenCodeExecutor({
    bin,
    env: { ...process.env, FAKE_OC_LOG: files.log, FAKE_OC_DB: files.db, FAKE_OC_PIDS: files.pids, FAKE_OC_HEARTBEAT_MS: "150", ...extraEnv },
  });
  const lines = (file: string): unknown[] =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  const log = (): LogLine[] => lines(files.log) as LogLine[];
  const requests = (): LogLine[] => log().filter((line) => line.kind === "request");
  const interrupts = (): LogLine[] => log().filter((line) => line.kind === "interrupt");
  const pids = (): { shell: number; grandchild: number }[] => lines(files.pids) as { shell: number; grandchild: number }[];
  // 测试失败时也不留下假工具进程。
  cleanups.push(() => {
    for (const { shell, grandchild } of pids()) for (const pid of [shell, grandchild]) if (alive(pid)) process.kill(pid);
  });
  return { executor, env: makeTrackedEnv([executor]), log, requests, interrupts, pids };
}

const delegate = delegatorFor("opencode");
const tools = (env: TestEnv, sessionId: string) => itemsOf(env, sessionId, "tool");
const diagnostics = (env: TestEnv, sessionId: string) => itemsOf(env, sessionId, "diagnostic");
const completed = (env: TestEnv, sessionId: string, index = 0) => until(() => stateOf(env, sessionId).runs[index]?.status === "completed", WAIT, `run ${index} completed`);
const promptsOf = (requests: LogLine[]) => requests.filter((line) => line.method === "POST" && /\/prompt$/.test(line.path ?? ""));
const questionsOf = (env: TestEnv, sessionId: string) => itemsOf(env, sessionId, "question");
const formReplies = (requests: LogLine[]) => requests.filter((line) => line.method === "POST" && /\/form\/frm_fake1\/reply$/.test(line.path ?? ""));
/** 等到提问落进时间线、还在待回答。 */
const asked = async (env: TestEnv, sessionId: string) => {
  await until(() => questionsOf(env, sessionId).some((question) => question.status === "open"), WAIT, "question asked");
  return questionsOf(env, sessionId)[0]!;
};

describe("OpenCode adapter against a faithful fake server", () => {
  it("maps a tool-using run: tools, file changes, phases, per-run usage, metadata and launch environment", async () => {
    const { env, log, requests } = setup();
    writeFileSync(join(env.cwd, "notes.txt"), "alpha\n");
    const { sessionId, messageId } = await delegate(env, { task: "Do some work [fake:tools]", model: "opencode/fake-free", effort: "high" });
    await completed(env, sessionId);

    const state = stateOf(env, sessionId);
    const summary = toSummary(state);
    expect(state.meta.model).toMatchObject({ resolved: "opencode/fake-free", label: "Fake fake-free", provider: "opencode" });
    expect(state.meta.effort).toBe("high");
    expect(state.meta.nativeRef).toEqual({ kind: "opencode-session", id: "ses_fake1" });
    expect(state.meta.accessEnforcement?.level).toBe("none");

    const items = tools(env, sessionId);
    expect(items.map((t) => [t.name, t.category, t.status, t.title])).toEqual([
      ["read", "read", "completed", "notes.txt"],
      ["write", "write", "completed", "out.txt"],
      ["edit", "edit", "completed", "notes.txt"],
      ["read", "read", "failed", "missing.txt"],
      ["shell", "shell", "completed", "echo done"],
    ]);
    expect(items[3]?.error).toBe("File not found: missing.txt");
    expect(items[4]?.exitCode).toBe(0);

    // 文件变更只取 OpenCode 明确上报的：write 看回执里的 Created，edit 看结果元数据；shell 里的改动不猜。
    expect(items[1]?.files).toEqual([{ path: "out.txt", change: "created", addedLines: 2 }]);
    expect(items[2]?.files?.[0]).toMatchObject({ path: "notes.txt", change: "modified", addedLines: 1, removedLines: 1 });
    expect(items[4]?.files ?? []).toEqual([]);
    expect(summary.counters.files).toBe(2);

    const answers = state.timeline.filter((item) => item.type === "assistant");
    expect(answers.map((a) => (a.type === "assistant" ? [a.text, a.phase] : []))).toEqual([["Done: Do some work", "final"]]);

    // OpenCode 的 input 不含缓存、reasoning 与 output 分开；Ensemble 的口径：输入含缓存，输出含推理。两个 step：
    // 输入 (100 + 50) × 2 = 300，输出 (10 + 5) × 2 = 30，缓存 100 ⊂ 输入，推理 10 ⊂ 输出，总量 330。
    expect(summary.usage).toMatchObject({ inputTokens: 300, outputTokens: 30, cachedTokens: 100, reasoningTokens: 10, totalTokens: 330, costUsd: 0.002, contextTokens: 150, contextWindow: 100000 });

    const task = state.messages.find((m) => m.id === messageId);
    expect(task?.delivery.history.map((h) => h.stage)).toContain("handed_off");

    // 会话在创建时就带着会话级权限、模型与档位；不碰用户的 opencode.json；标题先于第一次提示设好。
    const sent = requests();
    const created = sent.find((r) => r.method === "POST" && r.path === "/api/session");
    expect(created?.body).toMatchObject({
      location: { directory: env.cwd },
      model: { id: "fake-free", providerID: "opencode", variant: "high" },
      permissions: [
        { action: "*", resource: "*", effect: "allow" },
        { action: "question", resource: "*", effect: "allow" },
      ],
      metadata: { source: "ensemble", ensembleSession: sessionId },
    });
    const paths = sent.map((r) => `${r.method} ${r.path}`);
    expect(paths.indexOf("PATCH /api/session/ses_fake1")).toBeGreaterThan(paths.indexOf("POST /api/session"));
    expect(paths.indexOf("PATCH /api/session/ses_fake1")).toBeLessThan(paths.indexOf("POST /api/session/ses_fake1/prompt"));
    expect(sent.find((r) => r.method === "PATCH")?.body).toEqual({ title: expect.stringContaining("Do some work") });

    // 私有服务：环回地址、端口由系统分配、随机密码；嵌套委派的环境变量写进进程环境。
    const launch = log().filter((l) => l.kind === "start").find((l) => l.cwd === env.cwd);
    expect(launch).toMatchObject({ passwordSet: true, parent: sessionId, depth: "0" });
    expect(launch?.argv).toEqual(["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"]);
  });

  it("streams reasoning and text, and marks a no-tool final step as the final answer", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Just answer" });
    await completed(env, sessionId);
    const state = stateOf(env, sessionId);
    const reasoning = state.timeline.filter((item) => item.type === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]).toMatchObject({ type: "reasoning", text: "Thinking about it.", streaming: false });
    const answer = state.timeline.find((item) => item.type === "assistant");
    expect(answer).toMatchObject({ text: "Working on it.", phase: "final" });
    expect(state.runs[0]).toMatchObject({ status: "completed", stopReason: "stop" });
  });

  it("runs the second turn in the same native session", async () => {
    const { env, requests } = setup();
    const { sessionId } = await delegate(env, { task: "First" });
    await completed(env, sessionId);
    const next = await env.manager.send(sessionId, { text: "Second", author: USER });
    expect(next.kind).toBe("follow_up");
    await completed(env, sessionId, 1);
    expect(requests().filter((r) => r.method === "POST" && r.path === "/api/session")).toHaveLength(1);
    expect(promptsOf(requests()).map((r) => r.path)).toEqual(["/api/session/ses_fake1/prompt", "/api/session/ses_fake1/prompt"]);
    expect(stateOf(env, sessionId).runs.map((run) => run.status)).toEqual(["completed", "completed"]);
  });

  it("reports a steering message as applied only after OpenCode takes it from the inbox", async () => {
    const { env, requests } = setup({ FAKE_OC_HOLD_MS: "900" });
    const { sessionId } = await delegate(env, { task: "Work carefully [fake:hold]" });
    await until(() => tools(env, sessionId).some((t) => t.status === "running"), WAIT, "slow tool running");

    const result = await env.manager.send(sessionId, { text: "Skip the slow part", author: USER });
    expect(result.kind).toBe("steer");
    await until(() => stateOf(env, sessionId).messages.find((m) => m.id === result.messageId)?.delivery.stage === "applied", WAIT, "steer applied");

    const message = stateOf(env, sessionId).messages.find((m) => m.id === result.messageId)!;
    expect(message.delivery.history.map((h) => h.stage)).toEqual(["recorded", "handed_off", "queued", "applied"]);
    expect(message.delivery.history[2]).toMatchObject({ queuedBy: "harness", reason: "turn_boundary" });
    expect(message.delivery.history[1]?.evidence).toContain("delivery=steer");
    expect(message.delivery.evidence).toContain("session.inbox.delivered");

    await completed(env, sessionId);
    // 纠偏真的进了模型的上下文，而不只是回执：最终回答里能看到它。
    expect(stateOf(env, sessionId).timeline.some((item) => item.type === "assistant" && item.text.includes("Skip the slow part"))).toBe(true);
    const steers = promptsOf(requests()).filter((r) => r.body?.["delivery"] === "steer" && r.body["text"] === "Skip the slow part");
    expect(steers).toHaveLength(1);
  });

  it("fails a steering message the run never consumed and removes it from the inbox so it cannot leak into the next run", async () => {
    const { env, requests } = setup({ FAKE_OC_HOLD_MS: "500" });
    const { sessionId } = await delegate(env, { task: "Work [fake:hold] [fake:nodrain]" });
    await until(() => tools(env, sessionId).some((t) => t.status === "running"), WAIT, "slow tool running");
    const result = await env.manager.send(sessionId, { text: "Too late to matter", author: USER });
    await completed(env, sessionId);
    await until(() => stateOf(env, sessionId).messages.find((m) => m.id === result.messageId)?.delivery.stage === "failed", WAIT, "steer failed");
    const message = stateOf(env, sessionId).messages.find((m) => m.id === result.messageId)!;
    expect(message.delivery.history.at(-1)?.error?.code).toBe("run_ended");
    await until(() => requests().some((r) => r.method === "DELETE" && /\/inbox\//.test(r.path ?? "")), WAIT, "inbox entry deleted");
  });

  it("cancels by killing the tool's whole process tree first, reports cancelled (not failed), and keeps the session usable", async () => {
    const { env, requests, interrupts, pids } = setup();
    const { sessionId } = await delegate(env, { task: "Keep going [fake:long]" });
    await until(() => pids().length > 0 && pids()[0]!.grandchild > 0, WAIT, "shell and grandchild started");
    const { shell, grandchild } = pids()[0]!;
    expect(alive(shell) && alive(grandchild)).toBe(true);

    await env.manager.cancel(sessionId, USER);
    // 先等运行有个结局、再断言它是“已取消”：失败时能直接看到真实的结局（例如模型抢先走完了下一步 = completed），而不是一句超时。
    await until(() => ["cancelled", "completed", "failed"].includes(stateOf(env, sessionId).runs[0]?.status ?? ""), WAIT, "run ended");
    expect(stateOf(env, sessionId).runs[0]?.status).toBe("cancelled");

    const state = stateOf(env, sessionId);
    expect(state.runs[0]?.error).toBeUndefined();
    expect(state.status).toBe("idle");
    expect(tools(env, sessionId).map((t) => t.status)).toEqual(["cancelled"]);
    // 假 OpenCode 和真实的一样，自己的中断只杀 shell 本身；孙进程能被清掉，说明适配器先按 pid 杀了整棵进程树。
    await until(() => !alive(shell) && !alive(grandchild), 8_000, "no orphaned tool processes");
    expect(requests().some((r) => r.method === "POST" && r.path === "/api/session/ses_fake1/interrupt?resume=false")).toBe(true);
    // 顺序是要害：中断到达时 shell 进程已经被杀掉。中断先到的话 OpenCode 只会杀 shell 本身，孙进程就找不到父进程、成了孤儿。
    expect(interrupts()).toHaveLength(1);
    expect(interrupts()[0]?.aliveShells).toEqual([]);

    // 取消之后同一个原生会话还能继续。
    const next = await env.manager.send(sessionId, { text: "Something small", author: USER });
    expect(next.kind).toBe("follow_up");
    await completed(env, sessionId, 1);
    expect(promptsOf(requests()).every((r) => r.path === "/api/session/ses_fake1/prompt")).toBe(true);
  });

  it("finds a tool the event stream has not shown yet through the server's own shell list, and still cleans up its whole process tree", async () => {
    const { env, requests, interrupts, pids } = setup();
    const { sessionId } = await delegate(env, { task: "Keep going [fake:long][fake:hidden]" });
    await until(() => pids().length > 0 && pids()[0]!.grandchild > 0, WAIT, "hidden shell and grandchild started");
    const { shell, grandchild } = pids()[0]!;

    await env.manager.cancel(sessionId, USER);
    await until(() => stateOf(env, sessionId).runs[0]?.status === "cancelled", WAIT, "run cancelled");

    expect(requests().some((r) => r.method === "GET" && r.path === "/api/shell")).toBe(true);
    expect(interrupts()[0]?.aliveShells).toEqual([]);
    await until(() => !alive(shell) && !alive(grandchild), 8_000, "no orphaned tool processes");
  });

  it("withdraws an undelivered steering message when cancelling, so it does not leak into the next run", async () => {
    const { env, requests } = setup();
    const { sessionId } = await delegate(env, { task: "Keep going [fake:long]" });
    await until(() => tools(env, sessionId).some((t) => t.status === "running"), WAIT, "long tool running");
    const steer = await env.manager.send(sessionId, { text: "STALE-STEER", author: USER });
    await until(() => requests().some((r) => r.body?.["delivery"] === "steer"), WAIT, "steer posted");
    await env.manager.cancel(sessionId, USER);
    await until(() => stateOf(env, sessionId).runs[0]?.status === "cancelled", WAIT, "run cancelled");

    await until(() => stateOf(env, sessionId).messages.find((m) => m.id === steer.messageId)?.delivery.stage === "cancelled", WAIT, "steer cancelled");
    expect(requests().some((r) => r.method === "DELETE" && /\/inbox\//.test(r.path ?? ""))).toBe(true);

    await env.manager.send(sessionId, { text: "Fresh task", author: USER });
    await completed(env, sessionId, 1);
    const answers = itemsOf(env, sessionId, "assistant").map((a) => a.text);
    expect(answers.some((text) => text.includes("STALE-STEER"))).toBe(false);
  });

  it("classifies the asynchronous provider failure for a model OpenCode cannot route", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Hello", model: "opencode/nonexistent" });
    await until(() => stateOf(env, sessionId).runs[0]?.status === "failed", WAIT, "run failed");
    expect(stateOf(env, sessionId).runs[0]?.error).toMatchObject({ code: "model_not_found", message: expect.stringContaining("Model unavailable: opencode/nonexistent") });
    expect(stateOf(env, sessionId).status).toBe("idle");
  });

  it("explains an unknown variant as an invalid request", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Hello", model: "opencode/fake-free", effort: "extreme" });
    await until(() => stateOf(env, sessionId).runs[0]?.status === "failed", WAIT, "run failed");
    expect(stateOf(env, sessionId).runs[0]?.error).toMatchObject({ code: "invalid_request", message: expect.stringContaining("variant") });
  });

  it("classifies rate limits as retryable and never lets credential-looking text from the provider response through", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Hello [fake:ratelimit]" });
    await until(() => stateOf(env, sessionId).runs[0]?.status === "failed", WAIT, "run failed");
    const run = stateOf(env, sessionId).runs[0]!;
    expect(run.error).toMatchObject({ code: "rate_limited", retryable: true, message: expect.stringContaining("Rate limited") });
    const retry = diagnostics(env, sessionId).find((d) => d.code === "opencode.retry");
    expect(retry).toMatchObject({ level: "warn", message: expect.stringContaining("attempt 1") });
    expect(JSON.stringify([run, diagnostics(env, sessionId)])).not.toContain(LEAKED_BEARER);
  });

  it("fails the run and the session when the OpenCode server dies mid-run", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Crash [fake:crash]" });
    await until(() => stateOf(env, sessionId).status === "failed", WAIT, "session failed");
    expect(stateOf(env, sessionId).runs[0]).toMatchObject({ status: "failed", error: { code: "process_exited", message: expect.stringContaining("code 3") } });
    // 退出前 stderr 里那行带密钥形态的文字要出现在原始错误文本里（让人看得出出了什么事），但只能是脱敏后的样子。
    const detail = stateOf(env, sessionId).runs[0]?.error?.detail;
    expect(detail).toContain("Bearer ***");
    expect(detail).not.toContain(LEAKED_BEARER);
  });

  it("fails the session when the event stream is lost while the server is still up", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Drop [fake:dropsse]" });
    await until(() => stateOf(env, sessionId).status === "failed", WAIT, "session failed");
    expect(stateOf(env, sessionId).runs[0]?.error).toMatchObject({ code: "process_exited", message: expect.stringContaining("event stream") });
  });

  it("allows a stray permission request under Full Access, says so, and never leaves the run waiting", async () => {
    const { env, requests } = setup();
    const { sessionId } = await delegate(env, { task: "Read the env file [fake:perm]" });
    await completed(env, sessionId);
    const reply = requests().find((r) => /\/permission\/per_fake1\/reply$/.test(r.path ?? ""));
    expect(reply?.body).toEqual({ decision: "once" });
    expect(diagnostics(env, sessionId)).toEqual([expect.objectContaining({ level: "info", code: "opencode.permission_allowed", message: expect.stringContaining(".env") })]);
  });

  it("rejects a stray permission request in a read-only session and ends the run with a clear reason", async () => {
    const { env, requests } = setup();
    const { sessionId } = await delegate(env, { task: "Read the env file [fake:perm]", access: "read_only" });
    await until(() => stateOf(env, sessionId).runs[0]?.status === "failed", WAIT, "run failed");
    const created = requests().find((r) => r.method === "POST" && r.path === "/api/session");
    expect(created?.body?.["permissions"]).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "glob", resource: "*", effect: "allow" },
      { action: "grep", resource: "*", effect: "allow" },
      { action: "question", resource: "*", effect: "allow" },
    ]);
    expect(requests().find((r) => /\/permission\/per_fake1\/reply$/.test(r.path ?? ""))?.body).toEqual({ decision: "reject" });
    expect(stateOf(env, sessionId).runs[0]?.error).toMatchObject({ code: "opencode.permission_rejected" });
    expect(stateOf(env, sessionId).meta.accessEnforcement?.level).toBe("enforced");
    expect(tools(env, sessionId).map((t) => t.status)).toEqual(["cancelled"]);
  });

  it("keeps cancelling a form that is not a question, and ends the run with a clear reason", async () => {
    const { env, requests } = setup();
    const { sessionId } = await delegate(env, { task: "Show me a form [fake:formother]" });
    await until(() => stateOf(env, sessionId).runs[0]?.status === "failed", WAIT, "run failed");
    // 不是提问的表单没有“回答”可言：不带说明地撤回，OpenCode 因此中止整次执行（老办法，一个字没改）。
    expect(requests().some((r) => r.method === "DELETE" && r.path === "/api/session/ses_fake1/form/frm_fake1")).toBe(true);
    expect(stateOf(env, sessionId).runs[0]?.error).toMatchObject({ code: "opencode.question_unanswered" });
    expect(diagnostics(env, sessionId)).toEqual([expect.objectContaining({ level: "warn", code: "opencode.question_unanswered" })]);
    expect(itemsOf(env, sessionId, "question")).toEqual([]);
  });

  it("withdraws a question it cannot read with an explanation, so the model assumes and the run goes on", async () => {
    const { env, requests } = setup();
    const { sessionId } = await delegate(env, { task: "Ask me something [fake:form]" });
    await completed(env, sessionId);
    const withdrawn = requests().find((r) => r.method === "DELETE" && r.path?.startsWith("/api/session/ses_fake1/form/frm_fake1"));
    expect(decodeURIComponent(withdrawn?.path ?? "")).toContain("?message=Ensemble could not relay this question");
    expect(stateOf(env, sessionId).runs[0]?.error).toBeUndefined();
    expect(diagnostics(env, sessionId)).toEqual([expect.objectContaining({ level: "warn", code: "opencode.question_unanswered" })]);
    expect(itemsOf(env, sessionId, "question")).toEqual([]);
    expect(tools(env, sessionId)[0]).toMatchObject({ name: "question", status: "failed", error: expect.stringContaining("could not relay") });
  });

  // ── 业务提问（不是权限）：转给发起方，等回答 ──

  it("asks the delegator, keeps the run waiting, and hands the answer back with labels turned into OpenCode's values", async () => {
    const { env, requests } = setup();
    const { sessionId } = await delegate(env, { task: "Pick a color [fake:ask]" });
    const question = await asked(env, sessionId);

    // 字段原样呈现；提问期间运行没有结束，会话也没有因此换成别的阶段。
    expect(question.prompts).toEqual([
      { key: "q0", header: "Color", text: "Which color should I use?", options: [{ label: "Red", description: "A warm color" }, { label: "Blue" }], multiple: false, custom: true },
      { key: "q1", header: "Extras", text: "Which extras do you want?", options: [{ label: "Alpha" }, { label: "Beta" }], multiple: true, custom: false },
    ]);
    expect(stateOf(env, sessionId).runs[0]?.status).toBe("running");
    expect(toSummary(stateOf(env, sessionId)).openQuestions).toBe(1);
    expect(formReplies(requests())).toEqual([]);

    const resolved = await env.manager.answerQuestion(sessionId, question.questionId, { answers: ["red", ["Alpha", "beta"]] }, USER);
    expect(resolved).toMatchObject({ status: "answered", outcome: { by: USER, delivery: "handed_off", answers: [["Red"], ["Alpha", "Beta"]] } });
    // 展示用的标签换回 OpenCode 的 value；选项以外的自由文字（q0 允许自己写）则原样交回。
    expect(formReplies(requests())[0]?.body).toEqual({ answer: { q0: "red", q1: ["a", "b"] } });

    await completed(env, sessionId);
    expect(tools(env, sessionId)[0]?.output?.text).toBe('Answered: {"q0":"red","q1":["a","b"]}');
    expect(questionsOf(env, sessionId)[0]).toMatchObject({ status: "answered" });
    expect(toSummary(stateOf(env, sessionId)).openQuestions).toBeUndefined();
  });

  it("hands over free text the question allows, exactly as written", async () => {
    const { env, requests } = setup();
    const { sessionId } = await delegate(env, { task: "Pick a color [fake:ask]" });
    const question = await asked(env, sessionId);
    await env.manager.answerQuestion(sessionId, question.questionId, { answers: ["Teal, please", "Alpha"] }, USER);
    expect(formReplies(requests())[0]?.body).toEqual({ answer: { q0: "Teal, please", q1: ["a"] } });
    await completed(env, sessionId);
  });

  it("declining withdraws the form with an explanation: the model decides for itself and the run goes on", async () => {
    const { env, requests } = setup();
    const { sessionId } = await delegate(env, { task: "Pick a color [fake:ask]" });
    const question = await asked(env, sessionId);

    const resolved = await env.manager.declineQuestion(sessionId, question.questionId, "Either is fine", USER);
    expect(resolved).toMatchObject({ status: "declined", outcome: { by: USER, delivery: "handed_off" } });
    const withdrawn = requests().find((r) => r.method === "DELETE" && r.path?.startsWith("/api/session/ses_fake1/form/frm_fake1"));
    expect(decodeURIComponent(withdrawn?.path ?? "")).toContain("?message=Whoever delegated this task chose not to answer this question");
    expect(decodeURIComponent(withdrawn?.path ?? "")).toContain("Either is fine");

    await completed(env, sessionId);
    expect(stateOf(env, sessionId).runs[0]?.error).toBeUndefined();
    expect(questionsOf(env, sessionId)[0]).toMatchObject({ status: "declined" });
  });

  it("cancelling the run while a question is open records the question as expired (cancelled), not as answered", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Pick a color [fake:ask]" });
    const question = await asked(env, sessionId);
    await env.manager.cancel(sessionId, USER);
    await until(() => stateOf(env, sessionId).runs[0]?.status === "cancelled", WAIT, "run cancelled");
    expect(questionsOf(env, sessionId)[0]).toMatchObject({ status: "expired", outcome: { by: { kind: "system" }, reason: "cancelled" } });
    // 已经没有人在等：再回答是 409，并说清楚为什么，而不是悄悄成功。
    await expect(env.manager.answerQuestion(sessionId, question.questionId, { answers: ["Red", "Alpha"] }, USER)).rejects.toMatchObject({ code: "conflict" });
  });

  it("answers a permission request on the spot even though questions are now relayed: it never becomes a question", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Read the env file [fake:perm]" });
    await completed(env, sessionId);
    expect(questionsOf(env, sessionId)).toEqual([]);
    expect(toSummary(stateOf(env, sessionId)).openQuestions).toBeUndefined();
  });

  it("ignores events that belong to other sessions (sub-agents) on the same server", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Work [fake:child]" });
    await completed(env, sessionId);
    expect(tools(env, sessionId)).toEqual([]);
    expect(JSON.stringify(stateOf(env, sessionId).timeline)).not.toContain("child secret chatter");
  });

  it("surfaces compaction and counts side-call usage recorded during the run", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Long work [fake:compact]" });
    await completed(env, sessionId);
    expect(diagnostics(env, sessionId).map((d) => [d.level, d.code])).toEqual([
      ["info", "opencode.compaction"],
      ["warn", "opencode.compaction_failed"],
    ]);
    // 一个 step 的 (100 + 50) 加上压缩旁路调用的 200 输入。
    expect(toSummary(stateOf(env, sessionId)).usage).toMatchObject({ inputTokens: 350, outputTokens: 35 });
  });

  it("rejects model names that are not provider/model", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Hello", model: "noslash" });
    await until(() => stateOf(env, sessionId).status === "failed", WAIT, "session failed");
    expect(stateOf(env, sessionId).runs[0]?.error?.code).toBe("invalid_request");
  });
});

describe("OpenCode adapter probing", () => {
  it("lists only usable chat models with their real variants and never copies provider settings", async () => {
    const { executor } = setup();
    const info = await executor.probe();
    expect(info).toMatchObject({ id: "opencode", status: "ready", runtime: "native", version: "2.3.0", defaultModel: "opencode/fake-free" });
    expect(info.models).toEqual([
      { id: "opencode/fake-free", label: "Fake fake-free", provider: "opencode", efforts: ["low", "high"], isDefault: true, contextWindow: 100000 },
      { id: "anthropic/fake-pro", label: "Fake fake-pro", provider: "anthropic", contextWindow: 100000 },
    ]);
    expect(JSON.stringify(info)).not.toContain(LEAKED_KEY);
    expect(info.access.read_only).toMatchObject({ level: "enforced" });
    expect(info.access.full?.level).toBe("none");
    expect(Object.keys(info.access)).toEqual(["read_only", "full"]);
    expect(info.capabilities.plan.support).toBe("no");
    expect(info.capabilities.steer).toMatchObject({ support: "yes", mode: "turn_boundary" });
  });

  it("is honest when OpenCode cannot be found", async () => {
    const info = await new OpenCodeExecutor({ bin: join(tmpdir(), "definitely-missing", "opencode.mjs") }).probe();
    expect(info.status).toBe("unavailable");
    expect(info.setup).toMatchObject({ code: "opencode_not_found", message: expect.stringContaining("ENSEMBLE_OPENCODE_BIN") });
  });

  it("refuses an OpenCode that is too old and says which version it found", async () => {
    const { executor } = setup({ FAKE_OC_VERSION: "1.14.2" });
    const info = await executor.probe();
    expect(info).toMatchObject({ status: "unavailable", version: "1.14.2", setup: { code: "opencode_unsupported", command: "npm install -g @opencode/cli" } });
  });

  it("asks the user to connect a provider when OpenCode has no usable models", async () => {
    const { executor } = setup({ FAKE_OC_MODE: "nomodels" });
    const info = await executor.probe();
    expect(info).toMatchObject({ status: "needs_setup", models: [], setup: { code: "opencode_no_models", command: "opencode auth login" } });
  });

  it("reports a server that exits during startup as unavailable, without echoing what it wrote to stderr", async () => {
    const { executor } = setup({ FAKE_OC_MODE: "badstart" });
    const info = await executor.probe();
    expect(info.status).toBe("unavailable");
    expect(info.setup).toMatchObject({ code: "opencode_probe_failed", message: expect.stringContaining("exited during startup") });
    expect(JSON.stringify(info)).not.toContain(LEAKED_BEARER);
  });

  it("explains a failed model catalog request with the first line OpenCode wrote to stderr, redacted", async () => {
    const { executor } = setup({ FAKE_OC_MODE: "catalogfail" });
    const info = await executor.probe();
    expect(info.status).toBe("unavailable");
    expect(info.setup?.code).toBe("opencode_probe_failed");
    expect(info.setup?.message).toContain("Bearer ***");
    expect(JSON.stringify(info)).not.toContain(LEAKED_BEARER);
  });

  it("refuses to send its credentials to a server that announces a non-loopback address", async () => {
    const { executor } = setup({ FAKE_OC_MODE: "nonloopback" });
    const info = await executor.probe();
    expect(info.status).toBe("unavailable");
    expect(info.setup?.message).toContain("non-loopback");
  });
});

describe("OpenCode adapter lifecycle", () => {
  const openInput = (executor: OpenCodeExecutor, extra: Partial<Parameters<OpenCodeExecutor["open"]>[0]> = {}) => {
    const emitted: { kind: string; data: unknown; runId?: string }[] = [];
    const fatals: unknown[] = [];
    const controller = new AbortController();
    const input = {
      meta: testMeta({ harness: "opencode", cwd: tmpdir(), model: { requested: "opencode/fake-free" } }),
      emit: (draft: unknown) => emitted.push(draft as { kind: string; data: unknown; runId?: string }),
      fatal: (error: unknown) => fatals.push(error),
      log: silentLogger,
      signal: controller.signal,
      ...extra,
    } as Parameters<OpenCodeExecutor["open"]>[0];
    return { input, emitted, fatals, controller, executor };
  };

  it("reopens the same native session after a service restart and continues in it", async () => {
    const { executor, requests } = setup();
    const first = openInput(executor);
    const sessionA = await executor.open(first.input);
    expect(sessionA.nativeRef).toEqual({ kind: "opencode-session", id: "ses_fake1" });
    await sessionA.startRun({ runId: "run_a", messageId: "msg_a", prompt: "Remember pineapple", trigger: "task" });
    await until(() => first.emitted.some((e) => e.kind === "run.completed"), WAIT, "first run completed");
    first.controller.abort();
    await sessionA.close();

    const second = openInput(executor, { resume: sessionA.nativeRef! });
    const sessionB = await executor.open(second.input);
    try {
      expect(sessionB.nativeRef).toEqual({ kind: "opencode-session", id: "ses_fake1" });
      await sessionB.startRun({ runId: "run_b", messageId: "msg_b", prompt: "What was it?", trigger: "follow_up" });
      await until(() => second.emitted.some((e) => e.kind === "run.completed"), WAIT, "resumed run completed");
    } finally {
      second.controller.abort();
      await sessionB.close();
    }
    const sent = requests();
    expect(sent.filter((r) => r.method === "POST" && r.path === "/api/session")).toHaveLength(1);
    expect(sent.some((r) => r.method === "GET" && r.path === "/api/session/ses_fake1")).toBe(true);
    expect(promptsOf(sent).map((r) => r.path)).toEqual(["/api/session/ses_fake1/prompt", "/api/session/ses_fake1/prompt"]);
    // 恢复不重新设标题，也不重新指定模型与权限：它们留在 OpenCode 的会话里。
    expect(sent.filter((r) => r.method === "PATCH")).toHaveLength(1);
  });

  it("says the session cannot be resumed when OpenCode no longer has it or the reference is wrong", async () => {
    const { executor } = setup();
    const missing = openInput(executor, { resume: { kind: "opencode-session", id: "ses_gone" } });
    await expect(executor.open(missing.input)).rejects.toMatchObject({ code: "session_not_resumable" });
    const wrongKind = openInput(executor, { resume: { kind: "pi-session", id: "ses_fake1" } });
    await expect(executor.open(wrongKind.input)).rejects.toBeInstanceOf(HarnessStartError);
    const badId = openInput(executor, { resume: { kind: "opencode-session", id: "../etc/passwd" } });
    await expect(executor.open(badId.input)).rejects.toMatchObject({ code: "session_not_resumable" });
  });

  it("stops the run and kills running tool processes when the session closes, because the server exiting takes neither along", async () => {
    const { executor, pids, interrupts } = setup();
    const { input, emitted, controller } = openInput(executor);
    const session = await executor.open(input);
    await session.startRun({ runId: "run_a", messageId: "msg_a", prompt: "Keep going [fake:long]", trigger: "task" });
    await until(() => pids().length > 0 && pids()[0]!.grandchild > 0 && emitted.some((e) => e.kind === "run.started"), WAIT, "tool running");
    const { shell, grandchild } = pids()[0]!;
    controller.abort();
    await session.close();
    await until(() => !alive(shell) && !alive(grandchild), 8_000, "tool processes gone after close");
    // 先杀树再中断：中断让 OpenCode 干净地记下这次执行的结局（之后恢复会话时状态一致），也不让模型在 shell 被杀后抢先开新的 shell。
    expect(interrupts()).toHaveLength(1);
    expect(interrupts()[0]?.aliveShells).toEqual([]);
  });

  it("also cleans up tool processes it never saw an event for when the session closes", async () => {
    const { executor, pids } = setup();
    const { input, controller } = openInput(executor);
    const session = await executor.open(input);
    await session.startRun({ runId: "run_a", messageId: "msg_a", prompt: "Keep going [fake:long][fake:hidden]", trigger: "task" });
    await until(() => pids().length > 0 && pids()[0]!.grandchild > 0, WAIT, "hidden tool running");
    const { shell, grandchild } = pids()[0]!;
    controller.abort();
    await session.close();
    await until(() => !alive(shell) && !alive(grandchild), 8_000, "tool processes gone after close");
  });

  it("closing an idle session sends no interrupt, because there is nothing to stop", async () => {
    const { executor, interrupts } = setup();
    const { input, emitted, controller } = openInput(executor);
    const session = await executor.open(input);
    await session.startRun({ runId: "run_a", messageId: "msg_a", prompt: "Say hi", trigger: "task" });
    await until(() => emitted.some((e) => e.kind === "run.completed"), WAIT, "run completed");
    controller.abort();
    await session.close();
    expect(interrupts()).toEqual([]);
  });

  it("keeps credential-looking stderr out of a start failure while still showing what went wrong", async () => {
    const { executor } = setup({ FAKE_OC_MODE: "badstart" });
    const error = await executor.open(openInput(executor).input).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(HarnessStartError);
    const { message, detail } = error as HarnessStartError;
    expect(detail).toContain("cannot open database");
    expect(detail).toContain("Bearer ***");
    expect(`${message}\n${detail}`).not.toContain(LEAKED_BEARER);
  });
});
