import { mkdir, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { createExecutors } from "../server/executors";
import { ExecutorRegistry } from "../server/executors/registry";
import { ensureService, probeService, readServiceFile } from "../server/discovery";
import { createLogger, silentLogger } from "../server/logger";
import { openInSystemBrowser } from "../server/open-url";
import { pathsFor, resolveHome } from "../server/paths";
import { AlreadyRunningError, appVersion, locateWebRoot, startService } from "../server/service";
import { ServiceClient } from "../mcp/client";
import { runCursorLogin } from "./cursor-login";
import { defaultDeps, INSTALL_TARGETS, locatePluginRoot, runInstall, type InstallTarget } from "./install";
import { errorMessage, versionLabel } from "@shared/format";
import type { HarnessInfo, SessionSummary } from "@shared/types";

/**
 * 命令行入口（同一个文件既是本地服务，也是 MCP 桥）：
 *   serve    启动本地服务（通常由 MCP 桥按需拉起，不必手动运行）
 *   mcp      以 stdio 运行 MCP 桥（供 Codex / Cursor 等宿主调用）
 *   open     确保服务在运行，并在系统浏览器里打开面板
 *   status   查看服务与会话
 *   stop     停止本地服务（正在运行的会话会被中断）
 *   doctor   检查环境与各执行端是否可用
 *   install / uninstall   把插件装到 Codex、Cursor（需要确认；默认只展示计划）
 *   cursor-login          登录 Cursor（需要确认）
 */

const USAGE = `Ensemble ${appVersion()}

用法：ensemble <命令> [选项]
      （从源码目录运行时写作 node dist/ensemble.mjs <命令>）

命令
  serve [--port N] [--no-idle-exit] [--dev]   启动本地服务
  mcp                                           以 stdio 运行 MCP 桥
  open [会话 id]                                在浏览器中打开面板
  status                                        查看服务与会话
  stop                                          停止本地服务
  doctor                                        检查环境与各执行端
  install <codex|cursor|sdk>... [--all] [--dry-run] [--yes] [--force]
                                                把插件装到 Codex / Cursor，或把 @cursor/sdk 装到运行时目录
                                                （修改用户级配置，必须确认；先用 --dry-run 看计划）
  uninstall <codex|cursor>... [--all] [--dry-run] [--yes]
                                                移除由 install 装上的插件
  cursor-login [--status|--logout|--force|--yes]  登录 Cursor（会在你的账号里创建 API Key，需要确认）
  version                                       显示版本

环境变量
  ENSEMBLE_HOME        状态目录（默认在用户本地数据目录下的 Ensemble）
  ENSEMBLE_PORT        服务端口（默认 47821，被占用时自动换用空闲端口）
  ENSEMBLE_AUTO_OPEN   设为 system 时，MCP 桥在第一次委派时打开系统浏览器
  ENSEMBLE_FIXTURE     开发用：把列出的执行端换成模拟器（界面会标注“模拟”）
  CURSOR_API_KEY       Cursor 的 API Key；设置后优先于 cursor-login 保存的登录
  ENSEMBLE_CURSOR_SDK  已安装 @cursor/sdk 的目录（含 node_modules，或包目录本身）
  ENSEMBLE_CURSOR_SETTINGS  Cursor 会话读取哪些设置层：none|project|user|team|mdm|plugins|all（默认 project）
  ENSEMBLE_CLAUDE_BIN  Claude Code 可执行文件的路径（默认从 PATH 查找）
  ENSEMBLE_OPENCODE_BIN  OpenCode 可执行文件的路径（默认依次找 PATH、npm 全局目录与官方安装目录）
  ENSEMBLE_DSH_BIN  DSH（DeepSeek Harness）可执行文件或其 JS 入口的路径（默认依次找 PATH 与 npm 全局目录）
`;

interface Parsed {
  command: string;
  flags: Map<string, string | true>;
  rest: string[];
}

function parse(argv: readonly string[]): Parsed {
  const [command = "help", ...tokens] = argv;
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    if (token.startsWith("--")) {
      const [name, inline] = token.slice(2).split("=", 2) as [string, string | undefined];
      const next = tokens[i + 1];
      if (inline !== undefined) flags.set(name, inline);
      else if (next !== undefined && !next.startsWith("--") && ["port"].includes(name)) {
        flags.set(name, next);
        i += 1;
      } else flags.set(name, true);
    } else rest.push(token);
  }
  return { command, flags, rest };
}

