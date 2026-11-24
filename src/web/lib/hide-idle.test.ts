import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** “隐藏未在工作的会话”这个视图偏好的持久化：只在浏览器里，键名以 ensemble. 开头，默认关闭，localStorage 不可用时静默退回内存态。 */

const KEY = "ensemble.canvas.hideIdle";

/** 每次重新加载 lib/app：store 的初始值是模块加载时读 localStorage 得来的。 */
async function loadApp(): Promise<typeof import("./app")> {
  vi.resetModules();
  return import("./app");
}

describe("hideIdle 的持久化", () => {
  beforeEach(() => {
    localStorage.removeItem(KEY);
  });
  afterEach(() => {
    localStorage.removeItem(KEY);
    vi.restoreAllMocks();
  });

  it("键名是 ensemble.canvas.hideIdle，与节点位置的 ensemble.canvas.positions.v1 同属画布的偏好", async () => {
    const app = await loadApp();
    expect(app.HIDE_IDLE_KEY).toBe(KEY);
    expect(KEY.startsWith("ensemble.")).toBe(true);
  });

  it("默认关闭（显示全部）", async () => {
    const app = await loadApp();
    expect(app.store.get().hideIdle).toBe(false);
  });

  it("打开后写进 localStorage；关掉写回“0”；刷新（重新加载模块）后保持", async () => {
    const first = await loadApp();
    first.setHideIdle(true);
    expect(first.store.get().hideIdle).toBe(true);
    expect(localStorage.getItem(KEY)).toBe("1");

    const reloaded = await loadApp();
    expect(reloaded.store.get().hideIdle).toBe(true);

    reloaded.setHideIdle(false);
    expect(localStorage.getItem(KEY)).toBe("0");
    expect((await loadApp()).store.get().hideIdle).toBe(false);
  });

  it("存的是别的值（被改坏、旧版本）：当作关闭，不会误开", async () => {
    for (const bad of ["", "true", "2", "null", "{}"]) {
      localStorage.setItem(KEY, bad);
      expect((await loadApp()).store.get().hideIdle).toBe(false);
    }
  });

  it("localStorage 读不了（隐私模式）：启动时当作关闭，不抛错", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const app = await loadApp();
    expect(app.store.get().hideIdle).toBe(false);
  });

  it("localStorage 写不了：这一次访问里照样生效（退回内存态），不抛错", async () => {
    const app = await loadApp();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => app.setHideIdle(true)).not.toThrow();
    expect(app.store.get().hideIdle).toBe(true);
    expect(() => app.setHideIdle(false)).not.toThrow();
    expect(app.store.get().hideIdle).toBe(false);
  });

  it("不碰服务端：没有任何网络请求", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network expected"));
    const app = await loadApp();
    app.setHideIdle(true);
    app.setHideIdle(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
