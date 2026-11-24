import { describe, expect, it } from "vitest";
import { agentNodeId, boundsOf, fitArea, fitScale, folderNodeId, gitNodeId, isCompact, layoutScene, NODE, originNodeId, type LayoutNode, type SceneLayout } from "./layout";
import { centerOf, foldersOf, gitsOf, groupOf, inDir, linksOf, node, overlapsOf, REPO, REPO_ID, REPO_KEY, session, sessionsOfThreeOrigins } from "./layout.fixtures";

describe("layoutScene · Git 节点", () => {
  const wide = { w: 1200, h: 700 };
  const three = [session("a", "codex", 1), session("b", "codex", 2), session("c", "codex", 3)];
  /** 每个来源各在自己的工作树里（来源 key → 工作树 key，这里取 `repo-<来源 key>`）。 */
  const alone = (...keys: string[]): ReadonlyMap<string, string> => new Map(keys.map((key) => [key, `repo-${key}`]));
  const withGit = (...keys: string[]) => ({ area: wide, git: alone(...keys) });

  it("在来源节点左边，同高居中，用静态连线从 Git 的右侧接到来源的左侧", () => {
    const layout = layoutScene(three, withGit("codex"));
    const git = node(layout, gitNodeId("repo-codex"));
    const origin = node(layout, originNodeId("codex"));

    expect(git.kind).toBe("git");
    expect(git.x).toBe(0);
    expect(origin.x).toBe(NODE.gitW + NODE.originGap);
    expect(git.y + git.h / 2).toBeCloseTo(origin.y + origin.h / 2, 6);
    expect(layout.edges.find((edge) => edge.to === originNodeId("codex"))).toEqual({
      id: "git:repo-codex>origin:codex",
      from: gitNodeId("repo-codex"),
      to: originNodeId("codex"),
      phase: "link",
    });
  });

  it("整组向右让出一列：来源与会话之间的版式不变，只是整体右移 Git 节点那一列的宽度", () => {
    const plain = layoutScene(three, { area: wide });
    const linked = layoutScene(three, withGit("codex"));
    const shift = NODE.gitW + NODE.originGap;
    for (const original of plain.nodes) {
      const moved = node(linked, original.id);
      expect({ x: moved.x - shift, y: moved.y }, original.id).toEqual({ x: original.x, y: original.y });
    }
    expect(linked.bounds.x).toBe(0);
    expect(linked.bounds.w).toBe(plain.bounds.w + shift);
  });

  it("只有工作目录在 Git 仓库里的来源才有；没有的来源与布局都不受影响", () => {
    const sessions = [session("a", "codex", 1), session("b", "cursor", 2)];
    const layout = layoutScene(sessions, { area: { w: 1800, h: 900 }, git: alone("codex") });
    expect(layout.nodes.filter((n) => n.kind === "git").map((n) => n.id)).toEqual([gitNodeId("repo-codex")]);
    expect(layout.edges.some((edge) => edge.to === originNodeId("cursor"))).toBe(false);
    expect(layout.edges.filter((edge) => edge.phase === "link")).toHaveLength(1);
    expect(layout.origins.map((group) => [group.origin.key, group.worktree])).toEqual([["codex", "repo-codex"], ["cursor", undefined]]);
    // 表里有、但这次没有任何会话的来源，不凭空生成节点。
    expect(layoutScene(sessions, { area: wide, git: alone("ghost") }).nodes.some((n) => n.kind === "git")).toBe(false);
  });

  it("紧凑的取景区域（宿主侧栏）不画 Git 节点，布局与没有 Git 时完全一样", () => {
    const narrow = { w: 480, h: 700 };
    const plain = layoutScene(three, { area: narrow });
    const linked = layoutScene(three, { area: narrow, git: alone("codex") });
    expect(linked).toEqual(plain);
    expect(linked.origins.every((group) => group.worktree === undefined)).toBe(true);
  });

  it("不给 Git 表时布局与以前完全一样；320px 侧栏的取景比例也不受影响", () => {
    expect(layoutScene(three, { area: wide, git: new Map() })).toEqual(layoutScene(three, { area: wide }));
    const area = fitArea(320, 720);
    const layout = layoutScene([session("a", "codex", 1)], { area, git: alone("codex") });
    expect(layout.nodes.some((n) => n.kind === "git")).toBe(false);
    expect(fitScale(layout.bounds, area)).toBeGreaterThanOrEqual(0.72);
  });

  it("取景范围包含 Git 节点；多个来源并排时节点互不重叠，无论哪几个来源有 Git", () => {
    const sessions = sessionsOfThreeOrigins;
    for (const git of [["codex"], ["cursor", "console"], ["codex", "cursor", "console"]]) {
      for (const area of [undefined, { w: 1168, h: 656 }, { w: 1800, h: 900 }]) {
        const layout = layoutScene(sessions, { ...(area ? { area } : {}), git: alone(...git) });
        const box = boundsOf(layout.nodes);
        expect(layout.bounds).toEqual(box);
        for (const key of git) {
          const g = node(layout, gitNodeId(`repo-${key}`));
          expect(g.x).toBeGreaterThanOrEqual(box.x);
        }
        expect(overlapsOf(layout), `${JSON.stringify(git)} @ ${JSON.stringify(area)}`).toEqual([]);
      }
    }
  });

  describe("同一列里的来源节点共用一条竖轴", () => {
    const sessions = sessionsOfThreeOrigins;
    /**
     * 多列要比单列的取景比例高出 2% 才会被选中。本组夹具单列为 880 × 856（比例 0.766），两列为 1544 × 416：
     * 画布宽 1168 时两列只有 0.756，仍选单列；宽 1400 时两列为 0.907，才会并排。
     * 卡片尺寸再变时，改这里的宽度，而不是去碰断言。
     */
    const wide = { w: 1400, h: 656 };

    it("单列时：有 Git 节点的组与没有的组，来源节点在同一个 x 上，没有的那些组在左边留空", () => {
      const layout = layoutScene(sessions, { git: alone("codex") });
      const shift = NODE.gitW + NODE.originGap;
      expect(new Set(layout.nodes.filter((n) => n.kind === "origin").map((n) => n.x))).toEqual(new Set([shift]));
      // 没有 Git 节点的组只是空着，不凭空多出节点或连线。
      expect(layout.nodes.filter((n) => n.kind === "git")).toHaveLength(1);
      expect(layout.edges.filter((edge) => edge.phase === "link")).toHaveLength(1);
      expect(layout.bounds.x).toBe(0);
    });

    it("多列时：每一列各自对齐；整列都没有 Git 节点的那一列不留空位", () => {
      const layout = layoutScene(sessions, { area: wide, git: alone("codex") });
      const origins = layout.nodes.filter((n) => n.kind === "origin");
      const xs = [...new Set(origins.map((n) => n.x))].sort((a, b) => a - b);
      expect(xs.length).toBeGreaterThan(1);
      // 同一列的来源节点 x 相同，不同的列至少隔着一整个“来源 + 会话”的宽度。
      for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(NODE.originW + NODE.originGap + NODE.agentW);

      const codex = node(layout, originNodeId("codex"));
      const other = origins.filter((n) => n.x !== codex.x).sort((a, b) => a.x - b.x)[0]!;
      const leftColumnRight = Math.max(...layout.nodes.filter((n) => n.x < other.x).map((n) => n.x + n.w));
      expect(other.x - leftColumnRight).toBe(NODE.clusterGap);
    });

    it("没有任何 Git 节点时与以前一样：来源节点贴着各自的列左缘", () => {
      expect(layoutScene(sessions, { area: wide, git: new Map() })).toEqual(layoutScene(sessions, { area: wide }));
    });
  });

  it("Git 节点记着自己挂在来源节点旁边：锚点与偏移正好把它放回布局里的位置", () => {
    const layout = layoutScene(three, withGit("codex"));
    const git = node(layout, gitNodeId("repo-codex"));
    const origin = node(layout, originNodeId("codex"));
    expect(git.anchor?.id).toBe(origin.id);
    expect({ x: origin.x + git.anchor!.dx, y: origin.y + git.anchor!.dy }).toEqual({ x: git.x, y: git.y });
  });
});