const out = (text = ""): void => void process.stdout.write(`${text}\n`);
const err = (text = ""): void => void process.stderr.write(`${text}\n`);

async function serve(flags: Parsed["flags"]): Promise<number> {
  const home = resolveHome();
  const portFlag = flags.get("port");
  const port = typeof portFlag === "string" ? Number(portFlag) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    err(`无效的端口：${String(portFlag)}`);
    return 2;
  }
  try {
    const service = await startService({
      home,
      handleSignals: true,
      exitOnClose: true,
      dev: flags.has("dev"),
      ...(port !== undefined ? { port } : {}),
      ...(flags.has("no-idle-exit") ? { idleExitMs: 0 } : {}),
    });
    err(`Ensemble ${appVersion()} 已启动：${service.url}`);
    await service.closed;
    return 0;
  } catch (error) {
    if (error instanceof AlreadyRunningError) {
      err(`Ensemble 已在运行：${error.info.url}`);
      return 0;
    }
    throw error;
  }
}

async function runMcp(): Promise<number> {
  const paths = pathsFor(resolveHome());
  const logger = createLogger(
    { file: join(paths.logs, "mcp-bridge.log"), level: process.env["ENSEMBLE_LOG_LEVEL"] === "debug" ? "debug" : "info", stderr: process.env["ENSEMBLE_LOG_STDERR"] === "1" },
    "mcp",
  );
  process.on("uncaughtException", (error) => {
    logger.error("uncaught exception in the MCP bridge", { error });
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => logger.error("unhandled rejection in the MCP bridge", { reason }));
  const { runBridge } = await import("../mcp/bridge");
  await runBridge({
    paths,
    version: appVersion(),
    cwd: process.cwd(),
    log: (message, fields) => logger.info(message, fields),
  });
  logger.info("mcp bridge ready", { pid: process.pid });
  // 保持进程存活：stdio 传输会在管道关闭时让进程退出。
  return await new Promise<number>(() => undefined);
}

async function openPanel(rest: readonly string[]): Promise<number> {
  const paths = pathsFor(resolveHome());
  const file = await ensureService({ paths });
  const url = rest[0] ? `${file.url}/#/s/${encodeURIComponent(rest[0])}` : `${file.url}/`;
  try {
    openInSystemBrowser(url);
  } catch (error) {
    err(`无法自动打开浏览器：${errorMessage(error)}`);
  }
  out(url);
  return 0;
}

async function runningService() {
  const paths = pathsFor(resolveHome());
  const file = await readServiceFile(paths);
  if (!file || !(await probeService(file))) return undefined;
  return { paths, file, client: new ServiceClient({ paths, ensure: async () => file }) };
}

async function status(): Promise<number> {
  const running = await runningService();
  if (!running) {
    out("Ensemble 服务未运行（有委派时会由 MCP 桥自动启动）。");
    return 1;
  }
  const { sessions } = await running.client.request<{ sessions: SessionSummary[] }>("GET", "/api/sessions");
  out(`Ensemble ${running.file.version} 运行中 · ${running.file.url} · pid ${running.file.pid}`);
  const byPhase = new Map<string, number>();
  for (const session of sessions) byPhase.set(session.phase, (byPhase.get(session.phase) ?? 0) + 1);
  out(sessions.length === 0 ? "还没有会话。" : `${sessions.length} 个会话：${[...byPhase].map(([phase, count]) => `${phase} ${count}`).join("，")}`);
  for (const session of [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 12)) {
    out(`  ${session.id}  ${session.harness.padEnd(8)} ${session.phase.padEnd(9)} ${session.title}`);
  }
  return 0;
}

async function stop(): Promise<number> {
  const running = await runningService();
  if (!running) {
    out("Ensemble 服务没有在运行。");
    return 0;
  }
  await running.client.request("POST", "/api/shutdown", { body: {}, timeoutMs: 10_000 });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await probeService(running.file, 500))) {
      out("已停止。");
      return 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  err("已请求停止，但服务仍在响应。");
  return 1;
}

