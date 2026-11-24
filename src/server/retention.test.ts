import { describe, expect, it, vi } from "vitest";
import type { RetentionSettings } from "@shared/protocol";
import { DAY, lazyHub, NOW, seed, SpyStore, type Clock, type SessionFixture } from "./history-fixtures";
import { silentLogger } from "./logger";
import { RetentionSweeper } from "./retention";

const ago = (days: number): number => NOW - days * DAY;

/** 一棵有两代的老树、一个孤零零的老会话、一个新会话、一个很久以前开始却还在跑的会话，以及一棵“根很老但子会话很新”的树。 */
const FIXTURES: SessionFixture[] = [
  { id: "p", at: ago(60) },
  { id: "c", parent: "p", at: ago(59), depth: 1 },
  { id: "solo", at: ago(50) },
  { id: "recent", at: ago(2) },
  { id: "busy_old", ending: "running", at: ago(90) },
  { id: "fam_new", at: ago(80) },
  { id: "fam_new_kid", parent: "fam_new", at: ago(1) },
];

async function setup(settings: RetentionSettings, fixtures: readonly SessionFixture[] = FIXTURES, options: { batchSize?: number } = {}) {
  const store = new SpyStore();
  await seed(store, fixtures);
  const clock: Clock = { now: NOW };
  const hub = lazyHub(store, clock);
  await hub.load();
  store.loads.length = 0;
  store.logReads.length = 0;
  const current = { value: settings };
  const sweeper = new RetentionSweeper({ hub, log: silentLogger, settings: () => current.value, now: () => clock.now, ...options });
  return { store, hub, clock, sweeper, current };
}

const archivedIds = (hub: Awaited<ReturnType<typeof setup>>["hub"]): string[] =>
  hub.allSummaries("only").map((summary) => summary.id).sort();

