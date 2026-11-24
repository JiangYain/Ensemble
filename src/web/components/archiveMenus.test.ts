import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@shared/types";
import { setLang, store } from "../lib/app";
import { archiveUi } from "../lib/archive";
import { archivedSummary, stubApi, summary } from "../lib/archive.fixtures";
import { saveTextFile } from "../lib/download";
import { bindT } from "../lib/i18n";
import type { MenuEntry, MenuItem } from "./Menu";
import { originMenuEntries } from "./originMenu";
import { selectionMenuEntries, type ArrangeEngine } from "./selectionMenu";
import { nodeMenuItems, sessionMenuItems } from "./sessionActions";

// 保存文件会点一个看不见的 <a download>：这里只关心“有没有保存”，不真的走浏览器。
vi.mock("../lib/download", () => ({ saveTextFile: vi.fn() }));

const t = bindT("zh");
const engine: ArrangeEngine = { align: () => false, distribute: () => false, undo: () => false, redo: () => false, clearSelection: () => undefined };

/** 第 n 秒创建（数字越大越新）。 */
const at = (second: number): string => new Date(Date.UTC(2026, 10, 1, 0, 0, second)).toISOString();
const done = (id: string, patch: Partial<SessionSummary> = {}): SessionSummary => summary(id, { phase: "done", createdAt: at(1), ...patch });
const running = (id: string, patch: Partial<SessionSummary> = {}): SessionSummary => summary(id, { phase: "running", createdAt: at(1), ...patch });
const known = (...list: SessionSummary[]): Record<string, SessionSummary> => Object.fromEntries(list.map((one) => [one.id, one]));

