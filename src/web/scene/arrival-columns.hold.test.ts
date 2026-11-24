import { describe, expect, it } from "vitest";
import { agentsOf, arrive, columnsIn, firstSecondColumn, optionsOf, shapeOf, WINDOWS } from "./arrival.columns.fixtures";
import { agent, moved, roots, spot } from "./arrival.fixtures";
import { fitScale, layoutScene, MIN_ZOOM } from "./layout";
import { overlapsOf } from "./layout.fixtures";

/**
 * 页面开着、根会话一个个到达时：先填外框里的空格，没有空格再向“让整体看得最全”的方向长一行或一列（LAYOUT6，规则见 arrival-grow.ts；
 * 之前是 LAYOUT3 · W6 的“竖排的一列满了就在右边另起一列”，那条判据现在只留给家族里的子会话）——经过持有逻辑与取景区域的整条路（`HeldLayout.apply`），
 * 不是单看纯几何（规则的纯几何在 arrival-grow.test.ts）。每一步都满足：已有的卡一像素不动、只多了新来的那一张、没有重叠。
 * 哪个窗口里第一列装几个、各列长多高，都是规则当前取值的快照：改规则要连同它们一起重新审视，不是“数字变了就改数字”。
 */

const KEY = "cursor:a";
const DESK = WINDOWS[0]!.area;

/**
 * 每个窗口里第一个落到第二列的根会话是第几个到达的（= 第一列装得下的个数加一）：1440×900、1920×1080、1280×720、竖屏、窄区域。
 * 桌面窗口（宽过高）里前几个到达时两种长法一样全，持平时看形状（LAYOUT8）：长出来的块更像取景区域的那一边，第 3 个就另起第二列；
 * 竖屏与窄区域里长一行本来就更像取景区域，仍往下接得更久。旧值（LAYOUT6，持平一律长一行）是 [6, 7, 5, 9, 6]，更早（LAYOUT3）是 [7, 7, 6, 13, 10]。
 */
const FIRST_OVERFLOW = [3, 3, 3, 9, 6] as const;

/** 同一份“1 → 60 个根会话逐个到达”只算一次：每个窗口一份，几个用例共用。 */
const runs = new Map<string, ReturnType<typeof arrive>>();
const runOf = (name: string): ReturnType<typeof arrive> => {
  const found = runs.get(name);
  if (found) return found;
  const spec = WINDOWS.find((w) => w.name === name)!;
  const made = arrive(roots(KEY, 60), optionsOf(spec.area));
  runs.set(name, made);
  return made;
};

describe.each(WINDOWS.map((w) => w.name))("根会话从 1 个起逐个到达 60 个：%s", (name) => {
  it("每一步：已有的卡位置不变，只多了新来的那一张，没有重叠", () => {
    const steps = runOf(name);
    steps.forEach((layout, i) => {
      expect(agentsOf(layout), `第 ${i + 1} 步的会话卡数`).toHaveLength(i + 1);
      expect(overlapsOf(layout), `第 ${i + 1} 步有卡压在一起`).toEqual([]);
      const before = steps[i - 1];
      if (!before) return;
      expect(moved(before, layout), `第 ${i + 1} 个到达时挪动了已有的卡`).toEqual([]);
      expect(layout.nodes.length - before.nodes.length, `第 ${i + 1} 步多出的节点数`).toBe(1);
    });
  });

  it("每一列的顶都与第一列的顶对齐，坐标都是有限数", () => {
    const last = runOf(name).at(-1)!;
    const columns = columnsIn(last);
    const top = columns[0]!.cards[0]!.y;
    for (const column of columns) expect(column.cards[0]!.y, `x=${column.x} 那一列的顶`).toBe(top);
    for (const n of last.nodes) expect([n.x, n.y, n.w, n.h].every(Number.isFinite), n.id).toBe(true);
  });

  it("每一列里的卡一张接着一张往下排，行距处处相同（没有空洞，各列之间也一样）", () => {
    const pitches = new Set<number>();
    for (const column of columnsIn(runOf(name).at(-1)!)) {
      column.cards.forEach((card, i) => {
        if (i > 0) pitches.add(card.y - column.cards[i - 1]!.y);
      });
    }
    expect([...pitches], "整个排布里只有一种行距").toHaveLength(1);
  });
});

