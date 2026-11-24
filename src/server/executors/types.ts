import type { EventDraft } from "@shared/events";
import type { QuestionId } from "@shared/questions";
import type {
  ErrorInfo,
  ExecutorRuntime,
  HarnessId,
  HarnessInfo,
  MessageId,
  NativeRef,
  QueueReason,
  RunId,
  SessionMeta,
} from "@shared/types";
import type { Logger } from "../logger";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** 适配器只负责描述执行端发生了什么；事件来源由管理器统一标注为 executor。 */
export type ExecutorDraft = DistributiveOmit<EventDraft, "source">;

export type Emit = (draft: ExecutorDraft) => void;

export interface OpenInput {
  meta: SessionMeta;
  emit: Emit;
  /** 执行端进程或连接意外中断时调用（不是正常关闭）。 */
  fatal: (error: ErrorInfo) => void;
  log: Logger;
  /** 服务重启后重新接入原生会话时给出。 */
  resume?: NativeRef;
  /** 会话关闭时触发，适配器应据此释放资源。 */
  signal: AbortSignal;
}

export interface StartRunInput {
  runId: RunId;
  messageId: MessageId;
  prompt: string;
  trigger: "task" | "follow_up";
}

export interface SteerInput {
  runId: RunId;
  messageId: MessageId;
  text: string;
}

/**
 * 运行中补充输入的结果，必须如实反映执行端的真实行为：
 * - delivered：执行端明确确认已注入当前回合；
 * - handed_off：已被执行端接受，等待它在事件里显示生效（适配器稍后自行上报 applied）；
 * - queued_by_harness：执行端接受后放进了自己的队列（如回合边界处理）；
 * - needs_follow_up：执行端无法在运行中注入，需要在本次运行结束后作为新的运行发送。
 */
export type SteerOutcome =
  | { kind: "delivered"; evidence: string }
  | { kind: "handed_off"; evidence: string }
  | { kind: "queued_by_harness"; evidence: string; reason?: QueueReason }
  | { kind: "needs_follow_up"; reason: QueueReason; evidence?: string };

export interface ExecutorSession {
  readonly nativeRef: NativeRef | undefined;
  /** 向执行端提交一次运行；在执行端接受后返回，不等待运行结束。 */
  startRun(input: StartRunInput): Promise<void>;
  steer(input: SteerInput): Promise<SteerOutcome>;
  cancel(runId: RunId): Promise<void>;
  /** 释放进程与连接；不得删除执行端自己保存的原生会话。 */
  close(): Promise<void>;
  /**
   * 回复执行端的一次业务提问（可选；这不是授权——授权请求由适配器当场应答，从不经过这里）。
   * 能中继提问的适配器会先发 `question.asked`（带 Ensemble 的提问编号），之后由发起方通过它回答。
   * `answers` 与提问里的问题一一对应：每个问题一个字符串数组（单选一项，多选多项）。
   * 返回 true = 回复已交给执行端；false = 执行端已不再等待这个提问（回合结束、提问被撤回、连接已断开），回复没有送达。
   * “已不再等待”是预期内的，按返回值表达，不抛异常。
   * 不实现这两个方法的适配器不会发 `question.asked`，对执行端的提问仍是原来的处理方式。
   */
  answerQuestion?(questionId: QuestionId, answers: readonly (readonly string[])[]): Promise<boolean>;
  /**
   * 不回答：让执行端自行判断。`note` 是写给执行端看的一句话（英文）。返回值同 answerQuestion。
   * Ensemble 自己的时限也走这里（note 说明没有人在时限内回答）。
   */
  declineQuestion?(questionId: QuestionId, note: string): Promise<boolean>;
}

/**
 * 执行端拒绝了回复本身（取值不合它的要求）。与“已不再等待”不同：提问仍在等回答，发起方可以改了重答。
 * 适配器在 answerQuestion / declineQuestion 里遇到这种情况抛它；“已不再等待”仍用返回 false 表达。
 */
export class ReplyRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplyRejected";
  }
}

export interface Executor {
  readonly id: HarnessId;
  readonly runtime: ExecutorRuntime;
  probe(): Promise<HarnessInfo>;
  open(input: OpenInput): Promise<ExecutorSession>;
  /** 是否支持服务重启后重新接入原生会话。 */
  readonly canResume: boolean;
}
