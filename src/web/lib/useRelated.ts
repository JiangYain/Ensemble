import { useEffect, useMemo } from "react";
import { parentIdsOf } from "@shared/lineage";
import type { SessionId, SessionSummary } from "@shared/types";
import { store } from "./app";
import { loadArchived } from "./archive";
import { useStore } from "./store";

/**
 * 一个会话的上级与下级摘要。未归档与已归档的两张表都认：一个已归档的会话的上级可能还开着，
 * 一个还开着的会话也可能有已经归档的下级（整棵都已结束的下级可以先于上级被归档）。
 *
 * 认不出来的上级 / 下级（已归档、而已归档列表还没加载），并且服务端说确有已归档的会话时，在后台把已归档列表读一遍——
 * 读回来就认得了；读不到（失败）也不打扰，这里只是补全，不是主要内容。
 *
 * 选择器只取两张表本身（引用稳定）：useStore 按 store 状态缓存选择器的结果，选择器若捕获会变的 summary，
 * 上级被事后改挂时（摘要与 store 同时变）会读到旧结果，所以关系的解析放在选择器之外。
 *
 * 汇聚（一个会话跟随多个上级）：`parent` 仍是主上级（`parentSessionId`）的摘要；`parents` 是所有认得出的上级（有序，含主上级），
 * `missingParents` 是认不出的那几个的 id。单上级的会话里 `parents` 就是 `[parent]`（认不出时是空），`missingParents` 至多一个。
 */
export function useRelated(summary: Pick<SessionSummary, "parentSessionId" | "childIds"> & Partial<Pick<SessionSummary, "parentSessionIds">>): {
  parent: SessionSummary | undefined;
  parents: SessionSummary[];
  missingParents: SessionId[];
  children: SessionSummary[];
} {
  const sessions = useStore(store, (s) => s.sessions);
  const archived = useStore(store, (s) => s.archived);
  const unloaded = useStore(store, (s) => (s.archivedCount ?? 0) > 0 && !s.archivedLoaded);
  const { parentSessionId, parentSessionIds, childIds } = summary;

  const related = useMemo(() => {
    const ids = parentIdsOf({ parentSessionId, parentSessionIds });
    const found = ids.map((id) => sessions[id] ?? archived[id]);
    const parents = found.flatMap((one) => (one ? [one] : []));
    const missingParents = ids.filter((_, index) => found[index] === undefined);
    const parent = parentSessionId === undefined ? undefined : (sessions[parentSessionId] ?? archived[parentSessionId]);
    const children = childIds.flatMap((id) => {
      const child = sessions[id] ?? archived[id];
      return child ? [child] : [];
    });
    const missing = missingParents.length > 0 || children.length < childIds.length;
    return { parent, parents, missingParents, children, missing };
  }, [sessions, archived, parentSessionId, parentSessionIds, childIds]);

  const shouldLoad = related.missing && unloaded;
  useEffect(() => {
    if (shouldLoad) void loadArchived().catch(() => undefined);
  }, [shouldLoad]);

  return { parent: related.parent, parents: related.parents, missingParents: related.missingParents, children: related.children };
}
