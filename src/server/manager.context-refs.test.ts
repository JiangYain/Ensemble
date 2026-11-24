/**
 * 会话引用（`context` 里的 `session` 条目）在真中枢与管理器上的整条路径：委派时读上游自己的事件日志，
 * 原文注入下游的提示，取样事实冻结进下游的记录；上游还在运行、不存在、引用太多或提示太长时拒绝，而且拒绝时什么都没有创建；
 * 冷会话（只在磁盘上）读的是日志、不被解冻、不被取消归档；判重比较的是“请求了什么”。
 * 展开的各项细节用假中枢逐条断言：块的格式在 context-refs.test.ts 与 context-refs.merge.test.ts，额度与取不到时的说明在 context-refs.reject.test.ts。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LIMITS } from "@shared/constants";
import type { EnsembleEvent } from "@shared/events";
import { handedOverText, type HandoffPart } from "@shared/handoff";
import { finish, say, startRun } from "@shared/handoff.fixtures";
import { EventLog, testOrigin, USER } from "@shared/testing";
import type { ContextItem, RunId, SessionId } from "@shared/types";
import { archiveSessions } from "./archive";
import { composePrompt } from "./compose";
import { ExecutorRegistry } from "./executors/registry";
import { DAY, lazyHub, NOW, SpyStore, type Clock } from "./history-fixtures";
import { silentLogger } from "./logger";
import { DEFAULT_MANAGER_CONFIG, SessionManager, type DelegateInput, type DelegateResult, type ManagerConfig } from "./manager";
import { NoticeCenter } from "./notices";
import { makeTrackedEnv, ManualExecutor, shutdownTrackedEnvs, stateOf, until, type ManualSession, type TestEnv } from "./testing";

const managers: SessionManager[] = [];

afterEach(async () => {
  await shutdownTrackedEnvs();
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown().catch(() => undefined)));
});

const UPSTREAM_TITLE = "Fix the parser";
const ANSWER = "Parser fixed.\nAll tests pass.";

/** 防重复默认关闭在测试环境里（见 makeEnv）：判重的测试要的正是生产设定。 */
const DEDUPE_ON = { duplicateWindowMs: DEFAULT_MANAGER_CONFIG.duplicateWindowMs };

function setup(config: Partial<ManagerConfig> = {}): { env: TestEnv; exec: ManualExecutor } {
  const exec = new ManualExecutor("codex");
  exec.autoStart = true;
  return { env: makeTrackedEnv([exec], config), exec };
}

function ask(env: TestEnv, overrides: Partial<DelegateInput> = {}): Promise<DelegateResult> {
  return env.manager.delegate({ harness: "codex", task: "Review the fix", cwd: env.cwd, origin: testOrigin(), ...overrides });
}

const ref = (sessionId: string, extra: { include?: HandoffPart[]; note?: string } = {}): ContextItem => ({ kind: "session", sessionId, ...extra });

function sessionOf(exec: ManualExecutor, sessionId: SessionId): ManualSession {
  const session = exec.sessions.find((candidate) => candidate.input.meta.id === sessionId);
  if (!session) throw new Error(`no executor session for ${sessionId}`);
  return session;
}

/** 一次运行的结局：说一段最终回答，然后正常结束；等会话回到待命。 */
async function answerRun(env: TestEnv, exec: ManualExecutor, sessionId: SessionId, runId: RunId, answer: string): Promise<void> {
  const session = sessionOf(exec, sessionId);
  session.emit({ kind: "assistant.delta", data: { itemId: `m_${runId}`, text: answer, phase: "final" }, runId });
  session.emit({ kind: "assistant.completed", data: { itemId: `m_${runId}` }, runId });
  session.complete(runId);
  await until(() => stateOf(env, sessionId).status === "idle", 4000, "the run to end");
}

