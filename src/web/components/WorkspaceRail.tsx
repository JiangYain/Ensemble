import { useMemo, useState, type ReactNode } from "react";
import type { SessionId, SessionSummary } from "@shared/types";
import {
  navigate,
  openSettings,
  openSwitcher,
  selectWorkspace,
  setRailCollapsed,
  store,
} from "../lib/app";
import { flattenSessions, placeWindow, sameWindowMemory, type RowWindow, type WindowMemory } from "../lib/sessionOrder";
import { useStore } from "../lib/store";
import { useLang, useT } from "../lib/useT";
import {
  sameScope,
  sessionsInScope,
  workspaceDisplayTitle,
  workspaceSubtitle,
  type WorkspaceItem,
  type WorkspaceScope,
} from "../lib/workspaces";
import { shortcutModifier } from "./arrangeDefs";
import { Icon } from "./Icons";
import { HostMark } from "./OriginNode";

const RECENT_VISIBLE_LIMIT = 5;
const SIBLING_VISIBLE_LIMIT = 6;

/** 连接异常状态提示（连接正常时不渲染）：在左侧栏底部为内联行，在无侧栏的聚焦页 / 窄屏下为克制的边角细条（无大药丸）。 */
export function StatusNotices({ variant = "floating" }: { variant?: "inline" | "floating" }): ReactNode {
  const t = useT();
  const conn = useStore(store, (s) => s.conn);
  if (conn === "live") return null;

  return (
    <div className="status-notices" data-place={variant} aria-live="polite" data-modal-inert={variant === "floating" ? "" : undefined}>
      <span className="status-note" data-conn={conn}>
        <i aria-hidden="true" />
        {t(`conn.${conn}`)}
      </span>
    </div>
  );
}

export interface WorkspaceRailProps {
  workspaces: readonly WorkspaceItem[];
  sessions: readonly SessionSummary[];
  currentScope: WorkspaceScope;
  /** 聚焦页当前打开的会话 id（用于在所属 Main Agent 下展开兄弟会话快捷跳转）。 */
  focusedSessionId?: SessionId;
  /** 聚焦页当前会话所属的 Main Agent key。 */
  focusedOriginKey?: string;
  /** 每个 Main Agent 对应的真实 Git 分支名（有才显示）。 */
  branches?: ReadonlyMap<string, string>;
  /** 当前页是“已归档”视图：它不属于任何工作空间，所以“进行中 / 全部 / 某个 Main Agent”都不高亮，只有底部的“已归档”行高亮。 */
  archivedActive?: boolean;
}

interface SiblingWindowState {
  /** 这份窗口位置属于哪个 Main Agent；离开聚焦页（没有兄弟列表）时是 undefined。 */
  scope: string | undefined;
  memory: WindowMemory | undefined;
}

/**
 * 兄弟会话的可见窗口（规则见 lib/sessionOrder.ts 的 placeWindow）。窗口要记得自己在哪儿，所以位置存在 state 里；
 * 渲染时发现当前会话落到了窗口之外，就在同一次渲染里把新位置记下来（React 允许渲染中更新自己的 state，不会先画出一帧没有当前会话的列表）。
 * state 放在整个侧栏这一层，而不是某个 Main Agent 的条目里：条目会因为“进行中 / 最近”的分段变化被换到另一段、整个重新挂载，
 * 那时窗口不该跟着复位。换了 Main Agent、或离开聚焦页（scope 变成 undefined）就忘掉，下次从最上面重新开始——窗口位置不跨空间、不跨页面带着走。
 */
function useSiblingWindow(
  ordered: readonly SessionSummary[],
  currentId: SessionId | undefined,
  scope: string | undefined,
): RowWindow<SessionSummary> {
  const [held, setHeld] = useState<SiblingWindowState>({ scope, memory: undefined });
  const placed = placeWindow(ordered, currentId, held.scope === scope ? held.memory : undefined, SIBLING_VISIBLE_LIMIT);
  if (held.scope !== scope || !sameWindowMemory(held.memory, placed.memory)) setHeld({ scope, memory: placed.memory });
  return placed;
}

/**
 * 方案 A 宽屏左侧栏（Workspace Rail）：
 * - 按 Main Agent 隔离画布，分「进行中 / 最近 / 更早」三段呈现，一眼锁定活跃任务；
 * - 底部收纳「设置」，彻底告别浮在画布中央的胶囊 Dock；
 * - 进入聚焦页时，在所属 Main Agent 下展开同空间会话，无需退回画布即可横跳兄弟会话。
 */
