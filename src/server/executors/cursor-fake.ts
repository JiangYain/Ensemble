import type { CursorSdkAgent, CursorSdkRun } from "@mosoo/agent-driver";
import { CURSOR_SDK_VERSION } from "@shared/constants";
import type { Json } from "./common";
import type { CursorSdk } from "./cursor-sdk-loader";

/**
 * 测试用的假 Cursor SDK 与消息构造器：形状取自 @cursor/sdk 1.3.1 的类型定义与打包源码。
 * 供 executors/cursor.test.ts 与 driver/*.test.ts 共用；只被测试引用，不会进入产物。
 */

// ───────────────────────── 假 SDK ─────────────────────────

/** 与 SDK 一致的错误：类型名是 error.name，附带 status / isRetryable 等字段。 */
export function typedError(name: string, message: string, extra: Json = {}): Error {
  const error = Object.assign(new Error(message), extra);
  error.name = name;
  return error;
}

export class FakeRun implements CursorSdkRun {
  readonly steerCalls: string[] = [];
  cancelCalls = 0;
  steer?: (text: string) => Promise<string>;
  private queue: unknown[] = [];
  private ended = false;
  private result: unknown;
  private crashed: Error | undefined;
  private waiters: Array<() => void> = [];

  constructor(
    readonly id: string,
    private readonly owner: FakeSdk,
  ) {
    if (owner.supportsSteer) {
      this.steer = (text) => {
        this.steerCalls.push(text);
        return owner.steerImpl(text, this);
      };
    }
  }

  push(...messages: unknown[]): void {
    this.queue.push(...messages);
    this.wake();
  }

  finish(result: unknown): void {
    if (this.ended) return;
    this.result = result;
    this.ended = true;
    this.wake();
  }

  /** 流与 wait() 都以同一个错误失败。 */
  crash(error: Error): void {
    this.crashed = error;
    this.ended = true;
    this.wake();
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  async *stream(): AsyncGenerator<unknown> {
    for (;;) {
      while (this.queue.length > 0) yield this.queue.shift();
      if (this.crashed) throw this.crashed;
      if (this.ended) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  async wait(): Promise<unknown> {
    while (!this.ended) await new Promise<void>((resolve) => this.waiters.push(resolve));
    if (this.crashed) throw this.crashed;
    return this.result;
  }

  async cancel(): Promise<void> {
    this.cancelCalls += 1;
    if (this.owner.cancelError) throw this.owner.cancelError;
    // 与真实 SDK 一致：cancel() 之后 wait() 以 cancelled 结算。
    this.finish({ status: "cancelled" });
  }
}

export class FakeAgent implements CursorSdkAgent {
  closed = false;

  constructor(
    readonly agentId: string,
    private readonly owner: FakeSdk,
  ) {}

  async send(message: string, options?: Json): Promise<CursorSdkRun> {
    if (this.owner.sendError) throw this.owner.sendError;
    const run = new FakeRun(`run-${this.owner.runs.length + 1}`, this.owner);
    this.owner.runs.push(run);
    this.owner.sends.push({ prompt: message, options });
    return run;
  }

  close(): void {
    this.closed = true;
  }
}

export const MODELS = [
  { id: "auto", displayName: "Auto" },
  {
    id: "composer-fake",
    displayName: "Composer Fake",
    parameters: [{ id: "reasoning", displayName: "Reasoning", values: [{ value: "low" }, { value: "medium" }, { value: "high" }] }],
    variants: [
      { params: [{ id: "reasoning", value: "medium" }], displayName: "Medium", isDefault: true },
      { params: [{ id: "reasoning", value: "high" }], displayName: "High" },
    ],
  },
  { id: "plain-fake", displayName: "Plain Fake", aliases: ["plain"] },
];

export class FakeSdk {
  readonly runs: FakeRun[] = [];
  readonly sends: Array<{ prompt: string; options: Json | undefined }> = [];
  readonly created: Json[] = [];
  readonly resumed: Array<{ id: string; options: Json | undefined }> = [];
  readonly agents: FakeAgent[] = [];
  readonly modelsCalls: Array<Json | undefined> = [];
  authCalls = 0;

  models: unknown = MODELS;
  modelsError: Error | undefined;
  authStatus: unknown = { status: "logged-in", email: "dev@example.com" };
  authError: Error | undefined;
  me: unknown = { apiKeyName: "test key", userEmail: "dev@example.com" };
  createError: Error | undefined;
  resumeError: Error | undefined;
  sendError: Error | undefined;
  cancelError: Error | undefined;
  supportsSteer = true;
  steerImpl: (text: string, run: FakeRun) => Promise<string> = async () => "complete_delivered";

  readonly sdk: CursorSdk = {
    Agent: {
      create: async (options) => {
        if (this.createError) throw this.createError;
        this.created.push(options);
        return this.newAgent("agent-1");
      },
      resume: async (id, options) => {
        if (this.resumeError) throw this.resumeError;
        this.resumed.push({ id, options });
        return this.newAgent(id);
      },
    },
    Cursor: {
      models: {
        list: async (options) => {
          this.modelsCalls.push(options);
          if (this.modelsError) throw this.modelsError;
          return this.models;
        },
      },
      me: async () => this.me,
      auth: {
        status: async () => {
          this.authCalls += 1;
          if (this.authError) throw this.authError;
          return this.authStatus;
        },
      },
    },
  };

  readonly loader = async () => ({ sdk: this.sdk, version: CURSOR_SDK_VERSION });

  private newAgent(id: string): FakeAgent {
    const agent = new FakeAgent(id, this);
    this.agents.push(agent);
    return agent;
  }
}

// ───────────────────────── 消息构造（形状取自 SDK 源码） ─────────────────────────

export const assistantText = (text: string) => ({
  type: "assistant",
  agent_id: "agent-1",
  run_id: "run-1",
  message: { role: "assistant", content: [{ type: "text", text }] },
});
export const thinking = (text: string, durationMs?: number) => ({
  type: "thinking",
  text,
  ...(durationMs !== undefined ? { thinking_duration_ms: durationMs } : {}),
});
export const toolCall = (callId: string, name: string, status: "running" | "completed" | "error", args?: unknown, result?: unknown) => ({
  type: "tool_call",
  call_id: callId,
  name,
  status,
  ...(args !== undefined ? { args } : {}),
  ...(result !== undefined ? { result } : {}),
});
export const success = (value: unknown) => ({ status: "success", value });
export const failure = (message: string, extra: Json = {}) => ({ status: "error", error: { message, ...extra } });
export const usageMessage = (input: number, output: number, cacheRead = 0) => ({
  type: "usage",
  usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: 0, totalTokens: input + output },
});
export const userEcho = (text: string) => ({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
export const finished = (result: string, extra: Json = {}) => ({ status: "finished", result, ...extra });
