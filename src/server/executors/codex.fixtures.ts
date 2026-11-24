/**
 * 仅供测试使用：对着假 Codex app-server（test/fixtures/fake-codex.mjs）的几份套件（codex.test.ts、codex.questions.test.ts、codex.mapping.test.ts）共用的夹具：
 * `setup` 起一个指向假 Codex 的 CodexExecutor、登记进环境表、并读回假进程写下的请求日志；另有几个读时间线、等运行结束的小函数。
 *
 * 环境由 `makeTrackedEnv` 登记，每个测试文件各写一次 `afterEach(shutdownTrackedEnvs)` 收尾（登记表每个测试文件各有一份）；
 * 每次 `setup` 都用自己的临时日志目录，所以文件之间、用例之间不共用任何路径或子进程。
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { delegatorFor, itemsOf, makeTrackedEnv, stateOf, until, type TestEnv } from "../testing";
import { CodexExecutor } from "./codex";

const FAKE_CODEX = fileURLToPath(new URL("../../../test/fixtures/fake-codex.mjs", import.meta.url));
export const WAIT = 12_000;

export type Params = Record<string, any>;

export interface LogLine {
  argv?: string[];
  cwd?: string;
  parent?: string | null;
  depth?: string | null;
  request?: { method: string; params?: Params };
  response?: { id: number | string; result?: Params; error?: { code: number; message: string } };
}

export function setup(extraEnv: NodeJS.ProcessEnv = {}) {
  const logFile = join(mkdtempSync(join(tmpdir(), "ensemble-fakecodex-log-")), "log.jsonl");
  writeFileSync(logFile, "");
  const executor = new CodexExecutor({ bin: FAKE_CODEX, env: { ...process.env, FAKE_CODEX_LOG: logFile, ...extraEnv } });
  const env = makeTrackedEnv([executor]);
  const log = (): LogLine[] =>
    readFileSync(logFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LogLine);
  /** 某个请求方法收到的全部参数（探测进程与会话进程共用同一份日志）。 */
  const requests = (method: string): Params[] => log().flatMap((line) => (line.request?.method === method ? [line.request.params ?? {}] : []));
  return { env, executor, log, requests };
}

export const delegate = delegatorFor("codex");

export const tools = (env: TestEnv, sessionId: string) => itemsOf(env, sessionId, "tool");
export const diagnostics = (env: TestEnv, sessionId: string) => itemsOf(env, sessionId, "diagnostic");
export const assistants = (env: TestEnv, sessionId: string) => itemsOf(env, sessionId, "assistant");

export const completed = (env: TestEnv, sessionId: string, index = 0) =>
  until(() => stateOf(env, sessionId).runs[index]?.status === "completed", WAIT, `run ${index + 1} completed`);
