import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { ENV } from "@shared/constants";
import type { AccessLevel, SessionMeta } from "@shared/types";
import { findExecutableOnPath, resolveNpmCommandEntry } from "./process";

/**
 * DSH（DeepSeek Harness，npm 包 `@deepseek-ai/dsh`）的启动方式与环境。
 *
 * 以下行为都在 dsh 0.2.2-rc.1（Windows 11、Node 22.22.2）上用真实进程验证过，不是照文档推断：
 * - 控制面选 `dsh --profile acp`：官方的 ACP v1 服务（JSON-RPC 2.0，stdio 上每行一个 JSON）。
 *   官方 SDK 没有取消，也拿不到一轮对话的结束结果，所以不选它；
 * - 权限由环境变量 `DSH_PERMISSION_MODE`（read-only | workspace-write | danger-full-access）决定，
 *   优先于用户 settings.yaml 里的 permission 设置，所以不必改用户的任何配置；
 * - 沙箱的工作区根取自进程 cwd，所以进程必须以会话的工作目录启动。
 */

export const DSH_INSTALL_COMMAND = "npm install -g @deepseek-ai/dsh@latest";

/** dsh 的 npm 包名：用来从入口文件向上确认包根目录，不会把别的同名入口误当成 dsh。 */
export const DSH_PACKAGE = "@deepseek-ai/dsh";

export interface DshLaunch {
  command: string;
  /** 放在 `--profile` 等参数之前的参数：用 node 运行 JS 入口时是入口路径，直接运行可执行文件时为空。 */
  prefix: string[];
  /** 解析结果的来源描述（诊断时用）。 */
  source: string;
  /** dsh 包的根目录；找不到包（例如测试用的假 dsh）时为 undefined。 */
  packageDir?: string;
}

function isScript(path: string): boolean {
  return /\.(?:[cm]?js)$/i.test(path);
}

/** 从入口文件向上找 dsh 包的根目录（最多几层），用来读 engines 提示。 */
function findPackageDir(entry: string): string | undefined {
  let dir = dirname(entry);
  for (let depth = 0; depth < 5; depth += 1) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown };
      if (manifest.name === DSH_PACKAGE) return dir;
    } catch {
      // 这一层没有（或读不了）package.json，继续往上。
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function launchOf(entry: string, source: string): DshLaunch {
  if (!isScript(entry)) return { command: entry, prefix: [], source };
  const packageDir = findPackageDir(entry);
  return { command: process.execPath, prefix: [entry], source, ...(packageDir ? { packageDir } : {}) };
}

/**
 * 查找时额外带上 npm 全局目录：从 GUI 宿主（例如桌面版 Codex）里启动时，
 * PATH 常常不含 `%APPDATA%\npm`，而 `npm install -g` 恰好装在那里。
 */
function searchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const extra: string[] = [];
  const prefix = env["NPM_CONFIG_PREFIX"] ?? env["npm_config_prefix"];
  if (prefix) extra.push(process.platform === "win32" ? prefix : join(prefix, "bin"));
  if (process.platform === "win32" && env["APPDATA"]) extra.push(join(env["APPDATA"], "npm"));
  if (extra.length === 0) return env;
  const current = env["PATH"] ?? env["Path"] ?? "";
  return { ...env, PATH: [current, ...extra].filter((entry) => entry.length > 0).join(delimiter) };
}

/** 找到 dsh：显式指定（选项或环境变量）优先，其次 PATH 与 npm 全局目录。显式指定了却不存在时不再回退，免得悄悄用了别的版本。 */
export function resolveDshLaunch(options: { bin?: string | undefined; env: NodeJS.ProcessEnv }): DshLaunch | undefined {
  const explicit = options.bin ?? options.env[ENV.dshBin];
  if (explicit) return existsSync(explicit) ? launchOf(explicit, explicit) : undefined;
  const env = searchEnv(options.env);
  const entry = resolveNpmCommandEntry("dsh", env);
  if (entry) return launchOf(entry, entry);
  const native = findExecutableOnPath(process.platform === "win32" ? ["dsh.exe"] : ["dsh"], env);
  return native ? launchOf(native, native) : undefined;
}

