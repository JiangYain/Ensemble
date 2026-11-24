/**
 * `hold.restore*.test.ts` 共用：照引擎的做法驱动 `HeldLayout`（LAYOUT5 · W12、LAYOUT7 · W12），仅供测试使用：
 * 只有构造器，不含断言，也不依赖 vitest。前提都用真实的 `layoutScene` 规划来造。
 */

import type { SessionSummary } from "@shared/types";
import { HeldLayout } from "./arrival-memory";
import { DESK, roots } from "./arrival.fixtures";
import { layoutScene, type LayoutOptions, type SceneLayout } from "./layout";

export const KEY = "cursor:a";
/** 来源 `cursor:a` 名下的 `n` 个根会话 r1…rn。 */
export const a = (n: number): SessionSummary[] => roots(KEY, n);

/** 隐藏之后剩下的 7 个根（分散在各处）。 */
export const VISIBLE = ["r2", "r5", "r8", "r11", "r14", "r16", "r18"];

/**
 * 照引擎的做法：规划交给 `apply` 之后，才把这一批（含被收起的）记成“早就知道的”。
 * `visible` 是视图过滤留下的会话（没有就是全显示）。
 */
export function stage() {
  const held = new HeldLayout();
  const seen = new Set<string>();
  return {
    held,
    show(sessions: readonly SessionSummary[], opts: { visible?: readonly string[]; options?: LayoutOptions } = {}): { plan: SceneLayout; shown: SceneLayout } {
      const options = opts.options ?? DESK;
      const plan = layoutScene(sessions, { ...options, ...(opts.visible ? { visible: new Set(opts.visible) } : {}) });
      const shown = held.apply(plan, (id) => seen.has(id), options.area);
      for (const node of plan.nodes) seen.add(node.id);
      for (const id of plan.hidden ?? []) seen.add(id);
      return { plan, shown };
    },
  };
}

/** 12 个根，再逐个追加 6 个：19 张卡（来源卡加 18 个根）；返回追加完那一刻的排布。 */
export function grown19() {
  const run = stage();
  run.show(a(12));
  let last = run.show(a(13));
  for (let n = 14; n <= 18; n++) last = run.show(a(n));
  if (last.shown.nodes.length !== 19) throw new Error(`前提：19 张，实际 ${last.shown.nodes.length}`);
  return { ...run, before: last.shown };
}