describe("layoutScene · 共用同一张 Git 节点", () => {
  const wide = { w: 1200, h: 700 };
  const shift = NODE.gitW + NODE.originGap;
  /** 三个 Main Agent 各有一个会话；全部指向同一个工作树。 */
  const three = [session("a1", "codex", 1), session("b1", "cursor", 2), session("c1", "pi", 3)];
  const together = new Map([["codex", "repo"], ["cursor", "repo"], ["pi", "repo"]]);

  it("三个来源指向同一个工作树：只有一张 Git 节点，三条连线，每个来源各一条", () => {
    const layout = layoutScene(three, { area: wide, git: together });
    expect(gitsOf(layout).map((n) => n.id)).toEqual([gitNodeId("repo")]);
    expect(linksOf(layout).map((edge) => edge.id)).toEqual(["git:repo>origin:codex", "git:repo>origin:cursor", "git:repo>origin:pi"]);
    expect(new Set(linksOf(layout).map((edge) => edge.from))).toEqual(new Set([gitNodeId("repo")]));
    expect(linksOf(layout).map((edge) => edge.to)).toEqual(["codex", "cursor", "pi"].map(originNodeId));
    expect(layout.origins.map((group) => group.worktree)).toEqual(["repo", "repo", "repo"]);
  });

  it("没有重复的节点与连线：id 各不相同，每个来源只有一条进线", () => {
    const layout = layoutScene(three, { area: wide, git: together });
    expect(new Set(layout.nodes.map((n) => n.id)).size).toBe(layout.nodes.length);
    expect(new Set(layout.edges.map((edge) => edge.id)).size).toBe(layout.edges.length);
    for (const key of ["codex", "cursor", "pi"]) expect(layout.edges.filter((edge) => edge.to === originNodeId(key))).toHaveLength(1);
    // 一个来源有好几个根会话，也不会因此多出节点或连线。
    const many = layoutScene([...three, session("a2", "codex", 4), session("a3", "codex", 5)], { area: wide, git: together });
    expect(gitsOf(many)).toHaveLength(1);
    expect(linksOf(many)).toHaveLength(3);
    expect(new Set(many.edges.map((edge) => edge.id)).size).toBe(many.edges.length);
  });

  it("Git 节点在最左；来源节点同在一列、自上而下叠放；Git 节点落在第一个与最后一个来源的中线之间", () => {
    const layout = layoutScene(three, { area: wide, git: together });
    const git = node(layout, gitNodeId("repo"));
    const origins = ["codex", "cursor", "pi"].map((key) => node(layout, originNodeId(key)));

    expect(git.x).toBe(0);
    for (const origin of origins) expect(origin.x).toBe(shift);
    origins.forEach((origin, index) => {
      if (index > 0) expect(origin.y - origins[index - 1]!.y).toBe(NODE.agentH + NODE.groupGap);
    });
    expect(centerOf(git)).toBeCloseTo((centerOf(origins[0]!) + centerOf(origins[2]!)) / 2, 6);
    // 每条线都是从左向右：Git 的右缘在各来源左缘的左边，线上下对称地散开。
    for (const origin of origins) expect(git.x + git.w).toBeLessThan(origin.x);
    expect(Math.abs(centerOf(origins[0]!) - centerOf(git))).toBeCloseTo(Math.abs(centerOf(origins[2]!) - centerOf(git)), 6);
  });

  it("来源的会话数不同、高矮不一：Git 节点仍落在首尾两个来源中线的正中，所有节点互不重叠", () => {
    const sessions = [
      session("a1", "codex", 1), session("a2", "codex", 2), session("a3", "codex", 3),
      session("b1", "cursor", 4),
      session("c1", "pi", 5), session("c2", "pi", 6),
    ];
    for (const area of [undefined, wide, { w: 1800, h: 900 }]) {
      const layout = layoutScene(sessions, { ...(area ? { area } : {}), git: together });
      const git = node(layout, gitNodeId("repo"));
      const first = node(layout, originNodeId("codex"));
      const last = node(layout, originNodeId("pi"));
      expect(centerOf(git)).toBeCloseTo((centerOf(first) + centerOf(last)) / 2, 6);
      expect(git.x).toBe(0);
      expect(overlapsOf(layout)).toEqual([]);
      expect(layout.bounds).toEqual(boundsOf(layout.nodes));
      // 整体的上缘仍是 0：Git 节点没有冒出布局的范围。
      expect(layout.bounds.y).toBe(0);
    }
  });

  it("同一个工作树的来源紧挨着：创建的先后被别的来源隔开，也排在一起", () => {
    const sessions = [session("a1", "codex", 1), session("x1", "console", 2), session("b1", "cursor", 3)];
    const layout = layoutScene(sessions, { git: new Map([["codex", "repo"], ["cursor", "repo"]]) });
    const codex = node(layout, originNodeId("codex"));
    const cursor = node(layout, originNodeId("cursor"));
    const other = node(layout, originNodeId("console"));
    expect(cursor.y - codex.y).toBe(NODE.agentH + NODE.groupGap);
    expect(other.y - cursor.y).toBe(NODE.agentH + NODE.groupGap);
    // 没有 Git 的来源与它们共用同一条竖轴（左边留空），不凭空多出节点与连线。
    expect(other.x).toBe(shift);
    expect(layout.edges.some((edge) => edge.to === originNodeId("console"))).toBe(false);
    expect(linksOf(layout)).toHaveLength(2);
  });

  it("卡片的 id 只取决于工作树，不随来源的先后、增减而变", () => {
    const idsOf = (sessions: ReturnType<typeof session>[], links: ReadonlyMap<string, string> = together): string[] =>
      gitsOf(layoutScene(sessions, { area: wide, git: links })).map((n) => n.id);
    const expected = [gitNodeId("repo")];
    expect(idsOf(three)).toEqual(expected);
    // 谁先出现都一样：换一种创建顺序、输入数组倒过来。
    expect(idsOf([session("a1", "codex", 3), session("b1", "cursor", 2), session("c1", "pi", 1)])).toEqual(expected);
    expect(idsOf([...three].reverse())).toEqual(expected);
    // 排在最前的来源走了，或后来又多了一个来源：卡片还是同一张。
    expect(idsOf(three.slice(1))).toEqual(expected);
    expect(idsOf(three.slice(2))).toEqual(expected);
    expect(idsOf([...three, session("d1", "claude", 4)], new Map([...together, ["claude", "repo"]]))).toEqual(expected);
  });

  it("独立的工作树各有各的卡片与连线：共用的只是同一个工作树里的来源", () => {
    const sessions = [session("a1", "codex", 1), session("b1", "cursor", 2), session("c1", "pi", 3), session("d1", "claude", 4)];
    const links = new Map([["codex", "repo-a"], ["cursor", "repo-b"], ["pi", "repo-a"], ["claude", "repo-b"]]);
    const layout = layoutScene(sessions, { area: wide, git: links });
    expect(gitsOf(layout).map((n) => n.id).sort()).toEqual([gitNodeId("repo-a"), gitNodeId("repo-b")]);
    expect(linksOf(layout).map((edge) => edge.id).sort()).toEqual([
      "git:repo-a>origin:codex", "git:repo-a>origin:pi", "git:repo-b>origin:claude", "git:repo-b>origin:cursor",
    ]);
    // 每个工作树的来源叠在一起，Git 节点在自己那几个来源的左边、中线之间，两组不互相穿插。
    for (const [repo, members] of [["repo-a", ["codex", "pi"]], ["repo-b", ["cursor", "claude"]]] as const) {
      const git = node(layout, gitNodeId(repo));
      const origins = members.map((key) => node(layout, originNodeId(key)));
      expect(centerOf(git)).toBeCloseTo((centerOf(origins[0]!) + centerOf(origins[1]!)) / 2, 6);
      for (const origin of origins) expect(origin.x - (git.x + git.w)).toBe(NODE.originGap);
    }
    const [aTop, aBottom] = ["codex", "pi"].map((key) => node(layout, originNodeId(key)).y) as [number, number];
    const [bTop, bBottom] = ["cursor", "claude"].map((key) => node(layout, originNodeId(key)).y) as [number, number];
    expect(aBottom < bTop || bBottom < aTop, "两个工作树的来源不穿插").toBe(true);
    expect(Math.abs(aBottom - aTop)).toBe(NODE.agentH + NODE.groupGap);
    expect(Math.abs(bBottom - bTop)).toBe(NODE.agentH + NODE.groupGap);
    expect(overlapsOf(layout)).toEqual([]);
  });

  it("只有嵌套会话、没有来源节点的来源不会凭空多出连线", () => {
    // cursor 的会话是 codex 会话的子会话：画布上没有 cursor 的来源节点。
    const sessions = [session("p", "codex", 1), session("k", "cursor", 2, { parentSessionId: "p" })];
    const layout = layoutScene(sessions, { area: wide, git: new Map([["codex", "repo"], ["cursor", "repo"]]) });
    expect(layout.nodes.some((n) => n.id === originNodeId("cursor"))).toBe(false);
    expect(gitsOf(layout).map((n) => n.id)).toEqual([gitNodeId("repo")]);
    expect(linksOf(layout).map((edge) => edge.id)).toEqual(["git:repo>origin:codex"]);
    // 指向这个工作树的来源一个都不可见时，卡片也不画。
    const hidden = layoutScene(sessions, { area: wide, git: new Map([["cursor", "repo"]]) });
    expect(gitsOf(hidden)).toEqual([]);
    expect(linksOf(hidden)).toEqual([]);
  });

  it("紧凑的取景区域（宿主侧栏）里共用的来源也不画 Git 节点，布局与没有 Git 时完全一样", () => {
    const narrow = { w: 480, h: 700 };
    const plain = layoutScene(three, { area: narrow });
    const linked = layoutScene(three, { area: narrow, git: together });
    expect(linked).toEqual(plain);
    expect(gitsOf(linked)).toEqual([]);
    expect(linked.origins.every((group) => group.worktree === undefined)).toBe(true);
  });

  it("多列摆放时共用一张卡的来源仍是一个整体：同在一列、Git 节点在它们左边，不会被拆到别的列", () => {
    // 两个工作树各有两个来源。宽 1800、高 400 的区域里单列只能缩到可读下限（0.72），并排两列才不用缩小，所以会选两列。
    const sessions = [
      session("a1", "codex", 1), session("b1", "cursor", 2), session("c1", "pi", 3), session("d1", "claude", 4),
    ];
    const links = new Map([["codex", "repo-a"], ["cursor", "repo-a"], ["pi", "repo-b"], ["claude", "repo-b"]]);
    const layout = layoutScene(sessions, { area: { w: 1800, h: 400 }, git: links });
    const gits = gitsOf(layout);
    expect(gits).toHaveLength(2);
    expect(new Set(gits.map((git) => git.x)).size, "两个整体并排成两列").toBe(2);
    for (const [repo, members] of [["repo-a", ["codex", "cursor"]], ["repo-b", ["pi", "claude"]]] as const) {
      const git = node(layout, gitNodeId(repo));
      const origins = members.map((key) => node(layout, originNodeId(key)));
      expect(new Set(origins.map((origin) => origin.x)).size, `${repo} 的来源同在一列`).toBe(1);
      expect(origins[0]!.x - git.x).toBe(shift);
    }
    expect(overlapsOf(layout)).toEqual([]);
    expect(layout.bounds).toEqual(boundsOf(layout.nodes));
    expect(layout.bounds.x).toBe(0);
  });

  it("取景范围包含共用的 Git 节点；无论怎样共用、取景区域多大，节点都互不重叠", () => {
    const sessions = [
      session("a1", "codex", 1), session("a2", "codex", 2), session("a3", "codex", 3),
      session("b1", "cursor", 4), session("b2", "cursor", 5),
      session("c1", "console", 6),
      session("d1", "pi", 7),
    ];
    const shapes: ReadonlyMap<string, string>[] = [
      new Map([["codex", "r"], ["cursor", "r"], ["console", "r"], ["pi", "r"]]),
      new Map([["codex", "r"], ["console", "r"]]),
      new Map([["cursor", "x"], ["pi", "x"], ["codex", "y"]]),
      new Map([["codex", "r"], ["cursor", "r"], ["console", "s"], ["pi", "s"]]),
    ];
    for (const git of shapes) {
      for (const area of [undefined, { w: 1168, h: 656 }, { w: 1400, h: 656 }, { w: 1800, h: 900 }, { w: 480, h: 700 }]) {
        const layout = layoutScene(sessions, { ...(area ? { area } : {}), git });
        const compact = isCompact(area);
        // 夹具里的来源都有可见的来源节点：卡片数就是不同的工作树数；紧凑模式一张都不画。
        expect(gitsOf(layout).length).toBe(compact ? 0 : new Set(git.values()).size);
        expect(layout.bounds).toEqual(boundsOf(layout.nodes));
        for (const g of gitsOf(layout)) expect(g.x).toBeGreaterThanOrEqual(layout.bounds.x);
        expect(overlapsOf(layout), JSON.stringify([...git])).toEqual([]);
        expect(new Set(layout.edges.map((edge) => edge.id)).size).toBe(layout.edges.length);
        // 每个来源节点最多一条进线；没有 Git 的来源没有。
        for (const origin of layout.nodes.filter((n) => n.kind === "origin")) {
          const incoming = layout.edges.filter((edge) => edge.to === origin.id);
          expect(incoming.length).toBe(compact || !git.has(origin.id.slice("origin:".length)) ? 0 : 1);
        }
      }
    }
  });

  it("锚点取排在最前的来源：偏移正好把 Git 节点放回布局里的位置", () => {
    const layout = layoutScene(three, { area: wide, git: together });
    const git = node(layout, gitNodeId("repo"));
    const first = node(layout, originNodeId("codex"));
    expect(git.anchor?.id).toBe(first.id);
    expect({ x: first.x + git.anchor!.dx, y: first.y + git.anchor!.dy }).toEqual({ x: git.x, y: git.y });
    // 排在最前的来源换了，锚点跟着换；卡片的 id 不变。
    const without = layoutScene(three.slice(1), { area: wide, git: together });
    expect(node(without, gitNodeId("repo")).anchor?.id).toBe(originNodeId("cursor"));
  });

  it("只有一个来源指向工作树时与以前的版式完全一样：Git 节点与来源同高、整组右移一列", () => {
    const sessions = [session("a1", "codex", 1), session("a2", "codex", 2), session("b1", "cursor", 3)];
    const linked = layoutScene(sessions, { area: wide, git: new Map([["codex", "repo-a"], ["cursor", "repo-b"]]) });
    const plain = layoutScene(sessions, { area: wide });
    for (const [key, repo] of [["codex", "repo-a"], ["cursor", "repo-b"]] as const) {
      const git = node(linked, gitNodeId(repo));
      const origin = node(linked, originNodeId(key));
      expect(centerOf(git)).toBeCloseTo(centerOf(origin), 6);
      expect(git.anchor).toEqual({ id: origin.id, dx: -shift, dy: (NODE.originH - NODE.gitH) / 2 });
    }
    // 其余节点与没有 Git 时相比只差整体右移的那一列。
    for (const original of plain.nodes) {
      const moved = node(linked, original.id);
      expect(moved.y, original.id).toBe(original.y);
      expect(moved.x - original.x, original.id).toBe(shift);
    }
  });
});

