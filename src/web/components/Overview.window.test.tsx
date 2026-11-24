import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog, testOrigin } from "@shared/testing";
import type { SessionSummary } from "@shared/types";
import { setLang, setViewMode, store } from "../lib/app";
import { buildWorkspaces } from "../lib/workspaces";
import { SceneEngine } from "../scene/engine";
import { SETTLE_MS } from "../scene/hold-settle";
import { fitArea, layoutScene } from "../scene/layout";
import { Overview } from "./Overview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 窗口经过窄外壳再回到宽屏，页面上的排布与刷新同一个窗口一致（LAYOUT5 · W13）。
 *
 * 页面里取景区域是 `Overview` 用 `ResizeObserver` 量 `.scene` 得来的；外壳（窄屏顶栏 ↔ 宽屏侧栏）是 `App` 另外用窗口的 resize 事件切的，
 * 比 `ResizeObserver` 晚一两帧。窗口 800 → 1440 时第一次量取量到的是**旧外壳**（有顶栏、没有侧栏）在 1440 宽度下的 `.scene`（1440×846），
 * 随后外壳换好才是 1200×900。这里不渲染 `App`，直接按那个顺序改 `.scene` 的尺寸、手动触发所有 `ResizeObserver` 回调，读用户眼前的节点位置。
 * 排布的细节（逐卡、外框、作废条件、次数上限）在 `scene/hold.window.test.ts`；这里验的是接线：区域真的传到了持有逻辑、时钟是 `performance.now()`。
 */

const REPO = "C:\\Users\\alice\\Desktop\\Ensemble";
const ORIGIN = "cursor:window";
const COUNT = 40;

type View = { w: number; h: number };
const WIDE: View = { w: 1200, h: 900 }; // 窗口 1440×900，宽外壳（侧栏 240）
const NARROW: View = { w: 800, h: 846 }; // 窗口 800×900，窄外壳（顶栏 54）
const STALE: View = { w: 1440, h: 846 }; // 800 → 1440 时外壳还没换好的第一次量取
const WIDER: View = { w: 1680, h: 900 };
const SMALLER: View = { w: 1040, h: 720 };

/** 一个根会话：创建先后就是编号，所有会话同一个来源。 */
function makeSession(n: number): SessionSummary {
  const id = `ses_w${n}`;
  const log = new EventLog(id);
  log.created({
    id,
    title: `子任务 ${n}`,
    harness: "cursor",
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
    origin: testOrigin({ key: ORIGIN, host: "cursor", hostLabel: "Cursor", workspace: REPO, hostTitle: "窗口" }),
  });
  return toSummary(replay(log.events)!);
}
const sessionsOf = (count: number): SessionSummary[] => Array.from({ length: count }, (_, i) => makeSession(i + 1));

/** Overview 自己的算法：视口扣掉留白、再量化到 16px。 */
const quantized = (view: View): { w: number; h: number } => {
  const next = fitArea(view.w, view.h);
  return { w: Math.round(next.w / 16) * 16, h: Math.round(next.h / 16) * 16 };
};

/** 刷新页面时这个窗口里会得到的排布：同一批会话、同样的取景区域，全新规划。 */
const freshSpots = (list: readonly SessionSummary[], view: View): Record<string, string> =>
  Object.fromEntries(
    layoutScene(list, { area: quantized(view), grid: true, hideContextNodes: true })
      .nodes.filter((n) => n.kind === "agent")
      .map((n) => [n.id, `${n.x},${n.y}`]),
  );

