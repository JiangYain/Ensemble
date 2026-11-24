import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replay, toSummary } from "@shared/projection";
import type { GitResponse, GitSnapshot } from "@shared/protocol";
import { EventLog, testOrigin } from "@shared/testing";
import type { SessionPhase, SessionSummary } from "@shared/types";
import { api } from "../lib/api";
import { HIDE_IDLE_KEY, setHideIdle, setLang, store } from "../lib/app";
import { EXIT_MS, HOLD_POLL_MS } from "../lib/useWorkView";
import { SceneEngine } from "../scene/engine";
import type { SceneLayout } from "../scene/layout";
import { Overview } from "./Overview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 画布上的“隐藏未在工作的会话”：只剩工作中的会话与它们的祖先；来源卡上的总数仍是真实总数；
 * 都不在工作时是专门的空状态；离场先淡出、正被操作的先不收；选中随之同步。
 */

const WORKSPACE = "C:\\Users\\alice\\Desktop\\Ensemble";
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

function snapshot(): GitSnapshot {
  return {
    root: WORKSPACE,
    branch: "main",
    detached: false,
    head: { sha: SHA, subject: "feat: node", committedAt: new Date(2026, 0, 2, 9, 5).toISOString() },
    changes: { files: 2, staged: 0, unstaged: 2, untracked: 0, conflicted: 0 },
    checkedAt: new Date().toISOString(),
  };
}