function harnessLine(info: HarnessInfo): string {
  const icon = info.status === "ready" ? "✓" : info.status === "needs_setup" ? "!" : "✗";
  const bits = [info.status, info.version ? versionLabel(info.version) : undefined, info.runtime === "fixture" ? "模拟" : undefined, info.account].filter(Boolean);
  const lines = [` ${icon} ${info.displayName.padEnd(14)} ${bits.join(" · ")}`];
  if (info.status === "ready") {
    lines.push(`     模型：${info.models.length > 0 ? `${info.models.length} 个${info.defaultModel ? `，默认 ${info.defaultModel}` : ""}` : "未列出"}`);
  }
  if (info.setup) lines.push(`     ${info.setup.message}${info.setup.command ? `\n     → ${info.setup.command}` : ""}`);
  return lines.join("\n");
}

const isInteractive = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);

async function ask(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^(y|yes|是|好)$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

async function cursorLogin(flags: Parsed["flags"]): Promise<number> {
  return runCursorLogin({
    flags: new Set(flags.keys()),
    env: process.env,
    runtimeDir: pathsFor(resolveHome()).runtime,
    io: { out, err, interactive: isInteractive(), confirm: ask },
  });
}

async function installPlugin(mode: "install" | "uninstall", flags: Parsed["flags"], rest: readonly string[]): Promise<number> {
  const unknown = rest.filter((item) => !INSTALL_TARGETS.includes(item as InstallTarget));
  if (unknown.length > 0) {
    err(`未知的目标：${unknown.join("、")}（可选：${INSTALL_TARGETS.join(" | ")}）`);
    return 2;
  }
  const pluginRoot = locatePluginRoot();
  if (!pluginRoot) {
    err("找不到插件根目录（需要同时有 plugin.json 与 mcp.json）；请从完整的插件目录运行。");
    return 1;
  }
  const targets = flags.has("all") ? [...INSTALL_TARGETS] : (rest as InstallTarget[]);
  return runInstall({
    mode,
    targets,
    flags: new Set(flags.keys()),
    deps: defaultDeps({ pluginRoot, userHome: homedir(), runtimeDir: pathsFor(resolveHome()).runtime, version: appVersion() }),
    io: { out, err, interactive: isInteractive(), confirm: ask },
    serviceRunning: (await runningService()) !== undefined,
  });
}

async function doctor(): Promise<number> {
  const paths = pathsFor(resolveHome());
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const nodeOk = major > 22 || (major === 22 && minor >= 13);
  out(`Ensemble ${appVersion()} · Node ${process.version} · ${process.platform}`);
  out(`${nodeOk ? "✓" : "✗"} Node 版本${nodeOk ? "" : "（需要 22.13 或更高）"}`);

  try {
    await mkdir(paths.home, { recursive: true });
    const probe = join(paths.home, `.doctor-${process.pid}`);
    await writeFile(probe, "ok");
    await rm(probe, { force: true });
    out(`✓ 状态目录可写：${paths.home}`);
  } catch (error) {
    out(`✗ 状态目录不可写：${paths.home}（${errorMessage(error)}）`);
  }

  const webRoot = locateWebRoot();
  out(webRoot ? `✓ 网页界面已构建：${webRoot}` : "✗ 没有找到网页界面（dist/web）；请运行 npm run build");

  const running = await runningService();
  out(running ? `✓ 本地服务运行中：${running.file.url}（pid ${running.file.pid}）` : "· 本地服务未运行（有委派时会自动启动）");

  out();
  out("执行端");
  const registry = new ExecutorRegistry(createExecutors({ env: process.env, paths, log: silentLogger }), silentLogger);
  const infos = await registry.all({ force: true });
  for (const info of infos) out(harnessLine(info));
  return infos.some((info) => info.status === "ready") && nodeOk ? 0 : 1;
}

export async function main(argv: readonly string[]): Promise<number> {
  const { command, flags, rest } = parse(argv);
  switch (command) {
    case "serve":
      return serve(flags);
    case "mcp":
      return runMcp();
    case "open":
      return openPanel(rest);
    case "status":
      return status();
    case "stop":
      return stop();
    case "doctor":
      return doctor();
    case "cursor-login":
      return cursorLogin(flags);
    case "install":
    case "uninstall":
      return installPlugin(command, flags, rest);
    case "version":
    case "--version":
      out(appVersion());
      return 0;
    case "help":
    case "--help":
    case "-h":
      out(USAGE);
      return 0;
    default:
      err(`未知命令：${command}\n`);
      err(USAGE);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    err(`出错了：${errorMessage(error)}`);
    process.exit(1);
  },
);
