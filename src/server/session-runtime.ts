import { advanceDelivery, isDeliveryPending } from "@shared/delivery";
import type { EventDraft, EventSource } from "@shared/events";
import { isoNow } from "@shared/format";
import { newId } from "@shared/ids";
import { openQuestionItems, type SessionState } from "@shared/projection";
import { SYSTEM_ACTOR, type QuestionExpiry } from "@shared/questions";
import type {
  Actor, DeliveryRecord, DeliveryStage, ErrorInfo, Message, MessageId, NativeRef, QueueReason, Run, RunId, SessionStatus,
} from "@shared/types";
import { EnsembleError, toErrorInfo } from "./errors";
import type { Executor, ExecutorDraft, ExecutorSession, StartRunInput, SteerOutcome } from "./executors/types";
import type { EventHub } from "./hub";
import type { Logger } from "./logger";
import type { RunSlots } from "./run-slots";

type RunEnd = Extract<EventDraft, { kind: "run.completed" | "run.failed" | "run.cancelled" }>;

interface ActiveRun {
  input: StartRunInput;
  phase: "opening" | "submitting" | "accepted" | "running";
  waitingSteers: Message[];
  cancel?: { by: Actor; timer?: NodeJS.Timeout };
}

type Connection =
  | { kind: "unopened" }
  | { kind: "opening"; ready: Promise<ExecutorSession> }
  | { kind: "ready"; session: ExecutorSession };

type Lifecycle =
  | { kind: "open"; connection: Connection }
  | { kind: "closed"; done: Promise<void> };

interface RuntimeOptions {
  state: SessionState;
  executor: Executor;
  hub: EventHub;
  slots: RunSlots;
  log: Logger;
  cancelConfirmMs: number;
  resume?: NativeRef;
  onClosed(): void;
}

/**
 * 一个原生连接（含打开过程）及其运行队列。所有命令和回执在同一同步转换内
 * 修改状态并追加事件；异步完成后凭连接及运行身份回到这里。EventHub 的订阅方只观察。
 */
export class SessionRuntime {
  private readonly abort = new AbortController();
  private lifecycle: Lifecycle = { kind: "open", connection: { kind: "unopened" } };
  private active: ActiveRun | undefined;
  private readonly queue: StartRunInput[] = [];
  private readonly pending = new Map<MessageId, RunId>();

  constructor(private readonly options: RuntimeOptions) {}

  get accepting(): boolean {
    return this.lifecycle.kind === "open";
  }

  get activeRunId(): RunId | undefined {
    return this.active?.input.runId;
  }

  get busy(): boolean {
    return !this.accepting || this.active !== undefined || this.queue.length > 0 || this.pending.size > 0;
  }

  private get id(): string {
    return this.options.state.meta.id;
  }

  private update<T>(commit: () => T): T {
    return this.options.hub.batch(commit);
  }

  private emit(event: EventDraft): void {
    this.options.hub.emit(this.id, event);
  }

  enqueue(message: Message, prompt: string, fallback?: { reason: QueueReason; evidence?: string }): RunId {
    return this.update(() => {
      const runId = newId("run");
      const trigger = message.kind === "task" ? "task" : "follow_up";
      const run: Run = {
        id: runId, sessionId: this.id, index: (this.options.state.runs.at(-1)?.index ?? 0) + 1,
        trigger, messageId: message.id, status: "queued", queuedAt: isoNow(), steerCount: 0,
      };
      this.queue.push({ runId, messageId: message.id, prompt, trigger });
      this.pending.set(message.id, runId);
      this.emit({ kind: "run.queued", data: { run }, source: "ensemble" });
      if (fallback || this.active) {
        this.delivery(message.id, runId, { stage: "queued", queuedBy: "ensemble", reason: "run_in_progress", ...fallback });
      }
      this.schedule();
      return runId;
    });
  }

  steer(message: Message, runId: RunId): Promise<RunId> {
    return this.update(() => {
      const run = this.active;
      const lifecycle = this.lifecycle;
      if (!run || run.input.runId !== runId || lifecycle.kind !== "open") throw new Error("The target run is no longer active.");
      this.pending.set(message.id, runId);
      if (run.phase !== "running") {
        run.waitingSteers.push(message);
        this.delivery(message.id, runId, { stage: "queued", queuedBy: "ensemble", reason: "session_starting" });
        return Promise.resolve(runId);
      }
      const { connection } = lifecycle;
      if (connection.kind !== "ready") throw new Error("A started run must have a connection.");
      return this.passSteer(connection.session, runId, message);
    });
  }