const ids = (entries: readonly { id: string }[]): string[] => entries.map((entry) => entry.id);
function itemNamed(entries: readonly MenuEntry[], id: string): MenuItem {
  const found = entries.find((entry): entry is MenuItem => entry.id === id && "onSelect" in entry);
  if (!found) throw new Error(`菜单里没有：${id}`);
  return found;
}
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("归档与导出的菜单项", () => {
  beforeEach(() => {
    setLang("zh");
    store.set({ sessions: {}, archived: {}, archivedCount: 3, toasts: [], confirm: undefined });
    archiveUi.set({ list: { status: "idle" }, busy: 0 });
    vi.mocked(saveTextFile).mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    store.set({ sessions: {}, archived: {}, archivedCount: undefined, toasts: [], confirm: undefined });
    archiveUi.set({ list: { status: "idle" }, busy: 0 });
  });

  // ───────────────────────── 会话菜单（画布节点的右键 / 头部“···” / 聚焦页） ─────────────────────────

  describe("会话菜单", () => {
    it("老服务（不报已归档个数）：没有归档、取消归档与导出这几项，其余原样", () => {
      store.set({ archivedCount: undefined, sessions: known(done("a")) });
      expect(ids(sessionMenuItems(done("a"), t))).toEqual(["copy-link", "copy-id", "cancel", "stop", "remove"]);
      expect(ids(nodeMenuItems(done("a"), t))).toEqual(["open", "copy-link", "copy-id", "cancel", "stop", "remove"]);
    });

    it("服务懂归档：导出两项紧跟在复制之后（前面一道分隔线），归档紧挨在“删除记录”上面", () => {
      store.set({ sessions: known(done("a")) });
      const items = sessionMenuItems(done("a"), t);
      expect(ids(items)).toEqual(["copy-link", "copy-id", "export-md", "export-md-full", "cancel", "stop", "archive", "remove"]);
      expect(itemNamed(items, "export-md")).toMatchObject({ label: "导出 Markdown", separatorAbove: true });
      expect(itemNamed(items, "export-md-full").label).toBe("导出 Markdown（含工具输出）");
      expect(itemNamed(items, "export-md-full").separatorAbove).toBeUndefined();
      expect(itemNamed(items, "archive")).toMatchObject({ label: "归档", disabled: false });
    });

    it("有下级：多一项“导出 Markdown（含 n 个下级会话）”（整棵任务树），归档的标签写明下级个数", () => {
      const parent = done("r", { childIds: ["c"] });
      const child = done("c", { parentSessionId: "r", createdAt: at(2) });
      store.set({ sessions: known(parent, child) });
      const items = sessionMenuItems(parent, t);
      expect(ids(items)).toEqual(["copy-link", "copy-id", "export-md", "export-md-tree", "export-md-full", "cancel", "stop", "archive", "remove"]);
      expect(itemNamed(items, "export-md-tree").label).toBe("导出 Markdown（含 1 个下级会话）");
      expect(itemNamed(items, "archive")).toMatchObject({ label: "归档（含 1 个下级会话）", disabled: false });
    });

    it("下级摘要找不到（已归档或还没加载）：不写一个偏小的“确切值”", () => {
      const parent = done("r", { childIds: ["c"] });
      store.set({ sessions: known(parent) });
      expect(itemNamed(sessionMenuItems(parent, t), "export-md-tree").label).toBe("导出 Markdown（含下级会话）");
    });

    it("子树里还有会话在工作：归档禁用，原因是摘要里的事实，数字也是", () => {
      const parent = done("r", { childIds: ["c"] });
      const child = running("c", { parentSessionId: "r", createdAt: at(2) });
      store.set({ sessions: known(parent, child) });
      expect(itemNamed(sessionMenuItems(parent, t), "archive")).toMatchObject({
        label: "归档（含 1 个下级会话）",
        disabled: true,
        disabledReason: "还有 1 个会话在工作，等它们结束后才能归档",
      });
    });

    it("待命（ready）不算已结束；消息没被确认的已结束会话同样挡着", () => {
      const idle = summary("a", { phase: "ready" });
      store.set({ sessions: known(idle) });
      expect(itemNamed(sessionMenuItems(idle, t), "archive")).toMatchObject({ disabled: true, disabledReason: "还有 1 个会话在待命（还开着，不算已结束），关闭后才能归档" });

      const unacknowledged = summary("b", { phase: "done", messages: { ...summary("b").messages, pending: 1 } });
      store.set({ sessions: known(unacknowledged) });
      expect(itemNamed(sessionMenuItems(unacknowledged, t), "archive")).toMatchObject({ disabled: true, disabledReason: "还有 1 个会话的消息没有被确认，处理完才能归档" });
    });

    it("会话不在目录里（聚焦页刚打开、目录还没到）：用传进来的摘要自己预判，不报错", () => {
      store.set({ sessions: {} });
      expect(itemNamed(sessionMenuItems(done("solo"), t), "archive")).toMatchObject({ label: "归档", disabled: false });
    });

    it("已归档的会话：给“取消归档”，不再有“归档”", () => {
      const items = sessionMenuItems(archivedSummary("a"), t);
      expect(ids(items)).toContain("unarchive");
      expect(ids(items)).not.toContain("archive");
      expect(itemNamed(items, "unarchive")).toMatchObject({ label: "取消归档", disabled: false });
    });

    it("上一个归档操作在途：归档与取消归档都禁用，原因写明", () => {
      archiveUi.set({ busy: 1 });
      store.set({ sessions: known(done("a")) });
      expect(itemNamed(sessionMenuItems(done("a"), t), "archive")).toMatchObject({ disabled: true, disabledReason: "上一个归档操作还在进行" });
      expect(itemNamed(sessionMenuItems(archivedSummary("b"), t), "unarchive")).toMatchObject({ disabled: true, disabledReason: "上一个归档操作还在进行" });
    });

    it("归档一个会话（含它的子树）不问确认，直接请求，名单只有它自己", async () => {
      const calls = stubApi(() => ({ body: { changed: ["a"], skipped: [] } }));
      store.set({ sessions: known(done("a")) });
      itemNamed(sessionMenuItems(done("a"), t), "archive").onSelect();
      expect(store.get().confirm).toBeUndefined();
      await settle();
      expect(calls).toEqual([{ method: "POST", path: "/api/sessions/archive", body: { ids: ["a"] } }]);
    });

    it("取消归档同样直接请求", async () => {
      const calls = stubApi(() => ({ body: { changed: ["a"], skipped: [] } }));
      itemNamed(sessionMenuItems(archivedSummary("a"), t), "unarchive").onSelect();
      await settle();
      expect(calls).toEqual([{ method: "POST", path: "/api/sessions/unarchive", body: { ids: ["a"] } }]);
    });

    it("导出：一次点击就请求并保存，范围与详细度来自各自的菜单项；不弹对话框，成功不打扰", async () => {
      const calls = stubApi(() => ({ text: "# 报告", headers: { "content-disposition": 'attachment; filename="r.md"' } }));
      const parent = done("r", { childIds: ["c"] });
      store.set({ sessions: known(parent, done("c", { parentSessionId: "r", createdAt: at(2) })) });
      const items = sessionMenuItems(parent, t);

      itemNamed(items, "export-md").onSelect();
      await settle();
      itemNamed(items, "export-md-tree").onSelect();
      await settle();
      itemNamed(items, "export-md-full").onSelect();
      await settle();

      expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
        "GET /api/sessions/r/report?scope=session&detail=brief&lang=zh",
        "GET /api/sessions/r/report?scope=tree&detail=brief&lang=zh",
        "GET /api/sessions/r/report?scope=session&detail=full&lang=zh",
      ]);
      expect(saveTextFile).toHaveBeenCalledTimes(3);
      expect(saveTextFile).toHaveBeenCalledWith("r.md", "# 报告");
      expect(store.get().confirm).toBeUndefined();
      expect(store.get().toasts).toEqual([]);
    });

    it("报告的语言跟着界面语言；菜单文案也是", async () => {
      setLang("en");
      const calls = stubApi(() => ({ text: "# report" }));
      const items = sessionMenuItems(done("a"), bindT("en"));
      expect(itemNamed(items, "export-md").label).toBe("Export Markdown");
      expect(itemNamed(items, "archive").label).toBe("Archive");
      itemNamed(items, "export-md").onSelect();
      await settle();
      expect(calls.map((call) => call.path)).toEqual(["/api/sessions/a/report?scope=session&detail=brief&lang=en"]);
    });
  });

  // ───────────────────────── Main Agent 来源卡的菜单 ─────────────────────────

  describe("来源卡菜单：归档整个 Main Agent 空间", () => {
    const KEY = "codex:thr_test";
    const entries = (list: SessionSummary[], archiveSupported = true): MenuEntry[] =>
      originMenuEntries({ key: KEY, sessions: list, collapsed: new Set(), t, announce: () => undefined, archiveSupported })!;

    it("老服务（缺省＝不懂归档）：只有“隐藏相关节点”这一项", () => {
      const list = [done("a")];
      store.set({ sessions: known(...list) });
      expect(ids(entries(list, false))).toEqual(["toggle"]);
    });

    it("整个空间的会话都已结束：项名写实际会归档几个（含随上级走的下级）", () => {
      const list = [done("r", { childIds: ["c"] }), done("c", { parentSessionId: "r", createdAt: at(2) })];
      store.set({ sessions: known(...list) });
      const item = itemNamed(entries(list), "archive-space");
      expect(item).toMatchObject({ label: "归档整个 Main Agent 空间（2 个会话）", disabled: false, separatorAbove: true });
    });

    it("还有在工作的会话：项名改成“归档已完成的会话（n 个，其余保留）”，留下的整棵不动", () => {
      const list = [done("a"), done("b", { createdAt: at(2) }), running("w", { createdAt: at(3) })];
      store.set({ sessions: known(...list) });
      expect(itemNamed(entries(list), "archive-space")).toMatchObject({ label: "归档已完成的会话（2 个，其余保留）", disabled: false });
    });

    it("一个都归档不了：禁用，原因是那些会话为什么不能归档", () => {
      const list = [running("w1"), running("w2", { createdAt: at(2) })];
      store.set({ sessions: known(...list) });
      expect(itemNamed(entries(list), "archive-space")).toMatchObject({
        label: "归档整个 Main Agent 空间",
        disabled: true,
        disabledReason: "还有 2 个会话在工作，等它们结束后才能归档",
      });
    });

    it("上一个归档操作在途：禁用，原因写明", () => {
      archiveUi.set({ busy: 1 });
      const list = [done("a")];
      store.set({ sessions: known(...list) });
      expect(itemNamed(entries(list), "archive-space")).toMatchObject({ disabled: true, disabledReason: "上一个归档操作还在进行" });
    });

    it("选中它先问一次（写明数量），不改“隐藏相关节点”的偏好", () => {
      const list = [done("a"), done("b", { createdAt: at(2) })];
      store.set({ sessions: known(...list) });
      const before = store.get().collapsedOrigins;
      itemNamed(entries(list), "archive-space").onSelect();
      expect(store.get().confirm?.title).toBe("归档这 2 个会话？");
      expect(store.get().collapsedOrigins).toBe(before);
    });
  });

  // ───────────────────────── 多选菜单 ─────────────────────────

  describe("多选菜单：归档所选", () => {
    const menu = (selected: SessionSummary[], archiveSupported = true): MenuEntry[] =>
      selectionMenuEntries({ engine, count: selected.length, sessions: selected, canUndo: false, canRedo: false, t, announce: () => undefined, archiveSupported });

    it("老服务（缺省＝不懂归档）：没有这一项", () => {
      const list = [done("a")];
      store.set({ sessions: known(...list) });
      expect(ids(menu(list, false))).not.toContain("archive");
    });

    it("在“其中 M 个会话”这一组里，位于“关闭会话”之后、“删除记录”之前", () => {
      const list = [done("a")];
      store.set({ sessions: known(...list) });
      const all = ids(menu(list));
      expect(all.slice(all.indexOf("sessions"))).toEqual(["sessions", "copy-ids", "cancel", "stop", "archive", "remove"]);
    });

    it("每个选中的会话按子树归档：项名里是实际会归档的个数（含没被选中的下级）", () => {
      const parent = done("r", { childIds: ["c"] });
      const child = done("c", { parentSessionId: "r", createdAt: at(2) });
      store.set({ sessions: known(parent, child, done("x", { createdAt: at(3) })) });
      expect(itemNamed(menu([parent]), "archive")).toMatchObject({ label: "归档所选（2 个会话）", disabled: false });
    });

    it("选中里有还在工作的：它们不算，数字只数能归档的", () => {
      const a = done("a");
      const w = running("w", { createdAt: at(2) });
      store.set({ sessions: known(a, w) });
      expect(itemNamed(menu([a, w]), "archive")).toMatchObject({ label: "归档所选（1 个会话）", disabled: false });
    });

    it("全都归档不了：禁用，原因写明", () => {
      const w = running("w");
      store.set({ sessions: known(w) });
      expect(itemNamed(menu([w]), "archive")).toMatchObject({
        label: "归档所选（0 个会话）",
        disabled: true,
        disabledReason: "还有 1 个会话在工作，等它们结束后才能归档",
      });
    });

    it("上一个归档操作在途：禁用，原因写明", () => {
      archiveUi.set({ busy: 1 });
      const a = done("a");
      store.set({ sessions: known(a) });
      expect(itemNamed(menu([a]), "archive")).toMatchObject({ disabled: true, disabledReason: "上一个归档操作还在进行" });
    });

    it("选中它先问一次，确认之后才发请求；名单是被选中的会话", async () => {
      const calls = stubApi(() => ({ body: { changed: ["a", "b"], skipped: [] } }));
      const a = done("a");
      const b = done("b", { createdAt: at(2) });
      store.set({ sessions: known(a, b) });
      itemNamed(menu([a, b]), "archive").onSelect();
      const request = store.get().confirm!;
      expect(request.title).toBe("归档这 2 个会话？");
      expect(calls).toEqual([]);
      await request.onConfirm();
      expect(calls).toEqual([{ method: "POST", path: "/api/sessions/archive", body: { ids: ["a", "b"] } }]);
    });
  });
});
