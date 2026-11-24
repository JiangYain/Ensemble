import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replay, toSummary } from "@shared/projection";
import type { SessionDetail, StateSnapshot, StreamMessage } from "@shared/protocol";
import { EventLog } from "@shared/testing";
import type { SessionSummary } from "@shared/types";
import { loadDetail, store } from "./app";
import { archiveUi } from "./archive";
import { ARCHIVED_AT, archivedSummary, summary } from "./archive.fixtures";
import { endListLoad } from "./archiveState";
import { startLive } from "./live";

/** 可控的 EventSource：测试用 emit 模拟服务推来的消息。 */
class FakeEventSource {
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 0;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const snapshotOf = (patch: Partial<StateSnapshot> = {}): StateSnapshot => ({
  rev: 0,
  serverTime: "2026-11-22T00:00:00.000Z",
  version: "test",
  protocol: 1,
  sessions: [],
  harnesses: [],
  capacity: { occupied: 0, max: 20, waiting: 0 },
  dev: false,
  ...patch,
});

/** 一个会话的详情回执：摘要取自事件的真实投影（序号与事件一致），再用 patch 盖掉要测的字段。 */
function detailOf(id: string, patch: Partial<SessionSummary> = {}): SessionDetail {
  const log = new EventLog(id);
  log.created({ id, harness: "cursor", runtime: "native", title: id });
  return { summary: { ...toSummary(replay(log.events)!), ...patch }, events: log.events };
}

/** 聚焦页此刻显示着这个会话（详情已读好）。 */
function focusing(id: string): Pick<ReturnType<typeof store.get>, "route" | "detail"> {
  const { events } = detailOf(id);
  return { route: { kind: "session", id }, detail: { id, state: replay(events)!, rev: 1, loading: false } };
}

interface Routes {
  /** 会话详情（按 id）；没有的是 404。 */
  details?: Record<string, SessionDetail>;
  /** `GET /api/sessions?archived=only` 的内容。 */
  archivedList?: SessionSummary[];
}

describe("实时连接与详情读取里的归档", () => {
  let stop: (() => void) | undefined;
  let calls: string[];
  const previous = store.get();

  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    calls = [];
    // ready 为 true：首屏那次主动拉取的快照不再套用，各用例预置的状态不会被它改掉。
    store.set({
      ready: true,
      conn: "live",
      sessions: {},
      archived: {},
      archivedLoaded: false,
      archivedCount: undefined,
      retention: undefined,
      snapshotAt: undefined,
      detail: undefined,
      route: { kind: "overview" },
    });
    archiveUi.set({ list: { status: "idle" }, busy: 0 });
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    endListLoad();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    store.set(previous);
    archiveUi.set({ list: { status: "idle" }, busy: 0 });
  });

