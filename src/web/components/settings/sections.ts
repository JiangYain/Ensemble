import type { ComponentType } from "react";
import type { AppState } from "../../lib/app";
import type { TFunction } from "../../lib/i18n";
import type { IconName } from "../Icons";
import { ExecutorsActions, ExecutorsSection, executorsSummary } from "./ExecutorsSection";
import { GeneralSection, generalSummary } from "./GeneralSection";
import { HistorySection, historySummary } from "./HistorySection";
import { ProfilesSection, profilesSummary } from "./ProfilesSection";

/**
 * 设置窗口的分区登记表：导航与内容都从这里渲染，窗口里没有任何“if (section === …)”。加一项设置 = 在 SECTIONS 里登记一个条目 + 写一个组件：
 *   1. 在 `settings/` 里写分区组件（读写 store 或调接口，改动即时生效；不要自带“保存”按钮，与模型勾选、语言切换同一种手感）；
 *   2. 在下面的 SECTIONS 里登记 `{ id, labelKey, icon, Component }`（需要时加 `summary`、`actions`）；
 *   3. 两份字典里各加 `labelKey` 对应的文案（`i18n.test.ts` 会查中英文都有）。
 * `SettingsSectionId` 由登记表推出，所以 `openSettings("…")` 深链的 id 拼错会过不了类型检查；sections.test.ts 钉住登记表的不变量。
 * 可以进来的真实例子（现在都不在界面上）：“值得留意”的阈值（现为 LIMITS.attention 里的固定值）、委派的默认值。
 *
 * 顺序就是导航顺序；不带分区地打开设置时落在第一项（上次看过的除外）。
 */
export interface SettingsSection {
  /** 稳定的标识：深链（openSettings）与内存里记住的“上次看的那一项”都用它。 */
  id: string;
  /** 字典键：导航项与分区标题行都用它。 */
  labelKey: string;
  icon: IconName;
  /** 导航项名字下面的小字，必须来自真实数据（例如“3/4 可用”）；没有就返回 undefined，不占位。 */
  summary?: (state: AppState, t: TFunction) => string | undefined;
  Component: ComponentType;
  /** 分区标题行右侧的操作槽（例如“执行端”的重新探测），属于这个分区，切走就不在。 */
  actions?: ComponentType;
}

export const SECTIONS = [
  { id: "executors", labelKey: "settings.section.executors", icon: "layers", summary: executorsSummary, Component: ExecutorsSection, actions: ExecutorsActions },
  { id: "profiles", labelKey: "settings.section.profiles", icon: "bot", summary: profilesSummary, Component: ProfilesSection },
  { id: "general", labelKey: "settings.section.general", icon: "globe", summary: generalSummary, Component: GeneralSection },
  { id: "history", labelKey: "settings.section.history", icon: "clock", summary: historySummary, Component: HistorySection },
] as const satisfies readonly SettingsSection[];

export type SettingsSectionId = (typeof SECTIONS)[number]["id"];

/** 登记表的宽类型视图：窗口按它遍历，不必认识具体分区；条目的 id 仍是 SettingsSectionId，切换分区时不用再转型。 */
export type RegisteredSection = SettingsSection & { id: SettingsSectionId };
export const SECTION_LIST: readonly RegisteredSection[] = SECTIONS;
