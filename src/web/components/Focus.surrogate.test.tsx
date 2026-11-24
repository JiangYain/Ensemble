import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog, testOrigin } from "@shared/testing";
import { store } from "../lib/app";
import { Focus } from "./Focus";

/** 😀 在 UTF-16 里是 D83D DE00 两个码元。 */
const EMOJI = "\u{1F600}";
/** 孤立的高位或低位代理项（页面上会变成乱码字符）。 */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** 聚焦页头部“发起端”那一格里写出来的会话标识：自报的 conversationId 可以是任意字符串，页面只取它的前 10 个码元。 */
function headRef(id: string): string {
  const log = new EventLog("ses_focus_surrogate");
  log.created({ origin: testOrigin({ key: "cursor:surrogate", host: "cursor", hostLabel: "Cursor", sessionRef: { id, kind: "conversation", source: "declared" } }) });
  const state = replay(log.events);
  if (!state) throw new Error("missing session state");
  const summary = toSummary(state);
  const previous = store.get();
  store.set({ sessions: { [summary.id]: summary }, detail: { id: summary.id, state, rev: 0, loading: false }, lang: "zh" });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(<Focus id={summary.id} />));
    return host.querySelector<HTMLElement>(".head-origin .mono.head-origin-ref")?.textContent ?? "";
  } finally {
    act(() => root.unmount());
    host.remove();
    store.set(previous);
    vi.unstubAllGlobals();
  }
}

it("leaves out the first half of an emoji when the 10-unit cut of a self-declared session id would separate it from its second half", () => {
  // 😀 占下标 9、10：取前 10 个码元会切开它，所以只显示前面 9 个 a。
  const shown = headRef(`${"a".repeat(9)}${EMOJI}tail`);
  expect(shown).toBe("a".repeat(9));
  expect(LONE.test(shown)).toBe(false);
});

it("keeps an emoji that fits inside the first 10 units, and shows an ordinary id as before", () => {
  // 😀 占下标 8、9：前 10 个码元正好包住整个 emoji。
  expect(headRef(`${"a".repeat(8)}${EMOJI}tail`)).toBe(`${"a".repeat(8)}${EMOJI}`);
  expect(headRef("4706e0d9-12d7-4b10-a784-5d3416b186a9")).toBe("4706e0d9-1");
});
