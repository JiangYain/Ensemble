import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replay, toSummary } from "@shared/projection";
import type { GitResponse, GitSnapshot } from "@shared/protocol";
import { EventLog, testOrigin } from "@shared/testing";
import type { SessionPhase, SessionSummary } from "@shared/types";
import { api } from "../lib/api";
import { COLLAPSED_ORIGINS_KEY, expandAllOrigins, setHideIdle, setLang, setOriginCollapsed, store } from "../lib/app";
import { EXIT_MS } from "../lib/useWorkView";
import { SceneEngine } from "../scene/engine";
import type { SceneLayout } from "../scene/layout";
import { Overview } from "./Overview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 画布上的“隐藏某个 Main Agent 的相关节点”：它名下的会话（含嵌套的）与只为它服务的 Folder / Git 卡收起，
 * 来源卡自己留下当入口；离场先淡出；来源卡上的数字仍是真实的；偏好只在本浏览器，不改任何会话。
 */

const W = "C:\\Users\\alice\\Desktop\\Ensemble";
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const A = "codex:a";
const B = "cursor:b";

function snapshot(root: string): GitSnapshot {
  return {
    root,
    branch: "main",
    detached: false,
    head: { sha: SHA, subject: "feat: node", committedAt: new Date(2026, 0, 2, 9, 5).toISOString() },
    changes: { files: 2, staged: 0, unstaged: 2, untracked: 0, conflicted: 0 },
    checkedAt: new Date().toISOString(),
  };
}

