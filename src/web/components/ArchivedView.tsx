import { useEffect, useMemo, useState, type ReactNode } from "react";
import { formatDuration } from "@shared/format";
import type { SessionSummary } from "@shared/types";
import { navigate, openSettings, routeHash, store } from "../lib/app";
import { archiveUi, loadArchived, unarchiveSessions } from "../lib/archive";
import { descendantsOf, type Descendants } from "../lib/archivePlan";
import { modelFamily } from "../lib/modelFamily";
import { flattenSessions } from "../lib/sessionOrder";
import { useStore } from "../lib/store";
import { dateMinute, phaseLabel, subtitleOf } from "../lib/text";
import { useLang, useT } from "../lib/useT";
import { harnessName, modelLabel } from "../lib/view";
import { HarnessMark } from "./HarnessMark";
import { Icon } from "./Icons";
import { MenuButton } from "./Menu";
import { ModelSlot } from "./ModelMark";
import { exportMenuItems } from "./sessionActions";
import { Chip, IconButton, Spinner } from "./ui";

/** 一次最多画这么多行，其余在“显示更多”后面：归档的目的就是装下很长的历史，几千行一次画出来页面会卡。 */
const PAGE = 200;

interface ArchivedRowProps {
  session: SessionSummary;
  depth: number;
  below: Descendants;
  busy: boolean;
}

/**
 * 已归档会话的一行。版式沿用列表视图的行（同一套 slist-* 样式：头像、标题与副标题、执行端与模型、状态与时间），
 * 区别只在两处：时间是“归档于”，行尾是两个动作——取消归档、导出——而不是会话菜单（已归档的会话不能被操作，只能恢复或导出）。
 * 行上不画色条，也没有工作中的氤氲：已归档的会话都是结束了的。
 */
function ArchivedRow({ session, depth, below, busy }: ArchivedRowProps): ReactNode {
  const t = useT();
  const lang = useLang();
  const simulated = session.runtime === "fixture";
  const model = modelLabel(session, t);
  const effort = session.effort?.trim() || undefined;
  const subtitle = subtitleOf(session, t);
  const duration = session.phase === "done" ? session.lastRun?.durationMs : undefined;
  const when = session.archivedAt ? dateMinute(session.archivedAt, lang, true) : "";
  const href = routeHash({ kind: "session", id: session.id });

  return (
    <div
      className="slist-row arow"
      role="listitem"
      data-phase={session.phase}
      data-depth={depth}
      style={depth > 0 ? { paddingLeft: 20 + depth * 22 } : undefined}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a,button,[role='menu']")) return;
        navigate({ kind: "session", id: session.id });
      }}
    >
      {depth > 0 ? <span className="slist-branch" aria-hidden="true" /> : null}
      <div className="slist-avatar">
        <ModelSlot family={modelFamily(session.model)} simulated={simulated} size={20} />
      </div>
      <div className="slist-main">
        <div className="slist-top">
          <a className="slist-title" href={href} onClick={(event) => event.stopPropagation()}>
            {session.title}
          </a>
          {below.count > 0 ? (
            <span className="slist-files num">{below.complete ? t("archive.children", { n: below.count }) : t("archive.childrenAny")}</span>
          ) : null}
          {session.archivedBy === "retention" ? (
            <Chip tone="neutral" tip={t("archive.autoTip")}>
              {t("archive.auto")}
            </Chip>
          ) : null}
        </div>
        <div className="slist-sub" data-tip={subtitle}>
          {subtitle}
        </div>
      </div>
      <div className="slist-spec">
        <span className="slist-harness">
          <HarnessMark harness={session.harness} size={11} variant="bare" />
          <span>{harnessName(session.harness, t)}</span>
        </span>
        <span className="slist-model" data-tip={model}>
          {simulated ? t("run.simulated") : model}
        </span>
        {!simulated && effort ? <span className="a-effort">{effort}</span> : null}
      </div>
      <div className="slist-meta">
        <span className={`slist-state${duration === undefined ? "" : " num"}`} data-kind={session.phase}>
          {duration === undefined ? phaseLabel(session.phase, t) : formatDuration(duration)}
        </span>
        {when ? (
          <time className="slist-time num" dateTime={session.archivedAt}>
            {t("archive.archivedAt", { time: when })}
          </time>
        ) : null}
      </div>
      <div className="arow-actions">
        <IconButton
          icon="unarchive"
          size={15}
          label={t("archive.unarchiveOf", { title: session.title })}
          data-tip={t("archive.unarchiveTip")}
          disabled={busy}
          onClick={() => void unarchiveSessions([session.id])}
        />
        <MenuButton items={() => exportMenuItems(session, t)} label={t("archive.exportOf", { title: session.title })} icon="download" />
      </div>
    </div>
  );
}