describe("layoutScene · Git → Folder → 来源", () => {
  const wide = { w: 1800, h: 900 };
  const column = NODE.folderW + NODE.originGap;
  const GIT = gitNodeId("repo");
  const fromTo = (layout: SceneLayout, edge: { from: string; to: string }): [number, number] => {
    const from = node(layout, edge.from);
    const to = node(layout, edge.to);
    return [from.y + from.h / 2, to.y + to.h / 2];
  };

  it("三者从左到右：Git 工作树 → Folder → 来源；Git 连到 Folder，Folder 连到来源，没有 Git 直接连到来源的线", () => {
    const layout = layoutScene([inDir("a", "codex", 1, REPO)], { area: wide, git: new Map([["codex", "repo"]]) });
    const git = node(layout, GIT);
    const folder = node(layout, REPO_ID);
    const origin = node(layout, originNodeId("codex"));

    expect([git.x, folder.x, origin.x]).toEqual([0, column, 2 * column]);
    expect(layout.edges.filter((edge) => edge.phase === "link")).toEqual([
      { id: `${GIT}>${REPO_ID}`, from: GIT, to: REPO_ID, phase: "link" },
      { id: `${REPO_ID}>origin:codex`, from: REPO_ID, to: origin.id, phase: "link" },
    ]);
    // 端口都落在卡片的竖直中线上：一对一的链上三张卡中线重合，每条线是一条水平线。
    expect([centerOf(git), centerOf(folder)]).toEqual([centerOf(origin), centerOf(origin)]);
    for (const edge of layout.edges.filter((e) => e.phase === "link")) {
      const [out, into] = fromTo(layout, edge);
      expect(out, edge.id).toBe(into);
    }
    // 同一行里的卡片上下边缘对齐，会话卡也与它们同高。
    const agent = node(layout, agentNodeId("a"));
    expect([git.y, folder.y, origin.y]).toEqual([agent.y, agent.y, agent.y]);

    const group = groupOf(layout, "codex");
    expect(group).toMatchObject({ folder: REPO_KEY, worktree: "repo" });
    expect(layout.folders).toEqual([{ id: REPO_ID, key: REPO_KEY, path: REPO, origins: ["codex"] }]);
  });

  it("目录不在 Git 仓库里：Folder 直接连到来源，没有任何连线指向 Folder，也没有 Git 节点", () => {
    const layout = layoutScene([inDir("a", "codex", 1, REPO)], { area: wide });
    expect(layout.nodes.some((n) => n.kind === "git")).toBe(false);
    expect(layout.edges.some((edge) => edge.to === REPO_ID)).toBe(false);
    expect(linksOf(layout).map((edge) => edge.id)).toEqual([`${REPO_ID}>origin:codex`]);
  });

  it("几个 Folder 在同一个工作树里：共用一张 Git 节点，Git 连到每个 Folder，落在它们中线的正中", () => {
    const sub = `${REPO}\\packages\\web`;
    const subKey = "c:/users/alice/desktop/ensemble/packages/web";
    const layout = layoutScene(
      [inDir("a", "codex", 1, REPO), inDir("b", "cursor", 2, sub), inDir("c", "pi", 3, REPO)],
      { area: wide, git: new Map([["codex", "repo"], ["cursor", "repo"], ["pi", "repo"]]) },
    );
    expect(layout.nodes.filter((n) => n.kind === "git").map((n) => n.id)).toEqual([GIT]);
    expect(foldersOf(layout).map((n) => n.id).sort()).toEqual([REPO_ID, folderNodeId(subKey)].sort());
    expect(linksOf(layout).map((edge) => edge.id).sort()).toEqual([
      `${GIT}>${REPO_ID}`, `${GIT}>${folderNodeId(subKey)}`,
      `${REPO_ID}>origin:codex`, `${REPO_ID}>origin:pi`, `${folderNodeId(subKey)}>origin:cursor`,
    ].sort());
    const git = node(layout, GIT);
    const folders = foldersOf(layout).sort((a, b) => a.y - b.y);
    expect(folders).toHaveLength(2);
    expect(new Set(folders.map((f) => f.x))).toEqual(new Set([column]));
    expect(centerOf(git)).toBeCloseTo((centerOf(folders[0]!) + centerOf(folders[1]!)) / 2, 6);
    expect(git.x).toBe(0);
    // 同一个目录的两个来源挨在一起（创建先后被 sub 隔开也一样）。
    const codex = node(layout, originNodeId("codex"));
    const pi = node(layout, originNodeId("pi"));
    const cursor = node(layout, originNodeId("cursor"));
    expect(Math.abs(codex.y - pi.y)).toBe(NODE.agentH + NODE.groupGap);
    expect(cursor.y < Math.min(codex.y, pi.y) || cursor.y > Math.max(codex.y, pi.y)).toBe(true);
    expect(new Set([codex.x, pi.x, cursor.x])).toEqual(new Set([2 * column]));
    expect(layout.origins.map((group) => group.worktree)).toEqual(["repo", "repo", "repo"]);
    expect(overlapsOf(layout)).toEqual([]);
  });

  it("一个 Folder 有几个来源、另一个只有一个，同在一个工作树里：Folder 各自居中于自己的来源，Git 居中于两个 Folder", () => {
    const sub = `${REPO}\\sub`;
    const sessions = [
      inDir("a", "o1", 1, REPO), inDir("b", "o2", 2, REPO), inDir("c", "o3", 3, REPO),
      inDir("d", "o4", 4, sub), inDir("e", "o4", 5, sub),
    ];
    const git = new Map([["o1", "repo"], ["o2", "repo"], ["o3", "repo"], ["o4", "repo"]]);
    for (const area of [undefined, wide]) {
      const layout = layoutScene(sessions, { ...(area ? { area } : {}), git });
      const big = node(layout, REPO_ID);
      const small = node(layout, folderNodeId("c:/users/alice/desktop/ensemble/sub"));
      const [o1, o3, o4] = ["o1", "o3", "o4"].map((key) => node(layout, originNodeId(key))) as [LayoutNode, LayoutNode, LayoutNode];
      expect(centerOf(big)).toBeCloseTo((centerOf(o1) + centerOf(o3)) / 2, 6);
      expect(centerOf(small)).toBeCloseTo(centerOf(o4), 6);
      expect(centerOf(node(layout, GIT))).toBeCloseTo((centerOf(big) + centerOf(small)) / 2, 6);
      expect(overlapsOf(layout)).toEqual([]);
      expect(layout.bounds.y).toBe(0);
    }
  });

  it("同一列里 Folder 共用一条竖轴、来源共用一条竖轴：不在 Git 里的 Folder 与 Git 里的 Folder 同列，Git 列只在需要它的整体里留空", () => {
    const sessions = [inDir("a", "o1", 1, REPO), inDir("b", "o2", 2, "C:\\plain"), inDir("c", "o3", 3)];
    const layout = layoutScene(sessions, { git: new Map([["o1", "repo"]]) });
    const inRepo = node(layout, REPO_ID);
    const plain = node(layout, folderNodeId("c:/plain"));
    expect(inRepo.x).toBe(column);
    expect(plain.x).toBe(column);
    expect(node(layout, GIT).x).toBe(0);
    for (const key of ["o1", "o2", "o3"]) expect(node(layout, originNodeId(key)).x).toBe(2 * column);
    // 只有在 Git 里的 Folder 有进线；其余没有，也不凭空多出 Git 节点或连线。
    expect(layout.edges.some((edge) => edge.to === inRepo.id)).toBe(true);
    expect(layout.edges.some((edge) => edge.to === plain.id)).toBe(false);
    expect(layout.nodes.filter((n) => n.kind === "git")).toHaveLength(1);
    expect(linksOf(layout).map((edge) => edge.id).sort()).toEqual([`${GIT}>${REPO_ID}`, `${REPO_ID}>origin:o1`, `${folderNodeId("c:/plain")}>origin:o2`].sort());
    expect(layout.bounds.x).toBe(0);
  });

  // 一张 Folder 卡在哪个工作树里是 lib/git 的 groupGit 按读数得出的结论：读数矛盾时它不给这些来源任何工作树。
  // 布局拿到的表若仍然对不上（同一张卡下的来源指向不同的工作树，或有的没给），既不替数据挑一个（曾经取字典序最小的），
  // 也不替它补全，只是不画 Git 归属：Folder 卡不会因此拆成两张，也没有凭空的 Git 节点与连线。
  it("同一个目录的来源指向的工作树对不上（指向不同的工作树，或只有一部分给了）：不画 Git 归属，Folder 仍连到每个来源，布局与没有 Git 数据时完全一样，与来源的先后无关", () => {
    const sessions = [inDir("a", "o1", 1, REPO), inDir("b", "o2", 2, REPO)];
    const plain = layoutScene(sessions, { area: wide });
    for (const git of [new Map([["o1", "w2"], ["o2", "w1"]]), new Map([["o2", "w1"], ["o1", "w2"]]), new Map([["o1", "repo"]])]) {
      const layout = layoutScene(sessions, { area: wide, git });
      expect(layout.nodes.some((n) => n.kind === "git")).toBe(false);
      expect(linksOf(layout).map((edge) => edge.id).sort()).toEqual([`${REPO_ID}>origin:o1`, `${REPO_ID}>origin:o2`].sort());
      expect(layout.edges.some((edge) => edge.to === REPO_ID)).toBe(false);
      expect(layout.origins.map((group) => group.worktree)).toEqual([undefined, undefined]);
      expect(layout).toEqual(plain);
    }
  });

  it("冲突只涉及这一张 Folder：别的目录照常接在共用的 Git 节点上，没有凭空多出的节点与连线，互不重叠", () => {
    const other = "C:\\other";
    const third = "C:\\third";
    const sessions = [inDir("a", "o1", 1, REPO), inDir("b", "o2", 2, REPO), inDir("c", "o3", 3, other), inDir("d", "o4", 4, third)];
    const layout = layoutScene(sessions, { area: wide, git: new Map([["o1", "w1"], ["o2", "w2"], ["o3", "w1"], ["o4", "w1"]]) });
    const [otherId, thirdId] = [folderNodeId("c:/other"), folderNodeId("c:/third")];
    expect(layout.nodes.filter((n) => n.kind === "git").map((n) => n.id)).toEqual([gitNodeId("w1")]);
    expect(linksOf(layout).map((edge) => edge.id).sort()).toEqual([
      `${gitNodeId("w1")}>${otherId}`, `${gitNodeId("w1")}>${thirdId}`,
      `${REPO_ID}>origin:o1`, `${REPO_ID}>origin:o2`, `${otherId}>origin:o3`, `${thirdId}>origin:o4`,
    ].sort());
    expect(layout.edges.some((edge) => edge.to === REPO_ID)).toBe(false);
    expect(layout.origins.map((group) => [group.origin.key, group.worktree])).toEqual([["o1", undefined], ["o2", undefined], ["o3", "w1"], ["o4", "w1"]]);
    expect(new Set(layout.nodes.map((n) => n.id)).size).toBe(layout.nodes.length);
    expect(new Set(layout.edges.map((edge) => edge.id)).size).toBe(layout.edges.length);
    expect(overlapsOf(layout)).toEqual([]);
  });

  it("工作树表里有、来源却没有工作目录：Git 直接连到这个来源，与 Folder 并列，仍互不重叠", () => {
    const layout = layoutScene([inDir("a", "o1", 1, REPO), inDir("b", "o2", 2)], { area: wide, git: new Map([["o1", "repo"], ["o2", "repo"]]) });
    expect(linksOf(layout).map((edge) => edge.id).sort()).toEqual([`${GIT}>${REPO_ID}`, `${GIT}>origin:o2`, `${REPO_ID}>origin:o1`].sort());
    const git = node(layout, GIT);
    expect(centerOf(git)).toBeCloseTo((centerOf(node(layout, REPO_ID)) + centerOf(node(layout, originNodeId("o2")))) / 2, 6);
    expect(node(layout, originNodeId("o1")).x).toBe(node(layout, originNodeId("o2")).x);
    expect(groupOf(layout, "o2")).toMatchObject({ worktree: "repo" });
    expect(groupOf(layout, "o2").folder).toBeUndefined();
    expect(overlapsOf(layout)).toEqual([]);
  });

  it("紧凑的取景区域里 Git 与 Folder 都不画：来源没有入口，也没有任何 link", () => {
    const sessions = [inDir("s1", "a", 1, REPO), inDir("s2", "b", 2, REPO), inDir("s3", "c", 3, "C:\\other")];
    const layout = layoutScene(sessions, { area: { w: 480, h: 700 }, git: new Map([["a", "repo"], ["b", "repo"], ["c", "repo"]]) });
    expect(layout.nodes.every((n) => n.kind === "origin" || n.kind === "agent")).toBe(true);
    expect(linksOf(layout)).toEqual([]);
    expect(layout.folders).toEqual([]);
  });

  it("锚点：Folder 挂在它的第一个来源旁，Git 挂在它的第一个下游旁；锚点节点排在被挂节点之前，偏移正好放回布局里的位置", () => {
    const sub = `${REPO}\\sub`;
    const layout = layoutScene(
      [inDir("a", "o1", 1, REPO), inDir("b", "o2", 2, REPO), inDir("c", "o3", 3, sub)],
      { area: wide, git: new Map([["o1", "repo"], ["o2", "repo"], ["o3", "repo"]]) },
    );
    const git = node(layout, GIT);
    const folder = node(layout, REPO_ID);
    const first = node(layout, originNodeId("o1"));
    expect(folder.anchor).toEqual({ id: first.id, dx: folder.x - first.x, dy: folder.y - first.y });
    expect({ x: first.x + folder.anchor!.dx, y: first.y + folder.anchor!.dy }).toEqual({ x: folder.x, y: folder.y });
    expect(folder.anchor!.dx).toBe(-column);

    // Git 挂在排在最前的 Folder 上（不是更远的来源）。
    const top = foldersOf(layout).sort((a, b) => a.y - b.y)[0]!;
    expect(git.anchor?.id).toBe(top.id);
    expect({ x: top.x + git.anchor!.dx, y: top.y + git.anchor!.dy }).toEqual({ x: git.x, y: git.y });

    // 引擎按 nodes 的顺序逐个处理：每个锚点节点都排在挂着它的节点前面。
    const index = (id: string): number => layout.nodes.findIndex((n) => n.id === id);
    for (const n of layout.nodes) if (n.anchor) expect(index(n.anchor.id), `${n.id} 的锚点 ${n.anchor.id}`).toBeLessThan(index(n.id));
    expect(index(first.id)).toBeLessThan(index(folder.id));
    expect(index(folder.id)).toBeLessThan(index(git.id));
  });

  it("Git 节点的 id 与有没有 Folder 无关：已保存的 Git 位置照旧对得上", () => {
    const git = new Map([["codex", "repo"]]);
    const before = layoutScene([session("a", "codex", 1)], { area: wide, git });
    const after = layoutScene([inDir("a", "codex", 1, REPO)], { area: wide, git });
    expect(before.nodes.filter((n) => n.kind === "git").map((n) => n.id)).toEqual([GIT]);
    expect(after.nodes.filter((n) => n.kind === "git").map((n) => n.id)).toEqual([GIT]);
    // 来源、会话、Git 节点的 id 一个都没变；多出来的只有 Folder。
    expect(after.nodes.map((n) => n.id).filter((id) => !id.startsWith("folder:")).sort()).toEqual(before.nodes.map((n) => n.id).sort());
  });

  it("取景范围包含 Folder 与 Git；无论怎样共用、取景区域多大，节点都互不重叠，连线 id 唯一，每个来源最多一条进线", () => {
    const A = "C:\\work\\a";
    const B = "C:\\work\\b";
    const sessions = [
      inDir("a1", "o1", 1, A), inDir("a2", "o1", 2, A), inDir("a3", "o1", 3, A),
      inDir("b1", "o2", 4, B), inDir("b2", "o2", 5, B),
      inDir("c1", "o3", 6),
      inDir("d1", "o4", 7, A),
      inDir("e1", "o5", 8, "C:\\work\\c"),
    ];
    const shapes: ReadonlyMap<string, string>[] = [
      new Map(),
      new Map([["o1", "r"], ["o2", "r"], ["o4", "r"]]),
      new Map([["o1", "x"], ["o4", "x"], ["o2", "y"]]),
      new Map([["o1", "r"], ["o2", "s"], ["o3", "s"], ["o4", "r"], ["o5", "s"]]),
    ];
    for (const git of shapes) {
      for (const area of [undefined, { w: 1168, h: 656 }, { w: 1400, h: 656 }, { w: 1800, h: 900 }, { w: 480, h: 700 }]) {
        const layout = layoutScene(sessions, { ...(area ? { area } : {}), git });
        const where = `${JSON.stringify([...git])} @ ${JSON.stringify(area)}`;
        expect(layout.bounds).toEqual(boundsOf(layout.nodes));
        expect(overlapsOf(layout), where).toEqual([]);
        expect(new Set(layout.nodes.map((n) => n.id)).size).toBe(layout.nodes.length);
        expect(new Set(layout.edges.map((edge) => edge.id)).size).toBe(layout.edges.length);
        for (const n of layout.nodes) expect(n.x, `${n.id} ${where}`).toBeGreaterThanOrEqual(layout.bounds.x);
        for (const origin of layout.nodes.filter((n) => n.kind === "origin")) {
          expect(layout.edges.filter((edge) => edge.to === origin.id).length, `${origin.id} ${where}`).toBeLessThanOrEqual(1);
        }
        // 每条 link 的两端都是画出来的节点，并且是从左向右。
        for (const edge of linksOf(layout)) {
          const from = node(layout, edge.from);
          const to = node(layout, edge.to);
          expect(from.x + from.w, edge.id).toBeLessThan(to.x);
        }
        if (isCompact(area)) expect(layout.nodes.every((n) => n.kind === "origin" || n.kind === "agent")).toBe(true);
      }
    }
  });
});
