import type { SessionSummary } from "@shared/types";
import { describe, expect, it } from "vitest";
import { holdLayout, memoryOf, type AutoMemory } from "./arrival-hold";
import { arrive, columnsIn, holder, optionsOf, shapeOf, WINDOWS } from "./arrival.columns.fixtures";
import { agent, moved, roots, spot } from "./arrival.fixtures";
import { layoutScene, type Area, type LayoutOptions, type SceneLayout } from "./layout";
import { overlapsOf, session } from "./layout.fixtures";

/**
 * 根会话到达时“先填空格、再长一行或另起一列”（LAYOUT6，规则见 arrival-grow.ts；此前是 LAYOUT3 · W6 的“竖排满了另起一列”）只改“下一张新卡去哪”，
 * 别的一律照旧：窗口变了不挪卡、重置就是回到刚载入的状态、三类整体重排照常触发、隐藏再显示原样复原；
 * 刷新后载入的格点排布上追加根会话也照同一条规则走（以前是“与不给取景区域时逐点一致”，那是 LAYOUT3 的约定，LAYOUT6 的 B 部分明确改掉了）。这里逐条钉住。
 */

const KEY = "cursor:a";
const DESK = optionsOf(WINDOWS[0]!.area);
const COMPACT = optionsOf(WINDOWS[4]!.area);
const pointsOf = (layout: SceneLayout): [string, number, number][] => layout.nodes.map((n) => [n.id, n.x, n.y]);

/** 直接走 `holdLayout`（不经 HeldLayout）：逐个到达，返回最后的记忆、布局与见过的节点。 */
function grow(sessions: readonly SessionSummary[], options: LayoutOptions): { memory: AutoMemory; layout: SceneLayout; known: Set<string> } {
  const known = new Set<string>();
  let memory: AutoMemory | undefined;
  let layout: SceneLayout | undefined;
  for (let k = 1; k <= sessions.length; k++) {
    const held = holdLayout(layoutScene(sessions.slice(0, k), options), memory, (id) => known.has(id), options.area);
    memory = held.memory;
    layout = held.layout;
    for (const node of layout.nodes) known.add(node.id);
  }
  return { memory: memory!, layout: layout!, known };
}

describe("窗口变了：已经另起的列一张都不挪，新来的卡按新窗口判断", () => {
  it("1088×710 里长到 20 个根（四列）后换成别的窗口：布局的规划变了，已有的卡仍在原位，第 21 个落进第四列", () => {
    const all = roots(KEY, 21);
    const { show } = holder(DESK);
    let last = show(all.slice(0, 1));
    for (let k = 2; k <= 20; k++) last = show(all.slice(0, k));
    expect(shapeOf(last), "旧：[5, 5, 6, 4]").toEqual([6, 6, 6, 2]);
    for (const w of [WINDOWS[1]!, WINDOWS[2]!, WINDOWS[3]!]) {
      const next = show(all.slice(0, 20), optionsOf(w.area));
      expect(moved(last, next), `换成 ${w.name}`).toEqual([]);
      expect(shapeOf(next), `换成 ${w.name}`).toEqual([6, 6, 6, 2]);
      last = next;
    }
    const more = show(all, optionsOf(WINDOWS[1]!.area));
    expect(moved(last, more)).toEqual([]);
    // 旧：(1144, 4 * 136)——第四列已有 4 张，接在它下面。现在第四列只有 2 张，外框里的空格先填：第三个空格 (1144, 2 * 136)。
    expect(spot(more, agent("r21"))).toEqual({ x: 1144, y: 2 * 136 });
    expect(overlapsOf(more)).toEqual([]);
  });
});

