import { describe, expect, it } from "vitest";
import { at, fill, gridOf, HUGE, SIZE, slot, TALL_NARROW, WIDE_SHORT } from "./arrival-grow.fixtures";

/**
 * 根会话到达规则（arrival-grow.ts，LAYOUT6 / LAYOUT8）的纯几何：先填空格，没有空格再向“让整体看得最全”的方向长一行或一列，持平时看形状。
 * 这里只有矩形与取景区域，不认识会话、来源或引擎；每一条都从规则的文字推出，数字写在用例里能一眼验算。
 * 夹具（一格 248 × 112，步长 280 × 136，`slot`、`gridOf`、`at`）在 arrival-grow.fixtures.ts；持平时按形状的专门用例在 arrival-grow.shape.test.ts。
 */

describe("(a) 先填空格：外框里放得下的第一个，按阅读顺序（先上后下、每行从左到右）", () => {
  it("第 1 列 3 张、第 2 列 2 张、第 3 列 1 张：三个空格依次填 (560,136)、(280,272)、(560,272)，第 4 个才离开外框", () => {
    const roots = gridOf([3, 2, 1]);
    const picked = fill(roots, 4);
    expect(picked.slice(0, 3)).toEqual([{ x: 560, y: 136 }, { x: 280, y: 272 }, { x: 560, y: 272 }]);
    expect(picked[3], "没有空格了：新的一行从最左一格起（没有取景区域）").toEqual({ x: 0, y: 408 });
  });

  it("阅读顺序是先行后列：(0,272) 在 (280,136) 之后（按列从上到下会先取 (0,272)）", () => {
    // 第 1 列 2 张、第 2 列 1 张、第 3 列 3 张：空格是 (0,272)、(280,136)、(280,272)，第 2 行的 (280,136) 排在第 3 行的 (0,272) 之前。
    expect(slot({ roots: gridOf([2, 1, 3]) })).toEqual({ x: 280, y: 136 });
  });

  it("有空格就不看比例：另起一列明明更全（取景区域很宽很矮），也先填外框里的空格", () => {
    // 外框 808 × 384：长一行（高 520）只有 0.192；另起一列（宽 1088）0.26——另起一列严格更高，但外框里还有空格。
    expect(slot({ roots: gridOf([3, 2, 1]), area: { w: 5000, h: 100 } })).toEqual({ x: 560, y: 136 });
  });

  it("别的来源块里的空格不算：只数这个块自己的范围", () => {
    // 这个块 2 × 2 排满；别的来源块的两张卡在 (0,300)、(560,300)，它们之间的 (280,300) 是空的，但那是别人的地方。
    const others = [{ x: 0, y: 300, ...SIZE }, { x: 560, y: 300, ...SIZE }];
    // 新的一行从最左放得下的一格起：(0,272) 被 (0,300) 挤着，往右一格 (280,272) 放得下。
    expect(slot({ roots: gridOf([2, 2]), others })).toEqual({ x: 280, y: 272 });
  });

  it("来源块里子会话占着的列也算：它们没被占的格子是空格", () => {
    // 根会话只有第 1 列的 2 张，子会话在 (280,0)、(560,0)：块的范围伸到第 3 列，(280,136) 是第一个空格。
    expect(slot({ roots: gridOf([2]), kids: [at(1, 0), at(2, 0)] })).toEqual({ x: 280, y: 136 });
  });

  it("待用格（别的家族的下一格）不是空格：跳过它去下一个", () => {
    expect(slot({ roots: gridOf([2]), kids: [at(1, 0), at(2, 0)], reserved: [at(1, 1)] })).toEqual({ x: 560, y: 136 });
  });

  it("来源块的第一排之上不进：来源卡在 (0,-136)，第 2 列同一行的 (280,-136) 在外框里也是空的，仍不落进去", () => {
    // 2 × 2 排满，上面只有来源卡压着第 1 列；没有 `floor` 的话阅读顺序里第一个空格是 (280,-136)。
    const origin = { x: 0, y: -136, ...SIZE };
    const got = slot({ roots: gridOf([2, 2]), others: [origin], area: HUGE });
    expect(got, "取景区域放得下两种长法，方形的区域里长一行的形状更像它：长一行").toEqual({ x: 0, y: 272 });
    expect(got!.y).toBeGreaterThanOrEqual(0);
  });

  it("经典的树里奇数行错开 24：块的右缘比一列宽出 24，也不会多算出一列“空格”（第 4 个根不落到 (280, 0)）", () => {
    // 与 ceil 相比：(272 - 0 - 248) / 280 = 0.086，向上取整会多出 (280,0) 这一列；整张卡放得下才算，只有一列。
    const staggered = [at(0, 0), { ...at(0, 1), x: 24 }, at(0, 2)];
    expect(slot({ roots: staggered })).toEqual({ x: 0, y: 408 });
  });
});

