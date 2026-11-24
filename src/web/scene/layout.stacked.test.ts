import type { SessionSummary } from "@shared/types";
import { describe, expect, it } from "vitest";
import { cellsFor } from "./layout-cells";
import { MIN_STACKED, stacksSingles } from "./layout-stacked";
import { overlapsOf, session } from "./layout.fixtures";
import { agentNodeId, layoutScene, NODE, originNodeId, type SceneLayout } from "./layout";

/**
 * 少量根会话不再排成“单列竖堆 + 错位”（W1）：
 * - 横屏的取景区域里，只有一个来源、且至少有 3 个单卡根会话时，经典排法即使放得下也不再直接保留，改试格点网格：放得进缩放上限才换下经典排法（放不进时仍保留，见 layout.select.test.ts）；竖屏仍允许单列；
 * - 规划式排布里同一列的卡左缘在同一个 x 上（经典排法里奇偶行错开 24px 的那一处已去掉）；不规划的经典排法保持原样。
 */

const options = { grid: true, hideContextNodes: true } as const;
/** 1440×900 视口的取景区域（Overview 量化到 16px 之后）：5 个根会话单列竖堆的问题就出在这块区域上。 */
const AREA_1440 = { w: 1088, h: 704 };

/** 同一来源名下 count 个互不相干的根会话；`from` 是第一个会话创建的先后（秒）。 */
const singles = (count: number, key = "cursor:few", from = 1): SessionSummary[] => Array.from({ length: count }, (_, i) => session(`${key}-${i + 1}`, key, from + i));
const agentsOf = (layout: SceneLayout) => layout.nodes.filter((n) => n.kind === "agent");
const distinct = (values: readonly number[]): number => new Set(values).size;

describe("stacksSingles · 判定", () => {
  const landscape = { w: 1088, h: 704 };
  const roots = (list: readonly SessionSummary[], key = "cursor:few") => new Map([[key, list]]);
  const none = new Map<string, unknown>();

  it("横屏、单来源、至少 3 个单卡根会话才成立；2 个不成立", () => {
    expect(MIN_STACKED).toBe(3);
    expect(stacksSingles(landscape, 1, roots(singles(2)), none)).toBe(false);
    expect(stacksSingles(landscape, 1, roots(singles(3)), none)).toBe(true);
    expect(stacksSingles(landscape, 1, roots(singles(11)), none)).toBe(true);
  });

  it("竖屏（高 > 宽）允许单列；宽等于高算横屏", () => {
    expect(stacksSingles({ w: 704, h: 1088 }, 1, roots(singles(5)), none)).toBe(false);
    expect(stacksSingles({ w: 704, h: 705 }, 1, roots(singles(5)), none)).toBe(false);
    expect(stacksSingles({ w: 704, h: 704 }, 1, roots(singles(5)), none)).toBe(true);
    expect(stacksSingles({ w: 705, h: 704 }, 1, roots(singles(5)), none)).toBe(true);
  });

  it("多个来源并排时不管：来源之间本来就是左右并列的列", () => {
    expect(stacksSingles(landscape, 2, roots(singles(5)), none)).toBe(false);
  });

  it("带子会话的根会话不数：3 个根各带一个子会话不成立，3 个单卡加一棵树成立", () => {
    const list = singles(3);
    const withKids = new Map<string, unknown>(list.map((root) => [root.id, [root]]));
    expect(stacksSingles(landscape, 1, roots(list), withKids)).toBe(false);
    const oneTree = new Map<string, unknown>([[list[0]!.id, [list[1]]]]);
    expect(stacksSingles(landscape, 1, roots(list), oneTree)).toBe(false); // 单卡只剩 2 个
    expect(stacksSingles(landscape, 1, roots([...list, ...singles(1, "x")]), oneTree)).toBe(true); // 单卡 3 个（加上一棵树）
  });
});

