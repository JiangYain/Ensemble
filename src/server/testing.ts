/** 仅供测试使用：搭建内存环境，以及可手动控制节奏的执行端。 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionState } from "@shared/projection";
import type { QuestionId, QuestionPrompt } from "@shared/questions";
import { TEST_CAPABILITIES, testOrigin } from "@shared/testing";
import type { HarnessId, HarnessInfo, NativeRef, RunId, TimelineItem } from "@shared/types";
import { ExecutorRegistry, type ModelPolicy } from "./executors/registry";
import type {
  Executor,
  ExecutorDraft,
  ExecutorSession,
  OpenInput,
  StartRunInput,
  SteerInput,
  SteerOutcome,
} from "./executors/types";
import { EventHub } from "./hub";
import { silentLogger } from "./logger";
import { DEFAULT_MANAGER_CONFIG, SessionManager, type ManagerConfig } from "./manager";
import { NoticeCenter } from "./notices";
import { MemoryEventStore, type EventStore } from "./store";

export interface TestEnv {
  hub: EventHub;
  manager: SessionManager;
  notices: NoticeCenter;
  registry: ExecutorRegistry;
  store: EventStore;
  cwd: string;
}

export function makeEnv(
  executors: Executor[],
  config: Partial<ManagerConfig> = {},
  store: EventStore = new MemoryEventStore(),
  policy?: ModelPolicy,
): TestEnv {
  const hub = new EventHub({ store, log: silentLogger, coalesceMs: 0 });
  const registry = new ExecutorRegistry(executors, silentLogger, policy ? { policy } : {});
  const notices = new NoticeCenter(hub);
  // 默认不判重：绝大多数测试要用同样的参数连发好几个会话来测并发、排队与关系；判重本身见 manager.dedupe.test.ts。
  const manager = new SessionManager({ hub, executors: registry, notices, log: silentLogger, config: { duplicateWindowMs: 0, ...config } });
  const cwd = mkdtempSync(join(tmpdir(), "ensemble-test-"));
  return { hub, manager, notices, registry, store, cwd };
}

export async function until(predicate: () => boolean, timeoutMs = 4000, label = "condition"): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const trackedEnvs: TestEnv[] = [];

/** 创建环境并登记；测试文件里写一次 `afterEach(shutdownTrackedEnvs)` 就能统一收尾（每个测试文件各有一份登记表）。 */
export function makeTrackedEnv(...args: Parameters<typeof makeEnv>): TestEnv {
  const env = makeEnv(...args);
  trackedEnvs.push(env);
  return env;
}

export async function shutdownTrackedEnvs(): Promise<void> {
  await Promise.all(trackedEnvs.splice(0).map((env) => env.manager.shutdown().catch(() => undefined)));
}

export function stateOf(env: TestEnv, sessionId: string): SessionState {
  const state = env.hub.state(sessionId);
  if (!state) throw new Error("missing session");
  return state;
}

/** 某一类时间线条目（工具、诊断、回答……），按出现顺序。 */
export function itemsOf<T extends TimelineItem["type"]>(
  env: TestEnv,
  sessionId: string,
  type: T,
): Array<Extract<TimelineItem, { type: T }>> {
  return stateOf(env, sessionId).timeline.filter((item): item is Extract<TimelineItem, { type: T }> => item.type === type);
}

/** 给某个执行端生成 `delegate(env, overrides)`：默认任务、工作目录与来源都已填好。 */
export function delegatorFor(harness: HarnessId, task = "Do the thing") {
  return (env: TestEnv, overrides: Partial<Parameters<SessionManager["delegate"]>[0]> = {}) =>
    env.manager.delegate({ harness, task, cwd: env.cwd, origin: testOrigin(), ...overrides });
}

export const READY_INFO = (id: HarnessId, patch: Partial<HarnessInfo> = {}): HarnessInfo => ({
  id,
  displayName: id,
  runtime: "native",
  status: "ready",
  models: [],
  capabilities: TEST_CAPABILITIES,
  access: {
    read_only: { level: "enforced", mechanism: "test" },
    full: { level: "enforced", mechanism: "test" },
  },
  checkedAt: new Date().toISOString(),
  ...patch,
});

/**
 * 提问回复的受理方式（见 ManualExecutor.questionReply）：
 * true = 执行端收下了回复；false = 执行端已不再等待这个提问；Error = 抛出（`ReplyRejected` 表示执行端拒绝了回复本身）；
 * 函数 = 回复到达时才由测试决定，可以挂起（用来测两个回复同时到达、回复途中状态变化）。
 */