  stage(messageId: MessageId): DeliveryStage {
    return this.message(messageId)?.delivery.stage ?? "recorded";
  }

  get closed(): Promise<void> | undefined {
    return this.lifecycle.kind === "closed" ? this.lifecycle.done : undefined;
  }

  /**
   * 已经连上的执行端会话（尚未打开、正在打开、已关闭时没有）。回复提问时用：
   * 只有连着的会话才可能还在等一个回答，其余情形回复都不可能送达。
   */
  get connected(): ExecutorSession | undefined {
    const lifecycle = this.lifecycle;
    return lifecycle.kind === "open" && lifecycle.connection.kind === "ready" ? lifecycle.connection.session : undefined;
  }

  private async passSteer(session: ExecutorSession, runId: RunId, message: Message): Promise<RunId> {
    let outcome: SteerOutcome;
    try {
      outcome = await session.steer({ runId, messageId: message.id, text: message.text });
    } catch (error) {
      if (this.pending.has(message.id)) {
        this.update(() => this.delivery(message.id, runId, { stage: "failed", error: toErrorInfo(error, "steer_failed") }));
      }
      return runId;
    }

    return this.update(() => {
      // Cancel, stop and disconnect settle or remove pending messages before an RPC can reply.
      if (!this.accepting || !this.pending.has(message.id)) return runId;
      if (outcome.kind === "needs_follow_up") {
        return this.enqueue(message, message.text, { reason: outcome.reason, evidence: outcome.evidence });
      }
      this.delivery(message.id, runId, { stage: "handed_off", evidence: outcome.evidence });
      if (outcome.kind === "delivered") {
        this.delivery(message.id, runId, { stage: "applied", evidence: outcome.evidence });
      } else if (outcome.kind === "queued_by_harness") {
        this.delivery(message.id, runId, {
          stage: "queued", queuedBy: "harness", reason: outcome.reason ?? "turn_boundary", evidence: outcome.evidence,
        });
      }
      // A handed-off SDK call has a final callback even when its run event arrives first.
      if (this.active?.input.runId !== runId && outcome.kind === "queued_by_harness" && this.pending.has(message.id)) {
        this.delivery(message.id, runId, { stage: "failed", error: { code: "run_ended", message: "The run ended before delivery could be confirmed." } });
      }
      return runId;
    });
  }

  cancel(by: Actor): { interrupted: boolean; cancelledQueued: number } {
    return this.update(() => {
      const active = this.active;
      if (!this.accepting || (!active && this.queue.length === 0)) {
        throw new EnsembleError("conflict", "The session has no active or queued run to cancel.");
      }
      const cancelledQueued = this.finishQueued({
        kind: "run.cancelled", data: { by, note: "Cancelled before it started." }, source: sourceOf(by),
      });
      if (active && !active.cancel) {
        for (const steer of active.waitingSteers.splice(0)) this.delivery(steer.id, active.input.runId, { stage: "cancelled" });
        active.cancel = { by };
        if (active.phase === "opening") {
          this.finish({
            kind: "run.cancelled", data: { by, note: "Cancelled before the harness started it." },
            runId: active.input.runId, source: sourceOf(by),
          });
        } else {
          this.interrupt(active);
        }
      } else if (!active) {
        this.options.slots.release(this.id);
        this.status("idle");
      }
      return { interrupted: !!active, cancelledQueued };
    });
  }

  private interrupt(run: ActiveRun): void {
    const cancel = run.cancel;
    if (!cancel || (run.phase !== "accepted" && run.phase !== "running")) return;
    const lifecycle = this.lifecycle;
    if (lifecycle.kind !== "open" || lifecycle.connection.kind !== "ready") return;
    const { session } = lifecycle.connection;
    void Promise.resolve().then(() => {
      if (this.accepting && this.active === run) return session.cancel(run.input.runId);
    }).then(() => {
      if (!this.accepting || this.active !== run || run.cancel !== cancel) return;
      cancel.timer = setTimeout(() => {
        if (this.active !== run) return;
        this.diagnostic(run.input.runId, "warn", "cancel_unconfirmed",
          "The harness has not confirmed cancellation yet. The run may still be winding down.");
      }, this.options.cancelConfirmMs);
      cancel.timer.unref();
    }, (error: unknown) => {
      if (!this.accepting || this.active !== run) return;
      delete run.cancel;
      this.diagnostic(run.input.runId, "error", "cancel_failed", toErrorInfo(error).message);
    });
  }

  stop(by: Actor): Promise<void> {
    return this.close({ kind: "stop", by });
  }

