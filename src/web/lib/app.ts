import { flushSync } from "react-dom";
import type { EnsembleEvent } from "@shared/events";
import { errorMessage } from "@shared/format";
import type { ProfilesView } from "@shared/profiles";
import { applyEvent, replay, type SessionState } from "@shared/projection";
import type { ConcurrencySetting, ConcurrencyValue, RetentionSettings, SetAllowedModelsRequest } from "@shared/protocol";
import type { HarnessId, HarnessInfo, SessionId, SessionSummary } from "@shared/types";
import type { SettingsSectionId } from "../components/settings/sections";
import { ApiError, api } from "./api";
import { forgetPatch, routeSummary, summaryById, watchTouched } from "./archiveState";
import { detectLang, translate, type Lang } from "./i18n";
import { Store } from "./store";
import { parseScope, sameScope, serializeScope, type WorkspaceScope } from "./workspaces";

export type Route =
  | { kind: "overview"; scope?: WorkspaceScope }
  | { kind: "session"; id: SessionId }
  /** “已归档”视图：不属于任何工作空间（不是 WorkspaceScope），只是一张平铺的历史列表。 */
  | { kind: "archived" };

export type ViewMode = "canvas" | "list";

export interface Toast {
  id: number;
  tone: "info" | "success" | "warn" | "error";
  text: string;
  /** 提示里的一个小动作（例如归档之后的“撤销”）：渲染成键盘可达的按钮，点了就执行并收起这条提示。 */
  action?: { label: string; run: () => void };
}

export interface DetailState {
  id: SessionId;
  state: SessionState | undefined;
  /** 每应用一批事件加一，供组件判断是否需要重绘（状态对象是原地修改的）。 */
  rev: number;
  loading: boolean;
  error?: "not_found" | "failed";
}

export type Connection = "connecting" | "live" | "reconnecting" | "offline";

export interface ConfirmRequest {
  title: string;
  body?: string;
  confirmLabel: string;
  tone?: "danger" | "default";
  onConfirm: () => void | Promise<void>;
}

