import { LIMITS } from "./constants";
import { layerOf, parentIdsOf, reachableFrom } from "./lineage";
import type { ArchiveResponse, ArchiveSkipReason, RetentionSettings } from "./protocol";
import type { SessionId, SessionSummary } from "./types";

/**
 * 归档与留存的规则（纯函数）。HTTP、留存清扫器、自动取消归档都只走这里，规则只此一份；
 * 它们读到的会话树由调用方用 `ArchiveTree` 提供（服务端用摘要与子会话表构造，测试用几行内存表构造），这里不碰任何存储。
 *
 * 归档永远不改变会话本身的状态与记录：它只是“移出默认视图”的一个标记（服务端存在会话目录里的 archive.json）。
 * 规则的细节（都是编排者定的初稿，用户没有逐项确认）：
 * - 已结束：phase 属于 done / failed / cancelled / stopped / lost，且没有待确认的消息；starting / queued / running / ready 都不算。
 * - 归档按子树：归档某个 id＝它和它所有下级一起归档；子树里只要有一个不是已结束，整棵跳过（原因 active）；
 *   已经归档的 id 原因 already；不存在 not_found。同一次请求里已随前面某个上级一起归档的 id 不再报告。
 * - 取消归档：该会话的整棵子树，加上仍处于归档状态的上级链（取消之后它不会脱离上级单独出现）；本来没归档的 id 原因 not_archived。
 *   撤销刚才那次归档是另一回事：只恢复那次实际变化的会话（`exact`，见 UnarchiveOptions），不把本来就已归档的下级一并带回。
 * - 留存策略：keepDays＝最后活动（整棵树里最大的 updatedAt）早于 N 天的已结束根会话树归档；
 *   keepCount＝在未归档的根会话树里只保留最近活动的 M 棵，其余已结束的归档（含活动成员的树永远不归档，但仍占名额）；null＝不限。
 *
 * 汇聚（一个会话有多个上级，见 shared/lineage）下，上面各条在没有汇聚节点的数据上一字不变，汇聚节点另有这几条（编排者定的初稿，用户没有逐项确认）：
 * - 归档：随上级一起走的下级，只有在它的**所有**上级都已经归档、或同在这一次归档里时才走；还跟随着别的未归档上级的就留在原处，
 *   并在结果的 `kept` 里如实写出它跟随的是谁（不悄悄多归、也不悄悄少归）。被点名的会话本身总会归档，不看它的上级。
 *   “子树里有没有结束”只看真正会一起走的那些会话；留下来的汇聚节点还在别的上级之下，不算被藏起来。
 * - 取消归档：被点名会话的整棵子树，加上这些会话所有仍归档的祖先（沿全部上级往上，上级在前）。
 * - 留存策略：“根会话树”换成“连通的任务图”——沿上级与下级两个方向连起来的一整块会话，整块一起判断
 *   （最后活动取全块最大、已结束要求全块都结束、占一个名额）；没有汇聚时它就是原来的一棵树。
 */

/**
 * 留存策略里 keepDays / keepCount 的取值规则：null（这一项不限）或 1 到上限的整数。
 * 返回写给调用方看的错误说明（取值合法返回 undefined）。HTTP 的请求校验、设置文件的读写、测试共用这一处；
 * 0、负数、小数、过大的数、字符串都明确拒绝，不悄悄取整或截断。
 */
export function retentionFault(field: "keepDays" | "keepCount", value: unknown): string | undefined {
  if (value === null) return undefined;
  const max = field === "keepDays" ? LIMITS.retention.maxKeepDays : LIMITS.retention.maxKeepCount;
  if (typeof value !== "number" || !Number.isFinite(value)) return `${field} must be a whole number from 1 to ${max}, or null for no limit.`;
  if (!Number.isInteger(value)) return `${field} must be a whole number, got ${value}.`;
  if (value < 1) return `${field} must be at least 1, got ${value}; use null for no limit.`;
  if (value > max) return `${field} must be at most ${max}, got ${value}.`;
  return undefined;
}

/** 规则读到的一个会话：只需要这几项。 */
export interface ArchiveNode {
  id: SessionId;
  parentSessionId?: SessionId | undefined;
  /** 多于一个上级时的完整有序集合（见 shared/lineage 的 parentIdsOf）；单上级没有。 */
  parentSessionIds?: readonly SessionId[] | undefined;
  archived: boolean;
  /** 已结束（见 isFinishedSession）。 */
  finished: boolean;
  /**
   * 最后活动的时刻（毫秒）。解析不出来时用 Infinity：未知的时间宁可当作“刚刚还有动静”，
   * 这样留存策略不会因为一个读不懂的时间戳而把会话当成很久以前的。
   */
  activityMs: number;
}

