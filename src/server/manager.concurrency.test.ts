import { afterEach, describe, expect, it, vi } from "vitest";
import { USER } from "@shared/testing";
import { silentLogger } from "./logger";
import { UNLIMITED_RUNS } from "./run-slots";
import { ManualExecutor, delegatorFor, makeTrackedEnv, shutdownTrackedEnvs, stateOf, until, type TestEnv } from "./testing";

// 运行中调整全局并发上限（设置窗口里的“并发上限”）在 SessionManager 这一层的行为：
// 调高让排队的会话立刻开始，调低绝不中断在跑的会话。队列本身的先到先得见 run-slots.test.ts。

const delegate = delegatorFor("pi", "Refactor the parser module");

afterEach(async () => {
  vi.restoreAllMocks();
  await shutdownTrackedEnvs();
});

/** 依次委派几个会话（任务文本不同，免得被当成重复）。 */
async function delegateAll(env: TestEnv, tasks: string[]) {
  const delegated: Array<Awaited<ReturnType<typeof delegate>>> = [];
  for (const task of tasks) delegated.push(await delegate(env, { task }));
  return delegated;
}

/** 恰好 `count` 个会话已经连上执行端、并且各自的运行已经交给了它。 */
function handedOff(exec: ManualExecutor, count: number): Promise<void> {
  return until(() => exec.sessions.length === count && exec.sessions.every((session) => session.started.length === 1), 4000, `${count} runs handed to the harness`);
}

const sessionOf = (exec: ManualExecutor, sessionId: string) => exec.sessions.find((session) => session.input.meta.id === sessionId)!;

function limitChanges(spy: { mock: { calls: unknown[][] } }): unknown[] {
  return spy.mock.calls.filter(([message]) => message === "concurrency limit changed").map(([, fields]) => fields);
}

describe("raising the limit while sessions are queued", () => {
  it("starts the sessions that waited longest, as many as the new limit allows, and leaves the rest queued", async () => {
    const exec = new ManualExecutor("pi");
    const env = makeTrackedEnv([exec], { maxConcurrentRuns: 1 });
    const delegated = await delegateAll(env, ["first", "second", "third", "fourth"]);
    const ids = delegated.map(({ sessionId }) => sessionId);
    await handedOff(exec, 1);
    expect(env.manager.capacity()).toEqual({ occupied: 1, max: 1, waiting: 3 });

    env.manager.setMaxConcurrentRuns(3, "settings");
    // 账目当场就平了：两个排队的已经占上名额，第四个还在等。
    expect(env.manager.capacity()).toEqual({ occupied: 3, max: 3, waiting: 1 });
    await handedOff(exec, 3);
    expect(exec.sessions.map((session) => session.input.meta.id).sort()).toEqual(ids.slice(0, 3).sort());
    expect(stateOf(env, ids[3]!).status).toBe("queued");
    expect(stateOf(env, ids[3]!).messages[0]!.delivery).toMatchObject({ stage: "queued", queuedBy: "ensemble", reason: "capacity" });
  });

  it("moves a promoted session's task on from 'queued for capacity' to applied once its run starts", async () => {
    const exec = new ManualExecutor("pi");
    const env = makeTrackedEnv([exec], { maxConcurrentRuns: 1 });
    const [, second] = await delegateAll(env, ["first", "second"]);
    await handedOff(exec, 1);
    expect(stateOf(env, second!.sessionId).messages[0]!.delivery).toMatchObject({ stage: "queued", reason: "capacity" });

    env.manager.setMaxConcurrentRuns(2, "settings");
    await handedOff(exec, 2);
    sessionOf(exec, second!.sessionId).start(second!.runId);
    await until(() => stateOf(env, second!.sessionId).messages[0]?.delivery.stage === "applied", 4000, "the task applied");
    expect(stateOf(env, second!.sessionId).messages[0]!.delivery.history.map((entry) => entry.stage)).toContain("queued");
  });

  it("starts everybody who is waiting when the limit is lifted, and nobody waits afterwards", async () => {
    const exec = new ManualExecutor("pi");
    const env = makeTrackedEnv([exec], { maxConcurrentRuns: 1 });
    await delegateAll(env, ["a", "b", "c", "d"]);
    await handedOff(exec, 1);

    env.manager.setMaxConcurrentRuns(UNLIMITED_RUNS, "settings");
    await handedOff(exec, 4);
    expect(env.manager.capacity()).toEqual({ occupied: 4, max: UNLIMITED_RUNS, waiting: 0 });
    await delegate(env, { task: "e" });
    expect(env.manager.capacity().waiting).toBe(0);
  });

  it("does not start a session that was cancelled while it waited", async () => {
    const exec = new ManualExecutor("pi");
    const env = makeTrackedEnv([exec], { maxConcurrentRuns: 1 });
    const [, second, third] = await delegateAll(env, ["first", "second", "third"]);
    await handedOff(exec, 1);
    await env.manager.cancel(second!.sessionId, USER);
    expect(env.manager.capacity()).toEqual({ occupied: 1, max: 1, waiting: 1 });

    env.manager.setMaxConcurrentRuns(5, "settings");
    await handedOff(exec, 2);
    const opened = exec.sessions.map((session) => session.input.meta.id);
    expect(opened).not.toContain(second!.sessionId);
    expect(opened).toContain(third!.sessionId);
    expect(env.manager.capacity()).toEqual({ occupied: 2, max: 5, waiting: 0 });
  });
});

