import type { SessionSummary } from "@shared/types";
import { describe, expect, it } from "vitest";
import { fitScale, layoutScene, MIN_ZOOM, type LayoutOptions, type SceneLayout } from "./layout";
import { crossingsOf } from "./layout.crossings.fixtures";
import { overlapsOf, session } from "./layout.fixtures";
import { goldenCases } from "./layout.golden.fixtures";
import { REAL_CANVASES, realSessions } from "./layout.real.fixtures";
import { SMALL_FAMILY } from "./layout-plan";

/**
 * 小家族（后代数 ≤ SMALL_FAMILY）的子会话竖排在父会话右边一列，线走父子之间的缝（LAYOUT2 · W2）：
 * 版式、界线、“线不穿卡”、大扇出不变，以及三块真实画布的缩放不退化。
 * 来源卡发出的线（“来源 → 根会话”的大扇出）不在这条规则里，各用例都把它们排除在外。
 */

const KEY = "cursor:family";

/** 取景区域：桌面、竖屏、窄区域（紧凑模式）。 */
const AREAS = {
  桌面: { w: 1088, h: 610 },
  竖屏: { w: 720, h: 1000 },
  窄区域: { w: 288, h: 544 },
} as const;

const singles = (count: number, from = 1): SessionSummary[] => Array.from({ length: count }, (_, i) => session(`s${from + i}`, KEY, from + i));

/** 一个根带 `kids` 个叶子子会话。 */
const family = (root: string, kids: number, from: number): SessionSummary[] => [
  session(root, KEY, from),
  ...Array.from({ length: kids }, (_, i) => session(`${root}-${i + 1}`, KEY, from + 1 + i, { parentSessionId: root })),
];

const plan = (sessions: SessionSummary[], area: LayoutOptions["area"]): SceneLayout => layoutScene(sessions, { area, grid: true, hideContextNodes: true });
const at = (layout: SceneLayout, id: string) => {
  const found = layout.nodes.find((node) => node.id === `agent:${id}`);
  if (!found) throw new Error(`没有节点 ${id}`);
  return found;
};
const notFromOrigin = (edge: { from: string }): boolean => !edge.from.startsWith("origin:");

describe("小家族 · 子会话竖排在父会话右边", () => {
  for (const [name, area] of Object.entries(AREAS)) {
    for (const kids of [2, 3, 4, SMALL_FAMILY]) {
      it(`${name} · ${kids} 个子会话：同一列、一个挨一个，父会话在它们左边一列并竖直居中`, () => {
        const layout = plan([...singles(14), ...family("fam", kids, 20)], area);
        expect(layout.grid).toBe(true);
        const parent = at(layout, "fam");
        const children = Array.from({ length: kids }, (_, i) => at(layout, `fam-${i + 1}`));
        // 同一列，且就在父会话右边的下一格。
        expect(new Set(children.map((child) => child.x)).size).toBe(1);
        const pitchX = (children[0]?.x ?? 0) - parent.x;
        expect(pitchX).toBeGreaterThan(parent.w);
        // 一个挨一个：相邻两个的间距就是一个行距，整列没有空行。
        const pitchY = (children[1]?.y ?? 0) - (children[0]?.y ?? 0);
        expect(pitchY).toBeGreaterThan(parent.h);
        children.forEach((child, i) => expect(child.y).toBe((children[0]?.y ?? 0) + i * pitchY));
        // 父会话竖直居中（偶数个时靠上半格，见 layout-fold 的 parentRow）。
        expect(parent.y).toBe((children[0]?.y ?? 0) + Math.floor((kids - 1) / 2) * pitchY);
      });
    }
  }

  it("嵌套的小家族：子会话的子会话在再右一列，各占各的行，别的子会话不插进来", () => {
    const sessions = [
      ...singles(14),
      session("r", KEY, 20),
      session("r-a", KEY, 21, { parentSessionId: "r" }),
      session("r-b", KEY, 22, { parentSessionId: "r" }),
      session("r-a1", KEY, 23, { parentSessionId: "r-a" }),
      session("r-a2", KEY, 24, { parentSessionId: "r-a" }),
    ];
    const layout = plan(sessions, AREAS.桌面);
    const [a, b, a1, a2] = ["r-a", "r-b", "r-a1", "r-a2"].map((id) => at(layout, id)) as [ReturnType<typeof at>, ReturnType<typeof at>, ReturnType<typeof at>, ReturnType<typeof at>];
    expect(a.x).toBe(b.x);
    expect(a1.x).toBe(a2.x);
    expect(a1.x).toBeGreaterThan(a.x);
    // a 带两个子会话占两行，b 在它们下面：b 不会落在 a 的两个子会话之间。
    expect(a2.y).toBeGreaterThan(a1.y);
    expect(b.y).toBeGreaterThan(a2.y);
  });
});

