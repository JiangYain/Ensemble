import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog, USER, testOrigin } from "@shared/testing";
import { store } from "../lib/app";
import { Focus } from "./Focus";

it("shows only model and effort beneath the title and omits the native badge", () => {
  const log = new EventLog("ses_focus");
  log.created({
    harness: "cursor",
    runtime: "native",
    access: "read_only",
    model: { label: "DeepSeek V4.1 Flash 1017" },
    effort: "low",
  });
  const state = replay(log.events);
  if (!state) throw new Error("missing session state");
  const summary = toSummary(state);
  const previous = store.get();
  store.set({ sessions: { [summary.id]: summary }, detail: { id: summary.id, state, rev: 0, loading: false }, lang: "zh" });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(<Focus id={summary.id} />));
    const chips = [...host.querySelectorAll(".head-chips .chip")].map((chip) => chip.textContent);
    expect(chips).toEqual(["DeepSeek V4.1 Flash 1017", "low"]);
    expect(host.querySelector(".head-chips")?.textContent).not.toContain("只读");
    expect(host.textContent).not.toContain("原生接入");
  } finally {
    act(() => root.unmount());
    host.remove();
    store.set(previous);
    vi.unstubAllGlobals();
  }
});

it("keeps the effort badge in the executor's raw value under a Chinese UI, while its tooltip and the rest of the header stay translated", () => {
  const log = new EventLog("ses_focus_effort");
  log.created({
    harness: "cursor",
    runtime: "native",
    model: { label: "DeepSeek V4.1 Flash 1017" },
    effort: "high",
  });
  const state = replay(log.events);
  if (!state) throw new Error("missing session state");
  const summary = toSummary(state);
  const previous = store.get();
  store.set({ sessions: { [summary.id]: summary }, detail: { id: summary.id, state, rev: 0, loading: false }, lang: "zh" });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(<Focus id={summary.id} />));
    const chips = [...host.querySelectorAll<HTMLElement>(".head-chips .chip")];
    // 中文界面里档位徽标仍然写执行端的英文短值，不翻译成「高」。
    expect(chips.map((chip) => chip.textContent)).toEqual(["DeepSeek V4.1 Flash 1017", "high"]);
    const effortChip = chips[1]!;
    expect(effortChip.textContent).toBe("high");
    expect(effortChip.textContent).not.toBe("高");
    // 徽标本身之外，界面文字仍跟随语言。
    expect(effortChip.getAttribute("data-tip")).toBe("推理强度");
    expect(chips[0]!.getAttribute("data-tip")).toBe("模型");
    expect(host.querySelector(".head-top .btn--back")?.textContent).toBe("全部会话");
  } finally {
    act(() => root.unmount());
    host.remove();
    store.set(previous);
    vi.unstubAllGlobals();
  }
});

it("hides the effort badge when the executor reported no effort value", () => {
  const log = new EventLog("ses_focus_no_effort");
  log.created({ harness: "cursor", runtime: "native", model: { label: "DeepSeek V4.1 Flash 1017" } });
  const state = replay(log.events);
  if (!state) throw new Error("missing session state");
  const summary = toSummary(state);
  const previous = store.get();
  store.set({ sessions: { [summary.id]: summary }, detail: { id: summary.id, state, rev: 0, loading: false }, lang: "zh" });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(<Focus id={summary.id} />));
    expect([...host.querySelectorAll(".head-chips .chip")].map((chip) => chip.textContent)).toEqual(["DeepSeek V4.1 Flash 1017"]);
  } finally {
    act(() => root.unmount());
    host.remove();
    store.set(previous);
    vi.unstubAllGlobals();
  }
});

