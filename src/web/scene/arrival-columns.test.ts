import { describe, expect, it } from "vitest";
import { MIN_ROWS, newColumn, type Stack } from "./arrival-columns";
import { unionOf, type Point } from "./arrival-slots";
import type { Area } from "./layout";
import type { Rect } from "./placement";

/**
 * 竖排的一列满了就另起一列（LAYOUT3 · W6）：纯几何的单元测试，不经过规划与持有逻辑——
 * 判据、新列的落点、下限、被占时的退让各自单独钉住，集成层面的结果在 arrival-columns.hold.test.ts。
 * 数字取经典的树：卡 248×112，来源卡在 x=0、根会话在 x=304，行距 136，子会话那一列离上级 340。
 */

const SIZE = { w: 248, h: 112 };
const STEPS = { x: 340, y: 136 };
const ORIGIN: Rect = { x: 0, y: 0, ...SIZE };

/** 一竖排：`rows` 张卡，左缘 `x`，第一张的顶在 `top`，往下每行 136。 */
const column = (rows: number, x = 304, top = 0): Rect[] => Array.from({ length: rows }, (_, i) => ({ x, y: top + i * 136, ...SIZE }));
const stackOf = (cards: Rect[], scope: Rect[] = cards): Stack => ({ ref: cards[cards.length - 1]!, siblings: cards, scope });
const belowOf = (stack: Stack): Point => ({ x: stack.ref.x, y: stack.ref.y + STEPS.y });
/** 现有全部卡的外框（来源卡加上这些卡）。 */
const boundsOf = (cards: readonly Rect[]): Rect => unionOf([ORIGIN, ...cards])!;

/** 用 `area` 问一次：这一竖排再来一张，落在哪里（undefined = 接在下面）。 */
function ask(stack: Stack, area: Area, obstacles: readonly Rect[] = [ORIGIN, ...stack.scope], bounds: Rect = boundsOf(stack.scope)): Point | undefined {
  return newColumn(stack, belowOf(stack), SIZE, STEPS, area, obstacles, bounds);
}

describe("另起一列的判据：接在下面与另起一列，哪种让整个排布在取景区域里看得更全", () => {
  it("宽屏：接在下面要缩小、右边新开一列仍是 100%——另起一列", () => {
    // 6 行已经占 792px 高；第 7 行让整体 928px 高，在 890px 的取景区域里只剩 95.9%；新开一列（紧挨着，x=644）整体 892px 宽，宽 1568 放得下，高 792 也放得下。
    const stack = stackOf(column(6));
    expect(ask(stack, { w: 1568, h: 890 })).toEqual({ x: 644, y: 0 });
  });

  it("窄屏：多一列要把整体缩得很小，多接一行只缩一点——接在下面", () => {
    // 288×544 的取景区域：接在下面是 min(288/552, 544/928) = 52%；新开一列整体 892px 宽，只剩 32%。
    expect(ask(stackOf(column(6)), { w: 288, h: 544 })).toBeUndefined();
  });

  it("没有哪种更好（两种都是 100%，或者受同一边限制）就接在下面，不为了换列而换列", () => {
    const stack = stackOf(column(6));
    expect(ask(stack, { w: 10000, h: 10000 }), "都放得下").toBeUndefined();
    // 别处有一块把整体撑到 1300px 宽的内容：宽度已经是限制因素。新开一列（x=644..892）不会让它更宽，
    // 但接在下面也是同样的宽度（比例由宽度定），持平——此时多接几行是免费的，没有理由换列。
    const wide: Rect = { x: 1100, y: 600, w: 200, h: 112 };
    expect(ask(stack, { w: 650, h: 710 }, [ORIGIN, ...stack.scope, wide], boundsOf([...stack.scope, wide])), "同受宽度限制").toBeUndefined();
  });

  it("外框取全部卡：别处有一块很高的内容时，一列再长一行也不会让整体更高，不另起一列", () => {
    // 同样的 6 行；别处（来源卡的下面）还有一块把整体撑到 2100px 高。接在下面的第 7 行仍在这个高度以内。
    const tall: Rect = { x: 0, y: 2000, ...SIZE };
    const stack = stackOf(column(6));
    expect(ask(stack, { w: 1088, h: 710 }, [ORIGIN, ...stack.scope, tall], boundsOf([...stack.scope, tall]))).toBeUndefined();
    expect(ask(stack, { w: 1088, h: 710 }), "没有那一块时同一个区域会另起一列").toEqual({ x: 644, y: 0 });
  });
});

describe("下限：一列至少有 MIN_ROWS 张才允许另起", () => {
  const short: Area = { w: 4000, h: 60 };

  it(`不到 ${MIN_ROWS} 张：取景区域再矮、再宽也不另起`, () => {
    for (let rows = 1; rows < MIN_ROWS; rows++) expect(ask(stackOf(column(rows)), short), `${rows} 张`).toBeUndefined();
  });

  it(`正好 ${MIN_ROWS} 张：判据成立就另起`, () => {
    expect(ask(stackOf(column(MIN_ROWS)), short)).toEqual({ x: 644, y: 0 });
  });

  it("数的是这一列（ref 所在的那一列）里的卡，不是所有兄弟：第二列从零数起", () => {
    // 第一列 6 张，第二列只有 2 张（x=984）：ref 在第二列，第二列没到下限。
    const second = column(2, 984);
    const stack: Stack = { ref: second[1]!, siblings: [...column(6), ...second], scope: [...column(6), ...second] };
    expect(ask(stack, short)).toBeUndefined();
  });
});

