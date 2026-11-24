import { act } from "react";
import { createRoot } from "react-dom/client";
import { replay, toSummary } from "@shared/projection";
import { EventLog } from "@shared/testing";
import type { SessionSummary } from "@shared/types";
import { store } from "../lib/app";
import { SceneEngine } from "../scene/engine";
import { agentNodeId } from "../scene/layout";
import { AgentNode } from "./AgentNode";
import { NodeContextMenu } from "./NodeContextMenu";

/**
 * 画布节点右键菜单的测试共用的夹具（只被测试引用，不进页面的打包）：造会话摘要、真实的引擎加真实的节点、查菜单的小工具、触发右键与按键。
 * 单个会话节点、多选、批量动作各一份测试：NodeContextMenu.test.tsx、NodeContextMenu.multi.test.tsx、NodeContextMenu.batch.test.tsx。
 * vi 的桩与 beforeEach / afterEach 是按文件生效的，三份测试各写各的；`act` 环境的开关也照原样由各份测试自己写一行。
 */

const SVG_NS = "http://www.w3.org/2000/svg";

export function summaryOf(id: string, patch: Partial<SessionSummary>): SessionSummary {
  const log = new EventLog(id);
  log.created({ id, title: `会话 ${id}`, harness: "cursor", runtime: "native" });
  return { ...toSummary(replay(log.events)!), ...patch };
}

/** 四种会话：运行中、已完成、已关闭、排队中（有一条消息在途）。 */
export function sessionsFixture(): Record<string, SessionSummary> {
  const list = [
    summaryOf("ses_run", { title: "运行中的会话", phase: "running", status: "running", activeRunId: "run_1", seq: 10 }),
    summaryOf("ses_done", { title: "已完成的会话", phase: "done", status: "idle", seq: 10 }),
    summaryOf("ses_stop", { title: "已关闭的会话", phase: "stopped", status: "stopped", seq: 10 }),
    summaryOf("ses_queue", { title: "排队中的会话", phase: "queued", status: "queued", messages: { total: 1, pending: 1 }, seq: 10 }),
  ];
  return Object.fromEntries(list.map((summary) => [summary.id, summary]));
}

export const NODE_RECT = (index: number): DOMRectInit => ({ x: 100 + index * 300, y: 200, width: 248, height: 112 });
export const MENU_SIZE = { width: 224, height: 300 };

export interface Scene {
  engine: SceneEngine;
  viewport: HTMLElement;
  node(id: string): HTMLElement;
  origin(key: string): HTMLElement;
  root: ReturnType<typeof createRoot>;
  dispose(): void;
}

/** 真实的引擎 + 真实的会话节点 + 两个来源节点（没有菜单的那种），菜单宿主挂在同一棵树里。 */
export function mountScene(sessions: Record<string, SessionSummary>): Scene {
  const viewport = document.createElement("div");
  viewport.className = "scene";
  const world = document.createElement("div");
  const agents = document.createElement("div");
  const svg = document.createElementNS(SVG_NS, "svg");
  const tube = document.createElementNS(SVG_NS, "g");
  const dots = document.createElementNS(SVG_NS, "g");
  svg.append(tube, dots);
  world.append(agents);
  viewport.append(world, svg);
  document.body.append(viewport);
  Object.defineProperties(viewport, { clientWidth: { value: 1200, configurable: true }, clientHeight: { value: 800, configurable: true } });

  const engine = new SceneEngine();
  const origins = new Map<string, HTMLElement>();
  for (const key of ["o", "p"]) {
    const el = document.createElement("div");
    el.dataset["nodeId"] = `origin:${key}`;
    el.tabIndex = 0;
    el.textContent = `来源 ${key}`;
    world.append(el);
    origins.set(key, el);
    engine.register(`origin:${key}`, el);
  }
  engine.mount({ viewport, world, pipes: { tube, dots } });

  store.set({ sessions });
  const root = createRoot(agents);
  act(() => {
    root.render(
      <>
        {Object.values(sessions).map((summary) => (
          <AgentNode key={summary.id} summary={summary} engine={engine} />
        ))}
        <NodeContextMenu engine={engine} />
      </>,
    );
  });
  const ids = [...Object.keys(sessions).map(agentNodeId), "origin:o", "origin:p"];
  engine.setLayout({
    nodes: ids.map((id, index) => ({ id, kind: id.startsWith("agent:") ? ("agent" as const) : ("origin" as const), x: index * 300, y: 0, w: 248, h: 112, overhang: { left: 0, right: 0 } })),
    edges: [],
    bounds: { x: 0, y: 0, w: 2000, h: 112 },
    origins: [],
    folders: [],
  });
  return {
    engine,
    viewport,
    node: (id) => viewport.querySelector<HTMLElement>(`[data-node-id="${agentNodeId(id)}"]`)!,
    origin: (key) => origins.get(key)!,
    root,
    dispose() {
      act(() => root.unmount());
      engine.unmount();
      viewport.remove();
    },
  };
}

export const menus = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role="menu"]')];
export const menuEl = (): HTMLElement => {
  const found = menus();
  if (found.length !== 1) throw new Error(`应该恰好有一个菜单，实际 ${found.length} 个`);
  return found[0]!;
};
export const itemNamed = (name: string | RegExp): HTMLElement => {
  const found = [...menuEl().querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => {
    const text = item.getAttribute("aria-label") ?? item.textContent ?? "";
    return typeof name === "string" ? text === name : name.test(text);
  });
  if (!found) throw new Error(`菜单里没有：${String(name)}`);
  return found;
};

export function contextmenu(target: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 140, clientY: 230, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}
export function press(name: string, init: KeyboardEventInit = {}, target: EventTarget = document.activeElement ?? document.body): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}
