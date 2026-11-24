import { isoNow } from "@shared/format";
import { newId } from "@shared/ids";
import type { Actor, Message, Notice, NoticeKind, SessionId, SessionMeta } from "@shared/types";
import type { EventHub } from "./hub";

/** 每个发起端最多记多少个“已告知”的提问编号。 */
const MAX_TOLD_PER_ORIGIN = 200;

/**
 * 干预通知中心：用户直接对子会话做的纠正、中断、停止，需要同步给发起它的主 Agent。
 * 主 Agent 并不会被推送（MCP 工具调用是它主动发起的），所以通知留在这里，
 * 在它下一次调用任何 Ensemble 工具时随工具结果一起带回，并记录送达时间。
 */
export class NoticeCenter {
  private readonly pending = new Map<string, Notice>();
  /**
   * 各发起端已经被 `wait` 告知过的提问（originKey → questionId）。只在内存里：服务重启后仍待回答的提问都会过期，
   * 没有需要记的。它让“提问”像干预通知一样只告知一次——否则主 Agent 决定先等用户、再调一次 wait 时，
   * 同一个还没回答的提问会让每次 wait 都立刻返回（见 wait.ts）。
   */
  private readonly told = new Map<string, Set<string>>();

  constructor(private readonly hub: EventHub) {}

  /**
   * 启动时从事件日志重建尚未送达的通知。只读内存里的会话：有未送达通知的会话不会被冷存
   * （hub 载入时不采信这样的快照、运行中也不冻结它），所以冷会话里不可能有要重建的通知。
   */
  rebuild(): void {
    this.pending.clear();
    for (const sessionId of this.hub.hotIds()) {
      for (const event of this.hub.events(sessionId)) {
        if (event.kind === "notice.created") this.pending.set(event.data.notice.id, event.data.notice);
        else if (event.kind === "notice.delivered") {
          for (const id of event.data.noticeIds) this.pending.delete(id);
        }
      }
    }
  }

  create(input: {
    sessionId: SessionId;
    originKey: string;
    kind: NoticeKind;
    summary: string;
    text?: string;
    message?: Pick<Message, "id">;
  }): Notice {
    const notice: Notice = {
      id: newId("ntc"),
      originKey: input.originKey,
      sessionId: input.sessionId,
      kind: input.kind,
      createdAt: isoNow(),
      summary: input.summary,
      ...(input.text ? { text: input.text } : {}),
      ...(input.message ? { messageId: input.message.id } : {}),
    };
    this.pending.set(notice.id, notice);
    this.hub.emit(input.sessionId, { kind: "notice.created", data: { notice }, source: "ensemble" });
    return notice;
  }

  /**
   * 用户在页面上直接干预了一个由主 Agent 派发的子会话：给这个主 Agent 留一条通知。
   * 用户自己发起的会话没有主 Agent 需要知道；不是用户做的操作（例如系统清理）也不算用户干预。
   */
  syncIntervention(meta: SessionMeta, kind: NoticeKind, who: { message?: Message; by?: Actor } = {}): void {
    const { origin } = meta;
    if (origin.kind !== "agent") return;
    if (who.by && who.by.kind !== "user") return;
    const { message } = who;
    this.create({
      sessionId: meta.id,
      originKey: origin.key,
      kind,
      summary: interventionSummary(kind, meta, message),
      ...(message ? { text: message.text, message } : {}),
    });
  }

  /**
   * 用户在页面上直接回答（或选择不回答）了一个由主 Agent 派发的子会话的提问：给这个主 Agent 留一条通知，
   * 让它知道子会话已经按这个答案往下走了。主 Agent 自己的回答不必同步给它自己，
   * 系统的收尾（过期、时限）也不是用户的操作。复用 "intervention" 这个种类：这就是用户对子会话的一次直接干预。
   */
  syncQuestionResolved(
    meta: SessionMeta,
    input: { outcome: "answered" | "declined"; question: string; answerText?: string; by: Actor },
  ): void {
    const { origin } = meta;
    if (origin.kind !== "agent" || input.by.kind !== "user") return;
    const session = `"${meta.title}" (${meta.harness}, ${meta.id})`;
    const verb = input.outcome === "answered"
      ? "answered the question asked by"
      : "chose not to answer the question asked by (and told it to use its own judgment)";
    this.create({
      sessionId: meta.id,
      originKey: origin.key,
      kind: "intervention",
      summary: `The user ${verb} delegated session ${session} directly from the Ensemble panel. The question was: "${input.question}"`,
      ...(input.answerText ? { text: input.answerText } : {}),
    });
  }

  /** 这个发起端是否已经被 wait 告知过这个提问。没有 originKey 的调用方共用一份。 */
  wasTold(originKey: string | undefined, questionId: string): boolean {
    return this.told.get(originKey ?? "")?.has(questionId) ?? false;
  }

  /** 记下这个发起端已经被告知这些提问（只在响应真的交给了调用方之后记）。 */
  markTold(originKey: string | undefined, questionIds: Iterable<string>): void {
    const key = originKey ?? "";
    const set = this.told.get(key) ?? new Set<string>();
    for (const id of questionIds) set.add(id);
    // 只增不减会无限长；提问编号不会复用，最早记下的那些早已有了结局，丢掉它们没有影响。
    for (const oldest of set) {
      if (set.size <= MAX_TOLD_PER_ORIGIN) break;
      set.delete(oldest);
    }
    this.told.set(key, set);
  }

  peek(originKey: string): Notice[] {
    return [...this.pending.values()]
      .filter((n) => n.originKey === originKey)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** 取走并标记送达：每个会话记录一条 notice.delivered，页面据此显示“已同步给主 Agent”。 */
  collect(originKey: string): Notice[] {
    const notices = this.peek(originKey);
    if (notices.length === 0) return [];
    const at = isoNow();
    const bySession = new Map<SessionId, Notice[]>();
    for (const notice of notices) {
      const list = bySession.get(notice.sessionId) ?? [];
      list.push(notice);
      bySession.set(notice.sessionId, list);
      this.pending.delete(notice.id);
    }
    for (const [sessionId, list] of bySession) {
      this.hub.emit(sessionId, {
        kind: "notice.delivered",
        data: {
          noticeIds: list.map((n) => n.id),
          messageIds: list.flatMap((n) => (n.messageId ? [n.messageId] : [])),
          at,
        },
        source: "ensemble",
      });
    }
    return notices.map((n) => ({ ...n, deliveredAt: at }));
  }

  pendingCount(originKey?: string): number {
    if (!originKey) return this.pending.size;
    return this.peek(originKey).length;
  }
}

/** 写给主 Agent 的一句话：用户在页面上直接对哪个子会话做了什么。 */
function interventionSummary(kind: NoticeKind, meta: SessionMeta, message: Message | undefined): string {
  const session = `"${meta.title}" (${meta.harness}, ${meta.id})`;
  switch (kind) {
    case "intervention":
      return `The user sent ${message?.kind === "steer" ? "a correction" : "a follow-up instruction"} directly to delegated session ${session} from the Ensemble panel.`;
    case "cancel":
      return `The user requested an interruption or cancelled queued work in delegated session ${session} from the Ensemble panel.`;
    case "stop":
      return `The user closed delegated session ${session} from the Ensemble panel.`;
  }
}
