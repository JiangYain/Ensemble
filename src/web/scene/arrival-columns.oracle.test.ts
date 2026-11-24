import { describe, expect, it } from "vitest";
import { agentsOf, arrive, optionsOf, WINDOWS } from "./arrival.columns.fixtures";
import { agent, roots, spot } from "./arrival.fixtures";
import type { Rect } from "./placement";

/**
 * 根会话到达规则的独立复核（LAYOUT6 / LAYOUT8）：不调用 `growSlot`，只拿每一步前后的真实布局，按规则的文字（见 arrival-grow.ts）重新算一遍——
 * 外框里还有空格，新卡落在阅读顺序（先行后列）里的第一个空格；没有空格，比较“长一行”与“另起一列”哪一种让整个排布在取景区域里看得全的比例更高
 * （高出 0.0005 以上才算更全）；持平就看形状：长出来之后这个来源块（只有会话卡，不含来源卡）的宽高比离取景区域的宽高比哪个更近
 * （对数比；另起一列要近出 0.05 以上才选它，不然仍长一行），再核对新卡实际去了哪。单来源、纯根会话（没有家族），所以格子就是根会话卡本身所在的行与列。
 * 这样规则的取值（先填空格、看得全的比例用全部卡的外框、持平看块的形状、形状一样像长一行）有两份独立的陈述互相钉着，改实现不改规则时测试不会跟着变。
 * 旧的版本（LAYOUT3）复核的是“满了另起一列”的判据（每列至少 3 张、只看这一列的末尾），它对根会话已经不适用，被这一份取代。
 */

const KEY = "cursor:a";
/** 一种长法要比另一种高出多少才算“更全”：规则文字里的容差（arrival-grow.ts 里有同一个取值，这里独立写一遍）。 */
const TIE = 5e-4;
/** 持平时“形状一样像”的容差：两个块与取景区域的宽高比，对数比相差不足它（约 5%）算一样像（同上，独立写一遍）。 */
const SHAPE_TIE = 0.05;

const boxOf = (rects: readonly Rect[]): Rect => {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
};

describe.each(WINDOWS)("每个到达的根会话都落在规则说的那里：$name", ({ area }) => {
  // 列间空白、行间空白：经典的树与宽格点是 32 / 24（列距 280 减卡宽 248、行距 136 减卡高 112），紧凑的格点排布是 24 / 16（232 减 208、128 减 112）。
  const compact = area.w < 720;
  const space = compact ? 24 : 32;
  const gap = compact ? 16 : 24;

  it("1 → 60 个：填空格、长一行、另起一列（持平时看形状），与按规则重新算出来的一致；另起时紧挨在最右一列的右边（隔一道列间空白）、顶与第一排对齐", () => {
    const steps = arrive(roots(KEY, 60), optionsOf(area));
    const card = agentsOf(steps[0]!)[0]!;
    const pitch = { x: card.w + space, y: card.h + gap };
    const shown = (box: Rect): number => Math.min(1, area.w / box.w, area.h / box.h);
    /** 宽高比离取景区域的宽高比有多远：对数比的绝对值，越小越像。 */
    const unlikeness = (box: Rect): number => Math.abs(Math.log(box.w / box.h / (area.w / area.h)));
    const tally = { fill: 0, row: 0, column: 0, tie: 0, tieRow: 0, tieColumn: 0 };
    for (let k = 2; k <= 60; k++) {
      const before = steps[k - 2]!;
      const placed = spot(steps[k - 1]!, agent(`r${k}`));
      const cards = agentsOf(before);
      const xs = [...new Set(cards.map((c) => c.x))].sort((a, b) => a - b);
      const top = Math.min(...cards.map((c) => c.y));
      const rows = Math.round((Math.max(...cards.map((c) => c.y + c.h)) - card.h - top) / pitch.y) + 1;
      const taken = new Set(cards.map((c) => `${c.x},${c.y}`));
      const label = `第 ${k} 个到达`;

      // 外框里的空格：行优先、行内从左到右的第一个。
      let empty: { x: number; y: number } | undefined;
      for (let r = 0; r < rows && !empty; r++) {
        const x = xs.find((at) => !taken.has(`${at},${top + r * pitch.y}`));
        if (x !== undefined) empty = { x, y: top + r * pitch.y };
      }
      if (empty) {
        expect(placed, `${label}：外框里还有空格，先填`).toEqual(empty);
        tally.fill++;
        continue;
      }

      const frame = boxOf(before.nodes);
      const row = { x: xs[0]!, y: top + rows * pitch.y };
      const column = { x: xs[xs.length - 1]! + pitch.x, y: top };
      const reach = (at: { x: number; y: number }): number => shown(boxOf([frame, { ...at, w: card.w, h: card.h }]));
      // 持平时看的是这个来源块自己的会话卡（不含来源卡）加上新卡的外框。
      const unlike = (at: { x: number; y: number }): number => unlikeness(boxOf([...cards, { ...at, w: card.w, h: card.h }]));
      const tied = Math.abs(reach(column) - reach(row)) <= TIE;
      const wider = tied ? unlike(column) < unlike(row) - SHAPE_TIE : reach(column) > reach(row);
      const why = tied ? `持平，形状：长一行 ${unlike(row).toFixed(4)}，另起 ${unlike(column).toFixed(4)}` : `看得全：长一行 ${reach(row).toFixed(4)}，另起 ${reach(column).toFixed(4)}`;
      expect(placed, `${label}：${wider ? "另起一列" : "长一行"}（${why}）`).toEqual(wider ? column : row);
      tally[wider ? "column" : "row"]++;
      if (tied) {
        tally.tie++;
        tally[wider ? "tieColumn" : "tieRow"]++;
      }
    }
    expect(tally.fill, "前提：这 60 步里确实有填空格的").toBeGreaterThan(0);
    expect(tally.row, "前提：确实有长一行的").toBeGreaterThan(0);
    expect(tally.column, "前提：确实有另起一列的").toBeGreaterThan(0);
    // 三个桌面窗口里前几个到达时整体还放得下，两种方向一样全，规则看形状：既有因为形状更像而另起一列的，也有形状一样像或更像一行于是长一行的；
    // 竖屏与窄区域里这样的步不一定有，不要求。
    if (area.w >= 800) {
      expect(tally.tieColumn, "前提：确实有两种方向一样全、但另起一列的形状更像取景区域的").toBeGreaterThan(0);
      expect(tally.tieRow, "前提：确实有两种方向一样全、长一行的形状更像或一样像的").toBeGreaterThan(0);
    }
  });
});
