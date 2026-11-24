import { describe, expect, it } from "vitest";
import { Board } from "./arrival-board";
import { memoryOf } from "./arrival-hold";
import { crowds, type Point } from "./arrival-slots";
import { arrive, optionsOf, WINDOWS } from "./arrival.columns.fixtures";
import { agent, moved, spot } from "./arrival.fixtures";
import type { SceneLayout } from "./layout";
import { NODE } from "./layout-geometry";
import { overlapsOf, session } from "./layout.fixtures";
import type { Rect } from "./placement";

/**
 * 无关的卡不夹进家族的子列（LAYOUT4 · W8）：混排到达。
 * 家族竖排的子列，下一个子会话该落的那一格（子列最后一张的下面一格）对新来的根会话算占着——“待用格”，每家最多一格、现状推出来、不记状态。
 * 实现与取舍见 arrival-board.ts 的 `holes` / `holesFor`：只拦根会话与不属于任何一家的卡，别家的子会话不拦（拦了交替到来的子会话会各自隔格空着）。
 * 场景（与 `.tmp\layout-work\l4-mixed.ts` 同一批）：6 个根 + 家 A（r1 的 3 个子）+ 家 B（r3 的 3 个子）一次载入，再逐个来新根、A 多 1 个子、B 多 2 个子。
 * 取景区域都是 1440×900 的 1088×710，除非另说明。坐标是现状的描述；断言的主体是“不占待用格、已有的卡不动、不重叠、待用格数不超过家族数”。
 */

const KEY = "cursor:a";
/** [会话 id, 上级 id]：没有上级的是根会话。数组顺序就是创建、到达的先后。 */
type Item = readonly [id: string, parent?: string];
const roots = (from: number, to: number): Item[] => Array.from({ length: to - from + 1 }, (_, i): Item => [`r${from + i}`]);
const kids = (prefix: string, parent: string, from: number, to: number): Item[] => Array.from({ length: to - from + 1 }, (_, i): Item => [`${prefix}${from + i}`, parent]);
const loaded = (rootCount: number): Item[] => [...roots(1, rootCount), ...kids("a", "r1", 1, 3), ...kids("b", "r3", 1, 3)];

const DESK = WINDOWS[0]!.area;
const WIDE = WINDOWS[1]!.area;
const COMPACT = WINDOWS[4]!.area;

const sessionsOf = (items: readonly Item[]) => items.map(([id, parent], i) => session(id, KEY, i + 1, parent ? { parentSessionId: parent } : {}));
const run = (items: readonly Item[], load: number, area = DESK): SceneLayout[] => arrive(sessionsOf(items), optionsOf(area), undefined, load);

const rectOf = (layout: SceneLayout, id: string): Rect => {
  const found = layout.nodes.find((n) => n.id === agent(id));
  if (!found) throw new Error(`missing ${id}`);
  return { x: found.x, y: found.y, w: found.w, h: found.h };
};

/** 把一份排布整个摆进 `Board`（与持有逻辑里的做法一致），读它此刻的待用格。 */
function holesOf(layout: SceneLayout): Rect[] {
  const first = layout.nodes.find((n) => n.kind === "agent");
  const board = new Board(layout, memoryOf(layout).parents, new Map(layout.nodes.map((n) => [n.id, n.kind])), (first?.h ?? 0) + NODE.rowGap);
  for (const n of layout.nodes) board.put(n.id, { x: n.x, y: n.y, w: n.w, h: n.h });
  return board.holes();
}

/** 有子会话的家族数（家族 = 挂在来源卡上的根会话与它名下的全部后代；这里的场景只有一层）。 */
const familiesOf = (items: readonly Item[]): number => new Set(items.filter(([, parent]) => parent).map(([, parent]) => parent)).size;
const cell = (rect: Point): string => `${rect.x},${rect.y}`;

