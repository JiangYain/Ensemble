import { isoNow } from "@shared/format";
import type { SessionState } from "@shared/projection";
import {
  answersText,
  checkAnswers,
  EXPIRY_TEXT,
  questionItemId,
  questionPreview,
  SYSTEM_ACTOR,
  type AnswerInput,
  type QuestionId,
  type QuestionOutcomeRecord,
  type QuestionResolution,
  type QuestionStatus,
} from "@shared/questions";
import type { Actor, QuestionItem, SessionId } from "@shared/types";
import { EnsembleError } from "./errors";
import { ReplyRejected, type ExecutorSession } from "./executors/types";
import type { EventHub } from "./hub";
import type { Logger } from "./logger";
import type { NoticeCenter } from "./notices";
import { sourceOf } from "./session-runtime";

/**
 * 提问的受理处：回答、不回答与时限，都从这里把一个待回答的提问推到它的结局。
 *
 * 这不是授权闸门。被委派的会话是 Full Access，执行端的授权请求由适配器当场应答，从不经过这里；
 * 这里处理的只是执行端遇到需求歧义、停下来向发起方要一个答案。
 *
 * 记录的顺序是“先交给执行端，再写结局事件”：只有回复真的交到了执行端，才记 answered / declined；
 * 想回复时发现执行端已经不再等待，就如实记成 expired（not_waiting），并让调用方知道回复没有送达——
 * 绝不先记“已回答”再去碰运气。提问不另存状态文件：待回答的提问就是日志里没有结局事件的 `question.asked`。
 */

export interface QuestionDeskDeps {
  hub: EventHub;
  notices: NoticeCenter;
  log: Logger;
  /** 这个会话当前连着的执行端；只有连着的，才可能还在等一个回答。 */
  connection(sessionId: SessionId): ExecutorSession | undefined;
  /** 提问无人回答多久后告知执行端自行假设并记为过期；0 = 不设时限。 */
  timeoutMs: number;
}

/** 一次受理的结果：与写进事件的结局一致。 */
export interface ResolvedQuestion {
  questionId: QuestionId;
  status: Exclude<QuestionStatus, "open">;
  outcome: QuestionOutcomeRecord;
}

type Action =
  | { kind: "answer"; answers: string[][]; by: Actor }
  | { kind: "decline"; note?: string; by: Actor }
  | { kind: "timeout" };

const DECLINE_NOTE =
  "Whoever delegated this task chose not to answer this question. Use your own judgment: make a reasonable assumption, state it in your answer, and continue.";

/** 写给执行端的那句话（英文，与执行端的其他系统文字一致）。 */
function closingNote(action: Exclude<Action, { kind: "answer" }>, timeoutMs: number): string {
  if (action.kind === "timeout") {
    const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
    return `Nobody answered this question within ${minutes} minute${minutes === 1 ? "" : "s"}. Make a reasonable assumption, state it in your answer, and continue.`;
  }
  return action.note ? `${DECLINE_NOTE} They added: ${action.note}` : DECLINE_NOTE;
}

/** 提问已经有结局（或不在等待）：回复的人需要知道为什么这次没有生效。 */
function notOpen(item: QuestionItem): EnsembleError {
  const outcome = item.outcome;
  const details = {
    questionId: item.questionId,
    status: item.status,
    ...(outcome ? { resolvedBy: outcome.by.label, resolvedByKind: outcome.by.kind, resolvedAt: outcome.at } : {}),
    ...(outcome?.reason ? { reason: outcome.reason } : {}),
  };
  switch (item.status) {
    case "answered":
      return new EnsembleError("conflict", `This question was already answered${outcome ? ` by ${outcome.by.label}` : ""}.`, details);
    case "declined":
      return new EnsembleError("conflict", `This question was already declined${outcome ? ` by ${outcome.by.label}` : ""}; the session was told to use its own judgment.`, details);
    default:
      return new EnsembleError(
        "conflict",
        `This question has expired${outcome?.reason ? ` (${EXPIRY_TEXT[outcome.reason]})` : ""}; the harness is no longer waiting for an answer.`,
        details,
      );
  }
}

function findQuestion(state: SessionState, questionId: QuestionId): QuestionItem | undefined {
  const index = state.idx.items.get(questionItemId(questionId));
  const item = index === undefined ? undefined : state.timeline[index];
  return item?.type === "question" ? item : undefined;
}

