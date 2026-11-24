import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@shared/types";
import { collapsedSessions } from "../lib/originCollapse";
import { agentNodeId, gitNodeId, layoutScene, originNodeId, type LayoutOptions, type SceneLayout } from "./layout";

/**
 * `collapsed` 选项（隐藏某个 Main Agent 的相关节点）：调用方把它名下的会话从 visible 里拿掉，
 * 布局保证它仍有一张来源卡，并且它的 Folder / Git 卡随它一起收起（别的来源还在用的除外）。
 */

function s(id: string, order: number, extra: { origin?: string; parent?: string; workspace?: string; phase?: string } = {}): SessionSummary {
  return {
    id,
    phase: extra.phase ?? "running",
    origin: { key: extra.origin ?? "A", ...(extra.workspace ? { workspace: extra.workspace } : {}) },
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, order)).toISOString(),
    ...(extra.parent ? { parentSessionId: extra.parent } : {}),
  } as unknown as SessionSummary;
}

/** 调用方（Overview）做的事：把被隐藏来源名下的会话从可见集合里拿掉，再交给布局。 */
function collapse(list: readonly SessionSummary[], keys: string[], options: LayoutOptions = {}): SceneLayout {
  const gone = collapsedSessions(list, new Set(keys));
  const visible = new Set(list.filter((session) => !gone.has(session.id)).map((session) => session.id));
  return layoutScene(list, { ...options, visible, collapsed: new Set(keys) });
}

const ids = (layout: SceneLayout, kind: string): string[] => layout.nodes.filter((n) => n.kind === kind).map((n) => n.id).sort();
const at = (layout: SceneLayout, id: string) => layout.nodes.find((n) => n.id === id)!;

describe.each([
  ["普通画布", { w: 1200, h: 700 }],
  ["窄画布（宿主侧栏）", { w: 380, h: 700 }],
])("layoutScene · collapsed（%s）", (_name, area) => {
  const list = [
    s("a1", 1, { origin: "A" }),
    s("a2", 2, { origin: "A" }),
    s("a2-kid", 3, { origin: "A", parent: "a2" }),
    s("b1", 4, { origin: "B" }),
    s("c1", 5, { origin: "C" }),
  ];

  it("被隐藏的来源只剩一张来源卡：没有会话节点、没有连线；别的来源原样", () => {
    const layout = collapse(list, ["A"], { area });
    expect(ids(layout, "origin")).toEqual([originNodeId("A"), originNodeId("B"), originNodeId("C")]);
    expect(ids(layout, "agent")).toEqual([agentNodeId("b1"), agentNodeId("c1")]);
    expect(layout.edges.map((edge) => edge.id).sort()).toEqual(["origin:B>agent:b1", "origin:C>agent:c1"]);
    expect(layout.origins.map((group) => group.origin.key)).toEqual(["A", "B", "C"]);
  });

  it("来源卡上的数字仍是真实的：会话数、运行数、第一次委派的时间都按全部会话算（隐藏不让它变小）", () => {
    const full = layoutScene(list, { area });
    const layout = collapse(list, ["A"], { area });
    const a = layout.origins.find((group) => group.origin.key === "A")!;
    expect(a).toMatchObject({ count: 3, running: 3, startedAt: list[0]!.createdAt });
    expect(a).toEqual(full.origins.find((group) => group.origin.key === "A"));
  });

  it("被收起的会话都记在 hidden 里：引擎靠它分清“收起后再出现”与“新到的会话”", () => {
    const layout = collapse(list, ["A"], { area });
    expect([...layout.hidden!].sort()).toEqual([agentNodeId("a1"), agentNodeId("a2"), agentNodeId("a2-kid")]);
  });

  it("来源之间的先后不因隐藏而变：被隐藏的来源仍排在原来的位置上", () => {
    const originsOf = (layout: SceneLayout): string[] => layout.origins.map((group) => group.origin.key);
    expect(originsOf(collapse(list, ["B"], { area }))).toEqual(["A", "B", "C"]);
    expect(originsOf(collapse(list, ["A", "C"], { area }))).toEqual(["A", "B", "C"]);
    // 单列（不给取景区域）时节点从上到下的先后也不变：隐藏中间那个，A 仍在 B 上面、B 仍在 C 上面。
    const single = collapse(list, ["B"]);
    const top = (key: string) => at(single, originNodeId(key)).y;
    expect(top("A")).toBeLessThan(top("B"));
    expect(top("B")).toBeLessThan(top("C"));
  });

  it("嵌套会话的来源先出现也不影响先后：先后看的是第一个根会话的创建时间", () => {
    const tricky = [s("a1", 5, { origin: "A" }), s("b1", 1, { origin: "B" }), s("b1-kid", 2, { origin: "A", parent: "b1" })];
    // A 的第一个根会话（a1）晚于 B 的（b1）：B 在前、A 在后；隐藏 A 之后还是这个先后。
    expect(collapse(tricky, ["A"], { area }).origins.map((group) => group.origin.key)).toEqual(["B", "A"]);
    expect(layoutScene(tricky, { area }).origins.map((group) => group.origin.key)).toEqual(["B", "A"]);
  });

  it("全部隐藏：每个来源仍有一张卡；不隐藏任何来源与不给 collapsed 是同一个布局", () => {
    const layout = collapse(list, ["A", "B", "C"], { area });
    expect(ids(layout, "origin")).toEqual([originNodeId("A"), originNodeId("B"), originNodeId("C")]);
    expect(layout.nodes.every((node) => node.kind === "origin")).toBe(true);
    expect(layoutScene(list, { area, collapsed: new Set() })).toEqual(layoutScene(list, { area }));
  });

  it("隐藏之后重新排紧：不再为被收起的会话留空位", () => {
    const full = layoutScene(list, { area });
    const layout = collapse(list, ["A"], { area });
    expect(layout.bounds.h).toBeLessThan(full.bounds.h);
  });

  it("它名下还有会话画着（正在淡出）时按普通来源排：来源卡与会话还连着，淡出结束才收成一张卡", () => {
    const fading = layoutScene(list, { area, collapsed: new Set(["A"]) });
    expect(ids(fading, "agent")).toEqual(list.map((session) => agentNodeId(session.id)).sort());
    expect(fading.edges.some((edge) => edge.from === originNodeId("A"))).toBe(true);
    expect(fading.hidden).toBeUndefined();
  });

  it("key 对不上任何来源、或只出现在嵌套会话上（它们画在别的来源名下）：不凭空画一张卡", () => {
    const nested = [s("r", 1, { origin: "A" }), s("kid", 2, { origin: "Z", parent: "r" })];
    const layout = layoutScene(nested, { area, collapsed: new Set(["Z", "gone"]), visible: new Set(["r", "kid"]) });
    expect(ids(layout, "origin")).toEqual([originNodeId("A")]);
  });

  it("与“只看工作中”叠加：先被工作过滤收起的来源，隐藏后仍是一张卡；没隐藏的照旧只留工作中的", () => {
    const mixed = [
      s("a1", 1, { origin: "A", phase: "done" }),
      s("b1", 2, { origin: "B", phase: "running" }),
      s("b2", 3, { origin: "B", phase: "done" }),
    ];
    // 工作过滤：只剩 b1；A 隐藏了：A 作为一张卡留着，b1 仍画着，b2 收起。
    const visible = new Set(["b1"]);
    const layout = layoutScene(mixed, { area, visible, collapsed: new Set(["A"]) });
    expect(ids(layout, "origin")).toEqual([originNodeId("A"), originNodeId("B")]);
    expect(ids(layout, "agent")).toEqual([agentNodeId("b1")]);
  });
});

