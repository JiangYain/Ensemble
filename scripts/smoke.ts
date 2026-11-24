/**
 * 真实执行端冒烟：通过真实的适配器 + 管理器 + 事件中枢，对一个真实 Harness 做极小的端到端检查。
 * 只在你显式运行时才会产生模型调用与费用，请选择便宜的模型并使用空的临时目录。
 *
 *   npx tsx --tsconfig tsconfig.node.json scripts/smoke.ts pi --model deepseek/deepseek-v4-flash --effort off
 *   npx tsx --tsconfig tsconfig.node.json scripts/smoke.ts codex --model gpt-5.6-luna --effort low
 *   npx tsx --tsconfig tsconfig.node.json scripts/smoke.ts opencode --model opencode/deepseek-v4.1-flash-free
 *   npx tsx --tsconfig tsconfig.node.json scripts/smoke.ts dsh --model deepseek-official/deepseek-v4-flash --effort low
 *   选项：--only basic,followup,steer,readonly,fullaccess,cancel,resume   --model <id>   --effort <level>   --timeout <seconds>   --keep
 *
 * Codex 的冒烟会在你的 Codex 会话列表里留下以 “Ensemble · ” 开头的线程；结束时会按线程编号删除它们（--keep 则保留）。
 * fullaccess 场景会写入 %USERPROFILE%\ensemble-smoke-outside-*（工作目录和临时目录之外），结束时删除这些目录。
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { toSummary } from "@shared/projection";
import { testOrigin } from "@shared/testing";
import type { AccessLevel, Actor, HarnessId, ToolItem } from "@shared/types";
import { appServerArgs, CodexRpc, resolveCodexLaunch } from "../src/server/executors/codex-rpc";
import { createExecutors } from "../src/server/executors/index";
import { spawnJsonl } from "../src/server/executors/process";
import { silentLogger } from "../src/server/logger";
import { pathsFor, resolveHome } from "../src/server/paths";
import { makeEnv, until, type TestEnv } from "../src/server/testing";

const USER: Actor = { kind: "user", label: "smoke" };

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const harness = process.argv[2] as HarnessId | undefined;
if (!harness || harness.startsWith("--")) {
  console.error("usage: smoke.ts <pi|codex|cursor|opencode|dsh> [--model X] [--effort Y] [--only basic,steer,cancel] [--timeout 120]");
  process.exit(2);
}
const model = arg("model");
const effort = arg("effort");
const defaultScenarios = harness === "codex" || harness === "opencode" || harness === "dsh" ? "basic,followup,steer,readonly,fullaccess,cancel,resume" : "basic,followup,steer,fullaccess,cancel,resume";
const only = new Set((arg("only") ?? defaultScenarios).split(","));
const timeoutMs = Number(arg("timeout") ?? 120) * 1000;
const keepThreads = process.argv.includes("--keep");

// Cursor 适配器要用 paths.runtime 找 SDK；只是拼路径，不读写任何东西。
const paths = pathsFor(resolveHome(process.env));
const executors = createExecutors({
  env: process.env,
  paths,
  log: silentLogger,
}).filter((executor) => executor.id === harness);
if (executors.length === 0) {
  console.error(`No real adapter registered for "${harness}".`);
  process.exit(2);
}

const env: TestEnv = makeEnv(executors);
const stateIn = (e: TestEnv, id: string) => {
  const state = e.hub.state(id);
  if (!state) throw new Error("missing session");
  return state;
};
const stateOf = (id: string) => stateIn(env, id);
const toolsIn = (e: TestEnv, id: string): ToolItem[] => stateIn(e, id).timeline.filter((item): item is ToolItem => item.type === "tool");
const toolsOf = (id: string): ToolItem[] => toolsIn(env, id);

function line(text = ""): void {
  console.log(text);
}

function report(id: string, e: TestEnv = env): void {
  const state = stateIn(e, id);
  const summary = toSummary(state);
  line(`  model      : ${JSON.stringify(state.meta.model)} effort=${state.meta.effort ?? "-"}`);
  line(`  nativeRef  : ${JSON.stringify(state.meta.nativeRef)}`);
  line(`  status     : ${state.status} phase=${summary.phase}`);
  for (const run of state.runs) {
    line(`  run #${run.index}    : ${run.status}${run.stopReason ? ` (${run.stopReason})` : ""}${run.error ? ` error=${JSON.stringify(run.error)}` : ""} steer=${run.steerCount}`);
  }
  for (const tool of toolsIn(e, id)) {
    line(`  tool       : [${tool.category}] ${tool.name} → ${tool.status}${tool.exitCode !== undefined ? ` exit=${tool.exitCode}` : ""} · ${tool.title}${tool.files ? ` files=${JSON.stringify(tool.files.map((f) => `${f.change}:${f.path}`))}` : ""}`);
  }
  const assistant = state.timeline.filter((item) => item.type === "assistant");
  const last = assistant.at(-1);
  if (last && last.type === "assistant") line(`  answer     : (${last.phase ?? "?"}) ${last.text.replace(/\s+/g, " ").slice(0, 200)}`);
  for (const message of state.messages) {
    line(`  message    : ${message.kind} → ${message.delivery.history.map((h) => h.stage).join(" → ")}  | ${message.delivery.evidence ?? ""}`);
  }
  line(`  usage      : ${JSON.stringify(summary.usage)}`);
  const diagnostics = state.timeline.filter((item) => item.type === "diagnostic");
  for (const item of diagnostics) if (item.type === "diagnostic") line(`  diagnostic : [${item.level}] ${item.code} ${item.message}`);
}

const sessionsByScenario = new Map<string, string>();

/** 工作目录和临时目录之外的目录，用来验证 Full Access 会话可以直接写入、不会停下来等授权；结束时一并删除。 */
const outsideDirs: string[] = [];
function outsideDir(name: string): string {
  const dir = join(homedir(), `ensemble-smoke-outside-${name}`);
  outsideDirs.push(dir);
  return dir;
}

