import { describe, expect, it } from "vitest";
import { holdLayout, memoryOf } from "./arrival-hold";
import { arrive, optionsOf, shapeOf, WINDOWS } from "./arrival.columns.fixtures";
import { agent, join, kidsOf, moved, roots, spot } from "./arrival.fixtures";
import { layoutScene, type Area } from "./layout";
import { node, overlapsOf, session } from "./layout.fixtures";

/**
 * `holdLayout` 里两条规则的直接测试（LAYOUT4 · W11 的 N5 与 N7），不经 `HeldLayout`、不经逐个到达的夹具：
 *  N5：汇聚会话（有多个上级）不归 `columnOf`——它有自己的横向下限，逐个到达时不会触发“竖排满了另起一列”；
 *  N7：规则 ①（规划自己给的落点）在“这一列已满”时让位给逐张落位。
 */

const KEY = "cursor:a";
const DESK = optionsOf(WINDOWS[0]!.area);

describe("N5：汇聚会话不触发“竖排满了另起一列”", () => {
  // 两个根，r1 名下竖着 8 个子会话（1440×900 里排成 [2, 4, 5]：最右一列已满，再来一个普通子会话就要在右边另起一列），r2 是另一个根。
  const base = [...roots(KEY, 2), ...kidsOf(KEY, "r1", 8, 100)];
  const parents = ["r1", "r2"];

  it("前提：来的是第 9 个普通子会话时，这一列满了，它落在右边新开的一列、顶与这家人的第一排对齐", () => {
    const steps = arrive([...base, session("kx", KEY, 900, { parentSessionId: "r1" })], DESK, undefined, base.length);
    expect(shapeOf(steps[0]!)).toEqual([2, 4, 4]);
    const last = steps.at(-1)!;
    expect(spot(last, agent("kx"))).toEqual({ x: 840, y: 136 });
    expect(shapeOf(last)).toEqual([2, 4, 4, 1]);
  });

  it("来的是汇聚会话（r1 与 r2 两个上级，规划把它接在 k8 的下面）：不触发新列，落在 (560, 680)——不是普通子会话会去的 (840, 136)", () => {
    const joined = join("C", KEY, 900, parents);
    const plan = layoutScene([...base, joined], DESK);
    expect(node(plan, agent("C")).anchor, "前提：规划把 C 接在 k8 的下面（它的锚点是竖排的最后一张）").toMatchObject({ id: agent("k8"), dx: 0, dy: 136 });
    const [before, after] = arrive([...base, joined], DESK, undefined, base.length) as [ReturnType<typeof layoutScene>, ReturnType<typeof layoutScene>];
    expect(moved(before, after)).toEqual([]);
    expect(overlapsOf(after)).toEqual([]);
    const placed = spot(after, agent("C"));
    expect(placed, "不是普通子会话会去的新列").not.toEqual({ x: 840, y: 136 });
    for (const id of parents) expect(placed.x, `在 ${id} 的右边`).toBeGreaterThan(spot(after, agent(id)).x + node(after, agent(id)).w);
    expect(placed).toEqual({ x: 560, y: 680 });
    expect(shapeOf(after), "没有多出一列").toEqual([2, 4, 5]);
  });

  it("汇聚会话一个个地来（C1 再 C2）：每个都按自己的下限落位，已有的卡不动、不重叠，也不另起列", () => {
    const sessions = [...base, join("C1", KEY, 900, parents), join("C2", KEY, 901, parents)];
    const steps = arrive(sessions, DESK, undefined, base.length);
    steps.forEach((layout, i) => {
      const before = steps[i - 1];
      if (before) expect(moved(before, layout), `第 ${i} 步`).toEqual([]);
      expect(overlapsOf(layout), `第 ${i} 步`).toEqual([]);
    });
    const last = steps.at(-1)!;
    for (const id of ["C1", "C2"]) for (const parent of parents) expect(spot(last, agent(id)).x, `${id} 在 ${parent} 的右边`).toBeGreaterThan(spot(last, agent(parent)).x + node(last, agent(parent)).w);
    expect(shapeOf(last).length, "列数与 C 到达之前一样").toBe(shapeOf(steps[0]!).length);
  });
});

describe("N7：规则 ① 在这一列已满时让位", () => {
  // 规划用的区域很高，一直是一列的紧凑格点：每一步只在最下面多一张、已有的卡原封不动，规划给的落点既空着又合法；
  // 持有的区域是窄区域，第 6 个到达时这一列已满——另起一列的判据得赢过规划的落点。
  const compact = WINDOWS[4]!.area;
  const tall: Area = { w: compact.w, h: 3000 };
  const five = layoutScene(roots(KEY, 5), optionsOf(tall));
  const known = new Set(five.nodes.map((n) => n.id));
  const hold = (count: number, area?: Area) => holdLayout(layoutScene(roots(KEY, count), optionsOf(tall)), memoryOf(five), (id) => known.has(id), area);
  const first = spot(five, agent("r1"));

  it("前提：规划只在最下面多了 r6（一列格点），已有的卡没动；r6 的落点就是这一列的下一格", () => {
    const plan = layoutScene(roots(KEY, 6), optionsOf(tall));
    expect(plan.grid).toBe(true);
    expect(shapeOf(plan)).toEqual([6]);
    expect(moved(five, plan)).toEqual([]);
    expect(spot(plan, agent("r6"))).toEqual({ x: first.x, y: first.y + 5 * 128 });
  });

  it("不给取景区域，或给的区域够高（这一列没满）：用规划给的落点——持有的结果就是规划本身", () => {
    const plan = layoutScene(roots(KEY, 6), optionsOf(tall));
    expect(hold(6).layout).toEqual(plan);
    expect(hold(6, tall).layout).toEqual(plan);
    expect(hold(6, tall).added).toEqual([agent("r6")]);
  });

  it("给的是窄区域（这一列已满）：不用规划的落点，落在右边新开的一列、顶与第一排对齐", () => {
    const held = hold(6, compact);
    expect(held.mode).toBe("hold");
    expect(held.added).toEqual([agent("r6")]);
    expect(moved(five, held.layout)).toEqual([]);
    expect(spot(held.layout, agent("r6"))).toEqual({ x: first.x + 232, y: first.y });
    expect(spot(held.layout, agent("r6")), "不是规划的落点").not.toEqual({ x: first.x, y: first.y + 5 * 128 });
    expect(shapeOf(held.layout)).toEqual([5, 1]);
    expect(overlapsOf(held.layout)).toEqual([]);
  });

  it("一次来了两张（r6、r7）：第一张让位之后，两张都逐张落位——r7 接在 r6 的下面，不再用规划的落点", () => {
    const held = hold(7, compact);
    expect(held.added).toEqual([agent("r6"), agent("r7")]);
    expect(spot(held.layout, agent("r6"))).toEqual({ x: first.x + 232, y: first.y });
    expect(spot(held.layout, agent("r7"))).toEqual({ x: first.x + 232, y: first.y + 128 });
    expect(shapeOf(held.layout)).toEqual([5, 2]);
  });
});
