/**
 * 会话管理器的基本行为：用 fixture 执行端跑完整个委派（投递证据、提示词拼装、纠偏与介入通知、追加运行、取消、失败、Full Access），以及委派入口的校验。
 * 用手动控制的执行端测排队与收尾的部分，按主题在 manager.queueing.test.ts 与 manager.lifecycle.test.ts；三份共用 manager.fixtures.ts 的 delegate。
 */

import { describe, expect, it } from "vitest";
import { toSummary } from "@shared/projection";
import { USER, testOrigin } from "@shared/testing";
import { EnsembleError } from "./errors";
import { FixtureExecutor } from "./executors/fixture";
import { delegate } from "./manager.fixtures";
import { ManualExecutor, makeEnv, stateOf, until } from "./testing";

describe("delegation with the fixture executor", () => {
  it("runs a delegated session to completion and records honest delivery evidence", async () => {
    const env = makeEnv([new FixtureExecutor("pi", { speed: 0 })]);
    const { sessionId, messageId } = await delegate(env);
    await until(() => stateOf(env, sessionId).runs[0]?.status === "completed");

    const state = stateOf(env, sessionId);
    const summary = toSummary(state);
    expect(summary.phase).toBe("done");
    expect(summary.runtime).toBe("fixture");
    expect(summary.model).toMatchObject({ resolved: "fixture-fast" });
    expect(summary.counters.tools).toBeGreaterThan(3);
    expect(summary.counters.failedTools).toBe(1);
    expect(summary.counters.files).toBe(2);
    expect(summary.usage?.totalTokens).toBeGreaterThan(0);

    const task = state.messages.find((m) => m.id === messageId);
    expect(task?.delivery.stage).toBe("applied");
    expect(task?.delivery.history.map((h) => h.stage)).toEqual(["recorded", "handed_off", "applied"]);
    expect(task?.delivery.evidence).toContain("run started");
  });

  it("composes the prompt from the task and context, and keeps the original text", async () => {
    const env = makeEnv([new FixtureExecutor("pi", { speed: 0 })]);
    const { sessionId } = await delegate(env, {
      task: "Fix the failing test [fixture:quick]",
      context: [
        { kind: "text", title: "Background", text: "CI fails on Windows only." },
        { kind: "file", path: "C:\\work\\demo\\a.test.ts", note: "The failing test" },
      ],
    });
    await until(() => stateOf(env, sessionId).runs[0]?.status === "completed");
    const task = stateOf(env, sessionId).meta.task;
    expect(task.text).toBe("Fix the failing test [fixture:quick]");
    expect(task.context).toHaveLength(2);
    expect(task.prompt).toContain("### Background");
    expect(task.prompt).toContain("### File: C:\\work\\demo\\a.test.ts");
  });

  it("applies a user steer at the harness's turn boundary and syncs the intervention to the origin agent", async () => {
    const env = makeEnv([new FixtureExecutor("pi", { speed: 0 })]);
    const { sessionId } = await delegate(env, { task: "Wait for guidance [fixture:hold]" });
    await until(() => stateOf(env, sessionId).status === "running");

    const result = await env.manager.send(sessionId, { text: "Skip the slow ones", author: USER });
    expect(result.kind).toBe("steer");
    await until(() => stateOf(env, sessionId).messages.find((m) => m.id === result.messageId)?.delivery.stage === "applied");

    const message = stateOf(env, sessionId).messages.find((m) => m.id === result.messageId)!;
    expect(message.delivery.history.map((h) => h.stage)).toEqual(["recorded", "handed_off", "queued", "applied"]);
    expect(message.delivery.history[2]).toMatchObject({ queuedBy: "harness", reason: "turn_boundary" });
    expect(message.sync.toOrigin).toBe("pending");
    expect(stateOf(env, sessionId).runs[0]?.steerCount).toBe(1);

    // 主 Agent 下一次调用工具时拿到通知，并且页面上的同步状态变为已送达。
    const origin = testOrigin();
    expect(env.notices.peek(origin.key)).toHaveLength(1);
    const collected = env.notices.collect(origin.key);
    expect(collected[0]).toMatchObject({ kind: "intervention", text: "Skip the slow ones", sessionId });
    expect(collected[0]?.summary).toContain("directly to delegated session");
    expect(stateOf(env, sessionId).messages.find((m) => m.id === result.messageId)?.sync.toOrigin).toBe("delivered");
    expect(env.notices.collect(origin.key)).toHaveLength(0);
  });

  it("does not create notices when the session was started by the user from the console", async () => {
    const env = makeEnv([new FixtureExecutor("pi", { speed: 0 })]);
    const consoleOrigin = testOrigin({ key: "console:ui", kind: "user", host: "console", hostLabel: "Console" });
    const { sessionId } = await delegate(env, { origin: consoleOrigin, task: "x [fixture:hold]" });
    await until(() => stateOf(env, sessionId).status === "running");
    await env.manager.send(sessionId, { text: "hello", author: USER });
    expect(env.notices.pendingCount()).toBe(0);
    expect(stateOf(env, sessionId).messages.at(-1)?.sync.toOrigin).toBe("not_needed");
    await until(() => stateOf(env, sessionId).runs[0]?.status === "completed");
  });

  it("sends a follow-up after a finished run as a second run in the same session", async () => {
    const env = makeEnv([new FixtureExecutor("pi", { speed: 0 })]);
    const { sessionId } = await delegate(env, { task: "[fixture:quick]" });
    await until(() => stateOf(env, sessionId).status === "idle" && stateOf(env, sessionId).runs[0]?.status === "completed");

    const result = await env.manager.send(sessionId, { text: "Now add tests [fixture:quick]", author: USER });
    expect(result.kind).toBe("follow_up");
    await until(() => stateOf(env, sessionId).runs[1]?.status === "completed");
    expect(stateOf(env, sessionId).runs.map((r) => r.trigger)).toEqual(["task", "follow_up"]);
    expect(toSummary(stateOf(env, sessionId)).runCount).toBe(2);
  });

  it("cancels a running run, keeps the session usable and frees capacity", async () => {
    const env = makeEnv([new FixtureExecutor("pi", { speed: 0 })]);
    const { sessionId } = await delegate(env, { task: "[fixture:long]" });
    await until(() => stateOf(env, sessionId).status === "running");
    expect(env.manager.capacity().occupied).toBe(1);

    const result = await env.manager.cancel(sessionId, USER);
    expect(result.interrupted).toBe(true);
    await until(() => stateOf(env, sessionId).runs[0]?.status === "cancelled");
    expect(toSummary(stateOf(env, sessionId)).phase).toBe("cancelled");
    expect(env.manager.capacity().occupied).toBe(0);
    expect(env.notices.peek(testOrigin().key).map((n) => n.kind)).toEqual(["cancel"]);
  });

  it("reports failures on the run and still accepts follow-ups", async () => {
    const env = makeEnv([new FixtureExecutor("pi", { speed: 0 })]);
    const { sessionId } = await delegate(env, { task: "[fixture:fail]" });
    await until(() => stateOf(env, sessionId).runs[0]?.status === "failed");
    const summary = toSummary(stateOf(env, sessionId));
    expect(summary.phase).toBe("failed");
    expect(summary.lastError?.code).toBe("fixture_failure");
    expect(summary.status).toBe("idle");

    await env.manager.send(sessionId, { text: "Try again [fixture:quick]", author: USER });
    await until(() => stateOf(env, sessionId).runs[1]?.status === "completed");
  });

  it("delegates with Full Access by default and goes straight through without ever waiting on anyone", async () => {
    const env = makeEnv([new FixtureExecutor("pi", { speed: 0 })]);
    const statuses = new Set<string>();
    const unsubscribe = env.hub.subscribe(() => {
      for (const id of env.hub.sessionIds()) statuses.add(env.hub.state(id)?.status ?? "missing");
    });
    const { sessionId } = await delegate(env, { task: "Install the dependencies and run the build" });
    expect(stateOf(env, sessionId).meta.access).toBe("full");
    await until(() => stateOf(env, sessionId).runs[0]?.status === "completed");
    unsubscribe();

    expect(statuses.has("running")).toBe(true);
    expect([...statuses].filter((status) => !["starting", "running", "idle"].includes(status))).toEqual([]);
    expect(stateOf(env, sessionId).timeline.map((item) => item.type)).not.toContain("permission");
    expect(env.notices.peek(testOrigin().key)).toEqual([]);
  });
});

