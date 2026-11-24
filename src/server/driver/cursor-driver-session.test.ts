import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { testMeta } from "@shared/testing";
import type { MessageId, NativeRef, RunId } from "@shared/types";
import { HarnessStartError } from "../executors/common";
import { FakeSdk, assistantText, finished, toolCall, typedError, type FakeRun } from "../executors/cursor-fake";
import type { ExecutorDraft, OpenInput } from "../executors/types";
import { silentLogger } from "../logger";
import { until } from "../testing";
import { CursorDriverSession, type CursorDriverSessionConfig } from "./cursor-driver-session";

/**
 * 宿主层测试：Ensemble 的 `CursorDriverSession`（内核 + Cursor 后端 + 事件翻译）加上假 SDK。
 * 关注 Driver 换代、放弃、关闭这些 cursor.test.ts（经管理器）覆盖不到的内核边界。
 */

const WAIT = 6_000;

type Emitted = ExecutorDraft & { runId?: string };

interface Harness {
  readonly abort: AbortController;
  readonly emitted: Emitted[];
  readonly fake: FakeSdk;
  readonly session: CursorDriverSession;
  /** 事件种类与测试自己插入的标记，按发生顺序排列。 */
  readonly timeline: string[];
}

const sessions: CursorDriverSession[] = [];

async function open(
  options: { configure?: (fake: FakeSdk) => void; config?: Partial<CursorDriverSessionConfig>; resume?: NativeRef } = {},
): Promise<Harness> {
  const fake = new FakeSdk();
  options.configure?.(fake);
  const emitted: Emitted[] = [];
  const timeline: string[] = [];
  const abort = new AbortController();
  const input: OpenInput = {
    meta: testMeta({ harness: "cursor", cwd: mkdtempSync(join(tmpdir(), "ensemble-session-")) }),
    emit: (draft) => {
      emitted.push(draft as Emitted);
      timeline.push(draft.kind);
    },
    fatal: () => undefined,
    log: silentLogger,
    signal: abort.signal,
    ...(options.resume ? { resume: options.resume } : {}),
  };
  const session = new CursorDriverSession(input, {
    agentName: "Test agent",
    apiKey: undefined,
    effort: undefined,
    modelHint: "auto, composer-fake",
    modelId: "composer-fake",
    modelLabel: "Composer Fake",
    modelParams: undefined,
    readOnly: false,
    settingSources: ["project"],
    steerAckMs: 30,
    loadSdk: async () => fake.sdk,
    ...options.config,
  });
  sessions.push(session);
  await session.start();
  return { abort, emitted, fake, session, timeline };
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close().catch(() => undefined)));
});

let sequence = 0;

function submit(harness: Harness, prompt = "do it") {
  sequence += 1;
  const runId = `run_${sequence}` as RunId;
  const messageId = `msg_${sequence}` as MessageId;
  return { runId, messageId, accepted: harness.session.startRun({ runId, messageId, prompt, trigger: "task" }) };
}

async function runOf(fake: FakeSdk, index = 0): Promise<FakeRun> {
  await until(() => fake.runs.length > index, WAIT, `Cursor run ${index + 1} to start`);
  const run = fake.runs[index];
  if (!run) throw new Error("run missing");
  return run;
}

const kinds = (harness: Harness): string[] => harness.emitted.map((event) => event.kind);

const terminalsOf = (harness: Harness, runId: string): Emitted[] =>
  harness.emitted.filter((event) => event.runId === runId && (event.kind === "run.completed" || event.kind === "run.failed" || event.kind === "run.cancelled"));

async function finishRun(harness: Harness, index: number, prompt = "do it", result = "ok") {
  const run = submit(harness, prompt);
  const native = await runOf(harness.fake, index);
  await run.accepted;
  native.finish(finished(result));
  await until(() => terminalsOf(harness, run.runId).length === 1, WAIT, "run terminal");
  return { ...run, native };
}

