import { describe, expect, it } from "vitest";
import { applyEvent, createState, deriveProgress, replay, toSummary, type SessionState } from "./projection";
import { AGENT, EventLog, USER } from "./testing";
import type { AssistantItem, PlanItem, ToolItem } from "./types";

/** 创建会话 + 任务消息 + 第一次运行（已入队），返回日志与状态。 */
function bootstrap(): { log: EventLog; state: SessionState } {
  const log = new EventLog();
  const created = log.created();
  if (created.kind !== "session.created") throw new Error("unreachable");
  const state = createState(created);
  log.message("msg_1", "task", "Refactor the parser module");
  log.run("run_1", 1, "msg_1");
  feed(log, state);
  return { log, state };
}

function feed(log: EventLog, state: SessionState): void {
  for (const event of log.events) applyEvent(state, event);
}

describe("session lifecycle", () => {
  it("starts in the starting phase and moves through running to done", () => {
    const { log, state } = bootstrap();
    expect(toSummary(state).phase).toBe("starting");
    expect(toSummary(state).activity.kind).toBe("starting");

    log.startRun("run_1");
    feed(log, state);
    expect(state.status).toBe("running");
    expect(toSummary(state).phase).toBe("running");
    expect(state.activeRunId).toBe("run_1");

    log.push({ kind: "run.completed", data: { stopReason: "end_turn" } }, { runId: "run_1" });
    feed(log, state);
    const summary = toSummary(state);
    expect(summary.phase).toBe("done");
    expect(summary.activity.kind).toBe("done");
    expect(summary.lastRun?.status).toBe("completed");
    expect(summary.lastRun?.durationMs).toBeGreaterThan(0);
    expect(summary.activeRunId).toBeUndefined();
    expect(summary.endedAt).toBeDefined();
  });

  it("marks failed runs with the error and keeps the session usable (idle)", () => {
    const { log, state } = bootstrap();
    log.startRun("run_1");
    log.push({ kind: "run.failed", data: { error: { code: "model_not_found", message: "The model does not exist" } } }, { runId: "run_1" });
    feed(log, state);
    const summary = toSummary(state);
    expect(summary.phase).toBe("failed");
    expect(summary.status).toBe("idle");
    expect(summary.lastError?.code).toBe("model_not_found");
  });

  it("distinguishes cancelled from failed", () => {
    const { log, state } = bootstrap();
    log.startRun("run_1");
    log.push({ kind: "run.cancelled", data: { by: USER } }, { runId: "run_1" });
    feed(log, state);
    expect(toSummary(state).phase).toBe("cancelled");
  });

  it("honours explicit session status events for stopped, failed and lost", () => {
    const { log, state } = bootstrap();
    log.push({ kind: "session.status", data: { status: "queued", reason: "capacity" } }, { source: "ensemble" });
    feed(log, state);
    expect(toSummary(state).phase).toBe("queued");

    log.push({ kind: "session.status", data: { status: "lost" } }, { source: "ensemble" });
    feed(log, state);
    expect(toSummary(state).phase).toBe("lost");

    log.push({ kind: "session.status", data: { status: "stopped" } }, { source: "ensemble" });
    feed(log, state);
    expect(toSummary(state).phase).toBe("stopped");
  });

  it("tracks a second run separately from the first", () => {
    const { log, state } = bootstrap();
    log.startRun("run_1");
    log.push({ kind: "run.completed", data: {} }, { runId: "run_1" });
    log.message("msg_2", "follow_up", "Now add tests", USER);
    log.run("run_2", 2, "msg_2", "follow_up");
    log.startRun("run_2");
    feed(log, state);
    const summary = toSummary(state);
    expect(summary.runCount).toBe(2);
    expect(summary.activeRunId).toBe("run_2");
    expect(summary.phase).toBe("running");
    expect(state.runs.map((r) => r.status)).toEqual(["completed", "running"]);
  });
});