describe("第一列装多少个才另起一列", () => {
  it("各个窗口里第二列从第几个起是当前规则的快照：桌面窗口持平时按形状长、第 3 个就另起；竖屏与窄区域仍往下接得更久", () => {
    const first = WINDOWS.map(({ area }) => firstSecondColumn(arrive(roots(KEY, 20), optionsOf(area))));
    expect(first).toEqual([...FIRST_OVERFLOW]);
  });

  it("不给取景区域（改动前的调用）：一直往下接，60 个就是一整列", () => {
    for (const { area } of WINDOWS) {
      const last = arrive(roots(KEY, 60), optionsOf(area), "none").at(-1)!;
      expect(shapeOf(last)).toEqual([60]);
    }
  });
});

describe("新列落在哪里（1440×900，取景区域 1088×710）", () => {
  const steps = arrive(roots(KEY, 20), optionsOf(DESK));

  it("第 3 个根会话落在新列的顶：x 紧挨在第一列右缘（552）之外一道列间空隙（32），y 与第一个根会话对齐", () => {
    // 旧行为（LAYOUT4 · W7 之前）是第 7 个、x=984：右边先空出一整列（340）留给子会话，再加一道空隙（92）——每两列根会话之间白白隔一列。
    // LAYOUT6 里它是第 6 个（前 5 个竖成一列）；现在前两个排成一列之后两种长法一样全，长出来的块（宽 808、高 248）比再长一行的块（528 × 384）更像 1088 × 710，另起一列。
    const three = steps[2]!;
    expect(spot(three, agent("r1"))).toEqual({ x: 304, y: 0 });
    expect(spot(three, agent("r2"))).toEqual({ x: 304, y: 136 });
    expect(spot(three, agent("r3"))).toEqual({ x: 584, y: 0 });
    expect(584 - (304 + 248), "第一列右缘到新列左缘：只隔一道列间空隙").toBe(32);
  });

  it("新列里后来的根会话接在它下面（外框里的第一个空格），不去第一列长新的一行；两列都满了才在最左一格起新的一行", () => {
    // 旧：第 7、8 个接在新列的下面 (584,136)、(584,272)，那时第一列已经有 5 张、新列只有 1 张——旧规则里根本没有“两列都满”的时刻要选行还是列。
    expect(spot(steps[3]!, agent("r4"))).toEqual({ x: 584, y: 136 });
    expect(shapeOf(steps[3]!), "两列各 2 张").toEqual([2, 2]);
    expect(spot(steps[4]!, agent("r5")), "两列都满了：新的一行从最左一格起").toEqual({ x: 304, y: 272 });
    expect(spot(steps[5]!, agent("r6")), "第二列的第三格").toEqual({ x: 584, y: 272 });
  });

  it("先填空格再长：前面的列先装满、列高最多差 1（正在长的那一列除外）；第 11 个另起第三列，第 16 个长第六行，第 19 个另起第四列；x 间距始终是一个列距（280）", () => {
    // 旧的判据是“后开的列不比前面的短（越往右越划算）”：[5, 5, 1] → [5, 5, 6] → [5, 5, 6, 4]，第 17 个才另起第四列，
    // 前面几列的下半截一直空着，外框里一半是空格。现在每一步外框里的空格都是 0 或刚开出来的那一行 / 一列里还没轮到的格子。
    expect(shapeOf(steps[10]!), "11 个").toEqual([5, 5, 1]);
    expect(shapeOf(steps[14]!), "15 个").toEqual([5, 5, 5]);
    expect(shapeOf(steps[15]!), "16 个").toEqual([6, 5, 5]);
    expect(shapeOf(steps[17]!), "18 个").toEqual([6, 6, 6]);
    expect(shapeOf(steps[18]!), "19 个").toEqual([6, 6, 6, 1]);
    expect(shapeOf(steps[19]!), "20 个").toEqual([6, 6, 6, 2]);
    expect(columnsIn(steps[19]!).map((c) => c.x)).toEqual([304, 584, 864, 1144]);
    expect(spot(steps[10]!, agent("r11"))).toEqual({ x: 864, y: 0 });
    expect(spot(steps[15]!, agent("r16")), "长一行：新的一行从最左一格起").toEqual({ x: 304, y: 680 });
    expect(spot(steps[18]!, agent("r19"))).toEqual({ x: 1144, y: 0 });
  });

  it("前几个的形状：2 × 2 再长第三行，不再是一条竖到底（第 4 个起至少两列，两列的张数最多差 1）", () => {
    // 旧：前 5 个竖成一列（[5]），第 6 个才另起一列，之后是 [5, 1]、[5, 2]……。
    expect(steps.slice(0, 10).map(shapeOf)).toEqual([[1], [2], [2, 1], [2, 2], [3, 2], [3, 3], [4, 3], [4, 4], [5, 4], [5, 5]]);
    for (const layout of steps.slice(3, 10)) expect(shapeOf(layout).length, "第 4 个起至少两列").toBeGreaterThanOrEqual(2);
  });
});

