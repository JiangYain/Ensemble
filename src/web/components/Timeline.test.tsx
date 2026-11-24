import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyEvent, replay, toSummary, type SessionState } from "@shared/projection";
import { EventLog, USER } from "@shared/testing";
import { setLang } from "../lib/app";
import { followLatest, revealMessage, takePendingReveal } from "../lib/reveal";
import { buildRows, GROUP_WINDOW, Timeline } from "./Timeline";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function build(fill: (log: EventLog) => void): SessionState {
  const log = new EventLog("ses_t");
  log.created({ harness: "pi" });
  const message = log.message("msg_1", "task", "做点什么");
  log.run("run_1", 1, message.id);
  log.startRun("run_1");
  fill(log);
  const state = replay(log.events);
  if (!state) throw new Error("replay produced no state");
  return state;
}

const thought = (log: EventLog, id: string, text = "先想一想"): void => {
  log.push({ kind: "reasoning.delta", data: { itemId: id, text } }, { runId: "run_1" });
  log.push({ kind: "reasoning.completed", data: { itemId: id, durationMs: 90 } }, { runId: "run_1" });
};

const step = (log: EventLog, id: string): void => {
  log.tool("run_1", id, "running");
  log.tool("run_1", id, "completed");
};

describe("时间线分组", () => {
  it("连续的工具调用与推理合成一个工作组，被消息打断后另起一组", () => {
    const state = build((log) => {
      thought(log, "r1");
      step(log, "t1");
      step(log, "t2");
      log.push({ kind: "assistant.delta", data: { itemId: "a1", text: "好了", phase: "final" } }, { runId: "run_1" });
      log.push({ kind: "assistant.completed", data: { itemId: "a1" } }, { runId: "run_1" });
      step(log, "t3");
    });
    const kinds = buildRows(state).map((row) => row.kind);
    expect(kinds).toEqual(["message", "run", "work", "assistant", "work"]);
    const groups = buildRows(state).filter((row) => row.kind === "work");
    expect(groups.map((row) => (row.kind === "work" ? row.items.length : 0))).toEqual([3, 1]);
  });

  it("空白的助手条目不单独成行", () => {
    const state = build((log) => {
      log.push({ kind: "assistant.delta", data: { itemId: "a1", text: "   ", phase: "final" } }, { runId: "run_1" });
      log.push({ kind: "assistant.completed", data: { itemId: "a1" } }, { runId: "run_1" });
    });
    expect(buildRows(state).some((row) => row.kind === "assistant")).toBe(false);
  });
});

describe("时间线渲染", () => {
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

  const render = (state: SessionState): void => {
    act(() => {
      root.render(<Timeline state={state} rev={state.seq} summary={toSummary(state)} />);
    });
  };

  it("只有推理的工作组不会写成“执行了 0 个步骤”", () => {
    render(build((log) => thought(log, "r1")));
    const text = host.textContent ?? "";
    expect(text).not.toContain("0 个步骤");
    expect(host.querySelector(".work--solo")).not.toBeNull();
    expect(host.querySelector(".reasoning")).not.toBeNull();
  });

  it("没有任何工具调用时不出现“展开全部步骤”", () => {
    render(build((log) => thought(log, "r1")));
    expect(host.textContent).not.toContain("展开全部步骤");
  });

  it("有工具调用的工作组显示步骤数与失败数", () => {
    render(
      build((log) => {
        step(log, "t1");
        log.tool("run_1", "t2", "running");
        log.tool("run_1", "t2", "failed", { error: "boom" });
        log.push({ kind: "assistant.delta", data: { itemId: "a1", text: "完成", phase: "final" } }, { runId: "run_1" });
        log.push({ kind: "assistant.completed", data: { itemId: "a1" } }, { runId: "run_1" });
      }),
    );
    const head = host.querySelector(".work-head");
    expect(head?.textContent).toContain("执行了 2 个步骤");
    expect(head?.textContent).toContain("1 失败");
    expect(host.textContent).toContain("展开全部步骤");
  });

  it("很长的工作组展开后只先渲染最近的一段，更早的按需展开", () => {
    const total = GROUP_WINDOW * 3;
    const state = build((log) => {
      for (let i = 0; i < total; i++) step(log, `t${i}`);
    });
    render(state);
    const head = host.querySelector<HTMLButtonElement>(".work-head");
    expect(head?.textContent).toContain(`执行了 ${total} 个步骤`);

    // 运行还没有结束，工作组默认展开，但只渲染最近的 GROUP_WINDOW 步。
    expect(host.querySelectorAll(".tool").length).toBe(GROUP_WINDOW);
    const older = host.querySelector<HTMLButtonElement>(".more-btn--inline");
    expect(older?.textContent).toContain(`${total - GROUP_WINDOW}`);
    // 保留的是最近的那些。
    const titles = [...host.querySelectorAll(".tool-title")].map((node) => node.textContent);
    expect(titles[0]).toBe(`t${total - GROUP_WINDOW}`);
    expect(titles.at(-1)).toBe(`t${total - 1}`);

    act(() => older?.click());
    expect(host.querySelectorAll(".tool").length).toBe(total);
    expect(host.querySelector(".more-btn--inline")).toBeNull();
  });
});

