import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { CURSOR_SDK_PACKAGE, asCursorSdkAgentApi, type CursorSdkAgentApi } from "@mosoo/agent-driver/runtimes/cursor/cursor-sdk";
import { ENV } from "@shared/constants";
import { errorMessage } from "@shared/format";
import { asRecord, str, type Json } from "./common";

/**
 * 宿主用到的 SDK 表面：后端用的 `Agent`（定义在 Driver 的 Cursor 后端里，只此一份）
 * 加上宿主自己用来探测、列模型目录和查登录状态的 `Cursor.*`。
 * 用结构类型而不是直接依赖 @cursor/sdk 的类型：SDK 带原生组件、许可证不允许随插件分发，
 * 所以运行时按需加载，测试里也可以换成假 SDK。
 */
export interface CursorSdk extends CursorSdkAgentApi {
  Cursor: {
    models: { list(options?: Json): Promise<unknown> };
    me(options?: Json): Promise<unknown>;
    auth: {
      status(options?: Json): Promise<unknown>;
      /** 只有 `cursor-login` 命令会用到；执行端本身从不发起登录。 */
      login?(options?: Json): Promise<unknown>;
      logout?(options?: Json): Promise<void>;
    };
  };
}

export interface LoadedCursorSdk {
  sdk: CursorSdk;
  version?: string;
}

export type CursorSdkLoader = () => Promise<LoadedCursorSdk>;

function asSdk(moduleValue: unknown): CursorSdk {
  const api: Partial<CursorSdk> = asCursorSdkAgentApi(moduleValue);
  if (!api.Cursor) throw new Error("The module does not export the Cursor SDK's Cursor.");
  return api as CursorSdk;
}

function readPackageJson(packageDir: string): Json | undefined {
  try {
    return asRecord(JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")));
  } catch {
    return undefined;
  }
}

function readPackageVersion(packageDir: string): string | undefined {
  const pkg = readPackageJson(packageDir);
  return pkg?.["name"] === CURSOR_SDK_PACKAGE ? str(pkg["version"]) : undefined;
}

/** 从解析出的入口文件往上找到 @cursor/sdk 的 package.json。 */
function versionOfEntry(entry: string): string | undefined {
  let dir = dirname(entry);
  for (let depth = 0; depth < 8; depth++) {
    const version = readPackageVersion(dir);
    if (version) return version;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** `dir` 本身是包目录，或其下 node_modules/@cursor/sdk 是包目录。 */
function locatePackageDir(dir: string): string | undefined {
  for (const candidate of [dir, join(dir, "node_modules", "@cursor", "sdk")]) {
    if (readPackageVersion(candidate) !== undefined) return candidate;
  }
  return undefined;
}

function esmEntryOf(packageDir: string): string | undefined {
  const pkg = readPackageJson(packageDir);
  const root = asRecord(asRecord(pkg?.["exports"])?.["."]);
  const relative = str(root?.["import"]) ?? str(root?.["default"]) ?? str(pkg?.["module"]) ?? str(pkg?.["main"]);
  return relative ? resolvePath(packageDir, relative) : undefined;
}

async function importPackage(): Promise<LoadedCursorSdk> {
  const specifier: string = CURSOR_SDK_PACKAGE;
  const moduleValue: unknown = await import(/* @vite-ignore */ specifier);
  let version: string | undefined;
  try {
    version = versionOfEntry(createRequire(import.meta.url).resolve(specifier));
  } catch {
    version = undefined;
  }
  return { sdk: asSdk(moduleValue), ...(version ? { version } : {}) };
}

async function importFromDirectory(dir: string): Promise<LoadedCursorSdk> {
  const packageDir = locatePackageDir(dir);
  if (!packageDir) throw new Error(`${CURSOR_SDK_PACKAGE} is not installed under ${dir}`);
  const entry = esmEntryOf(packageDir);
  if (!entry) throw new Error(`${packageDir} has no ES module entry`);
  const moduleValue: unknown = await import(/* @vite-ignore */ pathToFileURL(entry).href);
  const version = readPackageVersion(packageDir);
  return { sdk: asSdk(moduleValue), ...(version ? { version } : {}) };
}

/**
 * 按顺序尝试：ENSEMBLE_CURSOR_SDK 指定的目录 → 随 Ensemble 一起安装的包 → Ensemble 管理的 runtime 目录。
 * 只缓存成功的结果：用户装好 SDK 之后不需要重启服务。
 */
export function defaultSdkLoader(options: { env: NodeJS.ProcessEnv; runtimeDir?: string | undefined }): CursorSdkLoader {
  let cached: Promise<LoadedCursorSdk> | undefined;

  const load = async (): Promise<LoadedCursorSdk> => {
    const attempts: Array<() => Promise<LoadedCursorSdk>> = [];
    const explicit = options.env[ENV.cursorSdk]?.trim();
    if (explicit) attempts.push(() => importFromDirectory(explicit));
    attempts.push(importPackage);
    if (options.runtimeDir) {
      const runtimeDir = options.runtimeDir;
      attempts.push(() => importFromDirectory(runtimeDir));
    }
    const failures: string[] = [];
    for (const attempt of attempts) {
      try {
        return await attempt();
      } catch (error) {
        failures.push(errorMessage(error));
      }
    }
    throw new Error(failures.join(" | "));
  };

  return () => {
    cached ??= load().catch((error: unknown) => {
      cached = undefined;
      throw error;
    });
    return cached;
  };
}
