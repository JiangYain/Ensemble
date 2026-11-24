import { describe, expect, it } from "vitest";
import { arrive, optionsOf, WINDOWS } from "./arrival.columns.fixtures";
import { roots } from "./arrival.fixtures";
import type { SceneLayout } from "./layout";

/**
 * 外框里的空格有上限（LAYOUT6）：只有根会话、没有手动拖动时，每一步外框（会话卡所在的列 × 行）里的空格数 ≤ max(列数, 行数) − 1。
 * 道理就是规则本身：先填外框里的空格，没有空格才长；长一行最多留下“列数 − 1”个空格（新的一行只有第一格有卡），
 * 长一列最多留下“行数 − 1”个——所以外框永远不会有一半是空的（以前从 1 个根起逐个到达，列高 [5, 4, 5, 8, 1, 10, 1]，77 个格子里只有 34 张卡）。
 * 两种真实顺序都量：A 从空来（1 → 60 个），B 载入 7 / 24 / 40 个再追加 30 个。
 */

const KEY = "cursor:a";

function framed(layout: SceneLayout): { cols: number; rows: number; empty: number } {
  const cards = layout.nodes.filter((n) => n.kind === "agent");
  const cols = new Set(cards.map((n) => n.x)).size;
  const rows = new Set(cards.map((n) => n.y)).size;
  return { cols, rows, empty: cols * rows - cards.length };
}

/** 逐步检查上限，返回这一串里出现过的最大空格数（用来确认检查不是空转）。 */
function checkAll(steps: readonly SceneLayout[], first: number, label: string): number {
  let most = 0;
  steps.forEach((layout, i) => {
    const { cols, rows, empty } = framed(layout);
    expect(empty, `${label} 第 ${first + i} 个：${cols} 列 × ${rows} 行里的空格`).toBeLessThanOrEqual(Math.max(cols, rows) - 1);
    most = Math.max(most, empty);
  });
  return most;
}

describe("A 从空来：1 → 60 个，每一步外框里的空格 ≤ max(列数, 行数) − 1", () => {
  for (const { name, area } of WINDOWS) {
    it(name, () => {
      const most = checkAll(arrive(roots(KEY, 60), optionsOf(area)), 1, name);
      expect(most, "前提：这 60 步里确实出现过空格（刚开出来的一行 / 一列）").toBeGreaterThan(0);
    });
  }
});

describe("B 载入后追加：载入 7 / 24 / 40 个再追加 30 个，每一步外框里的空格 ≤ max(列数, 行数) − 1", () => {
  for (const { name, area } of WINDOWS.slice(0, 3)) {
    for (const load of [7, 24, 40]) {
      it(`${name}，先载入 ${load} 个`, () => {
        const most = checkAll(arrive(roots(KEY, load + 30), optionsOf(area), undefined, load), load, name);
        expect(most, "前提：确实出现过空格").toBeGreaterThan(0);
      });
    }
  }
});
