import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type WheelEvent } from "react";
import type { SessionState } from "@shared/projection";
import type { AssistantItem, DiagnosticItem, Message, MessageItem, PlanItem, QuestionItem, RunMarkerItem, SessionSummary } from "@shared/types";
import { isNearBottom, turnLeads, type WorkItem } from "../lib/conversation";
import { Markdown } from "../lib/markdown";
import { onFollowLatest, onReveal, takePendingReveal } from "../lib/reveal";
import { clock, elapsedOf, shortDuration, timeOfDay, toolVerb, useNow } from "../lib/text";
import { useT } from "../lib/useT";
import { harnessName } from "../lib/view";
import { Clamp } from "./bits";
import { DeliveryTrack, SyncTag } from "./Delivery";
import { HarnessMark } from "./HarnessMark";
import { Icon } from "./Icons";
import { QuestionCard } from "./QuestionCard";
import { GROUP_WINDOW, WorkGroup } from "./Steps";
import { Spinner } from "./ui";

export { GROUP_WINDOW };

// ───────────────────────── 分组 ─────────────────────────

export type Row =
  | { key: string; kind: "message"; item: MessageItem; message: Message | undefined }
  | { key: string; kind: "assistant"; item: AssistantItem }
  | { key: string; kind: "work"; items: WorkItem[] }
  | { key: string; kind: "plan"; item: PlanItem }
  | { key: string; kind: "diagnostic"; item: DiagnosticItem }
  | { key: string; kind: "question"; item: QuestionItem }
  | { key: string; kind: "run"; item: RunMarkerItem };