export function versionArgs(launch: DshLaunch): string[] {
  return [...launch.prefix, "--version"];
}

/**
 * ACP 服务的启动参数。`patchFile` 是 dsh 自己的 `--patch` 叠加配置（YAML），
 * 用来在不改用户 profile 的前提下覆盖单次启动的配置（探测时用它把会话存储挪到临时目录）。
 */
export function acpArgs(launch: DshLaunch, patchFile?: string): string[] {
  return [...launch.prefix, "--profile", "acp", ...(patchFile ? ["--patch", patchFile] : [])];
}

export type DshPermissionMode = "read-only" | "danger-full-access";

/** Ensemble 的访问级别对应 dsh 的权限预设：委派默认 Full Access，只读只在发起方明确要求时才用。 */
export function permissionMode(access: AccessLevel): DshPermissionMode {
  return access === "read_only" ? "read-only" : "danger-full-access";
}

/** 会话进程的环境：覆盖用户可能已设置的 DSH_PERMISSION_MODE，并把父会话信息交给工具子进程（供嵌套委派）。 */
export function sessionEnv(base: NodeJS.ProcessEnv, meta: Pick<SessionMeta, "id" | "depth" | "access">): NodeJS.ProcessEnv {
  return {
    ...base,
    DSH_PERMISSION_MODE: permissionMode(meta.access),
    [ENV.parentSession]: meta.id,
    [ENV.parentDepth]: String(meta.depth),
  };
}

/**
 * 探测用的 `--patch`：把会话存储与会话索引都改到 `root` 之下。
 * dsh 每次 `session/new` 都会落盘一个会话（哪怕是空的），还会在 `storages/session_projcache` 里记一份索引（实测约 4 KB）；
 * 探测每隔几分钟就会做一次，不应该在用户的 `~/.dsh` 里越积越多。
 * 两处缺一不可：只改会话存储时，索引文件仍会落在用户目录里。
 */
export function probePatchYaml(root: string): string {
  // YAML 单引号字符串里反斜杠按字面处理（Windows 路径），只需要把单引号翻倍。
  const quote = (path: string): string => `'${path.replace(/'/g, "''")}'`;
  return [
    "- id: session-persistence-jsonl",
    "  config:",
    `    root: ${quote(join(root, "sessions"))}`,
    "- id: storage-json",
    "  config:",
    `    root: ${quote(join(root, "storages"))}`,
    "",
  ].join("\n");
}

/**
 * 读 dsh 包声明的 Node 要求（engines.node）。没有 packageDir 或读不到时返回 undefined。
 * 声明（0.2.2-rc.1 是 >=24.9.0）与实测（Node 22.22.2 上 acp profile 能正常启动和运行）有出入，
 * 所以这个值只用来提示，不用来拒绝启动。
 */
export function readEnginesNode(launch: DshLaunch): string | undefined {
  if (!launch.packageDir) return undefined;
  try {
    const manifest = JSON.parse(readFileSync(join(launch.packageDir, "package.json"), "utf8")) as { engines?: { node?: unknown } };
    const node = manifest.engines?.node;
    return typeof node === "string" ? node : undefined;
  } catch {
    return undefined;
  }
}

function triple(version: string): [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/**
 * 当前 Node 是否满足 `>=X.Y.Z` 形式的要求；别的范围写法一律返回 undefined（不猜）。
 */
export function nodeSatisfies(version: string, range: string): boolean | undefined {
  const required = /^\s*>=\s*v?(\d+\.\d+\.\d+)\s*$/.exec(range);
  const have = triple(version);
  const need = required?.[1] ? triple(required[1]) : undefined;
  if (!have || !need) return undefined;
  for (let index = 0; index < 3; index += 1) {
    const a = have[index] ?? 0;
    const b = need[index] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}