export function WorkspaceRail({
  workspaces,
  sessions,
  currentScope,
  focusedSessionId,
  focusedOriginKey,
  branches,
  archivedActive = false,
}: WorkspaceRailProps): ReactNode {
  const t = useT();
  const lang = useLang();
  const archivedCount = useStore(store, (s) => s.archivedCount);
  const [earlierOpen, setEarlierOpen] = useState(false);
  const mod = shortcutModifier();
  const toggleKeys = mod === "⌘" ? "⌘B" : "Ctrl+B";

  const activeWorkspaces = useMemo(
    () => workspaces.filter((item) => item.working > 0 || item.attention > 0),
    [workspaces],
  );
  const idleWorkspaces = useMemo(
    () => workspaces.filter((item) => item.working === 0 && item.attention === 0),
    [workspaces],
  );
  const recentItems = idleWorkspaces.slice(0, RECENT_VISIBLE_LIMIT);
  const earlierItems = idleWorkspaces.slice(RECENT_VISIBLE_LIMIT);

  const selectedOriginKey = focusedOriginKey ?? (currentScope.kind === "origin" ? currentScope.key : undefined);
  const selectedInEarlier = earlierItems.some((item) => item.key === selectedOriginKey);
  const showEarlier = earlierOpen || selectedInEarlier;

  const totalWorking = useMemo(() => workspaces.reduce((sum, item) => sum + item.working, 0), [workspaces]);
  const totalRunning = useMemo(() => workspaces.reduce((sum, item) => sum + item.running, 0), [workspaces]);

  // 聚焦页下当前空间的兄弟会话。顺序与列表视图是同一份（flattenSessions）：只看创建先后与 id，
  // 会话开始、结束、有新事件、点了另一行，行都不换位；当前打开的会话留在它自己的位置上，只靠高亮标出。
  // 依赖里没有当前会话的 id：点另一行不会重算顺序，只是窗口（见 useSiblingWindow）与高亮跟着变。
  const siblingScope = focusedSessionId ? focusedOriginKey : undefined;
  const siblings = useMemo(
    () =>
      siblingScope
        ? flattenSessions(sessionsInScope(sessions, { kind: "origin", key: siblingScope })).map((row) => row.session)
        : [],
    [siblingScope, sessions],
  );
  const siblingWindow = useSiblingWindow(siblings, focusedSessionId, siblingScope);

  // 侧栏的“进行中 / 全部 / 某个 Main Agent”只在概览页才高亮当前所在：聚焦页由兄弟会话与所属空间表达，“已归档”视图不属于任何空间，也不借用上一次的空间高亮。
  const onOverview = !focusedSessionId && !archivedActive;

  const renderOriginItem = (item: WorkspaceItem): ReactNode => {
    const title = workspaceDisplayTitle(item, t);
    const active = onOverview && currentScope.kind === "origin" && currentScope.key === item.key;
    const focusedParent = Boolean(focusedSessionId && focusedOriginKey === item.key);
    const branch = branches?.get(item.key);
    const meta = workspaceSubtitle(item, lang, branch);
    const visibleSiblings = focusedParent ? siblingWindow.rows : [];
    const hiddenSiblings = focusedParent ? siblingWindow.hidden : 0;

    return (
      <div key={item.key} className="rail-entry" data-focused-parent={focusedParent ? "" : undefined}>
        <button
          type="button"
          className="rail-item"
          aria-current={active ? "page" : undefined}
          data-active={active || focusedParent ? "" : undefined}
          data-live={item.running > 0 ? "" : undefined}
          onClick={() => selectWorkspace({ kind: "origin", key: item.key })}
        >
          <span className="rail-item-top">
            <span className="rail-item-ico">
              <HostMark host={item.origin.host} size={12.5} fit />
            </span>
            <span className="rail-item-title" data-tip={title}>
              {title}
            </span>
            <span className="rail-item-badges">
              {item.attention > 0 ? (
                <span className="rail-att" data-tip={t("attention.title")}>
                  <Icon name="alert" size={10.5} />
                </span>
              ) : null}
              {item.running > 0 ? (
                <span className="rail-live num">
                  <i className="a-run" aria-hidden="true" />
                  {item.running}
                </span>
              ) : (
                <span className="rail-count num">{item.total}</span>
              )}
            </span>
          </span>
          {meta ? (
            <span className="rail-item-sub" data-tip={item.workspace ? `${item.workspace}${branch ? ` (${branch})` : ""}` : meta}>
              {meta}
            </span>
          ) : null}
        </button>

        {visibleSiblings.length > 0 ? (
          <div className="rail-siblings" role="group" aria-label={t("rail.siblings")}>
            {visibleSiblings.map((sibling) => {
              const current = sibling.id === focusedSessionId;
              return (
                <button
                  key={sibling.id}
                  type="button"
                  className="rail-sibling"
                  aria-current={current ? "page" : undefined}
                  data-active={current ? "" : undefined}
                  data-phase={sibling.phase}
                  onClick={() => navigate({ kind: "session", id: sibling.id })}
                >
                  <i className="rail-sibling-dot" data-phase={sibling.phase} aria-hidden="true" />
                  <span className="rail-sibling-title" data-tip={sibling.title}>
                    {sibling.title}
                  </span>
                </button>
              );
            })}
            {hiddenSiblings > 0 ? (
              <button
                type="button"
                className="rail-sibling rail-sibling--more"
                onClick={() => selectWorkspace({ kind: "origin", key: item.key })}
              >
                {t("rail.moreSessions", { n: hiddenSiblings })}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <aside className="rail-panel" aria-label={t("rail.label")} data-modal-inert>
      <div className="rail-brand">
        <button
          type="button"
          className="rail-logo"
          onClick={() => selectWorkspace(workspaces[0] ? { kind: "origin", key: workspaces[0].key } : { kind: "all" })}
        >
          Ensemble
        </button>
        <button
          type="button"
          className="rail-ico-btn"
          aria-label={t("rail.collapse", { keys: toggleKeys })}
          data-tip={t("rail.collapse", { keys: toggleKeys })}
          onClick={() => setRailCollapsed(true)}
        >
          <Icon name="sidebar" size={14} />
        </button>
      </div>

      <nav className="rail-nav">
        <div className="rail-views">
          <button
            type="button"
            className="rail-item rail-item--view"
            aria-current={onOverview && sameScope(currentScope, { kind: "active" }) ? "page" : undefined}
            data-active={onOverview && sameScope(currentScope, { kind: "active" }) ? "" : undefined}
            onClick={() => selectWorkspace({ kind: "active" })}
          >
            <span className="rail-item-top">
              <span className="rail-item-ico">
                <Icon name="zap" size={12.5} />
              </span>
              <span className="rail-item-title">{t("rail.active")}</span>
              <span className="rail-item-badges">
                {totalRunning > 0 ? (
                  <span className="rail-live num">
                    <i className="a-run" aria-hidden="true" />
                    {totalWorking}
                  </span>
                ) : (
                  <span className="rail-count num">{totalWorking}</span>
                )}
              </span>
            </span>
          </button>

          <button
            type="button"
            className="rail-item rail-item--view"
            aria-current={onOverview && sameScope(currentScope, { kind: "all" }) ? "page" : undefined}
            data-active={onOverview && sameScope(currentScope, { kind: "all" }) ? "" : undefined}
            onClick={() => selectWorkspace({ kind: "all" })}
          >
            <span className="rail-item-top">
              <span className="rail-item-ico">
                <Icon name="layers" size={12.5} />
              </span>
              <span className="rail-item-title">{t("rail.all")}</span>
              <span className="rail-item-badges">
                <span className="rail-count num">{sessions.length}</span>
              </span>
            </span>
          </button>
        </div>

        <div className="rail-scroll">
          {workspaces.length === 0 ? (
            <div className="rail-empty">{t("rail.empty")}</div>
          ) : (
            <>
              {activeWorkspaces.length > 0 ? (
                <div className="rail-section">
                  <div className="rail-section-label">{t("rail.sectionActive")}</div>
                  {activeWorkspaces.map(renderOriginItem)}
                </div>
              ) : null}

              {recentItems.length > 0 ? (
                <div className="rail-section">
                  <div className="rail-section-label">{t("rail.sectionRecent")}</div>
                  {recentItems.map(renderOriginItem)}
                </div>
              ) : null}

              {earlierItems.length > 0 ? (
                <div className="rail-section">
                  <button
                    type="button"
                    className="rail-section-toggle"
                    aria-expanded={showEarlier}
                    onClick={() => setEarlierOpen((v) => !v)}
                  >
                    <Icon name={showEarlier ? "chevronDown" : "chevronRight"} size={11} strokeWidth={2.2} />
                    <span>{t("rail.sectionEarlier", { n: earlierItems.length })}</span>
                  </button>
                  {showEarlier ? earlierItems.map(renderOriginItem) : null}
                </div>
              ) : null}
            </>
          )}
        </div>

        {/* 归档的入口：安静地待在列表之下、底栏之上，不抢“进行中 / 最近”的注意力。服务不报个数（老服务，没有归档）就没有它；
            已经在这个视图里、而它恰好空了（刚把最后一条取消归档）时仍保留，免得页面还在而入口消失。 */}
        {archivedCount !== undefined && (archivedCount > 0 || archivedActive) ? (
          <div className="rail-archived">
            <button
              type="button"
              className="rail-item rail-item--view"
              aria-current={archivedActive ? "page" : undefined}
              data-active={archivedActive ? "" : undefined}
              onClick={() => navigate({ kind: "archived" })}
            >
              <span className="rail-item-top">
                <span className="rail-item-ico">
                  <Icon name="archive" size={12.5} />
                </span>
                <span className="rail-item-title">{t("archive.title")}</span>
                <span className="rail-item-badges">
                  <span className="rail-count num">{archivedCount}</span>
                </span>
              </span>
            </button>
          </div>
        ) : null}
      </nav>

      <footer className="rail-foot">
        <StatusNotices variant="inline" />
        <div className="rail-foot-actions">
          <button
            type="button"
            className="rail-settings"
            aria-label={t("topbar.settings")}
            data-tip={t("topbar.settings")}
            onClick={() => openSettings()}
          >
            <Icon name="settings" size={15} />
          </button>
        </div>
      </footer>
    </aside>
  );
}

/**
 * 宽屏下用户收起左侧栏之后，页面上唯一留下的控件：一个只有图标的“展开侧栏”按钮。
 * 图标与外观都和侧栏头部的“收起”按钮一样（同一个开关的两个方向）；它浮在左上角、不占文档流，所以收起只带来横向的变化，
 * 不会多出顶栏或别的东西。位置与各页标头为它让出的位置见 workspace.css 的“收起侧栏后的展开按钮”一节。
 * 只在宽屏渲染（由 App 判断）：窄屏本来就没有侧栏可展开。收起后切换工作空间用 Ctrl/⌘+K，设置要展开侧栏后从底部进入。
 */
export function RailExpandButton(): ReactNode {
  const t = useT();
  const toggleKeys = shortcutModifier() === "⌘" ? "⌘B" : "Ctrl+B";
  const label = t("rail.expand", { keys: toggleKeys });

  return (
    <button
      type="button"
      className="rail-ico-btn rail-expand"
      aria-label={label}
      data-tip={label}
      data-modal-inert
      onClick={() => setRailCollapsed(false)}
    >
      <Icon name="sidebar" size={14} />
    </button>
  );
}

export interface WorkspaceTopBarProps {
  currentScope: WorkspaceScope;
  currentWorkspace?: WorkspaceItem;
  /** 当前页是“已归档”视图：它不属于任何空间，快切入口的名字改写成“已归档”（点开仍是切换空间的快切器，用来离开这一页）。 */
  archived?: boolean;
}

/**
 * 窄屏（< 860px，没有侧栏）的 44px 极简顶栏，是窄屏唯一的工作空间切换与设置入口：
 * 左为品牌字样与当前空间快切入口，右为设置。宽屏收起侧栏之后不会换成它（那里只留一个展开按钮，见 RailExpandButton）。
 */
export function WorkspaceTopBar({ currentScope, currentWorkspace, archived = false }: WorkspaceTopBarProps): ReactNode {
  const t = useT();
  const mod = shortcutModifier();
  const kbd = mod === "⌘" ? "⌘K" : "Ctrl K";

  const label = archived
    ? t("archive.title")
    : currentScope.kind === "origin" && currentWorkspace
      ? workspaceDisplayTitle(currentWorkspace, t)
      : currentScope.kind === "active"
        ? t("rail.active")
        : t("rail.all");

  return (
    <header className="ws-topbar" data-modal-inert>
      <div className="ws-topbar-left">
        <span className="ws-topbar-brand">Ensemble</span>

        <button
          type="button"
          className="ws-topbar-switch"
          aria-label={t("rail.switchTip", { keys: kbd })}
          data-tip={t("rail.switchTip", { keys: kbd })}
          onClick={() => openSwitcher()}
        >
          {archived ? (
            <Icon name="archive" size={12.5} />
          ) : currentScope.kind === "origin" && currentWorkspace ? (
            <HostMark host={currentWorkspace.origin.host} size={12.5} fit />
          ) : (
            <Icon name={currentScope.kind === "active" ? "zap" : "layers"} size={12.5} />
          )}
          <span className="ws-topbar-name">{label}</span>
          <Icon name="chevronDown" size={12} className="ws-topbar-chev" />
        </button>
      </div>

      <div className="ws-topbar-right">
        <button
          type="button"
          className="rail-ico-btn"
          aria-label={t("topbar.settings")}
          data-tip={t("topbar.settings")}
          onClick={() => openSettings()}
        >
          <Icon name="settings" size={15} />
        </button>
      </div>
    </header>
  );
}
