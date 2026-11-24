import type { SessionId } from "@shared/types";
import { api } from "./api";
import { errorText, forgetSession, patchSummary, toast } from "./app";
import type { TFunction } from "./i18n";

/**
 * 多选菜单里“对选中的每个会话做同一件事”。每个会话调用的都是单个会话菜单用的同一个服务端接口
 * （`api.cancel` / `api.stop` / `api.remove`）；这里只是把它们并发发出去，并如实汇总：成功几个、失败几个、失败的原因。
 */
export interface BatchOutcome {
  /** 执行成功的会话。 */
  ok: SessionId[];
  /** 请求发出去了，但那一刻已经没有可做的事（中断时：运行恰好刚结束）。不算成功，也不算失败。 */
  idle: SessionId[];
  failed: { id: SessionId; reason: string }[];
}

async function runEach(ids: readonly SessionId[], task: (id: SessionId) => Promise<"ok" | "idle">): Promise<BatchOutcome> {
  const settled = await Promise.all(
    ids.map(async (id) => {
      try {
        return { id, failed: false, result: await task(id) } as const;
      } catch (error) {
        return { id, failed: true, reason: errorText(error) } as const;
      }
    }),
  );
  const outcome: BatchOutcome = { ok: [], idle: [], failed: [] };
  for (const item of settled) {
    if (item.failed) outcome.failed.push({ id: item.id, reason: item.reason });
    else if (item.result === "ok") outcome.ok.push(item.id);
    else outcome.idle.push(item.id);
  }
  return outcome;
}

export function cancelRuns(ids: readonly SessionId[]): Promise<BatchOutcome> {
  return runEach(ids, async (id) => {
    const response = await api.cancel(id);
    patchSummary(response.summary);
    return response.interrupted || response.cancelledQueued > 0 ? "ok" : "idle";
  });
}

export function stopSessions(ids: readonly SessionId[]): Promise<BatchOutcome> {
  return runEach(ids, async (id) => {
    const response = await api.stop(id);
    patchSummary(response.summary);
    return "ok";
  });
}

export function removeSessions(ids: readonly SessionId[]): Promise<BatchOutcome> {
  return runEach(ids, async (id) => {
    await api.remove(id);
    forgetSession(id);
    return "ok";
  });
}

/** 把批量结果如实告诉用户：全部成功是绿色，部分失败是黄色并带原因，全部失败是红色。 */
export function reportBatch(action: string, outcome: BatchOutcome, t: TFunction): void {
  const { ok, idle, failed } = outcome;
  const tone = failed.length === 0 ? (ok.length > 0 ? "success" : "info") : ok.length + idle.length > 0 ? "warn" : "error";
  const reason = failed[0]?.reason ?? "";
  toast(tone, t("batch.result", { action, ok: ok.length, idle: idle.length, failed: failed.length, reason }), failed.length > 0 ? 6000 : 4200);
}
