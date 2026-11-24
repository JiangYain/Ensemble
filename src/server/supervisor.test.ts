import { afterEach, describe, expect, it } from "vitest";
import type { AttentionLimits } from "@shared/attention";
import type { EventDraft, EventPayload } from "@shared/events";
import { testMeta } from "@shared/testing";
import type { AttentionItem, Run } from "@shared/types";
import type { HubChange } from "./hub";
import { AttentionSupervisor } from "./supervisor";
import { makeEnv, type TestEnv } from "./testing";
import { waitForSessions } from "./wait";

const MIN = 60_000;
const LIMITS: AttentionLimits = { quietMs: 4 * MIN, longToolMs: 10 * MIN, longRunMs: 60 * MIN, undeliveredMs: 2 * MIN, sharedFileWindowMs: 10 * MIN };
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

interface Rig {
  env: TestEnv;
  supervisor: AttentionSupervisor;
  clock: { now: number };
  changes: HubChange[];
  emit: (sessionId: string, payload: EventPayload, runId?: string) => void;
  open: (sessionId: string) => void;
}

const supervisors: AttentionSupervisor[] = [];

afterEach(() => {
  for (const supervisor of supervisors.splice(0)) supervisor.stop();
});

function rig(): Rig {
  const env = makeEnv([]);
  const clock = { now: T0 };
  // 不启动定时器：由测试推进时钟并显式调用 recompute()；订阅仍然生效，用来记录文件写入。
  const supervisor = new AttentionSupervisor({ hub: env.hub, log: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } }, limits: LIMITS, tickMs: 3_600_000, settleMs: 3_600_000, now: () => clock.now });
  supervisor.start();
  supervisors.push(supervisor);
  const changes: HubChange[] = [];
  env.hub.subscribe((change) => changes.push(change));

  const emit = (sessionId: string, payload: EventPayload, runId?: string): void => {
    env.hub.emit(sessionId, { ...payload, at: new Date(clock.now).toISOString(), source: "ensemble", ...(runId ? { runId } : {}) } as EventDraft);
  };
  const open = (sessionId: string): void => {
    emit(sessionId, { kind: "session.created", data: { meta: testMeta({ id: sessionId, cwd: "C:\\work\\demo", createdAt: new Date(clock.now).toISOString() }) } });
    const run: Run = { id: `${sessionId}_run`, sessionId, index: 1, trigger: "task", messageId: "msg_none", status: "queued", queuedAt: new Date(clock.now).toISOString(), steerCount: 0 };
    emit(sessionId, { kind: "run.queued", data: { run } });
    emit(sessionId, { kind: "run.started", data: {} }, run.id);
  };
  return { env, supervisor, clock, changes, emit, open };
}

const attentionKinds = (env: TestEnv, sessionId: string): string[] => (env.hub.summary(sessionId)?.attention ?? []).map((item) => item.kind);