  const serve = (routes: Routes = {}): void => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${input}`);
        const reply = (status: number, body: unknown) => {
          const text = JSON.stringify(body);
          return { ok: status < 400, status, text: async () => text, json: async () => JSON.parse(text), headers: { get: () => null } };
        };
        if (input.startsWith("/api/state")) return reply(200, snapshotOf());
        if (input === "/api/sessions?archived=only") return reply(200, { sessions: routes.archivedList ?? [] });
        const matched = /^\/api\/sessions\/([^/?]+)$/.exec(input);
        const detail = matched ? routes.details?.[decodeURIComponent(matched[1]!)] : undefined;
        return detail ? reply(200, detail) : reply(404, { error: { code: "not_found", message: "gone" } });
      }),
    );
  };

  /** 让挂起的微任务（假 fetch 的应答、读取之后的状态写入）都走完。 */
  const flush = async (): Promise<void> => {
    for (let round = 0; round < 4; round += 1) await vi.advanceTimersByTimeAsync(0);
  };
  const start = async (routes: Routes = {}): Promise<void> => {
    serve(routes);
    stop = startLive({ reload: vi.fn() });
    await flush();
  };
  const push = (message: StreamMessage): void => {
    FakeEventSource.instances.at(-1)!.emit(message.type, { data: JSON.stringify(message) });
  };

  // ───────────────────────── 快照 ─────────────────────────

  describe("快照", () => {
    it("带已归档个数的快照：个数、留存策略与快照时刻进状态", async () => {
      await start();
      push({ type: "snapshot", snapshot: snapshotOf({ archivedCount: 3, retention: { keepDays: 30, keepCount: null } }) });
      expect(store.get().archivedCount).toBe(3);
      expect(store.get().retention).toEqual({ keepDays: 30, keepCount: null });
      expect(store.get().snapshotAt).toBe("2026-11-22T00:00:00.000Z");
    });

    it("快照的会话列表不含已归档的：此前认识的已归档会话留着；断线期间被取消归档的（现在在快照里）从已归档表里去掉", async () => {
      store.set({ archived: { a: archivedSummary("a"), b: archivedSummary("b") }, archivedCount: 2 });
      await start();
      push({ type: "snapshot", snapshot: snapshotOf({ sessions: [summary("b", { phase: "done" })], archivedCount: 1 }) });
      expect(Object.keys(store.get().archived)).toEqual(["a"]);
      expect(Object.keys(store.get().sessions)).toEqual(["b"]);
      expect(store.get().archivedCount).toBe(1);
    });

    it("老服务的快照（没有 archivedCount）：已归档表、个数与留存策略全部清空，归档界面整个消失", async () => {
      store.set({ archived: { x: archivedSummary("x") }, archivedCount: 1, retention: { keepDays: 7, keepCount: 3 } });
      await start();
      push({ type: "snapshot", snapshot: snapshotOf() });
      expect(store.get().archived).toEqual({});
      expect(store.get().archivedCount).toBeUndefined();
      expect(store.get().retention).toBeUndefined();
    });

    it("已归档列表读过：快照到了在后台按服务端重读一遍（静默）；没读过就不读", async () => {
      store.set({ archived: { old: archivedSummary("old") }, archivedLoaded: true, archivedCount: 1 });
      await start({ archivedList: [archivedSummary("x"), archivedSummary("y")] });
      push({ type: "snapshot", snapshot: snapshotOf({ archivedCount: 2 }) });
      await flush();
      expect(calls).toContain("GET /api/sessions?archived=only");
      expect(Object.keys(store.get().archived).sort()).toEqual(["x", "y"]);
      expect(store.get().archivedCount).toBe(2);
      expect(store.get().archivedLoaded).toBe(true);
      expect(store.get().toasts).toEqual([]);
    });

    it("没读过已归档列表：快照到了不去读（按需加载，进“已归档”视图才读）", async () => {
      store.set({ archivedLoaded: false, archivedCount: 5 });
      await start();
      push({ type: "snapshot", snapshot: snapshotOf({ archivedCount: 5 }) });
      await flush();
      expect(calls.filter((call) => call.includes("archived=only"))).toEqual([]);
    });
  });

  // ───────────────────────── 推送的摘要 ─────────────────────────

  describe("summary 推送", () => {
    it("归档：摘要带 archivedAt 就进已归档表、个数 +1；取消归档（序号不变）：回到未归档表、个数 −1", async () => {
      const hot = summary("s1", { phase: "done" });
      store.set({ sessions: { s1: hot }, archivedCount: 0 });
      await start();

      push({ type: "summary", summary: { ...hot, archivedAt: ARCHIVED_AT, archivedBy: "user" } });
      expect(store.get().sessions).toEqual({});
      expect(store.get().archived["s1"]?.archivedAt).toBe(ARCHIVED_AT);
      expect(store.get().archivedCount).toBe(1);

      push({ type: "summary", summary: hot });
      expect(store.get().archived).toEqual({});
      expect(store.get().sessions["s1"]).toEqual(hot);
      expect(store.get().archivedCount).toBe(0);
    });

    it("同一个会话上序号更小的摘要是过期的，不会把它改回去", async () => {
      store.set({ archived: { s1: archivedSummary("s1", { seq: 9 }) }, archivedCount: 1 });
      await start();
      push({ type: "summary", summary: summary("s1", { phase: "done", seq: 8 }) });
      expect(store.get().archived["s1"]?.seq).toBe(9);
      expect(store.get().sessions).toEqual({});
    });
  });

  // ───────────────────────── 聚焦页与快照 ─────────────────────────

  describe("聚焦页上的已归档会话", () => {
    it("快照到来时它还在已归档表里、序号一致：不被判成已不存在，也不去重读", async () => {
      const detail = detailOf("ses_a");
      store.set({ ...focusing("ses_a"), archived: { ses_a: { ...detail.summary, archivedAt: ARCHIVED_AT, archivedBy: "user" } }, archivedCount: 1 });
      await start();
      push({ type: "snapshot", snapshot: snapshotOf({ archivedCount: 1 }) });
      await flush();
      expect(store.get().detail?.error).toBeUndefined();
      expect(calls.filter((call) => call.includes("/api/sessions/ses_a"))).toEqual([]);
    });

    it("懂归档的服务、两张表里都没有它：不断定已删除，去问详情；读到带归档标记的，归到已归档表", async () => {
      store.set({ ...focusing("ses_b"), archivedCount: 1 });
      await start({ details: { ses_b: detailOf("ses_b", { archivedAt: ARCHIVED_AT, archivedBy: "retention" }) } });
      push({ type: "snapshot", snapshot: snapshotOf({ archivedCount: 1 }) });
      await flush();
      expect(calls).toContain("GET /api/sessions/ses_b");
      expect(store.get().detail?.error).toBeUndefined();
      expect(store.get().archived["ses_b"]).toMatchObject({ archivedAt: ARCHIVED_AT, archivedBy: "retention" });
      expect(store.get().sessions["ses_b"]).toBeUndefined();
    });

    it("同样的情形，详情是 404：这才是真的没了", async () => {
      store.set({ ...focusing("ses_gone"), archivedCount: 1 });
      await start();
      push({ type: "snapshot", snapshot: snapshotOf({ archivedCount: 1 }) });
      await flush();
      expect(calls).toContain("GET /api/sessions/ses_gone");
      expect(store.get().detail?.error).toBe("not_found");
    });

    it("老服务（没有归档）：快照里没有它就是已删除，不去问", async () => {
      store.set(focusing("ses_c"));
      await start();
      push({ type: "snapshot", snapshot: snapshotOf() });
      await flush();
      expect(store.get().detail?.error).toBe("not_found");
      expect(calls.filter((call) => call.includes("/api/sessions/ses_c"))).toEqual([]);
    });

    it("removed 推送：已归档的会话也能被清掉（个数 −1），聚焦页标记为已不存在", async () => {
      store.set({ ...focusing("z"), archived: { z: archivedSummary("z") }, archivedCount: 1 });
      await start();
      push({ type: "removed", sessionId: "z" });
      expect(store.get().archived).toEqual({});
      expect(store.get().archivedCount).toBe(0);
      expect(store.get().detail?.error).toBe("not_found");
    });
  });

  // ───────────────────────── 详情回执里的摘要 ─────────────────────────

  describe("loadDetail", () => {
    const loading = (id: string): void => store.set({ route: { kind: "session", id }, detail: { id, state: undefined, rev: 0, loading: true } });

    it("读到的是已归档的会话：摘要进已归档表，个数不变（它早就算在服务端报告的数里）", async () => {
      store.set({ archivedCount: 4 });
      loading("ses_arch");
      serve({ details: { ses_arch: detailOf("ses_arch", { archivedAt: ARCHIVED_AT, archivedBy: "user" }) } });
      await loadDetail("ses_arch");
      expect(store.get().detail).toMatchObject({ id: "ses_arch", loading: false });
      expect(store.get().detail?.error).toBeUndefined();
      expect(store.get().archived["ses_arch"]?.archivedAt).toBe(ARCHIVED_AT);
      expect(store.get().sessions["ses_arch"]).toBeUndefined();
      expect(store.get().archivedCount).toBe(4);
    });

    it("读到的是已经认识的未归档会话：不重写摘要表（它在推送里一直是新的，重写只会让所有订阅者白白重绘）", async () => {
      // 摘要取自与回执同一份事件的投影：序号一致，才不会被当成“更旧”而走另一条路。
      store.set({ sessions: { ses_hot: detailOf("ses_hot").summary }, archivedCount: 0 });
      loading("ses_hot");
      serve({ details: { ses_hot: detailOf("ses_hot") } });
      const before = store.get().sessions;
      await loadDetail("ses_hot");
      expect(store.get().sessions).toBe(before);
      expect(store.get().detail?.loading).toBe(false);
    });

    it("打开聚焦页的那一刻它刚被归档（目录里还当它是未归档）：回执带归档标记，移到已归档表、个数 +1", async () => {
      store.set({ sessions: { ses_x: detailOf("ses_x").summary }, archivedCount: 0 });
      loading("ses_x");
      serve({ details: { ses_x: detailOf("ses_x", { archivedAt: ARCHIVED_AT, archivedBy: "user" }) } });
      await loadDetail("ses_x");
      expect(store.get().sessions["ses_x"]).toBeUndefined();
      expect(store.get().archived["ses_x"]?.archivedAt).toBe(ARCHIVED_AT);
      expect(store.get().archivedCount).toBe(1);
    });
  });
});