describe("重置与整体重排", () => {
  it("重置：忘掉记忆，下一次就是全新的规划（同一个对象），不再是长出来的几列", () => {
    const all = roots(KEY, 20);
    const { held, show } = holder(DESK);
    let grown = show(all.slice(0, 1));
    for (let k = 2; k <= 20; k++) grown = show(all.slice(0, k));
    expect(shapeOf(grown), "旧：[5, 5, 6, 4]").toEqual([6, 6, 6, 2]);
    expect(held.drifted, "排布已经偏离规划，重新排列才有东西可排").toBe(true);
    const raw = held.reset()!;
    const again = held.apply(raw, () => false, DESK.area);
    expect(again, "重置后交出去的就是规划本身").toBe(raw);
    expect(columnsIn(again).length, "全新的规划是多列的格点").toBeGreaterThan(3);
    expect(shapeOf(again), "不再是长出来的那几列（6、6、6、2），而是规划均匀排的 4 列").toEqual([5, 5, 5, 5]);
    expect(again.nodes.map((n) => [n.x, n.y])).toEqual(layoutScene(all, DESK).nodes.map((n) => [n.x, n.y]));
  });

  it("重置之后新来的根会话接着按规则走，与刷新后载入同样的 20 个再追加完全一样（重置就是回到刚载入的状态）", () => {
    // 旧：与不给取景区域时完全一样（“多列的格点不另起列”）。LAYOUT6 的 B 部分明确改掉了这一条：载入的格点上追加根会话也照同一条规则走，
    // 有取景区域时可以另起一列（见本文件最后一组），所以重置之后的参照改成“刷新后载入 20 个再追加”——两条路径从同一份规划出发，没有任何长出来的状态留下。
    const all = roots(KEY, 30);
    const { held, show } = holder(DESK);
    for (let k = 1; k <= 20; k++) show(all.slice(0, k));
    const first = held.apply(held.reset()!, () => false, DESK.area);
    const out = [pointsOf(first)];
    for (let k = 21; k <= 30; k++) out.push(pointsOf(show(all.slice(0, k))));
    expect(out).toEqual(arrive(all, DESK, undefined, 20).map(pointsOf));
    expect(out[10]!.length, "30 个根都在").toBeGreaterThan(30);
  });

  it("三类整体重排照常触发，记忆里也没有“按列长”的标记（紧凑排布，14 个根）", () => {
    const all = roots(KEY, 14);
    const grown = grow(all, COMPACT);
    expect(grown.memory.grid).toBe(true);
    // 旧：第二列开出来之后记着它（`Set(["origin:cursor:a"])`），整体重排再清掉。LAYOUT6 的规则只看卡片的位置，不再写这个标记
    // （字段与类型还在，旧的记忆照样能读），所以这里是“从不记着”；下面三类整体重排触发的断言原样保留。
    expect(grown.memory.columns, "不再记着“按列长”").toBeUndefined();
    const know = (id: string): boolean => grown.known.has(id);

    const vanished = layoutScene(all.slice(0, 13), COMPACT);
    const a = holdLayout(vanished, grown.memory, know, COMPACT.area);
    expect(a.mode, "有卡消失").toBe("full");
    expect(a.layout, "整体重排用的就是规划").toBe(vanished);
    expect(a.memory.columns).toBeUndefined();

    const reparented = layoutScene([...all.slice(0, 13), session("r14", KEY, 14, { parentSessionId: "r1" })], COMPACT);
    const b = holdLayout(reparented, grown.memory, know, COMPACT.area);
    expect(b.mode, "上级变了").toBe("full");
    expect(b.layout).toBe(reparented);
    expect(b.memory.columns).toBeUndefined();

    const stale = memoryOf(layoutScene(all.slice(0, 5), COMPACT));
    const c = holdLayout(layoutScene(all, COMPACT), stale, know, COMPACT.area);
    expect(c.mode, "早就见过的卡一下子出现").toBe("full");
    expect(c.memory.columns).toBeUndefined();
  });

  it("隐藏再显示：收起中间的一个根会话再恢复，各列原样复原（用的是当时的快照，不是另换一种排法）", () => {
    const all = roots(KEY, 20);
    const { show } = holder(DESK);
    let before = show(all.slice(0, 1));
    for (let k = 2; k <= 20; k++) before = show(all.slice(0, k));
    // 收起的是 r5（不是最后到的那个）：剩下 19 个这个组合从没出现过，没有快照，只能整体重排。
    const hidden = show(all.filter((s) => s.id !== "r5"));
    expect(moved(before, hidden).filter((id) => id !== agent("r5")).length, "隐藏让画布整体重排：剩下的卡也换了位置（规划自己的坐标）").toBeGreaterThan(0);
    const restored = show(all);
    expect(pointsOf(restored)).toEqual(pointsOf(before));
    expect(shapeOf(restored), "旧：[5, 5, 6, 4]").toEqual([6, 6, 6, 2]);
  });
});

