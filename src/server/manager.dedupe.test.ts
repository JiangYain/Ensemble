import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "@shared/constants";
import { derivePhase } from "@shared/projection";
import { testOrigin, USER } from "@shared/testing";
import type { ModelInfo, SessionId } from "@shared/types";
import { ExecutorRegistry, type ModelPolicy } from "./executors/registry";
import { EventHub } from "./hub";
import { silentLogger } from "./logger";
import { DEFAULT_MANAGER_CONFIG, SessionManager, type DelegateInput, type DelegateResult } from "./manager";
import { NoticeCenter } from "./notices";
import { MemoryEventStore } from "./store";
import { makeTrackedEnv, ManualExecutor, shutdownTrackedEnvs, stateOf, until, type TestEnv } from "./testing";

afterEach(shutdownTrackedEnvs);

const WINDOW = LIMITS.duplicateDelegationWindowMs;
const START = new Date("2026-11-16T01:00:00.000Z");

// 只换日期，不动计时器：执行端与 `until` 靠真实的 setTimeout 往前走。
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: START });
});
afterEach(() => {
  vi.useRealTimers();
});

const advance = (ms: number): void => void vi.setSystemTime(Date.now() + ms);

const MODELS: ModelInfo[] = [
  { id: "m-a", label: "A", isDefault: true, efforts: ["low", "high"], defaultEffort: "low" },
  { id: "m-b", label: "B", efforts: ["low", "high"], defaultEffort: "low" },
];

function executor(id: "cursor" | "codex"): ManualExecutor {
  const exec = new ManualExecutor(id, { models: MODELS, defaultModel: "m-a" });
  exec.autoStart = true;
  return exec;
}

/** 防重复默认关闭在测试环境里（见 makeEnv）：这里的测试要的正是生产设定。 */
const ON = { duplicateWindowMs: DEFAULT_MANAGER_CONFIG.duplicateWindowMs };

function setup(config: Parameters<typeof makeTrackedEnv>[1] = {}, policy?: ModelPolicy): { env: TestEnv; cursor: ManualExecutor; codex: ManualExecutor } {
  const cursor = executor("cursor");
  const codex = executor("codex");
  return { env: makeTrackedEnv([cursor, codex], { ...ON, ...config }, undefined, policy), cursor, codex };
}

function ask(env: TestEnv, overrides: Partial<DelegateInput> = {}): Promise<DelegateResult> {
  return env.manager.delegate({ harness: "cursor", task: "Review the parser", cwd: env.cwd, origin: testOrigin(), ...overrides });
}

/** 一次会话被创建的次数，以事件为准（不是以返回值为准）。 */
function created(env: TestEnv): number {
  return env.hub.sessionIds().filter((id) => env.hub.events(id).some((event) => event.kind === "session.created")).length;
}

async function running(env: TestEnv, sessionId: SessionId): Promise<void> {
  await until(() => stateOf(env, sessionId).status === "running", 4000, "running");
}

describe("the window", () => {
  it("is 120 seconds by default and comes from LIMITS, not a literal", () => {
    expect(LIMITS.duplicateDelegationWindowMs).toBe(120_000);
    expect(DEFAULT_MANAGER_CONFIG.duplicateWindowMs).toBe(LIMITS.duplicateDelegationWindowMs);
  });
});

