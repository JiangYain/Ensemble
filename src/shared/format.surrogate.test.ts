import { describe, expect, it } from "vitest";
import { clip, makePreview, shortenPath, tail } from "./format";

/** 孤立的代理项：高位后面不是低位，或低位前面不是高位。不带 u 标志，按码元匹配。 */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** 😀 在 UTF-16 里是 D83D DE00 两个码元。 */
const EMOJI = "\u{1F600}";

/** 代理项全部成对、带一个空格（让 trimEnd / trimStart 有机会起作用）的混合文字，长 16 个码元。 */
const MIXED = ["a", EMOJI, "bc", EMOJI, EMOJI, "d", "\u{1D4B3}", " ", EMOJI, "e"].join("");

describe("clip", () => {
  it("没有 emoji 时与以前一字不差", () => {
    expect(clip("hello world", 5)).toBe("hell…");
    expect(clip("hello", 5)).toBe("hello");
    expect(clip("hello world", 1)).toBe("…");
  });

  it("截点落在 emoji 中间时少留一个码元，不留孤立的代理项", () => {
    expect(clip(`ab${EMOJI}cd`, 4)).toBe("ab…");
    expect(clip(`ab${EMOJI}cd`, 5)).toBe(`ab${EMOJI}…`);
    expect(clip(`ab${EMOJI}cd`, 6)).toBe(`ab${EMOJI}cd`);
    expect(clip(`${EMOJI}${EMOJI}${EMOJI}`, 4)).toBe(`${EMOJI}…`);
    expect(clip(`${EMOJI}${EMOJI}`, 2)).toBe("…");
  });

  it("让出半个字符之后，照旧去掉末尾的空白", () => {
    // 码元：a b 空格 高 低 c d；截成前 4 个会以高位代理结尾，让出后剩 "ab "，trimEnd 去掉空格。
    expect(clip(`ab ${EMOJI}cd`, 5)).toBe("ab…");
  });

  it("原文里本来就孤立的代理项原样保留", () => {
    expect(clip("ab\uD83Dcd", 4)).toBe("ab\uD83D…");
  });

  it("混合文字在每一个 max 下都没有孤立的代理项，且总长不超过 max", () => {
    for (let max = 1; max <= MIXED.length + 1; max++) {
      const result = clip(MIXED, max);
      expect(LONE.test(result), `max=${max}`).toBe(false);
      expect(result.length, `max=${max}`).toBeLessThanOrEqual(max);
      if (max >= MIXED.length) expect(result, `max=${max}`).toBe(MIXED);
    }
  });
});

describe("tail", () => {
  it("没有 emoji 时与以前一字不差", () => {
    expect(tail("abcdefghij", 5)).toBe("…ghij");
    expect(tail("abcde", 5)).toBe("abcde");
    expect(tail("abcdefghij", 1)).toBe("…");
  });

  it("起点落在 emoji 中间时少留一个码元，不留孤立的代理项", () => {
    expect(tail(`ab${EMOJI}cd`, 4)).toBe("…cd");
    expect(tail(`ab${EMOJI}cd`, 5)).toBe(`…${EMOJI}cd`);
    expect(tail(`ab${EMOJI}cd`, 6)).toBe(`ab${EMOJI}cd`);
    expect(tail(`${EMOJI}${EMOJI}`, 2)).toBe("…");
  });

  it("让出半个字符之后，照旧去掉开头的空白", () => {
    // 码元：a b 高 低 空格 c d；留 4 个会从低位代理开始，让出后剩 " cd"，trimStart 去掉空格。
    expect(tail(`ab${EMOJI} cd`, 5)).toBe("…cd");
  });

  it("原文里本来就孤立的代理项原样保留", () => {
    expect(tail("ab\uDE00cd", 4)).toBe("…\uDE00cd");
  });

  it("混合文字在每一个 max 下都没有孤立的代理项，且总长不超过 max", () => {
    for (let max = 1; max <= MIXED.length + 1; max++) {
      const result = tail(MIXED, max);
      expect(LONE.test(result), `max=${max}`).toBe(false);
      expect(result.length, `max=${max}`).toBeLessThanOrEqual(max);
      if (max >= MIXED.length) expect(result, `max=${max}`).toBe(MIXED);
    }
  });
});

