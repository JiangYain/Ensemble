import { describe, expect, it } from "vitest";
import { agentsOf, arrive, columnsIn, optionsOf, shapeOf, WINDOWS } from "./arrival.columns.fixtures";
import { agent, kidsOf, moved, roots, spot } from "./arrival.fixtures";
import type { SceneLayout } from "./layout";
import { overlapsOf, session } from "./layout.fixtures";
import { REAL_CANVASES, realSessions } from "./layout.real.fixtures";

/**
 * 家族里逐个到达的子会话同理（LAYOUT3 · W6b）：一个根会话名下的子会话竖着排成一列，那一列满了就在右边另起一列，更深的后代再往右。
 * 走的是同一条规则（见 arrival-columns.ts），区别只在“这一列”是哪些卡、整块区域有多宽——新列在整家人（连同孙会话）的右边，顶与第一列对齐。
 * 取景区域都是 1440×900 的 1088×710，除非另说明。
 */

const KEY = "cursor:a";
const DESK = optionsOf(WINDOWS[0]!.area);
const grand = (id: string, parent: string, order: number) => session(id, KEY, order, { parentSessionId: parent });
/** 一个根 r1 与它名下逐个到达的 `n` 个子会话 k1…kn。 */
const family = (n: number) => [session("r1", KEY, 1), ...kidsOf(KEY, "r1", n, 10)];
/** 每一步相对上一步，已有的卡一张不动。 */
const expectNoneMoved = (steps: readonly SceneLayout[]): void => {
  steps.forEach((layout, i) => {
    const before = steps[i - 1];
    if (before) expect(moved(before, layout), `第 ${i + 1} 步`).toEqual([]);
  });
};

describe("一个根下的子会话逐个到达", () => {
  it("每一步：已有的卡位置不变，只多了新来的那一张，没有重叠（1 → 30 个子会话 × 五种窗口）", () => {
    for (const { name, area } of WINDOWS) {
      const steps = arrive(family(30), optionsOf(area));
      steps.forEach((layout, i) => {
        expect(overlapsOf(layout), `${name} 第 ${i + 1} 步`).toEqual([]);
        const before = steps[i - 1];
        if (!before) return;
        expect(moved(before, layout), `${name} 第 ${i + 1} 个到达时挪动了已有的卡`).toEqual([]);
        expect(layout.nodes.length - before.nodes.length, `${name} 第 ${i + 1} 步多出的节点数`).toBe(1);
      });
    }
  });

  it("满之前接在这一排的下面：前 5 个都在 x=644 的同一列，根会话不动", () => {
    const last = arrive(family(5), DESK).at(-1)!;
    expect(shapeOf(last)).toEqual([1, 5]);
    expect(spot(last, agent("r1"))).toEqual({ x: 304, y: 0 });
    expect(spot(last, agent("k1"))).toEqual({ x: 644, y: 0 });
    expect(spot(last, agent("k5"))).toEqual({ x: 644, y: 544 });
  });

  it("第 6 个落在右边新开的一列：顶与第一排子会话对齐，x 紧挨在第一排右缘（892）之外一道列间空隙（32）", () => {
    // 旧行为（LAYOUT4 · W7 之前）是第 8 个、x=1324：右边先空出下一层那一列（340）再加空隙（92），留给孙会话的巷。
    const steps = arrive(family(6), DESK);
    expect(steps.findIndex((layout) => columnsIn(layout).length > 2) + 1, "第三列（子会话的第二列）第一次出现时已到达的会话数：根加 6 个子会话").toBe(7);
    const six = steps.at(-1)!;
    expect(spot(six, agent("k6"))).toEqual({ x: 924, y: 0 });
    expect(924 - (644 + 248)).toBe(32);
    expect(shapeOf(six)).toEqual([1, 5, 1]);
  });

  it("越往右的列越长，再满了另起第三、第四列，x 间距始终是一个列距（280）", () => {
    const shapes = [14, 15, 20, 30].map((n) => shapeOf(arrive(family(n), DESK).at(-1)!));
    expect(shapes).toEqual([
      [1, 5, 7, 2],
      [1, 5, 7, 3],
      [1, 5, 7, 8],
      [1, 5, 7, 8, 9, 1],
    ]);
    const last = arrive(family(30), DESK).at(-1)!;
    expect(columnsIn(last).map((c) => c.x)).toEqual([304, 644, 924, 1204, 1484, 1764]);
    for (const column of columnsIn(last).slice(1)) expect(column.cards[0]!.y, `x=${column.x} 的顶`).toBe(0);
  });

  it("不给取景区域（改动前的调用）：子会话一直往下接，一列到底", () => {
    const last = arrive(family(30), DESK, "none").at(-1)!;
    expect(shapeOf(last)).toEqual([1, 30]);
  });

  it("竖屏（720×1000）里很高才另起：11 个仍是一列，12 个起才分成两列", () => {
    const portrait = optionsOf(WINDOWS[3]!.area);
    expect(shapeOf(arrive(family(11), portrait).at(-1)!)).toEqual([1, 11]);
    expect(shapeOf(arrive(family(12), portrait).at(-1)!)).toEqual([1, 11, 1]);
    expect(shapeOf(arrive(family(20), portrait).at(-1)!)).toEqual([1, 11, 9]);
  });
});

