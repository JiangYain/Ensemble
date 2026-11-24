import { useState, useSyncExternalStore, type ReactNode } from "react";
import { useT } from "../lib/useT";
import type { SceneEngine } from "../scene/engine";
import { ALIGN, DISTRIBUTE, DISTRIBUTE_MIN, shortcutModifier } from "./arrangeDefs";
import { IconButton } from "./ui";

/**
 * 选中两个及以上节点时，浮在 Dock 上方的对齐条：对齐、等距分布、撤销与重做。
 * 外观与 Dock 同源但更矮更轻；平时不占位，选中数不够时整条不出现。
 * 不可用的按钮不用 disabled：保持可聚焦、可悬停，提示里才能说明为什么不能用。
 */
export function ArrangeBar({ engine }: { engine: SceneEngine }): ReactNode {
  const t = useT();
  const { selected, canUndo, canRedo } = useSyncExternalStore(engine.subscribe, engine.getState);
  const [announcement, setAnnouncement] = useState("");
  if (selected < 2) return null;

  const mod = shortcutModifier();
  const apply = (label: string, action: () => boolean) => (): void => {
    setAnnouncement(action() ? t("arrange.done", { action: label, n: selected }) : t("arrange.unchanged", { action: label }));
  };
  const enoughToDistribute = selected >= DISTRIBUTE_MIN;

  return (
    <div className="arrange" role="toolbar" aria-label={t("arrange.label")}>
      <span className="arrange-count">
        <b className="num">{selected}</b> {t("arrange.count")}
      </span>
      <span className="dock-divider arrange-lead" aria-hidden="true" />
      <div className="arrange-group">
        {ALIGN.map(({ mode, icon, label }) => (
          <IconButton key={mode} icon={icon} label={t(label)} onClick={apply(t(label), () => engine.align(mode))} />
        ))}
      </div>
      <span className="dock-divider" aria-hidden="true" />
      <div className="arrange-group">
        {DISTRIBUTE.map(({ axis, icon, label }) => (
          <IconButton
            key={axis}
            icon={icon}
            label={enoughToDistribute ? t(label) : t("arrange.needThree", { label: t(label) })}
            aria-disabled={enoughToDistribute ? undefined : true}
            onClick={enoughToDistribute ? apply(t(label), () => engine.distribute(axis)) : undefined}
          />
        ))}
      </div>
      <span className="dock-divider" aria-hidden="true" />
      <div className="arrange-group">
        <IconButton icon="undo" label={t("arrange.undo", { keys: `${mod}Z` })} aria-disabled={canUndo ? undefined : true} onClick={canUndo ? () => engine.undo() : undefined} />
        <IconButton icon="redo" label={t("arrange.redo", { keys: `${mod}Shift+Z` })} aria-disabled={canRedo ? undefined : true} onClick={canRedo ? () => engine.redo() : undefined} />
      </div>
      <span className="dock-divider" aria-hidden="true" />
      <IconButton icon="close" label={t("arrange.clear")} onClick={() => engine.clearSelection()} />
      <span className="sr-only" aria-live="polite">{announcement}</span>
    </div>
  );
}
