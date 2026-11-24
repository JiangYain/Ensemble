import type { KeyboardEvent } from "react";
import type { SceneEngine } from "../scene/engine";

/**
 * 这次按键是不是画布节点自己的：焦点在节点本身（而不是它内部的控件，那些留给控件），
 * 且不带 Ctrl / Meta / Alt（那是浏览器与系统的快捷键）。节点上所有键盘操作都先过这一关。
 */
export function isNodeKey(event: KeyboardEvent<HTMLElement>): boolean {
  return event.target === event.currentTarget && !event.ctrlKey && !event.metaKey && !event.altKey;
}

/** 画布节点的键盘操作：方向键移动（Shift 加速），Shift+空格切换选中。节点另有的按键（如 Enter）由节点自己在 isNodeKey 之后处理。 */
export function nodeKeyHandler(engine: SceneEngine, id: string): (event: KeyboardEvent<HTMLElement>) => void {
  return (event) => {
    if (!isNodeKey(event)) return;
    if (event.key === " " && event.shiftKey) {
      event.preventDefault();
      engine.toggleSelection(id);
      return;
    }
    const step = event.shiftKey ? 50 : 10;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      engine.moveNode(id, ...move);
    }
  };
}
