import { describe, expect, it } from "vitest";
import { at, gridOf, HUGE, SIZE, slot } from "./arrival-grow.fixtures";
import { arrive, optionsOf, shapeOf, WINDOWS } from "./arrival.columns.fixtures";
import { roots } from "./arrival.fixtures";
import { fitScale, layoutScene, MIN_ZOOM, type Area, type SceneLayout } from "./layout";

/**
 * 根会话到达规则里“持平时看形状”这一步（arrival-grow.ts，LAYOUT8 · W1）：
 * 新开一行与新开一列让整体看得全的比例差不到 0.05 个百分点时，不再一律长一行，而是看长出来之后这个来源块（只算它自己的会话卡，不含来源卡
 * 与别的来源块）的宽高比，哪个更接近取景区域的宽高比（取对数比）；新开一列要比新开一行近出 0.05 以上（宽高比差约 5%）才选它，不然仍长一行。
 * 前半是纯几何（每个数都能手算），后半经过持有与取景区域的整条路：前 12 个根会话的形状表、载入后追加与刷新后的缩放。
 */

describe("(a) 持平时看形状：长出来的块的宽高比更接近取景区域的那种长法", () => {
  // 2 × 2 排满：块 528 × 248。长一行 (0,272) → 528 × 384（宽高比 1.375）；另起一列 (560,0) → 808 × 248（3.258）。
  const roots = gridOf([2, 2]);
  const ROW = { x: 0, y: 272 };
  const COLUMN = { x: 560, y: 0 };

  it("两种长法都是 100%：取景区域是方的 (1)，长一行（1.375 对 1 差 0.32）；很宽 (5000 × 1000，宽高比 5)，另起一列（3.258 对 5 差 0.43，长一行差 1.29）", () => {
    expect(slot({ roots, area: HUGE })).toEqual(ROW);
    expect(slot({ roots, area: { w: 5000, h: 1000 } })).toEqual(COLUMN);
  });

  it("形状差别不大时仍长一行：宽高比相差不到 5%（对数比 0.05）算一样像——长一行 (0,272)；差得再多一点才另起一列", () => {
    // 1000 × 465（2.151）：长一行差 ln(2.151 / 1.375) = 0.447，另起一列差 ln(3.258 / 2.151) = 0.416，只近 0.032，不到 0.05。
    expect(slot({ roots, area: { w: 1000, h: 465 } })).toEqual(ROW);
    // 1000 × 454（2.203）：长一行差 0.471，另起一列差 0.391，近 0.080，另起一列。
    expect(slot({ roots, area: { w: 1000, h: 454 } })).toEqual(COLUMN);
  });

  it("看的是这个来源块的形状，不是全部卡的外框：来源卡在块的左边把外框压宽了，块自己的形状仍是另起一列更像取景区域", () => {
    // 来源卡在 (-304, 0)：整个外框是长一行 832 × 384（2.167）或另起一列 1112 × 248（4.484），取景区域 1500 × 600（2.5）会选长一行（0.143 对 0.583）；
    // 块自己是 528 × 384（1.375）对 808 × 248（3.258），另起一列（0.265 对 0.598）。两种长法在 1500 × 600 里都是 100%。
    const origin = { x: -304, y: 0, ...SIZE };
    expect(slot({ roots, others: [origin], area: { w: 1500, h: 600 } })).toEqual(COLUMN);
    expect(slot({ roots, area: { w: 1500, h: 600 } }), "没有来源卡也是另起一列：来源卡不改变判断").toEqual(COLUMN);
  });

  it("别的来源块也不算：它在块的下面一整排，只看这个块自己的形状（别的块在 (0,600)，块的外框与它不相干）", () => {
    // 别的来源块的卡贴着这个块的下方（y = 600 起，与新的一行 (0,272) 隔得开）：外框很高，但块自己的形状没变。
    const others = [{ x: 0, y: 600, ...SIZE }, { x: 280, y: 600, ...SIZE }];
    expect(slot({ roots, others, area: { w: 5000, h: 1000 } })).toEqual(COLUMN);
    expect(slot({ roots, others, area: HUGE })).toEqual(ROW);
  });

  it("块里的子会话也算形状：它们把块拉宽了，长一行才更像取景区域", () => {
    // 根会话 2 × 2，子会话占着第 3、4 列（也是 2 行排满，没有空格）：块 1088 × 248（4.39）。取景区域 1500 × 500（3）里两种长法都是 100%：
    // 长一行 → 1088 × 384（2.833，差 0.057），另起一列 (1120,0) → 1368 × 248（5.516，差 0.609）；只算根会话的话反过来（1.375 差 0.78，5.516 差 0.609）。
    const kids = [at(2, 0), at(2, 1), at(3, 0), at(3, 1)];
    expect(slot({ roots, kids, area: { w: 1500, h: 500 } })).toEqual(ROW);
  });

  it("看得全的比例严格更高的先赢，不看形状：来源卡压宽了外框，另起一列放不下 (0.989)，长一行放得下 (100%)——哪怕块的形状更像另起一列", () => {
    // 外框 1112 × 248 对 1100 × 440：宽放不下，0.989；长一行 832 × 384 放得下，100%（高出 1.08 个百分点，不是持平）。
    // 块的形状在 1100 × 440（2.5）里更像另起一列（0.265 对 0.598）。
    const origin = { x: -304, y: 0, ...SIZE };
    expect(slot({ roots, others: [origin], area: { w: 1100, h: 440 } })).toEqual(ROW);
  });

  it("没有取景区域：没有形状可比，仍是先填空格、再长一行（形状这一步只在有取景区域时才有）", () => {
    expect(slot({ roots })).toEqual(ROW);
    expect(slot({ roots: gridOf([1]) })).toEqual({ x: 0, y: 136 });
  });
});

