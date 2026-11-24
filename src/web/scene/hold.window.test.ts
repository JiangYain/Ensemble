import type { SessionSummary } from "@shared/types";
import { describe, expect, it } from "vitest";
import { HeldLayout } from "./arrival-memory";
import { moved } from "./arrival.fixtures";
import { SETTLE_MS } from "./hold-settle";
import { layoutScene, type Area, type SceneLayout } from "./layout";
import { overlapsOf, session } from "./layout.fixtures";
import { REAL_CANVASES, realSessions } from "./layout.real.fixtures";

/**
 * 窗口经过窄模式再回到宽屏，排布与刷新不一致（LAYOUT5 · W13）。
 *
 * 取景区域是量出来的：外壳在窄屏（顶栏）与宽屏（侧栏）之间切换时，`Overview` 的第一次量取量到的是旧外壳在新窗口宽度下的样子
 * （窗口 800 → 1440：宽 1328 的 `.scene`、高被顶栏占去一截 → 区域 1328×656），一两帧之后外壳换好才量到最终值 1088×704。
 * 第一个区域让卡的尺寸体系翻转（紧凑 → 宽屏），整体重排用的是那个过渡值，列数是错的（70b49d0d：12 列而不是 10 列）；
 * 第二个区域尺寸体系没变，持有逻辑按“窗口变了已有的卡不动”不再重排，页面就停在了错的排布上。
 * 数字取自 `.tmp/layout-work/l5-area-cols.ts`；这里直接驱动 `HeldLayout`，时钟是假的（`performance.now` 不参与）。
 */

const FINAL: Area = { w: 1088, h: 704 }; // 1440×900 的窗口、宽外壳（侧栏 240）
const TRANSIENT: Area = { w: 1328, h: 656 }; // 800 → 1440 时外壳还没换好的第一次量取
const AT_800: Area = { w: 688, h: 656 }; // 800×900，窄外壳（顶栏）：宽 688 < 720 → 紧凑
const AT_1024: Area = { w: 672, h: 704 }; // 1024×900，宽外壳：宽 672 < 720 → 紧凑
const AT_1280: Area = { w: 928, h: 528 };
const AT_1920: Area = { w: 1568, h: 896 };
/** 宽外壳里的另外两个区域：四张画布在 1328×704、960×704 下的规划都与 1088×704（以及彼此）不同（`l5-window-areas.ts` 的表）。 */
const WIDE_SHORT: Area = { w: 1328, h: 704 };
const WIDE_NARROW: Area = { w: 960, h: 704 };

const planOf = (sessions: readonly SessionSummary[], area: Area): SceneLayout => layoutScene(sessions, { area, grid: true, hideContextNodes: true });
const positionsOf = (layout: SceneLayout): string[] => layout.nodes.map((n) => `${n.id}@${n.x},${n.y}`);
const columnsOf = (layout: SceneLayout): number => new Set(layout.nodes.filter((n) => n.kind === "agent").map((n) => n.x)).size;

/** 照引擎的做法：规划交给 `apply` 之后，才把这一批记成“早就知道的”；时钟由测试拨。 */
function stage(sessions: readonly SessionSummary[]) {
  let now = 0;
  const held = new HeldLayout(() => now);
  const seen = new Set<string>();
  return {
    held,
    show(area: Area, at: number, list: readonly SessionSummary[] = sessions): { plan: SceneLayout; shown: SceneLayout } {
      now = at;
      const plan = planOf(list, area);
      const shown = held.apply(plan, (id) => seen.has(id), area);
      for (const node of plan.nodes) seen.add(node.id);
      return { plan, shown };
    },
  };
}

const BIG = ["70b49d0d", "7295d4f1", "299997f3", "88e325d7"] as const;
const canvasOf = (name: string): { sessions: readonly SessionSummary[]; key: string } => {
  const canvas = REAL_CANVASES.find((c) => c.name === name)!;
  return { sessions: realSessions(canvas), key: canvas.key };
};

