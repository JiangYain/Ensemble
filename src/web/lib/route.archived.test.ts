import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { navigate, parseRoute, routeHash, startRouting, store } from "./app";

const until = async (check: () => boolean, ms = 1500): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("路由：#/archived（“已归档”视图）", () => {
  it("认得 #/archived，后面跟斜杠、查询串或锚点也认得", () => {
    for (const hash of ["#/archived", "#/archived/", "#/archived?x=1", "#/archived#top", "#/archived/anything"]) {
      expect(parseRoute(hash)).toEqual({ kind: "archived" });
    }
  });

  it("只认整段：别的前缀不是它，回到总览", () => {
    for (const hash of ["#/archivedx", "#/archive", "#/archived-2", "#/Archived", "#archived", "archived"]) {
      expect(parseRoute(hash)).toEqual({ kind: "overview" });
    }
  });

  it("不会抢别的路由：会话 id 恰好叫 archived 还是会话，名叫 archived 的 Main Agent 还是空间", () => {
    expect(parseRoute("#/s/archived")).toEqual({ kind: "session", id: "archived" });
    expect(parseRoute("#/m/archived")).toEqual({ kind: "overview", scope: { kind: "origin", key: "archived" } });
    expect(parseRoute("#/active")).toEqual({ kind: "overview", scope: { kind: "active" } });
    expect(parseRoute("#/all")).toEqual({ kind: "overview", scope: { kind: "all" } });
  });

  it("routeHash 与 parseRoute 互逆", () => {
    expect(routeHash({ kind: "archived" })).toBe("#/archived");
    expect(parseRoute(routeHash({ kind: "archived" }))).toEqual({ kind: "archived" });
  });
});

describe("路由：进入与离开“已归档”视图", () => {
  let stop: (() => void) | undefined;
  const previous = store.get();

  beforeEach(() => {
    location.hash = "";
    store.set({ route: { kind: "overview" }, detail: undefined });
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    location.hash = "";
    store.set(previous);
  });

  it("导航到它：地址变成 #/archived，状态里的路由跟着变，没有聚焦页的详情", async () => {
    stop = startRouting();
    navigate({ kind: "archived" });
    expect(location.hash).toBe("#/archived");
    await until(() => store.get().route.kind === "archived");
    expect(store.get().detail).toBeUndefined();
  });

  it("已经在这个视图里再导航一次：不重复写地址（不会多出一条历史记录）", () => {
    location.hash = "#/archived";
    const before = history.length;
    navigate({ kind: "archived" });
    expect(location.hash).toBe("#/archived");
    expect(history.length).toBe(before);
  });

  it("从它回到总览或某个空间：状态里的路由跟着变", async () => {
    stop = startRouting();
    location.hash = "#/archived";
    await until(() => store.get().route.kind === "archived");

    location.hash = "#/m/cursor%3Aa";
    await until(() => store.get().route.kind === "overview");
    expect(store.get().route).toEqual({ kind: "overview", scope: { kind: "origin", key: "cursor:a" } });
  });
});
