import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang, store } from "../lib/app";
import { archiveUi } from "../lib/archive";
import { archivedSummary, deferred, stubApi } from "../lib/archive.fixtures";
import { ArchivedView } from "./ArchivedView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 第 n 秒创建（数字越大越新）。 */
const at = (second: number): string => new Date(Date.UTC(2026, 10, 1, 0, 0, second)).toISOString();

describe("“已归档”视图", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const previous = store.get();

  beforeEach(() => {
    setLang("zh");
    location.hash = "";
    store.set({ sessions: {}, archived: {}, archivedLoaded: false, archivedCount: undefined, toasts: [], settings: { open: false, section: undefined } });
    archiveUi.set({ list: { status: "idle" }, busy: 0 });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    location.hash = "";
    store.set({
      sessions: previous.sessions,
      archived: previous.archived,
      archivedLoaded: previous.archivedLoaded,
      archivedCount: previous.archivedCount,
      toasts: [],
      settings: previous.settings,
      lang: previous.lang,
    });
    archiveUi.set({ list: { status: "idle" }, busy: 0 });
  });

  /** 让挂起的微任务与一个宏任务走完（假 fetch 的应答只靠微任务），并把由此产生的更新提交。 */
  const settle = async (): Promise<void> => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const mount = async (): Promise<void> => {
    await act(async () => {
      root.render(<ArchivedView />);
    });
    await settle();
  };

  const rows = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(".arow")];
  const titles = (): string[] => rows().map((row) => row.querySelector(".slist-title")?.textContent ?? "");
  const unarchiveButton = (title: string): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>(`button[aria-label="取消归档「${title}」"]`);

  it("老服务（不报已归档个数）：只说明这一点，不去读，也没有“留存策略”入口", async () => {
    const calls = stubApi(() => ({ body: { sessions: [] } }));
    await mount();
    expect(host.textContent).toContain("当前运行的服务还不支持归档。");
    expect(calls).toEqual([]);
    expect(host.querySelector(".ws-head-actions")).toBeNull();
    expect(host.querySelector(".ws-ctx-folder")?.textContent).toBe("已归档");
  });

  it("第一次进入才读一次整份：读到之前是“加载中”（标题里先用服务端报的个数），读完画出行，按创建先后排（新的在上）", async () => {
    store.set({ archivedCount: 2 });
    const gate = deferred();
    const calls = stubApi(async () => {
      await gate.promise;
      return { body: { sessions: [archivedSummary("a", { title: "甲", createdAt: at(1) }), archivedSummary("b", { title: "乙", createdAt: at(2) })] } };
    });
    await act(async () => {
      root.render(<ArchivedView />);
    });
    expect(calls.map((call) => call.path)).toEqual(["/api/sessions?archived=only"]);
    expect(host.querySelector('[role="status"]')?.textContent).toContain("正在读取已归档的会话");
    expect(host.querySelector(".ws-ctx-item")?.textContent).toBe("2 个会话");
    expect(rows()).toHaveLength(0);

    gate.resolve();
    await settle();
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(titles()).toEqual(["乙", "甲"]);
    expect(host.querySelector('[role="list"]')?.getAttribute("aria-label")).toBe("已归档");
    // 读过之后不再读。
    expect(calls).toHaveLength(1);
  });

  it("没有归档的会话：一句话，没有插图", async () => {
    store.set({ archivedCount: 0, archivedLoaded: true });
    const calls = stubApi(() => ({ body: { sessions: [] } }));
    await mount();
    expect(host.querySelector(".slist-empty")?.textContent).toBe("还没有归档的会话");
    expect(host.querySelector(".slist-empty svg, .slist-empty img")).toBeNull();
    expect(host.querySelector(".alist")).toBeNull();
    expect(calls).toEqual([]);
  });

  it("读取失败：内联的提示加原因加“重试”，不弹窗；重试成功后画出列表", async () => {
    store.set({ archivedCount: 1 });
    let healthy = false;
    const calls = stubApi(() =>
      healthy
        ? { body: { sessions: [archivedSummary("a", { title: "甲" })] } }
        : { status: 500, body: { error: { code: "internal", message: "boom" } } },
    );
    await mount();
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("读取已归档的会话失败");
    const retry = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("重试"));
    expect(retry).toBeDefined();
    // 失败之后不会自己再试。
    expect(calls).toHaveLength(1);

    healthy = true;
    await act(async () => {
      retry!.click();
    });
    await settle();
    expect(calls).toHaveLength(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(titles()).toEqual(["甲"]);
  });

  it("按任务树缩进：下级紧跟在上级之后；上级写“含 n 个下级”；留存策略自动归档的带“自动归档”，用户归档的没有", async () => {
    const parent = archivedSummary("r", { title: "上级", createdAt: at(1), childIds: ["c"] });
    const child = archivedSummary("c", { title: "下级", createdAt: at(2), parentSessionId: "r" });
    const auto = archivedSummary("x", { title: "自动归档的", createdAt: at(3), archivedBy: "retention" });
    store.set({ archived: { r: parent, c: child, x: auto }, archivedLoaded: true, archivedCount: 3 });
    await mount();

    expect(titles()).toEqual(["自动归档的", "上级", "下级"]);
    expect(rows().map((row) => row.getAttribute("data-depth"))).toEqual(["0", "0", "1"]);
    const [autoRow, parentRow, childRow] = rows();
    expect(parentRow!.querySelector(".slist-files")?.textContent).toBe("含 1 个下级");
    expect(childRow!.querySelector(".slist-files")).toBeNull();
    expect(autoRow!.querySelector(".chip")?.textContent).toBe("自动归档");
    expect(parentRow!.querySelector(".chip")).toBeNull();
    expect(host.querySelector(".ws-ctx-item")?.textContent).toBe("3 个会话");
  });

  it("每行都写着归档时间；标题是指向聚焦页的链接，点行身也进入聚焦页，点按钮不会", async () => {
    store.set({ archived: { a: archivedSummary("a", { title: "甲" }) }, archivedLoaded: true, archivedCount: 1 });
    stubApi(() => ({ body: { changed: ["a"], skipped: [] } }));
    await mount();

    const row = rows()[0]!;
    expect(row.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-20T08:00:00.000Z");
    expect(row.querySelector("time")?.textContent).toMatch(/^归档于 /);
    expect(row.querySelector("a.slist-title")?.getAttribute("href")).toBe("#/s/a");

    act(() => unarchiveButton("甲")!.click());
    expect(location.hash).toBe("");

    act(() => row.click());
    expect(location.hash).toBe("#/s/a");
  });

  it("“取消归档”按钮：按会话 id 请求；有归档在途时每一行的按钮都禁用", async () => {
    store.set({
      archived: { a: archivedSummary("a", { title: "甲", createdAt: at(1) }), b: archivedSummary("b", { title: "乙", createdAt: at(2) }) },
      archivedLoaded: true,
      archivedCount: 2,
    });
    const calls = stubApi(() => ({ body: { changed: ["a"], skipped: [] } }));
    await mount();

    await act(async () => {
      unarchiveButton("甲")!.click();
    });
    await settle();
    expect(calls).toEqual([{ method: "POST", path: "/api/sessions/unarchive", body: { ids: ["a"] } }]);

    act(() => archiveUi.set({ busy: 1 }));
    expect(unarchiveButton("甲")!.disabled).toBe(true);
    expect(unarchiveButton("乙")!.disabled).toBe(true);
    act(() => archiveUi.set({ busy: 0 }));
    expect(unarchiveButton("乙")!.disabled).toBe(false);
  });

  it("每行有导出入口，名字里带着会话标题", async () => {
    store.set({ archived: { a: archivedSummary("a", { title: "甲" }) }, archivedLoaded: true, archivedCount: 1 });
    await mount();
    expect(host.querySelector('button[aria-label="导出「甲」"]')).not.toBeNull();
  });

  it("一次最多画 200 行，其余在“显示更多”后面，点一下再露出 200 行", async () => {
    const base = archivedSummary("base");
    const many = Array.from({ length: 205 }, (_, index) => ({ ...base, id: `s${String(index).padStart(3, "0")}`, title: `会话 ${index}`, createdAt: at(index) }));
    store.set({ archived: Object.fromEntries(many.map((session) => [session.id, session])), archivedLoaded: true, archivedCount: 205 });
    await mount();

    expect(rows()).toHaveLength(200);
    const more = host.querySelector<HTMLButtonElement>(".alist-more button")!;
    expect(more.textContent).toBe("显示更多（还有 5 个）");
    act(() => more.click());
    expect(rows()).toHaveLength(205);
    expect(host.querySelector(".alist-more")).toBeNull();
    // 标题里写的是全部，不是画出来的。
    expect(host.querySelector(".ws-ctx-item")?.textContent).toBe("205 个会话");
  });

  it("页头的“留存策略”：打开设置窗口的“历史”分区", async () => {
    store.set({ archivedCount: 0, archivedLoaded: true });
    await mount();
    const button = host.querySelector<HTMLButtonElement>(".ws-head-actions button")!;
    expect(button.getAttribute("aria-label")).toBe("留存策略");
    act(() => button.click());
    expect(store.get().settings).toEqual({ open: true, section: "history" });
  });

  it("英文界面：同一套结构，文案跟着语言", async () => {
    setLang("en");
    store.set({ archivedCount: 0, archivedLoaded: true });
    await mount();
    expect(host.querySelector(".ws-ctx-folder")?.textContent).toBe("Archived");
    expect(host.querySelector(".slist-empty")?.textContent).toBe("No archived sessions yet");
    expect(host.querySelector(".ws-ctx-item")?.textContent).toBe("0 sessions");
  });
});
