// Node 22 的运行时缺少 Promise.try（V8 12.8 才有）。
// vendored driver 的 MCP 清理路径用到它；Ensemble 的 Cursor 后端不会走到那条路径（后端声明不支持 MCP 执行），
// 但“类型上存在、运行时不存在”本身就是隐患，所以按规范补上，并在类型里如实声明我们补了它。

declare global {
  interface PromiseConstructor {
    try<T, A extends unknown[]>(callback: (...args: A) => T | PromiseLike<T>, ...args: A): Promise<Awaited<T>>;
  }
}

export function ensureRuntimeCompat(): void {
  if (typeof Promise.try === "function") return;
  Object.defineProperty(Promise, "try", {
    configurable: true,
    writable: true,
    value: function promiseTry<T, A extends unknown[]>(
      callback: (...args: A) => T | PromiseLike<T>,
      ...args: A
    ): Promise<Awaited<T>> {
      return new Promise<Awaited<T>>((resolve) => {
        resolve(callback(...args) as Awaited<T> | PromiseLike<Awaited<T>>);
      });
    },
  });
}
