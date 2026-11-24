// ENSEMBLE ADDED — 本文件由 Ensemble 新增（Cursor SDK 后端），不属于上游 mosoo-agent-driver。详见 VENDORING.md。
import type { AgentDriverBackend, AgentDriverContext } from "../../core/agent-driver-backend";
import { pushLosslessEvents } from "../../core/driver-runtime-io";
import {
  DriverTurnCancellationCleanupError,
  DriverTurnCancelledError,
} from "../../core/driver-turn-cancelled-error";
import type { DriverEventInput } from "../../protocol/events";
import type { RunId } from "../../protocol/id";
import type { DriverNativeRuntimeRef } from "../../protocol/runtime";
import type { DriverStartInput } from "../../protocol/start";
import type { RunError, RuntimeCommandInput } from "../../runtime-command";
import { raceWithAbort } from "../../utils/async";
import { buildAgentOptions, readCursorConfiguration } from "./cursor-configuration";
import type { CursorBackendConfiguration } from "./cursor-configuration";
import { CursorStartError, errorNameOf, sdkFailure, toRunError, toStartError } from "./cursor-errors";
import { CursorTurnTranslator } from "./cursor-event-translator";
import type { CursorSessionNotes } from "./cursor-event-translator";
import { loadCursorSdkPackage } from "./cursor-sdk";
import type { CursorSdkAgent, CursorSdkAgentLoader, CursorSdkRun } from "./cursor-sdk";
import { errorMessage, normalizeText } from "./cursor-values";

/** dispatcher 给 cancelActiveTurn 的宽限是 2s：这里最多等 SDK 的 cancel() 这么久，之后让它在后台继续。 */
const CANCEL_ACK_WAIT_MS = 1_500;
/** cancel() 返回（无论成败）之后，流应该很快收尾；等这么久还没结束就放弃这次运行，并让内核回收这个实例。 */
const CANCEL_SETTLE_GRACE_MS = 5_000;
const DEFAULT_STEER_ACK_MS = 2_000;

/** pump 的“放弃”出口：和真实的流结果区分开。 */
const ABANDONED: unique symbol = Symbol("abandoned");

export interface CursorBackendDependencies {
  /** 取消之后，等流收尾的宽限；超过就放弃这次运行。默认 5 s，测试可以缩短。 */
  readonly cancelSettleMs: number;
  /** 测试用：确定性的文件存在性判断（决定“新建”还是“修改”）。 */
  readonly fileExists?: (absolutePath: string) => boolean;
  readonly loadSdk: CursorSdkAgentLoader;
  readonly now: () => number;
  /** steer() 最多等这么久；超过就先回报“已交给执行端”，之后的结论异步补报。 */
  readonly steerAckMs: number;
}

/** 纠偏的最终结局：已交给执行端之后才会有。 */
export type CursorSteerFinal =
  | { evidence: string; stage: "applied" }
  | { evidence: string; stage: "cancelled" }
  | { code: string; message: string; stage: "failed" };

/**
 * Driver 协议没有“运行中纠偏”命令（run.steer 只是契约里的事件定义），所以纠偏是这个后端自己的扩展方法，
 * 由宿主直接调用；结果如实反映 SDK 的真实行为：
 * - delivered：SDK 明确确认回合已追加这条消息；
 * - handed_off：SDK 已接受、尚未追加到回合，`final` 稍后给出结局；
 * - unavailable：无法在运行中注入，调用方应把它作为普通跟进在运行结束后发送。
 */
export type CursorSteerResult =
  | { evidence: string; kind: "delivered" }
  | { evidence: string; final: Promise<CursorSteerFinal>; kind: "handed_off" }
  | { evidence: string; kind: "unavailable" };

interface SteerTrack {
  applied: boolean;
  echoEvidence?: string;
  final: PromiseWithResolvers<CursorSteerFinal> | undefined;
  reported: boolean;
  returned: boolean;
  text: string;
}

type SteerSettled = { kind: "ack"; value: string } | { error: unknown; kind: "error" } | { kind: "pending" };

interface ActiveTurn {
  /** 流与 wait() 都不再被消费：取消之后等不到收尾时的出口。 */
  readonly abandoned: PromiseWithResolvers<void>;
  /** 放弃这次运行的原因：原生运行可能还在跑，这个实例之后不能再信任。 */
  abandonCause: unknown;
  cancelReason: string | null;
  cancelRequestedPublished: boolean;
  cancelTask: Promise<void> | null;
  readonly done: PromiseWithResolvers<void>;
  finishing: boolean;
  run: CursorSdkRun | null;
  readonly runId: RunId;
  readonly steers: Map<string, SteerTrack>;
  terminal: "completed" | "other" | null;
  readonly translator: CursorTurnTranslator;
}

