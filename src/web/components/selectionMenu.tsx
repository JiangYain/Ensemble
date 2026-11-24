import type { SessionId, SessionSummary } from "@shared/types";
import { askConfirm, store, toast } from "../lib/app";
import { archiveInFlight, blockedText, confirmArchive } from "../lib/archive";
import { pickSelected } from "../lib/archivePlan";
import { cancelRuns, removeSessions, reportBatch, stopSessions } from "../lib/batch";
import type { TFunction } from "../lib/i18n";
import { isActivePhase } from "../lib/text";
import type { SceneEngine } from "../scene/engine";
import { ALIGN, DISTRIBUTE, DISTRIBUTE_MIN, shortcutModifier } from "./arrangeDefs";
import type { MenuEntry, MenuItem } from "./Menu";
import { canRemoveSession, canStopSession, hasRunToCancel } from "./sessionActions";
import { copyText } from "./ui";

/** 菜单用到的那部分引擎：与底部对齐条调用的是同一组方法。 */
export type ArrangeEngine = Pick<SceneEngine, "align" | "distribute" | "undo" | "redo" | "clearSelection">;

export interface SelectionMenuInput {
  engine: ArrangeEngine;
  /** 选中的节点总数（包括来源、Git 等非会话节点）。 */
  count: number;
  /** 选中集合里的会话；没有会话时菜单里就没有“会话”这一组。 */
  sessions: readonly SessionSummary[];
  canUndo: boolean;
  canRedo: boolean;
  t: TFunction;
  /** 排列动作的结果，交给读屏软件播报（与对齐条同一套文案）。 */
  announce: (text: string) => void;
  /** 服务懂归档（老服务没有归档接口，就不给“归档所选”）。缺省＝不懂。 */
  archiveSupported?: boolean;
}

/**
 * 执行前重新读一遍会话的最新状态：确认对话框开着的时候，会话可能已经变了。
 * 对象是 `plan`——菜单建好、确认框打开那一刻定下的名单（数量写在项名与确认框里），只在它里面剔除；
 * 名单之外的会话哪怕此刻变得符合条件也不加进来，否则确认框承诺的是 N 个，实际动的是 N+1 个。
 */
function stillEligible(plan: readonly SessionSummary[], test: (summary: SessionSummary) => boolean): SessionId[] {
  const sessions = store.get().sessions;
  return plan.flatMap(({ id }) => {
    const current = sessions[id];
    return current !== undefined && test(current) ? [id] : [];
  });
}

/**
 * 多选菜单，对象是整个选中集合。三组，范围写在每组的标题上：
 * 1. 「已选择 N 个节点」：对齐（六种）、分布（两种）与撤销、重做排成两行紧凑的图标；取消选择单独一项。
 *    名字、图标、不可用的原因与对齐条完全一致（共用 `arrange.*` 与 arrangeDefs）。
 * 2. 「其中 M 个会话」（选中里有会话才出现）：复制 ID、中断当前运行、关闭会话、删除记录。
 *    对每个会话调用的是单个会话菜单同一个服务端动作；只对可用的那几个执行，数量写在项名里；不可用时写明原因。
 *    “可用的那几个”在菜单建好时定下，之后（比如确认框开着的时候）只会缩小，不会再把别的会话加进来。
 */