let seq = 0;
function make(id: string, phase: SessionPhase, extra: { origin?: string; parent?: string; workspace?: string } = {}): SessionSummary {
  seq += 1;
  const log = new EventLog(id);
  log.created({
    id,
    title: `任务 ${id}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    origin: testOrigin({ key: extra.origin ?? A, ...(extra.workspace ? { workspace: extra.workspace } : {}) }),
    ...(extra.parent ? { parentSessionId: extra.parent } : {}),
  });
  return { ...toSummary(replay(log.events)!), phase };
}

describe("Overview · 隐藏 Main Agent 的相关节点", () => {
  const previous = store.get();
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    seq = 0;
    setLang("zh");
    localStorage.removeItem(COLLAPSED_ORIGINS_KEY);
    localStorage.removeItem("ensemble.canvas.positions.v1");
    store.set({ sessions: {}, hideIdle: false, ready: true, collapsedOrigins: new Set() });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // 每个目录各是各的工作树：只有同一个目录的来源才共用 Git 卡。
    vi.spyOn(api, "git").mockImplementation(async (path): Promise<GitResponse> => ({ path, git: snapshot(path) }));
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1280 });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    store.set({ sessions: previous.sessions, hideIdle: false, collapsedOrigins: new Set() });
    localStorage.removeItem(COLLAPSED_ORIGINS_KEY);
    localStorage.removeItem("ensemble.canvas.positions.v1");
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)["clientWidth"];
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)["clientHeight"];
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const flush = async (): Promise<void> => {
    await act(async () => {
      for (let tick = 0; tick < 6; tick++) await Promise.resolve();
    });
  };
  const advance = async (ms: number): Promise<void> => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
    await flush();
  };
  const open = (...list: SessionSummary[]): void => {
    act(() => store.set({ sessions: Object.fromEntries(list.map((item) => [item.id, item])) }));
  };
  const ids = (selector: string): string[] => [...container.querySelectorAll<HTMLElement>(selector)].map((el) => el.dataset["nodeId"]!).sort();
  const agents = (): string[] => ids(".node.agent");
  const origins = (): string[] => ids(".node.origin");
  const leaving = (): string[] => ids("[data-leaving]");
  const nodeEl = (id: string): HTMLElement | null => container.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
  const srText = (): string => [...container.querySelectorAll(".sr-only[aria-live]")].map((el) => el.textContent).join("|");

  const mount = async (engine = new SceneEngine()) => {
    const setLayout = vi.spyOn(engine, "setLayout");
    act(() => root.render(<Overview engine={engine} />));
    await flush();
    await advance(800);
    return { engine, setLayout, layout: (): SceneLayout => setLayout.mock.lastCall![0] };
  };
  const expectPageMatches = (layout: SceneLayout): void => {
    const page = [...container.querySelectorAll("[data-node-id]")].map((el) => el.getAttribute("data-node-id")!).sort();
    expect(page).toEqual(layout.nodes.map((node) => node.id).sort());
  };

  /** A：运行中 + 已完成 + 一个挂在已完成下面的嵌套会话；B：一个运行中。A、B 在不同目录。 */
  const fixture = (): SessionSummary[] => [
    make("a-run", "running", { workspace: W }),
    make("a-done", "done", { workspace: W }),
    make("a-kid", "running", { parent: "a-done", workspace: W }),
    make("b-run", "running", { origin: B, workspace: "C:\\other" }),
  ];

  it("没隐藏时：与以前一样，所有会话与来源都在，来源卡上没有隐藏标记，也没有 data-leaving", async () => {
    open(...fixture());
    const { layout } = await mount();
    expect(agents()).toHaveLength(4);
    expect(origins()).toEqual([`origin:${A}`, `origin:${B}`]);
    expect(container.querySelectorAll("[data-collapsed]")).toHaveLength(0);
    expect(leaving()).toEqual([]);
    expectPageMatches(layout());
  });

  describe("隐藏一个 Main Agent", () => {
    it("它名下的会话（含嵌套的）先淡出再离场；来源卡自己不淡出、一直留着，并立刻显示成隐藏状态", async () => {
      open(...fixture());
      await mount();
      act(() => setOriginCollapsed(A, true));
      // 此刻：来源卡已经是隐藏状态（反馈是即时的），会话还在、正在淡出，来源卡不淡出。
      expect(nodeEl(`origin:${A}`)?.hasAttribute("data-collapsed")).toBe(true);
      expect(leaving()).toEqual(expect.arrayContaining(["agent:a-run", "agent:a-done", "agent:a-kid"]));
      expect(leaving()).not.toContain(`origin:${A}`);
      expect(agents()).toHaveLength(4);

      await advance(EXIT_MS + 60);
      expect(agents()).toEqual(["agent:b-run"]);
      expect(origins()).toEqual([`origin:${A}`, `origin:${B}`]);
      expect(leaving()).toEqual([]);
      expect(nodeEl(`origin:${B}`)?.hasAttribute("data-collapsed")).toBe(false);
    });

    it("只为它服务的 Folder 与 Git 卡一起收起；来源卡自己写目录行（Folder 节点没有了，目录信息不丢）；别的来源的卡照旧", async () => {
      open(...fixture());
      const { layout } = await mount();
      expect(ids(".node.folder")).toHaveLength(2);
      expect(ids(".node.git")).toHaveLength(2);
      act(() => setOriginCollapsed(A, true));
      await advance(EXIT_MS + 60);
      expect(layout().folders.map((folder) => folder.path)).toEqual(["C:\\other"]);
      expect(ids(".node.folder")).toHaveLength(1);
      expect(ids(".node.git")).toHaveLength(1);
      expect(nodeEl(`origin:${A}`)?.querySelector(".o-main .o-text")?.textContent).toBe("Ensemble");
      expectPageMatches(layout());
    });

    it("淡出时 Folder / Git 卡跟着会话一起淡出，不是等布局收起时突然消失", async () => {
      open(...fixture());
      await mount();
      act(() => setOriginCollapsed(A, true));
      const gone = leaving();
      expect(gone.some((id) => id.startsWith("folder:"))).toBe(true);
      expect(gone.some((id) => id.startsWith("git:"))).toBe(true);
      // B 的 Folder / Git 不在其中：它们还在为 B 服务。
      expect(gone.filter((id) => id.startsWith("folder:"))).toHaveLength(1);
      expect(gone.filter((id) => id.startsWith("git:"))).toHaveLength(1);
    });

    it("来源卡上的数字仍是真实的（3 个会话 · 2 个运行中），头部是“显示”按钮，提示写明收起了几个", async () => {
      open(...fixture());
      await mount();
      act(() => setOriginCollapsed(A, true));
      await advance(EXIT_MS + 60);
      const button = nodeEl(`origin:${A}`)!.querySelector<HTMLButtonElement>("button.o-expand")!;
      expect(button.textContent).toBe("3");
      expect(button.getAttribute("data-tip")).toBe("相关节点已隐藏 · 3 个会话 · 2 个运行中\n点击或右键显示");
      expect(button.querySelector("i.a-run")).not.toBeNull();
    });

    it("读屏的提示与画面一致：显示几个、收起几个（收起的不都是“未在工作的”，所以只说已隐藏）", async () => {
      open(...fixture());
      await mount();
      expect(srText()).toContain("画布上有 4 个会话");
      act(() => setOriginCollapsed(A, true));
      await advance(EXIT_MS + 60);
      expect(srText()).toContain("画布上显示 1 个会话，另有 3 个已隐藏");
      expect(srText()).not.toContain("未在工作");
    });

    it("点来源卡上的“显示”标记：会话回来，来源卡恢复，偏好同步清掉", async () => {
      open(...fixture());
      await mount();
      act(() => setOriginCollapsed(A, true));
      await advance(EXIT_MS + 60);
      act(() => nodeEl(`origin:${A}`)!.querySelector<HTMLButtonElement>("button.o-expand")!.click());
      await advance(100);
      expect(agents()).toHaveLength(4);
      expect(container.querySelectorAll("[data-collapsed]")).toHaveLength(0);
      expect(JSON.parse(localStorage.getItem(COLLAPSED_ORIGINS_KEY)!)).toEqual([]);
      expect(ids(".node.folder")).toHaveLength(2);
    });

    it("回来的会话不被当成新到的节点：回到隐藏之前的位置（引擎靠 layout.hidden 分清）", async () => {
      open(...fixture());
      const { layout } = await mount();
      const before = new Map(layout().nodes.map((node) => [node.id, { x: node.x, y: node.y }]));
      act(() => setOriginCollapsed(A, true));
      await advance(EXIT_MS + 60);
      expect([...(layout().hidden ?? [])].sort()).toEqual(["agent:a-done", "agent:a-kid", "agent:a-run"]);
      act(() => setOriginCollapsed(A, false));
      await advance(200);
      for (const node of layout().nodes) expect({ id: node.id, x: node.x, y: node.y }).toEqual({ id: node.id, ...before.get(node.id)! });
    });

    it("全部 Main Agent 都隐藏了：不是“都收起了”的空状态，画布上有每个来源的一张卡", async () => {
      open(...fixture());
      await mount();
      act(() => {
        setOriginCollapsed(A, true);
        setOriginCollapsed(B, true);
      });
      await advance(EXIT_MS + 60);
      expect(agents()).toEqual([]);
      expect(origins()).toEqual([`origin:${A}`, `origin:${B}`]);
      expect(container.querySelector(".empty")).toBeNull();
      expect(ids(".node.folder")).toEqual([]);
      act(() => expandAllOrigins());
      await advance(200);
      expect(agents()).toHaveLength(4);
    });

    it("新委派落在被隐藏的 Main Agent 名下：新会话不出现（隐藏是用户的决定），卡上的数字与运行指示如实增加", async () => {
      open(...fixture());
      await mount();
      act(() => setOriginCollapsed(A, true));
      await advance(EXIT_MS + 60);
      act(() => store.set((state) => ({ sessions: { ...state.sessions, "a-new": make("a-new", "running", { workspace: W }) } })));
      await advance(100);
      expect(agents()).toEqual(["agent:b-run"]);
      expect(nodeEl(`origin:${A}`)!.querySelector("button.o-expand")?.textContent).toBe("4");
      expect(nodeEl(`origin:${A}`)!.querySelector("button.o-expand")?.getAttribute("data-tip")).toContain("4 个会话 · 3 个运行中");
    });

    it("隐藏的来源已经没有会话（会话都被删了）：画布上没有它，偏好里残留的记录也不会凭空画出一张卡", async () => {
      act(() => store.set({ collapsedOrigins: new Set(["ghost:x"]) }));
      open(...fixture());
      const { layout } = await mount();
      expect(origins()).toEqual([`origin:${A}`, `origin:${B}`]);
      expect(agents()).toHaveLength(4);
      expectPageMatches(layout());
    });

    it("读偏好：浏览器里存着的隐藏名单在打开页面时就生效，首次排布不做离场动画", async () => {
      act(() => store.set({ collapsedOrigins: new Set([A]) }));
      open(...fixture());
      const { layout } = await mount();
      expect(agents()).toEqual(["agent:b-run"]);
      expect(origins()).toEqual([`origin:${A}`, `origin:${B}`]);
      expect(leaving()).toEqual([]);
      expectPageMatches(layout());
    });
  });

  describe("与“隐藏未在工作的会话”叠加", () => {
    it("两个都开：被隐藏的来源只剩卡片；没被隐藏的来源仍只留工作中的会话", async () => {
      open(
        make("a-run", "running", { workspace: W }),
        make("b-run", "running", { origin: B, workspace: "C:\\other" }),
        make("b-done", "done", { origin: B, workspace: "C:\\other" }),
      );
      act(() => store.set({ collapsedOrigins: new Set([A]) }));
      act(() => setHideIdle(true));
      const { layout } = await mount();
      expect(agents()).toEqual(["agent:b-run"]);
      expect(origins()).toEqual([`origin:${A}`, `origin:${B}`]);
      expectPageMatches(layout());
      // 关掉“只看工作中”：B 的已完成会话回来；A 仍然隐藏。
      act(() => setHideIdle(false));
      await advance(200);
      expect(agents()).toEqual(["agent:b-done", "agent:b-run"]);
      expect(nodeEl(`origin:${A}`)?.hasAttribute("data-collapsed")).toBe(true);
    });

    it("“只看工作中”把所有会话都收起、但有来源被隐藏着（只剩它那张卡）：不显示“现在没有正在工作的会话”", async () => {
      open(make("a-run", "running", { workspace: W }), make("b-done", "done", { origin: B }));
      act(() => store.set({ collapsedOrigins: new Set([A]) }));
      act(() => setHideIdle(true));
      await mount();
      expect(origins()).toEqual([`origin:${A}`]);
      expect(container.querySelector(".empty[data-idle]")).toBeNull();
    });
  });
});
