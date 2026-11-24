import { useMemo, type ReactNode } from "react";
import { formatDuration } from "@shared/format";
import type { AttentionItem, SessionSummary } from "@shared/types";
import { navigate, routeHash } from "../lib/app";
import { modelFamily } from "../lib/modelFamily";
import { flattenSessions } from "../lib/sessionOrder";
import { attentionTip, clock, dateMinute, elapsedOf, phaseLabel, subtitleOf, useNow } from "../lib/text";
import { useLang, useT } from "../lib/useT";
import { harnessName, modelLabel } from "../lib/view";
import { HarnessMark } from "./HarnessMark";
import { Icon } from "./Icons";
import { MenuButton } from "./Menu";
import { ModelSlot } from "./ModelMark";
import { nodeMenuItems } from "./sessionActions";

function LiveRowState({ summary }: { summary: SessionSummary }): ReactNode {
  const t = useT();
  const now = useNow();
  const ms = elapsedOf(summary, now);
  return (
    <span className="slist-state" data-kind="running">
      <i className="a-run" aria-hidden="true" />
      <span className="num">{ms === undefined ? phaseLabel(summary.phase, t) : clock(ms)}</span>
    </span>
  );
}

function RowAttention({ items }: { items: readonly AttentionItem[] }): ReactNode {
  const t = useT();
  const now = useNow();
  const tip = attentionTip(items, now, t);
  return (
    <span className="a-flag" data-tone="amber" data-tip={tip} role="img" aria-label={tip}>
      <Icon name="alert" size={11} />
      {items.length > 1 ? items.length : null}
    </span>
  );
}

function RowState({ summary }: { summary: SessionSummary }): ReactNode {
  const t = useT();
  const { phase } = summary;
  if (phase === "running") return <LiveRowState summary={summary} />;
  if (phase === "done") {
    const ms = summary.lastRun?.durationMs;
    return <span className="slist-state num" data-kind="done">{ms === undefined ? phaseLabel(phase, t) : formatDuration(ms)}</span>;
  }
  return <span className="slist-state" data-kind={phase}>{phaseLabel(phase, t)}</span>;
}

export interface SessionListProps {
  sessions: readonly SessionSummary[];
  /** 可选空状态（例如“只看工作中”下全部已结束时给出恢复按钮）。 */
  empty?: ReactNode;
}

/**
 * 瑞士编辑部紧凑列表视图：适合浏览单个 Main Agent 下几十条历史会话，或快速扫描多任务状态。
 * 与画布共享同一套真实数据和会话操作菜单。行序只看创建先后（见 lib/sessionOrder.ts 的 flattenSessions，会话页侧栏的兄弟会话也用它），状态怎么变都不会让行换位；
 * 行上不画色条：工作中的行靠一层很浅的朱砂氤氲（workspace.css），其余状态靠 `.slist-state` 的状态文字与“值得留意”标记承载。
 */
export function SessionList({ sessions, empty }: SessionListProps): ReactNode {
  const t = useT();
  const lang = useLang();
  const rows = useMemo(() => flattenSessions(sessions), [sessions]);

  if (rows.length === 0) {
    return empty ? <div className="slist-empty-wrap">{empty}</div> : <div className="slist-empty">{t("view.listEmpty")}</div>;
  }

  return (
    <div className="slist" role="list">
      {rows.map(({ session, depth }) => {
        const simulated = session.runtime === "fixture";
        const model = modelLabel(session, t);
        const effort = session.effort?.trim() || undefined;
        const family = modelFamily(session.model);
        const subtitle = subtitleOf(session, t);
        const hasAttention = (session.attention?.length ?? 0) > 0;
        const files = session.counters.files;
        return (
          <div
            key={session.id}
            className="slist-row"
            role="listitem"
            data-phase={session.phase}
            data-attention={hasAttention ? "" : undefined}
            data-depth={depth}
            style={depth > 0 ? { paddingLeft: 20 + depth * 22 } : undefined}
            onClick={(event) => {
              if ((event.target as HTMLElement).closest("a,button,[role='menu']")) return;
              navigate({ kind: "session", id: session.id });
            }}
          >
            {depth > 0 ? <span className="slist-branch" aria-hidden="true" /> : null}
            <div className="slist-avatar">
              <ModelSlot family={family} simulated={simulated} size={20} />
            </div>
            <div className="slist-main">
              <div className="slist-top">
                <a
                  className="slist-title"
                  href={routeHash({ kind: "session", id: session.id })}
                  onClick={(event) => event.stopPropagation()}
                >
                  {session.title}
                </a>
                {hasAttention ? <RowAttention items={session.attention!} /> : null}
                {files > 0 ? (
                  <span className="slist-files num" data-tip={t("view.filesChanged", { n: files })}>
                    <Icon name="file" size={11} />
                    {files}
                  </span>
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
              <RowState summary={session} />
              <time className="slist-time num" dateTime={session.createdAt}>
                {dateMinute(session.createdAt, lang, true)}
              </time>
            </div>
            <div className="slist-menu">
              <MenuButton
                items={() => nodeMenuItems(session, t)}
                label={t("node.menu")}
                className="a-menu"
                glyph={
                  <span className="a-dots" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                }
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
