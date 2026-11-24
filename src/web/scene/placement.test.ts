import { describe, expect, it } from "vitest";
import { agentNodeId, layoutScene, NODE, originNodeId, type LayoutNode } from "./layout";
import { node, session } from "./layout.fixtures";
import { arrivalsFor, freshIds, placeBeside, planArrivals, type Rect } from "./placement";
import type { NodePosition } from "./positions";

const SIZE = { w: NODE.agentW, h: NODE.agentH };
const ROW = NODE.agentH + NODE.rowGap;
const rect = (x: number, y: number, size = SIZE): Rect => ({ x, y, ...size });
const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const at = (spot: NodePosition): Rect => rect(spot.x, spot.y);

describe("placeBeside：新节点落在参照旁边", () => {
  it("没有人挡路：参照此刻的位置加上布局留的偏移（参照在原位时就是布局给的槽位）", () => {
    expect(placeBeside({ x: 912, y: 272 }, { dx: 24, dy: ROW }, SIZE, [])).toEqual({ x: 936, y: 272 + ROW });
  });

  it("参照被拖到上下左右任何一个方向：以拖后的位置为原点，偏移不变", () => {
    const home = { x: 912, y: 272 };
    const offset = { dx: 24, dy: ROW };
    for (const [name, to] of [["右", { x: 1400, y: 272 }], ["上", { x: 912, y: -300 }], ["下", { x: 912, y: 900 }], ["左", { x: -600, y: 272 }]] as const) {
      expect(placeBeside(to, offset, SIZE, []), `拖到${name}边`).toEqual({ x: to.x + offset.dx, y: to.y + offset.dy });
    }
    // 参照在原位与被拖走，新节点与参照的相对关系始终一样。
    expect(placeBeside(home, offset, SIZE, [])).toEqual({ x: home.x + 24, y: home.y + ROW });
  });

  it("紧凑画布没有错位（dx 为 0）：新节点与参照左对齐、正下方隔一个行距", () => {
    const spot = placeBeside({ x: 178, y: 136 }, { dx: 0, dy: ROW }, { w: NODE.agentWCompact, h: NODE.agentH }, []);
    expect(spot).toEqual({ x: 178, y: 136 + ROW });
  });

  it("与别的节点相交：落到它的下沿再隔一个行距，行距的节奏不变", () => {
    const blocker = rect(936, 408);
    const spot = placeBeside({ x: 912, y: 272 }, { dx: 24, dy: ROW }, SIZE, [blocker]);
    expect(spot).toEqual({ x: 936, y: blocker.y + blocker.h + NODE.rowGap });
    expect(overlaps(at(spot), blocker)).toBe(false);
  });

  it("只是挨得太近（没有相交、不足一个行距）也要让开；正好隔一个行距则不动（布局本来的行距）", () => {
    const from = { x: 0, y: 0 };
    const offset = { dx: 0, dy: ROW };
    // 障碍的上沿比落点的下沿只高 10px：没相交，但比一个行距近。
    const close = rect(0, ROW + NODE.agentH + 10);
    expect(placeBeside(from, offset, SIZE, [close]).y).toBe(close.y + close.h + NODE.rowGap);
    // 正好隔 rowGap：就是布局里相邻两行的样子，不能被当成挤着。
    const exact = rect(0, ROW + NODE.agentH + NODE.rowGap);
    expect(placeBeside(from, offset, SIZE, [exact])).toEqual({ x: 0, y: ROW });
    // 参照自己就在正上方、隔着一个行距：不能把新节点从参照旁边赶走。
    expect(placeBeside(from, offset, SIZE, [rect(0, 0)])).toEqual({ x: 0, y: ROW });
  });

  it("连着几个障碍：一直往下，直到真的放得下；中间放得下的空档会被用上", () => {
    const stacked = [rect(936, 408), rect(936, 408 + ROW), rect(936, 408 + 2 * ROW)];
    const below = placeBeside({ x: 912, y: 272 }, { dx: 24, dy: ROW }, SIZE, stacked);
    expect(below.y).toBe(408 + 2 * ROW + NODE.agentH + NODE.rowGap);
    for (const blocker of stacked) expect(overlaps(at(below), blocker)).toBe(false);

    // 两个障碍之间留了一个能放下的空档（上下各隔一个行距）：落进去，不必飞到最底下。
    const gap = [rect(936, 408), rect(936, 408 + NODE.agentH + 2 * NODE.rowGap + NODE.agentH + NODE.rowGap + NODE.agentH)];
    const hole = placeBeside({ x: 912, y: 272 }, { dx: 24, dy: ROW }, SIZE, gap);
    expect(hole.y).toBe(408 + NODE.agentH + NODE.rowGap);
  });

  it("障碍在别的列、水平上够远：不受影响", () => {
    const farRight = rect(936 + NODE.agentW + NODE.rowGap + 1, 408);
    expect(placeBeside({ x: 912, y: 272 }, { dx: 24, dy: ROW }, SIZE, [farRight])).toEqual({ x: 936, y: 408 });
  });

  it("输入不被修改", () => {
    const from = Object.freeze({ x: 912, y: 272 });
    const offset = Object.freeze({ dx: 24, dy: ROW });
    const size = Object.freeze({ ...SIZE });
    const occupied = Object.freeze([Object.freeze(rect(936, 408))]);
    const spot = placeBeside(from, offset, size, occupied);
    expect(spot).not.toBe(from);
    expect(from).toEqual({ x: 912, y: 272 });
    expect(occupied[0]).toEqual(rect(936, 408));
  });

  it("参照位置不是有限数：原样返回，不会死循环", () => {
    const spot = placeBeside({ x: Number.NaN, y: 0 }, { dx: 0, dy: ROW }, SIZE, [rect(0, 0)]);
    expect(Number.isNaN(spot.x)).toBe(true);
  });
});