describe("lowering the limit while sessions are running", () => {
  it("interrupts nobody, makes new sessions wait, and only hands out slots again once occupancy is under the new limit", async () => {
    const exec = new ManualExecutor("pi");
    const env = makeTrackedEnv([exec], { maxConcurrentRuns: 3 });
    const running = await delegateAll(env, ["first", "second", "third"]);
    await handedOff(exec, 3);
    for (const { sessionId, runId } of running) sessionOf(exec, sessionId).start(runId);
    await until(() => running.every(({ sessionId }) => stateOf(env, sessionId).status === "running"), 4000, "three running sessions");

    env.manager.setMaxConcurrentRuns(1, "settings");
    // 占用数暂时高于上限：这是如实的状态，不是错误。
    expect(env.manager.capacity()).toEqual({ occupied: 3, max: 1, waiting: 0 });
    expect(exec.sessions.flatMap((session) => session.cancelled)).toEqual([]);
    for (const { sessionId } of running) expect(stateOf(env, sessionId).status).toBe("running");

    const fourth = await delegate(env, { task: "fourth" });
    await until(() => stateOf(env, fourth.sessionId).status === "queued", 4000, "the fourth session queued");
    expect(stateOf(env, fourth.sessionId).messages[0]!.delivery).toMatchObject({ stage: "queued", queuedBy: "ensemble", reason: "capacity" });
    expect(env.manager.capacity()).toEqual({ occupied: 3, max: 1, waiting: 1 });

    sessionOf(exec, running[0]!.sessionId).complete(running[0]!.runId);
    await until(() => env.manager.capacity().occupied === 2, 4000, "the first slot released");
    sessionOf(exec, running[1]!.sessionId).complete(running[1]!.runId);
    await until(() => env.manager.capacity().occupied === 1, 4000, "the second slot released");
    expect(exec.sessions).toHaveLength(3);
    expect(stateOf(env, fourth.sessionId).status).toBe("queued");

    sessionOf(exec, running[2]!.sessionId).complete(running[2]!.runId);
    await handedOff(exec, 4);
    expect(env.manager.capacity()).toEqual({ occupied: 1, max: 1, waiting: 0 });
  });

  it("leaves running sessions alone when the limit is lifted and lowered again", async () => {
    const exec = new ManualExecutor("pi");
    const env = makeTrackedEnv([exec], { maxConcurrentRuns: 2 });
    await delegateAll(env, ["first", "second"]);
    await handedOff(exec, 2);

    env.manager.setMaxConcurrentRuns(UNLIMITED_RUNS, "settings");
    env.manager.setMaxConcurrentRuns(1, "settings");
    expect(env.manager.capacity()).toEqual({ occupied: 2, max: 1, waiting: 0 });
    expect(exec.sessions.flatMap((session) => session.cancelled)).toEqual([]);
  });
});

