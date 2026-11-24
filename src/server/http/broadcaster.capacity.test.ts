import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConcurrencySetting, StreamMessage } from "@shared/protocol";
import { EventLog } from "@shared/testing";
import { EventHub } from "../hub";
import { silentLogger } from "../logger";
import { MemoryEventStore } from "../store";
import { Broadcaster, type CapacityPayload } from "./broadcaster";

// SSE 的 capacity 消息：名额的占用 / 等待与并发上限的设置成对推给页面，按合并窗口合并，内容没变不推。
// 这里不开网络，只看 Broadcaster 对外 publish 了什么；真的经 HTTP 与 SSE 走一遍见 service.concurrency-setting.test.ts。

const FLUSH_MS = 5;
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, FLUSH_MS * 8));

function payload(occupied: number, max: number, waiting = 0, source: ConcurrencySetting["source"] = "default"): CapacityPayload {
  return { capacity: { occupied, max, waiting }, concurrency: { source, inherited: { max: 20, source: "default" } } };
}

const open: Broadcaster[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()!.stop();
  vi.restoreAllMocks();
});

function rig(initial: CapacityPayload) {
  const hub = new EventHub({ store: new MemoryEventStore(), log: silentLogger });
  const broadcaster = new Broadcaster(hub, silentLogger, FLUSH_MS);
  open.push(broadcaster);
  const publish = vi.spyOn(broadcaster, "publish");
  let current = initial;
  broadcaster.start();
  broadcaster.watchCapacity(() => current);
  const published = (): StreamMessage[] => publish.mock.calls.map(([message]) => message);
  const capacities = () => published().filter((message): message is Extract<StreamMessage, { type: "capacity" }> => message.type === "capacity");
  /** 改变“读出来的内容”，并像服务那样通知一声。 */
  const change = (next: CapacityPayload): void => {
    current = next;
    broadcaster.capacityChanged();
  };
  return { hub, broadcaster, published, capacities, change };
}

describe("Broadcaster 的 capacity 消息", () => {
  it("内容与当前页面看到的一样就不推：只是被通知了一声，不是心跳", async () => {
    const { published, change } = rig(payload(0, 20));
    change(payload(0, 20));
    await settle();
    expect(published()).toEqual([]);
  });

  it("成对推：名额账目与设置在同一条消息里", async () => {
    const { capacities, change } = rig(payload(0, 20));
    change(payload(0, 3, 0, "settings"));
    await settle();
    expect(capacities()).toEqual([
      { type: "capacity", capacity: { occupied: 0, max: 3, waiting: 0 }, concurrency: { source: "settings", inherited: { max: 20, source: "default" } } },
    ]);
  });

  it("一个窗口里连变几次，只推最后的样子，rev 只前进一格", async () => {
    const { broadcaster, capacities, change } = rig(payload(0, 1));
    change(payload(1, 1, 0));
    change(payload(1, 1, 1));
    change(payload(1, 1, 2));
    await settle();
    expect(capacities()).toHaveLength(1);
    expect(capacities()[0]?.capacity).toEqual({ occupied: 1, max: 1, waiting: 2 });
    expect(broadcaster.currentRev()).toBe(1);
  });

  it("窗口里来回抖动、最后回到原样，就什么都不推", async () => {
    const { published, change } = rig(payload(0, 1));
    change(payload(1, 1, 0));
    change(payload(0, 1, 0));
    await settle();
    expect(published()).toEqual([]);
  });

  it("与上一次推出去的比，而不是与上一次被通知的比", async () => {
    const { capacities, change } = rig(payload(0, 1));
    change(payload(1, 1));
    await settle();
    expect(capacities()).toHaveLength(1);

    change(payload(1, 1)); // 被通知了，内容没变
    await settle();
    expect(capacities()).toHaveLength(1);

    change(payload(0, 1)); // 回到最初的样子，但相对上一次推出去的是新的
    await settle();
    expect(capacities()).toHaveLength(2);
    expect(capacities()[1]?.capacity).toEqual({ occupied: 0, max: 1, waiting: 0 });
  });

  it("只有设置变了（上限、来源）、账目没变，也要推", async () => {
    const { capacities, change } = rig(payload(2, 5));
    change(payload(2, 5, 0, "settings"));
    await settle();
    expect(capacities()).toHaveLength(1);
    expect(capacities()[0]?.concurrency.source).toBe("settings");
  });

  it("排在同一个窗口里的会话事件之后：页面先看到会话，再看到名额", async () => {
    const { hub, published, change } = rig(payload(0, 1));
    const created = new EventLog().created();
    if (created.kind !== "session.created") throw new Error("Expected a session creation event");
    hub.emit(created.sessionId, { kind: created.kind, data: created.data, source: "ensemble" });
    change(payload(1, 1));
    await settle();
    const types = published().map((message) => message.type);
    expect(types).toEqual(["events", "summary", "capacity"]);
  });

  it("没登记读取方式时什么都不做（不推、也不留下计时器）", async () => {
    const hub = new EventHub({ store: new MemoryEventStore(), log: silentLogger });
    const broadcaster = new Broadcaster(hub, silentLogger, FLUSH_MS);
    open.push(broadcaster);
    const publish = vi.spyOn(broadcaster, "publish");
    broadcaster.capacityChanged();
    await settle();
    expect(publish).not.toHaveBeenCalled();
  });

  it("stop 之后，还没推出去的变化被丢掉", async () => {
    const { broadcaster, published, change } = rig(payload(0, 1));
    change(payload(1, 1));
    broadcaster.stop();
    await settle();
    expect(published()).toEqual([]);
    // 停止之后再被通知也不会推。
    broadcaster.capacityChanged();
    await settle();
    expect(published()).toEqual([]);
  });
});
