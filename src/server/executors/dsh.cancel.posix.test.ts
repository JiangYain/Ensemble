import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { USER, testMeta } from "@shared/testing";
import type { ErrorInfo, SessionMeta } from "@shared/types";
import { silentLogger } from "../logger";
import { delegatorFor, itemsOf, shutdownTrackedEnvs, stateOf, until, type TestEnv } from "../testing";
import type { DshExecutor } from "./dsh";
import { setup } from "./dsh.fakes";
import { CAN_RUN_REAL_TREES, cleanupRealProcesses, isRunning, killIfSame, startBystander, startMarkOf } from "./process-tree.fakes";

// dsh 取消 / 关闭的真实进程测试，Linux 与 macOS 版：对应 dsh.cancel.test.ts 里那几条只在 Windows 上跑的真实进程测试。
// 假 dsh（test/fixtures/fake-dsh.mjs）在 POSIX 上同样复现“只结束工具的 shell、之下的进程留下”的现象；
// 这些测试检查默认的孤儿清理与“结束整棵树”在真实进程上做对了。编写时没有运行过，Windows 上整个跳过，macOS 更是至今没有可用的环境。
//
// 只结束自己起的进程：清理按“pid + 起始标记”核对，pid 被别的进程复用时对不上就不动；假 dsh 的工具进程自带 5 分钟寿命上限。
// 在 Linux / macOS 上运行：
//   npx vitest run --project node src/server/executors/dsh.cancel.posix.test.ts

afterEach(async () => {
  await shutdownTrackedEnvs();
  cleanupRealProcesses();
});

const WAIT = 15_000;
const delegate = delegatorFor("dsh");
const diagnostics = (env: TestEnv, sessionId: string) => itemsOf(env, sessionId, "diagnostic");
const toolRunning = (env: TestEnv, sessionId: string) => until(() => itemsOf(env, sessionId, "tool").some((tool) => tool.status === "running"), WAIT, "tool running");
const cancelled = (env: TestEnv, sessionId: string) => until(() => stateOf(env, sessionId).runs[0]?.status === "cancelled", WAIT, "run cancelled");

interface Emitted {
  kind: string;
  data: any;
  runId?: string;
}

/** 不经管理器直接打开执行端会话（与 dsh.cancel.test.ts 里的同名辅助一致）。 */
async function openDirect(executor: DshExecutor, overrides: Partial<SessionMeta> = {}) {
  const emitted: Emitted[] = [];
  const fatals: ErrorInfo[] = [];
  const controller = new AbortController();
  const session = await executor.open({
    meta: testMeta({ harness: "dsh", cwd: tmpdir(), model: undefined, ...overrides }),
    emit: (draft) => emitted.push(draft as Emitted),
    fatal: (error) => fatals.push(error),
    log: silentLogger,
    signal: controller.signal,
  });
  const finish = async () => {
    controller.abort();
    await session.close();
  };
  return { session, emitted, fatals, finish };
}

/** 记下 pid 与起始标记，测试结束时只在“还是当初那个进程”时才结束它。 */
function remember(...pids: number[]): () => void {
  const marks = pids.map((pid) => [pid, startMarkOf(pid)] as const);
  return () => {
    for (const [pid, mark] of marks) killIfSame(pid, mark);
  };
}

