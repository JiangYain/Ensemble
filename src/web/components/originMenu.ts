import type { SessionSummary } from "@shared/types";
import { expandAllOrigins, setOriginCollapsed } from "../lib/app";
import { archiveInFlight, blockedText, confirmArchive } from "../lib/archive";
import { pickArchivable } from "../lib/archivePlan";
import type { TFunction } from "../lib/i18n";
import { sessionsPerOrigin } from "../lib/originCollapse";
import { sessionsInScope } from "../lib/workspaces";
import { originNodeId } from "../scene/layout";
import type { MenuEntry } from "./Menu";

/** `originNodeId` 的逆运算：不是来源节点（会话、Git、Folder……）返回 undefined。 */
export function originKeyOfNode(nodeId: string): string | undefined {
  const prefix = originNodeId("");
  return nodeId.startsWith(prefix) ? nodeId.slice(prefix.length) : undefined;
}

export interface OriginMenuInput {
  /** 菜单所指的来源（Main Agent）的 key。 */
  key: string;
  /** 全部会话：数这个来源名下有几个会话、还有几个别的来源也被隐藏着。 */
  sessions: readonly SessionSummary[];
  /** 被隐藏了相关节点的来源。 */
  collapsed: ReadonlySet<string>;
  t: TFunction;
  /** 动作的结果，交给读屏软件播报（卡片上的变化是视觉的，菜单关上之后读屏用户没有别的线索）。 */
  announce: (text: string) => void;
  /** 服务懂归档（老服务没有归档接口，就不给“归档整个空间”）。缺省＝不懂。 */
  archiveSupported?: boolean;
}

/**
 * Main Agent（来源卡）的右键菜单，也是键盘上 ContextMenu 键 / Shift+F10 的菜单。
 * 一件事：隐藏 / 显示它的相关节点——它名下的会话（含嵌套的），以及只为它服务的 Folder、Git 卡；来源卡自己留在画布上。
 * 已经隐藏时同一项变成“显示”。别的 Main Agent 也被隐藏着时，多一项“全部显示”，不必一张一张地开。
 * 服务懂归档时多一项“归档整个 Main Agent 空间”：只归档其中已结束的任务树（整棵都结束了的），还在工作的整棵保留，
 * 项名里写实际会归档几个、确认框里写清留下几个；它只改会话的“已归档”标记，来源卡的隐藏偏好与它无关。
 * 来源已经没有会话（来源不存在了）时返回 undefined：没有什么可隐藏的，不凭空开一个菜单。
 */
export function originMenuEntries({ key, sessions, collapsed, t, announce, archiveSupported = false }: OriginMenuInput): MenuEntry[] | undefined {
  const counts = sessionsPerOrigin(sessions);
  const n = counts.get(key);
  if (n === undefined) return undefined;

  const hidden = collapsed.has(key);
  const entries: MenuEntry[] = [
    {
      id: "toggle",
      label: t(hidden ? "origin.menuShow" : "origin.menuHide", { n }),
      icon: hidden ? "eye" : "eyeOff",
      onSelect: () => {
        setOriginCollapsed(key, !hidden);
        announce(t(hidden ? "origin.doneShow" : "origin.doneHide", { n }));
      },
    },
  ];

  // 还存在的、被隐藏着的来源数（含它自己）；只有“除它以外还有”时才值得多一项。
  const allHidden = [...collapsed].filter((other) => counts.has(other));
  if (allHidden.some((other) => other !== key)) {
    entries.push({
      id: "show-all",
      label: t("origin.menuShowAll", { n: allHidden.length }),
      icon: "eye",
      separatorAbove: true,
      onSelect: () => {
        expandAllOrigins();
        announce(t("origin.doneShowAll", { n: allHidden.length }));
      },
    });
  }

  if (archiveSupported) {
    // 范围与画布上的这张来源卡一致：它名下整棵会话树（含嵌套的）；子树要在全部会话里找。
    const pick = pickArchivable(sessionsInScope(sessions, { kind: "origin", key }), sessions);
    const none = pick.changed.length === 0;
    // 在途的归档还没回来时入口禁用（原因写明）；没有可归档的会话时，真正的原因是那些会话为什么不能归档，优先说它。
    const busy = archiveInFlight();
    entries.push({
      id: "archive-space",
      label: none ? t("origin.menuArchiveNone") : t(pick.kept > 0 ? "origin.menuArchivePart" : "origin.menuArchive", { n: pick.changed.length }),
      icon: "archive",
      separatorAbove: true,
      disabled: none || busy,
      disabledReason: none ? (pick.blocked ? blockedText(pick.blocked, t) : t("archive.nothing")) : t("archive.busy"),
      onSelect: () => confirmArchive(pick),
    });
  }
  return entries;
}
