import { holdLayout, type AutoMemory } from "./arrival-hold";
import { driftsFromPlan } from "./hold-drift";
import { Snapshots } from "./hold-restore";
import { Settling } from "./hold-settle";
import type { Area, SceneLayout } from "./layout";

/**
 * 引擎持有的“上一次排布”（只在内存里，刷新页面就没有了）：把规划交给它，拿回已有卡原位、新卡落进空位的布局（见 arrival-hold.ts）。
 *
 * 除了上一次排布，还记着最近几次排布的快照（hold-restore.ts）：隐藏一批会话会让画布整体重排，再显示出来时就直接用隐藏之前的排布——
 * 所以隐藏再显示是原样复原，而不是换成另一种排法；隐藏期间来了新会话也一样（不论来了几个），新会话落进下一个空位。
 * 快照最多 8 份、内存有界：超出时先丢被后来者包住的前驱、再丢只画了一部分卡的，所以隐藏之前的那份不会被隐藏期间的新排布挤掉。
 * 卡的尺寸体系翻转（紧凑 ↔ 宽屏）的那一次整体重排是暂定的，取景区域随后又变时会再算一次（hold-settle.ts）。
 */
export class HeldLayout {
  private memory: AutoMemory | undefined;
  /** 最近一次拿到的原始规划：“重置节点布局”要拿它整体重排。 */
  private raw: SceneLayout | undefined;
  /** 最近一次交出去的布局：引擎重放它（挂载、重置）时同一个对象再交进来，不是新规划，原样放行。 */
  private shown: SceneLayout | undefined;
  /** `shown` 与 `raw` 按内容比不一样（见 hold-drift.ts）：在 `apply` 里算好，`drifted` 只读它。 */
  private drift = false;
  private readonly snapshots = new Snapshots();
  private readonly settling: Settling;

  /** `clock`：暂定的整体重排计时用（毫秒），测试里换成假的；默认是 `performance.now()`。 */
  constructor(clock: () => number = () => performance.now()) {
    this.settling = new Settling(clock);
  }

  /**
   * `isKnown`：早就知道的节点（出现过，或被视图过滤收起过）；它们再出现不算新来的，要整体重排。
   * `area`：画布取景区域，只用来判断竖排的一列满没满、下一张新卡要不要另起一列（见 arrival-columns.ts），以及判断暂定的重排要不要再算一次；不给就一直往下接。
   */
  apply(plan: SceneLayout, isKnown: (id: string) => boolean, area?: Area): SceneLayout {
    if (plan === this.shown) return plan;
    this.raw = plan;
    const before = this.memory;
    const correcting = this.settling.corrects(plan, before, area);
    let held = holdLayout(plan, correcting ? undefined : before, isKnown, area);
    if (held.mode === "full" && !correcting) held = this.snapshots.restore(plan, before, isKnown, area) ?? held;
    this.settling.note(plan, before, held, area, correcting);
    this.memory = held.memory;
    this.shown = held.layout;
    this.drift = driftsFromPlan(held.layout, plan);
    this.snapshots.save(plan, held.memory);
    return held.layout;
  }

  /** 现在交出去的布局与最近一次的全新规划不一样（有会话卡留在原位、没跟着规划走）：这时“重新排列”才有东西可排，没拖过节点也要让用户点得到。 */
  get drifted(): boolean {
    return this.drift;
  }

  /**
   * 忘掉记忆（换空间、点“重置节点布局”、重置记下的排布缩放变了）：下一次布局整体重排。
   * 返回最近一次的原始规划，调用方可以拿它立即重排；还没有过规划就是 undefined。
   */
  reset(): SceneLayout | undefined {
    this.memory = undefined;
    this.shown = undefined;
    this.drift = false;
    this.snapshots.clear();
    this.settling.clear();
    return this.raw;
  }
}
