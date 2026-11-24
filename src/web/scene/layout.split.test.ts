import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@shared/types";
import * as facade from "./layout";
import { agentNodeId, gitNodeId, layoutScene, NODE, originNodeId, type LayoutFolder, type LayoutNode } from "./layout";
import { inDir, REPO, REPO_ID, REPO_KEY, session } from "./layout.fixtures";
import { buildModel, hiddenAgentIds } from "./layout-model";
import { assemble, type SceneContext } from "./layout-scene-assemble";
import { arrangeScene } from "./layout-scene-select";
import { layoutDims, SceneTree } from "./layout-tree";
import { NO_OVERHANG, type Built, type LayoutOptions, type OriginGroup, type Sink } from "./layout-types";
import { workspaceClusters, type WorkspaceSettings } from "./layout-workspace";

/**
 * layout.ts 拆成几个模块之后的“接缝”对照（SPLIT-L）。layout.golden.test.ts 固定的是整体输出，这里补的是它看不到、却最容易在拆分时悄悄变的东西：
 * 公开出口与模块之间的依赖方向（不许有环）、几处靠“同一个对象”才成立的约定（来源摘要被 Folder / Git 卡补字段、`NO_OVERHANG` 共用、
 * 节点属性的先后）、没有状态漏到下一次调用或改动调用方的数据，以及每个新模块自己的契约（模型、树、Folder 与 Git 的归组、摆放、排列）。
 * 期望值都从代码的约定与 `NODE` 尺寸推出来，不是把某次输出抄下来；整体输出变没变仍由 golden 管。
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string): string => readFileSync(join(here, `${name}.ts`), "utf8");
const lineCount = (text: string): number => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
const importsOf = (name: string): string[] => [...read(name).matchAll(/\bfrom "([^"]+)"/g)].map((match) => match[1]!);

/** 拆分后各模块的层级：只许依赖层级更低的兄弟（layout.ts 在最上面）。 */
const RANK: Record<string, number> = {
  "layout-types": 0,
  "layout-workspace": 1,
  "layout-model": 1,
  "layout-tree": 2,
  "layout-scene-assemble": 3,
  "layout-scene-select": 4,
  layout: 5,
};

describe("layout 模块的公开出口与依赖方向", () => {
  it("layout.ts 的运行时出口就是拆分前的那些：尺寸、取景、节点 id 与 layoutScene；中间产物不外泄", () => {
    expect(Object.keys(facade).sort()).toEqual([
      "FIT_ALL_MIN_ZOOM", "FIT_FLOOR", "MIN_ZOOM", "NODE", "agentNodeId", "boundsOf", "fitArea", "fitCamera", "fitPadding", "fitScale",
      "folderNodeId", "gitNodeId", "holdScale", "isCompact", "layoutScene", "originNodeId",
    ]);
  });

  it("每个模块只依赖层级更低的兄弟：没有环，新模块也不回头读 layout.ts", () => {
    for (const [name, rank] of Object.entries(RANK)) {
      for (const target of importsOf(name)) {
        const sibling = target.replace(/^\.\//, "");
        if (!target.startsWith("./") || !(sibling in RANK)) continue;
        expect(RANK[sibling]!, `${name} → ${sibling}`).toBeLessThan(rank);
      }
    }
  });

  it("拆出来的模块都不超过 450 行，layout.ts 只剩总调度（不超过 300 行）", () => {
    for (const name of Object.keys(RANK)) expect(lineCount(read(name)), name).toBeLessThanOrEqual(name === "layout" ? 300 : 450);
  });
});

const WIDE = { w: 1200, h: 700 };
const FAN_30 = Array.from({ length: 30 }, (_, i) => session(`s${i}`, "A", i + 1));
/** 汇聚：J 跟随 R2 与 K（主上级 R2）；R1 下面是 K；另有来源 B。 */
const joinScene = (): SessionSummary[] => [
  session("r1", "A", 1),
  session("r2", "A", 2),
  session("k", "A", 3, { parentSessionId: "r1" }),
  session("j", "A", 4, { parentSessionId: "r2", parentSessionIds: ["r2", "k"], phase: "done" }),
  session("b1", "B", 5),
];
const ids = (list: readonly { id: string }[]): string[] => list.map((item) => item.id);
const sceneOf = (sessions: readonly SessionSummary[], options: LayoutOptions = {}): SceneContext => {
  const dims = layoutDims(options);
  const model = buildModel(sessions, options);
  return { options, dims, model, tree: new SceneTree(model, dims) };
};
const freeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
};

