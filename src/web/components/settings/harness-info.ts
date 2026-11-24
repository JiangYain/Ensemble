import type { HarnessInfo } from "@shared/types";
import type { TFunction } from "../../lib/i18n";

/**
 * 状态词的色调。“可用”不是 teal：这套配色里 --teal（强调色）与 --red（告警色）是同一个朱砂色相，“可用”若也是朱砂色，
 * 就和“不可用”只差一个字。所以可用与检测中都是中性色，各状态由标记的形状区分（sidebar.css 的 .status-pip：可用是实心方块，需要设置 / 不可用是空心方块，
 * 检测中是框里带一道推移带子的方块）。
 */
export function statusTone(status: HarnessInfo["status"]): "amber" | "red" | "neutral" {
  return status === "needs_setup" ? "amber" : status === "unavailable" ? "red" : "neutral";
}

/** 执行端的设置提示（缺什么、怎么办），显示在设置窗口的执行端卡片上。 */
export function setupText(info: HarnessInfo, t: TFunction): string | undefined {
  const setup = info.setup;
  if (!setup) return undefined;
  const key = `setup.${setup.code}`;
  const headline = t(key);
  if (headline === key) return setup.message;
  // 探测失败类的消息里带着具体原因，只显示通用标题会把它丢掉。
  return /probe_failed$/.test(setup.code) && setup.message ? t("setup.withReason", { headline, reason: setup.message }) : headline;
}
