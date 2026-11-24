import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDetail } from "@shared/protocol";
import { EventLog } from "@shared/testing";
import { applyLiveEvents, closeSettings, openSettings, openSwitcher, parseRoute, routeHash, setLang, setSettingsSection, startRouting, store, toast } from "./app";

function detailFor(id: string, extra = 0): SessionDetail {
  const log = new EventLog(id);
  log.created({ id, title: "测试会话" });
  const message = log.message("msg_1", "task", "做点什么");
  log.run("run_1", 1, message.id);
  for (let i = 0; i < extra; i++) log.push({ kind: "diagnostic", data: { level: "info", code: "note", message: `n${i}` } });
  return { summary: {} as SessionDetail["summary"], events: log.events };
}

const until = async (check: () => boolean, ms = 1500): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("路由", () => {
  it("会话路由与哈希互相转换，非法哈希回到总览", () => {
    expect(parseRoute("#/s/ses_abc")).toEqual({ kind: "session", id: "ses_abc" });
    expect(parseRoute("#/s/a%2Fb")).toEqual({ kind: "session", id: "a/b" });
    expect(parseRoute("#/s/ses_abc?x=1")).toEqual({ kind: "session", id: "ses_abc" });
    expect(parseRoute("")).toEqual({ kind: "overview" });
    expect(parseRoute("#/whatever")).toEqual({ kind: "overview" });
    expect(routeHash({ kind: "session", id: "a/b" })).toBe("#/s/a%2Fb");
    expect(routeHash({ kind: "overview" })).toBe("#/");
  });
});

describe("进入聚焦页时读取详情", () => {
  let stop: (() => void) | undefined;

  beforeEach(() => {
    location.hash = "";
    store.set({ route: { kind: "overview" }, detail: undefined });
  });

  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.unstubAllGlobals();
    delete (document as { startViewTransition?: unknown }).startViewTransition;
  });

  it("View Transition 把状态写入推迟到下一帧时，更快返回的详情不会被丢掉", async () => {
    // 本地服务几毫秒就返回，而过渡回调要等下一帧：读取结果必须在状态写入之后才落地。
    (document as { startViewTransition?: unknown }).startViewTransition = (callback: () => void) => {
      setTimeout(callback, 40);
      return {};
    };
    // 用只经过微任务的假响应，保证它一定比 40ms 的过渡回调先完成（真实的 Response 体读取耗时不确定）。
    const json = JSON.stringify(detailFor("ses_slow"));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => json })));

    stop = startRouting();
    location.hash = "#/s/ses_slow";
    await until(() => store.get().detail?.loading === false);

    const detail = store.get().detail;
    expect(detail?.id).toBe("ses_slow");
    expect(detail?.error).toBeUndefined();
    expect(detail?.state?.meta.title).toBe("测试会话");
  });

  it("不支持过渡时同样能读到详情", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(detailFor("ses_plain")), { status: 200, headers: { "content-type": "application/json" } })),
    );
    stop = startRouting();
    location.hash = "#/s/ses_plain";
    await until(() => store.get().detail?.loading === false);
    expect(store.get().detail?.state?.meta.id).toBe("ses_plain");
  });

  it("会话不存在时标记为 not_found 而不是一直加载", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: "not_found", message: "gone" } }), { status: 404 })),
    );
    stop = startRouting();
    location.hash = "#/s/ses_gone";
    await until(() => store.get().detail?.loading === false);
    expect(store.get().detail?.error).toBe("not_found");
  });

  it("离开聚焦页后，晚到的读取结果不会写回", async () => {
    let release: (() => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = () => resolve(new Response(JSON.stringify(detailFor("ses_late")), { status: 200 }));
          }),
      ),
    );
    stop = startRouting();
    location.hash = "#/s/ses_late";
    await until(() => release !== undefined);
    location.hash = "#/";
    await until(() => store.get().route.kind === "overview");
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.get().detail).toBeUndefined();
  });
});

