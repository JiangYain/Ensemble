import { describe, expect, it } from "vitest";
import { isHighSurrogate, isLowSurrogate, sliceHead, sliceTail } from "./safe-slice";

/** 孤立的代理项：高位后面不是低位，或低位前面不是高位。不带 u 标志，按码元匹配。 */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** 😀 在 UTF-16 里是 D83D DE00 两个码元。 */
const EMOJI = "\u{1F600}";
const HIGH = "\uD83D";
const LOW = "\uDE00";

/** 代理项全部成对的文字，混着普通字符与空格：任何一个孤立的代理项都只可能是截取造成的。 */
const PAIRED = ["a", EMOJI, "bc", EMOJI, EMOJI, "d", "\u{1D4B3}", " ", EMOJI, "e"].join("");

describe("代理项判断", () => {
  it("各自只认自己那一半", () => {
    expect([0xd7ff, 0xd800, 0xdbff, 0xdc00].map((unit) => isHighSurrogate(unit))).toEqual([false, true, true, false]);
    expect([0xdbff, 0xdc00, 0xdfff, 0xe000].map((unit) => isLowSurrogate(unit))).toEqual([false, true, true, false]);
  });

  it("越界的 charCodeAt（NaN）既不是高位也不是低位", () => {
    const outOfRange = "".charCodeAt(0);
    expect(isHighSurrogate(outOfRange)).toBe(false);
    expect(isLowSurrogate(outOfRange)).toBe(false);
  });
});

describe("测试里用来找孤立代理项的正则", () => {
  it("认得孤立的一半，不误伤完整的一对", () => {
    expect(LONE.test(`a${HIGH}`)).toBe(true);
    expect(LONE.test(`${LOW}b`)).toBe(true);
    expect(LONE.test(`${HIGH}x${LOW}`)).toBe(true);
    expect(LONE.test(`${LOW}${HIGH}`)).toBe(true);
    expect(LONE.test(`a${EMOJI}b`)).toBe(false);
    expect(LONE.test(PAIRED)).toBe(false);
  });
});

describe("sliceHead", () => {
  it("没有代理对时与普通截取一样，n 夹在 0 到长度之间", () => {
    expect(sliceHead("abcdef", 3)).toBe("abc");
    expect(sliceHead("abcdef", 0)).toBe("");
    expect(sliceHead("abcdef", -2)).toBe("");
    expect(sliceHead("abcdef", 6)).toBe("abcdef");
    expect(sliceHead("abcdef", 99)).toBe("abcdef");
    expect(sliceHead("", 3)).toBe("");
  });

  it("截点落在一对中间时，连前半个一起让出去", () => {
    const text = `ab${EMOJI}cd`; // a b 高 低 c d
    expect(sliceHead(text, 2)).toBe("ab");
    expect(sliceHead(text, 3)).toBe("ab");
    expect(sliceHead(text, 4)).toBe(`ab${EMOJI}`);
    expect(sliceHead(text, 5)).toBe(`ab${EMOJI}c`);
    expect(sliceHead(`${EMOJI}x`, 1)).toBe("");
    expect(sliceHead(`ab${EMOJI}`, 3)).toBe("ab");
  });

  it("原文里本来就孤立的代理项原样保留：只有这一刀要切开的一对才让出", () => {
    expect(sliceHead(`ab${HIGH}cd`, 3)).toBe(`ab${HIGH}`);
    expect(sliceHead(`ab${LOW}cd`, 3)).toBe(`ab${LOW}`);
    expect(sliceHead(`ab${HIGH}`, 3)).toBe(`ab${HIGH}`);
    expect(sliceHead(`${LOW}${HIGH}`, 1)).toBe(LOW);
  });

  it("代理项全部成对的文字：只在切开一对时比普通截取少一个码元，其余与普通截取一字不差，也不会多出来", () => {
    for (let n = 0; n <= PAIRED.length + 2; n++) {
      const plain = PAIRED.slice(0, n);
      const splitsAPair = plain.length > 0 && plain.length < PAIRED.length && isHighSurrogate(plain.charCodeAt(plain.length - 1));
      const head = sliceHead(PAIRED, n);
      expect(head, `n=${n}`).toBe(splitsAPair ? plain.slice(0, -1) : plain);
      expect(LONE.test(head), `n=${n}`).toBe(false);
      expect(head.length, `n=${n}`).toBeLessThanOrEqual(n);
    }
  });
});

describe("sliceTail", () => {
  it("没有代理对时与普通截取一样，n 夹在 0 到长度之间", () => {
    expect(sliceTail("abcdef", 3)).toBe("def");
    expect(sliceTail("abcdef", 0)).toBe("");
    expect(sliceTail("abcdef", -1)).toBe("");
    expect(sliceTail("abcdef", 6)).toBe("abcdef");
    expect(sliceTail("abcdef", 99)).toBe("abcdef");
    expect(sliceTail("", 3)).toBe("");
  });

  it("起点落在一对中间时，连后半个一起让出去", () => {
    const text = `ab${EMOJI}cd`; // a b 高 低 c d
    expect(sliceTail(text, 2)).toBe("cd");
    expect(sliceTail(text, 3)).toBe("cd");
    expect(sliceTail(text, 4)).toBe(`${EMOJI}cd`);
    expect(sliceTail(text, 5)).toBe(`b${EMOJI}cd`);
    expect(sliceTail(`x${EMOJI}`, 1)).toBe("");
    expect(sliceTail(`${EMOJI}x`, 2)).toBe("x");
  });

  it("原文里本来就孤立的代理项原样保留：只有这一刀要切开的一对才让出", () => {
    expect(sliceTail(`ab${LOW}cd`, 3)).toBe(`${LOW}cd`);
    expect(sliceTail(`ab${HIGH}cd`, 3)).toBe(`${HIGH}cd`);
    expect(sliceTail(`${LOW}ab`, 3)).toBe(`${LOW}ab`);
    expect(sliceTail(`${LOW}${HIGH}`, 1)).toBe(HIGH);
  });

  it("代理项全部成对的文字：只在切开一对时比普通截取少一个码元，其余与普通截取一字不差，也不会多出来", () => {
    for (let n = 0; n <= PAIRED.length + 2; n++) {
      const plain = PAIRED.slice(PAIRED.length - Math.min(n, PAIRED.length));
      const splitsAPair = plain.length > 0 && plain.length < PAIRED.length && isLowSurrogate(plain.charCodeAt(0));
      const tail = sliceTail(PAIRED, n);
      expect(tail, `n=${n}`).toBe(splitsAPair ? plain.slice(1) : plain);
      expect(LONE.test(tail), `n=${n}`).toBe(false);
      expect(tail.length, `n=${n}`).toBeLessThanOrEqual(n);
    }
  });
});
