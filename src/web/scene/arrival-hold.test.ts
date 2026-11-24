import type { SessionSummary } from "@shared/types";
import { describe, expect, it } from "vitest";
import { holdLayout, memoryOf, type AutoMemory, type Held } from "./arrival-hold";
import { crowds, gapOf, nearestFree, unionOf, type Point } from "./arrival-slots";
import { agent, bottomOf, columnsOf, COMPACT, DESK, join, kidsOf, moved, NARROW, rectsOf, roots, spot } from "./arrival.fixtures";
import { growth } from "./arrival.growth.fixtures";
import { layoutScene, type LayoutOptions, type SceneLayout } from "./layout";
import { node, overlapsOf, session } from "./layout.fixtures";
import { NODE } from "./layout-geometry";

/**
 * 已有的卡片原地不动、新卡放进下一个空位（LAYOUT2 · W4）：纯函数层的测试。
 * 每个测试里标了“前提”的断言是在确认场景真的走到了要测的那条路径（规划确实把已有的卡重排了、最后一行确实是满的……）。
 * 这里的 `holdLayout` 都不带取景区域（改动前的调用）：根会话在规划给的位置，规划没给就是竖排的一列一直往下接。页面带着取景区域时，根会话按“先填外框里的空格、没有空格再按整体更全的方向开一行或一列”落位（LAYOUT6），那条路在 arrival-grow*.test.ts 与 arrival-columns*.test.ts。
 */

/** 上一次排布是 `before`（页面已经见过它的全部节点），这一次的规划是 `after` 的会话在 `next` 取景下排的结果。 */
function grow(before: readonly SessionSummary[], after: readonly SessionSummary[], options: LayoutOptions = DESK, next: LayoutOptions = options) {
  const base = layoutScene(before, options);
  const plan = layoutScene(after, next);
  const known = new Set(base.nodes.map((n) => n.id));
  return { base, plan, held: holdLayout(plan, memoryOf(base), (id) => known.has(id)) };
}

const expectFull = (held: Held, plan: SceneLayout): void => {
  expect(held.mode).toBe("full");
  expect(held.layout).toBe(plan);
  expect(held.added).toEqual([]);
  expect(held.memory).toEqual(memoryOf(plan));
};

describe("没有新卡：已有的卡一像素不动", () => {
  it("窗口变窄、规划把格子重排了，持有的坐标仍是原来的，外框也是", () => {
    const sessions = roots("cursor:a", 60);
    const { base, plan, held } = grow(sessions, sessions, DESK, NARROW);
    expect(moved(base, plan).length, "前提：规划确实把卡重排了").toBeGreaterThan(0);
    expect(held.mode).toBe("hold");
    expect(held.added).toEqual([]);
    expect(moved(base, held.layout)).toEqual([]);
    expect(held.layout.bounds).toEqual(base.bounds);
    expect(overlapsOf(held.layout)).toEqual([]);
  });

  it("规划没有挪任何已有的卡：持有的就是规划本身（同一个对象），新卡在规划给的位置", () => {
    const { base, plan, held } = grow(roots("cursor:a", 7), roots("cursor:a", 8));
    expect(moved(base, plan), "前提：规划没有重排").toEqual([]);
    expect(held.mode).toBe("hold");
    expect(held.layout).toBe(plan);
    expect(held.added).toEqual([agent("r8")]);
  });
});