describe("子会话另起了列之后，更深的后代与别的会话怎么落", () => {
  it("第一排子会话的孙会话：它右边紧挨着就是第二列，沿这一列往下让到第一个空格；右边有空格的（第二排）落在自己右边", () => {
    // 旧行为（LAYOUT4 · W7 之前）两列子会话之间留着一整列的巷，孙会话落在它上级的右边（924, 0）；现在两列只隔一道 32 的空隙，没有巷了，
    // 代价是孙会话离上级远：g1、g2 要一直让到第二列最下面一张（k12，下缘 928）之下。
    const all = [...family(14), grand("g1", "k1", 100), grand("g2", "k1", 101), grand("g3", "k8", 102)];
    const steps = arrive(all, DESK);
    const last = steps.at(-1)!;
    expect(spot(last, agent("g1"))).toEqual({ x: 924, y: 952 });
    expect(spot(last, agent("g2"))).toEqual({ x: 924, y: 1088 });
    expect(spot(last, agent("g3"))).toEqual({ x: 1204, y: 272 });
    expect(spot(last, agent("k8"))).toEqual({ x: 924, y: 272 });
    expect(overlapsOf(last)).toEqual([]);
    expectNoneMoved(steps);
  });

  it("多列紧挨着时：孙会话落在自己右边的空格，没有空格就沿右边那一列往下让到第一个空格，不压别的列", () => {
    const all = [...family(20), grand("g1", "k1", 100), grand("g2", "k8", 101), grand("g3", "k15", 102)];
    const steps = arrive(all, DESK);
    const last = steps.at(-1)!;
    expect(spot(last, agent("g1"))).toEqual({ x: 924, y: 952 });
    expect(spot(last, agent("g2"))).toEqual({ x: 1204, y: 1088 });
    expect(spot(last, agent("g3"))).toEqual({ x: 1484, y: 272 });
    expect(shapeOf(last)).toEqual([1, 5, 8, 9, 1]);
    expect(overlapsOf(last)).toEqual([]);
    expectNoneMoved(steps);
  });

  it("孙会话已经占了一块地方：之后另起的子会话列在它们的右边（整块外框都算），不压进去", () => {
    // k1、k2 各带一个孙会话（x=924）；再来 8 个子会话：第一排长到 7 个，第 8 个起另起一列，x=1204 在孙会话的右缘（1172）之外一道空隙（32）。
    const all = [
      ...family(5),
      grand("g1", "k1", 100),
      grand("g2", "k2", 101),
      ...Array.from({ length: 8 }, (_, i) => grand(`m${i + 1}`, "r1", 200 + i)),
    ];
    const steps = arrive(all, DESK);
    const last = steps.at(-1)!;
    expect(spot(last, agent("g1"))).toEqual({ x: 924, y: 0 });
    expect(spot(last, agent("m2"))).toEqual({ x: 644, y: 816 });
    expect(spot(last, agent("m3"))).toEqual({ x: 1204, y: 0 });
    expect(shapeOf(last)).toEqual([1, 7, 2, 6]);
    expect(1204 - (924 + 248), "新列与孙会话之间的空隙").toBeGreaterThanOrEqual(32);
    expectNoneMoved(steps);
  });

  it("两个根各带子会话，再来一批根会话：新的根会话列在所有家族的右边，顶与第一列对齐，已有的卡一张不动", () => {
    const all = [
      session("r1", KEY, 1),
      session("r2", KEY, 2),
      ...Array.from({ length: 8 }, (_, i) => grand(`a${i + 1}`, "r1", 10 + i)),
      ...Array.from({ length: 4 }, (_, i) => grand(`b${i + 1}`, "r2", 30 + i)),
      ...roots(KEY, 8, 100, "t"),
    ];
    const steps = arrive(all, DESK);
    const last = steps.at(-1)!;
    const families = agentsOf(last).filter((n) => !n.id.startsWith("agent:t"));
    const right = Math.max(...families.map((n) => n.x + n.w));
    // 两家的整块区域里没有空格可填：新的根会话直接另起一列（LAYOUT6），第一张就在列顶；
    // 旧的“一列满了才另起”先把 t1 接在整块的最下面一格（304, 1088），t2 才是新列的第一张。
    expect(spot(last, agent("t1"))).toEqual({ x: right + 32, y: 0 });
    expect(spot(last, agent("t2"))).toEqual({ x: right + 32, y: 136 });
    expect(spot(last, agent("a8"))).toEqual({ x: 924, y: 272 });
    expect(overlapsOf(last)).toEqual([]);
    expectNoneMoved(steps);
  });
});

