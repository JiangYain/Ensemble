import { describe, expect, it } from "vitest";
import { holdLayout, memoryOf } from "./arrival-hold";
import { HeldLayout } from "./arrival-memory";
import { holder, optionsOf, WINDOWS } from "./arrival.columns.fixtures";
import { agent, moved, roots, spot } from "./arrival.fixtures";
import { layoutScene, type Area, type LayoutOptions } from "./layout";
import { overlapsOf } from "./layout.fixtures";

/**
 * 根会话到达规则接进持有逻辑的那几处（LAYOUT6）：规则本身的取舍在 arrival-grow.test.ts，每一步的形状在 arrival-grow.oracle.test.ts，
 * 这里只看接线——什么时候规划的位置胜出、什么时候规则胜出、经典排布的错开是否保持、一步来两张是否等于一张张来。
 */

const KEY = "cursor:a";
const DESK = WINDOWS[0]!;

describe("规划的位置与规则的位置谁胜出", () => {
  it("不给取景区域（改动前的调用）：新卡排在上一个根会话的正下方，规划怎么排不影响；给了取景区域、两种长法一样全时按形状长，不再排成一条竖到底", () => {
    const options = optionsOf(DESK.area);
    const all = roots(KEY, 6);
    const plain = holder(options, "none");
    const framed = holder(options);
    let without = plain.show(all.slice(0, 1));
    let withView = framed.show(all.slice(0, 1));
    for (let k = 2; k <= 6; k++) {
      without = plain.show(all.slice(0, k));
      withView = framed.show(all.slice(0, k));
    }
    const fifth = spot(without, agent("r5"));
    expect(spot(without, agent("r6")), "没有取景区域：r5 的正下方").toEqual({ x: fifth.x, y: fifth.y + 136 });
    // 1440×900（取景区域 1088 × 710，宽高比 1.53）：每一步两种长法都放得下，一样全，于是看长出来的块更像哪个形状——
    // r1、r2 排成一列，r3 起另起第二列（顶与第一排对齐），r4 填第二列的第二格，r5 在第一列长第三行，r6 填第二列的第三格：3 行 × 2 列。
    expect(spot(withView, agent("r6")), "带取景区域：第二列的第三格").toEqual({ x: 584, y: 272 });
    // 旧：r1~r5 在两条路里都没有动（旧规则持平一律长一行，两条路都是一列）；现在带取景区域的从 r3 起去了第二列，r1、r2 仍然一样。
    expect(moved(without, withView).sort(), "r1、r2 两条路一样，r3~r6 不一样").toEqual([agent("r3"), agent("r4"), agent("r5"), agent("r6")].sort());
  });

  it("规划没有挪已有的卡、新卡的位置与规则给的一样：持有的就是规划本身（同一个对象），不另造一份", () => {
    const options = optionsOf(DESK.area);
    const all = roots(KEY, 27);
    const held = new HeldLayout();
    const known = new Set<string>();
    const show = (k: number) => {
      const plan = layoutScene(all.slice(0, k), options);
      const out = held.apply(plan, (id) => known.has(id), DESK.area);
      for (const node of out.nodes) known.add(node.id);
      return { plan, out };
    };
    show(24);
    for (const k of [25, 26, 27]) {
      const { plan, out } = show(k);
      expect(out, `第 ${k} 个`).toBe(plan);
    }
  });

  it("规划没有挪任何已有的卡（来源卡也没动）、规划给的位置合法，但规则要的是另一格：让位给规则，持有的不是规划本身；不给取景区域就用规划的位置", () => {
    // 规划用的区域很高：24 个根会话是 2 列 × 12 行（来源卡在上面），第 25 个只是在最下面另起一行——已有的卡原封不动，规划给的落点既空着又合法。
    const tall: Area = { w: DESK.area.w, h: 3000 };
    const base = layoutScene(roots(KEY, 24), optionsOf(tall));
    const known = new Set(base.nodes.map((n) => n.id));
    const plan = layoutScene(roots(KEY, 25), optionsOf(tall));
    expect(moved(base, plan), "前提：规划没有挪任何已有的卡，来源卡也没动").toEqual([]);
    expect(spot(plan, agent("r25")), "前提：规划把 r25 排在新一行的最左一格").toEqual({ x: 0, y: 1768 });

    // 1440×900 的取景区域里：再长一行（2 列 × 13 行）缩到 38%，另起第三列（3 列 × 12 行）是 41%——规则要的是第三列的顶格。
    const held = holdLayout(plan, memoryOf(base), (id) => known.has(id), DESK.area);
    expect(held.mode).toBe("hold");
    expect(held.layout).not.toBe(plan);
    expect(spot(held.layout, agent("r25")), "让位给规则").toEqual({ x: 560, y: 136 });
    expect(moved(base, held.layout)).toEqual([]);
    expect(overlapsOf(held.layout)).toEqual([]);

    const plain = holdLayout(plan, memoryOf(base), (id) => known.has(id));
    expect(plain.layout, "不给取景区域：没有什么可比的，规划的位置照用——持有的就是规划本身").toBe(plan);
  });

  it("规划挪了来源卡（它跟着这一列居中）、持有的排布不信规划给的位置：规则照样决定落点，与给不给取景区域的规划无关", () => {
    // 规划用的区域很高、一直是一列：每多一张，规划把来源卡往下居中一点。持有的来源卡不跟着动，所以新卡的位置由规则（不是规划）定。
    const tall: Area = { w: DESK.area.w, h: 3000 };
    const five = layoutScene(roots(KEY, 5), optionsOf(tall));
    const known = new Set(five.nodes.map((n) => n.id));
    const plan = layoutScene(roots(KEY, 6), optionsOf(tall));
    const first = spot(five, agent("r1"));
    expect(moved(five, plan), "前提：规划只挪了来源卡").toEqual(["origin:cursor:a"]);
    expect(spot(plan, agent("r6")), "前提：规划把 r6 接在这一列的下面").toEqual({ x: first.x, y: first.y + 5 * 136 });

    const held = holdLayout(plan, memoryOf(five), (id) => known.has(id), DESK.area);
    expect(spot(held.layout, agent("r6")), "1440×900 里这一列再长一行就看不全，改去右边新开的一列").toEqual({ x: first.x + 280, y: first.y });
    expect(moved(five, held.layout), "持有的排布里来源卡也没动").toEqual([]);
    expect(overlapsOf(held.layout)).toEqual([]);
    const plain = holdLayout(plan, memoryOf(five), (id) => known.has(id));
    expect(spot(plain.layout, agent("r6")), "不给取景区域：接在这一列的下面").toEqual(spot(plan, agent("r6")));
  });
});

