import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { sliceHead } from "@shared/safe-slice";
import type { SessionId, SessionSummary } from "@shared/types";
import { cancelRun, loadDetail, navigate, selectWorkspace, store, toast, viewMemory } from "../lib/app";
import { archiveUi, unarchiveSessions } from "../lib/archive";
import { refDeclared } from "../lib/originText";
import { onReveal } from "../lib/reveal";
import { useStore } from "../lib/store";
import { dateMinute, subtitleOf } from "../lib/text";
import { useLang, useT } from "../lib/useT";
import { modelLabel, panelHref } from "../lib/view";
import { originKeyOfSession } from "../lib/workspaces";
import { Composer } from "./Composer";
import { HarnessMark } from "./HarnessMark";
import { Icon } from "./Icons";
import { MenuButton } from "./Menu";
import { HostMark } from "./OriginNode";
import { InfoPanel, SummaryPanel, TaskPanel } from "./Panels";
import { sessionMenuItems } from "./sessionActions";
import { Timeline, codeHeadline } from "./Timeline";
import { Chip, Spinner, copyText } from "./ui";

type LayoutMode = "wide" | "medium" | "narrow";
type NarrowTab = "timeline" | "task" | "summary" | "info";

/** 按宽度定布局：≥1160 三栏，≥800 中等，其余是标签页。 */
function modeFor(width: number): LayoutMode {
  return width >= 1160 ? "wide" : width >= 800 ? "medium" : "narrow";
}

function useLayoutMode(ref: React.RefObject<HTMLElement | null>): LayoutMode {
  // 首帧先用视口宽度估一个：.focus 铺满整页，通常就是对的。写死“宽”的话，在宿主的窄侧栏里每次打开会话都会先按三栏排一遍，
  // 里面的输入框也按被挤窄的宽度量了一次高度。
  const [mode, setMode] = useState<LayoutMode>(() => modeFor(window.innerWidth));
  // 真实宽度在绘制之前量（useEffect 会让估错的那一帧被看见），不一致就当场纠正。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => setMode(modeFor(el.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return mode;
}

/** 已归档的会话不属于任何画布：它来自“已归档”视图（或刚刚在这里被归档），返回就回那里。 */
function isArchivedOnly(id: SessionId): boolean {
  const state = store.get();
  return state.sessions[id] === undefined && state.archived[id] !== undefined;
}

/** 返回该会话所属的 Main Agent 独立画布（已归档的回“已归档”视图）；找不到来源时回到默认总览。 */
function returnToWorkspace(id: SessionId): void {
  if (isArchivedOnly(id)) {
    navigate({ kind: "archived" });
    return;
  }
  const key = originKeyOfSession(Object.values(store.get().sessions), id);
  if (key) selectWorkspace({ kind: "origin", key });
  else navigate({ kind: "overview" });
}