/** 运行以 run.failed 收场之后抛出：内核据此把实例判为失败，宿主换一个新内核用原生会话恢复继续。 */
class CursorRunFailedError extends Error {
  readonly code: string;

  constructor(error: RunError) {
    super(error.message);
    this.name = "CursorRunFailedError";
    this.code = error.code;
  }
}

function abortReason(signal: AbortSignal | undefined): string {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error && reason.message) return reason.message;
  return typeof reason === "string" && reason ? reason : "input.aborted";
}

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

/**
 * Cursor SDK（`@cursor/sdk` 本地 Agent）后端。
 *
 * 作为 Driver 的一个 backend 运行在内核里：内核负责命令与终态纪律、事件队列与实例生命周期，
 * 本类负责与 Cursor SDK 的对话——启动 / 恢复 Agent、发送输入、消费消息流并翻译成统一事件、取消、纠偏与关闭。
 *
 * 诚实声明：本机没有可用的 Cursor 凭据，没有在真实账号上跑通过。事件映射依据 SDK 1.3.1 的类型定义与打包源码，
 * 测试用的是按同样形状写的假 SDK；换成真实凭据后需要逐项验证。
 */
export class CursorDriverBackend implements AgentDriverBackend {
  readonly runtime = "cursor";

  readonly #dependencies: CursorBackendDependencies;
  readonly #lifetime = new AbortController();
  readonly #notes: CursorSessionNotes = { modelId: undefined, toolsNoted: false };
  readonly #payload: DriverStartInput;
  #agent: CursorSdkAgent | null = null;
  #configuration: CursorBackendConfiguration | undefined;
  #failure: Error | null = null;
  /** 恢复出来的会话：第一次发送要让崩溃前残留的运行过期。 */
  #forceNext = false;
  #stopTask: Promise<void> | null = null;
  #stopped = false;
  #turn: ActiveTurn | null = null;

