import { archiveNodeOf, archiveScopeOf, isFinishedSession, planArchive, subtreeOf, type ArchiveTree } from "@shared/archive";
import type { SessionId, SessionSummary } from "@shared/types";
import { indexSessions, type SessionGraph } from "./sessionGraph";

/**
 * 归档前在网页里的预判：哪些会话会被归档、哪些不会、为什么。纯函数，只读摘要，不碰 store 与网络。
 *
 * 规则只此一份——“已结束”（isFinishedSession）与“按子树归档”（planArchive）都来自 shared/archive.ts，服务端归档、留存清扫器与这里读的是同一段代码；
 * 这里只负责把网页手里的未归档摘要造成它要读的那棵树。预判只用来写菜单项、确认框里的数字与“为什么不能归档”：
 * 服务端才是权威（执行时状态可能已变），以服务端回执里的 changed / skipped 为准（见 lib/archive.ts）。
 */

interface Index {
  tree: ArchiveTree;
  /** 目录的关系索引：按 id 查摘要，也回答目录里有哪些上级（与 tree 读的是同一份）。 */
  graph: SessionGraph;
}

/** 手里所有未归档会话的目录 → 规则读的树。父会话不在目录里的会话是根（与服务端的口径一致）。 */
function indexOf(catalog: readonly SessionSummary[]): Index {
  const graph = indexSessions(catalog);
  const nodes = new Map(catalog.map((summary) => [summary.id, archiveNodeOf(summary)]));
  const tree: ArchiveTree = {
    node: (id) => nodes.get(id),
    // 汇聚的会话是它每一个（目录里有的）上级的下级（索引的“全部下级”），与服务端的子会话表同一个口径；单上级与原来一样。
    // 子树的遍历次序由 childrenOf 决定：创建先后（早的在前），与列表视图同一个次序——索引的下级表本来就按它排。
    childrenOf: (id) => graph.childrenOf(id).map((child) => child.id),
    ids: () => [...graph.byId.keys()],
  };
  return { tree, graph };
}

/** 挡着归档的原因：还在工作 / 待命（会话还开着，不算结束）/ 阶段已结束但还有消息没被确认。 */
export type BlockReason = "working" | "idle" | "pending";

export interface Blocked {
  reason: BlockReason;
  /** 因为这个原因挡着的会话数。 */
  n: number;
}

/**
 * 一批会话里挡着归档的原因，只给最主要的一个：在工作的 > 待命的 > 消息未确认的。没有挡着的就返回 undefined。
 * 原因都是摘要里的事实（phase 与 messages.pending），不是网页自己编的判断。
 */
export function blockedBy(members: readonly Pick<SessionSummary, "phase" | "messages">[]): Blocked | undefined {
  let working = 0;
  let idle = 0;
  let pending = 0;
  for (const member of members) {
    if (isFinishedSession(member)) continue;
    if (member.phase === "starting" || member.phase === "queued" || member.phase === "running") working += 1;
    else if (member.phase === "ready") idle += 1;
    else pending += 1;
  }
  if (working > 0) return { reason: "working", n: working };
  if (idle > 0) return { reason: "idle", n: idle };
  if (pending > 0) return { reason: "pending", n: pending };
  return undefined;
}

export interface SubtreePlan {
  /** 连它自己，这一棵里（未归档的）会话数。 */
  total: number;
  /** 其中的下级数（不含它自己）：菜单里写“含 n 个下级会话”。 */
  descendants: number;
  /** 子树里有没结束的会话时给出原因；没有就是可以归档。 */
  blocked: Blocked | undefined;
}

/**
 * 归档某个会话（连同它的整棵子树）的预判。会话不在目录里（已归档或已删除）返回 undefined。
 * “整棵子树”指真正会一起走的那些：还跟随着别的未归档上级的汇聚下级留在原处，不算下级个数、也不挡着归档（见 shared/archive 的 archiveScopeOf）；没有汇聚时就是整棵子树。
 */
export function planSubtree(catalog: readonly SessionSummary[], id: SessionId): SubtreePlan | undefined {
  const { tree, graph } = indexOf(catalog);
  if (!graph.byId.has(id)) return undefined;
  const members = archiveScopeOf(tree, id).flatMap((member) => {
    const summary = graph.byId.get(member);
    return summary ? [summary] : [];
  });
  return { total: members.length, descendants: members.length - 1, blocked: blockedBy(members) };
}

