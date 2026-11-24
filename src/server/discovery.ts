import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { PROTOCOL_VERSION, type ServiceFeature } from "@shared/constants";
import type { HealthBody } from "@shared/protocol";
import type { EnsemblePaths } from "./paths";

/**
 * 服务发现：本地服务启动后把地址与令牌写入 service.json，
 * MCP 桥、CLI 与脚本都据此连接同一个服务，不依赖任何宿主私有的目录。
 */
export interface ServiceFile {
  pid: number;
  port: number;
  url: string;
  token: string;
  version: string;
  protocol: number;
  startedAt: string;
  home: string;
  /** 服务懂得的可协商功能（见 SERVICE_FEATURES）。老服务写的 service.json 里没有这个字段。 */
  features?: string[];
}

/** 服务是否声明支持某个可协商功能。没有 features 字段就是老服务，一律按“不支持”处理。 */
export function serviceSupports(file: Pick<ServiceFile, "features"> | undefined, feature: ServiceFeature): boolean {
  return file?.features?.includes(feature) === true;
}

export async function readServiceFile(paths: EnsemblePaths): Promise<ServiceFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(paths.serviceFile, "utf8")) as Partial<ServiceFile>;
    if (typeof parsed.port === "number" && typeof parsed.token === "string" && typeof parsed.pid === "number") {
      // features 是后加的可选字段：只留下字符串，别的形状一律当作没有。
      const features = Array.isArray(parsed.features) ? parsed.features.filter((item): item is string => typeof item === "string") : undefined;
      return { ...(parsed as ServiceFile), features };
    }
  } catch {
    // 不存在或损坏都视为没有服务。
  }
  return undefined;
}

/** 先写临时文件再改名，读取方永远看不到写了一半的内容。 */
export async function writeServiceFile(paths: EnsemblePaths, file: ServiceFile): Promise<void> {
  await mkdir(paths.run, { recursive: true });
  const temp = `${paths.serviceFile}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(file, null, 2), { mode: 0o600 });
  await rename(temp, paths.serviceFile);
}

export async function removeServiceFile(paths: EnsemblePaths, onlyIfPid?: number): Promise<void> {
  if (onlyIfPid !== undefined) {
    const current = await readServiceFile(paths);
    if (current && current.pid !== onlyIfPid) return;
  }
  await rm(paths.serviceFile, { force: true });
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function probeService(file: ServiceFile, timeoutMs = 1_500): Promise<HealthBody | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${file.port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return undefined;
    const body = (await response.json()) as Partial<HealthBody>;
    if (body.service !== "ensemble" || body.pid !== file.pid) return undefined;
    return body as HealthBody;
  } catch {
    return undefined;
  }
}

export interface EnsureServiceOptions {
  paths: EnsemblePaths;
  /** 拉起服务时传给子进程的环境。 */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * 确保本地服务在运行：已有健康服务就直接使用，否则以独立（detached）进程拉起并等待就绪。
 *
 * 服务不依赖桥进程存活：桥退出时我们不会主动停止它，别的桥与网页都可以继续使用同一个服务。
 * 但它能否活过宿主本身，取决于宿主如何清理子进程——这里没有、也不应悄悄绕过宿主的进程管理。
 * 实测：Windows 上 Codex 0.151.0 退出时会连同 MCP 进程的整棵子进程树（包括 detached 子进程）一并终止，
 * 服务随之停止、未完成的运行变为“已中断”；需要常驻时请自行运行 `ensemble serve`（或 `ensemble open`），桥会发现并复用它。
 */
export async function ensureService(options: EnsureServiceOptions): Promise<ServiceFile> {
  const { paths } = options;
  const existing = await readServiceFile(paths);
  if (existing && (await probeService(existing))) return existing;

  const entry = process.argv[1];
  if (!entry) throw new Error("Cannot determine the Ensemble entry script to start the service.");
  const child = spawn(process.execPath, [...process.execArgv, entry, "serve"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, ...options.env, ENSEMBLE_HOME: paths.home },
  });
  child.unref();

  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const file = await readServiceFile(paths);
    if (file && file.pid !== existing?.pid && (await probeService(file))) return file;
    if (file && !existing && (await probeService(file))) return file;
  }
  throw new Error(`The Ensemble service did not become ready in time. See ${paths.serviceLog}.`);
}

export function protocolCompatible(file: Pick<ServiceFile, "protocol">): boolean {
  return file.protocol === PROTOCOL_VERSION;
}