/** 一个来源下 count 个根会话（先后 1..count）的真实布局。 */
const column = (count: number, compact = false) =>
  layoutScene(
    Array.from({ length: count }, (_, i) => session(`s${i + 1}`, "codex", i + 1)),
    compact ? { area: { w: 400, h: 700 } } : {},
  );
const idOf = (n: number): string => agentNodeId(`s${n}` as never);
const positions = (entries: Record<string, NodePosition>): Map<string, NodePosition> => new Map(Object.entries(entries));
const freshOf = (...ids: string[]): Set<string> => new Set(ids);

describe("planArrivals：这一次布局里新来的会话落在哪里", () => {
  it("没有任何手动位置的原始状态：一个都不记，新节点照布局原位（positions 保持为空）", () => {
    const layout = column(4);
    expect(planArrivals(layout.nodes, new Map(), freshOf(idOf(4)))).toEqual(new Map());
  });

  it("参照（上一个兄弟）没被动过：新节点照布局原位，不记，哪怕别的节点被拖走了", () => {
    const layout = column(4);
    const far = positions({ [idOf(1)]: { x: 2000, y: 2000 } });
    expect(planArrivals(layout.nodes, far, freshOf(idOf(4))).size).toBe(0);
  });

  it("参照被拖走：新节点落在拖后位置的下方，沿用布局里错位的左右交替，并且要记下来", () => {
    const layout = column(4);
    const dragged = { x: 1400, y: 90 };
    const planned = planArrivals(layout.nodes, positions({ [idOf(3)]: dragged }), freshOf(idOf(4)));
    const home3 = node(layout, idOf(3));
    const home4 = node(layout, idOf(4));
    // 布局里第 4 个比第 3 个靠右 stagger、低一个行距。
    expect(home4.x - home3.x).toBe(NODE.stagger);
    expect(planned.get(idOf(4))).toEqual({ x: dragged.x + NODE.stagger, y: dragged.y + ROW });
  });

  it("参照被拖到四个方向：新节点总在参照下方一个行距，不会回到布局槽位，也不会跑到别处", () => {
    const layout = column(4);
    const home = node(layout, idOf(3));
    for (const [name, to] of [
      ["右", { x: home.x + 500, y: home.y }],
      ["上", { x: home.x + 700, y: home.y - 380 }],
      ["下", { x: home.x, y: home.y + 700 }],
      ["左", { x: home.x - 560, y: home.y }],
    ] as const) {
      const spot = planArrivals(layout.nodes, positions({ [idOf(3)]: to }), freshOf(idOf(4))).get(idOf(4))!;
      expect(spot.y - to.y, `拖到${name}边`).toBe(ROW);
      expect(spot.x - to.x, `拖到${name}边`).toBe(NODE.stagger);
    }
  });

  it("参照被拖到原来那一列的上方、紧下方压着别的会话：一路往下让到第一个放得下的空位（原来的槽位），不压任何一个", () => {
    const layout = column(4);
    const home = node(layout, idOf(3));
    const to = { x: home.x, y: home.y - 380 };
    const spot = planArrivals(layout.nodes, positions({ [idOf(3)]: to }), freshOf(idOf(4))).get(idOf(4))!;
    for (const n of [1, 2]) expect(overlaps(at(spot), at(node(layout, idOf(n)))), `s${n}`).toBe(false);
    expect(overlaps(at(spot), at(to))).toBe(false);
    expect(spot.y).toBe(home.y);
  });

  it("参照是紧凑画布里的节点：没有错位，正下方一个行距", () => {
    const layout = column(3, true);
    const dragged = { x: 40, y: -300 };
    const spot = planArrivals(layout.nodes, positions({ [idOf(2)]: dragged }), freshOf(idOf(3))).get(idOf(3))!;
    expect(spot).toEqual({ x: dragged.x, y: dragged.y + ROW });
  });

  it("落点被用户拖来的节点占着：往下让到最近的空位，保持行距；别的没被挤的节点不受影响", () => {
    const layout = column(4);
    const dragged = { x: 1400, y: 90 };
    // 把第 1 个会话拖到“第 3 个下面一格”的落点上。
    const slot = { x: dragged.x + NODE.stagger, y: dragged.y + ROW };
    const placed = positions({ [idOf(3)]: dragged, [idOf(1)]: { ...slot } });
    const spot = planArrivals(layout.nodes, placed, freshOf(idOf(4))).get(idOf(4))!;
    expect(spot).toEqual({ x: slot.x, y: slot.y + ROW });
    expect(overlaps(at(spot), at(slot))).toBe(false);
  });

  it("参照没动、但布局槽位被拖来的节点占了：避开并记下来（不然下一次布局又会把它放回那里）", () => {
    const layout = column(4);
    const slot = node(layout, idOf(4));
    const placed = positions({ [idOf(1)]: { x: slot.x + 10, y: slot.y + 20 } });
    const spot = planArrivals(layout.nodes, placed, freshOf(idOf(4))).get(idOf(4))!;
    expect(spot.x).toBe(slot.x);
    expect(spot.y).toBe(slot.y + 20 + NODE.agentH + NODE.rowGap);
  });

  it("槽位被占、往下让时碰到布局里排在后面的别的来源：继续往下让到它下面，不压任何一个（真实渲染里量到过压住别的来源的第一个会话）", () => {
    const box = { w: NODE.agentW, h: NODE.agentH, overhang: { left: 0, right: 0 } };
    const nodes: LayoutNode[] = [
      { id: "agent:a1", kind: "agent", x: 0, y: 0, ...box },
      { id: "agent:a3", kind: "agent", x: 0, y: 2 * ROW, ...box },
      { id: "agent:a4", kind: "agent", x: 24, y: 3 * ROW, ...box, anchor: { id: "agent:a3", dx: 24, dy: ROW } },
      // 别的来源的会话排在 A 这一列的下面（布局给的默认位置），紧挨着 a4 的槽位下沿。
      { id: "agent:b1", kind: "agent", x: 0, y: 3 * ROW + NODE.agentH + 56, ...box },
      { id: "agent:b2", kind: "agent", x: 24, y: 4 * ROW + NODE.agentH + 56, ...box },
    ];
    // a1 被拖来盖住了 a4 的槽位；a3（a4 的参照）没动。
    const spot = planArrivals(nodes, positions({ "agent:a1": { x: 24, y: 3 * ROW } }), freshOf("agent:a4")).get("agent:a4")!;
    const b2 = nodes[4]!;
    expect(spot).toEqual({ x: 24, y: b2.y + NODE.agentH + NODE.rowGap });
    for (const other of nodes.slice(1, 2).concat(nodes.slice(3))) expect(overlaps(at(spot), rect(other.x, other.y)), other.id).toBe(false);
    expect(overlaps(at(spot), rect(24, 3 * ROW))).toBe(false);
  });

  it("落点压在还在默认位置的节点上（比如来源卡）：同样避开，不压住它", () => {
    const layout = column(3);
    const origin = node(layout, originNodeId("codex"));
    // 第 2 个被拖到来源卡的正下方；第 3 个跟在它后面，落点与来源卡相交。
    const dragged = { x: origin.x, y: origin.y - ROW + 40 };
    const spot = planArrivals(layout.nodes, positions({ [idOf(2)]: dragged }), freshOf(idOf(3))).get(idOf(3))!;
    expect(overlaps(at({ x: spot.x, y: spot.y }), { x: origin.x, y: origin.y, w: origin.w, h: origin.h })).toBe(false);
    expect(overlaps(at(spot), at(dragged))).toBe(false);
  });

  it("同时来两个：第二个以第一个的落点为参照，互不重叠，也不压住别的节点", () => {
    const layout = column(5);
    const dragged = { x: 1400, y: 90 };
    const planned = planArrivals(layout.nodes, positions({ [idOf(3)]: dragged }), freshOf(idOf(4), idOf(5)));
    const a = planned.get(idOf(4))!;
    const b = planned.get(idOf(5))!;
    expect(a).toEqual({ x: dragged.x + NODE.stagger, y: dragged.y + ROW });
    expect(b).toEqual({ x: dragged.x, y: dragged.y + 2 * ROW });
    expect(overlaps(at(a), at(b))).toBe(false);
  });

  it("同时来两个、参照都没动、槽位被占：两个都往下让，互不重叠", () => {
    const layout = column(5);
    const s4 = node(layout, idOf(4));
    const s5 = node(layout, idOf(5));
    // 第 1 个会话盖在第 4 个的槽位上，第 2 个盖在第 5 个的槽位上。
    const placed = positions({ [idOf(1)]: { x: s4.x, y: s4.y }, [idOf(2)]: { x: s5.x, y: s5.y } });
    const planned = planArrivals(layout.nodes, placed, freshOf(idOf(4), idOf(5)));
    const a = planned.get(idOf(4))!;
    const b = planned.get(idOf(5))!;
    expect(overlaps(at(a), at(b))).toBe(false);
    for (const spot of [a, b]) for (const held of placed.values()) expect(overlaps(at(spot), at(held))).toBe(false);
    // 第 5 个的参照（第 4 个）这时有位置了，所以第 5 个落在第 4 个下面而不是原槽位。
    expect(b.y - a.y).toBe(ROW);
  });

  it("还没轮到的新节点没有最终位置，不当作障碍", () => {
    const box = { w: NODE.agentW, h: NODE.agentH, overhang: { left: 0, right: 0 } };
    const nodes: LayoutNode[] = [
      { id: "agent:a", kind: "agent", x: 0, y: 0, ...box },
      { id: "agent:n1", kind: "agent", x: 0, y: ROW, ...box, anchor: { id: "agent:a", dx: 0, dy: ROW } },
      // n2 在布局里的默认槽位恰好是 n1 将要落的地方（参照 a 被拖到了 (1000, 0)，n1 落在 (1000, ROW)）。
      { id: "agent:n2", kind: "agent", x: 1000, y: ROW, ...box, anchor: { id: "agent:n1", dx: 0, dy: ROW } },
    ];
    const planned = planArrivals(nodes, positions({ "agent:a": { x: 1000, y: 0 } }), freshOf("agent:n1", "agent:n2"));
    expect(planned.get("agent:n1")).toEqual({ x: 1000, y: ROW });
    expect(planned.get("agent:n2")).toEqual({ x: 1000, y: 2 * ROW });
  });

  it("子会话：父会话被拖走后，第一个子会话在它右边的下一列，第二个在第一个下面", () => {
    const sessions = [session("p1", "codex", 1), session("p2", "codex", 2), session("c1", "codex", 3, { parentSessionId: "p2" as never }), session("c2", "codex", 4, { parentSessionId: "p2" as never })];
    const parent = { x: 1100, y: 500 };
    const first = layoutScene(sessions.slice(0, 3));
    const p2 = node(first, agentNodeId("p2" as never));
    const c1home = node(first, agentNodeId("c1" as never));

    const one = planArrivals(first.nodes, positions({ [p2.id]: parent }), freshOf(c1home.id)).get(c1home.id)!;
    expect(one).toEqual({ x: parent.x + (c1home.x - p2.x), y: parent.y + (c1home.y - p2.y) });

    // 第二个子会话来的时候，第一个子会话已经记在 positions 里了。
    const both = layoutScene(sessions);
    const c2 = node(both, agentNodeId("c2" as never));
    const two = planArrivals(both.nodes, positions({ [p2.id]: parent, [c1home.id]: one }), freshOf(c2.id)).get(c2.id)!;
    expect(two.y - one.y).toBe(ROW);
    expect(Math.abs(two.x - one.x)).toBe(NODE.stagger);
  });

  it("只处理会话节点：Git、Folder、来源卡这类新节点不在这里，也不会被记下来", () => {
    const layout = column(2);
    const origin = node(layout, originNodeId("codex"));
    const planned = planArrivals(layout.nodes, positions({ [idOf(1)]: { x: 0, y: 0 } }), freshOf(origin.id));
    expect(planned.size).toBe(0);
  });

  it("已经有手动位置的节点不会被重新规划", () => {
    const layout = column(3);
    const mine = { x: 7, y: 7 };
    const planned = planArrivals(layout.nodes, positions({ [idOf(2)]: mine, [idOf(3)]: { x: 9, y: 9 } }), freshOf(idOf(3)));
    expect(planned.has(idOf(3))).toBe(false);
  });

  it("输入不被修改：nodes、positions、fresh 都原样", () => {
    const layout = column(4);
    const placed = positions({ [idOf(3)]: { x: 1400, y: 90 } });
    const fresh = freshOf(idOf(4));
    const nodesBefore = JSON.stringify(layout.nodes);
    const placedBefore = JSON.stringify([...placed]);
    planArrivals(layout.nodes, placed, fresh);
    expect(JSON.stringify(layout.nodes)).toBe(nodesBefore);
    expect(JSON.stringify([...placed])).toBe(placedBefore);
    expect([...fresh]).toEqual([idOf(4)]);
  });

  it("锚点不在布局里（被过滤掉了）：没有参照，退回布局原位", () => {
    const layout = column(3);
    const orphan: LayoutNode[] = layout.nodes.map((n) => (n.id === idOf(3) ? { ...n, anchor: { id: "agent:gone", dx: 24, dy: ROW } } : n));
    expect(planArrivals(orphan, positions({ [idOf(1)]: { x: 5000, y: 5000 } }), freshOf(idOf(3))).size).toBe(0);
  });
});