export class QuestionDesk {
  private readonly timers = new Map<QuestionId, NodeJS.Timeout>();
  /** 正在把回复交给执行端的提问：先到的占住，同一时刻到的另一个直接被告知，不会有两个结局。 */
  private readonly inFlight = new Set<QuestionId>();
  /**
   * 时限到点时正好有回复在途、被它挡了回去的提问。那个计时器已经用掉：回复若给了提问结局，这里什么也不用做；
   * 回复若被执行端拒绝（`ReplyRejected`，提问按约定回到“待回答”、等人改了重答），就再没有任何东西去收尾它——
   * 所以 `settle` 在回复收尾时，替这笔早已到期的时限补上。
   */
  private readonly overdue = new Set<QuestionId>();
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: QuestionDeskDeps) {
    // 时限从提问落地的那一刻起算，有了结局就撤掉；不依赖谁来调用。
    this.unsubscribe = deps.hub.subscribe((change) => {
      if (change.type !== "event") return;
      const { event } = change;
      if (event.kind === "question.asked") this.arm(event.sessionId, event.data.question.id);
      else if (event.kind === "question.resolved") this.disarm(event.data.questionId);
    });
  }

  dispose(): void {
    this.unsubscribe();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.overdue.clear();
  }

  /** 回答一个待回答的提问。回答不合格（选项不对、数量不对）是调用方的错，提问仍待回答。 */
  async answer(sessionId: SessionId, questionId: QuestionId, input: AnswerInput, by: Actor): Promise<ResolvedQuestion> {
    const item = await this.requireOpen(sessionId, questionId);
    const checked = checkAnswers(item.prompts, input);
    if (!checked.ok) throw new EnsembleError("invalid_request", checked.message, { questionId });
    return this.settle(sessionId, item, { kind: "answer", answers: checked.answers, by });
  }

  /** 不回答，让执行端自行判断。 */
  async decline(sessionId: SessionId, questionId: QuestionId, note: string | undefined, by: Actor): Promise<ResolvedQuestion> {
    const item = await this.requireOpen(sessionId, questionId);
    return this.settle(sessionId, item, { kind: "decline", ...(note ? { note } : {}), by });
  }

  // ───────────────────────── 内部 ─────────────────────────

  private async requireOpen(sessionId: SessionId, questionId: QuestionId): Promise<QuestionItem> {
    const { hub } = this.deps;
    if (!hub.has(sessionId)) throw new EnsembleError("not_found", `Session ${sessionId} does not exist.`);
    // 冷会话都是稳定、已结束的：解冻只为了给出准确的原因（已有结局），而不是“没有这个提问”。
    const state = hub.state(sessionId) ?? (await hub.ensureHot(sessionId));
    const item = state ? findQuestion(state, questionId) : undefined;
    if (!item) throw new EnsembleError("not_found", `Session ${sessionId} has no question ${questionId}.`);
    if (item.status !== "open") throw notOpen(item);
    return item;
  }

  private openItem(sessionId: SessionId, questionId: QuestionId): QuestionItem | undefined {
    const state = this.deps.hub.state(sessionId);
    const item = state ? findQuestion(state, questionId) : undefined;
    return item?.status === "open" ? item : undefined;
  }

  private arm(sessionId: SessionId, questionId: QuestionId): void {
    const { timeoutMs } = this.deps;
    if (timeoutMs <= 0 || this.timers.has(questionId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(questionId);
      void this.expire(sessionId, questionId);
    }, timeoutMs);
    timer.unref?.();
    this.timers.set(questionId, timer);
  }

  private disarm(questionId: QuestionId): void {
    const timer = this.timers.get(questionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(questionId);
    this.overdue.delete(questionId);
  }

  /**
   * 时限到了：告知执行端自行假设，并记为过期。这时可能刚好有人在回答——先到先得，输的一方此刻什么也不写。
   * 但赢的那个回复若没能给提问一个结局（执行端拒绝了它，提问仍待回答），这次时限不能就此作废：记在 `overdue` 里，
   * 由 `settle` 在回复收尾时补上，否则提问再也没有计时器，会一直开着。
   */
  private async expire(sessionId: SessionId, questionId: QuestionId): Promise<void> {
    const item = this.openItem(sessionId, questionId);
    if (!item) return;
    if (this.inFlight.has(questionId)) {
      this.overdue.add(questionId);
      return;
    }
    try {
      await this.settle(sessionId, item, { kind: "timeout" });
    } catch (error) {
      if (error instanceof EnsembleError && error.code === "conflict") return;
      this.deps.log.warn("expiring an unanswered question failed", { sessionId, questionId, error });
    }
  }

  private async settle(sessionId: SessionId, item: QuestionItem, action: Action): Promise<ResolvedQuestion> {
    const { hub, notices, log, timeoutMs } = this.deps;
    const { questionId } = item;
    if (this.inFlight.has(questionId)) {
      throw new EnsembleError("conflict", "This question is already being resolved by someone else.", { questionId, status: "open" });
    }
    this.inFlight.add(questionId);
    try {
      const session = this.deps.connection(sessionId);
      let handedOff = false;
      let unsupported = false;
      if (session) {
        try {
          if (action.kind === "answer") {
            if (session.answerQuestion) handedOff = await session.answerQuestion(questionId, action.answers);
            else unsupported = true;
          } else if (session.declineQuestion) {
            handedOff = await session.declineQuestion(questionId, closingNote(action, timeoutMs));
          } else {
            unsupported = true;
          }
        } catch (error) {
          // 执行端拒绝了回复本身（取值不合它的要求）：它仍在等，不记任何结局，让调用方改了重答。时限到了的那次不走这里——没有人可以重答。
          if (error instanceof ReplyRejected && action.kind !== "timeout") {
            throw new EnsembleError("invalid_request", `The harness did not accept this reply: ${error.message}`, { questionId });
          }
          // 适配器按约定不为“已不再等待”抛异常；真抛了，就当作没有送达，不让提问悬在“待回答”上。
          log.warn("handing a question reply to the harness failed", { sessionId, questionId, error });
        }
      }
      if (unsupported && action.kind !== "timeout") {
        throw new EnsembleError("question_unsupported", "This harness cannot receive replies to its questions.", { questionId });
      }

      // 等待期间状态可能变了（运行结束、会话关闭）：以日志里已有的结局为准，不再写第二个。
      const current = this.openItem(sessionId, questionId);
      if (!current) {
        const latest = hub.state(sessionId);
        const settled = latest ? findQuestion(latest, questionId) : undefined;
        throw settled ? notOpen(settled) : new EnsembleError("not_found", `Session ${sessionId} has no question ${questionId}.`);
      }

      const resolution = resolutionOf(questionId, action, handedOff, unsupported, timeoutMs);
      const state = hub.state(sessionId);
      const event = hub.batch(() => {
        const committed = hub.emit(sessionId, {
          kind: "question.resolved",
          data: resolution,
          ...(current.runId ? { runId: current.runId } : {}),
          source: sourceOf(resolution.by),
        });
        // 用户在页面上直接回答（或不回答）了主 Agent 派发的子会话的提问：同步给主 Agent。
        if (state && handedOff && (resolution.outcome === "answered" || resolution.outcome === "declined")) {
          notices.syncQuestionResolved(state.meta, {
            outcome: resolution.outcome,
            question: questionPreview(current.prompts, 200),
            ...(resolution.answers ? { answerText: answersText(resolution.answers) } : {}),
            by: resolution.by,
          });
        }
        return committed;
      });

      const outcome: QuestionOutcomeRecord = {
        at: event?.at ?? isoNow(),
        by: resolution.by,
        ...(resolution.answers ? { answers: resolution.answers } : {}),
        ...(resolution.note ? { note: resolution.note } : {}),
        ...(resolution.reason ? { reason: resolution.reason } : {}),
        ...(resolution.delivery ? { delivery: resolution.delivery } : {}),
      };

      if (!handedOff && action.kind !== "timeout") {
        // 回复没有送达：提问已如实记为过期，调用方要知道自己的回答没有生效。
        throw new EnsembleError(
          "conflict",
          "The harness is no longer waiting for this question (its turn ended or it withdrew the question), so the reply was not delivered.",
          { questionId, status: "expired", reason: "not_waiting" },
        );
      }
      return { questionId, status: resolution.outcome, outcome };
    } finally {
      this.inFlight.delete(questionId);
      // 这次回复途中时限曾到点、被它挡了回去（见 expire）。回复若给了提问结局，disarm 已经把这笔记录撤掉；走到这里还在，
      // 说明回复没有结局（执行端拒绝了它），提问回到待回答，而它早已过了期——现在补上。必须在上面的 delete 之后：补上的那次要自己占住 inFlight。
      if (this.overdue.delete(questionId)) void this.expire(sessionId, questionId);
    }
  }
}

/** 把一次受理折成要写进日志的结局。 */
function resolutionOf(questionId: QuestionId, action: Action, handedOff: boolean, unsupported: boolean, timeoutMs: number): QuestionResolution {
  if (!handedOff) {
    // 没有送达：不论谁想回复，记录里都是系统观察到的事实——执行端已不再等待（没有连接时同理）。
    // 例外：时限到了而这个执行端根本接不了回复，原因仍是时限，也就没有“送达结果”可记。
    const untold = action.kind === "timeout" && unsupported;
    return {
      questionId,
      outcome: "expired",
      by: SYSTEM_ACTOR,
      reason: untold ? "timeout" : "not_waiting",
      ...(untold ? {} : { delivery: "not_waiting" as const }),
    };
  }
  switch (action.kind) {
    case "answer":
      return { questionId, outcome: "answered", by: action.by, answers: action.answers, delivery: "handed_off" };
    case "decline":
      return { questionId, outcome: "declined", by: action.by, ...(action.note ? { note: action.note } : {}), delivery: "handed_off" };
    case "timeout":
      return { questionId, outcome: "expired", by: SYSTEM_ACTOR, reason: "timeout", note: closingNote(action, timeoutMs), delivery: "handed_off" };
  }
}