describe("makePreview", () => {
  const limit = 100;
  // 与实现里的切分是同一个算式：头部取 60%，其余给尾部。下面按它们造文字，不依赖浮点乘法恰好得多少。
  const head = Math.floor(limit * 0.6);
  const rest = limit - head;

  it("没有 emoji 时与以前一字不差：省略的字数就是总长减去 limit", () => {
    const preview = makePreview("a".repeat(500) + "z".repeat(500), limit);
    expect(preview.text).toBe(`${"a".repeat(head)}\n… 900 chars omitted …\n${"z".repeat(rest)}`);
    expect(preview.truncated).toBe(true);
    expect(preview.chars).toBe(1000);
  });

  it("头与尾的截点都落在 emoji 中间时各让出半个字符，省略的字数按实际算", () => {
    // 第一个 emoji 占下标 head-1 与 head（头部取 head 个码元会切开它）；
    // 第二个 emoji 的低位代理正好是尾部的第一个码元（尾部取 rest 个码元会切开它）。
    const text = `${"a".repeat(head - 1)}${EMOJI}${"m".repeat(200)}${EMOJI}${"z".repeat(rest - 1)}`;
    const kept = (head - 1) + (rest - 1);
    const preview = makePreview(text, limit);
    expect(preview.text).toBe(`${"a".repeat(head - 1)}\n… ${text.length - kept} chars omitted …\n${"z".repeat(rest - 1)}`);
    expect(LONE.test(preview.text)).toBe(false);
    expect(preview.chars).toBe(text.length);
    expect(preview.truncated).toBe(true);
  });

  it("头尾落在任何位置，都没有孤立的代理项，且省略的字数等于原文里没出现在预览中的码元数", () => {
    for (let lead = 0; lead < 4; lead++) {
      for (let pairs = 60; pairs < 70; pairs++) {
        const text = "b".repeat(lead) + EMOJI.repeat(pairs);
        const preview = makePreview(text, limit);
        const match = /^([\s\S]*)\n… (\d+) chars omitted …\n([\s\S]*)$/.exec(preview.text);
        if (!match) throw new Error(`no omission marker in the preview of lead=${lead} pairs=${pairs}`);
        const headText = match[1] ?? "";
        const tailText = match[3] ?? "";
        const label = `lead=${lead} pairs=${pairs}`;
        expect(preview.truncated, label).toBe(true);
        expect(preview.chars, label).toBe(text.length);
        expect(LONE.test(preview.text), label).toBe(false);
        expect(Number(match[2]), label).toBe(text.length - headText.length - tailText.length);
        expect(text.startsWith(headText), label).toBe(true);
        expect(text.endsWith(tailText), label).toBe(true);
        expect(headText.length, label).toBeGreaterThanOrEqual(head - 1);
        expect(headText.length, label).toBeLessThanOrEqual(head);
        expect(tailText.length, label).toBeGreaterThanOrEqual(rest - 1);
        expect(tailText.length, label).toBeLessThanOrEqual(rest);
      }
    }
  });
});

describe("shortenPath", () => {
  it("名字本身放得下时，中间省略、保留名字", () => {
    expect(shortenPath("src/parser/index.ts", 40)).toBe("src/parser/index.ts");
    // 名字 "file.ts" 7 个码元，room = 16 - 7 - 2 = 7：头部取 "abcdefg"，尾部取 "/file.ts"。
    expect(shortenPath("abcdefghij/klmnopqrst/file.ts", 16)).toBe("abcdefg…/file.ts");
  });

  it("名字放不下时只留名字的结尾；名字加上省略号刚好放得下时整个名字都留下（边界的逐条用例在 format.path-boundary.test.ts）", () => {
    // 名字 "index.ts" 8 个码元：max 为 7 时留 6 个，max 为 10 时 max - 1 = 9 比名字还长，名字整个留下。
    expect(shortenPath("src/parser/index.ts", 7)).toBe("…dex.ts");
    expect(shortenPath("src/parser/index.ts", 10)).toBe("…index.ts");
  });

  it("名字放不下、起点落在名字里的 emoji 中间时少留一个码元", () => {
    // 名字 "😀abc.ts" 共 8 个码元；max 为 8 时留 7 个码元，从低位代理开始，让出后剩 "abc.ts"。
    expect(shortenPath(`dir/${EMOJI}abc.ts`, 8)).toBe("…abc.ts");
  });

  it("中间省略时，头部的截点落在 emoji 中间也少留一个码元", () => {
    // 路径 "abcde" + 😀 + "bbbbbb" + "/f.ts" 共 18 个码元；max 为 12 时头部取 6 个码元，会切开 😀。
    expect(shortenPath(`abcde${EMOJI}bbbbbb/f.ts`, 12)).toBe("abcde…/f.ts");
  });

  it("中间省略时，尾部的起点落在 emoji 中间也少留一个码元", () => {
    // 路径末尾有多余的斜杠时，“名字加一个字符”的起点会落进名字内部：这里正好落在 😀 的低位代理上。
    const path = `${"x".repeat(12)}/${EMOJI}ab//`;
    expect(shortenPath(path, 14)).toBe("xxxxxxxx…ab//");
  });

  it("全是 emoji 的路径在每一个 max 下都没有孤立的代理项", () => {
    const path = `项目/${EMOJI.repeat(3)}/${EMOJI.repeat(4)}/文件${EMOJI}.ts`;
    for (let max = 4; max <= path.length; max++) {
      expect(LONE.test(shortenPath(path, max)), `max=${max}`).toBe(false);
    }
  });
});
