import { describe, expect, it } from "vitest";
import { summary } from "../lib/archive.fixtures";
import { structureKey } from "./Overview";

/**
 * 画布只在“结构键”变了时才重新排布：键里要有布局与连线依赖的字段，进度与活动文字不必有。
 * 汇聚的会话（跟随多个上级）的连线与所在的列由所有上级决定，所以键里要带完整的上级集合；
 * 单上级与没有上级的会话，键必须与加入汇聚之前一字不差（不白白多一次重排，也不让已经存下来的比较失效）。
 */

describe("画布的结构键", () => {
  it("单上级、没有上级的会话：键就是原来的五项，不多带任何东西", () => {
    const child = summary("child", { parentSessionId: "root" });
    const root = summary("root");

    expect(structureKey([root, child])).toBe(
      JSON.stringify([
        [root.id, root.origin, root.parentSessionId, root.createdAt, root.phase],
        [child.id, child.origin, "root", child.createdAt, child.phase],
      ]),
    );
  });

  it("汇聚的会话：键里带完整的上级集合（有序）", () => {
    const join = summary("join", { parentSessionId: "a", parentSessionIds: ["a", "b"] });

    expect(structureKey([join])).toBe(JSON.stringify([[join.id, join.origin, "a", join.createdAt, join.phase, ["a", "b"]]]));
  });

  it("只有非主上级变了（a、b → a、c），键也变：连线要跟着重画", () => {
    const before = summary("join", { parentSessionId: "a", parentSessionIds: ["a", "b"] });
    const after = summary("join", { parentSessionId: "a", parentSessionIds: ["a", "c"] });

    expect(structureKey([after])).not.toBe(structureKey([before]));
  });

  it("上级的先后变了，键也变：画在谁下面由第一个画着的上级决定", () => {
    const before = summary("join", { parentSessionId: "a", parentSessionIds: ["a", "b"] });
    const after = summary("join", { parentSessionId: "b", parentSessionIds: ["b", "a"] });

    expect(structureKey([after])).not.toBe(structureKey([before]));
  });

  it("单上级变成汇聚（事后又加了一个上级）：键变", () => {
    const single = summary("join", { parentSessionId: "a" });
    const joined = summary("join", { parentSessionId: "a", parentSessionIds: ["a", "b"] });

    expect(structureKey([joined])).not.toBe(structureKey([single]));
  });

  it("只有一个 id 的集合当作单上级：键与没有这个字段时一样（服务端不会这样写，读的一方也不被它带偏）", () => {
    const plain = summary("join", { parentSessionId: "a" });
    const odd = summary("join", { parentSessionId: "a", parentSessionIds: ["a"] });

    expect(structureKey([odd])).toBe(structureKey([plain]));
  });

  it("进度与活动的变化不改变键（汇聚与否都一样）", () => {
    const join = summary("join", { parentSessionId: "a", parentSessionIds: ["a", "b"], seq: 5 });
    const later = { ...join, seq: 99, updatedAt: "2030-01-01T00:00:00.000Z", lastAssistantPreview: "reading a file" };

    expect(structureKey([later])).toBe(structureKey([join]));
  });
});
