import type { KeyboardEvent } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneEngine } from "../scene/engine";
import { isNodeKey, nodeKeyHandler } from "./nodeKeys";

type KeyInit = Partial<Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey">>;

const NODE = {} as HTMLElement;
const CONTROL = {} as HTMLElement;

/** React 合成事件里 helper 用到的那几个字段；target 默认就是节点自身。 */
function keyEvent(init: KeyInit, target: HTMLElement = NODE): KeyboardEvent<HTMLElement> {
  return {
    key: "", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
    target, currentTarget: NODE, preventDefault: vi.fn(),
    ...init,
  } as unknown as KeyboardEvent<HTMLElement>;
}

describe("画布节点的键盘操作（nodeKeyHandler）", () => {
  const moveNode = vi.fn();
  const toggleSelection = vi.fn();
  const handler = nodeKeyHandler({ moveNode, toggleSelection } as unknown as SceneEngine, "n1");
  const press = (init: KeyInit, target?: HTMLElement): KeyboardEvent<HTMLElement> => {
    const event = keyEvent(init, target);
    handler(event);
    return event;
  };

  beforeEach(() => {
    moveNode.mockClear();
    toggleSelection.mockClear();
  });

  it.each([
    ["ArrowLeft", -10, 0],
    ["ArrowRight", 10, 0],
    ["ArrowUp", 0, -10],
    ["ArrowDown", 0, 10],
  ])("%s 移动 10px，并阻止默认行为（页面不跟着滚动）", (key, dx, dy) => {
    const event = press({ key });
    expect(moveNode).toHaveBeenCalledExactlyOnceWith("n1", dx, dy);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it.each([
    ["ArrowLeft", -50, 0],
    ["ArrowRight", 50, 0],
    ["ArrowUp", 0, -50],
    ["ArrowDown", 0, 50],
  ])("按住 Shift，%s 加速到 50px", (key, dx, dy) => {
    press({ key, shiftKey: true });
    expect(moveNode).toHaveBeenCalledExactlyOnceWith("n1", dx, dy);
  });

  it("Shift+空格切换选中，并阻止默认行为；不移动节点", () => {
    const event = press({ key: " ", shiftKey: true });
    expect(toggleSelection).toHaveBeenCalledExactlyOnceWith("n1");
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(moveNode).not.toHaveBeenCalled();
  });

  it("单独的空格与其他键不处理，也不阻止默认行为（Tab、Enter 等交给浏览器和各自的组件）", () => {
    for (const init of [{ key: " " }, { key: "Enter" }, { key: "Tab" }, { key: "a", shiftKey: true }]) {
      expect(press(init).preventDefault, init.key).not.toHaveBeenCalled();
    }
    expect(moveNode).not.toHaveBeenCalled();
    expect(toggleSelection).not.toHaveBeenCalled();
  });

  it("带 Ctrl / Meta / Alt 任一修饰键时一律不处理（方向键与 Shift+空格都是）", () => {
    for (const modifier of ["ctrlKey", "metaKey", "altKey"] as const) {
      for (const init of [{ key: "ArrowRight" }, { key: "ArrowUp", shiftKey: true }, { key: " ", shiftKey: true }]) {
        expect(press({ ...init, [modifier]: true }).preventDefault, `${modifier} ${init.key}`).not.toHaveBeenCalled();
      }
    }
    expect(moveNode).not.toHaveBeenCalled();
    expect(toggleSelection).not.toHaveBeenCalled();
  });

  it("焦点在节点内部的控件上（事件目标不是节点自身）时不处理，留给控件本身", () => {
    for (const init of [{ key: "ArrowLeft" }, { key: "ArrowDown", shiftKey: true }, { key: " ", shiftKey: true }]) {
      expect(press(init, CONTROL).preventDefault, init.key).not.toHaveBeenCalled();
    }
    expect(moveNode).not.toHaveBeenCalled();
    expect(toggleSelection).not.toHaveBeenCalled();
  });
});

describe("节点自己的按键（isNodeKey）：节点自有的其他按键（如会话卡的 Enter）与方向键同一道关", () => {
  it("焦点在节点本身、不带系统修饰键：是；Shift 不算修饰键", () => {
    expect(isNodeKey(keyEvent({ key: "Enter" }))).toBe(true);
    expect(isNodeKey(keyEvent({ key: "Enter", shiftKey: true }))).toBe(true);
  });

  it("焦点在内部控件上：不是", () => {
    expect(isNodeKey(keyEvent({ key: "Enter" }, CONTROL))).toBe(false);
  });

  it("带 Ctrl / Meta / Alt 任一：不是", () => {
    for (const modifier of ["ctrlKey", "metaKey", "altKey"] as const) {
      expect(isNodeKey(keyEvent({ key: "Enter", [modifier]: true })), modifier).toBe(false);
    }
  });
});