/**
 * “已归档”视图（`#/archived`）：一张平铺的历史列表，按任务树缩进（顺序与列表视图同一份，见 lib/sessionOrder）。
 * 它不是工作空间（不属于任何 Main Agent，没有画布，也不参与 ⌘K 与 [ ] 的轮换），所以没有空间标头，只有一行标题与说明。
 *
 * 数据：已归档的会话不在快照里。第一次进到这里才读一次整份（`GET /api/sessions?archived=only`），之后靠推送保持新鲜
 * （归档 / 取消归档都会推来摘要，见 lib/app.routeSummary），不轮询。读失败是一块内联的提示加“重试”，不是弹窗。
 * 服务不报已归档个数（老服务，没有归档）时只说明这一点，不去读也不报错。
 */
export function ArchivedView(): ReactNode {
  const t = useT();
  const archived = useStore(store, (s) => s.archived);
  const loaded = useStore(store, (s) => s.archivedLoaded);
  const count = useStore(store, (s) => s.archivedCount);
  const list = useStore(archiveUi, (s) => s.list);
  const busy = useStore(archiveUi, (s) => s.busy > 0);
  const supported = count !== undefined;
  const [shown, setShown] = useState(PAGE);

  // 读失败后不会自己再试（loaded 仍是 false、supported 没变，这个 effect 不会重跑）：重试是用户点的。
  useEffect(() => {
    if (supported && !loaded) void loadArchived().catch(() => undefined);
  }, [supported, loaded]);

  const rows = useMemo(() => flattenSessions(Object.values(archived)), [archived]);
  const visible = rows.length > shown ? rows.slice(0, shown) : rows;

  const body = ((): ReactNode => {
    if (!supported) return <div className="slist-empty">{t("archive.unsupported")}</div>;
    if (!loaded && list.status === "error") {
      return (
        <div className="slist-empty" role="alert">
          <p>{t("archive.loadFailed")}</p>
          {list.error ? <p className="arow-error">{list.error}</p> : null}
          <button type="button" className="btn" onClick={() => void loadArchived({ force: true }).catch(() => undefined)}>
            <Icon name="refresh" size={14} />
            {t("common.retry")}
          </button>
        </div>
      );
    }
    if (!loaded) {
      return (
        <div className="slist-empty arow-loading" role="status">
          <Spinner size={14} />
          <span>{t("archive.loading")}</span>
        </div>
      );
    }
    if (rows.length === 0) return <div className="slist-empty">{t("archive.empty")}</div>;
    return (
      <div className="alist">
        <p className="alist-note">{t("archive.note")}</p>
        <div className="slist" role="list" aria-label={t("archive.title")}>
          {visible.map(({ session, depth }) => (
            <ArchivedRow key={session.id} session={session} depth={depth} below={descendantsOf(session, (id) => archived[id])} busy={busy} />
          ))}
        </div>
        {rows.length > visible.length ? (
          <div className="alist-more">
            <button type="button" className="btn" onClick={() => setShown((current) => current + PAGE)}>
              {t("archive.more", { n: rows.length - visible.length })}
            </button>
          </div>
        ) : null}
      </div>
    );
  })();

  return (
    <div className="list-stage archived-stage">
      <header className="ws-head" data-mode="flow">
        <div className="ws-head-line">
          <span className="ws-ctx-primary">
            <Icon name="archive" size={13} className="ws-ctx-ico" />
            <span className="ws-ctx-folder">{t("archive.title")}</span>
          </span>
          {supported ? (
            <>
              <span className="ws-ctx-sep" aria-hidden="true" />
              <span className="ws-ctx-item num">{t("archive.subtitle", { n: loaded ? rows.length : count })}</span>
            </>
          ) : null}
        </div>
        {supported ? (
          <div className="ws-head-actions">
            <button
              type="button"
              className="ws-action-btn"
              aria-label={t("archive.retentionLink")}
              data-tip={t("archive.retentionLinkTip")}
              onClick={() => openSettings("history")}
            >
              <Icon name="clock" size={13} />
              <span className="ws-action-label">{t("archive.retentionLink")}</span>
            </button>
          </div>
        ) : null}
      </header>
      <div className="list-scroll">{body}</div>
    </div>
  );
}