/**
 * attempts > 1：用于“是否发生取决于模型当次的决定”的场景。
 * 每次尝试都是全新的会话；只有最后一次尝试会被详细报告，前面失败的原因会如实打印出来。
 */
async function scenario(
  name: string,
  task: string,
  run: (sessionId: string, cwd: string) => Promise<void>,
  options: { access?: AccessLevel; attempts?: number } = {},
): Promise<boolean | undefined> {
  if (!only.has(name)) return undefined;
  line(`\n── ${name} ──`);
  const attempts = options.attempts ?? 1;
  let ok = false;
  for (let attempt = 1; attempt <= attempts && !ok; attempt++) {
    const cwd = mkdtempSync(join(tmpdir(), `ensemble-smoke-${name}-`));
    const started = Date.now();
    const { sessionId } = await env.manager.delegate({
      harness: harness!,
      task,
      cwd,
      origin: testOrigin(),
      ...(options.access ? { access: options.access } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    });
    sessionsByScenario.set(attempt === 1 ? name : `${name}#${attempt}`, sessionId);
    try {
      await run(sessionId, cwd);
      ok = true;
    } catch (error) {
      line(`  !! ${attempts > 1 ? `attempt ${attempt}/${attempts}: ` : ""}${error instanceof Error ? error.message : String(error)}`);
    }
    if (ok || attempt === attempts) {
      line(`  cwd        : ${cwd}`);
      line(`  elapsed    : ${((Date.now() - started) / 1000).toFixed(1)}s`);
      report(sessionId);
    }
  }
  return ok;
}

const terminal = (id: string, index = 0) => ["completed", "failed", "cancelled"].includes(stateOf(id).runs[index]?.status ?? "");

/** 删除冒烟留下的东西：沙箱外的测试目录，以及（除非 --keep）在 Codex 会话列表里创建的线程。 */
async function cleanup(): Promise<void> {
  for (const dir of outsideDirs) rmSync(dir, { recursive: true, force: true });
  if (harness !== "codex" || keepThreads) return;
  const ids = [
    ...new Set(
      [...sessionsByScenario.values()].flatMap((sessionId) => {
        const ref = env.hub.state(sessionId)?.meta.nativeRef;
        return ref?.kind === "codex-thread" ? [ref.id] : [];
      }),
    ),
  ];
  if (ids.length === 0) return;
  const launch = resolveCodexLaunch({ env: process.env });
  if (!launch) return;
  const proc = spawnJsonl(launch.command, appServerArgs(launch), { cwd: tmpdir(), env: process.env });
  const rpc: CodexRpc = new CodexRpc(proc, {
    onNotification: () => undefined,
    onServerRequest: (requestId, method) => rpc.respondError(requestId, -32601, `unsupported: ${method}`),
  });
  try {
    await rpc.request("initialize", { clientInfo: { name: "ensemble-smoke", title: "Ensemble smoke cleanup", version: "0.0.0" }, capabilities: { experimentalApi: false } }, 30_000);
    rpc.notify("initialized");
    for (const threadId of ids) {
      // 会话进程刚被结束时，线程可能还短暂地被它“占用着”（active writer）；稍等后重试。
      for (let attempt = 1; ; attempt++) {
        try {
          await rpc.request("thread/delete", { threadId }, 30_000);
          line(`cleanup: deleted Codex thread ${threadId}`);
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (attempt < 4 && /active writer/i.test(message)) {
            await new Promise((resolve) => setTimeout(resolve, 1_500));
            continue;
          }
          line(`cleanup: could not delete Codex thread ${threadId} (${message}) — look for "Ensemble · …" in your Codex history`);
          break;
        }
      }
    }
  } catch (error) {
    line(`cleanup: Codex threads were not deleted (${error instanceof Error ? error.message : String(error)})`);
  } finally {
    rpc.failAll(new Error("cleanup finished"));
    await proc.kill();
  }
}

async function main(): Promise<void> {
  const info = await env.registry.info(harness!, { force: true });
  line(`probe: status=${info?.status} version=${info?.version ?? "-"} account=${info?.account ?? "-"} default=${info?.defaultModel ?? "-"} models=${info?.models.length}`);
  if (info?.setup) line(`  setup: ${JSON.stringify(info.setup)}`);
  if (info?.status !== "ready") {
    line("The harness is not ready; skipping runs.");
    return;
  }

  const results: (boolean | undefined)[] = [];

  results.push(
    await scenario(
      "basic",
      "Create a file named hello.txt containing the single word hi, then edit it to say hello instead, then read it back and answer with one short sentence. Use the tools and keep it brief.",
      async (id) => {
        await until(() => terminal(id), timeoutMs, "run to finish");
        if (stateOf(id).runs[0]?.status !== "completed") throw new Error(`run ended as ${stateOf(id).runs[0]?.status}`);
        if (toolsOf(id).length === 0) throw new Error("no tool events were reported");
      },
    ),
  );

  // 同一个活着的会话里追加一条消息（运行已结束 → 作为新的运行继续，上下文要保留）。
  const basicSession = sessionsByScenario.get("basic");
  if (only.has("followup") && basicSession) {
    line("\n── followup ──");
    const started = Date.now();
    let ok = true;
    try {
      const sent = await env.manager.send(basicSession, {
        text: "Without using any tools: what single word does hello.txt contain now? Answer with just that word.",
        author: USER,
      });
      line(`  message sent  : kind=${sent.kind} stage=${sent.stage}`);
      if (sent.kind !== "follow_up") throw new Error(`expected a follow-up, got ${sent.kind}`);
      await until(() => stateOf(basicSession).runs.length === 2 && terminal(basicSession, 1), timeoutMs, "follow-up run to finish");
      const run = stateOf(basicSession).runs[1];
      const answer = [...stateOf(basicSession).timeline].reverse().find((item) => item.type === "assistant");
      const text = answer?.type === "assistant" ? answer.text : "";
      line(`  run #2        : ${run?.status} · answer: ${text.replace(/\s+/g, " ").slice(0, 120)}`);
      if (run?.status !== "completed") throw new Error(`follow-up run ended as ${run?.status}`);
      if (!/hello/i.test(text)) throw new Error(`the follow-up did not use the earlier context: "${text.slice(0, 160)}"`);
      const message = stateOf(basicSession).messages.find((m) => m.id === sent.messageId);
      line(`  delivery      : ${message?.delivery.history.map((h) => h.stage).join(" → ")}`);
    } catch (error) {
      ok = false;
      line(`  !! ${error instanceof Error ? error.message : String(error)}`);
    }
    line(`  elapsed       : ${((Date.now() - started) / 1000).toFixed(1)}s`);
    results.push(ok);
  }

  results.push(
    await scenario(
      "steer",
      "Run three separate shell commands, one per step: `echo one`, then `echo two`, then `echo three`. After each, wait for its result before the next. Then summarize in one sentence.",
      async (id) => {
        await until(() => toolsOf(id).length > 0, timeoutMs, "first tool");
        const sent = await env.manager.send(id, { text: "Also run `echo steered` as your very next command, before anything else.", author: USER, mode: "steer" });
        line(`  steer sent : kind=${sent.kind} stage=${sent.stage}`);
        await until(() => terminal(id), timeoutMs, "run to finish");
        const message = stateOf(id).messages.find((m) => m.id === sent.messageId);
        line(`  steer final: ${message?.delivery.stage} (${message?.delivery.evidence ?? "no evidence"})`);
        if (message?.delivery.stage !== "applied" && message?.delivery.stage !== "failed") throw new Error(`steer is stuck in ${message?.delivery.stage}`);
      },
    ),
  );

  results.push(
    await scenario(
      "readonly",
      "Create a file named blocked.txt in the current directory containing the word hi. If you are not able to, say so in one short sentence and do not try any workaround.",
      async (id, cwd) => {
        await until(() => terminal(id), timeoutMs, "run to finish");
        if (stateOf(id).runs[0]?.status !== "completed") throw new Error(`run ended as ${stateOf(id).runs[0]?.status}`);
        const enforcement = stateOf(id).meta.accessEnforcement;
        line(`  access     : ${enforcement?.level} — ${enforcement?.mechanism}`);
        if (existsSync(join(cwd, "blocked.txt"))) throw new Error("the read-only sandbox let a file be written");
        if (enforcement?.level !== "enforced") throw new Error(`access enforcement was reported as ${enforcement?.level}`);
      },
      { access: "read_only" },
    ),
  );

  // 默认就是 Full Access：写入工作目录之外的位置时不会停下来等任何人批准，运行一路走到结束。
  const outside = outsideDir("fullaccess");
  rmSync(outside, { recursive: true, force: true });
  results.push(
    await scenario(
      "fullaccess",
      `Using one shell command, create the folder ${outside} if it does not exist and write a file named note.txt inside it containing the word ok. Keep it brief.`,
      async (id) => {
        const meta = stateOf(id).meta;
        line(`  access     : ${meta.access} — ${meta.accessEnforcement?.mechanism ?? "no enforcement note"}`);
        if (meta.access !== "full") throw new Error(`the session was not Full Access (${meta.access})`);
        await until(() => terminal(id), timeoutMs, "run to finish without waiting for anyone");
        if (stateOf(id).runs[0]?.status !== "completed") throw new Error(`run ended as ${stateOf(id).runs[0]?.status}`);
        if (!existsSync(join(outside, "note.txt"))) throw new Error("the file outside the workspace was not written");
        // 兜底通道（Codex 仍然发来授权请求时由适配器自动放行）只是例外，出现就如实提示。
        const fallbacks = stateOf(id).timeline.filter((item) => item.type === "diagnostic" && (item.code.startsWith("codex.approval_") || item.code.startsWith("dsh.approval_")));
        if (fallbacks.length > 0) line(`  note       : the harness still sent ${fallbacks.length} approval request(s); the adapter answered them automatically`);
        line("  verified   : the file exists outside the workspace and the run never waited for approval");
      },
    ),
  );

  results.push(
    await scenario(
      "cancel",
      "Run this exact shell command and wait for it to finish: node -e \"setTimeout(()=>{},60000)\"",
      async (id) => {
        await until(() => toolsOf(id).some((t) => t.status === "running"), timeoutMs, "long tool to start");
        await env.manager.cancel(id, USER);
        await until(() => terminal(id), 30_000, "run to cancel");
        if (stateOf(id).runs[0]?.status !== "cancelled") throw new Error(`run ended as ${stateOf(id).runs[0]?.status}`);
        if (stateOf(id).status !== "idle") throw new Error(`session status is ${stateOf(id).status}`);
      },
    ),
  );

  // 模拟“服务重启”：同一份事件存储 → 新的中枢与管理器 → 重放 → 会话被标为 lost → 再发消息触发原生会话恢复。
  const basicId = sessionsByScenario.get("basic");
  if (only.has("resume") && basicId) {
    line("\n── resume ──");
    const started = Date.now();
    // 先让旧的管理器优雅退出（结束旧的执行端进程，会话被标为 lost），再用同一份存储起一个新的。
    await env.manager.shutdown();
    const restarted = makeEnv(createExecutors({ env: process.env, paths, log: silentLogger }).filter((e) => e.id === harness), {}, env.store);
    let ok = true;
    try {
      await restarted.hub.load();
      restarted.manager.reconcileAfterRestart();
      line(`  after restart : status=${stateIn(restarted, basicId).status}`);
      const sent = await restarted.manager.send(basicId, {
        text: "Without using any tools: which file did you create in this conversation earlier, and what does it contain now? Answer in one short sentence.",
        author: USER,
      });
      line(`  message sent  : kind=${sent.kind} stage=${sent.stage}`);
      await until(() => ["completed", "failed", "cancelled"].includes(stateIn(restarted, basicId).runs.at(-1)?.status ?? ""), timeoutMs, "resumed run to finish");
      const state = stateIn(restarted, basicId);
      const answer = [...state.timeline].reverse().find((item) => item.type === "assistant");
      const text = answer?.type === "assistant" ? answer.text : "";
      if (state.runs.at(-1)?.status !== "completed") throw new Error(`resumed run ended as ${state.runs.at(-1)?.status}: ${JSON.stringify(state.runs.at(-1)?.error)}`);
      if (!/hello/i.test(text)) throw new Error(`the resumed session did not remember the earlier conversation: "${text.slice(0, 160)}"`);
    } catch (error) {
      ok = false;
      line(`  !! ${error instanceof Error ? error.message : String(error)}`);
    }
    line(`  elapsed       : ${((Date.now() - started) / 1000).toFixed(1)}s`);
    report(basicId, restarted);
    await restarted.manager.shutdown().catch(() => undefined);
    results.push(ok);
  }

  const ran = results.filter((r): r is boolean => r !== undefined);
  line(`\nresult: ${ran.every(Boolean) ? "ALL PASSED" : "SOME FAILED"} (${ran.filter(Boolean).length}/${ran.length})`);
  if (!ran.every(Boolean)) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await env.manager.shutdown().catch(() => undefined);
    await cleanup().catch((error: unknown) => console.error("cleanup failed:", error));
    process.exit(process.exitCode ?? 0);
  });