/** 经过持有与取景区域的整条路：根会话逐个到达，每一步的形状（各列张数，从左到右）。 */
const shapesOf = (area: Area, n: number): number[][] => arrive(roots("cursor:a", n), optionsOf(area)).map(shapeOf);

describe("(b) 前 12 个根会话的形状（N = 1 … 12，Overview 的格点选项）：宽的窗口里不再竖成一条", () => {
  const TABLE: Record<string, readonly (readonly number[])[]> = {
    "1440×900": [[1], [2], [2, 1], [2, 2], [3, 2], [3, 3], [4, 3], [4, 4], [5, 4], [5, 5], [5, 5, 1], [5, 5, 2]],
    "1920×1080": [[1], [2], [2, 1], [2, 2], [3, 2], [3, 3], [3, 3, 1], [3, 3, 2], [3, 3, 3], [4, 3, 3], [4, 4, 3], [4, 4, 4]],
    "1280×720": [[1], [2], [2, 1], [2, 2], [3, 2], [3, 3], [4, 3], [4, 4], [4, 4, 1], [4, 4, 2], [4, 4, 3], [4, 4, 4]],
    // 取景区域是高的 / 窄的：长一行本来就更像它，与改动前（持平一律长一行）完全一样。
    "竖屏 720×1000": [[1], [2], [3], [4], [5], [6], [7], [8], [8, 1], [8, 2], [8, 3], [8, 4]],
    "窄区域 288×544": [[1], [2], [3], [4], [5], [5, 1], [5, 2], [5, 3], [5, 4], [5, 5], [6, 5], [6, 6]],
  };

  for (const { name, area } of WINDOWS) {
    it(`${name}：每一步的形状与表一致`, () => {
      expect(shapesOf(area, 12)).toEqual(TABLE[name]!.map((shape) => [...shape]));
    });
  }

  for (const { name, area } of WINDOWS.slice(0, 3)) {
    it(`${name}（宽过高）：从第 4 个起至少两列；除最后一列外各列张数相差不超过 1，最后一列不比前面的多`, () => {
      shapesOf(area, 12).forEach((shape, i) => {
        if (i + 1 >= 4) expect(shape.length, `第 ${i + 1} 个：不是一条竖到底`).toBeGreaterThanOrEqual(2);
        const full = shape.slice(0, -1);
        const last = shape.at(-1)!;
        if (full.length > 0) {
          expect(Math.max(...full) - Math.min(...full), `第 ${i + 1} 个：各列张数 [${shape.join(", ")}]`).toBeLessThanOrEqual(1);
          expect(last, `第 ${i + 1} 个：最后一列 [${shape.join(", ")}]`).toBeLessThanOrEqual(Math.max(...full));
        }
      });
    });
  }
});

describe("(c) 载入后追加：页面打开时已有 N 个根会话（刷新后的网格），再逐个来几个——缩放仍等于同样张数刷新后的缩放", () => {
  const pageZoom = (layout: SceneLayout, area: Area): number => fitScale(layout.bounds, area, MIN_ZOOM, layout.grid === true || layout.fitAll === true);
  const LOADS = [7, 24, 40];
  const ADDS = [1, 2, 3, 4, 6, 9, 12];

  for (const { name, area } of WINDOWS.slice(0, 3)) {
    for (const load of LOADS) {
      it(`${name}：载入 ${load} 个，追加 ${ADDS.join("、")} 个之后的页面缩放等于刷新后（刷新后的排布不是这里的规则排的，只比缩放）`, () => {
        const options = optionsOf(area);
        const steps = arrive(roots("cursor:a", load + Math.max(...ADDS)), options, undefined, load);
        for (const add of ADDS) {
          const held = steps[add]!;
          const fresh = layoutScene(roots("cursor:a", load + add), options);
          expect(pageZoom(held, area), `追加 ${add} 个（共 ${load + add} 个）`).toBeCloseTo(pageZoom(fresh, area), 6);
        }
      });
    }
  }
});
