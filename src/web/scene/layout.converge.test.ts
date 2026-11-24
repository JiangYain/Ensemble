import type { SessionSummary } from "@shared/types";
import { describe, expect, it } from "vitest";
import { layoutScene, type LayoutOptions, type SceneLayout } from "./layout";
import { crossingsOf } from "./layout.crossings.fixtures";
import { overlapsOf, session } from "./layout.fixtures";
import { createFoldTree, placeKids, type Spot } from "./layout-fold";
import { settleBlock } from "./layout-converge";

/**
 * 汇聚（一个会话有多个上级）：汇聚会话所在的列严格大于同一来源块里每个上级所在的列（LAYOUT2 · W3）。
 * 规则在两种排法里都成立（经典的树、格点排布），上级在别的来源块里的不参与；没必要时不挪动，挪动时不留空洞。
 */

const roots = (key: string, ids: string[], from = 1): SessionSummary[] => ids.map((id, i) => session(id, key, from + i));
const kidsOf = (key: string, parent: string, ids: string[], from: number): SessionSummary[] => ids.map((id, i) => session(id, key, from + i, { parentSessionId: parent }));
const join = (id: string, key: string, order: number, parents: string[]): SessionSummary => session(id, key, order, { parentSessionId: parents[0], parentSessionIds: parents });

