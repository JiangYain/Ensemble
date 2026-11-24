import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import type { SessionSummary } from "@shared/types";
import { store } from "../lib/app";
import { useStore } from "../lib/store";
import { phaseLabel } from "../lib/text";
import { useT } from "../lib/useT";
import type { SceneEngine } from "../scene/engine";
import { agentNodeId } from "../scene/layout";
import type { Edge } from "../scene/offscreen";
import { Icon, type IconName } from "./Icons";

const ARROW: Record<Edge, IconName> = { top: "arrowUp", right: "arrowRight", bottom: "arrowDown", left: "arrowLeft" };
const DIRECTION = { top: "edgeHint.top", right: "edgeHint.right", bottom: "edgeHint.bottom", left: "edgeHint.left" } as const;

/** 悬停提示里最多列几个会话，再多的写“另有 N 个”。 */
const MAX_ROWS = 4;
/** “在这里”的光晕停留多久：与 scene.css 里 `.node[data-landed]::after` 的动画时长（1.6s）一致。 */
const LANDED_MS = 1600;

/**
 * 画布边缘的“新会话在视口之外”提示：新到的会话落在用户看不见的地方时，在它所在的那条边给一枚小方标，
 * 点一下相机平移过去（只平移，不改缩放）。相机始终归用户：这里从不自动移动它。
 * 什么算“新到”、何时消失、点了去哪个，都在 scene/arrivals.ts；这里只负责呈现与点击。
 *
 * 一个箭头，多于一个时再加数量；悬停或聚焦时读标题与状态（来自真实的会话数据，随状态更新）。
 * 点击不选中节点、不改选择、不抢焦点：只给被带过去的节点一圈短暂的光晕，免得在一屏节点里找不到“是哪一个”；
 * 例外是键盘触发——按钮随即消失，焦点若还留在上面就丢回页首，所以把焦点交给被带过去的节点（preventScroll：容器靠 transform 取景，不能被滚动）。
 */
export function EdgeHints({ engine }: { engine: SceneEngine }): ReactNode {
  const t = useT();
  const hints = useSyncExternalStore(engine.arrivals.subscribe, engine.arrivals.getHints);
  const sessions = useStore(store, (s) => s.sessions);
  const rootRef = useRef<HTMLDivElement>(null);
  const landed = useRef(new Map<HTMLElement, ReturnType<typeof setTimeout>>());
  const [announcement, setAnnouncement] = useState("");

  // 底部的提示避开底部的对齐条或提示容器：选中两个以上节点、对齐条冒出来时，提示跟着抬高而不是被盖住。
  useLayoutEffect(() => {
    const root = rootRef.current;
    const stack =
      root?.closest(".scene")?.querySelector<HTMLElement>(".arrange-wrap") ??
      root?.ownerDocument.querySelector<HTMLElement>(".dock-wrap");
    if (!root || !stack) return;
    const measure = (): void => {
      const gap = Number.parseFloat(getComputedStyle(stack).rowGap) || 0;
      const lift = root.getBoundingClientRect().bottom - stack.getBoundingClientRect().top;
      root.style.setProperty("--edge-stack", `${Math.max(0, lift) + gap}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stack);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // 卸载时收掉还没到点的光晕。
  useEffect(() => {
    const timers = landed.current;
    return () => {
      for (const [el, timer] of timers) {
        clearTimeout(timer);
        el.removeAttribute("data-landed");
      }
      timers.clear();
    };
  }, []);

  const byNode = new Map<string, SessionSummary>();
  for (const summary of Object.values(sessions)) byNode.set(agentNodeId(summary.id), summary);
  const shown = hints.flatMap((hint) => {
    const entries = hint.ids.flatMap((id) => byNode.get(id) ?? []);
    const nearest = entries[0];
    if (!nearest) return [];
    const dir = t(DIRECTION[hint.edge]);
    const label = entries.length === 1 ? t("edgeHint.one", { dir, title: nearest.title }) : t("edgeHint.many", { dir, n: entries.length, title: nearest.title });
    const rows = entries.slice(0, MAX_ROWS).map((entry) => `${entry.title} · ${phaseLabel(entry.phase, t)}`);
    if (entries.length > MAX_ROWS) rows.push(t("edgeHint.more", { n: entries.length - MAX_ROWS }));
    rows.push(t(entries.length === 1 ? "edgeHint.goOne" : "edgeHint.goNearest"));
    return [{ edge: hint.edge, count: entries.length, label, tip: rows.join("\n") }];
  });

  // 读屏：新出现（或又多了一个）时读一遍，全部消失后清空，下一次相同的文字才会再读。
  const total = shown.reduce((sum, hint) => sum + hint.count, 0);
  const announced = useRef(0);
  const labels = shown.map((hint) => hint.label).join(". ");
  useEffect(() => {
    if (total > announced.current) setAnnouncement(labels);
    else if (total === 0) setAnnouncement("");
    announced.current = total;
  }, [total, labels]);

  const go = (edge: Edge, event: MouseEvent<HTMLButtonElement>): void => {
    const id = engine.arrivals.go(edge);
    const scene = rootRef.current?.closest(".scene");
    const el = id === undefined ? undefined : [...(scene?.querySelectorAll<HTMLElement>("[data-node-id]") ?? [])].find((candidate) => candidate.dataset["nodeId"] === id);
    if (!el) return;
    clearTimeout(landed.current.get(el));
    el.setAttribute("data-landed", "");
    landed.current.set(el, setTimeout(() => {
      el.removeAttribute("data-landed");
      landed.current.delete(el);
    }, LANDED_MS));
    // 键盘触发的点击 detail 为 0。
    if (event.detail === 0) el.focus({ preventScroll: true });
  };

  return (
    <div className="edge-hints" ref={rootRef}>
      {shown.map((hint) => (
        <button key={hint.edge} type="button" className="edge-hint" data-edge={hint.edge} data-multi={hint.count > 1 ? "" : undefined}
          aria-label={hint.label} aria-description={hint.tip} data-tip={hint.tip} onClick={(event) => go(hint.edge, event)}>
          <Icon name={ARROW[hint.edge]} size={15} />
          {hint.count > 1 ? <span className="edge-hint-count num" aria-hidden="true">{hint.count > 99 ? "99+" : hint.count}</span> : null}
        </button>
      ))}
      <span className="sr-only" aria-live="polite">{announcement}</span>
    </div>
  );
}
