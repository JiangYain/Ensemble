/**
 * 随机生长（带种子）的测试夹具：一步步随机加一个根会话、子会话、汇聚会话或新来源，每一步都检查持有逻辑的不变量，返回违反的清单。
 * arrival-hold.test.ts（不给取景区域）与 arrival-columns.growth.test.ts（给取景区域，走“另起新列”的路）共用——仅供测试使用。
 */

import type { SessionSummary } from "@shared/types";
import { holdLayout, memoryOf, type AutoMemory } from "./arrival-hold";
import { agent, join, moved } from "./arrival.fixtures";
import { layoutScene, type Area, type LayoutOptions, type SceneLayout } from "./layout";
import { node, overlapsOf, session } from "./layout.fixtures";

/** 带种子的伪随机数：同一个种子永远走同一条路，失败时能原样复现。 */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 生长的调节：默认值就是 arrival-hold.test.ts 一直用的那组（24 步，起步 2~10 个根，35% 根会话、35% 子会话、其余汇聚）。 */
export interface Tuning {
  /** 交给持有逻辑的取景区域；不给就是改动前的调用。 */
  area?: Area;
  steps?: number;
  /** 起步时的根会话数；不给就随机 2~10 个。 */
  initial?: number;
  /** 一步的随机数落在哪一段：小于第一个数是根会话（或新来源），小于第二个数是子会话，其余是汇聚会话。 */
  cut?: readonly [number, number];
}

/** 随机生长：返回违反的清单，以及最后持有的布局。 */
export function growthRun(seed: number, options: LayoutOptions, tune: Tuning = {}): { found: string[]; layout: SceneLayout } {
  const rnd = prng(seed);
  const below = (n: number): number => Math.floor(rnd() * n);
  const [rootCut, kidCut] = tune.cut ?? ([0.35, 0.7] as const);
  const found: string[] = [];
  const originOf = new Map<string, string>();
  const depthOf = new Map<string, number>();
  const used = ["cursor:a"];
  let sessions: SessionSummary[] = [];
  let order = 1;
  const push = (item: SessionSummary, key: string, depth: number): void => {
    sessions = [...sessions, item];
    originOf.set(item.id, key);
    depthOf.set(item.id, depth);
    order++;
  };
  const rootIn = (key: string): void => push(session(`s${order}`, key, order), key, 0);
  for (let i = 0, n = tune.initial ?? 2 + below(9); i < n; i++) rootIn("cursor:a");

  let layout = layoutScene(sessions, options);
  let memory: AutoMemory = memoryOf(layout);
  const known = new Set(layout.nodes.map((n) => n.id));

  for (let step = 0; step < (tune.steps ?? 24); step++) {
    const roll = rnd();
    const shallow = sessions.filter((s) => (depthOf.get(s.id) ?? 0) <= 1);
    let parents: string[] = [];
    if (roll < rootCut) {
      const fresh = rnd() < 0.15 && used.length < 3;
      const key = fresh ? `cursor:${"bcd"[used.length - 1]}` : (used[below(used.length)] as string);
      if (fresh) used.push(key);
      rootIn(key);
    } else if (roll < kidCut) {
      const parent = shallow[below(shallow.length)] as SessionSummary;
      const key = originOf.get(parent.id) as string;
      push(session(`s${order}`, key, order, { parentSessionId: parent.id }), key, (depthOf.get(parent.id) ?? 0) + 1);
    } else {
      const key = used[below(used.length)] as string;
      const pool = shallow.filter((s) => originOf.get(s.id) === key);
      const first = pool[below(pool.length)];
      const rest = pool.filter((s) => s !== first);
      const second = rest[below(rest.length)];
      if (first && second) {
        parents = [first.id, second.id];
        push(join(`s${order}`, key, order, parents), key, Math.max(depthOf.get(first.id) ?? 0, depthOf.get(second.id) ?? 0) + 1);
      } else rootIn(key);
    }
    const created = sessions[sessions.length - 1] as SessionSummary;
    const plan = layoutScene(sessions, options);
    const held = holdLayout(plan, memory, (id) => known.has(id), tune.area);
    const label = `种子 ${seed} · 第 ${step + 1} 步 ${created.id}`;
    const expectedNew = plan.nodes.filter((n) => !memory.rects.has(n.id)).map((n) => n.id);

    if (held.mode !== "hold") found.push(`${label}：不该整体重排`);
    if (moved(layout, held.layout).length) found.push(`${label}：已有的卡动了 ${moved(layout, held.layout).join(",")}`);
    if (overlapsOf(held.layout).length) found.push(`${label}：卡片重叠 ${overlapsOf(held.layout).join(",")}`);
    if (held.layout.nodes.some((n) => !Number.isFinite(n.x) || !Number.isFinite(n.y))) found.push(`${label}：坐标不是有限数`);
    if (held.layout.nodes.map((n) => n.id).join() !== plan.nodes.map((n) => n.id).join()) found.push(`${label}：节点顺序与规划不一致`);
    if (held.added.join() !== expectedNew.join()) found.push(`${label}：added 不是这一步新出现的节点`);
    for (const parent of parents) {
      const joined = node(held.layout, agent(created.id)).x;
      const above = node(held.layout, agent(parent)).x;
      if (joined <= above) found.push(`${label}：汇聚会话 x=${joined} 不在上级 ${parent} (x=${above}) 的右边`);
    }

    for (const placed of plan.nodes) known.add(placed.id);
    memory = held.memory;
    layout = held.layout;
  }
  return { found, layout };
}

/** 不给取景区域、默认调节的随机生长：arrival-hold.test.ts 一直用的那个。 */
export const growth = (seed: number, options: LayoutOptions): string[] => growthRun(seed, options).found;