export function selectionMenuEntries({ engine, count, sessions, canUndo, canRedo, t, announce, archiveSupported = false }: SelectionMenuInput): MenuEntry[] {
  const mod = shortcutModifier();
  const arrange = (label: string, action: () => boolean) => (): void => {
    announce(action() ? t("arrange.done", { action: label, n: count }) : t("arrange.unchanged", { action: label }));
  };

  const align: MenuItem[] = ALIGN.map(({ mode, icon, label }, index) => ({
    id: `align-${mode}`,
    label: t(label),
    icon,
    // 横向三种与纵向三种之间一道竖线。
    separatorAbove: index === 3,
    onSelect: arrange(t(label), () => engine.align(mode)),
  }));

  const enoughToDistribute = count >= DISTRIBUTE_MIN;
  const distribute: MenuItem[] = DISTRIBUTE.map(({ axis, icon, label }) => ({
    id: `distribute-${axis}`,
    label: t(label),
    icon,
    disabled: !enoughToDistribute,
    disabledReason: t("arrange.needThree", { label: t(label) }),
    onSelect: arrange(t(label), () => engine.distribute(axis)),
  }));

  const undoLabel = t("arrange.undo", { keys: `${mod}Z` });
  const redoLabel = t("arrange.redo", { keys: `${mod}Shift+Z` });
  const history: MenuItem[] = [
    {
      id: "undo",
      label: undoLabel,
      icon: "undo",
      separatorAbove: true,
      disabled: !canUndo,
      disabledReason: t("ctx.undoNone", { label: undoLabel }),
      onSelect: () => {
        engine.undo();
      },
    },
    {
      id: "redo",
      label: redoLabel,
      icon: "redo",
      disabled: !canRedo,
      disabledReason: t("ctx.redoNone", { label: redoLabel }),
      onSelect: () => {
        engine.redo();
      },
    },
  ];

  const entries: MenuEntry[] = [
    { id: "scope", heading: t("scene.selected", { n: count }) },
    { id: "align", items: align },
    { id: "distribute", items: [...distribute, ...history] },
    { id: "clear", label: t("arrange.clear"), icon: "close", separatorAbove: true, onSelect: () => engine.clearSelection() },
  ];

  if (sessions.length === 0) return entries;

  const ids = sessions.map((summary) => summary.id);
  const cancellable = sessions.filter(hasRunToCancel);
  const stoppable = sessions.filter(canStopSession);
  const removable = sessions.filter(canRemoveSession);

  // 归档所选：每个选中的会话按子树归档（连同下级），整棵都已结束的才算数；写明实际会归档几个。
  // 名单在菜单建好时定下，确认之后的裁决在服务端——那一刻又有会话开始工作的，回执里会如实说“仍在工作，已保留”。
  const archivePick = archiveSupported ? pickSelected(sessions, Object.values(store.get().sessions)) : undefined;
  const archiveItems: MenuItem[] = archivePick
    ? [
        {
          id: "archive",
          label: t("ctx.archiveSelected", { n: archivePick.changed.length }),
          icon: "archive",
          disabled: archivePick.changed.length === 0 || archiveInFlight(),
          disabledReason:
            archivePick.changed.length === 0
              ? archivePick.blocked
                ? blockedText(archivePick.blocked, t)
                : t("archive.nothing")
              : t("archive.busy"),
          onSelect: () => confirmArchive(archivePick),
        },
      ]
    : [];

  entries.push(
    { id: "sessions", heading: t("ctx.sessions", { n: sessions.length }) },
    {
      id: "copy-ids",
      label: t("ctx.copyIds", { n: ids.length }),
      icon: "copy",
      onSelect: () => {
        void copyText(ids.join("\n")).then((ok) => toast(ok ? "success" : "warn", ok ? t("common.copied") : t("common.copyFailed"), 1800));
      },
    },
    {
      id: "cancel",
      label: t("ctx.cancelRuns", { n: cancellable.length }),
      icon: "stop",
      disabled: cancellable.length === 0,
      disabledReason: t("ctx.cancelNone"),
      onSelect: () => {
        const targets = stillEligible(cancellable, hasRunToCancel);
        if (targets.length === 0) return;
        void cancelRuns(targets).then((outcome) => reportBatch(t("menu.cancelRun"), outcome, t));
      },
    },
    {
      id: "stop",
      label: t("ctx.stopSessions", { n: stoppable.length }),
      icon: "pause",
      disabled: stoppable.length === 0,
      disabledReason: t("ctx.stopNone"),
      onSelect: () =>
        askConfirm({
          title: t("batch.stopTitle", { n: stoppable.length }),
          body: t("batch.stopBody", { active: stoppable.filter((summary) => isActivePhase(summary.phase)).length, skipped: sessions.length - stoppable.length }),
          confirmLabel: t("batch.stopConfirm", { n: stoppable.length }),
          onConfirm: async () => {
            const targets = stillEligible(stoppable, canStopSession);
            if (targets.length === 0) return;
            reportBatch(t("menu.stopSession"), await stopSessions(targets), t);
          },
        }),
    },
    ...archiveItems,
    {
      id: "remove",
      label: t("ctx.removeRecords", { n: removable.length }),
      icon: "trash",
      danger: true,
      disabled: removable.length === 0,
      disabledReason: t("ctx.removeNone"),
      onSelect: () =>
        askConfirm({
          title: t("batch.removeTitle", { n: removable.length }),
          body: t("batch.removeBody", { skipped: sessions.length - removable.length }),
          confirmLabel: t("batch.removeConfirm", { n: removable.length }),
          tone: "danger",
          onConfirm: async () => {
            const targets = stillEligible(removable, canRemoveSession);
            if (targets.length === 0) return;
            reportBatch(t("menu.remove"), await removeSessions(targets), t);
          },
        }),
    },
  );
  return entries;
}
