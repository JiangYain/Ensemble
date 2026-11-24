import type { KeyboardEvent } from "react";

type Axis = "vertical" | "horizontal" | "both";
type To = "prev" | "next" | "first" | "last";

/** 每个键朝哪个方向、属于哪根轴；Home / End 不分轴。 */
const KEYS: Record<string, { axis: Axis; to: To }> = {
  ArrowUp: { axis: "vertical", to: "prev" },
  ArrowDown: { axis: "vertical", to: "next" },
  ArrowLeft: { axis: "horizontal", to: "prev" },
  ArrowRight: { axis: "horizontal", to: "next" },
  Home: { axis: "both", to: "first" },
  End: { axis: "both", to: "last" },
};

function destination(to: To, index: number, count: number, wrap: boolean): number {
  const last = count - 1;
  if (to === "first") return 0;
  if (to === "last") return last;
  if (to === "next") return index < last ? index + 1 : wrap ? 0 : last;
  return index > 0 ? index - 1 : wrap ? last : 0;
}

/**
 * 方向键在一组同类控件之间移动焦点（Home / End 到两端）。处理了就把焦点交给目标、拦下这次按键，并返回目标；
 * 没处理（带修饰键、方向不属于这一组、焦点不在这一组里）返回 undefined，按键照常往下走。
 * 设置窗口里的三处共用它：分区导航与语言单选（上下左右都认：同一条导航在窄屏会横过来排）、执行端卡片头与模型勾选行
 * （只认上下，左右留给文字与滚动）。导航与单选的选中跟着焦点走，由调用方在拿到返回值后点一下目标。
 */
export function moveFocus(event: KeyboardEvent, items: readonly HTMLElement[], options: { axis: Axis; wrap?: boolean }): HTMLElement | undefined {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return undefined;
  const key = Object.hasOwn(KEYS, event.key) ? KEYS[event.key] : undefined;
  if (!key || (key.axis !== "both" && options.axis !== "both" && key.axis !== options.axis)) return undefined;
  const target = event.target as Node;
  const index = items.findIndex((item) => item === target || item.contains(target));
  if (index < 0) return undefined;
  event.preventDefault();
  const element = items[destination(key.to, index, items.length, options.wrap ?? false)];
  element?.focus();
  return element;
}
