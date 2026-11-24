import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@shared/types";
import { boundsOf, FIT_FLOOR, fitArea, fitScale, folderNodeId, isCompact, layoutScene, NODE, originNodeId, type LayoutNode } from "./layout";
import { centerOf, foldersOf, groupOf, inDir, linksOf, node, overlapsOf, REPO, REPO_ID, REPO_KEY, session } from "./layout.fixtures";

describe("layoutScene · Folder 节点", () => {
  const wide = { w: 1400, h: 800 };
  const shift = NODE.folderW + NODE.originGap;
  const three = [inDir("a1", "codex", 1, REPO), inDir("b1", "cursor", 2, REPO), inDir("c1", "pi", 3, REPO)];

  it("来源的工作目录画成它左边的 Folder 节点：同高居中，用静态连线从 Folder 右侧接到来源左侧", () => {
    const layout = layoutScene([inDir("a", "codex", 1, REPO), inDir("b", "codex", 2, REPO)], { area: wide });
    const folder = node(layout, REPO_ID);
    const origin = node(layout, originNodeId("codex"));

    expect(folder.kind).toBe("folder");
    expect([folder.w, folder.h]).toEqual([NODE.folderW, NODE.folderH]);
    expect(folder.x).toBe(0);
    expect(origin.x).toBe(shift);
    expect(centerOf(folder)).toBeCloseTo(centerOf(origin), 6);
    // 没有 Git 节点接进来：没有任何连线指向 Folder，它的左边不会亮端口。
    expect(layout.edges.some((edge) => edge.to === folder.id)).toBe(false);
    expect(layout.edges.find((edge) => edge.to === origin.id)).toEqual({ id: `${REPO_ID}>origin:codex`, from: REPO_ID, to: origin.id, phase: "link" });

    // 页面画 Folder 卡用的数据：目录、用它的来源（只算画出了来源节点的）。
    expect(layout.folders).toEqual([{ id: REPO_ID, key: REPO_KEY, path: REPO, origins: ["codex"] }]);
    const group = groupOf(layout, "codex");
    expect(group.folder).toBe(REPO_KEY);
    expect(group.worktree).toBeUndefined();
  });

  it("整组向右让出一列：来源与会话之间的版式不变，只是整体右移 Folder 那一列的宽度", () => {
    const plain = layoutScene([session("a", "codex", 1), session("b", "codex", 2)], { area: wide });
    const linked = layoutScene([inDir("a", "codex", 1, REPO), inDir("b", "codex", 2, REPO)], { area: wide });
    for (const original of plain.nodes) {
      const moved = node(linked, original.id);
      expect({ x: moved.x - shift, y: moved.y }, original.id).toEqual({ x: original.x, y: original.y });
    }
    expect(linked.bounds.x).toBe(0);
    expect(linked.bounds.w).toBe(plain.bounds.w + shift);
  });

  it("没有工作目录的来源（例如从控制台发起）没有 Folder 节点，也没有入口与连线", () => {
    for (const workspace of [undefined, "", "   "]) {
      const layout = layoutScene([inDir("a", "console", 1, workspace)], { area: wide });
      expect(foldersOf(layout), JSON.stringify(workspace)).toEqual([]);
      expect(layout.folders).toEqual([]);
      expect(linksOf(layout)).toEqual([]);
      expect(layout.edges.some((edge) => edge.to === originNodeId("console"))).toBe(false);
      const group = groupOf(layout, "console");
      expect(group.folder).toBeUndefined();
    }
    // 与有目录的来源同在一列：来源节点共用一条竖轴（没有 Folder 的那一组左边留空），不凭空多出节点或连线。
    const layout = layoutScene([inDir("a", "codex", 1, REPO), inDir("b", "console", 2)]);
    expect(node(layout, originNodeId("console")).x).toBe(shift);
    expect(node(layout, originNodeId("codex")).x).toBe(shift);
    expect(foldersOf(layout)).toHaveLength(1);
    expect(linksOf(layout)).toHaveLength(1);
    expect(layout.edges.some((edge) => edge.to === originNodeId("console"))).toBe(false);
  });

  it("一个来源的工作目录取最近一次带目录的委派：更早的、没有目录的委派不改变它，更晚的没有目录的委派也不会把它抹掉", () => {
    const OTHER = "C:\\work\\other";
    const withSource = (id: string, order: number, workspace: string, workspaceSource: "mcp-roots" | "delegate-cwd"): SessionSummary =>
      session(id, "cursor", order, { origin: { key: "cursor", workspace, workspaceSource } as SessionSummary["origin"] });
    const sessions = [
      withSource("old", 1, OTHER, "delegate-cwd"),
      inDir("later-without", "cursor", 5), // 最近的一次没有带目录（这一次没传 cwd，宿主也没报告）
      withSource("newest-with", 3, REPO, "mcp-roots"),
    ];
    for (const input of [sessions, [...sessions].reverse()]) {
      const layout = layoutScene(input, { area: wide });
      expect(layout.folders).toEqual([{ id: REPO_ID, key: REPO_KEY, path: REPO, origins: ["cursor"] }]);
      // 来源卡拿到的是同一次委派的整条来源信息：目录与它的来历一起走，不会是新目录配旧来历。
      expect(groupOf(layout, "cursor").origin).toMatchObject({ workspace: REPO, workspaceSource: "mcp-roots" });
    }
  });

  it("同一个目录的不同写法是同一张 Folder 节点：盘符与目录名大小写、正反斜杠、结尾与重复的分隔符、扩展长度前缀", () => {
    const spellings = [REPO, "c:/users/alice/desktop/ensemble", "C:/Users/alice/Desktop/Ensemble/", "C:\\USERS\\ALICE\\DESKTOP\\ENSEMBLE\\\\", "\\\\?\\C:\\Users\\alice\\Desktop\\Ensemble"];
    const sessions = spellings.map((dir, index) => inDir(`s${index}`, `host${index}`, index + 1, dir));
    for (const input of [sessions, [...sessions].reverse()]) {
      const layout = layoutScene(input, { area: wide });
      expect(foldersOf(layout).map((n) => n.id)).toEqual([REPO_ID]);
      expect(linksOf(layout).map((edge) => edge.id).sort()).toEqual(spellings.map((_, index) => `${REPO_ID}>origin:host${index}`).sort());
      expect(layout.folders).toHaveLength(1);
      expect(layout.folders[0]!.origins).toEqual(spellings.map((_, index) => `host${index}`));
      // 卡片上写的是同一种写法，与来源的先后无关：结尾没有分隔符的、字典序最小的一种。
      expect(layout.folders[0]!.path).toBe(REPO);
    }
  });

  it("不同的目录是不同的节点：父子目录、名字只差一个后缀、不同盘符；POSIX 区分大小写，Windows 不区分", () => {
    const dirs = ["C:\\repo", "C:\\repo\\sub", "C:\\repo2", "D:\\repo", "/home/me/Repo", "/home/me/repo"];
    const layout = layoutScene(dirs.map((dir, index) => inDir(`s${index}`, `o${index}`, index + 1, dir)), { area: wide });
    expect(foldersOf(layout).map((n) => n.id).sort()).toEqual(
      ["folder:c:/repo", "folder:c:/repo/sub", "folder:c:/repo2", "folder:d:/repo", "folder:/home/me/Repo", "folder:/home/me/repo"].sort(),
    );
    expect(linksOf(layout)).toHaveLength(6);
    // Windows 路径只差大小写：仍是一个。
    const same = layoutScene([inDir("a", "x", 1, "C:\\Repo"), inDir("b", "y", 2, "c:\\REPO")], { area: wide });
    expect(foldersOf(same)).toHaveLength(1);
  });

  it("节点 id 只取决于规范化后的目录，不随来源的先后、增减而变", () => {
    const a = inDir("a1", "codex", 1, REPO);
    const b = inDir("b1", "cursor", 2, "c:/users/alice/desktop/ensemble/");
    const c = inDir("c1", "pi", 3, REPO);
    const idsOf = (sessions: SessionSummary[]): string[] => foldersOf(layoutScene(sessions, { area: wide })).map((n) => n.id);
    expect(idsOf([a, b, c])).toEqual([REPO_ID]);
    expect(idsOf([c, b, a])).toEqual([REPO_ID]);
    // 换一种创建顺序、排在最前的来源走了、后来又多了一个来源：卡片还是同一张。
    expect(idsOf([inDir("a1", "codex", 3, REPO), inDir("b1", "cursor", 2, REPO), inDir("c1", "pi", 1, REPO)])).toEqual([REPO_ID]);
    expect(idsOf([b, c])).toEqual([REPO_ID]);
    expect(idsOf([c])).toEqual([REPO_ID]);
    expect(idsOf([a, b, c, inDir("d1", "claude", 4, REPO)])).toEqual([REPO_ID]);
  });

  it("几个来源用同一个目录：只有一张 Folder 节点，每个来源各一条连线；来源同在一列、叠放，Folder 落在首尾两个来源的正中", () => {
    const layout = layoutScene(three, { area: wide });
    const folder = node(layout, REPO_ID);
    const origins = ["codex", "cursor", "pi"].map((key) => node(layout, originNodeId(key)));

    expect(foldersOf(layout)).toHaveLength(1);
    expect(linksOf(layout).map((edge) => edge.id)).toEqual(["codex", "cursor", "pi"].map((key) => `${REPO_ID}>origin:${key}`));
    expect(layout.folders).toEqual([{ id: REPO_ID, key: REPO_KEY, path: REPO, origins: ["codex", "cursor", "pi"] }]);
    for (const origin of origins) {
      expect(origin.x).toBe(shift);
      expect(layout.edges.filter((edge) => edge.to === origin.id)).toHaveLength(1);
      expect(folder.x + folder.w).toBeLessThan(origin.x);
    }
    origins.forEach((origin, index) => {
      if (index > 0) expect(origin.y - origins[index - 1]!.y).toBe(NODE.agentH + NODE.groupGap);
    });
    expect(centerOf(folder)).toBeCloseTo((centerOf(origins[0]!) + centerOf(origins[2]!)) / 2, 6);
    expect(Math.abs(centerOf(origins[0]!) - centerOf(folder))).toBeCloseTo(Math.abs(centerOf(origins[2]!) - centerOf(folder)), 6);
    expect(new Set(layout.nodes.map((n) => n.id)).size).toBe(layout.nodes.length);
    expect(new Set(layout.edges.map((edge) => edge.id)).size).toBe(layout.edges.length);
    expect(overlapsOf(layout)).toEqual([]);
  });

  it("来源的会话数不同、高矮不一：Folder 仍落在首尾两个来源中线的正中，所有节点互不重叠", () => {
    const sessions = [
      inDir("a1", "codex", 1, REPO), inDir("a2", "codex", 2, REPO), inDir("a3", "codex", 3, REPO),
      inDir("b1", "cursor", 4, REPO),
      inDir("c1", "pi", 5, REPO), inDir("c2", "pi", 6, REPO),
    ];
    for (const area of [undefined, wide, { w: 1800, h: 900 }]) {
      const layout = layoutScene(sessions, { ...(area ? { area } : {}) });
      const folder = node(layout, REPO_ID);
      expect(centerOf(folder)).toBeCloseTo((centerOf(node(layout, originNodeId("codex"))) + centerOf(node(layout, originNodeId("pi")))) / 2, 6);
      expect(folder.x).toBe(0);
      expect(overlapsOf(layout)).toEqual([]);
      expect(layout.bounds).toEqual(boundsOf(layout.nodes));
      // 整体的上缘仍是 0：Folder 节点没有冒出布局的范围。
      expect(layout.bounds.y).toBe(0);
    }
  });

  it("同一个目录的来源紧挨着：创建的先后被别的目录、没有目录的来源隔开，也排在一起", () => {
    const sessions = [inDir("a1", "codex", 1, "C:\\work\\a"), inDir("x1", "console", 2), inDir("b1", "cursor", 3, "C:\\work\\a"), inDir("d1", "pi", 4, "C:\\work\\b")];
    const layout = layoutScene(sessions);
    const [codex, cursor, console_, pi] = ["codex", "cursor", "console", "pi"].map((key) => node(layout, originNodeId(key))) as [LayoutNode, LayoutNode, LayoutNode, LayoutNode];
    expect(cursor.y - codex.y).toBe(NODE.agentH + NODE.groupGap);
    expect(console_.y - cursor.y).toBe(NODE.agentH + NODE.groupGap);
    expect(pi.y - console_.y).toBe(NODE.agentH + NODE.groupGap);
    expect(foldersOf(layout)).toHaveLength(2);
    expect(overlapsOf(layout)).toEqual([]);
  });

  it("多个来源、多个目录混合：每个目录的来源叠在一起，Folder 在各自来源的正中，互不穿插、互不重叠", () => {
    const A = "C:\\work\\a";
    const B = "C:\\work\\b";
    const C = "C:\\work\\c";
    const sessions = [
      inDir("s1", "o1", 1, A), inDir("s2", "o1", 2, A),
      inDir("s3", "o2", 3, B),
      inDir("s4", "o3", 4, A), inDir("s5", "o3", 5, A), inDir("s6", "o3", 6, A),
      inDir("s7", "o4", 7, B),
      inDir("s8", "o5", 8),
      inDir("s9", "o6", 9, C), inDir("s10", "o6", 10, C),
    ];
    const dirOf: Record<string, string | undefined> = { o1: A, o2: B, o3: A, o4: B, o5: undefined, o6: C };
    for (const area of [undefined, { w: 1168, h: 656 }, { w: 1400, h: 656 }, { w: 1800, h: 900 }]) {
      const layout = layoutScene(sessions, { ...(area ? { area } : {}) });
      expect(foldersOf(layout)).toHaveLength(3);
      expect(layout.bounds).toEqual(boundsOf(layout.nodes));
      expect(layout.bounds.x).toBeGreaterThanOrEqual(0);
      expect(new Set(layout.edges.map((edge) => edge.id)).size).toBe(layout.edges.length);
      for (const dir of [A, B, C]) {
        const folder = node(layout, folderNodeId(dir.toLowerCase().replaceAll("\\", "/")));
        const members = Object.keys(dirOf).filter((key) => dirOf[key] === dir).map((key) => node(layout, originNodeId(key)));
        const tops = members.map((n) => n.y).sort((x, y) => x - y);
        const first = members.find((n) => n.y === tops[0])!;
        const last = members.find((n) => n.y === tops.at(-1))!;
        expect(centerOf(folder), `${dir} @ ${JSON.stringify(area)}`).toBeCloseTo((centerOf(first) + centerOf(last)) / 2, 6);
        expect(new Set(members.map((n) => n.x)).size, `${dir} 的来源同在一列`).toBe(1);
        for (const member of members) expect(layout.edges.filter((edge) => edge.to === member.id)).toHaveLength(1);
      }
      expect(layout.edges.filter((edge) => edge.to === originNodeId("o5"))).toHaveLength(0);
      expect(overlapsOf(layout), JSON.stringify(area)).toEqual([]);
    }
    // 单列时：同一个目录的来源在竖直方向上是连续的一段，不被别的目录穿插。
    const column = layoutScene(sessions);
    const order = column.nodes.filter((n) => n.kind === "origin").sort((a, b) => a.y - b.y).map((n) => dirOf[n.id.slice("origin:".length)] ?? "none");
    expect(order.join(",").replace(/(\w:\\work\\\w|none)(,\1)+/g, "$1")).toBe([A, B, "none", C].join(","));
  });

  it("紧凑的取景区域（宿主侧栏）不画 Folder 节点：来源卡自己保留目录行，布局与没有工作目录时完全一样", () => {
    const narrow = { w: 480, h: 700 };
    const withDirs = [inDir("a1", "codex", 1, REPO), inDir("b1", "cursor", 2, REPO), inDir("c1", "pi", 3, "C:\\other")];
    const withoutDirs = [session("a1", "codex", 1), session("b1", "cursor", 2), session("c1", "pi", 3)];
    const linked = layoutScene(withDirs, { area: narrow, git: new Map([["codex", "repo"], ["cursor", "repo"]]) });
    const plain = layoutScene(withoutDirs, { area: narrow });
    expect(linked.nodes).toEqual(plain.nodes);
    expect(linked.edges).toEqual(plain.edges);
    expect(linked.bounds).toEqual(plain.bounds);
    expect(linked.folders).toEqual([]);
    expect(foldersOf(linked)).toEqual([]);
    for (const group of linked.origins) {
      expect(group.folder).toBeUndefined();
      expect(group.worktree).toBeUndefined();
    }
    // 没有 Folder、没有 Git：没有任何连线指向来源（edges 已与 plain 逐项相等）。
    for (const origin of linked.nodes.filter((n) => n.kind === "origin")) expect(linked.edges.some((edge) => edge.to === origin.id)).toBe(false);
  });

  it("来源卡显示目录行当且仅当它的 Folder 节点没有画出来：布局给出的 folder 与节点一一对应，没有目录的来源没有目录行可写", () => {
    const sessions = [inDir("a1", "codex", 1, REPO), inDir("b1", "cursor", 2, REPO), inDir("c1", "console", 3), inDir("d1", "pi", 4, "C:\\other")];
    for (const area of [undefined, wide, { w: 480, h: 700 }]) {
      const layout = layoutScene(sessions, { ...(area ? { area } : {}) });
      const compact = isCompact(area);
      for (const group of layout.origins) {
        const drawn = group.folder !== undefined;
        // 画出来了就真有这个节点，并且这个来源连在它上面。
        if (drawn) {
          expect(layout.nodes.some((n) => n.id === folderNodeId(group.folder!))).toBe(true);
          expect(layout.edges.some((edge) => edge.from === folderNodeId(group.folder!) && edge.to === originNodeId(group.origin.key))).toBe(true);
        }
        const hasWorkspace = Boolean(group.origin.workspace);
        const rowOnCard = hasWorkspace && !drawn;
        expect(drawn, `${group.origin.key} @ ${JSON.stringify(area)}`).toBe(hasWorkspace && !compact);
        // 有目录就总有一处写着：紧凑时写在来源卡上，否则写在 Folder 节点上。
        expect(rowOnCard || drawn || !hasWorkspace).toBe(true);
      }
      // 每个画出来的 Folder 节点至少被一个来源用着，页面上不会有没人用的卡。
      for (const folder of layout.folders) expect(layout.origins.some((group) => group.folder === folder.key)).toBe(true);
      expect(layout.folders.map((f) => f.id).sort()).toEqual(foldersOf(layout).map((n) => n.id).sort());
    }
  });

  it("320px 侧栏的取景比例不受影响；普通窗口（1280 宽）放得下一整行 Git → Folder → 来源 → 会话，不缩小", () => {
    const side = fitArea(320, 720);
    const narrow = layoutScene([inDir("a", "codex", 1, REPO)], { area: side, git: new Map([["codex", "r"]]) });
    expect(fitScale(narrow.bounds, side)).toBeGreaterThanOrEqual(FIT_FLOOR);

    const area = fitArea(1280, 800);
    const row = layoutScene([inDir("a", "codex", 1, REPO)], { area, git: new Map([["codex", "r"]]) });
    expect(row.bounds.w).toBeLessThanOrEqual(area.w);
    expect(fitScale(row.bounds, area)).toBe(1);
  });
});