describe("layoutScene · 几处靠“同一个对象”和次序成立的约定", () => {
  const shared = [inDir("a1", "codex", 1, REPO), inDir("a2", "codex", 2, REPO), inDir("b1", "cursor", 3, REPO)];
  const options = { area: WIDE, git: new Map([["codex", "wt"], ["cursor", "wt"]]) };

  it("Folder / Git 卡补的 folder、worktree 写在交给调用方的来源摘要里（排布各步传的是同一份摘要）", () => {
    const layout = layoutScene(shared, options);
    expect(layout.origins.map((group) => [group.origin.key, group.folder, group.worktree])).toEqual([["codex", REPO_KEY, "wt"], ["cursor", REPO_KEY, "wt"]]);
    expect(ids(layout.folders)).toEqual([REPO_ID]);
    expect(layout.nodes.filter((n) => n.kind === "git").map((n) => n.id)).toEqual([gitNodeId("wt")]);
  });

  it("每个节点的 overhang 是同一个共用对象；属性依次是 id、kind、x、y、w、h、overhang，有锚点的最后才是 anchor", () => {
    for (const layout of [layoutScene(shared, options), layoutScene(FAN_30, { area: WIDE, grid: true }), layoutScene(joinScene())]) {
      for (const n of layout.nodes) {
        expect(n.overhang, n.id).toBe(NO_OVERHANG);
        const keys = Object.keys(n);
        expect(keys.slice(0, 7), n.id).toEqual(["id", "kind", "x", "y", "w", "h", "overhang"]);
        expect(keys.slice(7), n.id).toEqual(n.anchor ? ["anchor"] : []);
      }
    }
  });

  it("结果的属性依次是 nodes、edges、bounds、origins、folders，之后才是 hidden、grid、fitAll（有才带）", () => {
    const rich = joinScene();
    const results = [layoutScene([]), layoutScene(rich, { area: WIDE, visible: new Set(["r1"]) }), layoutScene(FAN_30, { area: WIDE, grid: true })];
    for (const result of results) {
      const extra = (["hidden", "grid", "fitAll"] as const).filter((key) => key in result);
      expect(Object.keys(result)).toEqual(["nodes", "edges", "bounds", "origins", "folders", ...extra]);
    }
    expect(results.map((result) => (["hidden", "grid", "fitAll"] as const).filter((key) => key in result))).toEqual([[], ["hidden"], ["grid", "fitAll"]]);
  });

  it("没有状态漏到下一次调用：中间插一次别的排布，同样的输入仍是同样的结果，节点与来源摘要都是新的对象", () => {
    const first = layoutScene(shared, options);
    layoutScene(FAN_30, { area: { w: 400, h: 300 }, grid: true });
    const again = layoutScene(shared, options);
    expect(again).toEqual(first);
    expect(again.nodes[0]).not.toBe(first.nodes[0]);
    expect(again.origins[0]).not.toBe(first.origins[0]);
  });

  it("不改调用方的数据：输入的会话（数组、对象）全部冻住也照常排布，会话数组的先后不变", () => {
    const sessions = freeze([...joinScene(), session("c1", "C", 0)]);
    const before = ids(sessions);
    const visible = new Set(before.filter((id) => id !== "c1"));
    expect(() => layoutScene(sessions, freeze({ area: { ...WIDE }, visible, collapsed: new Set(["C"]), git: new Map([["A", "wt"]]) }))).not.toThrow();
    expect(() => layoutScene(sessions, freeze({ area: { ...WIDE }, grid: true }))).not.toThrow();
    expect(ids(sessions)).toEqual(before);
  });

  it("hidden 就是被 visible 收起的会话的节点 id；没有 visible、或没有会话被收起都不带这一项", () => {
    const sessions = joinScene();
    expect(hiddenAgentIds(sessions, undefined)).toBeUndefined();
    const visible = new Set(["r1", "b1"]);
    const hidden = hiddenAgentIds(sessions, visible);
    expect([...hidden!]).toEqual(["r2", "k", "j"].map(agentNodeId));
    expect(layoutScene(sessions, { visible }).hidden).toEqual(hidden);
    expect("hidden" in layoutScene(sessions, { visible: new Set(ids(sessions)) })).toBe(false);
  });
});