  shutdown(): Promise<void> {
    return this.close({ kind: "shutdown" });
  }

  private close(reason: { kind: "stop"; by: Actor } | { kind: "shutdown" } | { kind: "disconnect"; error: ErrorInfo }): Promise<void> {
    return this.update(() => {
      if (this.lifecycle.kind === "closed") return this.lifecycle.done;
      const { connection } = this.lifecycle;
      const done = Promise.withResolvers<void>();
      this.lifecycle = { kind: "closed", done: done.promise };
      const { state, hub, log, slots } = this.options;
      const active = this.active;
      this.active = undefined;
      clearTimeout(active?.cancel?.timer);
      const settle = (end: RunEnd, record: Omit<DeliveryRecord, "at">) => {
        this.finishQueued(end);
        if (active) this.emit({ ...end, runId: active.input.runId });
        for (const [id, runId] of this.pending) this.delivery(id, runId, record);
        this.pending.clear();
      };
      // 待回答的提问先收尾：连接即将关闭，没有人再能把回答送到执行端。
      // 先写这个明确的原因，投影在运行收尾时的兜底（只知道“运行结束了”）就不会抢先。重启与关闭服务由 abandonSession 同样处理。
      if (reason.kind !== "shutdown") this.expireQuestions("session_closed");
      switch (reason.kind) {
        case "stop": {
          settle({ kind: "run.cancelled", data: { by: reason.by, note: "The session was stopped." }, source: sourceOf(reason.by) },
            { stage: "cancelled" });
          this.status("stopped", "stopped_by_user");
          break;
        }
        case "disconnect": {
          const { error } = reason;
          this.diagnostic(active?.input.runId, "error", error.code, error.message);
          settle({ kind: "run.failed", data: { error }, source: "ensemble" }, { stage: "failed", error });
          this.status("failed", error.code, error);
          break;
        }
        case "shutdown":
          this.queue.length = 0;
          abandonSession(hub, state, "service_stopped");
          this.pending.clear();
          break;
      }
      slots.release(this.id);
      this.abort.abort();
      // The slot counts runs. Keep the runtime registered until its connection closes so resume never opens a second one.
      void this.closeConnection(connection).catch((error: unknown) => {
        log.warn("closing executor failed", { sessionId: this.id, error });
      }).then(() => {
        this.options.onClosed();
        done.resolve();
      });
      return done.promise;
    });
  }

  private async closeConnection(connection: Connection): Promise<void> {
    if (connection.kind === "unopened") return;
    const session = connection.kind === "ready" ? connection.session : await connection.ready.catch(() => undefined);
    await session?.close();
  }

  private finishQueued(end: RunEnd): number {
    const queued = this.queue.splice(0);
    for (const input of queued) {
      this.emit({ ...end, runId: input.runId });
      if (end.kind === "run.failed") this.delivery(input.messageId, input.runId, { stage: "failed", error: end.data.error });
      else if (end.kind === "run.cancelled") this.delivery(input.messageId, input.runId, { stage: "cancelled" });
    }
    return queued.length;
  }

  private schedule(): void {
    if (!this.accepting || this.active) return;
    const next = this.queue[0];
    if (!next) return;
    if (this.options.slots.request(this.id, () => this.startNext())) return;
    this.status("queued", "capacity");
    this.delivery(next.messageId, next.runId, { stage: "queued", queuedBy: "ensemble", reason: "capacity" });
  }

  private startNext(): void {
    const input = this.queue.shift();
    const lifecycle = this.lifecycle;
    if (!input || lifecycle.kind !== "open") {
      this.options.slots.release(this.id);
      return;
    }
    const run: ActiveRun = { input, phase: "opening", waitingSteers: [] };
    this.active = run;
    this.emit({
      kind: "run.starting",
      data: lifecycle.connection.kind === "unopened" && this.options.resume ? { resuming: true } : {},
      runId: input.runId,
      source: "ensemble",
    });
    void this.start(run);
  }

  private async start(run: ActiveRun): Promise<void> {
    const { input } = run;
    let session: ExecutorSession;
    try {
      session = await this.connect();
    } catch (error) {
      // Opening belongs to the connection; even if its first run was cancelled, the connection failed.
      if (this.accepting) void this.close({ kind: "disconnect", error: toErrorInfo(error, "start_failed") });
      return;
    }
    if (!this.accepting || this.active !== run) return;
    this.update(() => { run.phase = "submitting"; });
    try {
      await session.startRun(input);
    } catch (error) {
      if (!this.accepting || this.active !== run) return;
      this.update(() => this.finish({
        kind: "run.failed", runId: input.runId, data: { error: toErrorInfo(error, "start_failed") }, source: "ensemble",
      }));
      return;
    }
    if (!this.accepting || this.active !== run || run.phase !== "submitting") return;
    this.update(() => {
      run.phase = "accepted";
      this.delivery(input.messageId, input.runId, { stage: "handed_off", evidence: this.evidence("run accepted") });
      this.interrupt(run);
    });
  }