describe("arrivalsFor：引擎的入口，从“谁早就在画布上”得出谁是新来的", () => {
  const dragged = positions({ [idOf(3)]: { x: 1400, y: 90 } });
  const onCanvas = (...ids: string[]) => (nodeId: string): boolean => ids.includes(nodeId);

  it("新来的节点（不在画布上、也没有手动位置）接在被拖走的参照后面", () => {
    const layout = column(4);
    const planned = arrivalsFor(layout.nodes, dragged, onCanvas(idOf(1), idOf(2), idOf(3), originNodeId("codex")));
    expect([...planned.keys()]).toEqual([idOf(4)]);
    expect(planned.get(idOf(4))).toEqual({ x: 1400 + NODE.stagger, y: 90 + ROW });
  });

  it("用户一个节点都没摆过（positions 为空）：没有可接的，什么都不规划", () => {
    const layout = column(4);
    expect(arrivalsFor(layout.nodes, new Map(), onCanvas(idOf(1), idOf(2), idOf(3))).size).toBe(0);
  });

  it("页面刚打开（布局里没有一个节点早就在画布上）：不搬任何没摆过的节点", () => {
    const layout = column(4);
    expect(arrivalsFor(layout.nodes, dragged, onCanvas()).size).toBe(0);
  });

  it("早就在画布上的节点不是新来的：即使它没有手动位置、参照又被拖走了，也不会被重新规划", () => {
    const layout = column(4);
    expect(arrivalsFor(layout.nodes, dragged, onCanvas(idOf(1), idOf(2), idOf(3), idOf(4), originNodeId("codex"))).size).toBe(0);
  });

  it("已有手动位置的节点不是新来的，哪怕它不在画布上（隐藏后再出现）", () => {
    const layout = column(4);
    const both = positions({ [idOf(3)]: { x: 1400, y: 90 }, [idOf(4)]: { x: 5, y: 5 } });
    expect(arrivalsFor(layout.nodes, both, onCanvas(idOf(1), idOf(2), idOf(3))).size).toBe(0);
  });

  it("被视图过滤收起过的节点（不在画布上，但引擎知道它们）重新出现：不是新来的，不被摆到被拖走的参照旁边", () => {
    const layout = column(5);
    // 第 4、5 个被收起过：不在画布上，但已知；第 3 个被拖走。
    const known = onCanvas(idOf(1), idOf(2), idOf(3), idOf(4), idOf(5), originNodeId("codex"));
    expect(arrivalsFor(layout.nodes, dragged, known).size).toBe(0);
    // 同一个谓词若不认得它们，它们就会被当成新来的接到被拖走的第 3 个后面。
    const planned = arrivalsFor(layout.nodes, dragged, onCanvas(idOf(1), idOf(2), idOf(3), originNodeId("codex")));
    expect([...planned.keys()]).toEqual([idOf(4), idOf(5)]);
  });

  it("收起的节点重新出现的同一次布局里又来了真正新的：只规划新的那个", () => {
    const layout = column(6);
    const known = onCanvas(idOf(1), idOf(2), idOf(3), idOf(4), idOf(5), originNodeId("codex"));
    // 第 4 个被收起过（已知、没有位置）；第 5 个被拖走，新来的第 6 个接在它后面。
    const planned = arrivalsFor(layout.nodes, positions({ [idOf(5)]: { x: 1400, y: 90 } }), known);
    expect([...planned.keys()]).toEqual([idOf(6)]);
    expect(planned.get(idOf(6))).toEqual({ x: 1400 + NODE.stagger, y: 90 + ROW });
  });
});

