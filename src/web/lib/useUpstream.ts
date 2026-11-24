import { useEffect } from "react";
import type { SessionId, SessionSummary } from "@shared/types";
import { store } from "./app";
import { loadArchived } from "./archive";
import { useStore } from "./store";

/**
 * 会话引用（context 的 session 条目）指向的上游会话现在还在不在：
 * - found：未归档或已归档的两张表里认得它，摘要在 `summary` 里；
 * - checking：现在认不出来，但还不能下结论——还没收到第一份快照，或服务端说有已归档的会话而列表还没读全（后台读一遍，读回来就认得了；
 *   读不到也不打扰，这里只是补全）；
 * - gone：两张表都读全了还是没有，说明它已经被删除。
 * 下游记录里“当时交接了什么”是冻结的，不受上游去向影响；这里只决定标题能不能点。
 */
export function useUpstream(id: SessionId): { summary: SessionSummary | undefined; state: "found" | "checking" | "gone" } {
  const sessions = useStore(store, (s) => s.sessions);
  const archived = useStore(store, (s) => s.archived);
  const ready = useStore(store, (s) => s.ready);
  const unloaded = useStore(store, (s) => (s.archivedCount ?? 0) > 0 && !s.archivedLoaded);

  const summary = sessions[id] ?? archived[id];
  const shouldLoad = summary === undefined && unloaded;
  useEffect(() => {
    if (shouldLoad) void loadArchived().catch(() => undefined);
  }, [shouldLoad]);

  const state = summary ? "found" : !ready || unloaded ? "checking" : "gone";
  return { summary, state };
}
