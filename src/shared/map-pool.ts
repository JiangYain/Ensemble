/**
 * 有界并发地逐项处理一组条目（`Promise.all` 的限流版）。
 *
 * - **并发上限**：同时在途的 `work` 不超过 `limit` 个。上限不足 1 或不是数的按 1，比条目数大的按条目数。
 *   条目按输入顺序依次领取，一路做完才领下一个，不是“一批一批地等最慢的那个”。
 * - **保序**：返回的结果与输入一一对应、次序相同，与各项谁先完成无关；`work` 的第二个参数是条目在输入里的下标。
 * - **错误由谁捕获**：`mapPool` 自己不捕获、不转换任何错误。`work` 抛出（或返回被拒绝的 Promise）就是整体失败：
 *   第一个错误让返回的 Promise 以它拒绝，之后不再领取新的条目；已经在途的各自跑完，它们的结果与之后的错误一并丢弃。
 *   需要“某一项失败不影响其他项”的调用方（启动时逐个读快照、批量阅读）在 `work` 里自己 try/catch，
 *   把失败变成一个结果或一条日志；哪些失败要继续抛出、让整体失败，也由 `work` 决定。
 *
 * 只用 ES2023 的标准能力、不依赖 Node，服务端、MCP 桥与网页都可以用。
 */
export async function mapPool<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  // 所有路共用同一个迭代器：谁空闲谁取下一项，每一项只会被取走一次。
  const queue = items.entries();
  let failed = false;
  const lane = async (): Promise<void> => {
    while (!failed) {
      const next = queue.next();
      if (next.done) return;
      const [index, item] = next.value;
      try {
        results[index] = await work(item, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, Math.trunc(limit) || 1)) }, lane));
  return results;
}
