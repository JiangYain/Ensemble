import { describe, expect, it } from "vitest";
import { holdLayout, memoryOf, type AutoMemory } from "./arrival-hold";
import { DESK, moved, roots } from "./arrival.fixtures";
import { a, grown19, KEY, stage, VISIBLE } from "./hold.restore.fixtures";
import { Snapshots, SNAPSHOT_LIMIT } from "./hold-restore";
import { layoutScene, type SceneLayout } from "./layout";
import { overlapsOf } from "./layout.fixtures";

/**
 * 隐藏期间来了很多新会话，再显示出来仍然复原，不整张画布重排（LAYOUT7 · W12）。
 *
 * 根因有两个，都在 hold-restore.ts，缺一个都不行：
 *  1. 容量：快照只记最近 8 份，隐藏期间每来一个新会话就多一份快照，来了 7 个隐藏之前那份就被按“最旧”挤掉了。
 *  2. 下限：只试“比刚失效的记忆大”的快照；隐藏期间的记忆每来一个新会话多一张，来了 11 个它就与隐藏之前那份一样大，那份被挡在门外。
 * 现在：逐出时先丢被更新的快照包住的前驱（同一条生长线上），再丢只画了一部分卡的，最后才是最旧的，永不丢最新的一份；
 * 下限换成“快照记得失效的那份记忆里没有的卡”。内存仍然有界（8 份，每份只是一张位置表）。
 */

/** 隐藏成 VISIBLE 之后，隐藏期间陆续来 `arrivals` 个新会话（r19 起）；`shownCount` 个之内的都在工作（留在视图里），其余也被收起。 */
function hideAndArrive(arrivals: number, shownCount = arrivals) {
  const run = grown19();
  run.show(a(18), { visible: VISIBLE });
  const visible = [...VISIBLE];
  for (let n = 19; n < 19 + arrivals; n++) {
    if (n - 18 <= shownCount) visible.push(`r${n}`);
    run.show(a(n), { visible: [...visible] });
  }
  return run;
}