describe("小家族 · 线只走缝隙，不穿过别的卡", () => {
  const scenes: [string, SessionSummary[]][] = [
    ["一个小家族加单卡", [...singles(14), ...family("fam", 4, 20)]],
    ["三个小家族并排加单卡", [...singles(10), ...family("f1", 2, 20), ...family("f2", 3, 30), ...family("f3", 5, 40)]],
    [
      "嵌套的小家族",
      [
        ...singles(12),
        session("r", KEY, 20),
        session("r-a", KEY, 21, { parentSessionId: "r" }),
        session("r-b", KEY, 22, { parentSessionId: "r" }),
        session("r-a1", KEY, 23, { parentSessionId: "r-a" }),
        session("r-a2", KEY, 24, { parentSessionId: "r-a" }),
      ],
    ],
    ["小家族与一个大扇出并存（只看小家族）", [...singles(8), ...family("fam", 3, 20), ...family("big", 9, 30)]],
  ];

  for (const [name, sessions] of scenes) {
    for (const [areaName, area] of Object.entries(AREAS)) {
      it(`${name} · ${areaName}`, () => {
        const layout = plan(sessions, area);
        expect(layout.grid).toBe(true);
        expect(overlapsOf(layout)).toEqual([]);
        // 大扇出（big）的 9 个子会话本来就按容器折，它的线照旧可能穿卡：只看后代数在界线内的家族发出的线。
        const smallParents = new Set(["fam", "f1", "f2", "f3", "r", "r-a"].map((id) => `agent:${id}`));
        expect(crossingsOf(layout, (edge) => notFromOrigin(edge) && smallParents.has(edge.from))).toEqual([]);
      });
    }
  }
});

describe("小家族的界线", () => {
  const spread = (layout: SceneLayout, ids: string[]): number => new Set(ids.map((id) => at(layout, id).x)).size;
  const kidIds = (root: string, count: number): string[] => Array.from({ length: count }, (_, i) => `${root}-${i + 1}`);

  it(`${SMALL_FAMILY} 个子会话还是一列，${SMALL_FAMILY + 1} 个就是大扇出：按容器折成多列`, () => {
    const small = plan([...singles(14), ...family("fam", SMALL_FAMILY, 20)], AREAS.桌面);
    expect(spread(small, kidIds("fam", SMALL_FAMILY))).toBe(1);
    const big = plan([...singles(14), ...family("fam", SMALL_FAMILY + 1, 20)], AREAS.桌面);
    expect(spread(big, kidIds("fam", SMALL_FAMILY + 1))).toBeGreaterThan(1);
  });

  it("界线按后代数（含子孙）算：根带 2 个子会话、其中一个再带 4 个共 6 个后代，根不竖排，但带 4 个子会话的那个子会话仍竖排", () => {
    const sessions = [
      ...singles(14),
      session("r", KEY, 20),
      session("r-a", KEY, 21, { parentSessionId: "r" }),
      session("r-b", KEY, 22, { parentSessionId: "r" }),
      ...kidIds("r-a", 4).map((id, i) => session(id, KEY, 23 + i, { parentSessionId: "r-a" })),
    ];
    const layout = plan(sessions, AREAS.桌面);
    expect(spread(layout, kidIds("r-a", 4))).toBe(1);
    // 根自己的两个子会话没有被竖排规则管（它有 6 个后代）：不要求同一列，只要求各不重叠。
    expect(overlapsOf(layout)).toEqual([]);
  });

  it("大扇出照旧：11、16、37 个子会话都按容器折成多列", () => {
    for (const kids of [11, 16, 37]) {
      const layout = plan([...singles(6), ...family("big", kids, 20)], AREAS.桌面);
      expect(spread(layout, kidIds("big", kids)), `${kids} 个子会话`).toBeGreaterThan(1);
    }
  });

  it("来源卡的会话（来源下的根会话）不受竖排影响：20 个根会话仍排成网格，不是一列", () => {
    const layout = plan(singles(20), AREAS.桌面);
    expect(new Set(layout.nodes.filter((n) => n.kind === "agent").map((n) => n.x)).size).toBeGreaterThan(1);
  });
});