/** 任务书里的五个场景：A 两个上级各带 3 个子会话、B 八个根会话里汇聚 1 与 6、C 十二个根会话里两个汇聚、D 菱形、E 跨来源块。 */
const SCENES: Record<string, () => SessionSummary[]> = {
  A: () => [...roots("cursor:a", ["P1", "P2"]), ...kidsOf("cursor:a", "P1", ["P1a", "P1b", "P1c"], 10), ...kidsOf("cursor:a", "P2", ["P2a", "P2b", "P2c"], 20), join("C", "cursor:a", 30, ["P1", "P2"])],
  B: () => [...roots("cursor:b", ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"]), join("C", "cursor:b", 30, ["r1", "r6"])],
  C: () => [
    ...roots("cursor:c", Array.from({ length: 12 }, (_, i) => `r${i + 1}`)),
    join("C1", "cursor:c", 30, ["r1", "r12"]),
    join("C2", "cursor:c", 31, ["r3", "r4", "r9"]),
  ],
  D: () => [...roots("cursor:d", ["R"]), ...kidsOf("cursor:d", "R", ["A", "B"], 10), join("C", "cursor:d", 30, ["A", "B"])],
  E: () => [
    ...roots("cursor:x", ["x1", "x2", "x3", "x4"]),
    ...roots("cursor:y", ["y1", "y2", "y3"], 10),
    join("CX", "cursor:x", 30, ["x1", "y2"]),
    join("CY", "cursor:y", 31, ["y1", "x3", "y3"]),
  ],
};

/** 取景：桌面、竖屏、窄区域（紧凑模式）、以及不规划的经典排法。 */
const OPTIONS: Record<string, LayoutOptions> = {
  桌面: { area: { w: 1088, h: 610 }, grid: true, hideContextNodes: true },
  竖屏: { area: { w: 720, h: 1000 }, grid: true, hideContextNodes: true },
  窄区域: { area: { w: 288, h: 544 }, grid: true },
  经典: { area: { w: 1088, h: 610 } },
};

const xOf = (layout: SceneLayout, id: string): number => {
  const found = layout.nodes.find((node) => node.id === `agent:${id}`);
  if (!found) throw new Error(`没有节点 ${id}`);
  return found.x;
};

/** 会话所在的来源块：沿第一个上级上溯到根，取根的来源（与排布里“来源块”的划分一致）。 */
function blockOf(sessions: readonly SessionSummary[], id: string): string {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  let cursor = byId.get(id) as SessionSummary;
  while (cursor.parentSessionId !== undefined && byId.has(cursor.parentSessionId)) cursor = byId.get(cursor.parentSessionId) as SessionSummary;
  return cursor.origin.key;
}

/** 违反规则的汇聚：汇聚会话的 x 没有严格大于某个同块上级的 x。 */
function violations(sessions: readonly SessionSummary[], layout: SceneLayout): string[] {
  const found: string[] = [];
  for (const s of sessions) {
    const parents = s.parentSessionIds ?? [];
    if (parents.length < 2) continue;
    for (const parent of parents) {
      if (blockOf(sessions, parent) !== blockOf(sessions, s.id)) continue;
      if (xOf(layout, s.id) <= xOf(layout, parent)) found.push(`${s.id}@${xOf(layout, s.id)} 不在 ${parent}@${xOf(layout, parent)} 的右边`);
    }
  }
  return found;
}

describe("汇聚 · 列严格大于同一来源块里每个上级的列", () => {
  for (const [scene, build] of Object.entries(SCENES)) {
    for (const [name, options] of Object.entries(OPTIONS)) {
      it(`场景 ${scene} · ${name}`, () => {
        const sessions = build();
        const layout = layoutScene(sessions, options);
        expect(violations(sessions, layout)).toEqual([]);
        expect(overlapsOf(layout)).toEqual([]);
      });
    }
  }

  it("连线：每个（上级，汇聚会话）一条，指向汇聚会话的第一条是树里挂着的那一个（主上级）", () => {
    const sessions = (SCENES.C as () => SessionSummary[])();
    const layout = layoutScene(sessions, OPTIONS.桌面);
    const into = (id: string) => layout.edges.filter((edge) => edge.to === `agent:${id}`).map((edge) => edge.from);
    expect(into("C1")).toEqual(["agent:r1", "agent:r12"]);
    expect(into("C2")).toEqual(["agent:r3", "agent:r4", "agent:r9"]);
    expect(new Set(layout.edges.map((edge) => edge.id)).size).toBe(layout.edges.length);
  });
});

describe("汇聚 · 上级在别的来源块里的不参与", () => {
  it("场景 E：汇聚会话的位置只由同一来源块里的上级决定，去掉跨块的那几条连线它也一样", () => {
    const sessions = (SCENES.E as () => SessionSummary[])();
    // 去掉跨块上级：CX 只剩 x1，CY 只剩 y1 与 y3。
    const trimmed = sessions.map((s) => {
      if (s.id === "CX") return session("CX", "cursor:x", 30, { parentSessionId: "x1" });
      if (s.id === "CY") return join("CY", "cursor:y", 31, ["y1", "y3"]);
      return s;
    });
    for (const [name, options] of Object.entries(OPTIONS)) {
      const full = layoutScene(sessions, options);
      const same = layoutScene(trimmed, options);
      expect(full.nodes.map((n) => [n.id, n.x, n.y]), name).toEqual(same.nodes.map((n) => [n.id, n.x, n.y]));
    }
  });
});

describe("汇聚 · 没必要就不挪，挪了也不留空洞", () => {
  it("场景 B：两个上级都在第 0 列，汇聚会话就在它们右边一格（紧挨着第一个上级），没有被推到更远", () => {
    const layout = layoutScene((SCENES.B as () => SessionSummary[])(), OPTIONS.桌面);
    const r1 = layout.nodes.find((n) => n.id === "agent:r1");
    const c = layout.nodes.find((n) => n.id === "agent:C");
    expect(c?.y).toBe(r1?.y);
    expect((c?.x ?? 0) - (r1?.x ?? 0)).toBeGreaterThan(r1?.w ?? 0);
    expect((c?.x ?? 0) - (r1?.x ?? 0)).toBeLessThan((r1?.w ?? 0) * 1.5);
    // 紧挨着的相邻两列之间线走缝隙，不穿卡。
    expect(crossingsOf(layout, (edge) => edge.to === "agent:C")).toEqual([]);
  });

  it("场景 C：被右移的两个汇聚会话不留空洞——另外 12 个根会话仍排满规则的网格（行数 = ⌈12 ÷ 列数⌉）", () => {
    for (const name of ["桌面", "竖屏"]) {
      const layout = layoutScene((SCENES.C as () => SessionSummary[])(), OPTIONS[name]);
      const plain = layout.nodes.filter((n) => n.kind === "agent" && n.id !== "agent:C1" && n.id !== "agent:C2");
      expect(plain).toHaveLength(12);
      const cols = new Set(plain.map((n) => n.x)).size;
      expect(new Set(plain.map((n) => n.y)).size, name).toBe(Math.ceil(12 / cols));
    }
  });

  it("场景 D：菱形里汇聚会话在 A、B 的右边一格，线都在缝里", () => {
    const layout = layoutScene((SCENES.D as () => SessionSummary[])(), OPTIONS.桌面);
    expect(crossingsOf(layout, (edge) => edge.to === "agent:C")).toEqual([]);
  });
});

describe("settleBlock · 格点排布里汇聚会话的摆法", () => {
  const kids =
    (tree: Record<string, readonly string[]>) =>
    (id: string): readonly string[] =>
      tree[id] ?? [];

  it("没有汇聚：一格不动，与直接折出来的完全一样（moved 为假）", () => {
    const tree = createFoldTree(kids({ o: ["a", "b", "c", "d"], a: ["a1"] }), 8);
    const plain = new Map<string, Spot>();
    placeKids(tree, "o", 3, 1, 0, plain);
    for (const joins of [undefined, new Map<string, string[]>()]) {
      const result = settleBlock(tree, "o", false, 3, joins);
      expect(result.moved).toBe(false);
      expect([...result.spots]).toEqual([...plain]);
    }
  });

  it("汇聚本来就满足（汇聚会话天生落在所有上级的右边）：同样一格不动", () => {
    // 容器两列宽：a 在第 1 列、它的子会话 c 在 a 右边一格，b 排在 a 下面——两个上级都在 c 的左边。
    const tree = createFoldTree(kids({ o: ["a", "b"], a: ["c"] }), 8);
    const plain = new Map<string, Spot>();
    placeKids(tree, "o", 2, 1, 0, plain);
    const result = settleBlock(tree, "o", false, 2, new Map([["c", ["a", "b"]]]));
    expect(result.moved).toBe(false);
    expect([...result.spots]).toEqual([...plain]);
  });

  it("折出来违反时：摘掉汇聚会话重折，其余会话补上它留下的位置（没有空洞），汇聚会话落在最右一个上级的右边", () => {
    // 容器三列宽：直接折会把 b 排到 c 的右边（c 与 b 的上级关系被反过来）；摘掉 c 之后 a、b 紧挨着，c 再放到它们右边。
    const tree = createFoldTree(kids({ o: ["a", "b"], a: ["c"] }), 8);
    const { spots, moved } = settleBlock(tree, "o", false, 3, new Map([["c", ["a", "b"]]]));
    expect(moved).toBe(true);
    expect(Object.fromEntries(spots)).toEqual({ a: { col: 1, row: 0 }, b: { col: 2, row: 0 }, c: { col: 3, row: 0 } });
  });

  it("违反时汇聚会话（连同它的子树）整块移到所有上级的右边；别的会话的格子不重叠、都在来源卡留出的行列之外", () => {
    // o 下六个根；e 同时跟随 a 与 f（f 在第 2 列）；e 带一个子会话 e1，e1 又同时跟随 e 与 d。
    const shape = { o: ["a", "b", "c", "d", "f"], a: ["e"], e: ["e1"] };
    const tree = createFoldTree(kids(shape), 8);
    const joins = new Map<string, string[]>([
      ["e", ["a", "f"]],
      ["e1", ["e", "d"]],
    ]);
    for (const top of [true, false]) {
      const { spots, moved } = settleBlock(tree, "o", top, 3, joins);
      expect(moved).toBe(true);
      const col = (id: string): number => (spots.get(id) as Spot).col;
      expect(col("e")).toBeGreaterThan(col("a"));
      expect(col("e")).toBeGreaterThan(col("f"));
      expect(col("e1")).toBeGreaterThan(col("e"));
      expect(col("e1")).toBeGreaterThan(col("d"));
      // 每张卡一个格子，没有两张卡同格；来源卡占的第 0 行（在上）或第 0 列（在左）不能被会话占去。
      const cells = [...spots.values()].map((s) => `${s.col},${s.row}`);
      expect(new Set(cells).size).toBe(cells.length);
      for (const spot of spots.values()) expect(top ? spot.row : spot.col).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("汇聚 · 随机的有向无环图（确定的随机数）：规则与不重叠恒成立", () => {
  /** mulberry32：同一个种子永远同一串数。 */
  const rng = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  const build = (seed: number): SessionSummary[] => {
    const next = rng(seed);
    const count = 4 + Math.floor(next() * 26);
    const keys = ["cursor:p", "cursor:q"];
    const list: SessionSummary[] = [];
    for (let i = 0; i < count; i++) {
      const id = `s${i}`;
      const earlier = list.map((s) => s.id);
      const root = earlier.length === 0 || next() < 0.5;
      const first = root ? undefined : (earlier[Math.floor(next() * earlier.length)] as string);
      // 子会话与它的树里的上级同一个来源；根会话随机取一个来源。
      const key = first === undefined ? (keys[Math.floor(next() * keys.length)] as string) : (list.find((s) => s.id === first) as SessionSummary).origin.key;
      const parents = first === undefined ? [] : [first];
      // 二成的会话再多挂 1 ~ 2 个更早的上级（可以在别的来源块里）。
      if (first !== undefined && next() < 0.3) {
        for (const extra of [earlier[Math.floor(next() * earlier.length)], earlier[Math.floor(next() * earlier.length)]]) {
          if (extra !== undefined && !parents.includes(extra) && next() < 0.7) parents.push(extra);
        }
      }
      list.push(session(id, key, i + 1, parents.length === 0 ? {} : { parentSessionId: parents[0] as string, parentSessionIds: parents }));
    }
    return list;
  };

  for (let seed = 1; seed <= 40; seed++) {
    it(`种子 ${seed}`, () => {
      const sessions = build(seed);
      for (const [name, options] of Object.entries(OPTIONS)) {
        const layout = layoutScene(sessions, options);
        expect(violations(sessions, layout), `${name}`).toEqual([]);
        expect(overlapsOf(layout), `${name}`).toEqual([]);
      }
    });
  }
});
