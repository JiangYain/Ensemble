import { useEffect, useState } from "react";

/** 用户偏好减少动态效果时，退出动画不需要等。 */
function calm(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/**
 * 让一块内容在关闭时先播完退出动画再卸载（打开时立刻挂载，由样式播进入动画）。
 *
 * - present：现在是否要渲染它。打开的同一帧就是 true；关闭后保持到退出动画播完。
 * - closing：正在播退出动画，样式据此换成收起的那一套（data-state="closing"）。
 *
 * 动画期间重新打开会取消卸载。exitMs 要与样式里的退出时长一致（略长一点即可）。
 */
export function usePresence(open: boolean, exitMs: number): { present: boolean; closing: boolean } {
  const [shown, setShown] = useState(open);
  // 打开时在渲染中同步记下来：这样“关闭”那一帧还能知道刚才是打开的，从而先播退出动画。
  if (open && !shown) setShown(true);

  useEffect(() => {
    if (open || !shown) return undefined;
    if (exitMs <= 0 || calm()) {
      setShown(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setShown(false), exitMs);
    return () => window.clearTimeout(timer);
  }, [open, shown, exitMs]);

  return { present: open || shown, closing: !open && shown };
}