export interface ArchivePick {
  /** 要交给服务端归档的会话（范围内“整棵子树都已结束”的最上层节点）。 */
  ids: SessionId[];
  /** 这些归档之后实际会移出视图的全部会话（含随上级一起归档的下级）。 */
  changed: SessionId[];
  /** 范围内不会被归档的会话数。 */
  kept: number;
  /** changed 里不是被点名、而是随上级一起归档的会话数。 */
  carried: number;
  /** 范围里挡着的原因（没有可归档的会话时，用它写“为什么不能归档”）。 */
  blocked: Blocked | undefined;
}

function summarize(range: readonly SessionSummary[], index: Index, ids: SessionId[], changed: SessionId[], requested: ReadonlySet<SessionId>): ArchivePick {
  const changedSet = new Set(changed);
  const left = range.filter((summary) => !changedSet.has(summary.id));
  // 挡着的原因要看留下的会话整棵子树：一个已结束的上级可能只是因为某个下级还在工作才没被归档，它自己的状态解释不了。
  const members = new Map<SessionId, SessionSummary>();
  for (const summary of left) {
    for (const id of subtreeOf(index.tree, summary.id)) {
      const member = index.graph.byId.get(id);
      if (member) members.set(id, member);
    }
  }
  return {
    ids,
    changed,
    kept: left.length,
    carried: changed.filter((id) => !requested.has(id)).length,
    blocked: blockedBy([...members.values()]),
  };
}

/**
 * “归档整个 Main Agent 空间”与页头“归档已完成会话”共用的选取：在 `range`（空间里或当前范围里的会话）里，
 * 找出整棵子树都已结束的最上层节点——它们的上级（若也在范围内）没有结束，所以才轮得到它们自己来被归档；
 * 上级的整棵子树都已结束时，只选上级（它会带着下级一起走）。仍在工作的任务树整棵保留。
 * `catalog` 是全部未归档的会话（子树要在它里面找：下级不一定都在范围内）。
 */
export function pickArchivable(range: readonly SessionSummary[], catalog: readonly SessionSummary[]): ArchivePick {
  const index = indexOf(catalog);
  const { tree, graph } = index;
  const inRange = new Set(range.map((summary) => summary.id));
  const memo = new Map<SessionId, boolean>();
  const finishedTree = (id: SessionId): boolean => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    // 只看点名它时真正会一起走的会话（同 planSubtree）：一个留在原处的汇聚下级还在工作，不妨碍它自己被归档。
    const done = archiveScopeOf(tree, id).every((member) => {
      const summary = graph.byId.get(member);
      return summary !== undefined && isFinishedSession(summary);
    });
    memo.set(id, done);
    return done;
  };
  const ids = range
    .filter((summary) => {
      if (summary.archivedAt !== undefined || !graph.byId.has(summary.id) || !finishedTree(summary.id)) return false;
      // 上级会带着它走才轮不到它自己：单上级就是“父会话在范围内、整棵都已结束”；
      // 汇聚的会话要它每一个（目录里有的）上级都满足这一条才会被带走（见 planArchive），否则要自己被点名。
      const parents = graph.parentsOf(summary.id);
      return !(parents.length > 0 && parents.every((parent) => inRange.has(parent) && finishedTree(parent)));
    })
    .map((summary) => summary.id);
  return summarize(range, index, ids, planArchive(tree, ids).changed, new Set(ids));
}

/** 多选里的“归档所选”：对选中的每个会话按子树归档，规则同上（只是名单是用户点的，不是自动选的）。 */
export function pickSelected(selected: readonly SessionSummary[], catalog: readonly SessionSummary[]): ArchivePick {
  const index = indexOf(catalog);
  const ids = selected.map((summary) => summary.id);
  return summarize(selected, index, ids, planArchive(index.tree, ids).changed, new Set(ids));
}

export interface Descendants {
  count: number;
  /** 每一级下级都找得到摘要。找不到的（例如已归档、还没加载）只能算一个、没法往下数，所以数字可能偏少——此时不要把它写成确切的数。 */
  complete: boolean;
}

/** 一个会话名下所有下级（含已归档的）有几个：沿 childIds 往下数，摘要由 lookup 提供。 */
export function descendantsOf(summary: Pick<SessionSummary, "id" | "childIds">, lookup: (id: SessionId) => SessionSummary | undefined): Descendants {
  const seen = new Set<SessionId>([summary.id]);
  const queue: SessionId[] = [...summary.childIds];
  let complete = true;
  let count = 0;
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (seen.has(id)) continue;
    seen.add(id);
    count += 1;
    const child = lookup(id);
    if (child) queue.push(...child.childIds);
    else complete = false;
  }
  return { count, complete };
}