describe("buildModel：画布上有什么、谁挂在谁下面", () => {
  it("会话按创建先后排（不改调用方的数组）；根会话按来源分组，下级挂在画出来的第一个上级下面", () => {
    const sessions = [...joinScene()].reverse();
    const original = ids(sessions);
    const model = buildModel(sessions, {});
    expect(ids(model.ordered)).toEqual(["r1", "r2", "k", "j", "b1"]);
    expect(model.ordered).not.toBe(sessions);
    expect(ids(sessions)).toEqual(original);
    expect([...model.roots].map(([key, group]) => [key, ids(group)])).toEqual([["A", ["r1", "r2"]], ["B", ["b1"]]]);
    expect([...model.children].map(([parent, group]) => [parent, ids(group)])).toEqual([["r1", ["k"]], ["r2", ["j"]]]);
    expect(model.drawn.get("j")).toEqual(["r2", "k"]);
    expect(model.drawn.get("r1")).toEqual([]);
    expect(model.placedCount).toBe(5);
  });

  it("汇聚的会话排在所有上级的右边：列比最深的上级多一列，joins 记着它的全部上级（节点 id）", () => {
    const model = buildModel(joinScene(), {});
    expect(model.columnOf.get("j")).toBe(2);
    expect([...model.joins]).toEqual([[agentNodeId("j"), [agentNodeId("r2"), agentNodeId("k")]]]);
    expect(buildModel(FAN_30, {}).columnOf.size).toBe(0);
    expect(buildModel(FAN_30, {}).joins.size).toBe(0);
  });

  it("上下级互指、自己跟随自己的数据：环上的连线被去掉，这些会话都当作根", () => {
    const loop = [session("x", "A", 1, { parentSessionId: "y" }), session("y", "A", 2, { parentSessionId: "x" }), session("z", "A", 3, { parentSessionId: "z" })];
    const model = buildModel(loop, {});
    expect(ids(model.roots.get("A")!)).toEqual(["x", "y", "z"]);
    expect([...model.drawn.values()]).toEqual([[], [], []]);
    expect(model.children.size).toBe(0);
  });

  it("来源摘要按全部会话算（visible 只决定排哪些）：数量、运行数、第一次委派的时间；摘要与 order 同序", () => {
    const sessions = joinScene();
    const model = buildModel(sessions, { visible: new Set(["r1", "r2", "b1"]) });
    expect(model.placedCount).toBe(3);
    expect(model.byOrigin.get("A")).toMatchObject({ count: 4, running: 3, startedAt: sessions[0]!.createdAt });
    expect(model.order).toEqual([{ key: "A", at: sessions[0]!.createdAt }, { key: "B", at: sessions[4]!.createdAt }]);
    expect(model.origins).toEqual(model.order.map(({ key }) => model.byOrigin.get(key)));
    model.origins.forEach((group, i) => expect(group).toBe(model.byOrigin.get(model.order[i]!.key)));
  });

  it("被隐藏、没有会话画出来的来源按第一个根会话的创建时间插进先后里；只有嵌套会话或根本没有会话的 key 不凭空画卡", () => {
    const sessions = [session("a1", "A", 1), session("c1", "C", 2), session("b1", "B", 3), session("n", "N", 4, { parentSessionId: "a1" })];
    const visible = new Set(["a1", "b1"]);
    const model = buildModel(sessions, { visible, collapsed: new Set(["C", "N", "ghost"]) });
    expect(model.order.map(({ key }) => key)).toEqual(["A", "C", "B"]);
    expect(model.roots.has("C")).toBe(false);
    expect(model.byOrigin.get("C")).toMatchObject({ count: 1 });
    expect(model.origins).toHaveLength(3);
  });
});