  private connect(): Promise<ExecutorSession> {
    const lifecycle = this.lifecycle;
    if (lifecycle.kind !== "open") throw new EnsembleError("session_closed", "The session is closed.");
    const { connection } = lifecycle;
    if (connection.kind === "ready") return Promise.resolve(connection.session);
    if (connection.kind === "opening") return connection.ready;
    const { executor, log, state, resume } = this.options;
    let openingFailure: ErrorInfo | undefined;
    // Store the in-flight open before entering the adapter, which is allowed to emit synchronously.
    const ready = Promise.resolve().then(() => {
      this.abort.signal.throwIfAborted();
      return executor.open({
        meta: state.meta, ...(resume ? { resume } : {}), signal: this.abort.signal, log: log.child(state.meta.harness),
        emit: (draft) => this.onExecutorEvent(draft),
        fatal: (error) => {
          // During open the adapter can report a more specific error from its startup handshake.
          if (lifecycle.connection.kind === "ready" && this.accepting) void this.close({ kind: "disconnect", error });
          else openingFailure = error;
        },
      });
    }).then(async (session) => {
      if (openingFailure) {
        await session.close().catch((error: unknown) => log.warn("closing failed connection", { sessionId: this.id, error }));
        throw Object.assign(new Error(openingFailure.message), openingFailure);
      }
      this.update(() => {
        if (this.lifecycle.kind !== "open") return;
        this.lifecycle.connection = { kind: "ready", session };
        const nativeRef = session.nativeRef;
        if (nativeRef && (nativeRef.id !== state.meta.nativeRef?.id || nativeRef.path !== state.meta.nativeRef.path)) {
          this.emit({ kind: "session.updated", data: { patch: { nativeRef } }, source: "ensemble" });
        }
      });
      return session;
    });
    lifecycle.connection = { kind: "opening", ready };
    return ready;
  }

  private onExecutorEvent(draft: ExecutorDraft): void {
    if (!this.accepting) return;
    this.update(() => {
      const run = this.active;
      const event: EventDraft = { ...draft, source: "executor" };
      switch (event.kind) {
        case "run.started":
          if (run && event.runId === run.input.runId && (run.phase === "submitting" || run.phase === "accepted") &&
            this.lifecycle.kind === "open" && this.lifecycle.connection.kind === "ready") {
            const { runId, messageId } = run.input;
            const previousPhase = run.phase;
            run.phase = "running";
            this.delivery(messageId, runId, { stage: "handed_off", evidence: this.evidence("run started") });
            this.emit(event);
            this.delivery(messageId, runId, { stage: "applied", evidence: this.evidence("run started from this message") });
            if (run.cancel && previousPhase === "submitting") this.interrupt(run);
            const { session } = this.lifecycle.connection;
            for (const message of run.waitingSteers.splice(0)) {
              if (this.pending.has(message.id)) void this.passSteer(session, runId, message);
            }
          }
          return;
        case "run.completed":
        case "run.failed":
        case "run.cancelled":
          if (run && event.runId === run.input.runId) this.finish(event);
          return;
        case "message.delivery":
          if (event.runId && this.pending.get(event.data.messageId) === event.runId) {
            this.recordDelivery(event.data.messageId, event.runId, event.data.record, "executor");
          }
          return;
        default:
          if (!event.runId || event.runId === run?.input.runId) this.emit(event);
      }
    });
  }

  private finish(end: RunEnd): void {
    const run = this.active;
    if (!run) return;
    this.active = undefined;
    clearTimeout(run.cancel?.timer);
    const { runId, messageId } = run.input;
    this.emit(end);
    if (end.kind === "run.failed") this.delivery(messageId, runId, { stage: "failed", error: end.data.error });
    else if (end.kind === "run.cancelled") this.delivery(messageId, runId, { stage: "cancelled" });
    else this.delivery(messageId, runId, { stage: "applied", evidence: this.evidence("run completed from this message") });
    for (const steer of run.waitingSteers) {
      this.delivery(steer.id, runId, end.kind === "run.cancelled"
        ? { stage: "cancelled" }
        : { stage: "failed", error: { code: "run_ended", message: "The run ended before the message could be sent." } });
    }
    this.options.slots.release(this.id);
    this.schedule();
  }