describe("根会话追加到已有的格点排布：下一个空位", () => {
  // 规划没有挪已有的卡时新卡就在规划给的格子里；规划换了取景把格子重排了，要自己找空位——两条路的结果必须一样。
  const paths = [
    ["规划没有挪已有的卡", DESK],
    ["规划换了取景、把格子重排了", NARROW],
  ] as const;

  for (const [path, next] of paths) {
    it(`同一行里排在上一张的右边一格 · ${path}`, () => {
      const { base, plan, held } = grow(roots("cursor:a", 60), roots("cursor:a", 61), DESK, next);
      if (next === NARROW) expect(moved(base, plan).length, "前提：规划把已有的卡重排了").toBeGreaterThan(0);
      const last = spot(base, agent("r60"));
      expect(held.mode).toBe("hold");
      expect(moved(base, held.layout)).toEqual([]);
      expect(spot(held.layout, agent("r61"))).toEqual({ x: last.x + 280, y: last.y });
      expect(overlapsOf(held.layout)).toEqual([]);
    });

    it(`满一行换到下一行最左一格，列数不变 · ${path}`, () => {
      const { base, plan, held } = grow(roots("cursor:a", 20), roots("cursor:a", 21), DESK, next);
      if (next === NARROW) expect(moved(base, plan).length, "前提：规划把已有的卡重排了").toBeGreaterThan(0);
      const cols = columnsOf(base);
      expect(20 % cols, "前提：最后一行是满的").toBe(0);
      const first = spot(base, agent("r1"));
      const last = spot(base, agent("r20"));
      expect(moved(base, held.layout)).toEqual([]);
      expect(spot(held.layout, agent("r21"))).toEqual({ x: first.x, y: last.y + 136 });
      expect(columnsOf(held.layout)).toBe(cols);
    });
  }

  it("一张接一张地追加三十张：已有的从不移动，按行从左到右排下去，列数始终不变", () => {
    let sessions = roots("cursor:a", 60);
    let layout = layoutScene(sessions, DESK);
    const cols = columnsOf(layout);
    const first = spot(layout, agent("r1"));
    let memory: AutoMemory = memoryOf(layout);
    const known = new Set(layout.nodes.map((n) => n.id));
    for (let n = 61; n <= 90; n++) {
      sessions = [...sessions, session(`r${n}`, "cursor:a", n)];
      const plan = layoutScene(sessions, DESK);
      const held = holdLayout(plan, memory, (id) => known.has(id));
      expect(held.mode, `r${n}`).toBe("hold");
      expect(moved(layout, held.layout), `r${n}`).toEqual([]);
      expect(spot(held.layout, agent(`r${n}`)), `r${n}`).toEqual({ x: first.x + ((n - 1) % cols) * 280, y: first.y + Math.floor((n - 1) / cols) * 136 });
      expect(overlapsOf(held.layout), `r${n}`).toEqual([]);
      for (const placed of plan.nodes) known.add(placed.id);
      memory = held.memory;
      layout = held.layout;
    }
    expect(columnsOf(layout)).toBe(cols);
  });

  it("不给取景区域时（改动前的调用；页面带着取景区域走的是先填空格、再按更全的方向开行开列，见 arrival-grow.hold.test.ts、arrival-columns.hold.test.ts）从一个根会话起步逐个追加到六十个：每一步已有的卡位移为 0、不重叠，新卡是多出来的唯一一张，排在上一个根会话的正下方", () => {
    // 起步是经典的一列（来源卡在左、会话在右）；规划在第 3 个根会话起换成了网格，持有的排布不跟着换，新卡接着往下排。
    let sessions = roots("cursor:a", 1);
    let layout = layoutScene(sessions, DESK);
    let memory: AutoMemory = memoryOf(layout);
    const known = new Set(layout.nodes.map((n) => n.id));
    let followedPlan = 0;
    for (let n = 2; n <= 60; n++) {
      sessions = [...sessions, session(`r${n}`, "cursor:a", n)];
      const plan = layoutScene(sessions, DESK);
      const held = holdLayout(plan, memory, (id) => known.has(id));
      const last = spot(layout, agent(`r${n - 1}`));
      if (moved(layout, plan).length === 0) followedPlan++;
      expect(held.mode, `r${n}`).toBe("hold");
      expect(moved(layout, held.layout), `r${n}`).toEqual([]);
      expect(held.added, `r${n}`).toEqual([agent(`r${n}`)]);
      expect(spot(held.layout, agent(`r${n}`)), `r${n}`).toEqual({ x: last.x, y: last.y + 136 });
      expect(overlapsOf(held.layout), `r${n}`).toEqual([]);
      for (const placed of plan.nodes) known.add(placed.id);
      memory = held.memory;
      layout = held.layout;
    }
    expect(layout.nodes.filter((n) => n.kind === "agent")).toHaveLength(60);
    expect(followedPlan, "前提：规划在绝大多数步里都把已有的卡重排了（不是规划恰好没动）").toBeLessThan(10);
  });

});