describe("HeldLayout · 隐藏期间来得很多，恢复不受来了几个的限制", () => {
  it.each([1, 2, 5, 6, 7, 8, 11, 12, 20, 30, 60])("隐藏期间来了 %i 个新会话（都在工作）→ 恢复：隐藏之前的 19 张卡 0 移动，新卡都在、不重叠、不是整体重排", (arrivals) => {
    const run = hideAndArrive(arrivals);
    const back = run.show(a(18 + arrivals));
    expect(back.shown.nodes).toHaveLength(19 + arrivals);
    expect(moved(run.before, back.shown), "隐藏之前的卡一像素不动").toEqual([]);
    expect(overlapsOf(back.shown)).toEqual([]);
    expect(back.shown, "不是整体重排").not.toBe(back.plan);
    expect(run.held.drifted, "恢复出来的排布不同于规划：重新排列有东西可排").toBe(true);
  });

  it("隐藏期间来了 12 个、其中一半也被收起（不在工作）→ 恢复：19 张老卡 0 移动，12 张新卡都落进空位", () => {
    const run = hideAndArrive(12, 6);
    const midway = run.show(a(30), { visible: [...VISIBLE, "r19", "r20", "r21", "r22", "r23", "r24"] });
    expect(midway.plan.hidden?.size, "前提：到这一刻有会话被收起").toBeGreaterThan(0);
    const back = run.show(a(30));
    expect(back.shown.nodes).toHaveLength(31);
    expect(moved(run.before, back.shown)).toEqual([]);
    expect(overlapsOf(back.shown)).toEqual([]);
    expect(back.shown).not.toBe(back.plan);
  });

  it("隐藏期间一边来新会话、一边有会话结束退出视图（十几次互不相干的整体重排）→ 恢复仍是隐藏之前那份", () => {
    const run = grown19();
    run.show(a(18), { visible: VISIBLE });
    const live = [...VISIBLE];
    let churned = 0;
    for (let n = 19; n <= 18 + 16; n++) {
      live.push(`r${n}`);
      // 每隔一个新会话就有一个旧的结束、退出视图：视图里有卡消失，记忆失效，整体重排一次。
      if (n % 2 === 0) live.shift();
      const step = run.show(a(n), { visible: [...live] });
      if (step.shown === step.plan) churned++;
    }
    expect(churned, "前提：隐藏期间整体重排了很多次，各留下一份互不相干的快照").toBeGreaterThanOrEqual(8);
    const back = run.show(a(18 + 16));
    expect(moved(run.before, back.shown)).toEqual([]);
    expect(overlapsOf(back.shown)).toEqual([]);
    expect(back.shown).not.toBe(back.plan);
  });

  it("连着两轮“隐藏 → 来很多 → 显示”：第二轮恢复的是第一轮恢复出来的那份，更早那份也没有动", () => {
    const run = hideAndArrive(9);
    const first = run.show(a(27));
    expect(moved(run.before, first.shown), "前提：第一轮复原").toEqual([]);

    run.show(a(27), { visible: ["r3", "r9", "r20"] });
    for (let n = 28; n <= 37; n++) run.show(a(n), { visible: ["r3", "r9", "r20", `r${n}`] });
    const second = run.show(a(37));
    expect(second.shown.nodes).toHaveLength(38);
    expect(moved(first.shown, second.shown), "第一轮恢复出来的 28 张卡原位").toEqual([]);
    expect(moved(run.before, second.shown), "隐藏之前的 19 张卡原位").toEqual([]);
    expect(overlapsOf(second.shown)).toEqual([]);
  });

  it("会话直接消失又回来（没有视图过滤，每份快照都是完整的）：期间来了 12 个新会话，回来后同样是隐藏之前那份", () => {
    const run = grown19();
    const kept = a(18).filter((s) => VISIBLE.includes(s.id));
    const gone = run.show(kept);
    expect(gone.plan.hidden, "前提：不是视图过滤，没有收起的会话").toBeUndefined();
    expect(gone.shown, "前提：卡消失，整体重排").toBe(gone.plan);
    for (let n = 19; n <= 30; n++) run.show([...kept, ...a(n).slice(18)]);

    const back = run.show(a(30));
    expect(back.shown.nodes).toHaveLength(31);
    expect(moved(run.before, back.shown)).toEqual([]);
    expect(overlapsOf(back.shown)).toEqual([]);
    expect(back.shown).not.toBe(back.plan);
  });

  it("隐藏期间来了 12 个、又有一张老卡被删除 → 记着它的快照都不成立，整体重排，而不是拿隐藏期间的排布凑数", () => {
    const run = hideAndArrive(12);
    const without3 = a(30).filter((s) => s.id !== "r3");
    const back = run.show(without3);
    expect(back.shown, "整体重排：交出去的就是规划").toBe(back.plan);
    expect(moved(run.before, back.shown).length, "前提：整体重排确实挪动了老卡").toBeGreaterThan(0);
  });
});

/** 前 `n` 个根里没有 `away` 的那些：视图过滤后留下的会话。 */
const view = (n: number, ...away: string[]): string[] => a(n).map((s) => s.id).filter((id) => !away.includes(id));

/**
 * 再显示全部时，完整的快照先于只画了一部分的（LAYOUT9，VLAYOUT4 · V4-5 量到的缺陷）。
 *
 * `restore()` 以前只按快照的节点数从大到小试。隐藏期间视图里的卡可能一度比隐藏之前的总数还多（新会话一直在工作），
 * 那份只画了一部分的快照因此排在最前；它又记得一张后来结束的会话，被当成前提，隐藏之前被收起的老卡就都成了“新卡”，隐藏之前的位置整个丢了。
 * 现在：这次规划画全了（再显示全部），完整的快照先于只画了一部分的；规划自己仍被过滤着就照旧按大小。
 * 第三例说明为什么不是“完整一律先于部分”：过滤仍开着时，还能用的完整快照是又旧又小的一份，让它先试会把几张卡一起拽走。
 */
