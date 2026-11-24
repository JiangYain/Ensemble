import { holdLayout, type AutoMemory, type Held } from "./arrival-hold";
import type { Area, SceneLayout } from "./layout";

/**
 * 最多记几份快照（按“画着哪些节点”分开，同一份节点集合只留最近一次）。
 * 每份只是一张位置表（每个节点一个 { x, y, w, h } 加上级），总量与节点数成正比，8 份可以忽略。
 * 上限只为内存有界，不是复原的次数限制：同一条生长线上被后来者包住的前驱会先被逐出（见 `Snapshots.save`），
 * 所以隐藏期间来了多少个新会话，隐藏之前的那份都还在（LAYOUT7 · W12）。
 */
export const SNAPSHOT_LIMIT = 8;

interface Entry {
  memory: AutoMemory;
  /** 记下它那一刻视图过滤着、收起过会话（`plan.hidden` 不为空）：它只画了一部分卡，逐出时不如完整的那份值得留；这次规划画全了（再显示全部）时复原也排在完整的后面。 */
  partial: boolean;
}

/** 这份规划被视图过滤着、只画了一部分会话（`plan.hidden` 不为空）；没有就是画全了。 */
const isPartial = (plan: SceneLayout): boolean => (plan.hidden?.size ?? 0) > 0;

/** 节点集合的签名：按 id 排好连起来。 */
const signatureOf = (plan: SceneLayout): string =>
  plan.nodes
    .map((node) => node.id)
    .sort()
    .join("\n");

/**
 * `older` 是 `newer` 的前身：它的每张卡 `newer` 里都有，位置、尺寸、上级一样，格点形态也一样——
 * 即 holdLayout 沿着“已有的卡不动、新卡落进空位”从 `older` 长成了 `newer`。`newer` 能做的复原它都能做，除非后来的卡被删了。
 */
function precedes(older: AutoMemory, newer: AutoMemory): boolean {
  if (older.rects.size > newer.rects.size || older.grid !== newer.grid) return false;
  for (const [id, rect] of older.rects) {
    const next = newer.rects.get(id);
    if (!next || next.x !== rect.x || next.y !== rect.y || next.w !== rect.w || next.h !== rect.h) return false;
    if (older.parents.get(id) !== newer.parents.get(id)) return false;
  }
  return true;
}

/** 这份快照记得刚失效的那份记忆里没有的卡（它们隐藏期间不在画面里、现在回来了）；没有失效的记忆就当作记得。 */
const remembersMore = (memory: AutoMemory, failed: AutoMemory | undefined): boolean =>
  !failed || [...memory.rects.keys()].some((id) => !failed.rects.has(id));

/**
 * 最近几次排布的快照，用来在整体重排之前先试着复原（LAYOUT2 · W4、LAYOUT5 · W12、LAYOUT7 · W12）。
 *
 * 隐藏一批会话（“隐藏未在工作的会话”、隐藏相关节点）会让画布整体重排；再显示出来时，隐藏之前的排布才是用户看熟了的那一个。
 * 复原分两步，都只在“记忆还能当前提”（见 holdLayout 的 mustRelayout：卡都在、尺寸与上级没变）时才算数：
 *  1. 节点集合与快照一模一样：原样复原；
 *  2. 隐藏期间又来了新会话（它们不在快照里）：找节点全都在这次规划里的快照，**大的优先**，同样大时取最近用过的，把快照没有的节点当新卡放进下一个空位。
 *     例外：这次规划画全了（没有被视图过滤着，也就是再显示全部）时，只画了一部分的快照排在完整的后面，各自再按上面的大小与新旧排。
 *     这一步要换一个 `isKnown`：快照之外的节点一律当作没见过——隐藏期间来的新会话与被隐藏的那些对引擎来说都是“早就知道的”，
 *     不换的话 holdLayout 会因为“见过的卡再出现”而要求整体重排，复原就不成立。
 *     只试“记得刚刚失效的那份记忆里没有的卡”的快照：复原是往回走到一份记得更多的排布——那些卡隐藏期间不在画面里、现在回来了。
 *     快照里的卡失效的记忆里全有的（它的前身、隐藏期间的排布），拿来当前提只是把现有的排布撤回到更早更小的样子，
 *     或者拿几张卡的位置把其余的卡塞进空位，与整体重排没有区别却更难看，宁可整体重排。
 *     不能用“比失效的记忆大”来判：隐藏期间每来一个新会话失效的记忆就多一张，来得够多它就比隐藏之前那份还大，那份被挡在门外。
 *     为什么“再显示全部”时完整的先试（LAYOUT9，VLAYOUT4 · V4-5）：隐藏期间视图里的卡可能一度比隐藏之前的总数还多（新会话一直在工作），
 *     只画了一部分的快照因此最大；它没有那些被收起的老卡，拿它当前提会把它们都当新卡塞进空位，隐藏之前的位置整个丢了。
 *     为什么规划自己仍被过滤着时不分：那时还能用的完整快照一定不记得任何一张当前被收起的卡，多半是过滤开着之前又旧又小的一份，
 *     过滤开着的这段时间里它早被整体重排甩在后面了；让它先试，一个会话离开视图又回来，往回走一步就成了拿旧位置把其余的卡重新长一遍，几张卡一起跳走
 *     （hold.restore.many.test.ts 里有这一例）。这时仍按大小：最近那份只画了一部分的快照才是用户上一次看熟的。
 */
