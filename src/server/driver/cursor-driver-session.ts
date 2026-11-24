import {
  AgentDriverKernelCore,
  CursorDriverBackend,
  CursorStartError,
  createDriverId,
} from "@mosoo/agent-driver";
import type {
  AgentDriverRuntimeEvent,
  CursorModelParam,
  CursorSdkAgentLoader,
  CursorSteerFinal,
  RunId as DriverRunId,
} from "@mosoo/agent-driver";
import { RUNTIME_COMMAND_MAX_UTF8_BYTES, measureRuntimeCommandJson } from "@mosoo/agent-driver/runtime-command";
import { clip, errorMessage, isoNow } from "@shared/format";
import type { DeliveryRecord, MessageId, NativeRef, RunId } from "@shared/types";
import { HarnessStartError, asRecord, stampRun, str } from "../executors/common";
import type { ExecutorDraft, ExecutorSession, OpenInput, StartRunInput, SteerInput, SteerOutcome } from "../executors/types";
import { RunEventMapper, errorInfoFromPayload } from "./event-mapper";
import { ensureRuntimeCompat } from "./runtime-compat";
import { buildCursorStartInput } from "./start-input";

/** 内核要换代时，最多等上一代收尾这么久（内核自己的关闭上限是 5 s）。 */
const RECYCLE_WAIT_MS = 6_000;
/** 命令失败后，先让事件泵把真正的结局（run.failed）送到，再决定要不要用命令自己的错误。 */
const OUTCOME_GRACE_MS = 25;
const CLOSE_WAIT_MS = 5_000;

export interface CursorDriverSessionConfig {
  readonly agentName: string;
  readonly apiKey: string | undefined;
  /** 测试用：取消之后等流收尾的宽限；不传用后端默认值。 */
  readonly cancelSettleMs?: number | undefined;
  readonly effort: string | undefined;
  /** 失败信息里附带的“该账号可用的模型”提示（模型不存在时给用户看）。 */
  readonly modelHint: string | undefined;
  readonly modelId: string;
  readonly modelLabel: string;
  readonly modelParams: readonly CursorModelParam[] | undefined;
  readonly readOnly: boolean;
  readonly settingSources: readonly string[];
  readonly steerAckMs: number;
  readonly loadSdk: CursorSdkAgentLoader;
}

/** 一代内核：内核 + Cursor 后端 + 事件泵。运行失败会让内核退出，下一次运行换新一代并用 Agent id 重新接入。 */
interface Generation {
  backend: CursorDriverBackend | undefined;
  readonly done: PromiseWithResolvers<void>;
  ended: boolean;
  readonly kernel: AgentDriverKernelCore;
  /** 内核注定要退出，或者后端已经不可信：不再接受新的运行。 */
  retired: boolean;
}

interface ActiveRun {
  readonly driverRunId: DriverRunId;
  generation: Generation | undefined;
  readonly id: RunId;
  readonly mapper: RunEventMapper;
  readonly messageId: MessageId;
  readonly started: PromiseWithResolvers<void>;
  startedSeen: boolean;
  terminal: boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/**
 * 通过 Driver Kernel 驱动一个完整的 Cursor Agent 会话。
 *
 * Ensemble 在进程内持有一个 Driver 内核（mosoo agent-driver 的本地副本），Cursor SDK 作为其中一个后端：
 * 内核负责命令与终态纪律、事件队列与实例生命周期；这里负责把 Ensemble 的“运行”映射成 Driver 的命令，
 * 把 Driver 的统一事件翻译成 Ensemble 事件，并在运行失败后换新内核重新接上同一个 Cursor Agent。
 *
 * 被委派的 Agent 是 Full Access：没有需要人批准的权限请求，所以这里不接权限通道。
 */
export class CursorDriverSession implements ExecutorSession {
  readonly #config: CursorDriverSessionConfig;
  readonly #input: OpenInput;
  #active: ActiveRun | undefined;
  #closePromise: Promise<void> | undefined;
  #closing = false;
  #generation: Generation | undefined;
  #nativeRef: NativeRef | undefined;

