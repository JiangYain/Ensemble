import { reachableFrom } from "@shared/lineage";
import type { SessionId, SessionSummary } from "@shared/types";
import { indexSessions, type SessionGraph } from "./sessionGraph";

/**
 * “隐藏某个 Main Agent 的相关节点”的全部归属判断，纯函数、不改输入。
 * 画布（Overview / 布局）、右键菜单与来源卡用同一份结果，不会各算各的。
 *
 * 一个会话画在哪个来源（Main Agent）名下，由布局决定：没有父会话的是根，按它自己的 `origin.key` 归到那张来源卡；
 * 有父会话的跟着父会话走，不看自己的 `origin`（嵌套委派的会话发起端可能是另一个 Harness）。
 * 这里按同一条规则从根往下归属，所以“隐藏一个 Main Agent”收起的，正是画布上连在它后面的那一整棵树。
 * 谁是谁的上级、下级，读的是 sessionGraph 的索引（与列表视图、只看工作中、归档预判同一份口径）；
 * 每次调用只为传入的那一批会话建一份，一次调用里的各来源共用它。
 */

/**
 * 每个会话画在哪张来源卡名下（来源的 key）。
 * - 没有父会话、或父会话不在列表里（已删除）：它自己是根，归到自己的 `origin.key`。
 * - 数据异常的环：环上的会话各自当根（布局也是把环上的会话当作根）；挂在环外的后代归到它们进入环的那个会话。
 */
export function rootOriginKeys(sessions: readonly SessionSummary[]): Map<SessionId, string> {
  return originKeysOf(indexSessions(sessions));
}

/** 一次上溯停在哪：撞上已经算过的会话、走到没有（可用）上级的根，或绕回了这次已经走过的会话（环；`at` 是它在链里的下标）。 */
type Ending = { kind: "known"; key: string } | { kind: "root" } | { kind: "cycle"; at: number };

function originKeysOf(graph: SessionGraph): Map<SessionId, string> {
  const result = new Map<SessionId, string>();
  /** 走过的会话都来自索引、查得到；只有走到根或环时才读它自己的来源。 */
  const ownKey = (id: SessionId): string => graph.byId.get(id)!.origin.key;
  for (const session of graph.sessions) {
    if (result.has(session.id)) continue;
    // 从这个会话一路往上走，记下走过的链，直到遇到：已经算过的会话、没有父级的会话、或走回了自己走过的会话（环）。
    const chain: SessionId[] = [];
    const seen = new Set<SessionId>();
    let ending: Ending = { kind: "root" };
    // 游标与循环里的变量都显式标了类型：靠初始化表达式去推断，它们在循环里互相引用，TypeScript 会报 TS7022（隐式 any）。
    let cursor: SessionId | undefined = session.id;
    while (cursor !== undefined) {
      const known: string | undefined = result.get(cursor);
      if (known !== undefined) {
        ending = { kind: "known", key: known };
        break;
      }
      if (seen.has(cursor)) {
        ending = { kind: "cycle", at: chain.indexOf(cursor) };
        break;
      }
      seen.add(cursor);
      chain.push(cursor);
      // 汇聚的会话在画布上挂在它第一个在列表里的上级下面（与布局一致），归属也沿着这一条链走；单上级就是它的父会话。
      cursor = graph.firstParentOf(cursor);
    }

    if (ending.kind === "known") {
      for (const id of chain) result.set(id, ending.key);
    } else if (ending.kind === "root") {
      // 链的最后一个会话没有（可用的）父级，它是根；整条链归到它的来源。
      const key = ownKey(chain[chain.length - 1]!);
      for (const id of chain) result.set(id, key);
    } else {
      // 环：链里从 at 开始的一段是环上的会话，各自当根；它们前面（更靠近起点）的会话是环外的后代，归到进入环的那个会话。
      const { at } = ending;
      const entryKey = ownKey(chain[at]!);
      chain.forEach((id, index) => result.set(id, index >= at ? ownKey(id) : entryKey));
    }
  }
  return result;
}

