import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog } from "@shared/testing";
import type { AttentionItem, SessionSummary } from "@shared/types";
import { setLang } from "../lib/app";
import { contextMenuNode } from "../lib/contextMenu";
import { agentNodeId } from "../scene/layout";
import { AgentNode } from "./AgentNode";
import { engine } from "./AgentNode.fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 会话卡片测试之二：头部右端——菜单打开时卡片保持悬停外观（data-menu-open）、“值得留意”的琥珀标记、待发与干预标记，以及菜单按钮永远在最右。
// 头部与正文图标、副标题在 AgentNode.test.tsx，工作中的氤氲在 AgentNode.aura.test.tsx；共用的夹具在 AgentNode.fixtures.ts。

describe("会话卡片的菜单悬停外观（data-menu-open）", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    setLang("zh");
    contextMenuNode.set({ nodeId: undefined });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const cards = ["ses_one", "ses_two"].map((id) => {
      const log = new EventLog(id);
      log.created({ id, harness: "cursor", runtime: "native" });
      return toSummary(replay(log.events)!);
    });
    act(() =>
      root.render(
        <>
          {cards.map((summary) => (
            <AgentNode key={summary.id} summary={summary} engine={engine} />
          ))}
        </>,
      ),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    contextMenuNode.set({ nodeId: undefined });
  });

  const card = (id: string): HTMLElement => host.querySelector<HTMLElement>(`[data-node-id="${agentNodeId(id)}"]`)!;

  it("“···”菜单打开时保持，关闭后恢复；只影响自己", () => {
    const dots = card("ses_one").querySelector<HTMLButtonElement>(".a-menu")!;
    expect(card("ses_one").hasAttribute("data-menu-open")).toBe(false);
    act(() => dots.click());
    expect(card("ses_one").hasAttribute("data-menu-open")).toBe(true);
    expect(card("ses_two").hasAttribute("data-menu-open")).toBe(false);
    act(() => dots.click());
    expect(card("ses_one").hasAttribute("data-menu-open")).toBe(false);
  });

  it("右键菜单指向它时保持；换到别的卡片或收起后恢复", () => {
    act(() => contextMenuNode.set({ nodeId: agentNodeId("ses_one") }));
    expect(card("ses_one").hasAttribute("data-menu-open")).toBe(true);
    expect(card("ses_two").hasAttribute("data-menu-open")).toBe(false);
    act(() => contextMenuNode.set({ nodeId: agentNodeId("ses_two") }));
    expect(card("ses_one").hasAttribute("data-menu-open")).toBe(false);
    expect(card("ses_two").hasAttribute("data-menu-open")).toBe(true);
    act(() => contextMenuNode.set({ nodeId: undefined }));
    expect(card("ses_two").hasAttribute("data-menu-open")).toBe(false);
  });

  it("两种菜单各管各的：收起其中一个，另一个还开着时外观不丢", () => {
    const dots = card("ses_one").querySelector<HTMLButtonElement>(".a-menu")!;
    act(() => dots.click());
    act(() => contextMenuNode.set({ nodeId: agentNodeId("ses_one") }));
    act(() => dots.click());
    expect(card("ses_one").hasAttribute("data-menu-open")).toBe(true);
    act(() => contextMenuNode.set({ nodeId: undefined }));
    expect(card("ses_one").hasAttribute("data-menu-open")).toBe(false);
  });
});

