import { memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatDuration } from "@shared/format";
import type { AttentionItem, SessionSummary } from "@shared/types";
import { navigate, routeHash } from "../lib/app";
import { auraStyle } from "../lib/aura";
import { useContextMenuOpen } from "../lib/contextMenu";
import { attentionTip, clock, elapsedOf, phaseLabel, subtitleOf, useNow } from "../lib/text";
import { modelFamily } from "../lib/modelFamily";
import { useSettledText } from "../lib/useSettledText";
import { useT } from "../lib/useT";
import { effortLabel, harnessName, modelLabel } from "../lib/view";
import { agentNodeId } from "../scene/layout";
import type { SceneEngine } from "../scene/engine";
import { HarnessMark } from "./HarnessMark";
import { Icon } from "./Icons";
import { MenuButton } from "./Menu";
import { ModelSlot } from "./ModelMark";
import { isNodeKey, nodeKeyHandler } from "./nodeKeys";
import { nodeMenuItems } from "./sessionActions";

/** 头部执行端图标的大小（墨迹长边）：与来源卡头部同为 12，同一类头部图标一样大。 */
const HEAD_MARK = 12;

type GlyphKind = "done" | "failed" | "cancelled" | "stopped" | "lost";

const GLYPH_MARKS: Record<GlyphKind, ReactNode> = {
  done: <path d="M3.7 6.2l1.6 1.6 3-3.4" />,
  failed: <path d="M4.3 4.3l3.4 3.4M7.7 4.3L4.3 7.7" />,
  cancelled: <path d="M4.6 4.5v3M7.4 4.5v3" />,
  stopped: <path d="M4.4 6h3.2" />,
  lost: <path d="M6 3.9v2.6M6 8.3v.01" />,
};

/** 结束状态的小标记：9×9 的实心方块（与全站的小标记同一种形状，没有圆），里面的符号是方头线帽、斜接线角。 */
function StateGlyph({ kind }: { kind: GlyphKind }): ReactNode {
  return (
    <svg className="a-glyph" width="9" height="9" viewBox="0 0 12 12" aria-hidden="true">
      <rect width="12" height="12" fill="currentColor" />
      <g fill="none" stroke="#262626" strokeWidth="1.5" strokeLinecap="square" strokeLinejoin="miter">
        {GLYPH_MARKS[kind]}
      </g>
    </svg>
  );
}

/** 执行中：呼吸的小方块 + 随时间增长的计时。单独成组件，只有它每秒重绘。 */
function LiveState({ summary, tip }: { summary: SessionSummary; tip: string | undefined }): ReactNode {
  const t = useT();
  const now = useNow();
  const ms = elapsedOf(summary, now);
  return (
    <span className="a-state" data-kind="running" data-tip={tip}>
      <i className="a-run" aria-hidden="true" />
      <span className="num">{ms === undefined ? phaseLabel(summary.phase, t) : clock(ms)}</span>
    </span>
  );
}

/**
 * 服务端依据事件注意到的事实（静默、工具许久没有动静、同时写同一个文件……）：头部一枚小标记，悬停读全文。
 * 它只说“发生了什么”，不是告警：颜色是一档暖灰而不是红色，也不改变卡片的状态。
 * 提示文字里的时长随时间增长，所以单独成组件，由它自己每秒取一次现在。
 */
