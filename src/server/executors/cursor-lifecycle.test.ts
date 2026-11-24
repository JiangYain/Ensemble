import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { USER, testMeta } from "@shared/testing";
import { silentLogger } from "../logger";
import { shutdownTrackedEnvs, stateOf, until } from "../testing";
import { finished, toolCall, typedError } from "./cursor-fake";
import { READ_ONLY_TOOLS, WAIT, completed, delegate, runOf, runningRun, setup, tools } from "./cursor-test-kit";
import type { ExecutorDraft } from "./types";

afterEach(shutdownTrackedEnvs);

// ───────────────────────── 取消、关闭与恢复 ─────────────────────────

describe("Cursor cancel, close and resume", () => {
  it("cancels cleanly: the interrupted tool is cancelled, not failed, and the session stays usable", async () => {
    const { env, fake } = setup();
    const { sessionId } = await delegate(env, { task: "Long job" });
    const run = await runOf(fake);
    run.push(toolCall("t1", "shell", "running", { command: "sleep 100" }));
    await until(() => tools(env, sessionId).length === 1, WAIT, "tool running");

    await env.manager.cancel(sessionId, USER);
    await until(() => stateOf(env, sessionId).runs[0]?.status === "cancelled", WAIT, "run cancelled");

    const state = stateOf(env, sessionId);
    expect(run.cancelCalls).toBe(1);
    expect(state.runs[0]?.error).toBeUndefined();
    expect(state.status).toBe("idle");
    expect(tools(env, sessionId)[0]?.status).toBe("cancelled");

    const next = await env.manager.send(sessionId, { text: "Do something small", author: USER });
    expect(next.kind).toBe("follow_up");
    const second = await runOf(fake, 1);
    // 不是恢复出来的会话：不需要让旧运行过期。
    expect(fake.sends[1]?.options).toBeUndefined();
    second.finish(finished("ok"));
    await until(completed(env, sessionId, 1), WAIT, "follow-up completed");
  });

  it("marks a tool that failed because of the cancel as cancelled", async () => {
    const { env, fake } = setup();
    const { sessionId } = await delegate(env);
    const run = await runOf(fake);
    run.push(toolCall("t1", "shell", "running", { command: "sleep 100" }));
    await until(() => tools(env, sessionId).length === 1, WAIT, "tool running");
    await env.manager.cancel(sessionId, USER);
    await until(() => stateOf(env, sessionId).runs[0]?.status === "cancelled", WAIT, "run cancelled");
    expect(tools(env, sessionId).some((t) => t.status === "failed")).toBe(false);
  });

  it("cancels the active run and closes the agent when the session is stopped", async () => {
    const { env, fake } = setup();
    const { sessionId } = await delegate(env);
    const run = await runningRun(env, fake, sessionId);
    await env.manager.stop(sessionId, USER);
    expect(run.cancelCalls).toBe(1);
    await until(() => fake.agents[0]?.closed === true, WAIT, "agent closed");
    expect(stateOf(env, sessionId).status).toBe("stopped");
  });

  it("rejects new messages during stop and closes an agent whose creation finishes late", async () => {
    const { env, fake } = setup();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const create = fake.sdk.Agent.create;
    fake.sdk.Agent.create = async (input) => {
      entered.resolve();
      await release.promise;
      return create(input);
    };
    const { sessionId } = await delegate(env);
    await entered.promise;
    const stopping = env.manager.stop(sessionId, USER);
    try {
      await expect(env.manager.send(sessionId, { text: "Too late", author: USER })).rejects.toMatchObject({ code: "session_closed" });
    } finally {
      release.resolve();
      await stopping;
    }
    expect(env.hub.summary(sessionId)).toMatchObject({ phase: "stopped", messages: { total: 1, pending: 0 } });
    expect(fake.agents[0]?.closed).toBe(true);
    expect(fake.runs).toHaveLength(0);
  });

  it("reattaches to a persisted agent with the same options and expires stale runs on the first send only", async () => {
    const { executor, fake } = setup();
    const emitted: ExecutorDraft[] = [];
    const cwd = mkdtempSync(join(tmpdir(), "ensemble-cursor-resume-"));
    const session = await executor.open({
      meta: testMeta({ harness: "cursor", cwd, access: "read_only", model: { requested: "auto" } }),
      emit: (draft) => void emitted.push(draft),
      fatal: () => undefined,
      log: silentLogger,
      resume: { kind: "cursor-agent", id: "agent-77" },
      signal: new AbortController().signal,
    });

    expect(fake.resumed).toHaveLength(1);
    expect(fake.resumed[0]?.id).toBe("agent-77");
    const options = fake.resumed[0]?.options ?? {};
    // tools 不随会话持久化，恢复时要重新传；已有的会话不能再改名。
    expect(options["tools"]).toEqual(READ_ONLY_TOOLS);
    expect("name" in options).toBe(false);
    expect(options["local"]).toMatchObject({ cwd });
    expect(session.nativeRef).toEqual({ kind: "cursor-agent", id: "agent-77" });

    await session.startRun({ runId: "run_1", messageId: "msg_1", prompt: "Continue", trigger: "follow_up" });
    expect(fake.sends[0]?.options).toEqual({ local: { force: true } });
    const run = await runOf(fake);
    run.finish(finished("done"));
    await until(() => emitted.some((draft) => draft.kind === "run.completed"), WAIT, "run completed");

    await session.startRun({ runId: "run_2", messageId: "msg_2", prompt: "Again", trigger: "follow_up" });
    expect(fake.sends[1]?.options).toBeUndefined();
    (await runOf(fake, 1)).finish(finished("done"));
    await session.close();
  });

  it("says why a persisted agent cannot be resumed", async () => {
    const { executor } = setup({ configure: (f) => (f.resumeError = typedError("AgentNotFoundError", "no such agent")) });
    await expect(
      executor.open({
        meta: testMeta({ harness: "cursor", cwd: tmpdir(), model: { requested: "auto" } }),
        emit: () => undefined,
        fatal: () => undefined,
        log: silentLogger,
        resume: { kind: "cursor-agent", id: "agent-gone" },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "session_not_resumable" });
  });
});