export interface ArchiveTree {
  node(id: SessionId): ArchiveNode | undefined;
  /** 直接下级，按创建时间排好（子树的遍历次序由它决定）。 */
  childrenOf(id: SessionId): readonly SessionId[];
  /** 全部已知会话（留存策略要遍历所有会话树）。 */
  ids(): readonly SessionId[];
}

/** 已结束：见文件头。`ready` 与进行中的阶段都不算；还有待确认的消息时即使阶段已结束也不算。 */
export function isFinishedSession(summary: Pick<SessionSummary, "phase" | "messages">): boolean {
  switch (summary.phase) {
    case "done":
    case "failed":
    case "cancelled":
    case "stopped":
    case "lost":
      return summary.messages.pending === 0;
    default:
      return false;
  }
}

/** 从摘要得到规则要读的那几项；服务端与网页共用同一个“已结束”的口径。 */
export function archiveNodeOf(
  summary: Pick<SessionSummary, "id" | "parentSessionId" | "parentSessionIds" | "phase" | "messages" | "archivedAt" | "updatedAt">,
): ArchiveNode {
  const activity = Date.parse(summary.updatedAt);
  return {
    id: summary.id,
    parentSessionId: summary.parentSessionId,
    ...(summary.parentSessionIds ? { parentSessionIds: summary.parentSessionIds } : {}),
    archived: summary.archivedAt !== undefined,
    finished: isFinishedSession(summary),
    activityMs: Number.isFinite(activity) ? activity : Number.POSITIVE_INFINITY,
  };
}

/** 一个会话与它所有下级（先根后枝；带去重，数据异常出现环时也不会死循环）。 */
export function subtreeOf(tree: ArchiveTree, id: SessionId): SessionId[] {
  const order: SessionId[] = [];
  const seen = new Set<SessionId>();
  const stack: SessionId[] = [id];
  for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
    if (seen.has(current)) continue;
    seen.add(current);
    order.push(current);
    const children = tree.childrenOf(current);
    // 倒着压栈，弹出时就是创建时间由早到晚。
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];
      if (child !== undefined) stack.push(child);
    }
  }
  return order;
}

/** 一个会话在树里仍然存在的上级（有序）；已被删除的上级不算。 */
function parentsInTree(tree: ArchiveTree, id: SessionId): SessionId[] {
  return parentIdsOf(tree.node(id)).filter((parent) => tree.node(parent) !== undefined);
}

/** 这些会话所有的祖先（沿全部上级往上，不含它们自己），上级在前、下级在后；上级已不存在、或出现环就到此为止。 */
function ancestorsFirst(tree: ArchiveTree, members: readonly SessionId[]): SessionId[] {
  const above = reachableFrom(members, (id) => parentsInTree(tree, id));
  const layered = layerOf(above, (id) => parentsInTree(tree, id));
  return [...layered.order, ...layered.cyclic];
}

/**
 * 从 `roots` 往下，哪些会话会随它们一起走：roots 自己（被点名的总是走），加上这样的下级——它的每一个上级都已经归档、或也在这一批里。
 * 没有汇聚时每个下级只有一个上级，它就是整棵子树，与“归档整棵子树”完全一致。
 * 一个下级是不是走，取决于它的上级是不是走，而上级又可能在它前面或后面才被判到，所以反复扫到不再增加为止（只增不减，一定停）。
 */
function carriedWith(tree: ArchiveTree, roots: readonly SessionId[]): Set<SessionId> {
  const carried = new Set<SessionId>(roots);
  const below = reachableFrom(roots, (id) => tree.childrenOf(id)).filter((id) => tree.node(id) !== undefined);
  for (let grew = true; grew; ) {
    grew = false;
    for (const id of below) {
      if (carried.has(id)) continue;
      const parents = parentsInTree(tree, id);
      if (parents.every((parent) => tree.node(parent)?.archived === true || carried.has(parent))) {
        carried.add(id);
        grew = true;
      }
    }
  }
  return carried;
}

/** `root` 与随它一起走的下级（先根后枝）：只沿 `carried` 里的下级往下，没有走的汇聚下级不算在内。 */
function scopeUnder(tree: ArchiveTree, root: SessionId, carried: ReadonlySet<SessionId>): SessionId[] {
  return [root, ...reachableFrom([root], (id) => tree.childrenOf(id).filter((child) => carried.has(child)))];
}

