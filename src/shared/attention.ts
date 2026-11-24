import { LIMITS } from "./constants";
import { latestRunningTool, openQuestionItems, type SessionState } from "./projection";
import type { AttentionItem, AttentionKind, SessionStatus } from "./types";

/**
 * “值得留意”的事实（纯函数，时间通过参数传入）。
 *
 * 这里只做会话自己的判定；“另一个会话也写了同一个文件”需要跨会话的写入记录，由服务端的 AttentionSupervisor 追加。
 * 所有判定都只依据已提交的事件与时间戳，不依赖进程是否存活之类的猜测，也不下结论：
 * 静默既可能是在等一次很长的构建，也可能是卡住了，由看到它的人或主 Agent 去判断。
 */

export interface AttentionLimits {
  quietMs: number;
  longToolMs: number;
  longRunMs: number;
  undeliveredMs: number;
  sharedFileWindowMs: number;
}

export const ATTENTION_LIMITS: AttentionLimits = LIMITS.attention;

/** 会话正在做事：只有这两种状态里“没有事件”才有意义。 */
export function isWorking(status: SessionStatus): boolean {
  return status === "starting" || status === "running";
}

/** 还可能被继续使用（没有结束、失败或丢失）：消息没有生效只对这类会话有意义。 */
function isOpen(status: SessionStatus): boolean {
  return status !== "stopped" && status !== "failed" && status !== "lost";
}

export function deriveAttention(state: SessionState, now: number, limits: AttentionLimits = ATTENTION_LIMITS): AttentionItem[] {
  const items: AttentionItem[] = [];
  const runId = state.activeRunId;
  const withRun = runId ? { runId } : {};

  // 待回答的提问：会话还开着才算。已结束、失败或丢失的会话里没有人再能把回答送到执行端，
  // 投影也已把它们记为过期。不看时间——提问一落地就在，回答、撤回或过期的那一刻就没了。
  const questions = isOpen(state.status) ? openQuestionItems(state) : [];
  for (const question of questions) {
    items.push({
      kind: "question",
      since: question.at,
      questionId: question.questionId,
      prompts: question.prompts,
      ...(question.runId ? { runId: question.runId } : {}),
    });
  }

  if (isWorking(state.status)) {
    const silentMs = now - Date.parse(state.updatedAt);
    // 会话在等回答时的静默是预料之中的，而且提问本身已经是更具体的一条：不再另报 quiet / long_tool。
    // 先看静默时长再找工具：绝大多数会话每秒都有事件，这样热路径上不需要扫描时间线。
    if (questions.length === 0 && silentMs >= Math.min(limits.quietMs, limits.longToolMs)) {
      const tool = latestRunningTool(state);
      if (!tool && silentMs >= limits.quietMs) {
        items.push({ kind: "quiet", since: state.updatedAt, seq: state.seq, ...withRun });
      } else if (tool && silentMs >= limits.longToolMs) {
        items.push({
          kind: "long_tool",
          since: state.updatedAt,
          seq: state.seq,
          tool: { callId: tool.callId, name: tool.name, category: tool.category, title: tool.title, startedAt: tool.startedAt },
          ...withRun,
        });
      }
    }

    const run = runId ? state.runs.find((candidate) => candidate.id === runId) : undefined;
    if (run?.startedAt && now - Date.parse(run.startedAt) >= limits.longRunMs) {
      items.push({ kind: "long_run", since: run.startedAt, runId: run.id });
    }
  }

  if (isOpen(state.status)) {
    for (const message of state.messages) {
      const { stage, at } = message.delivery;
      // “已排队”是在等回合边界，等多久都属于正常；只有已记录或已交给执行端却迟迟没有生效才值得提。
      if ((stage === "recorded" || stage === "handed_off") && now - Date.parse(at) >= limits.undeliveredMs) {
        items.push({ kind: "undelivered", since: at, messageId: message.id, messageKind: message.kind, stage, ...(message.runId ? { runId: message.runId } : {}) });
      }
    }
  }

  return items;
}

/**
 * 同一件事在持续期间标识不变：调用方据此区分“新出现”与“一直都在”。
 * shared_file 以文件而不是时间为准，因为 since 会随着对方继续写入而推后。
 */
export function attentionKey(item: AttentionItem): string {
  switch (item.kind) {
    case "quiet":
      return `quiet|${item.since}`;
    case "long_tool":
      return `long_tool|${item.tool.callId}|${item.since}`;
    case "long_run":
      return `long_run|${item.runId ?? item.since}`;
    case "shared_file":
      return `shared_file|${item.path}`;
    case "undelivered":
      return `undelivered|${item.messageId}`;
    case "question":
      // 以提问为准：同一个提问持续期间标识不变，回答之后它的标识就不再出现。
      return `question|${item.questionId}`;
  }
}

/** 两组事实的标识与内容是否完全相同（决定要不要通知订阅者）。 */
export function sameAttention(a: readonly AttentionItem[] | undefined, b: readonly AttentionItem[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index];
    return other !== undefined && attentionKey(item) === attentionKey(other) && attentionDetail(item) === attentionDetail(other);
  });
}

/** 标识之外会随时间变化、且界面或 MCP 会显示的内容（目前只有 shared_file 的对方会话与最近写入）。 */
function attentionDetail(item: AttentionItem): string {
  return item.kind === "shared_file" ? `${item.since}|${item.withSessionIds.join(",")}` : "";
}

/** 展示时按严重程度排序：先是正在等人回答的提问，再是可能卡住的，持续很久的最后。 */
const SEVERITY: Record<AttentionKind, number> = {
  question: -1,
  quiet: 0,
  long_tool: 1,
  undelivered: 2,
  shared_file: 3,
  long_run: 4,
};

export function sortAttention(items: readonly AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => SEVERITY[a.kind] - SEVERITY[b.kind]);
}
