import { describe, expect, it } from "vitest";
import { fitCut } from "./fit";

/** 每个字符（包括“…”）7px 宽：不依赖任何字体，只检验“按字符数精确排”的逻辑。 */
const measure = (text: string): number => Array.from(text).length * 7;
const chars = (text: string): string[] => Array.from(text);

const ID = "agent-29b3312c-7fda-481f-9447-f4fb2a3549ea"; // 42 个字符
const PATH = "C:\\Users\\alice\\Desktop\\Ensemble"; // 31 个字符

describe("fitCut · middle", () => {
  const mode = { kind: "middle", tail: 6 } as const;

  it("leaves text alone when it fits, including when it fits exactly", () => {
    expect(fitCut(chars(ID), 400, measure, mode)).toBeUndefined();
    expect(fitCut(chars(ID), 42 * 7, measure, mode)).toBeUndefined();
  });

  it("keeps as many leading characters as fit next to the ellipsis and the tail", () => {
    // 120px 放 17 个字符：头 + “…” + 6 位尾部 → 头 10 个。
    expect(fitCut(chars(ID), 120, measure, mode)).toBe(10);
    // 一个字符的差别也要精确：121px 仍然是 17 个，126px 才能再多一个。
    expect(fitCut(chars(ID), 125, measure, mode)).toBe(10);
    expect(fitCut(chars(ID), 126.5, measure, mode)).toBe(11);
  });

  it("keeps a sub-pixel margin: exactly filling the box is treated as not fitting, so the last glyph is never clipped", () => {
    // 17 个字符恰好 119px。可用宽度正好 119 时，为不切到末尾字形，只放 16 个字符（头 9 个）。
    expect(fitCut(chars(ID), 119, measure, mode)).toBe(9);
    expect(fitCut(chars(ID), 119.25, measure, mode)).toBe(10);
  });

  it("never shows more than fits, however the space shrinks", () => {
    for (let width = 8; width < 42 * 7; width += 3) {
      const cut = fitCut(chars(ID), width, measure, mode);
      expect(cut).toBeDefined();
      const shown = ID.slice(0, cut) + "…" + ID.slice(-6);
      // 只有连“…”加尾部都放不下（cut 已经是 0）时才允许超出。
      if (cut! > 0) expect(measure(shown)).toBeLessThanOrEqual(width);
    }
  });

  it("falls back to ellipsis plus tail when even that does not fit", () => {
    expect(fitCut(chars(ID), 20, measure, mode)).toBe(0);
  });

  it("does not try to ellipsize a value that is no longer than its tail", () => {
    expect(fitCut(chars("abc"), 5, measure, { kind: "middle", tail: 6 })).toBeUndefined();
  });
});

describe("fitCut · start", () => {
  const mode = { kind: "start" } as const;

  it("leaves a path alone when it fits", () => {
    expect(fitCut(chars(PATH), 400, measure, mode)).toBeUndefined();
    expect(fitCut(chars(PATH), 31 * 7, measure, mode)).toBeUndefined();
  });

  it("hides the front and keeps the end of the path", () => {
    // 120px 放 17 个字符：“…” + 16 个字符 → 隐去前 15 个，剩下 “Desktop\Ensemble”。
    const cut = fitCut(chars(PATH), 120, measure, mode);
    expect(cut).toBe(15);
    expect(PATH.slice(cut)).toBe("Desktop\\Ensemble");
  });

  it("collapses to just the ellipsis when nothing else fits", () => {
    expect(fitCut(chars(PATH), 5, measure, mode)).toBe(31);
  });
});

describe("fitCut · edge cases", () => {
  it("does nothing without a usable width or without text", () => {
    expect(fitCut(chars(ID), 0, measure, { kind: "start" })).toBeUndefined();
    expect(fitCut(chars(ID), Number.NaN, measure, { kind: "start" })).toBeUndefined();
    expect(fitCut([], 100, measure, { kind: "start" })).toBeUndefined();
  });

  it("counts a character outside the BMP as one character, never splitting it", () => {
    const text = chars("ab😀cd😀ef");
    const cut = fitCut(text, 4 * 7 + 1, measure, { kind: "start" });
    // “…” + 3 个字符：隐去前 5 个，可见部分从第二个 😀 开始。
    expect(cut).toBe(5);
    expect(text.slice(cut).join("")).toBe("😀ef");
  });
});