describe("applyEvent idempotency", () => {
  it("ignores events whose sequence number was already applied", () => {
    const { log, state } = bootstrap();
    const started = log.startRun("run_1");
    expect(applyEvent(state, started)).toBe(true);
    expect(applyEvent(state, started)).toBe(false);
    expect(state.timeline.filter((i) => i.type === "run")).toHaveLength(1);
  });

  it("replay rebuilds identical state from the full event list", () => {
    const { log, state } = bootstrap();
    log.startRun("run_1");
    log.push({ kind: "assistant.delta", data: { itemId: "a1", text: "Hello " } }, { runId: "run_1" });
    log.push({ kind: "assistant.delta", data: { itemId: "a1", text: "world" } }, { runId: "run_1" });
    log.tool("run_1", "c1", "running");
    log.tool("run_1", "c1", "completed");
    feed(log, state);
    const rebuilt = replay(log.events);
    expect(rebuilt).toBeDefined();
    expect(toSummary(rebuilt!)).toEqual(toSummary(state));
    expect(rebuilt!.timeline).toEqual(state.timeline);
  });

  it("returns undefined when the log does not begin with session.created", () => {
    const log = new EventLog();
    log.created();
    expect(replay(log.events.slice(1))).toBeUndefined();
  });
});

describe("streaming output", () => {
  it("accumulates assistant deltas and finalizes on completion with the authoritative text", () => {
    const { log, state } = bootstrap();
    log.startRun("run_1");
    log.push({ kind: "assistant.delta", data: { itemId: "a1", text: "I will " } }, { runId: "run_1" });
    log.push({ kind: "assistant.delta", data: { itemId: "a1", text: "start now" } }, { runId: "run_1" });
    feed(log, state);
    let item = state.timeline.find((i): i is AssistantItem => i.type === "assistant");
    expect(item?.text).toBe("I will start now");
    expect(item?.streaming).toBe(true);
    expect(toSummary(state).activity.kind).toBe("writing");

    log.push({ kind: "assistant.completed", data: { itemId: "a1", text: "I will start now.", phase: "final" } }, { runId: "run_1" });
    feed(log, state);
    item = state.timeline.find((i): i is AssistantItem => i.type === "assistant");
    expect(item?.text).toBe("I will start now.");
    expect(item?.streaming).toBe(false);
    expect(item?.phase).toBe("final");
    expect(toSummary(state).lastAssistantPreview).toBe("I will start now.");
  });

  it("reports thinking while reasoning streams and records its duration", () => {
    const { log, state } = bootstrap();
    log.startRun("run_1");
    log.push({ kind: "reasoning.delta", data: { itemId: "r1", text: "Consider the AST" } }, { runId: "run_1" });
    feed(log, state);
    expect(toSummary(state).activity.kind).toBe("thinking");
    log.push({ kind: "reasoning.completed", data: { itemId: "r1", durationMs: 1500 } }, { runId: "run_1" });
    feed(log, state);
    const reasoning = state.timeline.find((i) => i.type === "reasoning");
    expect(reasoning).toMatchObject({ streaming: false, durationMs: 1500 });
    expect(toSummary(state).activity.kind).toBe("working");
  });

  it("closes a streaming text block when a tool call starts", () => {
    const { log, state } = bootstrap();
    log.startRun("run_1");
    log.push({ kind: "assistant.delta", data: { itemId: "a1", text: "Let me look" } }, { runId: "run_1" });
    log.tool("run_1", "c1", "running", { name: "read", category: "read", title: "src/index.ts" });
    feed(log, state);
    const assistant = state.timeline.find((i): i is AssistantItem => i.type === "assistant");
    expect(assistant?.streaming).toBe(false);
  });
});