let seq = 0;
/** 一个会话摘要：按真实的投影造出来，再覆盖相位（造各种相位不必真的跑一遍运行）。 */
function make(id: string, phase: SessionPhase, extra: { origin?: string; parent?: string; workspace?: string } = {}): SessionSummary {
  seq += 1;
  const log = new EventLog(id);
  log.created({
    id,
    title: `任务 ${id}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    origin: testOrigin({ key: extra.origin ?? "codex:a", ...(extra.workspace ? { workspace: extra.workspace } : {}) }),
    ...(extra.parent ? { parentSessionId: extra.parent } : {}),
  });
  return { ...toSummary(replay(log.events)!), phase };
}

describe("Overview · 隐藏未在工作的会话", () => {
  const previous = store.get();
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let wide = true;

  beforeEach(() => {
    seq = 0;
    wide = true;
    setLang("zh");
    localStorage.removeItem(HIDE_IDLE_KEY);
    localStorage.removeItem("ensemble.canvas.positions.v1");
    store.set({ sessions: {}, hideIdle: false });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.spyOn(api, "git").mockImplementation(async (path): Promise<GitResponse> => ({ path, git: snapshot() }));
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => (wide ? 1280 : 480) });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    store.set({ sessions: previous.sessions, hideIdle: false });
    localStorage.removeItem(HIDE_IDLE_KEY);
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
  const originsOnPage = (): string[] => ids(".node.origin");
  const nodeEl = (id: string): HTMLElement | null => container.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
  const leaving = (): string[] => ids("[data-leaving]");
  const srText = (): string => [...container.querySelectorAll(".sr-only[aria-live]")].map((el) => el.textContent).join("|");
  const countTip = (origin: string): string | null | undefined => nodeEl(`origin:${origin}`)?.querySelector(".o-count")?.getAttribute("data-tip");

  const mount = async (engine = new SceneEngine()) => {
    const setLayout = vi.spyOn(engine, "setLayout");
    act(() => root.render(<Overview engine={engine} />));
    await flush();
    await advance(800);
    return { engine, setLayout, layout: (): SceneLayout => setLayout.mock.lastCall![0] };
  };
  const layoutIds = (layout: SceneLayout): string[] => layout.nodes.map((node) => node.id).sort();
  /** 页面上的节点就是布局里的节点：没有布局之外的、也没有漏掉的。 */
  const expectPageMatches = (layout: SceneLayout): void => {
    const page = [...container.querySelectorAll("[data-node-id]")].map((el) => el.getAttribute("data-node-id")!).sort();
    expect(page).toEqual(layout.nodes.map((node) => node.id).sort());
  };

  /**
   * 来源 A（有工作目录）下：工作中 + 已完成 + 失败 + 已取消 + 待命（待命算工作中），另有两层与三层的父子链；来源 B 全部已结束，与 A 共用一个目录。
   * 总共 A 10 个（3 个运行中、1 个待命）、B 2 个。
   */
  const mixed = (): SessionSummary[] => [
    make("run", "running", { workspace: WORKSPACE }),
    make("done", "done", { workspace: WORKSPACE }),
    make("fail", "failed", { workspace: WORKSPACE }),
    make("cancel", "cancelled", { workspace: WORKSPACE }),
    make("ready", "ready", { workspace: WORKSPACE }),
    make("p2", "done", { workspace: WORKSPACE }),
    make("c2", "running", { parent: "p2", workspace: WORKSPACE }),
    make("g3", "done", { workspace: WORKSPACE }),
    make("p3", "failed", { parent: "g3", workspace: WORKSPACE }),
    make("c3", "running", { parent: "p3", workspace: WORKSPACE }),
    make("b1", "done", { origin: "cursor:b", workspace: WORKSPACE }),
    make("b2", "failed", { origin: "cursor:b", workspace: WORKSPACE }),
  ];
  /** 工作中（含待命的 ready）与祖先链：已完成、失败、已取消的收起；p2 / g3 / p3 是为保住父子关系而留下的上级。 */
  const WORKING = ["agent:c2", "agent:c3", "agent:g3", "agent:p2", "agent:p3", "agent:ready", "agent:run"];

  it("关着（默认）：所有会话与来源都在，没有任何 data-leaving", async () => {
    open(...mixed());
    const { layout } = await mount();
    expect(agents()).toHaveLength(12);
    expect(originsOnPage()).toEqual(["origin:codex:a", "origin:cursor:b"]);
    expect(leaving()).toEqual([]);
    expectPageMatches(layout());
  });

  describe("打开后", () => {
    beforeEach(() => {
      store.set({ hideIdle: true });
    });

    it("只剩工作中的会话（运行中、待命）与它们的祖先链：已完成、失败、已取消都收起；父已结束、子在运行的链完整保留", async () => {
      open(...mixed());
      const { layout } = await mount();
      expect(agents()).toEqual(WORKING);
      expectPageMatches(layout());
      // 连线都是真实的关系：来源 → 根，父 → 子；没有“来源 → 子”这种不存在的关系。
      expect(layout().edges.filter((edge) => !edge.from.startsWith("git:") && !edge.from.startsWith("folder:")).map((edge) => edge.id).sort()).toEqual([
        "agent:g3>agent:p3",
        "agent:p2>agent:c2",
        "agent:p3>agent:c3",
        "origin:codex:a>agent:g3",
        "origin:codex:a>agent:p2",
        "origin:codex:a>agent:ready",
        "origin:codex:a>agent:run",
      ]);
    });

    it("一个来源下没有可见会话：来源卡收起；有可见会话的来源卡仍在，卡上的数字仍是真实总数（10 个会话 · 3 个运行中）", async () => {
      open(...mixed());
      await mount();
      expect(originsOnPage()).toEqual(["origin:codex:a"]);
      expect(countTip("codex:a")).toBe("10 个会话 · 3 个运行中");
    });

    it("共用的 Folder 与 Git 卡留着；Folder 上“N 个 Main Agent”仍按全部来源数（被收起的来源也在用这个目录）", async () => {
      open(...mixed());
      const { layout } = await mount();
      expect(ids(".node.folder")).toHaveLength(1);
      expect(ids(".node.git")).toHaveLength(1);
      expect(nodeEl(layout().nodes.find((node) => node.kind === "folder")!.id)?.querySelector(".o-count")?.textContent).toBe("2 个 Main Agent");
    });

    it("来源整条链一起收：只服务于被收起来源的 Folder 与 Git 卡也不画", async () => {
      open(make("a-run", "running", { origin: "codex:a", workspace: WORKSPACE }), make("c-done", "done", { origin: "pi:c", workspace: "C:\\other" }));
      const { layout } = await mount();
      expect(originsOnPage()).toEqual(["origin:codex:a"]);
      expect(layout().folders.map((folder) => folder.path)).toEqual([WORKSPACE]);
      expect(ids(".node.folder")).toHaveLength(1);
      expectPageMatches(layout());
    });

    it("被收起的 Git 卡仍在读：回来时带着最近一次的读数立刻就位（读的目录按全部来源，且都不在运行，只按空闲节奏读）", async () => {
      open(make("a-run", "running", { origin: "codex:a", workspace: WORKSPACE }), make("c-done", "done", { origin: "pi:c", workspace: "C:\\other" }));
      await mount();
      const asked = vi.mocked(api.git).mock.calls.map((call) => call[0]);
      expect(asked).toContain("C:\\other");
      expect(asked).toContain(WORKSPACE);
    });

    it("读屏的提示与画面一致：显示几个、收起几个", async () => {
      open(...mixed());
      await mount();
      expect(srText()).toContain("画布上显示 7 个会话，另有 5 个未在工作的已隐藏");
      act(() => setHideIdle(false));
      await advance(EXIT_MS + 50);
      expect(srText()).toContain("画布上有 12 个会话");
    });

    it("没有可收起的（都在工作）：读的仍是会话总数", async () => {
      open(make("a", "running"), make("b", "queued"));
      await mount();
      expect(srText()).toContain("画布上有 2 个会话");
      expect(agents()).toHaveLength(2);
    });

    it("只剩待命的会话：待命算工作中，留在画布上，不出现空状态；已结束的才被收起", async () => {
      open(make("a", "done"), make("r", "ready"));
      await mount();
      expect(agents()).toEqual(["agent:r"]);
      expect(container.querySelector(".empty")).toBeNull();
      expect(srText()).toContain("画布上显示 1 个会话，另有 1 个未在工作的已隐藏");
    });

    describe("全部都不在工作", () => {
      it("出现的是专门的空状态，不是“还没有委派”的 EmptyScene：写明有几个已收起，并给出恢复显示的出口", async () => {
        open(make("a", "done"), make("b", "failed", { origin: "pi:b" }), make("c", "cancelled"));
        await mount();
        const idle = container.querySelector(".empty[data-idle]");
        expect(idle).not.toBeNull();
        expect(container.querySelector(".ghost")).toBeNull();
        expect(container.querySelector(".empty-title")?.textContent).toBe("现在没有正在工作的会话");
        expect(idle!.querySelector(".empty-sub")?.textContent).toBe("3 个会话已收起");
        expect(container.querySelectorAll(".node")).toHaveLength(0);
        expect(container.textContent).not.toContain("还没有被委派出去的会话");
      });

      it("点“显示全部会话”：关闭开关、会话回来、空状态消失（Dock 上的按钮读同一份状态）", async () => {
        open(make("a", "done"), make("b", "failed"));
        await mount();
        act(() => container.querySelector<HTMLButtonElement>(".empty[data-idle] .btn")!.click());
        expect(store.get().hideIdle).toBe(false);
        expect(localStorage.getItem(HIDE_IDLE_KEY)).toBe("0");
        await advance(50);
        expect(container.querySelector(".empty")).toBeNull();
        expect(agents()).toEqual(["agent:a", "agent:b"]);
      });

      it("真的没有任何会话：仍是 EmptyScene 的引导，不是这个空状态", async () => {
        open();
        await mount();
        expect(container.querySelector(".empty[data-idle]")).toBeNull();
        expect(container.querySelector(".ghost")).not.toBeNull();
        expect(container.querySelector(".empty-title")?.textContent).toBe("还没有被委派出去的会话");
      });

      it("英文也成句", async () => {
        setLang("en");
        open(make("a", "done"));
        await mount();
        expect(container.querySelector(".empty-title")?.textContent).toBe("No session is working right now");
        expect(container.querySelector(".empty-sub")?.textContent).toBe("1 session is hidden");
        expect(container.querySelector(".empty .btn")?.textContent).toBe("Show all sessions");
      });
    });
  });

  describe("切换时的离场", () => {
    it("刚打开：被收起的先淡出（仍在页面与布局里，打上 data-leaving），淡出结束后才离开、布局才合拢", async () => {
      open(...mixed());
      const { layout } = await mount();
      expect(agents()).toHaveLength(12);
      const full = layoutIds(layout());

      act(() => setHideIdle(true));
      await flush();
      // 淡出中：节点都还在，布局也还是完整的一份（不提前合拢）；被收起的会话、整条被收起的来源卡打上了 data-leaving，留着的没有。
      expect(agents()).toHaveLength(12);
      expect(layoutIds(layout())).toEqual(full);
      expect(leaving()).toEqual([...agents().filter((id) => !WORKING.includes(id)), "origin:cursor:b"].sort());
      expect(nodeEl("agent:run")!.hasAttribute("data-leaving")).toBe(false);
      expect(nodeEl("origin:codex:a")!.hasAttribute("data-leaving")).toBe(false);

      await advance(EXIT_MS - 20);
      expect(agents()).toHaveLength(12);
      expect(layoutIds(layout())).toEqual(full);
      await advance(40);
      expect(agents()).toEqual(WORKING);
      expect(leaving()).toEqual([]);
      expect(originsOnPage()).toEqual(["origin:codex:a"]);
      expect(layoutIds(layout())).not.toEqual(full);
      expectPageMatches(layout());
    });

    it("再点一下：全部回来，没有残留的 data-leaving", async () => {
      store.set({ hideIdle: true });
      open(...mixed());
      const { layout } = await mount();
      expect(agents()).toEqual(WORKING);
      act(() => setHideIdle(false));
      await advance(50);
      expect(agents()).toHaveLength(12);
      expect(originsOnPage()).toEqual(["origin:codex:a", "origin:cursor:b"]);
      expect(leaving()).toEqual([]);
      expectPageMatches(layout());
    });

    describe("开着时一个运行中的会话完成了", () => {
      const run = (): SessionSummary => make("run", "running");
      const other = (): SessionSummary => make("other", "running");

      beforeEach(() => {
        store.set({ hideIdle: true });
      });

      it("不是“啪”地消失：先淡出，到时间才离开；连线与布局在它离开时才更新", async () => {
        const a = run();
        const b = other();
        open(a, b);
        const { layout } = await mount();
        expect(agents()).toEqual(["agent:other", "agent:run"]);

        open({ ...a, phase: "done" }, b);
        await flush();
        expect(agents()).toEqual(["agent:other", "agent:run"]);
        expect(leaving()).toEqual(["agent:run"]);
        // 布局里它与它的连线还在（相位已是 done），合拢要等淡出结束。
        expect(layoutIds(layout())).toContain("agent:run");
        expect(layout().edges.map((edge) => edge.id)).toContain("origin:codex:a>agent:run");

        await advance(EXIT_MS - 10);
        expect(agents()).toEqual(["agent:other", "agent:run"]);
        expect(layoutIds(layout())).toContain("agent:run");
        await advance(20);
        expect(agents()).toEqual(["agent:other"]);
        expect(leaving()).toEqual([]);
        expect(layoutIds(layout())).not.toContain("agent:run");
        expect(layout().edges.map((edge) => edge.id)).not.toContain("origin:codex:a>agent:run");
      });

      it("回到待命（ready）不算结束：不淡出、不离开；之后真的结束了才收起", async () => {
        const a = run();
        const b = other();
        open(a, b);
        await mount();

        open({ ...a, phase: "ready" }, b);
        await flush();
        expect(leaving()).toEqual([]);
        await advance(EXIT_MS + 50);
        expect(agents()).toEqual(["agent:other", "agent:run"]);

        open({ ...a, phase: "done" }, b);
        await flush();
        expect(leaving()).toEqual(["agent:run"]);
        await advance(EXIT_MS + 20);
        expect(agents()).toEqual(["agent:other"]);
      });

      it("同一来源下最后一个会话完成：来源卡与它的 Folder / Git 卡跟着一起淡出、一起离开", async () => {
        const a = make("run", "running", { workspace: WORKSPACE });
        open(a);
        await mount();
        expect(ids(".node.folder")).toHaveLength(1);
        expect(ids(".node.git")).toHaveLength(1);

        open({ ...a, phase: "done" });
        await flush();
        expect(leaving()).toEqual(expect.arrayContaining(["agent:run", "origin:codex:a"]));
        expect(leaving().some((id) => id.startsWith("folder:"))).toBe(true);
        expect(leaving().some((id) => id.startsWith("git:"))).toBe(true);
        // 这一刻画面上没有“整条链淡出到一半、空状态已经冒出来”的错乱。
        expect(container.querySelector(".empty")).toBeNull();

        await advance(EXIT_MS + 20);
        expect(container.querySelectorAll(".node")).toHaveLength(0);
        expect(container.querySelector(".empty[data-idle]")).not.toBeNull();
      });

      it.each([
        ["菜单开着（头部“···”或右键菜单）", "data-menu-open"],
        ["正在被拖动", "data-dragging"],
      ])("%s：不收，一直等；操作一结束才开始淡出", async (_name, attribute) => {
        const a = run();
        const b = other();
        open(a, b);
        await mount();
        nodeEl("agent:run")!.setAttribute(attribute, "");

        open({ ...a, phase: "done" }, b);
        await flush();
        await advance(10_000);
        expect(agents()).toEqual(["agent:other", "agent:run"]);
        expect(leaving()).toEqual([]);

        nodeEl("agent:run")!.removeAttribute(attribute);
        await advance(HOLD_POLL_MS + 10);
        expect(leaving()).toEqual(["agent:run"]);
        await advance(EXIT_MS + 20);
        expect(agents()).toEqual(["agent:other"]);
      });

      it("键盘焦点在它上面：不收；焦点离开后才开始淡出", async () => {
        const a = run();
        const b = other();
        open(a, b);
        await mount();
        const el = nodeEl("agent:run")!;
        act(() => el.focus());
        expect(document.activeElement).toBe(el);

        open({ ...a, phase: "done" }, b);
        await flush();
        await advance(5000);
        expect(agents()).toEqual(["agent:other", "agent:run"]);
        expect(leaving()).toEqual([]);

        act(() => el.blur());
        await advance(HOLD_POLL_MS + 10);
        expect(leaving()).toEqual(["agent:run"]);
        await advance(EXIT_MS + 20);
        expect(agents()).toEqual(["agent:other"]);
      });

      it("正在被操作的是子会话：它的父会话（已完成）也留着，直到子离开，子永远带着真实的父级", async () => {
        const parent = make("parent", "running");
        const child = make("child", "running", { parent: "parent" });
        open(parent, child);
        await mount();
        nodeEl("agent:child")!.setAttribute("data-menu-open", "");

        open({ ...parent, phase: "done" }, { ...child, phase: "done" });
        await flush();
        await advance(5000);
        expect(agents()).toEqual(["agent:child", "agent:parent"]);
        expect(leaving()).toEqual([]);

        nodeEl("agent:child")!.removeAttribute("data-menu-open");
        await advance(HOLD_POLL_MS + 10);
        // 整条链都不在工作了：来源卡也没有可见的会话了，一起淡出。
        expect(leaving()).toEqual(["agent:child", "agent:parent", "origin:codex:a"]);
      });

      it("新委派了一个会话（starting / queued / running）：当然可见，不经过任何淡出", async () => {
        const a = run();
        open(a);
        await mount();
        open(a, make("fresh", "starting"), make("later", "queued"));
        await flush();
        expect(agents()).toEqual(["agent:fresh", "agent:later", "agent:run"]);
        expect(leaving()).toEqual([]);
      });

      it("在聚焦页里把已完成的会话继续交代了，回到概览：它又是工作中，应该在", async () => {
        const done = make("revived", "done");
        const a = run();
        open(done, a);
        await mount();
        expect(agents()).toEqual(["agent:run"]);
        open({ ...done, phase: "running" }, a);
        await flush();
        expect(agents()).toEqual(["agent:revived", "agent:run"]);
      });

      it("淡出途中又被继续交代：不再淡出，直接留下", async () => {
        const a = run();
        const b = other();
        open(a, b);
        await mount();
        open({ ...a, phase: "done" }, b);
        await flush();
        expect(leaving()).toEqual(["agent:run"]);
        await advance(100);
        open({ ...a, phase: "running" }, b);
        await flush();
        expect(leaving()).toEqual([]);
        await advance(EXIT_MS + 50);
        expect(agents()).toEqual(["agent:other", "agent:run"]);
      });
    });
  });

  describe("选中与布局", () => {
    it("选中的节点被收起后，选中数同步：不会留下“已选 N 个”而画面上只剩更少", async () => {
      open(...mixed());
      const { engine, layout } = await mount();
      act(() => engine.selectAll());
      expect(engine.getState().selected).toBeGreaterThan(WORKING.length);

      act(() => setHideIdle(true));
      await advance(EXIT_MS + 40);
      const remaining = layout().nodes.map((node) => node.id).sort();
      expect(engine.getState().selected).toBe(remaining.length);
      expect([...engine.getSelectedIds()].sort()).toEqual(remaining);
      expect(srText()).toContain(`已选择 ${remaining.length} 个节点`);
    });

    it("被拖过（键盘微调）的节点：收起再展开后回到它存的位置；没拖过的回到布局给的位置", async () => {
      open(...mixed());
      const { engine } = await mount();
      const home = (id: string): string | undefined => nodeEl(id)?.style.translate;
      act(() => engine.moveNode("agent:done", 40, 24));
      await advance(50);
      const moved = home("agent:done");
      const untouched = home("agent:fail");
      expect(moved).toBeTruthy();

      act(() => setHideIdle(true));
      await advance(EXIT_MS + 40);
      expect(nodeEl("agent:done")).toBeNull();

      act(() => setHideIdle(false));
      await advance(600);
      expect(home("agent:done")).toBe(moved);
      expect(nodeEl("agent:fail")).not.toBeNull();
      expect(untouched).toBeTruthy();
    });

    it("窄画布（宿主侧栏）：同样只剩工作中的会话与祖先链，来源卡上的总数仍是真实总数；没有 Folder / Git 卡", async () => {
      wide = false;
      store.set({ hideIdle: true });
      open(...mixed());
      const { layout } = await mount();
      expect(agents()).toEqual(WORKING);
      expect(originsOnPage()).toEqual(["origin:codex:a"]);
      expect(countTip("codex:a")).toBe("10 个会话 · 3 个运行中");
      expect(ids(".node.folder")).toHaveLength(0);
      expect(ids(".node.git")).toHaveLength(0);
      expectPageMatches(layout());
    });

    it("窄画布里全部都不在工作：同样是专门的空状态", async () => {
      wide = false;
      store.set({ hideIdle: true });
      open(make("a", "done"), make("b", "cancelled"));
      await mount();
      expect(container.querySelector(".empty[data-idle] .empty-sub")?.textContent).toBe("2 个会话已收起");
    });
  });
});
