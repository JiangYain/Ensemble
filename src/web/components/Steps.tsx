import { memo, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ReasoningItem, ToolCategory, ToolItem } from "@shared/types";
import { mixLabels, workStats, type WorkItem } from "../lib/conversation";
import { shownDelta } from "../lib/diffstat";
import { Markdown } from "../lib/markdown";
import { usePresence } from "../lib/presence";
import { shortDuration, toolVerb, useNow } from "../lib/text";
import { useT } from "../lib/useT";
import { Icon, type IconName } from "./Icons";
import { LineDelta } from "./LineDelta";
import { Preview } from "./Preview";
import { Chip, Spinner } from "./ui";

/**
 * 执行端的“工作过程”：连续的工具调用与推理合成一个工作组。
 *
 * 默认安静：收起时只有一行文字（步骤数、各类次数、耗时），展开才看到逐步的记录；
 * 只有进行中的步骤、失败的步骤带颜色，已完成的步骤不加任何标记。
 * 每一行都来自执行端上报的事件，没有的颗粒度不补位。
 */

const CATEGORY_ICON: Record<ToolCategory, IconName> = {
  read: "file",
  write: "edit",
  edit: "edit",
  search: "search",
  shell: "terminal",
  web: "globe",
  mcp: "plug",
  task: "branch",
  plan: "list",
  other: "zap",
};

/** 收起/展开的动画时长（毫秒）：与 timeline.css 里 work-panel 的 --dur（220ms）一致，略长一点保证放完再卸载。 */
const PANEL_MS = 240;

/** 一个工作组展开后最多先渲染的步骤数；更早的按需再展开，避免一次运行里上千次工具调用把页面拖慢。 */
export const GROUP_WINDOW = 60;
const GROUP_WINDOW_STEP = 200;

/**
 * 用户离开底部（向上翻阅）期间，窗口起点冻结、新步骤只在尾部追加；冻结时窗口最多比正常窗口长出这么多行。
 * 超过之后起点才继续往前滑：免得离开很久、期间跑了上千步，回来时页面上挂着上千行。
 */
export const FROZEN_WINDOW_EXTRA = 200;

/** 进行中的步骤已经跑了多久。单独成组件：每秒重绘的只有这一小块。 */
function Elapsed({ since }: { since: string }): ReactNode {
  const now = useNow();
  const start = Date.parse(since);
  if (!Number.isFinite(start)) return null;
  return <span className="tool-dur num">{shortDuration(Math.max(0, now - start))}</span>;
}

