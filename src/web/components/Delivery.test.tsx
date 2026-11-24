import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replay } from "@shared/projection";
import { AGENT, EventLog, USER } from "@shared/testing";
import type { DeliveryRecord, Message, MessageKind } from "@shared/types";
import { setLang } from "../lib/app";
import { DeliveryTrack, SyncTag } from "./Delivery";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Step = Omit<DeliveryRecord, "at">;

/** 一条消息，依次收到这些投递记录（与服务端发出的 message.delivery 事件同一路径）。 */
function messageWith(records: Step[], options: { kind?: MessageKind; synced?: boolean } = {}): Message {
  const log = new EventLog("ses_delivery");
  log.created({ harness: "cursor" });
  const kind = options.kind ?? "steer";
  log.message("m1", kind, "文字", kind === "task" ? AGENT : USER);
  for (const record of records) log.push({ kind: "message.delivery", data: { messageId: "m1", record: { ...record, at: log.now() } } }, { source: "ensemble" });
  if (options.synced) log.push({ kind: "notice.delivered", data: { noticeIds: [], messageIds: ["m1"], at: log.now() } }, { source: "ensemble" });
  const state = replay(log.events);
  const message = state?.messages[0];
  if (!message) throw new Error("replay produced no message");
  return message;
}

describe("消息的投递轨迹", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    setLang("zh");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = (message: Message): void => {
    act(() => root.render(<DeliveryTrack message={message} />));
  };
  const states = (): string[] => [...host.querySelectorAll("li")].map((li) => li.getAttribute("data-state") ?? "");
  const names = (): string[] => [...host.querySelectorAll(".dl-name")].map((name) => name.textContent ?? "");
  const status = (): HTMLElement => host.querySelector<HTMLElement>(".dl-status")!;

  it("已记录：停在第一步，说明 Ensemble 收到了但还没交给执行端", () => {
    render(messageWith([]));
    expect(names()).toEqual(["已记录", "已交给执行端", "已生效"]);
    expect(states()).toEqual(["current", "todo", "todo"]);
    expect(status().textContent).toBe("Ensemble 已收到并保存，尚未交给执行端");
    expect(status().getAttribute("data-tone")).toBe("neutral");
    expect(host.querySelector(".delivery")?.hasAttribute("data-compact")).toBe(false);
    expect(host.querySelector("ol")?.getAttribute("aria-label")).toBe("投递进度");
  });

  it("由 Ensemble 排队：还在第一步，说明是谁持有以及在等什么（偏暖的提示色）", () => {
    render(messageWith([{ stage: "queued", queuedBy: "ensemble", reason: "capacity" }]));
    expect(states()).toEqual(["current", "todo", "todo"]);
    expect(status().textContent).toBe("已排队，由 Ensemble 持有 · 等待并发名额");
    expect(status().getAttribute("data-tone")).toBe("amber");
  });

  it("在执行端的队列里排队：已经交出去了，停在第二步", () => {
    render(messageWith([{ stage: "queued", queuedBy: "harness", reason: "turn_boundary" }]));
    expect(states()).toEqual(["done", "current", "todo"]);
    expect(status().textContent).toBe("已交给执行端，在它的队列里等待 · 等待当前回合边界");
    expect(status().getAttribute("data-tone")).toBe("amber");
  });

  it("已交给执行端 ≠ 已生效：停在第二步，写明“尚无生效确认”，不收成一行，也没有“已确认”", () => {
    render(messageWith([{ stage: "handed_off", evidence: "turn/steer accepted" }]));
    expect(states()).toEqual(["done", "current", "todo"]);
    expect(status().textContent).toBe("已交给执行端，尚无生效确认");
    expect(host.querySelector(".delivery")?.hasAttribute("data-compact")).toBe(false);
    expect(host.textContent).not.toContain("已确认");
  });

  it("已生效是终点：收成一行“执行端已确认纳入上下文”，不再摆三个小方块；逐条记录在悬停提示里", () => {
    render(messageWith([{ stage: "handed_off", evidence: "turn/steer accepted" }, { stage: "applied", evidence: "item/started userMessage" }]));
    const delivery = host.querySelector<HTMLElement>(".delivery")!;
    expect(delivery.hasAttribute("data-compact")).toBe(true);
    expect(delivery.getAttribute("data-stage")).toBe("applied");
    expect(host.querySelector("ol")).toBeNull();
    expect(host.textContent).toBe("执行端已确认纳入上下文");
    const lines = (delivery.getAttribute("data-tip") ?? "").split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("Ensemble 已收到并保存，尚未交给执行端");
    expect(lines[1]).toContain("已交给执行端，尚无生效确认");
    expect(lines[2]).toContain("执行端已确认纳入上下文");
    expect(lines[2]).toContain("item/started userMessage");
  });

  it("交给执行端之后没能生效：前两步保持完成，失败落在第三步，原因原样给出（红色）", () => {
    render(messageWith([{ stage: "handed_off" }, { stage: "failed", error: { code: "steer_rejected", message: "turn is not steerable" } }]));
    expect(states()).toEqual(["done", "done", "failed"]);
    expect(status().textContent).toBe("投递失败: turn is not steerable");
    expect(status().getAttribute("data-tone")).toBe("red");
  });

  it("排队时被撤回：已记录保持完成，撤回落在“已交给执行端”这一步，说明没有送达", () => {
    render(messageWith([{ stage: "queued", queuedBy: "ensemble", reason: "run_in_progress" }, { stage: "cancelled" }]));
    expect(states()).toEqual(["done", "cancelled", "todo"]);
    expect(status().textContent).toBe("已撤回，没有送达");
    expect(status().getAttribute("data-tone")).toBe("gray");
  });

  it("阶段只前进不后退：已生效之后再来一条“已交给执行端”，仍然是已生效", () => {
    render(messageWith([{ stage: "handed_off" }, { stage: "applied" }, { stage: "handed_off" }]));
    expect(host.querySelector(".delivery")?.getAttribute("data-stage")).toBe("applied");
    expect(host.textContent).toBe("执行端已确认纳入上下文");
  });

  it("英文界面走词典", () => {
    setLang("en");
    render(messageWith([{ stage: "handed_off" }]));
    expect(names()).toEqual(["Recorded", "Handed to harness", "Applied"]);
  });
});

describe("同步给主 Agent", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    setLang("zh");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = (message: Message): void => {
    act(() => root.render(<SyncTag message={message} />));
  };

  it("用户的纠偏：还没同步时是“待同步”（偏暖），主 Agent 收到之后变成“已同步”，都带悬停说明", () => {
    render(messageWith([{ stage: "handed_off" }]));
    const tag = host.querySelector<HTMLElement>(".sync-tag")!;
    expect(tag.textContent).toBe("待同步给主 Agent");
    expect(tag.getAttribute("data-state")).toBe("pending");
    expect(tag.getAttribute("data-tip")).toBe("主 Agent 下次调用 Ensemble 工具时会收到这条干预。");

    render(messageWith([{ stage: "handed_off" }], { synced: true }));
    const done = host.querySelector<HTMLElement>(".sync-tag")!;
    expect(done.textContent).toBe("已同步给主 Agent");
    expect(done.getAttribute("data-state")).toBe("delivered");
    expect(done.getAttribute("data-tip")).toContain("已随工具结果交给主 Agent");
  });

  it("主 Agent 自己发的委派不需要同步：不显示", () => {
    render(messageWith([], { kind: "task" }));
    expect(host.querySelector(".sync-tag")).toBeNull();
  });
});
