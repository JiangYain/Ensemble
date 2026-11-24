import { sliceHead } from "@shared/safe-slice";
import type { OriginSummary, SessionId, SessionSummary } from "@shared/types";
import type { Lang, TFunction } from "./i18n";
import { rootOriginKeys } from "./originCollapse";
import { dateMinute, isActivePhase, pathName } from "./text";
import { filterWorking } from "./workFilter";

/**
 * 工作空间（画布视角）的范围：
 * - `origin`：单个 Main Agent（宿主对话）的独立画布，只展示它名下的会话树；
 * - `active`：跨 Main Agent 的「全部活跃」战情画布，只聚合并发运行 / 待命中的会话及其祖先链；
 * - `all`：全景视图，展示全部 Main Agent 与 Folder / Git 归属关系。
 */
export type WorkspaceScope =
  | { kind: "origin"; key: string }
  | { kind: "active" }
  | { kind: "all" };

export interface WorkspaceItem {
  key: string;
  /**
   * 来源元数据：优先取该来源名下最近一个带工作目录的会话，这一点与 layout-model.ts 的 summarizeOrigins 一致；
   * 两处不同：这里按 rootOriginKeys 的根来源归并（嵌套会话并入根来源，只有来源就是这个根来源的会话才提供元数据），
   * summarizeOrigins 按各会话自己的 origin.key 归并；都没有工作目录时，这里取最近创建的会话的 origin，summarizeOrigins 取遍历到的第一个。
   */
  origin: OriginSummary;
  /** 宿主给这段对话起的标题（取最近一次委派读到的）；没有读到时为 undefined。 */
  hostTitle?: string;
  /** 工作目录（取自 origin.workspace）；未知时为 undefined。 */
  workspace?: string;
  /** 该 Main Agent 名下整棵树的所有会话（含嵌套委派）。 */
  sessionIds: SessionId[];
  total: number;
  /** 此刻正在运行 / 启动中 / 排队中的会话数。 */
  running: number;
  /** 工作中（含待命 ready）的会话数，与 workFilter 口径一致。 */
  working: number;
  /** 含有“值得留意”提示的进行中会话数。 */
  attention: number;
  /** 失败或失联的会话数。 */
  failed: number;
  /** 第一次委派的时间（最早 createdAt）。 */
  startedAt: string;
  /** 最近活跃的时间（最大 updatedAt / createdAt）。 */
  latestAt: string;
}

export function scopeKey(scope: WorkspaceScope): string {
  return scope.kind === "origin" ? `origin:${scope.key}` : scope.kind;
}

export function sameScope(a: WorkspaceScope | undefined, b: WorkspaceScope | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  return a.kind !== "origin" || (b.kind === "origin" && a.key === b.key);
}

export function serializeScope(scope: WorkspaceScope): string {
  return scope.kind === "origin" ? `origin:${scope.key}` : scope.kind;
}

export function parseScope(raw: string | undefined): WorkspaceScope | undefined {
  if (!raw) return undefined;
  if (raw === "active") return { kind: "active" };
  if (raw === "all") return { kind: "all" };
  if (raw.startsWith("origin:") && raw.length > "origin:".length) {
    return { kind: "origin", key: raw.slice("origin:".length) };
  }
  return undefined;
}

/** 会话的最后活动时间戳：优先 updatedAt，缺失时退回 createdAt。 */
function activityTime(session: SessionSummary): string {
  return session.updatedAt || session.createdAt;
}

/**
 * 把全部会话按根来源（Main Agent）聚合成有序的工作空间列表。
 *
 * 归属规则与画布（layout-model.ts 的 treeShape）及折叠（originCollapse.ts）完全一致：
 * 嵌套子会话跟随根会话归到同一个 Main Agent，不会单独冒出一条假来源；
 * 排序优先展示“正在运行 → 待命 → 有值得留意 → 最近活跃”，让用户一眼看到眼下正在发生的事。
 */