/** 派发一个上游会话，让它跑完并给出最终回答。 */
async function finishedUpstream(env: TestEnv, exec: ManualExecutor, answer = ANSWER): Promise<DelegateResult> {
  const upstream = await ask(env, { task: "Fix the parser", title: UPSTREAM_TITLE });
  await until(() => stateOf(env, upstream.sessionId).status === "running", 4000, "the upstream to run");
  await answerRun(env, exec, upstream.sessionId, upstream.runId, answer);
  return upstream;
}

/** 给上游补一条消息，让它再跑一次并给出新的最终回答。 */
async function continueUpstream(env: TestEnv, exec: ManualExecutor, sessionId: SessionId, answer: string): Promise<void> {
  const sent = await env.manager.send(sessionId, { text: "One more thing", author: USER });
  await until(() => stateOf(env, sessionId).status === "running", 4000, "the follow-up to run");
  await answerRun(env, exec, sessionId, sent.runId, answer);
}

/** 会话被创建的次数，以事件为准。 */
function created(env: TestEnv): number {
  return env.hub.sessionIds().filter((id) => env.hub.events(id).some((event) => event.kind === "session.created")).length;
}

describe("引用一个已结束的会话", () => {
  it("下游收到的提示里是上游的原文，记录里是取样事实，回执与之一致，委派原文原样保存", async () => {
    const { env, exec } = setup();
    const upstream = await finishedUpstream(env, exec);

    const result = await ask(env, { task: "Review the fix", context: [ref(upstream.sessionId, { include: ["result"], note: "Review this" })] });

    const { meta } = stateOf(env, result.sessionId);
    expect(meta.task.text).toBe("Review the fix");
    expect(meta.task.prompt).toContain(`### Session ${upstream.sessionId}: ${UPSTREAM_TITLE}\n`);
    expect(meta.task.prompt).toContain(`\`\`\`text\n${ANSWER}\n\`\`\``);
    expect(meta.task.prompt).toContain("Note from the delegating agent: Review this");

    // 执行端收到的就是记录里的那份提示，一个字不差。
    await until(() => sessionOf(exec, result.sessionId).started.length === 1, 4000, "the downstream run to start");
    expect(sessionOf(exec, result.sessionId).started[0]?.prompt).toBe(meta.task.prompt);

    // 记录里的引用：规范化的请求 + 取样事实 + 块在提示里的区间；回答的正文不在里面（不存第二份）。
    const item = meta.task.context[0];
    if (item?.kind !== "session") throw new Error("expected a session item");
    expect(item).toMatchObject({ sessionId: upstream.sessionId, include: ["result"], note: "Review this" });
    expect(item.sample).toMatchObject({
      title: UPSTREAM_TITLE,
      harness: "codex",
      phase: "done",
      runCount: 1,
      result: { found: true, label: "final", runIndex: 1, chars: ANSWER.length, sentChars: ANSWER.length },
    });
    expect(handedOverText(meta.task.prompt, item)).toContain(ANSWER);
    expect(JSON.stringify(meta.task.context)).not.toContain("All tests pass");

    // 回执：同样的事实，没有提示里的位置。
    expect(result.contextRefs).toEqual([
      expect.objectContaining({ sessionId: upstream.sessionId, include: ["result"], title: UPSTREAM_TITLE, harness: "codex", phase: "done", runCount: 1 }),
    ]);
    expect(result.contextRefs?.[0]).not.toHaveProperty("block");
  });

  it("三样都要，并且夹着别的上下文：各按各的格式进提示，别的条目原样", async () => {
    const { env, exec } = setup();
    const upstream = await ask(env, { task: "Fix the parser", title: UPSTREAM_TITLE });
    await until(() => stateOf(env, upstream.sessionId).status === "running", 4000, "the upstream to run");
    const session = sessionOf(exec, upstream.sessionId);
    session.emit({ kind: "file.changed", data: { files: [{ path: "src/parser.ts", change: "modified" }] }, runId: upstream.runId });
    session.emit({ kind: "assistant.delta", data: { itemId: "m1", text: "Tried, but it failed.", phase: "final" }, runId: upstream.runId });
    session.emit({ kind: "run.failed", data: { error: { code: "executor_exit", message: "Process exited with code 1" } }, runId: upstream.runId });
    await until(() => env.hub.summary(upstream.sessionId)?.phase === "failed", 4000, "the upstream to fail");
    const context: ContextItem[] = [{ kind: "text", title: "Background", text: "The parser is in src/parser.ts" }, ref(upstream.sessionId, { include: ["error", "files", "result"] })];

    const result = await ask(env, { context });

    const { meta } = stateOf(env, result.sessionId);
    expect(meta.task.context[0]).toEqual(context[0]);
    expect(meta.task.prompt).toContain("### Background\nThe parser is in src/parser.ts\n\n### Session ");
    expect(meta.task.prompt).toContain("#### Files changed (1 path across all 1 run, as reported by the executor)\n- src/parser.ts (modified)");
    expect(meta.task.prompt).toContain("#### Last error (run 1 of 1, code: executor_exit)\n```text\nProcess exited with code 1\n```");
    expect(result.contextRefs?.[0]).toMatchObject({
      include: ["result", "files", "error"],
      phase: "failed",
      files: { total: 1, sent: 1 },
      error: { found: true, code: "executor_exit", runIndex: 1 },
    });
  });

  it("同一个会话写了好几次：记录里合成一条，要的部分取并集，提示里只出现一遍", async () => {
    const { env, exec } = setup();
    const upstream = await finishedUpstream(env, exec);

    const result = await ask(env, { context: [ref(upstream.sessionId, { include: ["result"] }), ref(upstream.sessionId, { include: ["files"] })] });

    const { meta } = stateOf(env, result.sessionId);
    expect(meta.task.context).toHaveLength(1);
    expect(meta.task.context[0]).toMatchObject({ kind: "session", include: ["result", "files"] });
    expect(meta.task.prompt.split(`### Session ${upstream.sessionId}`).length - 1).toBe(1);
    expect(result.contextRefs).toHaveLength(1);
  });

  it("上游之后继续跑了：下游记录里“当时交出去了什么”一个字都没变；之后再引用，拿到的是它那时的样子", async () => {
    const { env, exec } = setup();
    const upstream = await finishedUpstream(env, exec, "First answer");
    const first = await ask(env, { task: "Review the first answer", context: [ref(upstream.sessionId)] });
    // 冻结并比较的只有交接记录 meta.task（委派原文、上下文与提示，创建之后没有人再写它）。整份 meta 里还有运行期才补写的字段，
    // 例如执行端打开会话之后才落盘的 nativeRef：它落在“冻结”之后，与上游有没有再跑无关，放进比较就成了与时间赛跑。
    const frozen = structuredClone(stateOf(env, first.sessionId).meta.task);

    await continueUpstream(env, exec, upstream.sessionId, "Second answer");

    const after = stateOf(env, first.sessionId).meta;
    expect(after.task).toEqual(frozen);
    expect(after.task.prompt).toContain("First answer");
    expect(after.task.prompt).not.toContain("Second answer");

    const second = await ask(env, { task: "Review the second answer", context: [ref(upstream.sessionId)] });
    expect(stateOf(env, second.sessionId).meta.task.prompt).toContain("#### Final answer (run 2 of 2)\n```text\nSecond answer\n```");
    expect(second.contextRefs?.[0]).toMatchObject({ runCount: 2, result: { found: true, runIndex: 2 } });
  });

  it("没有 session 条目的委派不经过展开：回执里没有 contextRefs，提示与 composePrompt 逐字相同，记录里的上下文原样", async () => {
    const { env } = setup();
    const context: ContextItem[] = [{ kind: "text", text: "plain" }, { kind: "file", path: "src/a.ts", note: "entry" }];

    const result = await ask(env, { task: "Do it", context });

    expect(result).not.toHaveProperty("contextRefs");
    const { meta } = stateOf(env, result.sessionId);
    expect(meta.task.prompt).toBe(composePrompt("Do it", context));
    expect(meta.task.context).toEqual(context);
  });
});