describe("(b) 没有空格：长一行还是另起一列，哪一个让整体在取景区域里看得更全就取哪一个", () => {
  // 2 × 2 排满：外框 528 × 248。新的一行 (0,272) → 528 × 384；新的一列 (560,0) → 808 × 248。
  const roots = gridOf([2, 2]);

  it("取景区域又宽又矮 (1000 × 300)：长一行只有 0.781（300 / 384），另起一列 100%——另起一列", () => {
    expect(slot({ roots, area: WIDE_SHORT })).toEqual({ x: 560, y: 0 });
  });

  it("取景区域又窄又高 (560 × 1000)：长一行 100%，另起一列只有 0.693（560 / 808）——长一行，新的一行从最左一格起", () => {
    expect(slot({ roots, area: TALL_NARROW })).toEqual({ x: 0, y: 272 });
  });

  it("新的一行从最左放得下的一格起：最左一格被别的来源块挤着，就从它右边起", () => {
    expect(slot({ roots, others: [{ x: 0, y: 300, ...SIZE }], area: TALL_NARROW })).toEqual({ x: 280, y: 272 });
  });

  it("新的一列紧挨最右一列、隔一个步长，顶与第一排对齐（不是与外框顶对齐）", () => {
    const shifted = gridOf([2, 2]).map((rect) => ({ ...rect, y: rect.y + 50 }));
    expect(slot({ roots: shifted, area: WIDE_SHORT })).toEqual({ x: 560, y: 50 });
  });
});

describe("(c) 持平：看得全的比例差不到 0.05 个百分点算持平，持平时才看形状，形状一样像就长一行", () => {
  const roots = gridOf([2, 2]);

  it("两种长法都是 100%，取景区域是方的：长出来的块 528 × 384（1.375）比 808 × 248（3.26）更像它——长一行", () => {
    expect(slot({ roots, area: HUGE })).toEqual({ x: 0, y: 272 });
  });

  it("长一行差 0.04 个百分点（0.9996 对 100%）仍算持平：两个块对 810 × 383.85（2.11）一样像（对数比 −0.43 与 +0.43，差不到 5%），长一行", () => {
    // 另起一列：808 × 248，宽 810、高 383.8464 放得下 → 100%；长一行：528 × 384 → 383.8464 / 384 = 0.9996。
    expect(slot({ roots, area: { w: 810, h: 383.8464 } })).toEqual({ x: 0, y: 272 });
  });

  it("长一行差 0.06 个百分点（0.9994 对 100%）就不算持平：另起一列（比例严格更高，不再看形状）", () => {
    expect(slot({ roots, area: { w: 810, h: 383.7696 } })).toEqual({ x: 560, y: 0 });
  });
});

