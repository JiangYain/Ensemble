import { memoryOf, type AutoMemory, type Held } from "./arrival-hold";
import type { Area, SceneLayout } from "./layout";

/**
 * 卡的尺寸体系翻转（紧凑 ↔ 宽屏）引起的整体重排，在这段时间内取景区域又变了，就用新的区域把排布再算一次（毫秒）。
 * 外壳切换（窄屏顶栏 ↔ 宽屏侧栏）时，取景区域会先量到一个过渡值、一两帧之后才是最终值（LAYOUT5 · W13）；
 * 这段时间只要几十毫秒，留得宽松一些，主线程忙的时候也能赶上。
 */
export const SETTLE_MS = 600;
/** 一次翻转之后最多再算几次：沿着窗口边缘连续拖动，不会让排布一路重排下去。 */
const MAX_CORRECTIONS = 2;

/** 这次规划与上一份记忆比：节点集合与上级都没变时，卡的尺寸变了（resized）还是都一样（same）；节点集合或上级变了就是 changed。 */
function compare(plan: SceneLayout, memory: AutoMemory): "same" | "resized" | "changed" {
  const now = memoryOf(plan);
  if (now.rects.size !== memory.rects.size) return "changed";
  let resized = false;
  for (const [id, rect] of memory.rects) {
    const next = now.rects.get(id);
    if (!next || memory.parents.get(id) !== now.parents.get(id)) return "changed";
    if (next.w !== rect.w || next.h !== rect.h) resized = true;
  }
  return resized ? "resized" : "same";
}

const sameArea = (a: Area, b: Area): boolean => a.w === b.w && a.h === b.h;

/**
 * 持有逻辑对“尺寸体系翻转”的善后。翻转时卡的尺寸变了，已有的位置都不能用，只能整体重排——这一次重排用的取景区域如果是过渡值，
 * 排出来的列数就是错的；随后区域变成最终值，卡的尺寸体系没变，持有逻辑按“窗口变了已有的卡不动”不再重排，就停在了那个错的排布上。
 * 所以这一次重排是**暂定**的：`SETTLE_MS` 之内，节点、尺寸、上级都没变而取景区域又变了，就无视持有的排布，用这一次的规划再整体重排，
 * 最多 `MAX_CORRECTIONS` 次。过了这段时间、或者中间卡有了任何变化（新会话、少了会话、上级、尺寸），暂定就作废——
 * 之后同一尺寸体系里的窗口变化仍然 0 位移（用户的决定：已有的卡原地不动）。
 */
export class Settling {
  private flip: { at: number; area: Area; corrections: number } | undefined;
  private readonly clock: () => number;

  constructor(clock: () => number) {
    this.clock = clock;
  }

  /** 这一次布局要不要无视持有的排布、用规划整体重排。 */
  corrects(plan: SceneLayout, memory: AutoMemory | undefined, area: Area | undefined): boolean {
    const flip = this.flip;
    if (!flip || !memory || !area) return false;
    if (this.clock() - flip.at > SETTLE_MS) {
      this.flip = undefined;
      return false;
    }
    return !sameArea(area, flip.area) && compare(plan, memory) === "same";
  }

  /** 这一次布局算完了：`before` 是它之前的记忆，`held` 是结果，`corrected` 是这次走的是不是上面的修正。 */
  note(plan: SceneLayout, before: AutoMemory | undefined, held: Held, area: Area | undefined, corrected: boolean): void {
    if (!area) {
      this.flip = undefined;
      return;
    }
    const flip = this.flip;
    if (corrected && flip) {
      this.flip = flip.corrections + 1 >= MAX_CORRECTIONS ? undefined : { at: flip.at, area, corrections: flip.corrections + 1 };
    } else if (held.mode === "full" && before && compare(plan, before) === "resized") {
      this.flip = { at: this.clock(), area, corrections: 0 };
    } else if (flip && before && compare(plan, before) !== "same") {
      this.flip = undefined;
    }
  }

  clear(): void {
    this.flip = undefined;
  }
}
