import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { USER, testMeta } from "@shared/testing";
import type { ErrorInfo, NativeRef, SessionMeta } from "@shared/types";
import { silentLogger } from "../logger";
import { delegatorFor, itemsOf, shutdownTrackedEnvs, stateOf, until, type TestEnv } from "../testing";
import type { DshExecutor } from "./dsh";
import { alive, setup } from "./dsh.fakes";
import type { ProcInfo, ProcessTools } from "./process-tree";

afterEach(shutdownTrackedEnvs);

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

/** 不经管理器直接打开执行端会话，用来检查适配器自己的行为（取消的次数、恢复、转发的事件）。 */
async function openDirect(executor: DshExecutor, overrides: Partial<SessionMeta> = {}, resume?: NativeRef) {
  const emitted: Emitted[] = [];
  const fatals: ErrorInfo[] = [];
  const controller = new AbortController();
  const session = await executor.open({
    meta: testMeta({ harness: "dsh", cwd: tmpdir(), model: undefined, ...overrides }),
    ...(resume ? { resume } : {}),
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

describe("DSH 适配器：取消", () => {
  it("这一轮以 cancelled 结束，进行中的工具记为已取消，同一个 dsh 进程继续下一轮", async () => {
    const { env, launches } = setup();
    const { sessionId } = await delegate(env, { task: "Wait [fake:hold]" });
    await toolRunning(env, sessionId);
    await env.manager.cancel(sessionId, USER);
    await cancelled(env, sessionId);
    // 被我们取消的工具是“已取消”，不是“失败”。
    expect(itemsOf(env, sessionId, "tool")[0]).toMatchObject({ name: "pwsh", status: "cancelled" });
    const next = await env.manager.send(sessionId, { text: "Continue", author: USER });
    await until(() => stateOf(env, sessionId).runs.find((run) => run.id === next.runId)?.status === "completed", WAIT, "next run");
    expect(stateOf(env, sessionId).runs.map((run) => run.status)).toEqual(["cancelled", "completed"]);
    expect(itemsOf(env, sessionId, "assistant").at(-1)?.text).toBe("Done (turn 2).");
    expect(launches()).toHaveLength(1);
  });

  it("同一次取消只通知 dsh 一次；运行已经结束或不是当前运行时什么也不做", async () => {
    const { executor, requests } = setup();
    const { session, emitted, finish } = await openDirect(executor);
    try {
      await session.startRun({ runId: "run_a", messageId: "msg_a", prompt: "Wait [fake:hold]", trigger: "task" });
      await until(() => emitted.some((entry) => entry.kind === "tool.updated"), WAIT, "tool started");
      await session.cancel("run_other");
      await Promise.all([session.cancel("run_a"), session.cancel("run_a")]);
      await until(() => emitted.some((entry) => entry.kind === "run.cancelled"), WAIT, "run cancelled");
      await session.cancel("run_a");
      expect(requests("session/cancel")).toEqual([expect.objectContaining({ sessionId: expect.any(String) })]);
      expect(emitted.filter((entry) => entry.kind === "run.cancelled")).toHaveLength(1);
    } finally {
      await finish();
    }
  });

  it("steer 直接说明做不到（dsh 一次只收一个 prompt），不假装已经注入", async () => {
    const { executor, requests } = setup();
    const { session, emitted, finish } = await openDirect(executor);
    try {
      await session.startRun({ runId: "run_a", messageId: "msg_a", prompt: "Wait [fake:hold]", trigger: "task" });
      await until(() => emitted.some((entry) => entry.kind === "tool.updated"), WAIT, "tool started");
      const outcome = await session.steer({ runId: "run_a", messageId: "msg_b", text: "Do it differently" });
      expect(outcome).toMatchObject({ kind: "needs_follow_up", reason: "run_in_progress", evidence: expect.stringContaining("one session/prompt at a time") });
      // 没有向 dsh 发出第二个 prompt。
      expect(requests("session/prompt")).toHaveLength(1);
    } finally {
      await finish();
    }
  });

  it("运行结束前同一会话再开一个运行会被拒绝，不会向 dsh 发第二个并发的 prompt", async () => {
    const { executor, requests } = setup();
    const { session, emitted, finish } = await openDirect(executor);
    try {
      await session.startRun({ runId: "run_a", messageId: "msg_a", prompt: "Wait [fake:hold]", trigger: "task" });
      await expect(session.startRun({ runId: "run_b", messageId: "msg_b", prompt: "Again", trigger: "follow_up" })).rejects.toThrow(/already active/);
      expect(requests("session/prompt")).toHaveLength(1);
      await until(() => emitted.some((entry) => entry.kind === "tool.updated"), WAIT, "tool started");
    } finally {
      await finish();
    }
  });
});

describe("DSH 适配器：取消后清理孤儿进程", () => {
  it("取消前拍进程树快照，运行结束后只结束孤儿（用模拟的进程表验证次序与对象）", async () => {
    let rig!: ReturnType<typeof setup>;
    const seenCancels: number[] = [];
    const killed: number[] = [];
    const born = { shell: 0, leaf: 0 };
    const tools: ProcessTools = {
      list: async () => {
        // 每次读进程表时，dsh 已经收到了几次 session/cancel。
        seenCancels.push(rig.requests("session/cancel").length);
        const root = rig.launches()[0]!.pid!;
        const first = seenCancels.length === 1;
        if (first) {
          born.shell = Date.now();
          born.leaf = Date.now();
        }
        const table: ProcInfo[] = [
          { pid: root, ppid: 1, created: 1, name: "node.exe" },
          { pid: 90_002, ppid: 90_001, created: born.leaf, name: "sleep.exe" },
        ];
        // 取消前：工具的 shell 与它启动的进程都在；结束后：shell 已被 dsh 结束，只剩下孙进程。
        if (first) table.push({ pid: 90_001, ppid: root, created: born.shell, name: "pwsh.exe" });
        return table;
      },
      kill: async (pid) => {
        killed.push(pid);
      },
    };
    rig = setup({}, { processTools: tools });
    const { env } = rig;
    const { sessionId } = await delegate(env, { task: "Wait [fake:hold]" });
    await toolRunning(env, sessionId);
    await env.manager.cancel(sessionId, USER);
    await cancelled(env, sessionId);
    await until(() => killed.length > 0, WAIT, "orphan cleanup");
    expect(seenCancels).toEqual([0, 1]);
    expect(killed).toEqual([90_002]);
    expect(diagnostics(env, sessionId).find((item) => item.code === "dsh.orphans_stopped")).toMatchObject({ level: "info", message: expect.stringContaining("sleep.exe (pid 90002)") });
  });

  it("没有工具在跑时取消不读进程表（只是在等模型，没有可清理的东西），取消也不会因此变慢", async () => {
    let listed = 0;
    const tools: ProcessTools = {
      list: async () => {
        listed += 1;
        return [];
      },
      kill: async () => undefined,
    };
    const { executor, requests } = setup({}, { processTools: tools });
    const { session, emitted, finish } = await openDirect(executor);
    try {
      await session.startRun({ runId: "run_a", messageId: "msg_a", prompt: "Wait [fake:waitmodel]", trigger: "task" });
      await until(() => emitted.some((entry) => entry.kind === "assistant.delta"), WAIT, "first update");
      await session.cancel("run_a");
      await until(() => emitted.some((entry) => entry.kind === "run.cancelled"), WAIT, "run cancelled");
      expect(requests("session/cancel")).toHaveLength(1);
      expect(listed).toBe(0);
      // 没有工具在跑，所以也没有“已取消的工具”这类事件。
      expect(emitted.some((entry) => entry.kind === "tool.updated")).toBe(false);
    } finally {
      await finish();
    }
  });

  it("进程表读不出来时取消照常完成，并留下说明", async () => {
    const tools: ProcessTools = {
      list: async () => {
        throw new Error("CIM unavailable");
      },
      kill: async () => undefined,
    };
    const { env } = setup({}, { processTools: tools });
    const { sessionId } = await delegate(env, { task: "Wait [fake:hold]" });
    await toolRunning(env, sessionId);
    await env.manager.cancel(sessionId, USER);
    await cancelled(env, sessionId);
    expect(diagnostics(env, sessionId).find((item) => item.code === "dsh.sweep_skipped")).toMatchObject({ level: "warn", message: expect.stringContaining("CIM unavailable") });
  });

  it("明确不清理（processTools: null）时取消照常，也不留清理相关的说明", async () => {
    const { env } = setup({}, { processTools: null });
    const { sessionId } = await delegate(env, { task: "Wait [fake:hold]" });
    await toolRunning(env, sessionId);
    await env.manager.cancel(sessionId, USER);
    await cancelled(env, sessionId);
    expect(diagnostics(env, sessionId).filter((item) => item.code.startsWith("dsh.sweep") || item.code.startsWith("dsh.orphans"))).toEqual([]);
  });

  it.skipIf(process.platform !== "win32")("真实进程（Windows）：dsh 只结束工具的 shell，孙进程被清理，无关进程不受影响", async () => {
    const { env, pids } = setup();
    // 与这次取消毫无关系的进程：清理只能动快照里的孤儿。
    const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    try {
      const { sessionId } = await delegate(env, { task: "Run [fake:orphan]" });
      await until(() => pids() !== undefined, WAIT, "tool tree started");
      await toolRunning(env, sessionId);
      const { shell, leaf } = pids()!;
      expect(alive(leaf)).toBe(true);
      await env.manager.cancel(sessionId, USER);
      await cancelled(env, sessionId);
      await until(() => !alive(leaf), WAIT, "orphan removed");
      expect(alive(shell)).toBe(false);
      expect(alive(bystander.pid!)).toBe(true);
      await until(() => diagnostics(env, sessionId).some((item) => item.code === "dsh.orphans_stopped"), WAIT, "cleanup diagnostic");
    } finally {
      bystander.kill();
    }
  });

  it.skipIf(process.platform !== "win32")("对照（Windows）：不清理时孙进程确实会留下，证明假 dsh 复现了孤儿现象，上面的清理不是白捡的", async () => {
    const { env, pids } = setup({}, { processTools: null });
    const { sessionId } = await delegate(env, { task: "Run [fake:orphan]" });
    await until(() => pids() !== undefined, WAIT, "tool tree started");
    await toolRunning(env, sessionId);
    const { shell, leaf } = pids()!;
    try {
      await env.manager.cancel(sessionId, USER);
      await cancelled(env, sessionId);
      await until(() => !alive(shell), WAIT, "shell ended by dsh");
      // 给清理（如果有的话）足够的时间，孙进程仍然活着。
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(alive(leaf)).toBe(true);
    } finally {
      try {
        process.kill(leaf);
      } catch {
        // 已经退出就算了。
      }
    }
  });

  it.skipIf(process.platform !== "win32")("真实进程（Windows）：运行中关闭会话，整棵进程树（包括工具的孙进程）一起结束", async () => {
    const { env, pids, launches } = setup();
    const { sessionId } = await delegate(env, { task: "Run [fake:orphan]" });
    await until(() => pids() !== undefined, WAIT, "tool tree started");
    await toolRunning(env, sessionId);
    const { shell, leaf } = pids()!;
    const dsh = launches()[0]!.pid!;
    await env.manager.shutdown();
    await until(() => !alive(leaf) && !alive(shell) && !alive(dsh), WAIT, "process tree gone");
  });

  it.skipIf(process.platform !== "win32")("真实进程（Windows）：并发的两次关闭（管理器与中止信号）共用一次“结束整棵树”，dsh 先于 taskkill 退出也不会留下孙进程", async () => {
    // 真实的 dsh 在标准输入关闭后会自己退出：若第二次 close() 越过“结束整棵树”抢先关了标准输入，
    // taskkill 到场时 dsh 已经没了，找不到它的后代，工具的子进程就被留下（真实 dsh 上实测到的竞态）。
    const { executor, pids } = setup({ FAKE_DSH_EXIT_ON_EOF: "1" });
    const { session, emitted, finish } = await openDirect(executor);
    try {
      await session.startRun({ runId: "run_a", messageId: "msg_a", prompt: "Run [fake:orphan]", trigger: "task" });
      await until(() => pids() !== undefined && emitted.some((entry) => entry.kind === "tool.updated"), WAIT, "tool tree started");
      const { shell, leaf } = pids()!;
      await Promise.all([session.close(), session.close()]);
      await until(() => !alive(leaf) && !alive(shell), WAIT, "shell and leaf gone");
    } finally {
      await finish();
    }
  });
});

describe("DSH 适配器：恢复与关闭", () => {
  it("在新进程里恢复同一个 dsh 会话：不新建会话、保留 dsh 记着的上下文，模型与档位不重复设置", async () => {
    const { env, executor, requests, launches } = setup({ FAKE_DSH_MODELS: "multi" });
    const { sessionId } = await delegate(env, { task: "First", model: "deepseek-official/deepseek-v4-pro", effort: "high" });
    await until(() => stateOf(env, sessionId).runs[0]?.status === "completed", WAIT, "first run");
    const native = stateOf(env, sessionId).meta.nativeRef!;
    // 结束第一个 dsh 进程，模拟服务重启。
    await env.manager.shutdown();
    expect(executor.canResume).toBe(true);

    const meta = stateOf(env, sessionId).meta;
    const { session, emitted, finish } = await openDirect(executor, { model: meta.model!, effort: meta.effort! }, native);
    try {
      expect(session.nativeRef).toMatchObject({ kind: "dsh-session", id: native.id });
      expect(launches()).toHaveLength(2);
      expect(requests("session/resume")).toEqual([expect.objectContaining({ sessionId: native.id, mcpServers: [] })]);
      expect(requests("session/new")).toHaveLength(1);
      // 模型与档位由 dsh 自己恢复，第一个进程里设过两次，恢复后不再设。
      expect(requests("session/set_config_option")).toHaveLength(2);

      await session.startRun({ runId: "run_a", messageId: "msg_a", prompt: "Continue", trigger: "follow_up" });
      await until(() => emitted.some((entry) => entry.kind === "run.completed"), WAIT, "resumed run");
      // 第二轮：dsh 记得上一轮（假 dsh 按会话累计轮数），说明是同一个会话而不是新会话。
      expect(emitted.find((entry) => entry.kind === "assistant.completed" && entry.data.text)?.data.text).toBe("Done (turn 2).");
    } finally {
      await finish();
    }
  });

  it("恢复 dsh 不认识的会话：给出明确的 resume_failed", async () => {
    const { executor } = setup();
    await expect(openDirect(executor, {}, { kind: "dsh-session", id: "no-such-session" })).rejects.toMatchObject({ code: "resume_failed" });
  });

  it("正常关闭不算意外中断，并且进程确实退出了", async () => {
    const { executor, launches } = setup();
    const { fatals, finish } = await openDirect(executor);
    const pid = launches()[0]!.pid!;
    expect(alive(pid)).toBe(true);
    await finish();
    await until(() => !alive(pid), WAIT, "dsh exited");
    expect(fatals).toEqual([]);
  });
});