describe("HeldLayout · 再显示全部时先试完整的快照", () => {
  it("隐藏期间长出的画面比隐藏之前那份还大（13 个新会话在工作），中途又有一个老会话结束退出视图 → 恢复仍是隐藏之前那份，不是隐藏期间那份只画了一部分的", () => {
    const run = grown19();
    run.show(a(18), { visible: VISIBLE });
    const live = [...VISIBLE];
    let biggestPartial = 0;
    for (let n = 19; n <= 18 + 15; n++) {
      live.push(`r${n}`);
      const step = run.show(a(n), { visible: [...live] });
      biggestPartial = Math.max(biggestPartial, step.plan.nodes.length);
      // 第 13 个新会话到来之后，一个隐藏之前就在工作的老会话结束、退出视图：记忆失效，而它留下的快照里有一张失效记忆里没有的卡。
      if (n === 18 + 13) {
        live.shift();
        run.show(a(n), { visible: [...live] });
      }
    }
    expect(biggestPartial, "前提：隐藏期间的排布比隐藏之前的 19 张卡还大").toBeGreaterThan(19);
    const back = run.show(a(18 + 15));
    expect(back.shown.nodes).toHaveLength(34);
    expect(moved(run.before, back.shown), "隐藏之前的 19 张卡一像素不动").toEqual([]);
    expect(overlapsOf(back.shown)).toEqual([]);
    expect(back.shown, "不是整体重排").not.toBe(back.plan);
  });

  it("没有任何完整快照能用（隐藏期间一张老卡被删除，每份完整快照都记着它）：只剩只画了一部分的快照，它们仍然被试用，不整体重排", () => {
    const run = grown19();
    let peak = run.show(a(18), { visible: VISIBLE }).shown;
    const live = [...VISIBLE];
    for (let n = 19; n <= 24; n++) {
      live.push(`r${n}`);
      peak = run.show(a(n), { visible: [...live] }).shown;
    }
    // 隐藏之前就在工作的 r2 结束、退出视图：记忆失效，它留在隐藏期间的快照里。
    live.shift();
    run.show(a(24), { visible: [...live] });

    const without3 = a(24).filter((s) => s.id !== "r3");
    const back = run.show(without3);
    expect(back.plan.hidden?.size ?? 0, "前提：这次规划画全了（完整先于部分这一档在起作用）").toBe(0);
    expect(back.shown, "不是整体重排：只画了一部分的快照被拿来当前提").not.toBe(back.plan);
    expect(moved(peak, back.shown), "隐藏期间最大的那份（14 张卡）原样回来").toEqual([]);
    expect(overlapsOf(back.shown)).toEqual([]);
  });

  it("视图仍然过滤着、两个会话又回到视图里 → 恢复的是其中一个离开之前那份同样只画了一部分的快照，不是一份又旧又小的完整快照（完整并不一律先于部分）", () => {
    const run = stage();
    run.show(a(3)); // 完整的快照：来源卡与 r1…r3，又旧又小
    // 视图开始过滤：r3、r6 不在工作被收起。旧快照记着 r3，不成立 → 整体重排，得到一份只画了一部分的排布（规划自己的格点位置）。
    const before = run.show(a(12), { visible: view(12, "r3", "r6") });
    expect(before.plan.hidden?.size, "前提：视图过滤着").toBe(2);
    expect(before.shown, "前提：整体重排").toBe(before.plan);
    run.show(a(12), { visible: view(12, "r2", "r3", "r6") }); // r2 也离开视图：又整体重排一次

    // r2、r3 都回到视图，同时来了 r13；视图仍然过滤着 r6。完整的旧快照（r1…r3）与离开之前那份都记得 r2。
    const back = run.show(a(13), { visible: view(13, "r6") });
    expect(back.plan.hidden?.size, "前提：视图仍然过滤着").toBe(1);
    expect(back.shown, "不是整体重排").not.toBe(back.plan);
    expect(moved(before.shown, back.shown), "r2 离开之前那份排布原样回来，不是旧完整快照往后重新长出来的那份").toEqual([]);
    expect(overlapsOf(back.shown)).toEqual([]);
  });
});