/** 每一步：不重叠、已有的卡一像素不动、只多出这一张、待用格不超过家族数；新来的是根会话时它没有占进上一步的待用格。 */
function expectMixedInvariants(steps: readonly SceneLayout[], items: readonly Item[], load: number, label: string): void {
  const parentOf = new Map<string, string | undefined>(items.map(([id, parent]) => [id, parent] as const));
  steps.forEach((layout, i) => {
    const step = `${label} 第 ${load + i} 个到达`;
    expect(overlapsOf(layout), step).toEqual([]);
    const holes = holesOf(layout);
    expect(holes.length, `${step}：待用格数不超过家族数`).toBeLessThanOrEqual(familiesOf(items.slice(0, load + i)));
    expect(new Set(holes.map(cell)).size, `${step}：待用格各不相同`).toBe(holes.length);
    const before = steps[i - 1];
    if (!before) return;
    expect(moved(before, layout), `${step}：已有的卡动了`).toEqual([]);
    const known = new Set(before.nodes.map((n) => n.id));
    const added = layout.nodes.filter((n) => !known.has(n.id));
    expect(added.map((n) => n.id), `${step}：多出的节点`).toEqual([agent(items[load + i - 1]![0])]);
    const id = items[load + i - 1]![0];
    if (parentOf.get(id) !== undefined) return;
    const placed = rectOf(layout, id);
    for (const hole of holesOf(before)) expect(crowds(placed, hole, 0), `${step}：根会话 ${id} 占进了上一步的待用格 (${hole.x}, ${hole.y})`).toBe(false);
  });
}

// 交错到达：新根、A+1、B+1、新根、B+1、新根。
const INTERLEAVED: Item[] = [...loaded(6), ["r7"], ...kids("a", "r1", 4, 4), ["r8"], ...kids("b", "r3", 4, 4), ["r9"], ...kids("b", "r3", 5, 5), ["r10"]];
// 先来 4 个根，再 A+1、B+2。
const ROOTS_FIRST: Item[] = [...loaded(6), ...roots(7, 10), ...kids("a", "r1", 4, 4), ...kids("b", "r3", 4, 5)];
// 先 A+1、B+2，再来 4 个根。
const KIDS_FIRST: Item[] = [...loaded(6), ...kids("a", "r1", 4, 4), ...kids("b", "r3", 4, 5), ...roots(7, 10)];
// 变体：载入的只有 4 个根 + A(3) + B(3)，再 A+1、新根、B+1、新根、B+1、新根。
const FEWER_ROOTS: Item[] = [...loaded(4), ...kids("a", "r1", 4, 4), ["r5"], ...kids("b", "r3", 4, 4), ["r6"], ...kids("b", "r3", 5, 5), ["r7"]];
// 经典树：只有 r1 时载入（规划是经典的一列），之后 A、B 的子会话与新根交替到来。
const CLASSIC: Item[] = [["r1"], ...kids("a", "r1", 1, 3), ["r2"], ...kids("b", "r2", 1, 2), ...kids("a", "r1", 4, 4), ["r3"], ...kids("b", "r2", 3, 3), ["r4"], ...kids("b", "r2", 4, 4), ["r5"]];

const CASES = [
  { name: "交错到达", items: INTERLEAVED, load: 12, area: DESK },
  { name: "先来 4 个根再来子会话", items: ROOTS_FIRST, load: 12, area: DESK },
  { name: "先来子会话再来 4 个根", items: KIDS_FIRST, load: 12, area: DESK },
  { name: "变体：载入的是 4 个根", items: FEWER_ROOTS, load: 10, area: DESK },
  { name: "交错到达 · 1920×1080", items: INTERLEAVED, load: 12, area: WIDE },
  { name: "交错到达 · 紧凑（288×544）", items: INTERLEAVED, load: 12, area: COMPACT },
  { name: "经典树（载入时只有 r1）", items: CLASSIC, load: 1, area: DESK },
] as const;

