import { isAncestorOrSelf } from "@shared/lineage";
import type { SessionId, SessionSummary } from "@shared/types";
import { createdOrder, indexSessions, type SessionGraph } from "../lib/sessionGraph";
import { convergence, type Joins } from "./layout-converge";
import { agentNodeId, type LayoutOptions, type OriginGroup } from "./layout-types";

/**
 * 排布的前半段：从会话摘要得出“画布上有什么、谁挂在谁下面”，不产生任何节点或坐标——
 * 索引与去环、树里的上下级与根会话、汇聚的列、每个来源的摘要与先后（含被隐藏、只剩一张卡的来源）。
 * 结果是一份只读的模型（`SceneModel`），后面的各步（layout-tree、layout-scene-assemble、layout-scene-select）只读它；
 * 这里只读 lib/sessionGraph 的索引与 layout-converge，不读排布的其余部分。
 */
export interface SceneModel {
  /** 排进来的会话数（`LayoutOptions.visible` 过滤之后）。 */
  readonly placedCount: number;
  /** 排进来的会话，按创建先后。 */
  readonly ordered: readonly SessionSummary[];
  /** 每个排进来的会话画出来的上级（已去掉环上的连线），第一个是主上级。 */
  readonly drawn: ReadonlyMap<SessionId, readonly SessionId[]>;
  /** 树里的下级：上级 → 它名下的会话（创建先后）；汇聚的会话只在它画出来的第一个上级名下。 */
  readonly children: ReadonlyMap<SessionId, readonly SessionSummary[]>;
  /** 没有上级的会话，按来源的 key 分组（创建先后）。 */
  readonly roots: ReadonlyMap<string, readonly SessionSummary[]>;
  /** 经典排法里会话的列（没有汇聚时是空表，列就是树里的深度），见 layout-converge。 */
  readonly columnOf: ReadonlyMap<SessionId, number>;
  /** 汇聚会话 → 它在同一来源块里的全部上级（节点 id），见 layout-converge。 */
  readonly joins: Joins;
  /** 来源的 key → 来源摘要（按全部会话算）；排 Folder 卡与 Git 卡时会往摘要里补 `folder`、`worktree`。 */
  readonly byOrigin: ReadonlyMap<string, OriginGroup>;
  /** 画布上来源的先后：按第一个根会话的创建时间，被隐藏、只剩一张卡的来源也按它插进来。 */
  readonly order: readonly { readonly key: string; readonly at: string }[];
  /** `order` 对应的来源摘要，同序；就是 `SceneLayout.origins` 交给调用方的那一份。 */
  readonly origins: OriginGroup[];
}

export function buildModel(sessions: readonly SessionSummary[], options: LayoutOptions): SceneModel {
  // 排哪些会话由 visible 决定；下面的 byOrigin 仍按全部会话数，来源卡上的总数才是真实的。
  const placed = options.visible ? sessions.filter((s) => options.visible!.has(s.id)) : sessions;
  // 谁跟随谁交给网页共用的会话索引（lib/sessionGraph）：它只描述排进来的这一批，上级不在这一批里就当它不存在。
  // 环上的连线怎么剔除、汇聚的会话排在第几列，是画布自己的事，仍在下面处理。
  const graph = indexSessions(placed);
  const drawn = drawnParents(placed, graph);
  const ordered = [...placed].sort(createdOrder);
  const { layoutParentOf, children, roots } = treeShape(ordered, drawn);

  // 汇聚：上级不止一个的会话排在同一来源块里所有上级的右边（见 layout-converge）；没有汇聚时两张表都是空的，列就是树形排布里的深度。
  const { columnOf, joins } = convergence({
    ordered: ordered.map((session) => session.id),
    drawn,
    layoutParentOf,
    originKeyOf: (rootId) => graph.byId.get(rootId)!.origin.key,
    nodeId: agentNodeId,
  });

  const byOrigin = summarizeOrigins(sessions);
  const order = originOrder(sessions, placed, graph, roots, options.collapsed);
  const origins = order.map(({ key }) => byOrigin.get(key)!);
  return { placedCount: placed.length, ordered, drawn, children, roots, columnOf, joins, byOrigin, order, origins };
}

/** 被视图过滤（`LayoutOptions.visible`）收起、没排进画布的会话节点的 id；没有按 visible 过滤就是 undefined。 */
export function hiddenAgentIds(sessions: readonly SessionSummary[], visible: ReadonlySet<SessionId> | undefined): Set<string> | undefined {
  return visible ? new Set(sessions.filter((s) => !visible.has(s.id)).map((s) => agentNodeId(s.id))) : undefined;
}