describe("CursorDriverSession", () => {
  it("opens through the kernel, reports the agent as the native session, and emits run.started after startRun resolved", async () => {
    const harness = await open();
    expect(harness.session.nativeRef).toEqual({ kind: "cursor-agent", id: "agent-1" });
    expect(harness.emitted[0]).toMatchObject({ kind: "session.updated", data: { patch: { model: { resolved: "composer-fake", label: "Composer Fake" } } } });

    const run = submit(harness);
    void run.accepted.then(() => harness.timeline.push("accepted"));
    const native = await runOf(harness.fake);
    await run.accepted;
    await until(() => kinds(harness).includes("run.started"), WAIT, "run.started");
    // 管理器要先记“已交给执行端”：run.started 必须晚于 startRun 的返回。
    expect(harness.timeline.indexOf("accepted")).toBeGreaterThanOrEqual(0);
    expect(harness.timeline.indexOf("accepted")).toBeLessThan(harness.timeline.indexOf("run.started"));
    expect(harness.emitted.find((event) => event.kind === "run.started")).toMatchObject({ runId: run.runId, data: { nativeTurnId: "run-1" } });

    native.push(assistantText("hi"));
    native.finish(finished("hi"));
    await until(() => terminalsOf(harness, run.runId).length === 1, WAIT, "run completed");
    expect(terminalsOf(harness, run.runId)[0]?.kind).toBe("run.completed");
  });

  it("re-attaches to the same Cursor agent with a fresh kernel after a failed run, closing the old one first", async () => {
    const harness = await open();
    const closedWhenResumed: boolean[] = [];
    const resume = harness.fake.sdk.Agent.resume;
    harness.fake.sdk.Agent.resume = async (id, options) => {
      closedWhenResumed.push(harness.fake.agents[0]?.closed === true);
      return resume(id, options);
    };

    const first = submit(harness, "will fail");
    const native = await runOf(harness.fake);
    await first.accepted;
    native.finish({ status: "error", error: { message: "boom from the model" } });
    await until(() => terminalsOf(harness, first.runId).length === 1, WAIT, "run.failed");
    expect(terminalsOf(harness, first.runId)[0]).toMatchObject({ kind: "run.failed", data: { error: { message: expect.stringContaining("boom from the model") } } });

    await finishRun(harness, 1, "again");
    expect(harness.fake.resumed.map((entry) => entry.id)).toEqual(["agent-1"]);
    expect(closedWhenResumed).toEqual([true]);
    expect(harness.fake.sends.map((send) => send.options)).toEqual([undefined, { local: { force: true } }]);
    expect(harness.session.nativeRef).toEqual({ kind: "cursor-agent", id: "agent-1" });
  });

  it("turns a refused run into an actionable start error and stays usable", async () => {
    const harness = await open({ configure: (fake) => (fake.sendError = typedError("AuthenticationError", "Invalid API key", { status: 401 })) });
    const refused = submit(harness);
    const error: unknown = await refused.accepted.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(HarnessStartError);
    expect(error).toMatchObject({ code: "auth_failed" });
    // 启动失败由 startRun 抛给管理器，不会作为“失败的运行”重复上报。
    expect(terminalsOf(harness, refused.runId)).toEqual([]);
    expect(kinds(harness)).not.toContain("run.started");

    harness.fake.sendError = undefined;
    await finishRun(harness, 0, "retry");
  });

  it("abandons a cancel the SDK never finishes: reports cancelled, then re-attaches for the next run", async () => {
    const harness = await open({ config: { cancelSettleMs: 30 } });
    const first = submit(harness, "stuck");
    const native = await runOf(harness.fake);
    await first.accepted;
    // SDK 的 cancel() 返回了，但流再也不收尾。
    native.cancel = async () => {
      native.cancelCalls += 1;
    };
    native.push(assistantText("working"));
    await until(() => kinds(harness).includes("assistant.delta"), WAIT, "streamed text");

    await harness.session.cancel(first.runId);
    await until(() => terminalsOf(harness, first.runId).length === 1, WAIT, "run.cancelled");
    expect(terminalsOf(harness, first.runId)[0]?.kind).toBe("run.cancelled");
    expect(native.cancelCalls).toBe(1);

    await finishRun(harness, 1, "next");
    expect(harness.fake.resumed.map((entry) => entry.id)).toEqual(["agent-1"]);
    expect(harness.fake.agents[0]?.closed).toBe(true);
  });

  it("keeps the same kernel after an ordinary cancel", async () => {
    const harness = await open();
    const first = submit(harness, "long task");
    const native = await runOf(harness.fake);
    await first.accepted;
    native.push(toolCall("t1", "shell", "running", { command: "sleep 100" }));
    await until(() => kinds(harness).includes("tool.updated"), WAIT, "tool started");

    await harness.session.cancel(first.runId);
    await until(() => terminalsOf(harness, first.runId).length === 1, WAIT, "run.cancelled");
    expect(terminalsOf(harness, first.runId)[0]?.kind).toBe("run.cancelled");

    await finishRun(harness, 1, "after the cancel");
    expect(harness.fake.resumed).toEqual([]);
    expect(harness.fake.agents).toHaveLength(1);
  });

  it("ignores a cancel for a run that already ended", async () => {
    const harness = await open();
    const done = await finishRun(harness, 0);
    await expect(harness.session.cancel(done.runId)).resolves.toBeUndefined();
    await expect(harness.session.cancel("run_unknown" as RunId)).resolves.toBeUndefined();
  });

  it("closes an idle session promptly and closes the Cursor agent", async () => {
    const harness = await open();
    const started = Date.now();
    await harness.session.close();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(harness.fake.agents[0]?.closed).toBe(true);
    await expect(harness.session.startRun({ runId: "run_late" as RunId, messageId: "msg_late" as MessageId, prompt: "x", trigger: "task" })).rejects.toThrow(/closed/);
  });

  it("closes during an active run: the run is cancelled quietly and nothing more is emitted", async () => {
    const harness = await open();
    const run = submit(harness, "working when closed");
    const native = await runOf(harness.fake);
    await run.accepted;
    native.push(assistantText("working"));
    await until(() => kinds(harness).includes("assistant.delta"), WAIT, "streamed text");

    await harness.session.close();
    const countAfterClose = harness.emitted.length;
    expect(native.cancelCalls).toBe(1);
    expect(harness.fake.agents[0]?.closed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(harness.emitted.length).toBe(countAfterClose);
    expect(terminalsOf(harness, run.runId)).toEqual([]);
  });

  it("closes when the session's abort signal fires", async () => {
    const harness = await open();
    harness.abort.abort();
    await until(() => harness.fake.agents[0]?.closed === true, WAIT, "agent closed on abort");
  });

  it("refuses a message above the Driver command limit and keeps accepting normal ones", async () => {
    const harness = await open();
    const huge = submit(harness, "x".repeat(900_000));
    await expect(huge.accepted).rejects.toMatchObject({ code: "invalid_request" });
    expect(harness.fake.runs).toHaveLength(0);
    await finishRun(harness, 0, "small");
  });

  it("never emits permission requests: delegated agents run with full access", async () => {
    const harness = await open();
    await finishRun(harness, 0);
    expect(kinds(harness).filter((kind) => kind.startsWith("permission."))).toEqual([]);
    expect(harness.fake.created[0]?.["tools"]).toBeUndefined();
  });
});