/**
 * 只点名 `id` 一个会话归档时，会一起走的会话（含它自己，不看它们是否已结束）。
 * 网页在点之前的预判（菜单里的下级个数、挡着归档的原因）读的就是这个范围，与 planArchive 判断“有没有没结束的”是同一个：
 * 一个还跟随着别的未归档上级的汇聚下级不会走，所以不算在内、也不会挡着。没有汇聚时它就是 `id` 的整棵子树。
 */
export function archiveScopeOf(tree: ArchiveTree, id: SessionId): SessionId[] {
  return scopeUnder(tree, id, carriedWith(tree, [id]));
}

/**
 * 归档：算出哪些会话会变（含随上级一起归档的下级），哪些被跳过以及为什么。只算不写。
 * 随上级一起走的会话里有任何一个没结束，这个上级整个不归档（原因 active）：归档不能把还在工作的会话藏起来。
 * 汇聚节点（多个上级）只在它所有的上级都已归档、或同在这一次归档里时才走；否则留在原处，写进 `kept`（见文件头）。
 */
export function planArchive(tree: ArchiveTree, ids: readonly SessionId[]): ArchiveResponse {
  // 按点名的次序（去重）记下每个 id：不存在、已归档的当场有结论，其余是候选——候选是否被拦（active）要等整批一起算完才知道。
  const named: SessionId[] = [];
  const verdict = new Map<SessionId, ArchiveSkipReason>();
  const candidates: SessionId[] = [];
  const requested = new Set<SessionId>();
  for (const id of ids) {
    if (requested.has(id)) continue;
    requested.add(id);
    named.push(id);
    const node = tree.node(id);
    if (!node) verdict.set(id, "not_found");
    else if (node.archived) verdict.set(id, "already");
    else candidates.push(id);
  }

  // 一个候选被拦住之后，只经由它才走的汇聚下级也就不再走了，别的候选的判断随之变化，所以反复算到不再有新的被拦为止。
  const blocked = new Set<SessionId>();
  let carried = new Set<SessionId>();
  for (let again = true; again; ) {
    again = false;
    const open = candidates.filter((id) => !blocked.has(id));
    carried = carriedWith(tree, open);
    for (const root of open) {
      const members = scopeUnder(tree, root, carried);
      if (members.some((member) => tree.node(member)?.finished === false)) {
        blocked.add(root);
        again = true;
      }
    }
  }

  const changed: SessionId[] = [];
  const planned = new Set<SessionId>();
  const kept: NonNullable<ArchiveResponse["kept"]> = [];
  const reported = new Set<SessionId>();
  for (const root of candidates) {
    if (blocked.has(root)) continue;
    for (const member of subtreeOf(tree, root)) {
      const node = tree.node(member);
      if (!node || node.archived || planned.has(member)) continue;
      if (carried.has(member)) {
        planned.add(member);
        changed.push(member);
      } else if (!reported.has(member) && !blocked.has(member)) {
        // 本来在这棵子树里、却还跟随着没有归档的别的上级：留在原处，并说明是谁让它留下的（被点名又被拦住的已经按 active 报告过了）。
        reported.add(member);
        kept.push({ id: member, follows: parentsInTree(tree, member).filter((parent) => tree.node(parent)?.archived !== true && !carried.has(parent)) });
      }
    }
  }

  // 没变的会话按点名的次序给出原因；候选里被拦住的是 active，其余已经在 changed 里（含随别的上级一起走的），不重复报告。
  const skipped: ArchiveResponse["skipped"] = [];
  for (const id of named) {
    const reason = verdict.get(id) ?? (blocked.has(id) ? "active" : undefined);
    if (reason) skipped.push({ id, reason });
  }
  return { changed, skipped, ...(kept.length > 0 ? { kept } : {}) };
}

/** 取消归档的选项；什么都不给就是下面 `planUnarchive` 文档里的“整棵子树加上级链”。 */
export interface UnarchiveOptions {
  /**
   * 只恢复点名的会话：不带上它们仍归档的下级，也不补它们仍归档的上级。
   * 撤销刚才那次归档用它：那次归档回执里的 `changed` 就是它实际改变的全部，只把这些放回去才是归档的逆操作；
   * 默认的取消归档会把本来就已归档的下级（比如更早单独归档的一条分支）也一起带回来，撤销就不再是原样放回。
   * 不检查被点名的会话之间的关系：调用方交来的就是要恢复的全部。
   */
  exact?: boolean;
}

