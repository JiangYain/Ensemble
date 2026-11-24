import type { EngineState } from "./engine-types";

/**
 * 一组监听者：订阅返回退订函数；通知时按订阅那一刻的快照逐个调用，
 * 监听者在回调里订阅或退订，都只影响下一轮。同一个函数订阅两次只算一次。
 */
export class Signal {
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/** 界面（对齐条）订阅的引擎状态：内容真的变了才换成新对象并通知，没变时 `get` 返回的始终是同一个对象。 */
export class StateCell {
  private state: EngineState = { selected: 0, canUndo: false, canRedo: false };
  private readonly signal = new Signal();

  readonly subscribe = this.signal.subscribe;

  get(): EngineState {
    return this.state;
  }

  patch(patch: Partial<EngineState>): void {
    const next = { ...this.state, ...patch };
    if (next.selected === this.state.selected && next.canUndo === this.state.canUndo && next.canRedo === this.state.canRedo) return;
    this.state = next;
    this.signal.notify();
  }
}