describe("窗口经过窄外壳再回到宽屏，与刷新同一个窗口的排布一致", () => {
  it.each(BIG)("%s：1440 → 800 → 1440（过渡值 1328×656 → 最终值 1088×704）：最后逐卡与刷新相同，外框相同，没有漂移", (name) => {
    const { sessions } = canvasOf(name);
    const run = stage(sessions);
    run.show(FINAL, 0);
    run.show(AT_800, 1000);
    const flipped = run.show(TRANSIENT, 2000);
    expect(columnsOf(flipped.shown), "前提：过渡值排出来的列数与最终值不同").not.toBe(columnsOf(planOf(sessions, FINAL)));
    const back = run.show(FINAL, 2016);

    const fresh = planOf(sessions, FINAL);
    expect(positionsOf(back.shown)).toEqual(positionsOf(fresh));
    expect(back.shown.bounds).toEqual(fresh.bounds);
    expect(columnsOf(back.shown)).toBe(columnsOf(fresh));
    expect(run.held.drifted, "与规划一样：重置按钮没有理由出现").toBe(false);
  });

  it.each(BIG)("%s：1440 → 1024 → 1440（一路宽外壳、不经过窄外壳）：回到宽屏与刷新相同", (name) => {
    const { sessions } = canvasOf(name);
    const run = stage(sessions);
    run.show(FINAL, 0);
    run.show(AT_1024, 1000);
    const back = run.show(FINAL, 2000);
    expect(positionsOf(back.shown)).toEqual(positionsOf(planOf(sessions, FINAL)));
    expect(run.held.drifted).toBe(false);
  });

  it.each(BIG)("%s：往窄走也一样——1440 → 800，区域先量到 448（宽外壳里的窄窗口）再量到 688，最后与刷新 800 相同", (name) => {
    const { sessions } = canvasOf(name);
    const run = stage(sessions);
    run.show(FINAL, 0);
    run.show({ w: 448, h: 704 }, 1000);
    const back = run.show(AT_800, 1016);
    expect(positionsOf(back.shown)).toEqual(positionsOf(planOf(sessions, AT_800)));
  });
});

describe("同一个尺寸体系里的窗口变化，已有的卡一像素不动", () => {
  it.each(BIG)("%s：宽屏里 1440 ↔ 1280 ↔ 1920：每一步 0 移动；刚载入页面也一样", (name) => {
    const { sessions } = canvasOf(name);
    const run = stage(sessions);
    const first = run.show(FINAL, 0);
    let before = first.shown;
    let at = 10;
    for (const area of [AT_1280, AT_1920, WIDE_SHORT, FINAL, WIDE_NARROW, AT_1920, AT_1280]) {
      const step = run.show(area, (at += 10));
      expect(moved(before, step.shown), `${area.w}×${area.h}`).toEqual([]);
      expect(positionsOf(step.shown)).toEqual(positionsOf(first.shown));
      before = step.shown;
    }
    expect(positionsOf(planOf(sessions, WIDE_SHORT)), "前提：规划随区域变").not.toEqual(positionsOf(first.plan));
  });

  it("紧凑体系里同理：688 → 480 → 592 → 656 原地不动，也不需要等任何时间", () => {
    const { sessions } = canvasOf("88e325d7");
    const run = stage(sessions);
    const first = run.show(AT_800, 0);
    for (const [at, w] of [[5, 480], [9, 592], [4000, 656]] as const) {
      const step = run.show({ w, h: 656 }, at);
      expect(positionsOf(step.shown), `宽 ${w}`).toEqual(positionsOf(first.shown));
    }
    expect(positionsOf(planOf(sessions, { w: 480, h: 656 })), "前提：规划随区域变").not.toEqual(positionsOf(first.plan));
  });

  it.each([
    [SETTLE_MS, true],
    [SETTLE_MS + 1, false],
  ])("翻转之后过了 %ims，区域再变（拖动窗口、折叠侧栏）：重新计算 = %s（时间窗之外原地不动）", (wait, corrects) => {
    const { sessions } = canvasOf("70b49d0d");
    const run = stage(sessions);
    run.show(FINAL, 0);
    run.show(AT_800, 1000);
    const flipped = run.show(TRANSIENT, 2000);
    const area: Area = { w: 1248, h: 656 };
    expect(positionsOf(planOf(sessions, area)), "前提：规划随区域变").not.toEqual(positionsOf(flipped.shown));
    const later = run.show(area, 2000 + wait);
    if (corrects) {
      expect(later.shown).toBe(later.plan);
    } else {
      expect(later.shown).not.toBe(later.plan);
      expect(moved(flipped.shown, later.shown)).toEqual([]);
    }
  });

  it("没有取景区域时不暂定（引擎在没量到区域时被调用）：与以前一样原地不动", () => {
    const { sessions } = canvasOf("88e325d7");
    const held = new HeldLayout(() => 0);
    const known = new Set<string>();
    const apply = (area: Area): SceneLayout => {
      const plan = planOf(sessions, area);
      const shown = held.apply(plan, (id) => known.has(id));
      for (const node of plan.nodes) known.add(node.id);
      return shown;
    };
    apply(AT_800);
    const flipped = apply(TRANSIENT);
    expect(moved(flipped, apply(FINAL))).toEqual([]);
  });
});