describe("窄区域（紧凑模式，来源卡在上、根会话在下）", () => {
  const compact = WINDOWS[4]!.area;
  const steps = arrive(roots(KEY, 20), optionsOf(compact));

  it("第 6 个起另起一列：顶与第一个根会话对齐，之后的根会话接在这一列的下面；两列装满之后新的一行从最左起，两列并排往下长", () => {
    const first = spot(steps[0]!, agent("r1"));
    expect(spot(steps[5]!, agent("r6"))).toEqual({ x: 232, y: first.y });
    expect(spot(steps[6]!, agent("r7"))).toEqual({ x: 232, y: first.y + 128 });
    expect(spot(steps[7]!, agent("r8"))).toEqual({ x: 232, y: first.y + 256 });
    // 旧：[5, 9, 2]（第二列一路长到 9 张、第三列才开）；现在第三列比并排长两行更难看全（窄区域只有 288 宽），两列各 8 张。
    expect(shapeOf(steps[15]!), "16 个").toEqual([8, 8]);
    expect(spot(steps[10]!, agent("r11")), "两列各 5 张之后：长一行，从最左一格起").toEqual({ x: 0, y: first.y + 5 * 128 });
    expect(spot(steps[11]!, agent("r12"))).toEqual({ x: 232, y: first.y + 5 * 128 });
  });

  it("列距是一格（一格的宽加间隙，格点的节距）：不再为子会话空出一整列", () => {
    const columns = columnsIn(arrive(roots(KEY, 40), optionsOf(compact)).at(-1)!);
    expect(columns.length).toBeGreaterThanOrEqual(3);
    columns.forEach((column, i) => {
      if (i > 0) expect(column.x - columns[i - 1]!.x, `第 ${i + 1} 列`).toBe(232);
    });
  });
});

describe("取景的标记与缩放语义不变（相机怎么取景是引擎的事，这里只看持有的布局给它的标记）", () => {
  it("经典的树另起了列之后仍是“非格点、非全部入画”，缩放由宽度定、不低于可读下限 30%；紧凑的格点排布仍是格点", () => {
    const desk = arrive(roots(KEY, 20), optionsOf(DESK)).at(-1)!;
    expect(shapeOf(desk), "前提：另起了列（旧：[5, 5, 6, 4]）").toEqual([6, 6, 6, 2]);
    expect(desk.grid).toBeUndefined();
    expect(desk.fitAll).toBeUndefined();
    const zoom = fitScale(desk.bounds, DESK, MIN_ZOOM, desk.grid === true || desk.fitAll === true);
    expect(zoom).toBeCloseTo(DESK.w / desk.bounds.w, 10);
    expect(zoom).toBeGreaterThanOrEqual(MIN_ZOOM);

    const compact = arrive(roots(KEY, 20), optionsOf(WINDOWS[4]!.area)).at(-1)!;
    expect(compact.grid).toBe(true);
  });
});