describe("AttentionSupervisor", () => {
  it("raises quiet with the passage of time, tells subscribers, and clears it when events resume", () => {
    const { env, supervisor, clock, changes, emit, open } = rig();
    open("ses_a");
    supervisor.recompute();
    expect(env.hub.summary("ses_a")?.attention).toBeUndefined();

    clock.now += 5 * MIN;
    supervisor.recompute();
    expect(attentionKinds(env, "ses_a")).toEqual(["quiet"]);
    expect(changes.filter((change) => change.type === "attention")).toEqual([{ type: "attention", sessionId: "ses_a" }]);

    // 条件没变就不再通知。
    clock.now += MIN;
    supervisor.recompute();
    expect(changes.filter((change) => change.type === "attention")).toHaveLength(1);

    emit("ses_a", { kind: "assistant.completed", data: { itemId: "a1", text: "back" } }, "ses_a_run");
    supervisor.recompute();
    expect(env.hub.summary("ses_a")?.attention).toBeUndefined();
    expect(changes.filter((change) => change.type === "attention")).toHaveLength(2);
  });

  it("serves summaries whose attention follows the registry even when the session itself has no new event", () => {
    const { env, clock, supervisor, open } = rig();
    open("ses_a");
    const before = env.hub.summary("ses_a");
    clock.now += 5 * MIN;
    supervisor.recompute();
    const after = env.hub.summary("ses_a");
    expect(after).not.toBe(before);
    expect(after?.seq).toBe(before?.seq);
    // 没有变化时继续返回缓存的同一个对象。
    expect(env.hub.summary("ses_a")).toBe(after);
  });

  it("tells two running sessions that they wrote the same file, and stops when one is no longer running", () => {
    const { env, supervisor, clock, emit, open } = rig();
    open("ses_a");
    open("ses_b");
    emit("ses_a", { kind: "file.changed", data: { files: [{ path: "src/engine.ts", change: "modified" }] } }, "ses_a_run");
    clock.now += 30_000;
    emit("ses_b", { kind: "file.changed", data: { files: [{ path: "src/engine.ts", change: "modified" }] } }, "ses_b_run");
    supervisor.recompute();

    const a = env.hub.summary("ses_a")?.attention ?? [];
    const b = env.hub.summary("ses_b")?.attention ?? [];
    expect(a).toEqual([expect.objectContaining({ kind: "shared_file", withSessionIds: ["ses_b"], since: new Date(clock.now).toISOString() })]);
    expect(b).toEqual([expect.objectContaining({ kind: "shared_file", withSessionIds: ["ses_a"] })]);
    expect((a[0] as Extract<AttentionItem, { kind: "shared_file" }>).path).toMatch(/engine\.ts$/);

    emit("ses_b", { kind: "run.completed", data: { stopReason: "end_turn" } }, "ses_b_run");
    supervisor.recompute();
    expect(attentionKinds(env, "ses_a")).toEqual([]);
    expect(attentionKinds(env, "ses_b")).toEqual([]);
  });

  // Windows 路径不区分大小写、两种分隔符都认；其他平台上这些写法本来就是不同的文件。
  it.runIf(process.platform === "win32")("recognises the same file under another spelling on Windows", () => {
    const { env, supervisor, emit, open } = rig();
    open("ses_a");
    open("ses_b");
    emit("ses_a", { kind: "file.changed", data: { files: [{ path: "src/engine.ts", change: "modified" }] } }, "ses_a_run");
    emit("ses_b", { kind: "file.changed", data: { files: [{ path: "C:\\work\\demo\\SRC\\Engine.ts", change: "modified" }] } }, "ses_b_run");
    supervisor.recompute();
    expect(attentionKinds(env, "ses_a")).toEqual(["shared_file"]);
    expect(attentionKinds(env, "ses_b")).toEqual(["shared_file"]);
  });

  it("publishes a whole round at once, so no subscriber ever reads half of it", () => {
    const { env, supervisor, emit, open } = rig();
    open("ses_a");
    open("ses_b");
    emit("ses_a", { kind: "file.changed", data: { files: [{ path: "src/engine.ts", change: "modified" }] } }, "ses_a_run");
    emit("ses_b", { kind: "file.changed", data: { files: [{ path: "src/engine.ts", change: "modified" }] } }, "ses_b_run");

    const views: string[][][] = [];
    env.hub.subscribe((change) => {
      if (change.type === "attention") views.push([attentionKinds(env, "ses_a"), attentionKinds(env, "ses_b")]);
    });
    supervisor.recompute();

    expect(views).toHaveLength(2);
    for (const view of views) expect(view).toEqual([["shared_file"], ["shared_file"]]);
  });

  it("ignores writes that are far apart, and different files", () => {
    const { env, supervisor, clock, emit, open } = rig();
    open("ses_a");
    open("ses_b");
    emit("ses_a", { kind: "file.changed", data: { files: [{ path: "a.ts", change: "modified" }] } }, "ses_a_run");
    emit("ses_b", { kind: "file.changed", data: { files: [{ path: "b.ts", change: "modified" }] } }, "ses_b_run");
    clock.now += 11 * MIN;
    emit("ses_b", { kind: "file.changed", data: { files: [{ path: "a.ts", change: "modified" }] } }, "ses_b_run");
    emit("ses_a", { kind: "assistant.completed", data: { itemId: "x", text: "alive" } }, "ses_a_run");
    supervisor.recompute();
    expect(attentionKinds(env, "ses_a")).toEqual([]);
    expect(attentionKinds(env, "ses_b")).toEqual([]);
  });

  it("forgets a removed session", async () => {
    const { env, supervisor, clock, open } = rig();
    open("ses_a");
    clock.now += 5 * MIN;
    supervisor.recompute();
    expect(env.hub.attentionOf("ses_a")).toHaveLength(1);
    await env.hub.remove("ses_a");
    expect(env.hub.attentionOf("ses_a")).toEqual([]);
    expect(() => supervisor.recompute()).not.toThrow();
  });
});