describe.skipIf(!CAN_RUN_REAL_TREES)("DSH 适配器：取消后清理孤儿进程（Linux / macOS 真实进程）", () => {
  it("dsh 只结束工具的 shell，孙进程被默认的清理结束，无关进程不受影响，并留下说明", async () => {
    const { env, pids } = setup();
    // 与这次取消毫无关系的进程：清理只能动快照里的孤儿。
    const bystander = startBystander();
    const { sessionId } = await delegate(env, { task: "Run [fake:orphan]" });
    await until(() => pids() !== undefined, WAIT, "tool tree started");
    await toolRunning(env, sessionId);
    const { shell, leaf } = pids()!;
    const cleanup = remember(shell, leaf);
    try {
      expect(isRunning(leaf)).toBe(true);
      await env.manager.cancel(sessionId, USER);
      await cancelled(env, sessionId);
      await until(() => !isRunning(leaf), WAIT, "orphan removed");
      expect(isRunning(shell)).toBe(false);
      expect(isRunning(bystander)).toBe(true);
      await until(() => diagnostics(env, sessionId).some((item) => item.code === "dsh.orphans_stopped"), WAIT, "cleanup diagnostic");
      expect(diagnostics(env, sessionId).find((item) => item.code === "dsh.orphans_stopped")).toMatchObject({ level: "info", message: expect.stringContaining(`(pid ${leaf})`) });
      // 清理成功，没有“清不掉”或“读不了进程表”之类的说明。
      expect(diagnostics(env, sessionId).filter((item) => item.code === "dsh.orphans_remaining" || item.code.startsWith("dsh.sweep"))).toEqual([]);
    } finally {
      cleanup();
    }
  }, 60_000);

  it("对照：不清理（processTools: null）时孙进程确实会留下，证明假 dsh 在这个系统上复现了孤儿现象，上面的清理不是白捡的", async () => {
    const { env, pids } = setup({}, { processTools: null });
    const { sessionId } = await delegate(env, { task: "Run [fake:orphan]" });
    await until(() => pids() !== undefined, WAIT, "tool tree started");
    await toolRunning(env, sessionId);
    const { shell, leaf } = pids()!;
    const cleanup = remember(shell, leaf);
    try {
      await env.manager.cancel(sessionId, USER);
      await cancelled(env, sessionId);
      await until(() => !isRunning(shell), WAIT, "shell ended by dsh");
      // 给清理（如果有的话）足够的时间，孙进程仍然活着。
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(isRunning(leaf)).toBe(true);
    } finally {
      cleanup();
    }
  }, 60_000);

  it("没有孤儿时取消不动任何进程，也不留清理相关的说明（读进程表本身成功了）", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Wait [fake:hold]" });
    await toolRunning(env, sessionId);
    await env.manager.cancel(sessionId, USER);
    await cancelled(env, sessionId);
    // 清理在后台做：给它一点时间；读表失败会留下 dsh.sweep_skipped / dsh.sweep_failed，这里一条都不该有。
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(diagnostics(env, sessionId).filter((item) => item.code.startsWith("dsh.sweep") || item.code.startsWith("dsh.orphans"))).toEqual([]);
  }, 60_000);

  it("运行中关闭会话：整棵进程树（dsh、工具的 shell、shell 之外 detached 的孙进程）一起结束", async () => {
    const { env, pids, launches } = setup();
    const { sessionId } = await delegate(env, { task: "Run [fake:orphan]" });
    await until(() => pids() !== undefined, WAIT, "tool tree started");
    await toolRunning(env, sessionId);
    const { shell, leaf } = pids()!;
    const dsh = launches()[0]!.pid!;
    const cleanup = remember(dsh, shell, leaf);
    try {
      await env.manager.shutdown();
      await until(() => !isRunning(leaf) && !isRunning(shell) && !isRunning(dsh), WAIT, "process tree gone");
    } finally {
      cleanup();
    }
  }, 60_000);

  it("并发的两次关闭（管理器与中止信号）共用一次“结束整棵树”：dsh 在标准输入关闭后先退出，也不会留下孙进程", async () => {
    // 真实的 dsh 在标准输入关闭后会自己退出：若第二次 close() 越过“结束整棵树”抢先关了标准输入，
    // 结束整棵树到场时 dsh 已经没了，沿 ppid 找不到它的后代，工具的子进程就被留下（Windows 上用真实 dsh 实测到的竞态；POSIX 上的做法同样依赖父子关系）。
    const { executor, pids } = setup({ FAKE_DSH_EXIT_ON_EOF: "1" });
    const { session, emitted, finish } = await openDirect(executor);
    let cleanup = (): void => undefined;
    try {
      await session.startRun({ runId: "run_a", messageId: "msg_a", prompt: "Run [fake:orphan]", trigger: "task" });
      await until(() => pids() !== undefined && emitted.some((entry) => entry.kind === "tool.updated"), WAIT, "tool tree started");
      const { shell, leaf } = pids()!;
      cleanup = remember(shell, leaf);
      await Promise.all([session.close(), session.close()]);
      await until(() => !isRunning(leaf) && !isRunning(shell), WAIT, "shell and leaf gone");
    } finally {
      await finish();
      cleanup();
    }
  }, 60_000);
});