describe("RetentionSweeper", () => {
  it("does nothing while both limits are off, and still records that it looked", async () => {
    const { hub, sweeper } = await setup({ keepDays: null, keepCount: null });
    expect(sweeper.lastSweep()).toBeUndefined();

    const result = await sweeper.sweep();

    expect(result.archived).toBe(0);
    expect(result.at).toEqual(expect.any(String));
    expect(sweeper.lastSweep()).toBe(result);
    expect(hub.counts().archived).toBe(0);
  });

  it("keepDays archives finished trees that have been quiet for longer than that, as the retention policy", async () => {
    const { hub, sweeper } = await setup({ keepDays: 30, keepCount: null });

    const result = await sweeper.sweep();

    // 计的是会话数：p 与它的子会话 c，加上 solo。
    expect(result.archived).toBe(3);
    expect(archivedIds(hub)).toEqual(["c", "p", "solo"]);
    for (const id of ["p", "c", "solo"]) expect(hub.archiveOf(id), id).toMatchObject({ by: "retention" });
    expect(hub.summary("solo")?.archivedBy).toBe("retention");
  });

  it("never archives a tree with a session still working, however old, nor a tree that has recent activity anywhere in it", async () => {
    const { hub, sweeper } = await setup({ keepDays: 7, keepCount: null });

    await sweeper.sweep();

    expect(archivedIds(hub)).toEqual(["c", "p", "solo"]);
    for (const id of ["busy_old", "fam_new", "fam_new_kid", "recent"]) expect(hub.archiveOf(id), id).toBeUndefined();
  });

  it("keepCount keeps the most recently active trees, and a tree that is still working holds a place without ever being archived", async () => {
    const { hub, sweeper } = await setup({ keepDays: null, keepCount: 2 });

    const result = await sweeper.sweep();

    // 按最后活动排：fam_new（1 天前）、recent（2 天前）留下；solo、p 树被归档；busy_old 排在最后但还在跑，不动。
    expect(archivedIds(hub)).toEqual(["c", "p", "solo"]);
    expect(result.archived).toBe(3);
  });

  it("applies both limits together", async () => {
    const { hub, sweeper } = await setup({ keepDays: 55, keepCount: 3 });

    await sweeper.sweep();

    // keepDays 55：p 树（最后活动 59 天前）太旧；keepCount 3：fam_new、recent、solo 占前三个名额，p 树在名额之外。
    expect(archivedIds(hub)).toEqual(["c", "p"]);
  });

  it("has nothing left to do the second time", async () => {
    const { sweeper } = await setup({ keepDays: 30, keepCount: null });
    expect((await sweeper.sweep()).archived).toBe(3);
    expect((await sweeper.sweep()).archived).toBe(0);
  });

  it("only archives: nothing is deleted, no log is read, and every session keeps its history and state", async () => {
    const { store, hub, sweeper } = await setup({ keepDays: 30, keepCount: null });
    const before = await Promise.all(FIXTURES.map((fixture) => store.load(fixture.id)));
    const summaries = new Map(hub.allSummaries().map((summary) => [summary.id, summary]));
    store.loads.length = 0;

    await sweeper.sweep();

    expect(store.loads).toEqual([]);
    expect(store.logReads).toEqual([]);
    expect(hub.counts().total).toBe(FIXTURES.length);
    expect(await Promise.all(FIXTURES.map((fixture) => store.load(fixture.id)))).toEqual(before);
    for (const id of ["p", "c", "solo"]) {
      expect(hub.summary(id), id).toMatchObject({ phase: summaries.get(id)?.phase, seq: summaries.get(id)?.seq, updatedAt: summaries.get(id)?.updatedAt });
    }
  });

  it("gets the same result in small batches as in one go, re-planning between batches", async () => {
    const fixtures: SessionFixture[] = [1, 2, 3, 4, 5, 6].map((n) => ({ id: `r${n}`, at: ago(n * 10) }));
    const whole = await setup({ keepDays: null, keepCount: 2 }, fixtures);
    const batched = await setup({ keepDays: null, keepCount: 2 }, fixtures, { batchSize: 1 });

    const one = await whole.sweeper.sweep();
    const many = await batched.sweeper.sweep();

    expect(one.archived).toBe(4);
    expect(many.archived).toBe(4);
    expect(archivedIds(batched.hub)).toEqual(archivedIds(whole.hub));
    expect(archivedIds(batched.hub)).toEqual(["r3", "r4", "r5", "r6"]);
  });

  it("reads the settings afresh on every sweep, so a changed policy applies to the next one", async () => {
    const { hub, sweeper, current } = await setup({ keepDays: null, keepCount: null });
    expect((await sweeper.sweep()).archived).toBe(0);

    current.value = { keepDays: 70, keepCount: null };
    expect((await sweeper.sweep()).archived).toBe(0);
    current.value = { keepDays: 55, keepCount: null };
    expect((await sweeper.sweep()).archived).toBe(2);
    expect(archivedIds(hub)).toEqual(["c", "p"]);
    current.value = { keepDays: 30, keepCount: null };
    expect((await sweeper.sweep()).archived).toBe(1);
    expect(archivedIds(hub)).toEqual(["c", "p", "solo"]);
  });

  it("runs one sweep after the other when asked twice at once, so the second sees the first's work", async () => {
    const { sweeper } = await setup({ keepDays: 30, keepCount: null });
    const [first, second] = await Promise.all([sweeper.sweep(), sweeper.sweep()]);
    expect(first.archived).toBe(3);
    expect(second.archived).toBe(0);
    expect(sweeper.lastSweep()).toBe(second);
  });

  it("judges age against its own clock: at an earlier moment the same sessions are not old enough yet", async () => {
    const { hub, sweeper, clock } = await setup({ keepDays: 30, keepCount: null });
    // “现在”往回拨到 solo 结束两天之后：此刻它只有两天，不够旧；p 树（最后活动在 59 天前）此刻只有 11 天，同样不够旧。
    clock.now = ago(50) + 2 * DAY;

    const result = await sweeper.sweep();

    expect(result.archived).toBe(0);
    expect(hub.counts().archived).toBe(0);
  });

  it("sweeps on its own timer once started, and stops cleanly", async () => {
    const { hub, store } = await setup({ keepDays: 30, keepCount: null });
    const sweeper = new RetentionSweeper({ hub, log: silentLogger, settings: () => ({ keepDays: 30, keepCount: null }), now: () => NOW, intervalMs: 10 });

    sweeper.start();
    await vi.waitFor(() => expect(sweeper.lastSweep()).toBeDefined());
    await sweeper.stop();

    expect(hub.counts().archived).toBe(3);
    expect(await store.readArchive("solo")).toMatchObject({ by: "retention" });
  });
});
