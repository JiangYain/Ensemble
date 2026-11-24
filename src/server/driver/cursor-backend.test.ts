import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentDriverKernelCore, CursorDriverBackend, CursorStartError, createDriverId } from "@mosoo/agent-driver";
import type { AgentDriverRuntimeEvent, CursorBackendDependencies, DriverStartInput, RunId } from "@mosoo/agent-driver";
import type { EventId } from "@mosoo/agent-driver/protocol/id";
import { ingestRuntimeEventInput } from "@mosoo/agent-driver/protocol/events/runtime-events";
import { CursorTurnTranslator } from "@mosoo/agent-driver/runtimes/cursor/cursor-event-translator";
import { typedError, FakeSdk, assistantText, failure, finished, thinking, toolCall, success, usageMessage, type FakeRun } from "../executors/cursor-fake";
import { until } from "../testing";
import { buildCursorStartInput, type CursorStartInputOptions } from "./start-input";

/**
 * Driver Kernel 与 Cursor 后端的直接测试：真实的 `AgentDriverKernelCore`（来自 vendor/mosoo-agent-driver）
 * 加上用假 SDK 驱动的 `CursorDriverBackend`，不经过 Ensemble 的会话管理器。
 * 它们同时证明：内核在 Node 22 + Windows 下能加载、启动、收发命令并按终态纪律收场。
 */

const WAIT = 6_000;

interface Rig {
  readonly events: AgentDriverRuntimeEvent[];
  readonly fake: FakeSdk;
  readonly input: DriverStartInput;
  readonly kernel: AgentDriverKernelCore;
  readonly pump: Promise<void>;
  backend(): CursorDriverBackend;
}

const rigs: Rig[] = [];

function rig(
  options: { configure?: (fake: FakeSdk) => void; deps?: Partial<CursorBackendDependencies>; start?: Partial<CursorStartInputOptions> } = {},
): Rig {
  const fake = new FakeSdk();
  options.configure?.(fake);
  let created: CursorDriverBackend | undefined;
  const kernel = new AgentDriverKernelCore({
    backendFactory: (payload) => {
      created = new CursorDriverBackend(payload, { loadSdk: async () => fake.sdk, steerAckMs: 30, ...options.deps });
      return created;
    },
  });
  const events: AgentDriverRuntimeEvent[] = [];
  const pump = (async () => {
    for await (const event of kernel.events()) events.push(event);
  })();
  const input = buildCursorStartInput({
    cwd: mkdtempSync(join(tmpdir(), "ensemble-driver-")),
    modelId: "composer-fake",
    readOnly: false,
    settingSources: ["project"],
    ...options.start,
  });
  const made: Rig = {
    events,
    fake,
    input,
    kernel,
    pump,
    backend: () => {
      if (!created) throw new Error("backend not created yet");
      return created;
    },
  };
  rigs.push(made);
  return made;
}

afterEach(async () => {
  for (const made of rigs.splice(0)) {
    await made.kernel.stop("test.cleanup").catch(() => undefined);
    await made.pump.catch(() => undefined);
  }
});

function inputCommand(text: string) {
  const runId = createDriverId() as RunId;
  return {
    runId,
    command: { commandId: createDriverId(), input: { text }, kind: "input.start", requestId: createDriverId(), runId } as const,
  };
}

async function runOf(fake: FakeSdk, index = 0): Promise<FakeRun> {
  await until(() => fake.runs.length > index, WAIT, `Cursor run ${index + 1} to start`);
  const run = fake.runs[index];
  if (!run) throw new Error("run missing");
  return run;
}

const kindsOf = (made: Rig, runId?: RunId): string[] =>
  made.events.filter((event) => runId === undefined || event.runId === runId).map((event) => event.kind);

const terminalsOf = (made: Rig) => made.events.filter((event) => event.kind === "run.completed" || event.kind === "run.failed" || event.kind === "run.cancelled");