describe("子会话追加在已有的家族里", () => {
  const family = (kids: number): SessionSummary[] => [...roots("cursor:a", 5), session("f", "cursor:a", 9), ...kidsOf("cursor:a", "f", kids, 10)];
  const addKid = (kids: number): SessionSummary[] => [...family(kids), session(`k${kids + 1}`, "cursor:a", 40, { parentSessionId: "f" })];

  it("再添一个：落在上一个子会话的正下方，家族里已有的卡不动", () => {
    const { base, plan, held } = grow(family(4), addKid(4));
    expect(moved(base, plan).length, "前提：规划把家族重排了（走的是找空位这条路）").toBeGreaterThan(0);
    expect(moved(base, held.layout)).toEqual([]);
    const last = spot(base, agent("k4"));
    expect(spot(held.layout, agent("k5"))).toEqual({ x: last.x, y: last.y + 136 });
    expect(overlapsOf(held.layout)).toEqual([]);
  });

  it("家族长大到规划要换一种折法时：照样接在最后一个子会话的下面，不跟着规划换", () => {
    const { base, plan, held } = grow(family(5), addKid(5));
    expect(moved(base, plan).length, "前提：规划把一整片都重排了").toBeGreaterThan(5);
    expect(spot(plan, agent("k6")), "前提：规划里这张卡不在这里").not.toEqual({ x: spot(base, agent("k5")).x, y: spot(base, agent("k5")).y + 136 });
    expect(moved(base, held.layout)).toEqual([]);
    const last = spot(base, agent("k5"));
    expect(spot(held.layout, agent("k6"))).toEqual({ x: last.x, y: last.y + 136 });
    expect(overlapsOf(held.layout)).toEqual([]);
  });

  it("不给取景区域时（改动前的调用；带着取景区域的见 arrival-columns.family.test.ts）逐个追加子会话（4 → 14 个，跨过小家族的界线）：每一步已有的卡一像素不动，新子会话接在上一个的正下方", () => {
    let sessions = family(3);
    let layout = layoutScene(sessions, DESK);
    let memory: AutoMemory = memoryOf(layout);
    const known = new Set(layout.nodes.map((n) => n.id));
    let replanned = 0;
    for (let n = 4; n <= 14; n++) {
      sessions = [...sessions, session(`k${n}`, "cursor:a", 40 + n, { parentSessionId: "f" })];
      const plan = layoutScene(sessions, DESK);
      const held = holdLayout(plan, memory, (id) => known.has(id));
      const last = spot(layout, agent(`k${n - 1}`));
      if (moved(layout, plan).length > 0) replanned++;
      expect(held.mode, `k${n}`).toBe("hold");
      expect(moved(layout, held.layout), `k${n}`).toEqual([]);
      expect(held.added, `k${n}`).toEqual([agent(`k${n}`)]);
      expect(spot(held.layout, agent(`k${n}`)), `k${n}`).toEqual({ x: last.x, y: last.y + 136 });
      expect(overlapsOf(held.layout), `k${n}`).toEqual([]);
      for (const placed of plan.nodes) known.add(placed.id);
      memory = held.memory;
      layout = held.layout;
    }
    expect(replanned, "前提：规划在这些步里有好几步把已有的卡重新排了（走的不是“规划恰好没动”）").toBeGreaterThan(3);
  });

  // 8 × 8 的格点排了 60 个根会话，最后一行只有 4 张：r1 在第一排（它下面和右边的六格全被占着），r57 在最后一行的最左（右边一格是 r58）。
  for (const parentId of ["r1", "r57"]) {
    it(`参照旁边被别家占满：落在离它该去的地方最近的合格空位——不压卡、不挪卡，也没有更近的合格空位 · 上级 ${parentId}`, () => {
      const before = roots("cursor:a", 60);
      const { base, held } = grow(before, [...before, session("c1", "cursor:a", 99, { parentSessionId: parentId })]);
      expect(held.mode).toBe("hold");
      expect(moved(base, held.layout)).toEqual([]);
      expect(overlapsOf(held.layout)).toEqual([]);
      // 它该去的地方：父会话右边一格（已被下一个根会话占着）。
      const parent = spot(base, agent(parentId));
      const ideal = { x: parent.x + 280, y: parent.y };
      const at = spot(held.layout, agent("c1"));
      const size = { w: node(held.layout, agent("c1")).w, h: node(held.layout, agent("c1")).h };
      const gap = gapOf(size, { x: 280, y: 136 });
      const others = rectsOf(held.layout, agent("c1"));
      // 第一排会话卡的顶：子会话不会悬在它之上（那一排之上是来源卡自己的行，LAYOUT4 · W9）。
      const top = Math.min(...base.nodes.filter((n) => n.kind === "agent").map((n) => n.y));
      const distance = (p: Point): number => Math.hypot(p.x - ideal.x, p.y - ideal.y);
      for (let j = -6; j <= 6; j++) {
        for (let i = -6; i <= 6; i++) {
          const candidate = { x: ideal.x + i * 280, y: ideal.y + j * 136 };
          // 不合格的格子不算空位：悬在第一排之上的、落在父会话左边（不在它右边那一列起）的。
          if (candidate.y < top - 0.01 || candidate.x < ideal.x - 0.01) continue;
          if (distance(candidate) >= distance(at) - 0.01) continue;
          const rect = { ...candidate, ...size };
          expect(others.some((other) => crowds(rect, other, gap)), `更近的 (${i}, ${j}) 是空的`).toBe(true);
        }
      }
      // r57 旁边就有空位（r58 的正下方）；r1 周围六格全满、也不许悬到第一排之上，整块放到所有卡的下面。
      expect(at).toEqual({ x: ideal.x, y: bottomOf(base) + NODE.rowGap });
    });
  }

  it("周围都被占满、六格之内没有空位：整块放到所有卡的下面，横向仍靠着它该去的列", () => {
    const sessions = roots("cursor:a", 225);
    const base = layoutScene(sessions, DESK);
    const agents = base.nodes.filter((n) => n.kind === "agent");
    const cx = base.bounds.x + base.bounds.w / 2;
    const cy = base.bounds.y + base.bounds.h / 2;
    const center = agents.slice().sort((p, q) => Math.hypot(p.x - cx, p.y - cy) - Math.hypot(q.x - cx, q.y - cy))[0]!;
    const parent = center.id.slice("agent:".length);
    const { held } = grow(sessions, [...sessions, session("kid", "cursor:a", 999, { parentSessionId: parent })]);
    const ideal = { x: center.x + 280, y: center.y };
    expect(nearestFree(ideal, { w: center.w, h: center.h }, rectsOf(base), { x: 280, y: 136 }), "前提：六格之内没有空位").toBeUndefined();
    expect(moved(base, held.layout)).toEqual([]);
    const placed = spot(held.layout, agent("kid"));
    expect(placed.x).toBe(ideal.x);
    expect(placed.y).toBe(bottomOf(base) + NODE.rowGap);
    expect(overlapsOf(held.layout)).toEqual([]);
  });
});

