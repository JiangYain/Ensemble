import { useMemo, type ReactNode } from "react";
import type { SessionSummary } from "@shared/types";
import { setHideIdle, setViewMode, store, type ViewMode } from "../lib/app";
import { archiveUi, blockedText, confirmArchive } from "../lib/archive";
import { pickArchivable } from "../lib/archivePlan";
import type { GitEntry } from "../lib/git";
import { refTipLines, workspaceTipLine, workspaceUnknown } from "../lib/originText";
import { useStore } from "../lib/store";
import { dateMinute, dateTime, pathName } from "../lib/text";
import { useLang, useT } from "../lib/useT";
import { filterWorking } from "../lib/workFilter";
import type { WorkspaceItem, WorkspaceScope } from "../lib/workspaces";
import { Icon } from "./Icons";
import { HostMark } from "./OriginNode";

const CHANGE_PARTS = ["staged", "unstaged", "untracked", "conflicted"] as const;

export interface WorkspaceHeaderProps {
  scope: WorkspaceScope;
  /** 单 Main Agent 空间时对应的汇总信息。 */
  workspace?: WorkspaceItem;
  /** 单 Main Agent 空间且工作目录在 Git 仓库中时的真实只读 Git 快照。 */
  git?: GitEntry;
  /** 全部空间（用于 `active` / `all` 标头统计）。 */
  allWorkspaces: readonly WorkspaceItem[];
  /** 当前空间内的会话（用于计算“仅工作中”可收起的数量）。 */
  scopedSessions: readonly SessionSummary[];
  /** 全部会话（用于 `all` 标头统计）。 */
  allSessions: readonly SessionSummary[];
  /** 列表模式下标头占据文档流，画布模式下以半透明轻层悬浮在顶部。 */
  variant?: "overlay" | "flow";
}

function GitContextPill({ entry }: { entry: GitEntry }): ReactNode {
  const t = useT();
  const lang = useLang();
  const { git, stale } = entry;
  const repo = pathName(git.root);
  const { head, upstream, changes } = git;
  const sha = head?.sha.slice(0, 7);
  const branch = git.branch ?? (git.detached ? t("git.detached") : repo);
  const conflict = changes.conflicted > 0;
  const status = conflict
    ? t("git.conflicts", { n: changes.conflicted })
    : changes.files > 0
      ? t("git.dirty", { n: changes.files })
      : t("git.clean");
  const checked = dateTime(git.checkedAt, lang);

  const upstreamParts = upstream
    ? [
        upstream.name,
        upstream.ahead > 0 ? t("git.ahead", { n: upstream.ahead }) : undefined,
        upstream.behind > 0 ? t("git.behind", { n: upstream.behind }) : undefined,
      ]
    : [];
  if (upstream && upstream.ahead === 0 && upstream.behind === 0) upstreamParts.push(t("git.inSync"));
  const parts = CHANGE_PARTS.filter((part) => changes[part] > 0).map((part) => t(`git.part.${part}`, { n: changes[part] }));
  const tip = [
    t("git.tipHead"),
    `${t("git.root")}: ${git.root}`,
    `${t("git.branch")}: ${git.branch ?? t("git.detached")}`,
    upstream ? `${t("git.upstream")}: ${upstreamParts.filter(Boolean).join(" · ")}` : undefined,
    head ? `${t("git.commit")}: ${sha} ${head.subject} (${dateMinute(head.committedAt, lang)})` : t("git.noCommits"),
    `${t("git.changes")}: ${parts.length > 0 ? parts.join(" · ") : t("git.clean")}`,
    git.remote ? `${t("git.remote")}: ${git.remote.name} ${git.remote.url}` : undefined,
    stale ? t("git.stale", { time: checked }) : `${t("git.checked")}: ${checked}`,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <span className="ws-ctx-item ws-ctx-git" data-stale={stale ? "" : undefined} data-tip={tip}>
      <Icon name="git" size={11.5} className="ws-ctx-git-mark" />
      <span className="ws-ctx-branch">{branch}</span>
      {sha ? <span className="ws-ctx-sha mono">{sha}</span> : null}
      <span className="ws-ctx-status" data-kind={conflict ? "attention" : undefined}>
        {status}
      </span>
      {upstream && upstream.ahead > 0 ? (
        <span className="ws-ctx-sync num">
          <Icon name="arrowUp" size={9.5} strokeWidth={2.4} />
          {upstream.ahead}
        </span>
      ) : null}
      {upstream && upstream.behind > 0 ? (
        <span className="ws-ctx-sync num">
          <Icon name="arrowDown" size={9.5} strokeWidth={2.4} />
          {upstream.behind}
        </span>
      ) : null}
      {stale ? <Icon name="clock" size={11} className="ws-ctx-stale" /> : null}
    </span>
  );
}

