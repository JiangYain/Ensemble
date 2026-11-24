import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog, TEST_CAPABILITIES } from "@shared/testing";
import type { Capabilities, SessionSummary } from "@shared/types";
import { api, ApiError } from "../lib/api";
import { setLang, store } from "../lib/app";
import { onFollowLatest } from "../lib/reveal";
import { Composer } from "./Composer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Phase = "idle" | "running" | "stopped" | "starting";

function summaryOf(phase: Phase, options: { id?: string; capabilities?: Capabilities } = {}): SessionSummary {
  const id = options.id ?? "ses_composer";
  const log = new EventLog(id);
  log.created({ harness: "cursor", ...(options.capabilities ? { capabilities: options.capabilities } : {}) });
  if (phase === "running" || phase === "idle") {
    const message = log.message("msg_task", "task", "做点什么");
    log.run("run_1", 1, message.id);
    log.startRun("run_1");
    if (phase === "idle") log.push({ kind: "run.completed", data: { stopReason: "end_turn" } }, { runId: "run_1" });
  }
  if (phase === "stopped") log.push({ kind: "session.status", data: { status: "stopped", reason: "stopped_by_user" } }, { source: "ensemble" });
  const state = replay(log.events);
  if (!state) throw new Error("replay produced no state");
  return toSummary(state);
}

const noSteer: Capabilities = { ...TEST_CAPABILITIES, steer: { support: "no", mode: "none", verification: "none" } };
const declaredSteer: Capabilities = { ...TEST_CAPABILITIES, steer: { support: "yes", mode: "turn_boundary", verification: "declared" } };

const response = (summary: SessionSummary) => ({ messageId: "msg_new", kind: "steer" as const, stage: "recorded" as const, summary });

