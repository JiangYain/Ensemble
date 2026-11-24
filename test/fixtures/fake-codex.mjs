#!/usr/bin/env node
// 假 Codex app-server：消息形状取自 Codex 0.151.0（Windows 11）的真实抓包，用于确定性测试。
// 场景由提示词里的标记选择：`[fake:basic|plan|approval|fileapproval|permissions|question|questions|secret|nonblocking|elicit|hold|long|fast|error|modelerror|crash|nophase|silent|reasoning2|bigoutput|mcp|mcpfail|websearch|stray]`，默认 basic。
// 环境变量：
//   FAKE_CODEX_LOG          把启动参数与收到的每条客户端消息写成 JSONL
//   FAKE_CODEX_ACCOUNT      none → 未登录
//   FAKE_CODEX_MODELS       none → 模型目录为空
//   FAKE_CODEX_CONFIG_MODEL 用户配置里的默认模型
//   FAKE_CODEX_SANDBOX      windowsSandbox/readiness 的状态（默认 ready）
//   FAKE_CODEX_OS           initialize 报告的 platformOs（默认随真实系统）
//   FAKE_CODEX_SANDBOX_TYPE 强制 thread/start 响应里的 sandbox.type（用来模拟“实际沙箱与请求不一致”）
//   FAKE_CODEX_RESUME_TOTAL 被恢复线程已经累计的 token 总数
//   FAKE_CODEX_STEER_REJECT 让 turn/steer 以 -32600（前置条件不满足）失败
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const logFile = process.env.FAKE_CODEX_LOG;
const log = (record) => {
  if (logFile) appendFileSync(logFile, `${JSON.stringify(record)}\n`);
};

if (args.includes("--version")) {
  console.log("codex-cli 9.9.9");
  process.exit(0);
}
if (args[0] !== "app-server") {
  console.error(`fake codex: unsupported arguments ${args.join(" ")}`);
  process.exit(2);
}

log({ argv: args, cwd: process.cwd(), parent: process.env.ENSEMBLE_PARENT_SESSION ?? null, depth: process.env.ENSEMBLE_PARENT_DEPTH ?? null });

const MODELS = [
  {
    id: "fake-default",
    model: "fake-default",
    displayName: "Fake Default",
    description: "",
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "" },
      { reasoningEffort: "medium", description: "" },
      { reasoningEffort: "high", description: "" },
    ],
  },
  {
    id: "fake-mini",
    model: "fake-mini",
    displayName: "Fake Mini",
    description: "",
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }],
  },
];

const SANDBOXES = {
  "read-only": { type: "readOnly", networkAccess: false },
  "workspace-write": { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  "danger-full-access": { type: "dangerFullAccess" },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });

// ───────────────────────── 状态 ─────────────────────────

let threadSeq = 0;
let turnSeq = 0;
let requestSeq = 0;
let toolSeq = 0;
const threads = new Map();
let active; // { id, threadId, interrupted, steers, marker }
const waiters = new Map();

// ───────────────────────── 入口 ─────────────────────────

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
    const line = buffer.slice(0, index).replace(/\r$/, "");
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(message) {
  if (message.method && message.id !== undefined) {
    log({ request: { method: message.method, params: message.params } });
    onRequest(message.id, message.method, message.params ?? {});
  } else if (message.method) {
    log({ notification: { method: message.method, params: message.params } });
  } else {
    log({ response: message });
    waiters.get(message.id)?.(message);
  }
}

const reply = (id, result) => send({ id, result });
const fail = (id, code, text) => send({ id, error: { code, message: text } });

