import { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog } from "@shared/testing";
import type { SessionSummary } from "@shared/types";
import { setLang, store } from "../lib/app";
import { translate } from "../lib/i18n";
import { mountScene, node, sceneOf, type SceneRig } from "../scene/engine.fixtures";
import { EdgeHints } from "./EdgeHints";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const summary = (id: string, title: string): SessionSummary => {
  const log = new EventLog(id);
  log.created({ id, title });
  return toSummary(replay(log.events)!);
};

/** 引擎侧：夹具视口 1200×800，相机在 (494, 352)、缩放 1；用户拖了一下画布之后，新节点落在视口之外。 */
const a = node("agent:a", 0, 0);
function arrive(rig: SceneRig, nodes: readonly [string, number, number][]): void {
  rig.viewport.dispatchEvent(new WheelEvent("wheel", { deltaX: 1, bubbles: true, cancelable: true }));
  const layout = sceneOf([a, ...nodes.map(([id, x, y]) => node(id, x, y))]);
  for (const spec of layout.nodes) if (!rig.els.has(spec.id)) rig.attach(spec.id);
  rig.engine.setLayout(layout);
}

describe("EdgeHints", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let rig: SceneRig;
  let previous: ReturnType<typeof store.get>;

  beforeEach(() => {
    previous = store.get();
    localStorage.clear();
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date", "setTimeout", "clearTimeout"] });
    setLang("zh");
    rig = mountScene(sceneOf([a]));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    rig.dispose();
    store.set(previous);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    localStorage.clear();
    document.body.replaceChildren();
  });

  /** 与页面一致：提示渲染在 `.scene` 里，节点元素是它的同级内容（这里不归 React 管，卸载提示时它们还在）。 */
  const render = (...ids: string[]): void => {
    act(() => root.render(<div className="scene"><EdgeHints engine={rig.engine} /></div>));
    const scene = host.querySelector(".scene")!;
    for (const id of ids) {
      if (scene.querySelector(`[data-node-id="${id}"]`)) continue;
      const el = document.createElement("div");
      el.dataset["nodeId"] = id;
      el.tabIndex = 0;
      scene.append(el);
    }
  };
  const nodeEl = (id: string): HTMLElement => host.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!;
  const sessions = (...items: SessionSummary[]): void => {
    act(() => store.set({ sessions: Object.fromEntries(items.map((item) => [item.id, item])) }));
  };
  const buttons = (): HTMLButtonElement[] => [...host.querySelectorAll<HTMLButtonElement>("button.edge-hint")];
  const status = (item: SessionSummary, lang: "zh" | "en" = "zh"): string => translate(lang, `phase.${item.phase}`);
  const click = (button: HTMLElement, detail: number): void => {
    act(() => void button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail })));
  };
  /** 鼠标点击的 detail 是点击次数（≥ 1）；键盘触发（Enter / 空格）的点击 detail 为 0。 */
  const mouseClick = (button: HTMLElement): void => click(button, 1);
  const keyboardClick = (button: HTMLElement): void => click(button, 0);
  const arriveIn = (...nodes: [string, number, number][]): void => {
    act(() => arrive(rig, nodes));
  };

  it("没有提示时什么按钮都没有", () => {
    sessions(summary("far", "Far"));
    render("agent:far");
    expect(buttons()).toEqual([]);
    expect(host.querySelector(".edge-hints")).not.toBeNull();
  });

  it("单个：一个 button，只有方向箭头、没有数字；aria-label 写清方向与标题，悬停提示写标题与状态", () => {
    const far = summary("far", "重构解析器");
    sessions(far);
    render("agent:far");
    arriveIn(["agent:far", 3000, 100]);
    expect(buttons()).toHaveLength(1);
    const button = buttons()[0]!;
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.tabIndex).toBe(0);
    expect(button.dataset["edge"]).toBe("right");
    expect(button.getAttribute("aria-label")).toBe("视口右侧有新会话：重构解析器");
    expect(button.dataset["tip"]).toBe(`重构解析器 · ${status(far)}\n点击平移到那里`);
    expect(button.getAttribute("aria-description")).toBe(button.dataset["tip"]);
    expect(button.querySelector("svg")).not.toBeNull();
    expect(button.querySelector(".edge-hint-count")).toBeNull();
    expect(button.hasAttribute("data-multi")).toBe(false);
  });

  it("同一边来了好几个：聚合成一个，带数量；标签写最近的那个，提示按远近列出", () => {
    const items = [summary("n1", "最近的"), summary("n2", "第二个"), summary("n3", "最远的")];
    sessions(...items);
    render("agent:n1", "agent:n2", "agent:n3");
    arriveIn(["agent:n3", 3600, 100], ["agent:n1", 1500, 100], ["agent:n2", 2400, 100]);
    expect(buttons()).toHaveLength(1);
    const button = buttons()[0]!;
    expect(button.querySelector(".edge-hint-count")?.textContent).toBe("3");
    expect(button.hasAttribute("data-multi")).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("视口右侧有 3 个新会话，最近的：最近的");
    expect(button.dataset["tip"]).toBe(`最近的 · ${status(items[0]!)}\n第二个 · ${status(items[1]!)}\n最远的 · ${status(items[2]!)}\n点击平移到最近的一个`);
  });

  it("提示最多列 4 行，其余写“另有 N 个”", () => {
    const items = Array.from({ length: 6 }, (_, i) => summary(`m${i}`, `会话${i}`));
    sessions(...items);
    render(...items.map((item) => `agent:${item.id}`));
    arriveIn(...items.map((item, i) => [`agent:${item.id}`, 1500 + i * 300, 100] as [string, number, number]));
    const tip = buttons()[0]!.dataset["tip"]!.split("\n");
    expect(tip).toHaveLength(6);
    expect(tip.slice(0, 4).map((line) => line.split(" · ")[0])).toEqual(["会话0", "会话1", "会话2", "会话3"]);
    expect(tip[4]).toBe("另有 2 个");
  });

  it("不同的边各一个按钮，顺序是上、右、下、左（Tab 顺序）", () => {
    const items = [summary("l", "左"), summary("b", "下"), summary("r", "右"), summary("t", "上")];
    sessions(...items);
    render(...items.map((item) => `agent:${item.id}`));
    arriveIn(["agent:l", -2000, 100], ["agent:b", 100, 1500], ["agent:r", 3000, 100], ["agent:t", 100, -1500]);
    expect(buttons().map((button) => button.dataset["edge"])).toEqual(["top", "right", "bottom", "left"]);
    expect(buttons().map((button) => button.getAttribute("aria-label"))).toEqual([
      "视口上方有新会话：上", "视口右侧有新会话：右", "视口下方有新会话：下", "视口左侧有新会话：左",
    ]);
    // 四个箭头各指向自己的方向：图标路径互不相同。
    expect(new Set(buttons().map((button) => button.querySelector("path")?.getAttribute("d"))).size).toBe(4);
  });

  it("英文界面：方向、数量与单复数", () => {
    setLang("en");
    const items = [summary("one", "Parser"), summary("two", "Linter")];
    sessions(...items);
    render("agent:one", "agent:two");
    arriveIn(["agent:one", 3000, 100], ["agent:two", 100, 1500]);
    expect(buttons().map((button) => button.getAttribute("aria-label"))).toEqual(["New session to the right of the view: Parser", "New session below the view: Linter"]);
    expect(buttons()[0]!.dataset["tip"]).toBe(`Parser · ${status(items[0]!, "en")}\nClick to pan there`);
    arriveIn(["agent:one", 3000, 100], ["agent:two", 100, 1500], ["agent:three", 3300, 100]);
    // 第三个还不在会话列表里（没有标题可写）：不出现，也不占数量。
    expect(buttons()[0]!.querySelector(".edge-hint-count")).toBeNull();
    sessions(...items, summary("three", "Docs"));
    expect(buttons()[0]!.getAttribute("aria-label")).toBe("2 new sessions to the right of the view, nearest: Parser");
    expect(buttons()[0]!.dataset["tip"]!.split("\n").at(-1)).toBe("Click to pan to the nearest");
    expect(translate("en", "edgeHint.more", { n: 2 })).toBe("2 more");
  });

  it("会话列表里没有的节点（刚被删除）：不显示提示", () => {
    sessions(summary("far", "Far"));
    render("agent:far", "agent:ghost");
    arriveIn(["agent:far", 3000, 100], ["agent:ghost", 100, 1500]);
    expect(buttons().map((button) => button.dataset["edge"])).toEqual(["right"]);
  });

  describe("点击", () => {
    beforeEach(() => {
      sessions(summary("far", "Far"), summary("far2", "Far two"));
      render("agent:far", "agent:far2");
      arriveIn(["agent:far", 3000, 100], ["agent:far2", 3000, 400]);
    });

    it("平移相机把最近的节点带进视口、右缘落在取景留白上，不改缩放；同一次平移带进来的另一个也一并算看见", () => {
      const before = { ...rig.engine.getCamera() };
      mouseClick(buttons()[0]!);
      const after = rig.engine.getCamera();
      expect(after.k).toBe(before.k);
      expect(after.x).toBeLessThan(before.x);
      expect(after.x + 3000 + 212).toBe(1200 - 56);
      expect(buttons()).toEqual([]);
    });

    it("鼠标点击不抢键盘焦点、不选中节点；被带过去的节点有一圈短暂的“在这里”的标记，之后自己消失", () => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      const target = nodeEl("agent:far");
      mouseClick(buttons()[0]!);
      expect(focus).not.toHaveBeenCalled();
      expect(target.hasAttribute("data-landed")).toBe(true);
      expect(nodeEl("agent:far2").hasAttribute("data-landed")).toBe(false);
      expect(rig.engine.getState().selected).toBe(0);
      act(() => void vi.advanceTimersByTime(1599));
      expect(target.hasAttribute("data-landed")).toBe(true);
      act(() => void vi.advanceTimersByTime(2));
      expect(target.hasAttribute("data-landed")).toBe(false);
    });

    it("键盘触发（Enter / 空格）：按钮即将消失，焦点交给目标节点，且不让容器滚动", () => {
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      buttons()[0]!.focus();
      keyboardClick(buttons()[0]!);
      expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
      expect(document.activeElement).toBe(nodeEl("agent:far"));
    });

    it("聚合的提示再点一次去下一个：每个节点的标记各有自己的计时，互不影响", () => {
      sessions(summary("far", "Far"), summary("far2", "Far two"), summary("far3", "Far three"));
      render("agent:far3");
      arriveIn(["agent:far", 3000, 100], ["agent:far2", 3000, 400], ["agent:far3", 6000, 100]);
      expect(buttons()[0]!.querySelector(".edge-hint-count")?.textContent).toBe("3");
      mouseClick(buttons()[0]!);
      expect(nodeEl("agent:far").hasAttribute("data-landed")).toBe(true);
      expect(buttons()).toHaveLength(1);
      expect(buttons()[0]!.getAttribute("aria-label")).toBe("视口右侧有新会话：Far three");
      act(() => void vi.advanceTimersByTime(800));
      mouseClick(buttons()[0]!);
      expect(nodeEl("agent:far3").hasAttribute("data-landed")).toBe(true);
      act(() => void vi.advanceTimersByTime(801));
      expect(nodeEl("agent:far").hasAttribute("data-landed")).toBe(false);
      expect(nodeEl("agent:far3").hasAttribute("data-landed")).toBe(true);
      act(() => void vi.advanceTimersByTime(800));
      expect(nodeEl("agent:far3").hasAttribute("data-landed")).toBe(false);
    });

    it("卸载时收掉还没到点的标记", () => {
      mouseClick(buttons()[0]!);
      expect(nodeEl("agent:far").hasAttribute("data-landed")).toBe(true);
      act(() => root.render(<div className="scene" />));
      expect(nodeEl("agent:far").hasAttribute("data-landed")).toBe(false);
    });
  });

  it("新到时在读屏的礼貌播报区里读出提示的 aria-label；提示都消失后清空，下一次相同的文字还能再读", () => {
    sessions(summary("far", "Far"));
    render("agent:far");
    const live = (): string => host.querySelector(".edge-hints .sr-only[aria-live='polite']")?.textContent ?? "";
    expect(live()).toBe("");
    arriveIn(["agent:far", 3000, 100]);
    expect(live()).toBe("视口右侧有新会话：Far");
    mouseClick(buttons()[0]!);
    expect(live()).toBe("");
  });

  describe("底部的提示贴在 Dock 一摞的上方", () => {
    const observers: (() => void)[] = [];
    let stack: HTMLElement;
    let top = 800;
    const rectOf = (y: number, height: number): DOMRect => DOMRect.fromRect({ x: 0, y, width: 400, height });

    beforeEach(() => {
      observers.length = 0;
      vi.stubGlobal("ResizeObserver", class {
        constructor(callback: () => void) {
          observers.push(callback);
        }
        observe(): void {}
        disconnect(): void {}
      });
      stack = document.createElement("div");
      stack.className = "dock-wrap";
      stack.style.rowGap = "9px";
      document.body.append(stack);
      top = 800;
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        if (this === stack) return rectOf(top, 900 - top);
        return this.classList.contains("edge-hints") ? rectOf(0, 900) : rectOf(0, 0);
      });
    });

    it("量 .dock-wrap 的上沿，加上它自己的行距，写进 --edge-stack；Dock 变高（对齐条出现）时重新量", () => {
      render();
      const el = host.querySelector<HTMLElement>(".edge-hints")!;
      // 根的下沿 900、一摞的上沿 800：抬 100，再加 Dock 与对齐条之间同样的 9 的行距。
      expect(el.style.getPropertyValue("--edge-stack")).toBe("109px");
      top = 740; // 对齐条冒出来：一摞变高了 60
      for (const callback of observers) callback();
      expect(el.style.getPropertyValue("--edge-stack")).toBe("169px");
    });

    it("页面里没有 Dock 一摞时不写变量，样式回退到贴着底边", () => {
      stack.remove();
      render();
      expect(host.querySelector<HTMLElement>(".edge-hints")!.style.getPropertyValue("--edge-stack")).toBe("");
    });
  });
});