describe("an identical delegation shortly after the first", () => {
  it("returns the session that already exists, and says how long ago it was created", async () => {
    const { env } = setup();
    const first = await ask(env);
    expect(first).not.toHaveProperty("duplicate");
    await running(env, first.sessionId);

    advance(11_700); // 今天那次真实重复相隔的时间
    const second = await ask(env);

    expect(second).toEqual({ sessionId: first.sessionId, runId: first.runId, messageId: first.messageId, duplicate: { ageMs: 11_700 } });
    expect(created(env)).toBe(1);
  });

  it("has no side effects: no event, no message, no notice, no new run, no new native session", async () => {
    const { env, cursor } = setup();
    const first = await ask(env);
    await running(env, first.sessionId);
    const before = stateOf(env, first.sessionId);
    const counts = { seq: before.seq, messages: before.messages.length, runs: before.runs.length, events: env.hub.events(first.sessionId).length };
    const seen: string[] = [];
    env.hub.subscribe((change) => seen.push(change.type));

    advance(5_000);
    await ask(env);
    await ask(env, { title: "Another title" });

    const after = stateOf(env, first.sessionId);
    expect({ seq: after.seq, messages: after.messages.length, runs: after.runs.length, events: env.hub.events(first.sessionId).length }).toEqual(counts);
    expect(seen).toEqual([]);
    expect(env.hub.sessionIds()).toHaveLength(1);
    expect(env.notices.pendingCount()).toBe(0);
    expect(cursor.sessions).toHaveLength(1);
    expect(cursor.sessions[0]!.started).toHaveLength(1);
  });

  it("counts from the creation of the existing session, not from its latest activity", async () => {
    const { env } = setup();
    const first = await ask(env);
    await running(env, first.sessionId);

    advance(WINDOW - 1);
    expect(await ask(env)).toMatchObject({ sessionId: first.sessionId, duplicate: { ageMs: WINDOW - 1 } });
    // 它一直在运行、一直有动静，也不延长窗口。
    advance(1);
    const later = await ask(env);
    expect(later.sessionId).not.toBe(first.sessionId);
    expect(later).not.toHaveProperty("duplicate");
    expect(created(env)).toBe(2);
  });

  it("treats a title, and whitespace around the task, as no difference", async () => {
    const { env } = setup();
    const first = await ask(env, { title: "One name" });
    const second = await ask(env, { title: "Another name", task: "  Review the parser\n" });
    expect(second).toMatchObject({ sessionId: first.sessionId, duplicate: {} });
    expect(created(env)).toBe(1);
  });

  it("treats a different spelling of the same directory as the same", async () => {
    const { env } = setup();
    const first = await ask(env);
    const second = await ask(env, { cwd: env.cwd + sep });
    expect(second).toMatchObject({ sessionId: first.sessionId, duplicate: {} });
  });

  // Windows 与 macOS 的目录不区分大小写；Linux 上大小写不同就是两个目录（也不能 stat 到），所以只在 Windows 上测。
  it.runIf(process.platform === "win32")("treats a path that differs only in letter case as the same directory on Windows", async () => {
    const { env } = setup();
    const first = await ask(env);
    const second = await ask(env, { cwd: env.cwd.toUpperCase() });
    expect(second).toMatchObject({ sessionId: first.sessionId, duplicate: {} });
  });

  it("ignores which host label or title the origin carries — only its key counts", async () => {
    const { env } = setup();
    const first = await ask(env);
    const second = await ask(env, { origin: testOrigin({ hostLabel: "Codex (other window)", hostTitle: "Renamed chat" }) });
    expect(second).toMatchObject({ sessionId: first.sessionId, duplicate: {} });
  });

  it("treats context as equal however its keys were ordered, and an empty list as none", async () => {
    const { env } = setup();
    const first = await ask(env, { context: [{ kind: "snippet", text: "x = 1", path: "a.ts", language: "ts" }] });
    const reordered = await ask(env, { context: [{ language: "ts", path: "a.ts", text: "x = 1", kind: "snippet" }] });
    expect(reordered).toMatchObject({ sessionId: first.sessionId, duplicate: {} });

    const bare = await ask(env, { task: "No context at all" });
    const empty = await ask(env, { task: "No context at all", context: [] });
    expect(empty).toMatchObject({ sessionId: bare.sessionId, duplicate: {} });
  });

  it("answers with the newest of several matching sessions", async () => {
    const { env } = setup();
    const first = await ask(env);
    advance(30_000);
    const second = await ask(env, { allowDuplicate: true });
    advance(10_000);
    const third = await ask(env);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(third).toMatchObject({ sessionId: second.sessionId, duplicate: { ageMs: 10_000 } });
  });
});

