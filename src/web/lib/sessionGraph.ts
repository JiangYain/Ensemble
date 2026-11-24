import { parentIdsOf } from "@shared/lineage";
import type { SessionId, SessionSummary } from "@shared/types";

/**
 * 网页里“谁跟随谁”的唯一一份索引。列表视图的展平、来源卡的折叠、“只看工作中”和归档前的预判都要从摘要里推上级、下级与根；
 * 汇聚的会话（跟随多个上级，见 shared/lineage）在这几处必须挂在同一个上级下面、数同一批下级，所以只在这里推一遍，各处读结果。
 *
 * 索引只描述传入的那一批会话：上级不在这一批里（已删除、还没载入、被过滤掉）就当它不存在，“第一个上级”指这一批里排在最前的那个。
 * 所以要回答“过滤之后的集合”的问题，就拿那个集合另建一份，不要拿全量的去答；索引不记任何状态，建一次、用完即弃，不改传入的数组与摘要。
 * 要的东西都是按需才算的：只沿祖先链走的消费者（只看工作中、离场结算）不会为下级表付代价。
 *
 * 两张下级表不能互相替代：
 * - 树里的下级（`treeChildrenOf`）：会话只在它的第一个上级名下出现一次，就是列表与画布排出来的那棵树；
 * - 全部下级（`childrenOf`）：汇聚的会话在它每一个上级名下都算——归档按“上级一起走的下级”判断，看的是跟随着它的所有会话。
 * 这个文件不依赖 sessionOrder / originCollapse / workFilter / archivePlan 与画布布局（它们都读它），导入时不会绕成环。
 */

/**
 * 行序的唯一依据：会话的创建先后（早的在前），同一时刻用 id 兜底。
 * 这两个量都是会话生下来就定了的；状态、最近事件、关注标记、起止时间这些随运行变化的字段一律不参与，
 * 否则会话一结束或一有新事件，行就会换位。有 id 兜底，结果也与传入数组的顺序无关。
 * 它放在索引这里而不是 sessionOrder：索引的下级表也按它排，而 sessionOrder 要读索引，放在那边两个文件就互相导入了。
 */
export function createdOrder(a: SessionSummary, b: SessionSummary): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface SessionGraph {
  /** 传入的会话，保持传入的先后（遍历次序要稳定的消费者，如来源归属，读的就是这个先后）。 */
  readonly sessions: readonly SessionSummary[];
  /** 按 id 查摘要；只有这一批里的会话。 */
  readonly byId: ReadonlyMap<SessionId, SessionSummary>;
  /**
   * 这一批里它的上级：有序（主上级在前）、去重；不在这一批里的上级略去，这一批里没有这个会话也是空。
   * 自己指向自己（数据异常）原样保留，不替各视图决定怎么收尾：列表视图把它当作有上级、交给兜底遍历补上，画布与折叠自己剔除。
   */
  readonly parentsOf: (id: SessionId) => readonly SessionId[];
  /** 树里的上级：`parentsOf` 的第一个，会话画在它下面；没有就是根。主上级不在这一批里时顺延到下一个。 */
  readonly firstParentOf: (id: SessionId) => SessionId | undefined;
  /** 树里的下级：`firstParentOf` 是它的会话，创建先后（早的在前）。 */
  readonly treeChildrenOf: (id: SessionId) => readonly SessionSummary[];
  /** 全部下级：它是任一上级（`parentsOf`）的会话，创建先后（早的在前）；汇聚的会话在它每一个上级名下各有一份。 */
  readonly childrenOf: (id: SessionId) => readonly SessionSummary[];
}

type KidTable = Map<SessionId, SessionSummary[]>;

interface KidTables {
  tree: KidTable;
  all: KidTable;
}

// 没有结果时各处共用同一个空数组：冻结，谁拿到它也改不了、不会串到别的调用里。
const NO_IDS: readonly SessionId[] = Object.freeze([]);
const NO_SESSIONS: readonly SessionSummary[] = Object.freeze([]);

function append(table: KidTable, key: SessionId, summary: SessionSummary): void {
  const list = table.get(key);
  if (list) list.push(summary);
  else table.set(key, [summary]);
}

export function indexSessions(summaries: readonly SessionSummary[]): SessionGraph {
  const byId = new Map(summaries.map((summary) => [summary.id, summary]));

  // 上级算过就记下：祖先链上每个会话只算一次，没走到的会话不算。
  const parents = new Map<SessionId, readonly SessionId[]>();
  const parentsOf = (id: SessionId): readonly SessionId[] => {
    const known = parents.get(id);
    if (known) return known;
    const summary = byId.get(id);
    if (!summary) return NO_IDS;
    const inSet = parentIdsOf(summary).filter((parent) => byId.has(parent));
    parents.set(id, inSet);
    return inSet;
  };

  // 两张下级表一起建、第一次要时才建。先按创建先后排好再往里放，每张表里的下级就天然是早的在前，不必逐张再排。
  let tables: KidTables | undefined;
  const kidTables = (): KidTables => {
    if (tables) return tables;
    const tree: KidTable = new Map();
    const all: KidTable = new Map();
    for (const summary of [...summaries].sort(createdOrder)) {
      parentsOf(summary.id).forEach((parent, index) => {
        append(all, parent, summary);
        if (index === 0) append(tree, parent, summary);
      });
    }
    tables = { tree, all };
    return tables;
  };

  return {
    sessions: summaries,
    byId,
    parentsOf,
    firstParentOf: (id) => parentsOf(id)[0],
    treeChildrenOf: (id) => kidTables().tree.get(id) ?? NO_SESSIONS,
    childrenOf: (id) => kidTables().all.get(id) ?? NO_SESSIONS,
  };
}