describe("(d) 一边放不下就长另一边", () => {
  const roots = gridOf([2, 2]);
  /** 压在整个新的一行上：另一个来源块的整块区域（比如它的待用格与子会话列）。 */
  const underneath = { x: -100, y: 272, w: 1000, h: 200 };
  /** 压在新的一列的列顶上。 */
  const beside = { x: 540, y: -50, w: 100, h: 100 };

  it("新的一行整行放不下：比例明明偏向长一行，也只能另起一列", () => {
    expect(slot({ roots, reserved: [underneath], area: TALL_NARROW })).toEqual({ x: 560, y: 0 });
  });

  it("新的一列的列顶放不下：比例明明偏向另起一列，也只能长一行", () => {
    expect(slot({ roots, reserved: [beside], area: WIDE_SHORT })).toEqual({ x: 0, y: 272 });
  });

  it("(e) 两边都放不下：返回 undefined，由调用方照原来的办法找位置", () => {
    expect(slot({ roots, reserved: [underneath, beside], area: HUGE })).toBeUndefined();
    expect(slot({ roots, reserved: [underneath, beside] })).toBeUndefined();
  });
});

describe("(f) 步长与卡的尺寸都是调用方给的", () => {
  it("紧凑的格点排布（卡 208 × 112，步长 232 × 128）：另起的一列在 x = 232 + 232，新的一行在 y = 2 × 128", () => {
    const size = { w: 208, h: 112 };
    const steps = { x: 232, y: 128 };
    const roots = [0, 1].flatMap((col) => [0, 1].map((row) => at(col, row, steps, size)));
    expect(slot({ roots, steps, size, area: { w: 1000, h: 300 } }), "宽而矮：另起一列").toEqual({ x: 464, y: 0 });
    expect(slot({ roots, steps, size, area: { w: 480, h: 1000 } }), "窄而高：长一行").toEqual({ x: 0, y: 256 });
  });

  it("步长不是卡的整数倍（300 × 150）也照用：新的一行 y = 2 × 150，新的一列 x = 300", () => {
    const steps = { x: 300, y: 150 };
    const roots = [at(0, 0, steps), at(0, 1, steps)];
    expect(slot({ roots, steps, area: HUGE })).toEqual({ x: 0, y: 300 });
    expect(slot({ roots, steps, area: { w: 1000, h: 300 } })).toEqual({ x: 300, y: 0 });
  });

  it("经典的树里奇偶行错开一小段：规划给的横坐标 (24) 与落点同列、放得下就沿用；离得远（≥ 半张卡宽）、被挤着就不用", () => {
    const staggered = [at(0, 0), { ...at(0, 1), x: 24 }, at(0, 2)];
    expect(slot({ roots: staggered, align: 24 })).toEqual({ x: 24, y: 408 });
    expect(slot({ roots: staggered, align: 300 }), "不在同一列").toEqual({ x: 0, y: 408 });
    expect(slot({ roots: staggered, align: 24, reserved: [{ x: 290, y: 408, w: 50, h: 112 }] }), "(24, 408) 放不下、(0, 408) 放得下").toEqual({ x: 0, y: 408 });
  });
});

describe("(g) 来源块里还没有根会话：没有格子可谈，返回 undefined", () => {
  it("没有已有的根会话（块里只有子会话也一样）", () => {
    expect(slot({ roots: [] })).toBeUndefined();
    expect(slot({ roots: [], kids: [at(1, 0)] })).toBeUndefined();
  });

  it("只有一个根会话：第一个空格就是它下面的新一行或旁边的新一列（没有空格可填）", () => {
    expect(slot({ roots: [at(0, 0)], area: HUGE })).toEqual({ x: 0, y: 136 });
    expect(slot({ roots: [at(0, 0)], area: { w: 300, h: 100 } }), "放不下新的一行时另起一列").toEqual({ x: 280, y: 0 });
  });
});

describe("(h) 没有取景区域：不比较，只填空格；没有空格长一行；放不下才长一列", () => {
  const roots = gridOf([2, 2]);

  it("填空格", () => {
    expect(slot({ roots: gridOf([3, 2, 1]) })).toEqual({ x: 560, y: 136 });
  });

  it("没有空格：长一行（比例不比，另起一列即使更好看也不选）", () => {
    expect(slot({ roots })).toEqual({ x: 0, y: 272 });
  });

  it("新的一行放不下：长一列", () => {
    expect(slot({ roots, reserved: [{ x: -100, y: 272, w: 1000, h: 200 }] })).toEqual({ x: 560, y: 0 });
  });
});
