import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../lib/app";
import type { EngineState, SceneEngine } from "../scene/engine";
import { ArrangeBar } from "./ArrangeBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 只实现操作条用到的那部分引擎：一个可订阅的状态加几个记录调用的动作。 */
function fakeEngine(initial: Partial<EngineState> = {}) {
  let state: EngineState = { selected: 2, canUndo: false, canRedo: false, ...initial };
  const listeners = new Set<() => void>();
  const engine = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState: () => state,
    align: vi.fn<(mode: string) => boolean>(() => true),
    distribute: vi.fn<(axis: string) => boolean>(() => true),
    undo: vi.fn(() => true),
    redo: vi.fn(() => true),
    clearSelection: vi.fn(),
  };
  const update = (patch: Partial<EngineState>): void => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };
  return { engine, update, as: engine as unknown as SceneEngine };
}

describe("对齐条", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    setLang("zh");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = (fake: ReturnType<typeof fakeEngine>): void => {
    act(() => root.render(<ArrangeBar engine={fake.as} />));
  };
  const button = (label: string | RegExp): HTMLButtonElement => {
    const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => {
      const name = item.getAttribute("aria-label") ?? "";
      return typeof label === "string" ? name === label : label.test(name);
    });
    if (!found) throw new Error(`没有找到按钮：${String(label)}`);
    return found;
  };
  const click = (target: HTMLElement): void => {
    act(() => target.click());
  };

  it("选中不足两个时整条不出现，选满两个才出现", () => {
    const fake = fakeEngine({ selected: 1 });
    render(fake);
    expect(host.querySelector(".arrange")).toBeNull();
    act(() => fake.update({ selected: 2 }));
    expect(host.querySelector(".arrange")).not.toBeNull();
    act(() => fake.update({ selected: 0 }));
    expect(host.querySelector(".arrange")).toBeNull();
  });

  it("是一条带名字的工具栏：已选数量、六个对齐、两个分布、撤销重做与取消选择", () => {
    render(fakeEngine({ selected: 2 }));
    const bar = host.querySelector(".arrange")!;
    expect(bar.getAttribute("role")).toBe("toolbar");
    expect(bar.getAttribute("aria-label")).toBe("对齐与分布");
    expect(bar.querySelector(".arrange-count")?.textContent).toBe("2 项已选");
    expect(bar.querySelectorAll("button")).toHaveLength(11);
    for (const name of ["左对齐", "水平居中", "右对齐", "顶对齐", "垂直居中", "底对齐", "取消选择（Esc）"]) {
      expect(button(name).getAttribute("data-tip")).toBe(name);
    }
  });

  it("每个对齐按钮对应引擎的一种对齐方式", () => {
    const fake = fakeEngine({ selected: 2 });
    render(fake);
    const expected: [string, string][] = [
      ["左对齐", "left"],
      ["水平居中", "hcenter"],
      ["右对齐", "right"],
      ["顶对齐", "top"],
      ["垂直居中", "vmiddle"],
      ["底对齐", "bottom"],
    ];
    for (const [label] of expected) click(button(label));
    expect(fake.engine.align.mock.calls.map(([mode]) => mode)).toEqual(expected.map(([, mode]) => mode));
  });

  it("选中少于三个时分布按钮不可用、点击无效，提示里说明原因", () => {
    const fake = fakeEngine({ selected: 2 });
    render(fake);
    const horizontal = button(/^水平等距分布/);
    expect(horizontal.getAttribute("aria-disabled")).toBe("true");
    expect(horizontal.getAttribute("aria-label")).toBe("水平等距分布（至少选 3 个）");
    expect(horizontal.disabled).toBe(false);
    click(horizontal);
    click(button(/^垂直等距分布/));
    expect(fake.engine.distribute).not.toHaveBeenCalled();
  });

  it("选中三个及以上时分布按钮可用", () => {
    const fake = fakeEngine({ selected: 3 });
    render(fake);
    const horizontal = button("水平等距分布");
    expect(horizontal.hasAttribute("aria-disabled")).toBe(false);
    click(horizontal);
    click(button("垂直等距分布"));
    expect(fake.engine.distribute.mock.calls).toEqual([["horizontal"], ["vertical"]]);
  });

  it("撤销与重做跟着历史走：没有可退的步骤时不可用", () => {
    const fake = fakeEngine({ selected: 2, canUndo: false, canRedo: false });
    render(fake);
    const modifier = /mac|iphone|ipad/i.test(navigator.platform) ? "⌘" : "Ctrl+";
    expect(button(/^撤销/).getAttribute("aria-label")).toBe(`撤销（${modifier}Z）`);
    expect(button(/^重做/).getAttribute("aria-label")).toBe(`重做（${modifier}Shift+Z）`);
    expect(button(/^撤销/).getAttribute("aria-disabled")).toBe("true");
    expect(button(/^重做/).getAttribute("aria-disabled")).toBe("true");
    click(button(/^撤销/));
    expect(fake.engine.undo).not.toHaveBeenCalled();

    act(() => fake.update({ canUndo: true, canRedo: true }));
    expect(button(/^撤销/).hasAttribute("aria-disabled")).toBe(false);
    click(button(/^撤销/));
    click(button(/^重做/));
    expect(fake.engine.undo).toHaveBeenCalledTimes(1);
    expect(fake.engine.redo).toHaveBeenCalledTimes(1);
  });

  it("取消选择按钮交给引擎清空选择", () => {
    const fake = fakeEngine({ selected: 2 });
    render(fake);
    click(button("取消选择（Esc）"));
    expect(fake.engine.clearSelection).toHaveBeenCalledTimes(1);
  });

  it("用一块不可见的提示区把结果告诉读屏软件，包括“没有变化”", () => {
    const fake = fakeEngine({ selected: 3 });
    render(fake);
    const live = host.querySelector(".arrange [aria-live]")!;
    expect(live.textContent).toBe("");
    click(button("水平居中"));
    expect(live.textContent).toBe("水平居中：3 个节点");
    fake.engine.align.mockReturnValueOnce(false);
    click(button("左对齐"));
    expect(live.textContent).toBe("左对齐：位置没有变化");
  });

  it("英文界面使用英文文案与单复数", () => {
    setLang("en");
    const fake = fakeEngine({ selected: 2 });
    render(fake);
    expect(host.querySelector(".arrange-count")?.textContent).toBe("2 selected");
    expect(host.querySelector(".arrange")?.getAttribute("aria-label")).toBe("Align and distribute");
    expect(button(/^Distribute horizontally/).getAttribute("aria-label")).toBe("Distribute horizontally (select at least 3)");
    click(button("Align left"));
    expect(host.querySelector(".arrange [aria-live]")?.textContent).toBe("Align left: 2 nodes");
  });
});