describe("layoutDims 与 SceneTree：尺寸与经典的树", () => {
  it("取景区域窄于 720 时用紧凑的尺寸且不错位；规划式排布（grid 加 area）同样不错位", () => {
    const wide = { compact: false, originGap: NODE.originGap, childGap: NODE.childGap, originW: NODE.originW, agentW: NODE.agentW, stagger: NODE.stagger };
    expect(layoutDims({ area: { w: 719, h: 700 } })).toEqual({ compact: true, originGap: NODE.originGapCompact, childGap: NODE.childGapCompact, originW: NODE.originWCompact, agentW: NODE.agentWCompact, stagger: 0 });
    expect(layoutDims({ area: { w: 720, h: 700 } })).toEqual(wide);
    expect(layoutDims({})).toEqual(wide);
    expect(layoutDims({ grid: true })).toEqual(wide);
    expect(layoutDims({ area: WIDE, grid: true })).toEqual({ ...wide, stagger: 0 });
  });

  const family = [session("r1", "A", 1), session("r2", "A", 2), session("k1", "A", 3, { parentSessionId: "r1" }), session("k2", "A", 4, { parentSessionId: "r1" })];
  const tree = () => {
    const model = buildModel(family, {});
    return { model, tree: new SceneTree(model, layoutDims({})) };
  };

  it("placeRoots：先序摆好根会话与子孙，父卡居中于子树，兄弟卡逐个锚在上一个的下面，连线只含树里的", () => {
    const { model, tree: scene } = tree();
    const out: Sink = { nodes: [], edges: [] };
    const { rootNodes, extent } = scene.placeRoots(model.roots.get("A")!, out);
    const a = NODE.agentH;
    const g = NODE.rowGap;
    const at = (id: string): LayoutNode => out.nodes.find((n) => n.id === agentNodeId(id))!;
    expect(ids(out.nodes)).toEqual(["r1", "k1", "k2", "r2"].map(agentNodeId));
    expect(rootNodes).toEqual([at("r1"), at("r2")]);
    expect(extent).toBe(3 * a + 2 * g);
    expect([at("r1").y, at("k1").y, at("k2").y, at("r2").y]).toEqual([(a + g) / 2, 0, a + g, 2 * a + 2 * g]);
    const column = NODE.originW + NODE.originGap;
    const step = NODE.agentW + NODE.stagger + NODE.childGap;
    expect([at("r1").x, at("r2").x, at("k1").x, at("k2").x]).toEqual([column, column + NODE.stagger, column + step, column + step + NODE.stagger]);
    expect(at("r1").anchor).toBeUndefined();
    expect(at("r2").anchor).toEqual({ id: agentNodeId("r1"), dx: NODE.stagger, dy: a + g });
    expect(at("k1").anchor).toEqual({ id: agentNodeId("r1"), dx: at("k1").x - at("r1").x, dy: at("k1").y - at("r1").y });
    expect(at("k2").anchor).toEqual({ id: agentNodeId("k1"), dx: NODE.stagger, dy: a + g });
    expect(out.edges).toEqual([
      { id: "agent:r1>agent:k1", from: agentNodeId("r1"), to: agentNodeId("k1"), phase: "running" },
      { id: "agent:r1>agent:k2", from: agentNodeId("r1"), to: agentNodeId("k2"), phase: "running" },
    ]);
  });

  it("kidsOf：来源卡的子节点是它的根会话，会话的子节点是它的下级；可以当回调单独传出去用", () => {
    const { kidsOf } = tree().tree;
    expect(kidsOf(originNodeId("A"))).toEqual(["r1", "r2"].map(agentNodeId));
    expect(kidsOf(agentNodeId("r1"))).toEqual(["k1", "k2"].map(agentNodeId));
    expect([kidsOf(agentNodeId("k1")), kidsOf("没有这个节点")]).toEqual([[], []]);
  });

  it("子树高度的缓存属于每一棵树：先排一棵有子会话的，再给同 id、没有子会话的，后者按自己的高度排", () => {
    const place = (sessions: readonly SessionSummary[]): LayoutNode => {
      const model = buildModel(sessions, {});
      const out: Sink = { nodes: [], edges: [] };
      new SceneTree(model, layoutDims({})).placeRoots(model.roots.get("A")!, out);
      return out.nodes.find((n) => n.id === agentNodeId("r1"))!;
    };
    const tall = place(family);
    const alone = place([session("r1", "A", 1)]);
    expect(tall.y).toBe((NODE.agentH + NODE.rowGap) / 2);
    expect(alone.y).toBe(0);
    expect(place(family)).toEqual(tall);
  });
});

