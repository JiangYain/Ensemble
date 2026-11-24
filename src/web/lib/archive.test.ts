import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog } from "@shared/testing";
import type { SessionSummary } from "@shared/types";
import { ApiError } from "./api";
import { patchSummary, setLang, store } from "./app";
import { archiveInFlight, archiveSessions, archiveUi, blockedText, confirmArchive, exportReport, loadArchived, readRetention, saveRetention, unarchiveSessions } from "./archive";
import { saveTextFile } from "./download";
import { bindT } from "./i18n";

// 保存文件会点一个看不见的 <a download>：这里只关心“有没有保存、存成什么名字”，不真的走浏览器。
vi.mock("./download", () => ({ saveTextFile: vi.fn() }));

function summary(id: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  const log = new EventLog(id);
  log.created({ id, harness: "cursor", runtime: "native" });
  return { ...toSummary(replay(log.events)!), seq: 5, ...patch };
}
const archived = (id: string, patch: Partial<SessionSummary> = {}): SessionSummary => summary(id, { archivedAt: "2026-11-20T08:00:00.000Z", archivedBy: "user", ...patch });

interface Call {
  method: string;
  path: string;
  body?: unknown;
}
interface Reply {
  status?: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

/** 按“方法 + 路径”应答的假 fetch；handler 可以是异步的，用来把应答卡在半路。返回按顺序记下的请求。 */
function stubApi(handler: (call: Call) => Reply | Promise<Reply>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const call: Call = { method: init?.method ?? "GET", path, ...(init?.body !== undefined ? { body: JSON.parse(String(init.body)) } : {}) };
      calls.push(call);
      const reply = await handler(call);
      const status = reply.status ?? 200;
      const text = reply.text ?? JSON.stringify(reply.body ?? {});
      const headers = reply.headers ?? {};
      return { ok: status < 400, status, text: async () => text, headers: { get: (name: string) => headers[name.toLowerCase()] ?? null } };
    }),
  );
  return calls;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const last = () => store.get().toasts.at(-1)!;

