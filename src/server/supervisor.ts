import { resolve } from "node:path";
import { ATTENTION_LIMITS, deriveAttention, isWorking, sortAttention, type AttentionLimits } from "@shared/attention";
import type { AttentionItem, SessionId } from "@shared/types";
import type { EventHub } from "./hub";
import type { Logger } from "./logger";

/** 同一个会话最多同时提示几个共写的文件，避免两个会话各自改了一大批文件时淹没其他信息（保留最近写入的）。 */
const MAX_SHARED_FILES = 6;

type SharedFileItem = Extract<AttentionItem, { kind: "shared_file" }>;

export interface SupervisorOptions {
  hub: EventHub;
  log: Logger;
  limits?: AttentionLimits;
  /** 周期复查间隔：静默、持续过久都是随时间成立的，没有新事件也要定期看。 */
  tickMs?: number;
  /** 事件到来后，最多隔这么久复查一次（让“恢复了”尽快反映出来，又不必每条事件都算）。 */
  settleMs?: number;
  now?: () => number;
}

/**
 * 看守所有会话：把“值得留意”的事实（静默、工具无响应、运行过久、同时写同一个文件、消息没生效）登记到 hub，
 * 由 hub 像事件一样推送给网页与 wait。它只读取 hub 里已有的事件和状态，不探测进程、不读文件，
 * 因此陈述的都是有事件依据的事实；会话自己的判定在 `shared/attention.ts`，这里补上需要跨会话记录的部分。
 */
export class AttentionSupervisor {
  /** 规范化路径 → 各会话最近一次写入它的时间（毫秒）。 */
  private readonly writes = new Map<string, { display: string; at: Map<SessionId, number> }>();
  private readonly hub: EventHub;
  private readonly log: Logger;
  private readonly limits: AttentionLimits;
  private readonly tickMs: number;
  private readonly settleMs: number;
  private readonly now: () => number;
  private unsubscribe: (() => void) | undefined;
  private tick: NodeJS.Timeout | undefined;
  private settle: NodeJS.Timeout | undefined;

  constructor(options: SupervisorOptions) {
    this.hub = options.hub;
    this.log = options.log;
    this.limits = options.limits ?? ATTENTION_LIMITS;
    this.tickMs = options.tickMs ?? 10_000;
    this.settleMs = options.settleMs ?? 1_000;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.hub.subscribe((change) => {
      // 归档只是界面上的整理，不影响任何一条“值得留意”的判断。
      if (change.type === "attention" || change.type === "archive") return;
      if (change.type === "event" && change.event.kind === "file.changed") this.recordWrites(change.event.sessionId, change.event.at, change.event.data.files.map((file) => file.path), change.state.meta.cwd);
      // 提问是一个请求，不是随时间才成立的迹象：它落地的那一刻就该出现在“值得留意”里，回答、过期的那一刻就该消失，
      // 不等常规的合并窗口（否则等着的 wait 要多等一秒才被唤醒）。
      if (change.type === "event" && (change.event.kind === "question.asked" || change.event.kind === "question.resolved")) {
        this.expedite();
        return;
      }
      this.schedule();
    });
    this.tick = setInterval(() => this.safely(), this.tickMs);
    this.tick.unref?.();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.tick) clearInterval(this.tick);
    if (this.settle) clearTimeout(this.settle);
    this.tick = undefined;
    this.settle = undefined;
  }

  /** 立即按当前时间复查所有会话。 */
  recompute(): void {
    const now = this.now();
    this.prune(now);
    const shared = this.sharedFiles(now);
    // 一轮复查先全部写入、再统一通知：否则在“两个会话共写同一文件”这类关联提示里，
    // 订阅者（wait、SSE）会在第一个会话已更新、第二个还没更新时读到半轮结果。
    this.hub.batch(() => {
      // 只复查内存里的会话：冷会话是稳定、已结束的，没有“值得留意”的事，也不该为了复查去读它们。
      for (const sessionId of this.hub.hotIds()) {
        const state = this.hub.state(sessionId);
        if (!state) continue;
        this.hub.setAttention(sessionId, sortAttention([...deriveAttention(state, now, this.limits), ...(shared.get(sessionId) ?? [])]));
      }
    });
  }

  private schedule(delayMs: number = this.settleMs): void {
    if (this.settle) return;
    this.settle = setTimeout(() => {
      this.settle = undefined;
      this.safely();
    }, delayMs);
    this.settle.unref?.();
  }

  /** 比常规合并窗口更急的一次复查：已经排着的那次让位，在当前这批通知结束后立刻算。 */
  private expedite(): void {
    if (this.settle) clearTimeout(this.settle);
    this.settle = undefined;
    this.schedule(0);
  }

  private safely(): void {
    try {
      this.recompute();
    } catch (error) {
      this.log.error("attention recompute failed", { error });
    }
  }

  private recordWrites(sessionId: SessionId, at: string, paths: readonly string[], cwd: string): void {
    const time = Date.parse(at);
    if (!Number.isFinite(time)) return;
    for (const path of paths) {
      const absolute = resolve(cwd, path);
      const key = normalizePath(absolute);
      const entry = this.writes.get(key) ?? { display: absolute, at: new Map() };
      entry.at.set(sessionId, time);
      this.writes.set(key, entry);
    }
  }

  private prune(now: number): void {
    for (const [key, entry] of this.writes) {
      for (const [sessionId, time] of entry.at) {
        if (now - time > this.limits.sharedFileWindowMs || !this.hub.has(sessionId)) entry.at.delete(sessionId);
      }
      if (entry.at.size === 0) this.writes.delete(key);
    }
  }

  /** 每个正在工作的会话各自的“同时写了同一个文件”事项。 */
  private sharedFiles(now: number): Map<SessionId, SharedFileItem[]> {
    const result = new Map<SessionId, SharedFileItem[]>();
    const working = (sessionId: SessionId): boolean => {
      const state = this.hub.state(sessionId);
      return state !== undefined && isWorking(state.status);
    };
    for (const entry of this.writes.values()) {
      const writers = [...entry.at].filter(([sessionId, time]) => now - time <= this.limits.sharedFileWindowMs && working(sessionId));
      if (writers.length < 2) continue;
      for (const [sessionId, time] of writers) {
        const others = writers.filter(([other]) => other !== sessionId);
        const since = new Date(Math.max(time, ...others.map(([, at]) => at))).toISOString();
        const list = result.get(sessionId) ?? [];
        list.push({ kind: "shared_file", since, path: entry.display, withSessionIds: others.map(([other]) => other).sort() });
        result.set(sessionId, list);
      }
    }
    for (const [sessionId, list] of result) {
      result.set(sessionId, list.sort((a, b) => b.since.localeCompare(a.since) || a.path.localeCompare(b.path)).slice(0, MAX_SHARED_FILES));
    }
    return result;
  }
}

/** Windows 与 macOS 的文件系统默认不区分大小写，同一个文件可能被写成不同的大小写。 */
function normalizePath(path: string): string {
  const unified = path.replace(/\\/g, "/");
  return process.platform === "win32" || process.platform === "darwin" ? unified.toLowerCase() : unified;
}
