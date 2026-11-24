import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replay, toSummary, type SessionState } from "@shared/projection";
import { EventLog } from "@shared/testing";
import type { SessionMeta, SessionSummary } from "@shared/types";
import { routeHash, setLang, store } from "../lib/app";
import { archivedSummary } from "../lib/archive.fixtures";
import { idHead } from "../lib/text";
import { TaskPanel } from "./Panels";

/**
 * 汇聚（一个会话跟随多个上级）时聚焦页“任务”里的上级：每个上级一行、放在同一个分组里，认不出的逐个点名；
 * 单上级的那一行（没有分组、认不出时一句说明）与以前一样，由 Panels.relink.test.tsx 守着，这里只确认两者没有混在一起。
 */

function stateOf(id: string, meta: Partial<SessionMeta> = {}): SessionState {
  const log = new EventLog(id);
  log.created({ title: id, ...meta });
  const state = replay(log.events);
  if (!state) throw new Error("replay failed");
  return state;
}

const titled = (id: string, title: string): SessionSummary => toSummary(stateOf(id, { title }));

describe("TaskPanel 里的上级（汇聚）", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const previous = store.get();

  beforeEach(() => {
    setLang("zh");
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    location.hash = "";
    store.set({ sessions: { p1: titled("p1", "第一部分"), p2: titled("p2", "第二部分") }, archived: {}, archivedLoaded: true, archivedCount: 0 });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    location.hash = "";
    store.set(previous);
    vi.unstubAllGlobals();
  });

  const render = (meta: Partial<SessionMeta>): void => {
    const state = stateOf("join", meta);
    act(() => root.render(<TaskPanel state={state} summary={toSummary(state)} />));
  };

  const links = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(".parent-link")];
  const group = (): HTMLElement | null => host.querySelector<HTMLElement>(".parent-links");
  // 页脚的说明是 .panel-stack 的直接子元素；各分区里的 p.muted（例如“没有上下文”）在分区里面，不算。
  const footnotes = (): string[] => [...host.querySelectorAll(".panel-stack > p.muted")].map((one) => one.textContent ?? "");

  it("每个上级一行，放在同一个分组里，先后与记录的一致；分组带读屏名称，写明跟随了几个", () => {
    render({ parentSessionId: "p2", parentSessionIds: ["p2", "p1"], depth: 1 });

    expect(group()).not.toBeNull();
    expect(group()?.getAttribute("role")).toBe("group");
    expect(group()?.getAttribute("aria-label")).toBe("跟随 2 个会话");
    expect(group()?.children).toHaveLength(2);
    expect([...group()!.children].every((one) => one.classList.contains("parent-link"))).toBe(true);
    expect(links().map((one) => one.textContent)).toEqual(["上级会话第二部分", "上级会话第一部分"]);
    expect(footnotes()).toEqual([]);
  });

  it("每一行都能点：点到哪一个，就去哪一个会话", () => {
    render({ parentSessionId: "p1", parentSessionIds: ["p1", "p2"], depth: 1 });

    act(() => links()[1]!.click());
    expect(location.hash).toBe(routeHash({ kind: "session", id: "p2" }));

    act(() => links()[0]!.click());
    expect(location.hash).toBe(routeHash({ kind: "session", id: "p1" }));
  });

  it("上级里有认不出的：认得出的照常成行，认不出的在页脚逐个点名（只写 id 的开头），不用单上级的那句话", () => {
    const gone = "ses_0123456789abcdefghij";
    render({ parentSessionId: "p1", parentSessionIds: ["p1", gone], depth: 1 });

    expect(links().map((one) => one.textContent)).toEqual(["上级会话第一部分"]);
    expect(group()?.getAttribute("aria-label")).toBe("跟随 2 个会话");
    expect(footnotes()).toEqual([`所跟随的会话 ${idHead(gone, 12)} 的记录已不存在。`]);
    expect(host.textContent).not.toContain("上级会话的记录已不存在");
  });

  it("主上级认不出、别的上级认得出：认得出的仍然成行，主上级在页脚点名", () => {
    const gone = "ses_zzzzzzzzzzzzzzzzzzzz";
    render({ parentSessionId: gone, parentSessionIds: [gone, "p2"], depth: 1 });

    expect(links().map((one) => one.textContent)).toEqual(["上级会话第二部分"]);
    expect(footnotes()).toEqual([`所跟随的会话 ${idHead(gone, 12)} 的记录已不存在。`]);
  });

  it("所有上级都认不出：不画空的分组，页脚把每一个都点出来", () => {
    const first = "ses_aaaaaaaaaaaaaaaaaaaa";
    const second = "ses_bbbbbbbbbbbbbbbbbbbb";
    render({ parentSessionId: first, parentSessionIds: [first, second], depth: 1 });

    expect(group()).toBeNull();
    expect(links()).toEqual([]);
    expect(footnotes()).toEqual([`所跟随的会话 ${idHead(first, 12)} 的记录已不存在。`, `所跟随的会话 ${idHead(second, 12)} 的记录已不存在。`]);
  });

  it("上级在已归档表里也认得（和单上级一样）", () => {
    store.set({ sessions: { p1: titled("p1", "第一部分") }, archived: { p2: archivedSummary("p2", { title: "第二部分" }) }, archivedLoaded: true, archivedCount: 1 });
    render({ parentSessionId: "p1", parentSessionIds: ["p1", "p2"], depth: 1 });

    expect(links().map((one) => one.textContent)).toEqual(["上级会话第一部分", "上级会话第二部分"]);
    expect(footnotes()).toEqual([]);
  });

  it("单上级：一行，没有分组；认不出时仍是原来的那一句", () => {
    render({ parentSessionId: "p1", depth: 1 });

    expect(group()).toBeNull();
    expect(links().map((one) => one.textContent)).toEqual(["上级会话第一部分"]);
    expect(footnotes()).toEqual([]);

    render({ parentSessionId: "ses_gone", depth: 1 });
    expect(group()).toBeNull();
    expect(links()).toEqual([]);
    expect(footnotes()).toEqual(["上级会话的记录已不存在。"]);
  });

  it("没有上级：什么都不画", () => {
    render({});

    expect(group()).toBeNull();
    expect(links()).toEqual([]);
    expect(footnotes()).toEqual([]);
  });

  it("英文界面：分组的读屏名称与页脚的说明也跟着换", () => {
    setLang("en");
    store.set({ sessions: { p1: titled("p1", "First part") } });
    const gone = "ses_0123456789abcdefghij";
    render({ parentSessionId: "p1", parentSessionIds: ["p1", gone], depth: 1 });

    expect(group()?.getAttribute("aria-label")).toBe("Follows 2 sessions");
    expect(links().map((one) => one.textContent)).toEqual(["Parent sessionFirst part"]);
    expect(footnotes()).toEqual([`The record of the followed session ${idHead(gone, 12)} no longer exists.`]);
  });
});