export interface AppState {
  conn: Connection;
  /** 已经收到过第一份快照。 */
  ready: boolean;
  version: string;
  /** 未归档的会话。画布、侧栏、列表、快切器与批量动作读的都是它；已归档的不在这里（见 archived）。 */
  sessions: Record<SessionId, SessionSummary>;
  /**
   * 已归档的会话摘要，按需加载（进“已归档”视图、聚焦页打开已归档会话时读，之后靠 SSE 保持新鲜）。与 sessions 分开存：
   * 一个会话同一时刻只在其中一张表里，所以现有的所有界面不必认识归档。`archivedLoaded` 为 false 时这里不是全集（见 lib/archiveState）。
   */
  archived: Record<SessionId, SessionSummary>;
  /** archived 已经按整份列表读全了（之后的推送只是增量）。 */
  archivedLoaded: boolean;
  /**
   * 服务端报告的已归档会话数（快照给出，之后随明确的进出归档增减，列表读全后等于 archived 的大小）。
   * `undefined`＝服务不懂归档（老服务）：整个归档界面都不出现；不拿“没给”当成 0。
   */
  archivedCount: number | undefined;
  /** 留存策略（快照给出，设置里改了之后由回执更新）；老服务没有，为 undefined。 */
  retention: RetentionSettings | undefined;
  /** 最近一份快照对应的服务端时刻：用来判断一个突然冒出来的、不认识的会话是新建的，还是此前归档着、刚被取消归档的。 */
  snapshotAt: string | undefined;
  harnesses: HarnessInfo[];
  /** 用户定义的委派角色（设置窗口的“角色”分区），服务端落盘的那一份。老服务没有这份数据：保持空表。 */
  profiles: ProfilesView;
  /** 已改动、尚未被服务端确认的模型与档位选择（整份快照）；每个执行端一条，关掉设置窗口也还在。 */
  pendingModelSettings: Partial<Record<HarnessId, Required<SetAllowedModelsRequest>>>;
  capacity: { occupied: number; max: number; waiting: number };
  /**
   * 并发上限这项设置的来源与用户存的值（上限本身是 capacity.max，两者由服务端成对更新）。
   * `undefined`＝服务没给（老服务，或首份快照还没到）：此时 capacity.max 为 0 并不表示“不限”，设置里不能把它读成不限。
   */
  concurrency: ConcurrencySetting | undefined;
  /**
   * 已改动、尚未被服务端确认的并发上限（见 lib/concurrency-settings）：`value` 为 null 表示“恢复默认”。
   * `undefined` 表示没有进行中的改动。关掉设置窗口也还在，直到服务端确认或拒绝。
   */
  pendingConcurrency: { value: ConcurrencyValue | null } | undefined;
  route: Route;
  detail: DetailState | undefined;
  toasts: Toast[];
  lang: Lang;
  /**
   * 设置窗口。`section` 是上次看的那一项（只记在内存里，不持久化）；`undefined` 表示还没选过，
   * 由窗口取登记表（components/settings/sections.ts）的第一项——默认落点只在登记表里定一次，这里不写死分区名。
   */
  settings: { open: boolean; section: SettingsSectionId | undefined };
  confirm: ConfirmRequest | undefined;
  /** 画布视图偏好：只显示正在工作的会话（见 lib/workFilter）。只存在浏览器里，不改任何会话，也不影响服务端与 MCP。 */
  hideIdle: boolean;
  /**
   * 被用户隐藏了“相关节点”的 Main Agent（来源的 key）：画布上只留来源卡，它名下的会话与只为它服务的 Folder / Git 卡收起（见 lib/originCollapse）。
   * 与 hideIdle 一样只是本浏览器的视图偏好，不改任何会话，服务端与 MCP 都不知道。换一个对象才会变，所以可以直接当 useMemo 的依赖。
   */
  collapsedOrigins: ReadonlySet<string>;
  /** 概览的呈现模式：画布拓扑图或紧凑列表。只存在本浏览器，不改任何会话。 */
  viewMode: ViewMode;
  /** 宽屏左侧栏是否折叠（窄屏下自动改用顶部导航条，不依赖这一项）。 */
  railCollapsed: boolean;
  /** 快速切换器（⌘K / Ctrl+K）是否打开。 */
  switcherOpen: boolean;
  /** 本浏览器最近一次访问的工作空间；再次打开 `#/` 时直接落回这里。 */
  lastWorkspace: WorkspaceScope | undefined;
  /** 最近访问过的 Main Agent key（MRU，最新在前），供 ⌘K 快切器实现类 Alt+Tab 排序。 */
  recentOrigins: readonly string[];
}

