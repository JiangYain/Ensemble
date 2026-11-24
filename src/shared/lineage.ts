import type { SessionId } from "./types";

/**
 * 会话之间“谁跟随谁”的纯函数（服务端、MCP 桥、网页共用）。
 *
 * 一个会话可以有多个上级（汇聚：这件事依赖几个会话的结果），所以会话之间是一张有向无环图，而不只是一棵树。
 * 数据的约定（字段说明见 SessionMeta / SessionSummary / RelinkData）：
 * - `parentSessionId` 始终是第一个上级（“主上级”）：只认这个字段的老读者（老桥、老网页缓存、老日志的重放）读到的仍是一棵树；
 * - `parentSessionIds` 是完整、有序的上级集合，**只在多于一个上级时才有**；单上级的会话没有它，数据与原来一字不差。
 * 所以读一个会话的上级一律用 `parentIdsOf`，写一律用 `parentFields`，不要直接碰这两个字段。
 *
 * 这里所有遍历都带 visited：同一个会话从两条路都能走到（菱形）时只算一次；数据里即使有环（不该出现，但日志是人能改的）也不会死循环。
 */

/** 带“上级”字段的任何东西：SessionMeta、SessionSummary、索引里的节点、请求体都满足它。 */
export interface ParentRefs {
  parentSessionId?: SessionId | undefined;
  parentSessionIds?: readonly SessionId[] | undefined;
}

/** 去重并保持原有顺序（第一次出现的位置为准）。 */
export function dedupeIds(ids: readonly SessionId[]): SessionId[] {
  return [...new Set(ids)];
}

/**
 * 一个会话的上级，有序、去重，没有上级就是空数组。
 * 有 `parentSessionIds` 以它为准（第一项就是主上级）；否则退回单个的 `parentSessionId`——老日志、老快照、老服务给的摘要都是这种形状。
 * 这个函数不查上级存不存在：它们可能已被删除，或还没载入。
 */
export function parentIdsOf(node: ParentRefs | undefined): SessionId[] {
  if (!node) return [];
  const many = node.parentSessionIds;
  if (many && many.length > 0) return dedupeIds(many);
  return node.parentSessionId ? [node.parentSessionId] : [];
}

/**
 * 把有序的上级列表写成会话上的两个字段：没有上级是空对象，一个上级只有 `parentSessionId`（与原来一字不差），
 * 两个及以上才多出 `parentSessionIds`，`parentSessionId` 仍是第一项。用对象展开写进 meta / 摘要 / 事件数据：
 * 没有的字段整个不出现（而不是写成 undefined），读回来的对象才与没有汇聚的时候逐字段相等。
 */
export function parentFields(ids: readonly SessionId[]): { parentSessionId?: SessionId; parentSessionIds?: SessionId[] } {
  const list = dedupeIds(ids);
  const first = list[0];
  if (first === undefined) return {};
  return list.length > 1 ? { parentSessionId: first, parentSessionIds: list } : { parentSessionId: first };
}

