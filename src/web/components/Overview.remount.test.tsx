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
 * 点一张卡进聚焦页、再用浏览器后退：概览整个卸载，引擎与它的相机原样留着（`App` 只建一次引擎），回来的是新挂载的 Overview。
 * 右下角的缩放读数与“适应”的高亮是这个新组件的状态，从 100%、未动过起步，之后只靠引擎的 `onCamera` 更新；
 * 相机没变化时通知被引擎的缓存挡住过，读数就停在 100%。引擎一侧的约定在 scene/engine.characterize.camera.test.ts（“a host that mounts again”），
 * 这里验接线：读数真的跟着相机，并且引擎认定的新宿主起点与 `Overview` 里 `useState(1)` / `useState(false)` 一致。
 */

const REPO = "C:\\Users\\alice\\Desktop\\Ensemble";
const ORIGIN = "cursor:remount";

/** 一个根会话：创建先后就是编号，所有会话同一个来源。 */
function makeSession(n: number) {
  const id = `ses_m${n}`;
  const log = new EventLog(id);
  log.created({
    id,
    title: `子任务 ${n}`,
    harness: "cursor",
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
    origin: testOrigin({ key: ORIGIN, host: "cursor", hostLabel: "Cursor", workspace: REPO, hostTitle: "返回" }),
  });
  return toSummary(replay(log.events)!);
}

describe("Overview · 聚焦页返回后的缩放读数", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let previous: ReturnType<typeof store.get>;
  /** 组件对外的 `onCamera` 收到的每一次通知（缩放与是否用户动过）。 */
  let heard: [number, boolean][];

  beforeEach(() => {
    previous = store.get();
    localStorage.clear();
    heard = [];
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
    const list = Array.from({ length: count }, (_, idx) => makeSession(idx + 1));
    store.set({ sessions: Object.fromEntries(list.map((s) => [s.id, s])) });
    act(() =>
      root.render(
        <Overview
          engine={engine}
          scope={{ kind: "origin", key: ORIGIN }}
          workspaces={buildWorkspaces(list)}
          gitState={{ pending: false, tracked: new Set(), entries: new Map() }}
          onCamera={(camera, moved) => heard.push([camera.k, moved])}
        />,
      ),
    );
  };
  /** 聚焦页接管整块区域：概览整个卸载；回到概览时用同一个引擎重新挂载（组件状态全新）。 */
  const leaveAndReturn = (): void => {
    act(() => root.unmount());
    root = createRoot(host);
  };
  const reading = (): string | null | undefined => host.querySelector(".canvas-scale .scale-value")?.textContent;
  /** “适应”按钮是比例尺里唯一带 `data-active` 的：相机归用户时亮起。 */
  const fitLit = (): boolean => host.querySelector(".canvas-scale [data-active]") !== null;
  const percent = (engine: SceneEngine): string => `${Math.round(engine.getCamera().k * 100)}%`;

  it("相机在起点（100%、自动取景）：第一次挂载与回来之后读数都是 100%、不亮，也没有被多告知一次", () => {
    const engine = new SceneEngine();
    render(engine, 2);
    expect(engine.getCamera().k, "前提：两张卡取景区域里放得下，相机停在 100%").toBe(1);
    expect(engine.isUserMoved()).toBe(false);
    expect(reading()).toBe("100%");
    expect(fitLit()).toBe(false);

    leaveAndReturn();
    render(engine, 2);
    expect(reading()).toBe("100%");
    expect(fitLit()).toBe(false);
    expect(heard, "新宿主的读数本来就是这样：相机在起点时不重发").toEqual([]);
  });

  it("自动取景缩小了：回来之后读数与相机一致，仍不算用户动过", () => {
    const engine = new SceneEngine();
    render(engine, 40);
    const zoom = engine.getCamera().k;
    expect(zoom, "前提：40 张卡放不下，自动取景缩小了").toBeLessThan(0.9);
    expect(engine.isUserMoved()).toBe(false);
    expect(reading()).toBe(percent(engine));
    expect(fitLit()).toBe(false);

    leaveAndReturn();
    render(engine, 40);
    expect(engine.getCamera().k).toBe(zoom);
    expect(reading(), "回来之后读数不能停在 100%").toBe(percent(engine));
    expect(fitLit()).toBe(false);
  });

  it("用户放大过：回来之后读数与相机一致，“适应”的高亮也在", () => {
    const engine = new SceneEngine();
    render(engine, 2);
    act(() => engine.zoomBy(1.2));
    expect(engine.isUserMoved()).toBe(true);
    expect(reading()).toBe("120%");
    expect(fitLit()).toBe(true);

    // 用户动过的相机回来之后既不取景也不换空间：只有挂载时那一次通知能告诉新宿主。
    leaveAndReturn();
    render(engine, 2);
    expect(engine.getCamera().k).toBe(1.2);
    expect(reading(), "回来之后读数不能停在 100%").toBe("120%");
    expect(fitLit(), "相机归用户的标记也要传过去").toBe(true);
  });

  it("列表与画布互相切换（概览不卸载、画布卸载再挂载）：读数与高亮不变", () => {
    const engine = new SceneEngine();
    render(engine, 2);
    act(() => engine.zoomBy(1.2));
    expect(reading()).toBe("120%");

    act(() => setViewMode("list"));
    expect(host.querySelector(".canvas-scale"), "列表里没有画布，也没有比例尺").toBeNull();
    act(() => setViewMode("canvas"));
    expect(reading()).toBe("120%");
    expect(fitLit()).toBe(true);
    expect(heard.at(-1), "最后一次通知就是相机现在的样子").toEqual([1.2, true]);
  });
});
