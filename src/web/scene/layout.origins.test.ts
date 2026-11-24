import type { SessionSummary } from "@shared/types";
import { describe, expect, it } from "vitest";
import { overlapsOf, session } from "./layout.fixtures";
import { layoutScene, originNodeId, type SceneLayout } from "./layout";

/**
 * 同一张画布里所有来源块的来源卡用同一种摆法（W5，用户的决定：“全部空间”里各来源卡的摆法统一）。
 * 以前每个来源块各自在“来源卡在上 / 在左”里取不被压过的那一种，同一张图里就会有的在上、有的在左；
 * 现在整张画布按摆法各规划一遍，整体缩放更大的采用（一样大取在上面的），单个来源块的画布不受影响（见 layout-plan 的 planLattice）。
 */

/**
 * 一个来源名下的会话：`roots` 里每一项是一个根会话带几个子会话。可带 `workspace`（画 Folder 卡）。
 * 创建先后从 `from` 起依次排下去：根会话与它的子会话紧挨着，所以来源之间按 `from` 分先后。
 */
function originOf(key: string, roots: readonly number[], from: number, workspace?: string): SessionSummary[] {
  const list: SessionSummary[] = [];
  let order = from;
  const make = (id: string, extra: Partial<SessionSummary>): SessionSummary =>
    session(id, key, order++, { ...(workspace === undefined ? {} : { origin: { key, workspace } as SessionSummary["origin"] }), ...extra });
  roots.forEach((kids, r) => {
    const root = `${key}-r${r}`;
    list.push(make(root, {}));
    for (let k = 0; k < kids; k++) list.push(make(`${root}-k${k}`, { parentSessionId: root }));
  });
  return list;
}

const singles = (count: number): number[] => Array.from({ length: count }, () => 0);

/** 来源卡相对它名下根会话的摆法：右缘落在最左一张根会话的左缘之内是“在左”，否则是“在上”；只有一张来源卡（没有会话）是 undefined。 */
function placementOf(layout: SceneLayout, key: string): "top" | "left" | undefined {
  const id = originNodeId(key);
  const origin = layout.nodes.find((n) => n.id === id)!;
  const roots = layout.edges.filter((edge) => edge.from === id).map((edge) => layout.nodes.find((n) => n.id === edge.to)!);
  if (roots.length === 0) return undefined;
  return origin.x + origin.w <= Math.min(...roots.map((root) => root.x)) ? "left" : "top";
}

const options = { grid: true } as const;
const AREA = { w: 1088, h: 704 };

/** 旧的“各挑各的”在这些形状上会混用摆法（用一次性脚本核对过：一个在上、一个在左）。 */
const MIXED_BEFORE: { name: string; origins: readonly (readonly number[])[]; area?: { w: number; h: number } }[] = [
  { name: "12 个单卡 + 一个父会话带 37 个子会话", origins: [singles(12), [37, 0]] },
  { name: "7 个单卡 + 一个父会话带 12 个子会话", origins: [singles(7), [12]] },
  { name: "三个父会话各带 3 个子会话 + 一个父会话带 11 个子会话", origins: [[3, 3, 3], [11]] },
  { name: "四个来源高矮不一", origins: [[6, 6], singles(9), [20], singles(3)] },
  { name: "宽屏（1568×896）下 12 个单卡 + 一个父会话带 37 个子会话", origins: [singles(12), [37, 0]], area: { w: 1568, h: 896 } },
];

describe("layoutScene · 同一张画布里来源卡的摆法统一", () => {
  for (const { name, origins, area } of MIXED_BEFORE) {
    it(`${name}：所有来源卡摆法相同`, () => {
      const sessions = origins.flatMap((roots, i) => originOf(`cursor:o${i}`, roots, 1 + i * 1000));
      const layout = layoutScene(sessions, { area: area ?? AREA, hideContextNodes: true, ...options });
      expect(layout.grid).toBe(true);
      const placements = origins.map((_, i) => placementOf(layout, `cursor:o${i}`));
      expect(new Set(placements).size, placements.join(",")).toBe(1);
      expect(overlapsOf(layout)).toEqual([]);
    });
  }

  it("全部空间里带 Folder 卡的多个来源也一样", () => {
    const sessions = [
      ...originOf("cursor:a", singles(12), 1, "C:\\work\\alpha"),
      ...originOf("cursor:b", [37, 0], 1000, "C:\\work\\beta"),
      ...originOf("cursor:c", singles(5), 2000, "C:\\work\\gamma"),
    ];
    const layout = layoutScene(sessions, { area: AREA, ...options });
    expect(layout.nodes.some((n) => n.kind === "folder")).toBe(true);
    const placements = ["cursor:a", "cursor:b", "cursor:c"].map((key) => placementOf(layout, key));
    expect(new Set(placements).size, placements.join(",")).toBe(1);
    expect(overlapsOf(layout)).toEqual([]);
  });

  it("被收起、只剩一张来源卡的来源不参与比较，其余来源仍是同一种摆法", () => {
    const a = originOf("cursor:a", singles(12), 1);
    const b = originOf("cursor:b", singles(4), 1000);
    const c = originOf("cursor:c", [37, 0], 2000);
    const visible = new Set([...a, ...c].map((s) => s.id));
    const layout = layoutScene([...a, ...b, ...c], { area: AREA, hideContextNodes: true, visible, collapsed: new Set(["cursor:b"]), ...options });
    expect(placementOf(layout, "cursor:b")).toBeUndefined();
    expect(placementOf(layout, "cursor:a")).toBe(placementOf(layout, "cursor:c"));
  });

  it("只有一个来源块时不强行统一成在上：仍按它自己的最优摆法排（12 个单卡在上，三棵各带 6 个子会话的树在左）", () => {
    // 单来源画布没有“统一”可言，排布与统一之前逐字相同（golden 里的单来源用例守着整体，这里只守摆法的取舍）。
    // 摆法是 layoutScene 的实测结果（1088×704）：又宽又矮的 12 个单卡来源卡在上面居中；三棵树并排时在左边省掉一整行高度、换一列宽度。
    const flat = layoutScene(originOf("cursor:flat", singles(12), 1), { area: AREA, hideContextNodes: true, ...options });
    expect(placementOf(flat, "cursor:flat")).toBe("top");
    const trees = layoutScene(originOf("cursor:trees", [6, 6, 6], 1), { area: AREA, hideContextNodes: true, ...options });
    expect(placementOf(trees, "cursor:trees")).toBe("left");
  });
});
