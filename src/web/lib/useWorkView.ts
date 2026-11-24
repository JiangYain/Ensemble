import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SessionId, SessionSummary } from "@shared/types";
import { agentNodeId } from "../scene/layout";
import { collapsedSessions } from "./originCollapse";
import { filterWorking, settle, type Drawn } from "./workFilter";

/**
 * 画布上“只看工作中”的运行时：把纯函数 filterWorking（规则）与 settle（离场结算）接到 React 与 DOM 上。
 * 规则一变，不要的会话不是当场消失，而是先淡出（EXIT_MS）；用户正在操作的那张卡一直留到操作结束。
 */

/** 淡出时长：与 scene.css 里 node-out 的时长一致（var(--dur) = 220ms，再留一帧的余量）。 */
export const EXIT_MS = 240;
/** 有会话因为正被操作而暂缓时，多久看一次“操作结束了没有”。 */
export const HOLD_POLL_MS = 250;

export interface WorkView {
  /** 画面上要画的会话；undefined 是没有过滤（全部）。内容不变时是同一个对象。 */
  drawn: ReadonlySet<SessionId> | undefined;
  /** 正在淡出的会话（还画着）。 */
  leaving: ReadonlySet<SessionId>;
  /** 规则下被收起的会话数（“只看工作中”收起的，加上被隐藏了相关节点的 Main Agent 名下的；不含为保真留下的祖先、也不含还在淡出的）；什么都没收起是 0。 */
  hidden: number;
  /** drawn 的签名，给 useMemo 的依赖用。 */
  key: string;
  /** leaving 的签名。 */
  leavingKey: string;
}

const signature = (ids: ReadonlySet<string>): string => [...ids].sort().join("|");

const NO_ORIGINS: ReadonlySet<string> = new Set();

/**
 * 规则要留的会话：“只看工作中”（开着才有）与“隐藏了相关节点的 Main Agent”（把它名下整棵树拿掉）两者取交。
 * 两者都没有实际收起任何会话时是 undefined（全部画着）。被拿掉的是整棵树，所以“留下的会话对祖先封闭”这条仍然成立。
 */
function ruleOf(list: readonly SessionSummary[], enabled: boolean, collapsed: ReadonlySet<string>): { visible: ReadonlySet<SessionId>; hidden: number } | undefined {
  const working = enabled ? filterWorking(list) : undefined;
  const gone = collapsedSessions(list, collapsed);
  if (gone.size === 0) return working ? { visible: working.visible, hidden: working.hidden.size } : undefined;
  const visible = new Set(list.filter((session) => !gone.has(session.id) && (!working || working.visible.has(session.id))).map((session) => session.id));
  return { visible, hidden: list.length - visible.size };
}

const reducedMotion = (): boolean => typeof window !== "undefined" && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);

/**
 * `operated(id)` 回答“这个会话此刻是否正被用户操作着”（见 isOperated）；它读的是 DOM，不是 React 状态，
 * 所以只在结算时调用，不会让组件为此重绘。
 */
export function useWorkView(list: readonly SessionSummary[], enabled: boolean, operated: (id: SessionId) => boolean, collapsed: ReadonlySet<string> = NO_ORIGINS): WorkView {
  const filter = useMemo(() => ruleOf(list, enabled, collapsed), [list, enabled, collapsed]);
  const prev = useRef<Drawn | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const settled = useMemo(
    () => settle({ sessions: list, rule: filter?.visible, prev: prev.current, operated, now: Date.now(), exitMs: reducedMotion() ? 0 : EXIT_MS }),
    // tick：淡出到点、或暂缓的会话该再看一眼时由下面的定时器推一下，重新结算。
    [list, filter, operated, tick],
  );

  useLayoutEffect(() => {
    prev.current = { drawn: settled.drawn, linger: settled.linger };
    let delay = settled.held.size > 0 ? HOLD_POLL_MS : Infinity;
    if (settled.wakeAt !== undefined) delay = Math.min(delay, Math.max(0, settled.wakeAt - Date.now()));
    if (!Number.isFinite(delay)) return undefined;
    const timer = setTimeout(() => setTick((n) => n + 1), delay);
    return () => clearTimeout(timer);
  }, [settled]);

  const key = settled.drawn === "all" ? "*" : signature(settled.drawn);
  const leavingKey = signature(settled.leaving);
  // 内容没变就沿用同一个对象：布局等下游的 useMemo 只认 key，不会因为每次事件都换一份集合而重排。
  const drawn = useMemo(() => (settled.drawn === "all" ? undefined : settled.drawn), [key]);
  const leaving = useMemo(() => settled.leaving, [leavingKey]);
  return { drawn, leaving, hidden: filter?.hidden ?? 0, key, leavingKey };
}

function focusVisible(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    // 不认识这个选择器的浏览器：宁可多留一会儿，也不在用户手上把卡片收走。
    return true;
  }
}

/**
 * 用户是否正在操作这个会话的节点：
 * - 正在被拖动（引擎在元素上写 `data-dragging`）；
 * - 头部“···”菜单或右键菜单开着（`data-menu-open`）；
 * - 键盘焦点在它里面（`:focus-visible`：鼠标点出来的焦点不算，否则点过一下的卡片会一直收不走）。
 * 都是 DOM 上现成的事实，不需要引擎或节点组件配合。
 */
export function isOperated(root: ParentNode | null | undefined, sessionId: SessionId): boolean {
  if (!root) return false;
  const nodeId = agentNodeId(sessionId);
  const el = [...root.querySelectorAll<HTMLElement>("[data-node-id]")].find((candidate) => candidate.getAttribute("data-node-id") === nodeId);
  if (!el) return false;
  if (el.hasAttribute("data-dragging") || el.hasAttribute("data-menu-open")) return true;
  const active = document.activeElement;
  return active !== null && el.contains(active) && focusVisible(active);
}

/**
 * 给淡出中的节点打上 `data-leaving`（样式见 scene.css 的 node-out）。直接写属性而不经过节点组件：
 * 和引擎写 `data-fresh`、`data-selected` 一样，React 不管这个属性，重渲染不会把它冲掉。
 */
export function markLeaving(root: ParentNode | null | undefined, ids: ReadonlySet<string>): void {
  if (!root) return;
  for (const el of root.querySelectorAll<HTMLElement>("[data-node-id]")) {
    el.toggleAttribute("data-leaving", ids.has(el.getAttribute("data-node-id") ?? ""));
  }
}
