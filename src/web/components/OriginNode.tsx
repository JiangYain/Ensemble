import { memo, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import type { OriginSummary } from "@shared/types";
import { setOriginCollapsed } from "../lib/app";
import { useContextMenuOpen } from "../lib/contextMenu";
import { refTipLines, workspaceTipLine, workspaceUnknown } from "../lib/originText";
import { dateMinute, dateTime, pathName } from "../lib/text";
import { useLang, useT } from "../lib/useT";
import { originNodeId } from "../scene/layout";
import type { SceneEngine } from "../scene/engine";
import { HarnessMark } from "./HarnessMark";
import { Icon } from "./Icons";
import { nodeKeyHandler } from "./nodeKeys";

const MARKED_HOSTS = new Set(["codex", "cursor", "claude", "pi"]);

/** 头部宿主图标的大小（墨迹长边）。与会话卡头部的模型图标同为 12，同一类头部图标一样大。 */
const HEAD_MARK = 12;

/** fit：画布节点里的画法，size 是图形墨迹的长边（线性图标的画布自带留白，所以放大一点）。 */
export function HostMark({ host, size = 18, fit = false }: { host: OriginSummary["host"]; size?: number; fit?: boolean }): ReactNode {
  if (MARKED_HOSTS.has(host)) return <HarnessMark harness={host} size={size} variant="bare" />;
  const box = fit ? size * 1.2 : size;
  if (host === "console") return <Icon name="user" size={box} />;
  return <Icon name="terminal" size={box} />;
}

export interface OriginNodeProps {
  origin: OriginSummary;
  count: number;
  running: number;
  /** 这个发起端第一次委派的时间（ISO）。 */
  startedAt: string;
  /** 宿主自己给这段对话起的标题；宿主没有（或没读到）时不传，卡片上就没有这一行。 */
  hostTitle?: string;
  /** 紧凑模式（窄画布，如宿主的浏览器侧栏）：卡片只有 150 宽，日期改用同样完整但更短的数字写法。 */
  compact?: boolean;
  /**
   * 工作目录已经画成左边的 Folder 节点，正文不再重复目录行。布局给出的事实（没有画出 Folder——没有工作目录、窄画布——就是 false），
   * 组件不自己推断：因此“卡片写着目录行”当且仅当“这个来源的 Folder 节点没有画出来”，窄画布里工作目录信息不会消失。
   */
  folderNode?: boolean;
  /**
   * 用户隐藏了它的相关节点（它名下的会话、只为它服务的 Folder / Git 卡）：卡片留在画布上作为再打开的入口。
   * 头部的会话数变成一个可点的“显示”标记，悬停提示写明状态。这是视图偏好，不改任何会话。
   */
  collapsed?: boolean;
  /** 隐藏时收起的会话数（它名下整棵树，含嵌套的）：与右键菜单里写的数相同；只在 collapsed 时用。 */
  hidden?: number;
  engine: SceneEngine;
}

/**
 * 来源卡片。头部是身份（宿主图标、Main Agent）加右端的会话数；正文是信息：
 * 工作目录（主）→ 第一次委派的时间 → 宿主给这段对话起的标题。工作目录画成了左边的 Folder 节点（folderNode）、
 * 或者没有工作目录（控制台发起）时，目录行不在这里：时间升为主行，标题接在它后面。窄画布不画 Folder 节点，卡片就保留目录行。
 * 缺的东西不画、也不写“没有”。
 * 宿主名不写在卡片上——头部的图标已经说明是谁；只有图标说明不了的宿主（VS Code、未识别的 MCP 客户端）才在头部补上名字，
 * 写法与 Agent 卡头部的“标签 / 次要信息”相同（Main Agent / my-mcp-client），不占正文的宽度。
 * 会话标识等细节在悬停提示里，不占卡片。标题只来自宿主本机的记录，没有就空着，不拿别的文字顶替。
 * 版式基准见 styles/scene.css 里 `.o-head` 之后的注释。
 */
export const OriginNode = memo(function OriginNode({ origin, count, running, startedAt, hostTitle, compact = false, folderNode = false, collapsed = false, hidden = count, engine }: OriginNodeProps): ReactNode {
  const t = useT();
  const lang = useLang();
  const ref = useRef<HTMLDivElement>(null);
  // 右键菜单开着的时候，卡片保持悬停外观（与会话卡一致）。
  const contextOpen = useContextMenuOpen(originNodeId(origin.key));

  useLayoutEffect(() => {
    const el = ref.current;
    return el ? engine.register(originNodeId(origin.key), el) : undefined;
  }, [engine, origin.key]);
  const onKeyDown = useMemo(() => nodeKeyHandler(engine, originNodeId(origin.key)), [engine, origin.key]);

  const isUser = origin.kind === "user";
  const title = isUser ? t("origin.user") : origin.hostLabel;
  const named = !isUser && !MARKED_HOSTS.has(origin.host);
  const tip = [
    t("origin.tipHead", { host: origin.hostLabel }),
    ...refTipLines(origin, t),
    workspaceTipLine(origin, t),
    `${t("origin.started")}: ${dateTime(startedAt, lang)}`,
  ]
    .filter(Boolean)
    .join("\n");
  const countTip = running > 0 ? t("origin.countRunning", { n: count, running }) : t("origin.count", { n: count });
  const collapsedTip = running > 0 ? t("origin.collapsedTipRunning", { n: hidden, running }) : t("origin.collapsedTip", { n: hidden });
  // 目录行只在工作目录没有画成 Folder 节点时才写；完整路径始终在悬停提示里。
  // Agent 发起的来源没有工作目录时写“未知”（宿主没有报告、委派时也没显式传 cwd），不拿桥进程的目录顶替。
  const workspace = folderNode ? undefined : origin.workspace || undefined;
  const unknown = !folderNode && workspaceUnknown(origin);
  const dirRow = workspace !== undefined || unknown;
  const stamp = (className: string): ReactNode => (
    <time className={className} dateTime={startedAt}>
      {dateMinute(startedAt, lang, compact)}
    </time>
  );

  return (
    <div ref={ref} className="node origin" data-node data-node-id={originNodeId(origin.key)}
      data-host={origin.host} data-tip={tip}
      data-collapsed={collapsed ? "" : undefined}
      data-menu-open={contextOpen ? "" : undefined}
      tabIndex={0} role="group" aria-label={t(collapsed ? "scene.originLabelCollapsed" : "scene.originLabel", { title })}
      aria-description={t("scene.originKeyboard")}
      onKeyDown={onKeyDown}>
      <header className="o-head">
        <span className="a-mark">
          <HostMark host={origin.host} size={HEAD_MARK} fit />
        </span>
        <span className="o-label">{t("origin.head")}</span>
        {named ? <span className="a-model">{title}</span> : null}
        {collapsed ? (
          // 隐藏状态的入口：与会话数同一个位置、同一个数，多一只“关着的眼睛”。点它就是“显示相关节点”（右键菜单里是同一个动作）。
          <button type="button" className="o-count o-expand num" aria-label={t("origin.expand")} aria-description={collapsedTip} data-tip={collapsedTip}
            onClick={() => setOriginCollapsed(origin.key, false)}>
            <Icon name="eyeOff" size={11} strokeWidth={1.9} />
            {running > 0 ? <i className="a-run" aria-hidden="true" /> : null}
            {count}
          </button>
        ) : (
          <span className="o-count num" data-tip={countTip}>
            {running > 0 ? <i className="a-run" aria-hidden="true" /> : null}
            {count}
          </span>
        )}
      </header>

      <div className="o-body">
        <div className="o-main">
          {dirRow ? <Icon name="folder" size={13} className="o-ico" /> : <Icon name="clock" size={13} className="o-ico" />}
          {workspace ? <span className="o-text">{pathName(workspace)}</span> : unknown ? <span className="o-text o-unknown">{t("origin.workspaceUnknown")}</span> : stamp("o-text num")}
        </div>
        {dirRow ? <span className="o-sub">{stamp("num")}</span> : null}
        {hostTitle ? (
          <span className="o-title" data-tip={`${t("origin.titleTip", { host: origin.hostLabel })}\n${hostTitle}`}>
            {hostTitle}
          </span>
        ) : null}
      </div>
    </div>
  );
});