/** 汇聚的会话（排进画布的上级不止一个）与它排进画布的上级：折叠的结果只有它们会和“来源卡在 collapsed 里”不一致。 */
interface Join {
  id: SessionId;
  parents: readonly SessionId[];
}

/** 折叠要用的东西，一批会话只算一次：sessionsPerOrigin 按来源逐张卡算折叠，这些在各张卡之间共用，不再每张卡重建。 */
interface Collapse {
  graph: SessionGraph;
  /** 每个会话画在哪张来源卡名下，见 rootOriginKeys。 */
  keys: ReadonlyMap<SessionId, string>;
  joins: readonly Join[];
}

function prepareCollapse(sessions: readonly SessionSummary[]): Collapse {
  const graph = indexSessions(sessions);
  const joins: Join[] = [];
  for (const session of graph.sessions) {
    // 排进画布的上级：列表里有的、不是它自己；不止一个才是汇聚（只有一个或没有的不必再过滤）。
    const listed = graph.parentsOf(session.id);
    const parents = listed.length > 1 ? listed.filter((parent) => parent !== session.id) : listed;
    if (parents.length > 1) joins.push({ id: session.id, parents });
  }
  return { graph, keys: originKeysOf(graph), joins };
}

/**
 * 算出隐藏 `collapsed` 里这些来源后收起的会话（`collapse.keys` 说每个会话画在哪张来源卡名下）。
 *
 * 汇聚（一个会话跟随多个上级）：它按树里挂着的那个上级归到一张来源卡名下，但只有它**所有**的上级都被收起时才跟着收起——
 * 还有上级画在外面，它就留着（画在剩下的上级下面，连线也只剩画着的那些）；挂在它下面、只因它才被收起的后代同样留着。
 * 一个汇聚的会话留下，会让以它为上级的汇聚会话也跟着留下，所以反复算到没有变化为止（每一轮至少留下一个，必然结束）。
 * 没有汇聚时结果就是“来源卡在 collapsed 里的那些会话”，与原来逐个会话相同。
 */
function collapseWith({ graph, keys, joins }: Collapse, collapsed: ReadonlySet<string>): Set<SessionId> {
  const out = new Set<SessionId>();
  for (const [id, key] of keys) if (collapsed.has(key)) out.add(id);
  if (out.size === 0 || joins.length === 0) return out;

  // 树里的下级：按每个会话第一个在列表里的上级（与 rootOriginKeys 的归属同一条规则）。
  const treeKids = (id: SessionId): SessionId[] => graph.treeChildrenOf(id).map((kid) => kid.id);
  for (let changed = true; changed; ) {
    changed = false;
    for (const join of joins) {
      if (!out.has(join.id) || join.parents.every((parent) => out.has(parent))) continue;
      for (const id of [join.id, ...reachableFrom([join.id], treeKids)]) {
        if (out.delete(id)) changed = true;
      }
    }
  }
  return out;
}

/** 属于被隐藏的 Main Agent 的会话（它名下整棵树；汇聚的会话要所有上级都被收起才算）。`collapsed` 是被隐藏的来源的 key。 */
export function collapsedSessions(sessions: readonly SessionSummary[], collapsed: ReadonlySet<string>): Set<SessionId> {
  if (collapsed.size === 0) return new Set<SessionId>();
  return collapseWith(prepareCollapse(sessions), collapsed);
}

/**
 * 每张来源卡名下有几个会话（含嵌套的）。隐藏时收起的就是这个数：
 * 汇聚的会话还跟随着别的来源卡下的会话时，只收起这一张卡不会收起它，所以不算在这一张卡名下。
 */
export function sessionsPerOrigin(sessions: readonly SessionSummary[]): Map<string, number> {
  const collapse = prepareCollapse(sessions);
  const counts = new Map<string, number>();
  for (const key of collapse.keys.values()) counts.set(key, (counts.get(key) ?? 0) + 1);
  // 没有汇聚（绝大多数画布）时不必再算：上面数的就是收起的个数。
  if (collapse.joins.length > 0) {
    for (const key of [...counts.keys()]) counts.set(key, collapseWith(collapse, new Set([key])).size);
  }
  return counts;
}
