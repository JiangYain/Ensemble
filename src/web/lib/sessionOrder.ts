import type { SessionId, SessionSummary } from "@shared/types";
import { createdOrder, indexSessions } from "./sessionGraph";

/**
 * 会话的稳定顺序，列表视图（SessionList）与会话页侧栏里的兄弟会话（WorkspaceRail）共用这一份：
 * 同一个空间里两处看到的先后由同一段代码保证，而不是各写各的。
 * 顺序只取决于创建先后与 id；状态、最近事件、关注标记、哪个会话正被打开，都不参与。
 */

export interface FlattenedRow {
  session: SessionSummary;
  depth: number;
}

// 行序的唯一依据 createdOrder 住在 sessionGraph（索引的下级表也按它排；放在这里，两个文件就互相导入了）。这里原样再导出，列表、侧栏与测试照旧从这里取。
export { createdOrder };

/** 根会话的方向：最新创建的在最上面（新建的会话仍出现在顶部，已有的行不再换位）。想改成最早在上，只改这一处——去掉对调。 */
export const rootOrder = (a: SessionSummary, b: SessionSummary): number => createdOrder(b, a);

/**
 * 按父子层级展平列表：根会话最新创建的在上（rootOrder），子会话紧跟在父会话下方、按创建先后（最早在前）排列并逐级缩进。
 * 行序只取决于创建先后与 id，与会话状态、活动、传入数组的顺序都无关。
 */
export function flattenSessions(sessions: readonly SessionSummary[]): FlattenedRow[] {
  // 汇聚（跟随多个会话）：会话只出现一次，挂在它的上级里第一个在列表里的下面（主上级不在列表里时顺延到下一个）——
  // 就是索引里的“树里的下级”（子会话早的在前）；没有这样上级的是根。
  const graph = indexSessions(sessions);
  // 先给全体定一个确定的次序：根会话按它排，下面数据环的兜底遍历也按它走。
  const ordered = [...sessions].sort(rootOrder);
  const roots = ordered.filter((session) => graph.firstParentOf(session.id) === undefined);

  const rows: FlattenedRow[] = [];
  const visited = new Set<SessionId>();
  const walk = (session: SessionSummary, depth: number): void => {
    if (visited.has(session.id)) return;
    visited.add(session.id);
    rows.push({ session, depth });
    for (const child of graph.treeChildrenOf(session.id)) walk(child, Math.min(depth + 1, 3));
  };
  for (const root of roots) walk(root, 0);
  // 兜底处理数据环，确保没有会话漏掉；同样按确定的次序遍历，输出不依赖入参顺序。
  for (const session of ordered) walk(session, 0);
  return rows;
}

// ───────────────────────── 可见窗口 ─────────────────────────

/*
 * 行数多于能放下的列表（侧栏里最多露出 6 个兄弟会话）只露出连续的一段，叫窗口。它像一块 `limit` 行高的视口，罩在上面的稳定顺序上：
 * - 窗口里的行保持列表本来的先后，是连续的一段——不会出现“前几行 + 隔着一大段的当前行”这种看着连续、其实有缺口的形式；
 * - 当前会话一定在窗口里。它本来就在窗口里时，窗口不动，在窗口里换当前会话也不动（点另一行只换高亮，不让整段窗口跟着滑一格）；
 * - 只有当前会话落到窗口之外，窗口才移动，而且只移到刚好能看见它：它在上方就成为第一行，在下方就成为最后一行，
 *   与浏览器 scrollIntoView 的 nearest 一样，尽量少移；
 * - 一开始没有记忆，窗口贴着顶端；窗口贴着顶端时，新会话出现在顶部、窗口仍留在顶端（看得到新来的）；
 *   不在顶端时窗口按“第一行是谁”锚定，上面插入新行（新会话出现在顶部）不会让窗口里的会话悄悄换掉；
 * - 总数不超过 `limit` 时没有窗口这回事，全部显示。
 * 挑哪几行只取决于列表的先后、当前会话 id 和上一次窗口的位置，与会话的状态、最近更新时间无关（这里只读 id）。
 */

export interface WindowMemory {
  /** 窗口第一行的 id：用 id 而不是下标锚定，列表里别处插入、删除行时，窗口里的会话才不会悄悄换掉。 */
  first: SessionId;
  /** 它上一次的下标：那一行被删掉、找不到时拿它兜底，窗口大致留在原处。 */
  index: number;
}

export interface RowWindow<T> {
  /** 窗口里的行，保持传入的先后，是连续的一段。 */
  rows: T[];
  /** 被藏起来的行数：窗口上方与下方合计，如实。 */
  hidden: number;
  /** 下一次调用时传回来的记忆；窗口贴着顶端（或没有窗口）时是 undefined。 */
  memory: WindowMemory | undefined;
}

/**
 * 在 `ordered`（已经排好的稳定顺序）上放窗口。把返回的 `memory` 原样传给下一次调用，窗口才记得自己在哪儿；
 * 对自己的输出再调用一次得到同一个结果（幂等），所以在渲染里据此更新 state 不会反复触发。
 * 记忆过期（第一行被删、列表缩短）时就近收拢，窗口始终是满的。
 */
export function placeWindow<T extends { id: SessionId }>(
  ordered: readonly T[],
  currentId: SessionId | undefined,
  memory: WindowMemory | undefined,
  limit: number,
): RowWindow<T> {
  const size = Math.max(1, Math.trunc(limit));
  if (ordered.length <= size) return { rows: [...ordered], hidden: 0, memory: undefined };

  const maxStart = ordered.length - size;
  let start = 0;
  if (memory) {
    const found = ordered.findIndex((row) => row.id === memory.first);
    start = Math.min(Math.max(found >= 0 ? found : memory.index, 0), maxStart);
  }

  // 当前会话在列表里才有“落在窗口之外”这回事；找不到（例如还没加载到）就不动窗口。
  const at = currentId === undefined ? -1 : ordered.findIndex((row) => row.id === currentId);
  if (at >= 0) {
    if (at < start) start = at;
    else if (at >= start + size) start = at - size + 1;
  }

  return {
    rows: ordered.slice(start, start + size),
    hidden: ordered.length - size,
    memory: start === 0 ? undefined : { first: ordered[start]!.id, index: start },
  };
}

export function sameWindowMemory(a: WindowMemory | undefined, b: WindowMemory | undefined): boolean {
  return a?.first === b?.first && a?.index === b?.index;
}
