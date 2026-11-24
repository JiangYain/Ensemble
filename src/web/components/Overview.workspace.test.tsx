import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog, testOrigin } from "@shared/testing";
import type { SessionSummary } from "@shared/types";
import { setLang, setViewMode, store } from "../lib/app";
import type { GitView } from "../lib/git";
import { buildWorkspaces } from "../lib/workspaces";
import { SceneEngine } from "../scene/engine";
import { Overview } from "./Overview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REPO = "C:\\Users\\alice\\Desktop\\Ensemble";

function makeSession(id: string, originKey: string, title: string, opts: { parentSessionId?: string; hostTitle?: string } = {}) {
  const log = new EventLog(id);
  log.created({
    id,
    title,
    harness: "cursor",
    origin: testOrigin({ key: originKey, host: "cursor", hostLabel: "Cursor", workspace: REPO, ...(opts.hostTitle ? { hostTitle: opts.hostTitle } : {}) }),
    ...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
  });
  return toSummary(replay(log.events)!);
}

type Stage = "running" | "done" | "failed";

/**
 * 在 createdAt（毫秒时间戳）创建一个 cursor:a 名下的会话，再推进到 stage。
 * lateBy：运行开始之后又过了多久才结束（只对 done / failed 起作用，running 没有结束事件）——
 * 用它把 updatedAt 与创建先后拉开：旧排序按最近活动，两者不一致才看得出差别。
 */
function stagedSession(
  id: string,
  title: string,
  createdAt: number,
  stage: Stage,
  opts: { lateBy?: number; parentSessionId?: string } = {},
): SessionSummary {
  const log = new EventLog(id, createdAt);
  log.created({
    title,
    harness: "cursor",
    createdAt: new Date(createdAt).toISOString(),
    origin: testOrigin({ key: "cursor:a", host: "cursor", hostLabel: "Cursor", workspace: REPO }),
    ...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
  });
  const message = log.message(`msg_${id}`, "task", title);
  log.run(`run_${id}`, 1, message.id);
  log.startRun(`run_${id}`);
  log.tick(opts.lateBy ?? 0);
  if (stage === "done") log.push({ kind: "run.completed", data: { stopReason: "end_turn" } }, { runId: `run_${id}` });
  if (stage === "failed") log.push({ kind: "run.failed", data: { error: { code: "boom", message: "boom" } } }, { runId: `run_${id}` });
  return toSummary(replay(log.events)!);
}