describe("tools and activity", () => {
  it("shows the running tool as the current activity, then returns to working", () => {
    const { log, state } = bootstrap();
    log.startRun("run_1");
    log.tool("run_1", "c1", "running", { name: "shell", category: "shell", title: "npm test" });
    feed(log, state);
    const running = toSummary(state).activity;
    expect(running.kind).toBe("tool");
    expect(running.tool).toMatchObject({ category: "shell", title: "npm test" });

    log.tool("run_1", "c1", "completed", { exitCode: 0 });
    feed(log, state);
    const done = state.timeline.find((i): i is ToolItem => i.type === "tool");
    expect(done).toMatchObject({ status: "completed", exitCode: 0 });
    expect(done?.durationMs).toBeGreaterThan(0);
    expect(toSummary(state).activity.kind).toBe("working");
    expect(toSummary(state).counters).toMatchObject({ tools: 1, failedTools: 0 });
  });

  it("counts failed tools once even if the failure is reported repeatedly", () => {
    const { log, state } = bootstrap();
    log.startRun("run_1");
    log.tool("run_1", "c1", "running");
    log.tool("run_1", "c1", "failed", { error: "exit 1" });
    log.tool("run_1", "c1", "failed", { error: "exit 1" });
    feed(log, state);
    expect(toSummary(state).counters.failedTools).toBe(1);
  });

  it("resets the activity timer only when the activity really changes", () => {
    const { log, state } = bootstrap();
    log.startRun("run_1");
    log.tool("run_1", "c1", "running");
    feed(log, state);
    const since = state.activity.since;
    log.tool("run_1", "c1", "running", { output: { text: "partial", truncated: false } });
    feed(log, state);
    expect(state.activity.since).toBe(since);
  });

  it("flags tools that never reported completion once the run ends", () => {
    const { log, state } = bootstrap();
    log.startRun("run_1");
    log.tool("run_1", "c1", "running");
    log.push({ kind: "run.completed", data: {} }, { runId: "run_1" });
    feed(log, state);
    const tool = state.timeline.find((i): i is ToolItem => i.type === "tool");
    expect(tool?.status).toBe("unfinished");
  });

  it("attaches file changes to the tool call and counts distinct files", () => {
    const { log, state } = bootstrap();
    log.startRun("run_1");
    log.tool("run_1", "c1", "running", { name: "edit", category: "edit", title: "src/a.ts" });
    log.push({ kind: "file.changed", data: { callId: "c1", files: [{ path: "src/a.ts", change: "modified", addedLines: 3, removedLines: 1 }] } }, { runId: "run_1" });
    log.push({ kind: "file.changed", data: { files: [{ path: "src/a.ts", change: "modified" }, { path: "src/b.ts", change: "created" }] } }, { runId: "run_1" });
    feed(log, state);
    const tool = state.timeline.find((i): i is ToolItem => i.type === "tool");
    expect(tool?.files).toEqual([{ path: "src/a.ts", change: "modified", addedLines: 3, removedLines: 1 }]);
    expect(toSummary(state).counters.files).toBe(2);
  });
});

