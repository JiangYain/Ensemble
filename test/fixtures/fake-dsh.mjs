// 假的 dsh：回放 `dsh --profile acp`（ACP v1，stdio 上每行一个 JSON）的真实行为，供适配器测试使用。
// 消息形状都来自 dsh 0.2.2-rc.1 的真实抓包；场景由 prompt 里的 [fake:*] 标记选择，环境由 FAKE_DSH_* 变量控制。
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const env = process.env;
const log = (entry) => env.FAKE_DSH_LOG && appendFileSync(env.FAKE_DSH_LOG, `${JSON.stringify(entry)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (args.includes("--version")) {
  if (env.FAKE_DSH_VERSION_FAIL) {
    console.error(env.FAKE_DSH_VERSION_FAIL);
    process.exit(1);
  }
  console.log(env.FAKE_DSH_VERSION ?? "0.2.2-rc.1");
  process.exit(0);
}

// 启动记录：参数、工作目录、权限模式、嵌套委派的环境变量，以及 --patch 文件在启动时的内容（探测结束后目录会被删掉）。
const patchAt = args.indexOf("--patch");
log({
  type: "launch",
  pid: process.pid,
  args,
  cwd: process.cwd(),
  permission: env.DSH_PERMISSION_MODE,
  parent: env.ENSEMBLE_PARENT_SESSION,
  depth: env.ENSEMBLE_PARENT_DEPTH,
  patch: patchAt >= 0 && existsSync(args[patchAt + 1]) ? readFileSync(args[patchAt + 1], "utf8") : undefined,
});
if (env.FAKE_DSH_CRASH) {
  console.error(env.FAKE_DSH_CRASH);
  process.exit(1);
}

// ── 模型目录：默认只有一个模型（与真实的默认目录一致）；multi 有三个，档位各不相同；none 为空 ──
const FLASH = { provider: "deepseek-official", name: "deepseek-v4-flash", efforts: ["off", "low", "high", "max"], effort: "high" };
const PRO = { provider: "deepseek-official", name: "deepseek-v4-pro", efforts: ["", "low", "high"], effort: "" };
const PLAIN = { provider: "local", name: "plain", efforts: [], effort: undefined };
const MODELS = { none: [], multi: [FLASH, PRO, PLAIN] }[env.FAKE_DSH_MODELS ?? ""] ?? [FLASH];
const valueOf = (model) => JSON.stringify([model.provider, model.name]);

function configOptions(session) {
  const model = MODELS.find((candidate) => valueOf(candidate) === session.model);
  if (!model) return [];
  const providers = [...new Set(MODELS.map((candidate) => candidate.provider))];
  const groups = providers.map((provider) => ({
    group: provider,
    name: provider,
    options: MODELS.filter((candidate) => candidate.provider === provider).map((candidate) => ({ value: valueOf(candidate), name: candidate.name })),
  }));
  const options = [{ id: "model", name: "Model", category: "model", type: "select", currentValue: session.model, options: groups }];
  if (model.efforts.length > 0) {
    options.push({
      id: "reasoning_effort",
      name: "Reasoning effort",
      category: "thought_level",
      type: "select",
      currentValue: session.effort ?? "",
      options: model.efforts.map((effort) => ({ value: effort, name: effort === "" ? "Provider default" : effort })),
    });
  }
  return options;
}

// ── 会话表放在文件里：新进程里的 session/resume 才找得到上一个进程创建的会话 ──
const stateFile = env.FAKE_DSH_STATE;
const sessions = stateFile && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
const save = () => stateFile && writeFileSync(stateFile, JSON.stringify(sessions));

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const respond = (id, result) => send({ id, result });
const fail = (id, code, message) => send({ id, error: { code, message } });
const notify = (session, update) => send({ method: "session/update", params: { sessionId: session.id, update } });

const asked = new Map();
let askSeq = 0;
const ask = (method, params) =>
  new Promise((resolve) => {
    askSeq += 1;
    asked.set(`srv-${askSeq}`, resolve);
    send({ id: `srv-${askSeq}`, method, params });
  });

class RpcFailure extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const running = new Map();

// 真实的 dsh 在标准输入关闭后会自己退出（实测 0.2.2-rc.1：工具在跑时约 3 秒，退出后工具的子进程成了孤儿）。
// 设了这个变量就立即退出，用来复现“关闭时先关标准输入、dsh 先于 taskkill 退出”的竞态。
process.stdin.on("end", () => {
  if (env.FAKE_DSH_EXIT_ON_EOF) process.exit(0);
});

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    log({ type: "response", id: message.id, result: message.result, error: message.error });
    asked.get(message.id)?.(message.result ?? message.error);
    asked.delete(message.id);
    return;
  }
  // parent 只有会话进程才有（探测进程没有），测试据此区分两者发出的请求。
  log({ type: "request", method: message.method, params: message.params, parent: env.ENSEMBLE_PARENT_SESSION });
  void handle(message);
});

async function handle({ id, method, params }) {
  switch (method) {
    case "initialize": {
      if (env.FAKE_DSH_CRASH_ON_INIT) {
        console.error(env.FAKE_DSH_CRASH_ON_INIT);
        process.exit(1);
      }
      const resume = env.FAKE_DSH_NO_RESUME ? {} : { resume: {} };
      respond(id, {
        protocolVersion: Number(env.FAKE_DSH_PROTOCOL ?? 1),
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          mcpCapabilities: { http: true, sse: false },
          sessionCapabilities: { close: {}, list: {}, ...resume },
        },
        agentInfo: { name: "deepseek-harness-acp", title: "DeepSeek Harness", version: "0.0.1" },
        authMethods: [],
      });
      return;
    }
    case "session/new": {
      const first = MODELS[0];
      const session = { id: `fake-session-${Object.keys(sessions).length + 1}`, model: first ? valueOf(first) : "", effort: first?.effort, turns: 0 };
      sessions[session.id] = session;
      save();
      respond(id, { sessionId: session.id, configOptions: configOptions(session) });
      return;
    }
    case "session/resume": {
      const session = sessions[params.sessionId];
      if (!session) return fail(id, -32602, `Invalid params: session is not resumable: ${params.sessionId}`);
      return respond(id, { configOptions: configOptions(session) });
    }
    case "session/set_config_option":
      return setOption(id, params);
    case "session/prompt":
      return prompt(id, params);
    case "session/cancel":
      running.get(params.sessionId)?.cancel();
      return;
    case "session/close":
      return respond(id, {});
    default:
      if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
  }
}

function setOption(id, { sessionId, configId, value }) {
  const session = sessions[sessionId];
  if (!session) return fail(id, -32602, `Invalid params: unknown session ${sessionId}`);
  if (configId === "model") {
    const model = MODELS.find((candidate) => valueOf(candidate) === value);
    if (!model) return fail(id, -32602, `Invalid params: unknown model option: ${value}`);
    session.model = value;
    session.effort = model.effort;
  } else if (configId === "reasoning_effort") {
    const model = MODELS.find((candidate) => valueOf(candidate) === session.model);
    if (!model?.efforts.includes(value)) return fail(id, -32602, `Invalid params: unknown reasoning effort: ${value}`);
    session.effort = value;
  } else {
    return fail(id, -32602, `Invalid params: unknown session config option: ${configId}`);
  }
  save();
  return respond(id, { configOptions: configOptions(session) });
}

async function prompt(id, { sessionId, prompt: blocks }) {
  const session = sessions[sessionId];
  if (!session) return fail(id, -32602, `Invalid params: unknown session ${sessionId}`);
  // 与真实 dsh 一致：同一会话同一时刻只接受一个 prompt，第二个被拒绝，文字不会被注入。
  if (running.has(sessionId)) return fail(id, -32602, "Invalid params: a prompt is already in flight for this session");
  const turn = { cancelled: false, onCancel: undefined, cancel() { turn.cancelled = true; turn.onCancel?.(); } };
  running.set(sessionId, turn);
  session.turns += 1;
  save();
  try {
    const text = blocks.map((block) => block.text ?? "").join("\n");
    respond(id, { stopReason: await scenario({ text, session, turn }) });
  } catch (error) {
    if (error instanceof RpcFailure) fail(id, error.code, error.message);
    else throw error;
  } finally {
    running.delete(sessionId);
  }
}

// ── 场景 ──
const text = (messageId, value) => ({ sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: value } });
const thought = (messageId, value) => ({ sessionUpdate: "agent_thought_chunk", messageId, content: { type: "text", text: value } });
const toolCall = (callId, title, rawInput) => ({ sessionUpdate: "tool_call", toolCallId: callId, title, kind: "other", status: "in_progress", rawInput });
const toolDone = (callId, status, value) => ({ sessionUpdate: "tool_call_update", toolCallId: callId, status, content: [{ type: "content", content: { type: "text", text: value } }] });

async function scenario({ text: prompt, session, turn }) {
  const has = (name) => prompt.includes(`[fake:${name}]`);
  const say = (update) => notify(session, update);
  const message = `m${session.turns}`;
  // 真实的 dsh 在第一次模型调用结束前不发任何更新，所以“运行中”是从第一条更新开始的：先发一条，再拖一会儿。
  if (has("slow")) {
    say(text(`${message}a`, "Working."));
    await sleep(400);
  }
  if (has("empty")) return "end_turn";
  if (has("error401")) {
    await sleep(20);
    throw new RpcFailure(-32603, 'Internal error: turn failed: 401: {"message":"Incorrect API key provided"}');
  }
  if (has("die")) {
    say(text(message, "Starting."));
    setTimeout(() => process.exit(3), 20);
    await sleep(10_000);
  }
  if (has("hold") || has("orphan") || has("waitmodel")) return hold({ say, turn, message, orphan: has("orphan"), tool: !has("waitmodel") });
  if (has("srvreq")) {
    // dsh 向客户端发它不该发的请求：客户端应当明确拒绝（回复记在日志里）。
    await ask("fs/read_text_file", { sessionId: session.id, path: "x.txt" });
    say(text(message, "Handled."));
    return "end_turn";
  }
  if (has("perm")) {
    say(toolCall("c_perm", "pwsh", { command: "Remove-Item important.txt" }));
    const options = [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ];
    const answer = await ask("session/request_permission", { sessionId: session.id, toolCall: { toolCallId: "c_perm", title: "pwsh", kind: "other", status: "pending" }, options });
    const allowed = answer?.outcome?.outcome === "selected" && String(answer.outcome.optionId).startsWith("allow");
    say(allowed ? toolDone("c_perm", "completed", "ok\n[exit code: 0]") : toolDone("c_perm", "failed", "Error: permission denied"));
    say(text(`${message}b`, "Permission handled."));
    return "end_turn";
  }
  if (has("think")) say(thought(message, "Thinking about it."));
  if (has("tools")) {
    say(text(`${message}a`, "Working on it."));
    say(toolCall("c_write", "write", { file_path: "out/hello.txt", content: "a\nb\nc\n" }));
    say(toolDone("c_write", "completed", "Created file out/hello.txt (3 lines)"));
    say(toolCall("c_edit", "edit", { file_path: "out/hello.txt", old_string: "b", new_string: "B" }));
    say(toolDone("c_edit", "completed", "Updated file out/hello.txt"));
    say(toolCall("c_pwsh", "pwsh", { command: "Write-Output oops; exit 3" }));
    say(toolDone("c_pwsh", "completed", "oops\r\n[exit code: 3]"));
    say(toolCall("c_read", "read", { file_path: "missing.txt" }));
    say(toolDone("c_read", "failed", "Error: ENOENT: no such file or directory"));
    say(toolCall("c_todo", "todo_write", { todos: [{ content: "Write the file", status: "completed" }, { content: "Run the tests", status: "in_progress" }] }));
    say(toolDone("c_todo", "completed", "Todos updated"));
    say({ sessionUpdate: "usage_update", used: 7100, size: 1_000_000 });
    say(text(`${message}b`, "All done."));
    return "end_turn";
  }
  say(text(message, `Done (turn ${session.turns}).`));
  say({ sessionUpdate: "usage_update", used: 3200 + session.turns, size: 1_000_000 });
  return /\[fake:stop:(\w+)\]/.exec(prompt)?.[1] ?? "end_turn";
}

/** 一个跑着不结束的 shell 工具；收到 session/cancel 后与真实 dsh 一样：只结束工具的那层 shell，之下的进程成为孤儿。 */
async function hold({ say, turn, message, orphan, tool }) {
  say(text(message, "Starting a long command."));
  // tool 为 false 时没有工具在跑，只是在等下一次模型调用（取消时没有可清理的进程）。
  if (tool) say(toolCall("c_hold", "pwsh", { command: "Start-Sleep 60" }));
  const shell = orphan ? spawnTree() : undefined;
  await new Promise((resolve) => {
    turn.onCancel = resolve;
    setTimeout(resolve, Number(env.FAKE_DSH_HOLD_MS ?? 60_000));
  });
  if (!turn.cancelled) return "end_turn";
  if (shell) {
    try {
      process.kill(shell.pid);
    } catch {
      // 已经退出就算了。
    }
  }
  if (tool) say(toolDone("c_hold", "failed", "Error: tool call aborted"));
  return "cancelled";
}

/**
 * shell（子进程）+ 它启动的长期进程（孙进程）；两个 pid 写进 FAKE_DSH_PIDS，供测试检查孙进程有没有被清理。
 * 孙进程必须 detached：Windows 上 libuv 会把非 detached 的子进程放进随父进程关闭而结束的作业对象，
 * shell 一死孙进程就跟着没了，这与真实 dsh 里 pwsh 启动的进程在 pwsh 被结束后继续存活（孤儿）的情形不符。
 * 两个进程都有 5 分钟的寿命上限：测试没清理成（崩了、被中断）时也不会一直留在机器上；所有测试都在几十秒内结束，不受影响。
 */
function spawnTree() {
  const source = [
    'const { spawn } = require("node:child_process");',
    'const leaf = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 300000).unref();"], { stdio: "ignore", windowsHide: true, detached: true });',
    "leaf.unref();",
    'require("node:fs").writeFileSync(process.env.FAKE_DSH_PIDS, JSON.stringify({ shell: process.pid, leaf: leaf.pid }));',
    "setInterval(() => {}, 1000);",
    "setTimeout(() => process.exit(0), 300000).unref();",
  ].join("\n");
  return spawn(process.execPath, ["-e", source], { stdio: "ignore", env, windowsHide: true });
}