export class Snapshots {
  private readonly entries = new Map<string, Entry>();

  /** 现在记着几份（不会超过 `SNAPSHOT_LIMIT`）。 */
  get size(): number {
    return this.entries.size;
  }

  /**
   * 记下这一次的排布；同一份节点集合只留最新的。超出 `SNAPSHOT_LIMIT` 份时逐出（最新的一份是现在的排布，不动）：
   *  ① 被更新的某份包住的前驱：隐藏期间每来一个新会话就多一份快照，它们是同一条生长线上的前驱，位置与后面那份在共有的卡上一模一样；
   *  ② 只画了一部分卡的（视图过滤着时留下的）：隐藏期间有会话结束、退出视图，每一次都是一次整体重排，各留一份互不相干的快照，
   *     不先逐出它们，隐藏之前那份完整的排布会被一份份挤掉；
   *  ③ 都不是：最旧的。
   * 同一档里取最旧的。
   */
  save(plan: SceneLayout, memory: AutoMemory): void {
    const key = signatureOf(plan);
    this.entries.delete(key);
    this.entries.set(key, { memory, partial: isPartial(plan) });
    while (this.entries.size > SNAPSHOT_LIMIT) this.entries.delete(this.victim());
  }

  private victim(): string {
    const all = [...this.entries];
    const others = all.slice(0, -1);
    const covered = others.find(([, { memory }], i) => all.slice(i + 1).some(([, newer]) => precedes(memory, newer.memory)));
    const [key] = covered ?? others.find(([, entry]) => entry.partial) ?? others[0] ?? all[0]!;
    return key;
  }

  clear(): void {
    this.entries.clear();
  }

  /**
   * 整体重排之前先试着从快照复原；`failed` 是刚刚失效的那份记忆（没有就是 undefined）。
   * 返回 `hold` 的第一个就用；都不成立返回 undefined，调用方整体重排。
   */
  restore(plan: SceneLayout, failed: AutoMemory | undefined, isKnown: (id: string) => boolean, area?: Area): Held | undefined {
    const exactKey = signatureOf(plan);
    const exact = this.entries.get(exactKey);
    if (exact) {
      const held = holdLayout(plan, exact.memory, isKnown, area);
      if (held.mode === "hold") return held;
    }
    const present = new Set(plan.nodes.map((node) => node.id));
    const whole = !isPartial(plan);
    const ranked = [...this.entries]
      .map(([key, { memory, partial }], recency) => ({ key, memory, behind: whole && partial, recency }))
      .filter(({ key, memory }) => key !== exactKey && [...memory.rects.keys()].every((id) => present.has(id)) && remembersMore(memory, failed))
      .sort((a, b) => Number(a.behind) - Number(b.behind) || b.memory.rects.size - a.memory.rects.size || b.recency - a.recency);
    for (const { memory } of ranked) {
      const held = holdLayout(plan, memory, (id) => memory.rects.has(id) && isKnown(id), area);
      if (held.mode === "hold") return held;
    }
    return undefined;
  }
}