export type QuestionReply = boolean | Error | (() => Promise<boolean>);

/** 执行端收到的一次对提问的回复。 */
export type ManualReply =
  | { kind: "answer"; questionId: QuestionId; answers: readonly (readonly string[])[] }
  | { kind: "decline"; questionId: QuestionId; note: string };

let askedCount = 0;

export class ManualSession implements ExecutorSession {
  readonly started: StartRunInput[] = [];
  readonly steers: SteerInput[] = [];
  readonly cancelled: RunId[] = [];
  /** 收到的回答 / 不回答，按到达顺序（只有 ManualExecutor.questionReply 有值时才会有）。 */
  readonly replies: ManualReply[] = [];
  closed = false;

  // 与真实适配器一致：不支持提问的执行端根本没有这两个方法（QuestionDesk 据此报 question_unsupported）。
  answerQuestion?: (questionId: QuestionId, answers: readonly (readonly string[])[]) => Promise<boolean>;
  declineQuestion?: (questionId: QuestionId, note: string) => Promise<boolean>;

  constructor(
    readonly input: OpenInput,
    private readonly owner: ManualExecutor,
    readonly nativeRef: NativeRef | undefined,
  ) {
    if (owner.questionReply !== undefined) {
      this.answerQuestion = (questionId, answers) => this.reply({ kind: "answer", questionId, answers });
      this.declineQuestion = (questionId, note) => this.reply({ kind: "decline", questionId, note });
    }
  }

  private async reply(record: ManualReply): Promise<boolean> {
    this.replies.push(record);
    const outcome = this.owner.questionReply;
    if (typeof outcome === "function") return outcome();
    if (outcome instanceof Error) throw outcome;
    return outcome ?? true;
  }

  /** 执行端提了一个问题（与适配器发出的事件同一形状）；返回提问编号。 */
  ask(runId: RunId, prompts: QuestionPrompt[] = [{ key: "q1", text: "Which package should I update?", multiple: false, custom: true }], id = `qst_test${++askedCount}`): QuestionId {
    this.emit({ kind: "question.asked", data: { question: { id, prompts } }, runId });
    return id;
  }

  async startRun(run: StartRunInput): Promise<void> {
    if (this.owner.startError) throw this.owner.startError;
    this.started.push(run);
    if (this.owner.autoStart) this.emit({ kind: "run.started", data: {}, runId: run.runId });
  }

  async steer(input: SteerInput): Promise<SteerOutcome> {
    this.steers.push(input);
    return this.owner.steerOutcome;
  }

  async cancel(runId: RunId): Promise<void> {
    this.cancelled.push(runId);
    if (this.owner.autoCancel) this.emit({ kind: "run.cancelled", data: {}, runId });
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  emit(draft: ExecutorDraft): void {
    this.input.emit(draft);
  }

  start(runId: RunId): void {
    this.emit({ kind: "run.started", data: {}, runId });
  }

  complete(runId: RunId): void {
    this.emit({ kind: "run.completed", data: { stopReason: "end_turn" }, runId });
  }

  fail(error: Error): void {
    this.input.fatal({ code: "process_exited", message: error.message });
  }
}

/** 由测试决定何时开始、何时结束的执行端。 */
export class ManualExecutor implements Executor {
  readonly runtime = "native" as const;
  canResume = false;
  openError: Error | undefined;
  startError: Error | undefined;
  autoStart = false;
  autoCancel = true;
  /** 设了值，这个执行端的会话才有 answerQuestion / declineQuestion（受理方式见 QuestionReply）；不设 = 不支持提问。 */
  questionReply: QuestionReply | undefined;
  steerOutcome: SteerOutcome = { kind: "needs_follow_up", reason: "run_in_progress" };
  readonly sessions: ManualSession[] = [];
  info: HarnessInfo;

  constructor(
    readonly id: HarnessId,
    info: Partial<HarnessInfo> = {},
  ) {
    this.info = READY_INFO(id, info);
  }

  async probe(): Promise<HarnessInfo> {
    return this.info;
  }

  async open(input: OpenInput): Promise<ExecutorSession> {
    if (this.openError) throw this.openError;
    const session = new ManualSession(input, this, input.resume ?? { kind: "pi-session", id: `native-${this.sessions.length + 1}` });
    this.sessions.push(session);
    return session;
  }
}

export { DEFAULT_MANAGER_CONFIG };
