import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog, testOrigin } from "@shared/testing";
import { setLang, setViewMode, store } from "../lib/app";
import { buildWorkspaces } from "../lib/workspaces";
import { SceneEngine } from "../scene/engine";
import { Overview } from "./Overview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 已有的卡原地不动之后，“重置节点布局”的入口（LAYOUT2 · W4）：整体重排只能靠它，所以现在的排布与全新规划不同时，
 * 即使从没拖过节点（没有手动位置）比例尺里也要有它；刚排好、或点过它之后没有东西可排，就不显示。
 * 聚焦页与概览之间切换时画布会卸载再挂载（引擎与它持有的排布不随之重置），入口的有无也要跟着排布走，不能被新挂载的组件状态吃掉。
 */

const REPO = "C:\\Users\\alice\\Desktop\\Ensemble";
const ORIGIN = "cursor:grow";

function makeSession(id: string, title: string) {
  const log = new EventLog(id);
  log.created({
    id,
    title,
    harness: "cursor",
    origin: testOrigin({ key: ORIGIN, host: "cursor", hostLabel: "Cursor", workspace: REPO, hostTitle: "批量改造" }),
  });
  return toSummary(replay(log.events)!);
}

describe("Overview · 已有的卡原地不动之后的“重置节点布局”入口", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let previous: ReturnType<typeof store.get>;

  beforeEach(() => {
    previous = store.get();
    localStorage.clear();
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1280 });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
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
    store.set(previous);
    localStorage.clear();
  });

  /** 画布上现在有 `count` 个根会话（会话 1 ~ count，创建先后同编号）。 */
  const render = (engine: SceneEngine, count: number): void => {
    const list = Array.from({ length: count }, (_, idx) => makeSession(`ses_s${idx + 1}`, `子任务 ${idx + 1}`));
    store.set({ sessions: Object.fromEntries(list.map((s) => [s.id, s])) });
    act(() =>
      root.render(<Overview engine={engine} scope={{ kind: "origin", key: ORIGIN }} workspaces={buildWorkspaces(list)} gitState={{ pending: false, tracked: new Set(), entries: new Map() }} />),
    );
  };
  const resetButton = (): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>('.canvas-scale button[aria-label="重置节点布局"]');
  /** 聚焦页接管整块区域：概览整个卸载；回到概览时用同一个引擎重新挂载。 */
  const leaveAndReturn = (): void => {
    act(() => root.unmount());
    root = createRoot(host);
  };

  it("没拖过节点：会话一个个到达，现在的排布与全新规划不同时比例尺里出现它；点它之后又收起", () => {
    const engine = new SceneEngine();
    render(engine, 8);
    expect(host.querySelector(".scene")?.hasAttribute("data-grid")).toBe(true);
    expect(resetButton(), "刚排好的画布没有东西可重排").toBeNull();

    for (let count = 9; count <= 40; count++) render(engine, count);
    expect(localStorage.getItem("ensemble.canvas.positions.v1"), "前提：没有拖过任何节点").toBeNull();
    expect(resetButton(), "已有的卡原地不动之后，现在的排布与全新规划不同：要有入口把它整体重排").not.toBeNull();

    act(() => resetButton()?.click());
    expect(resetButton(), "整体重排之后没有东西可重排").toBeNull();
    expect(host.querySelectorAll(".node.agent")).toHaveLength(40);
  });

  it("聚焦页回到概览（卸载再挂载，引擎沿用持有的排布）：有东西可排时入口仍在，没有时仍没有", () => {
    const calm = new SceneEngine();
    render(calm, 8);
    leaveAndReturn();
    render(calm, 8);
    expect(resetButton(), "排布就是规划本身：回到概览也没有东西可重排").toBeNull();

    const grown = new SceneEngine();
    render(grown, 8);
    for (let count = 9; count <= 40; count++) render(grown, count);
    expect(resetButton(), "前提：已有的卡原地不动，排布与规划不同").not.toBeNull();

    // 卸载时这个组件的状态没了；入口要靠引擎挂载时重放的排布状态回来，而不是等到下一个会话到达。
    leaveAndReturn();
    render(grown, 40);
    expect(resetButton(), "回到概览：排布仍与规划不同，入口仍在").not.toBeNull();

    act(() => resetButton()?.click());
    expect(resetButton(), "整体重排之后没有东西可重排").toBeNull();
  });
});
