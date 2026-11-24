import { describe, expect, it } from "vitest";
import { addKnown, shownDelta } from "./diffstat";

describe("shownDelta：只画真实知道、且说明了问题的行数", () => {
  it("两侧都有数：都画", () => {
    expect(shownDelta({ addedLines: 12, removedLines: 3 })).toEqual({ added: 12, removed: 3 });
  });

  it("上报了 0 的一侧不画（“−0”只是噪音）", () => {
    expect(shownDelta({ addedLines: 12, removedLines: 0 })).toEqual({ added: 12, removed: undefined });
    expect(shownDelta({ addedLines: 0, removedLines: 41 })).toEqual({ added: undefined, removed: 41 });
  });

  it("没上报（undefined）的一侧不画，也不当成 0", () => {
    expect(shownDelta({ addedLines: 64 })).toEqual({ added: 64, removed: undefined });
    expect(shownDelta({ removedLines: 7 })).toEqual({ added: undefined, removed: 7 });
  });

  it("两侧都没有可画的数字：返回 undefined，调用方不必渲染容器", () => {
    expect(shownDelta({})).toBeUndefined();
    expect(shownDelta({ addedLines: 0, removedLines: 0 })).toBeUndefined();
    expect(shownDelta({ addedLines: 0 })).toBeUndefined();
  });

  it("不是有限的正数一律不画", () => {
    expect(shownDelta({ addedLines: Number.NaN, removedLines: -1 })).toBeUndefined();
    expect(shownDelta({ addedLines: Number.POSITIVE_INFINITY })).toBeUndefined();
  });
});

describe("addKnown：累加可能没上报的行数", () => {
  it("两个都没上报仍是未知，不会变成 0", () => {
    expect(addKnown(undefined, undefined)).toBeUndefined();
  });

  it("只有一个上报了就以它为准；都上报了才相加；真实的 0 保持 0", () => {
    expect(addKnown(undefined, 5)).toBe(5);
    expect(addKnown(4, undefined)).toBe(4);
    expect(addKnown(4, 5)).toBe(9);
    expect(addKnown(0, undefined)).toBe(0);
    expect(addKnown(0, 0)).toBe(0);
  });
});
