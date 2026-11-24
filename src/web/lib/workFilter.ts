import { reachableFrom } from "@shared/lineage";
import type { SessionId, SessionPhase, SessionSummary } from "@shared/types";
import { agentNodeId, type SceneLayout } from "../scene/layout";
import { indexSessions } from "./sessionGraph";
import { isActivePhase } from "./text";

/**
 * “只看正在工作的会话”这个视图偏好的全部判断，都在这里，纯函数、不改输入：
 * 画布（Overview）与 Dock 的计数用同一份结果，不会各算各的。
 */

/**
 * “工作中”= isActivePhase（running / starting / queued）加上 `ready`。用户的决定：`ready` 是“会话在、此刻没有运行”的待命，
 * 仍算在工作里，不收起；收起的只有已经结束的（done / failed / cancelled / stopped / lost）。
 * 这条判定只在这里写一份（Dock 的角标与画布都经 filterWorking 取结果）；isActivePhase 本身不动：
 * “停止会话”等处要的是“此刻有没有运行”，待命在那里不算。
 */
function isWorking(phase: SessionPhase): boolean {
  return phase === "ready" || isActivePhase(phase);
}

export interface WorkFilter {
  /** 规则要留在画面上的会话：工作中的，加上它们的祖先。 */
  visible: ReadonlySet<SessionId>;
  /** 其中自己并不在工作、只是为保住真实的父子关系而留下的祖先。 */
  context: ReadonlySet<SessionId>;
  /** 被收起的会话：不在 visible 里的。数这个，而不是数 context。 */
  hidden: ReadonlySet<SessionId>;
}

/**
 * 工作中的会话与它们的祖先链（一直到没有父会话为止）留下，其余收起。汇聚的会话（跟随多个上级）要沿着每一个上级的链都留下，
 * 不只是主上级那一条——否则它的连线会少掉几条，看起来就不是它真实跟随的那些会话了。
 *
 * 祖先必须留：父会话已完成、子会话还在运行时，把父节点收起会让子节点看起来直接挂在来源上——
 * 那是一条不存在的关系。所以留下的祖先不是“被隐藏的空闲节点”，而是让连线保持真实的上下文。
 * 父会话不在列表里（已删除）时，布局本来就把子会话当根，这里也在那里停。数据异常的环由 reachableFrom 的 seen 截断。
 */
export function filterWorking(sessions: readonly SessionSummary[]): WorkFilter {
  const graph = indexSessions(sessions);
  const working = sessions.filter((session) => isWorking(session.phase)).map((session) => session.id);
  // 从全部工作中的会话一次走完每个上级的祖先链：广度优先、每个会话只算一次（菱形不会重复，环也走不死）。起点不在 reachableFrom 的结果里，自己并入。
  const visible = new Set<SessionId>(working);
  for (const ancestor of reachableFrom(working, graph.parentsOf)) visible.add(ancestor);
  const context = new Set<SessionId>();
  for (const id of visible) if (!isWorking(graph.byId.get(id)!.phase)) context.add(id);
  const hidden = new Set(sessions.filter((session) => !visible.has(session.id)).map((session) => session.id));
  return { visible, context, hidden };
}

// ───────────────────────── 离场 ─────────────────────────

/**
 * 一个已经不被规则需要、却还画在画面上的会话：
 * - `"held"`：用户正在操作它（拖动、菜单开着、键盘焦点在上面），先别收；
 * - 数字：开始淡出的时刻（毫秒时间戳），淡出结束后离开。
 */
export type Linger = "held" | number;

export interface Drawn {
  /** 上一次画着的会话；"all" 是没有过滤（全部都画着）。 */
  drawn: ReadonlySet<SessionId> | "all";
  linger: ReadonlyMap<SessionId, Linger>;
}

export interface SettleInput {
  sessions: readonly SessionSummary[];
  /** 规则要留的会话；undefined 是没有开过滤。 */
  rule: ReadonlySet<SessionId> | undefined;
  /** 上一次的结果；undefined 是第一次（没有“上一次”，也就没有谁需要离场）。 */
  prev: Drawn | undefined;
  /** 这个会话此刻是否被用户操作着。 */
  operated: (id: SessionId) => boolean;
  now: number;
  /** 淡出的时长；0 是不做离场动画（减少动效）。 */
  exitMs: number;
}

export interface Settled extends Drawn {
  /** 正在淡出的会话（还画着，已经不可操作）。 */
  leaving: ReadonlySet<SessionId>;
  /** 因为正被操作而暂缓的会话。 */
  held: ReadonlySet<SessionId>;
  /** 最近一次淡出结束的时刻；没有淡出中的会话就没有。 */
  wakeAt: number | undefined;
}

const NONE: ReadonlySet<SessionId> = new Set();