describe("干预输入", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    setLang("zh");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    // 草稿按会话 id 存在模块里：清掉这个用例留下的，免得串到下一个。
    if (host.querySelector("textarea")) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      act(() => {
        const element = host.querySelector("textarea")!;
        setter.call(element, "");
        element.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const render = (summary: SessionSummary): void => {
    act(() => root.render(<Composer summary={summary} />));
  };
  const area = (): HTMLTextAreaElement => host.querySelector<HTMLTextAreaElement>(".composer textarea")!;
  const sendButton = (): HTMLButtonElement => host.querySelector<HTMLButtonElement>(".send-btn")!;
  const radios = (): HTMLButtonElement[] => [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  const alertText = (): string | null => host.querySelector('[role="alert"]')?.textContent ?? null;

  const typeInto = (value: string): void => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setter.call(area(), value);
      area().dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  /** 在 target 上按一下键，返回事件（用来检查 preventDefault）。 */
  const press = (key: string, init: KeyboardEventInit & { keyCode?: number } = {}, target: Element = area()): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    // 不同的 DOM 实现对这两个字段的支持不一，缺的补上，保证测试的是组件而不是环境。
    if (init.keyCode !== undefined && event.keyCode !== init.keyCode) Object.defineProperty(event, "keyCode", { value: init.keyCode });
    if (init.isComposing !== undefined && event.isComposing !== init.isComposing) Object.defineProperty(event, "isComposing", { value: init.isComposing });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  };

  const settle = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  describe("空闲时", () => {
    it("按执行端的名字提示；没有内容（或只有空白）时发送键不可用，有内容才可用", () => {
      render(summaryOf("idle"));
      expect(area().placeholder).toBe("继续向 Cursor 交代…");
      expect(sendButton().disabled).toBe(true);
      typeInto("   \n ");
      expect(sendButton().disabled).toBe(true);
      typeInto("好");
      expect(sendButton().disabled).toBe(false);
      // 没有分段开关，也没有中断：空闲时只有“继续交代”这个说明。
      expect(radios()).toHaveLength(0);
      expect(host.querySelector(".composer-stop")).toBeNull();
      expect(host.querySelector(".composer-mode-label")?.textContent).toBe("继续交代");
    });

    it("Enter 发送：消息立刻从输入框清走，请求带的是空闲时的 auto 模式并去掉首尾空白", async () => {
      const summary = summaryOf("idle");
      const send = vi.spyOn(api, "send").mockResolvedValue(response(summary));
      render(summary);
      typeInto("  第一行\n第二行  ");
      const event = press("Enter");
      expect(event.defaultPrevented).toBe(true);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(summary.id, { text: "第一行\n第二行", mode: "auto" });
      expect(area().value).toBe("");
      await settle();
      expect(host.querySelector(".composer")?.hasAttribute("data-busy")).toBe(false);
    });

    it("Shift+Enter 只换行，不发送", () => {
      const send = vi.spyOn(api, "send");
      render(summaryOf("idle"));
      typeInto("第一行");
      const event = press("Enter", { shiftKey: true });
      expect(event.defaultPrevented).toBe(false);
      expect(send).not.toHaveBeenCalled();
      expect(area().value).toBe("第一行");
    });

    it("输入法组字期间的 Enter 不发送：isComposing 为真，或（Safari 组字结束那一下）keyCode 为 229", async () => {
      const send = vi.spyOn(api, "send");
      render(summaryOf("idle"));
      typeInto("你好");
      press("Enter", { isComposing: true });
      press("Enter", { keyCode: 229 });
      expect(send).not.toHaveBeenCalled();
      expect(area().value).toBe("你好");
      // 组字结束后的第一下 Enter 才发送。
      send.mockResolvedValue(response(summaryOf("idle")));
      press("Enter");
      expect(send).toHaveBeenCalledTimes(1);
      await settle();
    });

    it("发送时通知时间线回到最新处（让用户看到自己的话落在哪）", async () => {
      vi.spyOn(api, "send").mockResolvedValue(response(summaryOf("idle")));
      const followed = vi.fn();
      const off = onFollowLatest(followed);
      try {
        render(summaryOf("idle"));
        typeInto("好");
        press("Enter");
        expect(followed).toHaveBeenCalledTimes(1);
        await settle();
      } finally {
        off();
      }
    });
  });

  describe("运行中", () => {
    it("默认是“纠偏”，可以切到“排队”；提示文案与发送时带的模式都跟着变", async () => {
      const summary = summaryOf("running");
      const send = vi.spyOn(api, "send").mockResolvedValue(response(summary));
      render(summary);
      expect(radios().map((radio) => radio.textContent)).toEqual(["纠偏", "排队"]);
      expect(radios().map((radio) => radio.getAttribute("aria-checked"))).toEqual(["true", "false"]);
      expect(area().placeholder).toBe("补充或纠正 Cursor 当前的方向…");

      typeInto("别动 public API");
      press("Enter");
      expect(send).toHaveBeenLastCalledWith(summary.id, { text: "别动 public API", mode: "steer" });
      // 上一条还在发送时发送键是忙碌的；等它回来再发下一条。
      await settle();

      act(() => radios()[1]!.click());
      expect(radios().map((radio) => radio.getAttribute("aria-checked"))).toEqual(["false", "true"]);
      expect(area().placeholder).toBe("交代 Cursor 在本次运行之后继续做什么…");
      typeInto("跑完再补一个测试");
      press("Enter");
      expect(send).toHaveBeenLastCalledWith(summary.id, { text: "跑完再补一个测试", mode: "follow_up" });
    });

    it("分段开关是 radiogroup：只有选中的那一项在 Tab 序列里，方向键、Home、End 在两项之间移动并带着焦点", () => {
      render(summaryOf("running"));
      expect(host.querySelector('[role="radiogroup"]')?.getAttribute("aria-label")).toBe("发送方式");
      expect(radios().map((radio) => radio.tabIndex)).toEqual([0, -1]);

      radios()[0]!.focus();
      press("ArrowRight", {}, radios()[0]!);
      expect(radios().map((radio) => radio.getAttribute("aria-checked"))).toEqual(["false", "true"]);
      expect(radios().map((radio) => radio.tabIndex)).toEqual([-1, 0]);
      expect(document.activeElement).toBe(radios()[1]);

      press("ArrowRight", {}, radios()[1]!);
      expect(radios()[0]!.getAttribute("aria-checked")).toBe("true");
      press("End", {}, radios()[0]!);
      expect(radios()[1]!.getAttribute("aria-checked")).toBe("true");
      press("Home", {}, radios()[1]!);
      expect(radios()[0]!.getAttribute("aria-checked")).toBe("true");
      press("ArrowUp", {}, radios()[0]!);
      expect(radios()[1]!.getAttribute("aria-checked")).toBe("true");
    });

    it("能力注记：已实测的纠偏带对勾和投递方式（悬停说明都在）；仅文档声明用另一种说法且没有对勾；排队时只剩“运行结束后”", () => {
      render(summaryOf("running"));
      const notes = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(".cap-note")];
      expect(notes().map((note) => note.textContent)).toEqual(["已实测", "立即交付"]);
      expect(notes()[0]!.getAttribute("data-tip")).toBe("已在这台机器上用真实执行端验证过。");
      expect(notes()[0]!.getAttribute("data-tone")).toBe("ok");
      expect(notes()[0]!.querySelector("svg")).not.toBeNull();

      render(summaryOf("running", { capabilities: declaredSteer }));
      expect(notes().map((note) => note.textContent)).toEqual(["仅文档声明", "回合结束处理"]);
      expect(notes()[0]!.getAttribute("data-tip")).toBe("根据文档或源码声明，尚未在这台机器上验证。");
      expect(notes()[0]!.getAttribute("data-tone")).toBe("amber");
      expect(notes()[0]!.querySelector("svg")).toBeNull();

      act(() => radios()[1]!.click());
      expect(notes().map((note) => note.textContent)).toEqual(["运行结束后"]);
    });

    it("执行端不能在运行中纠偏：不摆只有一格的开关，只有一个“排队”标签并说明原因，发送按排队走", async () => {
      const summary = summaryOf("running", { capabilities: noSteer });
      const send = vi.spyOn(api, "send").mockResolvedValue(response(summary));
      render(summary);
      expect(host.querySelector('[role="radiogroup"]')).toBeNull();
      const label = host.querySelector<HTMLElement>(".composer-mode-label")!;
      expect(label.textContent).toBe("排队");
      expect(label.getAttribute("data-tip")).toBe("这个执行端不能在运行中纠偏，消息会排到本次运行之后。");
      expect(area().placeholder).toBe("交代 Cursor 在本次运行之后继续做什么…");
      typeInto("之后再说");
      press("Enter");
      expect(send).toHaveBeenCalledWith(summary.id, { text: "之后再说", mode: "follow_up" });
      await settle();
    });

    it("运行中有“中断”：点击调用取消，进行中显示忙碌且不能重复点", async () => {
      const summary = summaryOf("running");
      let finish: (value: { interrupted: boolean; cancelledQueued: number; summary: SessionSummary }) => void = () => {};
      const cancel = vi.spyOn(api, "cancel").mockReturnValue(new Promise((resolve) => (finish = resolve)));
      render(summary);
      const stop = host.querySelector<HTMLButtonElement>(".composer-stop")!;
      expect(stop.getAttribute("aria-label")).toBe("中断");
      act(() => stop.click());
      expect(cancel).toHaveBeenCalledWith(summary.id);
      expect(stop.disabled).toBe(true);
      expect(stop.getAttribute("aria-busy")).toBe("true");
      await act(async () => {
        finish({ interrupted: true, cancelledQueued: 0, summary });
        await Promise.resolve();
      });
      await settle();
      expect(host.querySelector<HTMLButtonElement>(".composer-stop")!.disabled).toBe(false);
    });
  });

  describe("发送的结果", () => {
    it("发送中：发送键忙碌（aria-busy）且不能再发，输入框仍可继续写下一条", async () => {
      let finish: (value: ReturnType<typeof response>) => void = () => {};
      const summary = summaryOf("idle");
      const send = vi.spyOn(api, "send").mockReturnValue(new Promise((resolve) => (finish = resolve)));
      render(summary);
      typeInto("第一条");
      press("Enter");
      expect(host.querySelector(".composer")?.hasAttribute("data-busy")).toBe(true);
      expect(sendButton().getAttribute("aria-busy")).toBe("true");
      expect(sendButton().disabled).toBe(true);
      typeInto("第二条");
      press("Enter");
      expect(send).toHaveBeenCalledTimes(1);
      await act(async () => {
        finish(response(summary));
        await Promise.resolve();
      });
      await settle();
      expect(sendButton().getAttribute("aria-busy")).toBeNull();
      expect(sendButton().disabled).toBe(false);
      expect(area().value).toBe("第二条");
    });

    it("失败：原文放回输入框，原因写在输入框里（role=alert），再输入就收起提示", async () => {
      vi.spyOn(api, "send").mockRejectedValue(new ApiError("network", "fetch failed", 0));
      render(summaryOf("idle"));
      typeInto("这条会失败");
      press("Enter");
      expect(area().value).toBe("");
      await settle();
      expect(area().value).toBe("这条会失败");
      expect(alertText()).toBe("发送失败：无法连接到 Ensemble 服务");
      expect(host.querySelector(".composer-box")?.hasAttribute("data-error")).toBe(true);
      expect(area().getAttribute("aria-invalid")).toBe("true");
      typeInto("这条会失败，改一改");
      expect(alertText()).toBeNull();
      expect(host.querySelector(".composer-box")?.hasAttribute("data-error")).toBe(false);
    });

    it("失败时用户已经写了新内容：两段都留着，不覆盖", async () => {
      let fail: (reason: unknown) => void = () => {};
      vi.spyOn(api, "send").mockReturnValue(new Promise((_resolve, reject) => (fail = reject)));
      render(summaryOf("idle"));
      typeInto("第一条");
      press("Enter");
      typeInto("第二条");
      await act(async () => {
        fail(new ApiError("network", "x", 0));
        await Promise.resolve();
      });
      await settle();
      expect(area().value).toContain("第一条");
      expect(area().value).toContain("第二条");
    });
  });

  describe("长度上限", () => {
    it("接近上限只显示字数；超过上限提示并禁止发送，Enter 也不发", () => {
      const send = vi.spyOn(api, "send");
      render(summaryOf("idle"));
      typeInto("字".repeat(44_999));
      expect(host.querySelector(".composer-count")).toBeNull();

      typeInto("字".repeat(46_000));
      expect(host.querySelector(".composer-count")?.textContent).toBe("46,000 / 50,000");
      expect(alertText()).toBeNull();
      expect(sendButton().disabled).toBe(false);

      typeInto("字".repeat(50_001));
      expect(host.querySelector(".composer-count")?.textContent).toBe("50,001 / 50,000");
      expect(host.querySelector(".composer-count")?.hasAttribute("data-over")).toBe(true);
      expect(alertText()).toBe("消息超过 50,000 字符的上限");
      expect(host.querySelector(".composer-box")?.hasAttribute("data-over")).toBe(true);
      expect(sendButton().disabled).toBe(true);
      press("Enter");
      expect(send).not.toHaveBeenCalled();

      typeInto("字".repeat(50_000));
      expect(sendButton().disabled).toBe(false);
    });
  });

  describe("其他状态", () => {
    it("会话已关闭：不放灰掉的输入框，只有一行说明，没有可聚焦的控件", () => {
      render(summaryOf("stopped"));
      expect(host.querySelector("textarea")).toBeNull();
      expect(host.querySelector("button")).toBeNull();
      expect(host.querySelector(".composer-closed")?.textContent).toBe("会话已关闭");
    });

    it("连接中：按空闲提示，可以中断，没有纠偏开关（运行还没开始）", () => {
      render(summaryOf("starting"));
      expect(area().placeholder).toBe("继续向 Cursor 交代…");
      expect(host.querySelector(".composer-stop")).not.toBeNull();
      expect(radios()).toHaveLength(0);
    });

    it("Esc 只让输入框失去焦点，草稿保留（再按一次 Esc 才轮到“返回全部会话”）", () => {
      const send = vi.spyOn(api, "send");
      const cancel = vi.spyOn(api, "cancel");
      render(summaryOf("running"));
      area().focus();
      expect(document.activeElement).toBe(area());
      typeInto("还没发的草稿");
      press("Escape");
      expect(document.activeElement).not.toBe(area());
      expect(area().value).toBe("还没发的草稿");
      expect(send).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
    });

    it("每个会话有自己的草稿：切走再切回来，没发的话还在", () => {
      render(summaryOf("idle", { id: "ses_a" }));
      typeInto("A 的草稿");
      render(summaryOf("idle", { id: "ses_b" }));
      expect(area().value).toBe("");
      typeInto("B 的草稿");
      render(summaryOf("idle", { id: "ses_a" }));
      expect(area().value).toBe("A 的草稿");
      render(summaryOf("idle", { id: "ses_b" }));
      expect(area().value).toBe("B 的草稿");
      // 清理模块里的草稿表，避免影响别的用例。
      typeInto("");
      render(summaryOf("idle", { id: "ses_a" }));
      typeInto("");
    });

    it("英文界面：占位、分段开关与注记都走词典", () => {
      setLang("en");
      render(summaryOf("running"));
      expect(radios().map((radio) => radio.textContent)).toEqual(["Steer", "Queue"]);
      expect(area().placeholder).toBe("Add or correct Cursor's current direction…");
      expect(host.querySelector(".composer-stop")?.getAttribute("aria-label")).toBe("Interrupt");
      expect(store.get().lang).toBe("en");
    });
  });

  describe("输入框的高度", () => {
    const original = globalThis.ResizeObserver;
    let notify: Array<() => void>;

    beforeEach(() => {
      notify = [];
      globalThis.ResizeObserver = class {
        constructor(callback: () => void) {
          notify.push(callback);
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      } as unknown as typeof ResizeObserver;
    });

    afterEach(() => {
      globalThis.ResizeObserver = original;
    });

    /** 排版在这个测试环境里恒为 0：用假的几何量描述“当前宽度下内容需要多高”。 */
    const geometry = (): { width: (value: number, needs: number) => void } => {
      const el = area();
      let clientWidth = 0;
      let scrollHeight = 46;
      Object.defineProperty(el, "clientWidth", { configurable: true, get: () => clientWidth });
      Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
      return {
        width: (value, needs) => {
          clientWidth = value;
          scrollHeight = needs;
        },
      };
    };
    const resized = (): void => {
      act(() => {
        for (const callback of notify) callback();
        vi.advanceTimersByTime(50);
      });
    };

    it("宽度变了就按新宽度重新量：折行变了，高度不能停在旧值上（首次进入时按“宽”布局量到被挤窄的宽度的情形）", () => {
      vi.useFakeTimers();
      render(summaryOf("idle"));
      const view = geometry();
      expect(notify.length).toBeGreaterThan(0);

      // 被挤窄时占位符折成两行；布局切到“中”之后变宽，一行就够了。
      view.width(260, 65);
      resized();
      expect(area().style.height).toBe("65px");
      view.width(450, 46);
      resized();
      expect(area().style.height).toBe("46px");
    });

    it("只是高度变了（输入框自己改的）不算宽度变化，不会再触发重新量", () => {
      vi.useFakeTimers();
      render(summaryOf("idle"));
      const view = geometry();
      view.width(450, 46);
      resized();
      expect(area().style.height).toBe("46px");

      view.width(450, 99);
      resized();
      expect(area().style.height).toBe("46px");
    });

    it("内容变长照样长高（原有行为），不依赖观察器", () => {
      render(summaryOf("idle"));
      const view = geometry();
      view.width(450, 90);
      typeInto("第一行\n第二行\n第三行");
      expect(area().style.height).toBe("90px");
    });
  });
});