describe("EdgeHints 的样式（scene.css）", () => {
  const css = readFileSync("src/web/styles/scene.css", "utf8");
  const rule = (selector: string): string => {
    const start = css.indexOf(`${selector} {`);
    if (start < 0) throw new Error(`没有规则 ${selector}`);
    return css.slice(start, css.indexOf("}", start));
  };

  it("容器不拦截任何指针事件，只有按钮自己接收：画布的平移、框选、右键照常穿透", () => {
    expect(rule(".edge-hints")).toMatch(/pointer-events:\s*none/);
    expect(rule(".edge-hint")).toMatch(/pointer-events:\s*auto/);
  });

  it("提示是直角的小方标：没有任何圆角声明；颜色与字号走现有 token", () => {
    const body = rule(".edge-hint");
    expect(body).not.toMatch(/border-radius|corner-shape/);
    expect(body).not.toMatch(/999px/);
    expect(body).toMatch(/color:\s*var\(--teal\)/);
    expect(body).toMatch(/font-size:\s*var\(--fs-xs\)/);
  });

  it("层级低于 Dock（30），高于画布节点", () => {
    expect(rule(".edge-hints")).toMatch(/z-index:\s*var\(--z-topbar\)/);
  });

  it("悬停与按下有状态（沿用 --soft / --soft-press），焦点环用全站的 :focus-visible（不单独写）", () => {
    expect(rule(".edge-hint:hover")).toMatch(/var\(--soft\)/);
    expect(rule(".edge-hint:active")).toMatch(/var\(--soft-press\)/);
    expect(css).not.toMatch(/\.edge-hint[^{]*:focus/);
  });

  it("减少动态效果：出现的动效与“在这里”的光晕动效都关掉（光晕保留为静态的一圈）", () => {
    const media = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce) {"));
    expect(media).toMatch(/\.edge-hint\s*\{[^}]*animation:\s*none/);
    expect(media).toMatch(/\.node\[data-landed\]::after\s*\{[^}]*animation:\s*none/);
  });

  it("“在这里”的光晕时长与组件里移除标记的计时一致（1.6s / 1600ms）", () => {
    expect(rule(".node[data-landed]::after")).toMatch(/animation:\s*node-landed\s+1\.6s/);
    expect(readFileSync("src/web/components/EdgeHints.tsx", "utf8")).toMatch(/LANDED_MS\s*=\s*1600/);
  });

  it("四个方向各有自己的锚点：上、左右对齐标题所在的版心，底部贴在 Dock 一摞的上方", () => {
    expect(rule('.edge-hint[data-edge="top"]')).toMatch(/top:\s*var\(--scene-top\)/);
    expect(rule('.edge-hint[data-edge="left"]')).toMatch(/left:\s*var\(--scene-side\)/);
    expect(rule('.edge-hint[data-edge="right"]')).toMatch(/right:\s*var\(--scene-side\)/);
    expect(rule('.edge-hint[data-edge="bottom"]')).toMatch(/bottom:\s*var\(--edge-stack/);
    // 标题也读同一组变量：版心只有一份。
    expect(rule(".canvas-meta")).toMatch(/top:\s*var\(--scene-top\)[\s\S]*left:\s*var\(--scene-side\)/);
  });
});
