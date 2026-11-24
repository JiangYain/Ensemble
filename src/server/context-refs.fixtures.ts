/**
 * 仅供测试使用：会话引用展开的三份套件（context-refs.test.ts、context-refs.reject.test.ts、context-refs.merge.test.ts）共用的假中枢与造数据的辅助。
 *
 * 假中枢只实现 prepareSessionContext 用到的四个方法（`ContextRefHub`），它直接满足这个类型，不必硬转成 `EventHub`。
 * 冷会话与真正的中枢一样不能同步读事件（调用 `events()` 会抛），读它的日志只能走 `readEvents()`——
 * 这样“冷会话没有被解冻、没有被同步读”是被断言的，而不是碰巧成立。真中枢、管理器与 HTTP 的整条路径见 manager.context-refs.test.ts。
 *
 * 这里不放文件级的设置：取样时刻是注入文本的一部分，用到 `prepare` 的测试文件各自写 `beforeEach` / `afterEach` 把日期定住。
 */

import { LIMITS } from "@shared/constants";
import type { EnsembleEvent } from "@shared/events";
import type { HandoffPart } from "@shared/handoff";
import { finish, say, startRun } from "@shared/handoff.fixtures";
import { EventLog } from "@shared/testing";
import type { ContextItem, HarnessId, ModelRef, SessionPhase, SessionSummary } from "@shared/types";
import { expect } from "vitest";
import { prepareSessionContext, type ContextRefHub } from "./context-refs";
import { EnsembleError } from "./errors";

export const CAP = LIMITS.contextSession;
export const AT = "2026-03-04T05:06:07.000Z";
export const HEAD = "\n\n---\nContext provided with this task:\n\n";
export const UP = "ses_up";
export const ANSWER = "Parser fixed.\nAll tests pass.";
export const SOURCE_TAIL = "Copied verbatim from that session's own event log by the Ensemble service; nothing below was retold.";

export interface Spec {
  title?: string;
  harness?: HarnessId;
  model?: ModelRef;
  phase?: SessionPhase;
  /** 在内存里（热）还是只在磁盘上（冷，缺省）。 */
  hot?: boolean;
}

export interface Fake {
  summary: SessionSummary;
  events: EnsembleEvent[];
  hot: boolean;
}

/** 只填取样用到的字段（标题、执行端、模型、阶段、序号）。 */
export function summaryOf(id: string, spec: Spec, seq: number): SessionSummary {
  return {
    id,
    title: spec.title ?? "Upstream task",
    harness: spec.harness ?? "codex",
    ...(spec.model ? { model: spec.model } : {}),
    phase: spec.phase ?? "done",
    seq,
  } as SessionSummary;
}

export function fake(id: string, spec: Spec = {}, build: (log: EventLog) => void = () => undefined): Fake {
  const log = new EventLog(id);
  log.created();
  build(log);
  return { summary: summaryOf(id, spec, log.events.length), events: log.events, hot: spec.hot ?? false };
}

/** 一次运行、一条最终回答的上游。 */
export function answered(id = UP, spec: Spec = {}, answer = ANSWER): Fake {
  return fake(id, spec, (log) => {
    startRun(log, "run_1", 1);
    say(log, "run_1", "item_0", answer, "final");
    finish(log, "run_1");
  });
}

export class FakeHub implements ContextRefHub {
  readonly sessions = new Map<string, Fake>();
  /** `readEvents` 读过的会话，按次序：热会话不该出现在这里。 */
  readonly reads: string[] = [];
  /** 每次读磁盘之后（返回的事件已经定下）执行：用来模拟“读的过程中上游又变了”。 */
  onRead: (() => void) | undefined;

  constructor(...sessions: Fake[]) {
    for (const session of sessions) this.sessions.set(session.summary.id, session);
  }

  summary(id: string): SessionSummary | undefined {
    return this.sessions.get(id)?.summary;
  }

  isHot(id: string): boolean {
    return this.sessions.get(id)?.hot === true;
  }

  /** 与真正的中枢一致：冷会话不能同步读事件。 */
  events(id: string): EnsembleEvent[] {
    const session = this.sessions.get(id);
    if (!session?.hot) throw new Error(`Session ${id} is not in memory; read its events with readEvents().`);
    return session.events;
  }

  async readEvents(id: string): Promise<EnsembleEvent[]> {
    this.reads.push(id);
    const events = [...(this.sessions.get(id)?.events ?? [])];
    this.onRead?.();
    return events;
  }
}

export const prepare = (hub: FakeHub, items: ContextItem[], task = "Review the fix") => prepareSessionContext(hub, task, items);
export const ref = (sessionId: string, extra: { include?: HandoffPart[]; note?: string } = {}): ContextItem => ({ kind: "session", sessionId, ...extra });

export async function rejection(promise: Promise<unknown>): Promise<EnsembleError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(EnsembleError);
    return error as EnsembleError;
  }
  throw new Error("expected the call to be rejected");
}