function Header({ summary }: { summary: SessionSummary }): ReactNode {
  const t = useT();
  const simulated = summary.runtime === "fixture";
  // 档位是执行端给出的短值（low / xhigh / max…），与模型选择里的英文档位保持同一写法，不随界面语言翻译。
  const effort = summary.effort?.trim() || undefined;
  const cancellable = summary.phase === "running" || summary.status === "queued" || summary.status === "starting";
  const origin = summary.origin;
  // 已归档：它不在画布上，返回的是“已归档”视图；入口之一是这里的“取消归档”（另一个在菜单里）。
  const archived = summary.archivedAt !== undefined;
  const archiveBusy = useStore(archiveUi, (s) => s.busy > 0);
  const backLabel = archived ? t("archive.title") : t("focus.back");

  return (
    <header className="focus-head" style={{ viewTransitionName: "session-card" }} data-phase={summary.phase}>
      <div className="head-top">
        <button type="button" className="btn btn--ghost btn--back" onClick={() => returnToWorkspace(summary.id)} data-tip={`${backLabel}  ·  Esc`}>
          <Icon name="arrowLeft" size={15} strokeWidth={2} />
          {backLabel}
        </button>
        <span className="head-origin" data-tip={origin.sessionRef ? [`${origin.hostLabel} · ${origin.sessionRef.id}`, ...(refDeclared(origin) ? [t("origin.refDeclaredTip")] : [])].join("\n") : origin.hostLabel}>
          <HostMark host={origin.host} size={14} />
          <span>{origin.kind === "user" ? t("origin.user") : t("origin.dispatchedBy", { host: origin.hostLabel })}</span>
          {origin.sessionRef ? <span className="mono head-origin-ref">{sliceHead(origin.sessionRef.id, 10)}</span> : null}
          {refDeclared(origin) ? <span className="head-origin-ref">{t("origin.refDeclared")}</span> : null}
        </span>
        <span className="spacer" />
        {archived ? (
          <button
            type="button"
            className="btn btn--ghost"
            disabled={archiveBusy}
            aria-busy={archiveBusy || undefined}
            onClick={() => void unarchiveSessions([summary.id])}
            data-tip={t("archive.unarchiveTip")}
          >
            <Icon name="unarchive" size={14} />
            <span className="btn-label">{t("menu.unarchive")}</span>
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => void copyText(panelHref(summary.id)).then((ok) => toast(ok ? "success" : "warn", ok ? t("common.copied") : t("common.copyFailed"), 1800))}
          data-tip={t("menu.copyLink")}
        >
          <Icon name="link" size={14} />
          <span className="btn-label">{t("focus.link")}</span>
        </button>
        {cancellable ? (
          <button type="button" className="btn btn--danger-ghost" onClick={() => void cancelRun(summary.id, { ok: t("toast.cancelOk"), nothing: t("toast.cancelNothing"), failed: t("toast.cancelFailed") })}>
            <Icon name="stop" size={13} />
            <span className="btn-label">{t("composer.cancel")}</span>
          </button>
        ) : null}
        <MenuButton items={() => sessionMenuItems(summary, t, { afterRemove: () => navigate({ kind: archived ? "archived" : "overview" }) })} label={t("node.menu")} />
      </div>

      <div className="head-main">
        <HarnessMark harness={summary.harness} size={48} simulated={simulated} />
        <div className="head-text">
          <h1 className="head-title" data-tip={summary.title}>
            {summary.title}
          </h1>
          <div className="head-chips">
            <Chip tone="neutral" tip={t("info.model")}>
              {modelLabel(summary, t)}
            </Chip>
            {effort ? <Chip tone="neutral" tip={t("info.effort")}>{effort}</Chip> : null}
            {archived ? <Chip tone="neutral" tip={t("archive.chipTip")}>{t("archive.chip")}</Chip> : null}
          </div>
        </div>
      </div>

      <div className="head-activity" data-phase={summary.phase}>
        {/* 停下来等回答时不转圈：转圈说的是“在做事”，而此刻它在等人（副标题写“等待回答”）。 */}
        {(summary.phase === "running" || summary.phase === "starting") && !summary.openQuestions ? <Spinner size={12} /> : null}
        <span className="head-activity-text">{subtitleOf(summary, t)}</span>
      </div>
    </header>
  );
}

/** 失败 / 失联时钉在时间线上方：先给本地化标题，再给执行端的原话，细节折叠。 */
function ErrorBanner({ summary }: { summary: SessionSummary }): ReactNode {
  const t = useT();
  const [open, setOpen] = useState(false);
  const error = summary.lastError;
  if (!error || (summary.phase !== "failed" && summary.phase !== "lost")) return null;
  const headline = codeHeadline(error.code, t) ?? (summary.phase === "lost" ? t("phase.lost") : t("error.title"));
  const hasDetail = Boolean(error.detail) && error.detail !== error.message;
  return (
    <div className="error-banner" role="alert" data-phase={summary.phase}>
      <span className="error-icon" aria-hidden="true">
        <Icon name="alert" size={16} />
      </span>
      <div className="error-body">
        <div className="error-line">
          <strong className="error-title">{headline}</strong>
          <span className="error-code mono">{error.code}</span>
        </div>
        <p className="error-message">{error.message}</p>
        {error.retryable ? <p className="error-hint">{t("error.retryable")}</p> : null}
        {hasDetail ? (
          <>
            <button type="button" className="error-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
              <Icon name={open ? "chevronDown" : "chevronRight"} size={12} strokeWidth={2.2} />
              {t("error.detail")}
            </button>
            {open ? <pre className="error-detail mono">{error.detail}</pre> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 聚焦的会话已归档时钉在页头下面：说清它现在在哪、取消归档会带回什么、给它发消息会怎样（服务端会自动取消归档）。
 * 它只是“已归档”这个事实的说明，不改变会话的任何状态，也不拦着用户继续看、继续发消息。
 */
function ArchivedBanner({ summary, archivedAt }: { summary: SessionSummary; archivedAt: string }): ReactNode {
  const t = useT();
  const lang = useLang();
  const time = dateMinute(archivedAt, lang, true);
  return (
    <div className="banner banner--archived" role="status">
      {t(summary.archivedBy === "retention" ? "archive.bannerAuto" : "archive.banner", { time })}
    </div>
  );
}

function Skeleton(): ReactNode {
  return (
    <div className="skeleton" aria-hidden="true">
      <i style={{ width: "42%" }} />
      <i style={{ width: "86%" }} />
      <i style={{ width: "74%" }} />
      <i style={{ width: "58%" }} />
    </div>
  );
}

function NotFound({ reason }: { reason: "not_found" | "failed"; id: SessionId }): ReactNode {
  const t = useT();
  return (
    <div className="state-card" role="alert">
      <span className="state-icon" data-tone={reason === "failed" ? "red" : "neutral"}>
        <Icon name={reason === "failed" ? "alert" : "search"} size={22} />
      </span>
      <h2>{reason === "failed" ? t("focus.failedTitle") : t("focus.notFoundTitle")}</h2>
      <p>{reason === "failed" ? t("focus.failedBody") : t("focus.notFoundBody")}</p>
      <div className="state-actions">
        <button type="button" className="btn btn--primary" onClick={() => navigate({ kind: "overview" })}>
          {t("focus.back")}
        </button>
      </div>
    </div>
  );
}

export function Focus({ id }: { id: SessionId }): ReactNode {
  const t = useT();
  // 已归档的会话不在 sessions 里，但聚焦页照样能打开它（详情回执带着它的摘要，之后由推送更新）。
  const summary = useStore(store, (s) => s.sessions[id] ?? s.archived[id]);
  const detail = useStore(store, (s) => (s.detail?.id === id ? s.detail : undefined));
  const rootRef = useRef<HTMLDivElement>(null);
  const mode = useLayoutMode(rootRef);
  const [tab, setTab] = useState<NarrowTab>("timeline");

  // 窄屏下右栏和时间线分在不同标签页：在右栏点了某条消息记录，要先回到时间线（滚动由随后挂载的时间线完成）。
  useEffect(() => (mode === "narrow" ? onReveal(() => setTab("timeline")) : undefined), [mode]);

  useEffect(() => {
    viewMemory.lastFocusId = id;
    return () => {
      viewMemory.lastFocusId = id;
    };
  }, [id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))) return;
      const state = store.get();
      if (state.settings.open || state.confirm || state.switcherOpen) return;
      if (document.querySelector('[role="menu"]')) return;
      returnToWorkspace(id);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [id]);

  const state = detail?.state;

  if (!summary && (detail?.error === "not_found" || (detail && !detail.loading && !state))) {
    return (
      <div className="focus" ref={rootRef}>
        <NotFound reason="not_found" id={id} />
      </div>
    );
  }
  if (!summary) {
    return (
      <div className="focus" ref={rootRef}>
        <Skeleton />
      </div>
    );
  }
  if (!state && detail?.error === "failed") {
    return (
      <div className="focus" ref={rootRef} data-mode={mode}>
        <Header summary={summary} />
        <div className="focus-body">
          <div className="state-card" role="alert">
            <span className="state-icon" data-tone="red">
              <Icon name="alert" size={22} />
            </span>
            <h2>{t("focus.failedTitle")}</h2>
            <p>{t("focus.failedBody")}</p>
            <div className="state-actions">
              <button type="button" className="btn btn--primary" onClick={() => void loadDetail(id)}>
                <Icon name="refresh" size={14} />
                {t("common.retry")}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const main = (
    <main className="focus-main">
      <ErrorBanner summary={summary} />
      {state ? <Timeline state={state} rev={detail?.rev ?? 0} summary={summary} /> : <Skeleton />}
      <Composer summary={summary} />
    </main>
  );

  const left = state ? (
    <>
      <TaskPanel state={state} summary={summary} />
      <InfoPanel state={state} summary={summary} />
    </>
  ) : (
    <Skeleton />
  );
  const right = state ? <SummaryPanel state={state} summary={summary} /> : <Skeleton />;

  return (
    <div className="focus" ref={rootRef} data-mode={mode}>
      <Header summary={summary} />
      {detail?.error === "not_found" ? <div className="banner banner--amber">{t("focus.removedBanner")}</div> : null}
      {summary.archivedAt !== undefined ? <ArchivedBanner summary={summary} archivedAt={summary.archivedAt} /> : null}
      {mode === "narrow" ? (
        <>
          <div className="tabs" role="tablist" aria-label={t("focus.tabs")}>
            {(["timeline", "task", "summary", "info"] as const).map((key) => (
              <button key={key} type="button" role="tab" aria-selected={tab === key} data-active={tab === key ? "" : undefined} onClick={() => setTab(key)}>
                {t(`focus.tab.${key}`)}
              </button>
            ))}
          </div>
          <div className="focus-body focus-body--narrow">
            {tab === "timeline" ? main : null}
            {tab === "task" && state ? <aside className="rail" data-scroll><TaskPanel state={state} summary={summary} /></aside> : null}
            {tab === "summary" ? <aside className="rail" data-scroll>{right}</aside> : null}
            {tab === "info" && state ? <aside className="rail" data-scroll><InfoPanel state={state} summary={summary} /></aside> : null}
          </div>
        </>
      ) : mode === "medium" ? (
        <div className="focus-body focus-body--medium">
          <aside className="rail rail--left" data-scroll>
            {left}
            {right}
          </aside>
          {main}
        </div>
      ) : (
        <div className="focus-body focus-body--wide">
          <aside className="rail rail--left" data-scroll>
            {left}
          </aside>
          {main}
          <aside className="rail rail--right" data-scroll>
            {right}
          </aside>
        </div>
      )}
    </div>
  );
}