describe("混排到达：每一步都守住几条不变量", () => {
  for (const { name, items, load, area } of CASES) {
    it(name, () => {
      const steps = run(items, load, area);
      expect(steps).toHaveLength(items.length - load + 1);
      expectMixedInvariants(steps, items, load, name);
    });
  }

  it("前提：经典树那一份载入时规划的确是经典的一列、其余是格点", () => {
    expect(run(CLASSIC, 1)[0]!.grid).not.toBe(true);
    for (const { name, items, load, area } of CASES.filter((c) => c.items !== CLASSIC)) expect(run(items, load, area)[0]!.grid, name).toBe(true);
  });
});

describe("家 B 的子列不被夹断：新根绕开待用格，b4、b5 接在上一个的正下方", () => {
  const stackBelow = (layout: SceneLayout, upper: string, lower: string): void => {
    expect(spot(layout, agent(lower)), `${lower} 在 ${upper} 的正下方`).toEqual({ x: spot(layout, agent(upper)).x, y: spot(layout, agent(upper)).y + 136 });
  };

  it("交错到达：每个新根都落在待用格以外的下一个空位，子会话照常接上去", () => {
    const steps = run(INTERLEAVED, 12);
    const last = steps.at(-1)!;
    expect(spot(last, agent("b3"))).toEqual({ x: 840, y: 544 });
    stackBelow(last, "b3", "b4");
    // b5：r9 先到、把右边新开的一列占了（外框已经宽到 1368），家 B 的子列再往下长要多一行（高 928 比 792），另起一列不多花宽（判据 G：子会话的新列）。
    // 旧的根会话规则让 r9 接在最下面一行，外框宽度没变，b5 就接在 b4 的正下方。
    expect(spot(last, agent("b5")), "b5 开了家 B 的新列，顶与 b1 对齐").toEqual({ x: 1120, y: 272 });
    // 每个新根的落点：行里下一个空格，家 B 的待用格（840, 680）留给 b4；
    // r9：没有空格了，长一行（高 928）不如长一列（宽 1368）看得全，新列顶与第一排对齐；r10 再长一行。（旧：r9 (0, 816)、r10 (0, 952)。）
    const at = (id: string) => spot(last, agent(id));
    expect([at("r7"), at("r8"), at("r9"), at("r10")]).toEqual([
      { x: 0, y: 680 },
      { x: 560, y: 680 },
      { x: 1120, y: 136 },
      { x: 0, y: 816 },
    ]);
    expect(at("a4"), "家 A：r6 在规划里就紧贴在 a3 的下面，a4 没有那一格，落在最近的空位").toEqual({ x: 280, y: 680 });
  });

  it("先来 4 个根：r10 不落进家 B 的待用格（840, 680），另起新列；b4、b5 随后接上", () => {
    const steps = run(ROOTS_FIRST, 12);
    const last = steps.at(-1)!;
    expect(spot(last, agent("r7"))).toEqual({ x: 0, y: 680 });
    expect(spot(last, agent("r8"))).toEqual({ x: 280, y: 680 });
    expect(spot(last, agent("r9"))).toEqual({ x: 560, y: 680 });
    // r10：行里的下一格 (840, 680) 是家 B 的待用格，外框里没有别的空格；长一行（高 928）不如长一列（宽 1368）看得全，
    // 新列顶与第一排对齐。（旧：换行去了下一行最左 (0, 816)。）
    expect(spot(last, agent("r10"))).toEqual({ x: 1120, y: 136 });
    stackBelow(last, "b3", "b4");
    stackBelow(last, "b4", "b5");
    expect(spot(last, agent("b4"))).toEqual({ x: 840, y: 680 });
  });

  it("家 A 的下一格是空的（变体：载入的是 4 个根）：a4 紧接 a3 的下面，之后的新根绕开它的待用格", () => {
    const steps = run(FEWER_ROOTS, 10);
    const last = steps.at(-1)!;
    stackBelow(last, "a3", "a4");
    stackBelow(last, "b3", "b4");
    // b5：r6 先到、另起的新列（外框宽到 1368）已经占了右边，家 B 的子列再往下长要多一行，另起一列不多花宽：b5 开了家 B 的新列（旧：接在 b4 的正下方）。
    expect(spot(last, agent("b5"))).toEqual({ x: 1120, y: 272 });
    expect(spot(last, agent("a4"))).toEqual({ x: 280, y: 544 });
    // 新根：r5 在 (0, 680)（行里的下一格 (280, 680) 是 a4 下面的待用格，不进），r6 长一列（旧：(0, 816)），r7 长一行 (0, 816)（旧：(280, 816)）。
    expect([spot(last, agent("r5")), spot(last, agent("r6")), spot(last, agent("r7"))]).toEqual([
      { x: 0, y: 680 },
      { x: 1120, y: 136 },
      { x: 0, y: 816 },
    ]);
    // 待用格：a4 下面的 (280, 680)，b5 开了新列之后是它下面的 (1120, 408)（旧：(840, 952)）。
    expect(holesOf(last).map(cell).sort()).toEqual(["1120,408", "280,680"]);
  });

  it("1920×1080 的窗口：结果与 1440×900 一样", () => {
    const wide = run(INTERLEAVED, 12, WIDE).at(-1)!;
    const desk = run(INTERLEAVED, 12).at(-1)!;
    expect(wide.nodes.map((n) => [n.id, n.x, n.y])).toEqual(desk.nodes.map((n) => [n.id, n.x, n.y]));
  });
});