export function parseRoute(hash: string): Route {
  const session = /^#\/s\/([^/?#]+)/.exec(hash);
  if (session?.[1]) return { kind: "session", id: decodeURIComponent(session[1]) };
  const origin = /^#\/m\/([^/?#]+)/.exec(hash);
  if (origin?.[1]) return { kind: "overview", scope: { kind: "origin", key: decodeURIComponent(origin[1]) } };
  if (/^#\/active(?:[/?#]|$)/.test(hash)) return { kind: "overview", scope: { kind: "active" } };
  if (/^#\/all(?:[/?#]|$)/.test(hash)) return { kind: "overview", scope: { kind: "all" } };
  if (/^#\/archived(?:[/?#]|$)/.test(hash)) return { kind: "archived" };
  return { kind: "overview" };
}

export function routeHash(route: Route): string {
  if (route.kind === "session") return `#/s/${encodeURIComponent(route.id)}`;
  if (route.kind === "archived") return "#/archived";
  if (!route.scope) return "#/";
  if (route.scope.kind === "active") return "#/active";
  if (route.scope.kind === "all") return "#/all";
  return `#/m/${encodeURIComponent(route.scope.key)}`;
}

/** 与节点位置（ensemble.canvas.positions.v1）同属画布的视图偏好，同样只留在本浏览器；默认关闭。 */
export const HIDE_IDLE_KEY = "ensemble.canvas.hideIdle";
/** 被隐藏了相关节点的 Main Agent：来源 key 的 JSON 数组。同属画布的视图偏好，只留在本浏览器。 */
export const COLLAPSED_ORIGINS_KEY = "ensemble.canvas.collapsedOrigins";
export const VIEW_MODE_KEY = "ensemble.workspace.viewMode";
export const RAIL_COLLAPSED_KEY = "ensemble.rail.collapsed";
export const LAST_WORKSPACE_KEY = "ensemble.workspace.last";

function readStorage(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 隐私模式下可能不可用，忽略。
  }
}

/** 读不出来、或内容不对（被手改过）就当没有：宁可全部显示，也不因为一份坏数据让用户找不到节点。 */
function readCollapsedOrigins(): ReadonlySet<string> {
  const raw = readStorage(COLLAPSED_ORIGINS_KEY);
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string" && key !== "") : []);
  } catch {
    return new Set();
  }
}

function readViewMode(): ViewMode {
  return readStorage(VIEW_MODE_KEY) === "list" ? "list" : "canvas";
}

function readLastWorkspace(): WorkspaceScope | undefined {
  return parseScope(readStorage(LAST_WORKSPACE_KEY));
}

const initialRoute = parseRoute(location.hash);
const initialLastWorkspace =
  initialRoute.kind === "overview" && initialRoute.scope ? initialRoute.scope : readLastWorkspace();

export const store = new Store<AppState>({
  conn: "connecting",
  ready: false,
  version: "",
  sessions: {},
  archived: {},
  archivedLoaded: false,
  archivedCount: undefined,
  retention: undefined,
  snapshotAt: undefined,
  harnesses: [],
  profiles: { entries: [] },
  pendingModelSettings: {},
  capacity: { occupied: 0, max: 0, waiting: 0 },
  concurrency: undefined,
  pendingConcurrency: undefined,
  route: initialRoute,
  detail: undefined,
  toasts: [],
  lang: detectLang(),
  settings: { open: false, section: undefined },
  confirm: undefined,
  hideIdle: readStorage(HIDE_IDLE_KEY) === "1",
  collapsedOrigins: readCollapsedOrigins(),
  viewMode: readViewMode(),
  railCollapsed: readStorage(RAIL_COLLAPSED_KEY) === "1",
  switcherOpen: false,
  lastWorkspace: initialLastWorkspace,
  recentOrigins: initialLastWorkspace?.kind === "origin" ? [initialLastWorkspace.key] : [],
});

// ───────────────────────── 提示 ─────────────────────────

/** 聚焦页离开时记住会话，总览里对应节点用它接住共享元素过渡。 */
export const viewMemory: { lastFocusId: SessionId | undefined } = { lastFocusId: undefined };

let toastSeq = 0;

/** `action` 是提示里可选的一个小动作（见 Toast.action）；带动作的提示要留得久一些，键盘用户才来得及 Tab 过去（调用方自己给 ttl）。 */
export function toast(tone: Toast["tone"], text: string, ttl = 4200, action?: Toast["action"]): void {
  const id = ++toastSeq;
  store.set((s) => ({ toasts: [...s.toasts.slice(-3), { id, tone, text, ...(action ? { action } : {}) }] }));
  if (ttl > 0) setTimeout(() => dismissToast(id), ttl);
}

export function dismissToast(id: number): void {
  store.set((s) => ({ toasts: s.toasts.filter((item) => item.id !== id) }));
}

const HEADLINE_ONLY = new Set(["network", "internal", "forbidden", "not_found"]);

/** 把服务返回的错误码本地化；带具体原因（英文原文）的错误把原因附在括号里，原因本身不翻译。 */
export function errorText(error: unknown): string {
  const lang = store.get().lang;
  if (error instanceof ApiError) {
    const key = `apiError.${error.code}`;
    const headline = translate(lang, key);
    if (headline === key) return error.message;
    if (HEADLINE_ONLY.has(error.code) || !error.message) return headline;
    return lang === "zh" ? `${headline}（${error.message}）` : `${headline} (${error.message})`;
  }
  return errorMessage(error);
}

// ───────────────────────── 路由与过渡 ─────────────────────────

type ViewTransitionDocument = Document & { startViewTransition?: (callback: () => void) => unknown };

/** 支持时用 View Transitions 让节点“变形”为聚焦视图；不支持或用户偏好减少动效时直接切换。 */
export function withTransition(update: () => void): void {
  const doc = document as ViewTransitionDocument;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!doc.startViewTransition || reduce) {
    update();
    return;
  }
  doc.startViewTransition(() => flushSync(update));
}

function rememberWorkspace(scope: WorkspaceScope): Partial<AppState> {
  writeStorage(LAST_WORKSPACE_KEY, serializeScope(scope));
  if (scope.kind !== "origin") return { lastWorkspace: scope };
  const prev = store.get().recentOrigins;
  const recentOrigins = [scope.key, ...prev.filter((item) => item !== scope.key)].slice(0, 24);
  return { lastWorkspace: scope, recentOrigins };
}