  constructor(payload: DriverStartInput, dependencies: Partial<CursorBackendDependencies> = {}) {
    this.#payload = payload;
    this.#dependencies = {
      cancelSettleMs: CANCEL_SETTLE_GRACE_MS,
      loadSdk: loadCursorSdkPackage,
      now: Date.now,
      steerAckMs: DEFAULT_STEER_ACK_MS,
      ...dependencies,
    };
  }

  /** Cursor 的 Agent id：恢复会话用的原生引用。启动成功之前为 undefined。 */
  get agentId(): string | undefined {
    return this.#agent?.agentId;
  }

  get nativeRef(): DriverNativeRuntimeRef | undefined {
    const value = this.agentId;
    return value === undefined ? undefined : { kind: "cursor_agent_id", runtimeId: "cursor", value };
  }

  /**
   * 这个后端实例还能不能接受下一次运行。放弃过一次取消后的原生运行、或者已经停止，就不能再用：
   * 宿主应当换新内核，用 {@link agentId} 重新接入同一个 Cursor Agent。
   */
  get usable(): boolean {
    return !this.#stopped && this.#failure === null;
  }

  // ── 启动 ──

  async start(context: AgentDriverContext, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#stopped || this.#agent !== null) throw new Error("Cursor backend has already started or stopped.");
    const execution = this.#payload.execution;
    const configuration = readCursorConfiguration(execution);
    const resumeRef = execution.session.nativeResumeRef;
    if (resumeRef !== null && resumeRef.runtimeId !== "cursor") {
      throw new CursorStartError("invalid_request", `Cannot resume a ${resumeRef.runtimeId} session with the Cursor backend.`);
    }

    const sdk = await raceWithAbort(this.#dependencies.loadSdk(), signal);
    const options = buildAgentOptions(configuration, execution.session.cwd, resumeRef !== null);
    let agent: CursorSdkAgent;
    try {
      agent = await raceWithAbort(
        resumeRef ? sdk.Agent.resume(resumeRef.value, options) : sdk.Agent.create(options),
        signal,
      );
    } catch (error) {
      throw toStartError(error, { resumeId: resumeRef?.value, availableModels: configuration.modelHint });
    }
    if (this.#stopped || signal.aborted) {
      await Promise.resolve(agent.close()).catch(() => undefined);
      signal.throwIfAborted();
      throw new Error("Cursor stopped during startup.");
    }
    this.#configuration = configuration;
    this.#agent = agent;
    this.#forceNext = resumeRef !== null;
    this.#notes.modelId = configuration.modelId;
    await this.#push(context, [
      {
        kind: "runtime.resume.updated",
        runId: null,
        occurredAt: nowIso(this.#dependencies.now),
        payload: { resumePointer: agent.agentId, mode: "cursor" },
      },
    ]);
  }

  // ── 运行 ──

  async handleInput(
    context: AgentDriverContext,
    input: RuntimeCommandInput,
    runId: RunId,
    signal?: AbortSignal,
  ): Promise<void> {
    const agent = this.#agent;
    const configuration = this.#configuration;
    if (this.#stopped || this.#failure !== null || agent === null || configuration === undefined || this.#turn !== null) {
      throw new Error("Cursor is unavailable or already running.");
    }
    const turn: ActiveTurn = {
      abandoned: Promise.withResolvers<void>(),
      abandonCause: undefined,
      cancelReason: null,
      cancelRequestedPublished: false,
      cancelTask: null,
      done: Promise.withResolvers<void>(),
      finishing: false,
      run: null,
      runId,
      steers: new Map(),
      terminal: null,
      translator: new CursorTurnTranslator({
        cwd: this.#payload.execution.session.cwd,
        notes: this.#notes,
        now: this.#dependencies.now,
        readOnly: configuration.readOnly,
        runId,
        ...(this.#dependencies.fileExists ? { fileExists: this.#dependencies.fileExists } : {}),
      }),
    };
    this.#turn = turn;
    const abort = () => {
      void this.#requestCancel(context, turn, abortReason(signal)).catch(() => undefined);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      await this.#execute(context, turn, agent, configuration, input);
    } finally {
      signal?.removeEventListener("abort", abort);
      this.#settleSteers(turn, turn.cancelReason !== null ? "cancelled" : "failed");
      if (this.#turn === turn) this.#turn = null;
      turn.done.resolve();
    }
  }

  async #execute(
    context: AgentDriverContext,
    turn: ActiveTurn,
    agent: CursorSdkAgent,
    configuration: CursorBackendConfiguration,
    input: RuntimeCommandInput,
  ): Promise<void> {
    // ── 交给 SDK ──
    let run: CursorSdkRun;
    try {
      const force = this.#forceNext;
      run = await agent.send(input.text, force ? { local: { force: true } } : undefined);
      this.#forceNext = false;
    } catch (error) {
      // SDK 没有接受这次运行（认证、模型、网络……）：诚实地不发 run.started。
      if (turn.cancelReason !== null) throw await this.#publishCancelled(context, turn);
      const failure = sdkFailure(error, "Cursor could not start the run.");
      const hint =
        failure.code === "model_not_found" && configuration.modelHint
          ? ` Available models: ${configuration.modelHint}.`
          : "";
      throw await this.#publishFailed(context, turn, toRunError({ ...failure, message: `${failure.message}${hint}` }));
    }
    turn.run = run;
    // 交给 SDK 的途中收到了取消请求：现在才有 run 可取消。
    if (turn.cancelReason !== null) this.#startSdkCancel(turn);

    await this.#push(context, [
      {
        kind: "run.started",
        runId: turn.runId,
        occurredAt: nowIso(this.#dependencies.now),
        payload: { startedAt: nowIso(this.#dependencies.now), nativeTurnId: run.id },
      },
    ]);

    // ── 消费消息流 ──
    const settled = await this.#pump(context, turn, run);
    if (settled.deliveryFailure !== undefined) {
      // 事件已经送不出去了：不要让原生运行继续空转，由内核按失败回收。
      await this.#cancelQuietly(run);
      throw settled.deliveryFailure;
    }

    // ── 收束 ──
    turn.finishing = true;
    const outcome = turn.translator.finish({
      cancelRequested: turn.cancelReason !== null,
      failure: settled.failure,
      result: settled.result,
    });
    await this.#push(context, outcome.events);
    this.#settleSteers(turn, outcome.outcome === "cancelled" ? "cancelled" : "failed");

    if (outcome.outcome === "cancelled") {
      throw await this.#publishCancelled(context, turn, turn.abandonCause);
    }
    if (outcome.outcome === "failed") {
      throw await this.#publishFailed(
        context,
        turn,
        outcome.error ?? toRunError(sdkFailure(settled.failure, "Cursor reported an error.")),
      );
    }

    turn.terminal = "completed";
    try {
      await this.#push(context, [
        {
          kind: "run.completed",
          runId: turn.runId,
          occurredAt: nowIso(this.#dependencies.now),
          payload: {
            checkpoint: {
              formatVersion: 1,
              nativeRef: { kind: "cursor_agent_id", runtimeId: "cursor", value: agent.agentId },
              runId: turn.runId,
            },
            ...(outcome.finalMessageId ? { finalMessageId: outcome.finalMessageId } : {}),
            stopReason: "end_turn",
          },
        },
      ]);
    } catch (error) {
      // 取消恰好与完成相撞：内核以取消为准，run.completed 会被拒绝；这时改发 run.cancelled。
      // 内核抛出的取消错误会被 pushLosslessEvents 包成“送达结果未知”，要顺着 cause 链识别。
      if (!causedByCancellation(error) && turn.cancelReason === null) {
        turn.terminal = "other";
        throw error;
      }
      turn.terminal = null;
      throw await this.#publishCancelled(context, turn, undefined, error instanceof Error ? error.message : undefined);
    }
  }

  async #pump(
    context: AgentDriverContext,
    turn: ActiveTurn,
    run: CursorSdkRun,
  ): Promise<{ deliveryFailure?: unknown; failure?: unknown; result?: unknown }> {
    let failure: unknown;
    let iterator: AsyncIterator<unknown> | undefined;
    const abandoned: Promise<typeof ABANDONED> = turn.abandoned.promise.then(() => ABANDONED);
    try {
      iterator = run.stream()[Symbol.asyncIterator]();
      for (;;) {
        const step = await Promise.race([iterator.next(), abandoned]);
        if (step === ABANDONED || step.done) break;
        const out = turn.translator.translate(step.value);
        if (out.userEcho !== undefined) this.#onUserEcho(turn, out.userEcho);
        if (out.violation !== undefined) {
          // 只读会话里仍出现了变更类工具：白名单没有生效，尽力中止；终态由翻译器按 policy_blocked 判定。
          turn.translator.markCancelObserved();
          this.#startSdkCancel(turn);
        }
        if (out.events.length > 0) await this.#push(context, out.events);
      }
    } catch (error) {
      if (errorNameOf(error) === "UnsupportedRunOperationError") {
        try {
          await this.#push(context, [
            turn.translator.diagnostic(
              "warn",
              "cursor.no_stream",
              "Cursor does not stream this run, so live steps are unavailable; only the final result will be shown.",
            ),
          ]);
        } catch (deliveryFailure) {
          return { deliveryFailure };
        }
      } else if (isDeliveryFailure(error)) {
        return { deliveryFailure: error };
      } else {
        failure = error;
      }
    } finally {
      try {
        void Promise.resolve(iterator?.return?.()).catch(() => undefined);
      } catch {
        // 关闭迭代器只是善后。
      }
    }

    let result: unknown;
    try {
      const waited = await Promise.race([run.wait(), abandoned]);
      result = waited === ABANDONED ? undefined : waited;
    } catch (error) {
      failure ??= error;
    }
    return { ...(failure !== undefined ? { failure } : {}), ...(result !== undefined ? { result } : {}) };
  }

  // ── 终态 ──

  async #publishCancelled(
    context: AgentDriverContext,
    turn: ActiveTurn,
    abandonCause?: unknown,
    fallbackReason?: string,
  ): Promise<Error> {
    const reason = turn.cancelReason ?? fallbackReason ?? "cancelled";
    turn.terminal = "other";
    if (abandonCause !== undefined) {
      // 取消之后流迟迟不收尾，只能放弃这次运行：终态如实记为 cancelled，但原生运行可能还在跑，
      // 这个实例不能再信任，交给宿主换新内核并用 Agent id 重新接上。
      // 必须在发出终态之前就标记：宿主一收到 run.cancelled 就可能接着开始下一次运行，那时 usable 要已经是 false。
      this.#failure = new DriverTurnCancellationCleanupError(
        "Cursor did not stop the native run after cancellation, so the session must be re-attached.",
        abandonCause,
      );
    }
    await this.#push(context, [
      {
        kind: "run.cancelled",
        runId: turn.runId,
        occurredAt: nowIso(this.#dependencies.now),
        payload: { reason, requestedBy: "user", stopReason: "cancelled" },
      },
    ]);
    return this.#failure ?? new DriverTurnCancelledError(reason);
  }

  async #publishFailed(context: AgentDriverContext, turn: ActiveTurn, error: RunError): Promise<Error> {
    turn.terminal = "other";
    await this.#push(context, [
      {
        kind: "run.failed",
        runId: turn.runId,
        occurredAt: nowIso(this.#dependencies.now),
        // Driver 要求 recoverable 与 error.retryable 一致。
        payload: { error, recoverable: error.retryable },
      },
    ]);
    // 内核把 run.failed 当作实例级失败；宿主换新内核、用 Agent id 恢复，会话本身不受影响。
    return new CursorRunFailedError(error);
  }

  // ── 取消 ──

  async cancelActiveTurn(context: AgentDriverContext, reason: string): Promise<void> {
    const turn = this.#turn;
    if (turn === null || turn.terminal !== null) return;
    await this.#requestCancel(context, turn, reason);
  }

  async #requestCancel(context: AgentDriverContext, turn: ActiveTurn, reason: string): Promise<void> {
    if (turn.terminal !== null) return;
    turn.translator.markCancelObserved();
    if (turn.cancelReason === null) turn.cancelReason = reason;
    if (turn.run !== null) this.#startSdkCancel(turn);
    if (!turn.cancelRequestedPublished) {
      turn.cancelRequestedPublished = true;
      await this.#push(context, [
        {
          kind: "run.cancel.requested",
          runId: turn.runId,
          occurredAt: nowIso(this.#dependencies.now),
          payload: { reason: turn.cancelReason, requestedBy: "user", targetRunId: turn.runId },
        },
      ]).catch(() => undefined);
    }
    const task = turn.cancelTask;
    if (task !== null) await raceTimeout(task, CANCEL_ACK_WAIT_MS);
  }

  /** 向 SDK 请求取消（只发一次）；之后流应当很快收尾，等不到就放弃这次运行。 */
  #startSdkCancel(turn: ActiveTurn): void {
    const run = turn.run;
    if (run === null || turn.cancelTask !== null) return;
    turn.cancelTask = (async () => {
      let cancelError: unknown;
      try {
        await run.cancel();
      } catch (error) {
        cancelError = error;
      }
      const timer = setTimeout(() => {
        turn.abandonCause = cancelError ?? new Error("The Cursor stream did not end after cancel().");
        turn.abandoned.resolve();
      }, this.#dependencies.cancelSettleMs);
      timer.unref();
      void turn.done.promise.then(() => clearTimeout(timer));
    })();
  }

  async #cancelQuietly(run: CursorSdkRun): Promise<void> {
    await raceTimeout(
      run.cancel().catch(() => undefined),
      CANCEL_ACK_WAIT_MS,
    );
  }

  // ── 纠偏 ──

  async steer(input: { key: string; runId: RunId; text: string }): Promise<CursorSteerResult> {
    const turn = this.#turn;
    const run = turn?.run;
    if (!turn || !run || turn.runId !== input.runId || turn.terminal !== null || turn.finishing) {
      return { kind: "unavailable", evidence: "cursor: no active run to steer" };
    }
    if (typeof run.steer !== "function") {
      return { kind: "unavailable", evidence: "cursor: Run.steer() is not available in this SDK build" };
    }

    const track: SteerTrack = { text: normalizeText(input.text), returned: false, applied: false, reported: false, final: undefined };
    turn.steers.set(input.key, track);

    const result: Promise<SteerSettled> = Promise.resolve()
      .then(() => run.steer?.(input.text) ?? Promise.resolve("revert_to_followup"))
      .then(
        (value): SteerSettled => ({ kind: "ack", value }),
        (error: unknown): SteerSettled => ({ kind: "error", error }),
      );
    let timer: NodeJS.Timeout | undefined;
    const ackWindow = new Promise<SteerSettled>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "pending" }), this.#dependencies.steerAckMs);
    });
    const settled = await Promise.race([result, ackWindow]);
    clearTimeout(timer);
    track.returned = true;

    // 流里的 user 回显已经证明回合追加了这条消息。
    if (track.echoEvidence) {
      track.applied = true;
      return { kind: "delivered", evidence: track.echoEvidence };
    }
    // 等待期间运行已经结束：这条消息不可能在这个回合里生效，交还给调用方当作普通跟进。
    if (track.reported) {
      return { kind: "unavailable", evidence: "cursor: the run ended before Run.steer() was answered" };
    }

    switch (settled.kind) {
      case "ack":
        if (settled.value === "complete_delivered") {
          track.applied = true;
          return {
            kind: "delivered",
            evidence: "cursor: Run.steer() settled with complete_delivered — the active turn appended the message",
          };
        }
        turn.steers.delete(input.key);
        return {
          kind: "unavailable",
          evidence: "cursor: Run.steer() settled with revert_to_followup — it must be sent as an ordinary follow-up",
        };
      case "error":
        turn.steers.delete(input.key);
        if (errorNameOf(settled.error) === "UnsupportedRunOperationError") {
          return { kind: "unavailable", evidence: "cursor: the SDK does not support steering this run" };
        }
        throw settled.error;
      case "pending": {
        // SDK 已收到、尚未追加到回合：结论稍后异步补报。
        const final = Promise.withResolvers<CursorSteerFinal>();
        track.final = final;
        void result.then((late) => this.#onLateSteer(track, late));
        return {
          kind: "handed_off",
          evidence: "cursor: Run.steer() is pending — the SDK accepted the message and is waiting for the turn to append it",
          final: final.promise,
        };
      }
    }
  }

  #onLateSteer(track: SteerTrack, late: SteerSettled): void {
    if (track.applied || track.reported || late.kind === "pending") return;
    track.reported = true;
    if (late.kind === "ack" && late.value === "complete_delivered") {
      track.applied = true;
      track.final?.resolve({
        stage: "applied",
        evidence: "cursor: Run.steer() settled with complete_delivered — the active turn appended the message",
      });
      return;
    }
    track.final?.resolve(
      late.kind === "ack"
        ? {
            stage: "failed",
            code: "steer_reverted",
            message: "Cursor could not inject this message into the running turn (revert_to_followup). Send it again as a follow-up.",
          }
        : { stage: "failed", code: "steer_failed", message: errorMessage(late.error).slice(0, 300) },
    );
  }

  /** 流里的 user 回显：如果它就是某条待生效的纠偏，这就是“已生效”的证据。 */
  #onUserEcho(turn: ActiveTurn, text: string): void {
    for (const track of turn.steers.values()) {
      if (track.applied || track.reported || track.text !== text) continue;
      const evidence = "cursor: stream event `user` — the steering message entered the conversation";
      if (track.returned) {
        track.applied = true;
        track.final?.resolve({ stage: "applied", evidence });
      } else {
        track.echoEvidence = evidence;
      }
      return;
    }
  }

  /** 运行收尾时，还没有结局的纠偏必须有交代。 */
  #settleSteers(turn: ActiveTurn, outcome: "cancelled" | "failed"): void {
    for (const track of turn.steers.values()) {
      if (track.applied || track.reported) continue;
      track.reported = true;
      track.final?.resolve(
        outcome === "cancelled"
          ? { stage: "cancelled", evidence: "cursor: the run was cancelled before the turn appended this message" }
          : {
              stage: "failed",
              code: "run_ended",
              message: "The run ended before Cursor appended this steering message to the turn.",
            },
      );
    }
    turn.steers.clear();
  }

  // ── 关闭 ──

  stop(context: AgentDriverContext, reason: string, signal: AbortSignal): Promise<void> {
    this.#stopped = true;
    this.#stopTask ??= (async () => {
      const turn = this.#turn;
      await Promise.allSettled([this.cancelActiveTurn(context, reason)]);
      if (turn !== null) await turn.done.promise;
      const agent = this.#agent;
      try {
        await agent?.close();
      } catch {
        // 关闭失败不影响 Ensemble 自己的收尾。
      }
      this.#lifetime.abort();
    })().catch((error: unknown) => {
      this.#stopTask = null;
      throw error;
    });
    return raceWithAbort(this.#stopTask, signal);
  }

  // ── 事件 ──

  async #push(context: AgentDriverContext, events: readonly DriverEventInput[]): Promise<void> {
    if (events.length === 0) return;
    await pushLosslessEvents(context.ports.eventSink, events, undefined, this.#lifetime.signal);
  }
}

function causedByCancellation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (current instanceof DriverTurnCancelledError) return true;
    current = current.cause;
  }
  return false;
}

/** 事件送不出去（内核已拒绝 / 实例已失败）不是 SDK 的错，要和 SDK 流的错误区分开。 */
function isDeliveryFailure(error: unknown): boolean {
  const name = errorNameOf(error);
  return (
    name === "DriverEventRejectedError" ||
    name === "DriverEventDeliveryOutcomeUnknownError" ||
    (error instanceof Error && /^Driver (event|run terminal)/.test(error.message))
  );
}

async function raceTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