it("in the narrow layout, clicking a message record on the summary tab switches back to the timeline and scrolls to that message", () => {
  const log = new EventLog("ses_narrow");
  log.created({ harness: "cursor" });
  log.message("msg_task", "task", "请只读走查当前项目。");
  const steer = log.message("msg_steer", "steer", "不要改任何文件。", USER);
  const state = replay(log.events);
  if (!state) throw new Error("missing session state");
  const summary = toSummary(state);
  const previous = store.get();
  store.set({ sessions: { [summary.id]: summary }, detail: { id: summary.id, state, rev: 0, loading: false }, lang: "zh" });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const scrollTo = vi.fn();
  const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTo");
  Object.defineProperty(Element.prototype, "scrollTo", { value: scrollTo, configurable: true, writable: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(<Focus id={summary.id} />));
    // 测试环境里没有版面宽度，会落在窄屏布局。
    expect(host.querySelector(".focus")?.getAttribute("data-mode")).toBe("narrow");

    const tab = (name: string): HTMLButtonElement => [...host.querySelectorAll<HTMLButtonElement>(".tabs button")].find((button) => button.textContent === name)!;
    act(() => tab("概览").click());
    expect(host.querySelector(".timeline-scroll")).toBeNull();
    expect(tab("概览").hasAttribute("data-active")).toBe(true);

    const record = [...host.querySelectorAll<HTMLButtonElement>(".msg-log-head")][1]!;
    scrollTo.mockClear();
    act(() => record.click());

    expect(tab("进展").hasAttribute("data-active")).toBe(true);
    expect(host.querySelector(".msg-log")).toBeNull();
    const target = host.querySelector(`[data-message-id="${steer.id}"]`);
    expect(target).not.toBeNull();
    expect(target!.hasAttribute("data-flash")).toBe(true);
    expect(scrollTo.mock.calls.filter(([arg]) => (arg as { behavior?: string }).behavior === "smooth")).toHaveLength(1);
  } finally {
    act(() => root.unmount());
    host.remove();
    store.set(previous);
    vi.unstubAllGlobals();
    if (original) Object.defineProperty(Element.prototype, "scrollTo", original);
    else delete (Element.prototype as { scrollTo?: unknown }).scrollTo;
  }
});

it("layout mode follows the real width of the page: >=1160 three columns, >=800 medium, otherwise tabs; and switches when the width changes", () => {
  const log = new EventLog("ses_mode");
  log.created({ harness: "cursor" });
  const state = replay(log.events);
  if (!state) throw new Error("missing session state");
  const summary = toSummary(state);
  const previous = store.get();
  store.set({ sessions: { [summary.id]: summary }, detail: { id: summary.id, state, rev: 0, loading: false }, lang: "zh" });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // 测试环境里没有版面：用假的宽度，并让观察器可以手动触发。
  let width = 1200;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("focus") ? width : 0;
    },
  });
  const notify: Array<() => void> = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        notify.push(callback);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(<Focus id={summary.id} />));
    const mode = (): string | null | undefined => host.querySelector(".focus")?.getAttribute("data-mode");
    expect(mode()).toBe("wide");
    expect(host.querySelector(".tabs")).toBeNull();

    for (const [next, expected] of [
      [1160, "wide"],
      [1159, "medium"],
      [800, "medium"],
      [799, "narrow"],
      [360, "narrow"],
    ] as const) {
      width = next;
      act(() => {
        for (const callback of notify) callback();
      });
      expect(mode(), `width ${next}`).toBe(expected);
    }
    expect(host.querySelector(".tabs")).not.toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
    store.set(previous);
    vi.unstubAllGlobals();
    delete (HTMLElement.prototype as { clientWidth?: unknown }).clientWidth;
  }
});

