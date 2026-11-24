import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile, copyFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CURSOR_SDK_VERSION } from "@shared/constants";
import { errorMessage } from "@shared/format";
import { resolveCodexLaunch } from "../server/executors/codex-rpc";
import { runCapture, type CaptureResult } from "../server/executors/process";

/**
 * 把本插件安装到宿主里。
 *
 * 这些操作都会写到用户级的位置（Codex 的个人市场、Cursor 的本地插件目录、Ensemble 自己的运行时目录），
 * 所以 install / uninstall 默认只展示计划，必须得到明确确认（--yes 或交互确认）才会动手。
 * 每一步只动 Ensemble 自己创建的东西：目录里有安装标记才会被覆盖或删除，
 * 市场清单只增删名为 ensemble 的条目，并在修改前备份。
 */

const PLUGIN_NAME = "ensemble";
export const INSTALL_MARKER = ".ensemble-install.json";

export type InstallTarget = "codex" | "cursor" | "sdk";
export const INSTALL_TARGETS: readonly InstallTarget[] = ["codex", "cursor", "sdk"];

/**
 * 随插件分发的内容（相对插件根）。不复制源码、测试和 node_modules。
 * 插件根可能是源码仓库，也可能是 npm 包（`package.json` 的 `files` 必须覆盖这里除 README.md 之外的每一项，
 * 由 test/plugin-package.test.ts 守着）。LICENSE 与 NOTICE 跟着走：dist/ 里打包进了第三方代码，分发它的地方要带上声明。
 */
export const PLUGIN_PAYLOAD: readonly string[] = ["plugin.json", "mcp.json", ".mcp.json", ".cursor-plugin", "skills", "assets", "dist", "README.md", "LICENSE", "NOTICE"];

export interface InstallDeps {
  /** 当前这份插件的根目录（含 plugin.json、mcp.json 与 dist/）。 */
  pluginRoot: string;
  /** 用户主目录；Codex 个人市场与 Cursor 本地插件目录都在它下面。 */
  userHome: string;
  /** 放 @cursor/sdk 的运行时目录（<ENSEMBLE_HOME>/runtime）。 */
  runtimeDir: string;
  version: string;
  now: () => Date;
  /** 运行 Codex CLI；找不到 Codex 时返回 undefined。 */
  runCodex: (args: readonly string[]) => Promise<CaptureResult | undefined>;
  /** 运行 npm；找不到 npm 时返回 undefined。 */
  runNpm: (args: readonly string[]) => Promise<CaptureResult | undefined>;
}

export interface StepResult {
  target: InstallTarget;
  ok: boolean;
  lines: string[];
}

// ───────────────────────── 位置 ─────────────────────────

export function codexPluginDir(userHome: string): string {
  return join(userHome, "plugins", PLUGIN_NAME);
}

export function codexMarketplaceFile(userHome: string): string {
  return join(userHome, ".agents", "plugins", "marketplace.json");
}

export function cursorPluginDir(userHome: string): string {
  return join(userHome, ".cursor", "plugins", "local", PLUGIN_NAME);
}