function onRequest(id, method, params) {
  switch (method) {
    case "initialize":
      return reply(id, {
        userAgent: "fake-codex/9.9.9",
        codexHome: join(tmpdir(), "fake-codex-home"),
        platformFamily: process.platform === "win32" ? "windows" : "unix",
        platformOs: process.env.FAKE_CODEX_OS ?? (process.platform === "win32" ? "windows" : process.platform),
      });
    case "account/read":
      return reply(
        id,
        process.env.FAKE_CODEX_ACCOUNT === "none"
          ? { account: null, requiresOpenaiAuth: true }
          : { account: { type: "chatgpt", email: "dev@example.com", planType: "plus" }, requiresOpenaiAuth: true },
      );
    case "model/list":
      return reply(id, { data: process.env.FAKE_CODEX_MODELS === "none" ? [] : MODELS, nextCursor: null });
    case "config/read":
      return reply(id, { config: { model: process.env.FAKE_CODEX_CONFIG_MODEL ?? null }, origins: {}, layers: null });
    case "windowsSandbox/readiness":
      return reply(id, { status: process.env.FAKE_CODEX_SANDBOX ?? "ready" });
    case "thread/start":
      return startThread(id, params, false);
    case "thread/resume":
      return startThread(id, params, true);
    case "thread/name/set":
      return reply(id, {});
    case "turn/start":
      return startTurn(id, params);
    case "turn/steer":
      return steerTurn(id, params);
    case "turn/interrupt":
      return interruptTurn(id, params);
    default:
      return fail(id, -32601, `fake codex does not implement ${method}`);
  }
}

function startThread(id, params, resuming) {
  let threadId;
  if (resuming) {
    threadId = params.threadId;
    if (!String(threadId).startsWith("thr-fake-")) return fail(id, -32600, `no rollout found for thread id ${threadId}`);
  } else {
    threadId = `thr-fake-${++threadSeq}`;
  }
  const total = resuming ? Number(process.env.FAKE_CODEX_RESUME_TOTAL ?? 0) : 0;
  threads.set(threadId, {
    id: threadId,
    cwd: params.cwd,
    model: params.model ?? process.env.FAKE_CODEX_CONFIG_MODEL ?? "fake-config-model",
    totals: { inputTokens: total, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: total },
  });
  const thread = threads.get(threadId);
  const sandbox = params.sandbox ?? "workspace-write";
  const sandboxType = process.env.FAKE_CODEX_SANDBOX_TYPE;
  reply(id, {
    thread: { id: threadId, path: join(tmpdir(), `${threadId}.jsonl`), cwd: params.cwd, ephemeral: false, name: null, turns: [] },
    model: thread.model,
    modelProvider: "openai",
    serviceTier: null,
    cwd: params.cwd,
    approvalPolicy: params.approvalPolicy ?? "on-request",
    sandbox: sandboxType ? { ...SANDBOXES[sandbox], type: sandboxType } : SANDBOXES[sandbox],
    reasoningEffort: "medium",
  });
  if (!resuming) notify("thread/started", { thread: { id: threadId } });
  notify("warning", { threadId, message: "Under-development features enabled: default_mode_request_user_input. They may behave unpredictably." });
}

// ───────────────────────── 回合 ─────────────────────────

const turnObject = (turn, status, extra = {}) => ({
  id: turn.id,
  items: [],
  itemsView: "notLoaded",
  status,
  error: null,
  startedAt: Math.floor(Date.now() / 1000),
  completedAt: null,
  durationMs: null,
  ...extra,
});

function startTurn(id, params) {
  const thread = threads.get(params.threadId);
  if (!thread) return fail(id, -32600, `thread not found: ${params.threadId}`);
  if (active) return fail(id, -32600, "a turn is already active");
  const prompt = params.input?.[0]?.text ?? "";
  const marker = /\[fake:([\w-]+)\]/.exec(prompt)?.[1] ?? "basic";
  const turn = { id: `turn-fake-${++turnSeq}`, threadId: thread.id, interrupted: false, steers: [], marker, thread, params };
  active = turn;
  reply(id, { turn: turnObject(turn, "inProgress") });
  void runTurn(turn, prompt).catch((error) => {
    console.error("fake codex scenario crashed:", error);
    process.exit(9);
  });
}

