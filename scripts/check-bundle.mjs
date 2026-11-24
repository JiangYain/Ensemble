// 对已构建的 dist/ensemble.mjs 做端到端自检（不触碰你的真实状态目录、不调用任何真实模型）：
//  1. 以 stdio 方式拉起 MCP 桥，让它按需把本地服务作为独立进程启动；
//  2. 用模拟执行端走一遍 harnesses → delegate → wait → read；
//  3. 确认网页界面与 API 在同一个地址上；
//  4. 关闭桥后服务仍然活着（桥退出不会主动停止服务；宿主若自己清理整棵进程树则另当别论），最后停止服务并清理。
//
//   node scripts/check-bundle.mjs
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "dist", "ensemble.mjs");
if (!existsSync(entry)) {
  console.error("dist/ensemble.mjs 不存在，请先运行 npm run build");
  process.exit(2);
}

const home = mkdtempSync(join(tmpdir(), "ensemble-check-"));
const env = { ...process.env, ENSEMBLE_HOME: home, ENSEMBLE_FIXTURE: "pi,cursor,codex", ENSEMBLE_FIXTURE_SPEED: "0", ENSEMBLE_PORT: "0", ENSEMBLE_IDLE_EXIT_MS: "0" };

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${!ok && detail ? `\n    ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

const run = (command, args) =>
  new Promise((resolve) => {
    import("node:child_process").then(({ execFile }) => execFile(command, args, { env, cwd: root }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
  });

let client;
try {
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, "mcp"], env, cwd: tmpdir(), stderr: "pipe" });
  client = new Client({ name: "codex-mcp-client", version: "check" });
  await client.connect(transport);

  const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
  check("MCP 桥列出 8 个工具", tools.join() === "cancel,delegate,harnesses,open_panel,read,send,status,wait", tools.join());

  const text = (result) => result.content.map((part) => part.text).join("\n");

  const harnesses = text(await client.callTool({ name: "harnesses", arguments: {} }));
  check("按需拉起了本地服务并列出执行端", /pi — /.test(harnesses) && /simulated/.test(harnesses), harnesses.slice(0, 300));

  const delegated = await client.callTool({ name: "delegate", arguments: { harness: "pi", task: "[fixture:quick] bundle check", cwd: tmpdir() } });
  const sessionId = delegated.structuredContent?.sessionId;
  const panelUrl = delegated.structuredContent?.panelUrl;
  check("delegate 立即返回会话 id 与面板地址", typeof sessionId === "string" && typeof panelUrl === "string", text(delegated).slice(0, 300));

  const waited = text(await client.callTool({ name: "wait", arguments: { timeoutSeconds: 15 } }));
  check("wait 返回会话已完成", /finished/.test(waited), waited.slice(0, 300));

  const read = text(await client.callTool({ name: "read", arguments: { sessionId } }));
  check("read 返回最终回答", /Final answer:/.test(read), read.slice(0, 300));

  const base = new URL(panelUrl).origin;
  const health = await fetch(`${base}/api/health`).then((response) => response.json());
  check("服务健康检查", health.ok === true && health.service === "ensemble");

  const page = await fetch(`${base}/`);
  const html = await page.text();
  check("同一地址提供网页界面", page.ok && /<div id="root">/.test(html) && html.includes('name="ensemble-token"'), `HTTP ${page.status} ${html.slice(0, 120)}`);
  const token = /name="ensemble-token" content="([^"]+)"/.exec(html)?.[1];
  check("网页拿到了访问令牌", Boolean(token));

  await client.close();
  client = undefined;
  await new Promise((resolve) => setTimeout(resolve, 600));
  const stillUp = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
  check("关闭 MCP 桥后服务仍在运行", stillUp);

  const status = await run(process.execPath, [entry, "status"]);
  check("status 命令能看到会话", status.code === 0 && status.stdout.includes(sessionId), status.stdout + status.stderr);

  const stop = await run(process.execPath, [entry, "stop"]);
  check("stop 命令停止服务", stop.code === 0, stop.stdout + stop.stderr);
  const gone = await fetch(`${base}/api/health`).then(() => false).catch(() => true);
  check("服务已退出", gone);
} catch (error) {
  check("自检过程没有抛出异常", false, error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  await client?.close().catch(() => undefined);
  await run(process.execPath, [entry, "stop"]).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 300));
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} 项未通过`);
  process.exit(1);
}
console.log("\n全部通过");