describe("progress", () => {
  it("counts nothing before any step happens", () => {
    const { log, state } = bootstrap();
    log.startRun("run_1");
    feed(log, state);
    expect(deriveProgress(state)).toEqual({ done: 0, steps: 0 });
  });

  it("counts real tool steps: finished ones (failed included) as done, every step as steps", () => {
    const { log, state } = bootstrap();
    log.startRun("run_1");
    for (let i = 0; i < 3; i++) {
      log.tool("run_1", `c${i}`, "running");
      log.tool("run_1", `c${i}`, i === 1 ? "failed" : "completed");
    }
    log.tool("run_1", "c3", "running");
    feed(log, state);
    const progress = deriveProgress(state);
    expect(progress).toEqual({ done: 3, steps: 4 });
    expect(progress.total).toBeUndefined();
  });

  it("does not cap the count: many steps are all counted", () => {
    const { log, state } = bootstrap();
    log.startRun("run_1");
    for (let i = 0; i < 52; i++) {
      log.tool("run_1", `c${i}`, "running");
      log.tool("run_1", `c${i}`, "completed");
    }
    feed(log, state);
    expect(deriveProgress(state)).toEqual({ done: 52, steps: 52 });
  });

  it("keeps counting what a cancelled run really did, without pretending it finished", () => {
    const { log, state } = bootstrap();
    log.startRun("run_1");
    log.tool("run_1", "c1", "running");
    log.tool("run_1", "c1", "completed");
    log.push({ kind: "run.cancelled", data: {} }, { runId: "run_1" });
    feed(log, state);
    expect(deriveProgress(state)).toEqual({ done: 1, steps: 1 });
  });

  it("counts only the current run, not the steps of earlier runs", () => {
    const { log, state } = bootstrap();
    log.startRun("run_1");
    log.tool("run_1", "a1", "running");
    log.tool("run_1", "a1", "completed");
    log.push({ kind: "run.completed", data: {} }, { runId: "run_1" });
    log.message("msg_2", "follow_up", "Now add tests", USER);
    log.run("run_2", 2, "msg_2", "follow_up");
    log.startRun("run_2");
    log.tool("run_2", "b1", "running");
    feed(log, state);
    expect(state.activeRunId).toBe("run_2");
    expect(deriveProgress(state)).toEqual({ done: 0, steps: 1 });
  });

  it("uses the harness plan when one is provided", () => {
    const { log, state } = bootstrap();
    log.startRun("run_1");
    log.push(
      {
        kind: "plan.updated",
        data: {
          entries: [
            { text: "Read code", status: "completed" },
            { text: "Edit code", status: "completed" },
            { text: "Run tests", status: "in_progress" },
            { text: "Summarize", status: "pending" },
          ],
        },
      },
      { runId: "run_1" },
    );
    feed(log, state);
    expect(deriveProgress(state)).toEqual({ done: 2, total: 4, steps: 0 });

    log.push(
      {
        kind: "plan.updated",
        data: { entries: [{ text: "A", status: "completed" }, { text: "B", status: "completed" }] },
      },
      { runId: "run_1" },
    );
    feed(log, state);
    expect(deriveProgress(state)).toEqual({ done: 2, total: 2, steps: 0 });

    log.push({ kind: "run.completed", data: {} }, { runId: "run_1" });
    feed(log, state);
    expect(deriveProgress(state)).toEqual({ done: 2, total: 2, steps: 0 });
    expect(state.timeline.filter((i): i is PlanItem => i.type === "plan")).toHaveLength(1);
  });
});

describe("messages and delivery", () => {
  it("advances delivery through harness-reported stages and counts applied steers", () => {
    const { log, state } = bootstrap();
    log.startRun("run_1");
    log.message("msg_s", "steer", "Use async/await instead", USER, "run_1");
    log.push({ kind: "message.delivery", data: { messageId: "msg_s", record: { stage: "handed_off", at: log.now(), evidence: "pi:rpc.response" } } }, { runId: "run_1", source: "ensemble" });
    feed(log, state);
    let summary = toSummary(state);
    expect(summary.messages.pending).toBeGreaterThanOrEqual(1);
    expect(summary.counters.interventions).toBe(1);

    log.push({ kind: "message.delivery", data: { messageId: "msg_s", record: { stage: "applied", at: log.now(), evidence: "pi:message_start(user)" } } }, { runId: "run_1" });
    feed(log, state);
    summary = toSummary(state);
    const message = state.messages.find((m) => m.id === "msg_s");
    expect(message?.delivery.stage).toBe("applied");
    expect(state.runs[0]?.steerCount).toBe(1);
    expect(message?.delivery.history.map((h) => h.stage)).toEqual(["recorded", "handed_off", "applied"]);
  });

  it("marks user interventions as synced once the origin received the notice", () => {
    const { log, state } = bootstrap();
    log.startRun("run_1");
    log.message("msg_s", "steer", "Stop touching the lockfile", USER, "run_1");
    feed(log, state);
    expect(state.messages.find((m) => m.id === "msg_s")?.sync.toOrigin).toBe("pending");

    log.push({ kind: "notice.delivered", data: { noticeIds: ["ntc_1"], messageIds: ["msg_s"], at: log.now() } }, { source: "ensemble" });
    feed(log, state);
    expect(state.messages.find((m) => m.id === "msg_s")?.sync).toMatchObject({ toOrigin: "delivered" });
  });

  it("does not count messages from the delegating agent as user interventions", () => {
    const { log, state } = bootstrap();
    log.startRun("run_1");
    log.message("msg_a", "steer", "Agent-originated steer", AGENT, "run_1");
    feed(log, state);
    expect(toSummary(state).counters.interventions).toBe(0);
  });
});

