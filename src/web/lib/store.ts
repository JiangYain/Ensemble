import { useRef, useSyncExternalStore } from "react";

type Listener = () => void;

/** 极小的外部状态容器：整个应用只有一份状态，组件通过选择器订阅自己关心的部分。 */
export class Store<S extends object> {
  private state: S;
  private readonly listeners = new Set<Listener>();

  constructor(initial: S) {
    this.state = initial;
  }

  get = (): S => this.state;

  set(patch: Partial<S> | ((state: S) => Partial<S>)): void {
    const next = typeof patch === "function" ? patch(this.state) : patch;
    let changed = false;
    for (const key of Object.keys(next) as (keyof S)[]) {
      if (!Object.is(this.state[key], next[key])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.state = { ...this.state, ...next };
    for (const listener of [...this.listeners]) listener();
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

/** 订阅状态的一部分。同一份状态下只运行一次选择器：`useSyncExternalStore` 每次渲染会多次取快照，返回新对象的选择器不缓存会死循环。 */
export function useStore<S extends object, T>(store: Store<S>, selector: (state: S) => T): T {
  const cache = useRef<{ state: S; value: T } | undefined>(undefined);
  const getSnapshot = (): T => {
    const state = store.get();
    if (cache.current?.state !== state) cache.current = { state, value: selector(state) };
    return cache.current.value;
  };
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
