// 对“将要发布到 npm 的那份包”做端到端自检。全程在临时目录里进行：不碰你真实的 Ensemble 状态目录、
// 用户主目录里的 Cursor / Codex 配置、全局 npm 前缀与 npm 缓存，也不调用任何真实模型。
//
//  1. npm pack：核对包里有什么、没有什么，以及大小；
//  2. 像用户那样安装它（npm install -g --prefix <临时目录> <tgz>），通过 npm 生成的命令运行 version / doctor；
//  3. 像 npx 那样运行同一个包（npm exec）；
//  4. 用它把插件装进一个临时的“用户主目录”（install cursor），确认装出来的插件是自包含的：拉起它的 MCP 桥，列出 8 个工具，
//     再让桥拉起本地服务，用模拟执行端走一遍 delegate → wait → read，并确认同一个地址提供网页；
//  5. uninstall 把它清干净。
//
//   node scripts/check-package.mjs            检查包与安装流程
//   node scripts/check-package.mjs --clean    发布前用（npm publish 会自动带上）：另外要求工作区没有未提交的改动，
//                                             保证发布出去的就是仓库里的这份
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const flags = new Set(process.argv.slice(2));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const isWindows = process.platform === "win32";

const failures = [];
function check(name, ok, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${!ok && detail ? `\n    ${String(detail).trim().split("\n").join("\n    ")}` : ""}`);
  if (!ok) failures.push(name);
  return ok;
}

for (const required of [join("dist", "ensemble.mjs"), join("dist", "web", "index.html"), join("dist", "THIRD-PARTY-NOTICES.txt")]) {
  if (!existsSync(join(root, required))) {
    console.error(`${required} 不存在，请先运行 npm run build`);
    process.exit(2);
  }
}

function findNpmCli() {
  const candidates = [process.env["npm_execpath"], join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"), join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")];
  return candidates.find((candidate) => candidate && /npm-cli\.c?js$/i.test(candidate) && existsSync(candidate));
}
const npmCli = findNpmCli();
if (!npmCli) {
  console.error("找不到 npm（需要 Node 自带的 npm）");
  process.exit(2);
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolve) => {
    execFile(command, commandArgs, { cwd: root, maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 240_000, ...options }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) + (error && typeof error.code !== "number" ? String(error.message) : "") });
    });
  });
}

const tmp = mkdtempSync(join(tmpdir(), "ensemble-package-"));
const dirs = { pack: join(tmp, "pack"), global: join(tmp, "global"), cache: join(tmp, "npm-cache"), home: join(tmp, "home"), state: join(tmp, "state") };
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });

// 子进程的环境：用户主目录、状态目录都指向临时目录；模拟执行端；把外层 npm 注入的配置去掉（比如 publish --dry-run
// 会让内层的 npm 也变成 dry run）。
const env = { ...process.env, HOME: dirs.home, USERPROFILE: dirs.home, ENSEMBLE_HOME: dirs.state, ENSEMBLE_FIXTURE: "pi,cursor,codex", ENSEMBLE_FIXTURE_SPEED: "0", ENSEMBLE_PORT: "0", ENSEMBLE_IDLE_EXIT_MS: "0" };
for (const key of Object.keys(env)) if (/^(npm_config_|npm_lifecycle_|npm_package_|npm_command$|npm_execpath$|npm_node_execpath$)/i.test(key)) delete env[key];
for (const key of ["CURSOR_API_KEY", "ENSEMBLE_CURSOR_SDK", "ENSEMBLE_WEB_ROOT"]) delete env[key];

const npm = (npmArgs, options = {}) => run(process.execPath, [npmCli, ...npmArgs], { env, ...options });

/** 通过 npm 为 bin 生成的命令运行（Windows 上是 ensemble.cmd，其它系统是 bin 下的符号链接）。 */
let shim = "";
function ensemble(commandArgs) {
  if (isWindows) {
    const line = `""${shim}" ${commandArgs.join(" ")}"`;
    return run(process.env["ComSpec"] ?? "cmd.exe", ["/d", "/s", "/c", line], { env, cwd: tmp, windowsVerbatimArguments: true });
  }
  return run(shim, commandArgs, { env, cwd: tmp });
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

try {
  if (flags.has("--clean")) {
    const status = await run("git", ["status", "--porcelain"]);
    check("工作区没有未提交的改动（发布出去的就是仓库里的这份）", status.code === 0 && status.stdout.trim() === "", status.code === 0 ? status.stdout.split("\n").slice(0, 10).join("\n") : `不是 git 工作区，或没有安装 git：${status.stderr}`);
  }

  // ── 1. 包里有什么 ──
  const packed = await npm(["pack", "--json", "--ignore-scripts", "--pack-destination", dirs.pack]);
  let info;
  try {
    info = JSON.parse(packed.stdout)[0];
  } catch {
    // 下面统一报错
  }
  if (!check("npm pack 成功", packed.code === 0 && Boolean(info), packed.stderr.slice(-600) || packed.stdout.slice(-600))) throw new Error("没有打出包，后面的检查无从谈起");

  const paths = new Set(info.files.map((file) => file.path));
  const required = [
    "package.json",
    "README.md",
    "LICENSE",
    "NOTICE",
    "plugin.json",
    "mcp.json",
    ".mcp.json",
    ".cursor-plugin/plugin.json",
    "skills/ensemble-delegate/SKILL.md",
    "skills/ensemble-delegate/scripts/watch.mjs",
    "assets/icon.svg",
    "assets/logo.svg",
    "dist/ensemble.mjs",
    "dist/web/index.html",
    "dist/THIRD-PARTY-NOTICES.txt",
  ];
  const missing = required.filter((path) => !paths.has(path));
  check("包里有插件需要的全部文件（清单、MCP 配置、Skill、资源、dist、许可证与第三方声明）", missing.length === 0, `缺少：${missing.join("、")}`);

  const forbidden = [...paths].filter((path) => /^(src|test|vendor|scripts|docs|node_modules|\.tmp|\.git|\.github)(\/|$)/.test(path) || /\.map$/.test(path) || /^(agents|claude)\.md$/i.test(path) || /\.(mp4|mov)$/i.test(path) || /^\.env/.test(path) || /^tsconfig/.test(path));
  check("包里没有源码、测试、vendor、构建脚本、source map 与私有文件", forbidden.length === 0, `不该出现：${forbidden.slice(0, 10).join("、")}`);

  check("包的名字与版本和 package.json 一致", info.name === pkg.name && info.version === pkg.version, `${info.name}@${info.version}`);
  check(`压缩后小于 3 MB、展开后小于 8 MB（实际 ${(info.size / 1048576).toFixed(2)} MB / ${(info.unpackedSize / 1048576).toFixed(2)} MB，${info.entryCount} 个文件）`, info.size < 3 * 1048576 && info.unpackedSize < 8 * 1048576);

  // ── 2. 像用户那样安装 ──
  const tarball = join(dirs.pack, info.filename);
  const installed = await npm(["install", "-g", "--prefix", dirs.global, "--cache", dirs.cache, "--offline", "--no-audit", "--no-fund", "--ignore-scripts", tarball]);
  const packageDir = isWindows ? join(dirs.global, "node_modules", ...pkg.name.split("/")) : join(dirs.global, "lib", "node_modules", ...pkg.name.split("/"));
  shim = isWindows ? join(dirs.global, "ensemble.cmd") : join(dirs.global, "bin", "ensemble");
  if (!check("npm install -g 安装成功，并生成了 ensemble 命令", installed.code === 0 && existsSync(shim) && existsSync(join(packageDir, "dist", "ensemble.mjs")), installed.stderr.slice(-600))) throw new Error("安装失败，后面的检查无从谈起");
  check("安装出来的 dist/ensemble.mjs 与仓库里的逐字节相同", sha256(join(packageDir, "dist", "ensemble.mjs")) === sha256(join(root, "dist", "ensemble.mjs")));
  // 全局安装时 npm 把依赖放在包目录自己的 node_modules 里；这个包不该有任何依赖（@cursor/sdk 不随包分发）。
  check("安装这个包没有拉进任何依赖（包目录里没有 node_modules）", !existsSync(join(packageDir, "node_modules")));

  const version = await ensemble(["version"]);
  check("通过 npm 生成的命令运行 ensemble version", version.code === 0 && version.stdout.trim() === pkg.version, `${version.stdout}${version.stderr}`);

  const doctor = await ensemble(["doctor"]);
  check("ensemble doctor 在安装位置找到了网页界面", doctor.code === 0 && doctor.stdout.includes("网页界面已构建") && doctor.stdout.includes(join("node_modules", ...pkg.name.split("/"), "dist", "web")), `${doctor.stdout}${doctor.stderr}`.slice(0, 700));

  // ── 3. 像 npx 那样运行 ──
  // 包规格用 file: 形式：npm 对 Windows 的绝对路径（C:\…）不会报错，却什么也不运行。
  // 不指定命令名，只给包规格：npm 会运行包里唯一的那个 bin（与 `npx <包名> …` 相同）。
  const spec = `file:${tarball.split("\\").join("/")}`;
  const exec = await npm(["exec", "--yes", "--cache", dirs.cache, "--offline", "--", spec, "version"], { cwd: tmp });
  check("npx 方式运行同一个包（npm exec -- <包> version，不指定命令名）", exec.code === 0 && exec.stdout.trim() === pkg.version, `${exec.code} ${exec.stdout}${exec.stderr}`.slice(-600));

  // ── 4. 用它安装插件 ──
  const pluginDir = join(dirs.home, ".cursor", "plugins", "local", "ensemble");
  const dry = await ensemble(["install", "cursor", "--dry-run"]);
  check("install cursor --dry-run 只展示计划，不写任何东西", dry.code === 0 && dry.stdout.includes(pluginDir) && !existsSync(pluginDir), `${dry.stdout}${dry.stderr}`.slice(0, 500));

  const dryCodex = await ensemble(["install", "codex", "--dry-run"]);
  check("install codex --dry-run 只展示计划", dryCodex.code === 0 && dryCodex.stdout.includes("codex plugin add") && !existsSync(join(dirs.home, "plugins")), `${dryCodex.stdout}${dryCodex.stderr}`.slice(0, 500));

  const refused = await ensemble(["install", "cursor"]);
  check("不带 --yes 且无法交互确认时拒绝修改（退出码 2）", refused.code === 2 && !existsSync(pluginDir), `${refused.code} ${refused.stdout}${refused.stderr}`.slice(0, 400));

  const real = await ensemble(["install", "cursor", "--yes"]);
  check("install cursor --yes 成功", real.code === 0 && existsSync(pluginDir), `${real.stdout}${real.stderr}`.slice(0, 600));

  const copied = ["plugin.json", "mcp.json", ".mcp.json", ".cursor-plugin/plugin.json", "skills/ensemble-delegate/SKILL.md", "skills/ensemble-delegate/scripts/watch.mjs", "assets/icon.svg", "assets/logo.svg", "dist/ensemble.mjs", "dist/web/index.html", "dist/THIRD-PARTY-NOTICES.txt", "README.md", "LICENSE", "NOTICE", ".ensemble-install.json"];
  const notCopied = copied.filter((path) => !existsSync(join(pluginDir, path)));
  check("装出来的插件目录里有全部文件（含第三方声明、LICENSE 与 NOTICE）", notCopied.length === 0, `缺少：${notCopied.join("、")}`);
  check("装出来的插件目录里没有 package.json、源码与 node_modules", !["package.json", "src", "node_modules", "vendor"].some((path) => existsSync(join(pluginDir, path))));

  let marker;
  try {
    marker = JSON.parse(readFileSync(join(pluginDir, ".ensemble-install.json"), "utf8"));
  } catch {
    // 下面统一报错
  }
  check("安装标记记录了名字与版本", marker?.name === "ensemble" && marker?.version === pkg.version, JSON.stringify(marker));

  // 装出来的那份要能独立运行（它所在的目录往上没有 node_modules）：宿主启动的就是这份里的桥，
  // 桥再把本地服务作为独立进程拉起（用的也是这份里的 dist/ensemble.mjs 与 dist/web）。走一遍模拟执行端的委派。
  let client;
  try {
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(pluginDir, "dist", "ensemble.mjs"), "mcp"], env, cwd: tmp, stderr: "pipe" });
    client = new Client({ name: "codex-mcp-client", version: "check" });
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    check("插件副本里的 MCP 桥能启动，并列出 8 个工具", tools.join() === "cancel,delegate,harnesses,open_panel,read,send,status,wait", tools.join());

    const text = (result) => result.content.map((part) => part.text).join("\n");
    const harnesses = text(await client.callTool({ name: "harnesses", arguments: {} }));
    check("桥按需拉起了本地服务，并列出（模拟的）执行端", /pi — /.test(harnesses) && /simulated/.test(harnesses), harnesses.slice(0, 300));

    const delegated = await client.callTool({ name: "delegate", arguments: { harness: "pi", task: "[fixture:quick] package check", cwd: tmp } });
    const sessionId = delegated.structuredContent?.sessionId;
    const panelUrl = delegated.structuredContent?.panelUrl;
    check("delegate 立即返回会话 id 与面板地址", typeof sessionId === "string" && typeof panelUrl === "string", text(delegated).slice(0, 300));

    const waited = text(await client.callTool({ name: "wait", arguments: { timeoutSeconds: 15 } }));
    check("wait 返回会话已完成", /finished/.test(waited), waited.slice(0, 300));
    const read = text(await client.callTool({ name: "read", arguments: { sessionId } }));
    check("read 返回最终回答", /Final answer:/.test(read), read.slice(0, 300));

    if (typeof panelUrl === "string") {
      const page = await fetch(`${new URL(panelUrl).origin}/`);
      const html = await page.text();
      check("同一个地址提供了网页界面", page.ok && /<div id="root">/.test(html) && html.includes('name="ensemble-token"'), `HTTP ${page.status} ${html.slice(0, 120)}`);
    }
  } finally {
    await client?.close().catch(() => undefined);
  }

  // 服务是插件副本拉起的，卸载之前先把它停掉（它还开着这个目录里的文件）。
  const stopped = await ensemble(["stop"]);
  check("ensemble stop 停掉了它拉起的服务", stopped.code === 0, `${stopped.stdout}${stopped.stderr}`.slice(0, 300));

  // ── 5. 卸载 ──
  const removed = await ensemble(["uninstall", "cursor", "--yes"]);
  check("uninstall cursor --yes 把插件目录清理干净", removed.code === 0 && !existsSync(pluginDir), `${removed.stdout}${removed.stderr}`.slice(0, 400));
} catch (error) {
  check("自检过程没有中断", false, error instanceof Error ? error.message : String(error));
} finally {
  if (shim) await ensemble(["stop"]).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 300));
  rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} 项未通过`);
  process.exit(1);
}
console.log("\n全部通过");