function drawnParents(placed: readonly SessionSummary[], graph: SessionGraph): Map<SessionId, SessionId[]> {
  // 一个会话在画布上的上级：只算排进来的。汇聚时不止一个（见 shared/lineage），第一个是主上级。
  const placedParents = graph.parentsOf;
  // 数据异常时（上下级互指、成环）把落在环上的连线去掉，保证每个会话都有位置、遍历不会死循环：
  // 落在环上的连线是“上级 → 子会话，而子会话又是这个上级的祖先（或就是它自己）”。去掉之后没有别的上级的会话当作根；
  // 单上级的数据里，这与原来“环上的会话当作根”逐个会话完全一致。
  const drawn = new Map<SessionId, SessionId[]>();
  for (const session of placed) {
    drawn.set(session.id, placedParents(session.id).filter((parentId) => !isAncestorOrSelf(session.id, parentId, placedParents)));
  }
  return drawn;
}

function treeShape(
  ordered: readonly SessionSummary[],
  drawn: ReadonlyMap<SessionId, readonly SessionId[]>,
): { layoutParentOf: Map<SessionId, SessionId>; children: Map<SessionId, SessionSummary[]>; roots: Map<string, SessionSummary[]> } {
  const children = new Map<SessionId, SessionSummary[]>();
  const roots = new Map<string, SessionSummary[]>();
  // 会话在树形排布里挂在哪个上级下面：画出来的上级里排在最前的那个（主上级被收起、没排进来时顺延到下一个）。
  // 其余的上级只多画一条连线，不影响排布，也不是拖动时的锚点（锚点只跟树里的上级，见 LayoutNode.anchor）。
  const layoutParentOf = new Map<SessionId, SessionId>();

  for (const session of ordered) {
    const parent = drawn.get(session.id)?.[0];
    if (parent !== undefined) {
      layoutParentOf.set(session.id, parent);
      const list = children.get(parent);
      if (list) list.push(session);
      else children.set(parent, [session]);
    } else {
      const list = roots.get(session.origin.key);
      if (list) list.push(session);
      else roots.set(session.origin.key, [session]);
    }
  }
  return { layoutParentOf, children, roots };
}

function summarizeOrigins(sessions: readonly SessionSummary[]): Map<string, OriginGroup> {
  // Only visible origins get cards; keep their counts across all delegated sessions, including nested ones.
  const byOrigin = new Map<string, OriginGroup>();
  const titleFrom = new Map<string, string>();
  const workspaceFrom = new Map<string, string>();
  for (const session of sessions) {
    const group = byOrigin.get(session.origin.key) ?? { origin: session.origin, count: 0, running: 0, startedAt: session.createdAt };
    if (session.origin.workspace && session.createdAt >= (workspaceFrom.get(session.origin.key) ?? "")) {
      group.origin = session.origin;
      workspaceFrom.set(session.origin.key, session.createdAt);
    }
    group.count += 1;
    if (session.phase === "running") group.running += 1;
    if (session.createdAt < group.startedAt) group.startedAt = session.createdAt;
    const title = session.origin.hostTitle;
    if (title && session.createdAt >= (titleFrom.get(session.origin.key) ?? "")) {
      group.hostTitle = title;
      titleFrom.set(session.origin.key, session.createdAt);
    }
    byOrigin.set(session.origin.key, group);
  }
  return byOrigin;
}

function originOrder(
  sessions: readonly SessionSummary[],
  placed: readonly SessionSummary[],
  graph: SessionGraph,
  roots: ReadonlyMap<string, readonly SessionSummary[]>,
  collapsed: ReadonlySet<string> | undefined,
): { key: string; at: string }[] {
  // 被隐藏、名下没有会话画出来的来源：只排一张来源卡（见 LayoutOptions.collapsed）。它按“第一个根会话的创建时间”插进来源的先后里，
  // 与它隐藏之前的位置一致，别的来源的先后不会因为它被隐藏而变。
  // 只有真的有根会话的来源才有这张卡：key 只出现在嵌套会话上（它们画在别的来源名下）的不凭空画一张。
  const chips = new Map<string, string>();
  // 第一个根会话要在全部会话里找（被隐藏的来源名下的会话已经不在 placed 里）；没有按 visible 过滤时 placed 就是全部，直接复用排布用的那份索引（graph）。
  let everyone: SessionGraph | undefined;
  for (const key of collapsed ?? []) {
    if (roots.has(key)) continue;
    everyone ??= placed === sessions ? graph : indexSessions(sessions);
    const at = firstRootCreatedAt(everyone, key);
    if (at === undefined) continue;
    chips.set(key, at);
  }
  const order = [...roots].map(([key, group]) => ({ key, at: group[0]!.createdAt }));
  for (const [key, at] of chips) order.push({ key, at });
  if (chips.size > 0) order.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return order;
}

/**
 * 一个来源第一个根会话（没有上级的）的创建时间：来源在画布上先后的依据。来源只有嵌套会话时没有。汇聚的会话只要有一个上级在，就不是根。
 * `graph` 必须是全部会话的索引（不是按 visible 过滤之后的）：被隐藏的来源名下的会话已经不在排布的那一批里，却仍决定它的先后。
 */
function firstRootCreatedAt(graph: SessionGraph, key: string): string | undefined {
  let first: string | undefined;
  for (const session of graph.sessions) {
    if (session.origin.key !== key || graph.firstParentOf(session.id) !== undefined) continue;
    if (first === undefined || session.createdAt < first) first = session.createdAt;
  }
  return first;
}