describe("freshIds：摆放与“视口外提示”共用的“谁是新来的”", () => {
  const onCanvas = (...ids: string[]) => (nodeId: string): boolean => ids.includes(nodeId);

  it("不是已知的就是新来的；已知的（画布上出现过，或被视图过滤收起过）不是", () => {
    const layout = column(4);
    expect([...freshIds(layout.nodes, onCanvas(idOf(1), idOf(2), originNodeId("codex")))].sort()).toEqual([idOf(3), idOf(4)].sort());
    expect(freshIds(layout.nodes, onCanvas(idOf(1), idOf(2), idOf(3), idOf(4), originNodeId("codex"))).size).toBe(0);
  });

  it("没有一个节点是已知的（页面刚打开）：那是现状，不是新来的", () => {
    expect(freshIds(column(4).nodes, onCanvas()).size).toBe(0);
  });

  it("手动位置不影响它：有位置的节点只要不是已知的，同样是新来的（arrivalsFor 才另外把它们排除）", () => {
    const layout = column(3);
    const fresh = freshIds(layout.nodes, onCanvas(idOf(1), originNodeId("codex")));
    expect([...fresh].sort()).toEqual([idOf(2), idOf(3)].sort());
    const planned = arrivalsFor(layout.nodes, positions({ [idOf(1)]: { x: 1400, y: 90 }, [idOf(3)]: { x: 5, y: 5 } }), onCanvas(idOf(1), originNodeId("codex")));
    expect([...planned.keys()]).toEqual([idOf(2)]);
  });
});
