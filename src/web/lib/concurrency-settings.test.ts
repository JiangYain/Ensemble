import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { LIMITS } from "@shared/constants";
import type { Capacity, ConcurrencySetting, SetConcurrencyResponse } from "@shared/protocol";
import { ApiError, api } from "./api";
import { store } from "./app";
import {
  CONCURRENCY_MAX,
  CONCURRENCY_MIN,
  displayConcurrency,
  parseDraft,
  saveConcurrency,
  startingLimit,
  stepped,
  valueOfMax,
} from "./concurrency-settings";

const capacity = (max: number, occupied = 0, waiting = 0): Capacity => ({ occupied, max, waiting });
const base: ConcurrencySetting = { source: "default", inherited: { max: 20, source: "default" } };
const stored = (value: number | "unlimited"): ConcurrencySetting => ({ source: "settings", stored: value, inherited: { max: 20, source: "default" } });
/** 让已经就绪的 Promise 链都跑完。 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("并发上限的取值范围", () => {
  it("与服务端同一份：1 到 1000", () => {
    expect(CONCURRENCY_MIN).toBe(1);
    expect(CONCURRENCY_MAX).toBe(1000);
    expect(CONCURRENCY_MAX).toBe(LIMITS.concurrentRunsSetting.max);
  });

  it("协议里的 0 是“不设上限”，界面统一说 unlimited，数字就是数字", () => {
    expect(valueOfMax(0)).toBe("unlimited");
    expect(valueOfMax(5)).toBe(5);
  });
});

describe("parseDraft：数字框里的草稿", () => {
  it.each([
    ["8", 8],
    ["1", 1],
    ["1000", 1000],
    [" 12 ", 12],
    ["007", 7],
  ])("接受 %j", (text, expected) => {
    expect(parseDraft(text)).toBe(expected);
  });

  it.each(["", "   ", "0", "-3", "+5", "2.5", "1e2", "0x10", "abc", "8x", "1,000", "1001", "99999999999999999999", "０８"])(
    "不接受 %j（空、0、负号、小数、字母、超范围、全角数字都是无效草稿）",
    (text) => {
      expect(parseDraft(text)).toBeUndefined();
    },
  );
});

describe("stepped：加减一步", () => {
  it("加一减一", () => {
    expect(stepped(5, 1)).toBe(6);
    expect(stepped(5, -1)).toBe(4);
  });

  it("停在合法范围的两端，不会减到 0 或加过 1000", () => {
    expect(stepped(CONCURRENCY_MIN, -1)).toBe(CONCURRENCY_MIN);
    expect(stepped(CONCURRENCY_MAX, 1)).toBe(CONCURRENCY_MAX);
  });

  it("从范围之外的数出发也落回范围（环境变量允许写任意正整数）", () => {
    expect(stepped(5000, -1)).toBe(CONCURRENCY_MAX);
    expect(stepped(5000, 1)).toBe(CONCURRENCY_MAX);
  });
});

describe("startingLimit：从“不限制”切回“限制”时的起点", () => {
  it("优先是最近一次看到的数字", () => {
    expect(startingLimit(7, 20)).toBe(7);
    expect(startingLimit(7, "unlimited")).toBe(7);
  });

  it("没有就取“恢复默认”会落到的上限", () => {
    expect(startingLimit(undefined, 12)).toBe(12);
  });

  it("默认本身也不限制时用内置默认，而不是一个空框", () => {
    expect(startingLimit(undefined, "unlimited")).toBe(LIMITS.maxConcurrentRuns);
  });

  it("结果一律落在合法范围内：超过 1000 的环境变量值直接提交会被服务端拒绝", () => {
    expect(startingLimit(undefined, 5000)).toBe(CONCURRENCY_MAX);
    expect(startingLimit(5000, 20)).toBe(CONCURRENCY_MAX);
  });
});

describe("displayConcurrency：界面此刻要显示的样子", () => {
  it("没有在途的改动：以服务端生效的上限为准（capacity.max），设置只解释来源", () => {
    expect(displayConcurrency(base, capacity(20), undefined)).toEqual({
      value: 20, source: "default", stored: undefined, inherited: 20, issue: undefined, pending: false, locked: false,
    });
    expect(displayConcurrency(stored(5), capacity(5), undefined)).toEqual({
      value: 5, source: "settings", stored: 5, inherited: 20, issue: undefined, pending: false, locked: false,
    });
  });

  it("capacity.max 为 0 就是不限制", () => {
    expect(displayConcurrency(stored("unlimited"), capacity(0), undefined)).toMatchObject({ value: "unlimited", stored: "unlimited" });
  });

  it("环境变量本身是“不限制”时，恢复默认会落到不限制", () => {
    const setting: ConcurrencySetting = { source: "settings", stored: 4, inherited: { max: 0, source: "env" } };
    expect(displayConcurrency(setting, capacity(4), undefined).inherited).toBe("unlimited");
  });

  it("改动在途：先显示用户要的值，并算作“已在这里指定”", () => {
    expect(displayConcurrency(base, capacity(20), { value: 8 })).toEqual({
      value: 8, source: "settings", stored: 8, inherited: 20, issue: undefined, pending: true, locked: false,
    });
    expect(displayConcurrency(base, capacity(20), { value: "unlimited" })).toMatchObject({ value: "unlimited", stored: "unlimited", pending: true });
  });

  it("“恢复默认”在途：先显示它会落到的值与来源，不让界面停在旧值上等一个来回", () => {
    const setting: ConcurrencySetting = { source: "settings", stored: 5, inherited: { max: 6, source: "env" } };
    expect(displayConcurrency(setting, capacity(5), { value: null })).toEqual({
      value: 6, source: "env", stored: undefined, inherited: 6, issue: undefined, pending: true, locked: false,
    });
  });

  it("启动方固定了上限、或设置文件读不出来：改不了，在途的改动也不再显示", () => {
    const fixed: ConcurrencySetting = { source: "startup", stored: 7, inherited: { max: 20, source: "default" } };
    expect(displayConcurrency(fixed, capacity(2), { value: 9 })).toMatchObject({ value: 2, source: "startup", locked: true, pending: false });
    const unreadable: ConcurrencySetting = { source: "default", inherited: { max: 20, source: "default" }, issue: "unreadable_file" };
    expect(displayConcurrency(unreadable, capacity(20), undefined)).toMatchObject({ locked: true, issue: "unreadable_file" });
  });

  it("文件里的值无效：照常能改（用户正是在修它），并带着这个问题", () => {
    const invalid: ConcurrencySetting = { source: "default", inherited: { max: 20, source: "default" }, issue: "invalid_value" };
    expect(displayConcurrency(invalid, capacity(20), undefined)).toMatchObject({ locked: false, issue: "invalid_value", stored: undefined });
  });
});

describe("saveConcurrency：提交与在途队列", () => {
  let setConcurrency: MockInstance<typeof api.setConcurrency>;

  beforeEach(() => {
    store.set({ lang: "zh", concurrency: base, capacity: capacity(20), pendingConcurrency: undefined, toasts: [] });
    setConcurrency = vi.spyOn(api, "setConcurrency");
  });

  afterEach(() => {
    store.set({ concurrency: undefined, capacity: capacity(0), pendingConcurrency: undefined, toasts: [] });
    vi.restoreAllMocks();
  });

  const response = (max: number, setting: ConcurrencySetting): SetConcurrencyResponse => ({ capacity: capacity(max), concurrency: setting });

  /** 每次请求都挂起，由测试决定何时回来。 */
  const hold = () => {
    const held: Array<{ value: unknown; resolve(reply: SetConcurrencyResponse): void; reject(error: Error): void }> = [];
    setConcurrency.mockImplementation((value) => new Promise<SetConcurrencyResponse>((resolve, reject) => {
      held.push({ value, resolve, reject });
    }));
    return held;
  };

  it("服务没给这项设置（老服务、第一份快照还没到）：什么也不做，不发一个注定失败的请求", async () => {
    store.set({ concurrency: undefined });
    saveConcurrency(5);
    await tick();
    expect(setConcurrency).not.toHaveBeenCalled();
    expect(store.get().pendingConcurrency).toBeUndefined();
  });

  const lockedSettings: Array<[string, ConcurrencySetting]> = [
    ["启动方固定了上限", { source: "startup", inherited: { max: 20, source: "default" } }],
    ["设置文件读不出来", { source: "default", inherited: { max: 20, source: "default" }, issue: "unreadable_file" }],
  ];

  it.each(lockedSettings)("%s：改不了，什么也不做", async (_label, setting) => {
    store.set({ concurrency: setting });
    saveConcurrency(5);
    saveConcurrency(null);
    await tick();
    expect(setConcurrency).not.toHaveBeenCalled();
    expect(store.get().pendingConcurrency).toBeUndefined();
  });

  it("请求在途时先记下用户要的值；回执回来后以服务端为准，清掉在途", async () => {
    const held = hold();
    saveConcurrency(8);
    expect(setConcurrency).toHaveBeenCalledTimes(1);
    expect(setConcurrency).toHaveBeenCalledWith(8);
    expect(store.get().pendingConcurrency).toEqual({ value: 8 });

    held[0]!.resolve(response(8, stored(8)));
    await tick();
    expect(store.get().pendingConcurrency).toBeUndefined();
    expect(store.get().capacity).toEqual(capacity(8));
    expect(store.get().concurrency).toEqual(stored(8));
  });

  it("“不限制”与“恢复默认”分别发 \"unlimited\" 与 null", async () => {
    setConcurrency.mockResolvedValue(response(20, base));
    saveConcurrency("unlimited");
    await tick();
    saveConcurrency(null);
    await tick();
    expect(setConcurrency.mock.calls.map(([value]) => value)).toEqual(["unlimited", null]);
  });

  it("同一时刻只有一条在途的请求；期间的新改动只记最新的，前一条回来后再发，最后一次为准", async () => {
    const held = hold();
    saveConcurrency(3);
    saveConcurrency(4);
    saveConcurrency(5);
    expect(setConcurrency).toHaveBeenCalledTimes(1);
    expect(store.get().pendingConcurrency).toEqual({ value: 5 });

    held[0]!.resolve(response(3, stored(3)));
    await tick();
    // 前一条的回执已经应用，但最新的改动还没确认，界面不回退到 3。
    expect(setConcurrency).toHaveBeenCalledTimes(2);
    expect(setConcurrency).toHaveBeenLastCalledWith(5);
    expect(store.get().pendingConcurrency).toEqual({ value: 5 });

    held[1]!.resolve(response(5, stored(5)));
    await tick();
    expect(store.get().pendingConcurrency).toBeUndefined();
    expect(store.get().capacity.max).toBe(5);
    expect(setConcurrency).toHaveBeenCalledTimes(2);
  });

  it("服务拒绝或网络失败：提示一次，在途清掉，界面回到服务端当前的样子", async () => {
    const held = hold();
    saveConcurrency(8);
    held[0]!.reject(new ApiError("conflict", "The concurrency limit was fixed by the process that started this service.", 409));
    await tick();
    expect(store.get().pendingConcurrency).toBeUndefined();
    expect(store.get().capacity).toEqual(capacity(20));
    expect(store.get().concurrency).toEqual(base);
    const toasts = store.get().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ tone: "error" });
    expect(toasts[0]!.text).toContain("没能保存并发上限");
  });

  it("失败不卡住后面的改动", async () => {
    const held = hold();
    saveConcurrency(8);
    held[0]!.reject(new Error("offline"));
    await tick();
    saveConcurrency(9);
    expect(setConcurrency).toHaveBeenCalledTimes(2);
    held[1]!.resolve(response(9, stored(9)));
    await tick();
    expect(store.get().pendingConcurrency).toBeUndefined();
    expect(store.get().capacity.max).toBe(9);
  });

  it("在途期间又被另一个标签页改了：回执仍按服务端给的应用，之后的新改动照常发", async () => {
    const held = hold();
    saveConcurrency(8);
    store.set({ capacity: capacity(2), concurrency: stored(2) });
    held[0]!.resolve(response(8, stored(8)));
    await tick();
    expect(store.get().capacity.max).toBe(8);
    expect(store.get().pendingConcurrency).toBeUndefined();
  });
});
