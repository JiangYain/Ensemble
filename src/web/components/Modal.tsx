import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePresence } from "../lib/presence";

/** 与 overlays.css 里 [data-closing] 的退出动画（0.16s）一致。 */
const EXIT_MS = 160;

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

let openModals = 0;

/** 对话框打开期间，让带 data-modal-inert 的背景区域整体不可聚焦、不进入无障碍树（提示通知区不受影响）。 */
function setBackgroundInert(on: boolean): void {
  openModals = Math.max(0, openModals + (on ? 1 : -1));
  const inert = openModals > 0;
  for (const el of document.querySelectorAll<HTMLElement>("[data-modal-inert]")) el.inert = inert;
}

/** 正在显示的对话框（退出动画期间不算），最后一个是最上层。 */
const shown: Array<() => void> = [];

/**
 * 焦点丢到 body 上时（刚按过的按钮随即被禁用或移除），面板自己的 onKeyDown 收不到按键，Esc 就关不掉对话框：
 * 这里兜底关最上层的那个。面板里处理过的 Esc（含筛选框先清字、菜单先收起）都已 preventDefault，不会重复。
 */
function closeTopOnEscape(event: KeyboardEvent): void {
  if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
  event.preventDefault();
  shown[shown.length - 1]?.();
}

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  label: string;
  width?: number;
  children: ReactNode;
  /** 打开时优先聚焦的元素（选择器）；缺省聚焦第一个可聚焦元素。 */
  initialFocus?: string;
}

/** 对话框：门户渲染、背景遮罩、焦点圈定与归还、Esc 与点击遮罩关闭、退出动画。 */
export function Modal({ open, onClose, label, width, children, initialFocus }: ModalProps): ReactNode {
  // present = open || 退出动画保留：open 变真的那一次渲染面板就已经挂上。
  const { present, closing } = usePresence(open, EXIT_MS);
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  // 副作用运行时面板已经提交、ref 已就位，所以先记下触发处，再直接把焦点交进面板，不依赖任何一帧。
  // 不能用 useLayoutEffect：它的清理发生在提交的变更阶段，随后 React 会把焦点“恢复”到提交前聚焦的元素——
  // 退出动画期间面板还在文档里，归还给触发处的焦点会被这一步抢回面板。
  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement as HTMLElement | null;
    setBackgroundInert(true);
    const panel = panelRef.current;
    const target = (initialFocus ? panel?.querySelector<HTMLElement>(initialFocus) : null) ?? panel?.querySelector<HTMLElement>(FOCUSABLE) ?? panel;
    target?.focus();
    return () => {
      // 先解除背景的 inert，再把焦点还回去，否则元素还不可聚焦。
      setBackgroundInert(false);
      const el = returnFocus.current;
      if (el && el.isConnected) el.focus();
    };
  }, [open, initialFocus]);

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const close = (): void => closeRef.current();
    shown.push(close);
    if (shown.length === 1) document.addEventListener("keydown", closeTopOnEscape);
    return () => {
      shown.splice(shown.indexOf(close), 1);
      if (shown.length === 0) document.removeEventListener("keydown", closeTopOnEscape);
    };
  }, [open]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent): void => {
      if (event.key === "Escape" && !event.nativeEvent.isComposing) {
        event.stopPropagation();
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      // tabIndex < 0 的元素（roving tabindex 里没被选中的那几项）按不到 Tab，不能当作“第一个/最后一个”，否则圈定会在它们那里漏掉。
      const nodes = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((node) => (node.offsetParent !== null && node.tabIndex >= 0) || node === document.activeElement);
      if (nodes.length === 0) {
        event.preventDefault();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    },
    [onClose],
  );

  if (!present) return null;
  return createPortal(
    <div className="overlay" data-closing={closing ? "" : undefined} onKeyDown={onKeyDown}>
      <div className="overlay-backdrop" onClick={onClose} aria-hidden="true" />
      <div ref={panelRef} className="overlay-panel" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} style={width ? { width } : undefined}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
