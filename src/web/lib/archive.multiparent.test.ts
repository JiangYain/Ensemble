import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang, store } from "./app";
import { archiveSessions, archiveUi } from "./archive";
import { stubApi } from "./archive.fixtures";

/**
 * 归档回执里的 `kept`（汇聚的会话本来会随上级一起走，却还跟随着没有归档的别的会话，所以留在原处）怎么写进成功提示：
 * 数的是回执里的个数、排在“还在工作”的后面；老服务不报 `kept`，提示与以前一字不差。其余的提示由 archive.test.ts 守着。
 */

const last = () => store.get().toasts.at(-1)!;

describe("归档的成功提示里，汇聚的会话没有跟着走", () => {
  const previous = store.get();

  beforeEach(() => {
    setLang("zh");
    store.set({ sessions: {}, archived: {}, archivedLoaded: false, archivedCount: 5, toasts: [], confirm: undefined });
    archiveUi.set({ list: { status: "idle" }, busy: 0 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    store.set({
      sessions: previous.sessions,
      archived: previous.archived,
      archivedLoaded: previous.archivedLoaded,
      archivedCount: previous.archivedCount,
      toasts: [],
      confirm: undefined,
      lang: previous.lang,
    });
    archiveUi.set({ list: { status: "idle" }, busy: 0 });
  });

  it("回执里有 kept：成功提示末尾说明有几个会话还跟随着没有归档的会话，仍带“撤销”", async () => {
    stubApi(() => ({ body: { changed: ["a"], skipped: [], kept: [{ id: "j", follows: ["b"] }] } }));

    await archiveSessions(["a"]);

    expect(last()).toMatchObject({ tone: "success", text: "已归档 1 个会话；另有 1 个会话还跟随着没有归档的会话，没有归档" });
    expect(last().action?.label).toBe("撤销");
  });

  it("数的是回执里留下的会话个数，排在“还在工作”的后面", async () => {
    stubApi(() => ({
      body: {
        changed: ["a", "b"],
        skipped: [{ id: "x", reason: "active" }],
        kept: [
          { id: "j1", follows: ["c"] },
          { id: "j2", follows: ["c", "d"] },
        ],
      },
    }));

    await archiveSessions(["a", "x"], { reason: "working", n: 1 });

    expect(last().text).toBe("已归档 2 个会话；另有 2 个会话还在工作，没有归档；另有 2 个会话还跟随着没有归档的会话，没有归档");
  });

  it("老服务不报 kept（或报空表）：提示与以前一字不差", async () => {
    stubApi(() => ({ body: { changed: ["a"], skipped: [] } }));
    await archiveSessions(["a"]);
    expect(last().text).toBe("已归档 1 个会话");

    stubApi(() => ({ body: { changed: ["a"], skipped: [], kept: [] } }));
    await archiveSessions(["a"]);
    expect(last().text).toBe("已归档 1 个会话");
  });

  it("一个都没归档时不提 kept：说的仍是没归档的原因", async () => {
    stubApi(() => ({ body: { changed: [], skipped: [{ id: "a", reason: "already" }], kept: [{ id: "j", follows: ["b"] }] } }));

    await archiveSessions(["a"]);

    expect(last()).toMatchObject({ tone: "info", text: "这些会话已经归档过了" });
  });

  it("英文：单复数跟着个数走", async () => {
    setLang("en");

    stubApi(() => ({ body: { changed: ["a"], skipped: [], kept: [{ id: "j", follows: ["b"] }] } }));
    await archiveSessions(["a"]);
    expect(last().text).toBe("Archived 1 session; 1 session also follows a session that is not archived, kept");

    stubApi(() => ({
      body: {
        changed: ["a", "b"],
        skipped: [],
        kept: [
          { id: "j1", follows: ["c"] },
          { id: "j2", follows: ["d"] },
        ],
      },
    }));
    await archiveSessions(["a", "b"]);
    expect(last().text).toBe("Archived 2 sessions; 2 sessions also follow a session that is not archived, kept");
  });
});
