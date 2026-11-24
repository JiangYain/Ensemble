import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog, testOrigin } from "@shared/testing";
import { openSwitcher, setLang, store } from "../lib/app";
import { buildWorkspaces } from "../lib/workspaces";
import { QuickSwitcher } from "./QuickSwitcher";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 😀 在 UTF-16 里是 D83D DE00 两个码元。 */
const EMOJI = "\u{1F600}";
/** 孤立的高位或低位代理项（页面上会变成乱码字符）。 */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("QuickSwitcher: the short session id in a Main Agent row that has no host title", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let previous: ReturnType<typeof store.get>;

  beforeEach(() => {
    previous = store.get();
    location.hash = "";
    store.set({ switcherOpen: false, recentOrigins: [] });
    setLang("zh");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    location.hash = "";
    store.set(previous);
  });

  /** 渲染一个来源只有一次委派、没有宿主标题的切换器，返回第一行的主标题；自报的会话标识是 id。 */
  function firstRowTitle(id: string): string {
    const log = new EventLog("ses_switcher_surrogate");
    log.created({ origin: testOrigin({ key: "cursor:surrogate", host: "cursor", hostLabel: "Cursor", sessionRef: { id, kind: "conversation", source: "declared" } }) });
    const state = replay(log.events);
    if (!state) throw new Error("missing session state");
    const sessions = [toSummary(state)];
    const workspaces = buildWorkspaces(sessions);
    act(() => openSwitcher());
    act(() => root.render(<QuickSwitcher workspaces={workspaces} sessions={sessions} currentScope={{ kind: "all" }} />));
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"][aria-label="快速切换"]');
    if (!dialog) throw new Error("the switcher did not open");
    return dialog.querySelector('[role="option"] .switcher-primary')?.textContent ?? "";
  }

  it("leaves out the first half of an emoji that the 8-unit cut would separate from its second half", () => {
    // 😀 占下标 7、8：取前 8 个码元会切开它，所以只显示前面 7 个 a。
    const title = firstRowTitle(`${"a".repeat(7)}${EMOJI}tail`);
    expect(title).toBe(`Cursor · ${"a".repeat(7)}`);
    expect(LONE.test(title)).toBe(false);
  });

  it("keeps an emoji that fits inside the first 8 units, and shows an ordinary id as before", () => {
    // 😀 占下标 6、7：前 8 个码元正好包住整个 emoji。
    expect(firstRowTitle(`${"a".repeat(6)}${EMOJI}tail`)).toBe(`Cursor · ${"a".repeat(6)}${EMOJI}`);
  });

  it("shows the first 8 characters of an ordinary id", () => {
    expect(firstRowTitle("4706e0d9-12d7-4b10-a784-5d3416b186a9")).toBe("Cursor · 4706e0d9");
  });
});
