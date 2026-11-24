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
 * “重置节点布局”的另一半：经典的树放得下缩放、但外框是一条细长的竖串时，不回到树形（Overview.workspace.test.tsx 管“回到树形”那一半）。
 * 用户点的是“重新排列”，得到一条竖排到底的串，等于什么都没排。
 */

const REPO = "C:\\Users\\alice\\Desktop\\Ensemble";

function makeSession(id: string, originKey: string, title: string) {
  const log = new EventLog(id);
  log.created({
    id,
    title,
    harness: "cursor",
    origin: testOrigin({ key: originKey, host: "cursor", hostLabel: "Cursor", workspace: REPO, hostTitle: "批量改造" }),
  });
  return toSummary(replay(log.events)!);
}

describe("Overview · 重置节点布局不会换回一条竖串", () => {
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

  it("12 个根会话：缩小到 33% 时经典的单列（576 × 1608，宽高比只有取景区域的 0.19 倍）虽然放得下，重置后仍是多列网格，缩放不变", () => {
    const many = Array.from({ length: 12 }, (_, idx) => makeSession(`ses_s${idx + 1}`, "cursor:slender", `子任务 ${idx + 1}`));
    store.set({ sessions: Object.fromEntries(many.map((s) => [s.id, s])) });
    const engine = new SceneEngine();

    act(() =>
      root.render(
        <Overview
          engine={engine}
          scope={{ kind: "origin", key: "cursor:slender" }}
          workspaces={buildWorkspaces(many)}
          gitState={{ pending: false, tracked: new Set(), entries: new Map() }}
        />,
      ),
    );
    expect(host.querySelector(".scene")?.hasAttribute("data-grid")).toBe(true);

    act(() => {
      for (let i = 0; i < 6; i++) engine.zoomBy(1 / 1.2);
    });
    const zoom = engine.getCamera().k;
    expect(zoom).toBeCloseTo(0.335, 3);
    act(() => engine.resetLayout());

    // 单列在 1168 × 608 里按 37.8% 就放得下，此刻放得下；但它是一条竖串，所以不回到树形：网格在这个缩放下同样放得下，缩放原样不动。
    expect(host.querySelector(".scene")?.hasAttribute("data-grid")).toBe(true);
    expect(host.querySelectorAll(".node.agent")).toHaveLength(12);
    expect(engine.getCamera().k).toBeCloseTo(zoom, 6);
  });
});