describe("Cursor backend in the Driver Kernel", () => {
  it("starts, announces the Cursor agent as the resume pointer, and completes a turn", async () => {
    const made = rig();
    await made.kernel.start(made.input);

    const resume = made.events.find((event) => event.kind === "runtime.resume.updated");
    expect(resume?.payload).toEqual({ resumePointer: "agent-1", mode: "cursor" });
    expect(made.backend().nativeRef).toEqual({ kind: "cursor_agent_id", runtimeId: "cursor", value: "agent-1" });
    // 新建 Agent 时带着名字与模型；会话没有被限制工具。
    expect(made.fake.created[0]).toMatchObject({ model: { id: "composer-fake" }, local: { settingSources: ["project"] } });
    expect(made.fake.created[0]?.["tools"]).toBeUndefined();

    const { runId, command } = inputCommand("hello");
    const done = made.kernel.dispatch(command);
    const run = await runOf(made.fake);
    run.push(assistantText("Hel"), assistantText("lo"));
    run.finish(finished("Hello"));
    await expect(done).resolves.toEqual({ requestId: command.requestId });

    const kinds = kindsOf(made, runId);
    expect(kinds[0]).toBe("run.started");
    expect(kinds.at(-1)).toBe("run.completed");
    expect(kinds.filter((kind) => kind.startsWith("run."))).toEqual(["run.started", "run.completed"]);
    const completed = made.events.at(-1);
    expect(completed?.payload).toMatchObject({
      checkpoint: { nativeRef: { kind: "cursor_agent_id", runtimeId: "cursor", value: "agent-1" } },
      stopReason: "end_turn",
    });
    expect(made.fake.sends[0]?.prompt).toBe("hello");
  });

  it("emits only events the upstream runtime-event admission accepts", async () => {
    const made = rig();
    await made.kernel.start(made.input);
    const { command } = inputCommand("tidy");
    const done = made.kernel.dispatch(command);
    const run = await runOf(made.fake);
    run.push(
      { type: "system", agent_id: "agent-1", run_id: "run-1", model: { id: "auto" }, tools: ["read", "shell", "edit"] },
      thinking("Considering "),
      thinking("", 900),
      assistantText("Looking around."),
      toolCall("c1", "read", "running", { path: "a.txt" }),
      toolCall("c1", "read", "completed", { path: "a.txt" }, success({ content: "x\n", totalLines: 1, fileSize: 2 })),
      toolCall("c2", "edit", "running", { path: "new.txt" }),
      toolCall("c2", "edit", "completed", { path: "new.txt" }, success({ linesAdded: 2, linesRemoved: 0, diffString: "+a\n+b\n" })),
      toolCall("c3", "shell", "running", { command: "exit 3" }),
      toolCall("c3", "shell", "completed", { command: "exit 3" }, success({ exitCode: 3, signal: "", stdout: "", stderr: "boom\n", executionTime: 5 })),
      toolCall("c4", "updateTodos", "completed", { todos: [{ content: "Fix", status: "inProgress" }] }, success({ todos: [{ content: "Fix", status: "inProgress" }], totalCount: 1 })),
      toolCall("c5", "read", "completed", { path: "missing.txt" }, failure("File not found", { path: "missing.txt" })),
      usageMessage(100, 10, 50),
    );
    run.finish(finished("Done.", { usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 0, totalTokens: 110 } }));
    await done;

    const context = {
      createId: () => createDriverId() as EventId,
      driverInstanceId: made.input.driverInstanceId,
      occurredAt: new Date().toISOString(),
      runtimeId: "cursor",
      sessionId: made.input.execution.run.sessionId,
    };
    const rejected = made.events.flatMap((event) => {
      // 会话级事件（如 runtime.resume.updated）在进程内用 runId: null 表示“不属于任何运行”（上游自己的约定），
      // 进入信封时是省略 runId。
      const { runId, ...withoutRun } = event;
      const outcome = ingestRuntimeEventInput(context, runId === null ? withoutRun : event);
      return outcome.status === "rejected" ? [`${event.kind}: ${outcome.rejection.message}`] : [];
    });
    expect(rejected).toEqual([]);
    // 工具、文件、计划、用量都真的出现过，而不是被悄悄丢掉。
    const kinds = new Set(kindsOf(made));
    for (const kind of ["tool.call.updated", "file.change.updated", "plan.updated", "usage.updated", "thought.started", "message.added"]) {
      expect(kinds.has(kind), kind).toBe(true);
    }
  });

  it("cancels through turn.cancel: the run ends cancelled and the kernel takes the next input", async () => {
    const made = rig();
    await made.kernel.start(made.input);
    const first = inputCommand("long task");
    const firstDone = made.kernel.dispatch(first.command);
    const run = await runOf(made.fake);
    run.push(assistantText("working"), toolCall("t1", "shell", "running", { command: "sleep 100" }));
    await until(() => made.events.some((event) => event.kind === "tool.call.updated"), WAIT, "tool event");

    await made.kernel.dispatch({ commandId: createDriverId(), kind: "turn.cancel", reason: "user asked", runId: first.runId });
    await expect(firstDone).resolves.toBeUndefined();
    expect(run.cancelCalls).toBe(1);

    const kinds = kindsOf(made, first.runId);
    expect(kinds).toContain("run.cancel.requested");
    expect(kinds.at(-1)).toBe("run.cancelled");
    expect(kinds).not.toContain("run.failed");
    // 被打断的工具是 cancelled，不是 failed。
    const tool = made.events.filter((event) => event.kind === "tool.call.updated" && event.runId === first.runId).at(-1);
    expect(tool?.payload).toMatchObject({ toolCallId: "t1", status: "cancelled" });
    expect(made.backend().usable).toBe(true);

    // 取消不是致命的：同一个内核接着跑下一次输入，并且是同一个 Cursor Agent。
    const second = inputCommand("next");
    const secondDone = made.kernel.dispatch(second.command);
    const next = await runOf(made.fake, 1);
    next.finish(finished("ok"));
    await secondDone;
    expect(kindsOf(made, second.runId).at(-1)).toBe("run.completed");
    expect(made.fake.agents).toHaveLength(1);
    expect(terminalsOf(made).map((event) => event.kind)).toEqual(["run.cancelled", "run.completed"]);
  });

  it("lets a result the SDK already produced win over a late cancel request", () => {
    const translator = new CursorTurnTranslator({
      cwd: "C:\\work",
      notes: { modelId: undefined, toolsNoted: false },
      now: Date.now,
      readOnly: false,
      runId: createDriverId() as RunId,
    });
    const settled = translator.finish({ cancelRequested: true, failure: undefined, result: { status: "finished", result: "done" } });
    expect(settled.outcome).toBe("completed");
    const cancelled = new CursorTurnTranslator({
      cwd: "C:\\work",
      notes: { modelId: undefined, toolsNoted: false },
      now: Date.now,
      readOnly: false,
      runId: createDriverId() as RunId,
    }).finish({ cancelRequested: true, failure: undefined, result: { status: "cancelled" } });
    expect(cancelled.outcome).toBe("cancelled");
  });

  it("abandons a native run that ignores cancel: cancelled is published, the backend is already unusable, the kernel fails", async () => {
    const made = rig({ deps: { cancelSettleMs: 40 } });
    await made.kernel.start(made.input);
    const first = inputCommand("stuck task");
    const firstDone = made.kernel.dispatch(first.command);
    firstDone.catch(() => undefined);
    const run = await runOf(made.fake);
    // SDK 的 cancel() 返回了，但流再也不收尾。
    run.cancel = async () => {
      run.cancelCalls += 1;
    };
    run.push(assistantText("working"));

    // 宿主一看到 run.cancelled 就可能开始下一次运行：那一刻后端必须已经被标记为不可用。
    let usableAtTerminal: boolean | undefined;
    const watcher = (async () => {
      await until(() => made.events.some((event) => event.kind === "run.cancelled"), WAIT, "run.cancelled");
      usableAtTerminal = made.backend().usable;
    })();

    await made.kernel.dispatch({ commandId: createDriverId(), kind: "turn.cancel", reason: "give up", runId: first.runId });
    await watcher;
    expect(run.cancelCalls).toBe(1);
    expect(usableAtTerminal).toBe(false);
    expect(terminalsOf(made).map((event) => event.kind)).toEqual(["run.cancelled"]);
    await until(() => made.fake.agents[0]?.closed === true, WAIT, "agent closed after abandonment");
    await expect(made.kernel.dispatch(inputCommand("again").command)).rejects.toThrow();
  });

  it("publishes run.failed, rejects the command with the error code, and fails the kernel (the host re-attaches)", async () => {
    const made = rig();
    await made.kernel.start(made.input);
    const { runId, command } = inputCommand("will fail");
    const done = made.kernel.dispatch(command);
    const rejected = done.then(
      () => undefined,
      (error: unknown) => error,
    );
    const run = await runOf(made.fake);
    run.push(assistantText("partial"));
    run.finish({ status: "error", error: { message: "The model returned an error" } });

    const error = await rejected;
    expect(error).toBeInstanceOf(Error);
    expect(kindsOf(made, runId).at(-1)).toBe("run.failed");
    const failed = made.events.find((event) => event.kind === "run.failed");
    expect(failed?.payload).toMatchObject({ error: { message: expect.stringContaining("model returned an error") } });
    await expect(made.kernel.dispatch(inputCommand("again").command)).rejects.toThrow();
    // 事件流在失败之后正常收尾，宿主据此知道这一代已经结束。
    await made.pump;
    expect(made.fake.agents[0]?.closed).toBe(true);
  });

  it("does not publish run.started when the SDK refuses the run", async () => {
    const made = rig({ configure: (fake) => (fake.sendError = typedError("AuthenticationError", "Invalid API key", { status: 401 })) });
    await made.kernel.start(made.input);
    const { runId, command } = inputCommand("no credentials");
    await expect(made.kernel.dispatch(command)).rejects.toThrow();
    const kinds = kindsOf(made, runId);
    expect(kinds).not.toContain("run.started");
    expect(kinds.at(-1)).toBe("run.failed");
    const failed = made.events.find((event) => event.kind === "run.failed");
    expect(failed?.payload).toMatchObject({ error: { code: "auth_failed" } });
  });

  it("stops: cancels the active run, closes the agent and ends the event stream", async () => {
    const made = rig();
    await made.kernel.start(made.input);
    const { runId, command } = inputCommand("running while stopped");
    const done = made.kernel.dispatch(command);
    done.catch(() => undefined);
    const run = await runOf(made.fake);
    run.push(assistantText("working"));
    await until(() => made.events.some((event) => event.kind === "message.delta"), WAIT, "streamed text");

    await made.kernel.stop("session.closed");
    await made.pump;
    expect(run.cancelCalls).toBe(1);
    expect(made.fake.agents[0]?.closed).toBe(true);
    expect(kindsOf(made, runId).filter((kind) => kind === "run.failed")).toEqual([]);
  });
});