describe("小家族 · 别家的卡不挤在父会话上下紧挨着的格子里", () => {
  // 家族先于单卡创建（单卡在后面见缝插针的机会最大）与后于单卡创建，两种先后都要守住。
  const orders: [string, () => SessionSummary[]][] = [
    ["单卡先、家族后", () => [...singles(14), ...family("f1", 4, 20), ...family("f2", 3, 30)]],
    ["家族先、单卡后", () => [...family("f1", 4, 1), ...family("f2", 3, 10), ...singles(14, 100)]],
  ];
  for (const [name, build] of orders) {
    for (const [areaName, area] of Object.entries(AREAS)) {
      it(`${name} · ${areaName}：父会话那一列里，家族占着的几行除了它自己没有别的卡`, () => {
        const layout = plan(build(), area);
        for (const [root, kids] of [
          ["f1", 4],
          ["f2", 3],
        ] as const) {
          const parent = at(layout, root);
          const first = at(layout, `${root}-1`);
          const last = at(layout, `${root}-${kids}`);
          const intruders = layout.nodes.filter((n) => n.kind === "agent" && n.id !== parent.id && n.x === parent.x && n.y >= first.y && n.y <= last.y);
          expect(intruders.map((n) => n.id), `${root} 父会话那一列里的闯入者`).toEqual([]);
        }
      });
    }
  }
});

/**
 * 小家族父会话（后代数 1 ~ SMALL_FAMILY，来源卡除外）发出的树边：每个节点的第一条入边。
 * 汇聚补出来的线（第二条起的入边）与 Folder / Git 的 link 不在这条规则里。
 */
function smallFamilyEdges(layout: SceneLayout): Set<string> {
  const parentOf = new Map<string, string>();
  const edgeOf = new Map<string, string>();
  for (const edge of layout.edges) {
    if (edge.phase === "link" || parentOf.has(edge.to)) continue;
    parentOf.set(edge.to, edge.from);
    edgeOf.set(edge.to, edge.id);
  }
  const kids = new Map<string, string[]>();
  for (const [child, parent] of parentOf) kids.set(parent, [...(kids.get(parent) ?? []), child]);
  const descendants = (id: string): number => (kids.get(id) ?? []).reduce((sum, kid) => sum + 1 + descendants(kid), 0);
  const found = new Set<string>();
  for (const [child, parent] of parentOf) {
    if (parent.startsWith("origin:")) continue;
    const count = descendants(parent);
    if (count >= 1 && count <= SMALL_FAMILY) found.add(edgeOf.get(child) as string);
  }
  return found;
}

