/**
 * 手动控制的执行端下的排队：超出并发上限的会话排队并按先后接手、默认 20 路与“不限”、执行端不能中途注入时退回排队的补充消息、
 * 会话还在启动时被扣住的纠偏、纠偏被执行端拒绝时的投递失败。
 * 执行端打不开、退出、取消、停止、重启这些收尾的行为在 manager.lifecycle.test.ts；用 fixture 执行端跑完整个委派的在 manager.test.ts。
 */

import { describe, expect, it } from "vitest";
import { toSummary } from "@shared/projection";
import { USER } from "@shared/testing";
import { delegate } from "./manager.fixtures";
import { UNLIMITED_RUNS } from "./run-slots";
import { ManualExecutor, makeEnv, stateOf, until, type TestEnv } from "./testing";

/** 这个会话有没有出现过“排队”：会话状态进过 queued，或任务消息的投递记录里出现过 queued。 */
function everQueued(env: TestEnv, sessionId: string): boolean {
  return env.hub.events(sessionId).some((event) =>
    (event.kind === "session.status" && event.data.status === "queued") ||
    (event.kind === "message.delivery" && event.data.record.stage === "queued"));
}

describe("scheduling with a manually controlled executor", () => {
  it("queues sessions beyond the concurrency limit and starts them when capacity frees up", async () => {
    const exec = new ManualExecutor("pi");
    const env = makeEnv([exec], { maxConcurrentRuns: 1 });
    const first = await delegate(env, { task: "first" });
    const second = await delegate(env, { task: "second" });

    await until(() => exec.sessions.length === 1 && exec.sessions[0]!.started.length === 1);
    expect(stateOf(env, second.sessionId).status).toBe("queued");
    const queuedTask = stateOf(env, second.sessionId).messages[0]!;
    expect(queuedTask.delivery).toMatchObject({ stage: "queued", queuedBy: "ensemble", reason: "capacity" });
    expect(toSummary(stateOf(env, second.sessionId)).phase).toBe("queued");

    const firstSession = exec.sessions[0]!;
    firstSession.start(first.runId);
    firstSession.complete(first.runId);
    await until(() => exec.sessions.length === 2 && exec.sessions[1]!.started.length === 1);
    expect(stateOf(env, second.sessionId).status).toBe("starting");
    exec.sessions[1]!.start(second.runId);
    await until(() => stateOf(env, second.sessionId).status === "running");
    expect(env.manager.capacity()).toMatchObject({ occupied: 1, waiting: 0 });
  });

  it("gives freed slots to queued sessions in the order they asked", async () => {
    const exec = new ManualExecutor("pi");
    const env = makeEnv([exec], { maxConcurrentRuns: 1 });
    const first = await delegate(env, { task: "first" });
    const second = await delegate(env, { task: "second" });
    const third = await delegate(env, { task: "third" });
    expect(env.manager.capacity()).toEqual({ occupied: 1, max: 1, waiting: 2 });
    const sessionOf = (sessionId: string) => exec.sessions.find((session) => session.input.meta.id === sessionId);

    await until(() => sessionOf(first.sessionId)?.started.length === 1);
    sessionOf(first.sessionId)!.complete(first.runId);
    await until(() => sessionOf(second.sessionId)?.started.length === 1);
    expect(stateOf(env, third.sessionId).status).toBe("queued");
    expect(sessionOf(third.sessionId)).toBeUndefined();

    sessionOf(second.sessionId)!.complete(second.runId);
    await until(() => sessionOf(third.sessionId)?.started.length === 1);
    expect(env.manager.capacity()).toEqual({ occupied: 1, max: 1, waiting: 0 });
  });

  it("starts up to 20 sessions at once by default, queues the 21st and starts it as soon as any one finishes", async () => {
    const exec = new ManualExecutor("pi");
    const env = makeEnv([exec]);
    const sessionOf = (sessionId: string) => exec.sessions.find((session) => session.input.meta.id === sessionId)!;

    const firstTwenty: Array<Awaited<ReturnType<typeof delegate>>> = [];
    for (let i = 1; i <= 20; i += 1) {
      firstTwenty.push(await delegate(env, { task: `task ${i}` }));
      expect(env.manager.capacity().waiting).toBe(0);
    }
    await until(() => exec.sessions.length === 20 && exec.sessions.every((session) => session.started.length === 1), 4000, "20 runs handed to the harness");
    for (const { sessionId, runId } of firstTwenty) sessionOf(sessionId).start(runId);
    await until(() => firstTwenty.every(({ sessionId }) => stateOf(env, sessionId).status === "running"), 4000, "20 running sessions");
    expect(env.manager.capacity()).toEqual({ occupied: 20, max: 20, waiting: 0 });
    for (const { sessionId } of firstTwenty) expect(everQueued(env, sessionId), sessionId).toBe(false);

    // 超过 20 个时才排队，并且如实标成“等待并发名额”，而不是拒绝。
    const extra = await delegate(env, { task: "task 21" });
    expect(stateOf(env, extra.sessionId).status).toBe("queued");
    expect(stateOf(env, extra.sessionId).messages[0]!.delivery).toMatchObject({ stage: "queued", queuedBy: "ensemble", reason: "capacity" });
    expect(env.manager.capacity()).toEqual({ occupied: 20, max: 20, waiting: 1 });
    expect(exec.sessions).toHaveLength(20);

    // 任意一个结束（不必是最先开始的那个），排队的立刻接手。
    const finishing = firstTwenty[6]!;
    sessionOf(finishing.sessionId).complete(finishing.runId);
    await until(() => exec.sessions.length === 21 && exec.sessions[20]!.started.length === 1, 4000, "the 21st run handed to the harness");
    expect(exec.sessions[20]!.input.meta.id).toBe(extra.sessionId);
    expect(stateOf(env, extra.sessionId).status).toBe("starting");
    exec.sessions[20]!.start(extra.runId);
    await until(() => stateOf(env, extra.sessionId).status === "running");
    expect(env.manager.capacity()).toEqual({ occupied: 20, max: 20, waiting: 0 });
  });

  it("runs 30 sessions at once, and nobody ever waits, when the limit is turned off", async () => {
    const exec = new ManualExecutor("pi");
    const env = makeEnv([exec], { maxConcurrentRuns: UNLIMITED_RUNS });
    const sessionOf = (sessionId: string) => exec.sessions.find((session) => session.input.meta.id === sessionId)!;
    let mostWaiting = 0;
    const unsubscribe = env.hub.subscribe(() => {
      mostWaiting = Math.max(mostWaiting, env.manager.capacity().waiting);
    });

    const delegated: Array<Awaited<ReturnType<typeof delegate>>> = [];
    for (let i = 1; i <= 30; i += 1) {
      delegated.push(await delegate(env, { task: `task ${i}` }));
      expect(env.manager.capacity().waiting).toBe(0);
    }
    await until(() => exec.sessions.length === 30 && exec.sessions.every((session) => session.started.length === 1), 4000, "30 runs handed to the harness");
    for (const { sessionId, runId } of delegated) sessionOf(sessionId).start(runId);
    await until(() => delegated.every(({ sessionId }) => stateOf(env, sessionId).status === "running"), 4000, "30 running sessions");
    expect(env.manager.capacity()).toEqual({ occupied: 30, max: UNLIMITED_RUNS, waiting: 0 });
    for (const { sessionId } of delegated) expect(everQueued(env, sessionId), sessionId).toBe(false);

    for (const { sessionId, runId } of delegated) sessionOf(sessionId).complete(runId);
    await until(() => env.manager.capacity().occupied === 0, 4000, "all slots released");
    unsubscribe();
    expect(mostWaiting).toBe(0);
    expect(env.manager.capacity()).toEqual({ occupied: 0, max: UNLIMITED_RUNS, waiting: 0 });
  });

  it("falls back to a queued follow-up when the harness cannot inject into a running turn", async () => {
    const exec = new ManualExecutor("pi");
    const env = makeEnv([exec]);
    const { sessionId, runId } = await delegate(env);
    await until(() => exec.sessions[0]?.started.length === 1);
    const session = exec.sessions[0]!;
    session.start(runId);
    await until(() => stateOf(env, sessionId).status === "running");

    const sent = await env.manager.send(sessionId, { text: "Also update the docs", author: USER });
    expect(sent.kind).toBe("steer");
    const message = stateOf(env, sessionId).messages.find((m) => m.id === sent.messageId)!;
    expect(message.delivery).toMatchObject({ stage: "queued", queuedBy: "ensemble", reason: "run_in_progress" });
    expect(session.steers).toHaveLength(1);

    // 当前运行结束后，排队的消息作为新的运行发送给执行端。
    session.complete(runId);
    await until(() => session.started.length === 2);
    expect(session.started[1]).toMatchObject({ prompt: "Also update the docs", trigger: "follow_up" });
    const nextRunId = session.started[1]!.runId;
    session.start(nextRunId);
    await until(() => stateOf(env, sessionId).messages.find((m) => m.id === sent.messageId)?.delivery.stage === "applied");
  });

  it("queues explicit follow-ups behind the active run", async () => {
    const exec = new ManualExecutor("pi");
    const env = makeEnv([exec]);
    const { sessionId, runId } = await delegate(env);
    await until(() => exec.sessions[0]?.started.length === 1);
    const session = exec.sessions[0]!;
    session.start(runId);
    await until(() => stateOf(env, sessionId).status === "running");

    const sent = await env.manager.send(sessionId, { text: "After that, run the linter", mode: "follow_up", author: USER });
    expect(sent.kind).toBe("follow_up");
    expect(session.steers).toHaveLength(0);
    expect(stateOf(env, sessionId).messages.at(-1)?.delivery).toMatchObject({ stage: "queued", queuedBy: "ensemble" });
    expect(stateOf(env, sessionId).runs.map((r) => r.status)).toEqual(["running", "queued"]);
  });

  it("holds steers that arrive while the session is still starting and delivers them once the run begins", async () => {
    const exec = new ManualExecutor("pi");
    exec.steerOutcome = { kind: "delivered", evidence: "pi: steer acknowledged" };
    const env = makeEnv([exec]);
    const { sessionId, runId } = await delegate(env);
    await until(() => exec.sessions[0]?.started.length === 1);
    const session = exec.sessions[0]!;

    const sent = await env.manager.send(sessionId, { text: "Use async/await", author: USER });
    const early = stateOf(env, sessionId).messages.find((m) => m.id === sent.messageId)!;
    expect(early.delivery).toMatchObject({ stage: "queued", queuedBy: "ensemble", reason: "session_starting" });
    expect(session.steers).toHaveLength(0);

    session.start(runId);
    await until(() => stateOf(env, sessionId).messages.find((m) => m.id === sent.messageId)?.delivery.stage === "applied");
    expect(session.steers).toHaveLength(1);
    expect(stateOf(env, sessionId).messages.find((m) => m.id === sent.messageId)?.delivery.evidence).toBe("pi: steer acknowledged");
  });

  it("records a failed delivery when the harness rejects a steer", async () => {
    const exec = new ManualExecutor("pi");
    const env = makeEnv([exec]);
    const { sessionId, runId } = await delegate(env);
    await until(() => exec.sessions[0]?.started.length === 1);
    const session = exec.sessions[0]!;
    session.start(runId);
    await until(() => stateOf(env, sessionId).status === "running");
    session.steer = async () => {
      throw new Error("RPC error: no active turn");
    };
    const sent = await env.manager.send(sessionId, { text: "Change course", author: USER });
    const message = stateOf(env, sessionId).messages.find((m) => m.id === sent.messageId)!;
    expect(message.delivery.stage).toBe("failed");
    expect(message.delivery.error?.message).toContain("no active turn");
  });
});