/** 从当前运行的文件向上找插件根（打包后在 dist/ 的上一级；开发时在仓库根）。 */
export function locatePluginRoot(fromUrl: string = import.meta.url): string | undefined {
  let dir = dirname(fileURLToPath(fromUrl));
  for (let depth = 0; depth < 5; depth++) {
    if (existsSync(join(dir, "plugin.json")) && existsSync(join(dir, "mcp.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** npm 的 JS 入口：优先用启动本进程的 npm，其次是随 Node 一起安装的那份。Windows 上直接 spawn npm.cmd 不可靠，所以用 node 运行入口。 */
function findNpmCli(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromNpm = env["npm_execpath"];
  const candidates = [
    ...(fromNpm && /npm-cli\.c?js$/i.test(fromNpm) ? [fromNpm] : []),
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

export function defaultDeps(options: { pluginRoot: string; userHome: string; runtimeDir: string; version: string; env?: NodeJS.ProcessEnv }): InstallDeps {
  const env = options.env ?? process.env;
  return {
    pluginRoot: options.pluginRoot,
    userHome: options.userHome,
    runtimeDir: options.runtimeDir,
    version: options.version,
    now: () => new Date(),
    runCodex: async (args) => {
      const launch = resolveCodexLaunch({ env });
      if (!launch) return undefined;
      return runCapture(launch.command, [...launch.prefix, ...args], { env, timeoutMs: 120_000 });
    },
    runNpm: async (args) => {
      const cli = findNpmCli(env);
      if (!cli) return undefined;
      return runCapture(process.execPath, [cli, ...args], { env, timeoutMs: 300_000 });
    },
  };
}

// ───────────────────────── 文件操作 ─────────────────────────

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

async function readJson(file: string): Promise<unknown> {
  const text = (await readFile(file, "utf8")).replace(/^\uFEFF/, "");
  return JSON.parse(text) as unknown;
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.ensemble-tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 命令输出的最后几行：失败原因通常在末尾。 */
function lastLines(text: string, lines = 6): string {
  return text.trim().split(/\r?\n/).slice(-lines).join("\n");
}

/** 目录是不是 Ensemble 自己装的（有安装标记）。 */
async function readMarker(dir: string): Promise<{ version?: string } | undefined> {
  try {
    const value = await readJson(join(dir, INSTALL_MARKER));
    return isRecord(value) && value["name"] === PLUGIN_NAME ? { ...(typeof value["version"] === "string" ? { version: value["version"] } : {}) } : undefined;
  } catch {
    return undefined;
  }
}

export function verifySource(deps: InstallDeps): string | undefined {
  for (const required of ["plugin.json", "mcp.json", join("dist", "ensemble.mjs"), join("dist", "web", "index.html")]) {
    if (!existsSync(join(deps.pluginRoot, required))) {
      return `插件目录 ${deps.pluginRoot} 里缺少 ${required}${required.startsWith("dist") ? "；请先运行 npm run build" : ""}。`;
    }
  }
  return undefined;
}

/**
 * 把插件内容同步到目标目录。逐个文件覆盖，而不是整目录替换：
 * 宿主拉起的 MCP 桥可能把目标目录当作工作目录，Windows 上这样的目录不能被改名或删除。
 */
async function syncPlugin(deps: InstallDeps, target: string, force: boolean): Promise<void> {
  const existing = existsSync(target);
  if (existing && !(await readMarker(target)) && !force) {
    const entries = await readdir(target).catch(() => []);
    if (entries.length > 0) {
      throw new Error(`${target} 已存在，而且不是由 Ensemble 安装的；没有动它。确认要覆盖时加 --force。`);
    }
  }
  await mkdir(target, { recursive: true });
  const skip = (source: string): boolean => !/(^|[\\/])(\.DS_Store|Thumbs\.db)$/.test(source) && !source.endsWith(".map");
  for (const entry of PLUGIN_PAYLOAD) {
    const from = join(deps.pluginRoot, entry);
    if (!existsSync(from)) continue;
    const to = join(target, entry);
    try {
      if ((await stat(from)).isDirectory()) {
        await rm(to, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        await cp(from, to, { recursive: true, filter: skip });
      } else {
        await mkdir(dirname(to), { recursive: true });
        await copyFile(from, to);
      }
    } catch (error) {
      throw new Error(`无法写入 ${to}：${errorMessage(error)}。如果有宿主正在使用这个插件，先关闭它，或运行 stop 停掉 Ensemble 服务后重试。`);
    }
  }
  await writeFile(
    join(target, INSTALL_MARKER),
    `${JSON.stringify({ name: PLUGIN_NAME, version: deps.version, installedAt: deps.now().toISOString(), source: deps.pluginRoot }, null, 2)}\n`,
    "utf8",
  );
}

async function removeManaged(dir: string): Promise<{ removed: boolean; note: string }> {
  if (!existsSync(dir)) return { removed: false, note: `${dir} 不存在，无需删除。` };
  if (!(await readMarker(dir))) return { removed: false, note: `${dir} 不是由 Ensemble 安装的，没有动它。` };
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  return { removed: true, note: `已删除 ${dir}。` };
}

// ───────────────────────── Codex ─────────────────────────

interface MarketplaceEntry {
  name: string;
  source: { source: "local"; path: string };
  policy: { installation: "AVAILABLE"; authentication: "ON_INSTALL" };
  category: string;
}

export function marketplaceEntry(userHome: string, pluginDir: string): MarketplaceEntry {
  const relativePath = relative(userHome, pluginDir).split(sep).join("/");
  return {
    name: PLUGIN_NAME,
    source: { source: "local", path: `./${relativePath}` },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Developer Tools",
  };
}

interface MarketplaceRead {
  data: Record<string, unknown> | undefined;
  name: string;
}

/** 读个人市场清单；文件不存在返回 undefined 数据，无法解析时抛出（不会覆盖用户的文件）。 */
async function readMarketplace(file: string): Promise<MarketplaceRead> {
  if (!existsSync(file)) return { data: undefined, name: "personal" };
  let value: unknown;
  try {
    value = await readJson(file);
  } catch (error) {
    throw new Error(`${file} 不是有效的 JSON（${errorMessage(error)}）；为了不破坏它，没有改动。`);
  }
  if (!isRecord(value) || (value["plugins"] !== undefined && !Array.isArray(value["plugins"]))) {
    throw new Error(`${file} 的结构不是预期的市场清单（需要带 plugins 数组的对象）；为了不破坏它，没有改动。`);
  }
  return { data: value, name: typeof value["name"] === "string" && value["name"].length > 0 ? value["name"] : "personal" };
}

async function backupFile(file: string, now: Date): Promise<string> {
  const backup = `${file}.ensemble-backup-${stamp(now)}`;
  await copyFile(file, backup);
  return backup;
}

async function upsertMarketplace(deps: InstallDeps, entry: MarketplaceEntry): Promise<{ name: string; changed: boolean; backup?: string }> {
  const file = codexMarketplaceFile(deps.userHome);
  const { data, name } = await readMarketplace(file);
  if (!data) {
    await writeJsonAtomic(file, { name: "personal", interface: { displayName: "Personal" }, plugins: [entry] });
    return { name: "personal", changed: true };
  }
  const plugins = (Array.isArray(data["plugins"]) ? data["plugins"] : []) as unknown[];
  const index = plugins.findIndex((item) => isRecord(item) && item["name"] === PLUGIN_NAME);
  const current = index >= 0 ? plugins[index] : undefined;
  if (current !== undefined && JSON.stringify(current) === JSON.stringify(entry)) return { name, changed: false };
  const backup = await backupFile(file, deps.now());
  const next = index >= 0 ? plugins.map((item, i) => (i === index ? entry : item)) : [...plugins, entry];
  await writeJsonAtomic(file, { ...data, plugins: next });
  return { name, changed: true, backup };
}

async function dropFromMarketplace(deps: InstallDeps): Promise<{ name: string; changed: boolean; backup?: string }> {
  const file = codexMarketplaceFile(deps.userHome);
  const { data, name } = await readMarketplace(file);
  if (!data || !Array.isArray(data["plugins"])) return { name, changed: false };
  const plugins = data["plugins"] as unknown[];
  if (!plugins.some((item) => isRecord(item) && item["name"] === PLUGIN_NAME)) return { name, changed: false };
  const backup = await backupFile(file, deps.now());
  await writeJsonAtomic(file, { ...data, plugins: plugins.filter((item) => !(isRecord(item) && item["name"] === PLUGIN_NAME)) });
  return { name, changed: true, backup };
}

export async function installCodex(deps: InstallDeps, options: { force: boolean }): Promise<StepResult> {
  const lines: string[] = [];
  const dir = codexPluginDir(deps.userHome);
  try {
    // 先确认市场清单可读：清单损坏时不要留下装了一半的状态。
    await readMarketplace(codexMarketplaceFile(deps.userHome));
    await syncPlugin(deps, dir, options.force);
    lines.push(`已复制插件到 ${dir}`);
    const market = await upsertMarketplace(deps, marketplaceEntry(deps.userHome, dir));
    lines.push(
      market.changed
        ? `已在 ${codexMarketplaceFile(deps.userHome)} 中登记 ${PLUGIN_NAME}${market.backup ? `（原文件已备份为 ${market.backup}）` : "（新建了个人市场）"}`
        : `${codexMarketplaceFile(deps.userHome)} 中已有相同的 ${PLUGIN_NAME} 条目`,
    );
    const selector = `${PLUGIN_NAME}@${market.name}`;
    const result = await deps.runCodex(["plugin", "add", selector]);
    if (!result) {
      lines.push(`没有找到 Codex 命令行，文件已就位；装好 Codex 后运行：codex plugin add ${selector}`);
      return { target: "codex", ok: false, lines };
    }
    if (result.code !== 0 || result.error) {
      lines.push(`codex plugin add ${selector} 没有成功（${result.timedOut ? "超时" : `退出码 ${String(result.code)}`}）：${lastLines(result.stderr || result.stdout || errorMessage(result.error))}`);
      lines.push(`文件已就位，可以稍后手动运行：codex plugin add ${selector}`);
      return { target: "codex", ok: false, lines };
    }
    lines.push(`已运行 codex plugin add ${selector}；重启 Codex（或新开会话）后生效。`);
    return { target: "codex", ok: true, lines };
  } catch (error) {
    lines.push(errorMessage(error));
    return { target: "codex", ok: false, lines };
  }
}

export async function uninstallCodex(deps: InstallDeps): Promise<StepResult> {
  const lines: string[] = [];
  let ok = true;
  try {
    const market = await readMarketplace(codexMarketplaceFile(deps.userHome));
    const selector = `${PLUGIN_NAME}@${market.name}`;
    const result = await deps.runCodex(["plugin", "remove", selector]);
    if (!result) lines.push("没有找到 Codex 命令行，跳过 codex plugin remove。");
    else if (result.code !== 0 || result.error) lines.push(`codex plugin remove ${selector}：${lastLines(result.stderr || result.stdout || errorMessage(result.error))}（可能本来就没有安装）`);
    else lines.push(`已运行 codex plugin remove ${selector}`);

    const dropped = await dropFromMarketplace(deps);
    if (dropped.changed) lines.push(`已从 ${codexMarketplaceFile(deps.userHome)} 移除 ${PLUGIN_NAME}（原文件已备份为 ${dropped.backup ?? ""}）`);
    const removed = await removeManaged(codexPluginDir(deps.userHome));
    lines.push(removed.note);
    if (!removed.removed && existsSync(codexPluginDir(deps.userHome))) ok = false;
  } catch (error) {
    lines.push(errorMessage(error));
    ok = false;
  }
  return { target: "codex", ok, lines };
}

// ───────────────────────── Cursor ─────────────────────────

export async function installCursor(deps: InstallDeps, options: { force: boolean }): Promise<StepResult> {
  const dir = cursorPluginDir(deps.userHome);
  try {
    await syncPlugin(deps, dir, options.force);
    return { target: "cursor", ok: true, lines: [`已复制插件到 ${dir}`, "在 Cursor 里运行命令 “Developer: Reload Window” 后生效。"] };
  } catch (error) {
    return { target: "cursor", ok: false, lines: [errorMessage(error)] };
  }
}

export async function uninstallCursor(deps: InstallDeps): Promise<StepResult> {
  try {
    const removed = await removeManaged(cursorPluginDir(deps.userHome));
    return { target: "cursor", ok: removed.removed || !existsSync(cursorPluginDir(deps.userHome)), lines: [removed.note] };
  } catch (error) {
    return { target: "cursor", ok: false, lines: [errorMessage(error)] };
  }
}

// ───────────────────────── Cursor SDK ─────────────────────────

export function sdkPackageDir(runtimeDir: string): string {
  return join(runtimeDir, "node_modules", "@cursor", "sdk");
}

export async function installSdk(deps: InstallDeps): Promise<StepResult> {
  const spec = `@cursor/sdk@${CURSOR_SDK_VERSION}`;
  try {
    await mkdir(deps.runtimeDir, { recursive: true });
    const result = await deps.runNpm(["install", "--prefix", deps.runtimeDir, "--no-audit", "--no-fund", spec]);
    if (!result) return { target: "sdk", ok: false, lines: ["没有找到 npm；请安装 Node 自带的 npm 后重试，或手动安装 @cursor/sdk 并用 ENSEMBLE_CURSOR_SDK 指向它。"] };
    if (result.code !== 0 || result.error) {
      return { target: "sdk", ok: false, lines: [`npm install ${spec} 没有成功（${result.timedOut ? "超时" : `退出码 ${String(result.code)}`}）：${lastLines(result.stderr || result.stdout || errorMessage(result.error))}`] };
    }
    if (!existsSync(join(sdkPackageDir(deps.runtimeDir), "package.json"))) {
      return { target: "sdk", ok: false, lines: [`npm 报告成功，但没有在 ${deps.runtimeDir} 下找到 ${spec}。`] };
    }
    return {
      target: "sdk",
      ok: true,
      lines: [`已把 ${spec} 安装到 ${deps.runtimeDir}。Cursor 还需要登录：node "${join(deps.pluginRoot, "dist", "ensemble.mjs")}" cursor-login，或设置 CURSOR_API_KEY。`],
    };
  } catch (error) {
    return { target: "sdk", ok: false, lines: [errorMessage(error)] };
  }
}

// ───────────────────────── 计划与入口 ─────────────────────────

async function describePlan(targets: readonly InstallTarget[], deps: InstallDeps, mode: "install" | "uninstall"): Promise<string[]> {
  const lines: string[] = [];
  for (const target of targets) {
    if (target === "codex") {
      const market = await readMarketplace(codexMarketplaceFile(deps.userHome)).catch(() => ({ data: undefined, name: "personal" }));
      const selector = `${PLUGIN_NAME}@${market.name}`;
      if (mode === "install") {
        lines.push(
          `Codex   复制插件到 ${codexPluginDir(deps.userHome)}`,
          `        在 ${codexMarketplaceFile(deps.userHome)} 中登记 ${PLUGIN_NAME}（已有文件会先备份）`,
          `        运行 codex plugin add ${selector}（会在 Codex 配置里启用该插件）`,
        );
      } else {
        lines.push(
          `Codex   运行 codex plugin remove ${selector}`,
          `        从 ${codexMarketplaceFile(deps.userHome)} 移除 ${PLUGIN_NAME} 条目（先备份）`,
          `        删除 ${codexPluginDir(deps.userHome)}（仅当它是 Ensemble 安装的）`,
        );
      }
    } else if (target === "cursor") {
      lines.push(
        mode === "install"
          ? `Cursor  复制插件到 ${cursorPluginDir(deps.userHome)}（之后在 Cursor 里重新加载窗口）`
          : `Cursor  删除 ${cursorPluginDir(deps.userHome)}（仅当它是 Ensemble 安装的）`,
      );
    } else if (mode === "install") {
      lines.push(`SDK     npm install @cursor/sdk@${CURSOR_SDK_VERSION} 到 ${deps.runtimeDir}（需要联网，约 50 MB；许可证不允许把它打进插件）`);
    }
  }
  return lines;
}

export interface InstallIo {
  out: (text?: string) => void;
  err: (text?: string) => void;
  confirm: (question: string) => Promise<boolean>;
  interactive: boolean;
}

export interface RunInstallOptions {
  mode: "install" | "uninstall";
  targets: readonly InstallTarget[];
  flags: ReadonlySet<string>;
  deps: InstallDeps;
  io: InstallIo;
  /** 本地服务是否正在运行：运行中的旧版本不会自己换成新装的文件。 */
  serviceRunning?: boolean;
}

const LABEL: Record<InstallTarget, string> = { codex: "Codex", cursor: "Cursor", sdk: "Cursor SDK" };

/** 退出码：0 全部成功或仅预览；1 有步骤失败或被拒绝；2 需要确认但无法确认。 */
export async function runInstall(options: RunInstallOptions): Promise<number> {
  const { mode, flags, deps, io } = options;
  const targets = INSTALL_TARGETS.filter((target) => options.targets.includes(target) && !(mode === "uninstall" && target === "sdk"));
  if (targets.length === 0) {
    io.err(`请指明要${mode === "install" ? "安装" : "卸载"}到哪里：${(mode === "install" ? INSTALL_TARGETS : INSTALL_TARGETS.filter((t) => t !== "sdk")).join(" | ")}（或 --all）。`);
    return 2;
  }
  if (mode === "install") {
    const problem = verifySource(deps);
    if (problem) {
      io.err(problem);
      return 1;
    }
    if (deps.pluginRoot === codexPluginDir(deps.userHome) || deps.pluginRoot === cursorPluginDir(deps.userHome)) {
      if (targets.some((target) => target !== "sdk")) {
        io.err("当前运行的就是已安装的那份插件；请从源码目录运行 install，才能把新版本复制过去。");
        return 1;
      }
    }
  }

  io.out(`Ensemble ${deps.version} · ${mode === "install" ? "安装" : "卸载"}计划（只会改下面列出的位置）`);
  for (const line of await describePlan(targets, deps, mode)) io.out(`  ${line}`);
  io.out();

  if (flags.has("dry-run")) {
    io.out("这只是预览，没有改动任何东西。");
    return 0;
  }
  if (!flags.has("yes")) {
    if (!io.interactive) {
      io.err("这会修改你的用户级配置，需要你的明确确认。确认后请加上 --yes 重新运行（或先加 --dry-run 只看计划）。");
      return 2;
    }
    if (!(await io.confirm("按上面的计划继续吗？"))) {
      io.out("已取消，没有改动任何东西。");
      return 1;
    }
  }

  const force = flags.has("force");
  const results: StepResult[] = [];
  for (const target of targets) {
    const result =
      mode === "install"
        ? target === "codex"
          ? await installCodex(deps, { force })
          : target === "cursor"
            ? await installCursor(deps, { force })
            : await installSdk(deps)
        : target === "codex"
          ? await uninstallCodex(deps)
          : await uninstallCursor(deps);
    results.push(result);
    io.out(`${result.ok ? "✓" : "✗"} ${LABEL[target]}`);
    for (const line of result.lines) io.out(`    ${line}`);
  }
  if (mode === "install" && options.serviceRunning && results.some((r) => r.ok && r.target !== "sdk")) {
    io.out();
    io.out("Ensemble 本地服务正在运行旧版本；运行 stop 停掉它，下一次委派会自动启动新版本。");
  }
  return results.every((result) => result.ok) ? 0 : 1;
}