describe("小家族 · golden 的全部格点用例与真实画布：线不穿卡", () => {
  it("golden 里每个走了格点排布的用例：小家族父会话发出的树边都没有从非端点的卡片上经过", () => {
    let examined = 0;
    const offenders: string[] = [];
    for (const entry of goldenCases()) {
      const layout = layoutScene(entry.sessions, entry.options);
      if (layout.grid !== true) continue;
      const mine = smallFamilyEdges(layout);
      examined += mine.size;
      for (const hit of crossingsOf(layout, (edge) => mine.has(edge.id))) offenders.push(`${entry.name}：${hit}`);
    }
    expect(examined, "前提：这些用例里确有小家族的线（不是空转）").toBeGreaterThan(300);
    expect(offenders.slice(0, 8)).toEqual([]);
  });

  it("6 块真实画布 × 3 个窗口（1440×900、1920×1080、1280×720）：同上", () => {
    let examined = 0;
    const offenders: string[] = [];
    for (const canvas of REAL_CANVASES) {
      for (const area of [{ w: 1088, h: 710 }, { w: 1568, h: 890 }, { w: 928, h: 530 }]) {
        const layout = layoutScene(realSessions(canvas), { area, grid: true, hideContextNodes: true });
        const mine = smallFamilyEdges(layout);
        examined += mine.size;
        for (const hit of crossingsOf(layout, (edge) => mine.has(edge.id))) offenders.push(`${canvas.name} @ ${area.w}×${area.h}：${hit}`);
      }
    }
    expect(examined, "前提：真实画布里确有小家族的线（不是空转）").toBeGreaterThan(100);
    expect(offenders.slice(0, 8)).toEqual([]);
  });
});

describe("真实画布的缩放不退化（对 LAYOUT2 之前的默认缩放）", () => {
  // 取景区域与 layout.real.test.ts 一致（对应 1440×900、1920×1080、1280×720 的窗口）；数字是 LAYOUT2 之前量出来的默认缩放（取景后）。
  const windows = [
    { w: 1088, h: 710 },
    { w: 1568, h: 890 },
    { w: 928, h: 530 },
  ] as const;
  // 家族都不在竖排界线内（11、12、16、37 个子会话）或根本没有家族的画布：缩放必须与之前一样。
  const unchanged: Record<string, readonly [number, number, number]> = {
    "70b49d0d": [0.378, 0.51, 0.304],
    "299997f3": [0.66, 0.836, 0.498],
    "88e325d7": [0.592, 0.813, 0.481],
    "7c1805af": [0.795, 1, 0.669],
    "71e659dc": [1, 1, 1],
  };
  // 7295d4f1 里有 8 个只带 1 个子会话的根，以及那棵 21 个后代的大家族里 6 个后代数为 1 ~ 2 的非根父会话；它们的子会话现在竖排成列、装箱少了灵活性，整张网格多一行：
  // 1920 与 1280 下略降（71.0 → 66.6%、42.0 → 39.7%），这里钉住新的数字。
  const slightlyLower: Record<string, readonly [number, number, number]> = { "7295d4f1": [0.493, 0.666, 0.397] };

  for (const [table, entries] of [
    ["缩放与之前一样", unchanged],
    ["缩放略降（已知）", slightlyLower],
  ] as const) {
    for (const [name, expected] of Object.entries(entries)) {
      it(`${name} · ${table}`, () => {
        const canvas = REAL_CANVASES.find((candidate) => candidate.name.startsWith(name));
        expect(canvas, `没有这块真实画布 ${name}`).toBeDefined();
        windows.forEach((area, i) => {
          const layout = layoutScene(realSessions(canvas!), { area, grid: true, hideContextNodes: true });
          const shown = fitScale(layout.bounds, area, MIN_ZOOM, true);
          // 差不到 0.1 个百分点（取景缩放的取整）。
          expect(shown, `${name} @ ${area.w}×${area.h}`).toBeGreaterThanOrEqual((expected[i] as number) - 0.001);
        });
      });
    }
  }
});
