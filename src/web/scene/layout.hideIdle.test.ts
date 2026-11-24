import { describe, expect, it } from "vitest";
import type { SessionPhase, SessionSummary } from "@shared/types";
import { filterWorking } from "../lib/workFilter";
import { agentNodeId, layoutScene, originNodeId, type SceneLayout } from "./layout";

/** `visible` 选项（视图过滤“只看工作中”）：只排留下的会话，来源卡上的数字仍是全部会话的真实数字。 */

function s(id: string, phase: SessionPhase, order: number, extra: { origin?: string; parent?: string; workspace?: string; hostTitle?: string } = {}): SessionSummary {
  const key = extra.origin ?? "A";
  return {
    id,
    phase,
    origin: { key, ...(extra.workspace ? { workspace: extra.workspace } : {}), ...(extra.hostTitle ? { hostTitle: extra.hostTitle } : {}) },
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, order)).toISOString(),
    ...(extra.parent ? { parentSessionId: extra.parent } : {}),
  } as unknown as SessionSummary;
}

const ids = (layout: ReturnType<typeof layoutScene>, kind: string): string[] => layout.nodes.filter((n) => n.kind === kind).map((n) => n.id).sort();

describe.each([
  ["普通画布", { w: 1200, h: 700 }],
  ["窄画布（宿主侧栏）", { w: 380, h: 700 }],
])("layoutScene · visible（%s）", (_name, area) => {
  const list = [
    s("a-run", "running", 1),
    s("a-done", "done", 2),
    s("a-fail", "failed", 3),
    s("a-ready", "ready", 4),
    s("a-stop", "stopped", 5, { hostTitle: "整理解析器" }),
    s("b-done", "done", 6, { origin: "B" }),
    s("b-cancel", "cancelled", 7, { origin: "B" }),
  ];
  const view = filterWorking(list);

  it("只排 visible 里的会话（运行中与待命）；没有会话留下的来源不画卡片、也没有连线", () => {
    const layout = layoutScene(list, { area, visible: view.visible });
    expect(ids(layout, "agent")).toEqual([agentNodeId("a-ready"), agentNodeId("a-run")]);
    expect(ids(layout, "origin")).toEqual([originNodeId("A")]);
    expect(layout.origins.map((group) => group.origin.key)).toEqual(["A"]);
    expect(layout.edges.map((edge) => edge.id).sort()).toEqual([`origin:A>agent:a-ready`, `origin:A>agent:a-run`]);
  });

  it("来源卡上的数字仍是真实总数：会话数、运行数、第一次委派的时间、宿主标题都按全部会话算", () => {
    const full = layoutScene(list, { area });
    const hidden = layoutScene(list, { area, visible: view.visible });
    const [group] = hidden.origins;
    expect(group).toMatchObject({ count: 5, running: 1, startedAt: list[0]!.createdAt, hostTitle: "整理解析器" });
    expect(group).toEqual(full.origins.find((candidate) => candidate.origin.key === "A"));
  });

  it("最早的会话被收起时，第一次委派的时间仍是它的（不是留下的最早一个）", () => {
    const sessions = [s("old", "done", 1), s("new", "running", 9)];
    const layout = layoutScene(sessions, { area, visible: filterWorking(sessions).visible });
    expect(layout.origins[0]!.startedAt).toBe(sessions[0]!.createdAt);
    expect(layout.origins[0]!.count).toBe(2);
  });

  it("不给 visible 与给“全部”是同一个布局", () => {
    const all = new Set(list.map((session) => session.id));
    expect(layoutScene(list, { area, visible: all })).toEqual(layoutScene(list, { area }));
  });

  it("保留祖先链：父已完成、子运行中，连线是 来源 → 父 → 子，没有 来源 → 子", () => {
    const chain = [s("p", "done", 1), s("c", "running", 2, { parent: "p" }), s("x", "done", 3)];
    const layout = layoutScene(chain, { area, visible: filterWorking(chain).visible });
    expect(layout.edges.map((edge) => edge.id).sort()).toEqual(["agent:p>agent:c", "origin:A>agent:p"]);
  });

  it("收起之后重新排紧：剩下的节点不再为被收起的会话留空位", () => {
    const full = layoutScene(list, { area });
    const tight = layoutScene(list, { area, visible: view.visible });
    expect(tight.bounds.h).toBeLessThan(full.bounds.h);
    // 剩下的两个会话（运行中、待命）紧挨着排，行距与完整布局里相邻两行相同；来源卡落在它们的纵向正中。
    const at = (layout: SceneLayout, id: string) => layout.nodes.find((n) => n.id === id)!;
    const run = at(tight, agentNodeId("a-run"));
    const ready = at(tight, agentNodeId("a-ready"));
    const origin = at(tight, originNodeId("A"));
    expect(ready.y - run.y).toBe(at(full, agentNodeId("a-done")).y - at(full, agentNodeId("a-run")).y);
    expect(origin.y + origin.h / 2).toBe((run.y + ready.y + ready.h) / 2);
  });

  it("全部都收起：没有任何节点与连线，不出错", () => {
    const layout = layoutScene(list, { area, visible: new Set() });
    expect(layout.nodes).toEqual([]);
    expect(layout.edges).toEqual([]);
    expect(layout.origins).toEqual([]);
  });
});

describe("layoutScene · visible 与 Folder / Git", () => {
  const area = { w: 1200, h: 700 };
  const repo = "C:\\repo";
  const list = [
    s("a-run", "running", 1, { origin: "A", workspace: repo }),
    s("b-done", "done", 2, { origin: "B", workspace: repo }),
    s("c-done", "done", 3, { origin: "C", workspace: "C:\\other" }),
  ];
  const git = new Map([["A", "wt-repo"], ["B", "wt-repo"], ["C", "wt-other"]]);

  it("来源收起后，只服务于它的 Folder 与 Git 卡也不排；共用的那张留着", () => {
    const layout = layoutScene(list, { area, git, visible: filterWorking(list).visible });
    expect(ids(layout, "origin")).toEqual(["origin:A"]);
    expect(ids(layout, "folder")).toEqual(["folder:c:/repo"]);
    expect(ids(layout, "git")).toEqual(["git:wt-repo"]);
    // 用这个目录的 Main Agent 里只排了 A；真实个数由调用方按全部来源另算（Overview 里按全部来源修正）。
    expect(layout.folders.map((folder) => folder.origins)).toEqual([["A"]]);
  });

  it("没有任何来源留下：Folder 与 Git 都不排", () => {
    const layout = layoutScene(list, { area, git, visible: new Set() });
    expect(layout.nodes).toEqual([]);
    expect(layout.folders).toEqual([]);
  });
});
