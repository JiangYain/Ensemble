import type { SessionSummary } from "@shared/types";
import type { ServiceClient } from "./client";
import type { Call } from "./tool-call";

/**
 * `status`、`wait`、`read` 共用的几件小事：取会话清单、挑出这个来源名下的会话、把摘要压成结构化结果里的一项。
 * 单独放一个文件，是为了让工具文件之间不必互相依赖。
 */

/**
 * 全部会话，含已归档的：新服务默认不返回已归档的，所以明确要 include（`follows` 要能接在已归档的会话后面、
 * `status` 要能点名读已归档的、被略去的数量要能数出来）。老服务不认这个参数、本来就返回全部，也没有归档这回事——不报错、不需要先协商。
 * 要不要把已归档的列给主 Agent 由调用方按 `archivedAt` 决定（`status` 默认不列并说明数量，`wait` 的默认范围不含它们）。
 */
export async function fetchAllSessions(client: Pick<ServiceClient, "request">): Promise<SessionSummary[]> {
  return (await client.request<{ sessions: SessionSummary[] }>("GET", "/api/sessions?archived=include")).sessions;
}

/** 这个来源（这段对话）名下的会话。 */
export function sessionsOfOrigin(all: readonly SessionSummary[], { origin }: Call): SessionSummary[] {
  return all.filter((session) => session.origin.key === origin.key);
}

export function compactSession(summary: SessionSummary): Record<string, unknown> {
  return {
    id: summary.id,
    harness: summary.harness,
    title: summary.title,
    phase: summary.phase,
    // 最近一条事件的序号：可以直接当作 `read` 的 `afterSeq`，省得先读一遍才拿到游标。
    seq: summary.seq,
    activity: summary.activity.kind,
    progress: { done: summary.progress.done, ...(summary.progress.total !== undefined ? { total: summary.progress.total } : {}), steps: summary.progress.steps },
    runCount: summary.runCount,
    ...(summary.model?.resolved || summary.model?.requested ? { model: summary.model.resolved ?? summary.model.requested } : {}),
    ...(summary.lastError ? { error: summary.lastError.code } : {}),
    ...(summary.attention?.length
      ? { attention: summary.attention.map((item) => ({ kind: item.kind, since: item.since, ...(item.kind === "question" ? { questionId: item.questionId } : {}) })) }
      : {}),
    ...(summary.archivedAt ? { archived: true } : {}),
  };
}
