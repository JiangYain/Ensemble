import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NodeContextRequest } from "./engine";
import { mountPair } from "./engine.fixtures";

/**
 * 特征化测试（补洞）：节点上的右键菜单——别处已经处理过的 contextmenu 事件、还没落位的节点——引擎都不接管。
 * 拆分之前的实现里这两条没有测试守着，是拆分之后补跑单行变异时才暴露的（见 HARDEN-E 报告）。数值是未改动的引擎跑出来的结果。
 */
describe("canvas node context menu, the remaining corners", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
  });

  const contextmenu = (target: Element, init: MouseEventInit = {}): MouseEvent => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 40, clientY: 50, ...init });
    target.dispatchEvent(event);
    return event;
  };

  it("leaves a contextmenu event alone when something closer to the node has already handled it", () => {
    const { engine, agent } = mountPair();
    try {
      const requests: NodeContextRequest[] = [];
      engine.onNodeContext((request) => {
        requests.push(request);
        return true;
      });
      agent.addEventListener("contextmenu", (event) => event.preventDefault(), { once: true });
      const handled = contextmenu(agent);
      // 事件的默认行为已经被节点自己拦下：引擎不再问宿主要不要开菜单，选中也不动。
      expect(handled.defaultPrevented).toBe(true);
      expect(requests).toHaveLength(0);
      expect(engine.getSelectedIds()).toEqual([]);
      // 对照：没人处理过的右键，引擎照常接管。
      const free = contextmenu(agent);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ nodeId: "agent:one", scope: "node", ids: ["agent:one"] });
      expect(free.defaultPrevented).toBe(true);
    } finally {
      engine.unmount();
    }
  });

  it("does not open a menu for a node that has an element but no place on the canvas yet", () => {
    const rig = mountPair();
    const { engine, agent } = rig;
    try {
      const requests: NodeContextRequest[] = [];
      engine.onNodeContext((request) => {
        requests.push(request);
        return true;
      });
      // 先登记了元素、布局里还没有它（React 的 ref 先于布局）：它还不是画布上的节点。
      const late = rig.attach("agent:late");
      const early = contextmenu(late);
      expect(early.defaultPrevented).toBe(false);
      expect(requests).toHaveLength(0);
      expect(engine.getSelectedIds()).toEqual([]);
      // 对照：落了位的节点照常有菜单。
      expect(contextmenu(agent).defaultPrevented).toBe(true);
      expect(requests).toHaveLength(1);
    } finally {
      engine.unmount();
    }
  });
});