export function navigate(route: Route): void {
  const hash = routeHash(route);
  if (location.hash === hash || (route.kind === "overview" && !route.scope && (location.hash === "" || location.hash === "#"))) return;
  location.hash = hash;
}

/** 切换到指定的工作空间（独立 Main Agent 画布、全部活跃或全部），同时记录最近访问顺序供 ⌘K 快切使用。 */
export function selectWorkspace(scope: WorkspaceScope): void {
  const current = store.get().route;
  const patch = rememberWorkspace(scope);
  store.set({ ...patch, switcherOpen: false });
  if (current.kind === "overview" && sameScope(current.scope, scope)) return;
  navigate({ kind: "overview", scope });
}

let detailAbort: AbortController | undefined;

function sameRoute(a: Route, b: Route): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "session" && b.kind === "session") return a.id === b.id;
  if (a.kind === "overview" && b.kind === "overview") return sameScope(a.scope, b.scope);
  return true;
}

function syncRoute(): void {
  const route = parseRoute(location.hash);
  const current = store.get().route;
  if (sameRoute(route, current)) return;
  const scopePatch = route.kind === "overview" && route.scope ? rememberWorkspace(route.scope) : {};
  const apply = (): void => {
    store.set({
      ...scopePatch,
      route,
      switcherOpen: false,
      detail: route.kind === "session" ? { id: route.id, state: undefined, rev: 0, loading: true } : undefined,
    });
    // 读取要在状态写入之后才开始：View Transition 会把这个回调推迟到下一帧，
    // 本地服务几毫秒就能返回，读在前写在后，结果会因为 id 对不上被丢掉，页面就永远停在骨架屏。
    if (route.kind === "session") void loadDetail(route.id);
    else detailAbort?.abort();
  };
  // 概览与聚焦页之间做共享元素过渡；工作空间之间、以及概览与“已归档”视图之间没有共享元素，直接瞬切，不闪整页。
  if (route.kind !== current.kind && (route.kind === "session" || current.kind === "session")) withTransition(apply);
  else apply();
}

export function startRouting(): () => void {
  const onHash = (): void => syncRoute();
  window.addEventListener("hashchange", onHash);
  const route = store.get().route;
  if (route.kind === "session") {
    store.set({ detail: { id: route.id, state: undefined, rev: 0, loading: true } });
    void loadDetail(route.id);
  }
  return () => window.removeEventListener("hashchange", onHash);
}

// ───────────────────────── 会话详情 ─────────────────────────

export async function loadDetail(id: SessionId): Promise<void> {
  detailAbort?.abort();
  const controller = new AbortController();
  detailAbort = controller;
  // 记下请求在途期间推送碰过哪些会话：回执里的摘要要不要用，下面要看它（见 archiveState.watchTouched）。
  const pushes = watchTouched();
  try {
    const detail = await api.session(id, controller.signal);
    if (controller.signal.aborted) return;
    const state = replay(detail.events);
    if (!state) throw new ApiError("internal", "Session has no readable history", 500);
    const current = store.get().detail;
    if (current?.id !== id) return;
    // 详情回执带着这个会话最新的摘要。已归档的会话不在快照里，聚焦页要靠它才有摘要可显示（此后的变化由推送接手）；
    // 已经认识的未归档会话不动：它在 sessions 里一直被推送更新，重写一遍只会让所有订阅者白白重绘。
    // 回执里没有摘要（或不是这个会话的）就不碰任何摘要表。
    // 请求在途期间推送碰过这个会话的话，这份摘要是推送之前取的（服务端先取摘要、后读事件，回执一路上还要花时间），
    // 而归档标记不占序号、比不出新旧，所以不能再用：迟到的旧回执会把刚被取消归档（或刚被归档）的会话挪回原来的那张表。
    const incoming = detail.summary as SessionSummary | undefined;
    const pushedMeanwhile = pushes.touched.has(id);
    const ingest = (s: AppState): Partial<AppState> =>
      incoming?.id === id && !pushedMeanwhile && !(s.sessions[id] && incoming.archivedAt === undefined) ? routeSummary(s, incoming) : {};
    store.set((s) => ({ detail: { id, state, rev: (current.rev ?? 0) + 1, loading: false }, ...ingest(s) }));
    // 读取期间推送过来的事件会被丢弃（状态还没建好），这里按摘要里的最新序号补齐。
    const summary = summaryById(store.get(), id);
    if (summary && summary.seq > state.seq) void catchUp(id, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) return;
    const current = store.get().detail;
    if (current?.id !== id) return;
    store.set({
      detail: { id, state: current.state, rev: current.rev, loading: false, error: error instanceof ApiError && error.status === 404 ? "not_found" : "failed" },
    });
  } finally {
    pushes.stop();
  }
}

