import { describe, expect, it } from "vitest";
import { COMPACT, DESK, NARROW } from "./arrival.fixtures";
import { growthRun } from "./arrival.growth.fixtures";
import type { LayoutOptions, SceneLayout } from "./layout";

/**
 * 带着取景区域的随机生长（LAYOUT3）：与 arrival-hold.test.ts 里不给取景区域的那一组同一个生成器，
 * 区别是步数多、偏向根会话与子会话（竖排才长得到“满”）、起步只有 1 个根，并且把取景区域交给持有逻辑。
 * 每一步都检查：不整体重排、已有的卡不动、不重叠、坐标有限、顺序与规划一致、新增的就是这一步新出现的节点、汇聚会话在上级的右边。
 */

const TUNE = { steps: 60, initial: 1, cut: [0.5, 0.85] } as const;
/** 几乎全是根会话（LAYOUT6）：规则（arrival-grow.ts）只管根会话，混着一半子会话时多数落点与规划相同，要这一组才常走到规则自己挑的落点。 */
const ROOTY = { steps: 60, initial: 1, cut: [0.9, 0.97] } as const;
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
const pointsOf = (layout: SceneLayout): string => layout.nodes.map((n) => `${n.id}@${n.x},${n.y}`).join("|");

describe("随机生长 + 取景区域：每一步都满足不变量", () => {
  for (const [name, options] of [["宽屏", DESK], ["竖屏", NARROW], ["窄区域", COMPACT]] as const) {
    it(`${name}：${SEEDS.length} 个种子 × ${TUNE.steps} 步`, () => {
      const runs = SEEDS.map((seed) => growthRun(seed, options, { ...TUNE, area: options.area }));
      expect(runs.flatMap((run) => run.found).slice(0, 12)).toEqual([]);
    });

    it(`${name}：${SEEDS.length} 个种子 × ${ROOTY.steps} 步（几乎全是根会话）`, () => {
      const runs = SEEDS.map((seed) => growthRun(seed, options, { ...ROOTY, area: options.area }));
      expect(runs.flatMap((run) => run.found).slice(0, 12)).toEqual([]);
    });

    it(`${name}：前提——以根会话为主的种子确实走到了规则自己挑的落点（最终排布与不给取景区域时不同）`, () => {
      // 旧：TUNE 的前 6 个种子里至少 5 个不同（旧的判据 G 让每个窗口都另起新列，规划是一路往下的竖排）。
      // 现在规则只在“另起一列比长一行更看得全”时才离开规划的落点；TUNE 里一半是子会话、竖屏与窄区域里多数落点与规划相同，
      // 前提改成：根会话为主的 20 个种子里至少一半不同（宽屏 19、竖屏 12、窄区域 16）。
      const differing = SEEDS.filter((seed) => {
        const withArea = growthRun(seed, options, { ...ROOTY, area: options.area });
        const without = growthRun(seed, options, ROOTY);
        expect(without.found, `种子 ${seed} 不给取景区域时的违反`).toEqual([]);
        return pointsOf(withArea.layout) !== pointsOf(without.layout);
      });
      expect(differing.length).toBeGreaterThanOrEqual(SEEDS.length / 2);
    });
  }
});

describe("随机生长 + 取景区域：全景（所有空间——经典的树、多个来源，不是格点排布）", () => {
  // Overview 在“全部活跃”的全景里不开格点排布，多个来源的块上下叠着：另起的列要躲开别的来源与它们的家族整块区域。
  for (const [name, area] of [
    ["宽屏", { w: 1088, h: 710 }],
    ["竖屏", { w: 720, h: 1000 }],
    ["窄区域", { w: 288, h: 544 }],
  ] as const) {
    it(`${name}：${SEEDS.length - 8} 个种子 × ${TUNE.steps} 步，已有的卡不动、不重叠、顺序与规划一致`, () => {
      const options: LayoutOptions = { area };
      const runs = SEEDS.slice(0, SEEDS.length - 8).map((seed) => growthRun(seed, options, { ...TUNE, area }));
      expect(runs.flatMap((run) => run.found).slice(0, 12)).toEqual([]);
      expect(runs.every((run) => run.layout.grid !== true), "前提：这是经典的树，不是格点").toBe(true);
    });
  }
});