/**
 * 取消归档：被点名的会话本身、它所有仍归档的下级，加上这些会话所有仍归档的祖先（沿全部上级往上，上级在前）。只算不写。
 * 点名的 id 本来就没归档时原因是 not_archived（即使它的上级归档着，也不为它单独取消上级：那不是它被要求的事）。
 * `options.exact` 时只恢复点名的会话本身（见 UnarchiveOptions），not_found / not_archived 的判断不变。
 */
export function planUnarchive(tree: ArchiveTree, ids: readonly SessionId[], options: UnarchiveOptions = {}): ArchiveResponse {
  const changed: SessionId[] = [];
  const changedSet = new Set<SessionId>();
  const skipped: ArchiveResponse["skipped"] = [];
  const requested = new Set<SessionId>();
  for (const id of ids) {
    if (requested.has(id)) continue;
    requested.add(id);
    const node = tree.node(id);
    if (!node) {
      skipped.push({ id, reason: "not_found" });
      continue;
    }
    if (changedSet.has(id)) continue;
    if (!node.archived) {
      skipped.push({ id, reason: "not_archived" });
      continue;
    }
    if (options.exact) {
      changedSet.add(id);
      changed.push(id);
      continue;
    }
    // 取消之后每个恢复的会话都不会脱离它的上级单独出现：下级里有汇聚节点时，它别的（仍归档的）上级也要一并回来。
    const below = subtreeOf(tree, id);
    for (const member of [...ancestorsFirst(tree, below), ...below]) {
      if (changedSet.has(member) || !tree.node(member)?.archived) continue;
      changedSet.add(member);
      changed.push(member);
    }
  }
  return { changed, skipped };
}

/**
 * 留存策略：算出要归档的根会话（每个根连同它的整棵树一起归档，随后交给 planArchive 落实）。
 * - 只看未归档的根会话树（没有上级、或上级已经不存在的会话是根）；
 * - 一棵树的“最后活动”是整棵树里最大的 updatedAt，已结束＝整棵树的每个会话都已结束；
 * - keepDays：已结束、最后活动早于 N 天的树；keepCount：按最后活动由近到远排，前 M 棵之外已结束的树（含活动成员的树仍占名额，但永远不归档）；
 * - 两项都是 null（默认）什么也不做。
 * 汇聚下，“树”是沿上级与下级两个方向连通的一整块任务图：整块一起判断、占一个名额，要归档时交出它所有未归档的根
 * （汇聚节点才会随它们一起走）；块里没有汇聚时它就是原来的一棵树，结果与原来完全一样。
 */
export function planRetention(tree: ArchiveTree, settings: RetentionSettings, nowMs: number): SessionId[] {
  const { keepDays, keepCount } = settings;
  if (keepDays === null && keepCount === null) return [];

  const visited = new Set<SessionId>();
  const groups: { open: SessionId[]; id: SessionId; lastActivityMs: number; finished: boolean }[] = [];
  for (const start of tree.ids()) {
    if (visited.has(start) || !tree.node(start)) continue;
    const members = [
      start,
      ...reachableFrom([start], (id) => [...parentsInTree(tree, id), ...tree.childrenOf(id).filter((child) => tree.node(child) !== undefined)]),
    ];
    for (const member of members) visited.add(member);
    const nodes = members.flatMap((member) => {
      const memberNode = tree.node(member);
      return memberNode ? [memberNode] : [];
    });
    // 这一整块里还没归档、又没有上级的会话：它们是这块的“根”，块要归档就是归档它们。没有（根都已归档）这块就不是留存要管的。
    const open = members
      .filter((member) => parentsInTree(tree, member).length === 0 && tree.node(member)?.archived === false)
      .sort((a, b) => a.localeCompare(b));
    const first = open[0];
    if (first === undefined) continue;
    groups.push({
      open,
      id: first,
      lastActivityMs: nodes.reduce((latest, node) => Math.max(latest, node.activityMs), Number.NEGATIVE_INFINITY),
      finished: nodes.every((node) => node.finished),
    });
  }
  // 最近活动的在前；时刻相同按 id，结果才是确定的。
  groups.sort((a, b) => (b.lastActivityMs === a.lastActivityMs ? a.id.localeCompare(b.id) : b.lastActivityMs > a.lastActivityMs ? 1 : -1));

  const cutoff = keepDays === null ? undefined : nowMs - keepDays * 86_400_000;
  const picked: SessionId[] = [];
  groups.forEach((group, index) => {
    if (!group.finished) return;
    const tooOld = cutoff !== undefined && group.lastActivityMs < cutoff;
    const overCount = keepCount !== null && index >= keepCount;
    if (tooOld || overCount) picked.push(...group.open);
  });
  return picked;
}
