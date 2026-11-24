import { delegatorFor, itemsOf, makeTrackedEnv, stateOf, until, type TestEnv } from "../testing";
import { CursorExecutor } from "./cursor";
import { FakeSdk, type FakeRun } from "./cursor-fake";

/**
 * cursor-*.test.ts 共用的脚手架：假 SDK 驱动的 Cursor 执行端 + 内存环境。
 * 只被测试引用，不会进入产物；用法：每个测试文件写一次 `afterEach(shutdownTrackedEnvs)`。
 */

export const WAIT = 6_000;
export const FAKE_KEY = "key_test_not_a_real_credential";

export const READ_ONLY_TOOLS = ["read", "grep", "glob", "ls", "semSearch", "readLints", "readTodos", "updateTodos"];

export const delegate = delegatorFor("cursor");

interface SetupOptions {
  env?: NodeJS.ProcessEnv;
  configure?: (fake: FakeSdk) => void;
  steerAckMs?: number;
}

export function setup(options: SetupOptions = {}) {
  const fake = new FakeSdk();
  options.configure?.(fake);
  const executor = new CursorExecutor({ env: options.env ?? {}, loadSdk: fake.loader, steerAckMs: options.steerAckMs ?? 40 });
  const env = makeTrackedEnv([executor]);
  return { fake, executor, env };
}

export async function runOf(fake: FakeSdk, index = 0): Promise<FakeRun> {
  await until(() => fake.runs.length > index, WAIT, `Cursor run ${index + 1} to start`);
  const run = fake.runs[index];
  if (!run) throw new Error("run missing");
  return run;
}

export async function runningRun(env: TestEnv, fake: FakeSdk, sessionId: string, index = 0): Promise<FakeRun> {
  const run = await runOf(fake, index);
  await until(() => stateOf(env, sessionId).runs[index]?.status === "running", WAIT, "run running");
  return run;
}

export const tools = (env: TestEnv, sessionId: string) => itemsOf(env, sessionId, "tool");

export const diagnostics = (env: TestEnv, sessionId: string) => itemsOf(env, sessionId, "diagnostic");

export const messageOf = (env: TestEnv, sessionId: string, messageId: string) => {
  const message = stateOf(env, sessionId).messages.find((m) => m.id === messageId);
  if (!message) throw new Error("missing message");
  return message;
};

export const completed = (env: TestEnv, sessionId: string, index = 0) => (): boolean => stateOf(env, sessionId).runs[index]?.status === "completed";
