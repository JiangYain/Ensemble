import { describe, expect, it, vi } from "vitest";
import { archiveSessions, archiveTreeOf, reviveSession, unarchiveSessions } from "./archive";
import { lazyHub, NOW, seed, SpyStore, type Clock, type SessionFixture } from "./history-fixtures";
import { silentLogger } from "./logger";

const FIXTURES: SessionFixture[] = [
  { id: "root" },
  { id: "kid", parent: "root" },
  { id: "grandkid", parent: "kid", depth: 2 },
  { id: "other" },
  { id: "busy", ending: "running" },
  { id: "idle", ending: "ready" },
  { id: "waiting", ending: "pending" },
  { id: "family" },
  { id: "family_busy", parent: "family", ending: "running" },
];

/** 把这些会话放进存储、启动一个懒加载的中枢（已结束的都是冷的）；之后的读写次数从零数起。 */
async function started(fixtures: readonly SessionFixture[] = FIXTURES) {
  const store = new SpyStore();
  await seed(store, fixtures);
  const clock: Clock = { now: NOW };
  const hub = lazyHub(store, clock);
  await hub.load();
  store.loads.length = 0;
  store.logReads.length = 0;
  return { store, hub, clock };
}

describe("archiveSessions", () => {
  it("archives a finished session with everything below it, as the user, without reading any session log", async () => {
    const { store, hub } = await started();

    const result = await archiveSessions(hub, ["root"], "user");

    expect(result).toEqual({ changed: ["root", "kid", "grandkid"], skipped: [] });
    for (const id of result.changed) {
      expect(hub.archiveOf(id), id).toMatchObject({ by: "user" });
      expect(hub.summary(id)?.archivedBy, id).toBe("user");
      expect(await store.readArchive(id), id).toMatchObject({ by: "user" });
    }
    expect(hub.archiveOf("other")).toBeUndefined();
    expect(store.loads).toEqual([]);
    expect(store.logReads).toEqual([]);
    expect(hub.isHot("root")).toBe(false);
  });

  it("refuses what is still going on: a working session, a ready one and one with an unconfirmed message", async () => {
    const { hub } = await started();

    const result = await archiveSessions(hub, ["busy", "idle", "waiting", "ghost"], "user");

    expect(result).toEqual({
      changed: [],
      skipped: [
        { id: "busy", reason: "active" },
        { id: "idle", reason: "active" },
        { id: "waiting", reason: "active" },
        { id: "ghost", reason: "not_found" },
      ],
    });
    expect(hub.counts().archived).toBe(0);
  });

  it("skips a whole family when any member is still working, even if the one asked for has finished", async () => {
    const { hub } = await started();

    const result = await archiveSessions(hub, ["family"], "user");

    expect(result).toEqual({ changed: [], skipped: [{ id: "family", reason: "active" }] });
    expect(hub.archiveOf("family")).toBeUndefined();
    expect(hub.archiveOf("family_busy")).toBeUndefined();
  });

  it("reports an already archived session as such, and changes nothing the second time", async () => {
    const { hub } = await started();
    await archiveSessions(hub, ["root"], "user");
    const mark = hub.archiveOf("root");

    const again = await archiveSessions(hub, ["root"], "user");

    expect(again).toEqual({ changed: [], skipped: [{ id: "root", reason: "already" }] });
    expect(hub.archiveOf("root")).toBe(mark);
  });

  it("records who archived: the retention policy is not the user", async () => {
    const { hub } = await started();
    await archiveSessions(hub, ["other"], "retention");
    expect(hub.archiveOf("other")?.by).toBe("retention");
    expect(hub.summary("other")?.archivedBy).toBe("retention");
  });

  it("can archive a branch and leave its parent where it was; the parent still lists the branch as a child", async () => {
    const { hub } = await started();

    const result = await archiveSessions(hub, ["kid"], "user");

    expect(result.changed).toEqual(["kid", "grandkid"]);
    expect(hub.archiveOf("root")).toBeUndefined();
    expect(hub.summary("root")?.childIds).toEqual(["kid"]);
    expect(hub.allSummaries("exclude").map((summary) => summary.id)).toContain("root");
    expect(hub.allSummaries("exclude").map((summary) => summary.id)).not.toContain("kid");
  });

  it("does not change what the session is: same phase, same sequence number, same last activity", async () => {
    const { hub } = await started();
    const before = hub.summary("other");

    await archiveSessions(hub, ["other"], "user");

    expect(hub.summary("other")).toMatchObject({ phase: before?.phase, seq: before?.seq, updatedAt: before?.updatedAt, status: before?.status });
  });
});