describe("经典排布（没有格点标记）也带着取景区域逐个到达", () => {
  const classic = (): LayoutOptions => ({ area: DESK.area, hideContextNodes: true });

  it("奇数行错开 24 的传统保持，第二列另起在这一块右缘之外一格（x = 608，不是 584），再往右一列同理", () => {
    const all = roots(KEY, 12);
    const { show } = holder(classic());
    const landed = all.map((_, i) => spot(show(all.slice(0, i + 1)), agent(`r${i + 1}`)));
    // 两种长法一样全时按形状长（LAYOUT8）：第 3 个起另起第二列，两列各排满 5 行（r10）之后才另起第三列（r11，x = 912）。
    // 错开的 24 是规划给新卡的横坐标（相对上一个根会话右移或左移 24），只有新卡与上一个根会话落在同一列才沿用（r2、r4、r12）；隔了一列的（r3、r5~r10）不沿用。
    expect(landed).toEqual([
      { x: 304, y: 0 },
      { x: 328, y: 136 },
      { x: 608, y: 0 },
      { x: 632, y: 136 },
      { x: 304, y: 272 },
      { x: 608, y: 272 },
      { x: 304, y: 408 },
      { x: 608, y: 408 },
      { x: 304, y: 544 },
      { x: 608, y: 544 },
      { x: 912, y: 0 },
      { x: 936, y: 136 },
    ]);
  });

  it("每一步已有的卡不动、不重叠，到第 40 个也一样", () => {
    const all = roots(KEY, 40);
    const { show } = holder(classic());
    let before = show(all.slice(0, 1));
    for (let k = 2; k <= 40; k++) {
      const after = show(all.slice(0, k));
      expect(moved(before, after), `第 ${k} 个`).toEqual([]);
      expect(overlapsOf(after), `第 ${k} 个`).toEqual([]);
      before = after;
    }
  });
});

describe("一步来了两张", () => {
  for (const { name, area } of WINDOWS.slice(0, 3)) {
    it(`${name}：已有 5 个、一次来 r6 与 r7，落点与一张张来的一样，已有的卡不动`, () => {
      const options = optionsOf(area);
      const all = roots(KEY, 7);
      const together = holder(options);
      const one = holder(options);
      for (let k = 1; k <= 5; k++) {
        together.show(all.slice(0, k));
        one.show(all.slice(0, k));
      }
      const before = together.show(all.slice(0, 5));
      const batch = together.show(all);
      one.show(all.slice(0, 6));
      const sequential = one.show(all);
      for (const id of ["r6", "r7"]) expect(spot(batch, agent(id)), id).toEqual(spot(sequential, agent(id)));
      expect(moved(before, batch)).toEqual([]);
      expect(overlapsOf(batch)).toEqual([]);
    });
  }
});
