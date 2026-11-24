import { useEffect, useRef, useState } from "react";

/**
 * 让一段会频繁变化的文字“沉淀”下来再显示：两次换字之间至少隔 `holdMs`，期间到来的新值只保留最新的一个。
 *
 * 节点副标题显示的是最近一次工具调用，一连串很快的读取 / 搜索会让它一秒换好几次；
 * 每次换字都带一段模糊淡入的话，字会一直处在“正在换”的状态，根本读不清。合并之后每个值至少能停留一会儿，
 * 数据没有丢（最后总会显示最新值），只是不再逐帧抖动。
 *
 * `phase` 变了（例如执行中 → 已完成）时不等待，立刻换成新值：状态符号和文字不能一前一后。
 */
export function useSettledText(text: string, phase: string, holdMs = 1200): string {
  const [shown, setShown] = useState({ text, phase });
  const lastSwap = useRef(0);

  useEffect(() => {
    if (shown.text === text && shown.phase === phase) return undefined;
    const apply = (): void => {
      lastSwap.current = performance.now();
      setShown({ text, phase });
    };
    if (shown.phase !== phase) {
      apply();
      return undefined;
    }
    const wait = lastSwap.current + holdMs - performance.now();
    if (wait <= 0) {
      apply();
      return undefined;
    }
    const timer = window.setTimeout(apply, wait);
    return () => window.clearTimeout(timer);
  }, [text, phase, shown, holdMs]);

  return shown.text;
}
