import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang, store } from "../lib/app";
import { contextMenuNode } from "../lib/contextMenu";
import { agentNodeId } from "../scene/layout";
import { MENU_SIZE, NODE_RECT, contextmenu, itemNamed, menuEl, mountScene, press, sessionsFixture, summaryOf, type Scene } from "./NodeContextMenu.fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 画布节点右键菜单的测试之三：多选菜单里的批量动作（复制 ID、中断、关闭会话、删除记录）——数量与不可用的原因、确认框、请求与结果的如实汇总。
// 单个会话节点在 NodeContextMenu.test.tsx，多选与排列在 NodeContextMenu.multi.test.tsx；共用的夹具在 NodeContextMenu.fixtures.tsx。

describe("画布节点的右键菜单", () => {
  let scene: Scene;
  let writeText: ReturnType<typeof vi.fn>;
  const sizes = { width: window.innerWidth, height: window.innerHeight };

  const setViewport = (width: number, height: number): void => {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
    Object.defineProperty(window, "innerHeight", { value: height, configurable: true, writable: true });
  };

  beforeEach(() => {
    setLang("zh");
    localStorage.clear();
    store.set({ toasts: [], confirm: undefined });
    setViewport(1200, 800);
    writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    // 菜单按布局尺寸摆位置（包围盒在入场动画起点是缩小的，见 Menu.tsx）。
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("menu") ? MENU_SIZE.width : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("menu") ? MENU_SIZE.height : 0;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("menu")) return DOMRect.fromRect({ x: 0, y: 0, width: MENU_SIZE.width * 0.98, height: MENU_SIZE.height * 0.98 });
      const id = this.dataset["nodeId"];
      if (id) {
        const order = [...document.querySelectorAll("[data-node-id]")].indexOf(this);
        return DOMRect.fromRect(NODE_RECT(Math.max(0, order)));
      }
      return DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
    });
    scene = mountScene(sessionsFixture());
  });

  afterEach(() => {
    scene.dispose();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    store.set({ sessions: {}, toasts: [], confirm: undefined });
    contextMenuNode.set({ nodeId: undefined });
    setViewport(sizes.width, sizes.height);
  });

  // ───────────── 批量动作 ─────────────

  const select = (...ids: string[]): void => {
    act(() => {
      for (const id of ids) scene.engine.toggleSelection(id);
    });
  };
  const run = agentNodeId("ses_run");
  const done = agentNodeId("ses_done");
  const stopped = agentNodeId("ses_stop");
  const queued = agentNodeId("ses_queue");

  const respond = (handler: (method: string, path: string) => { status?: number; body: unknown }) => {
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      const result = handler(init?.method ?? "GET", path);
      const status = result.status ?? 200;
      return { ok: status < 400, status, text: async () => JSON.stringify(result.body) };
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };
  const settled = async (): Promise<void> => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const toasts = () => store.get().toasts;

  it("会话组的项带着数量，只统计可用的那几个；不可用的有原因", () => {
    select(run, done, stopped, "origin:o");
    contextmenu(scene.node("ses_run"));
    expect(itemNamed(/^复制会话 ID/).textContent).toBe("复制会话 ID（3 个）");
    // 运行中 1 个有运行。
    expect(itemNamed(/^中断当前运行/).textContent).toBe("中断当前运行（1 个）");
    // 已关闭的那个不能再关闭。
    expect(itemNamed(/^关闭会话/).textContent).toBe("关闭会话（2 个）");
    // 运行中的不能删。
    expect(itemNamed(/^删除记录/).textContent).toBe("删除记录（2 个）");
    expect(itemNamed(/^删除记录/).hasAttribute("data-danger")).toBe(true);
    press("Escape");

    act(() => scene.engine.clearSelection());
    select(done, stopped, "origin:o");
    contextmenu(scene.node("ses_done"));
    expect(itemNamed(/^中断当前运行/).getAttribute("aria-disabled")).toBe("true");
    expect(itemNamed(/^中断当前运行/).getAttribute("data-tip")).toBe("选中的会话里没有正在进行的运行");
    press("Escape");
  });

  it("全部不可用时整项不可用并写明原因：全是运行中不能删、全已关闭不能再关", () => {
    select(run, queued);
    contextmenu(scene.node("ses_run"));
    expect(itemNamed(/^删除记录/).getAttribute("aria-disabled")).toBe("true");
    expect(itemNamed(/^删除记录/).getAttribute("data-tip")).toBe("选中的会话都在运行中，不能删除，请先中断并关闭。");
    act(() => itemNamed(/^删除记录/).click());
    expect(store.get().confirm).toBeUndefined();
    press("Escape");

    act(() => scene.engine.clearSelection());
    select(stopped, done);
    act(() => scene.engine.toggleSelection(done));
    select("origin:o");
    contextmenu(scene.node("ses_stop"));
    expect(itemNamed(/^关闭会话/).getAttribute("aria-disabled")).toBe("true");
    expect(itemNamed(/^关闭会话/).getAttribute("data-tip")).toBe("选中的会话都已经关闭");
  });

  it("复制 ID：多个用换行连接，按选中的先后", async () => {
    select(done, run, stopped);
    contextmenu(scene.node("ses_run"));
    act(() => itemNamed(/^复制会话 ID/).click());
    await settled();
    expect(writeText).toHaveBeenCalledWith("ses_done\nses_run\nses_stop");
    expect(toasts().at(-1)).toMatchObject({ tone: "success", text: "已复制" });
  });

  it("中断当前运行：只对有运行的会话调用同一个接口，结果如实汇总", async () => {
    select(run, queued, done);
    const calls: string[] = [];
    respond((method, path) => {
      calls.push(`${method} ${path}`);
      const id = /sessions\/([^/]+)\/cancel/.exec(path)![1]!;
      return { body: { summary: { ...store.get().sessions[id]!, seq: 99 }, interrupted: id === "ses_run", cancelledQueued: 0 } };
    });
    contextmenu(scene.node("ses_run"));
    expect(itemNamed(/^中断当前运行/).textContent).toBe("中断当前运行（2 个）");
    act(() => itemNamed(/^中断当前运行/).click());
    await settled();
    expect(calls.sort()).toEqual(["POST /api/sessions/ses_queue/cancel", "POST /api/sessions/ses_run/cancel"]);
    // 一个真的中断了，另一个请求发出时已经没有可中断的：不假装都成功。
    expect(toasts().at(-1)).toMatchObject({ tone: "success", text: "中断当前运行：1 个已完成，1 个当时已没有可中断的运行" });
  });

  it("关闭会话：先确认（写明影响几个、其中几个在工作、几个已关闭不受影响），确认后只对可用的执行", async () => {
    select(run, done, stopped);
    const calls: string[] = [];
    respond((method, path) => {
      calls.push(`${method} ${path}`);
      const id = /sessions\/([^/]+)\/stop/.exec(path)![1]!;
      return { body: { summary: { ...store.get().sessions[id]!, phase: "stopped", status: "stopped", seq: 99 } } };
    });
    contextmenu(scene.node("ses_run"));
    act(() => itemNamed(/^关闭会话/).click());
    const confirm = store.get().confirm!;
    expect(confirm.title).toBe("关闭这 2 个会话？");
    expect(confirm.body).toBe("这些会话会从执行端断开，之后不能再发送消息；已有记录会保留。其中 1 个正在工作：会先中断当前运行，再断开会话。另有 1 个已经关闭，不受影响。");
    expect(confirm.confirmLabel).toBe("关闭 2 个会话");
    expect(confirm.tone).not.toBe("danger");
    expect(calls).toEqual([]);

    await act(async () => {
      await confirm.onConfirm();
    });
    expect(calls.sort()).toEqual(["POST /api/sessions/ses_done/stop", "POST /api/sessions/ses_run/stop"]);
    expect(store.get().sessions["ses_run"]!.status).toBe("stopped");
    expect(toasts().at(-1)).toMatchObject({ tone: "success", text: "关闭会话：2 个已完成" });
  });

  it("部分失败时如实反馈：成功几个、失败几个、失败的原因；全部失败是错误提示", async () => {
    select(run, done);
    respond((_method, path) => {
      const id = /sessions\/([^/]+)\/stop/.exec(path)![1]!;
      if (id === "ses_done") return { status: 409, body: { error: { code: "conflict", message: "执行端没有响应" } } };
      return { body: { summary: { ...store.get().sessions[id]!, phase: "stopped", status: "stopped", seq: 99 } } };
    });
    contextmenu(scene.node("ses_run"));
    act(() => itemNamed(/^关闭会话/).click());
    await act(async () => {
      await store.get().confirm!.onConfirm();
    });
    const partial = toasts().at(-1)!;
    expect(partial.tone).toBe("warn");
    expect(partial.text).toContain("关闭会话：1 个已完成，1 个失败");
    expect(partial.text).toContain("执行端没有响应");

    // 全部失败。
    store.set({ toasts: [], sessions: sessionsFixture() });
    respond(() => ({ status: 500, body: { error: { code: "internal", message: "boom" } } }));
    contextmenu(scene.node("ses_run"));
    act(() => itemNamed(/^关闭会话/).click());
    await act(async () => {
      await store.get().confirm!.onConfirm();
    });
    expect(toasts().at(-1)).toMatchObject({ tone: "error" });
    expect(toasts().at(-1)!.text).toContain("2 个失败");
  });

  it("删除记录：确认框写明将删几条、另有几个运行中不会被删；确认后只删可删的，成功的从画布消失", async () => {
    select(run, done, stopped);
    const calls: string[] = [];
    respond((method, path) => {
      calls.push(`${method} ${path}`);
      return { body: { removed: path.split("/").at(-1) } };
    });
    contextmenu(scene.node("ses_run"));
    act(() => itemNamed(/^删除记录/).click());
    const confirm = store.get().confirm!;
    expect(confirm.title).toBe("删除这 2 条会话记录？");
    expect(confirm.body).toBe("这些会话的全部记录会被永久删除，无法恢复。执行端那边保存的原生会话不受影响。另有 1 个正在运行，不会被删除；请先中断并关闭它们。");
    expect(confirm.confirmLabel).toBe("删除 2 条记录");
    expect(confirm.tone).toBe("danger");
    expect(calls).toEqual([]);

    await act(async () => {
      await confirm.onConfirm();
    });
    expect(calls.sort()).toEqual(["DELETE /api/sessions/ses_done", "DELETE /api/sessions/ses_stop"]);
    expect(Object.keys(store.get().sessions).sort()).toEqual(["ses_queue", "ses_run"]);
    expect(toasts().at(-1)).toMatchObject({ tone: "success", text: "删除记录：2 个已完成" });
  });

  it("确认框开着的时候会话状态变了：执行时按最新状态重新筛选，不会对已经不可用的会话发请求", async () => {
    select(done, stopped);
    const calls: string[] = [];
    respond((method, path) => {
      calls.push(`${method} ${path}`);
      return { body: { removed: path.split("/").at(-1) } };
    });
    contextmenu(scene.node("ses_done"));
    act(() => itemNamed(/^删除记录/).click());
    const confirm = store.get().confirm!;
    // ses_done 又开始运行了。
    act(() => store.set({ sessions: { ...store.get().sessions, ses_done: summaryOf("ses_done", { phase: "running", status: "running", activeRunId: "run_2", seq: 20 }) } }));
    await act(async () => {
      await confirm.onConfirm();
    });
    expect(calls).toEqual(["DELETE /api/sessions/ses_stop"]);
  });

  it("确认框开着的时候，原本运行中（不在删除名单里）的会话结束了：它不会被加进删除集合，确认框承诺删几个就只删几个", async () => {
    select(run, done, stopped);
    const calls: string[] = [];
    respond((method, path) => {
      calls.push(`${method} ${path}`);
      return { body: { removed: path.split("/").at(-1) } };
    });
    contextmenu(scene.node("ses_run"));
    act(() => itemNamed(/^删除记录/).click());
    const confirm = store.get().confirm!;
    expect(confirm.title).toBe("删除这 2 条会话记录？");
    // ses_run 在对话框开着的时候跑完了：现在它本身是可删的，但确认框里没有它。
    act(() => store.set({ sessions: { ...store.get().sessions, ses_run: summaryOf("ses_run", { phase: "done", status: "idle", seq: 20 }) } }));
    await act(async () => {
      await confirm.onConfirm();
    });
    expect(calls.sort()).toEqual(["DELETE /api/sessions/ses_done", "DELETE /api/sessions/ses_stop"]);
    expect(Object.keys(store.get().sessions).sort()).toEqual(["ses_queue", "ses_run"]);
    expect(toasts().at(-1)).toMatchObject({ tone: "success", text: "删除记录：2 个已完成" });
  });

  it("英文界面：多选菜单与确认框使用英文文案与单复数", () => {
    setLang("en");
    select(run, done, stopped);
    contextmenu(scene.node("ses_run"));
    expect(menuEl().getAttribute("aria-label")).toBe("3 nodes selected");
    expect(itemNamed(/^Copy session/).textContent).toBe("Copy session IDs (3)");
    expect(itemNamed(/^Interrupt/).textContent).toBe("Interrupt current run (1)");
    expect(itemNamed(/^Delete/).textContent).toBe("Delete records (2)");
    act(() => itemNamed(/^Close/).click());
    expect(store.get().confirm!.title).toBe("Close these 2 sessions?");
    expect(store.get().confirm!.body).toContain("1 of them is working");
    expect(store.get().confirm!.body).toContain("1 other is already closed");
  });
});
