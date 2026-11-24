import { describe, expect, it } from "vitest";
import { DESK, kidsOf, moved } from "./arrival.fixtures";
import { a, grown19, KEY, stage, VISIBLE } from "./hold.restore.fixtures";
import type { Area, LayoutOptions, SceneLayout } from "./layout";
import { overlapsOf, session } from "./layout.fixtures";

/**
 * 隐藏 → 恢复时，隐藏期间来过新会话也不整张画布重排（LAYOUT5 · W12）。
 *
 * 根因：`HeldLayout.apply` 整体重排前只按“与规划完全相同的节点集合”找快照。恢复时规划比隐藏之前多了隐藏期间来的会话，
 * 隐藏之前存的快照对不上，于是整张画布换成全新规划（16/19 张卡挪位、缩放从 77% 变 90%、重置按钮消失）。
 * 现在对不上时找“节点全在规划里”的快照，大的优先，快照之外的节点当新卡落进下一个空位（hold-restore.ts）。
 *
 * 隐藏期间来得很多（来了 7 个以上）的情形在 `hold.restore.many.test.ts`（LAYOUT7 · W12）。
 * `stage` 照引擎的做法驱动 `HeldLayout`，在 `hold.restore.fixtures.ts`。
 */

const idOf = (id: string): string => `agent:${id}`;

const spotOf = (layout: SceneLayout, id: string): { x: number; y: number } => {
  const found = layout.nodes.find((node) => node.id === id);
  if (!found) throw new Error(`没有 ${id}`);
  return { x: found.x, y: found.y };
};