describe("workspaceClusters：来源按目录与 Git 工作树归组", () => {
  const built = (key: string, workspace?: string): Built => {
    const origin: LayoutNode = { id: originNodeId(key), kind: "origin", x: 0, y: 0, w: NODE.originW, h: NODE.originH, overhang: NO_OVERHANG };
    const summary = { origin: { key, ...(workspace ? { workspace } : {}) }, count: 1, running: 0, startedAt: "2026-01-01T00:00:00.000Z" } as unknown as OriginGroup;
    return { summary, origin, nodes: [origin], width: NODE.originW, height: NODE.originH };
  };
  const SETTINGS: WorkspaceSettings = { git: undefined, drawFolders: true, gap: 40, stackGap: 10 };
  const run = (items: Built[], settings: WorkspaceSettings = SETTINGS) => {
    const out: Sink = { nodes: [], edges: [] };
    const folders: LayoutFolder[] = [];
    return { out, folders, clusters: workspaceClusters(items, out, folders, settings) };
  };
  const gitOf = (...pairs: [string, string][]): WorkspaceSettings => ({ ...SETTINGS, git: new Map(pairs) });
  const other = "C:\\somewhere\\else";
  const linkTo = (from: string, to: string) => ({ id: `${from}>${to}`, from, to, phase: "link" });

  it("没有目录、也不在 Git 里的来源（或不画 Folder 与 Git）原样返回：每个来源一组，不往 Sink 里添任何东西", () => {
    const cases: [Built[], WorkspaceSettings][] = [
      [[built("a"), built("b")], SETTINGS],
      [[built("a", REPO), built("b", REPO)], { ...SETTINGS, drawFolders: false }],
    ];
    for (const [items, settings] of cases) {
      const { out, folders, clusters } = run(items, settings);
      expect(clusters).toEqual(items.map((item) => ({ nodes: item.nodes, width: item.width, height: item.height, lead: 0, keys: [item.summary.origin.key] })));
      expect(clusters[0]!.nodes).toBe(items[0]!.nodes);
      expect([out.nodes, out.edges, folders]).toEqual([[], [], []]);
    }
  });

  it("同一个目录的来源共用一张 Folder 卡：整组右移一列、自上而下叠放，卡落在它们中线的正中，每个来源各一条 link", () => {
    const items = [built("a", REPO), built("b", REPO)];
    const { out, folders, clusters } = run(items);
    const lead = NODE.folderW + SETTINGS.gap;
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({ keys: ["a", "b"], lead, width: lead + NODE.originW });
    expect(items.map((item) => item.origin.x)).toEqual([lead, lead]);
    expect(items[1]!.origin.y - items[0]!.origin.y).toBe(NODE.originH + SETTINGS.stackGap);
    const card = out.nodes[0]!;
    expect(ids(out.nodes)).toEqual([REPO_ID]);
    expect(card.y + card.h / 2).toBeCloseTo((items[0]!.origin.y + items[0]!.origin.h / 2 + items[1]!.origin.y + items[1]!.origin.h / 2) / 2, 6);
    expect(out.edges).toEqual([linkTo(REPO_ID, "origin:a"), linkTo(REPO_ID, "origin:b")]);
    expect(folders).toEqual([{ key: REPO_KEY, path: REPO, origins: ["a", "b"], id: REPO_ID }]);
    expect(items.map((item) => item.summary.folder)).toEqual([REPO_KEY, REPO_KEY]);
    expect(Math.min(...clusters[0]!.nodes.map((n) => n.y))).toBe(0);
  });

  it("工作树相同的来源再共用一张 Git 卡：排在 Folder 卡之后，Git 的连线排在 Folder 的连线之前，摘要里记着工作树", () => {
    const items = [built("a", REPO), built("b", REPO)];
    const { out, clusters } = run(items, gitOf(["a", "wt"], ["b", "wt"]));
    expect(clusters[0]).toMatchObject({ keys: ["a", "b"], lead: NODE.gitW + SETTINGS.gap + NODE.folderW + SETTINGS.gap });
    expect(ids(out.nodes)).toEqual([REPO_ID, gitNodeId("wt")]);
    expect(out.nodes.map((n) => n.x)).toEqual([NODE.gitW + SETTINGS.gap, 0]);
    expect(out.edges).toEqual([linkTo(gitNodeId("wt"), REPO_ID), linkTo(REPO_ID, "origin:a"), linkTo(REPO_ID, "origin:b")]);
    expect(items.map((item) => item.summary.worktree)).toEqual(["wt", "wt"]);
  });

  it("没有目录的来源由 Git 卡直接连到来源；同一目录里读数矛盾的工作树不画 Git，只画 Folder", () => {
    const direct = [built("a")];
    const first = run(direct, gitOf(["a", "wt"]));
    expect(first.clusters[0]).toMatchObject({ lead: NODE.gitW + SETTINGS.gap });
    expect([ids(first.out.nodes), first.out.edges, first.folders]).toEqual([[gitNodeId("wt")], [linkTo(gitNodeId("wt"), "origin:a")], []]);
    expect([direct[0]!.summary.folder, direct[0]!.summary.worktree]).toEqual([undefined, "wt"]);

    const items = [built("a", REPO), built("b", REPO)];
    const second = run(items, gitOf(["a", "w1"], ["b", "w2"]));
    expect(ids(second.out.nodes)).toEqual([REPO_ID]);
    expect(second.clusters[0]!.lead).toBe(NODE.folderW + SETTINGS.gap);
    expect(items.map((item) => item.summary.worktree)).toEqual([undefined, undefined]);
  });

  it("整体按第一个成员出现的先后排，同一目录的来源挨在一起；共用工作树的两个目录各有 Folder 卡，Git 卡居中于它们", () => {
    const apart = run([built("a", REPO), built("b", other), built("c", REPO)]);
    expect(apart.clusters.map((cluster) => cluster.keys)).toEqual([["a", "c"], ["b"]]);

    const items = [built("a", REPO), built("b", other)];
    const { out } = run(items, gitOf(["a", "wt"], ["b", "wt"]));
    const [upper, lower, git] = out.nodes as [LayoutNode, LayoutNode, LayoutNode];
    expect([upper.kind, lower.kind, git.kind]).toEqual(["folder", "folder", "git"]);
    expect(git.y + git.h / 2).toBeCloseTo((upper.y + upper.h / 2 + lower.y + lower.h / 2) / 2, 6);
    expect(out.edges.slice(0, 2)).toEqual([linkTo(gitNodeId("wt"), upper.id), linkTo(gitNodeId("wt"), lower.id)]);
  });
});