describe("别家的整块区域也是障碍", () => {
  it("一家人外框里空着的格子（父会话下面）不会被别家的新根会话占用", () => {
    // f 的三个子会话竖排在它右边，父会话正下方留着空格：那一格在 f 这家人的外框里，却没有任何卡。
    const family = [...roots("cursor:a", 2), session("f", "cursor:a", 10), ...kidsOf("cursor:a", "f", 3, 20)];
    const { base, plan, held } = grow(family, [...family, session("z", "cursor:a", 99)], DESK, NARROW);
    expect(moved(base, plan).length, "前提：规划把已有的卡重排了（走的是找空位这条路）").toBeGreaterThan(0);

    const rectOf = (layout: SceneLayout, id: string) => ({ x: node(layout, id).x, y: node(layout, id).y, w: node(layout, id).w, h: node(layout, id).h });
    const box = unionOf(["f", "k1", "k2", "k3"].map((id) => rectOf(base, agent(id)))) as ReturnType<typeof rectOf>;
    const f = rectOf(base, agent("f"));
    const hole = { ...f, y: f.y + 136 };
    const touches = (p: ReturnType<typeof rectOf>, q: ReturnType<typeof rectOf>): boolean => p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
    expect(base.nodes.some((n) => touches(hole, n)), "前提：父会话下面那一格没有卡").toBe(false);
    expect(touches(hole, box), "前提：那一格在 f 这家人的外框里").toBe(true);

    expect(moved(base, held.layout)).toEqual([]);
    expect(touches(rectOf(held.layout, agent("z")), box), "新卡闯进了 f 这家人的外框").toBe(false);
    expect(overlapsOf(held.layout)).toEqual([]);
  });
});

