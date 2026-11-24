import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog } from "@shared/testing";
import type { SessionSummary } from "@shared/types";
import { store } from "./app";
import { cancelRuns, removeSessions, reportBatch, stopSessions, type BatchOutcome } from "./batch";
import { bindT } from "./i18n";

function summary(id: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  const log = new EventLog(id);
  log.created({ id, harness: "cursor", runtime: "native" });
  return { ...toSummary(replay(log.events)!), seq: 5, ...patch };
}

function stubFetch(handler: (method: string, id: string, action: string) => { status?: number; body: unknown }) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const match = /\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/.exec(path)!;
      const method = init?.method ?? "GET";
      calls.push(`${method} ${match[1]}${match[2] ? `/${match[2]}` : ""}`);
      const result = handler(method, match[1]!, match[2] ?? "");
      const status = result.status ?? 200;
      return { ok: status < 400, status, text: async () => JSON.stringify(result.body) };
    }),
  );
  return calls;
}

describe("批量动作：对每个会话调用与单个会话相同的接口，并如实汇总", () => {
  beforeEach(() => {
    store.set({ sessions: { a: summary("a"), b: summary("b"), c: summary("c") }, toasts: [] });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    store.set({ sessions: {}, toasts: [] });
  });

  it("中断：被中断或撤掉了排队消息算成功；请求发出时已经没有可做的事算“当时没有”，不冒充成功", async () => {
    const calls = stubFetch((_method, id) => ({
      body: { summary: summary(id, { seq: 9 }), interrupted: id === "a", cancelledQueued: id === "b" ? 2 : 0 },
    }));
    const outcome = await cancelRuns(["a", "b", "c"]);
    expect(calls.sort()).toEqual(["POST a/cancel", "POST b/cancel", "POST c/cancel"]);
    expect(outcome).toEqual({ ok: ["a", "b"], idle: ["c"], failed: [] });
    // 返回的最新摘要写回了 store。
    expect(store.get().sessions["a"]!.seq).toBe(9);
  });

  it("关闭：成功的写回最新摘要，失败的带着服务端给的原因，其余不受牵连", async () => {
    stubFetch((_method, id) =>
      id === "b" ? { status: 409, body: { error: { code: "conflict", message: "执行端没有响应" } } } : { body: { summary: summary(id, { status: "stopped", phase: "stopped", seq: 8 }) } },
    );
    const outcome = await stopSessions(["a", "b", "c"]);
    expect(outcome.ok).toEqual(["a", "c"]);
    expect(outcome.idle).toEqual([]);
    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0]).toMatchObject({ id: "b" });
    expect(outcome.failed[0]!.reason).toContain("执行端没有响应");
    expect(store.get().sessions["a"]!.status).toBe("stopped");
    expect(store.get().sessions["b"]!.status).not.toBe("stopped");
  });

  it("删除：只有成功的从 store 里消失，失败的留着；并发完成也不会互相覆盖", async () => {
    const calls = stubFetch((_method, id) => (id === "c" ? { status: 500, body: { error: { code: "internal", message: "boom" } } } : { body: { removed: id } }));
    const outcome = await removeSessions(["a", "b", "c"]);
    expect(calls.sort()).toEqual(["DELETE a", "DELETE b", "DELETE c"]);
    expect(outcome.ok).toEqual(["a", "b"]);
    expect(outcome.failed.map((item) => item.id)).toEqual(["c"]);
    expect(Object.keys(store.get().sessions)).toEqual(["c"]);
  });

  it("网络错误也归为失败，不抛出", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    const outcome = await stopSessions(["a", "b"]);
    expect(outcome.ok).toEqual([]);
    expect(outcome.failed.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("空列表不发请求", async () => {
    const calls = stubFetch(() => ({ body: {} }));
    expect(await removeSessions([])).toEqual({ ok: [], idle: [], failed: [] });
    expect(calls).toEqual([]);
  });
});

describe("reportBatch：提示的颜色与文案跟随真实结果", () => {
  const zh = bindT("zh");
  const en = bindT("en");
  const outcome = (ok: number, idle: number, failed: number): BatchOutcome => ({
    ok: Array.from({ length: ok }, (_, index) => `ok${index}`),
    idle: Array.from({ length: idle }, (_, index) => `idle${index}`),
    failed: Array.from({ length: failed }, (_, index) => ({ id: `bad${index}`, reason: `原因${index}` })),
  });
  const last = () => store.get().toasts.at(-1)!;

  beforeEach(() => store.set({ toasts: [] }));
  afterEach(() => store.set({ toasts: [] }));

  it("全部成功：绿色，只写成功数", () => {
    reportBatch("关闭会话", outcome(3, 0, 0), zh);
    expect(last()).toMatchObject({ tone: "success", text: "关闭会话：3 个已完成" });
  });

  it("全部都是“当时没有可做的事”：中性提示", () => {
    reportBatch("中断当前运行", outcome(0, 2, 0), zh);
    expect(last()).toMatchObject({ tone: "info", text: "中断当前运行：2 个当时已没有可中断的运行" });
  });

  it("部分失败：黄色，带成功数、失败数与第一个失败的原因", () => {
    reportBatch("删除记录", outcome(2, 0, 1), zh);
    expect(last()).toMatchObject({ tone: "warn", text: "删除记录：2 个已完成，1 个失败（原因0）" });
    reportBatch("中断当前运行", outcome(1, 1, 1), zh);
    expect(last()).toMatchObject({ tone: "warn", text: "中断当前运行：1 个已完成，1 个当时已没有可中断的运行，1 个失败（原因0）" });
  });

  it("全部失败：红色", () => {
    reportBatch("关闭会话", outcome(0, 0, 2), zh);
    expect(last()).toMatchObject({ tone: "error", text: "关闭会话：2 个失败（原因0）" });
  });

  it("英文文案", () => {
    reportBatch("Close session", outcome(2, 0, 1), en);
    expect(last().tone).toBe("warn");
    expect(last().text).toMatch(/^Close session: 2 done, 1 failed/);
    expect(last().text).toContain("原因0");
  });
});