function AttentionFlag({ items }: { items: readonly AttentionItem[] }): ReactNode {
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

function NodeState({ summary }: { summary: SessionSummary }): ReactNode {
  const t = useT();
  const { phase } = summary;
  // 一个会话可以经历多次运行；节点上显示的是最近一次，次数放在悬停提示里。
  const tip = summary.runCount > 1 ? t("node.runs", { n: summary.runCount }) : undefined;
  switch (phase) {
    case "running":
      return <LiveState summary={summary} tip={tip} />;
    case "done": {
      const ms = summary.lastRun?.durationMs;
      return (
        <span className="a-state" data-kind="done" data-tip={tip}>
          <StateGlyph kind="done" />
          <span className="num">{ms === undefined ? phaseLabel(phase, t) : formatDuration(ms)}</span>
        </span>
      );
    }
    case "failed":
    case "cancelled":
    case "stopped":
    case "lost":
      return (
        <span className="a-state" data-kind={phase} data-tip={tip}>
          <StateGlyph kind={phase} />
          <span>{phaseLabel(phase, t)}</span>
        </span>
      );
    default:
      return (
        <span className="a-state" data-kind={phase === "ready" ? "ready" : "pending"} data-tip={tip}>
          <span>{phaseLabel(phase, t)}</span>
        </span>
      );
  }
}

export interface AgentNodeProps {
  summary: SessionSummary;
  engine: SceneEngine;
  /** 刚从聚焦页返回的会话：让它带着共享元素过渡的名字。 */
  morph?: boolean;
}

/**
 * 会话卡片。头部是身份：执行端（Harness）的图标与名字，后面跟着它用的模型与推理档位（`.a-model`，与来源卡、Git 卡头部是同一个类），
 * 右端是“值得留意”、待发 / 干预标记与菜单；正文是信息：左边一格 24px 的模型头像（模型家族标，认不出画中性占位，模拟执行画烧瓶），
 * 右边两行——标题与当前状态、最近动作。卡片可拖动或用键盘移动。
 * 模型名与档位是头部的一个整体，写在执行端名后面：它们回答“谁在用什么模型做”，与执行端名一起读，正文因此少一行，更清楚。
 * 头部的宽度是弹性的（248 宽的卡扣掉图标格、执行端名、标记与菜单，常见的 Cursor 剩一百二三十 px，紧凑一档的 208 更少）：
 * 放不下先省略模型名，剩下的放不下一个像样的名字时名字与档位整块收起——由 CSS 的容器查询按真正剩下的宽度决定，不在 JS 里量宽度；
 * 收起的名字仍在可访问性树里，悬停提示另挂在正文的头像上，始终读得到。版式基准见 styles/scene.css 里 `.a-head` 与 `.o-head` 之后的注释。
 * 会话在工作时，整张卡里有两团极淡的朱砂在缓慢漂移（`.a-aura`：纯 CSS 的合成层动画，不依赖这个组件的重渲染）；
 * 每张卡的起始相位取自会话标识（lib/aura.ts），所以刷新后不重新起跳，几十张卡也不会同进同退。
 */
export const AgentNode = memo(function AgentNode({ summary, engine, morph }: AgentNodeProps): ReactNode {
  const t = useT();
  const nodeId = agentNodeId(summary.id);
  const ref = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // 头部“···”菜单与节点上的右键菜单任何一个开着，卡片都保持悬停外观。
  const contextOpen = useContextMenuOpen(nodeId);

  useLayoutEffect(() => {
    const el = ref.current;
    return el ? engine.register(agentNodeId(summary.id), el) : undefined;
  }, [engine, summary.id]);

  const moveKeys = useMemo(() => nodeKeyHandler(engine, nodeId), [engine, nodeId]);

  const { phase } = summary;
  const simulated = summary.runtime === "fixture";
  // 空串与纯空白都算“执行端没给档位”：徽标不出现，提示里也写“无”而不是一段空白。
  const effortValue = summary.effort?.trim() || undefined;
  // 悬停提示里的档位跟随界面语言；紧跟模型名的徽标与聚焦页一致，直接写执行端给出的英文短值。
  const effort = effortValue ? effortLabel(effortValue, t) : undefined;
  // 副标题是最近一次工具调用，快的时候一秒换好几次：合并后再显示，换字的淡入才看得清。
  const subtitle = useSettledText(subtitleOf(summary, t), phase);
  const model = modelLabel(summary, t);
  const family = modelFamily(summary.model);
  // 悬停提示：模拟执行的模型是假的，只说明“这是模拟”，不写那个假模型；否则是模型与推理强度。
  // 头部的名字与正文的头像共用这一句：名字在窄卡上会整块收起，头像始终在场。
  const modelTip = simulated ? t("run.simulatedTip") : t("node.modelTip", { model, effort: effort ?? t("common.none") });
  // 氤氲的起始相位：只由会话标识决定，不随重渲染变化。
  const aura = useMemo(() => auraStyle(summary.id), [summary.id]);

  const open = (card: HTMLElement | null): void => {
    // 共享元素过渡：让被点击的节点带上名字，聚焦页的头部卡片接住它。
    if (card) card.style.viewTransitionName = "session-card";
    navigate({ kind: "session", id: summary.id });
  };

  return (
    <div
      ref={ref}
      className="node agent"
      data-node
      data-node-id={nodeId}
      data-phase={phase}
      data-attention={summary.attention?.length ? "" : undefined}
      data-menu-open={menuOpen || contextOpen ? "" : undefined}
      tabIndex={0}
      role="group"
      aria-label={t("scene.nodeLabel", { title: summary.title })}
      aria-description={t("scene.nodeKeyboard")}
      style={morph ? { viewTransitionName: "session-card" } : undefined}
      onKeyDown={(event) => {
        // 方向键与 Shift+空格同其他节点；Enter 是会话卡独有的，同样只认节点自己的按键。
        moveKeys(event);
        if (event.key === "Enter" && isNodeKey(event)) {
          event.preventDefault();
          open(ref.current);
        }
      }}
      onClick={(event) => {
        // 菜单、按钮和标题链接各管各的；卡片的其余部分都是“打开这个会话”。
        if ((event.target as HTMLElement).closest("a,button,[role='menu']")) return;
        open(ref.current);
      }}
    >
      {/*
        氤氲：节点里的第一个子元素，只画、不接收指针、不进可访问性树。显示与否、流不流动都由节点的 data-phase / data-attention 决定（见 scene.css 的“工作中的氤氲”），
        这里只给每张卡一组起始相位。放在 header 之前：它在样式里用 z-index: -1 垫在所有内容之下，源码里也排在最前，读起来与层叠一致。
      */}
      <span className="a-aura" aria-hidden="true" style={aura} />
      <header className="a-head">
        {/*
          头部是身份：执行端的图标与名字，与来源卡头部是同一套类（.a-mark / .o-label）、同一条列轴——
          图标格 13×13 起于 x=14，名字起于 x=34；Cursor 发起的 Main Agent 与 Cursor 执行的会话，头部用的是同一枚 Cursor 标。
          没有官方标的执行端由 HarnessMark 画中性的烧瓶，名字照写。名字是身份，不收缩：右端的标记与菜单放得下，不需要让位。
        */}
        <span className="a-mark">
          <HarnessMark harness={summary.harness} size={HEAD_MARK} variant="bare" />
        </span>
        <span className="o-label">{harnessName(summary.harness, t)}</span>
        {/*
          模型与档位是头部的一个整体（.a-model：名字 + 可选的档位徽标，与来源卡、Git 卡头部同一个类；不画“/”，原因见 scene.css），
          放在一块弹性空白（.a-room）里：这块空白同时是容器查询的容器，量的是执行端名与右端标记、菜单之外真正剩下的宽度，
          所以执行端名多长、有几枚标记、卡片是 248 还是 208 宽，收起的阈值都对。名字先省略，档位徽标不收缩；放不下一个像样的名字时整块收起。
          模拟执行的模型是假的：只写“模拟执行”，不写、也不画那个假模型，没有档位。没有档位就不渲染徽标，也不留空位。
        */}
        <span className="a-room">
          <span className="a-model">
            <span className="a-model-name" data-tip={modelTip}>
              {simulated ? t("run.simulated") : model}
            </span>
            {!simulated && effortValue ? (
              <span className="a-effort" data-tip={t("info.effort")}>
                {effortValue}
              </span>
            ) : null}
          </span>
        </span>
        {summary.attention?.length ? <AttentionFlag items={summary.attention} /> : null}
        {summary.messages.pending > 0 ? (
          <span className="a-flag" data-tone="blue" data-tip={`${t("node.pending", { n: summary.messages.pending })}\n${t("node.pendingTip")}`}>
            <Icon name="send" size={11} />
            {summary.messages.pending}
          </span>
        ) : summary.counters.interventions > 0 ? (
          <span className="a-flag" data-tip={t("node.interventionsTip")}>
            <Icon name="hand" size={11} />
            {summary.counters.interventions}
          </span>
        ) : null}
        <MenuButton
          items={() => nodeMenuItems(summary, t)}
          label={t("node.menu")}
          className="a-menu"
          glyph={
            <span className="a-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          }
          onOpenChange={setMenuOpen}
        />
      </header>

      <div className="a-inset">
        <div className="a-row">
          <ModelSlot family={family} simulated={simulated} tip={modelTip} />
          <div className="a-text">
            <div className="a-line">
              <a className="a-title" href={routeHash({ kind: "session", id: summary.id })} data-tip={summary.title} onClick={(event) => event.stopPropagation()}>
                {summary.title}
              </a>
              <NodeState summary={summary} />
            </div>
            <div className="a-sub" data-tip={subtitle}>
              <span key={subtitle}>{subtitle}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