describe("汇聚：新的汇聚会话落在同一来源块里每个上级的右边", () => {
  const eight = roots("cursor:b", 8);
  const withJoin = [...eight, join("C", "cursor:b", 30, ["r1", "r6"])];

  for (const [name, next] of [["规划与上一次同一取景", DESK], ["规划换了取景（把格子重排了）", NARROW]] as const) {
    it(name, () => {
      const { base, plan, held } = grow(eight, withJoin, DESK, next);
      if (next !== DESK) expect(moved(base, plan).length, "前提：规划把已有的卡重排了").toBeGreaterThan(0);
      expect(held.mode).toBe("hold");
      expect(moved(base, held.layout)).toEqual([]);
      const joined = node(held.layout, agent("C"));
      expect(joined.x).toBeGreaterThan(node(held.layout, agent("r1")).x);
      expect(joined.x).toBeGreaterThan(node(held.layout, agent("r6")).x);
      expect(overlapsOf(held.layout)).toEqual([]);
    });
  }
});

describe("新来源：整块放到所有已有的卡下面，左缘对齐，相对位置照规划", () => {
  const before = roots("cursor:a", 6);
  const after = [...before, ...roots("cursor:b", 2, 20, "b")];

  for (const [name, next] of [["宽屏", DESK], ["竖屏", NARROW]] as const) {
    it(name, () => {
      const { base, plan, held } = grow(before, after, DESK, next);
      expect(moved(base, plan).length, "前提：规划把已有的卡重排了（走的是整块放下面这条路）").toBeGreaterThan(0);
      expect(held.mode).toBe("hold");
      expect(moved(base, held.layout)).toEqual([]);
      expect(overlapsOf(held.layout)).toEqual([]);
      const group = ["origin:cursor:b", agent("b1"), agent("b2")];
      const top = Math.min(...group.map((id) => node(held.layout, id).y));
      const left = Math.min(...group.map((id) => node(held.layout, id).x));
      expect(top).toBe(bottomOf(base) + NODE.groupGap);
      expect(left).toBe(Math.min(...base.nodes.map((n) => n.x)));
      // 整块是刚性的：块里各卡之间的相对位置与规划一致。
      for (const id of group) {
        expect(node(held.layout, id).x - node(held.layout, "origin:cursor:b").x, id).toBe(node(plan, id).x - node(plan, "origin:cursor:b").x);
        expect(node(held.layout, id).y - node(held.layout, "origin:cursor:b").y, id).toBe(node(plan, id).y - node(plan, "origin:cursor:b").y);
      }
    });
  }
});

