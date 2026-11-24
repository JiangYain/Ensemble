import { isConcurrencyValue } from "@shared/concurrency";
import { LIMITS } from "@shared/constants";
import type { Capacity, ConcurrencySetting, ConcurrencyValue } from "@shared/protocol";
import { api } from "./api";
import { perform, store, type AppState } from "./app";
import { translate } from "./i18n";

/**
 * 并发上限的页面侧逻辑：把服务端给的“容量 + 设置”合成界面要显示的样子，以及改动的提交。
 * 与 lib/model-settings.ts 同一种手感：改动即时生效、没有保存按钮；请求在途期间界面先显示用户要的值，
 * 服务端确认（或拒绝并还原）之后再以服务端为准。
 */

export const CONCURRENCY_MIN = LIMITS.concurrentRunsSetting.min;
export const CONCURRENCY_MAX = LIMITS.concurrentRunsSetting.max;

/** 协议里“不设上限”是 `max` 为 0；设置里的写法是 "unlimited"。界面统一用后者，数字就是数字。 */
export function valueOfMax(max: number): ConcurrencyValue {
  return max === 0 ? "unlimited" : max;
}

/** 界面此刻要显示的并发上限。 */
export interface ConcurrencyDisplay {
  /** 要显示的上限：有改动在途时是用户要的值，否则是服务端当前生效的。 */
  value: ConcurrencyValue;
  source: ConcurrencySetting["source"];
  /** 用户在这里指定过的值（含在途的）；没有就不提供“恢复默认”。 */
  stored: ConcurrencyValue | undefined;
  /** 清掉指定之后会落到的值（环境变量或内置默认）。 */
  inherited: ConcurrencyValue;
  issue: ConcurrencySetting["issue"];
  /** 有一个改动还在等服务端确认。 */
  pending: boolean;
  /** 这一项此刻改不了：启动服务的程序固定了它，或设置文件整个读不出来。 */
  locked: boolean;
}

export function displayConcurrency(setting: ConcurrencySetting, capacity: Capacity, pending: AppState["pendingConcurrency"]): ConcurrencyDisplay {
  const locked = isLocked(setting);
  const inherited = valueOfMax(setting.inherited.max);
  if (pending !== undefined && !locked) {
    return pending.value === null
      // “恢复默认”在途：先显示它会落到的值与来源，免得点了之后界面还停在旧值上等一个来回。
      ? { value: inherited, source: setting.inherited.source, stored: undefined, inherited, issue: undefined, pending: true, locked }
      : { value: pending.value, source: "settings", stored: pending.value, inherited, issue: undefined, pending: true, locked };
  }
  // 服务端当前生效的上限就是 capacity.max（设置只解释它的来源），不从 stored 另算一份：两者由服务端成对更新，这里不会对不上。
  return { value: valueOfMax(capacity.max), source: setting.source, stored: setting.stored, inherited, issue: setting.issue, pending: false, locked };
}

function isLocked(setting: ConcurrencySetting): boolean {
  return setting.source === "startup" || setting.issue === "unreadable_file";
}

/**
 * 输入框里的草稿：只认纯数字（两侧空白忽略）且落在合法范围内；其余（空、小数、负号、字母、0、超范围）都是无效，返回 undefined。
 * 判定范围用 shared/concurrency 的 isConcurrencyValue，与服务端写文件、校验请求体是同一份规则。
 */
export function parseDraft(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return isConcurrencyValue(value) ? value : undefined;
}

function clamped(value: number): number {
  return Math.min(CONCURRENCY_MAX, Math.max(CONCURRENCY_MIN, value));
}

/** 加减一步，停在合法范围的两端。 */
export function stepped(value: number, delta: 1 | -1): number {
  return clamped(value + delta);
}

/**
 * 从“不限制”切回“限制”时给的起点：最近一次看到的数字；没有就取“恢复默认”会落到的上限；默认本身也不限制时用内置默认。
 * 给一个有来历的数，而不是让用户面对一个空框。结果一律落在合法范围内：环境变量允许写任意正整数，
 * 超过设置里的上限（1000）的那种值直接提交会被服务端拒绝。
 */
export function startingLimit(last: number | undefined, inherited: ConcurrencyValue): number {
  if (last !== undefined) return clamped(last);
  if (typeof inherited === "number") return clamped(inherited);
  return LIMITS.maxConcurrentRuns;
}

/**
 * 指定并发上限（正整数或 "unlimited"）；`null` 清掉指定、回到环境变量 / 内置默认。
 * 只有一条在途的请求：请求期间又有新的改动就只记下最新的，等前一个回来再发（后一次的结果不会被前一次的回执盖掉）。
 * 服务端拒绝或网络失败：统一提示，然后界面回到服务端当前的样子。
 */
export function saveConcurrency(value: ConcurrencyValue | null): void {
  const { concurrency, pendingConcurrency } = store.get();
  // 服务没给这项设置（老服务、快照还没到），或此刻改不了（启动方固定、文件读不出来）：什么也不做，不发一个注定失败的请求。
  if (!concurrency || isLocked(concurrency)) return;
  store.set({ pendingConcurrency: { value } });
  if (pendingConcurrency === undefined) void flush();
}

async function flush(): Promise<void> {
  for (;;) {
    const request = store.get().pendingConcurrency;
    if (request === undefined) return;
    const response = await perform(() => api.setConcurrency(request.value), translate(store.get().lang, "settings.concurrencySaveFailed"));
    if (response) store.set({ capacity: response.capacity, concurrency: response.concurrency });
    // 等待期间用户又改了：用最新的再发一次。
    if (store.get().pendingConcurrency !== request) continue;
    store.set({ pendingConcurrency: undefined });
    return;
  }
}
