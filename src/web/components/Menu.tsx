import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icons";

export interface MenuItem {
  id: string;
  label: string;
  icon?: IconName;
  danger?: boolean;
  disabled?: boolean;
  /** 禁用时给出原因（悬停提示）。 */
  disabledReason?: string;
  separatorAbove?: boolean;
  onSelect: () => void;
}

/**
 * 分组标题：不可操作，它开启一个新的分组。组与组之间自动画一条分隔线；
 * 组内的项在无障碍树里属于这个标题命名的 `group`，读屏软件能读出“这一组是对什么操作”。
 */
export interface MenuHeading {
  id: string;
  heading: string;
}

/**
 * 一行紧凑的图标项：只画图标，`label` 是无障碍名称，悬停与聚焦时提示 `label`（不可用时提示 `disabledReason`）。
 * 行内某一项的 `separatorAbove` 表示“这一项前面画一道竖线”，用来把行内的两类操作分开。
 * 键盘：↑↓ 在行与行（以及普通项）之间走，←→ 在行内走。
 */
export interface MenuRow {
  id: string;
  items: MenuItem[];
}

export type MenuEntry = MenuItem | MenuHeading | MenuRow;

// ───────────────────────── 定位 ─────────────────────────

/** 菜单距视口边缘至少留的空隙。 */
export const MENU_MARGIN = 8;
/** 按钮触发时，菜单与按钮之间的空隙。 */
const BUTTON_GAP = 6;

export interface MenuPlacement {
  left: number;
  top: number;
  /** 菜单比视口还高时才有：限制高度，由菜单自己内部滚动。 */
  maxHeight?: number;
  /** 出场动画的原点：从触发点“长”出来。 */
  origin: string;
}

interface Size {
  width: number;
  height: number;
}

/**
 * 在指针位置弹出：左上角贴着指针；右边或下边放不下就整体翻到指针的左边 / 上边；
 * 最后再夹进距视口边缘 `margin` 的范围里，永远不会超出视口。
 */
export function placeMenuAtPoint(point: { x: number; y: number }, size: Size, viewport: Size, margin = MENU_MARGIN): MenuPlacement {
  let left = point.x;
  const flipX = left + size.width > viewport.width - margin;
  if (flipX) left = point.x - size.width;
  left = Math.max(margin, Math.min(left, viewport.width - margin - size.width));
  const room = Math.max(0, viewport.height - margin * 2);
  if (size.height > room) return { left, top: margin, maxHeight: room, origin: `top ${flipX ? "right" : "left"}` };
  let top = point.y;
  const flipY = top + size.height > viewport.height - margin;
  if (flipY) top = point.y - size.height;
  top = Math.max(margin, Math.min(top, viewport.height - margin - size.height));
  return { left, top, origin: `${flipY ? "bottom" : "top"} ${flipX ? "right" : "left"}` };
}

/** 从按钮弹出：与按钮右对齐、放在按钮下方；下方放不下就翻到上方。 */
export function placeMenuByButton(
  rect: { left: number; right: number; top: number; bottom: number },
  size: Size,
  viewport: Size,
  margin = MENU_MARGIN,
): MenuPlacement {
  const left = Math.max(margin, Math.min(rect.right - size.width, viewport.width - size.width - margin));
  const room = Math.max(0, viewport.height - margin * 2);
  if (size.height > room) return { left, top: margin, maxHeight: room, origin: "top right" };
  const below = rect.bottom + BUTTON_GAP;
  const flipped = below + size.height > viewport.height - margin;
  const top = flipped ? Math.max(margin, rect.top - size.height - BUTTON_GAP) : below;
  return { left, top, origin: `${flipped ? "bottom" : "top"} right` };
}

// ───────────────────────── 弹层 ─────────────────────────

export type MenuAnchor =
  | { kind: "button"; el: HTMLElement }
  | { kind: "point"; x: number; y: number };

export interface MenuPopupProps {
  entries: MenuEntry[];
  label: string;
  anchor: MenuAnchor;
  /** 弹层要关闭了。`restoreFocus` 为 true 表示是用户在菜单里操作（选了一项或按了 Esc），宿主应把焦点还给触发它的元素。 */
  onClose: (restoreFocus: boolean) => void;
}

const ENABLED_ITEM = '[role="menuitem"]:not([aria-disabled="true"])';

/** 同一时刻只有一个菜单：新的菜单打开时，先把已经打开的收起来（比如 ··· 菜单开着时在节点上点右键）。 */
const openPopups = new Set<() => void>();

/** 键盘的“停靠点”：一行紧凑项算一个停靠点，其余每项各算一个。 */
function stopsOf(menu: HTMLElement): HTMLElement[][] {
  const stops: HTMLElement[][] = [];
  let lastRow: Element | null = null;
  for (const node of menu.querySelectorAll<HTMLElement>(ENABLED_ITEM)) {
    const row = node.closest(".menu-row");
    const last = stops[stops.length - 1];
    if (row && row === lastRow && last) last.push(node);
    else stops.push([node]);
    lastRow = row;
  }
  return stops;
}