/** 一份完整的排布：n 个根，id 带前缀，所以不同前缀的排布互不相干（节点集合不会互相包含）。 */
function unrelated(prefix: string, n = 5): { plan: SceneLayout; memory: AutoMemory } {
  const plan = layoutScene(roots(KEY, n, 1, prefix), DESK);
  return { plan, memory: memoryOf(plan) };
}

/** 只画了一部分卡的排布：视图过滤着，只留 2 个根，其余收起（`plan.hidden` 不为空）。 */
function partial(prefix: string, n = 6): { plan: SceneLayout; memory: AutoMemory } {
  const plan = layoutScene(roots(KEY, n, 1, prefix), { ...DESK, visible: new Set([`${prefix}1`, `${prefix}2`]) });
  if (!plan.hidden?.size) throw new Error("前提：有会话被收起");
  return { plan, memory: memoryOf(plan) };
}

/** 12 → 18 个根逐个长出来的 7 份排布：后一份是前一份“已有的卡不动、新卡落进空位”长成的（前一份被后一份包住）。 */
function growth(from = 12, to = 18): { plan: SceneLayout; memory: AutoMemory }[] {
  const seen = new Set<string>();
  let memory: AutoMemory | undefined;
  const out: { plan: SceneLayout; memory: AutoMemory }[] = [];
  for (let n = from; n <= to; n++) {
    const plan = layoutScene(a(n), DESK);
    const held = holdLayout(plan, memory, (id) => seen.has(id), DESK.area);
    for (const node of plan.nodes) seen.add(node.id);
    memory = held.memory;
    out.push({ plan, memory });
  }
  return out;
}

const lookup = (snapshots: Snapshots, plan: SceneLayout) => snapshots.restore(plan, undefined, () => false, DESK.area)?.mode;

