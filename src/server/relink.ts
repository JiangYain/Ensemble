import type { RelinkData } from "@shared/events";
import { dedupeIds, isAncestorOrSelf, layerOf, parentIdsOf, reachableFrom, sameParentList } from "@shared/lineage";
import type { SessionId } from "@shared/types";
import { EnsembleError } from "./errors";
import type { EventHub } from "./hub";
import { missingParents } from "./parents";

/** 一条要写进某个会话日志的“关系调整”。 */
export interface RelinkStep {
  sessionId: SessionId;
  data: Omit<RelinkData, "by">;
}

/**
 * 校验“把某会话改挂到另一个（或另几个）上级之下（或改回没有上级）”，并算出需要写的全部记录；这里不写任何东西。
 * 要写的有两类：被改的会话自己，以及因它而层数变化的后代（各写进自己的日志，重放才不必跨会话）。
 * 任何一项不满足就整体拒绝，不会只改一半，也不会悄悄截断子树的层数。上级的先后与个数都和原来一样时返回空数组。
 *
 * `parents`：一个上级、一组有序的上级（汇聚；整组替换原来的上级，第一个是主上级）、或 null / 空数组（不再有上级）。
 * 层数取“最长链”：被改会话 = 各新上级里最深的那个 + 1，后代 = 各自所有上级里最深的那个 + 1（后代的别的上级在这棵子树之外时，
 * 用它们已记录的层数）；单上级时就是原来的“新上级层数 + 1，再加相对层”。
 *
 * 只读 `hub.node()`（索引层面的上级、层数；热的冷的都能读），所以规划本身不会去解冻任何会话；
 * 调用方（manager.relink）再对 steps 里真正要写事件的会话逐个 `ensureHot`，并在解冻之后重新规划一遍。
 */
export function planRelink(
  hub: Pick<EventHub, "node" | "childIds">,
  sessionId: SessionId,
  parents: SessionId | readonly SessionId[] | null,
  maxDepth: number,
): RelinkStep[] {
  const target = hub.node(sessionId);
  if (!target) throw new EnsembleError("not_found", "Session " + sessionId + " does not exist.");
  const wanted = parents === null ? [] : typeof parents === "string" ? [parents] : dedupeIds(parents);
  if (wanted.includes(sessionId)) {
    throw new EnsembleError("invalid_request", "Session " + sessionId + " cannot be its own parent.");
  }
  // 不存在的上级一次全部说出来（只缺一个时与单上级的说法完全一样）。
  const notFound = missingParents(wanted.filter((id) => hub.node(id) === undefined));
  if (notFound) throw notFound;
  if (sameParentList(parentIdsOf(target), wanted)) return [];

  // 新上级不能是自己的后代（也不能是自己）：自己是新上级的祖先，就会让自己成了自己的上级。沿着上级一路往上找，带去重，数据异常时也不会死循环。
  const parentsOf = (id: SessionId): readonly SessionId[] => parentIdsOf(hub.node(id));
  for (const parent of wanted) {
    if (isAncestorOrSelf(sessionId, parent, parentsOf)) {
      throw new EnsembleError("conflict",
        "Session " + parent + " is a descendant of " + sessionId + ", so making it the parent would form a loop. Choose a session outside " + sessionId + "'s own subtree.",
        { sessionId, parentSessionId: parent });
    }
  }

  // 被改会话的整棵子树都要重新算层数（后代经由哪条路走到都只算一次）。
  const subtree = [sessionId, ...reachableFrom([sessionId], (id) => hub.childIds(id))];
  const { depths } = layerOf(subtree, (id) => (id === sessionId ? wanted : parentsOf(id)), (id) => hub.node(id)?.depth);
  let deepestId = sessionId;
  let deepest = depths.get(sessionId) ?? 0;
  for (const id of subtree) {
    const level = depths.get(id) ?? 0;
    if (level > deepest) {
      deepest = level;
      deepestId = id;
    }
  }
  if (deepest > maxDepth) {
    const who = deepestId === sessionId ? "it" : "its descendant " + deepestId;
    // 汇聚时点名是哪个上级让链过长：层数取最长链，最深的那个上级决定了被改会话的层数。
    // （details 里的 `via` 已被 MCP 桥用来标记“由 follows 引起”，所以这里叫 deepestParentId。）
    const deepestParentId = wanted.length > 1 ? wanted.reduce((best, id) => ((hub.node(id)?.depth ?? 0) > (hub.node(best)?.depth ?? 0) ? id : best)) : undefined;
    throw new EnsembleError("depth_exceeded",
      "Moving " + sessionId + (wanted.length > 0 ? " under " + wanted.join(", ") : " out of its parent") + " would put " + who + " at nesting depth " + deepest + ", over the limit of " + maxDepth + ". Choose a parent closer to the top."
        + (deepestParentId ? " The longest chain runs through " + deepestParentId + "." : ""),
      { sessionId, parentSessionId: wanted[0] ?? null, ...(wanted.length > 1 ? { parentSessionIds: wanted, deepestParentId } : {}), depth: deepest, maxDepth, deepestSessionId: deepestId });
  }

  const steps: RelinkStep[] = [];
  for (const id of subtree) {
    const node = hub.node(id);
    if (!node) continue;
    const self = id === sessionId;
    const depth = depths.get(id) ?? 0;
    if (!self && node.depth === depth) continue;
    const after = self ? wanted : parentIdsOf(node);
    steps.push({
      sessionId: id,
      data: {
        parentSessionId: self ? (wanted[0] ?? null) : (node.parentSessionId ?? null),
        ...(after.length > 1 ? { parentSessionIds: after } : {}),
        depth,
        previous: {
          ...(node.parentSessionId ? { parentSessionId: node.parentSessionId } : {}),
          ...(node.parentSessionIds ? { parentSessionIds: node.parentSessionIds } : {}),
          depth: node.depth,
        },
        cause: self ? "self" : "ancestor",
      },
    });
  }
  return steps;
}