describe("layoutScene · collapsed 与 Folder / Git 卡", () => {
  const WIDE = { w: 1400, h: 800 };
  const repo = "C:\\work\\repo";
  const other = "C:\\work\\other";

  it("独占一个目录的来源隐藏后，Folder 卡与 Git 卡一起收起；来源卡自己写目录行（没有 Folder 节点）", () => {
    const list = [s("a1", 1, { origin: "A", workspace: repo }), s("b1", 2, { origin: "B", workspace: other })];
    const git = new Map([["A", "wt-repo"], ["B", "wt-other"]]);
    const full = layoutScene(list, { area: WIDE, git });
    expect(ids(full, "folder")).toHaveLength(2);
    expect(ids(full, "git")).toHaveLength(2);

    const layout = collapse(list, ["A"], { area: WIDE, git });
    // 留下的 Folder 卡只属于 B；A 的那张没有了。
    expect(layout.folders).toHaveLength(1);
    expect(layout.folders[0]!.origins).toEqual(["B"]);
    expect(ids(layout, "folder")).toEqual(full.folders.filter((folder) => folder.origins.includes("B")).map((folder) => folder.id));
    expect(layout.nodes.some((node) => node.id === gitNodeId("wt-repo"))).toBe(false);
    expect(layout.nodes.some((node) => node.id === gitNodeId("wt-other"))).toBe(true);
    const a = layout.origins.find((group) => group.origin.key === "A")!;
    expect(a.folder).toBeUndefined();
    expect(a.worktree).toBeUndefined();
    expect(layout.edges.some((edge) => edge.to === originNodeId("A") || edge.from === originNodeId("A"))).toBe(false);
  });

  it("几个来源共用一张 Folder / Git 卡：只要还有一个没隐藏，卡片就留着，只是不再连到被隐藏的那个", () => {
    const list = [s("a1", 1, { origin: "A", workspace: repo }), s("b1", 2, { origin: "B", workspace: repo })];
    const git = new Map([["A", "wt"], ["B", "wt"]]);
    const layout = collapse(list, ["A"], { area: WIDE, git });
    expect(layout.folders).toHaveLength(1);
    expect(layout.folders[0]!.origins).toEqual(["B"]);
    expect(ids(layout, "git")).toEqual([gitNodeId("wt")]);
    expect(layout.edges.filter((edge) => edge.to === originNodeId("A"))).toEqual([]);
    expect(layout.edges.some((edge) => edge.to === originNodeId("B"))).toBe(true);
    // 被隐藏的来源自己成一组，没有 Folder 节点，来源卡自己写目录行。
    expect(layout.origins.find((group) => group.origin.key === "A")!.folder).toBeUndefined();
    expect(layout.origins.find((group) => group.origin.key === "B")!.folder).toBeDefined();
  });

  it("共用的卡片所有来源都隐藏了：卡片全部收起", () => {
    const list = [s("a1", 1, { origin: "A", workspace: repo }), s("b1", 2, { origin: "B", workspace: repo })];
    const git = new Map([["A", "wt"], ["B", "wt"]]);
    const layout = collapse(list, ["A", "B"], { area: WIDE, git });
    expect(layout.folders).toEqual([]);
    expect(ids(layout, "git")).toEqual([]);
    expect(ids(layout, "origin")).toEqual([originNodeId("A"), originNodeId("B")]);
  });

  it("没有工作目录的来源（控制台发起）隐藏后同样只剩一张卡", () => {
    const list = [s("u1", 1, { origin: "U" }), s("a1", 2, { origin: "A", workspace: repo })];
    const layout = collapse(list, ["U"], { area: WIDE });
    expect(ids(layout, "origin")).toEqual([originNodeId("A"), originNodeId("U")]);
    expect(ids(layout, "agent")).toEqual([agentNodeId("a1")]);
  });
});
