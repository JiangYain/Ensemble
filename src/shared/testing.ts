/** 仅供测试使用的构造辅助，不会被打进运行时产物。 */

import { newDelivery } from "./delivery";
import type { EnsembleEvent, EventPayload, EventSource } from "./events";
import type { QuestionPrompt, QuestionResolution } from "./questions";
import type {
  Actor,
  Capabilities,
  Message,
  MessageKind,
  Origin,
  Run,
  SessionMeta,
} from "./types";

export const TEST_CAPABILITIES: Capabilities = {
  steer: { support: "yes", mode: "immediate", verification: "live" },
  followUp: { support: "yes", mode: "queued_by_harness", verification: "live" },
  cancel: { support: "yes", verification: "live" },
  resume: { support: "no" },
  reasoning: { support: "yes" },
  plan: { support: "no" },
  usage: { support: "yes" },
  fileEvents: { support: "partial" },
};

export function testOrigin(overrides: Partial<Origin> = {}): Origin {
  return {
    key: "codex:thr_test",
    kind: "agent",
    host: "codex",
    hostLabel: "Codex",
    sessionRef: { id: "thr_test", kind: "thread", source: "mcp-meta" },
    evidence: ["mcp.clientInfo"],
    ...overrides,
  };
}

export function testMeta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: "ses_test",
    title: "Refactor the parser",
    harness: "pi",
    runtime: "native",
    model: { requested: "test-model" },
    access: "full",
    cwd: "C:\\work\\demo",
    origin: testOrigin(),
    depth: 0,
    task: { text: "Refactor the parser module", context: [], prompt: "Refactor the parser module" },
    createdAt: "2026-01-01T00:00:00.000Z",
    capabilities: TEST_CAPABILITIES,
    ...overrides,
  };
}

export const USER: Actor = { kind: "user", label: "You" };
export const AGENT: Actor = { kind: "agent", label: "Codex", originKey: "codex:thr_test" };

/** 按顺序累积事件的小型时钟与序号发生器。 */
export class EventLog {
  readonly events: EnsembleEvent[] = [];
  private seq = 0;
  private clock: number;
  private counter = 0;

  constructor(
    readonly sessionId = "ses_test",
    start = Date.parse("2026-01-01T00:00:00.000Z"),
  ) {
    this.clock = start;
  }

  now(): string {
    return new Date(this.clock).toISOString();
  }

  tick(ms = 1000): this {
    this.clock += ms;
    return this;
  }

  push(payload: EventPayload, options: { runId?: string; source?: EventSource; advance?: number } = {}): EnsembleEvent {
    this.clock += options.advance ?? 100;
    this.counter += 1;
    const event = {
      id: `evt_${String(this.counter).padStart(6, "0")}`,
      sessionId: this.sessionId,
      seq: ++this.seq,
      at: this.now(),
      source: options.source ?? "executor",
      ...(options.runId ? { runId: options.runId } : {}),
      ...payload,
    } as EnsembleEvent;
    this.events.push(event);
    return event;
  }

  created(meta: Partial<SessionMeta> = {}): EnsembleEvent {
    return this.push({ kind: "session.created", data: { meta: testMeta({ id: this.sessionId, ...meta }) } }, { source: "ensemble" });
  }

  message(id: string, kind: MessageKind, text: string, author: Actor = AGENT, runId?: string): Message {
    const message: Message = {
      id,
      sessionId: this.sessionId,
      kind,
      author,
      text,
      createdAt: this.now(),
      ...(runId ? { runId } : {}),
      delivery: newDelivery(this.now()),
      sync: { toOrigin: author.kind === "user" && kind !== "task" ? "pending" : "not_needed" },
    };
    this.push({ kind: "message.sent", data: { message } }, { source: author.kind === "user" ? "user" : "origin" });
    return message;
  }

  run(id: string, index: number, messageId: string, trigger: Run["trigger"] = "task"): Run {
    const run: Run = {
      id,
      sessionId: this.sessionId,
      index,
      trigger,
      messageId,
      status: "queued",
      queuedAt: this.now(),
      steerCount: 0,
    };
    this.push({ kind: "run.queued", data: { run } }, { source: "ensemble" });
    return run;
  }

  startRun(runId: string): EnsembleEvent {
    return this.push({ kind: "run.started", data: {} }, { runId });
  }

  tool(
    runId: string,
    callId: string,
    status: "running" | "completed" | "failed",
    extra: Partial<Extract<EventPayload, { kind: "tool.updated" }>["data"]> = {},
  ): EnsembleEvent {
    return this.push({ kind: "tool.updated", data: { callId, status, name: "shell", category: "shell", title: callId, ...extra } }, { runId });
  }

  /** 执行端提了一个问题（`question.asked`）。 */
  ask(questionId: string, prompts: QuestionPrompt[], runId?: string): EnsembleEvent {
    return this.push({ kind: "question.asked", data: { question: { id: questionId, prompts } } }, runId ? { runId } : {});
  }

  /** 提问有了结局（`question.resolved`：回答 / 不回答 / 过期）；署名决定事件来源。 */
  settle(resolution: QuestionResolution, runId?: string): EnsembleEvent {
    const source = resolution.by.kind === "user" ? "user" : resolution.by.kind === "agent" ? "origin" : "ensemble";
    return this.push({ kind: "question.resolved", data: resolution }, { source, ...(runId ? { runId } : {}) });
  }
}