describe("归档的动作", () => {
  const previous = store.get();

  beforeEach(() => {
    setLang("zh");
    store.set({ sessions: {}, archived: {}, archivedLoaded: false, archivedCount: 5, retention: undefined, snapshotAt: undefined, toasts: [], confirm: undefined });
    archiveUi.set({ list: { status: "idle" }, busy: 0 });
    vi.mocked(saveTextFile).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    store.set({
      sessions: previous.sessions,
      archived: previous.archived,
      archivedLoaded: previous.archivedLoaded,
      archivedCount: previous.archivedCount,
      retention: previous.retention,
      snapshotAt: previous.snapshotAt,
      toasts: [],
      confirm: undefined,
      lang: previous.lang,
    });
    archiveUi.set({ list: { status: "idle" }, busy: 0 });
  });

  describe("blockedText：不能归档时的真实原因", () => {
    it("三种原因，数字来自摘要里的事实；英文按单复数选词", () => {
      const zh = bindT("zh");
      expect(blockedText({ reason: "working", n: 2 }, zh)).toBe("还有 2 个会话在工作，等它们结束后才能归档");
      expect(blockedText({ reason: "idle", n: 1 }, zh)).toBe("还有 1 个会话在待命（还开着，不算已结束），关闭后才能归档");
      expect(blockedText({ reason: "pending", n: 3 }, zh)).toBe("还有 3 个会话的消息没有被确认，处理完才能归档");
      const en = bindT("en");
      expect(blockedText({ reason: "working", n: 1 }, en)).toBe("1 session is still working; archive once it has finished");
      expect(blockedText({ reason: "working", n: 3 }, en)).toBe("3 sessions are still working; archive once they have finished");
    });
  });

  describe("archiveSessions", () => {
    it("成功：发一次请求；不做乐观更新（状态等服务端推送）；提示带“撤销”", async () => {
      store.set({ sessions: { a: summary("a", { phase: "done" }) } });
      const calls = stubApi(() => ({ body: { changed: ["a"], skipped: [] } }));
      const response = await archiveSessions(["a"]);
      expect(response).toEqual({ changed: ["a"], skipped: [] });
      expect(calls).toEqual([{ method: "POST", path: "/api/sessions/archive", body: { ids: ["a"] } }]);
      expect(store.get().sessions["a"]).toBeDefined();
      expect(store.get().archived["a"]).toBeUndefined();
      expect(last()).toMatchObject({ tone: "success", text: "已归档 1 个会话" });
      expect(last().action?.label).toBe("撤销");
      expect(archiveInFlight()).toBe(false);
    });

    it("“撤销”就是只把这次真正归档的会话放回去（含随上级一起归档的，请求带 exact），并如实说结果", async () => {
      const calls = stubApi(() => ({ body: { changed: ["a", "b"], skipped: [] } }));
      await archiveSessions(["a"]);
      last().action!.run();
      await vi.waitFor(() => expect(calls.map((call) => call.path)).toEqual(["/api/sessions/archive", "/api/sessions/unarchive"]));
      expect(calls[1]!.body).toEqual({ ids: ["a", "b"], exact: true });
      await vi.waitFor(() => expect(last().text).toBe("已取消归档 2 个会话"));
    });

    it("“撤销”只发一次取消归档的请求：点名的恰好是这次实际变化的会话，并带 exact:true（更早单独归档的下级不在其中）", async () => {
      // a 名下的 c 更早就单独归档了：归档 a 时回执里实际变化的只有 a，撤销就只该放回 a。
      const calls = stubApi(() => ({ body: { changed: ["a"], skipped: [] } }));
      await archiveSessions(["a"]);
      last().action!.run();
      await vi.waitFor(() => expect(last().text).toBe("已取消归档 1 个会话"));
      expect(calls).toEqual([
        { method: "POST", path: "/api/sessions/archive", body: { ids: ["a"] } },
        { method: "POST", path: "/api/sessions/unarchive", body: { ids: ["a"], exact: true } },
      ]);
    });

    it("旧服务不认识 exact、撤销时把更早单独归档的下级一并带回来：不报错，提示照实说一并恢复了几个", async () => {
      const calls = stubApi((call) => ({ body: { changed: call.path === "/api/sessions/archive" ? ["a"] : ["a", "c"], skipped: [] } }));
      await archiveSessions(["a"]);
      last().action!.run();
      await vi.waitFor(() => expect(last()).toMatchObject({ tone: "success", text: "已取消归档 2 个会话（其中 1 个是随它一起恢复的上级或下级）" }));
      expect(calls[1]!.body).toEqual({ ids: ["a"], exact: true });
    });

    it("点之前就知道会被留下的（还在工作的）写进成功提示，执行时才发现还在工作的也一并算上", async () => {
      stubApi(() => ({ body: { changed: ["a"], skipped: [{ id: "b", reason: "active" }] } }));
      await archiveSessions(["a", "b"], { reason: "working", n: 2 });
      expect(last().text).toBe("已归档 1 个会话；另有 3 个会话还在工作，没有归档");

      stubApi(() => ({ body: { changed: ["a"], skipped: [{ id: "b", reason: "active" }] } }));
      await archiveSessions(["a", "b"]);
      expect(last().text).toBe("已归档 1 个会话；另有 1 个会话还在工作，没有归档");

      stubApi(() => ({ body: { changed: ["a"], skipped: [] } }));
      await archiveSessions(["a"], { reason: "idle", n: 1 });
      expect(last().text).toBe("已归档 1 个会话；另有 1 个会话在待命，没有归档");

      stubApi(() => ({ body: { changed: ["a"], skipped: [] } }));
      await archiveSessions(["a"], { reason: "pending", n: 2 });
      expect(last().text).toBe("已归档 1 个会话；另有 2 个会话的消息没有被确认，没有归档");
    });

    it("一个都没归档：照实说原因（还没结束 / 找不到 / 本来就已归档），不给“撤销”", async () => {
      stubApi(() => ({ body: { changed: [], skipped: [{ id: "a", reason: "active" }] } }));
      await archiveSessions(["a"]);
      expect(last()).toMatchObject({ tone: "warn", text: "没有归档：这些会话还没有全部结束" });
      expect(last().action).toBeUndefined();

      stubApi(() => ({ body: { changed: [], skipped: [{ id: "a", reason: "not_found" }] } }));
      await archiveSessions(["a"]);
      expect(last()).toMatchObject({ tone: "warn", text: "没有归档：找不到这些会话，可能已被删除" });

      stubApi(() => ({ body: { changed: [], skipped: [{ id: "a", reason: "already" }] } }));
      await archiveSessions(["a"]);
      expect(last()).toMatchObject({ tone: "info", text: "这些会话已经归档过了" });
    });

    it("失败是一条真实的错误提示，状态不动、入口随即恢复", async () => {
      store.set({ sessions: { a: summary("a") } });
      stubApi(() => ({ status: 500, body: { error: { code: "internal", message: "boom" } } }));
      expect(await archiveSessions(["a"])).toBeUndefined();
      expect(last().tone).toBe("error");
      expect(last().text.startsWith("归档失败：")).toBe(true);
      expect(store.get().sessions["a"]).toBeDefined();
      expect(archiveInFlight()).toBe(false);
    });

    it("在途时再调用被忽略（不发第二次请求），结束后恢复", async () => {
      const gate = deferred();
      const calls = stubApi(async () => {
        await gate.promise;
        return { body: { changed: ["a"], skipped: [] } };
      });
      const first = archiveSessions(["a"]);
      expect(archiveInFlight()).toBe(true);
      expect(await archiveSessions(["b"])).toBeUndefined();
      expect(calls).toHaveLength(1);
      gate.resolve();
      await first;
      expect(archiveInFlight()).toBe(false);
    });

    it("空名单不发请求", async () => {
      const calls = stubApi(() => ({ body: {} }));
      expect(await archiveSessions([])).toBeUndefined();
      expect(calls).toEqual([]);
    });
  });

  describe("confirmArchive：批量归档前的确认", () => {
    const pick = { ids: ["r"], changed: ["r", "c"], kept: 1, carried: 1, blocked: { reason: "working" as const, n: 1 } };

    it("写明会归档几个、其中几个随上级一起走、几个因为还没结束而留下", () => {
      confirmArchive(pick);
      const request = store.get().confirm!;
      expect(request.title).toBe("归档这 2 个会话？");
      expect(request.confirmLabel).toBe("归档 2 个会话");
      expect(request.body).toBe("这 2 个会话会移出画布、侧栏与列表；记录原样保留，随时可以在「已归档」里取消归档。其中包含 1 个随上级一起归档的下级会话。另有 1 个会话还没结束，留在原处。");
    });

    it("没有下级、也没有被留下的会话时，只说最基本的一句", () => {
      confirmArchive({ ids: ["a"], changed: ["a"], kept: 0, carried: 0, blocked: undefined });
      expect(store.get().confirm!.body).toBe("这 1 个会话会移出画布、侧栏与列表；记录原样保留，随时可以在「已归档」里取消归档。");
    });

    it("确认之后才发请求，名单是要交给服务端的最上层会话；被留下的原因写进结果提示", async () => {
      const calls = stubApi(() => ({ body: { changed: ["r", "c"], skipped: [] } }));
      confirmArchive(pick);
      expect(calls).toEqual([]);
      await store.get().confirm!.onConfirm();
      expect(calls).toEqual([{ method: "POST", path: "/api/sessions/archive", body: { ids: ["r"] } }]);
      expect(last().text).toBe("已归档 2 个会话；另有 1 个会话还在工作，没有归档");
    });

    it("对话框开着的时候别处又起了一次归档：点确认不能什么都没发生，要说出来", async () => {
      const calls = stubApi(() => ({ body: { changed: [], skipped: [] } }));
      confirmArchive(pick);
      archiveUi.set({ busy: 1 });
      await store.get().confirm!.onConfirm();
      expect(calls).toEqual([]);
      expect(last()).toMatchObject({ tone: "info", text: "上一个归档操作还在进行" });
    });
  });

  describe("unarchiveSessions", () => {
    it("成功：一并恢复的上级与下级如实写出来", async () => {
      const calls = stubApi(() => ({ body: { changed: ["p", "a", "c"], skipped: [] } }));
      await unarchiveSessions(["a"]);
      expect(calls).toEqual([{ method: "POST", path: "/api/sessions/unarchive", body: { ids: ["a"] } }]);
      expect(last()).toMatchObject({ tone: "success", text: "已取消归档 3 个会话（其中 2 个是随它一起恢复的上级或下级）" });
    });

    it("只恢复了点名的：不加括号", async () => {
      stubApi(() => ({ body: { changed: ["a"], skipped: [] } }));
      await unarchiveSessions(["a"]);
      expect(last().text).toBe("已取消归档 1 个会话");
    });

    it("一个都没恢复：找不到与本来就没归档分开说", async () => {
      stubApi(() => ({ body: { changed: [], skipped: [{ id: "a", reason: "not_found" }] } }));
      await unarchiveSessions(["a"]);
      expect(last()).toMatchObject({ tone: "warn", text: "没有取消归档：找不到这个会话，可能已被删除" });

      stubApi(() => ({ body: { changed: [], skipped: [{ id: "a", reason: "not_archived" }] } }));
      await unarchiveSessions(["a"]);
      expect(last()).toMatchObject({ tone: "info", text: "这些会话本来就没有归档" });
    });

    it("失败是一条真实的错误提示", async () => {
      stubApi(() => ({ status: 500, body: { error: { code: "internal", message: "boom" } } }));
      expect(await unarchiveSessions(["a"])).toBeUndefined();
      expect(last().tone).toBe("error");
      expect(last().text.startsWith("取消归档失败：")).toBe(true);
    });

    it("有归档在途时入口被闸住，不发请求", async () => {
      archiveUi.set({ busy: 1 });
      const calls = stubApi(() => ({ body: { changed: [], skipped: [] } }));
      expect(await unarchiveSessions(["a"])).toBeUndefined();
      expect(calls).toEqual([]);
    });
  });

  describe("exportReport", () => {
    it("一次点击直接保存：文件名取服务端给的（百分号编码的中文），请求带范围、详细程度与界面语言，成功不弹提示", async () => {
      const calls = stubApi(() => ({ text: "# 报告", headers: { "content-disposition": "attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.md" } }));
      expect(await exportReport("ses_x", { scope: "tree", detail: "full" })).toBe(true);
      expect(calls).toEqual([{ method: "GET", path: "/api/sessions/ses_x/report?scope=tree&detail=full&lang=zh" }]);
      expect(saveTextFile).toHaveBeenCalledWith("报告.md", "# 报告");
      expect(store.get().toasts).toEqual([]);
    });

    it("报告语言跟着当前界面语言", async () => {
      setLang("en");
      const calls = stubApi(() => ({ text: "# Report" }));
      await exportReport("ses_x", { scope: "session", detail: "brief" });
      expect(calls[0]!.path).toBe("/api/sessions/ses_x/report?scope=session&detail=brief&lang=en");
    });

    it("服务端没给文件名：用自己起的兜底名", async () => {
      stubApi(() => ({ text: "# 报告" }));
      await exportReport("ses_x", { scope: "session", detail: "brief" });
      expect(saveTextFile).toHaveBeenCalledWith("ensemble-session-ses_x.md", "# 报告");
    });

    it("失败是一条真实的错误提示，不保存任何文件", async () => {
      stubApi(() => ({ status: 404, body: { error: { code: "not_found", message: "no such route" } } }));
      expect(await exportReport("ses_x", { scope: "session", detail: "brief" })).toBe(false);
      expect(last().tone).toBe("error");
      expect(last().text.startsWith("导出失败：")).toBe(true);
      expect(saveTextFile).not.toHaveBeenCalled();
    });

    it("同一份报告在途时再点不重复发；不同的报告互不影响", async () => {
      const gate = deferred();
      const calls = stubApi(async () => {
        await gate.promise;
        return { text: "# 报告" };
      });
      const first = exportReport("ses_x", { scope: "session", detail: "brief" });
      expect(await exportReport("ses_x", { scope: "session", detail: "brief" })).toBe(false);
      const other = exportReport("ses_x", { scope: "session", detail: "full" });
      expect(calls).toHaveLength(2);
      gate.resolve();
      expect(await first).toBe(true);
      expect(await other).toBe(true);
      // 结束之后可以再导出。
      stubApi(() => ({ text: "# 报告" }));
      expect(await exportReport("ses_x", { scope: "session", detail: "brief" })).toBe(true);
    });
  });

  describe("loadArchived：按需读全已归档列表", () => {
    it("老服务（不报已归档个数）：什么也不读", async () => {
      store.set({ archivedCount: undefined });
      const calls = stubApi(() => ({ body: { sessions: [] } }));
      await loadArchived();
      expect(calls).toEqual([]);
    });

    it("首次读全：已归档表、读全标记与个数一起更新；读过之后不再读，force 才重读", async () => {
      store.set({ archivedCount: 2 });
      const calls = stubApi(() => ({ body: { sessions: [archived("x"), archived("y")] } }));
      await loadArchived();
      expect(calls.map((call) => call.path)).toEqual(["/api/sessions?archived=only"]);
      expect(Object.keys(store.get().archived).sort()).toEqual(["x", "y"]);
      expect(store.get().archivedLoaded).toBe(true);
      expect(store.get().archivedCount).toBe(2);
      expect(archiveUi.get().list.status).toBe("idle");

      await loadArchived();
      expect(calls).toHaveLength(1);
      await loadArchived({ force: true });
      expect(calls).toHaveLength(2);
    });

    it("同一时刻只读一份：在途时再调用返回同一个 Promise，界面处在 loading", async () => {
      const gate = deferred();
      const calls = stubApi(async () => {
        await gate.promise;
        return { body: { sessions: [] } };
      });
      const first = loadArchived();
      const second = loadArchived();
      expect(second).toBe(first);
      expect(archiveUi.get().list.status).toBe("loading");
      gate.resolve();
      await first;
      expect(calls).toHaveLength(1);
      expect(archiveUi.get().list.status).toBe("idle");
    });

    it("读取失败：抛出，界面处在 error 并带着原因，不算读全", async () => {
      stubApi(() => ({ status: 500, body: { error: { code: "internal", message: "boom" } } }));
      await expect(loadArchived()).rejects.toBeInstanceOf(ApiError);
      expect(archiveUi.get().list.status).toBe("error");
      expect(archiveUi.get().list.error).toBeTruthy();
      expect(store.get().archivedLoaded).toBe(false);
    });

    it("读取期间推送来的变化优先：回执里写着已归档、期间却被取消归档的，不会被改回去", async () => {
      store.set({ archivedCount: 2 });
      const gate = deferred();
      stubApi(async () => {
        await gate.promise;
        return { body: { sessions: [archived("a"), archived("b")] } };
      });
      const loading = loadArchived();
      // 期间服务推来：a 已被取消归档（序号不变、不带 archivedAt）。
      patchSummary(summary("a"));
      gate.resolve();
      await loading;
      expect(Object.keys(store.get().archived)).toEqual(["b"]);
      expect(store.get().sessions["a"]).toBeDefined();
      expect(store.get().archivedCount).toBe(1);
    });
  });

  describe("留存策略", () => {
    it("读取：回执里的策略放进状态，上次清扫原样交给调用方", async () => {
      const calls = stubApi(() => ({ body: { retention: { keepDays: 30, keepCount: null }, lastSweep: { at: "2026-11-21T00:00:00.000Z", archived: 4 } } }));
      const response = await readRetention();
      expect(calls).toEqual([{ method: "GET", path: "/api/retention" }]);
      expect(response.lastSweep).toEqual({ at: "2026-11-21T00:00:00.000Z", archived: 4 });
      expect(store.get().retention).toEqual({ keepDays: 30, keepCount: null });
    });

    it("写入：整份替换、回执放进状态；失败原样抛出，状态不动", async () => {
      store.set({ retention: { keepDays: null, keepCount: null } });
      const calls = stubApi(() => ({ body: { retention: { keepDays: 7, keepCount: null } } }));
      await saveRetention({ keepDays: 7, keepCount: null });
      expect(calls).toEqual([{ method: "PUT", path: "/api/retention", body: { keepDays: 7, keepCount: null } }]);
      expect(store.get().retention).toEqual({ keepDays: 7, keepCount: null });

      stubApi(() => ({ status: 400, body: { error: { code: "invalid_request", message: "keepDays must be at least 1" } } }));
      await expect(saveRetention({ keepDays: 0, keepCount: null })).rejects.toBeInstanceOf(ApiError);
      expect(store.get().retention).toEqual({ keepDays: 7, keepCount: null });
    });
  });
});
