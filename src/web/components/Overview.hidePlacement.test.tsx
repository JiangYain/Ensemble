import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replay, toSummary } from "@shared/projection";
import type { GitResponse, GitSnapshot } from "@shared/protocol";
import { EventLog, testOrigin } from "@shared/testing";
import type { SessionPhase, SessionSummary } from "@shared/types";
import { api } from "../lib/api";
import { HIDE_IDLE_KEY, setHideIdle, setLang, store } from "../lib/app";
import { EXIT_MS } from "../lib/useWorkView";
import { SceneEngine } from "../scene/engine";
import type { SceneLayout } from "../scene/layout";
import { Overview } from "./Overview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * “隐藏未在工作的会话”与新节点的放置规则相遇的地方：被收起的会话重新显示出来不是“新到的会话”，
 * 回到布局本来给它们的位置，不按新节点摆到被拖走的参照旁边，也不推动别的节点（引擎与布局的细节在 engine.placement.test.ts）。
 */

const WORKSPACE = "C:\\Users\\alice\\Desktop\\Ensemble";
const KEY = "ensemble.canvas.positions.v1";

const snapshot = (): GitSnapshot => ({
  root: WORKSPACE,
  branch: "main",
  detached: false,
  head: { sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", subject: "feat: node", committedAt: new Date(2026, 0, 2, 9, 5).toISOString() },
  changes: { files: 2, staged: 0, unstaged: 2, untracked: 0, conflicted: 0 },
  checkedAt: new Date().toISOString(),
});

let seq = 0;
function make(id: string, phase: SessionPhase, extra: { parent?: string } = {}): SessionSummary {
  seq += 1;
  const log = new EventLog(id);
  log.created({
    id,
    title: `任务 ${id}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    origin: testOrigin({ key: "codex:a", workspace: WORKSPACE }),
    ...(extra.parent ? { parentSessionId: extra.parent } : {}),
  });
  return { ...toSummary(replay(log.events)!), phase };
}

/** 同一个来源下一排根会话：只有 run 在工作；done / fail / cancel 排在它后面，是收起时会离开的。 */
const sessions = (): SessionSummary[] => [
  make("run", "running"),
  make("done", "done"),
  make("fail", "failed"),
  make("cancel", "cancelled"),
  make("work", "running"),
  make("after", "done"),
];
const HIDDEN = ["agent:after", "agent:cancel", "agent:done", "agent:fail"];

describe("Overview · 隐藏未在工作的会话 × 新节点放置", () => {
  const previous = store.get();
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    seq = 0;
    setLang("zh");
    localStorage.removeItem(HIDE_IDLE_KEY);
    localStorage.removeItem(KEY);
    store.set({ sessions: {}, hideIdle: false });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    vi.spyOn(api, "git").mockImplementation(async (path): Promise<GitResponse> => ({ path, git: snapshot() }));
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1280 });
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
    localStorage.removeItem(KEY);
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
  const nodeEl = (id: string): HTMLElement | null => container.querySelector<HTMLElement>(`[data-node-id="${id}"]`);
  const at = (id: string): { x: number; y: number } => {
    const [x, y] = nodeEl(id)!.style.translate.split(" ").map((part) => Number.parseFloat(part));
    return { x: x!, y: y! };
  };
  const everyNode = (): string[] => [...container.querySelectorAll<HTMLElement>("[data-node-id]")].map((el) => el.dataset["nodeId"]!).sort();
  const spots = (): Record<string, { x: number; y: number }> => Object.fromEntries(everyNode().map((id) => [id, at(id)]));
  const stored = (): Record<string, unknown> => JSON.parse(localStorage.getItem(KEY) ?? "{}");

  const mount = async (engine = new SceneEngine()) => {
    const setLayout = vi.spyOn(engine, "setLayout");
    act(() => root.render(<Overview engine={engine} />));
    await flush();
    await advance(800);
    return { engine, layout: (): SceneLayout => setLayout.mock.lastCall![0] };
  };
  /** 页面上每个节点都在布局给的位置，除了用户自己摆过的那些。 */
  const expectAtLayout = (layout: SceneLayout, except: readonly string[]): void => {
    for (const node of layout.nodes) {
      if (except.includes(node.id)) continue;
      expect(at(node.id).x, node.id).toBeCloseTo(node.x, 1);
      expect(at(node.id).y, node.id).toBeCloseTo(node.y, 1);
    }
  };

  it("拖过 run 之后“隐藏 → 再显示”：排在它后面的被收起会话回到布局位置，不被摆到被拖走的 run 旁边；其余节点一动不动，没有多记位置", async () => {
    open(...sessions());
    const { engine, layout } = await mount();
    act(() => engine.moveNode("agent:run", 640, 0));
    await advance(3000);
    const dragged = at("agent:run");
    const before = spots();
    const written = localStorage.getItem(KEY);
    expect(Object.keys(stored())).toEqual(["agent:run"]);
    expect(before["agent:done"]).not.toEqual({ x: dragged.x + 24, y: dragged.y + 136 });

    act(() => setHideIdle(true));
    await advance(EXIT_MS + 40);
    for (const id of HIDDEN) expect(nodeEl(id), id).toBeNull();

    act(() => setHideIdle(false));
    await advance(3000);
    expect(everyNode()).toEqual(Object.keys(before).sort());
    expect(spots()).toEqual(before);
    expect(at("agent:run")).toEqual(dragged);
    expectAtLayout(layout(), ["agent:run"]);
    expect(localStorage.getItem(KEY)).toBe(written);
  });

  it("收起的时候新委派了一个会话：照常接在被拖走的参照后面；再显示收起的会话，它们回到布局位置、新会话不动", async () => {
    const base = sessions();
    open(...base);
    const { engine, layout } = await mount();
    act(() => engine.moveNode("agent:work", 640, 0));
    await advance(3000);
    const before = spots();
    act(() => setHideIdle(true));
    await advance(EXIT_MS + 40);

    // 新委派的会话是工作中的：收起时也画着，它的上一个可见兄弟是被拖走的 work（收着时 run、work、fresh 是第 1、2、3 个根，
    // 布局里奇数位向右错开 24，所以 fresh 在 work 左边 24、下面一个行距）。
    open(...base, make("fresh", "running"));
    await advance(3000);
    const dragged = at("agent:work");
    expect(at("agent:fresh")).toEqual({ x: dragged.x - 24, y: dragged.y + 136 });
    const landed = at("agent:fresh");
    expect(stored()["agent:fresh"]).toEqual(landed);

    act(() => setHideIdle(false));
    await advance(3000);
    expect(at("agent:fresh")).toEqual(landed);
    expect(at("agent:work")).toEqual(dragged);
    // 再显示时复原的是收起之前的排布（LAYOUT5 · W12）：收起的会话与来源 / Folder / Git 卡都回到收起之前的位置，隐藏期间新来的 fresh 按新卡处理。
    // 以前这里整体重排，来源、Folder、Git 卡随新规划（多了 fresh）居中而与规划一致；现在它们留在收起之前的位置，所以这几张卡不再与新规划逐个相同，改为与收起之前相同。
    expect(spots()).toEqual({ ...before, "agent:fresh": landed });
    const contextCards = layout().nodes.filter((node) => node.kind !== "agent").map((node) => node.id);
    expectAtLayout(layout(), ["agent:work", "agent:fresh", ...contextCards]);
  });

  it("页面一打开就收着，之前拖过的位置还在：打开显示后，收起的会话回到布局位置，没有多记位置", async () => {
    // 先在没收着的页面里拖一次，把位置存进浏览器。
    open(...sessions());
    const first = await mount();
    act(() => first.engine.moveNode("agent:run", 640, 0));
    await advance(3000);
    const written = localStorage.getItem(KEY);
    act(() => root.unmount());
    root = createRoot(container);

    // 重新打开页面：开关已经是开的，这些会话从没在这一页的画布上出现过。
    store.set({ hideIdle: true });
    const { layout } = await mount();
    for (const id of HIDDEN) expect(nodeEl(id), id).toBeNull();
    act(() => setHideIdle(false));
    await advance(3000);
    for (const id of HIDDEN) expect(nodeEl(id), id).not.toBeNull();
    expectAtLayout(layout(), ["agent:run"]);
    expect(localStorage.getItem(KEY)).toBe(written);
    expect(Object.keys(stored())).toEqual(["agent:run"]);
  });
});