describe("新列的落点", () => {
  const area: Area = { w: 3000, h: 500 };

  it("列顶与第一列的顶对齐，不是与接在下面的那张或 ref 所在列的顶对齐", () => {
    // 第一列从 y=40 起 3 张；第二列（x=984）从 y=200 起 3 张（别的路径摆出来的，与第一列不齐），ref 在第二列：
    // 第三列紧挨在两列的右边（984 + 248 = 1232，再隔 92 → 1324），顶仍是第一列的 40。
    const first = column(3, 304, 40);
    const second = column(3, 984, 200);
    const stack: Stack = { ref: second[2]!, siblings: [...first, ...second], scope: [...first, ...second] };
    expect(ask(stack, area)).toEqual({ x: 1324, y: 40 });
  });

  it("第一列取最靠左的那一列里最高的一张：兄弟里有比它更高的汇聚会话也不影响", () => {
    // 一张晚到的会话落在更右的列、比第一列更高（y=-300）：第一列的顶不变。
    const first = column(3, 304, 40);
    const odd: Rect = { x: 1664, y: -300, ...SIZE };
    const stack: Stack = { ref: first[2]!, siblings: [...first, odd], scope: [...first, odd] };
    expect(ask(stack, area, [ORIGIN, ...first, odd])?.y).toBe(40);
  });

  it("横向：紧挨在这一列（连同它们全部后代）的右边，只隔一道列间空白——不为每张卡将来的子会话预留一整列", () => {
    // 304 + 248 = 552 是这一列的右缘；列间空白 = 列距 340 - 卡宽 248 = 92 → 644。
    expect(ask(stackOf(column(3)), area)?.x).toBe(644);
    // 列距换成格点排布的 280：空白 32 → 552 + 32 = 584。
    const grid = newColumn(stackOf(column(3)), { x: 304, y: 408 }, SIZE, { x: 280, y: 136 }, area, [ORIGIN, ...column(3)], boundsOf(column(3)));
    expect(grid?.x).toBe(584);
  });

  it("已经长出子孙的：整块区域本来就更靠右，新列在它们全部的右边——整块外框都算进去", () => {
    // 第一列的根会话带着子孙，一直到 x=1200..1448：新列要在 1448 之外再空一个列间距（92）。
    const cards = column(3);
    const grandkids: Rect[] = [
      { x: 644, y: 0, ...SIZE },
      { x: 984, y: 0, ...SIZE },
      { x: 1200, y: 136, ...SIZE },
    ];
    const stack = stackOf(cards, [...cards, ...grandkids]);
    const at = ask(stack, area, [ORIGIN, ...cards, ...grandkids]);
    expect(at).toEqual({ x: 1448 + 92, y: 0 });
  });

  it("新列的位置被别的东西占着：不另起（调用方接在下面），也不去压它", () => {
    // 外框只有这一列自己（默认的 bounds），所以紧挨着的那一格被占了，“开到所有卡的右边”还是同一格：两处都被占，不另起。
    const stack = stackOf(column(3));
    const blocker: Rect = { x: 644, y: 60, ...SIZE };
    expect(ask(stack, area, [ORIGIN, ...stack.scope, blocker])).toBeUndefined();
    // 没压住、但与新列的卡只隔 12（不到卡与卡之间至少要留的 24）：也算挤。
    const close: Rect = { x: 644, y: 112 + 12, ...SIZE };
    expect(ask(stack, area, [ORIGIN, ...stack.scope, close])).toBeUndefined();
    // 离新列还有一个行距以上的空隙：不算挤。
    const apart: Rect = { x: 644, y: 400, ...SIZE };
    expect(ask(stack, area, [ORIGIN, ...stack.scope, apart])).toEqual({ x: 644, y: 0 });
  });

  it("紧挨着的那一格被占了：开到所有卡的右边（外框的右缘再隔一道空白），顶仍与第一列对齐——不再有一条竖到底", () => {
    // 别的东西（别家的整块区域、并排的来源……）占着紧挨着的那一格，外框因此伸到 948：新列在它右边 948 + 92 = 1040，不是 644。
    const stack = stackOf(column(3));
    const blocker: Rect = { x: 700, y: 60, ...SIZE };
    expect(ask(stack, area, [ORIGIN, ...stack.scope, blocker], boundsOf([...stack.scope, blocker]))).toEqual({ x: 1040, y: 0 });
  });

  it("所有卡的右边也被占着（外框右缘之外还有不在外框里的东西）：不另起", () => {
    const stack = stackOf(column(3));
    const blocker: Rect = { x: 700, y: 60, ...SIZE };
    const hidden: Rect = { x: 1040, y: 0, ...SIZE };
    expect(ask(stack, area, [ORIGIN, ...stack.scope, blocker, hidden], boundsOf([...stack.scope, blocker]))).toBeUndefined();
  });
});