  private message(id: MessageId): Message | undefined {
    const { idx, messages } = this.options.state;
    const index = idx.messages.get(id);
    return index === undefined ? undefined : messages[index];
  }

  private delivery(messageId: MessageId, runId: RunId, record: Omit<DeliveryRecord, "at">): void {
    this.recordDelivery(messageId, runId, { ...record, at: isoNow() }, "ensemble");
  }

  private recordDelivery(messageId: MessageId, runId: RunId, record: DeliveryRecord, source: EventSource): void {
    const message = this.message(messageId);
    if (!message || advanceDelivery(message.delivery, record) === message.delivery) return;
    if (!isDeliveryPending(record)) this.pending.delete(messageId);
    this.emit({ kind: "message.delivery", data: { messageId, record }, runId, source });
  }

  private evidence(action: string): string {
    return `${this.options.state.meta.harness}: ${action}`;
  }

  private status(status: SessionStatus, reason?: string, error?: ErrorInfo): void {
    const { state } = this.options;
    if (state.status === status && state.statusReason === reason && !error) return;
    this.emit({ kind: "session.status", data: { status, reason, error }, source: "ensemble" });
  }

  private diagnostic(runId: RunId | undefined, level: "warn" | "error", code: string, message: string): void {
    this.emit({ kind: "diagnostic", data: { level, code, message }, runId, source: "ensemble" });
  }

  /** 把仍待回答的提问记为过期（执行端不会再收到回答）。 */
  private expireQuestions(reason: QuestionExpiry): void {
    for (const item of openQuestionItems(this.options.state)) {
      this.emit({
        kind: "question.resolved",
        data: { questionId: item.questionId, outcome: "expired", by: SYSTEM_ACTOR, reason },
        ...(item.runId ? { runId: item.runId } : {}),
        source: "ensemble",
      });
    }
  }
}

export function sourceOf(actor: Actor): "user" | "origin" | "ensemble" {
  if (actor.kind === "user") return "user";
  if (actor.kind === "agent") return "origin";
  return "ensemble";
}

function isHeld(message: Message | undefined): boolean {
  const delivery = message?.delivery;
  return delivery?.stage === "recorded" || (delivery?.stage === "queued" && delivery.queuedBy === "ensemble");
}

/** 重放后不复跑任何在途工作；只有发起方的新消息可以恢复原生会话。 */
export function abandonSession(hub: EventHub, state: SessionState, code: "service_restarted" | "service_stopped"): boolean {
  if (state.status === "stopped" || state.status === "lost" || state.status === "failed") return false;
  if (state.status === "idle" && !state.activeRunId && !state.runs.some((run) => run.status === "queued") &&
    !state.messages.some((message) => isDeliveryPending(message.delivery))) return false;
  const id = state.meta.id;
  const cause = code === "service_restarted" ? "Ensemble restarted" : "Ensemble was shut down";
  hub.batch(() => {
    // 仍待回答的提问先记为过期：连接随重启或关闭断开了，没有任何办法再把回答送过去。
    for (const item of openQuestionItems(state)) {
      hub.emit(id, {
        kind: "question.resolved",
        data: { questionId: item.questionId, outcome: "expired", by: SYSTEM_ACTOR, reason: "restarted" },
        ...(item.runId ? { runId: item.runId } : {}),
        source: "ensemble",
      });
    }
    for (const run of state.runs) {
      if (run.status === "starting" || run.status === "running") {
        const error = { code, message: `${cause} while this run was active, so its final outcome is unknown. Check the harness's own session.` };
        hub.emit(id, { kind: "run.failed", data: { error }, runId: run.id, source: "ensemble" });
      } else if (run.status === "queued") {
        hub.emit(id, { kind: "run.cancelled", data: { note: `${cause} before this run started.` }, runId: run.id, source: "ensemble" });
      }
    }
    for (const message of state.messages) {
      if (!isDeliveryPending(message.delivery)) continue;
      const error = { code, message: isHeld(message)
        ? `${cause} before this message was handed to the harness.`
        : `${cause} before delivery could be confirmed by the harness.` };
      const record: DeliveryRecord = { stage: "failed", at: isoNow(), error };
      hub.emit(id, { kind: "message.delivery", data: { messageId: message.id, record }, source: "ensemble" });
    }
    hub.emit(id, { kind: "session.status", data: { status: "lost", reason: code }, source: "ensemble" });
  });
  return true;
}