describe("Overview · 窗口经过窄外壳再回到宽屏", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let previous: ReturnType<typeof store.get>;
  let view: View;
  const observers = new Set<() => void>();

  beforeEach(() => {
    previous = store.get();
    localStorage.clear();
    view = WIDE;
    observers.clear();
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        private readonly fire: () => void;
        constructor(callback: ResizeObserverCallback) {
          this.fire = () => callback([], this as unknown as ResizeObserver);
          observers.add(this.fire);
        }
        observe(): void {}
        disconnect(): void {
          observers.delete(this.fire);
        }
      },
    );
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => view.w });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => view.h });
    setLang("zh");
    setViewMode("canvas");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)["clientWidth"];
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)["clientHeight"];
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
    store.set(previous);
    localStorage.clear();
  });

  const show = (engine: SceneEngine, list: readonly SessionSummary[]): void => {
    store.set({ sessions: Object.fromEntries(list.map((s) => [s.id, s])) });
    act(() =>
      root.render(<Overview engine={engine} scope={{ kind: "origin", key: ORIGIN }} workspaces={buildWorkspaces([...list])} gitState={{ pending: false, tracked: new Set(), entries: new Map() }} />),
    );
  };
  /** 窗口 / 外壳变了：`.scene` 的尺寸换成 `next`，所有 `ResizeObserver` 回调各触发一次（Overview 的量取、引擎的取景）。 */
  const resizeTo = (next: View): void => {
    view = next;
    act(() => {
      for (const fire of [...observers]) fire();
    });
  };
  const tick = (ms: number): void => {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  };
  /** 让节点与相机的弹簧落定（远超 `SETTLE_MS`）。 */
  const settle = (): void => tick(4000);

  /** 用户眼前每张会话卡的位置（节点元素的 `translate`）。 */
  const spots = (): Record<string, string> =>
    Object.fromEntries(
      [...host.querySelectorAll<HTMLElement>(".node.agent[data-node-id]")].map((el) => {
        const [x, y] = el.style.translate.split(" ").map((part) => Number.parseFloat(part));
        return [el.dataset["nodeId"] as string, `${x},${y}`];
      }),
    );
  const zoomText = (): string | null | undefined => host.querySelector(".canvas-scale .scale-value")?.textContent;
  const resetButton = (): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>('.canvas-scale button[aria-label="重置节点布局"]');

  it("1440 → 800 → 1440：外壳没换好的那次量取（1328×656）不把页面留在错的排布上，最后与刷新相同，比例尺读数相同，没有重置入口", () => {
    const engine = new SceneEngine();
    const list = sessionsOf(COUNT);
    show(engine, list);
    settle();
    const refreshed = { spots: spots(), zoom: zoomText() };
    expect(refreshed.spots, "前提：刷新得到的就是全新规划").toEqual(freshSpots(list, WIDE));
    expect(resetButton(), "前提：刚排好没有东西可重排").toBeNull();

    resizeTo(NARROW);
    settle();
    expect(spots(), "窗口 800：紧凑排布").toEqual(freshSpots(list, NARROW));
    expect(freshSpots(list, STALE), "前提：过渡值排出来的与最终值不同").not.toEqual(freshSpots(list, WIDE));

    resizeTo(STALE);
    tick(16);
    resizeTo(WIDE);
    settle();

    expect(spots()).toEqual(refreshed.spots);
    expect(zoomText()).toBe(refreshed.zoom);
    expect(resetButton()).toBeNull();
  });

  it("同一个尺寸体系里的窗口变化（拖动窗口、折叠侧栏）：已有的卡一像素不动，不需要等任何时间", () => {
    const engine = new SceneEngine();
    const list = sessionsOf(COUNT);
    show(engine, list);
    settle();
    const first = spots();
    for (const next of [WIDER, SMALLER, WIDE]) {
      resizeTo(next);
      tick(16);
      expect(spots(), `${next.w}×${next.h}`).toEqual(first);
    }
    expect(freshSpots(list, WIDER), "前提：规划随区域变").not.toEqual(freshSpots(list, WIDE));
  });

  it("翻转之后过了时间窗，区域再变不再重排：页面停在翻转那一刻的排布上（与重构前一致的 0 位移保证）", () => {
    const engine = new SceneEngine();
    const list = sessionsOf(COUNT);
    show(engine, list);
    settle();
    resizeTo(NARROW);
    settle();
    resizeTo(STALE);
    tick(SETTLE_MS + 100);
    resizeTo(WIDE);
    settle();
    expect(spots()).toEqual(freshSpots(list, STALE));
  });

  it("紧凑 → 宽屏（校正之后）来了一个新会话：40 个老卡一像素不动，新卡出现在空位上", () => {
    const engine = new SceneEngine();
    const list = sessionsOf(COUNT);
    show(engine, list);
    settle();
    resizeTo(NARROW);
    settle();
    resizeTo(STALE);
    tick(16);
    resizeTo(WIDE);
    settle();
    const before = spots();

    show(engine, [...list, makeSession(COUNT + 1)]);
    settle();
    const after = spots();
    expect(Object.keys(after)).toHaveLength(COUNT + 1);
    for (const [id, at] of Object.entries(before)) expect(after[id], id).toBe(at);
    const taken = new Set(Object.values(before));
    expect(taken.has(after[`agent:ses_w${COUNT + 1}`]!), "新卡没有落在老卡的位置上").toBe(false);
  });
});