describe("触发整体重排：持有的坐标不再成立，用规划本身", () => {
  const eight = roots("cursor:a", 8);

  it("没有记忆（页面刚打开、换了空间、点了“重置节点布局”之后的第一次）", () => {
    const plan = layoutScene(eight, DESK);
    expectFull(holdLayout(plan, undefined, () => false), plan);
  });

  it("有卡消失了（归档、删除、隐藏未在工作的会话、隐藏相关节点）", () => {
    const { plan, held } = grow(eight, eight.slice(0, 7));
    expectFull(held, plan);
  });

  it("早就见过的卡重新出现了（收起后再显示）：不算新来的", () => {
    const base = layoutScene(eight.slice(0, 7), DESK);
    const plan = layoutScene(eight, DESK);
    expectFull(
      holdLayout(plan, memoryOf(base), () => true),
      plan,
    );
  });

  it("某个会话的上级变了（改挂）", () => {
    const { plan, held } = grow(eight, [...eight.slice(0, 7), session("r8", "cursor:a", 8, { parentSessionId: "r1" })]);
    expectFull(held, plan);
  });

  it("已有的会话多了一个上级（汇聚关系变了）", () => {
    const before = [...roots("cursor:a", 6), session("c", "cursor:a", 30, { parentSessionId: "r1" })];
    const after = [...roots("cursor:a", 6), join("c", "cursor:a", 30, ["r1", "r4"])];
    const { plan, held } = grow(before, after);
    expectFull(held, plan);
  });

  it("卡的尺寸变了（宽屏与窄侧栏之间切换）", () => {
    const { plan, held } = grow(eight, eight, DESK, COMPACT);
    expectFull(held, plan);
  });

  it("相反：只是多了没见过的卡，就不整体重排", () => {
    const { held } = grow(eight, [...eight, session("r9", "cursor:a", 9)]);
    expect(held.mode).toBe("hold");
  });
});

describe("取景标记跟着持有的排布走", () => {
  it("经典的一列排布不会因为规划已是格点排布，就被当成“全部入画”（缩到很小）", () => {
    const { base, plan, held } = grow(roots("cursor:a", 1), roots("cursor:a", 43));
    expect(base.grid, "前提：上一次是经典排布").toBeUndefined();
    expect(plan.grid, "前提：规划已是格点排布，并要求全部入画").toBe(true);
    expect(plan.fitAll).toBe(true);
    expect(held.layout.grid).toBeUndefined();
    expect(held.layout.fitAll).toBeUndefined();
    expect(moved(base, held.layout)).toEqual([]);
    expect(overlapsOf(held.layout)).toEqual([]);
  });

  it("格点排布仍是格点排布", () => {
    const { base, plan, held } = grow(roots("cursor:a", 60), roots("cursor:a", 61), DESK, NARROW);
    expect(base.grid).toBe(true);
    expect(held.layout.grid).toBe(true);
    expect(held.layout.fitAll).toBe(plan.fitAll);
  });
});

describe("随机生长：每一步都满足不变量", () => {
  const seeds = Array.from({ length: 30 }, (_, i) => i + 1);
  for (const [name, options] of [["宽屏", DESK], ["竖屏", NARROW], ["窄区域", COMPACT]] as const) {
    it(`${name}：已有的卡不动、不重叠、顺序与规划一致、汇聚在上级右边（${seeds.length} 个种子 × 24 步）`, () => {
      const failures = seeds.flatMap((seed) => growth(seed, options));
      expect(failures.slice(0, 12)).toEqual([]);
    });
  }
});