describe("拒绝：什么都没有创建，也没有碰上游", () => {
  /** 创建会话的数量、打开的执行端连接数、以及上游的事件条数——拒绝之后都不该变。 */
  function snapshot(env: TestEnv, exec: ManualExecutor, upstreamId: SessionId) {
    return { sessions: env.hub.sessionIds().length, opened: exec.sessions.length, upstreamEvents: env.hub.events(upstreamId).length };
  }

  it("上游还在运行：拒绝，点名并写明阶段", async () => {
    const { env, exec } = setup();
    const upstream = await ask(env, { task: "Fix the parser" });
    await until(() => stateOf(env, upstream.sessionId).status === "running", 4000, "the upstream to run");
    const before = snapshot(env, exec, upstream.sessionId);

    await expect(ask(env, { context: [ref(upstream.sessionId)] })).rejects.toMatchObject({
      code: "context_session_active",
      details: { via: "context", sessions: [{ sessionId: upstream.sessionId, phase: "running" }] },
    });

    expect(snapshot(env, exec, upstream.sessionId)).toEqual(before);
  });

  it("上游在排队等并发名额：同样拒绝，阶段写 queued", async () => {
    const { env, exec } = setup({ maxConcurrentRuns: 1 });
    await ask(env, { task: "first" });
    const waiting = await ask(env, { task: "second" });
    await until(() => stateOf(env, waiting.sessionId).status === "queued", 4000, "the second session to queue");
    const before = snapshot(env, exec, waiting.sessionId);

    await expect(ask(env, { context: [ref(waiting.sessionId)] })).rejects.toMatchObject({
      code: "context_session_active",
      details: { sessions: [{ sessionId: waiting.sessionId, phase: "queued" }] },
    });

    expect(snapshot(env, exec, waiting.sessionId)).toEqual(before);
  });

  it("引用的会话不存在：拒绝并点名", async () => {
    const { env, exec } = setup();
    const upstream = await finishedUpstream(env, exec);
    const before = snapshot(env, exec, upstream.sessionId);

    await expect(ask(env, { context: [ref(upstream.sessionId), ref("ses_nope")] })).rejects.toMatchObject({
      code: "not_found",
      message: "Session ses_nope referenced in context does not exist.",
      details: { via: "context", sessionIds: ["ses_nope"] },
    });

    expect(snapshot(env, exec, upstream.sessionId)).toEqual(before);
  });

  it("引用的不同会话太多：拒绝，一个都不读", async () => {
    const { env, exec } = setup();
    const upstream = await finishedUpstream(env, exec);
    const before = snapshot(env, exec, upstream.sessionId);
    const refs = Array.from({ length: LIMITS.contextSession.maxRefs + 1 }, (_, index) => ref(index === 0 ? upstream.sessionId : `ses_other_${index}`));

    await expect(ask(env, { context: refs })).rejects.toMatchObject({ code: "context_too_large", details: { refs: LIMITS.contextSession.maxRefs + 1 } });

    expect(snapshot(env, exec, upstream.sessionId)).toEqual(before);
  });

  it("展开之后的提示超过总额：拒绝并分项说明", async () => {
    const { env, exec } = setup();
    const upstream = await finishedUpstream(env, exec);
    const before = snapshot(env, exec, upstream.sessionId);
    // 任务原文本身还在 maxTaskChars 以内（可以单独委派），加上引用块之后才超。
    const task = "t".repeat(LIMITS.maxTaskChars);

    await expect(ask(env, { task, context: [ref(upstream.sessionId)] })).rejects.toMatchObject({
      code: "context_too_large",
      details: { via: "context", maxPromptChars: LIMITS.contextSession.maxPromptChars, taskChars: task.length },
    });

    expect(snapshot(env, exec, upstream.sessionId)).toEqual(before);
    // 同样的任务不带引用照常可以委派：额度只对带会话引用的委派生效。
    await expect(ask(env, { task })).resolves.toMatchObject({ sessionId: expect.any(String) });
  });
});

