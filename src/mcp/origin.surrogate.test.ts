import { describe, expect, it } from "vitest";
import { describeClues, detectOrigin } from "./origin";

const base = { env: {}, bridgeId: "b1" };

/** 😀 在 UTF-16 里是 D83D DE00 两个码元。 */
const EMOJI = "\u{1F600}";
/** 孤立的高位或低位代理项（页面与排查日志里会变成乱码字符）。 */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** 客户端自己报的名字与版本是任意字符串：detectOrigin 把它们截到 80 / 200 / 100 个码元，截点落在 😀 中间时少留一个码元。 */
describe("detectOrigin: truncated client labels never end in half an emoji", () => {
  it("cuts the label of an unknown client at 80 units without splitting an emoji", () => {
    // 未识别的客户端：hostLabel 取它自己的名字。😀 占下标 79、80：取前 80 个码元会切开它，所以只留 79 个 n。
    const name = `${"n".repeat(79)}${EMOJI}tail`;
    const { origin } = detectOrigin({ ...base, clientInfo: { name } });
    expect(origin.hostLabel).toBe("n".repeat(79));
    expect(LONE.test(origin.hostLabel)).toBe(false);
    // clientInfo.name 的上限是 200 个码元，这个名字只有 85 个，原样保留。
    expect(origin.clientInfo?.name).toBe(name);
  });

  it("keeps an emoji that fits inside the 80 units of the label", () => {
    // 😀 占下标 78、79：前 80 个码元正好包住整个 emoji。
    const { origin } = detectOrigin({ ...base, clientInfo: { name: `${"n".repeat(78)}${EMOJI}tail` } });
    expect(origin.hostLabel).toBe(`${"n".repeat(78)}${EMOJI}`);
  });

  it("cuts clientInfo.name at 200 units without splitting an emoji", () => {
    // 😀 占下标 199、200。hostLabel 先在 80 处截断，不涉及 emoji。
    const { origin } = detectOrigin({ ...base, clientInfo: { name: `${"m".repeat(199)}${EMOJI}tail` } });
    expect(origin.clientInfo?.name).toBe("m".repeat(199));
    expect(origin.hostLabel).toBe("m".repeat(80));
    // 😀 占下标 198、199：前 200 个码元正好包住整个 emoji。
    const fits = detectOrigin({ ...base, clientInfo: { name: `${"m".repeat(198)}${EMOJI}tail` } }).origin;
    expect(fits.clientInfo?.name).toBe(`${"m".repeat(198)}${EMOJI}`);
  });

  it("cuts clientInfo.version at 100 units without splitting an emoji", () => {
    // 😀 占下标 99、100。
    const { origin } = detectOrigin({ ...base, clientInfo: { name: "codex-mcp-client", version: `${"v".repeat(99)}${EMOJI}tail` } });
    expect(origin.clientInfo?.version).toBe("v".repeat(99));
    // 😀 占下标 98、99：前 100 个码元正好包住整个 emoji。
    const fits = detectOrigin({ ...base, clientInfo: { name: "codex-mcp-client", version: `${"v".repeat(98)}${EMOJI}tail` } }).origin;
    expect(fits.clientInfo?.version).toBe(`${"v".repeat(98)}${EMOJI}`);
  });

  it("leaves names and versions that are short enough untouched", () => {
    const { origin } = detectOrigin({ ...base, clientInfo: { name: "my-fancy-client", version: "1.2.3" } });
    expect(origin).toMatchObject({ hostLabel: "my-fancy-client", clientInfo: { name: "my-fancy-client", version: "1.2.3" } });
  });
});

/** 排查日志里的 _meta 字符串超过 120 个码元就截到 117 个再加省略号。 */
describe("describeClues: long strings in the redacted _meta never end in half an emoji", () => {
  const noteOf = (note: string): unknown => (describeClues({ env: {}, meta: { note } }).meta as { note: unknown }).note;

  it("leaves out the first half of an emoji that the 117-unit cut would separate from its second half", () => {
    // 共 122 个码元；😀 占下标 116、117：取前 117 个会切开它，所以只留 116 个 x，再加省略号。
    expect(noteOf(`${"x".repeat(116)}${EMOJI}tail`)).toBe(`${"x".repeat(116)}…`);
  });

  it("keeps an emoji that fits inside the 117 units", () => {
    // 共 121 个码元；😀 占下标 115、116：前 117 个码元正好包住整个 emoji。
    expect(noteOf(`${"x".repeat(115)}${EMOJI}tail`)).toBe(`${"x".repeat(115)}${EMOJI}…`);
  });

  it("cuts plain text at 117 units and keeps text of up to 120 units whole", () => {
    expect(noteOf("z".repeat(130))).toBe(`${"z".repeat(117)}…`);
    expect(noteOf("y".repeat(120))).toBe("y".repeat(120));
  });
});