interface Block {
  heading: MenuHeading | undefined;
  entries: (MenuItem | MenuRow)[];
}

function toBlocks(entries: readonly MenuEntry[]): Block[] {
  const blocks: Block[] = [];
  for (const entry of entries) {
    if ("heading" in entry) {
      blocks.push({ heading: entry, entries: [] });
      continue;
    }
    let block = blocks[blocks.length - 1];
    if (!block) {
      block = { heading: undefined, entries: [] };
      blocks.push(block);
    }
    block.entries.push(entry);
  }
  return blocks;
}

/**
 * 菜单弹层：门户渲染（不受画布缩放影响），支持键盘（↑↓ ←→ Home End Enter 空格 Esc），
 * 点击外部、滚动、滚轮、resize、失焦与 Tab 都会关闭。
 * “按钮触发”（`MenuButton`）与“指针位置触发”（画布上的右键菜单）共用这一份实现，只有定位的锚点不同。
 * 弹层只负责呈现与交互；关闭之后焦点交给谁，由宿主在 `onClose` 里决定。
 */
export function MenuPopup({ entries, label, anchor, onClose }: MenuPopupProps): ReactNode {
  const menuRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<MenuPlacement | undefined>(undefined);
  const idBase = useId();
  // 事件监听只在挂载时绑定一次；回调和锚点放进 ref，宿主每次渲染换新对象也不会让监听重绑、更不会重新聚焦。
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    // 量布局尺寸，不量 getBoundingClientRect：入场动画的起点带着 scale(0.98)，包围盒比真实尺寸小 2%，
    // 翻转和夹边都会因此偏出几个像素（菜单最终落定时越过指针或 8px 边距）。
    const size = { width: menu.offsetWidth, height: menu.offsetHeight };
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const at = anchorRef.current;
    setPlace(at.kind === "point" ? placeMenuAtPoint(at, size, viewport) : placeMenuByButton(at.el.getBoundingClientRect(), size, viewport));
  }, []);

  useEffect(() => {
    menuRef.current?.querySelector<HTMLElement>(ENABLED_ITEM)?.focus();
    const self = (): void => closeRef.current(false);
    for (const other of [...openPopups]) other();
    openPopups.add(self);
    return () => {
      openPopups.delete(self);
    };
  }, []);

  useEffect(() => {
    const dismiss = (): void => closeRef.current(false);
    // scroll / wheel 的目标可能是 document 甚至 window，不一定是节点。
    const inMenu = (target: EventTarget | null): boolean => target instanceof Node && (menuRef.current?.contains(target) ?? false);
    const onPointerDown = (event: PointerEvent): void => {
      if (inMenu(event.target)) return;
      const at = anchorRef.current;
      // 触发按钮自己的点击负责开合，这里不抢。
      if (at.kind === "button" && event.target instanceof Node && at.el.contains(event.target)) return;
      dismiss();
    };
    const onOutside = (event: Event): void => {
      if (inMenu(event.target)) return;
      dismiss();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", onOutside, true);
    // 画布上的滚轮会平移、缩放，不产生 scroll 事件，菜单留在原地就和它指的东西对不上了。
    window.addEventListener("wheel", onOutside, { capture: true, passive: true });
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", onOutside, true);
      window.removeEventListener("wheel", onOutside, true);
      window.removeEventListener("blur", dismiss);
    };
  }, []);

  const choose = (item: MenuItem): void => {
    if (item.disabled) return;
    closeRef.current(true);
    item.onSelect();
  };
  const onItemKeyDown = (event: React.KeyboardEvent, item: MenuItem): void => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(item);
    }
  };

  const onMenuKeyDown = (event: React.KeyboardEvent): void => {
    const menu = menuRef.current;
    if (!menu) return;
    const stops = stopsOf(menu);
    const active = document.activeElement as HTMLElement | null;
    const stopIndex = stops.findIndex((stop) => active !== null && stop.includes(active));
    const column = stopIndex >= 0 ? (stops[stopIndex]?.indexOf(active as HTMLElement) ?? 0) : 0;
    const focusStop = (next: number, at = 0): void => {
      const stop = stops[(next + stops.length) % stops.length];
      stop?.[Math.min(at, stop.length - 1)]?.focus();
    };
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusStop(stopIndex + 1, column);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusStop(stopIndex < 0 ? stops.length - 1 : stopIndex - 1, column);
        break;
      case "ArrowLeft":
      case "ArrowRight": {
        const row = stops[stopIndex];
        if (!row || row.length < 2) break;
        event.preventDefault();
        row[(column + (event.key === "ArrowRight" ? 1 : -1) + row.length) % row.length]?.focus();
        break;
      }
      case "Home":
        event.preventDefault();
        focusStop(0);
        break;
      case "End":
        event.preventDefault();
        stops[stops.length - 1]?.at(-1)?.focus();
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        closeRef.current(true);
        break;
      case "Tab":
        closeRef.current(false);
        break;
    }
  };

  const renderItem = (item: MenuItem): ReactNode => (
    <div key={item.id}>
      {item.separatorAbove ? <div className="menu-sep" role="separator" /> : null}
      <div
        role="menuitem"
        tabIndex={-1}
        className="menu-item"
        data-danger={item.danger ? "" : undefined}
        aria-disabled={item.disabled || undefined}
        data-tip={item.disabled ? item.disabledReason : undefined}
        onClick={() => choose(item)}
        onKeyDown={(event) => onItemKeyDown(event, item)}
      >
        {item.icon ? <Icon name={item.icon} size={15} /> : <span className="menu-icon-gap" />}
        <span>{item.label}</span>
      </div>
    </div>
  );

  const renderRow = (row: MenuRow): ReactNode => (
    <div key={row.id} className="menu-row">
      {row.items.map((item, index) => {
        // 不可用时，原因就是它的名字和提示：读屏与悬停都能知道为什么。
        const name = item.disabled && item.disabledReason ? item.disabledReason : item.label;
        return (
          <Fragment key={item.id}>
            {index > 0 && item.separatorAbove ? <div className="menu-vsep" role="separator" aria-orientation="vertical" /> : null}
            <div
              role="menuitem"
              tabIndex={-1}
              className="menu-item"
              data-compact=""
              data-danger={item.danger ? "" : undefined}
              aria-label={name}
              aria-disabled={item.disabled || undefined}
              data-tip={name}
              onClick={() => choose(item)}
              onKeyDown={(event) => onItemKeyDown(event, item)}
            >
              {item.icon ? <Icon name={item.icon} size={15} /> : <span>{item.label}</span>}
            </div>
          </Fragment>
        );
      })}
    </div>
  );

  const renderEntry = (entry: MenuItem | MenuRow): ReactNode => ("items" in entry ? renderRow(entry) : renderItem(entry));

  return createPortal(
    <div
      ref={menuRef}
      className="menu"
      role="menu"
      aria-label={label}
      data-ready={place ? "" : undefined}
      style={{ left: place?.left ?? 0, top: place?.top ?? 0, maxHeight: place?.maxHeight, transformOrigin: place?.origin }}
      onKeyDown={onMenuKeyDown}
      onClick={(event) => event.stopPropagation()}
      // 菜单上再点右键不该叠出浏览器的原生菜单。
      onContextMenu={(event) => event.preventDefault()}
    >
      {toBlocks(entries).map((block, index) => {
        const heading = block.heading;
        const labelId = heading ? `${idBase}-${heading.id}` : undefined;
        return (
          <Fragment key={heading?.id ?? `plain-${index}`}>
            {index > 0 ? <div className="menu-sep" role="separator" /> : null}
            <div role={heading ? "group" : undefined} aria-labelledby={labelId}>
              {heading ? (
                <div className="menu-label" id={labelId}>
                  {heading.heading}
                </div>
              ) : null}
              {block.entries.map(renderEntry)}
            </div>
          </Fragment>
        );
      })}
    </div>,
    document.body,
  );
}

