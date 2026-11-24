import { useEffect, useMemo, type ReactNode } from "react";
import { ArchivedView } from "./components/ArchivedView";
import { Dock } from "./components/Dock";
import { Focus } from "./components/Focus";
import { Icon } from "./components/Icons";
import { Overview } from "./components/Overview";
import { ConfirmDialog, Toasts } from "./components/Overlays";
import { QuickSwitcher } from "./components/QuickSwitcher";
import { SettingsWindow } from "./components/settings/SettingsWindow";
import { TipHost } from "./components/ui";
import { RailExpandButton, WorkspaceRail, WorkspaceTopBar } from "./components/WorkspaceRail";
import {
  recordRecentOrigin,
  selectWorkspace,
  setRailCollapsed,
  startRouting,
  store,
  toggleSwitcher,
} from "./lib/app";
import { directoryKey } from "./lib/folder";
import { planGit, useGit } from "./lib/git";
import { startLive } from "./lib/live";
import { useStore } from "./lib/store";
import { useEmptiedSpace } from "./lib/useEmptiedSpace";
import { useLang, useT } from "./lib/useT";
import { useWideShell } from "./lib/useWideShell";
import {
  buildWorkspaces,
  originKeyOfSession,
  resolveWorkspace,
  stepOriginScope,
} from "./lib/workspaces";
import { SceneEngine } from "./scene/engine";