it("the header subtitle is a one-line plain-text summary of the executor's last reply: fences and inline marks are removed, nothing is added", () => {
  const log = new EventLog("ses_focus_sub");
  log.created({ harness: "cursor", runtime: "native" });
  const message = log.message("msg_1", "task", "请重构解析器。");
  log.run("run_1", 1, message.id);
  log.startRun("run_1");
  log.push({ kind: "assistant.delta", data: { itemId: "a1", text: "```ts\nexport class ParseError extends Error {}\n```\n\n详见[这次提交](https://example.com/c/1)，**旧的** `parseLegacy` 仍保留。", phase: "final" } }, { runId: "run_1" });
  log.push({ kind: "assistant.completed", data: { itemId: "a1" } }, { runId: "run_1" });
  log.push({ kind: "run.completed", data: { stopReason: "end_turn" } }, { runId: "run_1" });
  log.push({ kind: "session.status", data: { status: "idle" } }, { source: "ensemble" });
  const state = replay(log.events);
  if (!state) throw new Error("missing session state");
  const summary = toSummary(state);
  const previous = store.get();
  store.set({ sessions: { [summary.id]: summary }, detail: { id: summary.id, state, rev: 0, loading: false }, lang: "zh" });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(<Focus id={summary.id} />));
    const text = host.querySelector(".head-activity-text")?.textContent;
    expect(text).toBe("export class ParseError extends Error {} 详见这次提交，旧的 parseLegacy 仍保留。");
    expect(text).not.toMatch(/[`*[\]]/);
  } finally {
    act(() => root.unmount());
    host.remove();
    store.set(previous);
    vi.unstubAllGlobals();
  }
});

it("Esc 返回总览；设置窗口开着时不响应（这一下 Esc 属于设置窗口），关上后恢复", () => {
  const log = new EventLog("ses_focus_esc");
  log.created({ harness: "cursor", runtime: "native" });
  const state = replay(log.events);
  if (!state) throw new Error("missing session state");
  const summary = toSummary(state);
  const previous = store.get();
  const session = `#/s/${summary.id}`;
  location.hash = session;
  store.set({ sessions: { [summary.id]: summary }, detail: { id: summary.id, state, rev: 0, loading: false }, lang: "zh", settings: { open: false, section: undefined } });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const escape = (): void => {
    act(() => void document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  };
  try {
    act(() => root.render(<Focus id={summary.id} />));

    store.set({ settings: { open: true, section: undefined } });
    escape();
    expect(location.hash).toBe(session);

    store.set({ settings: { open: false, section: undefined }, switcherOpen: true });
    escape();
    expect(location.hash).toBe(session);

    store.set({ switcherOpen: false });
    escape();
    // 聚焦页返回到该会话所属 Main Agent 的独立画布。
    expect(location.hash).toBe(`#/m/${encodeURIComponent(summary.origin.key)}`);
  } finally {
    act(() => root.unmount());
    host.remove();
    location.hash = "";
    store.set(previous);
    vi.unstubAllGlobals();
  }
});

it("marks a session reference the agent declared itself right in the header, and not one the host provided", () => {
  const ID = "4706e0d9-12d7-4b10-a784-5d3416b186a9";
  const headOrigin = (source: "declared" | "mcp-meta"): { text: string; tip: string | null; refs: string[] } => {
    const log = new EventLog("ses_focus_origin");
    log.created({ origin: testOrigin({ key: `cursor:${ID}`, host: "cursor", hostLabel: "Cursor", sessionRef: { id: ID, kind: "conversation", source } }) });
    const state = replay(log.events);
    if (!state) throw new Error("missing session state");
    const summary = toSummary(state);
    const previous = store.get();
    store.set({ sessions: { [summary.id]: summary }, detail: { id: summary.id, state, rev: 0, loading: false }, lang: "zh" });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() => root.render(<Focus id={summary.id} />));
      const head = host.querySelector<HTMLElement>(".head-origin")!;
      return { text: head.textContent ?? "", tip: head.getAttribute("data-tip"), refs: [...head.querySelectorAll(".head-origin-ref")].map((el) => el.textContent ?? "") };
    } finally {
      act(() => root.unmount());
      host.remove();
      store.set(previous);
      vi.unstubAllGlobals();
    }
  };

  const declared = headOrigin("declared");
  expect(declared.refs).toEqual([ID.slice(0, 10), "由 Agent 自报"]);
  expect(declared.tip).toContain(ID);
  expect(declared.tip).toContain("Ensemble 无法核对");

  const fromHost = headOrigin("mcp-meta");
  expect(fromHost.refs).toEqual([ID.slice(0, 10)]);
  expect(fromHost.text).not.toContain("自报");
  expect(fromHost.tip).toBe(`Cursor · ${ID}`);
});