  constructor(input: OpenInput, config: CursorDriverSessionConfig) {
    ensureRuntimeCompat();
    this.#input = input;
    this.#config = config;
    this.#nativeRef = input.resume;
  }

  get nativeRef(): NativeRef | undefined {
    return this.#nativeRef;
  }

  // ── 启动 ──

  async start(): Promise<void> {
    const { signal } = this.#input;
    signal.throwIfAborted();
    signal.addEventListener("abort", () => {
      void this.close().catch((error: unknown) => this.#input.log.warn("closing Cursor on abort failed", { error: errorMessage(error) }));
    }, { once: true });
    this.#generation = await this.#boot(this.#nativeRef?.id);
    if (signal.aborted) {
      // Abort can arrive after boot's final check but before this continuation.
      await this.#stopGeneration(this.#generation);
      this.#generation = undefined;
      signal.throwIfAborted();
    }
    this.#emit({
      kind: "session.updated",
      data: {
        patch: {
          model: { resolved: this.#config.modelId, label: this.#config.modelLabel },
          ...(this.#config.effort ? { effort: this.#config.effort } : {}),
        },
      },
    });
  }

  async #boot(resumeAgentId: string | undefined): Promise<Generation> {
    const kernel = new AgentDriverKernelCore({
      backendFactory: (payload) => {
        const backend = new CursorDriverBackend(payload, {
          loadSdk: this.#config.loadSdk,
          steerAckMs: this.#config.steerAckMs,
          ...(this.#config.cancelSettleMs !== undefined ? { cancelSettleMs: this.#config.cancelSettleMs } : {}),
        });
        generation.backend = backend;
        return backend;
      },
    });
    const generation: Generation = { backend: undefined, done: Promise.withResolvers<void>(), ended: false, kernel, retired: false };
    void this.#pump(generation);

    try {
      await generation.kernel.start(
        buildCursorStartInput({
          agentName: resumeAgentId ? undefined : this.#config.agentName,
          apiKey: this.#config.apiKey,
          cwd: this.#input.meta.cwd,
          modelHint: this.#config.modelHint,
          modelId: this.#config.modelId,
          modelParams: this.#config.modelParams,
          readOnly: this.#config.readOnly,
          resumeAgentId,
          settingSources: this.#config.settingSources,
        }),
      );
    } catch (error) {
      generation.retired = true;
      await this.#stopGeneration(generation);
      throw toStartError(error);
    }

    if (this.#closing) {
      await this.#stopGeneration(generation);
      throw new Error("The Cursor session is closed.");
    }
    const agentId = generation.backend?.agentId;
    if (agentId) this.#nativeRef = { kind: "cursor-agent", id: agentId };
    return generation;
  }

  async #stopGeneration(generation: Generation): Promise<void> {
    generation.retired = true;
    try {
      await generation.kernel.stop("session.closed");
    } catch {
      // 内核已经因为失败退出时，stop 会把当初的原因重新抛出；这里只需要它彻底收尾。
    }
    await Promise.race([generation.done.promise, delay(CLOSE_WAIT_MS)]);
  }

  /** 上一代内核已经（或注定要）退出时，等它彻底收尾，再用同一个 Cursor Agent 重新接入。 */
  async #ensureGeneration(): Promise<Generation> {
    const current = this.#generation;
    if (current && !current.retired && !current.ended) return current;
    if (current) await Promise.race([current.done.promise, delay(RECYCLE_WAIT_MS)]);
    const next = await this.#boot(this.#nativeRef?.id);
    this.#generation = next;
    return next;
  }

  // ── 事件泵 ──

