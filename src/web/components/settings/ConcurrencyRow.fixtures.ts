/**
 * 并发上限这一行的测试夹具（只被 ConcurrencyRow 的三份测试引用，不进页面的打包）：服务端给的容量与设置的样本，以及挂起请求的记录。
 * vi 的桩与 beforeEach / afterEach 是按文件生效的，所以 store 的复位与那组查询、操作小工具由各份测试各写一份。
 * 外观、此刻改不了、可访问性与语言、衔接与样式：ConcurrencyRow.test.tsx；提交、不合法的草稿、步进钮与方向键：ConcurrencyRow.commit.test.tsx；
 * 限制 / 不限制、恢复默认、失败与竞态：ConcurrencyRow.modes.test.tsx。
 */
import type { Capacity, ConcurrencySetting, ConcurrencyValue, SetConcurrencyResponse } from "@shared/protocol";

export const capacity = (max: number, occupied = 0, waiting = 0): Capacity => ({ occupied, max, waiting });
export const base: ConcurrencySetting = { source: "default", inherited: { max: 20, source: "default" } };
export const stored = (value: ConcurrencyValue, inherited: ConcurrencySetting["inherited"] = base.inherited): ConcurrencySetting => ({
  source: "settings",
  stored: value,
  inherited,
});
export const reply = (max: number, setting: ConcurrencySetting): SetConcurrencyResponse => ({ capacity: capacity(max), concurrency: setting });

/** 让已经就绪的 Promise 链都跑完。 */
export const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** 一次挂起的请求：由测试决定什么时候回来、回什么。 */
export interface Held {
  value: unknown;
  resolve(response: SetConcurrencyResponse): void;
  reject(error: Error): void;
}
