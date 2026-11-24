import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { SessionPhase } from "@shared/types";
import { toast } from "../lib/app";
import { useT } from "../lib/useT";
import { Icon, type IconName } from "./Icons";

// ───────────────────────── 状态点 ─────────────────────────

export function StatusDot({ phase, size = 8 }: { phase: SessionPhase; size?: number }): ReactNode {
  return <span className="status-dot" data-phase={phase} style={{ width: size, height: size }} aria-hidden="true" />;
}

// ───────────────────────── 按钮与标签 ─────────────────────────

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  label: string;
  size?: number;
  tone?: "default" | "danger";
}

export function IconButton({ icon, label, size = 15, tone = "default", className, ...rest }: IconButtonProps): ReactNode {
  return (
    <button type="button" className={`icon-btn${className ? ` ${className}` : ""}`} data-tone={tone} aria-label={label} data-tip={label} {...rest}>
      <Icon name={icon} size={size} />
    </button>
  );
}

export function Chip({
  children,
  tone = "neutral",
  icon,
  tip,
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "teal" | "amber" | "red" | "blue" | "violet";
  icon?: IconName;
  tip?: string;
  className?: string;
}): ReactNode {
  return (
    <span className={`chip${className ? ` ${className}` : ""}`} data-tone={tone} data-tip={tip}>
      {icon ? <Icon name={icon} size={12} /> : null}
      {children}
    </span>
  );
}

/**
 * 转动标记：空心方块里一道上下推移的带子（画法与几何公式见 components.css 的 .spinner）。
 * 框占 1px，框内高度是 size − 2；带子取它的一半（向下取整），能停的位置数 = 行程 + 1（每格 1px，每一帧都落在整像素上）。
 */
export function Spinner({ size = 14 }: { size?: number }): ReactNode {
  const inner = size - 2;
  const band = Math.floor(inner / 2);
  const style = { width: size, height: size, "--spin-band": `${band}px`, "--spin-n": inner - band + 1 } as CSSProperties;
  return <span className="spinner" style={style} aria-hidden="true" />;
}

export function CopyButton({ value, label, size = 13 }: { value: string; label: string; size?: number }): ReactNode {
  const t = useT();
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className="icon-btn icon-btn--bare"
      aria-label={label}
      data-tip={done ? t("common.copied") : label}
      onClick={(event) => {
        event.stopPropagation();
        void copyText(value).then((ok) => {
          if (!ok) {
            toast("warn", t("common.copyFailed"));
            return;
          }
          setDone(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setDone(false), 1400);
        });
      }}
    >
      <Icon name={done ? "check" : "copy"} size={size} />
    </button>
  );
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 非安全上下文或被拒绝时退回到临时文本域。
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

// ───────────────────────── 提示（事件委托：任何带 data-tip 的元素） ─────────────────────────

interface TipState {
  text: string;
  rect: DOMRect;
  side: "top" | "bottom";
}

/** 全局只挂一个：悬停或聚焦任意带 data-tip 的元素，延迟片刻后在其上方（放不下则下方）显示。 */
export function TipHost(): ReactNode {
  const [tip, setTip] = useState<TipState | undefined>(undefined);
  const [pos, setPos] = useState<{ left: number; top: number } | undefined>(undefined);
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastShown = useRef(0);
  const current = useRef<Element | null>(null);

  useEffect(() => {
    const hide = (): void => {
      clearTimeout(timer.current);
      current.current = null;
      setTip((previous) => {
        if (previous) lastShown.current = Date.now();
        return undefined;
      });
      setPos(undefined);
    };
    const show = (target: Element): void => {
      const text = target.getAttribute("data-tip");
      if (!text) return;
      current.current = target;
      const open = (): void => {
        if (!target.isConnected) return;
        // 打开的这一刻再读一次：等待的 260ms 里文案可能已经变了。
        const latest = target.getAttribute("data-tip");
        if (!latest) return;
        const rect = target.getBoundingClientRect();
        setPos(undefined);
        setTip({ text: latest, rect, side: rect.top < 64 ? "bottom" : "top" });
      };
      clearTimeout(timer.current);
      timer.current = Date.now() - lastShown.current < 500 ? undefined : setTimeout(open, 260);
      if (!timer.current) open();
    };
    const onOver = (event: Event): void => {
      const target = (event.target as Element | null)?.closest?.("[data-tip]");
      if (!target) {
        if (current.current) hide();
        return;
      }
      if (target !== current.current) show(target);
    };
    const onOut = (event: PointerEvent): void => {
      const to = event.relatedTarget as Element | null;
      if (current.current && !(to && current.current.contains(to))) hide();
    };
    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerout", onOut);
    document.addEventListener("focusin", onOver);
    document.addEventListener("focusout", hide);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") hide();
    };
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("scroll", hide, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", hide);
    // 提示开着时目标的文案变了（点一下按钮、文案随状态翻转；点击先聚焦、后翻转，提示打开时读到的是旧的）：跟着换，
    // 去掉了文案就收起。只看当前这一个目标，别的元素的变化不相干。
    const watcher = new MutationObserver(() => {
      const target = current.current;
      if (!target) return;
      const text = target.getAttribute("data-tip");
      if (!text) {
        hide();
        return;
      }
      setTip((previous) => (previous && previous.text !== text ? { ...previous, text } : previous));
    });
    watcher.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-tip"] });
    return () => {
      watcher.disconnect();
      clearTimeout(timer.current);
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerout", onOut);
      document.removeEventListener("focusin", onOver);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("scroll", hide, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", hide);
    };
  }, []);

  useLayoutEffect(() => {
    if (!tip || !ref.current) return;
    const box = ref.current.getBoundingClientRect();
    const margin = 8;
    const center = tip.rect.left + tip.rect.width / 2;
    const left = Math.min(Math.max(margin, center - box.width / 2), window.innerWidth - box.width - margin);
    const top = tip.side === "top" ? tip.rect.top - box.height - 8 : tip.rect.bottom + 8;
    setPos({ left, top: Math.max(margin, top) });
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div ref={ref} className="tip" role="tooltip" data-ready={pos ? "" : undefined} style={{ left: pos?.left ?? 0, top: pos?.top ?? 0 }}>
      {tip.text}
    </div>,
    document.body,
  );
}