describe("从右栏定位到时间线里的消息", () => {
  let host: HTMLDivElement;
  let root: Root;
  const scrollTo = vi.fn();
  const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTo");

  beforeEach(() => {
    setLang("zh");
    scrollTo.mockReset();
    Object.defineProperty(Element.prototype, "scrollTo", { value: scrollTo, configurable: true, writable: true });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    takePendingReveal();
    vi.useRealTimers();
    if (original) Object.defineProperty(Element.prototype, "scrollTo", original);
    else delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
  });

  const render = (state: SessionState): void => {
    act(() => {
      root.render(<Timeline state={state} rev={state.seq} summary={toSummary(state)} />);
    });
  };

  const messageNode = (id: string): HTMLElement | null => host.querySelector(`[data-message-id="${id}"]`);

  /** 定位用的是平滑滚动；挂载和新内容到来时的“贴底”用的是即时滚动。 */
  const revealCalls = (): unknown[][] => scrollTo.mock.calls.filter(([arg]) => (arg as { behavior?: string } | undefined)?.behavior === "smooth");

  const withSteers = (count: number): SessionState =>
    build((log) => {
      for (let i = 0; i < count; i++) log.message(`msg_s${i}`, "steer", `第 ${i} 条纠偏`, USER);
    });

  it("滚到目标消息的位置（留出顶边距离），并让它的外框短暂亮一下", () => {
    vi.useFakeTimers();
    render(withSteers(3));
    const container = host.querySelector<HTMLElement>(".timeline-scroll")!;
    const target = messageNode("msg_s1")!;
    expect(target).not.toBeNull();
    container.scrollTop = 40;
    container.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    target.getBoundingClientRect = () => ({ top: 500 }) as DOMRect;
    scrollTo.mockClear();

    act(() => revealMessage("msg_s1"));

    // 500（目标）− 100（滚动区）+ 40（已滚动）− 18（顶边距离）。
    expect(revealCalls()).toEqual([[{ top: 422, behavior: "smooth" }]]);
    expect(scrollTo.mock.contexts[scrollTo.mock.calls.length - 1]).toBe(container);
    expect(target.hasAttribute("data-flash")).toBe(true);
    expect(messageNode("msg_s0")!.hasAttribute("data-flash")).toBe(false);

    // 到点摘掉标记，下一次定位同一条还能再亮。
    act(() => {
      vi.advanceTimersByTime(2600);
    });
    expect(target.hasAttribute("data-flash")).toBe(false);
    act(() => revealMessage("msg_s1"));
    expect(target.hasAttribute("data-flash")).toBe(true);
  });

  it("定位会放弃“贴底跟随”：之后来了新内容只提示，不会把视图拽回底部", () => {
    render(withSteers(3));
    // 没定位时：新内容到来，贴底跟随生效，不出现“有新内容”按钮。
    render(withSteers(4));
    expect(host.querySelector(".jump")).toBeNull();

    act(() => revealMessage("msg_s0"));
    scrollTo.mockClear();
    render(withSteers(5));

    expect(host.querySelector(".jump")).not.toBeNull();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("目标在被收起的更早的行里时，先展开它再定位", () => {
    render(withSteers(450));
    expect(host.textContent).toContain("更早");
    expect(messageNode("msg_s0")).toBeNull();
    scrollTo.mockClear();

    act(() => revealMessage("msg_s0"));

    const target = messageNode("msg_s0");
    expect(target).not.toBeNull();
    expect(revealCalls()).toHaveLength(1);
    expect(target!.hasAttribute("data-flash")).toBe(true);
  });

  it("时间线挂载之前发出的请求，挂载时被取走（窄屏下从摘要标签页切回时间线）", () => {
    revealMessage("msg_s2");
    expect(scrollTo).not.toHaveBeenCalled();
    render(withSteers(3));
    expect(revealCalls()).toHaveLength(1);
    expect(messageNode("msg_s2")!.hasAttribute("data-flash")).toBe(true);

    // 取走即清除：重新挂载不会再滚一次。
    act(() => root.unmount());
    root = createRoot(host);
    scrollTo.mockClear();
    render(withSteers(3));
    expect(revealCalls()).toHaveLength(0);
  });

  it("不存在的消息 id 什么也不做", () => {
    render(withSteers(2));
    scrollTo.mockClear();
    act(() => revealMessage("msg_missing"));
    expect(revealCalls()).toHaveLength(0);
  });
});

/**
 * 运行中的会话：事件一条一条追加进同一个 state（与线上的增量更新同一条路径：state 原地改，rev 往前走），
 * 而不是每次重建一个新 state——这样测到的才是真实的“增量”行为。
 */
function liveSession(fill?: (log: EventLog) => void): { log: EventLog; state: SessionState; sync: () => number } {
  const log = new EventLog("ses_t");
  log.created({ harness: "pi" });
  const message = log.message("msg_1", "task", "做点什么");
  log.run("run_1", 1, message.id);
  log.startRun("run_1");
  fill?.(log);
  const state = replay(log.events);
  if (!state) throw new Error("replay produced no state");
  let applied = log.events.length;
  return {
    log,
    state,
    sync: () => {
      for (const event of log.events.slice(applied)) applyEvent(state, event);
      applied = log.events.length;
      return state.seq;
    },
  };
}

describe("时间线的滚动跟随", () => {
  let host: HTMLDivElement;
  let root: Root;
  const scrollTo = vi.fn();
  const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTo");

  beforeEach(() => {
    setLang("zh");
    scrollTo.mockReset();
    Object.defineProperty(Element.prototype, "scrollTo", { value: scrollTo, configurable: true, writable: true });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    if (original) Object.defineProperty(Element.prototype, "scrollTo", original);
    else delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
  });

  const render = (live: { state: SessionState; sync: () => number }): void => {
    const rev = live.sync();
    act(() => {
      root.render(<Timeline state={live.state} rev={rev} summary={toSummary(live.state)} />);
    });
  };

  /** 排版在这个测试环境里恒为 0：用假的几何量描述“内容有多高、可视区有多高”。 */
  function geometry(): { box: HTMLElement; set: (scrollHeight: number, clientHeight?: number) => void; scrollTo: (top: number) => void } {
    const box = host.querySelector<HTMLElement>(".timeline-scroll")!;
    let scrollHeight = 0;
    let clientHeight = 0;
    Object.defineProperty(box, "scrollHeight", { configurable: true, get: () => scrollHeight });
    Object.defineProperty(box, "clientHeight", { configurable: true, get: () => clientHeight });
    return {
      box,
      set: (height, visible = 400) => {
        scrollHeight = height;
        clientHeight = visible;
      },
      // 用户（或程序）把滚动位置放到 top，并派发滚动事件。
      scrollTo: (top) => {
        box.scrollTop = top;
        act(() => {
          box.dispatchEvent(new Event("scroll"));
        });
      },
    };
  }

  const jump = (): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>(".jump");
  const pinned = (): unknown[][] => scrollTo.mock.calls.filter(([arg]) => (arg as { behavior?: string } | undefined)?.behavior === "auto");

  it("在底部时新步骤继续贴底，不出现任何按钮", () => {
    const live = liveSession((log) => step(log, "t1"));
    render(live);
    const view = geometry();
    view.set(2000);
    view.scrollTo(1600);
    scrollTo.mockClear();

    view.set(2200);
    step(live.log, "t2");
    render(live);
    expect(jump()).toBeNull();
    expect(pinned().at(-1)).toEqual([{ top: 2200, behavior: "auto" }]);
  });

  it("内容长高而视图位置没动：不算用户离开，之后的新内容照样跟随（慢机器上滚动事件晚到的情形）", () => {
    const live = liveSession((log) => step(log, "t1"));
    render(live);
    const view = geometry();
    view.set(2000);
    view.scrollTo(1600);

    // 内容先长高到 2400；浏览器的滚动事件此时才派发，位置仍是 1600，离底部 400。
    view.set(2400);
    view.scrollTo(1600);
    expect(jump()).toBeNull();

    scrollTo.mockClear();
    step(live.log, "t2");
    render(live);
    expect(jump()).toBeNull();
    expect(pinned().at(-1)).toEqual([{ top: 2400, behavior: "auto" }]);
  });

  it("用户向上滚：放弃跟随，出现“回到最新”；新条目（哪怕追加在同一个工作组里）让它变成“有新内容”，视图不被拽动", () => {
    const live = liveSession((log) => step(log, "t1"));
    render(live);
    const view = geometry();
    view.set(2000);
    view.scrollTo(1600);
    view.scrollTo(900);

    expect(jump()).not.toBeNull();
    expect(jump()?.hasAttribute("data-new")).toBe(false);
    expect(jump()?.getAttribute("aria-label")).toBe("回到最新");

    scrollTo.mockClear();
    const rowsBefore = host.querySelectorAll(".timeline-inner > *").length;
    step(live.log, "t2");
    render(live);
    expect(host.querySelectorAll(".work")).toHaveLength(1); // 仍是同一个工作组
    expect(host.querySelectorAll(".timeline-inner > *").length).toBe(rowsBefore);
    expect(jump()?.hasAttribute("data-new")).toBe(true);
    expect(jump()?.textContent).toBe("有新内容");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("点“有新内容”：平滑回到底部、恢复跟随，之后的新内容又贴底了", () => {
    const live = liveSession((log) => step(log, "t1"));
    render(live);
    const view = geometry();
    view.set(2000);
    view.scrollTo(1600);
    view.scrollTo(900);
    step(live.log, "t2");
    render(live);

    scrollTo.mockClear();
    act(() => jump()?.click());
    expect(scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: "smooth" });
    expect(jump()).toBeNull();

    scrollTo.mockClear();
    view.set(2300);
    step(live.log, "t3");
    render(live);
    expect(pinned().at(-1)).toEqual([{ top: 2300, behavior: "auto" }]);
  });

  it("向上滚轮立即放弃跟随——哪怕离底部还不到阈值，新内容也不会把他刚滚上去的那一点拽回去", () => {
    const live = liveSession((log) => step(log, "t1"));
    render(live);
    const view = geometry();
    view.set(2000);
    view.scrollTo(1600);

    act(() => {
      view.box.scrollTop = 1590;
      view.box.dispatchEvent(Object.assign(new Event("wheel", { bubbles: true, cancelable: true }), { deltaY: -40 }));
    });
    scrollTo.mockClear();
    live.log.message("msg_s1", "steer", "换个方向", USER);
    render(live);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(jump()?.hasAttribute("data-new")).toBe(true);
  });

  it("在输入框里发了话：回到最新并继续跟随", () => {
    const live = liveSession((log) => step(log, "t1"));
    render(live);
    const view = geometry();
    view.set(2000);
    view.scrollTo(1600);
    view.scrollTo(300);
    expect(jump()).not.toBeNull();

    scrollTo.mockClear();
    act(() => followLatest());
    expect(jump()).toBeNull();
    expect(pinned().at(-1)).toEqual([{ top: 2000, behavior: "auto" }]);
  });

  describe("很长的工作组：向上翻阅时窗口起点冻结", () => {
    const titles = (): Array<string | null> => [...host.querySelectorAll(".tool-title")].map((node) => node.textContent);
    const tools = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(".tool")];
    const append = (live: ReturnType<typeof liveSession>, from: number, to: number): void => {
      for (let i = from; i < to; i++) step(live.log, `t${i}`);
      render(live);
    };

    it("贴底时窗口照常跟着尾部滑动；向上翻阅后来一批新步骤，起点不动、已渲染的行不卸载；回到底部后恢复窗口化", () => {
      const live = liveSession((log) => {
        for (let i = 0; i < 100; i++) step(log, `t${i}`);
      });
      render(live);
      const view = geometry();
      view.set(2000);
      view.scrollTo(1600);

      // 贴底：只留最近的 GROUP_WINDOW 步，逐条追加时起点逐条前移。
      expect(tools()).toHaveLength(GROUP_WINDOW);
      expect(titles()[0]).toBe("t40");
      append(live, 100, 101);
      expect(titles()[0]).toBe("t41");
      expect(tools()).toHaveLength(GROUP_WINDOW);

      // 用户向上翻着读：来了一批 30 步。
      view.scrollTo(900);
      expect(jump()).not.toBeNull();
      const before = tools();
      expect(titles()[0]).toBe("t41");
      scrollTo.mockClear();
      append(live, 101, 131);

      expect(titles()[0]).toBe("t41");
      expect(titles().at(-1)).toBe("t130");
      expect(tools()).toHaveLength(GROUP_WINDOW + 30);
      before.forEach((node, i) => expect(tools()[i]).toBe(node));
      expect(host.querySelector(".more-btn--inline")?.textContent).toContain("41");
      expect(scrollTo).not.toHaveBeenCalled();
      expect(jump()?.hasAttribute("data-new")).toBe(true);

      // 回到底部：恢复正常窗口化，只留最近的一段。
      view.set(2600);
      view.scrollTo(2200);
      expect(jump()).toBeNull();
      expect(tools()).toHaveLength(GROUP_WINDOW);
      expect(titles()[0]).toBe("t71");
      expect(titles().at(-1)).toBe("t130");
    });

    it("点“有新内容”回到底部之后同样恢复窗口化，之后逐条追加又是起点逐条前移", () => {
      const live = liveSession((log) => {
        for (let i = 0; i < 100; i++) step(log, `t${i}`);
      });
      render(live);
      const view = geometry();
      view.set(2000);
      view.scrollTo(1600);
      view.scrollTo(900);
      append(live, 100, 130);
      expect(tools()).toHaveLength(GROUP_WINDOW + 30);
      expect(titles()[0]).toBe("t40");

      act(() => jump()?.click());
      expect(jump()).toBeNull();
      expect(tools()).toHaveLength(GROUP_WINDOW);
      expect(titles()[0]).toBe("t70");

      append(live, 130, 131);
      expect(titles()[0]).toBe("t71");
    });

    it("在输入框里发了话（回到最新）也恢复窗口化", () => {
      const live = liveSession((log) => {
        for (let i = 0; i < 100; i++) step(log, `t${i}`);
      });
      render(live);
      const view = geometry();
      view.set(2000);
      view.scrollTo(1600);
      view.scrollTo(300);
      append(live, 100, 130);
      expect(tools()).toHaveLength(GROUP_WINDOW + 30);

      act(() => followLatest());
      expect(tools()).toHaveLength(GROUP_WINDOW);
      expect(titles()[0]).toBe("t70");
    });
  });
});

describe("时间线的行", () => {
  it("buildRows：没变的工作组沿用上一次的那一行，只有追加了步骤的那一组换新（memo 才能命中）", () => {
    const live = liveSession((log) => {
      step(log, "t1");
      log.message("msg_s1", "steer", "换个方向", USER);
      step(log, "t2");
    });
    const first = buildRows(live.state);
    step(live.log, "t3");
    live.sync();
    const second = buildRows(live.state, first);

    const groups = (rows: ReturnType<typeof buildRows>) => rows.filter((row) => row.kind === "work");
    const [firstA, firstB] = groups(first);
    const [secondA, secondB] = groups(second);
    expect(groups(first)).toHaveLength(2);
    expect(secondA).toBe(firstA);
    expect(secondB).not.toBe(firstB);
    expect(secondB?.kind === "work" ? secondB.items.length : 0).toBe(2);
  });

  describe("渲染", () => {
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

    const render = (live: { state: SessionState; sync: () => number }): void => {
      const rev = live.sync();
      act(() => {
        root.render(<Timeline state={live.state} rev={rev} summary={toSummary(live.state)} />);
      });
    };
    const answer = (log: EventLog, id: string, text: string): void => {
      log.push({ kind: "assistant.delta", data: { itemId: id, text, phase: "final" } }, { runId: "run_1" });
      log.push({ kind: "assistant.completed", data: { itemId: id } }, { runId: "run_1" });
    };

    it("每一段执行端发言只在第一行署名一次；用户再发话之后的下一段重新署名", () => {
      const live = liveSession((log) => {
        thought(log, "r1");
        step(log, "t1");
        answer(log, "a1", "第一段回复");
        log.message("msg_s1", "steer", "再补一点", USER, "run_1");
        step(log, "t2");
        answer(log, "a2", "第二段回复");
      });
      render(live);
      expect(host.querySelectorAll(".turn-head")).toHaveLength(2);
    });

    it("只有新出现的行带淡入标记：一开始就在的、以及已有行的重绘，都不再播", () => {
      const live = liveSession((log) => step(log, "t1"));
      render(live);
      const entering = (): Element[] => [...host.querySelectorAll(".timeline-inner [data-enter]")].filter((node) => !node.classList.contains("live-line"));
      expect(entering()).toHaveLength(0);

      answer(live.log, "a1", "好了");
      render(live);
      const fresh = entering();
      expect(fresh).toHaveLength(1);
      expect(fresh[0]?.classList.contains("msg--assistant")).toBe(true);

      // 同一行里内容继续变（流式），标记保持，不会被中途摘掉。
      live.log.push({ kind: "assistant.delta", data: { itemId: "a1", text: "，再补一句", phase: "final" } }, { runId: "run_1" });
      render(live);
      expect(entering()).toHaveLength(1);
    });

    it("没有任何记录也没有实时状态时：只有一句“还没有任何事件”，不写“0 条记录”", () => {
      const log = new EventLog("ses_t");
      log.created({ harness: "pi" });
      log.push({ kind: "session.status", data: { status: "idle" } }, { source: "ensemble" });
      const state = replay(log.events)!;
      act(() => {
        root.render(<Timeline state={state} rev={state.seq} summary={toSummary(state)} />);
      });
      expect(host.querySelector(".timeline-empty")?.textContent).toBe("还没有任何事件。");
      expect(host.querySelector(".timeline-count")).toBeNull();
      expect(host.textContent).not.toContain("0 条记录");
    });
  });
});

describe("时间线末尾的实时状态", () => {
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

  const render = (state: SessionState): void => {
    act(() => {
      root.render(<Timeline state={state} rev={state.seq} summary={toSummary(state)} />);
    });
  };
  const line = (): HTMLElement | null => host.querySelector<HTMLElement>(".live-line");

  it("正在连接执行端：转圈和一句话，没有计时（运行还没开始就不编造耗时）", () => {
    const log = new EventLog("ses_t");
    log.created({ harness: "pi" });
    log.message("msg_1", "task", "做点什么");
    render(replay(log.events)!);
    expect(line()?.querySelector(".spinner")).not.toBeNull();
    expect(line()?.querySelector(".live-text")?.textContent).toBe("正在连接执行端");
    expect(line()?.querySelector(".live-clock")).toBeNull();
    expect(line()?.getAttribute("role")).toBe("status");
  });

  it("等并发名额：没有任何东西在运行，所以不转圈，只放一个静止的钟，也没有计时", () => {
    const log = new EventLog("ses_t");
    log.created({ harness: "pi" });
    log.message("msg_1", "task", "做点什么");
    log.run("run_1", 1, "msg_1");
    log.push({ kind: "session.status", data: { status: "queued" } }, { source: "ensemble" });
    render(replay(log.events)!);
    expect(line()?.hasAttribute("data-waiting")).toBe(true);
    expect(line()?.querySelector(".spinner")).toBeNull();
    expect(line()?.querySelector("svg")).not.toBeNull();
    expect(line()?.querySelector(".live-text")?.textContent).toBe("等待并发名额");
    expect(line()?.querySelector(".live-clock")).toBeNull();
  });

  it("正在用工具：只说在做哪一类事和运行了多久，不重复步骤行里的命令或路径", () => {
    const live = liveSession((log) => log.tool("run_1", "call_1", "running", { category: "shell", title: "npm run test:unit" }));
    render(live.state);
    expect(line()?.querySelector(".live-text")?.textContent).toBe("运行");
    expect(line()?.textContent).not.toContain("npm run test:unit");
    expect(line()?.querySelector(".live-clock")?.textContent).toMatch(/^\d+(:\d{2}){1,2}$/);
    // 命令本身在上面那一步的行里。
    expect(host.querySelector(".tool-title")?.textContent).toBe("npm run test:unit");
  });
});
