import type { AlignMode, DistributeAxis } from "../scene/arrange";
import type { IconName } from "./Icons";

/**
 * 对齐、分布的定义：图标与文案键。底部的对齐条和多选右键菜单共用这一份，两处的名字、图标、顺序永远一致。
 * 键名写成完整字面量，缺文案时词典测试能直接指出来。
 */
export const ALIGN: readonly { mode: AlignMode; icon: IconName; label: string }[] = [
  { mode: "left", icon: "alignLeft", label: "arrange.left" },
  { mode: "hcenter", icon: "alignHCenter", label: "arrange.hcenter" },
  { mode: "right", icon: "alignRight", label: "arrange.right" },
  { mode: "top", icon: "alignTop", label: "arrange.top" },
  { mode: "vmiddle", icon: "alignVMiddle", label: "arrange.vmiddle" },
  { mode: "bottom", icon: "alignBottom", label: "arrange.bottom" },
];

export const DISTRIBUTE: readonly { axis: DistributeAxis; icon: IconName; label: string }[] = [
  { axis: "horizontal", icon: "distributeH", label: "arrange.distributeH" },
  { axis: "vertical", icon: "distributeV", label: "arrange.distributeV" },
];

/** 分布至少需要的节点数；不足时按钮不可用，并说明原因。 */
export const DISTRIBUTE_MIN = 3;

/** 快捷键的写法跟着平台走；引擎侧 Ctrl 与 ⌘ 都认。 */
export function shortcutModifier(): string {
  return typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform) ? "⌘" : "Ctrl+";
}