/**
 * 画布与列表共用的极简单行上下文标头：
 * - 单 Main Agent 空间：移除冗余的重复大标题与会话总数，直接在一行呈现工作目录（置顶最左）与真实只读 Git 状态，
 *   与右侧 28px 高的视图控制组严格垂直居中齐平；
 * - 「全部活跃」与「全部空间」：同样克制为单行安静摘要。
 */
export function WorkspaceHeader({
  scope,
  workspace,
  git,
  allWorkspaces,
  scopedSessions,
  allSessions,
  variant = "overlay",
}: WorkspaceHeaderProps): ReactNode {
  const t = useT();
  const lang = useLang();
  const hideIdle = useStore(store, (s) => s.hideIdle);
  const viewMode = useStore(store, (s) => s.viewMode);

  const hideable = filterWorking(scopedSessions).hidden.size;
  const showFilter = scope.kind !== "active" && scopedSessions.length > 0;
  const filterHead = hideIdle
    ? hideable > 0
      ? t("dock.showAllTip", { n: hideable })
      : t("dock.showAllNone")
    : hideable > 0
      ? t("dock.hideIdleTip", { n: hideable })
      : t("dock.hideIdleNone");
  const filterTip = hideable > 0 ? `${filterHead}\n${t("dock.hideIdleReady")}\n${t("dock.hideIdleKept")}` : filterHead;

  // “归档已完成会话”：视图选项区里的一个动作（不放在 .ws-head-line 那一行：那一行只显示文字与图标，没有按钮）。
  // 服务不报已归档个数（老服务，没有归档）就没有这个入口；“进行中”是全部 Main Agent 里在工作的会话的并集，里面没有“已完成”可言，同样不提供。
  // 预判只在要显示按钮时才算，规则与服务端同源（lib/archivePlan → shared/archive），点下去由服务端裁决。
  const archiveAware = useStore(store, (s) => s.archivedCount !== undefined);
  const archiveBusy = useStore(archiveUi, (s) => s.busy > 0);
  const showArchive = archiveAware && scope.kind !== "active" && scopedSessions.length > 0;
  const archivePick = useMemo(
    () => (showArchive ? pickArchivable(scopedSessions, allSessions) : undefined),
    [showArchive, scopedSessions, allSessions],
  );
  const archivable = archivePick?.changed.length ?? 0;
  const archiveDisabled = archivePick === undefined || archivable === 0 || archiveBusy;
  // 悬停与读屏的说明：能归档时写明数量与留下的原因；不能时写明真实的原因（还有会话在工作 / 待命 / 消息未确认），没有会话可挑才是“没有已完成的”。
  const archiveTip =
    archivePick === undefined
      ? ""
      : archiveBusy
        ? t("archive.busy")
        : archivable === 0
          ? archivePick.blocked
            ? blockedText(archivePick.blocked, t)
            : t("archive.nothing")
          : [
              t("archive.finishedTip", { n: archivable }),
              archivePick.kept > 0 && archivePick.blocked ? blockedText(archivePick.blocked, t) : undefined,
            ]
              .filter(Boolean)
              .join("\n");

  const renderLeft = (): ReactNode => {
    if (scope.kind === "origin" && workspace) {
      const { origin } = workspace;
      const dir = workspace.workspace;
      const unknown = workspaceUnknown(origin);
      const contextTip = [
        workspace.hostTitle ? `${workspace.hostTitle}` : undefined,
        t("origin.tipHead", { host: origin.hostLabel }),
        ...refTipLines(origin, t),
        workspaceTipLine(origin, t),
        `${t("origin.started")}: ${dateTime(workspace.startedAt, lang)}`,
      ]
        .filter(Boolean)
        .join("\n");

      return (
        <div className="ws-head-line">
          {dir ? (
            <span className="ws-ctx-primary" data-tip={contextTip}>
              <Icon name="folder" size={13} className="ws-ctx-ico" />
              <span className="ws-ctx-folder">{pathName(dir)}</span>
            </span>
          ) : unknown ? (
            <span className="ws-ctx-primary ws-ctx-unknown" data-tip={contextTip}>
              <Icon name="folder" size={13} className="ws-ctx-ico" />
              <span>{t("origin.workspaceUnknown")}</span>
            </span>
          ) : (
            <span className="ws-ctx-primary" data-tip={contextTip}>
              <HostMark host={origin.host} size={13} fit />
              <span className="ws-ctx-folder">{origin.kind === "user" ? t("origin.user") : origin.hostLabel}</span>
            </span>
          )}
          {git ? (
            <>
              <span className="ws-ctx-sep" aria-hidden="true" />
              <GitContextPill entry={git} />
            </>
          ) : null}
        </div>
      );
    }

    if (scope.kind === "active") {
      const running = allWorkspaces.reduce((sum, item) => sum + item.running, 0);
      const working = allWorkspaces.reduce((sum, item) => sum + item.working, 0);
      const activeOrigins = allWorkspaces.filter((item) => item.working > 0).length;
      return (
        <div className="ws-head-line">
          <span className="ws-ctx-primary">
            <Icon name="zap" size={13} className="ws-ctx-ico" />
            <span className="ws-ctx-folder">{t("rail.active")}</span>
          </span>
          <span className="ws-ctx-sep" aria-hidden="true" />
          <span className="ws-ctx-item num">
            {t("view.activeSubtitle", { running, total: working, n: activeOrigins })}
          </span>
        </div>
      );
    }

    return (
      <div className="ws-head-line">
        <span className="ws-ctx-primary">
          <Icon name="layers" size={13} className="ws-ctx-ico" />
          <span className="ws-ctx-folder">{t("rail.all")}</span>
        </span>
        <span className="ws-ctx-sep" aria-hidden="true" />
        <span className="ws-ctx-item num">
          {t("view.allSubtitle", { n: allWorkspaces.length, total: allSessions.length })}
        </span>
      </div>
    );
  };

  const setMode = (mode: ViewMode): void => {
    if (viewMode !== mode) setViewMode(mode);
  };

  return (
    <header className="ws-head" data-mode={variant} data-scene-ui>
      {renderLeft()}
      <div className="ws-head-actions">
        {showFilter ? (
          <button
            type="button"
            className="ws-action-btn ws-filter-btn"
            aria-label={t("dock.hideIdle")}
            aria-pressed={hideIdle}
            aria-description={filterTip}
            data-tip={filterTip}
            data-active={hideIdle ? "" : undefined}
            onClick={() => setHideIdle(!hideIdle)}
          >
            <Icon name="eyeOff" size={13} />
            <span className="ws-action-label">{t("view.workingOnly")}</span>
            {hideIdle && hideable > 0 ? <span className="ws-filter-count num">{hideable > 99 ? "99+" : hideable}</span> : null}
          </button>
        ) : null}
        {archivePick ? (
          <button
            type="button"
            className="ws-action-btn ws-archive-btn"
            aria-label={t("archive.finished")}
            aria-disabled={archiveDisabled ? "true" : undefined}
            aria-description={archiveTip}
            data-tip={archiveTip}
            onClick={() => {
              // aria-disabled 不拦点击：禁用的按钮仍能被键盘聚焦、读出原因，所以点击要自己判断。
              if (!archiveDisabled) confirmArchive(archivePick);
            }}
          >
            <Icon name="archive" size={13} />
            <span className="ws-action-label">{t("archive.finished")}</span>
            {archivable > 0 ? <span className="ws-filter-count num">{archivable > 99 ? "99+" : archivable}</span> : null}
          </button>
        ) : null}
        {allSessions.length > 0 ? (
          <div className="ws-view-switch" role="group" aria-label={t("view.mode")}>
            <button
              type="button"
              className="ws-view-btn"
              data-view-mode="canvas"
              aria-label={t("view.canvas")}
              aria-pressed={viewMode === "canvas"}
              data-active={viewMode === "canvas" ? "" : undefined}
              onClick={() => setMode("canvas")}
            >
              <Icon name="canvas" size={13} />
              <span className="ws-action-label">{t("view.canvas")}</span>
            </button>
            <button
              type="button"
              className="ws-view-btn"
              data-view-mode="list"
              aria-label={t("view.list")}
              aria-pressed={viewMode === "list"}
              data-active={viewMode === "list" ? "" : undefined}
              onClick={() => setMode("list")}
            >
              <Icon name="list" size={13} />
              <span className="ws-action-label">{t("view.list")}</span>
            </button>
          </div>
        ) : null}
      </div>
    </header>
  );
}