describe("会话卡片上“值得留意”的标记", () => {
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

  const render = (attention: AttentionItem[] | undefined): HTMLElement => {
    const log = new EventLog("ses_watch");
    log.created({ harness: "cursor", runtime: "native" });
    const base = toSummary(replay(log.events)!);
    const summary: SessionSummary = { ...base, ...(attention ? { attention } : {}) };
    act(() => root.render(<AgentNode summary={summary} engine={engine} />));
    return host.querySelector<HTMLElement>(".node.agent")!;
  };
  const since = (ms: number): string => new Date(Date.now() - ms).toISOString();

  it("没有事实就没有标记", () => {
    expect(render(undefined).querySelector('.a-flag[data-tone="amber"]')).toBeNull();
    expect(render([]).querySelector('.a-flag[data-tone="amber"]')).toBeNull();
  });

  it("一条事实：只画图标；悬停读到标题和这句话，写的是事实而不是判断", () => {
    const flag = render([{ kind: "quiet", since: since(5 * 60_000), seq: 9 }]).querySelector<HTMLElement>('.a-flag[data-tone="amber"]')!;
    expect(flag.textContent).toBe("");
    const tip = flag.getAttribute("data-tip")!;
    expect(tip.split("\n")[0]).toBe("值得留意");
    expect(tip).toMatch(/已 5m 0\ds 没有收到任何事件，也没有进行中的工具调用/);
    expect(tip).not.toMatch(/卡住|失败|错误/);
    expect(flag.getAttribute("aria-label")).toBe(tip);
  });

  it("多条事实：图标旁写条数，提示逐条列出，并带上具体的步骤与文件名", () => {
    const flag = render([
      { kind: "long_tool", since: since(11 * 60_000), seq: 9, tool: { callId: "c1", name: "shell", category: "shell", title: "npm run build", startedAt: since(14 * 60_000) } },
      { kind: "shared_file", since: since(30_000), path: "C:/work/demo/src/engine.ts", withSessionIds: ["ses_other"] },
    ]).querySelector<HTMLElement>('.a-flag[data-tone="amber"]')!;
    expect(flag.textContent).toBe("2");
    const lines = flag.getAttribute("data-tip")!.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("npm run build");
    expect(lines[1]).toContain("开始于 14m");
    expect(lines[2]).toContain("engine.ts 也被另 1 个运行中的会话写过");
  });

  it("等待回答的提问也在这里：提示里写出问题的摘要与已等待的时长，仍是事实而不是判断", () => {
    const flag = render([
      { kind: "question", since: since(3 * 60_000), questionId: "qst_1", prompts: [{ key: "db", text: "Which database should the service use?", multiple: false, custom: true }] },
    ]).querySelector<HTMLElement>('.a-flag[data-tone="amber"]')!;
    expect(flag.textContent).toBe("");
    const tip = flag.getAttribute("data-tip")!;
    expect(tip.split("\n")[0]).toBe("值得留意");
    expect(tip).toMatch(/提问待回答：“Which database should the service use\?”（已等待 3m 0\ds）/);
    expect(tip).not.toMatch(/卡住|失败|错误/);
  });

  it("不改变卡片自己的状态，也不挤掉待发消息的标记", () => {
    const node = render([{ kind: "long_run", since: since(61 * 60_000) }]);
    expect(node.getAttribute("data-phase")).toBe("starting");
    expect(node.querySelectorAll(".a-head .a-flag")).toHaveLength(1);
    expect(node.querySelector(".a-head")!.lastElementChild).toBe(node.querySelector(".a-menu"));
  });
});

describe("会话卡片头部右端的标记与菜单", () => {
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

  const render = (patch: (base: SessionSummary) => Partial<SessionSummary>): HTMLElement => {
    const log = new EventLog("ses_flags");
    log.created({ harness: "claude", runtime: "native", model: { resolved: "claude-opus-4.1", label: "Claude Opus 4.1" }, effort: "max" });
    const base = toSummary(replay(log.events)!);
    act(() => root.render(<AgentNode summary={{ ...base, ...patch(base) }} engine={engine} />));
    return host.querySelector<HTMLElement>(".node.agent")!;
  };
  const headOrder = (node: HTMLElement): string[] => [...node.querySelector(".a-head")!.children].map((el) => (el.classList.contains("a-flag") ? `a-flag:${el.getAttribute("data-tone") ?? "plain"}` : el.className.split(" ")[0]!));

  it("头部次序：执行端图标 → 名字 → 模型与档位（弹性空白）→ 留意 → 待发 → 菜单；菜单永远在最右", () => {
    const node = render((base) => ({
      attention: [{ kind: "long_run", since: new Date(Date.now() - 61 * 60_000).toISOString() }],
      messages: { ...base.messages, pending: 2 },
    }));
    expect(headOrder(node)).toEqual(["a-mark", "o-label", "a-room", "a-flag:amber", "a-flag:blue", "icon-btn"]);
    expect(node.querySelector(".a-head")!.lastElementChild).toBe(node.querySelector(".a-menu"));
    expect(node.querySelector(".a-head .a-flag[data-tone='blue']")?.textContent).toBe("2");
  });

  it("没有待发、有用户干预记录时换成手形标记，且不与待发标记同时出现", () => {
    const node = render((base) => ({ counters: { ...base.counters, interventions: 3 } }));
    expect(headOrder(node)).toEqual(["a-mark", "o-label", "a-room", "a-flag:plain", "icon-btn"]);
    const flag = node.querySelector<HTMLElement>(".a-head .a-flag")!;
    expect(flag.textContent).toBe("3");
    expect(flag.getAttribute("data-tip")).toBeTruthy();

    // 待发优先：同时存在时只画待发，不叠两个标记。
    const both = render((base) => ({ messages: { ...base.messages, pending: 1 }, counters: { ...base.counters, interventions: 3 } }));
    expect(headOrder(both)).toEqual(["a-mark", "o-label", "a-room", "a-flag:blue", "icon-btn"]);
  });

  it("什么标记都没有时，头部只有图标、名字、模型与档位（弹性空白）与菜单；菜单仍是同一个按钮（可打开、有标签）", () => {
    const node = render(() => ({}));
    expect(headOrder(node)).toEqual(["a-mark", "o-label", "a-room", "icon-btn"]);
    const menu = node.querySelector<HTMLButtonElement>(".a-head .a-menu")!;
    expect(menu.getAttribute("aria-label")).toBe("会话操作");
    expect(menu.querySelectorAll(".a-dots i")).toHaveLength(3);
  });
});