describe("待用格的释放：子会话落进去、列满了另起一列、被别的卡占了，都不留旧账", () => {
  it("子会话落进去：待用格换成它下面那一格，原来那一格不再是待用格", () => {
    const steps = run(INTERLEAVED, 12);
    // 载入时：家 B 的 (840, 680) 是待用格；家 A 的那一格（280, 544）被规划里的 r6 占着，没有。
    expect(holesOf(steps[0]!).map(cell)).toEqual(["840,680"]);
    // b4 落进 (840, 680) 之后，待用格是 (840, 816)。
    expect(holesOf(steps[4]!).map(cell).sort()).toEqual(["280,816", "840,816"]);
    // b5 另起了新列 (1120, 272)（见上面“交错到达”）：待用格跟到它下面的 (1120, 408)，b4 下面的 (840, 816) 不再是待用格。（旧：b5 落进 (840, 816)，待用格是 (840, 952)。）
    expect(holesOf(steps[6]!).map(cell).sort()).toEqual(["1120,408", "280,816"]);
  });

  it("列满了另起一列：待用格跟到新列，原来那一格自然空出来，之后的新根可以用它", () => {
    const steps = run(KIDS_FIRST, 12);
    // b5 开了新列（1120, 272）：b4 下面的 (840, 816) 不再是待用格，待用格是新列第二格 (1120, 408)。
    expect(spot(steps[3]!, agent("b5"))).toEqual({ x: 1120, y: 272 });
    expect(holesOf(steps[3]!).map(cell).sort()).toEqual(["1120,408", "280,816"]);
    // 新根（LAYOUT6）：r7 填进外框里新列顶上空着的 (1120, 136)；r8 长一行 (0, 816)；r9 不进家 A 的待用格 (280, 816)，落在 (560, 816)；
    // r10 到达时正好用了 (840, 816)：它此刻不是任何人的待用格。（旧：r7 (0, 816)、r8 (560, 816)、r9 (840, 816)、r10 (1120, 816)。）
    expect(spot(steps[4]!, agent("r7"))).toEqual({ x: 1120, y: 136 });
    expect(spot(steps[5]!, agent("r8"))).toEqual({ x: 0, y: 816 });
    expect(holesOf(steps[5]!).map(cell), "家 A 的待用格还在 a4 下面").toContain("280,816");
    expect(spot(steps[6]!, agent("r9"))).toEqual({ x: 560, y: 816 });
    expect(spot(steps[7]!, agent("r10"))).toEqual({ x: 840, y: 816 });
  });

  it("被别的卡占了就没有：载入时家 A 的子列尾下面是规划自己放的 r6", () => {
    const first = run(INTERLEAVED, 12)[0]!;
    expect(spot(first, agent("r6"))).toEqual({ x: spot(first, agent("a3")).x, y: spot(first, agent("a3")).y + 136 });
    expect(holesOf(first).map(cell)).not.toContain(cell({ x: spot(first, agent("a3")).x, y: spot(first, agent("a3")).y + 136 }));
  });
});

