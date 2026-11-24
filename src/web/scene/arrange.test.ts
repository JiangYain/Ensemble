import { describe, expect, it } from "vitest";
import { alignBoxes, distributeBoxes, type Box } from "./arrange";

/** 三个大小不一的节点：宽窄、高矮都不同，才能分出“对齐到哪条边”。 */
const boxes: Box[] = [
  { id: "a", x: 10, y: 40, w: 100, h: 60 },
  { id: "b", x: 200, y: 10, w: 60, h: 120 },
  { id: "c", x: 120, y: 90, w: 140, h: 40 },
];

const at = (result: Map<string, { x: number; y: number }>, id: string): { x: number; y: number } => result.get(id)!;

describe("alignBoxes", () => {
  it("left / right 对齐到整体外框的左右边，纵向不动", () => {
    const left = alignBoxes(boxes, "left");
    expect(boxes.map((box) => at(left, box.id).x)).toEqual([10, 10, 10]);
    expect(boxes.map((box) => at(left, box.id).y)).toEqual([40, 10, 90]);

    // 外框右边是 260（b 与 c 的右缘）。
    const right = alignBoxes(boxes, "right");
    expect(boxes.map((box) => at(right, box.id).x + box.w)).toEqual([260, 260, 260]);
    expect(boxes.map((box) => at(right, box.id).y)).toEqual([40, 10, 90]);
  });

  it("top / bottom 对齐到整体外框的上下边，横向不动", () => {
    const top = alignBoxes(boxes, "top");
    expect(boxes.map((box) => at(top, box.id).y)).toEqual([10, 10, 10]);
    expect(boxes.map((box) => at(top, box.id).x)).toEqual([10, 200, 120]);

    // 外框下边是 130（b 与 c 的下缘）。
    const bottom = alignBoxes(boxes, "bottom");
    expect(boxes.map((box) => at(bottom, box.id).y + box.h)).toEqual([130, 130, 130]);
    expect(boxes.map((box) => at(bottom, box.id).x)).toEqual([10, 200, 120]);
  });

  it("居中对齐：每个节点的中心落在整体外框的中线上", () => {
    const hcenter = alignBoxes(boxes, "hcenter");
    // 外框 x：10..260，中线 135。
    expect(boxes.map((box) => at(hcenter, box.id).x + box.w / 2)).toEqual([135, 135, 135]);
    const vmiddle = alignBoxes(boxes, "vmiddle");
    // 外框 y：10..130，中线 70。
    expect(boxes.map((box) => at(vmiddle, box.id).y + box.h / 2)).toEqual([70, 70, 70]);
  });

  it("两个节点就能对齐；少于两个没有可对齐的对象", () => {
    expect(alignBoxes(boxes.slice(0, 2), "left").size).toBe(2);
    expect(alignBoxes(boxes.slice(0, 1), "left").size).toBe(0);
    expect(alignBoxes([], "top").size).toBe(0);
  });

  it("结果落在整数像素上（中线落在半像素时取整），也不改动输入", () => {
    const odd: Box[] = [
      { id: "a", x: 0, y: 0, w: 101, h: 51 },
      { id: "b", x: 300, y: 80, w: 50, h: 30 },
    ];
    const copy = JSON.parse(JSON.stringify(odd)) as Box[];
    const result = alignBoxes(odd, "hcenter");
    for (const position of result.values()) {
      expect(Number.isInteger(position.x)).toBe(true);
      expect(Number.isInteger(position.y)).toBe(true);
    }
    expect(odd).toEqual(copy);
  });

  it("已经对齐的节点原地不动", () => {
    const aligned: Box[] = [
      { id: "a", x: 10, y: 0, w: 100, h: 40 },
      { id: "b", x: 10, y: 80, w: 60, h: 40 },
    ];
    const result = alignBoxes(aligned, "left");
    expect(at(result, "a")).toEqual({ x: 10, y: 0 });
    expect(at(result, "b")).toEqual({ x: 10, y: 80 });
  });
});

describe("distributeBoxes", () => {
  it("水平等距：整体外框不变，相邻节点之间的空隙相等，纵向不动", () => {
    const row: Box[] = [
      { id: "a", x: 0, y: 5, w: 100, h: 40 },
      { id: "b", x: 150, y: 20, w: 60, h: 40 },
      { id: "c", x: 400, y: 0, w: 100, h: 40 },
    ];
    const result = distributeBoxes(row, "horizontal");
    // 外框 0..500，宽度合计 260，两个空隙各 120。
    expect([at(result, "a").x, at(result, "b").x, at(result, "c").x]).toEqual([0, 220, 400]);
    expect([at(result, "a").y, at(result, "b").y, at(result, "c").y]).toEqual([5, 20, 0]);
    const gaps = [at(result, "b").x - (at(result, "a").x + 100), at(result, "c").x - (at(result, "b").x + 60)];
    expect(gaps).toEqual([120, 120]);
  });

  it("垂直等距同理", () => {
    const column: Box[] = [
      { id: "a", x: 0, y: 0, w: 80, h: 50 },
      { id: "b", x: 30, y: 60, w: 80, h: 100 },
      { id: "c", x: 10, y: 300, w: 80, h: 50 },
    ];
    const result = distributeBoxes(column, "vertical");
    // 外框 0..350，高度合计 200，两个空隙各 75。
    expect([at(result, "a").y, at(result, "b").y, at(result, "c").y]).toEqual([0, 125, 300]);
    expect([at(result, "a").x, at(result, "b").x, at(result, "c").x]).toEqual([0, 30, 10]);
  });

  it("按中心位置排序，与传入顺序无关", () => {
    const shuffled: Box[] = [
      { id: "c", x: 400, y: 0, w: 100, h: 40 },
      { id: "a", x: 0, y: 0, w: 100, h: 40 },
      { id: "b", x: 150, y: 0, w: 60, h: 40 },
    ];
    const result = distributeBoxes(shuffled, "horizontal");
    expect([at(result, "a").x, at(result, "b").x, at(result, "c").x]).toEqual([0, 220, 400]);
  });

  it("多于三个节点时空隙依旧全部相等", () => {
    const row: Box[] = [0, 90, 130, 600].map((x, index) => ({ id: `n${index}`, x, y: 0, w: 100, h: 40 }));
    const result = distributeBoxes(row, "horizontal");
    const xs = row.map((box) => at(result, box.id).x);
    expect(xs).toEqual([0, 200, 400, 600]);
  });

  it("少于三个节点没有“中间的”可分布，返回空", () => {
    expect(distributeBoxes(boxes.slice(0, 2), "horizontal").size).toBe(0);
    expect(distributeBoxes([], "vertical").size).toBe(0);
  });

  it("空隙取不到整数时各节点仍落在整数像素上，首尾不动", () => {
    const row: Box[] = [
      { id: "a", x: 0, y: 0, w: 100, h: 40 },
      { id: "b", x: 111, y: 0, w: 100, h: 40 },
      { id: "c", x: 150, y: 0, w: 100, h: 40 },
      { id: "d", x: 301, y: 0, w: 100, h: 40 },
    ];
    const result = distributeBoxes(row, "horizontal");
    for (const position of result.values()) expect(Number.isInteger(position.x)).toBe(true);
    expect(at(result, "a").x).toBe(0);
    expect(at(result, "d").x).toBe(301);
  });
});