describe("取景区域很宽、只够几行高：持平时先横着长，高度只够 3 行——第四行会缩小整体、另起一列不花高度，所以每列最多 3 张", () => {
  // 按 1440×900 规划（经典的树），持有时给一个 6000×400 的取景区域（宽高比 15）：三行（高 384）正好放得下，第四行就超出高度、整体缩小；
  // 另起一列不花高度、宽度远没到 6000。旧的判据 G 在 6000×200 的区域里靠“每列至少 3 张”的下限才没有变成一列一张；
  // LAYOUT6 里这个形状是比例比较的结果（高度只够 3 行，每列装 3 张，第 4 个才开第二列）；LAYOUT8 起前几个到达时两种长法一样全，
  // 按形状长：一排最像 15，横着长到 9 个（宽高比 22.6），第 10 个起第二排（再往右一格是 25，离 15 比第二排的 10.2 更远）；高度的限制仍在，第四行始终不开。
  const short = arrive(roots(KEY, 60), optionsOf(DESK), { w: 6000, h: 400 });

  it("先横着长：第 2 个就另起第二列，前 9 个排成一排，第 10 个起第二排从最左一格起", () => {
    expect(firstSecondColumn(short)).toBe(2);
    expect(shapeOf(short[8]!)).toEqual(Array.from({ length: 9 }, () => 1));
    expect(spot(short[9]!, agent("r10"))).toEqual({ x: 304, y: 136 });
  });

  it("高度只够 3 行：第四行看不全、另起一列不花高度——60 个排成 20 列、每列恰好 3 张，没有第四行", () => {
    const last = short[59]!;
    expect(shapeOf(last)).toEqual(Array.from({ length: 20 }, () => 3));
    expect(columnsIn(last).map((c) => c.x)).toEqual(Array.from({ length: 20 }, (_, i) => 304 + i * 280));
    expect(new Set(agentsOf(last).map((n) => n.y)).size, "只有三行").toBe(3);
  });

  it("高度连一行半都不到（6000×200）：没有下限，一排横到底——每多接一行都更难看全，另起一列不花高度", () => {
    // 旧：第 4 个才开第二列、每列 3 张（判据 G 的下限）。LAYOUT6 里根会话不再用那个下限（子会话那一支仍用）。
    const flat = arrive(roots(KEY, 16), optionsOf(DESK), { w: 6000, h: 200 });
    expect(firstSecondColumn(flat)).toBe(2);
    expect(shapeOf(flat[15]!)).toEqual(Array.from({ length: 16 }, () => 1));
    expect(new Set(agentsOf(flat[15]!).map((n) => n.y)).size, "都在第一排").toBe(1);
  });

  it("不挪已有的卡、不重叠", () => {
    short.forEach((layout, i) => {
      const before = short[i - 1];
      if (before) expect(moved(before, layout), `第 ${i + 1} 步`).toEqual([]);
      expect(overlapsOf(layout), `第 ${i + 1} 步`).toEqual([]);
    });
  });
});

describe("规划只是在下面多了一张新卡时（规划平移给的位置空着、合法），这一列满了也照样另起", () => {
  // 真实用法里规划与持有用同一份取景区域，规划会在“满”之前就把紧凑格点改排成两列、已有的卡被重排，平移这条路用不上；
  // 这里把规划的区域拉得很高，规划便一直是一列的紧凑格点：每一步只多出一张在最下面的新卡、其余原封不动，平移给的落点既空着又合法。
  // 持有的区域仍是窄区域，第 6 个到达时这一列已满——另起一列的判据得赢过规划的落点。去掉这条让位，第 6 个会落在第一列的最下面（0, 768）。
  const compact = WINDOWS[4]!.area;
  const tall = { w: compact.w, h: 3000 };
  const plans = Array.from({ length: 16 }, (_, i) => layoutScene(roots(KEY, i + 1), optionsOf(tall)));
  const plain = arrive(roots(KEY, 16), optionsOf(compact));
  const stretched = arrive(roots(KEY, 16), optionsOf(tall), compact);
  const pointsOf = (layout: (typeof plain)[number]): string[] => layout.nodes.map((n) => `${n.id}@${n.x},${n.y}`);

  it("前提：规划每一步都只是在最下面多了一张、一列的格点", () => {
    plans.forEach((plan, i) => {
      expect(plan.grid, `第 ${i + 1} 步规划是格点`).toBe(true);
      expect(shapeOf(plan), `第 ${i + 1} 步规划的列`).toEqual([i + 1]);
      const before = plans[i - 1];
      if (before) expect(moved(before, plan), `第 ${i + 1} 步规划没有重排已有的卡`).toEqual([]);
    });
  });

  it("第 6 个起另起一列，每一步的落点与规划和持有用同一份窄区域时完全一样", () => {
    const first = spot(stretched[0]!, agent("r1"));
    expect(spot(stretched[4]!, agent("r5")), "第 5 个还接在下面").toEqual({ x: first.x, y: first.y + 4 * 128 });
    expect(spot(stretched[5]!, agent("r6"))).toEqual({ x: 232, y: first.y });
    expect(shapeOf(stretched[15]!), "旧：[5, 9, 2]").toEqual([8, 8]);
    stretched.forEach((layout, i) => expect(pointsOf(layout), `第 ${i + 1} 步`).toEqual(pointsOf(plain[i]!)));
  });

  it("每一步已有的卡不动、没有重叠", () => {
    stretched.forEach((layout, i) => {
      const before = stretched[i - 1];
      if (before) expect(moved(before, layout), `第 ${i + 1} 步`).toEqual([]);
      expect(overlapsOf(layout), `第 ${i + 1} 步`).toEqual([]);
    });
  });
});