describe("待用格只拦根会话与不属于任何一家的卡：别家的子会话不拦", () => {
  it("经典树里 r2 的 b1 落在家 A 子列尾下面的那一格（它自己的位置，不让开）；a4 因此另起一列、顶与 a1 对齐", () => {
    const steps = run(CLASSIC, 1);
    const at = (layout: SceneLayout, id: string) => spot(layout, agent(id));
    const afterR2 = steps[4]!;
    expect(holesOf(afterR2).map(cell), "r2 到达那一步：家 A 的待用格在 (644, 408)").toEqual(["644,408"]);
    const afterB1 = steps[5]!;
    expect(at(afterB1, "b1"), "b1 是子会话，不被别家的待用格拦住").toEqual({ x: 644, y: 408 });
    expect(at(afterB1, "a3")).toEqual({ x: 644, y: 272 });
    const afterA4 = steps[7]!;
    expect(at(afterA4, "a4"), "a4 的那一格被 b1 占了：另起一列，顶与第一个子会话对齐").toEqual({ x: 924, y: 0 });
  });

  it("经典树的根会话仍排在根列里往下接：待用格在子会话那一列，不挡根列", () => {
    const steps = run(CLASSIC, 1);
    const column = (id: string) => spot(steps.at(-2)!, agent(id)).x;
    expect([column("r1"), column("r2"), column("r3"), column("r4")]).toEqual([304, 304, 304, 304]);
  });
});

describe("待用格的数量上限：占着的空格数 ≤ 家族数", () => {
  it("每个场景、每一步：待用格数不超过有子会话的家族数，每家至多一格", () => {
    for (const { name, items, load, area } of CASES) {
      run(items, load, area).forEach((layout, i) => {
        const holes = holesOf(layout);
        const families = familiesOf(items.slice(0, load + i));
        expect(holes.length, `${name} 第 ${load + i} 个到达`).toBeLessThanOrEqual(families);
        // 每一格都在某一个子会话的正下方（同列、紧邻下一格）：一格对应一家人的子列尾。
        for (const hole of holes) {
          const above = layout.nodes.find((n) => n.kind === "agent" && n.x === hole.x && n.y + n.h + NODE.rowGap === hole.y);
          expect(above, `${name} 第 ${load + i} 个到达：(${hole.x}, ${hole.y}) 的上面`).toBeDefined();
        }
      });
    }
  });

  it("一口气长出 8 个家族（每家 3 个子会话）再各来 2 个新子会话：待用格数始终 ≤ 家族数", () => {
    const base: Item[] = [...roots(1, 8)];
    for (let family = 1; family <= 8; family++) base.push(...kids(`f${family}k`, `r${family}`, 1, 3));
    const arrivals: Item[] = [];
    for (let round = 4; round <= 5; round++) for (let family = 1; family <= 8; family++) arrivals.push(...kids(`f${family}k`, `r${family}`, round, round));
    arrivals.push(...roots(9, 12));
    const items = [...base, ...arrivals];
    const steps = run(items, base.length);
    steps.forEach((layout, i) => expect(holesOf(layout).length, `第 ${base.length + i} 个到达`).toBeLessThanOrEqual(8));
    expectMixedInvariants(steps, items, base.length, "八个家族");
  });
});
