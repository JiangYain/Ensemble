import { describe, expect, it } from "vitest";
import { holdLayout, memoryOf, type AutoMemory } from "./arrival-hold";
import { agent, DESK, roots } from "./arrival.fixtures";
import { Snapshots, SNAPSHOT_LIMIT } from "./hold-restore";
import { layoutScene, type SceneLayout } from "./layout";

/**
 * 快照逐出时“被更新的某份包住的前身先走”（hold-restore.ts 的 `precedes`）：前身的每张卡在后继里都有，位置、尺寸**上级**一样，**格点形态**也一样。
 * 上级不同（那个会话改挂过）、格点形态不同（一份是格点、一份是经典的树）时，前身还能在撤销那次改动之后派上用场，不能被当作“已被包住”而先逐出。
 * hold.restore*.test.ts 里前身与后继的上级、格点形态总是一样的，所以把这两条比较各自拿掉，旧套件都照样全绿；
 * 这里用真实的生长线（12 个根长到 13 个）造出前身与后继，再各改一处，直接看谁被逐出。
 */

/** 来源 key 与会话 id 都带 `tag` 的 `count` 个根会话，节点集合与别的 tag 互不相交——逐出谁只取决于“前身”这一条关系。 */
const planOf = (tag: string, count: number): SceneLayout => layoutScene(roots(`cursor:${tag}`, count, 1, `${tag}-`), DESK);

const before = planOf("g", 12);
const beforeMemory = memoryOf(before);
/** 真实的生长：从 12 个长到 13 个，已有的卡原地不动，新卡落进空位；记忆里的格点形态与前身一样。 */
const grown = holdLayout(planOf("g", 13), beforeMemory, (id) => beforeMemory.rects.has(id), DESK.area);

/** [后继与前身的差别, 前身是否被先逐出, 把真实的后继记忆改成那个样子]。 */
const CASES: ReadonlyArray<readonly [string, boolean, (memory: AutoMemory) => AutoMemory]> = [
  ["位置、尺寸、上级、格点形态都一样（同一条生长线）", true, (memory) => memory],
  ["只有一个会话的上级不同（改挂过）", false, (memory) => ({ ...memory, parents: new Map(memory.parents).set(agent("g-2"), agent("g-1")) })],
  ["只有格点形态不同（一份是格点、一份是经典的树）", false, (memory) => ({ ...memory, grid: !memory.grid })],
];

describe("Snapshots 逐出：谁算“被包住的前身”", () => {
  it("前提：真实的生长线上，后继记得前身的每张卡、位置不变，格点形态相同", () => {
    expect(grown.mode).toBe("hold");
    expect(beforeMemory.grid, "12 个根会话在桌面区域里是格点").toBe(true);
    expect(grown.memory.grid).toBe(beforeMemory.grid);
    expect(grown.memory.rects.size).toBe(beforeMemory.rects.size + 1);
    for (const [id, rect] of beforeMemory.rects) expect(grown.memory.rects.get(id), id).toEqual(rect);
    expect(grown.memory.parents.get(agent("g-2")), "被改挂的会话在前身里挂在来源卡上").toBe("origin:cursor:g");
  });

  it.each(CASES)("%s：前身被先逐出 = %s", (_name, predecessorGoes, change) => {
    const snaps = new Snapshots();
    // 最旧的一份、与生长线无关；然后是前身，凑满上限的几份无关的，最后是后继；再多记一份最新的，逼出一次逐出。
    const old = planOf("old", 2);
    snaps.save(old, memoryOf(old));
    snaps.save(before, beforeMemory);
    for (let i = 0; i < SNAPSHOT_LIMIT - 3; i++) {
      const filler = planOf(`f${i}`, 2);
      snaps.save(filler, memoryOf(filler));
    }
    snaps.save(planOf("g", 13), change(grown.memory));
    expect(snaps.size, "前提：正好记满").toBe(SNAPSHOT_LIMIT);
    const newest = planOf("newest", 2);
    snaps.save(newest, memoryOf(newest));
    expect(snaps.size).toBe(SNAPSHOT_LIMIT);

    // 谁还在：用它自己的规划去复原，能原样复原就是还在。
    const alive = (plan: SceneLayout): boolean => snaps.restore(plan, undefined, () => false, DESK.area) !== undefined;
    expect(alive(before), "前身").toBe(!predecessorGoes);
    expect(alive(old), "最旧的一份").toBe(predecessorGoes);
  });
});