describe("what makes a delegation a different one", () => {
  const VARIANTS: Array<[string, (parent: SessionId) => Partial<DelegateInput>]> = [
    ["harness", () => ({ harness: "codex" })],
    ["model", () => ({ model: "m-b" })],
    ["effort", () => ({ effort: "high" })],
    ["access", () => ({ access: "read_only" })],
    ["working directory", () => ({ cwd: mkdtempSync(join(tmpdir(), "ensemble-dedupe-other-")) })],
    ["task", () => ({ task: "Review the parser, then the lexer" })],
    ["context", () => ({ context: [{ kind: "text", text: "Mind the unicode escapes" }] })],
    ["origin", () => ({ origin: testOrigin({ key: "codex:thr_another_chat" }) })],
    ["parent session", (parent) => ({ parentSessionId: parent })],
  ];

  it.each(VARIANTS)("a different %s creates a new session", async (_name, variant) => {
    const { env } = setup();
    const parent = await ask(env, { task: "The parent" });
    const base = await ask(env);
    const other = await ask(env, variant(parent.sessionId));
    expect(other.sessionId).not.toBe(base.sessionId);
    expect(other).not.toHaveProperty("duplicate");
    expect(created(env)).toBe(3);
  });

  it("the same parent session twice is one delegation", async () => {
    const { env } = setup();
    const parent = await ask(env, { task: "The parent" });
    const first = await ask(env, { parentSessionId: parent.sessionId });
    const second = await ask(env, { parentSessionId: parent.sessionId });
    expect(second).toMatchObject({ sessionId: first.sessionId, duplicate: {} });
    // 没有上级的那一份不是同一个委派。
    const orphan = await ask(env);
    expect(orphan.sessionId).not.toBe(first.sessionId);
  });
});

describe("model and effort", () => {
  it("naming the default model and effort is the same as leaving them out", async () => {
    const { env } = setup();
    const omitted = await ask(env);
    const explicit = await ask(env, { model: "m-a", effort: "low" });
    expect(explicit).toMatchObject({ sessionId: omitted.sessionId, duplicate: {} });

    const named = await ask(env, { task: "Another job", model: "m-a" });
    const left = await ask(env, { task: "Another job" });
    expect(left).toMatchObject({ sessionId: named.sessionId, duplicate: {} });
  });

  it("is not fooled by a model that is not the default", async () => {
    const { env } = setup();
    const omitted = await ask(env);
    const other = await ask(env, { model: "m-b" });
    expect(other.sessionId).not.toBe(omitted.sessionId);
    const sameOther = await ask(env, { model: "m-b", effort: "low" });
    expect(sameOther).toMatchObject({ sessionId: other.sessionId, duplicate: {} });
  });

  it("follows the model the user's settings pin when the default is not open", async () => {
    // 默认模型 m-a 没有开放：不指定模型时 Ensemble 固定用 m-b，所以与明说 m-b 是同一个委派。
    const { env } = setup({}, { modelSettings: () => ({ allowedModels: ["m-b"] }) });
    const omitted = await ask(env);
    expect(stateOf(env, omitted.sessionId).meta.model?.requested).toBe("m-b");
    const explicit = await ask(env, { model: "m-b" });
    expect(explicit).toMatchObject({ sessionId: omitted.sessionId, duplicate: {} });
  });

  describe("with a default the user chose in the settings", () => {
    const view = (userDefaultModel: string | undefined): ModelPolicy => ({ modelSettings: () => userDefaultModel === undefined ? {} : { userDefaultModel } });

    it("omitting the model is the same as naming the chosen one, and not the same as naming the harness's own default", async () => {
      const { env } = setup({}, view("m-b"));
      const omitted = await ask(env);
      expect(stateOf(env, omitted.sessionId).meta.model?.requested).toBe("m-b");
      // 再次不指定模型：判重看到的也是固定下来的 m-b，而不是执行端自己的 m-a（否则每次都会多出一个会话）。
      expect(await ask(env)).toMatchObject({ sessionId: omitted.sessionId, duplicate: {} });
      expect(await ask(env, { model: "m-b" })).toMatchObject({ sessionId: omitted.sessionId, duplicate: {} });
      const own = await ask(env, { model: "m-a" });
      expect(own.sessionId).not.toBe(omitted.sessionId);
      expect(own.duplicate).toBeUndefined();
    });

    it("a session created before the choice ran on the harness's own default, so it is not a duplicate of one that now gets the chosen model", async () => {
      let chosen: string | undefined;
      const { env } = setup({}, { modelSettings: () => chosen === undefined ? {} : { userDefaultModel: chosen } });
      const before = await ask(env);
      expect(stateOf(env, before.sessionId).meta.model).toBeUndefined();
      chosen = "m-b";
      const after = await ask(env);
      expect(after.duplicate).toBeUndefined();
      expect(after.sessionId).not.toBe(before.sessionId);
      expect(stateOf(env, after.sessionId).meta.model?.requested).toBe("m-b");
      // 而明说 m-a（执行端自己的默认）才是先前那个会话的重复。
      expect(await ask(env, { model: "m-a" })).toMatchObject({ sessionId: before.sessionId, duplicate: {} });
    });

    it("a chosen default that is no longer usable changes nothing: omitting the model is the harness's own default again", async () => {
      const { env } = setup({}, view("m-gone"));
      const omitted = await ask(env);
      expect(stateOf(env, omitted.sessionId).meta.model).toBeUndefined();
      expect(await ask(env, { model: "m-a", effort: "low" })).toMatchObject({ sessionId: omitted.sessionId, duplicate: {} });
    });
  });
});