export function buildWorkspaces(sessions: readonly SessionSummary[]): WorkspaceItem[] {
  if (sessions.length === 0) return [];
  const rootOf = rootOriginKeys(sessions);
  const byKey = new Map<
    string,
    {
      origin: OriginSummary;
      originAt: string;
      originHasWs: boolean;
      hostTitle?: string;
      hostTitleAt: string;
      sessionIds: SessionId[];
      running: number;
      working: number;
      attention: number;
      failed: number;
      startedAt: string;
      latestAt: string;
    }
  >();

  for (const session of sessions) {
    const key = rootOf.get(session.id) ?? session.origin.key;
    const isOwn = session.origin.key === key;
    const at = activityTime(session);
    const running = isActivePhase(session.phase) ? 1 : 0;
    const working = running || session.phase === "ready" ? 1 : 0;
    const attention = (session.attention?.length ?? 0) > 0 ? 1 : 0;
    const failed = session.phase === "failed" || session.phase === "lost" ? 1 : 0;

    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        origin: session.origin,
        originAt: session.createdAt,
        originHasWs: Boolean(session.origin.workspace) && isOwn,
        hostTitle: isOwn ? session.origin.hostTitle : undefined,
        hostTitleAt: isOwn && session.origin.hostTitle ? session.createdAt : "",
        sessionIds: [session.id],
        running,
        working,
        attention,
        failed,
        startedAt: session.createdAt,
        latestAt: at,
      };
      byKey.set(key, entry);
      continue;
    }

    entry.sessionIds.push(session.id);
    entry.running += running;
    entry.working += working;
    entry.attention += attention;
    entry.failed += failed;
    if (session.createdAt < entry.startedAt) entry.startedAt = session.createdAt;
    if (at > entry.latestAt) entry.latestAt = at;

    if (isOwn) {
      const hasWs = Boolean(session.origin.workspace);
      const replaceOrigin =
        entry.origin.key !== key ||
        (hasWs && !entry.originHasWs) ||
        (hasWs === entry.originHasWs && session.createdAt > entry.originAt);
      if (replaceOrigin) {
        entry.origin = session.origin;
        entry.originAt = session.createdAt;
        entry.originHasWs = hasWs;
      }
      if (session.origin.hostTitle && session.createdAt >= entry.hostTitleAt) {
        entry.hostTitle = session.origin.hostTitle;
        entry.hostTitleAt = session.createdAt;
      }
    }
  }

  const items: WorkspaceItem[] = [];
  for (const [key, entry] of byKey) {
    items.push({
      key,
      origin: entry.origin,
      ...(entry.hostTitle ? { hostTitle: entry.hostTitle } : {}),
      ...(entry.origin.workspace ? { workspace: entry.origin.workspace } : {}),
      sessionIds: entry.sessionIds,
      total: entry.sessionIds.length,
      running: entry.running,
      working: entry.working,
      attention: entry.attention,
      failed: entry.failed,
      startedAt: entry.startedAt,
      latestAt: entry.latestAt,
    });
  }

  items.sort((a, b) => {
    const rank = (item: WorkspaceItem): number =>
      item.running > 0 ? 3 : item.attention > 0 ? 2 : item.working > 0 ? 1 : 0;
    const diff = rank(b) - rank(a);
    if (diff !== 0) return diff;
    if (a.latestAt !== b.latestAt) return a.latestAt > b.latestAt ? -1 : 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  return items;
}

/**
 * 为概览解析当前生效的工作空间：
 * 1. URL 显式指定了有效空间时，尊重 URL；
 * 2. 否则回到本浏览器上次查看的有效空间；
 * 3. 首次打开且有会话时，直接进入排在第一位的 Main Agent（最活跃或最近更新）的独立画布，不再把所有历史塞进一张图；
 * 4. 没有任何会话时退回 `all`（显示空画布引导）。
 */
export function resolveWorkspace(
  explicit: WorkspaceScope | undefined,
  last: WorkspaceScope | undefined,
  workspaces: readonly WorkspaceItem[],
): WorkspaceScope {
  const valid = (scope: WorkspaceScope | undefined): scope is WorkspaceScope => {
    if (!scope) return false;
    if (scope.kind !== "origin") return true;
    return workspaces.some((item) => item.key === scope.key);
  };
  if (valid(explicit)) return explicit;
  // 快照尚未到达时保留 URL 里显式指向的 origin，避免刚打开直链就闪切到别处。
  if (explicit && workspaces.length === 0) return explicit;
  if (valid(last)) return last;
  if (workspaces.length > 0) return { kind: "origin", key: workspaces[0]!.key };
  return { kind: "all" };
}

/** 按工作空间范围筛出当前该展示的会话集合（保持原有顺序，不修改输入）。 */
export function sessionsInScope(sessions: readonly SessionSummary[], scope: WorkspaceScope): SessionSummary[] {
  if (scope.kind === "all") return [...sessions];
  if (scope.kind === "active") {
    const working = filterWorking(sessions).visible;
    return sessions.filter((session) => working.has(session.id));
  }
  const rootOf = rootOriginKeys(sessions);
  return sessions.filter((session) => (rootOf.get(session.id) ?? session.origin.key) === scope.key);
}

/** 某个会话所属的根 Main Agent key；用于聚焦页返回时回到正确的独立画布。 */
export function originKeyOfSession(sessions: readonly SessionSummary[], sessionId: SessionId): string | undefined {
  const rootOf = rootOriginKeys(sessions);
  return rootOf.get(sessionId);
}

/**
 * 工作空间的展示主名（绝不编造对话标题）：
 * - 有宿主给对话起的真实标题时直接用它；
 * - 控制台发起用“你（控制台）”；
 * - 其余没有宿主标题的来源：优先 “宿主 · 短会话标识”，否则 “宿主 · 目录名”，再否则仅宿主名，
 *   避免多个同目录历史来源在侧栏里全挤成一模一样的目录名。
 */
export function workspaceDisplayTitle(item: WorkspaceItem, t: TFunction): string {
  if (item.hostTitle) return item.hostTitle;
  if (item.origin.kind === "user") return t("origin.user");
  const ref = item.origin.sessionRef?.id;
  if (ref) return `${item.origin.hostLabel} · ${sliceHead(ref, 8)}`;
  if (item.workspace) return `${item.origin.hostLabel} · ${pathName(item.workspace)}`;
  return item.origin.hostLabel;
}

/**
 * 工作空间在侧栏与快速切换器里的副行（绝不和主名重复同一段字）：
 * - 有宿主标题时：目录名 · Git 分支（如 `Ensemble · main`）；没有目录时退回首次委派时刻；
 * - 无宿主标题时：始终显示精确到分的真实首次委派时刻（如 `2026-11-16 14:20`），有 Git 分支再附在后面，
 *   让同目录的多个历史对话在列表里一眼可辨。
 */
export function workspaceSubtitle(item: WorkspaceItem, lang: Lang, branch?: string): string {
  const stamp = dateMinute(item.startedAt, lang, true);
  if (item.hostTitle) {
    const dir = item.workspace ? pathName(item.workspace) : undefined;
    const parts = [dir, branch].filter(Boolean);
    return parts.length > 0 ? parts.join(" · ") : stamp;
  }
  const parts = [stamp];
  if (branch) parts.push(branch);
  else if (item.origin.sessionRef && item.workspace) parts.push(pathName(item.workspace));
  return parts.filter(Boolean).join(" · ");
}

/** 快捷键 `[` / `]` 在 Main Agent 空间之间按列表顺序循环切换。 */
export function stepOriginScope(
  workspaces: readonly WorkspaceItem[],
  current: WorkspaceScope,
  delta: 1 | -1,
): WorkspaceScope | undefined {
  if (workspaces.length === 0) return undefined;
  if (current.kind !== "origin") {
    const target = delta > 0 ? workspaces[0] : workspaces[workspaces.length - 1];
    return target ? { kind: "origin", key: target.key } : undefined;
  }
  const index = workspaces.findIndex((item) => item.key === current.key);
  if (index < 0) return { kind: "origin", key: workspaces[0]!.key };
  if (workspaces.length === 1) return undefined;
  const next = (index + delta + workspaces.length) % workspaces.length;
  return { kind: "origin", key: workspaces[next]!.key };
}

/** 快速切换器里的条目类型。 */
export type SwitcherEntry =
  | { kind: "workspace"; id: string; item: WorkspaceItem; recent: boolean }
  | { kind: "view"; id: string; scope: { kind: "active" } | { kind: "all" } }
  | { kind: "session"; id: string; session: SessionSummary; workspaceTitle?: string };

/**
 * 构建快速切换器（⌘K）的候选条目：
 * - 无搜索词时，类似 Alt+Tab：把最近访问（MRU）里刚离开的 Main Agent 排在前面（当前所在的排后面，方便一键切回上一个任务），
 *   接着列出其余 Main Agent、全局视图，以及正在运行或需要留意的会话；
 * - 有搜索词时，按标题、宿主名、目录、分支、模型、会话 id 大小写不敏感匹配。
 */
export function buildSwitcherEntries(options: {
  query: string;
  workspaces: readonly WorkspaceItem[];
  sessions: readonly SessionSummary[];
  currentScope: WorkspaceScope;
  recentOrigins: readonly string[];
  branches?: ReadonlyMap<string, string>;
  t: TFunction;
  lang?: Lang;
}): SwitcherEntry[] {
  const { workspaces, sessions, currentScope, recentOrigins, branches, t } = options;
  const q = options.query.trim().toLowerCase();
  const tokens = q ? q.split(/\s+/).filter(Boolean) : [];
  const matches = (...fields: (string | undefined)[]): boolean => {
    if (tokens.length === 0) return true;
    const hay = fields.filter(Boolean).join(" ").toLowerCase();
    return tokens.every((token) => hay.includes(token));
  };

  // MRU 排序：无搜索词时，把刚离开的 Main Agent 排在最前面（类似 Alt+Tab），当前空间放在 MRU 末尾。
  const currentKey = currentScope.kind === "origin" ? currentScope.key : undefined;
  const mruRank = new Map<string, number>();
  let order = 0;
  for (const key of recentOrigins) {
    if (key !== currentKey && !mruRank.has(key)) mruRank.set(key, order++);
  }
  const orderedWorkspaces = [...workspaces].sort((a, b) => {
    if (tokens.length === 0) {
      const aCur = a.key === currentKey ? 1 : 0;
      const bCur = b.key === currentKey ? 1 : 0;
      if (aCur !== bCur) return aCur - bCur;
      const ra = mruRank.get(a.key);
      const rb = mruRank.get(b.key);
      if (ra !== undefined || rb !== undefined) {
        if (ra === undefined) return 1;
        if (rb === undefined) return -1;
        return ra - rb;
      }
    }
    return 0; // 保持 buildWorkspaces 的活跃与时间序
  });

  const out: SwitcherEntry[] = [];
  const titleByOrigin = new Map<string, string>();
  for (const item of workspaces) titleByOrigin.set(item.key, workspaceDisplayTitle(item, t));

  for (const item of orderedWorkspaces) {
    const title = titleByOrigin.get(item.key) ?? item.origin.hostLabel;
    const branch = branches?.get(item.key);
    const stamp = dateMinute(item.startedAt, options.lang ?? "zh", true);
    if (matches(title, item.origin.hostLabel, item.workspace, branch, item.origin.sessionRef?.id, item.key, stamp)) {
      out.push({ kind: "workspace", id: `ws:${item.key}`, item, recent: mruRank.has(item.key) });
    }
  }

  // 全局汇总视图
  const activeLabel = `${t("rail.active")} active live running`;
  if (matches(activeLabel)) out.push({ kind: "view", id: "view:active", scope: { kind: "active" } });
  const allLabel = `${t("rail.all")} all overview`;
  if (matches(allLabel)) out.push({ kind: "view", id: "view:all", scope: { kind: "all" } });

  // 会话：有搜索词时全量搜（至多 12 条）；无搜索词时只列正在运行 / 值得留意的会话（至多 6 条）
  const rootOf = rootOriginKeys(sessions);
  const candidateSessions =
    tokens.length > 0
      ? sessions
      : sessions.filter((s) => isActivePhase(s.phase) || (s.attention?.length ?? 0) > 0);
  const sortedSessions = [...candidateSessions].sort((a, b) => {
    const aRun = isActivePhase(a.phase) ? 1 : 0;
    const bRun = isActivePhase(b.phase) ? 1 : 0;
    if (aRun !== bRun) return bRun - aRun;
    return activityTime(b).localeCompare(activityTime(a));
  });
  const limit = tokens.length > 0 ? 12 : 6;
  let added = 0;
  for (const session of sortedSessions) {
    if (added >= limit) break;
    const wsTitle = titleByOrigin.get(rootOf.get(session.id) ?? session.origin.key);
    if (
      matches(
        session.title,
        session.id,
        session.harness,
        session.model?.label,
        session.model?.resolved,
        session.model?.requested,
        session.cwd,
        wsTitle,
      )
    ) {
      out.push({ kind: "session", id: `ses:${session.id}`, session, ...(wsTitle ? { workspaceTitle: wsTitle } : {}) });
      added += 1;
    }
  }
  return out;
}