describe("根会话已经另起了列之后，各列根会话的子会话落在哪里（W6b 与 W6 相邻时）", () => {
  it("两列根会话（5 + 5）：第二列根的子会话落在它右边的空格里；第一列根的子会话右边就是第二列，只好接在第二列最下面一张之下；孙会话在上级右边，不挪任何卡", () => {
    // 两列根会话只隔一道 32 的空隙，第一列根（x=304）的右边就是第二列（x=584）。旧行为（LAYOUT4 · W7 之前）两列相隔两个列距，中间那一列专给子会话。
    const all = [...roots(KEY, 10), grand("a1", "r1", 100), grand("a8", "r8", 101), grand("g1", "a1", 102), grand("a2", "r1", 103)];
    const steps = arrive(all, DESK);
    expect(shapeOf(steps[9]!), "前提：10 个根会话已经是两列").toEqual([5, 5]);
    const last = steps.at(-1)!;
    expect(spot(last, agent("a1")), "r1 的子会话：落在第二列最下面一张（r10，下缘 656）之下").toEqual({ x: 584, y: 680 });
    expect(spot(last, agent("a2")), "r1 的第二个子会话接在 a1 下面").toEqual({ x: 584, y: 816 });
    // 旧：r8 在 (584, 272)（第二列第三行），子会话在 (864, 272)；现在两列交替往下填（LAYOUT8），r8 是第二列第四行 (584, 408)，子会话仍紧贴在它右边。
    expect(spot(last, agent("r8")), "前提：r8 在第二列第四行").toEqual({ x: 584, y: 408 });
    expect(spot(last, agent("a8")), "r8（第二列第四行）的子会话在它右边").toEqual({ x: 864, y: 408 });
    expect(spot(last, agent("g1")), "孙会话在 a1 的右边").toEqual({ x: 864, y: 680 });
    expect(columnsIn(last).map((c) => `${c.x}:${c.cards.length}`)).toEqual(["304:5", "584:7", "864:2"]);
    expect(overlapsOf(last)).toEqual([]);
    expectNoneMoved(steps);
  });

  it("三列根会话（5 + 5 + 5）：右边是别的根会话列的子会话，沿那一列往下让到最下面一张之下；别家外框里空着的格子也挡；不挪任何一张", () => {
    const all = [...roots(KEY, 15), grand("a8", "r8", 100), grand("g1", "a8", 101), grand("b1", "r1", 102), grand("h1", "b1", 103)];
    const steps = arrive(all, DESK);
    expect(columnsIn(steps[14]!).map((c) => `${c.x}:${c.cards.length}`), "前提：15 个根会话是三列").toEqual(["304:5", "584:5", "864:5"]);
    const last = steps.at(-1)!;
    expect(spot(last, agent("a8")), "r8 的子会话：右边是第三列，落在第三列最下面一张（下缘 656）之下").toEqual({ x: 864, y: 680 });
    expect(spot(last, agent("g1")), "a8 的孙会话在它右边").toEqual({ x: 1144, y: 680 });
    // b1 的理想位置是第二列最下面一张之下的 (584, 680)，那一格在 r8 一家的外框里（r8 在 (584, 272)、a8 在 (864, 680)）：别家外框里空着的格子也挡，落在外框之下。
    expect(spot(last, agent("b1"))).toEqual({ x: 584, y: 816 });
    expect(spot(last, agent("h1")), "b1 的子会话在它右边").toEqual({ x: 864, y: 816 });
    expect(overlapsOf(last)).toEqual([]);
    expectNoneMoved(steps);
  });

  it("别家的整块区域里的空格也挡新列：真实画布 7295d4f1 里 #37 的第 7 个子会话（#44）不落进邻家家族（#28 与它的孩子 #36 之间）空着的那一格，开到所有卡的右边", () => {
    // 不挡的话，#37 的子会话第二列（x=560）满了、紧挨着的 (840, 952) 没有任何卡，会在那里另起一列——可那一格在 #28 的外框里（#28 在 (840, 816)、#36 在 (1120, 952)）。
    const all = realSessions(REAL_CANVASES.find((entry) => entry.name === "7295d4f1")!).slice(0, 45);
    const steps = arrive(all, DESK, undefined, 36);
    const last = steps.at(-1)!;
    expect(spot(last, agent("7295d4f1-28")), "前提：邻家家族的根").toEqual({ x: 840, y: 816 });
    expect(spot(last, agent("7295d4f1-36")), "前提：邻家家族的孩子（在根的右下方，根的正右边是空格）").toEqual({ x: 1120, y: 952 });
    expect(spot(last, agent("7295d4f1-38")), "前提：#37 的第一个子会话").toEqual({ x: 280, y: 952 });
    expect(spot(last, agent("7295d4f1-41")), "第 4 个子会话开第二列，紧挨着第一列").toEqual({ x: 560, y: 952 });
    expect(spot(last, agent("7295d4f1-43")), "第二列装满 3 张").toEqual({ x: 560, y: 1224 });
    expect(spot(last, agent("7295d4f1-44")), "第 7 个子会话：紧挨着的位置在邻家的外框里，开到所有卡的右边（顶与第一列对齐）").toEqual({ x: 1680, y: 952 });
    expect(overlapsOf(last)).toEqual([]);
    expectNoneMoved(steps);
  });
});
