import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog, testOrigin } from "@shared/testing";
import { setLang, setViewMode, store } from "../lib/app";
import { buildWorkspaces } from "../lib/workspaces";
import { arrive, firstSecondColumn, optionsOf } from "../scene/arrival.columns.fixtures";
import { roots } from "../scene/arrival.fixtures";
import { SceneEngine } from "../scene/engine";
import { fitArea, type Area } from "../scene/layout";
import { Overview } from "./Overview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 画布把取景区域交给引擎（LAYOUT3 · W6）：会话一个个到达时，持有的排布里竖排的一列放不下了，下一张新卡落在右边新开的一列——
 * 要判断“放不下”就得知道取景区域，所以 Overview 在每次把布局交给引擎时带上它（量化到 16px 的那份，与规划用的数值一致）。
 * 这里验的是接线：引擎收到的区域、用户眼前（节点元素上）看到的排布；判据与落点本身在 scene/arrival-columns*.test.ts。
 */

const REPO = "C:\\Users\\alice\\Desktop\\Ensemble";
const ORIGIN = "cursor:cols";
const VIEWPORT = { w: 1280, h: 800 };

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

/** Overview 自己的算法：视口扣掉留白、再量化到 16px。 */
const quantized = (w: number, h: number): Area => {
  const next = fitArea(w, h);
  return { w: Math.round(next.w / 16) * 16, h: Math.round(next.h / 16) * 16 };
};

describe("Overview · 取景区域交给引擎，会话一个个到达时竖排满了另起一列", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let previous: ReturnType<typeof store.get>;

  beforeEach(() => {
    previous = store.get();
    localStorage.clear();
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => VIEWPORT.w });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => VIEWPORT.h });
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
    vi.useRealTimers();
    vi.restoreAllMocks();
    store.set(previous);
    localStorage.clear();
  });

  /** 画布上现在有 `count` 个根会话（会话 1 ~ count，创建先后同编号），并让节点与相机的弹簧落定。 */
  const render = (engine: SceneEngine, count: number): void => {
    const list = Array.from({ length: count }, (_, idx) => makeSession(`ses_s${idx + 1}`, `子任务 ${idx + 1}`));
    store.set({ sessions: Object.fromEntries(list.map((s) => [s.id, s])) });
    act(() =>
      root.render(<Overview engine={engine} scope={{ kind: "origin", key: ORIGIN }} workspaces={buildWorkspaces(list)} gitState={{ pending: false, tracked: new Set(), entries: new Map() }} />),
    );
    act(() => {
      vi.advanceTimersByTime(4000);
    });
  };

  /** 用户眼前每张会话卡的位置（节点元素的 `translate`）。 */
  const spots = (): Map<string, { x: number; y: number }> =>
    new Map(
      [...host.querySelectorAll<HTMLElement>(".node.agent[data-node-id]")].map((el): [string, { x: number; y: number }] => {
        const [x, y] = el.style.translate.split(" ").map((part) => Number.parseFloat(part));
        return [el.dataset["nodeId"] as string, { x: x as number, y: y as number }];
      }),
    );
  const columnsNow = (): number => new Set([...spots().values()].map((p) => p.x)).size;

  it("每次交给引擎的布局都带着取景区域：Overview 量化过的那一份；引擎自己重放时不带（那不是新规划）", () => {
    const engine = new SceneEngine();
    const spy = vi.spyOn(engine, "setLayout");
    render(engine, 3);
    render(engine, 4);
    const fresh = spy.mock.calls.filter(([, isReplay]) => !isReplay);
    expect(fresh.length, "前提：确实交过布局").toBeGreaterThan(0);
    for (const [, , area] of fresh) expect(area).toEqual(quantized(VIEWPORT.w, VIEWPORT.h));
  });

  it("会话一个个到达（1 → 20）：已有的卡一像素不动，第二列出现的时刻与按同一份取景区域算出来的一致", () => {
    const engine = new SceneEngine();
    const expected = firstSecondColumn(arrive(roots("cursor:a", 20), optionsOf(quantized(VIEWPORT.w, VIEWPORT.h))));
    expect(expected, "前提：这个窗口里 20 个根会话会开出第二列").toBeDefined();

    let before = new Map<string, { x: number; y: number }>();
    let opened: number | undefined;
    for (let count = 1; count <= 20; count++) {
      render(engine, count);
      const now = spots();
      expect(now.size, `第 ${count} 个到达时的会话卡数`).toBe(count);
      for (const [id, p] of before) expect(now.get(id), `${id}（第 ${count} 个到达时）`).toEqual(p);
      if (opened === undefined && columnsNow() > 1) opened = count;
      before = now;
    }
    expect(opened).toBe(expected);
    expect(columnsNow(), "20 个之后不止两列").toBeGreaterThan(2);
  });
});
