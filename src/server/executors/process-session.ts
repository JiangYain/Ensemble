import { isoNow, tail } from "@shared/format";
import type { MessageId, NativeRef, RunId } from "@shared/types";
import { stampRun } from "./common";
import type { ExitInfo, JsonlProcess } from "./process";
import { exitMessage } from "./rpc";
import type { ExecutorDraft, ExecutorSession, OpenInput, StartRunInput, SteerInput, SteerOutcome } from "./types";

/**
 * 一条运行中纠偏消息的“已生效”证据，与 `steer()` 的返回之间的先后协调（Codex 与 Pi 共用）。
 *
 * 管理器在 `steer()` 返回后的微任务里记录“已排队”，证据链必须按真实发生的顺序出现；
 * 而执行端的回显（用户消息被写进会话）可能比 steer 命令的响应先被处理：
 * 回显先到就先记下证据，等 `steer()` 被执行端接受之后再补报。
 */
export class SteerTrack {
  /** 已经看到执行端把这条消息写进了会话（回显）。 */
  applied = false;
  private accepted = false;
  private deferredEvidence: string | undefined;

  /** 看到回显：steer 命令已被接受就立刻报告，否则留到 `accept()` 再报。 */
  echo(evidence: string, report: (evidence: string) => void): void {
    this.applied = true;
    if (this.accepted) report(evidence);
    else this.deferredEvidence = evidence;
  }

  /** steer 命令被执行端接受；如果回显已经先到，在管理器记录完“已排队”之后补报。 */
  accept(report: (evidence: string) => void): void {
    this.accepted = true;
    const deferred = this.deferredEvidence;
    if (!deferred) return;
    this.deferredEvidence = undefined;
    // 宏任务一定排在管理器的微任务之后。
    setImmediate(() => report(deferred));
  }
}

/**
 * “起一个子进程、通过 JSONL 对话”的执行端会话骨架：事件盖章、诊断条目、关闭、进程意外退出。
 * 具体的启动握手与事件映射由 Codex / Pi 各自实现。
 */
export abstract class ProcessSession<Rpc extends { failAll(error: Error): void }> implements ExecutorSession {
  nativeRef: NativeRef | undefined;
  protected proc!: JsonlProcess;
  protected rpc!: Rpc;
  protected closing = false;
  private closePromise: Promise<void> | undefined;

  /** `peer` 是对端的名字，用在错误信息里（Codex / Pi）。 */
  protected constructor(
    protected readonly input: OpenInput,
    private readonly peer: string,
  ) {}

  /** 当前正在进行的运行；事件默认归到它名下。 */
  protected abstract activeRunId(): RunId | undefined;

  abstract startRun(input: StartRunInput): Promise<void>;
  abstract steer(input: SteerInput): Promise<SteerOutcome>;
  abstract cancel(runId: RunId): Promise<void>;

  /** 关闭时补充的清理（例如还没触发的定时器）。 */
  protected dispose(): void {}

  protected emit(draft: ExecutorDraft, runId?: RunId): void {
    if (this.closing) return;
    this.input.emit(stampRun(draft, runId ?? this.activeRunId()));
  }

  protected diagnostic(level: "info" | "warn" | "error", code: string, message: string): void {
    this.emit({ kind: "diagnostic", data: { level, code, message } });
  }

  protected emitApplied(messageId: MessageId, evidence: string, runId: RunId): void {
    this.emit({ kind: "message.delivery", data: { messageId, record: { stage: "applied", at: isoNow(), evidence } }, runId });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      this.dispose();
      this.rpc?.failAll(new Error(`The ${this.peer} session is closed.`));
      await this.proc?.kill();
    })();
    return this.closePromise;
  }

  protected onExit(info: ExitInfo): void {
    if (this.closing) return;
    const stderr = info.stderrTail.trim();
    this.input.fatal({
      code: "process_exited",
      message: `${exitMessage(this.peer, info)} while the session was still open.`,
      ...(stderr ? { detail: tail(stderr, 1_500) } : {}),
    });
  }
}
