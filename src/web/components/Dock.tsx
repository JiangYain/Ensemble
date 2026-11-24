import type { ReactNode } from "react";
import type { SceneEngine } from "../scene/engine";
import { ArrangeBar } from "./ArrangeBar";
import { StatusNotices } from "./WorkspaceRail";

export interface CanvasControls {
  engine: SceneEngine;
  zoom: number;
  moved: boolean;
  custom: boolean;
}

/**
 * 方案 A 已彻底移除原来的底部居中浮空胶囊 Dock：
 * - 设置落地到左侧栏底部（窄屏收进顶部薄栏；宽屏收起侧栏后只留一个展开按钮，设置要展开侧栏再进）；
 * - 缩放与适应画布移至画布右下角 30px 直角图纸比例尺（CanvasScale）；
 * - 「仅工作中」数据过滤移至画布右上角视图操作区（WorkspaceHeader）；
 * - 这里仅在无侧栏可见时渲染克制的连接状态提示（StatusNotices），不给页面底部留任何浮空药丸。
 */
export function Dock({ canvas, tools = false, notices = true }: { canvas?: CanvasControls; tools?: boolean; notices?: boolean }): ReactNode {
  if (!tools) return notices ? <StatusNotices variant="floating" /> : null;
  return (
    <>
      {canvas ? (
        <div className="arrange-wrap" data-modal-inert>
          <ArrangeBar engine={canvas.engine} />
        </div>
      ) : null}
      {notices ? <StatusNotices variant="floating" /> : null}
    </>
  );
}
