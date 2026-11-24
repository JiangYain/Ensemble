import { describe, expect, it } from "vitest";
import {
  basename,
  clipByWidth,
  deriveTitle,
  errorMessage,
  formatCount,
  formatDuration,
  formatUsd,
  makePreview,
  shortenPath,
  tail,
  versionLabel,
} from "./format";
import { newId, shortId, ulid } from "./ids";

describe("format helpers", () => {
  it("prefixes plain version numbers with v and leaves self-describing ones alone", () => {
    expect(versionLabel("0.130.0")).toBe("v0.130.0");
    expect(versionLabel("SDK 1.3.1")).toBe("SDK 1.3.1");
  });

  it("clips by display width and treats CJK as double width", () => {
    expect(clipByWidth("hello world", 20)).toBe("hello world");
    expect(clipByWidth("重构解析器模块并补充单元测试覆盖", 12)).toBe("重构解析器…");
    expect(clipByWidth("a".repeat(30), 10)).toBe(`${"a".repeat(9)}…`);
  });

  it("keeps head and tail in previews and states how much was omitted", () => {
    const text = `${"a".repeat(500)}${"z".repeat(500)}`;
    const preview = makePreview(text, 100);
    expect(preview.truncated).toBe(true);
    expect(preview.chars).toBe(1000);
    expect(preview.text.startsWith("a")).toBe(true);
    expect(preview.text.endsWith("z")).toBe(true);
    expect(preview.text).toContain("900 chars omitted");
    expect(makePreview("short", 100)).toMatchObject({ truncated: false, text: "short" });
  });

  it("serializes objects safely, including circular references", () => {
    const a: Record<string, unknown> = { n: 1 };
    a["self"] = a;
    const preview = makePreview(a, 1000);
    expect(preview.format).toBe("json");
    expect(preview.text).toContain("[Circular]");
  });

  it("formats durations, counts and cost", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(185_000)).toBe("3m 05s");
    expect(formatDuration(3_725_000)).toBe("1h 02m");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1234)).toBe("1.2k");
    expect(formatCount(25_400)).toBe("25k");
    expect(formatCount(2_500_000)).toBe("2.5M");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(0.456)).toBe("$0.46");
  });

  it("shortens paths in the middle but always keeps the file name", () => {
    const path = "C:\\Users\\alice\\Desktop\\Ensemble\\src\\server\\executors\\pi-adapter.ts";
    const short = shortenPath(path, 40);
    expect(short.length).toBeLessThanOrEqual(41);
    expect(short.endsWith("pi-adapter.ts")).toBe(true);
    expect(basename("/a/b/c.txt")).toBe("c.txt");
    expect(basename("C:\\a\\b\\")).toBe("b");
  });

  it("derives a readable title from a task", () => {
    expect(deriveTitle("## 重构解析器\n\n把 parser 拆成 tokenizer 与 AST 两层")).toBe("重构解析器");
    expect(deriveTitle("- Fix the flaky login test. Then update docs.")).toBe("Fix the flaky login test.");
    expect(deriveTitle("   \n  ")).toBe("Untitled task");
  });

  it("keeps the tail of long text", () => {
    expect(tail("abcdefghij", 5)).toBe("…ghij");
    expect(tail("abc", 5)).toBe("abc");
  });

  it("turns anything that was thrown into readable text without ever throwing or returning a non-string", () => {
    expect(errorMessage(new TypeError("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage({ code: 7 })).toBe('{"code":7}');
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(null)).toBe("null");
    // JSON.stringify answers undefined (not a string) for these.
    expect(errorMessage(undefined)).toBe("undefined");
    expect(errorMessage(() => 1)).toContain("=>");
    // JSON.stringify throws for these.
    expect(errorMessage(10n)).toBe("10");
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(errorMessage(circular)).toBe("[object Object]");
  });
});

describe("ids", () => {
  it("generates unique, lexicographically sortable ids even within the same millisecond", () => {
    const now = Date.now();
    const ids = Array.from({ length: 200 }, () => ulid(now));
    expect(new Set(ids).size).toBe(200);
    expect([...ids].sort()).toEqual(ids);
  });

  it("prefixes ids and shortens them for display", () => {
    const id = newId("ses");
    expect(id.startsWith("ses_")).toBe(true);
    expect(shortId(id)).toHaveLength(6);
    expect(id.endsWith(shortId(id))).toBe(true);
  });
});
