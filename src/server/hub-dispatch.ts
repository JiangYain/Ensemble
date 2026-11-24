/**
 * 订阅与派发：事件中枢通知订阅者的那一半（EventHub 的 subscribe / batch / notify 转给它）。
 * 重入规则：正在派发（`dispatching`）或处在 `batch` 里（`batchDepth > 0`）时，新的通知只入队、不派发——
 * 由最外层正在跑的派发循环（或 `batch` 结束时的那一次 `dispatch`）按入队次序送出，所以订阅者看到的次序就是通知发出的次序，
 * 订阅者回调里再触发通知也不会嵌套执行。一个订阅者抛错只记一条日志，不影响其余订阅者，也不影响后面的通知。
 * 它只依赖日志；每个 EventHub 持有自己的一份，状态不跨实例。
 */

import type { HubChange, HubListener } from "./hub-types";
import type { Logger } from "./logger";

export class HubDispatcher {
  private readonly listeners = new Set<HubListener>();
  private readonly dispatchQueue: HubChange[] = [];
  private dispatching = false;
  private batchDepth = 0;

  constructor(private readonly log: Logger) {}

  subscribe(listener: HubListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 同一个同步转换的事件先全部写入投影，再让 wait 和 SSE 观察。 */
  batch<T>(commit: () => T): T {
    this.batchDepth += 1;
    try {
      return commit();
    } finally {
      this.batchDepth -= 1;
      this.dispatch();
    }
  }

  notify(change: HubChange): void {
    this.dispatchQueue.push(change);
    this.dispatch();
  }

  private dispatch(): void {
    if (this.dispatching || this.batchDepth > 0) return;
    this.dispatching = true;
    try {
      for (let next = this.dispatchQueue.shift(); next; next = this.dispatchQueue.shift()) {
        for (const listener of this.listeners) {
          try {
            listener(next);
          } catch (error) {
            this.log.error("hub listener failed", { error });
          }
        }
      }
    } finally {
      this.dispatching = false;
    }
  }
}