describe("引用冷会话（只在磁盘上的）", () => {
  const COLD = "ses_cold";

  /** 一份 30 天前就结束了的上游的完整日志：一次运行、一条最终回答。 */
  function coldLog(id: string, answer: string): EnsembleEvent[] {
    const start = NOW - 30 * DAY;
    const log = new EventLog(id, start);
    log.created({ title: "Cold upstream", harness: "codex", createdAt: new Date(start).toISOString() });
    startRun(log, "run_1", 1);
    say(log, "run_1", "item_0", answer, "final");
    finish(log, "run_1");
    return log.events;
  }

  /** 懒加载环境：启动时夹具里的老会话就是冷的；之后的断言只看“谁又被读了”。 */
  async function lazyEnv(logs: readonly EnsembleEvent[][]): Promise<{ env: TestEnv; store: SpyStore }> {
    const store = new SpyStore();
    for (const events of logs) for (const event of events) store.append(event);
    await store.flush();
    const clock: Clock = { now: NOW };
    const hub = lazyHub(store, clock);
    await hub.load();
    const exec = new ManualExecutor("codex");
    exec.autoStart = true;
    const registry = new ExecutorRegistry([exec], silentLogger);
    const notices = new NoticeCenter(hub);
    notices.rebuild();
    const manager = new SessionManager({ hub, executors: registry, notices, log: silentLogger, config: { duplicateWindowMs: 0 } });
    managers.push(manager);
    store.loads.length = 0;
    store.logReads.length = 0;
    return { env: { hub, manager, notices, registry, store, cwd: mkdtempSync(join(tmpdir(), "ensemble-refs-")) }, store };
  }

  it("读的是它磁盘上的日志，不解冻它；已归档的也能引用，引用不会把它取消归档", async () => {
    const { env, store } = await lazyEnv([coldLog(COLD, "Cold answer")]);
    await archiveSessions(env.hub, [COLD], "user");
    expect(env.hub.isHot(COLD)).toBe(false);
    store.loads.length = 0;
    store.logReads.length = 0;

    const result = await ask(env, { context: [ref(COLD)] });

    expect(store.loads).toEqual([]);
    expect(store.logReads).toEqual([COLD]);
    expect(env.hub.isHot(COLD)).toBe(false);
    expect(env.hub.summary(COLD)?.archivedAt).toBeDefined();
    expect(await store.readArchive(COLD)).toBeDefined();
    expect(stateOf(env, result.sessionId).meta.task.prompt).toContain("```text\nCold answer\n```");
    expect(result.contextRefs?.[0]).toMatchObject({ sessionId: COLD, title: "Cold upstream", phase: "done", runCount: 1 });
  });

  it("冷会话也一样先校验：不存在的拒绝，什么都不读", async () => {
    const { env, store } = await lazyEnv([coldLog(COLD, "Cold answer")]);

    await expect(ask(env, { context: [ref(COLD), ref("ses_nope")] })).rejects.toMatchObject({ code: "not_found" });

    expect(store.loads).toEqual([]);
    expect(store.logReads).toEqual([]);
  });
});

