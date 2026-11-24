import { describe, expect, it } from "vitest";
import { arrive, columnsIn, optionsOf, WINDOWS } from "./arrival.columns.fixtures";
import { moved } from "./arrival.fixtures";
import type { SceneLayout } from "./layout";
import { overlapsOf } from "./layout.fixtures";
import { REAL_CANVASES, realSessions } from "./layout.real.fixtures";

/**
 * 真实画布形状里的“竖排满了另起一列”（LAYOUT3）：与 arrival.real.test.ts 同一批六张画布、同一个做法——页面先载入前 60%（整体规划），
 * 其余按真实的创建先后一个个到达——区别是这里带着取景区域，走另起新列的那条路。每一步：已有的卡位移为 0、不重叠、只多出新来的这一张。
 * 合成数据里想不到的形状（几十个单卡夹着带 12 个、37 个子会话的家族，孙会话晚于兄弟到达）都在这里过一遍。
 */

const AREAS = [WINDOWS[0]!, WINDOWS[2]!];

describe("真实画布形状 + 取景区域：页面载入大半，其余逐个到达", () => {
  for (const canvas of REAL_CANVASES) {
    for (const { name, area } of AREAS) {
      it(`${canvas.name} · ${name}：每到一个，已有的卡位移为 0、不重叠、只多出这一张新卡`, () => {
        const all = realSessions(canvas);
        const start = Math.ceil(all.length * 0.6);
        const steps = arrive(all, optionsOf(area), undefined, start);
        steps.forEach((next, i) => {
          const count = start + i;
          const label = `${canvas.name} 第 ${count} 个到达`;
          expect(overlapsOf(next), label).toEqual([]);
          expect(
            next.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y)),
            label,
          ).toBe(true);
          const shown = steps[i - 1];
          if (!shown) return;
          expect(moved(shown, next), label).toEqual([]);
          const before = new Set(shown.nodes.map((node) => node.id));
          expect(next.nodes.filter((node) => !before.has(node.id)).map((node) => node.id), label).toEqual([`agent:${all[count - 1]!.id}`]);
        });
        expect(steps.at(-1)!.nodes.filter((node) => node.kind === "agent")).toHaveLength(all.length);
      });
    }
  }

  it("一个根会话带 37 个子会话的那张画布：后来的子会话另起了列，整体比一路往下接矮得多（1440×900）", () => {
    const canvas = REAL_CANVASES.find((entry) => entry.name === "88e325d7")!;
    const all = realSessions(canvas);
    const start = Math.ceil(all.length * 0.6);
    const options = optionsOf(WINDOWS[0]!.area);
    const withArea = arrive(all, options, undefined, start).at(-1)!;
    const without = arrive(all, options, "none", start).at(-1)!;
    expect(columnsIn(withArea).length, "另起了列").toBeGreaterThan(columnsIn(without).length);
    expect(withArea.bounds.h, "外框的高度").toBeLessThan(without.bounds.h * 0.7);
  });

  it("带着子会话家族的画布，到达的会话让竖排另起列后外框都不比一路往下接的更高（两个窗口）", () => {
    for (const canvasName of ["299997f3", "88e325d7", "7c1805af"]) {
      const all = realSessions(REAL_CANVASES.find((entry) => entry.name === canvasName)!);
      const start = Math.ceil(all.length * 0.6);
      for (const { name, area } of AREAS) {
        const options = optionsOf(area);
        const withArea = arrive(all, options, undefined, start).at(-1)!;
        const without = arrive(all, options, "none", start).at(-1)!;
        expect(withArea.bounds.h, `${canvasName} · ${name}`).toBeLessThan(without.bounds.h);
      }
    }
  });

  it("载入的是多列格点、到达的又没有哪个竖排长到另起一列的大画布：带不带取景区域结果一样（格点按行填的规则没动）", () => {
    // 这是现状的描述，不是承诺：到达的会话要是让某个家族的竖排满了，结果就会不同——那是新规则该有的样子。
    // 7295d4f1 不再属于这一类：新列紧挨着上一列（不再留一条“子会话专用的道”），#37 的竖排更早满，见下一条。
    const canvasName = "70b49d0d";
    const all = realSessions(REAL_CANVASES.find((entry) => entry.name === canvasName)!);
    const start = Math.ceil(all.length * 0.6);
    for (const { name, area } of AREAS) {
      const options = optionsOf(area);
      const withArea = arrive(all, options, undefined, start);
      const without = arrive(all, options, "none", start);
      withArea.forEach((layout, i) => {
        expect(
          layout.nodes.map((n) => [n.id, n.x, n.y]),
          `${canvasName} · ${name} 第 ${start + i} 个到达`,
        ).toEqual(without[i]!.nodes.map((n) => [n.id, n.x, n.y]));
      });
    }
  });

  it("7295d4f1：#37 右边的竖排被 #38–#40 占满后，#41 到达的那一步才与一路往下接不同——之前一样，之后另起一列、顶与第一个子会话对齐（两个窗口）", () => {
    const all = realSessions(REAL_CANVASES.find((entry) => entry.name === "7295d4f1")!);
    const start = Math.ceil(all.length * 0.6);
    for (const { name, area } of AREAS) {
      const options = optionsOf(area);
      const withArea = arrive(all, options, undefined, start);
      const without = arrive(all, options, "none", start);
      const cells = (layout: SceneLayout): string => JSON.stringify(layout.nodes.map((n) => [n.id, n.x, n.y]));
      const first = withArea.findIndex((layout, i) => cells(layout) !== cells(without[i]!));
      expect(all[start + first - 1]!.id, `${name}：第一个不同的一步是哪张卡到达`).toBe("7295d4f1-41");
      const layout = withArea[first]!;
      const kid = (id: number) => layout.nodes.find((n) => n.id === `agent:7295d4f1-${id}`)!;
      expect(kid(41).x, `${name}：#41 在 #38 所在那一列的右边`).toBe(kid(38).x + 280);
      expect(kid(41).y, `${name}：顶与第一个子会话对齐`).toBe(kid(38).y);
    }
  });
});
