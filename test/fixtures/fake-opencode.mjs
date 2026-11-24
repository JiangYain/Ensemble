#!/usr/bin/env node
/**
 * 假 OpenCode：按真实 `opencode serve --stdio`（2.3.0）抓到的 HTTP / SSE 行为回放，仅用于适配器的确定性测试。
 *
 * 接口：Basic 认证（opencode:$OPENCODE_PASSWORD）；GET /api/model、/api/model/default、/api/shell（运行中的 shell 登记表）、/api/event（SSE）；
 * POST /api/session、PATCH|GET /api/session/:id、POST …/prompt、POST …/interrupt、DELETE …/inbox/:id、
 * POST …/permission/:id/reply、POST …/form/:id/reply（204 / 400 / 404 / 409）、DELETE …/form/:id[?message=]（204 / 404 / 409）。
 * 进程在 stdin 关闭时退出，且**不会**带走它启动的工具进程（最坏情形）。
 *
 * shell 工具是真的子进程（再带一个孙进程），中断时只杀 shell 本身，孙进程变成孤儿，和真实的 OpenCode 一样；
 * 这样适配器“先杀进程树再中断”的行为才能被真实检验。所有子进程都有自毁定时器，测试失败也不会永远残留。
 *
 * 场景由提示词里的标记选择：
 *   [fake:tools]    read → write(新建) → edit(带 metadata.files) → shell(退出码 0)，再给最终回答
 *   [fake:hold]     一个约 FAKE_OC_HOLD_MS 毫秒的 shell 工具；期间收到的 steer 在工具结束后的 step 边界被取走
 *   [fake:long]     shell 工具一直不结束，直到被中断（用来测取消与孤儿进程）
 *   [fake:hidden]   与 long / hold 连用：shell 在登记表里，但 shell.created 事件不发出（相当于适配器还没处理到它）
 *   [fake:nodrain]  运行结束时不取走收件箱里的 steer（弱路径）
 *   [fake:error]    provider.no-route 异步失败（模型不存在）
 *   [fake:ratelimit] 429：session.retry.scheduled → step.failed → execution.failed
 *   [fake:perm]     先发 permission.asked（读 .env），等回复；被拒绝则中止整次执行
 *   [fake:form]     先发一个 metadata.kind=question 但没有字段的表单（适配器读不懂的提问）：适配器带说明地撤回它，工具报错、运行继续
 *   [fake:formother] 先发一个不是提问的表单（metadata.kind=other），等被取消；不带说明地取消后中止整次执行
 *   [fake:ask]      先发一个真实形状的提问表单（q0 单选、可自己写；q1 多选、不可自己写；选项的 value 与 label 不同），等 reply 或 DELETE：
 *                   reply 先校验（400 / 404 / 409）；DELETE 带 ?message= 时工具报错、运行继续，不带则中止整次执行；运行被中断时表单被撤掉（form.cancelled，真实服务是否如此没有核实）
 *   [fake:crash]    运行中进程直接退出（退出前往 stderr 写一行带密钥形态的文字，用来测脱敏）
 *   [fake:dropsse]  运行中把事件流连接掐断（进程还活着）
 *   [fake:child]    插入属于别的会话（子 Agent）的事件，适配器必须忽略
 *   [fake:compact]  压缩上下文并记录旁路用量
 * 环境变量：FAKE_OC_LOG（记录启动参数与每个请求）、FAKE_OC_DB（会话持久化文件，缺省则只在内存）、FAKE_OC_PIDS（记录 shell 与孙进程 pid）、
 * FAKE_OC_VERSION、FAKE_OC_MODE（badstart | nonloopback | nomodels | catalogfail：服务正常起来，但模型目录请求 500，并先往 stderr 写一行带密钥形态的文字）、FAKE_OC_HOLD_MS、FAKE_OC_HEARTBEAT_MS。
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const log = (value) => {
  if (process.env.FAKE_OC_LOG) appendFileSync(process.env.FAKE_OC_LOG, `${JSON.stringify(value)}\n`);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

if (argv.includes("--version")) {
  // 不调用 process.exit：Windows 上管道输出是异步的，立刻退出会截断版本号。
  process.stdout.write(`opencode v${process.env.FAKE_OC_VERSION ?? "2.3.0"}\n`);
} else if (argv[0] === "serve") {
  main();
} else {
  process.stderr.write(`fake-opencode: unsupported arguments ${argv.join(" ")}\n`);
  process.exitCode = 2;
}

function main() {
  const mode = process.env.FAKE_OC_MODE ?? "";
  if (mode === "badstart") {
    process.stderr.write("fatal: cannot open database (Authorization: Bearer abcdefgh12345678)\n");
    process.exitCode = 1;
    return;
  }
  // 先于监听地址写出：探测在模型目录请求失败时会取 stderr 的第一行非空文字作为原因，它必须被脱敏。
  if (mode === "catalogfail") process.stderr.write("warn: upstream rejected Authorization: Bearer abcdefgh12345678\n");
  const password = process.env.OPENCODE_PASSWORD ?? "";
  log({
    kind: "start",
    argv,
    cwd: process.cwd(),
    parent: process.env.ENSEMBLE_PARENT_SESSION ?? null,
    depth: process.env.ENSEMBLE_PARENT_DEPTH ?? null,
    passwordSet: password.length > 0,
  });
  const expectedAuth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;

  // ───── 模型目录（settings 里的 apiKey 必须永远不被适配器拷贝出去） ─────
  const model = (providerID, modelID, extra = {}) => ({
    id: modelID, modelID, providerID, type: "chat", name: `Fake ${modelID}`,
    settings: { apiKey: "sk-live-SHOULD-NEVER-LEAK-0123456789" },
    variants: [{ id: "low", settings: {} }, { id: "high", settings: {} }],
    status: "active", enabled: true, limit: { context: 100000, output: 8000 }, ...extra,
  });
  const catalog = mode === "nomodels" ? [] : [
    model("opencode", "fake-free"),
    model("anthropic", "fake-pro", { variants: [] }),
    model("anthropic", "fake-off", { enabled: false }),
    model("anthropic", "fake-old", { status: "deprecated" }),
    model("opencode", "fake-embed", { type: "embedding" }),
  ];

  // ───── 会话库（可持久化，供“服务重启后恢复”测试） ─────
  const dbPath = process.env.FAKE_OC_DB;
  const db = dbPath && existsSync(dbPath) ? JSON.parse(readFileSync(dbPath, "utf8")) : { sessions: {}, seq: 0 };
  const save = () => dbPath && writeFileSync(dbPath, JSON.stringify(db));
  const states = new Map();
  const stateOf = (id) => {
    if (!states.has(id)) states.set(id, { running: false, interrupted: false, inbox: [], wake: () => {}, replies: new Map(), forms: new Map(), shells: new Map(), step: undefined, totals: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, cost: 0 }, context: [] });
    return states.get(id);
  };

  // ───── shell 登记表（GET /api/shell）：只含运行中的 shell，退出后条目消失，和真实服务一致 ─────
  const shellRegistry = new Map();
  const pidAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  // ───── 事件流 ─────
  const clients = new Set();
  let eventSeq = 0;
  const emit = (type, data) => {
    const frame = JSON.stringify({ id: `evt_${++eventSeq}`, created: Date.now(), type, data });
    for (const res of clients) res.write(`data: ${frame}\n\n`);
  };
  const heartbeat = setInterval(() => { for (const res of clients) res.write(": heartbeat\n\n"); }, Number(process.env.FAKE_OC_HEARTBEAT_MS ?? 15000));
  heartbeat.unref();

  // ───── HTTP ─────
  const send = (res, status, body) => {
    res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  /** 校验提问表单的回答：每个字段都要有；单选一个字符串、多选字符串数组；不许自己写（custom=false）的字段只能取可选项的 value。返回问题描述，没问题返回 undefined。 */
  const formAnswerProblem = (entry, answer) => {
    if (typeof answer !== "object" || answer === null || Array.isArray(answer)) return "answer must be an object keyed by field";
    for (const field of entry.fields) {
      const value = answer[field.key];
      if (value === undefined) return `missing answer for ${field.key}`;
      const multiple = field.type === "multiselect";
      if (multiple ? !Array.isArray(value) : typeof value !== "string") return `${field.key}: expected ${multiple ? "an array of strings" : "a string"}`;
      const picks = multiple ? value : [value];
      if (picks.some((pick) => typeof pick !== "string")) return `${field.key}: answers must be strings`;
      const allowed = new Set((field.options ?? []).map((option) => option.value));
      if (field.custom === false && picks.some((pick) => !allowed.has(pick))) return `${field.key}: not one of the options`;
    }
    return undefined;
  };

  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== expectedAuth) return send(res, 401, { message: "unauthorized" });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : undefined;
    log({ kind: "request", method: req.method, path: url.pathname + url.search, body });
    const path = url.pathname;

    if (req.method === "GET" && path === "/api/event") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      clients.add(res);
      res.on("close", () => clients.delete(res));
      emit("server.connected", {});
      return;
    }
    if (req.method === "GET" && path === "/api/model" && mode === "catalogfail") return send(res, 500, { message: "model catalog unavailable" });
    if (req.method === "GET" && path === "/api/model") return send(res, 200, { location: { directory: process.cwd() }, data: catalog });
    if (req.method === "GET" && path === "/api/model/default") return catalog[0] ? send(res, 200, { data: catalog[0] }) : send(res, 404, { message: "no default model" });
    if (req.method === "GET" && path === "/api/shell") return send(res, 200, { location: { directory: process.cwd() }, data: [...shellRegistry.values()] });

    if (req.method === "POST" && path === "/api/session") {
      const id = `ses_fake${++db.seq}`;
      db.sessions[id] = { id, title: undefined, model: body.model ?? { id: "fake-free", providerID: "opencode" }, permissions: body.permissions ?? [], location: body.location, metadata: body.metadata };
      save();
      emit("session.created", { sessionID: id, location: body.location, model: db.sessions[id].model, permissions: db.sessions[id].permissions, version: "2.3.0" });
      return send(res, 200, { data: db.sessions[id] });
    }
    const match = /^\/api\/session\/([^/]+)(?:\/(.*))?$/.exec(path);
    const session = match ? db.sessions[match[1]] : undefined;
    if (!match) return send(res, 404, { message: "not found" });
    if (!session) return send(res, 404, { message: `Session not found: ${match[1]}` });
    const sub = match[2] ?? "";
    const state = stateOf(session.id);

    if (req.method === "GET" && sub === "") return send(res, 200, { data: session });
    if (req.method === "PATCH" && sub === "") {
      session.title = body.title;
      save();
      emit("session.renamed", { sessionID: session.id, title: body.title });
      return send(res, 200, { data: session });
    }
    if (req.method === "POST" && sub === "prompt") {
      const inboxID = `msg_in${++db.seq}`;
      const delivery = body.delivery ?? "steer";
      save();
      emit("session.inbox.enqueued", { inboxID, sessionID: session.id, item: { type: "user", payload: { text: body.text }, delivery } });
      state.inbox.push({ id: inboxID, text: body.text });
      if (!state.running) setImmediate(() => void execute(session, state));
      return send(res, 200, { data: { id: inboxID, delivery } });
    }
    if (req.method === "POST" && sub === "interrupt") {
      // 记下中断到达的这一刻还有哪些 shell 进程活着：适配器必须先杀进程树、再发中断。
      log({ kind: "interrupt", aliveShells: [...shellRegistry.values()].map((shell) => shell.pid).filter(pidAlive) });
      const wasRunning = state.running;
      if (wasRunning) {
        state.interrupted = true;
        state.wake();
      }
      return send(res, 200, { interrupted: wasRunning });
    }
    const inbox = /^inbox\/(.+)$/.exec(sub);
    if (req.method === "DELETE" && inbox) {
      const index = state.inbox.findIndex((item) => item.id === inbox[1]);
      if (index < 0) return send(res, 404, { message: "inbox entry not found" });
      state.inbox.splice(index, 1);
      emit("session.inbox.cancelled", { sessionID: session.id, inboxID: inbox[1] });
      return send(res, 200, { data: true });
    }
    const reply = /^permission\/(.+)\/reply$/.exec(sub);
    if (req.method === "POST" && reply) {
      state.replies.get(reply[1])?.(body.decision);
      return send(res, 204);
    }
    // 表单（提问）：reply 带回答，先校验；DELETE 撤回，带 ?message= 时工具以错误结束而运行继续，不带则整次运行被中止（与真实服务一致，读 2.3.0 源码所得）。
    const formReply = /^form\/([^/]+)\/reply$/.exec(sub);
    if (req.method === "POST" && formReply) {
      const entry = state.forms.get(formReply[1]);
      if (!entry) return send(res, 404, { message: `Form not found: ${formReply[1]}` });
      if (entry.settled) return send(res, 409, { message: "Form already settled" });
      const problem = formAnswerProblem(entry, body?.answer);
      if (problem) return send(res, 400, { message: problem });
      entry.settled = true;
      emit("form.replied", { id: entry.id, sessionID: session.id, answer: body.answer });
      entry.result = { answer: body.answer };
      return send(res, 204);
    }
    const form = /^form\/([^/]+)$/.exec(sub);
    if (req.method === "DELETE" && form) {
      const entry = state.forms.get(form[1]);
      if (!entry) return send(res, 404, { message: `Form not found: ${form[1]}` });
      if (entry.settled) return send(res, 409, { message: "Form already settled" });
      entry.settled = true;
      emit("form.cancelled", { id: entry.id, sessionID: session.id });
      const message = url.searchParams.get("message");
      entry.result = message ? { cancelled: message } : { cancelled: "" };
      return send(res, 204);
    }
    return send(res, 404, { message: "not found" });
  });

  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    const host = mode === "nonloopback" ? "evil.example.com" : "127.0.0.1";
    process.stdout.write(`${JSON.stringify({ url: `http://${host}:${port}` })}\n`);
  });
  // stdin 是它的生命线：对端一关就退出（但不替工具进程善后）。
  const shutdown = () => {
    server.close();
    for (const client of clients) client.destroy();
    process.exit(0);
  };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.stdin.resume();

  // ───── 执行引擎 ─────
  class Interrupted extends Error {}
  const ids = { msg: 0, call: 0, shell: 0 };

  const waitUntil = async (state, predicate, timeoutMs = 20000) => {
    const start = Date.now();
    while (!predicate()) {
      if (state.interrupted) throw new Interrupted();
      if (Date.now() - start > timeoutMs) throw new Error("fake-opencode: wait timeout");
      await new Promise((wakeUp) => {
        state.wake = wakeUp;
        setTimeout(wakeUp, 10);
      });
    }
  };

  const drainInbox = (session, state, keepFirst = false) => {
    const items = state.inbox.splice(keepFirst ? 1 : 0);
    for (const item of items) {
      state.context.push(item.text);
      emit("session.inbox.delivered", { sessionID: session.id, inboxID: item.id });
    }
  };

  const tally = (state) => {
    const tokens = { input: 100, output: 10, reasoning: 5, cache: { read: 50, write: 0 } };
    state.totals.input += tokens.input;
    state.totals.output += tokens.output;
    state.totals.reasoning += tokens.reasoning;
    state.totals.cache.read += tokens.cache.read;
    state.totals.cost += 0.001;
    return { tokens, cost: 0.001 };
  };

  async function runStep(session, state, body, { finish = "stop" } = {}) {
    const assistantMessageID = `msg_a${++ids.msg}`;
    state.step = assistantMessageID;
    const m = session.model;
    emit("session.step.started", { sessionID: session.id, agent: "build", model: { id: m.id, providerID: m.providerID, variant: m.variant ?? "default" }, assistantMessageID, started: Date.now() });
    await body(assistantMessageID);
    const { tokens, cost } = tally(state);
    emit("session.step.ended", { sessionID: session.id, assistantMessageID, finish, rawFinish: finish === "stop" ? "stop" : "tool_calls", tokens, cost });
    emit("session.usage.updated", { sessionID: session.id, cost: state.totals.cost, tokens: { input: state.totals.input, output: state.totals.output, reasoning: state.totals.reasoning, cache: state.totals.cache } });
    state.step = undefined;
  }

  const say = async (session, assistantMessageID, text, { think = true } = {}) => {
    if (think) {
      emit("session.reasoning.started", { sessionID: session.id, assistantMessageID, ordinal: 0 });
      emit("session.reasoning.delta", { sessionID: session.id, assistantMessageID, ordinal: 0, delta: "Thinking about it." });
      emit("session.reasoning.ended", { sessionID: session.id, assistantMessageID, ordinal: 0, text: "Thinking about it." });
    }
    emit("session.text.started", { sessionID: session.id, assistantMessageID, ordinal: think ? 1 : 0 });
    for (const piece of text.match(/.{1,8}/gs) ?? [text]) {
      emit("session.text.delta", { sessionID: session.id, assistantMessageID, ordinal: think ? 1 : 0, delta: piece });
      await sleep(2);
    }
    emit("session.text.ended", { sessionID: session.id, assistantMessageID, ordinal: think ? 1 : 0, text });
  };

  /** 发起一次工具调用；`run(callId)` 返回 { text, metadata }，抛出普通错误表示工具失败，抛出 Interrupted 表示被中断。 */
  async function tool(session, state, assistantMessageID, name, input, run) {
    const id = `call_${++ids.call}`;
    const base = { sessionID: session.id, assistantMessageID, id };
    emit("session.tool.input.started", { ...base, name });
    await sleep(3);
    emit("session.tool.input.ended", { ...base, text: JSON.stringify(input) });
    emit("session.tool.called", { ...base, input, executed: false });
    try {
      const { text, metadata } = await run(id);
      emit("session.tool.success", { ...base, content: [{ type: "text", text }], metadata: metadata ?? { truncated: false }, executed: false });
    } catch (error) {
      if (error instanceof Interrupted) {
        emit("session.tool.failed", { ...base, error: { type: "tool.execution", message: "\r\n\uFFFD\uFFFD\uFFFD\uFFFD partial output" }, metadata: { interrupted: true, truncated: false }, executed: false });
        throw error;
      }
      if (error.aborted) {
        // 权限被拒绝或表单被取消：真实 OpenCode 以 aborted 收尾，并中止整次执行（reason 为 shutdown）。
        emit("session.tool.failed", { ...base, error: { type: "aborted", message: error.message }, executed: false });
        throw Object.assign(new Interrupted(), { reason: "shutdown" });
      }
      emit("session.tool.failed", { ...base, error: { type: "tool.execution", message: error.message }, executed: false });
    }
  }

  /** 发出一个表单（提问）并等它有结局（reply 或 DELETE 把结果写进 entry.result）；运行被中断时表单被撤掉，发 form.cancelled（真实服务是否如此没有核实）。 */
  async function askForm(session, state, form) {
    const entry = { ...form, sessionID: session.id, settled: false, result: undefined };
    state.forms.set(entry.id, entry);
    emit("form.created", { form: { id: entry.id, sessionID: session.id, title: entry.title, metadata: entry.metadata, fields: entry.fields } });
    try {
      await waitUntil(state, () => entry.result !== undefined, 60000);
    } catch (error) {
      if (error instanceof Interrupted && !entry.settled) {
        entry.settled = true;
        emit("form.cancelled", { id: entry.id, sessionID: session.id });
      }
      throw error;
    }
    return entry.result;
  }

  /** 真的起一个 shell 子进程（并让它再起一个孙进程），报告真实 pid。 */
  async function shellTool(session, state, assistantMessageID, command, { holdMs, hidden = false }) {
    await tool(session, state, assistantMessageID, "shell", { command, workdir: process.cwd() }, async () => {
      const shellID = `sh_${++ids.shell}`;
      const script = "const { spawn } = require('node:child_process');" +
        "const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 90000)'], { stdio: 'ignore', windowsHide: true });" +
        "process.stdout.write('grandchild ' + g.pid + '\\n'); setTimeout(() => process.exit(0), 90000);";
      const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      let grandchild;
      child.stdout.on("data", (chunk) => {
        grandchild = Number(/grandchild (\d+)/.exec(String(chunk))?.[1]);
        if (process.env.FAKE_OC_PIDS) appendFileSync(process.env.FAKE_OC_PIDS, `${JSON.stringify({ shell: child.pid, grandchild })}\n`);
      });
      const exited = new Promise((done) => child.on("exit", (code) => done(code)));
      let exitCode;
      // 登记表里的条目在进程退出的那一刻就消失（真实服务同样如此）；shell.exited 事件要晚一些才到。
      exited.then((code) => { exitCode = code ?? 1; shellRegistry.delete(shellID); });
      const forget = () => { state.shells.delete(shellID); shellRegistry.delete(shellID); };
      state.shells.set(shellID, child);
      const info = { id: shellID, pid: child.pid, status: "running", command, cwd: process.cwd(), shell: "pwsh", file: "pwsh.exe", metadata: { sessionID: session.id }, time: { started: Date.now() } };
      shellRegistry.set(shellID, info);
      // hidden：登记表里有，但 shell.created 事件“还没送到适配器”（事件循环忙、刚起就取消），只能靠 GET /api/shell 找到它。
      if (!hidden) emit("shell.created", { info });
      emit("session.tool.progress", { sessionID: session.id, assistantMessageID, id: `call_${ids.call}`, metadata: { shellID } });
      const started = Date.now();
      try {
        // holdMs 为空表示一直等到被中断（或被适配器按 pid 杀掉）。
        await waitUntil(state, () => exitCode !== undefined || (holdMs !== undefined && Date.now() - started >= holdMs), 60000);
      } catch (error) {
        if (error instanceof Interrupted) {
          // 和真实 OpenCode 一样：中断只杀 shell 本身，不管它的子孙进程。
          child.kill();
          await exited;
          emit("shell.exited", { id: shellID, exit: 1, status: "killed" });
          forget();
        }
        throw error;
      }
      if (exitCode !== undefined) {
        // 被外部杀掉（适配器的进程树清理）：给“紧随其后的 interrupt”一点时间再判断。
        // 真实 OpenCode 实测要约 0.9 秒才处理到 shell.exited、才继续下一步；这里取 400 毫秒，仍比真实更苛刻，
        // 但不至于在机器被别的进程压住、测试进程的事件循环被拖慢时，把“迟到几十毫秒的中断”误判成适配器的错。
        await sleep(400);
        emit("shell.exited", { id: shellID, exit: exitCode, status: "killed" });
        forget();
        if (state.interrupted) throw new Interrupted();
        throw new Error("The shell was killed.");
      }
      child.kill();
      await exited;
      emit("shell.exited", { id: shellID, exit: 0, status: "exited" });
      forget();
      return { text: "(no output)", metadata: { status: "completed", truncated: false, exit: 0 } };
    });
  }

  async function execute(session, state) {
    state.running = true;
    state.interrupted = false;
    const first = state.inbox[0];
    const flags = [...(first?.text ?? "").matchAll(/\[fake:(\w+)\]/g)].map((m) => m[1]);
    const has = (flag) => flags.includes(flag);
    emit("session.execution.started", { sessionID: session.id });
    drainInbox(session, state, false);
    state.context = [first?.text ?? ""];
    const cwd = session.location?.directory ?? process.cwd();
    const finalText = () => `Done: ${state.context.map((t) => t.replace(/\[fake:\w+\]/g, "").trim()).filter(Boolean).join(" / ")}`;
    try {
      if (has("crash")) {
        emit("session.step.started", { sessionID: session.id, agent: "build", model: { id: session.model.id, providerID: session.model.providerID, variant: "default" }, assistantMessageID: "msg_crash" });
        await sleep(30);
        // Windows 上管道写入是异步的：等这一行真的写出去再退出，否则 stderr 会被截掉。
        await new Promise((flushed) => process.stderr.write("fatal: upstream rejected Authorization: Bearer abcdefgh12345678\n", flushed));
        process.exit(3);
      }
      if (has("error") || /nonexistent/.test(session.model.id) || (session.model.variant && !["low", "high"].includes(session.model.variant))) {
        await sleep(20);
        const message = session.model.variant && !["low", "high"].includes(session.model.variant) ? `Unknown variant "${session.model.variant}" for model` : `Model unavailable: ${session.model.providerID}/${session.model.id}`;
        emit("session.execution.failed", { sessionID: session.id, error: { type: "provider.no-route", message } });
        return;
      }
      if (has("ratelimit")) {
        const error = { type: "provider.http", message: "Rate limited, retry later", status: 429, response: { body: "Authorization: Bearer abcdefgh12345678 leaked-in-response" } };
        emit("session.step.started", { sessionID: session.id, agent: "build", model: { id: session.model.id, providerID: session.model.providerID, variant: "default" }, assistantMessageID: "msg_rl" });
        emit("session.retry.scheduled", { sessionID: session.id, assistantMessageID: "msg_rl", attempt: 1, at: Date.now() + 1000, error });
        emit("session.step.failed", { sessionID: session.id, assistantMessageID: "msg_rl", error, rawFinish: "error", tokens: { input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 });
        emit("session.execution.failed", { sessionID: session.id, error });
        return;
      }
      if (has("child")) {
        emit("session.tool.input.started", { sessionID: "ses_child1", assistantMessageID: "msg_child", id: "call_child", name: "shell" });
        emit("shell.created", { info: { id: "sh_child", pid: 1, status: "running", command: "child", metadata: { sessionID: "ses_child1" } } });
        emit("session.text.delta", { sessionID: "ses_child1", assistantMessageID: "msg_child", ordinal: 0, delta: "child secret chatter" });
      }

      await runStep(session, state, async (asst) => {
        if (has("dropsse")) {
          await sleep(30);
          for (const client of clients) client.destroy();
          await sleep(300);
        }
        if (has("perm")) {
          await tool(session, state, asst, "read", { path: ".env" }, async (callId) => {
            const permissionID = "per_fake1";
            emit("permission.asked", { id: permissionID, sessionID: session.id, action: "read", resources: [".env"], save: ["*"], source: { type: "tool", messageID: asst, id: callId } });
            const decision = await new Promise((done) => { state.replies.set(permissionID, done); });
            if (decision === "reject") throw Object.assign(new Error("The user declined this tool call"), { aborted: true });
            return { text: "Read file .env, lines 1-1\n1: PLACEHOLDER" };
          });
        }
        if (has("form") || has("formother") || has("ask")) {
          const metadata = { kind: has("formother") ? "other" : "question", tool: { messageID: asst } };
          // 真实形状的提问：每个问题一个字段；选项的 value 与 label 故意不同，好核对适配器把标签换回了 value。
          const fields = has("ask")
            ? [
                { key: "q0", title: "Color", description: "Which color should I use?", type: "string", custom: true, options: [{ value: "red", label: "Red", description: "A warm color" }, { value: "blue", label: "Blue" }] },
                { key: "q1", title: "Extras", description: "Which extras do you want?", type: "multiselect", custom: false, options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }] },
              ]
            : [];
          await tool(session, state, asst, "question", { questions: [{ question: "Which color?", header: "Color", options: [] }] }, async () => {
            const result = await askForm(session, state, { id: "frm_fake1", title: "Questions", metadata, fields });
            if (result.answer) return { text: `Answered: ${JSON.stringify(result.answer)}` };
            // 带说明地撤回：这次工具调用报错，运行继续；不带说明：和真实服务一样，整次运行被中止。
            if (result.cancelled) throw new Error(`The question was not answered: ${result.cancelled}`);
            throw Object.assign(new Error("The user dismissed this question"), { aborted: true });
          });
        }
        if (has("compact")) {
          emit("session.compaction.started", { sessionID: session.id, reason: "auto" });
          emit("session.usage.recorded", { sessionID: session.id, source: "compaction", cost: 0.002, tokens: { input: 200, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } });
          emit("session.compaction.failed", { sessionID: session.id, reason: "auto", error: { type: "provider.http", message: "summary failed" } });
        }
        if (has("tools")) {
          await tool(session, state, asst, "read", { path: resolve(cwd, "notes.txt") }, async () => ({ text: "Read file notes.txt, lines 1-1\n1: alpha", metadata: { truncated: false } }));
          await tool(session, state, asst, "write", { path: resolve(cwd, "out.txt"), content: "new\nfile\n" }, async () => {
            writeFileSync(resolve(cwd, "out.txt"), "new\nfile\n");
            return { text: "Created file successfully: out.txt" };
          });
          await tool(session, state, asst, "edit", { path: resolve(cwd, "notes.txt"), oldString: "alpha", newString: "ALPHA" }, async () => ({
            text: "Edited notes.txt (1 replacement)",
            metadata: { files: [{ file: "notes.txt", status: "modified", additions: 1, deletions: 1, patch: "--- notes.txt\n+++ notes.txt\n@@ -1 +1 @@\n-alpha\n+ALPHA\n" }], truncated: false },
          }));
          await tool(session, state, asst, "read", { path: resolve(cwd, "missing.txt") }, async () => { throw new Error("File not found: missing.txt"); });
          await shellTool(session, state, asst, "echo done", { holdMs: 30 });
        } else if (has("hold") || has("long")) {
          await shellTool(session, state, asst, has("long") ? "ping -n 90 127.0.0.1" : "Start-Sleep -Seconds 1", { holdMs: has("long") ? undefined : Number(process.env.FAKE_OC_HOLD_MS ?? 700), hidden: has("hidden") });
        } else {
          await say(session, asst, "Working on it.", { think: true });
        }
      }, { finish: has("tools") || has("hold") || has("long") ? "tool-calls" : "stop" });

      if (has("tools") || has("hold") || has("long")) {
        // step 边界：收件箱里的纠偏在这里被取走。
        if (!has("nodrain")) drainInbox(session, state, false);
        await runStep(session, state, (asst) => say(session, asst, finalText(), { think: false }));
      } else if (!has("nodrain")) {
        drainInbox(session, state, false);
      }
      emit("session.execution.succeeded", { sessionID: session.id });
    } catch (error) {
      if (error instanceof Interrupted) {
        const tokens = { input: 64, output: 5, reasoning: 2, cache: { read: 10, write: 0 } };
        state.totals.input += tokens.input;
        emit("session.step.failed", { sessionID: session.id, assistantMessageID: state.step ?? "msg_x", error: { type: "aborted", message: "Step interrupted" }, rawFinish: "tool_calls", tokens, cost: 0 });
        emit("session.usage.updated", { sessionID: session.id, cost: state.totals.cost, tokens: { input: state.totals.input, output: state.totals.output, reasoning: state.totals.reasoning, cache: state.totals.cache } });
        emit("session.execution.interrupted", { sessionID: session.id, reason: error.reason ?? "user" });
      } else {
        emit("session.execution.failed", { sessionID: session.id, error: { type: "unknown", message: String(error.message ?? error) } });
      }
    } finally {
      state.running = false;
      state.step = undefined;
    }
  }
}
