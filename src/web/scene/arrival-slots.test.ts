import { describe, expect, it } from "vitest";
import { crowds, gapOf, isFree, nearestFree, REACH, unionOf } from "./arrival-slots";
import type { Rect } from "./placement";

/** 格点排布的一格：会话卡 248×112，一格 280×136（横向空白 32、纵向空白 24）。 */
const CARD = { w: 248, h: 112 };
const STEPS = { x: 280, y: 136 };
const cell = (col: number, row: number): Rect => ({ x: col * 280, y: row * 136, ...CARD });
const pointOf = (col: number, row: number) => ({ x: col * 280, y: row * 136 });

describe("crowds / isFree / gapOf", () => {
  it("相邻两格之间的空白恰好够：不算挤；相交与靠得更近才算", () => {
    const gap = gapOf(CARD, STEPS);
    expect(gap).toBe(24);
    expect(crowds(cell(1, 0), cell(0, 0), gap)).toBe(false);
    expect(crowds(cell(0, 1), cell(0, 0), gap)).toBe(false);
    expect(crowds(cell(1, 1), cell(0, 0), gap)).toBe(false);
    // 临界点：左缘离对方右缘 24（= 272）正好不算，再近 1px 就算。
    expect(crowds({ ...cell(1, 0), x: 272 }, cell(0, 0), gap)).toBe(false);
    expect(crowds({ ...cell(1, 0), x: 271 }, cell(0, 0), gap)).toBe(true);
    expect(crowds({ ...cell(0, 1), y: 136 }, cell(0, 0), gap)).toBe(false);
    expect(crowds({ ...cell(0, 1), y: 135 }, cell(0, 0), gap)).toBe(true);
    expect(crowds(cell(0, 0), cell(0, 0), gap)).toBe(true);
  });

  it("isFree：与障碍里的每一个都隔开才算空", () => {
    const wall = [cell(0, 0), cell(2, 0)];
    expect(isFree(pointOf(1, 0), CARD, wall, 24)).toBe(true);
    expect(isFree({ x: 280 + 40, y: 0 }, CARD, wall, 24)).toBe(false);
    expect(isFree(pointOf(0, 0), CARD, wall, 24)).toBe(false);
    expect(isFree(pointOf(0, 0), CARD, [], 24)).toBe(true);
  });

  it("纵向空白比横向小时取小的（紧凑模式的一格：横向 24、纵向 16）", () => {
    expect(gapOf({ w: 208, h: 112 }, { x: 232, y: 128 })).toBe(16);
  });
});

describe("nearestFree · 离理想位置最近的空位", () => {
  it("理想位置本身空着：就是它", () => {
    expect(nearestFree(pointOf(2, 3), CARD, [cell(0, 0)], STEPS)).toEqual(pointOf(2, 3));
  });

  it("被占了：落在最近的一格（按像素距离，不是按格数）", () => {
    // 只占了理想的那一格：正下方（136）与正上方（136）同样近，先下后上。
    expect(nearestFree(pointOf(1, 1), CARD, [cell(1, 1)], STEPS)).toEqual(pointOf(1, 2));
    // 正下方也占了：正上方（136）。
    expect(nearestFree(pointOf(1, 1), CARD, [cell(1, 1), cell(1, 2)], STEPS)).toEqual(pointOf(1, 0));
    // 上下都占了：再往下两格是 272，比右边一格的 280 还近。
    expect(nearestFree(pointOf(1, 1), CARD, [cell(1, 1), cell(1, 2), cell(1, 0)], STEPS)).toEqual(pointOf(1, 3));
  });

  it("同样远时先右后左（方形的一格：上下左右都是 280）", () => {
    const square = { x: 280, y: 280 };
    const at = (col: number, row: number): Rect => ({ x: col * 280, y: row * 280, ...CARD });
    const taken = [at(1, 1), at(1, 2), at(1, 0)];
    expect(nearestFree({ x: 280, y: 280 }, CARD, taken, square)).toEqual({ x: 560, y: 280 });
    // 右边也占了：左边。
    expect(nearestFree({ x: 280, y: 280 }, CARD, [...taken, at(2, 1)], square)).toEqual({ x: 0, y: 280 });
  });

  it("横向下限：汇聚的会话不会落在上级的左边，即使那里更近", () => {
    const taken = [cell(2, 0)];
    expect(nearestFree(pointOf(2, 0), CARD, taken, STEPS, 2 * 280)?.x).toBeGreaterThanOrEqual(2 * 280);
    // 没有下限时，正下方（136）已经够近；下限只会排除左边的候选，所以这里取一个把整列以左都排除的值。
    expect(nearestFree(pointOf(2, 0), CARD, taken, STEPS, 3 * 280)).toEqual(pointOf(3, 0));
  });

  it("候选都落在以理想位置为原点的格子上：理想位置不在整数格上，落点也跟着它错开同样的量", () => {
    const found = nearestFree({ x: 13, y: 7 }, CARD, [{ x: 13, y: 7, ...CARD }], STEPS);
    expect(found).toEqual({ x: 13, y: 7 + 136 });
  });

  it("周围 REACH 格以内都被占了：没有空位（调用方再放到所有卡的下面）", () => {
    const reach = REACH * 280 + 400;
    expect(nearestFree(pointOf(0, 0), CARD, [{ x: -reach, y: -reach, w: reach * 2, h: reach * 2 }], STEPS)).toBeUndefined();
  });

  it("不修改传入的障碍", () => {
    const obstacles = [cell(1, 1)];
    const copy = structuredClone(obstacles);
    nearestFree(pointOf(1, 1), CARD, obstacles, STEPS);
    expect(obstacles).toEqual(copy);
  });
});

describe("unionOf", () => {
  it("一组矩形的外框；空组没有", () => {
    expect(unionOf([])).toBeUndefined();
    expect(unionOf([cell(0, 0), cell(2, 1)])).toEqual({ x: 0, y: 0, w: 2 * 280 + 248, h: 136 + 112 });
    expect(unionOf(new Set([cell(1, 1)]))).toEqual(cell(1, 1));
  });
});