describe("unarchiveSessions", () => {
  it("brings back the session, everything below it and the archived chain above it", async () => {
    const { hub } = await started();
    await archiveSessions(hub, ["root"], "user");

    const result = await unarchiveSessions(hub, ["kid"]);

    expect(result).toEqual({ changed: ["root", "kid", "grandkid"], skipped: [] });
    expect(hub.counts().archived).toBe(0);
    expect(hub.summary("grandkid")?.archivedAt).toBeUndefined();
  });

  it("answers not_archived and not_found for what it cannot do", async () => {
    const { hub } = await started();
    const result = await unarchiveSessions(hub, ["other", "ghost"]);
    expect(result).toEqual({
      changed: [],
      skipped: [
        { id: "other", reason: "not_archived" },
        { id: "ghost", reason: "not_found" },
      ],
    });
  });

  // 撤销归档的场景：kid 一支更早就单独归档了，之后归档 root，这次真正变化的只有 root。
  // 没有 exact 时撤销 root 会把 kid 一支也带回来（不是这次归档的逆操作）；有 exact 才只放回 root。
  describe("undoing an archive after a branch below it was archived earlier", () => {
    async function archivedBranchThenRoot() {
      const world = await started();
      await archiveSessions(world.hub, ["kid"], "user");
      const archiveRoot = await archiveSessions(world.hub, ["root"], "user");
      expect(archiveRoot.changed).toEqual(["root"]);
      return { ...world, archiveRoot };
    }

    it("with exact restores only the sessions named, in memory and in the store, and leaves the earlier branch archived", async () => {
      const { store, hub, archiveRoot } = await archivedBranchThenRoot();

      const undo = await unarchiveSessions(hub, archiveRoot.changed, { exact: true });

      expect(undo).toEqual({ changed: ["root"], skipped: [] });
      expect(hub.archiveOf("root")).toBeUndefined();
      expect(hub.summary("root")?.archivedAt).toBeUndefined();
      expect(await store.readArchive("root")).toBeUndefined();
      for (const id of ["kid", "grandkid"]) {
        expect(hub.archiveOf(id), id).toMatchObject({ by: "user" });
        expect(hub.summary(id)?.archivedAt, id).toBeDefined();
        expect(await store.readArchive(id), id).toMatchObject({ by: "user" });
      }
    });

    it("without exact the same request is the ordinary unarchive and brings the earlier branch back too, as before", async () => {
      const { hub, archiveRoot } = await archivedBranchThenRoot();

      const result = await unarchiveSessions(hub, archiveRoot.changed);

      expect(result).toEqual({ changed: ["root", "kid", "grandkid"], skipped: [] });
      expect(hub.counts().archived).toBe(0);
    });

    it("with exact still answers not_archived and not_found for what it cannot do", async () => {
      const { hub } = await started();

      const result = await unarchiveSessions(hub, ["other", "ghost"], { exact: true });

      expect(result).toEqual({
        changed: [],
        skipped: [
          { id: "other", reason: "not_archived" },
          { id: "ghost", reason: "not_found" },
        ],
      });
    });
  });
});

describe("reviveSession", () => {
  it("does nothing for a session that is not archived", async () => {
    const { store, hub } = await started();
    expect(await reviveSession(hub, "other", silentLogger)).toBe(false);
    expect(await reviveSession(hub, "ghost", silentLogger)).toBe(false);
    expect(await store.readArchive("other")).toBeUndefined();
  });

  it("unarchives a session that is being used again, with its family", async () => {
    const { hub } = await started();
    await archiveSessions(hub, ["root"], "user");

    expect(await reviveSession(hub, "grandkid", silentLogger)).toBe(true);

    expect(hub.counts().archived).toBe(0);
  });

  it("never throws: when the mark cannot be removed it says so in the log and the session stays archived", async () => {
    const { store, hub } = await started();
    await archiveSessions(hub, ["other"], "user");
    store.failArchive = true;
    const warn = vi.fn();

    await expect(reviveSession(hub, "other", { ...silentLogger, warn })).resolves.toBe(false);

    expect(warn).toHaveBeenCalledWith("could not unarchive a session that was just used", expect.objectContaining({ sessionId: "other" }));
    expect(hub.archiveOf("other")).toBeDefined();
  });
});

describe("archiveTreeOf", () => {
  it("describes the sessions to the rules from their summaries, hot or cold", async () => {
    const { hub } = await started();
    const tree = archiveTreeOf(hub);

    expect([...tree.ids()].sort()).toEqual([...hub.sessionIds()].sort());
    expect(tree.node("root")).toMatchObject({ id: "root", archived: false, finished: true });
    expect(tree.node("kid")?.parentSessionId).toBe("root");
    expect(tree.node("busy")?.finished).toBe(false);
    expect(tree.node("idle")?.finished).toBe(false);
    expect(tree.node("waiting")?.finished).toBe(false);
    expect(tree.node("ghost")).toBeUndefined();
    expect(tree.childrenOf("root")).toEqual(["kid"]);
    expect(tree.node("other")?.activityMs).toBe(Date.parse(hub.summary("other")?.updatedAt ?? ""));

    await archiveSessions(hub, ["other"], "user");
    expect(archiveTreeOf(hub).node("other")?.archived).toBe(true);
  });
});
