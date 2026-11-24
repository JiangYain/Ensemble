import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { MENU_MARGIN, MenuButton, MenuPopup, placeMenuAtPoint, placeMenuByButton, type MenuAnchor, type MenuEntry, type MenuItem } from "./Menu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIEWPORT = { width: 1000, height: 800 };
const MENU = { width: 224, height: 200 };

describe("菜单定位：指针位置", () => {
  it("放得下：左上角贴着指针，从指针“长”出来", () => {
    expect(placeMenuAtPoint({ x: 100, y: 120 }, MENU, VIEWPORT)).toEqual({ left: 100, top: 120, origin: "top left" });
  });

  it("右边放不下：整体翻到指针左边，右缘贴着指针", () => {
    expect(placeMenuAtPoint({ x: 900, y: 120 }, MENU, VIEWPORT)).toEqual({ left: 900 - 224, top: 120, origin: "top right" });
  });

  it("下边放不下：整体翻到指针上边，下缘贴着指针", () => {
    expect(placeMenuAtPoint({ x: 100, y: 700 }, MENU, VIEWPORT)).toEqual({ left: 100, top: 700 - 200, origin: "bottom left" });
  });

  it("右下角：两个方向都翻，仍距视口边缘至少 8px", () => {
    const place = placeMenuAtPoint({ x: 995, y: 797 }, MENU, VIEWPORT);
    expect(place.origin).toBe("bottom right");
    expect(place.left + MENU.width).toBeLessThanOrEqual(VIEWPORT.width - MENU_MARGIN);
    expect(place.top + MENU.height).toBeLessThanOrEqual(VIEWPORT.height - MENU_MARGIN);
  });

  it("左上角：夹在距边缘 8px 的位置，不会出到视口外", () => {
    expect(placeMenuAtPoint({ x: 0, y: 0 }, MENU, VIEWPORT)).toMatchObject({ left: MENU_MARGIN, top: MENU_MARGIN });
    expect(placeMenuAtPoint({ x: -50, y: -30 }, MENU, VIEWPORT)).toMatchObject({ left: MENU_MARGIN, top: MENU_MARGIN });
  });

  it("窄视口（宿主侧栏约 320px）：翻转之后仍夹进 8px 边距内", () => {
    const narrow = { width: 320, height: 700 };
    // 指针在 250：右边只剩 70，翻到指针左边（右缘贴着指针，26..250）。
    const place = placeMenuAtPoint({ x: 250, y: 100 }, MENU, narrow);
    expect(place).toMatchObject({ left: 250 - 224, origin: "top right" });
    expect(place.left + MENU.width).toBeLessThanOrEqual(narrow.width - MENU_MARGIN);
    // 指针在最右边缘：翻转之后超出右边距的部分被夹回来。
    const edge = placeMenuAtPoint({ x: 319, y: 100 }, MENU, narrow);
    expect(edge.left).toBe(narrow.width - MENU_MARGIN - MENU.width);
    // 菜单比可用宽度还宽时贴左边。
    expect(placeMenuAtPoint({ x: 50, y: 10 }, { width: 400, height: 100 }, narrow).left).toBe(MENU_MARGIN);
  });

  it("比视口还高：顶住上边距，限制高度让菜单自己内部滚动", () => {
    const place = placeMenuAtPoint({ x: 100, y: 300 }, { width: 224, height: 900 }, { width: 1000, height: 600 });
    expect(place.top).toBe(MENU_MARGIN);
    expect(place.maxHeight).toBe(600 - MENU_MARGIN * 2);
  });

  it("不论指针落在哪（含视口之外），菜单整体都在 8px 边距之内", () => {
    for (const size of [MENU, { width: 320, height: 520 }, { width: 150, height: 60 }]) {
      for (const viewport of [VIEWPORT, { width: 320, height: 480 }, { width: 640, height: 300 }]) {
        for (let x = -40; x <= viewport.width + 40; x += 37) {
          for (let y = -40; y <= viewport.height + 40; y += 29) {
            const place = placeMenuAtPoint({ x, y }, size, viewport);
            const height = Math.min(size.height, place.maxHeight ?? size.height);
            expect(place.left).toBeGreaterThanOrEqual(MENU_MARGIN);
            expect(place.top).toBeGreaterThanOrEqual(MENU_MARGIN);
            // 比可用宽度还宽的菜单无法同时满足两侧，这里只验证它贴左。
            if (size.width <= viewport.width - MENU_MARGIN * 2) expect(place.left + size.width).toBeLessThanOrEqual(viewport.width - MENU_MARGIN);
            expect(place.top + height).toBeLessThanOrEqual(viewport.height - MENU_MARGIN);
          }
        }
      }
    }
  });
});