function sameItems(a: readonly WorkItem[], b: readonly WorkItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 连续的工具调用与推理合成一个“工作组”，其余条目各自成行。
 *
 * previous 是上一次的结果：某个工作组里的条目一个都没变时沿用上次那一行（同一个 items 数组），
 * 这样 WorkGroup 的 memo 才能命中——事件每来一条，只有正在变化的那一组需要重绘，而不是全部。
 */
export function buildRows(state: SessionState, previous?: readonly Row[]): Row[] {
  const rows: Row[] = [];
  const before = previous ? new Map(previous.map((row) => [row.key, row])) : undefined;
  let group: WorkItem[] | undefined;
  const closeGroup = (): void => {
    if (group && group.length > 0) {
      const key = `work:${group[0]?.id ?? rows.length}`;
      const old = before?.get(key);
      rows.push(old?.kind === "work" && sameItems(old.items, group) ? old : { key, kind: "work", items: group });
    }
    group = undefined;
  };
  for (const item of state.timeline) {
    if (item.type === "tool" || item.type === "reasoning") {
      (group ??= []).push(item);
      continue;
    }
    closeGroup();
    switch (item.type) {
      case "message": {
        const index = state.idx.messages.get(item.messageId);
        rows.push({ key: item.id, kind: "message", item, message: index === undefined ? undefined : state.messages[index] });
        break;
      }
      case "assistant":
        if (item.text.trim().length > 0 || item.streaming) rows.push({ key: item.id, kind: "assistant", item });
        break;
      case "plan":
        rows.push({ key: item.id, kind: "plan", item });
        break;
      case "diagnostic":
        rows.push({ key: item.id, kind: "diagnostic", item });
        break;
      case "question":
        // 提问卡片原位更新：回答、过期后同一个 key 换成只读的样子，不另起一行，也不会重新淡入。
        rows.push({ key: item.id, kind: "question", item });
        break;
      case "run":
        rows.push({ key: item.id, kind: "run", item });
        break;
    }
  }
  closeGroup();
  return rows;
}

/** 这一行内容开始的时刻，署名行显示它。 */
function startOf(row: Row): string | undefined {
  switch (row.kind) {
    case "assistant":
    case "plan":
    case "question":
      return row.item.at;
    case "work":
      return row.items[0]?.at;
    default:
      return undefined;
  }
}

// ───────────────────────── 单行 ─────────────────────────

function Time({ at }: { at: string }): ReactNode {
  return (
    <time className="row-time num" dateTime={at} data-tip={new Date(at).toLocaleString()}>
      {timeOfDay(at)}
    </time>
  );
}

/** 执行端一段发言的署名：图标、名字、开始的时刻。同一段里后面的内容不再重复。 */
function TurnHead({ harness, at, label }: { harness: SessionSummary["harness"]; at: string; label?: string | undefined }): ReactNode {
  const t = useT();
  return (
    <div className="turn-head">
      <HarnessMark harness={harness} size={16} variant="bare" />
      <span className="turn-name">{harnessName(harness, t)}</span>
      {label ? <span className="turn-tag">{label}</span> : null}
      <Time at={at} />
    </div>
  );
}

const AssistantRow = memo(function AssistantRow({ item, lead, enter }: { item: AssistantItem; lead: boolean; enter?: boolean }): ReactNode {
  const t = useT();
  const commentary = item.phase === "commentary";
  return (
    <article className="msg msg--assistant" data-phase={item.phase} data-streaming={item.streaming ? "" : undefined} data-enter={enter ? "" : undefined} aria-label={commentary ? t("msg.commentary") : undefined}>
      {/* 署名在发言的第一行；同一段里后面的回复只在悬停或聚焦时才显示时刻（过程说明还注明它是过程说明）。 */}
      {lead ? null : (
        <span className="msg-aside">
          {commentary ? <span>{t("msg.commentary")}</span> : null}
          <Time at={item.at} />
        </span>
      )}
      <Markdown text={item.text} streaming={item.streaming} />
    </article>
  );
});

/** 派发方（用户或主 Agent）发出的消息：靠右的气泡，下面跟着投递进度与同步状态。 */
const MessageRow = memo(function MessageRow({ item, message, enter }: { item: MessageItem; message: Message | undefined; enter?: boolean }): ReactNode {
  const t = useT();
  if (!message) return null;
  const isTask = message.kind === "task";
  const external = message.author.kind !== "system";
  return (
    <article className="msg msg--message" data-kind={message.kind} data-author={message.author.kind} data-message-id={message.id} data-enter={enter ? "" : undefined}>
      <header className="msg-head">
        <span className="msg-author">{message.author.label}</span>
        <span className="msg-kind" data-kind={message.kind}>
          {t(`msg.kind.${message.kind}`)}
        </span>
        <Time at={item.at} />
      </header>
      <div className="msg-bubble">
        <div className="msg-text">
          {isTask ? (
            <Clamp lines={4} expandLabel={t("common.expand")} collapseLabel={t("common.collapse")} watch={message.text}>
              {message.text}
            </Clamp>
          ) : (
            message.text
          )}
        </div>
      </div>
      <footer className="msg-foot">
        <DeliveryTrack message={message} />
        {external ? <SyncTag message={message} /> : null}
      </footer>
    </article>
  );
});

const PlanRow = memo(function PlanRow({ item, enter }: { item: PlanItem; enter?: boolean }): ReactNode {
  const t = useT();
  const done = item.entries.filter((entry) => entry.status === "completed").length;
  return (
    <section className="plan" data-enter={enter ? "" : undefined}>
      <header className="plan-head">
        <Icon name="list" size={14} />
        <span>{t("plan.title")}</span>
        <span className="plan-count num">
          {done}/{item.entries.length}
        </span>
      </header>
      {item.explanation ? <p className="plan-note">{item.explanation}</p> : null}
      <ol className="plan-list">
        {item.entries.map((entry, index) => (
          <li key={entry.id ?? index} data-status={entry.status}>
            <span className="plan-mark">{entry.status === "completed" ? <Icon name="check" size={10} strokeWidth={3} /> : entry.status === "in_progress" ? <Spinner size={10} /> : null}</span>
            <span>{entry.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
});

/** 状态码的本地化标题；没有收录的码返回 undefined，界面只显示执行端的原文。 */
export function codeHeadline(code: string, t: ReturnType<typeof useT>): string | undefined {
  const key = `code.${code}`;
  const text = t(key);
  return text === key ? undefined : text;
}

const DiagnosticRow = memo(function DiagnosticRow({ item, enter }: { item: DiagnosticItem; enter?: boolean }): ReactNode {
  const t = useT();
  const headline = codeHeadline(item.code, t);
  return (
    <div className="diag" data-level={item.level} data-enter={enter ? "" : undefined}>
      <Icon name={item.level === "info" ? "info" : "alert"} size={14} />
      <span className="diag-body">
        {headline ? <strong className="diag-head">{headline}</strong> : null}
        <span className="diag-text" data-tip={item.code}>
          {item.message}
        </span>
      </span>
      <Time at={item.at} />
    </div>
  );
});

const RunRow = memo(function RunRow({ item, enter }: { item: RunMarkerItem; enter?: boolean }): ReactNode {
  const t = useT();
  const duration = item.durationMs !== undefined ? ` · ${shortDuration(item.durationMs)}` : "";
  return (
    <div className="run-marker" data-phase={item.phase} data-enter={enter ? "" : undefined}>
      <span className="run-line" />
      <span className="run-label">
        {t(`run.marker.${item.phase}`, { n: item.runIndex })}
        {duration}
        {item.stopReason && item.phase !== "completed" ? ` · ${item.stopReason}` : ""}
      </span>
      <span className="run-line" />
    </div>
  );
});

// ───────────────────────── 实时状态行 ─────────────────────────

/**
 * 时间线末尾的“现在”：连接中、排队中、正在做什么，都是服务端给出的真实状态。
 * 排队时没有任何东西在运行，不转圈，只放一个静止的钟。计时只在运行开始后才有，之前不编造。
 *
 * 这一行只说“在做哪一类事、这次运行已经多久”，不重复工具的标题：正在运行的那一步就在它正上方的步骤组里
 * （连同命令或路径），页面顶部的状态也有一份；同一个字符串在相邻两处出现是噪音。
 */
function LiveLine({ summary }: { summary: SessionSummary }): ReactNode {
  const t = useT();
  const now = useNow();
  const { activity } = summary;
  const since = elapsedOf(summary, now);
  const tool = activity.kind === "tool" ? activity.tool : undefined;
  // 执行端停下来问了问题：此刻它在等一个回答，卡片就在上面——这一行不转圈，如实写“等待回答”。
  const asking = (summary.openQuestions ?? 0) > 0;
  const waiting = summary.phase === "queued" || asking;
  return (
    <div className="live-line" role="status" data-waiting={waiting ? "" : undefined} data-enter="">
      {waiting ? <Icon name="clock" size={13} /> : <Spinner size={12} />}
      {/* 状态种类变了才重新淡入；同一类里换工具只改文字，不闪。 */}
      <span className="live-text" key={asking ? "asking" : activity.kind}>
        {asking ? t("question.waiting") : tool ? toolVerb(tool.category, t) : t(`activity.${activity.kind}`)}
      </span>
      {since !== undefined ? (
        <span className="num live-clock" aria-hidden="true">
          {clock(since)}
        </span>
      ) : null}
    </div>
  );
}

// ───────────────────────── 时间线 ─────────────────────────

const ROW_STEP = 400;

/** 离底部不到这个距离就算“在底部”，新内容继续贴底。 */
const NEAR_BOTTOM = 48;

/** 定位后目标消息离滚动区顶边留出的距离，让它不贴着边。取 .timeline-inner 的上内边距，这样第一条消息恰好落在 scrollTop 0。 */
const REVEAL_TOP_GAP = 18;

/** 与 timeline.css 里 msg-flash 的时长一致（略长一点，保证动画放完再摘标记）。 */
const FLASH_MS = 2500;
const flashTimers = new WeakMap<HTMLElement, number>();

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** 让目标消息的外框亮一下再淡出，告诉用户“就是这一条”。到点摘掉标记，下次定位同一条还能再亮。 */
function flashMessage(target: HTMLElement): void {
  window.clearTimeout(flashTimers.get(target));
  target.removeAttribute("data-flash");
  void target.offsetWidth; // 重新触发动画
  target.setAttribute("data-flash", "");
  flashTimers.set(
    target,
    window.setTimeout(() => target.removeAttribute("data-flash"), FLASH_MS),
  );
}

/** 离开底部之后的三种状态：没离开 / 离开了 / 离开期间又来了新条目。 */
type Away = "none" | "idle" | "new";

export function Timeline({ state, rev, summary }: { state: SessionState; rev: number; summary: SessionSummary }): ReactNode {
  const t = useT();
  const lastRows = useRef<readonly Row[]>([]);
  const rows = useMemo(() => buildRows(state, lastRows.current), [state, rev]);
  useLayoutEffect(() => {
    lastRows.current = rows;
  }, [rows]);
  const [limit, setLimit] = useState(ROW_STEP);
  const [expandAll, setExpandAll] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState<Away>("none");
  // 是否贴底（正在跟随最新）：交给工作组决定窗口起点——贴底时起点随尾部前移，离开底部向上翻阅时冻结。
  // 与 stick 同步（离开 / 回到底部都会改 away）；stick 是 ref，不能直接作为渲染的依据。
  const atLatest = away === "none";
  const [scrolled, setScrolled] = useState(false);
  const itemCount = useRef(0);

  // 连接中、排队中也要有“现在”这一行；排队时没有东西在运行（见 LiveLine）。
  const active = summary.phase === "running" || summary.phase === "starting";
  const showLive = active || summary.phase === "queued";
  const hidden = Math.max(0, rows.length - limit);
  const visible = hidden > 0 ? rows.slice(hidden) : rows;
  const leads = useMemo(() => turnLeads(rows.map((row) => row.kind)), [rows]);
  const lastWorkIndex = (() => {
    for (let i = visible.length - 1; i >= 0; i--) if (visible[i]?.kind === "work") return i;
    return -1;
  })();
  const hasWork = useMemo(() => rows.some((row) => row.kind === "work" && row.items.some((item) => item.type === "tool")), [rows]);

  // 新出现的行淡入上来；一开始就在的、以及展开“更早的”时才露出来的，都不动。
  // 登记在提交之后进行，所以同一行在后续（比如流式）重绘里始终带着标记，动画不会被中途掐断。
  const known = useRef<Set<string> | undefined>(undefined);
  const entering = useRef<Set<string>>(new Set());
  const sessionId = useRef(state.meta.id);
  if (known.current === undefined || sessionId.current !== state.meta.id) {
    known.current = new Set(rows.map((row) => row.key));
    entering.current = new Set();
    sessionId.current = state.meta.id;
  } else {
    for (const row of visible) if (!known.current.has(row.key)) entering.current.add(row.key);
  }
  useLayoutEffect(() => {
    for (const row of rows) known.current?.add(row.key);
  }, [rows]);

  const scrollToEnd = useCallback((smooth: boolean) => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reducedMotion() ? "smooth" : "auto" });
  }, []);

  // 内容增长时，如果用户本来就在底部，就继续贴底；否则只提示有新内容。
  useLayoutEffect(() => {
    // “新内容”按条目数（工具调用、推理、消息……）算，不按行数：运行中的新步骤是追加进同一个工作组的，行数不会变。
    const count = state.timeline.length;
    if (stick.current) {
      scrollToEnd(false);
      setAway("none");
    } else if (count > itemCount.current) {
      setAway("new");
    }
    itemCount.current = count;
  }, [state, rev, rows.length, scrollToEnd]);

  // 流式文字、折叠块的展开与收起、输入框长高……都会让高度在两次渲染之间继续变化，
  // 用观察器保持贴底：内容变高、可视区变矮，两种变化都要跟。
  useEffect(() => {
    const el = scrollRef.current;
    const inner = el?.firstElementChild;
    if (!el || !inner) return;
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(inner);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 只有两种情形改变“是否贴底”：回到了底部附近（恢复跟随），或者位置确实向上移了（放弃）。
  // 内容长高让“离底部变远”但位置没动，不算用户离开：滚动事件与排版的先后并不确定——慢的机器上，
  // 程序刚贴底、事件还没派发，内容又长了一截，这时按距离判断就会把贴底误判成放弃，之后新内容再也不跟了。
  const lastTop = useRef(0);
  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    const movedUp = top < lastTop.current - 1;
    lastTop.current = top;
    if (isNearBottom(el, NEAR_BOTTOM)) stick.current = true;
    else if (movedUp) stick.current = false;
    const following = stick.current;
    setAway((previous) => (following ? "none" : previous === "none" ? "idle" : previous));
    setScrolled(top > 2);
  };

  // 用户向上滚：立刻放弃贴底，哪怕离底部还不到阈值——否则内容一长高，就把他刚滚上去的那一点又拽回去。
  const onWheel = (event: WheelEvent<HTMLDivElement>): void => {
    const el = scrollRef.current;
    if (el && event.deltaY < 0 && el.scrollTop > 0) stick.current = false;
  };

  // 在输入框里发了话：不管之前滚到了哪里，都回到最新处并继续贴底，让用户看到自己的话落在哪。
  useEffect(
    () =>
      onFollowLatest(() => {
        stick.current = true;
        setAway("none");
        scrollToEnd(false);
      }),
    [scrollToEnd],
  );

  // 右栏“消息记录”点击：滚动到对应的那条消息。目标行不在已渲染范围时（更早的行被收起），要等展开后再滚。
  const wanted = useRef<string | undefined>(undefined);

  const locate = useCallback((messageId: string): boolean => {
    const container = scrollRef.current;
    if (!container) return false;
    const target = [...container.querySelectorAll<HTMLElement>("[data-message-id]")].find((node) => node.dataset["messageId"] === messageId);
    if (!target) return false;
    const top = target.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - REVEAL_TOP_GAP;
    // 先放弃“贴底”，否则内容一变高就会被拽回底部，把这次滚动顶掉。离开了底部就给一条回去的路。
    stick.current = false;
    setAway((previous) => (previous === "none" ? "idle" : previous));
    container.scrollTo({ top: Math.max(0, top), behavior: reducedMotion() ? "auto" : "smooth" });
    flashMessage(target);
    return true;
  }, []);

  const reveal = useCallback(
    (messageId: string): void => {
      const index = rows.findIndex((row) => row.kind === "message" && row.message?.id === messageId);
      if (index < 0) return;
      if (index < hidden) {
        wanted.current = messageId;
        setLimit(rows.length - index);
      } else {
        locate(messageId);
      }
    },
    [rows, hidden, locate],
  );

  useLayoutEffect(() => {
    const id = wanted.current;
    if (id && locate(id)) wanted.current = undefined;
  }, [limit, locate]);

  useEffect(() => {
    // 窄屏下点击发生在别的标签页，时间线是随后才挂载的：挂载时把暂存的请求取走。
    const pending = takePendingReveal();
    if (pending) reveal(pending);
    return onReveal((messageId) => {
      takePendingReveal();
      reveal(messageId);
    });
  }, [reveal]);

  const jumpToLatest = (): void => {
    stick.current = true;
    scrollToEnd(true);
    setAway("none");
  };

  return (
    <div className="timeline" data-scrolled={scrolled ? "" : undefined}>
      <div className="timeline-tools">
        {rows.length > 0 ? <span className="timeline-count num">{t("timeline.count", { n: rows.length })}</span> : null}
        {hasWork ? (
          <button type="button" className="link-btn" onClick={() => setExpandAll((value) => !value)}>
            {expandAll ? t("timeline.collapseAll") : t("timeline.expandAll")}
          </button>
        ) : null}
      </div>
      <div className="timeline-scroll" ref={scrollRef} onScroll={onScroll} onWheel={onWheel} data-scroll>
        <div className="timeline-inner">
          {hidden > 0 ? (
            <button type="button" className="more-btn" onClick={() => setLimit((value) => value + ROW_STEP)}>
              {t("timeline.older", { n: hidden })}
            </button>
          ) : null}
          {visible.map((row, offset) => {
            const lead = leads[hidden + offset] === true;
            const enter = entering.current.has(row.key);
            const at = lead ? startOf(row) : undefined;
            const label = row.kind === "assistant" && row.item.phase === "commentary" ? t("msg.commentary") : undefined;
            return (
              <Fragment key={row.key}>
                {at ? <TurnHead harness={summary.harness} at={at} label={label} /> : null}
                {row.kind === "message" ? <MessageRow item={row.item} message={row.message} enter={enter} /> : null}
                {row.kind === "assistant" ? <AssistantRow item={row.item} lead={lead} enter={enter} /> : null}
                {row.kind === "work" ? <WorkGroup items={row.items} live={active && offset === lastWorkIndex && offset >= visible.length - 2} expandAll={expandAll} enter={enter} following={atLatest} /> : null}
                {row.kind === "plan" ? <PlanRow item={row.item} enter={enter} /> : null}
                {row.kind === "diagnostic" ? <DiagnosticRow item={row.item} enter={enter} /> : null}
                {row.kind === "question" ? <QuestionCard item={row.item} sessionId={summary.id} enter={enter} /> : null}
                {row.kind === "run" ? <RunRow item={row.item} enter={enter} /> : null}
              </Fragment>
            );
          })}
          {showLive ? <LiveLine summary={summary} /> : null}
          {rows.length === 0 && !showLive ? <div className="timeline-empty">{t("timeline.empty")}</div> : null}
        </div>
      </div>
      {away !== "none" ? (
        <button type="button" className="jump" data-new={away === "new" ? "" : undefined} aria-label={away === "new" ? undefined : t("timeline.latest")} data-tip={away === "new" ? undefined : t("timeline.latest")} onClick={jumpToLatest}>
          <Icon name="arrowDown" size={14} strokeWidth={2} />
          {away === "new" ? t("timeline.jump") : null}
        </button>
      ) : null}
    </div>
  );
}
