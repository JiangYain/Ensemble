/**
 * 手动控制的执行端下，会话与运行怎样收尾：执行端打不开、意外退出、断线后只在被要求时恢复，取消排在后面的运行，wait 在运行交接处的表现，
 * 停止会话，以及服务停止 / 重启时的失联、恢复与不改动。
 * 排队与补充消息的投递在 manager.queueing.test.ts；用 fixture 执行端跑完整个委派的在 manager.test.ts。
 */

import { describe, expect, it } from "vitest";
import { newDelivery } from "@shared/delivery";
import { toSummary } from "@shared/projection";
import { USER } from "@shared/testing";
import type { SteerOutcome } from "./executors/types";
import { EventHub } from "./hub";
import { silentLogger } from "./logger";
import { SessionManager } from "./manager";
import { delegate } from "./manager.fixtures";
import { ExecutorRegistry } from "./executors/registry";
import { NoticeCenter } from "./notices";
import { MemoryEventStore } from "./store";
import { ManualExecutor, makeEnv, stateOf, until } from "./testing";
import { waitForSessions } from "./wait";

describe("scheduling with a manually controlled executor", () => {
  it("fails the session and its queued work when the executor cannot be opened", async () => {
    const exec = new ManualExecutor("pi");
    exec.openError = new Error("spawn pi ENOENT");
    const env = makeEnv([exec]);
    const { sessionId } = await delegate(env);
    await until(() => stateOf(env, sessionId).status === "failed");

    const state = stateOf(env, sessionId);
    expect(state.runs[0]?.status).toBe("failed");
    expect(state.runs[0]?.error?.message).toContain("ENOENT");
    expect(state.messages[0]?.delivery.stage).toBe("failed");
    expect(toSummary(state).phase).toBe("failed");
    expect(env.manager.capacity().occupied).toBe(0);
  });

  it("turns an unexpected executor exit into a failed run and a failed session", async () => {
    const exec = new ManualExecutor("pi");
    const env = makeEnv([exec]);
    const { sessionId, runId } = await delegate(env);
    await until(() => exec.sessions[0]?.started.length === 1);
    const session = exec.sessions[0]!;
    session.start(runId);
    await until(() => stateOf(env, sessionId).status === "running");

    session.fail(new Error("pi exited with code 1"));
    await until(() => stateOf(env, sessionId).status === "failed");
    const state = stateOf(env, sessionId);
    expect(state.runs[0]?.status).toBe("failed");
    expect(state.runs[0]?.error?.code).toBe("process_exited");
    expect(env.manager.capacity().occupied).toBe(0);
    expect(session.closed).toBe(true);
  });

  it("fails queued work on disconnect and resumes only when explicitly asked", async () => {
    const exec = new ManualExecutor("pi");
    exec.autoStart = true;
    exec.canResume = true;
    const env = makeEnv([exec]);
    try {
      const { sessionId, runId } = await delegate(env);
      await until(() => env.hub.summary(sessionId)?.activeRunId === runId);
      const session = exec.sessions[0]!;
      const queued = await env.manager.send(sessionId, { text: "Needs the context from run one", mode: "follow_up", author: USER });
      session.fail(new Error("Disconnected"));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(exec.sessions).toHaveLength(1);
      expect(env.hub.summary(sessionId)).toMatchObject({ status: "failed", messages: { pending: 0 } });
      expect(stateOf(env, sessionId).runs.map((run) => run.status)).toEqual(["failed", "failed"]);
      expect(stateOf(env, sessionId).messages.find((message) => message.id === queued.messageId)?.delivery.stage).toBe("failed");
      expect(env.manager.capacity().occupied).toBe(0);

      const resumed = await env.manager.send(sessionId, { text: "Resume and try again", author: USER });
      await until(() => env.hub.summary(sessionId)?.activeRunId === resumed.runId);
      expect(exec.sessions[1]?.input.resume).toEqual(session.nativeRef);
      session.emit({ kind: "run.completed", data: {}, runId: resumed.runId });
      expect(env.hub.summary(sessionId)?.activeRunId).toBe(resumed.runId);
    } finally {
      await env.manager.shutdown();
    }
  });

  it("cancels runs that were queued behind the active one", async () => {
    const exec = new ManualExecutor("pi");
    const env = makeEnv([exec]);
    const { sessionId, runId } = await delegate(env);
    await until(() => exec.sessions[0]?.started.length === 1);
    const session = exec.sessions[0]!;
    session.start(runId);
    await until(() => stateOf(env, sessionId).status === "running");
    await env.manager.send(sessionId, { text: "later", mode: "follow_up", author: USER });

    const result = await env.manager.cancel(sessionId, USER);
    expect(result).toEqual({ interrupted: true, cancelledQueued: 1 });
    await until(() => stateOf(env, sessionId).runs.every((r) => r.status === "cancelled"));
    expect(stateOf(env, sessionId).messages.at(-1)?.delivery.stage).toBe("cancelled");
  });

  it("does not settle wait when cancelling a queued run leaves the active run in flight", async () => {
    const exec = new ManualExecutor("pi");
    exec.autoStart = true;
    exec.autoCancel = false;
    const env = makeEnv([exec]);
    try {
      const { sessionId, runId } = await delegate(env);
      await until(() => env.hub.summary(sessionId)?.phase === "running");
      const session = exec.sessions[0]!;
      session.emit({ kind: "assistant.delta", data: { itemId: "answer", text: "Still working" }, runId });
      env.hub.events(sessionId);
      const agent = { kind: "agent", label: "Parent" } as const;
      await env.manager.send(sessionId, { text: "Queued work", mode: "follow_up", author: agent });
      const wait = (timeoutMs: number) => waitForSessions(env, { sessionIds: [sessionId], timeoutMs }, new AbortController().signal);
      const waiting = wait(500);
      await env.manager.cancel(sessionId, agent);
      expect((await wait(0)).reason).toBe("timeout");
      expect(env.hub.summary(sessionId)).toMatchObject({ phase: "running", activeRunId: runId });
      expect(stateOf(env, sessionId).timeline.find((item) => item.type === "assistant")).toMatchObject({ streaming: true });

      session.complete(runId);
      const result = await waiting;
      expect(result.reason).toBe("settled");
      expect(result.sessions[0]).toMatchObject({ phase: "done", lastRun: { id: runId, status: "completed" } });
    } finally {
      await env.manager.shutdown();
    }
  });

  it("waits across the handoff between one run ending and the next run starting", async () => {
    const exec = new ManualExecutor("pi");
    exec.autoStart = true;
    const env = makeEnv([exec]);
    try {
      const { sessionId, runId } = await delegate(env);
      await until(() => env.hub.summary(sessionId)?.phase === "running");
      const session = exec.sessions[0]!;
      exec.autoStart = false;
      const next = await env.manager.send(sessionId, { text: "Queued follow-up", mode: "follow_up", author: USER });
      const waiting = waitForSessions(env, { sessionIds: [sessionId], timeoutMs: 500 }, new AbortController().signal);
      session.complete(runId);
      await until(() => session.started.length === 2);
      expect(env.hub.summary(sessionId)?.phase).toBe("starting");
      session.start(next.runId);
      session.complete(next.runId);

      const result = await waiting;
      expect(result.reason).toBe("settled");
      expect(result.sessions[0]?.lastRun?.id).toBe(next.runId);
    } finally {
      await env.manager.shutdown();
    }
  });

  it("starts a follow-up when the steer fallback arrives after the previous run ended", async () => {
    const exec = new ManualExecutor("pi");
    exec.autoStart = true;
    const env = makeEnv([exec]);
    try {
      const { sessionId, runId } = await delegate(env);
      await until(() => env.hub.summary(sessionId)?.phase === "running");
      const session = exec.sessions[0]!;
      const steer = Promise.withResolvers<SteerOutcome>();
      session.steer = () => steer.promise;
      const sending = env.manager.send(sessionId, { text: "Use the other approach", mode: "steer", author: USER });
      session.complete(runId);
      const wait = (timeoutMs: number) => waitForSessions(env, { sessionIds: [sessionId], timeoutMs }, new AbortController().signal);
      expect((await wait(0)).reason).toBe("timeout");
      const waiting = wait(500);
      steer.resolve({ kind: "needs_follow_up", reason: "run_in_progress" });
      const result = await sending;

      await until(() => session.started.length === 2);
      expect(session.started[1]).toMatchObject({ runId: result.runId, messageId: result.messageId, prompt: "Use the other approach" });
      expect(result.runId).not.toBe(runId);
      expect(env.hub.summary(sessionId)?.activeRunId).toBe(result.runId);
      expect(stateOf(env, sessionId).messages.find((message) => message.id === result.messageId)?.runId).toBe(result.runId);
      expect(stateOf(env, sessionId).runs[1]?.steerCount).toBe(0);
      session.complete(result.runId);
      expect((await waiting).sessions[0]?.lastRun?.id).toBe(result.runId);
    } finally {
      await env.manager.shutdown();
    }
  });

  it("stops a session: closes the executor and refuses further messages", async () => {
    const exec = new ManualExecutor("pi");
    const env = makeEnv([exec]);
    const { sessionId, runId } = await delegate(env);
    await until(() => exec.sessions[0]?.started.length === 1);
    exec.sessions[0]!.start(runId);
    await until(() => stateOf(env, sessionId).status === "running");

    await env.manager.stop(sessionId, USER);
    expect(exec.sessions[0]!.closed).toBe(true);
    const state = stateOf(env, sessionId);
    expect(state.status).toBe("stopped");
    expect(state.runs[0]?.status).toBe("cancelled");
    expect(env.manager.capacity().occupied).toBe(0);
    await expect(env.manager.send(sessionId, { text: "hi", author: USER })).rejects.toMatchObject({ code: "session_closed" });
  });

  it("re-attaches a lost session to its native session when the harness supports resume", async () => {
    const exec = new ManualExecutor("pi");
    exec.canResume = true;
    const store = new MemoryEventStore();
    const env = makeEnv([exec], {}, store);
    const { sessionId, runId } = await delegate(env);
    await until(() => exec.sessions[0]?.started.length === 1);
    exec.sessions[0]!.start(runId);
    await until(() => stateOf(env, sessionId).status === "running");
    expect(stateOf(env, sessionId).meta.nativeRef).toEqual({ kind: "pi-session", id: "native-1" });

    // 模拟服务重启：新的中枢从存储重放，旧运行被如实标记为失败，会话为 lost。
    const hub2 = new EventHub({ store, log: silentLogger, coalesceMs: 0 });
    await hub2.load();
    const registry2 = new ExecutorRegistry([exec], silentLogger);
    const notices2 = new NoticeCenter(hub2);
    const manager2 = new SessionManager({ hub: hub2, executors: registry2, notices: notices2, log: silentLogger });
    expect(manager2.reconcileAfterRestart()).toBe(1);
    const lost = hub2.state(sessionId)!;
    expect(lost.status).toBe("lost");
    expect(lost.runs[0]?.status).toBe("failed");
    expect(lost.runs[0]?.error?.code).toBe("service_restarted");

    await manager2.send(sessionId, { text: "Continue please", author: USER });
    await until(() => exec.sessions.length === 2 && exec.sessions[1]!.started.length === 1);
    expect(exec.sessions[1]!.input.resume).toEqual({ kind: "pi-session", id: "native-1" });
  });

  it("refuses to message a lost session that cannot be resumed", async () => {
    const exec = new ManualExecutor("pi");
    const store = new MemoryEventStore();
    const env = makeEnv([exec], {}, store);
    const { sessionId } = await delegate(env);
    await until(() => exec.sessions[0]?.started.length === 1);

    const hub2 = new EventHub({ store, log: silentLogger, coalesceMs: 0 });
    await hub2.load();
    const manager2 = new SessionManager({
      hub: hub2,
      executors: new ExecutorRegistry([exec], silentLogger),
      notices: new NoticeCenter(hub2),
      log: silentLogger,
    });
    manager2.reconcileAfterRestart();
    await expect(manager2.send(sessionId, { text: "hi", author: USER })).rejects.toMatchObject({ code: "session_not_resumable" });
  });

  it("keeps a finished, idle session as it is when the service stops or restarts — nothing was lost", async () => {
    const exec = new ManualExecutor("pi");
    exec.canResume = true;
    const store = new MemoryEventStore();
    const env = makeEnv([exec], {}, store);
    const { sessionId, runId } = await delegate(env);
    await until(() => exec.sessions[0]?.started.length === 1);
    exec.sessions[0]!.start(runId);
    exec.sessions[0]!.complete(runId);
    await until(() => stateOf(env, sessionId).status === "idle" && stateOf(env, sessionId).runs[0]?.status === "completed");
    const eventsBefore = stateOf(env, sessionId).seq;

    // 优雅退出：执行端连接被关闭，但会话不会被改成“已失联”，也没有多出任何事件。
    await env.manager.shutdown();
    expect(exec.sessions[0]!.closed).toBe(true);
    expect(stateOf(env, sessionId).status).toBe("idle");
    expect(toSummary(stateOf(env, sessionId)).phase).toBe("done");
    expect(stateOf(env, sessionId).seq).toBe(eventsBefore);

    // 重启：从存储重放后没有什么需要改动；下一条消息按需恢复到原生会话。
    const hub2 = new EventHub({ store, log: silentLogger, coalesceMs: 0 });
    await hub2.load();
    const manager2 = new SessionManager({
      hub: hub2,
      executors: new ExecutorRegistry([exec], silentLogger),
      notices: new NoticeCenter(hub2),
      log: silentLogger,
    });
    expect(manager2.reconcileAfterRestart()).toBe(0);
    expect(hub2.state(sessionId)!.status).toBe("idle");

    await manager2.send(sessionId, { text: "One more thing", author: USER });
    await until(() => exec.sessions.length === 2 && exec.sessions[1]!.started.length === 1);
    expect(exec.sessions[1]!.input.resume).toEqual({ kind: "pi-session", id: "native-1" });
  });

  it("still marks an idle session as lost when a message was held by Ensemble and never reached the harness", async () => {
    const exec = new ManualExecutor("pi");
    const store = new MemoryEventStore();
    const env = makeEnv([exec], {}, store);
    const { sessionId, runId } = await delegate(env);
    await until(() => exec.sessions[0]?.started.length === 1);
    exec.sessions[0]!.start(runId);
    exec.sessions[0]!.complete(runId);
    await until(() => stateOf(env, sessionId).status === "idle");

    // 一条还握在 Ensemble 手里的消息（已记录、尚未交给执行端）：重启后必须如实记为未送达，而不是悄悄丢掉。
    const at = new Date().toISOString();
    env.hub.emit(sessionId, {
      kind: "message.sent",
      data: {
        message: {
          id: "msg_held",
          sessionId,
          kind: "follow_up",
          author: USER,
          text: "never delivered",
          createdAt: at,
          delivery: newDelivery(at),
          sync: { toOrigin: "not_needed" },
        },
      },
      source: "user",
      at,
    });

    const hub2 = new EventHub({ store, log: silentLogger, coalesceMs: 0 });
    await hub2.load();
    const manager2 = new SessionManager({
      hub: hub2,
      executors: new ExecutorRegistry([exec], silentLogger),
      notices: new NoticeCenter(hub2),
      log: silentLogger,
    });
    expect(manager2.reconcileAfterRestart()).toBe(1);
    const state = hub2.state(sessionId)!;
    expect(state.status).toBe("lost");
    expect(state.messages.find((m) => m.id === "msg_held")?.delivery.stage).toBe("failed");
  });

  it("marks active sessions as lost on graceful shutdown instead of leaving a phantom running run", async () => {
    const exec = new ManualExecutor("pi");
    const env = makeEnv([exec]);
    const { sessionId, runId } = await delegate(env);
    await until(() => exec.sessions[0]?.started.length === 1);
    exec.sessions[0]!.start(runId);
    await until(() => stateOf(env, sessionId).status === "running");

    await env.manager.shutdown();
    const state = stateOf(env, sessionId);
    expect(state.status).toBe("lost");
    expect(state.runs[0]?.status).toBe("failed");
    expect(state.runs[0]?.error?.code).toBe("service_stopped");
    expect(state.activeRunId).toBeUndefined();
    expect(exec.sessions[0]!.closed).toBe(true);
  });
});