describe("判重：比较“请求了什么”，不比较每次都不同的取样结果", () => {
  it("同样的引用请求（include 顺序、note 首尾空白不同）在窗口内只建一个会话，第二次没有回执", async () => {
    const { env, exec } = setup(DEDUPE_ON);
    const upstream = await finishedUpstream(env, exec);

    const first = await ask(env, { context: [ref(upstream.sessionId, { include: ["result", "error"], note: "  Review this  " })] });
    const second = await ask(env, { context: [ref(upstream.sessionId, { include: ["error", "result"], note: "Review this" })] });

    expect(second).toMatchObject({ sessionId: first.sessionId, runId: first.runId, duplicate: {} });
    expect(second).not.toHaveProperty("contextRefs");
    expect(created(env)).toBe(2); // 上游加下游，没有第三个
  });

  it("要的部分不同、或说明不同，就是不同的委派", async () => {
    const { env, exec } = setup(DEDUPE_ON);
    const upstream = await finishedUpstream(env, exec);

    const first = await ask(env, { context: [ref(upstream.sessionId)] });
    const otherParts = await ask(env, { context: [ref(upstream.sessionId, { include: ["files"] })] });
    const otherNote = await ask(env, { context: [ref(upstream.sessionId, { note: "a different reason" })] });

    expect(new Set([first.sessionId, otherParts.sessionId, otherNote.sessionId]).size).toBe(3);
    expect(otherParts).not.toHaveProperty("duplicate");
    expect(otherNote).not.toHaveProperty("duplicate");
  });

  it("上游在两次请求之间又跑完了一次：请求没变，仍然是重复", async () => {
    const { env, exec } = setup(DEDUPE_ON);
    const upstream = await finishedUpstream(env, exec, "First answer");
    const first = await ask(env, { context: [ref(upstream.sessionId)] });

    await continueUpstream(env, exec, upstream.sessionId, "Second answer");
    const second = await ask(env, { context: [ref(upstream.sessionId)] });

    expect(second).toMatchObject({ sessionId: first.sessionId, duplicate: {} });
    // 重复命中时没有新建任何东西，下游记录里仍然是第一次取到的那份。
    expect(stateOf(env, first.sessionId).meta.task.prompt).toContain("First answer");
    expect(stateOf(env, first.sessionId).meta.task.prompt).not.toContain("Second answer");
  });

  it("allowDuplicate 放行：新建一个会话，带着新的取样", async () => {
    const { env, exec } = setup(DEDUPE_ON);
    const upstream = await finishedUpstream(env, exec);
    const first = await ask(env, { context: [ref(upstream.sessionId)] });

    const again = await ask(env, { context: [ref(upstream.sessionId)], allowDuplicate: true });

    expect(again.sessionId).not.toBe(first.sessionId);
    expect(again).not.toHaveProperty("duplicate");
    expect(again.contextRefs).toHaveLength(1);
  });

  it("不带会话引用的委派判重与以前一样", async () => {
    const { env } = setup(DEDUPE_ON);
    const context: ContextItem[] = [{ kind: "text", text: "plain" }];

    const first = await ask(env, { context });
    const second = await ask(env, { context });

    expect(second).toMatchObject({ sessionId: first.sessionId, duplicate: {} });
    expect(second).not.toHaveProperty("contextRefs");
  });
});

