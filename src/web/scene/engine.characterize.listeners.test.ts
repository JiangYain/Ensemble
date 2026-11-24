import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SceneEngine } from "./engine";
import { describeListener, key, wheel } from "./engine-characterize.fixtures";
import { mountPair, pointer, selectBoth } from "./engine.fixtures";

/**
 * 特征化测试：引擎向 window、视口与媒体查询登记了哪些监听器、按什么顺序、带什么选项，卸载时又摘掉了什么。
 * 拆分引擎（纯结构整理）之前在旧实现上跑绿，拆分之后必须仍然全绿——监听器的登记顺序与选项属于行为。
 */

interface Spied {
  mock: { calls: readonly (readonly unknown[])[]; invocationCallOrder: readonly number[] };
}
interface Entry {
  order: number;
  text: string;
  fn: unknown;
}

/** 一个 spy 的全部调用，带上全局调用序号：几个目标的登记可以合成一条时间线。 */
const entries = (spy: Spied, label: string, verb: "add" | "remove"): Entry[] =>
  spy.mock.calls.map((args, i) => ({ order: spy.mock.invocationCallOrder[i]!, text: describeListener(label, verb, String(args[0]), args[2]), fn: args[1] }));

const plain = (spy: Spied, text: string): Entry[] => spy.mock.invocationCallOrder.map((order) => ({ order, text, fn: undefined }));

const texts = (list: readonly Entry[]): string[] => [...list].sort((a, b) => a.order - b.order).map((entry) => entry.text);

const MOUNT_ADDS = [
  "media.add change",
  "window.add keydown capture",
  "window.add keydown",
  "window.add keyup",
  "window.add blur",
  "window.add pointermove",
  "window.add pointerup",
  "window.add pointercancel",
  "viewport.add pointerdown",
  "viewport.add click capture",
  "viewport.add dragstart",
  'viewport.add wheel {"passive":false}',
  "viewport.add contextmenu",
  "observer.create",
  "observer.observe",
];

const UNMOUNT_REMOVES = [
  "media.remove change",
  "window.remove keydown capture",
  "window.remove keydown",
  "window.remove keyup",
  "window.remove blur",
  "window.remove pointermove",
  "window.remove pointerup",
  "window.remove pointercancel",
  "viewport.remove pointerdown",
  "viewport.remove click capture",
  "viewport.remove dragstart",
  "viewport.remove wheel",
  "viewport.remove contextmenu",
  "world.remove transform",
  "observer.disconnect",
];