function steerTurn(id, params) {
  if (process.env.FAKE_CODEX_STEER_REJECT) return fail(id, -32600, "the active turn is not steerable");
  if (!active) return fail(id, -32600, "no active turn to steer");
  if (params.expectedTurnId !== active.id) {
    return fail(id, -32600, `expected active turn id \`${params.expectedTurnId}\` but found \`${active.id}\``);
  }
  const text = params.input?.[0]?.text ?? "";
  const steer = { clientId: params.clientUserMessageId ?? null, text };
  active.steers.push(steer);
  if (active.marker === "fast") {
    // 响应与回显落在同一个数据块里：适配器必须把“已生效”推迟到“已排队”之后。
    active.steers.pop();
    process.stdout.write(
      `${JSON.stringify({ id, result: { turnId: active.id } })}\n` +
        `${JSON.stringify({ method: "item/started", params: { item: userMessage(steer.clientId, text), threadId: active.threadId, turnId: active.id, startedAtMs: Date.now() } })}\n`,
    );
    active.fastSteered = text;
    return;
  }
  reply(id, { turnId: active.id });
}

function interruptTurn(id, params) {
  if (!active || active.id !== params.turnId) return fail(id, -32600, "no active turn to interrupt");
  active.interrupted = true;
  reply(id, {});
}

// ───────────────────────── 条目构造 ─────────────────────────

const WRAPPER = (cmd) => `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command '${cmd}'`;
const userMessage = (clientId, text) => ({ type: "userMessage", id: `um-${++toolSeq}`, clientId, content: [{ type: "text", text, text_elements: [] }] });
const agentItem = (id, text, phase) => ({ type: "agentMessage", id, text, phase, memoryCitation: null, delivery: null });
const commandItem = (id, cwd, status, cmd, extra = {}) => ({
  type: "commandExecution",
  id,
  pluginId: null,
  scriptPath: null,
  command: WRAPPER(cmd),
  cwd,
  processId: "4242",
  source: "unifiedExecStartup",
  status,
  commandActions: [{ type: "unknown", command: cmd }],
  aggregatedOutput: null,
  exitCode: null,
  durationMs: null,
  ...extra,
});

/** 向客户端提一个业务提问并等回答（回合被中断时 Codex 会先结清请求）；回答之后如实把收到的回复写进最终文字。 */
async function askUser(t, turn, params) {
  const answer = await t.ask("item/tool/requestUserInput", { itemId: "q-1", autoResolutionMs: null, ...params });
  if (turn.interrupted) return t.finish("interrupted");
  await t.say("final_answer", answer?.error ? `Proceeding with an assumption (${answer.error.message.slice(0, 120)})` : `Got an answer: ${JSON.stringify(answer?.result ?? null)}`);
  t.usage();
  t.finish("completed");
}

class Turn {
  constructor(turn) {
    this.turn = turn;
    this.cwd = turn.thread.cwd;
    this.last = { inputTokens: 100, cachedInputTokens: 40, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 4, totalTokens: 110 };
  }
  note(method, params) {
    notify(method, { threadId: this.turn.threadId, turnId: this.turn.id, ...params });
  }
  started(item) {
    this.note("item/started", { item, startedAtMs: Date.now() });
  }
  completed(item) {
    this.note("item/completed", { item, completedAtMs: Date.now() });
  }
  async say(phase, text, id = `msg-${++toolSeq}`) {
    this.started(agentItem(id, "", phase));
    for (const piece of text.match(/.{1,6}/g) ?? []) {
      this.note("item/agentMessage/delta", { itemId: id, delta: piece });
      await sleep(1);
    }
    this.completed(agentItem(id, text, phase));
  }
  usage() {
    const totals = this.turn.thread.totals;
    for (const key of Object.keys(this.last)) totals[key] += this.last[key];
    this.note("thread/tokenUsage/updated", { tokenUsage: { total: { ...totals }, last: { ...this.last }, modelContextWindow: 400000 } });
  }
  async interruptedWithin(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (this.turn.interrupted) return true;
      await sleep(5);
    }
    return this.turn.interrupted;
  }
  finish(status, error = null) {
    active = undefined;
    notify("turn/completed", { threadId: this.turn.threadId, turn: turnObject(this.turn, status, { error, completedAt: Math.floor(Date.now() / 1000), durationMs: 5 }) });
  }
  /** 向客户端发请求并等待回答；回合被中断时 Codex 会先结清请求。 */
  async ask(method, params) {
    const id = ++requestSeq;
    send({ id, method, params: { threadId: this.turn.threadId, turnId: this.turn.id, ...params } });
    let poll;
    const answer = await new Promise((resolve) => {
      waiters.set(id, resolve);
      poll = setInterval(() => {
        if (this.turn.interrupted) resolve(undefined);
      }, 5);
    });
    clearInterval(poll);
    waiters.delete(id);
    notify("serverRequest/resolved", { threadId: this.turn.threadId, requestId: id });
    return answer;
  }
}