describe("only a session that still stands counts", () => {
  it("counts starting, queued, running and done sessions", async () => {
    const { env, cursor } = setup({ maxConcurrentRuns: 1 });
    const holder = await ask(env, { task: "Hold the only slot" });
    await running(env, holder.sessionId);
    const waiting = await ask(env, { task: "Wait in line" });
    await until(() => derivePhase(stateOf(env, waiting.sessionId)) === "queued", 4000, "queued");

    expect(await ask(env, { task: "Hold the only slot" })).toMatchObject({ sessionId: holder.sessionId, duplicate: {} });
    expect(derivePhase(stateOf(env, holder.sessionId))).toBe("running");
    expect(await ask(env, { task: "Wait in line" })).toMatchObject({ sessionId: waiting.sessionId, duplicate: {} });

    // 做完了（done）也算：几十秒内做完、又收到逐字相同的委派，几乎一定是重复提交。
    cursor.sessions[0]!.complete(holder.runId);
    await until(() => derivePhase(stateOf(env, holder.sessionId)) === "done", 4000, "done");
    expect(await ask(env, { task: "Hold the only slot" })).toMatchObject({ sessionId: holder.sessionId, duplicate: {} });
  });

  it("counts a session that has not been connected yet (starting)", async () => {
    const cursor = executor("cursor");
    cursor.autoStart = false;
    const env = makeTrackedEnv([cursor], ON);
    const first = await ask(env);
    await until(() => cursor.sessions[0]?.started.length === 1, 4000, "run handed to the harness");
    expect(derivePhase(stateOf(env, first.sessionId))).toBe("starting");
    expect(await ask(env)).toMatchObject({ sessionId: first.sessionId, duplicate: {} });
  });

  it("does not count a failed session: trying again right after a failure is legitimate", async () => {
    const { env, cursor } = setup();
    cursor.openError = new Error("boom");
    const failed = await ask(env);
    await until(() => derivePhase(stateOf(env, failed.sessionId)) === "failed", 4000, "failed");
    cursor.openError = undefined;

    const retry = await ask(env);
    expect(retry.sessionId).not.toBe(failed.sessionId);
    expect(retry).not.toHaveProperty("duplicate");
  });

  it("does not count a cancelled session", async () => {
    const { env } = setup();
    const first = await ask(env);
    await running(env, first.sessionId);
    await env.manager.cancel(first.sessionId, USER);
    await until(() => derivePhase(stateOf(env, first.sessionId)) === "cancelled", 4000, "cancelled");

    const again = await ask(env);
    expect(again.sessionId).not.toBe(first.sessionId);
    expect(again).not.toHaveProperty("duplicate");
  });

  it("does not count a stopped session", async () => {
    const { env } = setup();
    const first = await ask(env);
    await running(env, first.sessionId);
    await env.manager.stop(first.sessionId, USER);
    expect(derivePhase(stateOf(env, first.sessionId))).toBe("stopped");

    const again = await ask(env);
    expect(again.sessionId).not.toBe(first.sessionId);
    expect(again).not.toHaveProperty("duplicate");
  });

  it("does not count a removed session", async () => {
    const { env } = setup();
    const first = await ask(env);
    await running(env, first.sessionId);
    await env.manager.stop(first.sessionId, USER);
    await env.manager.remove(first.sessionId);

    const again = await ask(env);
    expect(again.sessionId).not.toBe(first.sessionId);
  });
});

