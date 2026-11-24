import { memo, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import type { GitEntry } from "../lib/git";
import { dateMinute, dateTime, pathName } from "../lib/text";
import { useLang, useT } from "../lib/useT";
import { gitNodeId } from "../scene/layout";
import type { SceneEngine } from "../scene/engine";
import { Icon } from "./Icons";
import { nodeKeyHandler } from "./nodeKeys";

export interface GitNodeProps {
  /** 这张卡对应的真实工作树（`GitSnapshot.root` 规范化后的标识，见 lib/git 的 worktreeKey）。 */
  worktree: string;
  entry: GitEntry;
  engine: SceneEngine;
}

const CHANGE_PARTS = ["staged", "unstaged", "untracked", "conflicted"] as const;

/**
 * Git 卡片：来源节点的工作目录所在的工作树，接在来源节点左边；工作树是一个，卡片就只有一张，
 * 指向它的每个来源（Main Agent）各有一条连线。内容全部来自服务端读到的真实 Git 状态：
 * 分支（游离 HEAD 时写明）→ 最近一次提交（短哈希与说明）→ 工作区状态。头部是身份（Git / 仓库目录名），
 * 右端是与上游的领先落后；最近一次读取失败时多一个钟表标记，提示这是旧的状态。
 * 没有的东西不画：没有上游就没有领先落后，没有提交就写“还没有提交”，不拿别的文字顶替。
 * 版式与来源卡片共用同一套基准（见 styles/scene.css 里 `.o-head` 之后的注释）。
 * 完整信息（目录、上游、远程、读取时间）在悬停提示里。
 */
export const GitNode = memo(function GitNode({ worktree, entry, engine }: GitNodeProps): ReactNode {
  const t = useT();
  const lang = useLang();
  const ref = useRef<HTMLDivElement>(null);
  const id = gitNodeId(worktree);
  const { git, stale } = entry;

  useLayoutEffect(() => {
    const el = ref.current;
    return el ? engine.register(id, el) : undefined;
  }, [engine, id]);
  const onKeyDown = useMemo(() => nodeKeyHandler(engine, id), [engine, id]);

  const repo = pathName(git.root);
  const { head, upstream, changes } = git;
  const sha = head?.sha.slice(0, 7);
  const branch = git.branch ?? (git.detached ? t("git.detached") : repo);
  const attention = changes.conflicted > 0;
  const status = attention ? t("git.conflicts", { n: changes.conflicted }) : changes.files > 0 ? t("git.dirty", { n: changes.files }) : t("git.clean");
  const checked = dateTime(git.checkedAt, lang);

  const upstreamParts = upstream
    ? [upstream.name, upstream.ahead > 0 ? t("git.ahead", { n: upstream.ahead }) : undefined, upstream.behind > 0 ? t("git.behind", { n: upstream.behind }) : undefined]
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
  const syncTip = (count: number, key: "git.ahead" | "git.behind"): string => `${t("git.upstream")}: ${upstream?.name ?? ""} · ${t(key, { n: count })}`;

  return (
    <div ref={ref} className="node git" data-node data-node-id={id} data-stale={stale ? "" : undefined} data-tip={tip}
      tabIndex={0} role="group" aria-label={t("git.label", { name: repo })} aria-description={t("git.keyboard")}
      onKeyDown={onKeyDown}>
      <header className="o-head">
        <span className="a-mark">
          <Icon name="git" size={12.6} />
        </span>
        <span className="o-label">{t("git.head")}</span>
        <span className="a-model">{repo}</span>
        {upstream && (upstream.ahead > 0 || upstream.behind > 0) || stale ? (
          <span className="o-count g-sync num">
            {upstream && upstream.ahead > 0 ? (
              <span className="g-chip" data-tip={syncTip(upstream.ahead, "git.ahead")}>
                <Icon name="arrowUp" size={10} strokeWidth={2.4} />
                {upstream.ahead}
              </span>
            ) : null}
            {upstream && upstream.behind > 0 ? (
              <span className="g-chip" data-tip={syncTip(upstream.behind, "git.behind")}>
                <Icon name="arrowDown" size={10} strokeWidth={2.4} />
                {upstream.behind}
              </span>
            ) : null}
            {stale ? (
              <span className="g-chip g-stale" data-tip={t("git.stale", { time: checked })}>
                <Icon name="clock" size={11} />
              </span>
            ) : null}
          </span>
        ) : null}
      </header>

      <div className="o-body">
        <div className="o-main">
          <Icon name="branch" size={13} className="o-ico" />
          <span className="o-text">{branch}</span>
        </div>
        <span className="o-sub">
          {head ? (
            <>
              <span className="g-sha num">{sha}</span>
              {head.subject}
            </>
          ) : (
            t("git.noCommits")
          )}
        </span>
        <span className="o-title" data-kind={attention ? "attention" : undefined}>
          {status}
        </span>
      </div>
    </div>
  );
});