describe("assemble 与 arrangeScene：摆放与排列", () => {
  it("每次摆放都是一套全新的节点（经典与格点互不共用），来源摘要则是同一份；每个来源一组，先后与模型的 order 一致", () => {
    const scene = sceneOf(joinScene(), { area: WIDE });
    const first = assemble(scene);
    const second = assemble(scene);
    expect(second).toEqual(first);
    expect(second.nodes[0]).not.toBe(first.nodes[0]);
    expect(first.items.map((item) => item.summary)).toEqual(scene.model.origins);
    first.items.forEach((item, i) => expect(item.summary).toBe(scene.model.origins[i]));
    expect(first.clusters.flatMap((cluster) => cluster.keys)).toEqual(scene.model.order.map(({ key }) => key));
  });

  it("汇聚的补线排在所有来源块的连线之后（指向它的第一条仍是树里的），id 都是 上级>子会话，阶段跟着汇聚的会话", () => {
    const { edges } = assemble(sceneOf(joinScene(), { area: WIDE }));
    expect(edges.at(-1)).toEqual({ id: "agent:k>agent:j", from: agentNodeId("k"), to: agentNodeId("j"), phase: "done" });
    expect(edges.filter((edge) => edge.to === agentNodeId("j")).map((edge) => edge.id)).toEqual(["agent:r2>agent:j", "agent:k>agent:j"]);
    expect(edges.findIndex((edge) => edge.id === "origin:B>agent:b1")).toBeLessThan(edges.length - 1);
    for (const edge of edges) expect(edge.id).toBe(`${edge.from}>${edge.to}`);
  });

  it("被隐藏的来源只有一张来源卡，作为单独的一组按原来的先后放在各组之间", () => {
    const sessions = [session("a1", "A", 1), session("c1", "C", 2), session("b1", "B", 3)];
    const options = { area: WIDE, visible: new Set(["a1", "b1"]), collapsed: new Set(["C"]) };
    const { items, clusters } = assemble(sceneOf(sessions, options));
    expect(items.map((item) => item.summary.origin.key)).toEqual(["A", "C", "B"]);
    expect(items[1]!.nodes).toEqual([items[1]!.origin]);
    expect(clusters.map((cluster) => cluster.keys)).toEqual([["A"], ["C"], ["B"]]);
    expect(clusters[1]).toMatchObject({ lead: 0, width: items[1]!.width, height: items[1]!.height });
  });

  it("不规划（没有 grid、没有 area、没有来源）时沿用经典的一套：chosen 就是 base，没有 grid 与 fitAll", () => {
    for (const options of [{ area: WIDE }, { grid: true }, { area: WIDE, grid: true }]) {
      const scene = sceneOf(options.area && options.grid ? [] : FAN_30, options);
      const base = assemble(scene);
      expect(arrangeScene(scene, base)).toEqual({ chosen: base, usedGrid: false, fitAll: false });
      expect(arrangeScene(scene, base).chosen).toBe(base);
    }
  });

  it("规划式排布：换用格点就换成另摆的一套（chosen 不是 base）并带 grid；放不下 100% 才带 fitAll，且与 layoutScene 的结果一致", () => {
    const options = { area: WIDE, grid: true };
    const scene = sceneOf(FAN_30, options);
    const base = assemble(scene);
    const result = arrangeScene(scene, base);
    expect(result.usedGrid).toBe(true);
    expect(result.chosen).not.toBe(base);
    expect(result.fitAll).toBe(true);
    const layout = layoutScene(FAN_30, options);
    expect([layout.grid, layout.fitAll]).toEqual([true, true]);
    expect(layout.nodes).toEqual(result.chosen.nodes);
    expect(layoutScene(FAN_30.slice(0, 6), options).fitAll).toBeUndefined();
  });

  it("缩放恰好是 100% 算放得下：取景区域的宽正好等于经典排法的外框宽时仍是原来的树，不带 grid 与 fitAll（判据是 scale < 1，不含等于）", () => {
    const nested = [session("r", "A", 1), session("c", "A", 2, { parentSessionId: "r" })];
    const { bounds } = layoutScene(nested, { grid: true, area: { w: 4000, h: 4000 } });
    const layout = layoutScene(nested, { grid: true, area: { w: bounds.w, h: bounds.h * 2 } });
    expect(layout.bounds).toEqual(bounds);
    expect([layout.grid, layout.fitAll]).toEqual([undefined, undefined]);
  });
});