describe("Overview · 单 Main Agent 独立画布与标头、列表视图", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let previous: ReturnType<typeof store.get>;

  beforeEach(() => {
    previous = store.get();
    localStorage.clear();
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1280 });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
    setLang("zh");
    setViewMode("canvas");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)["clientWidth"];
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)["clientHeight"];
    store.set(previous);
    localStorage.clear();
  });

  it("单 Main Agent 空间只渲染该空间会话，不在画布画 Git/Folder 卡，而把目录和真实 Git 状态升格到左上角编辑部标头", () => {
    const a1 = makeSession("ses_a1", "cursor:a", "实现新侧栏", { hostTitle: "UI 架构改造" });
    const a2 = makeSession("ses_a2", "cursor:a", "验收新侧栏", { parentSessionId: "ses_a1" });
    const b1 = makeSession("ses_b1", "cursor:b", "别的任务", { hostTitle: "另一对话" });
    const all = [a1, a2, b1];
    store.set({ sessions: Object.fromEntries(all.map((s) => [s.id, s])) });

    const gitState: GitView = {
      pending: false,
      tracked: new Set([REPO]),
      entries: new Map([
        [
          REPO,
          {
            stale: false,
            git: {
              root: REPO,
              branch: "main",
              detached: false,
              head: { sha: "b920509abcdef", subject: "build dist", committedAt: "2026-11-17T11:00:00.000Z" },
              changes: { files: 3, staged: 1, unstaged: 2, untracked: 0, conflicted: 0 },
              checkedAt: "2026-11-21T07:00:00.000Z",
            },
          },
        ],
      ]),
    };

    act(() =>
      root.render(
        <Overview
          scope={{ kind: "origin", key: "cursor:a" }}
          workspaces={buildWorkspaces(all)}
          gitState={gitState}
        />,
      ),
    );

    // 画布节点只含 cursor:a 自己的 1 个来源卡 + 2 个会话卡，没有 Git / Folder 节点，也没有 cursor:b 的会话
    expect(host.querySelectorAll(".node.agent")).toHaveLength(2);
    expect(host.querySelectorAll(".node.origin")).toHaveLength(1);
    expect(host.querySelectorAll(".node.git")).toHaveLength(0);
    expect(host.querySelectorAll(".node.folder")).toHaveLength(0);

    // 左上角极简单行标头：不再重复大标题与会话总数，工作目录直接置顶最左，紧接真实 Git 状态
    const header = host.querySelector(".ws-head")!;
    expect(header.querySelector("h1")).toBeNull();
    expect(header.querySelector(".ws-head-title")).toBeNull();
    expect(header.querySelector(".ws-ctx-primary .ws-ctx-folder")?.textContent).toBe("Ensemble");
    expect(header.querySelector(".ws-ctx-branch")?.textContent).toBe("main");
    expect(header.querySelector(".ws-ctx-sha")?.textContent).toBe("b920509");
    expect(header.querySelector(".ws-ctx-status")?.textContent).toBe("3 个文件有改动");
    expect(host.querySelector(".canvas-scale")).not.toBeNull();
  });

  it("单 Main Agent 空间会话较多时自动启用多列规则网格排布（data-grid）", () => {
    const many = Array.from({ length: 12 }, (_, idx) =>
      makeSession(`ses_m${idx + 1}`, "cursor:many", `子任务 ${idx + 1}`, { hostTitle: "批量改造" }),
    );
    store.set({ sessions: Object.fromEntries(many.map((s) => [s.id, s])) });

    act(() =>
      root.render(
        <Overview
          scope={{ kind: "origin", key: "cursor:many" }}
          workspaces={buildWorkspaces(many)}
          gitState={{ pending: false, tracked: new Set(), entries: new Map() }}
        />,
      ),
    );

    expect(host.querySelector(".scene")?.hasAttribute("data-grid")).toBe(true);
    expect(host.querySelectorAll(".node.agent")).toHaveLength(12);
  });

  it("“重置节点布局”以此刻的缩放重新规划：缩小到经典的树放得下（且不是竖串）时，网格回到树形，缩放不变", () => {
    // 3 个根会话各带 2 个子会话：经典的树 940 × 792，要缩到 77% 才放得进 1168 × 608，宽高比也贴着取景区域；
    // 格点排布里每个家族的子会话竖排在父会话右边（线走缝隙、不穿卡），1088 × 656，取景缩到 93%。
    const many = [1, 2, 3].flatMap((n) => [
      makeSession(`ses_r${n}`, "cursor:reset", `子任务 ${n}`, { hostTitle: "批量改造" }),
      ...[1, 2].map((k) => makeSession(`ses_r${n}_k${k}`, "cursor:reset", `子任务 ${n}-${k}`, { parentSessionId: `ses_r${n}` })),
    ]);
    store.set({ sessions: Object.fromEntries(many.map((s) => [s.id, s])) });
    const engine = new SceneEngine();

    act(() =>
      root.render(
        <Overview
          engine={engine}
          scope={{ kind: "origin", key: "cursor:reset" }}
          workspaces={buildWorkspaces(many)}
          gitState={{ pending: false, tracked: new Set(), entries: new Map() }}
        />,
      ),
    );
    // 9 个会话在 100% 缩放下，经典的树放不下（要缩到 77%）：排成多列网格。
    expect(host.querySelector(".scene")?.hasAttribute("data-grid")).toBe(true);

    // 用户再缩小两档（各 ÷1.2）：缩放落在经典的树放得下的 77% 以下，此刻放得下。再点“重置节点布局”。
    const initial = engine.getCamera().k;
    act(() => {
      for (let i = 0; i < 2; i++) engine.zoomBy(1 / 1.2);
    });
    const zoom = engine.getCamera().k;
    expect(zoom).toBeCloseTo(initial / 1.44, 3);
    expect(zoom).toBeLessThan(0.77);
    act(() => engine.resetLayout());

    // 布局带着重置时的缩放重新规划（Overview 订阅了引擎记下的排布缩放）：放得下、又不是竖串，就回到经典的树，缩放原样不动。
    expect(host.querySelector(".scene")?.hasAttribute("data-grid")).toBe(false);
    expect(host.querySelectorAll(".node.agent")).toHaveLength(9);
    expect(engine.getCamera().k).toBeCloseTo(zoom, 6);
  });

  it("点击标头右上角切换为「列表」模式，呈现紧凑父子层级列表且点击行可直达聚焦页", () => {
    const a1 = makeSession("ses_a1", "cursor:a", "实现新侧栏", { hostTitle: "UI 架构改造" });
    const a2 = makeSession("ses_a2", "cursor:a", "验收新侧栏", { parentSessionId: "ses_a1" });
    const all = [a1, a2];
    store.set({ sessions: Object.fromEntries(all.map((s) => [s.id, s])) });

    act(() =>
      root.render(
        <Overview
          scope={{ kind: "origin", key: "cursor:a" }}
          workspaces={buildWorkspaces(all)}
          gitState={{ pending: false, tracked: new Set(), entries: new Map() }}
        />,
      ),
    );

    const listBtn = host.querySelector<HTMLButtonElement>('.ws-view-btn[data-view-mode="list"]')!;
    act(() => listBtn.click());

    expect(store.get().viewMode).toBe("list");
    expect(host.querySelector(".list-stage")).not.toBeNull();
    // 切换画布 → 列表不复用 .scene-world DOM，也不残留相机的 inline transform
    expect(host.querySelector<HTMLElement>(".list-scroll")!.style.transform).toBe("");
    const rows = [...host.querySelectorAll<HTMLElement>(".slist-row")];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.getAttribute("data-depth")).toBe("0");
    expect(rows[1]!.getAttribute("data-depth")).toBe("1");

    act(() => rows[1]!.click());
    expect(location.hash).toBe("#/s/ses_a2");
  });

  it("列表视图的行序只由创建先后决定：会话完成、失败、有新事件都不会让行换位", () => {
    const minute = 60_000;
    const t0 = Date.parse("2026-11-21T08:00:00.000Z");
    // 创建先后：oldest → middle → newest；kid 是 oldest 的子会话，创建得最晚，但仍紧跟在父会话下面。
    // 第一幕：最早创建的在跑——旧排序按状态分层，会把它（连同子会话）顶到最上面。
    const before = [
      stagedSession("ses_oldest", "最早创建", t0, "running"),
      stagedSession("ses_middle", "居中创建", t0 + minute, "done"),
      stagedSession("ses_newest", "最新创建", t0 + 2 * minute, "done"),
      stagedSession("ses_kid", "最早创建的子会话", t0 + 3 * minute, "running", { parentSessionId: "ses_oldest" }),
    ];
    // 第二幕：每个会话的状态都变了——最早的收尾（这条结束事件是全场最新的活动），居中的开始运行，最新的失败，子会话完成。
    // 旧排序会把在跑的居中那条顶到最上面，已结束的里又以最近活动为先，于是最早的排到最新的前面。
    const after = [
      stagedSession("ses_oldest", "最早创建", t0, "done", { lateBy: 60 * minute }),
      stagedSession("ses_middle", "居中创建", t0 + minute, "running"),
      stagedSession("ses_newest", "最新创建", t0 + 2 * minute, "failed"),
      stagedSession("ses_kid", "最早创建的子会话", t0 + 3 * minute, "done", { parentSessionId: "ses_oldest" }),
    ];
    const byId = (list: readonly SessionSummary[]) => Object.fromEntries(list.map((s) => [s.id, s]));
    // 已结束与失败的会话也要在列表里，所以明确关掉“只看工作中”。
    store.set({ sessions: byId(before), hideIdle: false });
    setViewMode("list");

    act(() =>
      root.render(
        <Overview
          scope={{ kind: "origin", key: "cursor:a" }}
          workspaces={buildWorkspaces(before)}
          gitState={{ pending: false, tracked: new Set(), entries: new Map() }}
        />,
      ),
    );

    const rows = () => [...host.querySelectorAll<HTMLElement>(".slist-row")];
    const titles = () => rows().map((row) => row.querySelector(".slist-title")!.textContent);
    // 根会话最新创建的在上；子会话紧跟在父会话下面。
    const order = ["最新创建", "居中创建", "最早创建", "最早创建的子会话"];

    expect(rows().map((row) => row.getAttribute("data-phase"))).toEqual(["done", "done", "running", "running"]);
    expect(titles()).toEqual(order);
    expect(rows().map((row) => row.getAttribute("data-depth"))).toEqual(["0", "0", "0", "1"]);

    act(() => store.set({ sessions: byId(after) }));
    // 状态确实全变了，行却一动没动。
    expect(rows().map((row) => row.getAttribute("data-phase"))).toEqual(["failed", "running", "done", "done"]);
    expect(titles()).toEqual(order);
    expect(rows().map((row) => row.getAttribute("data-depth"))).toEqual(["0", "0", "0", "1"]);

    // 传入数组的顺序反过来，行序也一样。
    act(() => store.set({ sessions: byId([...before].reverse()) }));
    expect(titles()).toEqual(order);
  });

  it("同一时刻创建的会话用 id 兜底：列表行序与传入数组的顺序无关", () => {
    const t0 = Date.parse("2026-11-21T08:00:00.000Z");
    const older = stagedSession("ses_older", "较早创建", t0, "done");
    const tieA = stagedSession("ses_tie_a", "同刻 A", t0 + 60_000, "running");
    const tieB = stagedSession("ses_tie_b", "同刻 B", t0 + 60_000, "running");
    const byId = (list: readonly SessionSummary[]) => Object.fromEntries(list.map((s) => [s.id, s]));
    store.set({ sessions: byId([older, tieA, tieB]), hideIdle: false });
    setViewMode("list");

    act(() =>
      root.render(
        <Overview
          scope={{ kind: "origin", key: "cursor:a" }}
          workspaces={buildWorkspaces([older, tieA, tieB])}
          gitState={{ pending: false, tracked: new Set(), entries: new Map() }}
        />,
      ),
    );

    const titles = () => [...host.querySelectorAll<HTMLElement>(".slist-row .slist-title")].map((el) => el.textContent);
    const first = titles();
    expect(first).toHaveLength(3);
    // 同刻的两条排在较早创建的前面；它们之间的先后由 id 定。
    expect(first[2]).toBe("较早创建");

    act(() => store.set({ sessions: byId([tieB, tieA, older]) }));
    expect(titles()).toEqual(first);
  });
});