describe("暂定的整体重排何时作废", () => {
  it("紧凑 → 宽屏（经过渡值校正）之后来了一个新会话：老卡 0 移动，新卡落进空位、不压任何卡", () => {
    const { sessions, key } = canvasOf("299997f3");
    const run = stage(sessions);
    run.show(AT_800, 0);
    run.show(TRANSIENT, 1000);
    const settled = run.show(FINAL, 1016);
    expect(settled.shown, "前提：已校正成与刷新相同").toBe(settled.plan);
    const next = run.show(FINAL, 5000, [...sessions, session("new-1", key, 9999)]);
    expect(moved(settled.shown, next.shown)).toEqual([]);
    expect(next.shown.nodes.some((n) => n.id === "agent:new-1")).toBe(true);
    expect(overlapsOf(next.shown)).toEqual([]);
  });

  it("暂定期间有新会话到来：老卡不再被重排，新卡落进空位，之后窗口怎么变都不动", () => {
    const { sessions, key } = canvasOf("88e325d7");
    const arrival = [...sessions, session("new-1", key, 9999)];
    const run = stage(sessions);
    run.show(AT_800, 0);
    const flipped = run.show(TRANSIENT, 1000);
    const withNew = run.show(FINAL, 1010, arrival);
    expect(moved(flipped.shown, withNew.shown), "新会话与新区域同时到：老卡按持有的排布，不重排").toEqual([]);
    expect(withNew.shown.nodes.some((n) => n.id === "agent:new-1")).toBe(true);
    expect(overlapsOf(withNew.shown)).toEqual([]);
    const later = run.show(AT_1280, 1020, arrival);
    expect(moved(withNew.shown, later.shown)).toEqual([]);
  });

  it("暂定期间有会话消失：同样作废，老卡原地不动", () => {
    const { sessions } = canvasOf("88e325d7");
    const run = stage(sessions);
    run.show(AT_800, 0);
    const flipped = run.show(TRANSIENT, 1000);
    const gone = run.show(FINAL, 1010, sessions.slice(0, -1));
    expect(gone.shown, "少了一张卡：持有逻辑按它自己的规矩整体重排（与暂定无关）").toBe(gone.plan);
    const later = run.show(AT_1280, 1020, sessions.slice(0, -1));
    expect(moved(gone.shown, later.shown), "暂定已作废：之后窗口变化原地不动").toEqual([]);
    expect(flipped.shown).not.toBe(gone.shown);
  });

  it("暂定的整体重排最多再算 2 次：第 3 次区域变化起原地不动", () => {
    const { sessions } = canvasOf("70b49d0d");
    const run = stage(sessions);
    run.show(AT_800, 0);
    const flipped = run.show(TRANSIENT, 1000);
    const areas: Area[] = [WIDE_SHORT, FINAL, WIDE_NARROW];
    const plans = areas.map((area) => positionsOf(planOf(sessions, area)).join());
    expect(new Set([positionsOf(flipped.plan).join(), ...plans]).size, "前提：四个区域的规划互不相同").toBe(4);

    const second = run.show(areas[0]!, 1010);
    expect(second.shown, "第 1 次校正").toBe(second.plan);
    const third = run.show(areas[1]!, 1020);
    expect(third.shown, "第 2 次校正").toBe(third.plan);
    const fourth = run.show(areas[2]!, 1030);
    expect(fourth.shown, "第 3 次不再校正").not.toBe(fourth.plan);
    expect(moved(third.shown, fourth.shown)).toEqual([]);
  });

  it("点了“重置节点布局”之后不再校正：重置把暂定忘掉，随后窗口变化原地不动", () => {
    const { sessions } = canvasOf("299997f3");
    const contrast = stage(sessions);
    contrast.show(AT_800, 0);
    contrast.show(TRANSIENT, 1000);
    const corrected = contrast.show(FINAL, 1010);
    expect(corrected.shown, "对照：不重置就校正").toBe(corrected.plan);

    const run = stage(sessions);
    run.show(AT_800, 0);
    run.show(TRANSIENT, 1000);
    run.held.reset();
    const again = run.show(TRANSIENT, 1005);
    const later = run.show(FINAL, 1010);
    expect(moved(again.shown, later.shown)).toEqual([]);
    expect(later.shown).not.toBe(later.plan);
  });
});
