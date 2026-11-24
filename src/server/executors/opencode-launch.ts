import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, extname, join } from "node:path";
import { ENV } from "@shared/constants";
import { runCapture } from "./process";

/**
 * 定位可用的 opencode 可执行文件。
 *
 * 为什么不能只看 PATH：Ensemble 服务是被宿主（Codex、Cursor 等）拉起的，它的 PATH 常常和用户终端里的不一样；
 * 而 npm 全局安装的 OpenCode 在 Windows 上由平台包 `@opencode/cli-windows-*` 提供真正的 exe，
 * `@opencode/cli/bin/opencode.exe` 只是个几百字节的占位文件。更糟的是平台包可能装坏（实测本机的 x64 包是截断的），
 * 所以“文件存在”不算数，必须真的跑一下 `--version` 才算找到。
 */

export interface OpenCodeLaunch {
  command: string;
  /** 放在参数最前面的东西：目标是 JS 入口（测试用的假 OpenCode）时是入口路径，否则为空。 */
  prefix: string[];
  version: string;
}

export type OpenCodeResolution =
  | { ok: true; launch: OpenCodeLaunch }
  | { ok: false; reason: "not_found" }
  /** 指定了 ENSEMBLE_OPENCODE_BIN，但那个路径不存在或运行不起来（指定了就不再去别处找，免得悄悄用错版本）。 */
  | { ok: false; reason: "configured_unusable"; path: string }
  /** 找到了能运行的 opencode，但版本太旧（V2 接口从 2.x 起）。 */
  | { ok: false; reason: "unsupported"; version: string; path: string };

/** Ensemble 依赖的 `serve --stdio` 与 `/api/*` 接口在 OpenCode 2.x 才有（本适配器按 2.3.0 核对）。 */
export const MIN_MAJOR = 2;

const VERSION_TIMEOUT_MS = 10_000;

function launchFile(path: string): Pick<OpenCodeLaunch, "command" | "prefix"> {
  return /\.(?:m?js|cjs)$/i.test(extname(path)) ? { command: process.execPath, prefix: [path] } : { command: path, prefix: [] };
}

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  return (env["PATH"] ?? env["Path"] ?? "").split(delimiter).filter((entry) => entry.length > 0);
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** npm 全局目录下的 OpenCode 平台包：同架构的完整包排在 baseline（兼容旧 CPU）包前面。 */
function npmPackageBinaries(prefixDir: string, exe: string): string[] {
  const root = join(prefixDir, "node_modules", "@opencode", "cli");
  const platformDirs = listDir(join(root, "node_modules", "@opencode"))
    .filter((name) => name.startsWith("cli-"))
    .sort((a, b) => Number(a.endsWith("-baseline")) - Number(b.endsWith("-baseline")) || a.localeCompare(b));
  return [...platformDirs.map((name) => join(root, "node_modules", "@opencode", name, "bin", exe)), join(root, "bin", exe)];
}

/**
 * 按优先级列出可能的 opencode 位置（只列出，不检查能不能运行）。
 * 只有 Windows 上的 npm 全局安装位置在这台机器上验证过；其余位置来自官方安装脚本与常见包管理器的约定。
 */
export function candidateBinaries(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
  const home = env["USERPROFILE"] ?? env["HOME"] ?? homedir();
  const exe = platform === "win32" ? "opencode.exe" : "opencode";
  const found: string[] = [];
  const dirs = pathEntries(env);

  for (const dir of dirs) found.push(join(dir, exe));
  if (platform === "win32") {
    for (const dir of dirs) {
      const shim = join(dir, "opencode.cmd");
      if (!existsSync(shim)) continue;
      try {
        const match = /"%dp0%[\\/]+(node_modules[^"]+?\.(?:exe|m?js|cjs))"/i.exec(readFileSync(shim, "utf8"));
        if (match?.[1]) found.push(join(dir, match[1]));
      } catch {
        // 垫片读不了就看下一个。
      }
    }
  }

  const npmPrefixes = [
    ...(env["APPDATA"] ? [join(env["APPDATA"], "npm")] : []),
    ...(platform === "win32" ? [] : [join(home, ".npm-global", "lib"), "/usr/local/lib", "/opt/homebrew/lib"]),
    ...dirs,
  ];
  for (const prefix of npmPrefixes) found.push(...npmPackageBinaries(prefix, exe));

  found.push(join(home, ".opencode", "bin", exe));
  if (platform === "win32") found.push(join(home, "scoop", "shims", exe), join(home, ".bun", "bin", exe));
  else found.push(join(home, ".local", "bin", exe), "/usr/local/bin/opencode", "/opt/homebrew/bin/opencode");
  return [...new Set(found)];
}

/** `opencode --version` 输出形如 “opencode v2.3.0”。跑不起来（占位文件、损坏的二进制、超时）返回 undefined。 */
async function versionOf(launch: Pick<OpenCodeLaunch, "command" | "prefix">, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const result = await runCapture(launch.command, [...launch.prefix, "--version"], { timeoutMs: VERSION_TIMEOUT_MS, env });
    if (result.error || result.timedOut || result.code !== 0) return undefined;
    // 不能用 \b：输出是 “opencode v2.3.0”，v 和 2 都是单词字符，中间没有单词边界。
    return `${result.stdout}\n${result.stderr}`.match(/(?<![\d.])(\d+\.\d+\.\d+[\w.+-]*)/)?.[1];
  } catch {
    // Windows 上对占位文件或截断的二进制 spawn 会同步抛出 `spawn UNKNOWN`（本机的 x64 平台包就是这样），当作“跑不起来”。
    return undefined;
  }
}

const resolved = new Map<string, OpenCodeLaunch>();

function cacheKey(env: NodeJS.ProcessEnv, configured: string | undefined): string {
  return JSON.stringify([configured ?? null, env["PATH"] ?? env["Path"] ?? null, env["APPDATA"] ?? null, env["USERPROFILE"] ?? env["HOME"] ?? null]);
}

/**
 * 找到第一个真的能运行、且版本够新的 opencode。结果按环境缓存，委派时不必再跑一遍 `--version`，缓存的文件消失了才重新找。
 * 探测传 `fresh: true` 跳过缓存：用户可能刚就地升级过 opencode，探测报告的版本必须是此刻的版本；找到后会刷新缓存。
 */
export async function resolveOpenCode(env: NodeJS.ProcessEnv, explicit?: string, options: { fresh?: boolean } = {}): Promise<OpenCodeResolution> {
  const configured = explicit ?? env[ENV.opencodeBin];
  const key = cacheKey(env, configured);
  const cached = options.fresh ? undefined : resolved.get(key);
  if (cached && existsSync(cached.prefix[0] ?? cached.command)) return { ok: true, launch: cached };
  if (configured && !existsSync(configured)) return { ok: false, reason: "configured_unusable", path: configured };

  let unsupported: { version: string; path: string } | undefined;
  for (const path of configured ? [configured] : candidateBinaries(env)) {
    if (!existsSync(path)) continue;
    const file = launchFile(path);
    const version = await versionOf(file, env);
    if (!version) {
      if (configured) return { ok: false, reason: "configured_unusable", path };
      continue;
    }
    if (Number(version.split(".")[0]) < MIN_MAJOR) {
      unsupported ??= { version, path };
      continue;
    }
    const launch = { ...file, version };
    resolved.set(key, launch);
    return { ok: true, launch };
  }
  return unsupported ? { ok: false, reason: "unsupported", ...unsupported } : { ok: false, reason: "not_found" };
}
