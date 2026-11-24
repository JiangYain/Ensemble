import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NodeContextRequest } from "./engine";
import { mountPair } from "./engine.fixtures";

/**
 * 特征化测试：节点上的右键请求（`onNodeContext`）里几处别的测试没有钉住的边界——处理者的询问次序、
 * 作用范围的人数门槛、键盘触发的判定与它在卸载时的复位。拆分引擎之前在旧实现上跑绿，拆分之后必须仍然全绿。
 */
describe("canvas node context requests", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
  });

  const menu = (target: Element, init: MouseEventInit = {}): MouseEvent => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, ...init });
    target.dispatchEvent(event);
    return event;
  };

  const key = (init: KeyboardEventInit): void => {
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  };

  it("asks the handlers in the order they were registered and stops at the first one that takes the request", () => {
    const { engine, agent } = mountPair();
    try {
      const asked: string[] = [];
      const handler = (name: string, take: boolean) => (): boolean => {
        asked.push(name);
        return take;
      };
      engine.onNodeContext(handler("declines", false));
      engine.onNodeContext(handler("takes", true));
      engine.onNodeContext(handler("never asked", true));
      expect(menu(agent).defaultPrevented).toBe(true);
      expect(asked).toEqual(["declines", "takes"]);
    } finally {
      engine.unmount();
    }
  });

  it("scopes the request to the selection from two selected nodes up, and to the one node below that", () => {
    const { engine, origin, agent } = mountPair();
    try {
      const requests: NodeContextRequest[] = [];
      engine.onNodeContext((request) => {
        requests.push(request);
        return true;
      });
      engine.toggleSelection("agent:one");
      menu(agent);
      expect(requests[0]).toMatchObject({ nodeId: "agent:one", scope: "node", ids: ["agent:one"] });
      engine.toggleSelection("origin:one");
      menu(agent);
      expect(requests[1]).toMatchObject({ nodeId: "agent:one", scope: "selection", ids: ["agent:one", "origin:one"] });
      menu(origin);
      expect(requests[2]).toMatchObject({ nodeId: "origin:one", scope: "selection", ids: ["agent:one", "origin:one"] });
    } finally {
      engine.unmount();
    }
  });

  it("takes the pointer position from the event unless it looks like a keyboard-made event: a primary button at exactly (0, 0)", () => {
    const { engine, agent } = mountPair();
    try {
      const points: (NodeContextRequest["point"])[] = [];
      engine.onNodeContext((request) => {
        points.push(request.point);
        return true;
      });
      menu(agent, { button: 0, clientX: 0, clientY: 77 });
      menu(agent, { button: 0, clientX: 123, clientY: 0 });
      menu(agent, { button: 2, clientX: 0, clientY: 0 });
      menu(agent, { button: 0, clientX: 0, clientY: 0 });
      expect(points).toEqual([{ x: 0, y: 77 }, { x: 123, y: 0 }, { x: 0, y: 0 }, undefined]);
    } finally {
      engine.unmount();
    }
  });

  it("forgets a ContextMenu key press when the canvas is unmounted, so after a remount the next right-click has its pointer position", () => {
    const { engine, viewport, world, tube, dots, agent } = mountPair();
    try {
      const points: (NodeContextRequest["point"])[] = [];
      engine.onNodeContext((request) => {
        points.push(request.point);
        return true;
      });
      key({ key: "ContextMenu" });
      engine.unmount();
      engine.mount({ viewport, world, pipes: { tube, dots } });
      menu(agent, { clientX: 123, clientY: 77 });
      expect(points).toEqual([{ x: 123, y: 77 }]);
      // 同样的按键没有被卸载清掉的话（没有卸载），紧随其后的 contextmenu 不用坐标。
      key({ key: "F10", shiftKey: true });
      menu(agent, { clientX: 123, clientY: 77 });
      expect(points).toEqual([{ x: 123, y: 77 }, undefined]);
    } finally {
      engine.unmount();
    }
  });
});