  async #pump(generation: Generation): Promise<void> {
    try {
      for await (const event of generation.kernel.events()) {
        try {
          await this.#onEvent(generation, event);
        } catch (error) {
          this.#input.log.error("cursor driver event handling failed", { kind: event.kind, error: errorMessage(error) });
        }
      }
    } catch (error) {
      this.#input.log.warn("cursor driver event stream failed", { error: errorMessage(error) });
    } finally {
      generation.ended = true;
      generation.done.resolve();
      this.#onGenerationEnded(generation);
    }
  }

  async #onEvent(generation: Generation, event: AgentDriverRuntimeEvent): Promise<void> {
    const payload = asRecord(event.payload);
    if (event.kind === "runtime.resume.updated") {
      const pointer = str(payload?.["resumePointer"]);
      if (pointer) this.#nativeRef = { kind: "cursor-agent", id: pointer };
      return;
    }

    const run = this.#active;
    if (!run || run.generation !== generation) return;
    if (event.runId !== undefined && event.runId !== null && event.runId !== run.driverRunId) return;

    switch (event.kind) {
      case "run.started":
        await this.#onRunStarted(run, str(payload?.["nativeTurnId"]));
        return;
      case "run.completed":
        this.#endRun(run);
        this.#emit({ kind: "run.completed", data: {} }, run.id);
        return;
      case "run.cancelled":
        // 放弃过取消后的原生运行：后端已经不可信，要在通知管理器之前就把这一代标记为退役。
        if (generation.backend && !generation.backend.usable) generation.retired = true;
        this.#endRun(run);
        this.#emit({ kind: "run.cancelled", data: {} }, run.id);
        return;
      case "run.failed": {
        // 运行失败会让内核退出。管理器收到终态后可能立刻开始下一次运行，所以先退役、先清掉当前运行。
        generation.retired = true;
        const error = errorInfoFromPayload(payload?.["error"]);
        const startedBefore = run.startedSeen;
        this.#endRun(run);
        if (!startedBefore) {
          // SDK 没有接受这次运行：它不是一次“失败的运行”，而是启动失败，由 startRun 抛给管理器。
          run.started.reject(new HarnessStartError(error.code, error.message, error.detail));
          return;
        }
        this.#emit({ kind: "run.failed", data: { error } }, run.id);
        return;
      }
      default:
        for (const draft of run.mapper.map(event)) this.#emit(draft, run.id);
    }
  }

  async #onRunStarted(run: ActiveRun, nativeTurnId: string | undefined): Promise<void> {
    run.startedSeen = true;
    run.started.resolve();
    // 管理器在 startRun 返回之后的微任务里记录“已交给执行端”；宏任务一定排在它之后，
    // 这样 run.started（会把消息推进到“已生效”）不会先于“已交给”。
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (this.#closing || run.terminal) return;
    this.#emit({ kind: "run.started", data: { ...(nativeTurnId ? { nativeTurnId } : {}) } }, run.id);
  }

  /** 内核在没有给出终态的情况下退出：如实报告，不让运行悬在“运行中”。 */
  #onGenerationEnded(generation: Generation): void {
    const run = this.#active;
    if (!run || run.generation !== generation || run.terminal) return;
    const message = "The Cursor driver stopped before the run reported an outcome.";
    this.#endRun(run);
    if (!run.startedSeen) {
      run.started.reject(new HarnessStartError("harness_unavailable", message));
      return;
    }
    this.#emit({ kind: "run.failed", data: { error: { code: "driver_stopped", message } } }, run.id);
  }

  #endRun(run: ActiveRun): void {
    run.terminal = true;
    if (this.#active === run) this.#active = undefined;
  }

  // ── ExecutorSession ──

  async startRun(input: StartRunInput): Promise<void> {
    if (this.#closing) throw new Error("The Cursor session is closed.");
    if (this.#active) throw new Error("A run is already active in this Cursor session.");

    const driverRunId = createDriverId() as DriverRunId;
    const command = {
      commandId: createDriverId(),
      input: { text: input.prompt },
      kind: "input.start",
      requestId: createDriverId(),
      runId: driverRunId,
    } as const;
    if (measureRuntimeCommandJson(command) > RUNTIME_COMMAND_MAX_UTF8_BYTES) {
      throw new HarnessStartError(
        "invalid_request",
        `The message is too large for the Cursor driver (limit ${Math.floor(RUNTIME_COMMAND_MAX_UTF8_BYTES / 1024)} KB).`,
      );
    }

    const run: ActiveRun = {
      driverRunId,
      generation: undefined,
      id: input.runId,
      mapper: new RunEventMapper(input.runId),
      messageId: input.messageId,
      started: Promise.withResolvers<void>(),
      startedSeen: false,
      terminal: false,
    };
    run.started.promise.catch(() => undefined);
    // 先占住“当前运行”：换代内核的等待期间，管理器不会、也不应该再提交第二次运行。
    this.#active = run;

    let generation: Generation;
    try {
      generation = await this.#ensureGeneration();
      if (this.#closing) throw new Error("The Cursor session is closed.");
    } catch (error) {
      this.#endRun(run);
      throw error;
    }
    run.generation = generation;

    generation.kernel.dispatch(command).then(
      () => undefined,
      (error: unknown) => this.#onDispatchFailed(run, error),
    );
    await run.started.promise;
  }

  #onDispatchFailed(run: ActiveRun, error: unknown): void {
    // 先让事件泵有机会把真正的结局（run.failed 里的错误码与原因）送到。
    void delay(OUTCOME_GRACE_MS).then(() => {
      if (run.terminal || run.startedSeen) return;
      this.#endRun(run);
      run.started.reject(new HarnessStartError("harness_unavailable", clip(errorMessage(error), 400)));
    });
  }

  async steer(input: SteerInput): Promise<SteerOutcome> {
    const run = this.#active;
    const backend = run?.generation?.backend;
    if (!run || !backend || run.id !== input.runId || run.terminal) {
      return { kind: "needs_follow_up", reason: "run_in_progress", evidence: "cursor: no active run to steer" };
    }

    const result = await backend.steer({ key: input.messageId, runId: run.driverRunId, text: input.text });
    switch (result.kind) {
      case "delivered":
        return { kind: "delivered", evidence: result.evidence };
      case "unavailable":
        return { kind: "needs_follow_up", reason: "run_in_progress", evidence: result.evidence };
      case "handed_off":
        // SDK 已收到、尚未追加到回合：结论稍后异步补报。
        void result.final.then((final) => this.#onSteerFinal(run, input.messageId, final));
        return { kind: "handed_off", evidence: result.evidence };
    }
  }

  #onSteerFinal(run: ActiveRun, messageId: MessageId, final: CursorSteerFinal): void {
    const at = isoNow();
    const record: DeliveryRecord =
      final.stage === "failed"
        ? { stage: "failed", at, error: { code: final.code, message: final.message } }
        : { stage: final.stage, at, evidence: final.evidence };
    this.#emit({ kind: "message.delivery", data: { messageId, record } }, run.id);
  }

  async cancel(runId: RunId): Promise<void> {
    const run = this.#active;
    const generation = run?.generation;
    if (!run || !generation || run.id !== runId || run.terminal) return;
    try {
      await generation.kernel.dispatch({
        commandId: createDriverId(),
        kind: "turn.cancel",
        reason: "cancelled by Ensemble",
        runId: run.driverRunId,
      });
    } catch (error) {
      // 取消恰好与运行收尾相撞（运行已经有了结局）不算失败。
      await delay(OUTCOME_GRACE_MS);
      if (run.terminal) return;
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = (async () => {
      const run = this.#active;
      if (run) {
        this.#endRun(run);
        run.started.reject(new Error("The Cursor session is closed."));
      }
      const generation = this.#generation;
      this.#generation = undefined;
      if (generation) await this.#stopGeneration(generation);
    })();
    return this.#closePromise;
  }

  // ── 事件 ──

  #emit(draft: ExecutorDraft, runId?: RunId): void {
    if (this.#closing) return;
    this.#input.emit(stampRun(draft, runId ?? this.#active?.id));
  }
}

/** 启动阶段的失败转换成可行动的错误：保留 Cursor 给出的错误码与原因。 */
function toStartError(error: unknown): HarnessStartError {
  if (error instanceof HarnessStartError) return error;
  if (error instanceof CursorStartError) return new HarnessStartError(error.code, error.message, error.detail);
  return new HarnessStartError("harness_unavailable", `The Cursor driver could not start: ${clip(errorMessage(error), 300)}`);
}