describe("changing the limit", () => {
  it("logs one line for every real change, with the old and new limit and who decided it, and none when nothing changed", () => {
    const info = vi.spyOn(silentLogger, "info");
    const env = makeTrackedEnv([new ManualExecutor("pi")], { maxConcurrentRuns: 4 });

    env.manager.setMaxConcurrentRuns(4, "settings");
    expect(limitChanges(info)).toEqual([]);

    env.manager.setMaxConcurrentRuns(9, "settings");
    env.manager.setMaxConcurrentRuns(UNLIMITED_RUNS, "env");
    env.manager.setMaxConcurrentRuns(2, "default");
    expect(limitChanges(info)).toEqual([
      { from: 4, to: 9, source: "settings", occupied: 0, waiting: 0 },
      // 不设上限在日志里写成 "unlimited"，0 读起来像“一个都不许跑”。
      { from: 9, to: "unlimited", source: "env", occupied: 0, waiting: 0 },
      { from: "unlimited", to: 2, source: "default", occupied: 0, waiting: 0 },
    ]);
  });

  it("refuses a limit RunSlots cannot use, and changes and logs nothing", () => {
    const info = vi.spyOn(silentLogger, "info");
    const env = makeTrackedEnv([new ManualExecutor("pi")], { maxConcurrentRuns: 3 });
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => env.manager.setMaxConcurrentRuns(bad, "settings")).toThrow(RangeError);
    }
    expect(env.manager.capacity().max).toBe(3);
    expect(limitChanges(info)).toEqual([]);
  });

  it("tells capacity listeners about occupancy, waiting and limit changes, and stops when they unsubscribe", async () => {
    const exec = new ManualExecutor("pi");
    const env = makeTrackedEnv([exec], { maxConcurrentRuns: 1 });
    const seen: Array<{ occupied: number; max: number; waiting: number }> = [];
    const unsubscribe = env.manager.onCapacityChange(() => void seen.push(env.manager.capacity()));

    const [first] = await delegateAll(env, ["first", "second"]);
    expect(seen.at(-1)).toEqual({ occupied: 1, max: 1, waiting: 1 });

    env.manager.setMaxConcurrentRuns(2, "settings");
    expect(seen.at(-1)).toEqual({ occupied: 2, max: 2, waiting: 0 });
    await handedOff(exec, 2);

    unsubscribe();
    const count = seen.length;
    sessionOf(exec, first!.sessionId).complete(first!.runId);
    await until(() => env.manager.capacity().occupied === 1, 4000, "a slot released");
    expect(seen).toHaveLength(count);
  });

  it("keeps the slots straight when a capacity listener throws, and says so in the log", async () => {
    const warn = vi.spyOn(silentLogger, "warn");
    const env = makeTrackedEnv([new ManualExecutor("pi")], { maxConcurrentRuns: 1 });
    env.manager.onCapacityChange(() => {
      throw new Error("listener bug");
    });

    await delegateAll(env, ["first", "second"]);
    expect(env.manager.capacity()).toEqual({ occupied: 1, max: 1, waiting: 1 });
    env.manager.setMaxConcurrentRuns(2, "settings");
    expect(env.manager.capacity()).toEqual({ occupied: 2, max: 2, waiting: 0 });
    expect(warn).toHaveBeenCalledWith("capacity listener failed", expect.anything());
  });
});