describe("allowDuplicate", () => {
  it("creates a second identical session on purpose, and says nothing about duplicates", async () => {
    const { env, cursor } = setup();
    const first = await ask(env);
    const second = await ask(env, { allowDuplicate: true });
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second).not.toHaveProperty("duplicate");
    await until(() => cursor.sessions.length === 2, 4000, "two native sessions");
    expect(created(env)).toBe(2);
  });

  it("false is the same as leaving it out", async () => {
    const { env } = setup();
    const first = await ask(env);
    expect(await ask(env, { allowDuplicate: false })).toMatchObject({ sessionId: first.sessionId, duplicate: {} });
    expect(created(env)).toBe(1);
  });
});

describe("requests arriving at the same time", () => {
  it("two identical requests create one session", async () => {
    const { env, cursor } = setup();
    const results = await Promise.all([ask(env), ask(env)]);

    expect(new Set(results.map((result) => result.sessionId)).size).toBe(1);
    expect(results.filter((result) => result.duplicate === undefined)).toHaveLength(1);
    expect(created(env)).toBe(1);
    await until(() => cursor.sessions.length === 1, 4000, "native session");
    expect(stateOf(env, results[0]!.sessionId).runs).toHaveLength(1);
  });

  it("five identical requests create one session and one run", async () => {
    const { env } = setup();
    const results = await Promise.all(Array.from({ length: 5 }, () => ask(env)));

    expect(new Set(results.map((result) => result.sessionId)).size).toBe(1);
    expect(new Set(results.map((result) => result.runId)).size).toBe(1);
    expect(results.filter((result) => result.duplicate === undefined)).toHaveLength(1);
    expect(created(env)).toBe(1);
    expect(stateOf(env, results[0]!.sessionId).runs).toHaveLength(1);
    expect(stateOf(env, results[0]!.sessionId).messages).toHaveLength(1);
  });

  it("holds when the requests spell the same thing differently and take different routes to the check", async () => {
    const { env } = setup();
    const results = await Promise.all([
      ask(env),
      ask(env, { cwd: env.cwd + sep, title: "Named" }),
      ask(env, { task: "\nReview the parser  ", model: "m-a", effort: "low" }),
      ask(env, { context: [] }),
    ]);
    expect(new Set(results.map((result) => result.sessionId)).size).toBe(1);
    expect(created(env)).toBe(1);
  });

  it("only merges the identical ones when different requests are mixed in", async () => {
    const { env } = setup();
    const results = await Promise.all([
      ask(env, { task: "A" }),
      ask(env, { task: "B" }),
      ask(env, { task: "A" }),
      ask(env, { task: "B" }),
      ask(env, { task: "A" }),
      ask(env, { task: "C" }),
    ]);
    expect(created(env)).toBe(3);
    expect(new Set(results.map((result) => result.sessionId)).size).toBe(3);
    expect(results[0]!.sessionId).toBe(results[2]!.sessionId);
    expect(results[0]!.sessionId).toBe(results[4]!.sessionId);
    expect(results[1]!.sessionId).toBe(results[3]!.sessionId);
  });

  it("also when they all wait on the same slow probe and continue in one go (a service that has just started)", async () => {
    // 冷启动：几个请求同时等同一次探测，探测一完成它们在同一轮微任务里依次继续——最容易在检查与登记之间漏过去。
    class SlowProbe extends ManualExecutor {
      override async probe() {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return this.info;
      }
    }
    const slow = new SlowProbe("cursor", { models: MODELS, defaultModel: "m-a" });
    slow.autoStart = true;
    const env = makeTrackedEnv([slow], ON);
    const results = await Promise.all(Array.from({ length: 4 }, () => ask(env)));
    expect(new Set(results.map((result) => result.sessionId)).size).toBe(1);
    expect(created(env)).toBe(1);
  });

  it("with allowDuplicate on every request, all of them are created", async () => {
    const { env } = setup();
    await Promise.all(Array.from({ length: 4 }, () => ask(env, { allowDuplicate: true })));
    expect(created(env)).toBe(4);
  });

  it("a request that is rejected leaves nothing behind for the others to match", async () => {
    const { env } = setup();
    const results = await Promise.allSettled([ask(env, { cwd: join(env.cwd, "missing") }), ask(env), ask(env)]);
    expect(results[0]!.status).toBe("rejected");
    expect(created(env)).toBe(1);
  });
});

