import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog } from "@shared/testing";
import { setLang } from "../lib/app";
import type { SceneEngine } from "../scene/engine";
import { agentNodeId } from "../scene/layout";
import { AgentNode } from "./AgentNode";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION = "ses_card";
const NODE_ID = agentNodeId(SESSION);

describe("会话卡片的键盘操作", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const moveNode = vi.fn();
  const toggleSelection = vi.fn();
  const engine = { register: () => () => undefined, toggleSelection, moveNode } as unknown as SceneEngine;

  beforeEach(() => {
    setLang("zh");
    moveNode.mockClear();
    toggleSelection.mockClear();
    // navigate 在地址没变时什么都不做：每个用例从空地址开始，才看得出有没有跳转。
    location.hash = "";
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const log = new EventLog(SESSION);
    log.created({ harness: "cursor", runtime: "native" });
    const summary = toSummary(replay(log.events)!);
    act(() => root.render(<AgentNode summary={summary} engine={engine} />));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    location.hash = "";
  });

  const card = (): HTMLElement => host.querySelector<HTMLElement>(".node.agent")!;
  const press = (init: KeyboardEventInit, target: HTMLElement = card()): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  };

  it("方向键移动节点（Shift 加速到 50px），Shift+空格切换选中，都阻止默认行为", () => {
    expect(press({ key: "ArrowRight" }).defaultPrevented).toBe(true);
    expect(moveNode).toHaveBeenLastCalledWith(NODE_ID, 10, 0);
    expect(press({ key: "ArrowUp", shiftKey: true }).defaultPrevented).toBe(true);
    expect(moveNode).toHaveBeenLastCalledWith(NODE_ID, 0, -50);
    expect(moveNode).toHaveBeenCalledTimes(2);

    expect(press({ key: " ", shiftKey: true }).defaultPrevented).toBe(true);
    expect(toggleSelection).toHaveBeenCalledExactlyOnceWith(NODE_ID);
    expect(location.hash).toBe("");
  });

  it("Enter 打开这个会话：阻止默认行为，卡片带上共享元素过渡的名字；不移动也不选中", () => {
    expect(card().style.viewTransitionName).toBeFalsy();
    expect(press({ key: "Enter" }).defaultPrevented).toBe(true);
    expect(location.hash).toBe(`#/s/${SESSION}`);
    expect(card().style.viewTransitionName).toBe("session-card");
    expect(moveNode).not.toHaveBeenCalled();
    expect(toggleSelection).not.toHaveBeenCalled();
  });

  it("焦点在卡片内部的控件上（标题链接、菜单按钮）时，方向键、Shift+空格与 Enter 都不处理：留给控件本身", () => {
    for (const target of [card().querySelector<HTMLElement>("a")!, card().querySelector<HTMLElement>("button")!]) {
      for (const init of [{ key: "ArrowLeft" }, { key: " ", shiftKey: true }, { key: "Enter" }]) {
        expect(press(init, target).defaultPrevented, `${target.tagName} ${init.key}`).toBe(false);
      }
    }
    expect(moveNode).not.toHaveBeenCalled();
    expect(toggleSelection).not.toHaveBeenCalled();
    expect(location.hash).toBe("");
    expect(card().style.viewTransitionName).toBeFalsy();
  });

  it("带 Ctrl / Meta / Alt 时不处理：方向键、Shift+空格与 Enter 都不动作，也不阻止默认行为", () => {
    for (const modifier of ["ctrlKey", "metaKey", "altKey"] as const) {
      for (const init of [{ key: "ArrowRight" }, { key: " ", shiftKey: true }, { key: "Enter" }]) {
        expect(press({ ...init, [modifier]: true }).defaultPrevented, `${modifier} ${init.key}`).toBe(false);
      }
    }
    expect(moveNode).not.toHaveBeenCalled();
    expect(toggleSelection).not.toHaveBeenCalled();
    expect(location.hash).toBe("");
    expect(card().style.viewTransitionName).toBeFalsy();
  });

  it("其他键不处理，也不阻止默认行为（Tab 照常移走焦点）", () => {
    for (const init of [{ key: "Tab" }, { key: " " }, { key: "Escape" }]) {
      expect(press(init).defaultPrevented, init.key).toBe(false);
    }
    expect(moveNode).not.toHaveBeenCalled();
    expect(toggleSelection).not.toHaveBeenCalled();
    expect(location.hash).toBe("");
  });
});
