import { describe, expect, it } from "vitest";
import { isSecretEntry } from "./codex-questions";

/**
 * “这一条原始条目标着机密吗”：codex-questions.ts 用它判断整个请求，codex-side-channel.ts 的 `describeUnrelayed` 数机密条目时也用它。
 * 两处共用这一个谓词，所以口径只在这里钉一次：严格的 `isSecret === true`，别的一概不算。
 * 整个请求怎么处理（整个不转交、固定的诊断）见 codex-questions.secret.test.ts，诊断怎么写见 codex-side-channel.test.ts。
 */

describe("isSecretEntry", () => {
  it("is true for an entry whose isSecret is exactly true, whatever else it carries", () => {
    expect(isSecretEntry({ isSecret: true })).toBe(true);
    expect(isSecretEntry({ id: "token", header: "Token", question: "Paste your API token", isOther: true, isSecret: true, options: null })).toBe(true);
    // 缺 id、缺问题正文的条目照样算：转交读不出它，不等于它不是机密。
    expect(isSecretEntry({ question: "No id", isSecret: true })).toBe(true);
    expect(isSecretEntry({ id: "k", isSecret: true })).toBe(true);
  });

  it.each([
    ["false", false],
    ["undefined", undefined],
    ['the string "true"', "true"],
    ["the number 1", 1],
    ["null", null],
    ["an array", [true]],
    ["an object", { value: true }],
  ] as Array<[string, unknown]>)("is false when isSecret is %s: the flag must be exactly true", (_what, flag) => {
    expect(isSecretEntry({ id: "k", question: "Which package should I update?", isSecret: flag })).toBe(false);
  });

  it("is false when the entry does not carry the flag at all", () => {
    expect(isSecretEntry({})).toBe(false);
    expect(isSecretEntry({ id: "k", question: "Which package should I update?" })).toBe(false);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "isSecret"],
    ["a number", 1],
    ["the boolean true", true],
    ["an array", [{ isSecret: true }]],
  ] as Array<[string, unknown]>)("is false for something that is not an entry object: %s", (_what, raw) => {
    expect(isSecretEntry(raw)).toBe(false);
  });
});
