import { afterEach, describe, expect, it, vi } from "vitest";
import { followLatest, onFollowLatest, onReveal, revealMessage, takePendingReveal } from "./reveal";

afterEach(() => {
  takePendingReveal();
  vi.useRealTimers();
});

describe("消息定位请求", () => {
  it("通知所有订阅者，取消订阅后不再收到", () => {
    const a: string[] = [];
    const b: string[] = [];
    const offA = onReveal((id) => a.push(id));
    const offB = onReveal((id) => b.push(id));
    revealMessage("msg_1");
    offA();
    revealMessage("msg_2");
    offB();
    revealMessage("msg_3");
    expect(a).toEqual(["msg_1"]);
    expect(b).toEqual(["msg_1", "msg_2"]);
  });

  it("没人接手的请求暂存起来，取走一次后就没有了", () => {
    revealMessage("msg_late");
    expect(takePendingReveal()).toBe("msg_late");
    expect(takePendingReveal()).toBeUndefined();
  });

  it("只暂存最近的一条请求", () => {
    revealMessage("msg_old");
    revealMessage("msg_new");
    expect(takePendingReveal()).toBe("msg_new");
  });

  it("暂存的请求过期后作废，避免很久以后被陈旧的请求拽着滚动", () => {
    vi.useFakeTimers();
    revealMessage("msg_stale");
    vi.advanceTimersByTime(3500);
    expect(takePendingReveal()).toBeUndefined();
  });
});

describe("回到最新处的请求", () => {
  it("通知所有订阅者，取消订阅后不再收到", () => {
    let a = 0;
    let b = 0;
    const offA = onFollowLatest(() => (a += 1));
    const offB = onFollowLatest(() => (b += 1));
    followLatest();
    offA();
    followLatest();
    offB();
    followLatest();
    expect(a).toBe(1);
    expect(b).toBe(2);
  });

  it("没有订阅者（时间线没有挂载）时什么也不留下", () => {
    followLatest();
    let late = 0;
    const off = onFollowLatest(() => (late += 1));
    expect(late).toBe(0);
    off();
  });

  it("与消息定位互不相干", () => {
    const revealed: string[] = [];
    let followed = 0;
    const offReveal = onReveal((id) => revealed.push(id));
    const offFollow = onFollowLatest(() => (followed += 1));
    followLatest();
    expect(revealed).toEqual([]);
    revealMessage("msg_1");
    expect(followed).toBe(1);
    offReveal();
    offFollow();
  });
});