function Loading(): ReactNode {
  const t = useT();
  const conn = useStore(store, (s) => s.conn);
  if (conn === "offline") {
    return (
      <div className="boot boot--offline" role="alert">
        <div className="state-card">
          <span className="state-icon" data-tone="red">
            <Icon name="alert" size={22} />
          </span>
          <h2>{t("boot.offlineTitle")}</h2>
          <p>{t("boot.offlineBody")}</p>
          <div className="state-actions">
            <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
              <Icon name="refresh" size={14} />
              {t("boot.reload")}
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="boot" role="status">
      <span className="spinner" style={{ width: 18, height: 18 }} />
      <span>{t("boot.connecting")}</span>
    </div>
  );
}

export function App(): ReactNode {
  const route = useStore(store, (s) => s.route);
  const ready = useStore(store, (s) => s.ready);
  const sessionsMap = useStore(store, (s) => s.sessions);
  const lastWorkspace = useStore(store, (s) => s.lastWorkspace);
  const railCollapsed = useStore(store, (s) => s.railCollapsed);
  const lang = useLang();
  const wide = useWideShell();
  const engine = useMemo(() => new SceneEngine(), []);

  const allSessions = useMemo(() => Object.values(sessionsMap), [sessionsMap]);
  const workspaces = useMemo(() => buildWorkspaces(allSessions), [allSessions]);

  const focusedSessionId = route.kind === "session" ? route.id : undefined;
  const focusedOriginKey = useMemo(
    () => (focusedSessionId ? originKeyOfSession(allSessions, focusedSessionId) : undefined),
    [allSessions, focusedSessionId],
  );

  const currentScope = useMemo(() => {
    if (route.kind === "session" && focusedOriginKey) return { kind: "origin" as const, key: focusedOriginKey };
    const explicit = route.kind === "overview" ? route.scope : undefined;
    return resolveWorkspace(explicit, lastWorkspace, workspaces);
  }, [route, focusedOriginKey, lastWorkspace, workspaces]);

  const currentWorkspace = useMemo(
    () => (currentScope.kind === "origin" ? workspaces.find((item) => item.key === currentScope.key) : undefined),
    [currentScope, workspaces],
  );

  // 正看着的 Main Agent 空间被归档清空时，地址栏跟上回退后的画面，并说明东西去了哪里（见 lib/useEmptiedSpace）。
  // 传的是“地址栏（或上次看的空间）指向的那个空间”，不是 currentScope：currentScope 在空间消失的同一次渲染里就已经按回退规则
  // 换成了别的空间，钩子拿它比对永远等不到“它消失了”，地址栏不会改写、提示也不会出现。
  const watchedScope = route.kind === "overview" ? (route.scope ?? lastWorkspace ?? currentScope) : currentScope;
  useEmptiedSpace(route, watchedScope, workspaces, ready);

  // 全站共用一份只读 Git 快照轮询：左侧栏分支、快切器搜索、单空间标头与全景 Git 卡共用。
  const gitPlan = useMemo(() => planGit(allSessions), [allSessions]);
  const gitState = useGit(gitPlan.targets);
  const branches = useMemo(() => {
    const map = new Map<string, string>();
    if (gitState.entries.size === 0) return map;
    const byDir = new Map<string, string>();
    for (const [path, entry] of gitState.entries) {
      if (entry.git.branch) byDir.set(directoryKey(path), entry.git.branch);
    }
    for (const item of workspaces) {
      if (!item.workspace) continue;
      const direct = gitState.entries.get(item.workspace)?.git.branch;
      const branch = direct ?? byDir.get(directoryKey(item.workspace));
      if (branch) map.set(item.key, branch);
    }
    return map;
  }, [gitState.entries, workspaces]);

  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [lang]);

  useEffect(() => {
    const stopRouting = startRouting();
    const stopLive = startLive();
    return () => {
      stopRouting();
      stopLive();
    };
  }, []);

  // 记录当前活跃的 Main Agent，确保 ⌘K 快切器总有准确的 MRU 顺序。
  useEffect(() => {
    if (currentScope.kind === "origin") recordRecentOrigin(currentScope.key);
  }, [currentScope]);

  // 全局工作空间快捷键：⌘K / Ctrl+K 快切器、⌘B / Ctrl+B 折叠侧栏、[ / ] 或 Alt+↑/↓ 快速轮换 Main Agent。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.isComposing) return;
      const state = store.get();
      if (state.confirm) return;
      const target = event.target as HTMLElement | null;
      const inInput = Boolean(target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName)));

      const lower = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && lower === "k") {
        event.preventDefault();
        toggleSwitcher();
        return;
      }

      if (inInput) return;

      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && lower === "b" && wide) {
        if (state.settings.open || state.switcherOpen) return;
        event.preventDefault();
        setRailCollapsed(!state.railCollapsed);
        return;
      }

      if (state.settings.open || state.switcherOpen) return;
      if (document.querySelector('[role="menu"]')) return;

      if (!event.metaKey && !event.ctrlKey && !event.altKey && (event.key === "[" || event.key === "]")) {
        const next = stepOriginScope(workspaces, currentScope, event.key === "]" ? 1 : -1);
        if (next) {
          event.preventDefault();
          selectWorkspace(next);
        }
        return;
      }

      if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        const next = stepOriginScope(workspaces, currentScope, event.key === "ArrowDown" ? 1 : -1);
        if (next) {
          event.preventDefault();
          selectWorkspace(next);
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [wide, workspaces, currentScope]);

  // 左侧栏只存在于宽屏：展开时是侧栏；用户收起它（Ctrl/⌘+B 或侧栏里的按钮）之后页面不换样子，
  // 只在左上角留一个“展开侧栏”按钮（见 RailExpandButton），没有顶栏、不改纵向几何，也没有过渡动画。
  // 窄屏没有侧栏可收可展（收起的偏好不影响它），顶栏是窄屏唯一的工作空间切换与设置入口，只在概览页与“已归档”视图出现
  // （“已归档”视图没有自己的返回键，窄屏要靠顶栏的快切器离开；聚焦页有自己的“返回”）。
  // data-rail 的三个取值把这三种情形分开：open（宽屏、侧栏展开）/ collapsed（宽屏、已收起）/ none（窄屏），样式靠它区分。
  const showRail = wide && !railCollapsed;
  const showExpand = wide && railCollapsed;
  const archivedView = route.kind === "archived";
  const showTopBar = !wide && (route.kind === "overview" || archivedView);

  return (
    <div
      className="app"
      data-view={route.kind}
      data-rail={showRail ? "open" : showExpand ? "collapsed" : "none"}
      data-topbar={showTopBar ? "" : undefined}
    >
      {showRail ? (
        <WorkspaceRail
          workspaces={workspaces}
          sessions={allSessions}
          currentScope={currentScope}
          {...(focusedSessionId ? { focusedSessionId } : {})}
          {...(focusedOriginKey ? { focusedOriginKey } : {})}
          branches={branches}
          archivedActive={archivedView}
        />
      ) : showExpand ? (
        <RailExpandButton />
      ) : null}

      <div className="shell-main" data-modal-inert>
        {showTopBar ? (
          <WorkspaceTopBar
            currentScope={currentScope}
            {...(currentWorkspace ? { currentWorkspace } : {})}
            archived={archivedView}
          />
        ) : null}

        <div className="stage">
          {!ready ? (
            <Loading />
          ) : route.kind === "session" ? (
            <Focus key={route.id} id={route.id} />
          ) : archivedView ? (
            <ArchivedView />
          ) : (
            <Overview
              engine={engine}
              scope={currentScope}
              workspaces={workspaces}
              gitState={gitState}
            />
          )}
        </div>
      </div>

      {/* 侧栏关闭时仅保留克制的连接状态提示，不再有底部胶囊工具栏。 */}
      {!showRail ? <Dock tools={false} notices /> : null}

      <QuickSwitcher
        workspaces={workspaces}
        sessions={allSessions}
        currentScope={currentScope}
        branches={branches}
      />
      <SettingsWindow />
      <ConfirmDialog />
      <Toasts />
      <TipHost />
    </div>
  );
}