// ───────────────────────── 按钮触发 ─────────────────────────

interface MenuButtonProps {
  /**
   * 菜单项。给一个函数就在菜单打开时才现算：项的可用状态依赖别处的状态时（例如“归档”要看整棵子树里有没有会话还在工作），
   * 父组件不会因为下级的变化重绘，预先算好的数组就可能是过期的。
   */
  items: MenuItem[] | (() => MenuItem[]);
  label: string;
  icon?: IconName;
  /** 替换触发按钮里的图标（节点头部用三个会“呼吸”的点）。 */
  glyph?: ReactNode;
  className?: string;
  /** 打开/关闭时通知宿主（节点据此在菜单打开期间保持“悬停”样式）。 */
  onOpenChange?: (open: boolean) => void;
}

/**
 * 轻量下拉菜单：弹层见 `MenuPopup`；这里只管触发按钮——点击或在按钮上按 ↓ 打开，关闭后焦点回到按钮。
 */
export function MenuButton({ items, label, icon = "more", glyph, className, onOpenChange }: MenuButtonProps): ReactNode {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(
    (restoreFocus: boolean) => {
      setOpen(false);
      onOpenChange?.(false);
      if (restoreFocus) buttonRef.current?.focus();
    },
    [onOpenChange],
  );

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`icon-btn${className ? ` ${className}` : ""}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tip={open ? undefined : label}
        data-open={open ? "" : undefined}
        onClick={(event) => {
          event.stopPropagation();
          const next = !open;
          setOpen(next);
          onOpenChange?.(next);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(true);
            onOpenChange?.(true);
          }
        }}
      >
        {glyph ?? <Icon name={icon} size={16} />}
      </button>
      {open && buttonRef.current ? (
        <MenuPopup entries={typeof items === "function" ? items() : items} label={label} anchor={{ kind: "button", el: buttonRef.current }} onClose={close} />
      ) : null}
    </>
  );
}
