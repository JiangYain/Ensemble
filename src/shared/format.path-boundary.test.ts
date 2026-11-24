import { describe, expect, it } from "vitest";
import { shortenPath } from "./format";

/**
 * shortenPath 在“名字放不下”“名字加省略号刚好放下”“要在中间省略”之间的分界。设文件名长 N：
 * - max = N - 1、N：名字放不下，只留它结尾的 max - 1 个字符；
 * - max = N + 1：名字加省略号正好占满 max；
 * - max = N + 2：max - 1 比名字还长，名字整个留下（比 max 短一个字符）。以前这一格只剩名字的最后一个字符，那是 slice 的 -1 下标造成的；
 * - max = N + 3 起：走中间省略。头部至少留 3 个字符，所以 N + 3 与 N + 4 的结果比 max 长（既有行为，这里不改，只是如实钉住）。
 * 下面所有期望都是对着源码逐个字符手算的，不依赖旧实现；skills 里 watch.mjs 的副本对同一批输入的对照在 test/watch-script.copies.test.ts。
 */

/** 😀 在 UTF-16 里是 D83D DE00 两个码元。 */
const EMOJI = "\u{1F600}";

describe("shortenPath: around the length of the file name", () => {
  // 19 个码元，文件名 "index.ts" 8 个码元（N = 8）。
  const parser = "src/parser/index.ts";

  it("keeps only the last max - 1 characters of a name that does not fit (max = N - 1 and N)", () => {
    expect(shortenPath(parser, 7)).toBe("…dex.ts");
    expect(shortenPath(parser, 8)).toBe("…ndex.ts");
  });

  it("keeps the whole name once it fits with the ellipsis (max = N + 1 and N + 2)", () => {
    // N + 1：名字加省略号正好 9 个字符。
    expect(shortenPath(parser, 9)).toBe("…index.ts");
    // N + 2：max - 1 = 9 比名字长，整个名字都留下；以前这里是 "…s"。
    expect(shortenPath(parser, 10)).toBe("…index.ts");
  });

  it("elides the middle from max = N + 3, keeping at least three characters of the head", () => {
    // N + 3：room = 11 - 8 - 2 = 1，头部取 3 个字符（下限），结果 13 个字符，比 max 长。
    expect(shortenPath(parser, 11)).toBe("src…/index.ts");
    // N + 4：room = 2，同样取 3 个。N + 5：room = 3，结果恰好 13 个字符。
    expect(shortenPath(parser, 12)).toBe("src…/index.ts");
    expect(shortenPath(parser, 13)).toBe("src…/index.ts");
    // N + 6：room = 4，头部 "src/"。
    expect(shortenPath(parser, 14)).toBe("src/…/index.ts");
  });

  it("returns a path that already fits untouched", () => {
    expect(shortenPath(parser, 19)).toBe(parser);
    expect(shortenPath(parser, 40)).toBe(parser);
  });

  it("behaves the same for a shorter name (N = 4)", () => {
    // 15 个码元，文件名 "a.ts"。
    const path = "dir/subdir/a.ts";
    expect(shortenPath(path, 3)).toBe("…ts");
    expect(shortenPath(path, 4)).toBe("….ts");
    expect(shortenPath(path, 5)).toBe("…a.ts");
    // N + 2：以前是 "…s"。
    expect(shortenPath(path, 6)).toBe("…a.ts");
    expect(shortenPath(path, 7)).toBe("dir…/a.ts");
    expect(shortenPath(path, 10)).toBe("dir/…/a.ts");
  });

  it("finds the file name after a backslash as well", () => {
    // 24 个码元，文件名 "file.txt"（N = 8）。
    const path = "C:\\work\\project\\file.txt";
    expect(shortenPath(path, 10)).toBe("…file.txt");
    expect(shortenPath(path, 11)).toBe("C:\\…\\file.txt");
  });
});

describe("shortenPath: the same boundaries when the name starts with an emoji", () => {
  // 😀 占两个码元：文件名 "😀ab.ts" 共 7 个码元（N = 7），路径共 11 个码元。
  const path = `dir/${EMOJI}ab.ts`;

  it("leaves out one more unit when max - 1 would cut the emoji in half (max = N)", () => {
    // 留 6 个码元会从低位代理开始，让出后只剩 "ab.ts"。
    expect(shortenPath(path, 7)).toBe("…ab.ts");
  });

  it("keeps the emoji with the rest of the name (max = N + 1 and N + 2)", () => {
    expect(shortenPath(path, 8)).toBe(`…${EMOJI}ab.ts`);
    expect(shortenPath(path, 9)).toBe(`…${EMOJI}ab.ts`);
  });

  it("elides the middle from max = N + 3", () => {
    expect(shortenPath(path, 10)).toBe(`dir…/${EMOJI}ab.ts`);
  });
});

describe("shortenPath: what holds at every width", () => {
  it("keeps the whole file name once max is at least N + 1, and is exactly max long from N + 5 on", () => {
    const path = "src/parser/index.ts";
    for (let max = 9; max <= 18; max += 1) {
      const result = shortenPath(path, max);
      expect(result.endsWith("index.ts"), `max=${max}`).toBe(true);
      if (max >= 13) expect(result, `max=${max}`).toHaveLength(max);
    }
  });
});
