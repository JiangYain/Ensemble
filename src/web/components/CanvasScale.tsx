import type { ReactNode } from "react";
import { useT } from "../lib/useT";
import type { SceneEngine } from "../scene/engine";
import { Icon } from "./Icons";

export interface CanvasScaleProps {
  engine: SceneEngine;
  zoom: number;
  moved: boolean;
  /** 显示“重置节点布局”按钮：用户拖过节点，或此刻的排布与按当前会话重新规划的结果不一样（见 HeldLayout.drifted）。 */
  canReset: boolean;
}

/**
 * 画布右下角的图纸比例尺 HUD（方案 A）：
 * 取代原来的底部居中大胶囊 Dock，只保留与画布几何直接相关的操作（缩放、适应、重置布局）。
 * 30px 高、直角 1px 细线、纸白底，像建筑图纸右下角的图签比例尺，安静贴边、不遮挡画布主体。
 */
export function CanvasScale({ engine, zoom, moved, canReset }: CanvasScaleProps): ReactNode {
  const t = useT();
  const pct = Math.round(zoom * 100);
  return (
    <div className="canvas-scale" role="group" aria-label={t("dock.zoom")} data-scene-ui>
      <button
        type="button"
        className="scale-btn"
        aria-label={t("scene.zoomOut")}
        data-tip={t("scene.zoomOut")}
        onClick={() => engine.zoomBy(1 / 1.2)}
      >
        <Icon name="minus" size={13} />
      </button>
      <span className="scale-value num">{pct}%</span>
      <button
        type="button"
        className="scale-btn"
        aria-label={t("scene.zoomIn")}
        data-tip={t("scene.zoomIn")}
        onClick={() => engine.zoomBy(1.2)}
      >
        <Icon name="plus" size={13} />
      </button>
      <span className="scale-sep" aria-hidden="true" />
      <button
        type="button"
        className="scale-btn"
        aria-label={t("scene.fit")}
        data-tip={t("scene.fit")}
        data-active={moved ? "" : undefined}
        onClick={() => engine.fit(true, true)}
      >
        <Icon name="fit" size={13} />
      </button>
      {canReset ? (
        <button
          type="button"
          className="scale-btn"
          aria-label={t("scene.resetLayout")}
          data-tip={t("scene.resetLayoutTip")}
          onClick={() => engine.resetLayout()}
        >
          <Icon name="refresh" size={13} />
        </button>
      ) : null}
    </div>
  );
}
