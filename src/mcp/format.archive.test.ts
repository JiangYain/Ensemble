import { describe, expect, it } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog } from "@shared/testing";
import type { SessionSummary } from "@shared/types";
import { renderSessionDetail, renderSessionLine, renderSessions, sessionHead } from "./format";

/**
 * 已归档的会话在 MCP 输出里的文字：状态后面的 “(archived)” 标记，与详情里写明时间与谁归档的那一行。
 * 都是纯函数，这里只测“写成什么字”；工具里怎么用上它们（status / wait / read）见 bridge.archive.test.ts。
 */

const AT = "2026-05-30T08:00:00.000Z";

function summaryOf(id = "ses_test"): SessionSummary {
  const log = new EventLog(id);
  log.created();
  const state = replay(log.events);
  if (!state) throw new Error("replay failed");
  return toSummary(state);
}

function archived(by?: "user" | "retention", id?: string): SessionSummary {
  return { ...summaryOf(id), archivedAt: AT, ...(by ? { archivedBy: by } : {}) };
}

describe("an archived session in a one-line summary", () => {
  it("is marked after its state, and a session that is not archived is not", () => {
    expect(sessionHead(archived("user"))).toMatch(/ \(archived\)$/);
    expect(renderSessionLine(archived("user"))).toMatch(/ \(archived\)$/);
    expect(sessionHead(summaryOf())).not.toContain("archived");
    expect(renderSessionLine(summaryOf())).not.toContain("archived");
  });

  it("keeps the id, harness and title in front, so the line still reads the same up to the mark", () => {
    const plain = renderSessionLine(summaryOf());
    expect(renderSessionLine(archived("user"))).toBe(`${plain} (archived)`);
  });

  it("marks only the archived ones in a list", () => {
    const lines = renderSessions([summaryOf("ses_open"), archived("retention", "ses_old")]).split("\n");

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("ses_open");
    expect(lines[0]).not.toContain("(archived)");
    expect(lines[1]).toContain("ses_old");
    expect(lines[1]).toContain("(archived)");
  });
});

describe("an archived session in the detailed view", () => {
  const archivedLine = (text: string): string | undefined => text.split("\n").find((line) => line.startsWith("    archived: "));

  it("says when it was archived and by whom, and that the history is still there", () => {
    expect(archivedLine(renderSessionDetail(archived("user")))).toBe(
      `    archived: ${AT} by the user — moved out of the default view; the history is kept and still readable`,
    );
    expect(archivedLine(renderSessionDetail(archived("retention")))).toBe(
      `    archived: ${AT} by the retention policy — moved out of the default view; the history is kept and still readable`,
    );
  });

  it("does not make up an actor when the record does not say who archived it", () => {
    expect(archivedLine(renderSessionDetail(archived()))).toBe(`    archived: ${AT} — moved out of the default view; the history is kept and still readable`);
  });

  it("has no such line for a session that is not archived, and the first line carries the mark", () => {
    expect(archivedLine(renderSessionDetail(summaryOf()))).toBeUndefined();
    expect(renderSessionDetail(archived("user")).split("\n")[0]).toMatch(/ \(archived\)$/);
  });

  it("renders the detail of every session in a list the same way", () => {
    const text = renderSessions([archived("user", "ses_old")], { detail: true });

    expect(text).toContain(`    archived: ${AT} by the user`);
  });
});