/** 补读 state.seq 之后的事件；最多补几轮，避免服务端一直在产生事件时无限追赶。 */
export async function catchUp(id: SessionId, signal?: AbortSignal): Promise<void> {
  for (let round = 0; round < 6; round++) {
    const detail = store.get().detail;
    if (!detail?.state || detail.id !== id || signal?.aborted) return;
    const after = detail.state.seq;
    try {
      const response = await api.events(id, after);
      if (signal?.aborted || response.events.length === 0) return;
      applyLiveEvents(id, response.events);
      if (response.lastSeq <= (store.get().detail?.state?.seq ?? after)) return;
    } catch {
      return;
    }
  }
}

export function applyLiveEvents(sessionId: SessionId, events: readonly EnsembleEvent[]): void {
  const detail = store.get().detail;
  if (!detail || detail.id !== sessionId || !detail.state) return;
  const state = detail.state;
  let applied = false;
  for (const event of events) {
    if (event.seq <= state.seq) continue;
    if (event.seq !== state.seq + 1) {
      // 出现缺口（例如断线期间的事件已不在缓冲里）：整体重新读取最稳妥。
      void loadDetail(sessionId);
      return;
    }
    applyEvent(state, event);
    applied = true;
  }
  if (applied) store.set({ detail: { ...detail, rev: detail.rev + 1 } });
}

// ───────────────────────── 动作 ─────────────────────────

export function setLang(lang: Lang): void {
  writeStorage("ensemble.lang", lang);
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  store.set({ lang });
}

/** 隐藏（或恢复显示）画布上未在工作的会话。localStorage 不可用时静默退回内存态：这一次访问里照样生效。 */
export function setHideIdle(hide: boolean): void {
  writeStorage(HIDE_IDLE_KEY, hide ? "1" : "0");
  store.set({ hideIdle: hide });
}

/**
 * 隐藏（或恢复显示）一个 Main Agent 的相关节点。偏好存在浏览器里；localStorage 不可用时静默退回内存态：这一次访问里照样生效。
 * 写入时顺手丢掉已经没有会话的来源（会话都删了，这条记录再也不会起作用）——只在会话已经加载完之后丢，加载中不能凭空认为“它不存在”。
 */
export function setOriginCollapsed(key: string, collapsed: boolean): void {
  const state = store.get();
  const next = new Set(state.collapsedOrigins);
  if (collapsed) next.add(key);
  else next.delete(key);
  // 已归档的会话还在“存在”之列：它们的来源取消归档之后会回来，这时偏好不能已经被丢掉。
  // 已归档的会话没读全（个数大于 0、列表还没加载）时不知道哪些来源还活着，那就一个也不丢。
  const everythingKnown = state.archivedLoaded || (state.archivedCount ?? 0) === 0;
  if (state.ready && everythingKnown) {
    const alive = new Set([...Object.values(state.sessions), ...Object.values(state.archived)].map((session) => session.origin.key));
    for (const known of next) if (known !== key && !alive.has(known)) next.delete(known);
  }
  commitCollapsedOrigins(next);
}

/** 把所有隐藏了相关节点的 Main Agent 都恢复显示。 */
export function expandAllOrigins(): void {
  commitCollapsedOrigins(new Set());
}

function commitCollapsedOrigins(next: Set<string>): void {
  writeStorage(COLLAPSED_ORIGINS_KEY, JSON.stringify([...next].sort()));
  store.set({ collapsedOrigins: next });
}

export function setViewMode(viewMode: ViewMode): void {
  writeStorage(VIEW_MODE_KEY, viewMode);
  store.set({ viewMode });
}

export function setRailCollapsed(collapsed: boolean): void {
  writeStorage(RAIL_COLLAPSED_KEY, collapsed ? "1" : "0");
  store.set({ railCollapsed: collapsed });
}