describe("HeldLayout · 隐藏期间来了新会话，恢复时用隐藏之前的快照", () => {
  it("(a) 19 张隐藏成 8 张，隐藏期间新来 1 个（工作中）→ 恢复：19 张老卡 0 移动，第 20 张落在没有隐藏时它会落的下一个空位，没有重叠", () => {
    const { show, held, before } = grown19();
    const hidden = show(a(18), { visible: VISIBLE.map((id) => id) });
    expect(hidden.shown.nodes, "前提：隐藏后剩 8 张").toHaveLength(8);
    expect(hidden.shown, "前提：隐藏时整体重排").toBe(hidden.plan);
    const duringHide = show(a(19), { visible: [...VISIBLE, "r19"] });
    expect(duringHide.shown.nodes, "前提：隐藏期间来了 1 张").toHaveLength(9);

    const back = show(a(19));
    expect(back.shown.nodes).toHaveLength(20);
    expect(moved(before, back.shown), "19 张老卡一像素不动").toEqual([]);
    expect(overlapsOf(back.shown)).toEqual([]);
    expect(back.shown, "不是整体重排").not.toBe(back.plan);
    expect(held.drifted, "恢复出来的排布不同于规划：重新排列有东西可排").toBe(true);

    // 对照：没有隐藏时，同样的第 19 个根会落在哪里。
    const control = grown19();
    const next = control.show(a(19));
    expect(spotOf(back.shown, idOf("r19"))).toEqual(spotOf(next.shown, idOf("r19")));
  });

  it("(b) 隐藏期间来了 3 个、其中 1 个也被收起（不在工作）→ 恢复：老卡 0 移动，3 个新会话都落进空位，不重叠", () => {
    const { show, before } = grown19();
    show(a(18), { visible: VISIBLE });
    show(a(19), { visible: [...VISIBLE, "r19"] });
    show(a(20), { visible: [...VISIBLE, "r19", "r20"] });
    const midway = show(a(21), { visible: [...VISIBLE, "r19", "r20"] });
    expect(midway.plan.hidden?.has(idOf("r21")), "前提：r21 来了就被收起").toBe(true);

    const back = show(a(21));
    expect(back.shown.nodes).toHaveLength(22);
    expect(moved(before, back.shown)).toEqual([]);
    expect(overlapsOf(back.shown)).toEqual([]);
    const spots = ["r19", "r20", "r21"].map((id) => JSON.stringify(spotOf(back.shown, idOf(id))));
    expect(new Set(spots).size, "三张新卡各占一格").toBe(3);
  });

  it("(c) 隐藏期间有一张老卡被删除（它不在规划里了）→ 记着它的快照都不成立，整体重排，而不是用错的快照", () => {
    const { show, before } = grown19();
    show(a(18), { visible: VISIBLE });
    show(a(19), { visible: [...VISIBLE, "r19"] });
    const without3 = a(19).filter((s) => s.id !== "r3");
    const back = show(without3);
    expect(back.shown, "整体重排：交出去的就是规划").toBe(back.plan);
    expect(moved(before, back.shown).length, "前提：整体重排确实挪动了老卡（r3 没了，位置都变）").toBeGreaterThan(0);
  });

  it("(c2) 删掉的是最后追加的那个根：更早、更小但仍然成立的快照（17 个根那份）能用，17 个根 0 移动、其余落进空位", () => {
    const run = stage();
    run.show(a(12));
    const snapshots17 = [13, 14, 15, 16, 17].map((n) => run.show(a(n)));
    run.show(a(18));
    run.show(a(18), { visible: VISIBLE.slice(0, -1) });
    run.show(a(19), { visible: [...VISIBLE.slice(0, -1), "r19"] });
    const without18 = a(19).filter((s) => s.id !== "r18");
    const back = run.show(without18);
    const at17 = snapshots17[snapshots17.length - 1]!.shown;
    expect(back.shown, "不是整体重排").not.toBe(back.plan);
    expect(moved(at17, back.shown), "17 个根那一刻的排布原样回来").toEqual([]);
    expect(overlapsOf(back.shown)).toEqual([]);
  });

  it("(d) 同一个尺寸体系里的窗口变化不影响恢复：隐藏期间换了窗口、恢复时又换了一个，老卡仍然 0 移动", () => {
    const { show, before } = grown19();
    const other: LayoutOptions = { ...DESK, area: { w: 928, h: 530 } as Area };
    show(a(18), { visible: VISIBLE, options: other });
    show(a(19), { visible: [...VISIBLE, "r19"], options: other });
    const back = show(a(19), { options: { ...DESK, area: { w: 1280, h: 720 } } });
    expect(moved(before, back.shown)).toEqual([]);
    expect(overlapsOf(back.shown)).toEqual([]);
  });

  it("(e) 隐藏期间来了多少个新会话，隐藏之前的那份都还在、都能复原（LAYOUT7 · W12：以前只记最近 8 份，来了 7 个就被挤掉而整体重排）", () => {
    for (const arrivals of [6, 7, 8, 12, 30]) {
      const { show, before } = grown19();
      show(a(18), { visible: VISIBLE });
      const visible = [...VISIBLE];
      for (let n = 19; n < 19 + arrivals; n++) {
        visible.push(`r${n}`);
        show(a(n), { visible: [...visible] });
      }
      const back = show(a(18 + arrivals));
      expect(back.shown === back.plan, `隐藏期间来了 ${arrivals} 个`).toBe(false);
      expect(moved(before, back.shown), `隐藏期间来了 ${arrivals} 个`).toEqual([]);
    }
  });

  it("(f) 精确签名仍然优先：隐藏期间没来新会话，恢复的就是隐藏之前的那一份", () => {
    const { show, before } = grown19();
    show(a(18), { visible: VISIBLE });
    const back = show(a(18));
    expect(moved(before, back.shown)).toEqual([]);
    expect(back.shown.nodes).toHaveLength(19);
  });

  it("(f2) 再把同一批会话隐藏起来：复原上一次这批会话的排布（含隐藏期间长出来的子会话），而不是重新规划；它走精确签名，不受“只试记得更多的快照”限制", () => {
    const { show } = grown19();
    const base = a(18);
    const kids = kidsOf(KEY, "r1", 3, 100);
    const live = ["r1", "r2", "r3", "r4", "r5", "r6"];
    let grown = show(base, { visible: live });
    for (const [k, kid] of kids.entries()) {
      live.push(kid.id);
      grown = show([...base, ...kids.slice(0, k + 1)], { visible: [...live] });
    }
    expect(grown.shown, "前提：隐藏期间长出来的排布不是规划").not.toBe(grown.plan);
    show([...base, ...kids]);

    const again = show([...base, ...kids], { visible: live });
    expect(moved(grown.shown, again.shown), "与上一次这批会话的排布逐卡相同").toEqual([]);
    expect(again.shown, "不是整体重排").not.toBe(again.plan);
  });

  it("(g) 同样大的候选取最近用过的：先后排过两份同样多节点的排布，隐藏之后恢复到更近的那一份", () => {
    const run = stage();
    // X = r3…r10；p = r1（最老，排在 X 前面）、q = r11（最新，排在 X 后面）：两份排布里 X 的位置不同。
    const X = a(11).slice(2, 10);
    const p = a(11)[0]!;
    const q = a(11)[10]!;
    const withP = run.show([p, ...X]);
    const withQ = run.show([...X, q]);
    expect(moved(withP.shown, withQ.shown).length, "前提：两份排布里 X 的位置不同").toBeGreaterThan(0);
    run.show([...X, q], { visible: ["r3", "r4"] });
    const back = run.show([p, ...X, q]);
    const xIds = X.map((s) => idOf(s.id));
    const stayed = (from: SceneLayout) => xIds.filter((id) => spotOf(from, id).x === spotOf(back.shown, id).x && spotOf(from, id).y === spotOf(back.shown, id).y);
    expect(stayed(withQ.shown), "X 回到更近的那份（有 q 的）里的位置").toHaveLength(xIds.length);
    expect(overlapsOf(back.shown)).toEqual([]);
    // 它没有被另一份（有 p 的）带走。
    expect(stayed(withP.shown).length).toBeLessThan(xIds.length);
  });

  it("(h) 大的优先：隐藏过两次，更早一次隐藏留下的小快照（规划排的，另一个谱系）不能抢在隐藏之前那份大快照前面", () => {
    const { show, before } = grown19();
    const first = show(a(18), { visible: VISIBLE });
    // 前提：那一次隐藏留下的排布（规划排的 8 张）与长出来的排布不是一回事——从它出发复原，已有的卡就不在原位了。
    expect(VISIBLE.some((id) => JSON.stringify(spotOf(first.shown, idOf(id))) !== JSON.stringify(spotOf(before, idOf(id)))), "前提：两个谱系的排布不同").toBe(true);
    show(a(18));
    show(a(18), { visible: ["r3", "r9"] });
    show(a(19), { visible: ["r3", "r9", "r19"] });

    const back = show(a(19));
    expect(moved(before, back.shown), "复原的是第二次隐藏之前用户看到的那一份").toEqual([]);
    expect(overlapsOf(back.shown)).toEqual([]);
  });

  it("隐藏期间来了新会话，但窗口翻到了紧凑尺寸：快照里卡的尺寸变了，不能复原，整体重排", () => {
    const { show } = grown19();
    show(a(18), { visible: VISIBLE });
    show(a(19), { visible: [...VISIBLE, "r19"] });
    const compact: LayoutOptions = { area: { w: 288, h: 544 }, grid: true, hideContextNodes: true };
    const back = show(a(19), { options: compact });
    expect(back.shown).toBe(back.plan);
  });

  it("刚打开页面（还没有任何快照）：第一份布局就是规划本身", () => {
    const first = stage().show(a(5));
    expect(first.shown).toBe(first.plan);
  });

  it("上级变了的会话让每一份记着它的快照失效：隐藏期间有早期的根（每份快照里都有它）改挂了上级，恢复时整体重排", () => {
    const { show } = grown19();
    show(a(18), { visible: VISIBLE });
    const reparented = a(19).map((s) => (s.id === "r5" ? session("r5", KEY, 5, { parentSessionId: "r1" }) : s));
    const back = show(reparented);
    expect(back.shown).toBe(back.plan);
  });
});