describe("validation", () => {
  const rejects = async (promise: Promise<unknown>, code: string) => {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(EnsembleError);
    expect((error as EnsembleError).code).toBe(code);
  };

  it("rejects empty tasks, relative or missing working directories, and unknown harnesses", async () => {
    const env = makeEnv([new ManualExecutor("pi")]);
    await rejects(delegate(env, { task: "   " }), "invalid_request");
    await rejects(delegate(env, { cwd: "relative/path" }), "invalid_request");
    await rejects(delegate(env, { cwd: `${env.cwd}\\does-not-exist` }), "invalid_request");
    await rejects(delegate(env, { harness: "codex" }), "harness_unavailable");
  });

  it("refuses harnesses that need setup and surfaces the setup hint", async () => {
    const exec = new ManualExecutor("cursor", {
      status: "needs_setup",
      setup: { code: "auth_invalid", message: "The stored login was rejected (401)", command: "cursor-sdk login" },
    });
    const env = makeEnv([exec]);
    const error = await delegate(env, { harness: "cursor" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EnsembleError);
    expect((error as EnsembleError).code).toBe("harness_needs_setup");
    expect((error as EnsembleError).message).toContain("401");
    expect((error as EnsembleError).details).toMatchObject({ setup: { command: "cursor-sdk login" } });
  });

  it("refuses access levels the harness cannot enforce", async () => {
    const exec = new ManualExecutor("pi", {
      access: { read_only: { level: "enforced", mechanism: "tool allowlist" }, full: null },
    });
    const env = makeEnv([exec]);
    await rejects(delegate(env, { access: "full" }), "access_unsupported");
    await expect(delegate(env, { access: "read_only" })).resolves.toBeDefined();
  });

  it("limits nested delegation depth", async () => {
    const exec = new ManualExecutor("pi");
    const env = makeEnv([exec], { maxDepth: 1 });
    const root = await delegate(env);
    const child = await delegate(env, { parentSessionId: root.sessionId });
    expect(stateOf(env, child.sessionId).meta.depth).toBe(1);
    expect(env.hub.childIds(root.sessionId)).toEqual([child.sessionId]);
    expect(toSummary(stateOf(env, root.sessionId), env.hub.childIds(root.sessionId)).childIds).toEqual([child.sessionId]);
    await rejects(delegate(env, { parentSessionId: child.sessionId }), "depth_exceeded");
  });

  it("rejects steering when no run is active and messages to unknown sessions", async () => {
    const env = makeEnv([new FixtureExecutor("pi", { speed: 0 })]);
    const { sessionId } = await delegate(env, { task: "[fixture:quick]" });
    await until(() => stateOf(env, sessionId).runs[0]?.status === "completed");
    await rejects(env.manager.send(sessionId, { text: "x", mode: "steer", author: USER }), "conflict");
    await rejects(env.manager.send("ses_missing", { text: "x", author: USER }), "not_found");
    await rejects(env.manager.send(sessionId, { text: "  ", author: USER }), "invalid_request");
  });
});
