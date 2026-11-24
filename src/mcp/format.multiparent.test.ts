import { describe, expect, it } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog } from "@shared/testing";
import type { SessionMeta, SessionSummary } from "@shared/types";
import { renderSessionDetail, renderSessionLine, renderSessions } from "./format";

/**
 * 汇聚（一个会话跟随多个上级）在 MCP 输出里的文字：详情里多一行 `follows:`，只有多于一个上级时才写；
 * 其余输出（一行摘要、单上级的详情）与以前一字不差。都是纯函数，这里只测“写成什么字”；
 * 委派时怎么传 `follows`、回执怎么写、老服务时怎么说明见 bridge.multiparent.test.ts。
 */

function summaryOf(meta: Partial<SessionMeta> = {}, id = "ses_join"): SessionSummary {
  const log = new EventLog(id);
  log.created(meta);
  const state = replay(log.events);
  if (!state) throw new Error("replay failed");
  return toSummary(state);
}

const joined = (): SessionSummary => summaryOf({ parentSessionId: "ses_a", parentSessionIds: ["ses_a", "ses_b", "ses_c"], depth: 1 });
const followsLine = (text: string): string | undefined => text.split("\n").find((line) => line.startsWith("    follows: "));

describe("a session that follows several sessions, in the detailed view", () => {
  it("lists every one of them, in the order the work was given, on one `follows:` line", () => {
    expect(followsLine(renderSessionDetail(joined()))).toBe("    follows: ses_a, ses_b, ses_c");
  });

  it("puts the line right after the workspace, where the other facts about where it runs sit", () => {
    const lines = renderSessionDetail(joined()).split("\n");
    const at = lines.findIndex((line) => line.startsWith("    workspace: "));

    expect(at).toBeGreaterThan(-1);
    expect(lines[at + 1]).toBe("    follows: ses_a, ses_b, ses_c");
  });

  it("keeps the order it was recorded in, so the first one is still the one the panel nests it under", () => {
    const reordered = summaryOf({ parentSessionId: "ses_c", parentSessionIds: ["ses_c", "ses_a"], depth: 1 });

    expect(followsLine(renderSessionDetail(reordered))).toBe("    follows: ses_c, ses_a");
  });

  it("is written for every session of a detailed list that has several parents, and only for those", () => {
    const text = renderSessions([joined(), summaryOf({ parentSessionId: "ses_a", depth: 1 }, "ses_single")], { detail: true });
    const lines = text.split("\n").filter((line) => line.startsWith("    follows: "));

    expect(lines).toEqual(["    follows: ses_a, ses_b, ses_c"]);
  });
});

describe("a session with one parent or none, which reads exactly as before", () => {
  it("has no `follows:` line, and a detail identical to the one of a session that follows nothing", () => {
    const single = summaryOf({ parentSessionId: "ses_a", depth: 1 });
    const none = summaryOf();

    expect(followsLine(renderSessionDetail(single))).toBeUndefined();
    expect(followsLine(renderSessionDetail(none))).toBeUndefined();
    // 单上级与无上级的详情里本来就不写上级（它在回执与面板里），这一点不因汇聚而改变。
    expect(renderSessionDetail(single)).toBe(renderSessionDetail(none));
  });

  it("does not make a line out of a set that only has one id in it (the service never writes one)", () => {
    const odd: SessionSummary = { ...summaryOf({ parentSessionId: "ses_a", depth: 1 }), parentSessionIds: ["ses_a"] };

    expect(followsLine(renderSessionDetail(odd))).toBeUndefined();
  });
});

describe("the one-line summary of a session that follows several sessions", () => {
  it("is the same line as for any other session: the parents are not part of it", () => {
    const single = summaryOf({ parentSessionId: "ses_a", depth: 1 });

    expect(renderSessionLine(joined())).toBe(renderSessionLine(single));
    expect(renderSessionLine(joined())).not.toContain("ses_b");
    expect(renderSessions([joined()])).toBe(renderSessionLine(joined()));
  });
});
