import { describe, expect, it } from "vitest";
import { toTurnErrorInfo } from "./codex-items";

/** 孤立的高位或低位代理项（时间线与 MCP 输出里会变成乱码字符）。 */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** 😀 在 UTF-16 里是 D83D DE00 两个码元。 */
const EMOJI = "\u{1F600}";

/** 错误详情最多留 2000 个码元（codex-items.ts 的 `sliceHead(detail, 2_000)`）：截点落在 emoji 中间时少留一个，不留半个。 */
describe("toTurnErrorInfo: the detail is cut at 2000 code units without splitting an emoji", () => {
  const withDetail = (additionalDetails: string) => ({ message: "Request failed", additionalDetails });

  it("leaves out the first half of an emoji that the cut would separate from its second half", () => {
    // 下标 1999 是 😀 的高位代理，下标 2000 是低位：切在 2000 会把它们拆开，所以只留前面的 1999 个 x。
    const info = toTurnErrorInfo(withDetail(`${"x".repeat(1_999)}${EMOJI}tail`));
    expect(info.detail).toBe("x".repeat(1_999));
    expect(info.detail).toHaveLength(1_999);
    expect(LONE.test(info.detail ?? "")).toBe(false);
  });

  it("keeps an emoji that fits exactly inside the 2000 units", () => {
    // 😀 占下标 1998、1999，切在 2000 正好落在它后面：整个 emoji 保留，长度 2000。
    const info = toTurnErrorInfo(withDetail(`${"x".repeat(1_998)}${EMOJI}tail`));
    expect(info.detail).toBe(`${"x".repeat(1_998)}${EMOJI}`);
    expect(info.detail).toHaveLength(2_000);
    expect(LONE.test(info.detail ?? "")).toBe(false);
  });

  it("does not touch a detail that is already within the limit, emoji at the very end included", () => {
    const text = `${"x".repeat(1_998)}${EMOJI}`;
    expect(text).toHaveLength(2_000);
    expect(toTurnErrorInfo(withDetail(text)).detail).toBe(text);
    expect(toTurnErrorInfo(withDetail(`short ${EMOJI}`)).detail).toBe(`short ${EMOJI}`);
  });

  it("cuts plain text at exactly 2000 units, as before", () => {
    expect(toTurnErrorInfo(withDetail("y".repeat(2_500))).detail).toBe("y".repeat(2_000));
  });
});
