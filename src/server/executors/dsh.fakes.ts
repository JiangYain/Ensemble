/** 仅供测试使用：把适配器接到 test/fixtures/fake-dsh.mjs（按真实 dsh 0.2.2-rc.1 的抓包回放 ACP）上。 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeTrackedEnv } from "../testing";
import { DshExecutor, type DshExecutorOptions } from "./dsh";

export const FAKE_DSH = fileURLToPath(new URL("../../../test/fixtures/fake-dsh.mjs", import.meta.url));

/** 假 dsh 写下的日志：每次启动、收到的每个请求、客户端对它的请求的回复。 */
export interface LogEntry {
  type: "launch" | "request" | "response";
  pid?: number;
  args?: string[];
  cwd?: string;
  permission?: string;
  parent?: string;
  depth?: string;
  patch?: string;
  method?: string;
  params?: Record<string, any>;
  result?: Record<string, any>;
  error?: { code: number; message: string };
}

export interface TreePids {
  shell: number;
  leaf: number;
}

export function setup(extra: NodeJS.ProcessEnv = {}, options: DshExecutorOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-fakedsh-"));
  const files = { log: join(dir, "log.jsonl"), pids: join(dir, "pids.json"), state: join(dir, "state.json") };
  writeFileSync(files.log, "");
  const executor = new DshExecutor({
    bin: FAKE_DSH,
    // 外层环境里可能带着 Ensemble 的父会话变量（例如这些测试正由被委派的会话运行）：清掉，免得与探测进程混淆。
    env: { ...process.env, ENSEMBLE_PARENT_SESSION: undefined, ENSEMBLE_PARENT_DEPTH: undefined, FAKE_DSH_LOG: files.log, FAKE_DSH_STATE: files.state, FAKE_DSH_PIDS: files.pids, ...extra },
    ...options,
  });
  const env = makeTrackedEnv([executor]);
  const log = (): LogEntry[] =>
    readFileSync(files.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LogEntry);
  /** 某个方法收到的全部参数；默认只看会话进程（带 ENSEMBLE_PARENT_SESSION 的），`probe` 看探测进程。 */
  const requests = (method: string, from: "session" | "probe" = "session"): Record<string, any>[] =>
    log().flatMap((entry) => (entry.type === "request" && entry.method === method && (from === "session") === (entry.parent !== undefined) ? [entry.params ?? {}] : []));
  const launches = (from: "session" | "probe" = "session"): LogEntry[] => log().filter((entry) => entry.type === "launch" && (from === "session") === (entry.parent !== undefined));
  /** 孤儿场景里假 dsh 写下的 shell 与孙进程 pid；文件还没写完整时返回 undefined。 */
  const pids = (): TreePids | undefined => {
    if (!existsSync(files.pids)) return undefined;
    try {
      return JSON.parse(readFileSync(files.pids, "utf8")) as TreePids;
    } catch {
      return undefined;
    }
  };
  return { env, executor, log, requests, launches, pids, dir };
}

/**
 * 在临时目录里造一个“带 package.json 的 dsh 包”，入口转去运行假 dsh：
 * 适配器据此读到包声明的 Node 要求（真实的 dsh 0.2.2-rc.1 声明 >=24.9.0）。
 */
export function packagedFake(enginesNode: string): string {
  const root = mkdtempSync(join(tmpdir(), "ensemble-fakedsh-pkg-"));
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.2.2-rc.1", engines: { node: enginesNode } }));
  const entry = join(root, "bin", "dsh.mjs");
  writeFileSync(entry, `import ${JSON.stringify(pathToFileURL(FAKE_DSH).href)};\n`);
  return entry;
}

/** 进程是否还活着（信号 0 只检查存在性，Windows 上同样可用）。 */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