describe("Snapshots · 逐出与下限", () => {
  it("内存有界：存进 200 份互不相干的排布，只留最近的 8 份", () => {
    const snapshots = new Snapshots();
    const all = Array.from({ length: 200 }, (_, i) => unrelated(`x${i}-`));
    for (const entry of all) snapshots.save(entry.plan, entry.memory);
    expect(snapshots.size).toBe(SNAPSHOT_LIMIT);
    expect(all.slice(-SNAPSHOT_LIMIT).map((entry) => lookup(snapshots, entry.plan))).toEqual(Array(SNAPSHOT_LIMIT).fill("hold"));
    expect(lookup(snapshots, all[all.length - SNAPSHOT_LIMIT - 1]!.plan), "再早一份已经被挤掉").toBeUndefined();
  });

  it("先丢被更新的快照包住的前驱：旧的互不相干的排布排在生长线前面，超出 8 份时丢的是生长线上的前驱，不是最旧的那几份", () => {
    const snapshots = new Snapshots();
    const others = [1, 2, 3, 4].map((i) => unrelated(`x${i}-`));
    const chain = growth();
    for (const entry of [...others, ...chain]) snapshots.save(entry.plan, entry.memory);
    expect(snapshots.size).toBe(SNAPSHOT_LIMIT);
    expect(others.map((entry) => lookup(snapshots, entry.plan)), "最旧的几份互不相干的排布都还在").toEqual(Array(4).fill("hold"));
    expect(chain.map((entry) => lookup(snapshots, entry.plan)), "生长线上只留最新的几份（被包住的前驱 12、13、14 个根那三份走了）").toEqual([undefined, undefined, undefined, "hold", "hold", "hold", "hold"]);
  });

  it("只画了一部分卡的先于完整的逐出：最旧的一份是完整的，之后存了 8 份只画一部分的，丢的是最旧的那份只画一部分的", () => {
    const snapshots = new Snapshots();
    const whole = unrelated("w-");
    const parts = Array.from({ length: SNAPSHOT_LIMIT }, (_, i) => partial(`p${i + 1}-`));
    snapshots.save(whole.plan, whole.memory);
    for (const entry of parts) snapshots.save(entry.plan, entry.memory);
    expect(snapshots.size).toBe(SNAPSHOT_LIMIT);
    expect(lookup(snapshots, whole.plan), "最旧的那份完整排布还在").toBe("hold");
    expect(parts.map((entry) => lookup(snapshots, entry.plan))).toEqual([undefined, ...Array(SNAPSHOT_LIMIT - 1).fill("hold")]);
  });

  it("最新的一份不会被逐出：别的都是完整的、最新这份只画了一部分，丢的是最旧的完整那份", () => {
    const snapshots = new Snapshots();
    const whole = Array.from({ length: SNAPSHOT_LIMIT }, (_, i) => unrelated(`w${i + 1}-`));
    const newest = partial("q-");
    for (const entry of [...whole, newest]) snapshots.save(entry.plan, entry.memory);
    expect(snapshots.size).toBe(SNAPSHOT_LIMIT);
    expect(lookup(snapshots, newest.plan), "最新的一份还在").toBe("hold");
    expect(whole.map((entry) => lookup(snapshots, entry.plan))).toEqual([undefined, ...Array(SNAPSHOT_LIMIT - 1).fill("hold")]);
  });

  it("同一份节点集合只留最近一次：重复存同一份不占份数、也不挤掉别的", () => {
    const snapshots = new Snapshots();
    const keep = Array.from({ length: SNAPSHOT_LIMIT - 1 }, (_, i) => unrelated(`k${i + 1}-`));
    for (const entry of keep) snapshots.save(entry.plan, entry.memory);
    const again = unrelated("same-");
    for (let i = 0; i < 20; i++) snapshots.save(again.plan, again.memory);
    expect(snapshots.size).toBe(SNAPSHOT_LIMIT);
    expect(keep.map((entry) => lookup(snapshots, entry.plan))).toEqual(Array(SNAPSHOT_LIMIT - 1).fill("hold"));
  });

  it("下限：快照要记得失效的那份记忆里没有的卡才算“往回走”；失效的记忆比它大也一样（隐藏期间攒了很多新卡）", () => {
    const [, , , c15] = growth();
    if (!c15) throw new Error("前提：生长线有 15 个根那份");
    const snapshots = new Snapshots();
    snapshots.save(c15.plan, c15.memory);
    const plan = layoutScene(a(40), DESK);
    const seenAll = (): boolean => true;

    // 失效的记忆只有 r16…r40：比快照（15 个根）还大，但快照记得的 r1…r15 它都没有。
    const late = layoutScene(a(40).filter((s) => Number(s.id.slice(1)) > 15), DESK);
    expect(late.nodes.length, "前提：失效的记忆比快照大").toBeGreaterThan(c15.memory.rects.size);
    const back = snapshots.restore(plan, memoryOf(late), seenAll, DESK.area);
    expect(back?.mode, "复原：快照里的 15 个根原位，其余落进空位").toBe("hold");
    const stayed = [...c15.memory.rects].filter(([id, rect]) => back?.layout.nodes.some((node) => node.id === id && node.x === rect.x && node.y === rect.y));
    expect(stayed, "快照里的每一张卡（来源卡加 15 个根）都在原位").toHaveLength(c15.memory.rects.size);

    // 失效的记忆已经包含快照里的每一张卡（快照是它的前身）：用快照等于把排布撤回到更早更小的样子，不算。
    const c16 = growth()[4];
    if (!c16) throw new Error("前提：生长线有 16 个根那份");
    expect(snapshots.restore(layoutScene(a(18), DESK), c16.memory, seenAll, DESK.area), "快照是失效的记忆的前身：不复原").toBeUndefined();
  });
});
