import { describe, expect, it } from "vitest";
import { moved } from "./arrival.fixtures";
import { HeldLayout } from "./arrival-memory";
import { layoutScene, type LayoutOptions, type SceneLayout } from "./layout";
import { overlapsOf } from "./layout.fixtures";
import { REAL_CANVASES, realSessions } from "./layout.real.fixtures";

/**
 * 真实画布形状的“已有卡原地不动、新卡落进空位”（LAYOUT2 · W4）：用六张真实画布的精简夹具（会话的先后与上下级与真实数据一致），
 * 页面先载入前 60%（整体规划），其余按真实的创建先后一个个到达——合成数据里想不到的形状（几十个单卡里夹着带 12 个、37 个子会话的家族，
 * 孙会话晚于兄弟到达）都在这里过一遍。每一步都经过引擎持有的那条路（`HeldLayout.apply`，`known` 的记法与引擎一致：出现过的节点都记下）。
 */
const WINDOWS: readonly (readonly [string, LayoutOptions])[] = [
  ["1440×900", { area: { w: 1088, h: 710 }, grid: true, hideContextNodes: true }],
  ["1280×720", { area: { w: 928, h: 530 }, grid: true, hideContextNodes: true }],
];

/** 一个小夹具：按引擎的方式记住“出现过的节点”，把一份规划交给 `HeldLayout`，返回持有后的布局。 */
function holder(): { show: (plan: SceneLayout) => SceneLayout } {
  const held = new HeldLayout();
  const known = new Set<string>();
  return {
    show: (plan) => {
      const layout = held.apply(plan, (id) => known.has(id));
      for (const node of layout.nodes) known.add(node.id);
      return layout;
    },
  };
}

describe("真实画布形状：页面载入大半，其余逐个到达", () => {
  for (const canvas of REAL_CANVASES) {
    for (const [window, options] of WINDOWS) {
      it(`${canvas.name} · ${window}：每到一个，已有的卡位移为 0、不重叠、只多出这一张新卡`, () => {
        const all = realSessions(canvas);
        const start = Math.ceil(all.length * 0.6);
        const { show } = holder();
        let shown = show(layoutScene(all.slice(0, start), options));
        for (let count = start + 1; count <= all.length; count++) {
          const label = `${canvas.name} 第 ${count} 个到达`;
          const next = show(layoutScene(all.slice(0, count), options));
          expect(moved(shown, next), label).toEqual([]);
          expect(overlapsOf(next), label).toEqual([]);
          const before = new Set(shown.nodes.map((node) => node.id));
          expect(next.nodes.filter((node) => !before.has(node.id)).map((node) => node.id), label).toEqual([`agent:${all[count - 1]!.id}`]);
          expect(
            next.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y)),
            label,
          ).toBe(true);
          shown = next;
        }
        expect(shown.nodes.filter((node) => node.kind === "agent")).toHaveLength(all.length);
      });

      it(`${canvas.name} · ${window}：一次到达最后 8 个，已有的卡位移为 0、不重叠`, () => {
        const all = realSessions(canvas);
        const { show } = holder();
        const shown = show(layoutScene(all.slice(0, all.length - 8), options));
        const next = show(layoutScene(all, options));
        expect(moved(shown, next)).toEqual([]);
        expect(overlapsOf(next)).toEqual([]);
        expect(next.nodes.filter((node) => node.kind === "agent")).toHaveLength(all.length);
      });
    }
  }

  it("隐藏一批会话是整体重排，再显示出来时整张画布原样复原（不是换一种排法）", () => {
    const canvas = REAL_CANVASES.find((entry) => entry.name === "7295d4f1")!;
    const [, options] = WINDOWS[0]!;
    const all = realSessions(canvas);
    const { show } = holder();
    const full = show(layoutScene(all, options));
    const visible = new Set(all.slice(20).map((entry) => entry.id));
    const fewer = show(layoutScene(all, { ...options, visible }));
    expect(moved(full, fewer).length, "隐藏之后是整体重排：留下的卡不会全在原位").toBeGreaterThan(0);
    const back = show(layoutScene(all, options));
    expect(moved(full, back)).toEqual([]);
  });
});