describe("Cursor backend start-up", () => {
  it("re-attaches to the persisted agent and expires stale runs on the first send only", async () => {
    const made = rig({ start: { resumeAgentId: "agent-9" } });
    await made.kernel.start(made.input);
    expect(made.fake.created).toEqual([]);
    expect(made.fake.resumed.map((entry) => entry.id)).toEqual(["agent-9"]);
    expect(made.events.find((event) => event.kind === "runtime.resume.updated")?.payload).toEqual({ resumePointer: "agent-9", mode: "cursor" });

    for (const text of ["first", "second"]) {
      const { command } = inputCommand(text);
      const done = made.kernel.dispatch(command);
      const run = await runOf(made.fake, text === "first" ? 0 : 1);
      run.finish(finished("ok"));
      await done;
    }
    expect(made.fake.sends.map((send) => send.options)).toEqual([{ local: { force: true } }, undefined]);
  });

  it("says why a persisted agent cannot be resumed", async () => {
    const made = rig({
      start: { resumeAgentId: "agent-gone" },
      configure: (fake) => (fake.resumeError = typedError("AgentNotFoundError", "agent not found")),
    });
    const error: unknown = await made.kernel.start(made.input).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CursorStartError);
    expect(error).toMatchObject({ code: "session_not_resumable" });
  });

  it("restricts a read-only session to the read tools", async () => {
    const made = rig({ start: { readOnly: true } });
    await made.kernel.start(made.input);
    expect(made.fake.created[0]?.["tools"]).toEqual(["read", "grep", "glob", "ls", "semSearch", "readLints", "readTodos", "updateTodos"]);
  });
});