describe("waitForSessions and attention", () => {
  const quiet = (since: string): AttentionItem => ({ kind: "quiet", since, seq: 3 });
  const signal = (): AbortSignal => new AbortController().signal;

  function waiting() {
    const { env, open } = rig();
    open("ses_a");
    return { env, deps: { hub: env.hub, notices: env.notices } };
  }

  it("returns early when a session newly shows something, and says what was raised", async () => {
    const { env, deps } = waiting();
    const pending = waitForSessions(deps, { sessionIds: ["ses_a"], timeoutMs: 5_000 }, signal());
    env.hub.setAttention("ses_a", [quiet("2026-01-01T00:04:00.000Z")]);
    const response = await pending;
    expect(response.reason).toBe("attention");
    expect(response.raised).toEqual([{ sessionId: "ses_a", item: quiet("2026-01-01T00:04:00.000Z") }]);
    expect(response.sessions[0]?.attention).toEqual([quiet("2026-01-01T00:04:00.000Z")]);
  });

  it("does not return at once for something that was already there, but still hands it back with the summary", async () => {
    const { env, deps } = waiting();
    env.hub.setAttention("ses_a", [quiet("2026-01-01T00:04:00.000Z")]);
    const response = await waitForSessions(deps, { sessionIds: ["ses_a"], timeoutMs: 30 }, signal());
    expect(response.reason).toBe("timeout");
    expect(response.raised).toBeUndefined();
    expect(response.sessions[0]?.attention).toHaveLength(1);
  });

  it("returns again when the same session later raises a different quiet period", async () => {
    const { env, deps } = waiting();
    env.hub.setAttention("ses_a", [quiet("2026-01-01T00:04:00.000Z")]);
    const pending = waitForSessions(deps, { sessionIds: ["ses_a"], timeoutMs: 5_000 }, signal());
    env.hub.setAttention("ses_a", [quiet("2026-01-01T00:04:00.000Z"), { kind: "long_run", since: "2026-01-01T00:00:00.000Z" }]);
    const response = await pending;
    expect(response.reason).toBe("attention");
    expect(response.raised?.map((entry) => entry.item.kind)).toEqual(["long_run"]);
  });

  it("can be told to wait strictly for completion", async () => {
    const { env, deps } = waiting();
    const pending = waitForSessions(deps, { sessionIds: ["ses_a"], timeoutMs: 60, attention: false }, signal());
    env.hub.setAttention("ses_a", [quiet("2026-01-01T00:04:00.000Z")]);
    const response = await pending;
    expect(response.reason).toBe("timeout");
    expect(response.raised).toBeUndefined();
  });

  it("keeps settling a session as before: attention does not hide completion", async () => {
    const { env, open } = rig();
    open("ses_a");
    open("ses_b");
    const deps = { hub: env.hub, notices: env.notices };
    const pending = waitForSessions(deps, { sessionIds: ["ses_a", "ses_b"], mode: "any_settled", timeoutMs: 5_000 }, signal());
    env.hub.setAttention("ses_b", [quiet("2026-01-01T00:04:00.000Z")]);
    expect((await pending).reason).toBe("attention");

    env.hub.emit("ses_a", { kind: "run.completed", data: { stopReason: "end_turn" }, runId: "ses_a_run", source: "executor" });
    const next = await waitForSessions(deps, { sessionIds: ["ses_a", "ses_b"], mode: "any_settled", timeoutMs: 100 }, signal());
    expect(next.reason).toBe("settled");
  });
});
