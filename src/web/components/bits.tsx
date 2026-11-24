import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { fitCut, type FitMode } from "../lib/fit";
import { Icon } from "./Icons";

/** 可折叠分区：标题 + 计数 + 内容。折叠状态由使用方决定初始值，不做持久化。 */
export function Section({
  title,
  count,
  defaultOpen = true,
  action,
  children,
  className,
}: {
  title: string;
  count?: number | string;
  defaultOpen?: boolean;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}): ReactNode {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <section className={`section${className ? ` ${className}` : ""}`} data-open={open ? "" : undefined}>
      <div className="section-head">
        <button type="button" className="section-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}>
          <Icon name="chevronRight" size={13} className="section-chevron" strokeWidth={2} />
          <span className="section-title">{title}</span>
          {count !== undefined ? <span className="section-count num">{count}</span> : null}
        </button>
        {action ? <span className="section-action">{action}</span> : null}
      </div>
      {open ? (
        <div className="section-body" id={id}>
          {children}
        </div>
      ) : null}
    </section>
  );
}

// ───────────────────────── 单行省略 ─────────────────────────

/** 量字符串宽度用的隐藏元素：整页共用一个，放在视口之外，不参与任何布局，也不会撑出滚动条。 */
let measurer: HTMLSpanElement | undefined;

const FONT_PROPS = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontStretch",
  "fontFeatureSettings",
  "fontVariationSettings",
  "fontVariantNumeric",
  "fontKerning",
  "fontOpticalSizing",
  "letterSpacing",
  "wordSpacing",
] as const;

/** 返回一个按目标元素当前字体量宽度的函数。逐项复制字体属性，而不是读 `font` 简写：后者在设置了字体特性时会是空串。 */
function measureWith(style: CSSStyleDeclaration): (text: string) => number {
  if (!measurer || !measurer.isConnected) {
    measurer = document.createElement("span");
    measurer.setAttribute("aria-hidden", "true");
    measurer.style.cssText = "position:fixed;left:-99999px;top:0;visibility:hidden;pointer-events:none;white-space:pre;";
    document.body.append(measurer);
  }
  const target = measurer;
  for (const prop of FONT_PROPS) {
    const value = style[prop];
    if (value) target.style[prop] = value;
  }
  return (text) => {
    target.textContent = text;
    return target.getBoundingClientRect().width;
  };
}

/**
 * 量出这一行能放下多少字符。可用宽度取元素自己的 `max-width`（样式表里写成 `calc(100cqw - …)`，
 * 浏览器会算成像素），所以“让出多少空间给旁边的按钮”只在 CSS 里写一遍。容器宽度变化、字体加载完成都会重新量。
 * 没有可用宽度（不在受限的容器里）时不省略，原样显示。
 */
function useFit(value: string, mode: FitMode): { ref: RefObject<HTMLSpanElement | null>; chars: string[]; cut: number | undefined } {
  const ref = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState<number | undefined>();
  const chars = useMemo(() => Array.from(value), [value]);
  const tail = mode.kind === "middle" ? mode.tail : 0;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let stale = false;
    const fit = (): void => {
      if (stale) return;
      const style = getComputedStyle(el);
      const available = Number.parseFloat(style.maxWidth);
      const next = Number.isFinite(available) ? fitCut(chars, available, measureWith(style), mode.kind === "middle" ? { kind: "middle", tail } : { kind: "start" }) : undefined;
      setCut((previous) => (previous === next ? previous : next));
    };
    fit();
    // 可用宽度来自容器（cqw），而不是这个元素自己，所以观察容器。
    const observer = new ResizeObserver(fit);
    observer.observe(el.parentElement ?? el);
    void document.fonts?.ready?.then(fit);
    return () => {
      stale = true;
      observer.disconnect();
    };
  }, [chars, mode.kind, tail]);

  return { ref, chars, cut };
}

/**
 * 路径放不下时从左边省略、保留最有辨识度的末尾（项目名、文件名）；完整路径放在悬停提示里。
 * 被省略的前半段仍在 DOM 里（宽度为 0），选中、复制得到的是完整路径；“…”由样式补在可见部分前面。
 */
export function PathText({ value, className }: { value: string; className?: string }): ReactNode {
  const { ref, chars, cut } = useFit(value, { kind: "start" });
  const clipped = cut !== undefined;
  return (
    <span ref={ref} className={`path-text${className ? ` ${className}` : ""}`} data-clipped={clipped ? "" : undefined} data-tip={value}>
      {clipped ? <span className="fit-hidden">{chars.slice(0, cut).join("")}</span> : null}
      <span className="path-shown">{clipped ? chars.slice(cut).join("") : value}</span>
    </span>
  );
}

/**
 * 标识符放不下时从中间省略：前缀（`ses_`、`agent-`）只说明类型，真正区分两个会话的是末尾几位，所以两头都要留。
 * 被省略的中段仍在 DOM 里（宽度为 0），选中、复制得到的是完整原文；“…”由样式补在尾部前面；完整值放在悬停提示里。
 */
export function MiddleText({ value, className, tail = 6, tip }: { value: string; className?: string; tail?: number; tip?: string }): ReactNode {
  const { ref, chars, cut } = useFit(value, { kind: "middle", tail });
  const split = Math.max(chars.length - tail, 0);
  const clipped = cut !== undefined;
  const headEnd = clipped ? Math.min(cut, split) : split;
  return (
    <span ref={ref} className={`mid-text${className ? ` ${className}` : ""}`} data-clipped={clipped ? "" : undefined} data-tip={tip ?? value}>
      <span className="mid-head">{chars.slice(0, headEnd).join("")}</span>
      {clipped && headEnd < split ? <span className="fit-hidden">{chars.slice(headEnd, split).join("")}</span> : null}
      <span className="mid-tail">{chars.slice(split).join("")}</span>
    </span>
  );
}

export function KV({ label, children, tip }: { label: string; children: ReactNode; tip?: string }): ReactNode {
  return (
    <div className="kv">
      <dt data-tip={tip}>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** 长文本默认只显示若干行，点击展开；文本本身不做任何改写。 */
export function Clamp({
  children,
  lines = 6,
  expandLabel,
  collapseLabel,
  watch,
}: {
  children: ReactNode;
  lines?: number;
  expandLabel: string;
  collapseLabel: string;
  /** 内容变化时重新测量是否溢出（例如文本会增长）。 */
  watch?: unknown;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || open) return;
    const measure = (): void => setOverflow(el.scrollHeight - el.clientHeight > 2);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, watch, lines]);
  return (
    <div className="clamp" data-open={open ? "" : undefined}>
      <div className="clamp-body" ref={bodyRef} style={open ? undefined : { WebkitLineClamp: lines }}>
        {children}
      </div>
      {overflow || open ? (
        <button type="button" className="link-btn" onClick={() => setOpen((value) => !value)}>
          {open ? collapseLabel : expandLabel}
        </button>
      ) : null}
    </div>
  );
}