describe("layoutScene · 少量根会话（规划式排布）", () => {
  it("1440×900 下 5 个根会话不再是单列竖堆：排成网格，来源卡在上居中，同一列的卡左缘相同", () => {
    const layout = layoutScene(singles(5), { area: AREA_1440, ...options });
    expect(layout.grid).toBe(true);
    const xs = agentsOf(layout).map((n) => n.x);
    expect(distinct(xs)).toBeGreaterThanOrEqual(2);
    // 格点：所有会话卡的左缘都落在 minX + k × 一格宽 上，没有 24px 之类的零头。
    const pitch = cellsFor(false).pitchX;
    const min = Math.min(...xs);
    for (const x of xs) expect((x - min) % pitch).toBe(0);
    const origin = layout.nodes.find((n) => n.id === originNodeId("cursor:few"))!;
    expect(origin.y).toBe(0);
    expect(overlapsOf(layout)).toEqual([]);
  });

  it("横屏里 3 ~ 11 个根会话都不是单列", () => {
    for (let count = MIN_STACKED; count <= 11; count++) {
      const layout = layoutScene(singles(count), { area: AREA_1440, ...options });
      expect(layout.grid, `${count} 个根会话`).toBe(true);
      expect(distinct(agentsOf(layout).map((n) => n.x)), `${count} 个根会话的列数`).toBeGreaterThanOrEqual(2);
      expect(overlapsOf(layout), `${count} 个根会话`).toEqual([]);
    }
  });

  it("1 ~ 2 个根会话保持经典的样子：来源卡在左、卡片在右，同一列左缘相同（不错位）", () => {
    for (const count of [1, 2]) {
      const layout = layoutScene(singles(count), { area: AREA_1440, ...options });
      expect(layout.grid, `${count} 个根会话`).toBeUndefined();
      const origin = layout.nodes.find((n) => n.id === originNodeId("cursor:few"))!;
      const xs = agentsOf(layout).map((n) => n.x);
      expect(distinct(xs)).toBe(1);
      expect(xs[0]).toBe(origin.x + NODE.originW + NODE.originGap);
    }
  });

  it("竖屏（高 > 宽）下允许单列：5 个根会话仍是一列，左缘相同", () => {
    const layout = layoutScene(singles(5), { area: { w: 704, h: 1088 }, ...options });
    expect(layout.grid).toBeUndefined();
    expect(distinct(agentsOf(layout).map((n) => n.x))).toBe(1);
  });

  it("多个来源并排时这条规则不管：两个来源各 3 个根会话仍可以保持经典的并排", () => {
    const sessions = [...singles(3, "cursor:a"), ...singles(3, "cursor:b", 10)];
    const layout = layoutScene(sessions, { area: { w: 1600, h: 800 }, ...options });
    expect(layout.grid).toBeUndefined();
  });

  it("经典的树里没有错位：两个根各带一个子会话，根的左缘相同、子会话的左缘也相同", () => {
    const sessions = [
      session("r1", "cursor:t", 1),
      session("r2", "cursor:t", 2),
      session("c1", "cursor:t", 3, { parentSessionId: "r1", depth: 1 }),
      session("c2", "cursor:t", 4, { parentSessionId: "r2", depth: 1 }),
    ];
    const layout = layoutScene(sessions, { area: { w: 1600, h: 900 }, ...options });
    expect(layout.grid).toBeUndefined();
    const x = (id: string): number => layout.nodes.find((n) => n.id === agentNodeId(id))!.x;
    expect(x("r1")).toBe(x("r2"));
    expect(x("c1")).toBe(x("c2"));
  });

  it("范围守卫：不规划的经典排法（不给 grid）仍保留奇偶行 24px 的错位", () => {
    const layout = layoutScene(singles(2), { area: AREA_1440, hideContextNodes: true });
    const [first, second] = agentsOf(layout);
    expect(second!.x - first!.x).toBe(NODE.stagger);
  });
});
