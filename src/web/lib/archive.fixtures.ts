import { vi } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog } from "@shared/testing";
import type { SessionSummary } from "@shared/types";

/**
 * 归档相关的网页测试共用的小零件（只被测试引用，不进页面的打包）：造会话摘要、假 fetch、可手动放行的闸门。
 * 摘要用真实的投影造出来（和 batch.test.ts 同一个办法），再用 patch 盖掉要测的字段，免得手写一份不完整的摘要。
 */

export const ARCHIVED_AT = "2026-11-20T08:00:00.000Z";

export function summary(id: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  const log = new EventLog(id);
  log.created({ id, harness: "cursor", runtime: "native", title: id });
  return { ...toSummary(replay(log.events)!), seq: 5, ...patch };
}

/** 已归档的会话摘要：序号不变（归档不是事件，不推进序号）。 */
export function archivedSummary(id: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  return summary(id, { phase: "done", archivedAt: ARCHIVED_AT, archivedBy: "user", ...patch });
}

export interface FetchCall {
  method: string;
  path: string;
  body?: unknown;
}

export interface FetchReply {
  status?: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

/** 按请求应答的假 fetch；handler 可以是异步的，用来把应答卡在半路。返回按顺序记下的请求（请求在应答之前就记下了）。 */
export function stubApi(handler: (call: FetchCall) => FetchReply | Promise<FetchReply>): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const call: FetchCall = { method: init?.method ?? "GET", path, ...(init?.body !== undefined ? { body: JSON.parse(String(init.body)) } : {}) };
      calls.push(call);
      const reply = await handler(call);
      const status = reply.status ?? 200;
      const text = reply.text ?? JSON.stringify(reply.body ?? {});
      const headers = reply.headers ?? {};
      return { ok: status < 400, status, text: async () => text, headers: { get: (name: string) => headers[name.toLowerCase()] ?? null } };
    }),
  );
  return calls;
}

/** 手动放行的闸门：让一个请求停在半路，测“在途时”的行为。 */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