export function openSwitcher(): void {
  store.set((s) => ({ switcherOpen: true, settings: { ...s.settings, open: false } }));
}

export function closeSwitcher(): void {
  store.set({ switcherOpen: false });
}

export function toggleSwitcher(): void {
  if (store.get().switcherOpen) closeSwitcher();
  else openSwitcher();
}

export function recordRecentOrigin(key: string): void {
  const prev = store.get().recentOrigins;
  if (prev[0] === key) return;
  store.set({ recentOrigins: [key, ...prev.filter((item) => item !== key)].slice(0, 24) });
}

/** 打开设置窗口。不指定分区时回到上次看的那一项（深链入口，例如“去配置执行端”，传分区 id）。 */
export function openSettings(section?: SettingsSectionId): void {
  store.set((s) => ({ settings: { open: true, section: section ?? s.settings.section }, switcherOpen: false }));
}

export function closeSettings(): void {
  store.set((s) => ({ settings: { ...s.settings, open: false } }));
}

/** 窗口里切换分区；与 openSettings 一样记在内存里，下次不带分区地打开仍停在这里。 */
export function setSettingsSection(section: SettingsSectionId): void {
  store.set((s) => ({ settings: { ...s.settings, section } }));
}

export function askConfirm(request: ConfirmRequest): void {
  store.set({ confirm: request });
}

export function closeConfirm(): void {
  store.set({ confirm: undefined });
}

// ───────────────────────── 会话级动作（节点菜单与聚焦页共用） ─────────────────────────

export async function cancelRun(id: SessionId, labels: { ok: string; nothing: string; failed: string }): Promise<void> {
  const response = await perform(() => api.cancel(id), labels.failed);
  if (!response) return;
  patchSummary(response.summary);
  toast(response.interrupted || response.cancelledQueued > 0 ? "success" : "info", response.interrupted || response.cancelledQueued > 0 ? labels.ok : labels.nothing);
}

export async function stopSession(id: SessionId, labels: { ok: string; failed: string }): Promise<void> {
  const response = await perform(() => api.stop(id), labels.failed);
  if (!response) return;
  patchSummary(response.summary);
  toast("success", labels.ok);
}

export async function removeSession(id: SessionId, labels: { ok: string; failed: string }): Promise<boolean> {
  const response = await perform(() => api.remove(id), labels.failed);
  if (!response) return false;
  forgetSession(id);
  toast("success", labels.ok);
  return true;
}

/** 会话没了（本页删除、SSE 的 `removed`、批量删除）：从未归档与已归档两张表里都去掉，已归档的个数跟着减。幂等。 */
export function forgetSession(id: SessionId): void {
  store.set((s) => forgetPatch(s, id));
}

/** 在失败时统一提示并重新抛出，调用方只需处理自己的界面状态。 */
export async function perform<T>(action: () => Promise<T>, failure?: string): Promise<T | undefined> {
  try {
    return await action();
  } catch (error) {
    const separator = store.get().lang === "zh" ? "：" : ": ";
    toast("error", failure ? `${failure}${separator}${errorText(error)}` : errorText(error), 6000);
    return undefined;
  }
}

/** 用服务给出的最新执行端信息替换（或新增）同一个执行端；推送与保存设置的回执都走这里。 */
export function applyHarness(info: HarnessInfo): void {
  store.set((s) => {
    const index = s.harnesses.findIndex((item) => item.id === info.id);
    if (index < 0) return { harnesses: [...s.harnesses, info] };
    const harnesses = s.harnesses.slice();
    harnesses[index] = info;
    return { harnesses };
  });
}

/** 用服务给出的整张角色表替换本地的；快照、推送（SSE 的 `profiles`）与角色写入的回执都走这里（每次都是整表，很小）。 */
export function applyProfiles(profiles: ProfilesView): void {
  store.set({ profiles });
}

/**
 * 收下一份推送来的（或接口回执里的）会话摘要，放进它该去的那张表：带 `archivedAt` 的进已归档，否则进未归档，
 * 摘要在两张表之间移动时数量跟着变。同一会话上序号更小的摘要是过期的；序号相同的照收（归档不改序号，见 lib/archiveState）。
 */
export function patchSummary(summary: SessionSummary): void {
  store.set((s) => routeSummary(s, summary));
}