/** 两份上级列表完全一样（个数、成员、先后都一样）：改挂时据此判断“什么都不用改”；换了先后就是换了主上级，不算一样。 */
export function sameParentList(a: readonly SessionId[], b: readonly SessionId[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** 两份上级是同一个集合（不看先后）：防重复按它比较，同样的上级换个写法顺序不该造出第二个会话。 */
export function sameParentSet(a: readonly SessionId[], b: readonly SessionId[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}

/**
 * 从 `starts` 出发沿 `next`（取子会话就是后代，取上级就是祖先）能走到的所有会话：广度优先，每个只出现一次，不含起点本身
 * （即使数据里有环绕回了起点）。菱形里两条路都能到的会话只算一次。
 */
export function reachableFrom(starts: readonly SessionId[], next: (id: SessionId) => Iterable<SessionId>): SessionId[] {
  const seen = new Set<SessionId>(starts);
  const queue = [...seen];
  const found: SessionId[] = [];
  for (let index = 0; index < queue.length; index++) {
    for (const id of next(queue[index] as SessionId)) {
      if (seen.has(id)) continue;
      seen.add(id);
      found.push(id);
      queue.push(id);
    }
  }
  return found;
}

/**
 * `target` 是不是 `of` 自己，或沿着上级一路往上能走到的会话（祖先）。
 * 改挂时判断环路：新上级里只要有一个满足“自己是它的祖先或它本身”，就会让自己成为自己的上级。
 * 画布上也用它认出落在环上的那条连线（上级 → 子会话，而子会话又是上级的祖先）。
 */
export function isAncestorOrSelf(target: SessionId, of: SessionId, parentsOf: (id: SessionId) => readonly SessionId[]): boolean {
  if (target === of) return true;
  const seen = new Set<SessionId>([of]);
  const queue: SessionId[] = [of];
  for (let index = 0; index < queue.length; index++) {
    for (const parent of parentsOf(queue[index] as SessionId)) {
      if (parent === target) return true;
      if (seen.has(parent)) continue;
      seen.add(parent);
      queue.push(parent);
    }
  }
  return false;
}

/** `layerOf` 的结果。 */
export interface Layering {
  /** 每个会话的层数 = 最长的那条上级链的长度：没有上级是 0，否则是各上级层数的最大值加 1。 */
  depths: Map<SessionId, number>;
  /** 拓扑序：上级一定排在它的下级前面，先后由传入的次序唯一确定。落在环上（或被环挡住）的会话不在里面。 */
  order: SessionId[];
  /** 数据异常时落在环上、或只能经由环到达的会话（正常数据里没有）。它们的层数只算到被挡住之前，不可当真。 */
  cyclic: SessionId[];
}

/**
 * 给一批会话分层：每个会话的层数是它最长的上级链（汇聚时取各上级里最深的那个，而不是第一个）。
 * `parentsOf` 给每个会话的上级（可以包含 `nodes` 之外的）；`nodes` 之外的上级用 `outside` 取已知的层数
 * （取不到，比如已被删除，就当它不存在，不影响层数）。自己指向自己的那一条被忽略。
 * 用 Kahn 算法逐层剥开，没有递归，所以链很长、或数据里有环都不会爆栈或死循环。
 */
export function layerOf(
  nodes: readonly SessionId[],
  parentsOf: (id: SessionId) => readonly SessionId[],
  outside: (id: SessionId) => number | undefined = () => undefined,
): Layering {
  const inside = new Set(nodes);
  const depths = new Map<SessionId, number>();
  const waiting = new Map<SessionId, number>();
  const kids = new Map<SessionId, SessionId[]>();
  for (const id of nodes) {
    if (waiting.has(id)) continue;
    let base = 0;
    let count = 0;
    for (const parent of dedupeIds(parentsOf(id))) {
      if (parent === id) continue;
      if (inside.has(parent)) {
        count += 1;
        const list = kids.get(parent);
        if (list) list.push(id);
        else kids.set(parent, [id]);
        continue;
      }
      const known = outside(parent);
      if (known !== undefined) base = Math.max(base, known + 1);
    }
    waiting.set(id, count);
    depths.set(id, base);
  }

  const order: SessionId[] = [];
  const queue = [...waiting].filter(([, count]) => count === 0).map(([id]) => id);
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index] as SessionId;
    order.push(id);
    for (const kid of kids.get(id) ?? []) {
      depths.set(kid, Math.max(depths.get(kid) as number, (depths.get(id) as number) + 1));
      const left = (waiting.get(kid) as number) - 1;
      waiting.set(kid, left);
      if (left === 0) queue.push(kid);
    }
  }
  const done = new Set(order);
  return { depths, order, cyclic: [...waiting.keys()].filter((id) => !done.has(id)) };
}
