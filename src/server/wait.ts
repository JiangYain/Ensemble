import { attentionKey } from "@shared/attention";
import { LIMITS } from "@shared/constants";
import type { RaisedAttention, WaitReason, WaitRequest, WaitResponse } from "@shared/protocol";
import { isSessionSettled } from "@shared/session-end";
import type { AttentionItem, SessionSummary } from "@shared/types";
import { EnsembleError } from "./errors";
import type { EventHub } from "./hub";
import type { NoticeCenter } from "./notices";

/**
 * 长轮询：等待所指定的会话结束（或需要关注）。
 * 返回条件：会话已落定 / 发起端有未送达的干预通知 / 等待期间有会话出现新的“值得留意”事项 / 超时。
 * 主 Agent 因此不需要反复轮询状态，也不会错过用户在网页上的纠正，或一个静默了很久的会话。
 *
 * “新的”以等待开始时的状态为基线：开始时就存在的事项不会让这次等待立刻返回
 * （否则对一个持续静默的会话反复调用 wait 会不停地立即返回），它们随会话摘要一起带回。
 *
 * 提问（执行端停下来等一个回答，不是授权）是例外，它有自己的规则：
 * - 它是一个请求而不是“可能出了问题的迹象”，所以不受 `attention=false` 影响；
 * - 它不以等待开始时的状态为基线——等待开始前就已经存在、但这个发起端还没被告知过的提问，会让 wait 立刻返回
 *   （否则主 Agent 在两次 wait 之间错过的提问，会因为“开始时就存在”而永远不被提起）；
 * - 反过来，一旦在某次响应里告知过，之后的 wait 就把它当作已知（同一个提问不会让每次 wait 都立刻返回），
 *   直到它有了结局。“告知过”记在 NoticeCenter 里，按发起端区分；调用方已断开的那一次不算。
 */
export async function waitForSessions(
  deps: {
    hub: EventHub;
    notices: NoticeCenter;
    /** 调用方认识“提问”这种事项（见 ACCEPTS_HEADER）；老桥不认识，默认认识。 */
    questions?: boolean;
  },
  request: WaitRequest,
  signal: AbortSignal,
): Promise<WaitResponse> {
  const { hub, notices } = deps;
  const withQuestions = deps.questions !== false;
  for (const id of request.sessionIds) {
    if (!hub.has(id)) throw new EnsembleError("not_found", `Session ${id} does not exist.`);
  }
  const mode = request.mode ?? "all_settled";
  const timeoutMs = Math.min(request.timeoutMs ?? LIMITS.maxWaitMs, LIMITS.maxWaitMs);

  const snapshot = (): SessionSummary[] =>
    request.sessionIds.flatMap((id) => {
      const summary = hub.summary(id);
      return summary ? [withQuestions ? summary : withoutQuestions(summary)] : [];
    });

  const keyOf = (sessionId: string, item: AttentionItem): string => `${sessionId}|${attentionKey(item)}`;
  // 基线里没有提问：提问不看“开始时是否已存在”，而看这个发起端是否已被告知。
  const known = new Set(
    snapshot().flatMap((summary) => (summary.attention ?? []).filter((item) => item.kind !== "question").map((item) => keyOf(summary.id, item))),
  );
  const raised = (): RaisedAttention[] =>
    snapshot().flatMap((summary) =>
      (summary.attention ?? [])
        .filter((item) =>
          item.kind === "question"
            ? !notices.wasTold(request.originKey, item.questionId)
            : request.attention !== false && !known.has(keyOf(summary.id, item)),
        )
        .map((item) => ({ sessionId: summary.id, item })),
    );

  const evaluate = (): WaitReason | undefined => {
    const sessions = snapshot();
    if (request.originKey && notices.peek(request.originKey).length > 0) return "notice";
    const settled = sessions.filter(isSessionSettled).length;
    const removed = request.sessionIds.length - sessions.length;
    if (mode === "any_settled" ? settled + removed > 0 : settled === sessions.length) return "settled";
    if (raised().length > 0) return "attention";
    return undefined;
  };

  /** `deliver` 为 false 表示这份响应没有人会收到（调用方已断开）：不记“已告知”，它下次来时仍能看到这个提问。 */
  const respond = (reason: WaitReason, deliver = true): WaitResponse => {
    const newlyRaised = raised();
    const questionIds = newlyRaised.flatMap(({ item }) => (item.kind === "question" ? [item.questionId] : []));
    if (deliver && questionIds.length > 0) notices.markTold(request.originKey, questionIds);
    return { reason, sessions: snapshot(), ...(newlyRaised.length > 0 ? { raised: newlyRaised } : {}) };
  };

  const immediate = evaluate();
  if (immediate) return respond(immediate, !signal.aborted);
  if (timeoutMs === 0 || signal.aborted) return respond("timeout", !signal.aborted);

  return new Promise<WaitResponse>((resolve) => {
    let done = false;
    const finish = (reason: WaitReason, deliver = true): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener("abort", onAbort);
      resolve(respond(reason, deliver));
    };
    const onAbort = (): void => finish("timeout", false);
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    const unsubscribe = hub.subscribe(() => {
      const reason = evaluate();
      if (reason) finish(reason);
    });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 调用方不认识“提问”（老桥）：给它的摘要里不带这类事项，也不会为它被唤醒；其余原样。 */
function withoutQuestions(summary: SessionSummary): SessionSummary {
  if (!summary.attention?.some((item) => item.kind === "question")) return summary;
  const { attention, ...rest } = summary;
  const remaining = (attention ?? []).filter((item) => item.kind !== "question");
  return remaining.length > 0 ? { ...rest, attention: remaining } : rest;
}