describe("菜单定位：按钮", () => {
  const button = { left: 800, right: 826, top: 100, bottom: 126 };

  it("与按钮右对齐，放在按钮下方 6px", () => {
    expect(placeMenuByButton(button, MENU, VIEWPORT)).toEqual({ left: 826 - 224, top: 132, origin: "top right" });
  });

  it("下方放不下就翻到按钮上方", () => {
    expect(placeMenuByButton({ left: 800, right: 826, top: 700, bottom: 726 }, MENU, VIEWPORT)).toEqual({ left: 602, top: 700 - 200 - 6, origin: "bottom right" });
  });

  it("按钮靠近左边：夹在 8px 边距上；比视口还高：限制高度", () => {
    expect(placeMenuByButton({ left: 10, right: 36, top: 100, bottom: 126 }, MENU, VIEWPORT).left).toBe(MENU_MARGIN);
    const tall = placeMenuByButton(button, { width: 224, height: 900 }, { width: 1000, height: 600 });
    expect(tall).toMatchObject({ top: MENU_MARGIN, maxHeight: 584 });
  });
});

// ───────────────────────── 组件 ─────────────────────────

const originalSize = { width: window.innerWidth, height: window.innerHeight };

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true, writable: true });
}

/** happy-dom 没有布局：让 .menu 有固定大小，其余元素的矩形由测试指定。 */
function mockLayout(menu: { width: number; height: number }, rects = new Map<Element, DOMRectInit>()) {
  const isMenu = (el: HTMLElement): boolean => el.classList.contains("menu");
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return isMenu(this) ? menu.width : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return isMenu(this) ? menu.height : 0;
  });
  return vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    // 入场动画的起点带着 scale(0.98)：包围盒比布局尺寸小 2%。弹层必须按布局尺寸摆位置，不能按包围盒。
    if (isMenu(this)) return DOMRect.fromRect({ x: 0, y: 0, width: menu.width * 0.98, height: menu.height * 0.98 });
    return DOMRect.fromRect(rects.get(this) ?? { x: 0, y: 0, width: 0, height: 0 });
  });
}

