import { describe, expect, it } from "vitest";
import { idHead, oneLine } from "./text";

/** 😀 在 UTF-16 里是 D83D DE00 两个码元。 */
const EMOJI = "\u{1F600}";
/** 孤立的高位或低位代理项（页面上会变成乱码字符）。 */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("oneLine", () => {
  it("keeps text that fits, and collapses whitespace first", () => {
    expect(oneLine("short text")).toBe("short text");
    expect(oneLine("abcdefghij", 10)).toBe("abcdefghij");
    expect(oneLine("  a \n\n b\t c  ")).toBe("a b c");
    expect(oneLine("   ")).toBe("");
  });

  it("cuts plain text to max - 1 units and adds the ellipsis, so the result is max long", () => {
    expect(oneLine("abcdefghijk", 10)).toBe("abcdefghi…");
    expect(oneLine("a  b\n\nc d e f", 6)).toBe("a b c…");
  });

  it("drops whitespace left at the end of the cut", () => {
    // 折叠后 "hello world foo"（15 个码元）；取前 6 个是 "hello "，去掉末尾空白再加省略号。
    expect(oneLine("hello world foo", 7)).toBe("hello…");
  });

  it("copes with a very small max", () => {
    expect(oneLine("abc", 1)).toBe("…");
    expect(oneLine("abc", 2)).toBe("a…");
    expect(oneLine("abc", 3)).toBe("abc");
  });

  it("leaves out the first half of an emoji that the cut would separate from its second half", () => {
    // "ab😀cd" 共 6 个码元；max 为 4 时取前 3 个会切开 😀，所以只取 "ab"。
    expect(oneLine(`ab${EMOJI}cd`, 4)).toBe("ab…");
    // 😀 三连共 6 个码元：取前 3 个会切开第二个，只取第一个。
    expect(oneLine(EMOJI.repeat(3), 4)).toBe(`${EMOJI}…`);
  });

  it("keeps an emoji that fits inside the cut", () => {
    // max 为 5 时取前 4 个码元："ab" 加完整的 😀。
    expect(oneLine(`ab${EMOJI}cd`, 5)).toBe(`ab${EMOJI}…`);
    expect(oneLine(`a ${EMOJI} b c`, 5)).toBe(`a ${EMOJI}…`);
  });

  it("still trims whitespace that follows an emoji inside the cut", () => {
    // 折叠后 "a 😀 b c"（8 个码元）；max 为 6 时取前 5 个："a 😀 "，去掉末尾空白。
    expect(oneLine(`a ${EMOJI} b c`, 6)).toBe(`a ${EMOJI}…`);
  });

  it("never leaves half an emoji behind and never exceeds max, whatever max is", () => {
    // 😀 五连共 10 个码元；max 不到 10 时要截断，到了 10 就原样返回。
    const text = EMOJI.repeat(5);
    for (let max = 1; max <= 12; max += 1) {
      const result = oneLine(text, max);
      expect(LONE.test(result), `max=${max}`).toBe(false);
      expect(result.length, `max=${max}`).toBeLessThanOrEqual(Math.min(max, text.length));
    }
  });
});

describe("idHead", () => {
  it("drops the `xxx_` prefix and takes the first `length` units", () => {
    expect(idHead("conv_abcdef123456", 6)).toBe("abcdef");
    expect(idHead("SES_abcdef123456", 12)).toBe("abcdef123456");
    expect(idHead("0123456789abcdef", 8)).toBe("01234567");
  });

  it("returns the whole id when it is shorter than `length`, and nothing for a length of 0", () => {
    expect(idHead("ses_abcdef", 12)).toBe("abcdef");
    expect(idHead("abc", 0)).toBe("");
  });

  it("leaves out the first half of an emoji that the cut would separate from its second half", () => {
    // 前缀正则只认字母加下划线，😀 开头的标识不去前缀；取前 3 个码元会切开第二个 😀，所以只取第一个。
    expect(idHead(EMOJI.repeat(4), 3)).toBe(EMOJI);
    // 去掉前缀之后是 "😀abc"：只取 1 个码元就只剩半个 😀，所以什么也不取。
    expect(idHead(`conv_${EMOJI}abc`, 1)).toBe("");
  });

  it("keeps an emoji that fits inside the cut", () => {
    expect(idHead(EMOJI.repeat(4), 4)).toBe(EMOJI.repeat(2));
    expect(idHead(`conv_${EMOJI}abc`, 2)).toBe(EMOJI);
  });
});
