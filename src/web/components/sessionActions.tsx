import type { SessionSummary } from "@shared/types";
import { askConfirm, cancelRun, navigate, removeSession, stopSession, store, toast } from "../lib/app";
import { archiveSessions, archiveUi, blockedText, exportReport, unarchiveSessions } from "../lib/archive";
import { descendantsOf, planSubtree } from "../lib/archivePlan";
import { summaryById } from "../lib/archiveState";
import type { TFunction } from "../lib/i18n";
import { isActivePhase } from "../lib/text";
import { panelHref } from "../lib/view";
import { copyText } from "./ui";
import type { MenuItem } from "./Menu";

export interface SessionMenuOptions {
  /** 聚焦页里“打开”没有意义；节点上需要。 */
  includeOpen?: boolean;
  /** 删除成功后（聚焦页需要退回总览）。 */
  afterRemove?: () => void;
}

/** 有没有一次进行中或排队中的运行：能不能“中断当前运行”。多选菜单的批量动作用同一个判断。 */
export function hasRunToCancel(summary: SessionSummary): boolean {
  return summary.activeRunId !== undefined || summary.status === "queued" || summary.status === "starting";
}

/** 会话还没有关闭：能不能“关闭会话”。 */
export function canStopSession(summary: SessionSummary): boolean {
  return summary.status !== "stopped";
}

/** 运行中的会话不能删：能不能“删除记录”。 */
export function canRemoveSession(summary: SessionSummary): boolean {
  return !isActivePhase(summary.phase);
}

/**
 * 画布上会话节点的菜单：头部“···”与右键共用这一份——同一个调用，菜单内容永远一致。
 * 比聚焦页多一项“打开会话”。
 */
export function nodeMenuItems(summary: SessionSummary, t: TFunction): MenuItem[] {
  return sessionMenuItems(summary, t, { includeOpen: true });
}

/**
 * 导出 Markdown：一次点击直接下载（见 lib/archive.exportReport）。
 * 单个会话是默认项（摘要）；有下级时另有一项带上整棵任务树；“含工具输出”是单独的、非默认的一项——文件会大得多，不做成一键的默认。
 * 下级个数数的是现在能看到的摘要，有找不到的（例如已归档、还没加载）就不写数字，免得写出一个偏小的“确切值”。
 * “已归档”视图每一行的导出菜单也用这一份，所以会话菜单与归档列表里的导出入口永远一致。
 */
export function exportMenuItems(summary: SessionSummary, t: TFunction): MenuItem[] {
  const { count, complete } = descendantsOf(summary, (id) => summaryById(store.get(), id));
  const items: MenuItem[] = [
    { id: "export-md", label: t("menu.exportMd"), icon: "download", onSelect: () => void exportReport(summary.id, { scope: "session", detail: "brief" }) },
  ];
  if (summary.childIds.length > 0) {
    items.push({
      id: "export-md-tree",
      label: complete ? t("menu.exportMdTree", { n: count }) : t("menu.exportMdTreeAny"),
      icon: "download",
      onSelect: () => void exportReport(summary.id, { scope: "tree", detail: "brief" }),
    });
  }
  items.push({ id: "export-md-full", label: t("menu.exportMdFull"), icon: "download", onSelect: () => void exportReport(summary.id, { scope: "session", detail: "full" }) });
  return items;
}

/**
 * 归档 / 取消归档。归档按子树：连同它的所有下级一起走，所以标签里写明下级个数（现在未归档的那些）；
 * 子树里有会话还没结束就禁用并写明真实原因（在工作 / 待命 / 消息未确认，数字来自摘要）。网页只做预判，真正的裁决在服务端。
 * 已归档的会话（聚焦页里）给“取消归档”。上一个归档动作在途时禁用，免得连点。
 */
