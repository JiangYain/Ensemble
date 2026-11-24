import { errorMessage } from "@shared/format";
import type { HarnessId, HarnessInfo, ModelInfo, NativeRef, RunId } from "@shared/types";
import type {
  Executor,
  ExecutorDraft,
  ExecutorSession,
  OpenInput,
  StartRunInput,
  SteerInput,
  SteerOutcome,
} from "./types";

/**
 * 模拟执行端：仅用于开发与自动化测试，界面会标注“模拟执行”，绝不冒充真实 Harness。
 * 它走和真实适配器完全相同的接口与事件词汇，因此能验证调度、投递状态、纠偏、取消与界面。
 *
 * 提示词中的标记可以选择场景：
 *   [fixture:fail]        运行到一半失败
 *   [fixture:long]        持续运行直到被取消
 *   [fixture:hold]        运行开始后停下，等收到纠偏再继续（确定性，便于测试）
 *   [fixture:quick]       只有一步，立刻完成
 *   [fixture:steps=N]     执行 N 个工具步骤
 */

export interface FixtureOptions {
  /** 时间倍率：1 为正常节奏，0 为无等待（测试）。 */
  speed?: number;
  displayName?: string;
}

const MODELS: ModelInfo[] = [
  { id: "fixture-fast", label: "Fixture Fast", provider: "fixture", isDefault: true },
  { id: "fixture-deep", label: "Fixture Deep", provider: "fixture", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
];

const ACCESS = { level: "none" as const, mechanism: "fixture (simulated, not enforced)" };

export class FixtureExecutor implements Executor {
  readonly runtime = "fixture" as const;
  readonly canResume = false;

  constructor(
    readonly id: HarnessId,
    private readonly options: FixtureOptions = {},
  ) {}

  async probe(): Promise<HarnessInfo> {
    return {
      id: this.id,
      displayName: this.options.displayName ?? `${this.id} (fixture)`,
      runtime: "fixture",
      status: "ready",
      version: "fixture",
      models: MODELS,
      defaultModel: "fixture-fast",
      capabilities: {
        steer: { support: "yes", mode: "turn_boundary", verification: "none" },
        followUp: { support: "yes", mode: "after_run", verification: "none" },
        cancel: { support: "yes", verification: "none" },
        resume: { support: "no" },
        reasoning: { support: "yes", verification: "none" },
        plan: { support: "yes", verification: "none" },
        usage: { support: "yes", verification: "none" },
        fileEvents: { support: "yes", verification: "none" },
      },
      access: { read_only: ACCESS, full: ACCESS },
      checkedAt: new Date().toISOString(),
    };
  }

  async open(input: OpenInput): Promise<ExecutorSession> {
    return new FixtureSession(input, this.options.speed ?? 1);
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

class Cancelled extends Error {}

interface ActiveRun {
  runId: RunId;
  cancelled: boolean;
  steers: SteerInput[];
  wake: Deferred<void>;
}

class FixtureSession implements ExecutorSession {
  readonly nativeRef: NativeRef | undefined = undefined;
  private active: ActiveRun | undefined;
  private closed = false;
  private tick = 0;

  constructor(
    private readonly input: OpenInput,
    private readonly speed: number,
  ) {
    input.signal.addEventListener("abort", () => {
      this.closed = true;
      this.active?.wake.resolve();
    });
    // 解析出的模型写回会话，和真实适配器行为一致。
    const requested = input.meta.model?.requested ?? "fixture-fast";
    const model = MODELS.find((m) => m.id === requested) ?? MODELS[0]!;
    input.emit({
      kind: "session.updated",
      data: { patch: { model: { resolved: model.id, label: model.label, provider: "fixture" } } },
    });
  }

  async startRun(run: StartRunInput): Promise<void> {
    if (this.active) throw new Error("fixture: a run is already active in this session");
    const active: ActiveRun = {
      runId: run.runId,
      cancelled: false,
      steers: [],
      wake: deferred<void>(),
    };
    this.active = active;
    void this.play(run, active).finally(() => {
      if (this.active === active) this.active = undefined;
    });
  }

  async steer(input: SteerInput): Promise<SteerOutcome> {
    if (!this.active || this.active.runId !== input.runId) {
      return { kind: "needs_follow_up", reason: "run_in_progress", evidence: "fixture: no active run" };
    }
    this.active.steers.push(input);
    this.active.wake.resolve();
    return { kind: "queued_by_harness", evidence: "fixture: steering queue", reason: "turn_boundary" };
  }

  async cancel(runId: RunId): Promise<void> {
    const active = this.active;
    if (!active || active.runId !== runId) return;
    active.cancelled = true;
    active.wake.resolve();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.active?.wake.resolve();
  }

  // ───────────────────────── 剧本 ─────────────────────────

  private emit(draft: ExecutorDraft): void {
    if (!this.closed) this.input.emit(draft);
  }

  private async pause(ms: number, active: ActiveRun, minimumMs = 0): Promise<void> {
    if (active.cancelled || this.closed) throw new Cancelled();
    const scaled = Math.max(ms * this.speed, minimumMs);
    if (scaled <= 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    } else {
      const timer = deferred<void>();
      const handle = setTimeout(() => timer.resolve(), scaled);
      active.wake = timer;
      await timer.promise;
      clearTimeout(handle);
    }
    if (active.cancelled || this.closed) throw new Cancelled();
  }

  /** 停下来等待至少一条纠偏（或取消）。 */
  private async waitForSteer(active: ActiveRun): Promise<void> {
    while (active.steers.length === 0) {
      if (active.cancelled || this.closed) throw new Cancelled();
      const gate = deferred<void>();
      active.wake = gate;
      await gate.promise;
    }
  }

  /** 回合边界：消费排队的纠偏，并如实上报“已生效”。 */
  private async boundary(active: ActiveRun): Promise<void> {
    while (active.steers.length > 0) {
      const steer = active.steers.shift()!;
      this.emit({
        kind: "message.delivery",
        data: {
          messageId: steer.messageId,
          record: { stage: "applied", at: new Date().toISOString(), evidence: "fixture: steering message consumed at turn boundary" },
        },
        runId: active.runId,
      });
      await this.say(active, `收到纠正：「${steer.text}」。我会据此调整接下来的做法。`, "commentary");
    }
  }

  private async say(active: ActiveRun, text: string, phase: "commentary" | "final"): Promise<void> {
    const itemId = `a${++this.tick}`;
    const chunks = text.match(/.{1,6}/gsu) ?? [text];
    for (const chunk of chunks) {
      this.emit({ kind: "assistant.delta", data: { itemId, text: chunk, phase }, runId: active.runId });
      await this.pause(28, active);
    }
    this.emit({ kind: "assistant.completed", data: { itemId, text, phase }, runId: active.runId });
  }

  private async think(active: ActiveRun, text: string): Promise<void> {
    const itemId = `r${++this.tick}`;
    const started = Date.now();
    for (const chunk of text.match(/.{1,8}/gsu) ?? [text]) {
      this.emit({ kind: "reasoning.delta", data: { itemId, text: chunk }, runId: active.runId });
      await this.pause(22, active);
    }
    this.emit({ kind: "reasoning.completed", data: { itemId, durationMs: Date.now() - started }, runId: active.runId });
  }

  private async tool(
    active: ActiveRun,
    spec: {
      name: string;
      category: "read" | "write" | "edit" | "search" | "shell" | "web" | "mcp" | "task" | "plan" | "other";
      title: string;
      input?: string;
      output?: string;
      exitCode?: number;
      failed?: boolean;
      ms?: number;
      files?: { path: string; change: "created" | "modified" | "deleted"; addedLines?: number; removedLines?: number }[];
    },
  ): Promise<void> {
    const callId = `t${++this.tick}`;
    this.emit({
      kind: "tool.updated",
      data: {
        callId,
        name: spec.name,
        category: spec.category,
        title: spec.title,
        status: "running",
        ...(spec.input ? { input: { text: spec.input, truncated: false, format: "text" as const } } : {}),
      },
      runId: active.runId,
    });
    await this.pause(spec.ms ?? 700, active);
    this.emit({
      kind: "tool.updated",
      data: {
        callId,
        status: spec.failed ? "failed" : "completed",
        ...(spec.output ? { output: { text: spec.output, truncated: false, format: "text" as const } } : {}),
        ...(spec.exitCode !== undefined ? { exitCode: spec.exitCode } : {}),
        ...(spec.failed ? { error: spec.output ?? "failed" } : {}),
      },
      runId: active.runId,
    });
    if (spec.files) this.emit({ kind: "file.changed", data: { callId, files: spec.files }, runId: active.runId });
    await this.boundary(active);
  }

  private async play(run: StartRunInput, active: ActiveRun): Promise<void> {
    const prompt = run.prompt;
    const steps = Number(/\[fixture:steps=(\d+)\]/.exec(prompt)?.[1] ?? 0);
    try {
      await this.pause(260, active);
      this.emit({ kind: "run.started", data: {}, runId: active.runId });

      if (prompt.includes("[fixture:hold]")) {
        await this.say(active, "我先停在这里，等你的指示。", "commentary");
        await this.waitForSteer(active);
        await this.boundary(active);
        await this.tool(active, { name: "shell", category: "shell", title: "echo done", output: "done", exitCode: 0, ms: 200 });
        await this.say(active, "已按你的纠正完成。", "final");
        this.usage(active, 1);
        this.emit({ kind: "run.completed", data: { stopReason: "end_turn" }, runId: active.runId });
        return;
      }

      if (prompt.includes("[fixture:quick]")) {
        await this.say(active, "这是一个很小的任务，已经直接完成。", "final");
        this.usage(active, 1);
        this.emit({ kind: "run.completed", data: { stopReason: "end_turn" }, runId: active.runId });
        return;
      }

      if (steps > 0) {
        for (let i = 1; i <= steps; i++) {
          await this.tool(active, { name: "shell", category: "shell", title: `step ${i} of ${steps}`, output: `ok ${i}`, exitCode: 0, ms: 380 });
        }
        await this.say(active, `${steps} 个步骤已全部执行。`, "final");
        this.usage(active, steps);
        this.emit({ kind: "run.completed", data: { stopReason: "end_turn" }, runId: active.runId });
        return;
      }

      await this.think(active, "先看一下任务涉及的模块边界，再决定从哪里下手。");
      await this.say(active, "我先阅读相关代码，弄清楚现在的结构。", "commentary");
      await this.tool(active, { name: "read", category: "read", title: "src/parser/index.ts", input: "src/parser/index.ts", output: "export function parse(input: string) { … }", ms: 600 });
      await this.tool(active, { name: "grep", category: "search", title: "parse(", input: "parse(", output: "src/parser/index.ts:12\nsrc/cli.ts:48\nsrc/parser/index.test.ts:9", ms: 520 });

      this.emit({
        kind: "plan.updated",
        data: {
          entries: [
            { text: "阅读现有解析器", status: "completed" },
            { text: "拆分 tokenizer 与 AST", status: "in_progress" },
            { text: "更新调用方", status: "pending" },
            { text: "运行测试", status: "pending" },
          ],
        },
        runId: active.runId,
      });

      if (prompt.includes("[fixture:fail]")) {
        await this.tool(active, { name: "shell", category: "shell", title: "npm run build", output: "error TS2322: Type 'string' is not assignable to type 'number'.", exitCode: 2, failed: true, ms: 800 });
        this.emit({
          kind: "run.failed",
          data: { error: { code: "fixture_failure", message: "构建失败且无法自动修复（模拟的失败场景）。" } },
          runId: active.runId,
        });
        return;
      }

      if (prompt.includes("[fixture:long]")) {
        for (let i = 1; ; i++) {
          await this.tool(active, { name: "shell", category: "shell", title: `poll ${i}`, output: "waiting", exitCode: 0, ms: 900 });
          await this.pause(0, active, 5);
        }
      }

      await this.say(active, "现在开始拆分解析器，把词法与语法两层分开。", "commentary");
      await this.tool(active, {
        name: "edit",
        category: "edit",
        title: "src/parser/tokenizer.ts",
        input: "create src/parser/tokenizer.ts",
        output: "created",
        ms: 900,
        files: [
          { path: "src/parser/tokenizer.ts", change: "created", addedLines: 64 },
          { path: "src/parser/index.ts", change: "modified", addedLines: 12, removedLines: 41 },
        ],
      });
      await this.tool(active, { name: "shell", category: "shell", title: "npm test", input: "npm test", output: "FAIL src/parser/index.test.ts\n  ● parse › handles empty input", exitCode: 1, failed: true, ms: 1200 });
      await this.say(active, "有一个用例没过：空输入没有处理，我补上。", "commentary");
      await this.tool(active, {
        name: "edit",
        category: "edit",
        title: "src/parser/tokenizer.ts",
        input: "patch src/parser/tokenizer.ts",
        output: "patched",
        ms: 700,
        files: [{ path: "src/parser/tokenizer.ts", change: "modified", addedLines: 4, removedLines: 0 }],
      });
      await this.tool(active, { name: "shell", category: "shell", title: "npm test", input: "npm test", output: "PASS src/parser/index.test.ts\nTests: 18 passed", exitCode: 0, ms: 1100 });

      this.emit({
        kind: "plan.updated",
        data: {
          entries: [
            { text: "阅读现有解析器", status: "completed" },
            { text: "拆分 tokenizer 与 AST", status: "completed" },
            { text: "更新调用方", status: "completed" },
            { text: "运行测试", status: "completed" },
          ],
        },
        runId: active.runId,
      });
      await this.say(active, "解析器已拆成 tokenizer 和 AST 两层，18 个测试全部通过。改动集中在 src/parser/ 下。", "final");
      this.usage(active, 6);
      this.emit({ kind: "run.completed", data: { stopReason: "end_turn" }, runId: active.runId });
    } catch (error) {
      if (error instanceof Cancelled) {
        if (!this.closed) this.emit({ kind: "run.cancelled", data: {}, runId: active.runId });
        return;
      }
      this.emit({
        kind: "run.failed",
        data: { error: { code: "fixture_error", message: errorMessage(error) } },
        runId: active.runId,
      });
    }
  }

  private usage(active: ActiveRun, steps: number): void {
    this.emit({
      kind: "usage.updated",
      data: {
        usage: {
          inputTokens: 1800 * steps,
          outputTokens: 240 * steps,
          totalTokens: 2040 * steps,
          costUsd: 0.004 * steps,
          contextTokens: 3200 + 900 * steps,
          contextWindow: 200_000,
        },
      },
      runId: active.runId,
    });
  }
}