function key(target: Element, name: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

const menuEl = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="menu"]');
const itemEls = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
describe("MenuButton", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let spies: Record<"a" | "b" | "c", Mock<() => unknown>>;
  let items: MenuItem[];

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    spies = { a: vi.fn<() => unknown>(), b: vi.fn<() => unknown>(), c: vi.fn<() => unknown>() };
    items = [
      { id: "a", label: "甲", icon: "eye", onSelect: spies["a"]! },
      { id: "b", label: "乙", icon: "copy", separatorAbove: true, disabled: true, disabledReason: "乙现在不能用", onSelect: spies["b"]! },
      { id: "c", label: "丙", icon: "trash", danger: true, onSelect: spies["c"]! },
    ];
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    setViewport(originalSize.width, originalSize.height);
  });

  const render = (node: ReactNode): void => {
    act(() => root.render(node));
  };
  const button = (): HTMLButtonElement => host.querySelector("button")!;
  const open = (): void => {
    act(() => button().click());
  };
  const pointerDown = (target: EventTarget): void => {
    act(() => {
      target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    });
  };

  it("点击触发按钮打开：门户渲染的 role=menu，按钮声明展开，第一个可用项获得焦点", () => {
    const onOpenChange = vi.fn();
    render(<MenuButton items={items} label="会话操作" onOpenChange={onOpenChange} />);
    expect(menuEl()).toBeNull();
    expect(button().getAttribute("aria-haspopup")).toBe("menu");
    expect(button().getAttribute("aria-expanded")).toBe("false");

    open();
    const menu = menuEl()!;
    expect(menu.parentElement).toBe(document.body);
    expect(host.contains(menu)).toBe(false);
    expect(menu.getAttribute("aria-label")).toBe("会话操作");
    expect(button().getAttribute("aria-expanded")).toBe("true");
    expect(button().hasAttribute("data-open")).toBe(true);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    expect(document.activeElement).toBe(itemEls()[0]);
    expect(menu.hasAttribute("data-ready")).toBe(true);
  });

  it("项的语义：禁用项 aria-disabled 并在悬停提示里给原因，危险项有标记，分隔线是 separator", () => {
    render(<MenuButton items={items} label="操作" />);
    open();
    const [a, b, c] = itemEls();
    expect(a!.getAttribute("aria-disabled")).toBeNull();
    expect(b!.getAttribute("aria-disabled")).toBe("true");
    expect(b!.getAttribute("data-tip")).toBe("乙现在不能用");
    expect(a!.hasAttribute("data-tip")).toBe(false);
    expect(c!.hasAttribute("data-danger")).toBe(true);
    expect(menuEl()!.querySelectorAll('[role="separator"]')).toHaveLength(1);
    // 点禁用项：不触发，也不关闭。
    act(() => b!.click());
    expect(spies["b"]).not.toHaveBeenCalled();
    expect(menuEl()).not.toBeNull();
  });

  it("↑↓ Home End 在可用项里循环（跳过禁用项）", () => {
    render(<MenuButton items={items} label="操作" />);
    open();
    const [a, , c] = itemEls();
    expect(document.activeElement).toBe(a);
    key(document.activeElement!, "ArrowDown");
    expect(document.activeElement).toBe(c);
    key(document.activeElement!, "ArrowDown");
    expect(document.activeElement).toBe(a);
    key(document.activeElement!, "ArrowUp");
    expect(document.activeElement).toBe(c);
    key(document.activeElement!, "Home");
    expect(document.activeElement).toBe(a);
    key(document.activeElement!, "End");
    expect(document.activeElement).toBe(c);
  });

  it("Enter 与空格选择：先关闭并把焦点还给按钮，再执行动作；只执行一次", () => {
    const onOpenChange = vi.fn();
    render(<MenuButton items={items} label="操作" onOpenChange={onOpenChange} />);
    open();
    const order: string[] = [];
    spies["a"]!.mockImplementation(() => order.push(`select:${document.activeElement === button() ? "button" : "other"}`));
    key(document.activeElement!, "Enter");
    expect(order).toEqual(["select:button"]);
    expect(menuEl()).toBeNull();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);

    open();
    key(document.activeElement!, " ");
    expect(spies["a"]).toHaveBeenCalledTimes(2);
    open();
    act(() => itemEls()[2]!.click());
    expect(spies["c"]).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(button());
  });

  it("Esc 关闭并把焦点还给按钮，事件不再往外冒", () => {
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    try {
      render(<MenuButton items={items} label="操作" />);
      open();
      key(document.activeElement!, "Escape");
      expect(menuEl()).toBeNull();
      expect(document.activeElement).toBe(button());
      expect(outer).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", outer);
    }
  });

  it("点外部关闭（不抢焦点）；按钮自己的按下不算外部，再点一次是关闭", () => {
    render(<MenuButton items={items} label="操作" />);
    open();
    pointerDown(button());
    expect(menuEl()).not.toBeNull();
    act(() => button().click());
    expect(menuEl()).toBeNull();

    open();
    const outside = document.createElement("div");
    document.body.append(outside);
    pointerDown(outside);
    expect(menuEl()).toBeNull();
    expect(document.activeElement).not.toBe(button());
    // 点在菜单里面不关闭。
    open();
    pointerDown(itemEls()[0]!);
    expect(menuEl()).not.toBeNull();
  });

  it("Tab、resize、窗口失焦、外部滚动和滚轮都会关闭；菜单自己内部的滚动与滚轮不关闭", () => {
    render(<MenuButton items={items} label="操作" />);
    const closesBy = (trigger: () => void): boolean => {
      open();
      expect(menuEl()).not.toBeNull();
      act(trigger);
      const closed = menuEl() === null;
      if (!closed) act(() => button().click());
      return closed;
    };
    expect(closesBy(() => void document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })))).toBe(true);
    expect(closesBy(() => void window.dispatchEvent(new Event("resize")))).toBe(true);
    expect(closesBy(() => void window.dispatchEvent(new Event("blur")))).toBe(true);
    expect(closesBy(() => void document.dispatchEvent(new Event("scroll")))).toBe(true);
    expect(closesBy(() => void window.dispatchEvent(new Event("scroll")))).toBe(true);
    expect(closesBy(() => void document.body.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 40 })))).toBe(true);

    open();
    act(() => {
      menuEl()!.dispatchEvent(new Event("scroll"));
      itemEls()[0]!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 40 }));
    });
    expect(menuEl()).not.toBeNull();
  });

  it("在关闭的按钮上按 ↓ 打开菜单", () => {
    render(<MenuButton items={items} label="操作" />);
    const event = key(button(), "ArrowDown");
    expect(event.defaultPrevented).toBe(true);
    expect(menuEl()).not.toBeNull();
  });

  it("同一时刻只有一个菜单：打开另一个时，先把已打开的收起来", () => {
    const first = vi.fn();
    const second = vi.fn();
    render(
      <>
        <MenuButton items={items} label="第一个" onOpenChange={first} />
        <MenuButton items={items} label="第二个" onOpenChange={second} />
      </>,
    );
    const [one, two] = host.querySelectorAll("button");
    act(() => one!.click());
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    // 第二个按钮的按下在第一个菜单之外，本来就会关；直接点击（不经按下）验证“互斥”这条独立的保护。
    act(() => two!.click());
    expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
    expect(menuEl()!.getAttribute("aria-label")).toBe("第二个");
    expect(first).toHaveBeenLastCalledWith(false);
    expect(second).toHaveBeenLastCalledWith(true);
  });

  it("菜单上点右键不弹浏览器的原生菜单；菜单里的点击不会冒泡到卡片", () => {
    const outerClick = vi.fn();
    render(
      <div onClick={outerClick}>
        <MenuButton items={items} label="操作" />
      </div>,
    );
    open();
    outerClick.mockClear();
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
    act(() => {
      itemEls()[0]!.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    outerClick.mockClear();
    act(() => itemEls()[0]!.click());
    expect(outerClick).not.toHaveBeenCalled();
  });

  it("定位：与按钮右对齐、在按钮下方；下方放不下翻到上方；出现之前不可见", () => {
    setViewport(1000, 800);
    const rects = new Map<Element, DOMRectInit>();
    mockLayout(MENU, rects);
    render(<MenuButton items={items} label="操作" />);
    rects.set(button(), { x: 800, y: 100, width: 26, height: 26 });
    open();
    expect(menuEl()!.style.left).toBe("602px");
    expect(menuEl()!.style.top).toBe("132px");
    expect(menuEl()!.style.transformOrigin).toBe("top right");
    act(() => button().click());

    rects.set(button(), { x: 800, y: 700, width: 26, height: 26 });
    open();
    expect(menuEl()!.style.top).toBe(`${700 - 200 - 6}px`);
    expect(menuEl()!.style.transformOrigin).toBe("bottom right");
  });
});