// ───────────────────────── 场景 ─────────────────────────

async function runTurn(turn, prompt) {
  const t = new Turn(turn);
  notify("turn/started", { threadId: turn.threadId, turn: turnObject(turn, "inProgress") });
  const echo = userMessage(turn.params.clientUserMessageId ?? null, prompt);
  t.started(echo);
  t.completed(echo);
  await sleep(2);
  await SCENARIOS[turn.marker]?.(t, turn);
}

const SCENARIOS = {
  async basic(t) {
    t.started({ type: "reasoning", id: "rs-1", summary: [], content: [] });
    t.note("item/reasoning/summaryPartAdded", { itemId: "rs-1", summaryIndex: 0 });
    t.note("item/reasoning/summaryTextDelta", { itemId: "rs-1", delta: "**Planning the work**", summaryIndex: 0 });
    t.completed({ type: "reasoning", id: "rs-1", summary: ["**Planning the work**"], content: [] });
    await t.say("commentary", "I'll run a command and write a file.", "msg-a");

    t.started(commandItem("cmd-1", t.cwd, "inProgress", "echo hello"));
    t.note("item/commandExecution/outputDelta", { itemId: "cmd-1", delta: "hello" });
    t.note("item/commandExecution/outputDelta", { itemId: "cmd-1", delta: "\r\n" });
    await sleep(8);
    t.completed(commandItem("cmd-1", t.cwd, "completed", "echo hello", { aggregatedOutput: "hello\r\n", exitCode: 0, durationMs: 746 }));
    t.usage();

    const file = (kind, name, diff) => ({ path: join(t.cwd, name), kind, diff });
    const create = [file({ type: "add" }, "notes.txt", "ready\nsteady\n")];
    t.started({ type: "fileChange", id: "patch-1", changes: create, status: "inProgress" });
    t.completed({ type: "fileChange", id: "patch-1", changes: create, status: "completed" });
    const edit = [file({ type: "update", move_path: null }, "existing.txt", "@@ -1,3 +1,3 @@\n line one\n-this is old text\n+this is new text\n line three\n")];
    t.started({ type: "fileChange", id: "patch-2", changes: edit, status: "inProgress" });
    t.completed({ type: "fileChange", id: "patch-2", changes: edit, status: "completed" });
    t.usage();

    await t.say("final_answer", "All done.", "msg-b");
    t.usage();
    t.finish("completed");
  },

  async plan(t) {
    const steps = (a, b) => [
      { step: "Run echo one", status: a },
      { step: "Run echo two", status: b },
    ];
    t.note("turn/plan/updated", { explanation: null, plan: steps("inProgress", "pending") });
    await sleep(3);
    t.note("turn/plan/updated", { explanation: "Halfway", plan: steps("completed", "inProgress") });
    await sleep(3);
    t.note("turn/plan/updated", { explanation: null, plan: steps("completed", "completed") });
    await t.say("final_answer", "DONE");
    t.usage();
    t.finish("completed");
  },

  async approval(t, turn) {
    t.started(commandItem("cmd-approve", t.cwd, "inProgress", "Set-Content -LiteralPath .\\out.txt -Value hello"));
    const answer = await t.ask("item/commandExecution/requestApproval", {
      kind: "command",
      itemId: "cmd-approve",
      startedAtMs: Date.now(),
      environmentId: "local",
      reason: "May I write the requested out.txt file outside the sandbox?",
      command: WRAPPER("Set-Content -LiteralPath .\\out.txt -Value hello"),
      cwd: t.cwd,
      commandActions: [{ type: "unknown", command: "Set-Content -LiteralPath .\\out.txt -Value hello" }],
    });
    if (turn.interrupted) return t.finish("interrupted");
    const accepted = answer?.result?.decision === "accept";
    t.completed(
      commandItem("cmd-approve", t.cwd, accepted ? "completed" : "declined", "Set-Content -LiteralPath .\\out.txt -Value hello", accepted ? { aggregatedOutput: "", exitCode: 0, durationMs: 31 } : {}),
    );
    await t.say("final_answer", accepted ? "DONE (written)" : "DONE (declined)");
    t.usage();
    t.finish("completed");
  },

  async fileapproval(t, turn) {
    const changes = [{ path: join(t.cwd, "..", "outside.txt"), kind: { type: "add" }, diff: "x\n" }];
    t.started({ type: "fileChange", id: "patch-out", changes, status: "inProgress" });
    const answer = await t.ask("item/fileChange/requestApproval", { itemId: "patch-out", startedAtMs: Date.now(), reason: "Write outside the workspace", grantRoot: null });
    if (turn.interrupted) return t.finish("interrupted");
    const accepted = answer?.result?.decision === "accept";
    t.completed({ type: "fileChange", id: "patch-out", changes, status: accepted ? "completed" : "declined" });
    await t.say("final_answer", accepted ? "WRITTEN" : "SKIPPED");
    t.usage();
    t.finish("completed");
  },

  async permissions(t, turn) {
    const answer = await t.ask("item/permissions/requestApproval", {
      itemId: "perm-1",
      environmentId: "local",
      startedAtMs: Date.now(),
      cwd: t.cwd,
      reason: "Needs network access to fetch a package",
      permissions: { network: { enabled: true }, fileSystem: null },
    });
    if (turn.interrupted) return t.finish("interrupted");
    await t.say("final_answer", Object.keys(answer?.result?.permissions ?? {}).length > 0 ? "GRANTED" : "NOT GRANTED");
    t.usage();
    t.finish("completed");
  },

  /** 业务提问（不是授权）：一个自由文字的问题。适配器会转给发起方，回合停在这里等回答；最终文字如实写出它收到的回复，测试靠它核对回复的形状。 */
  async question(t, turn) {
    return askUser(t, turn, {
      isBlocking: true,
      questions: [{ id: "q1", header: "Scope", question: "Which package should I update?", isOther: true, isSecret: false, options: null }],
    });
  },

  /** 两个问题：第一个有固定选项（不许自己写），第二个是自由文字。 */
  async questions(t, turn) {
    return askUser(t, turn, {
      isBlocking: true,
      questions: [
        {
          id: "scope",
          header: "Scope",
          question: "Which package should I update?",
          isOther: false,
          isSecret: false,
          options: [
            { label: "core", description: "The core package" },
            { label: "web", description: "The web package" },
          ],
        },
        { id: "note", header: "Note", question: "Anything else I should know?", isOther: true, isSecret: false, options: null },
      ],
    });
  },

  /** 涉及密钥的提问：适配器不转交，直接告诉 Codex 走不通。 */
  async secret(t, turn) {
    return askUser(t, turn, {
      isBlocking: true,
      questions: [{ id: "token", header: "Token", question: "Paste your API token", isOther: true, isSecret: true, options: null }],
    });
  },

  /** isBlocking=false：没有谁在等这个回答，适配器按原来的办法告诉 Codex 无法中继（真实 Codex 此时怎样处理请求没有核实过）。 */
  async nonblocking(t, turn) {
    return askUser(t, turn, {
      isBlocking: false,
      questions: [{ id: "q1", header: "Scope", question: "Which package should I update?", isOther: true, isSecret: false, options: null }],
    });
  },

  async elicit(t) {
    const answer = await t.ask("mcpServer/elicitation/request", {
      serverName: "docs",
      mode: "form",
      _meta: null,
      message: "Pick a collection",
      requestedSchema: { type: "object", properties: {} },
    });
    await t.say("final_answer", `elicitation action: ${answer?.result?.action ?? "none"}`);
    t.usage();
    t.finish("completed");
  },

  /** 一条会运行一小会儿的命令；期间收到的纠偏在命令结束后（回合边界）才进入线程；被中断时命令不会再收到 completed。 */
  async hold(t, turn, ms = 700) {
    await t.say("commentary", "Starting the long step.");
    t.started(commandItem("cmd-hold", t.cwd, "inProgress", "Start-Sleep -Seconds 12"));
    if (await t.interruptedWithin(ms)) return t.finish("interrupted");
    t.completed(commandItem("cmd-hold", t.cwd, "completed", "Start-Sleep -Seconds 12", { aggregatedOutput: "", exitCode: 0, durationMs: ms }));
    t.usage();
    const steers = turn.steers.splice(0);
    for (const steer of steers) {
      const item = userMessage(steer.clientId, steer.text);
      t.started(item);
      t.completed(item);
    }
    await t.say("final_answer", steers.length > 0 ? `Adjusted: ${steers.map((s) => s.text).join(" | ")}` : "Finished without corrections.");
    t.usage();
    t.finish("completed");
  },

  async long(t, turn) {
    return SCENARIOS.hold(t, turn, 20_000);
  },

  async fast(t, turn) {
    await t.say("commentary", "Working.");
    t.started(commandItem("cmd-fast", t.cwd, "inProgress", "Start-Sleep -Seconds 12"));
    const until = Date.now() + 5_000;
    while (!turn.fastSteered && !turn.interrupted && Date.now() < until) await sleep(5);
    if (turn.interrupted) return t.finish("interrupted");
    t.completed(commandItem("cmd-fast", t.cwd, "completed", "Start-Sleep -Seconds 12", { aggregatedOutput: "", exitCode: 0 }));
    await t.say("final_answer", `Fast steer seen: ${turn.fastSteered ?? "no"}`);
    t.usage();
    t.finish("completed");
  },

  async error(t) {
    const error = (message, info) => ({ message, codexErrorInfo: info, additionalDetails: null, misalignment: null });
    t.note("error", { error: error("stream disconnected before completion", { responseStreamDisconnected: { httpStatusCode: null } }), willRetry: true });
    await sleep(3);
    t.note("error", { error: error("You've hit your usage limit. Try again later.", "usageLimitExceeded"), willRetry: false });
    t.finish("failed", error("You've hit your usage limit. Try again later.", "usageLimitExceeded"));
  },

  async modelerror(t) {
    t.finish("failed", {
      message: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.",
      codexErrorInfo: "badRequest",
      additionalDetails: null,
      misalignment: null,
    });
  },

  async crash(t) {
    t.started(commandItem("cmd-crash", t.cwd, "inProgress", "echo about to crash"));
    await sleep(15);
    process.exit(7);
  },

  async nophase(t) {
    await t.say(null, "First thought.", "np-1");
    await t.say(null, "Second thought.", "np-2");
    t.usage();
    t.finish("completed");
  },

  async silent(t) {
    t.started({ type: "reasoning", id: "rs-empty", summary: [], content: [] });
    t.completed({ type: "reasoning", id: "rs-empty", summary: [], content: [] });
    await t.say("final_answer", "Quiet.");
    t.usage();
    t.finish("completed");
  },

  async reasoning2(t) {
    t.started({ type: "reasoning", id: "rs-2", summary: [], content: [] });
    t.note("item/reasoning/summaryPartAdded", { itemId: "rs-2", summaryIndex: 0 });
    t.note("item/reasoning/summaryTextDelta", { itemId: "rs-2", delta: "**First idea**", summaryIndex: 0 });
    t.note("item/reasoning/summaryPartAdded", { itemId: "rs-2", summaryIndex: 1 });
    t.note("item/reasoning/summaryTextDelta", { itemId: "rs-2", delta: "**Second idea**", summaryIndex: 1 });
    t.completed({ type: "reasoning", id: "rs-2", summary: ["**First idea**", "**Second idea**"], content: [] });
    t.started({ type: "reasoning", id: "rs-3", summary: [], content: [] });
    t.completed({ type: "reasoning", id: "rs-3", summary: ["Only at completion"], content: [] });
    await t.say("final_answer", "Thought about it.");
    t.usage();
    t.finish("completed");
  },

  async bigoutput(t) {
    t.started(commandItem("cmd-big", t.cwd, "inProgress", "build everything"));
    for (let i = 0; i < 60; i++) {
      t.note("item/commandExecution/outputDelta", { itemId: "cmd-big", delta: `line ${i} ${"x".repeat(60)}\n` });
      await sleep(1);
    }
    t.note("item/commandExecution/outputDelta", { itemId: "cmd-big", delta: "TAIL-MARKER\n" });
    // 输出停顿：最后一段必须在节流窗口结束时被刷新，而不是等到命令结束。
    await sleep(900);
    t.completed(commandItem("cmd-big", t.cwd, "failed", "build everything", { aggregatedOutput: "FULL-OUTPUT\n", exitCode: 2, durationMs: 950 }));
    await t.say("final_answer", "Build failed.");
    t.usage();
    t.finish("completed");
  },

  async mcp(t) {
    const call = (status, extra = {}) => ({
      type: "mcpToolCall",
      id: "mcp-1",
      server: "docs",
      tool: "search",
      status,
      arguments: { query: "retry policy" },
      appContext: null,
      pluginId: null,
      readOnlyHint: true,
      result: null,
      error: null,
      durationMs: null,
      ...extra,
    });
    t.started(call("inProgress"));
    t.note("item/mcpToolCall/progress", { itemId: "mcp-1", message: "Searching…" });
    await sleep(3);
    t.completed(call("completed", { result: { content: [{ type: "text", text: "3 results" }], structuredContent: null, _meta: null }, durationMs: 120 }));
    t.started({ ...call("inProgress"), id: "mcp-2", tool: "fetch" });
    t.completed({ ...call("failed", { error: { message: "upstream returned 500" } }), id: "mcp-2", tool: "fetch" });
    await t.say("final_answer", "Searched.");
    t.usage();
    t.finish("completed");
  },

  /** 用户自己 Codex 配置里的某个 MCP 服务器启动失败：Codex 会把同一个失败上报不止一次。 */
  async mcpfail(t) {
    const failed = { threadId: t.turn.threadId, name: "idalib", status: "failed", error: "MCP client for `idalib` failed to start: MCP startup failed: Transport closed", failureReason: null };
    notify("mcpServer/startupStatus/updated", failed);
    notify("mcpServer/startupStatus/updated", failed);
    notify("mcpServer/startupStatus/updated", { ...failed, name: "docs", error: "spawn ENOENT" });
    await t.say("final_answer", "Ready.");
    t.usage();
    t.finish("completed");
  },

  async websearch(t) {
    const search = (status) => ({ type: "webSearch", id: "web-1", query: "codex app-server protocol", action: { type: "search", query: "codex app-server protocol" }, results: null, status });
    t.started(search("inProgress"));
    t.completed(search("completed"));
    await t.say("final_answer", "Found it.");
    t.usage();
    t.finish("completed");
  },

  async stray(t) {
    await t.say("final_answer", "Done.");
    t.usage();
    t.finish("completed");
    // 回合结束后 Codex 自行开始了一个 Ensemble 没有请求过的回合（例如排队的输入）。
    const stray = { id: "turn-stray", threadId: t.turn.threadId };
    notify("turn/started", { threadId: stray.threadId, turn: turnObject(stray, "inProgress") });
  },
};