/**
 * 一次结算：规则、上一次画着的和“谁在被操作”三者之间，这一刻该画哪些会话。
 *
 * - 规则新不要的会话先逗留：没人操作它就开始淡出，淡出结束再离开（节点淡出完、布局才合拢，两件事不叠在一起）。
 * - 正被操作的会话不淡出，一直画着，操作结束的下一次结算才开始淡出。
 * - 祖先不早于后代离开：有后代还画着（或被操作着）时，它也留着。这样画着的会话永远带着它真实的父级。
 * - 一旦开始淡出就不回头；中途又被规则需要（用户继续交代了它）则不再算逗留，直接留下。
 */
export function settle({ sessions, rule, prev, operated, now, exitMs }: SettleInput): Settled {
  if (!rule) return { drawn: "all", linger: new Map(), leaving: NONE, held: NONE, wakeAt: undefined };
  if (!prev) return { drawn: rule, linger: new Map(), leaving: NONE, held: NONE, wakeAt: undefined };

  const graph = indexSessions(sessions);
  const before = prev.drawn === "all" ? graph.byId.keys() : prev.drawn;
  const lingering = new Set<SessionId>();
  for (const id of before) if (graph.byId.has(id) && !rule.has(id)) lingering.add(id);
  if (lingering.size === 0) return { drawn: rule, linger: new Map(), leaving: NONE, held: NONE, wakeAt: undefined };

  const kids = new Map<SessionId, SessionId[]>();
  for (const id of lingering) {
    // 汇聚的会话是它每一个上级的下级：任何一个上级都不早于它离开。
    for (const parent of graph.parentsOf(id)) {
      if (lingering.has(parent)) kids.set(parent, [...(kids.get(parent) ?? []), id]);
    }
  }

  // 已经在淡出的不再被拦住；其余的，自己被操作、或有还没开始淡出的后代被操作，就暂缓。
  const holdMemo = new Map<SessionId, boolean>();
  const holds = (id: SessionId): boolean => {
    const known = holdMemo.get(id);
    if (known !== undefined) return known;
    const fading = typeof prev.linger.get(id) === "number";
    holdMemo.set(id, false);
    const result = !fading && (operated(id) || (kids.get(id) ?? []).some(holds));
    holdMemo.set(id, result);
    return result;
  };

  const linger = new Map<SessionId, Linger>();
  for (const id of lingering) {
    const was = prev.linger.get(id);
    linger.set(id, typeof was === "number" ? was : holds(id) ? "held" : now);
  }

  // 离开：淡出时间到了，并且它的后代都已经离开。
  const expiredMemo = new Map<SessionId, boolean>();
  const expired = (id: SessionId): boolean => {
    const known = expiredMemo.get(id);
    if (known !== undefined) return known;
    expiredMemo.set(id, false);
    const since = linger.get(id);
    const result = typeof since === "number" && now - since >= exitMs && (kids.get(id) ?? []).every(expired);
    expiredMemo.set(id, result);
    return result;
  };

  const drawn = new Set(rule);
  const leaving = new Set<SessionId>();
  const held = new Set<SessionId>();
  let wakeAt: number | undefined;
  for (const [id, state] of [...linger]) {
    if (expired(id)) {
      linger.delete(id);
      continue;
    }
    drawn.add(id);
    if (state === "held") {
      held.add(id);
    } else {
      leaving.add(id);
      wakeAt = Math.min(wakeAt ?? Infinity, state + exitMs);
    }
  }
  return { drawn, linger, leaving, held, wakeAt };
}

/**
 * 哪些节点要跟着淡出：淡出中的会话，以及“下游全部在淡出”的卡片（来源、Folder、Git）。
 * 一张卡只要还有一个下游留着就不动——它仍在为那个下游服务；下游就是布局里从它出发的连线的终点。
 *
 * `keep` 是无论如何都要留在画面上的来源卡（被用户隐藏了“相关节点”的 Main Agent，它的会话淡出、卡片自己留下）。
 * 它不会被标成淡出，但它的会话都淡出了，就等于它不再为上游的 Folder / Git 卡服务：那些卡跟着会话一起淡出，
 * 而不是等布局收起时突然消失。它的会话还有没淡出的（正被操作、暂缓），它就仍在服务，上游照旧留着。
 */
export function leavingNodes(layout: Pick<SceneLayout, "nodes" | "edges">, leaving: ReadonlySet<SessionId>, keep?: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  if (leaving.size === 0) return out;
  for (const id of leaving) out.add(agentNodeId(id));
  const downstream = new Map<string, string[]>();
  for (const edge of layout.edges) downstream.set(edge.from, [...(downstream.get(edge.from) ?? []), edge.to]);
  // 留下的来源卡里，下游全部在淡出的：对上游来说它已经“走了”。
  const departed = new Set<string>();
  // 来源 → Folder → Git：按这个顺序往上推，上一层的结论就是下一层的依据。
  for (const kind of ["origin", "folder", "git"] as const) {
    for (const node of layout.nodes) {
      if (node.kind !== kind) continue;
      const below = downstream.get(node.id) ?? [];
      if (below.length === 0) continue;
      if (kind === "origin" && keep?.has(node.id)) {
        if (below.every((id) => out.has(id))) departed.add(node.id);
        continue;
      }
      if (below.every((id) => out.has(id) || departed.has(id))) out.add(node.id);
    }
  }
  return out;
}
