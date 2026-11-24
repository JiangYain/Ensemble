import { describe, expect, it } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog, testOrigin } from "@shared/testing";
import { translate } from "./i18n";
import { buildWorkspaces, workspaceDisplayTitle } from "./workspaces";

const t = (key: string, vars?: Record<string, string | number>) => translate("zh", key, vars);

/** 😀 在 UTF-16 里是 D83D DE00 两个码元。 */
const EMOJI = "\u{1F600}";
/** 孤立的高位或低位代理项（页面上会变成乱码字符）。 */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** 一个只有一次委派、没有宿主标题的来源，自报的会话标识是 id；返回它在侧栏与快速切换器里的显示名。 */
function displayTitleOf(id: string): string {
  const log = new EventLog("ses_ws_surrogate");
  log.created({ origin: testOrigin({ key: "cursor:surrogate", host: "cursor", hostLabel: "Cursor", sessionRef: { id, kind: "conversation", source: "declared" } }) });
  const state = replay(log.events);
  if (!state) throw new Error("missing session state");
  const item = buildWorkspaces([toSummary(state)])[0];
  if (!item) throw new Error("missing workspace item");
  return workspaceDisplayTitle(item, t);
}

describe("workspaceDisplayTitle: the short session id after the host name", () => {
  it("takes the first 8 units of the id, and the whole id when it is shorter", () => {
    expect(displayTitleOf("4706e0d9-12d7-4b10-a784-5d3416b186a9")).toBe("Cursor · 4706e0d9");
    expect(displayTitleOf("abc")).toBe("Cursor · abc");
  });

  it("leaves out the first half of an emoji that the cut would separate from its second half", () => {
    // 😀 占下标 7、8：取前 8 个码元会切开它，所以只留前面 7 个 a。
    const title = displayTitleOf(`${"a".repeat(7)}${EMOJI}tail`);
    expect(title).toBe(`Cursor · ${"a".repeat(7)}`);
    expect(LONE.test(title)).toBe(false);
  });

  it("keeps an emoji that fits inside the first 8 units", () => {
    // 😀 占下标 6、7：前 8 个码元正好包住整个 emoji。
    expect(displayTitleOf(`${"a".repeat(6)}${EMOJI}tail`)).toBe(`Cursor · ${"a".repeat(6)}${EMOJI}`);
  });
});
