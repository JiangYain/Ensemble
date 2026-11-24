import { describe, expect, it } from "vitest";
import { preferredAssistant } from "./timeline-selectors";
import type { AssistantItem, ReasoningItem, TimelineItem } from "./types";

describe("preferredAssistant", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const assistant = (id: string, text: string, extra: { phase?: "commentary" | "final"; runId?: string } = {}): AssistantItem => ({
    type: "assistant",
    id,
    at,
    updatedAt: at,
    text,
    streaming: false,
    ...(extra.phase ? { phase: extra.phase } : {}),
    ...(extra.runId ? { runId: extra.runId } : {}),
  });
  const reasoning = (id: string, text: string): ReasoningItem => ({ type: "reasoning", id, at, updatedAt: at, text, streaming: false });

  it("takes the last non-empty final text, even when process comments came after it", () => {
    const first = assistant("a1", "first", { phase: "final" });
    const last = assistant("a2", "second", { phase: "final" });
    const comment = assistant("a3", "still thinking", { phase: "commentary" });
    expect(preferredAssistant([first, last, comment])).toBe(last);
  });

  it("falls back to the last non-empty assistant text when nothing is marked final", () => {
    const comment = assistant("a1", "one", { phase: "commentary" });
    const plain = assistant("a2", "two");
    const blank = assistant("a3", " \n ", { phase: "commentary" });
    expect(preferredAssistant([comment, plain, blank])).toBe(plain);
  });

  it("ignores blank texts and other kinds of item, and finds nothing in an empty list", () => {
    const answer = assistant("a1", "answer", { phase: "final" });
    const blankFinal = assistant("a2", "   ", { phase: "final" });
    const items: TimelineItem[] = [answer, blankFinal, reasoning("r1", "not an answer")];
    expect(preferredAssistant(items)).toBe(answer);
    expect(preferredAssistant([reasoning("r2", "only reasoning")])).toBeUndefined();
    expect(preferredAssistant([])).toBeUndefined();
  });

  it("looks only at the run it is given when one is named", () => {
    const one = assistant("a1", "one", { phase: "final", runId: "run_1" });
    const two = assistant("a2", "two", { phase: "final", runId: "run_2" });
    const loose = assistant("a3", "no run", { phase: "final" });
    expect(preferredAssistant([one, two, loose], "run_1")).toBe(one);
    expect(preferredAssistant([one, two, loose], "run_2")).toBe(two);
    expect(preferredAssistant([one, two, loose], "run_3")).toBeUndefined();
    expect(preferredAssistant([one, two, loose])).toBe(loose);
  });

  it("hands back the timeline's own item with its text untouched, and does not depend on how ids are written", () => {
    const padded = assistant("same", "  padded answer \n", { phase: "final" });
    const later = assistant("same", "\tlater answer", { phase: "final" });
    expect(preferredAssistant([padded])).toBe(padded);
    expect(preferredAssistant([padded])?.text).toBe("  padded answer \n");
    // 两条 id 相同也只按位置与内容挑选。
    expect(preferredAssistant([padded, later])).toBe(later);
  });
});