export const ToolRow = memo(function ToolRow({ item }: { item: ToolItem }): ReactNode {
  const t = useT();
  const [open, setOpen] = useState(false);
  const hasDetail = Boolean(item.input || item.output || item.error || item.files?.length || item.exitCode !== undefined);
  const running = item.status === "running";
  const status = t(`tool.status.${item.status}`);
  const mcpLabel = item.mcp?.server ? `${item.mcp.server}${item.mcp.tool ? ` · ${item.mcp.tool}` : ""}` : undefined;
  const onlyFile = item.files?.length === 1 ? item.files[0] : undefined;
  const singleDelta = onlyFile ? shownDelta(onlyFile) : undefined;
  return (
    <div className="tool" data-status={item.status} data-open={open ? "" : undefined}>
      <button type="button" className="tool-head" aria-expanded={hasDetail ? open : undefined} disabled={!hasDetail} onClick={() => setOpen((value) => !value)}>
        <span className="tool-icon">
          {running ? (
            <>
              <Spinner size={12} />
              <span className="sr-only">{status}</span>
            </>
          ) : (
            <Icon name={CATEGORY_ICON[item.category]} size={14} />
          )}
        </span>
        <span className="tool-verb">{toolVerb(item.category, t)}</span>
        <span className="tool-title mono" data-tip={item.title}>
          {mcpLabel ? <em>{mcpLabel}</em> : null}
          {item.title}
        </span>
        <span className="tool-end">
          {/* 单个文件只写执行端真实上报、且不为 0 的行数（没上报不是 0）；没有可写的就不渲染。多个文件只写个数。 */}
          {item.files && item.files.length > 1 ? (
            <span className="tool-files num" data-tip={item.files.map((f) => f.path).join("\n")}>
              {t("tool.files", { n: item.files.length })}
            </span>
          ) : singleDelta ? (
            <span className="tool-files num" data-tip={onlyFile?.path}>
              <LineDelta delta={singleDelta} />
            </span>
          ) : null}
          {running ? <Elapsed since={item.startedAt} /> : item.durationMs !== undefined ? <span className="tool-dur num">{shortDuration(item.durationMs)}</span> : null}
          {/* 已完成不加标记；失败、取消、没有结束事件才有，并配文字说明。 */}
          {item.status === "failed" || item.status === "cancelled" || item.status === "unfinished" ? (
            <span className="tool-state" data-tip={status}>
              <Icon name={item.status === "failed" ? "close" : "minus"} size={13} strokeWidth={2.2} />
              <span className="sr-only">{status}</span>
            </span>
          ) : null}
          {hasDetail ? <Icon name="chevronRight" size={12} className="tool-chevron" strokeWidth={2} /> : <span className="tool-chevron-gap" />}
        </span>
      </button>
      {open && hasDetail ? (
        <div className="tool-detail">
          {item.status === "unfinished" ? <div className="note">{t("tool.unfinishedNote")}</div> : null}
          {item.input ? <Preview preview={item.input} label={t("tool.input")} /> : null}
          {item.output ? <Preview preview={item.output} label={item.exitCode !== undefined ? `${t("tool.output")} · ${t("tool.exit", { code: item.exitCode })}` : t("tool.output")} /> : item.exitCode !== undefined ? <div className="note mono">{t("tool.exit", { code: item.exitCode })}</div> : null}
          {item.error ? <div className="note note--red">{item.error}</div> : null}
          {item.files?.map((file) => {
            const delta = shownDelta(file);
            return (
              <div key={file.path} className="file-change">
                <div className="file-change-head">
                  <Chip tone={file.change === "deleted" ? "red" : "neutral"}>{t(`file.${file.change}`)}</Chip>
                  <span className="mono file-path" data-tip={file.path}>
                    {file.path}
                  </span>
                  {delta ? (
                    <span className="num file-stat">
                      <LineDelta delta={delta} />
                    </span>
                  ) : null}
                </div>
                {file.diff ? <Preview preview={file.diff} maxHeight={260} /> : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
});

export const ReasoningRow = memo(function ReasoningRow({ item }: { item: ReasoningItem }): ReactNode {
  const t = useT();
  const [open, setOpen] = useState(false);
  const hasText = item.text.trim().length > 0;
  const note = t("reasoning.note");
  // “思考”这个词容易让人以为展示的是模型完整的思考，所以把“这只是执行端上报的推理摘要”放在悬停提示里，
  // 不在每个展开的块里重复一行。提示只挂在动词上（行内其他位置、点击后的键盘焦点都不弹）；
  // 读屏与“没有文字的行”（disabled，Tab 到不了）靠按钮的 aria-description，和画布节点的做法一致。
  return (
    <div className="reasoning" data-open={open ? "" : undefined} data-streaming={item.streaming ? "" : undefined}>
      <button type="button" className="reasoning-head" disabled={!hasText} aria-expanded={hasText ? open : undefined} aria-description={note} onClick={() => setOpen((value) => !value)}>
        <span className="tool-icon">{item.streaming ? <Spinner size={12} /> : <Icon name="sparkle" size={14} />}</span>
        <span className="tool-verb" data-tip={note}>
          {item.streaming ? t("reasoning.live") : t("reasoning.done")}
        </span>
        <span className="tool-end">
          {item.durationMs !== undefined ? <span className="tool-dur num">{shortDuration(item.durationMs)}</span> : null}
          {hasText ? <Icon name="chevronRight" size={12} className="tool-chevron" strokeWidth={2} /> : <span className="tool-chevron-gap" />}
        </span>
      </button>
      {open && hasText ? (
        <div className="reasoning-body">
          <Markdown text={item.text} streaming={item.streaming} />
        </div>
      ) : null}
    </div>
  );
});

export const WorkGroup = memo(function WorkGroup({ items, live, expandAll, enter, following = true }: { items: WorkItem[]; live: boolean; expandAll: boolean; enter?: boolean; following?: boolean }): ReactNode {
  const t = useT();
  const bodyId = useId();
  const [override, setOverride] = useState<boolean | undefined>(undefined);
  const [windowSize, setWindowSize] = useState(GROUP_WINDOW);
  const stats = useMemo(() => workStats(items), [items]);
  // 写入与编辑共用一个动词：先按动词合并，免得标题里出现“写入 3 · 写入 2”。
  const mix = useMemo(() => mixLabels(stats.mix, (category) => toolVerb(category, t)), [stats.mix, t]);
  const open = override ?? (expandAll || live);
  const { present, closing } = usePresence(open, PANEL_MS);
  // 窗口起点：贴底时只留最近的 windowSize 步，起点随尾部前移；用户离开底部（向上翻阅）时冻结在屏幕上此刻的起点，
  // 新步骤只在尾部追加——否则起点前移会卸载他正在读的最老的行，视口里的内容跟着位移。
  // shownHidden 是最近一次提交时实际收起的步骤数；它在冻结期间只会因“显示更早的”而变小，不会变大。
  const shownHidden = useRef<number | undefined>(undefined);
  const naturalHidden = Math.max(0, items.length - windowSize);
  const hiddenItems = following || shownHidden.current === undefined ? naturalHidden : Math.max(Math.min(shownHidden.current, naturalHidden), naturalHidden - FROZEN_WINDOW_EXTRA);
  const visibleItems = hiddenItems > 0 ? items.slice(hiddenItems) : items;
  useLayoutEffect(() => {
    shownHidden.current = hiddenItems;
  });

  // 只有推理、没有工具调用时，不应该显示“执行了 0 个步骤”：直接展示推理行本身。
  if (stats.tools === 0) {
    return (
      <div className="work work--solo" data-live={stats.running ? "" : undefined} data-enter={enter ? "" : undefined}>
        {items.map((item) => (item.type === "reasoning" ? <ReasoningRow key={item.id} item={item} /> : null))}
      </div>
    );
  }

  return (
    <div className="work" data-open={open ? "" : undefined} data-live={stats.running ? "" : undefined} data-failed={stats.failed > 0 ? "" : undefined} data-enter={enter ? "" : undefined}>
      <button type="button" className="work-head" aria-expanded={open} aria-controls={present ? bodyId : undefined} onClick={() => setOverride(!open)}>
        <Icon name="chevronRight" size={12} className="work-chevron" strokeWidth={2} />
        <span className="work-title">{stats.running ? t("work.running", { n: stats.tools }) : t("work.done", { n: stats.tools })}</span>
        <span className="work-mix">{mix.slice(0, 4).map(([label, n]) => `${label} ${n}`).join(" · ")}</span>
        {stats.failed > 0 ? (
          <span className="work-failed num" data-tip={t("work.failedTip")}>
            {t("work.failed", { n: stats.failed })}
          </span>
        ) : null}
        <span className="spacer" />
        {stats.durationMs !== undefined && !stats.running ? <span className="work-dur num">{shortDuration(stats.durationMs)}</span> : null}
      </button>
      {present ? (
        <div className="work-panel" id={bodyId} data-state={closing ? "closing" : "open"}>
          <div className="work-body">
            {hiddenItems > 0 ? (
              <button type="button" className="more-btn more-btn--inline" onClick={() => setWindowSize((value) => value + GROUP_WINDOW_STEP)}>
                <Icon name="chevronUp" size={11} strokeWidth={2} />
                {t("work.older", { n: hiddenItems })}
              </button>
            ) : null}
            {visibleItems.map((item) => (item.type === "tool" ? <ToolRow key={item.id} item={item} /> : <ReasoningRow key={item.id} item={item} />))}
          </div>
        </div>
      ) : null}
    </div>
  );
});