describe("after the service restarts", () => {
  it("still recognises a session replayed from the event log that finished before the restart", async () => {
    const exec = executor("cursor");
    const store = new MemoryEventStore();
    const env = makeTrackedEnv([exec], ON, store);
    const first = await ask(env);
    await running(env, first.sessionId);
    exec.sessions[0]!.complete(first.runId);
    await until(() => derivePhase(stateOf(env, first.sessionId)) === "done", 4000, "done");

    advance(40_000);
    const hub2 = new EventHub({ store, log: silentLogger, coalesceMs: 0 });
    await hub2.load();
    const manager2 = new SessionManager({ hub: hub2, executors: new ExecutorRegistry([exec], silentLogger), notices: new NoticeCenter(hub2), log: silentLogger, config: ON });
    expect(manager2.reconcileAfterRestart()).toBe(0);

    const again = await manager2.delegate({ harness: "cursor", task: "Review the parser", cwd: env.cwd, origin: testOrigin() });
    expect(again).toEqual({ sessionId: first.sessionId, runId: first.runId, messageId: first.messageId, duplicate: { ageMs: 40_000 } });
    expect(hub2.sessionIds()).toEqual([first.sessionId]);
    expect(hub2.state(first.sessionId)?.seq).toBe(stateOf(env, first.sessionId).seq);
  });

  it("does not match a session the restart marked lost: nothing is running there any more", async () => {
    const exec = executor("cursor");
    const store = new MemoryEventStore();
    const env = makeTrackedEnv([exec], ON, store);
    const first = await ask(env);
    await running(env, first.sessionId);

    const hub2 = new EventHub({ store, log: silentLogger, coalesceMs: 0 });
    await hub2.load();
    const manager2 = new SessionManager({ hub: hub2, executors: new ExecutorRegistry([exec], silentLogger), notices: new NoticeCenter(hub2), log: silentLogger, config: ON });
    expect(manager2.reconcileAfterRestart()).toBe(1);
    expect(derivePhase(hub2.state(first.sessionId)!)).toBe("lost");

    const again = await manager2.delegate({ harness: "cursor", task: "Review the parser", cwd: env.cwd, origin: testOrigin() });
    expect(again.sessionId).not.toBe(first.sessionId);
    expect(again).not.toHaveProperty("duplicate");
    await manager2.shutdown();
  });
});
