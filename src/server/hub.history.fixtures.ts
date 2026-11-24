/**
 * 仅供测试使用：hub.history*.test.ts 几份套件共用的小辅助，建在 history-fixtures.ts 之上：
 * ISO 时间、“刚结束 5 分钟”的会话，以及“用懒加载启动过一次”的存储。
 */

import { lazyHub, MINUTE, NOW, seed, SpyStore, type Clock, type SessionFixture } from "./history-fixtures";

export const iso = (ms: number): string => new Date(ms).toISOString();

/** 一个刚结束 5 分钟的会话：启动时还在保温期里（热），再过 6 分钟就可以冻结。 */
export const RECENT = (id: string): SessionFixture => ({ id, at: NOW - 5 * MINUTE });

/** 用懒加载启动过一次（把该写的快照写好），再返回同一个存储，之后的“重启”从它开始。 */
export async function startedOnce(fixtures: readonly SessionFixture[]): Promise<{ store: SpyStore; clock: Clock }> {
  const store = new SpyStore();
  await seed(store, fixtures);
  const clock: Clock = { now: NOW };
  await lazyHub(store, clock).load();
  store.loads.length = 0;
  return { store, clock };
}
