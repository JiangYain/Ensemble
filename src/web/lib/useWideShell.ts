import { useSyncExternalStore } from "react";

/** 窗口宽度达到这个值外壳才是宽屏（左侧栏）；更窄是窄屏（顶栏）。 */
export const WIDE_SHELL_MIN = 860;

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

const isWide = (): boolean => (typeof window === "undefined" ? true : window.innerWidth >= WIDE_SHELL_MIN);

/**
 * 外壳现在是宽屏（侧栏）还是窄屏（顶栏）（LAYOUT7 · W13）。
 *
 * 不能写成 `useState` 加 `resize` 监听：`resize` 在 React 里是连续事件，监听器里的 `setState` 要等调度器的下一个宏任务才渲染；
 * 而浏览器在同一帧里紧接着就做布局、通知 `ResizeObserver`，画布量到的是“窗口已经变了、外壳还没换”的过渡区域
 * （800 → 1440 时先量到 1328×672，几十毫秒后才是 1088×704），整体重排就用了它（见 scene/hold-settle.ts）。
 * `useSyncExternalStore` 的更新是同步优先级，在这次事件回调结束后的微任务里就渲染并提交完，早于布局与 `ResizeObserver`。
 * 没有 `window`（服务端渲染）时按宽屏。
 */
export function useWideShell(): boolean {
  return useSyncExternalStore(subscribe, isWide, () => true);
}