describe("canvas engine listeners", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
    localStorage.clear();
  });

  /** 在已经搭好的画布上装好所有“看得见登记”的探针；之后的 `mount` / `unmount` 都会被记下来。 */
  function instrument(rig: ReturnType<typeof mountPair>) {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    vi.spyOn(window, "matchMedia").mockReturnValue(media);
    const probes = {
      mediaAdd: vi.spyOn(media, "addEventListener"),
      mediaRemove: vi.spyOn(media, "removeEventListener"),
      windowAdd: vi.spyOn(window, "addEventListener"),
      windowRemove: vi.spyOn(window, "removeEventListener"),
      viewportAdd: vi.spyOn(rig.viewport, "addEventListener"),
      viewportRemove: vi.spyOn(rig.viewport, "removeEventListener"),
      worldRemove: vi.spyOn(rig.world.style, "removeProperty"),
      made: vi.fn(),
      observe: vi.fn(),
      disconnect: vi.fn(),
    };
    const { made, observe, disconnect } = probes;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          made(callback);
        }
        observe = observe;
        disconnect = disconnect;
        unobserve = vi.fn();
      },
    );
    /** 关心的登记与摘除全部合成一份（没排序，按 `order` 排或交给 `texts`）。 */
    const events = (): Entry[] => [
      ...entries(probes.mediaAdd, "media", "add"),
      ...entries(probes.mediaRemove, "media", "remove"),
      ...[...entries(probes.windowAdd, "window", "add"), ...entries(probes.windowRemove, "window", "remove")]
        .filter((entry) => /^window\.\w+ (keydown|keyup|blur|pointermove|pointerup|pointercancel)/.test(entry.text)),
      ...entries(probes.viewportAdd, "viewport", "add"),
      ...entries(probes.viewportRemove, "viewport", "remove"),
      ...probes.worldRemove.mock.calls.map((args, i) => ({ order: probes.worldRemove.mock.invocationCallOrder[i]!, text: `world.remove ${String(args[0])}`, fn: undefined })),
      ...plain(made, "observer.create"),
      ...plain(observe, "observer.observe"),
      ...plain(disconnect, "observer.disconnect"),
    ];
    const lastOrder = (): number => Math.max(0, ...events().map((entry) => entry.order));
    return { media, probes, events, lastOrder };
  }

  const remount = (rig: ReturnType<typeof mountPair>): void => rig.engine.mount({ viewport: rig.viewport, world: rig.world, pipes: { tube: rig.tube, dots: rig.dots } });

  it("registers the media query, window and viewport listeners in a fixed order with fixed options", () => {
    const rig = mountPair();
    try {
      rig.engine.unmount();
      const { events, lastOrder } = instrument(rig);
      const mark = lastOrder();
      remount(rig);
      const added = events().filter((entry) => entry.order > mark && !entry.text.includes(".remove ") && !entry.text.endsWith("disconnect"));
      expect(texts(added)).toEqual(MOUNT_ADDS);
    } finally {
      rig.engine.unmount();
    }
  });

  it("removes every listener it added on unmount, in order, with the same handler references", () => {
    const rig = mountPair();
    try {
      rig.engine.unmount();
      const { events, probes, lastOrder } = instrument(rig);
      const before = lastOrder();
      remount(rig);
      const mark = lastOrder();
      /** 某个时间点之后、某一类动作交给浏览器的处理函数（按发生先后）。 */
      const handlers = (verb: string, since: number): unknown[] =>
        [...events()].sort((a, b) => a.order - b.order).filter((entry) => entry.order > since && entry.text.includes(`.${verb} `) && entry.fn !== undefined).map((entry) => entry.fn);
      const added = handlers("add", before);
      rig.engine.unmount();
      expect(texts(events().filter((entry) => entry.order > mark))).toEqual(UNMOUNT_REMOVES);
      const removed = handlers("remove", mark);
      expect(added).toHaveLength(13);
      expect(removed).toHaveLength(13);
      removed.forEach((fn, i) => expect(fn).toBe(added[i]));
      expect(probes.disconnect).toHaveBeenCalledTimes(1);
    } finally {
      rig.engine.unmount();
    }
  });

  it("mounting twice first removes the previous listeners and observer, then adds a fresh set", () => {
    const rig = mountPair();
    try {
      const { events, probes, lastOrder } = instrument(rig);
      remount(rig);
      const mark = lastOrder();
      remount(rig);
      const second = events().filter((entry) => entry.order > mark);
      expect(texts(second)).toEqual([...UNMOUNT_REMOVES, ...MOUNT_ADDS]);
      expect(probes.disconnect).toHaveBeenCalledTimes(1);
      expect(probes.made).toHaveBeenCalledTimes(2);
    } finally {
      rig.engine.unmount();
    }
  });

  it("stops reacting to the page once unmounted", () => {
    const rig = mountPair();
    const { engine, viewport, world, agent } = rig;
    engine.unmount();
    const scroll = wheel(viewport, { deltaY: 40 });
    expect(scroll.defaultPrevented).toBe(false);
    expect(world.style.transform).toBe("");
    key("keydown", { key: "Shift", shiftKey: true });
    expect(viewport.dataset["tool"]).toBeUndefined();
    pointer(agent, "pointerdown", 400, 300);
    pointer(viewport, "pointermove", 450, 330);
    pointer(viewport, "pointerup", 450, 330);
    expect(agent.style.translate).toBe("310.00px 14.00px");
    expect(engine.getSelectedIds()).toEqual([]);
  });

  it("cleans up on unmount: tool, world transform, selection, pending frame", () => {
    const rig = mountPair();
    const { engine, viewport, world, agent } = rig;
    const onSelection = vi.fn();
    engine.mount({ viewport, world, pipes: { tube: rig.tube, dots: rig.dots }, onSelection });
    selectBoth(engine);
    expect(onSelection.mock.calls).toEqual([[1], [2]]);
    key("keydown", { key: "Shift", shiftKey: true });
    expect(viewport.dataset["tool"]).toBe("select");
    engine.zoomBy(1.2);
    expect(vi.getTimerCount()).toBe(1);
    const states = vi.fn();
    const selections = vi.fn();
    engine.subscribe(states);
    engine.subscribeSelection(selections);
    engine.unmount();
    expect(viewport.dataset["tool"]).toBeUndefined();
    expect(world.style.transform).toBe("");
    expect(vi.getTimerCount()).toBe(0);
    expect(engine.getState()).toEqual({ selected: 0, canUndo: false, canRedo: false });
    expect(engine.getSelectedIds()).toEqual([]);
    expect(agent.hasAttribute("data-selected")).toBe(false);
    // 状态与选中成员各通知一次；挂载时交给引擎的 `onSelection` 在卸载时不再被叫。
    expect(states).toHaveBeenCalledTimes(1);
    expect(selections).toHaveBeenCalledTimes(1);
    expect(onSelection).toHaveBeenCalledTimes(2);
  });

  it("is safe to unmount before mounting and to unmount repeatedly", () => {
    const engine = new SceneEngine();
    expect(() => {
      engine.unmount();
      engine.unmount();
    }).not.toThrow();
    const rig = mountPair();
    expect(() => {
      rig.engine.unmount();
      rig.engine.unmount();
    }).not.toThrow();
    expect(rig.engine.getState()).toEqual({ selected: 0, canUndo: false, canRedo: false });
  });
});