describe("logs written by earlier builds", () => {
  // 旧版本有“授权”事件和“等待授权”状态；现在被委派的会话是 Full Access，这些概念都不存在了。
  // 类型里已经没有它们，但磁盘上的旧日志可能还带着，重放时必须安静地略过。
  const legacy = (log: EventLog, kind: string, data: unknown): void => {
    log.push({ kind, data } as never, { runId: "run_1" });
  };

  it("replays permission events without ever entering a waiting state", () => {
    const { log, state } = bootstrap();
    log.startRun("run_1");
    legacy(log, "permission.requested", { request: { id: "p1", kind: "command", title: "npm install", requestedAt: log.now() } });
    feed(log, state);
    expect(state.status).toBe("running");
    expect(toSummary(state).phase).toBe("running");
    expect(toSummary(state).activity.kind).not.toBe("waiting_permission");

    legacy(log, "permission.resolved", { requestId: "p1", status: "approved" });
    log.push({ kind: "run.completed", data: {} }, { runId: "run_1" });
    feed(log, state);
    expect(state.timeline.map((item) => item.type as string)).not.toContain("permission");
    expect(toSummary(state).phase).toBe("done");
    expect(toSummary(state)).not.toHaveProperty("pendingPermissions");
  });

  it("reads the retired workspace_write access level as Full Access", () => {
    const log = new EventLog();
    const created = log.created({ access: "workspace_write" as never });
    if (created.kind !== "session.created") throw new Error("unreachable");
    expect(createState(created).meta.access).toBe("full");

    const kept = new EventLog().created({ access: "read_only" });
    if (kept.kind !== "session.created") throw new Error("unreachable");
    expect(createState(kept).meta.access).toBe("read_only");
  });
});

describe("usage", () => {
  it("sums per-run cumulative usage across runs and keeps the latest context size", () => {
    const { log, state } = bootstrap();
    log.startRun("run_1");
    log.push({ kind: "usage.updated", data: { usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.01 } } }, { runId: "run_1" });
    log.push({ kind: "usage.updated", data: { usage: { inputTokens: 150, outputTokens: 40, costUsd: 0.02, contextTokens: 900, contextWindow: 200_000 } } }, { runId: "run_1" });
    log.push({ kind: "run.completed", data: {} }, { runId: "run_1" });
    log.message("msg_2", "follow_up", "again", USER);
    log.run("run_2", 2, "msg_2", "follow_up");
    log.startRun("run_2");
    log.push({ kind: "usage.updated", data: { usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.005, contextTokens: 1200, contextWindow: 200_000 } } }, { runId: "run_2" });
    feed(log, state);
    const usage = toSummary(state).usage;
    expect(usage).toMatchObject({ inputTokens: 160, outputTokens: 45, contextTokens: 1200, contextWindow: 200_000 });
    expect(usage?.costUsd).toBeCloseTo(0.025, 5);
  });
});

describe("session metadata updates", () => {
  it("merges resolved model and native reference into the session", () => {
    const { log, state } = bootstrap();
    log.push(
      {
        kind: "session.updated",
        data: { patch: { model: { resolved: "gpt-5.5", label: "GPT-5.5" }, nativeRef: { kind: "pi-session", id: "abc" } } },
      },
      { source: "executor" },
    );
    feed(log, state);
    const summary = toSummary(state);
    expect(summary.model).toMatchObject({ requested: "test-model", resolved: "gpt-5.5", label: "GPT-5.5" });
    expect(summary.nativeRef).toEqual({ kind: "pi-session", id: "abc" });
  });

  it("includes child sessions and keeps the origin summary free of internal evidence", () => {
    const { state } = bootstrap();
    const summary = toSummary(state, ["ses_child"]);
    expect(summary.childIds).toEqual(["ses_child"]);
    expect(summary.origin).not.toHaveProperty("evidence");
    expect(summary.origin.hostLabel).toBe("Codex");
  });
});