describe("刷新后载入的多列格点排布上追加根会话：照规则走，每一步都不比不给取景区域时更难看全（第 7、24、60 个载入之后再追加 12 个）", () => {
  // 旧（LAYOUT3）：与不给取景区域时逐点一致——“多列的格点从不另起列”。LAYOUT6 的 B 部分（载入后追加）明确改掉了这一条：载入的格点上追加的根会话
  // 与逐个到达用同一条规则（先填空格、再长一行或另起一列，看哪个让整体更全），不再无条件接着格点的下一格。
  // 新的约定：载入本身一样；每一步已有的卡不动、只多一张、不重叠；整体的“全入画”比例不低于不给取景区域时同一步的比例（规则就是为了它选方向）。
  const runs = (load: number, options: LayoutOptions): { withArea: SceneLayout[]; without: SceneLayout[] } => {
    const all = roots(KEY, load + 12);
    return { withArea: arrive(all, options, undefined, load), without: arrive(all, options, "none", load) };
  };
  const fullFit = (layout: SceneLayout, area: Area): number => Math.min(1, area.w / layout.bounds.w, area.h / layout.bounds.h);

  for (const { name, area } of WINDOWS) {
    for (const load of [7, 24, 60]) {
      it(`${name}，先载入 ${load} 个`, () => {
        const { withArea, without } = runs(load, optionsOf(area));
        const classicLoad = withArea[0]!.grid !== true;
        if (classicLoad) {
          // 竖屏载入 7 个时规划的是经典的树（不是格点）：它按竖排的规则长，有取景区域就会另起列——这正是新规则要管的，不在这里比。
          expect(name).toBe("竖屏 720×1000");
          expect(load).toBe(7);
          expect(columnsIn(withArea.at(-1)!).length).toBeGreaterThan(columnsIn(without.at(-1)!).length);
          return;
        }
        expect(pointsOf(withArea[0]!), "载入本身与不给取景区域时一样").toEqual(pointsOf(without[0]!));
        withArea.forEach((layout, i) => {
          const before = withArea[i - 1];
          if (before) {
            expect(moved(before, layout), `第 ${i} 步：已有的卡不动`).toEqual([]);
            expect(layout.nodes.length - before.nodes.length, `第 ${i} 步：只多一张`).toBe(1);
          }
          expect(overlapsOf(layout), `第 ${i} 步：不重叠`).toEqual([]);
          expect(fullFit(layout, area), `第 ${i} 步：不比不给取景区域时更难看全`).toBeGreaterThanOrEqual(fullFit(without[i]!, area) - 1e-9);
        });
      });
    }
  }

  it("格点排布的记忆里没有“按列长”标记：多列的格点从不进来", () => {
    const all = roots(KEY, 36);
    const fresh = layoutScene(all.slice(0, 24), DESK);
    const loaded = holdLayout(fresh, undefined, () => false, DESK.area);
    expect(loaded.memory.grid).toBe(true);
    expect(loaded.memory.columns).toBeUndefined();
    let memory = loaded.memory;
    const known = new Set(fresh.nodes.map((n) => n.id));
    for (let k = 25; k <= 36; k++) {
      const held = holdLayout(layoutScene(all.slice(0, k), DESK), memory, (id) => known.has(id), DESK.area);
      memory = held.memory;
      for (const n of held.layout.nodes) known.add(n.id);
    }
    expect(memory.columns).toBeUndefined();
  });
});
