import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@shared/types";

/**
 * “隐藏某个 Main Agent 的相关节点”的持久化：只在浏览器里，键名以 ensemble. 开头，默认没有任何来源被隐藏；
 * 存的东西坏了就当没有（宁可全部显示）；localStorage 不可用时静默退回内存态。
 */

const KEY = "ensemble.canvas.collapsedOrigins";

/** 每次重新加载 lib/app：store 的初始值是模块加载时读 localStorage 得来的。 */
async function loadApp(): Promise<typeof import("./app")> {
  vi.resetModules();
  return import("./app");
}

const session = (id: string, key: string): SessionSummary => ({ id, origin: { key } }) as unknown as SessionSummary;

describe("collapsedOrigins 的持久化", () => {
  beforeEach(() => {
    localStorage.removeItem(KEY);
  });
  afterEach(() => {
    localStorage.removeItem(KEY);
    vi.restoreAllMocks();
  });

  it("键名是 ensemble.canvas.collapsedOrigins，与 hideIdle、节点位置同属画布的浏览器偏好", async () => {
    const app = await loadApp();
    expect(app.COLLAPSED_ORIGINS_KEY).toBe(KEY);
    expect(KEY.startsWith("ensemble.canvas.")).toBe(true);
  });

  it("默认一个都不隐藏", async () => {
    expect([...(await loadApp()).store.get().collapsedOrigins]).toEqual([]);
  });

  it("隐藏后写进 localStorage（排序后的 JSON 数组）；恢复后写回；刷新（重新加载模块）后保持", async () => {
    const first = await loadApp();
    first.setOriginCollapsed("pi:z", true);
    first.setOriginCollapsed("cursor:a", true);
    expect(localStorage.getItem(KEY)).toBe('["cursor:a","pi:z"]');

    const reloaded = await loadApp();
    expect([...reloaded.store.get().collapsedOrigins].sort()).toEqual(["cursor:a", "pi:z"]);

    reloaded.setOriginCollapsed("pi:z", false);
    expect(localStorage.getItem(KEY)).toBe('["cursor:a"]');
    expect([...(await loadApp()).store.get().collapsedOrigins]).toEqual(["cursor:a"]);
  });

  it("重复隐藏同一个来源只记一次", async () => {
    const app = await loadApp();
    app.setOriginCollapsed("cursor:a", true);
    app.setOriginCollapsed("cursor:a", true);
    expect(localStorage.getItem(KEY)).toBe('["cursor:a"]');
  });

  it("每次都换一个新的 Set：订阅者靠引用变化得知更新，旧的 Set 不被原地改", async () => {
    const app = await loadApp();
    const before = app.store.get().collapsedOrigins;
    app.setOriginCollapsed("cursor:a", true);
    const after = app.store.get().collapsedOrigins;
    expect(after).not.toBe(before);
    expect(before.size).toBe(0);
    app.expandAllOrigins();
    expect(app.store.get().collapsedOrigins).not.toBe(after);
    expect(after.size).toBe(1);
  });

  it("全部显示：清空内存与存储", async () => {
    const app = await loadApp();
    app.setOriginCollapsed("a", true);
    app.setOriginCollapsed("b", true);
    app.expandAllOrigins();
    expect(app.store.get().collapsedOrigins.size).toBe(0);
    expect(localStorage.getItem(KEY)).toBe("[]");
  });

  it("存的是坏数据（不是 JSON、不是数组、混着别的类型、空串）：当作没有，不抛错；数组里能用的照留", async () => {
    for (const bad of ["", "not json", "{}", "null", "42", '"cursor:a"']) {
      localStorage.setItem(KEY, bad);
      expect([...(await loadApp()).store.get().collapsedOrigins]).toEqual([]);
    }
    localStorage.setItem(KEY, JSON.stringify(["cursor:a", 3, null, "", { key: "x" }, "pi:b"]));
    expect([...(await loadApp()).store.get().collapsedOrigins].sort()).toEqual(["cursor:a", "pi:b"]);
  });

  it("localStorage 读不了（隐私模式）：启动时当作没有，不抛错", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect((await loadApp()).store.get().collapsedOrigins.size).toBe(0);
  });

  it("localStorage 写不了：这一次访问里照样生效（退回内存态），不抛错", async () => {
    const app = await loadApp();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => app.setOriginCollapsed("cursor:a", true)).not.toThrow();
    expect(app.store.get().collapsedOrigins.has("cursor:a")).toBe(true);
    expect(() => app.expandAllOrigins()).not.toThrow();
    expect(app.store.get().collapsedOrigins.size).toBe(0);
  });

  it("不碰服务端：没有任何网络请求", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network expected"));
    const app = await loadApp();
    app.setOriginCollapsed("cursor:a", true);
    app.expandAllOrigins();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe("清理已经没有会话的来源", () => {
    it("会话已加载完：写入时丢掉没有会话的来源记录（会话都删了，这条记录再也不会起作用）", async () => {
      localStorage.setItem(KEY, JSON.stringify(["dead:old", "cursor:a"]));
      const app = await loadApp();
      app.store.set({ ready: true, sessions: { s1: session("s1", "cursor:a"), s2: session("s2", "pi:b") } });
      app.setOriginCollapsed("pi:b", true);
      expect([...app.store.get().collapsedOrigins].sort()).toEqual(["cursor:a", "pi:b"]);
      expect(localStorage.getItem(KEY)).toBe('["cursor:a","pi:b"]');
    });

    it("会话还没加载完（ready 之前）：不丢——此刻不能凭空认为“它不存在”，否则刷新一下就把偏好洗掉了", async () => {
      localStorage.setItem(KEY, JSON.stringify(["cursor:a"]));
      const app = await loadApp();
      expect(app.store.get().ready).toBe(false);
      app.setOriginCollapsed("pi:b", true);
      expect([...app.store.get().collapsedOrigins].sort()).toEqual(["cursor:a", "pi:b"]);
    });

    it("正在隐藏的这一个，即使它眼下没有会话也不被丢（调用方明确要隐藏它）", async () => {
      const app = await loadApp();
      app.store.set({ ready: true, sessions: {} });
      app.setOriginCollapsed("cursor:a", true);
      expect([...app.store.get().collapsedOrigins]).toEqual(["cursor:a"]);
    });
  });
});