describe("引用失败了的上游", () => {
  it("上游失败了也是定稿的：能引用，错误如实带过去", async () => {
    const { env, exec } = setup();
    const upstream = await ask(env, { task: "Fix the parser", title: UPSTREAM_TITLE });
    await until(() => stateOf(env, upstream.sessionId).status === "running", 4000, "the upstream to run");
    sessionOf(exec, upstream.sessionId).emit({ kind: "run.failed", data: { error: { code: "executor_exit", message: "Process exited with code 1" } }, runId: upstream.runId });
    await until(() => env.hub.summary(upstream.sessionId)?.phase === "failed", 4000, "the upstream to fail");

    const result = await ask(env, { context: [ref(upstream.sessionId, { include: ["result", "error"] })] });

    const { prompt } = stateOf(env, result.sessionId).meta.task;
    expect(prompt).toContain("#### Final answer\nNone: none of its 1 run wrote any assistant text (session phase at sampling: failed).");
    expect(prompt).toContain("#### Last error (run 1 of 1, code: executor_exit)\n```text\nProcess exited with code 1\n```");
    expect(result.contextRefs?.[0]).toMatchObject({ phase: "failed", result: { found: false, reason: "no_text" }, error: { found: true, code: "executor_exit", runIndex: 1 } });
  });
});