describe("MenuPopup：指针位置、分组与紧凑行", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    setViewport(originalSize.width, originalSize.height);
  });

  const noop = (): void => undefined;
  const entries = (select: (id: string) => void = noop): MenuEntry[] => [
    { id: "scope", heading: "已选择 3 个节点" },
    {
      id: "align",
      items: [
        { id: "left", label: "左对齐", icon: "alignLeft", onSelect: () => select("left") },
        { id: "center", label: "水平居中", icon: "alignHCenter", onSelect: () => select("center") },
        { id: "right", label: "右对齐", icon: "alignRight", onSelect: () => select("right") },
      ],
    },
    {
      id: "history",
      items: [
        { id: "dist", label: "水平等距分布", icon: "distributeH", disabled: true, disabledReason: "水平等距分布（至少选 3 个）", onSelect: () => select("dist") },
        { id: "undo", label: "撤销（Ctrl+Z）", icon: "undo", separatorAbove: true, onSelect: () => select("undo") },
        { id: "redo", label: "重做（Ctrl+Shift+Z）", icon: "redo", onSelect: () => select("redo") },
      ],
    },
    { id: "clear", label: "取消选择（Esc）", icon: "close", separatorAbove: true, onSelect: () => select("clear") },
    { id: "sessions", heading: "其中 2 个会话" },
    { id: "copy", label: "复制会话 ID（2 个）", icon: "copy", onSelect: () => select("copy") },
    { id: "remove", label: "删除记录（1 个）", icon: "trash", danger: true, onSelect: () => select("remove") },
  ];

  const popup = (props: { entries: MenuEntry[]; anchor: MenuAnchor; onClose?: (restore: boolean) => void; label?: string }): void => {
    act(() => root.render(<MenuPopup entries={props.entries} label={props.label ?? "已选择 3 个节点"} anchor={props.anchor} onClose={props.onClose ?? noop} />));
  };

  it("指针锚点：左上角贴着指针；出现之后才可见；起始动画原点跟着翻转方向", () => {
    setViewport(1000, 800);
    mockLayout(MENU);
    popup({ entries: entries(), anchor: { kind: "point", x: 300, y: 200 } });
    const menu = menuEl()!;
    expect(menu.style.left).toBe("300px");
    expect(menu.style.top).toBe("200px");
    expect(menu.style.transformOrigin).toBe("top left");
    expect(menu.hasAttribute("data-ready")).toBe(true);
  });

  it("靠近右下角与左上角：翻转并保持 8px 边距；窄视口里也完整落在视口内", () => {
    setViewport(1000, 800);
    mockLayout({ width: 224, height: 360 });
    popup({ entries: entries(), anchor: { kind: "point", x: 990, y: 790 } });
    let menu = menuEl()!;
    expect(Number.parseFloat(menu.style.left) + 224).toBeLessThanOrEqual(992);
    expect(Number.parseFloat(menu.style.top) + 360).toBeLessThanOrEqual(792);
    expect(menu.style.transformOrigin).toBe("bottom right");

    // 位置只在弹层出现时算一次（宿主换位置就换一个新的弹层，见 NodeContextMenu 的 key）。
    act(() => root.unmount());
    root = createRoot(host);
    popup({ entries: entries(), anchor: { kind: "point", x: 1, y: 2 } });
    menu = menuEl()!;
    expect(menu.style.left).toBe("8px");
    expect(menu.style.top).toBe("8px");

    setViewport(320, 480);
    act(() => root.unmount());
    root = createRoot(host);
    popup({ entries: entries(), anchor: { kind: "point", x: 300, y: 470 } });
    menu = menuEl()!;
    expect(Number.parseFloat(menu.style.left)).toBeGreaterThanOrEqual(8);
    expect(Number.parseFloat(menu.style.left) + 224).toBeLessThanOrEqual(312);
    expect(Number.parseFloat(menu.style.top) + 360).toBeLessThanOrEqual(472);
  });

  it("按布局尺寸而不是动画起点的缩小包围盒摆位置：翻转之后右缘正好贴着指针，夹边之后正好留 8px", () => {
    setViewport(1000, 800);
    mockLayout({ width: 224, height: 360 });
    popup({ entries: entries(), anchor: { kind: "point", x: 900, y: 600 } });
    const flipped = menuEl()!;
    expect(Number.parseFloat(flipped.style.left) + 224).toBe(900);
    expect(Number.parseFloat(flipped.style.top) + 360).toBe(600);
    act(() => root.unmount());
    root = createRoot(host);
    popup({ entries: entries(), anchor: { kind: "point", x: 995, y: 100 } });
    // 指针贴着右缘：翻到左边之后右缘（995）超出 8px 边距，被夹回到距右缘正好 8px。
    expect(Number.parseFloat(menuEl()!.style.left) + 224).toBe(1000 - 8);
    act(() => root.unmount());
    root = createRoot(host);
    popup({ entries: entries(), anchor: { kind: "point", x: 5, y: 100 } });
    expect(menuEl()!.style.left).toBe("8px");
  });

  it("矮视口里菜单比视口还高：限制高度、顶住上边距，内部滚动", () => {
    setViewport(800, 300);
    mockLayout({ width: 224, height: 520 });
    popup({ entries: entries(), anchor: { kind: "point", x: 100, y: 150 } });
    const menu = menuEl()!;
    expect(menu.style.top).toBe("8px");
    expect(menu.style.maxHeight).toBe("284px");
    // 菜单自己滚动时不关闭。
    const onClose = vi.fn();
    popup({ entries: entries(), anchor: { kind: "point", x: 100, y: 150 }, onClose });
    act(() => {
      menuEl()!.dispatchEvent(new Event("scroll"));
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("分组标题：每组是一个以标题命名的 group，组与组之间有分隔线", () => {
    popup({ entries: entries(), anchor: { kind: "point", x: 10, y: 10 } });
    const groups = [...document.querySelectorAll<HTMLElement>('[role="group"]')];
    expect(groups).toHaveLength(2);
    const labelOf = (group: HTMLElement): string | undefined => document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent ?? undefined;
    expect(groups.map(labelOf)).toEqual(["已选择 3 个节点", "其中 2 个会话"]);
    expect(groups[0]!.querySelectorAll('[role="menuitem"]')).toHaveLength(3 + 3 + 1);
    expect(groups[1]!.querySelectorAll('[role="menuitem"]')).toHaveLength(2);
    // 两组之间一条横线（在组外）。
    expect(groups[1]!.previousElementSibling?.getAttribute("role")).toBe("separator");
    expect(menuEl()!.getAttribute("aria-label")).toBe("已选择 3 个节点");
  });

  it("紧凑行：每项只画图标，名字就是无障碍名与悬停提示；不可用时名字与提示都是原因；行内竖线只在非首项前", () => {
    popup({ entries: entries(), anchor: { kind: "point", x: 10, y: 10 } });
    const rows = [...document.querySelectorAll<HTMLElement>(".menu-row")];
    expect(rows).toHaveLength(2);
    const first = [...rows[0]!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(first.map((item) => item.getAttribute("aria-label"))).toEqual(["左对齐", "水平居中", "右对齐"]);
    expect(first.map((item) => item.getAttribute("data-tip"))).toEqual(["左对齐", "水平居中", "右对齐"]);
    expect(first[0]!.textContent).toBe("");
    expect(first[0]!.hasAttribute("data-compact")).toBe(true);
    expect(rows[0]!.querySelector('[role="separator"]')).toBeNull();

    const second = [...rows[1]!.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(second[0]!.getAttribute("aria-label")).toBe("水平等距分布（至少选 3 个）");
    expect(second[0]!.getAttribute("data-tip")).toBe("水平等距分布（至少选 3 个）");
    expect(second[0]!.getAttribute("aria-disabled")).toBe("true");
    expect(rows[1]!.querySelectorAll('[role="separator"][aria-orientation="vertical"]')).toHaveLength(1);
    expect(second[1]!.previousElementSibling?.getAttribute("role")).toBe("separator");
  });

  it("点击紧凑项：关闭（把焦点还给宿主）并执行；禁用项点了没反应", () => {
    const select = vi.fn();
    const onClose = vi.fn();
    popup({ entries: entries(select), anchor: { kind: "point", x: 10, y: 10 }, onClose });
    const byName = (name: string): HTMLElement => itemEls().find((item) => item.getAttribute("aria-label") === name)!;
    act(() => byName("水平等距分布（至少选 3 个）").click());
    expect(select).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    act(() => byName("水平居中").click());
    expect(onClose).toHaveBeenCalledWith(true);
    expect(select).toHaveBeenCalledWith("center");
  });

  it("键盘：↓↑ 在行与行、行与普通项之间走（一行算一站），←→ 在行内走，Home End 到首尾", () => {
    popup({ entries: entries(), anchor: { kind: "point", x: 10, y: 10 } });
    const label = (): string | null => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? null;
    // 第一个可用项：第一行的第一个。
    expect(label()).toBe("左对齐");
    key(document.activeElement!, "ArrowRight");
    expect(label()).toBe("水平居中");
    key(document.activeElement!, "ArrowRight");
    key(document.activeElement!, "ArrowRight");
    expect(label()).toBe("左对齐");
    key(document.activeElement!, "ArrowLeft");
    expect(label()).toBe("右对齐");
    // 下一站是第二行（禁用的分布被跳过，落在同一列或该行的最后一个可用项）。
    key(document.activeElement!, "ArrowDown");
    expect(["撤销（Ctrl+Z）", "重做（Ctrl+Shift+Z）"]).toContain(label());
    key(document.activeElement!, "ArrowDown");
    expect(label()).toBe("取消选择（Esc）");
    key(document.activeElement!, "ArrowDown");
    expect(label()).toBe("复制会话 ID（2 个）");
    key(document.activeElement!, "ArrowDown");
    expect(label()).toBe("删除记录（1 个）");
    key(document.activeElement!, "ArrowDown");
    expect(label()).toBe("左对齐");
    key(document.activeElement!, "ArrowUp");
    expect(label()).toBe("删除记录（1 个）");
    key(document.activeElement!, "Home");
    expect(label()).toBe("左对齐");
    key(document.activeElement!, "End");
    expect(label()).toBe("删除记录（1 个）");
    // 普通项上 ←→ 什么也不做。
    key(document.activeElement!, "ArrowLeft");
    expect(label()).toBe("删除记录（1 个）");
  });

  it("Esc 与选择走 onClose(true)，点外部、Tab、滚轮走 onClose(false)", () => {
    const onClose = vi.fn();
    popup({ entries: entries(), anchor: { kind: "point", x: 10, y: 10 }, onClose });
    key(document.activeElement!, "Escape");
    expect(onClose).toHaveBeenLastCalledWith(true);
    act(() => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(onClose).toHaveBeenLastCalledWith(false);
    onClose.mockClear();
    act(() => {
      document.body.dispatchEvent(new WheelEvent("wheel", { bubbles: true, ctrlKey: true, deltaY: -30 }));
    });
    expect(onClose).toHaveBeenCalledWith(false);
    key(document.activeElement!, "Tab");
    expect(onClose).toHaveBeenLastCalledWith(false);
  });

  it("宿主每次渲染换新的回调和锚点，不会让监听重绑、也不会重新抢焦点", () => {
    const first = vi.fn();
    popup({ entries: entries(), anchor: { kind: "point", x: 10, y: 10 }, onClose: first });
    key(document.activeElement!, "ArrowDown");
    const focused = document.activeElement;
    const second = vi.fn();
    popup({ entries: entries(), anchor: { kind: "point", x: 10, y: 10 }, onClose: second });
    expect(document.activeElement).toBe(focused);
    act(() => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(false);
  });

  it("再打开一个弹层时，先收起已经打开的那个", () => {
    const closed = vi.fn();
    popup({ entries: entries(), anchor: { kind: "point", x: 10, y: 10 }, onClose: closed });
    const other = document.createElement("div");
    document.body.append(other);
    const otherRoot = createRoot(other);
    act(() => otherRoot.render(<MenuPopup entries={entries()} label="另一个" anchor={{ kind: "point", x: 50, y: 50 }} onClose={noop} />));
    expect(closed).toHaveBeenCalledWith(false);
    act(() => otherRoot.unmount());
  });
});