describe("实时事件", () => {
  it("连续的事件原地应用并推进 rev；有缺口时整体重读", async () => {
    const full = detailFor("ses_live", 5);
    const first = { ...full, events: full.events.slice(0, 4) };
    store.set({ route: { kind: "session", id: "ses_live" }, detail: { id: "ses_live", state: undefined, rev: 0, loading: true } });

    const fetchMock = vi.fn(async () => new Response(JSON.stringify(first), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { loadDetail } = await import("./app");
    await loadDetail("ses_live");
    const loaded = store.get().detail;
    expect(loaded?.state?.seq).toBe(4);

    applyLiveEvents("ses_live", [full.events[4]!]);
    expect(store.get().detail?.state?.seq).toBe(5);
    expect(store.get().detail?.rev).toBe((loaded?.rev ?? 0) + 1);

    // 已经应用过的事件不会重复应用。
    applyLiveEvents("ses_live", [full.events[4]!]);
    expect(store.get().detail?.state?.seq).toBe(5);

    // 跳号：丢弃这批事件并重新读取。
    const calls = fetchMock.mock.calls.length;
    applyLiveEvents("ses_live", [full.events[6]!]);
    expect(fetchMock.mock.calls.length).toBe(calls + 1);
    vi.unstubAllGlobals();
  });
});

describe("语言与提示", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("切换语言会持久化并同步 <html lang>", () => {
    setLang("en");
    expect(localStorage.getItem("ensemble.lang")).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(store.get().lang).toBe("en");
    setLang("zh");
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("提示最多同时保留 4 条，并会自动消失", () => {
    vi.useFakeTimers();
    store.set({ toasts: [] });
    for (let i = 0; i < 6; i++) toast("info", `t${i}`, 1000);
    expect(store.get().toasts.map((item) => item.text)).toEqual(["t2", "t3", "t4", "t5"]);
    vi.advanceTimersByTime(1100);
    expect(store.get().toasts).toEqual([]);
    vi.useRealTimers();
  });
});

describe("设置窗口的状态", () => {
  beforeEach(() => {
    store.set({ settings: { open: false, section: undefined }, switcherOpen: false });
  });
  afterEach(() => {
    store.set({ settings: { open: false, section: undefined }, switcherOpen: false });
  });

  it("初始：关着，没有记住的分区（默认落点由窗口取登记表第一项，store 里不写死分区名）", () => {
    expect(store.get().settings).toEqual({ open: false, section: undefined });
  });

  it("openSettings(分区)：打开并停在那个分区；不带分区则沿用上次看的，没有上次的就保持 undefined", () => {
    openSettings();
    expect(store.get().settings).toEqual({ open: true, section: undefined });
    closeSettings();
    openSettings("general");
    expect(store.get().settings).toEqual({ open: true, section: "general" });
    closeSettings();
    expect(store.get().settings).toEqual({ open: false, section: "general" });
    openSettings();
    expect(store.get().settings).toEqual({ open: true, section: "general" });
    openSettings("executors");
    expect(store.get().settings).toEqual({ open: true, section: "executors" });
  });

  it("setSettingsSection：只改分区，不改开关；记在内存里，窗口关了再开仍在", () => {
    openSettings("executors");
    setSettingsSection("general");
    expect(store.get().settings).toEqual({ open: true, section: "general" });
    closeSettings();
    setSettingsSection("executors");
    expect(store.get().settings).toEqual({ open: false, section: "executors" });
  });

  it("记忆只在内存里：不写 localStorage（刷新页面后回到默认分区；语言才是持久的那一项）", () => {
    const before = Object.keys(localStorage).sort();
    openSettings("general");
    setSettingsSection("executors");
    closeSettings();
    expect(Object.keys(localStorage).sort()).toEqual(before);
  });

  it("打开快速切换器会同时关掉设置窗口，但记得它停在哪个分区；两个对话框不会叠在一起", () => {
    openSettings("general");
    openSwitcher();
    expect(store.get().settings).toEqual({ open: false, section: "general" });
    expect(store.get().switcherOpen).toBe(true);
  });
});