function archiveMenuItem(summary: SessionSummary, t: TFunction): MenuItem {
  const busy = archiveUi.get().busy > 0;
  if (summary.archivedAt !== undefined) {
    return {
      id: "unarchive",
      label: t("menu.unarchive"),
      icon: "unarchive",
      disabled: busy,
      disabledReason: t("archive.busy"),
      onSelect: () => void unarchiveSessions([summary.id]),
    };
  }
  const plan = planSubtree(Object.values(store.get().sessions), summary.id) ?? planSubtree([summary], summary.id);
  const blocked = plan?.blocked;
  return {
    id: "archive",
    label: plan && plan.descendants > 0 ? t("menu.archiveTree", { n: plan.descendants }) : t("menu.archive"),
    icon: "archive",
    disabled: busy || blocked !== undefined,
    disabledReason: blocked ? blockedText(blocked, t) : t("archive.busy"),
    onSelect: () => void archiveSessions([summary.id]),
  };
}

/** 节点菜单与聚焦页共用的会话级操作。所有操作都对应真实的服务端动作，不可用时写明原因。 */
export function sessionMenuItems(summary: SessionSummary, t: TFunction, options: SessionMenuOptions = {}): MenuItem[] {
  const active = isActivePhase(summary.phase);
  const hasRun = hasRunToCancel(summary);
  const items: MenuItem[] = [];
  // 归档与导出只在服务懂归档时出现：老服务没有这些接口，不给一个点了必然失败的菜单项。
  const archiveAware = store.get().archivedCount !== undefined;

  if (options.includeOpen) {
    items.push({ id: "open", label: t("menu.open"), icon: "eye", onSelect: () => navigate({ kind: "session", id: summary.id }) });
  }

  items.push(
    {
      id: "copy-link",
      label: t("menu.copyLink"),
      icon: "link",
      onSelect: () => {
        void copyText(panelHref(summary.id)).then((ok) => toast(ok ? "success" : "warn", ok ? t("common.copied") : t("common.copyFailed"), 1800));
      },
    },
    {
      id: "copy-id",
      label: t("menu.copyId"),
      icon: "copy",
      onSelect: () => {
        void copyText(summary.id).then((ok) => toast(ok ? "success" : "warn", ok ? t("common.copied") : t("common.copyFailed"), 1800));
      },
    },
  );

  if (archiveAware) items.push(...exportMenuItems(summary, t).map((item, index) => (index === 0 ? { ...item, separatorAbove: true } : item)));

  items.push({
    id: "cancel",
    label: t("menu.cancelRun"),
    icon: "stop",
    separatorAbove: true,
    disabled: !hasRun,
    disabledReason: t("menu.cancelRunDisabled"),
    onSelect: () => void cancelRun(summary.id, { ok: t("toast.cancelOk"), nothing: t("toast.cancelNothing"), failed: t("toast.cancelFailed") }),
  });

  items.push({
    id: "stop",
    label: t("menu.stopSession"),
    icon: "pause",
    disabled: !canStopSession(summary),
    disabledReason: t("menu.stopDisabled"),
    onSelect: () =>
      askConfirm({
        title: t("confirm.stopTitle"),
        body: active ? t("confirm.stopBodyActive") : t("confirm.stopBody"),
        confirmLabel: t("menu.stopSession"),
        onConfirm: () => stopSession(summary.id, { ok: t("toast.stopOk"), failed: t("toast.stopFailed") }),
      }),
  });

  // 归档紧挨在“删除记录”上面：它是同一类“从视野里拿走”的事，但不删任何东西。
  if (archiveAware) items.push(archiveMenuItem(summary, t));

  items.push({
    id: "remove",
    label: t("menu.remove"),
    icon: "trash",
    danger: true,
    disabled: !canRemoveSession(summary),
    disabledReason: t("menu.removeDisabled"),
    onSelect: () =>
      askConfirm({
        title: t("confirm.removeTitle"),
        body: t("confirm.removeBody", { title: summary.title }),
        confirmLabel: t("menu.remove"),
        tone: "danger",
        onConfirm: async () => {
          const ok = await removeSession(summary.id, { ok: t("toast.removeOk"), failed: t("toast.removeFailed") });
          if (ok) options.afterRemove?.();
        },
      }),
  });

  return items;
}
