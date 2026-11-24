import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SessionSummary } from "@shared/types";
import {
  agentNodeId,
  boundsOf,
  FIT_ALL_MIN_ZOOM,
  FIT_FLOOR,
  fitArea,
  fitCamera,
  fitScale,
  isCompact,
  layoutScene,
  MIN_ZOOM,
  NODE,
  originNodeId,
  type LayoutNode,
} from "./layout";
import { cellsFor } from "./layout-cells";
import { node, overlapsOf, session, sessionsOfThreeOrigins } from "./layout.fixtures";

describe("NODE 与 scene.css 的节点尺寸", () => {
  const css = readFileSync("src/web/styles/scene.css", "utf8");
  const sizeOf = (selector: string): { w: number; h?: number } => {
    const escaped = selector.replace(/[.[\]="-]/g, "\\$&");
    const rule = new RegExp(`^${escaped} \\{([^}]*)\\}`, "m").exec(css);
    if (!rule) throw new Error(`scene.css 里找不到 ${selector} 的尺寸规则`);
    const width = /width:\s*(\d+)px/.exec(rule[1]!);
    const height = /height:\s*(\d+)px/.exec(rule[1]!);
    if (!width) throw new Error(`${selector} 没有写宽度`);
    return { w: Number(width[1]), ...(height ? { h: Number(height[1]) } : {}) };
  };

  // 管线的接口坐标由 NODE 推出（高度的一半），卡片真实高度来自 CSS：两处差一点，管线就会落在卡片中线之外。
  it("四种卡片的宽高与 CSS 一致", () => {
    expect(sizeOf(".agent")).toEqual({ w: NODE.agentW, h: NODE.agentH });
    expect(sizeOf(".origin")).toEqual({ w: NODE.originW, h: NODE.originH });
    expect(sizeOf(".git")).toEqual({ w: NODE.gitW, h: NODE.gitH });
    expect(sizeOf(".folder")).toEqual({ w: NODE.folderW, h: NODE.folderH });
  });

  it("来源、Git、Folder 三种卡片同宽同高：上下摆在一起时共用同一条列轴、同一条中线", () => {
    expect([NODE.gitW, NODE.folderW]).toEqual([NODE.originW, NODE.originW]);
    expect([NODE.gitH, NODE.folderH, NODE.agentH]).toEqual([NODE.originH, NODE.originH, NODE.originH]);
  });

  it("紧凑模式的宽度与 CSS 一致", () => {
    expect(sizeOf(".scene[data-compact] .agent").w).toBe(NODE.agentWCompact);
    expect(sizeOf(".scene[data-compact] .origin").w).toBe(NODE.originWCompact);
  });
});

describe("isCompact", () => {
  it("取景宽度低于 720 才算紧凑；还没量出取景区域时不算", () => {
    expect(isCompact(undefined)).toBe(false);
    expect(isCompact({ w: 719, h: 600 })).toBe(true);
    expect(isCompact({ w: 720, h: 600 })).toBe(false);
  });

  it("与布局用的是同一个判定：紧凑时来源卡取紧凑宽度", () => {
    const narrow = layoutScene([session("a", "codex", 1)], { area: { w: 400, h: 600 } });
    const wide = layoutScene([session("a", "codex", 1)], { area: { w: 1200, h: 600 } });
    expect(node(narrow, originNodeId("codex")).w).toBe(NODE.originWCompact);
    expect(node(wide, originNodeId("codex")).w).toBe(NODE.originW);
  });
});

describe("layoutScene · 单个发起端", () => {
  it("发起端在最左，会话在右侧纵向堆叠，发起端相对它们垂直居中", () => {
    const layout = layoutScene([session("a", "codex", 1), session("b", "codex", 2), session("c", "codex", 3)]);
    const [a, b, c] = ["a", "b", "c"].map((id) => node(layout, agentNodeId(id)));
    const origin = node(layout, originNodeId("codex"));

    expect(origin.x).toBe(0);
    expect(a!.x).toBe(NODE.originW + NODE.originGap);
    expect(b!.y - a!.y).toBe(NODE.agentH + NODE.rowGap);
    expect(c!.y - b!.y).toBe(NODE.agentH + NODE.rowGap);
    expect(origin.y + origin.h / 2).toBeCloseTo((a!.y + (c!.y + c!.h)) / 2, 6);
    expect(layout.edges.map((edge) => edge.id)).toEqual(["origin:codex>agent:a", "origin:codex>agent:b", "origin:codex>agent:c"]);
  });

  it("同一列里奇数位的会话向右错开", () => {
    const layout = layoutScene([session("a", "codex", 1), session("b", "codex", 2), session("c", "codex", 3)]);
    const [a, b, c] = ["a", "b", "c"].map((id) => node(layout, agentNodeId(id)));
    expect(b!.x - a!.x).toBe(NODE.stagger);
    expect(c!.x).toBe(a!.x);
  });

  it("连线从发起端右侧接入会话左侧", () => {
    const layout = layoutScene([session("a", "codex", 1)]);
    const origin = node(layout, originNodeId("codex"));
    const agent = node(layout, agentNodeId("a"));
    // 连线由发起端指向会话，会话整个在发起端右缘的右边（端口落在两端卡片的竖直中点，由引擎按矩形算）。
    expect(layout.edges.filter((edge) => edge.to === agentNodeId("a"))).toEqual([expect.objectContaining({ from: originNodeId("codex"), to: agentNodeId("a") })]);
    expect(agent.x).toBeGreaterThanOrEqual(origin.x + origin.w);
    // 发起端比单个会话更高，整组下移后上缘仍是 0。
    expect(origin.y).toBeGreaterThanOrEqual(0);
    expect(layout.bounds.y).toBe(0);
  });

  it("子会话排到下一列，并且父会话相对它的子树垂直居中", () => {
    const layout = layoutScene([
      session("p", "codex", 1),
      session("k1", "codex", 2, { parentSessionId: "p" }),
      session("k2", "codex", 3, { parentSessionId: "p" }),
    ]);
    const parent = node(layout, agentNodeId("p"));
    const k1 = node(layout, agentNodeId("k1"));
    const k2 = node(layout, agentNodeId("k2"));

    expect(k1.x).toBe(parent.x + NODE.agentW + NODE.stagger + NODE.childGap);
    expect(k2.x - k1.x).toBe(NODE.stagger);
    expect(parent.y + parent.h / 2).toBeCloseTo((k1.y + (k2.y + k2.h)) / 2, 6);
    expect(layout.edges.some((edge) => edge.id === "agent:p>agent:k1")).toBe(true);
    // 子会话不再直接连在发起端上。
    expect(layout.edges.some((edge) => edge.id === "origin:codex>agent:k1")).toBe(false);
  });

  it("父子互指的脏数据不会让布局卡住，每个会话仍然有位置", () => {
    const layout = layoutScene([
      session("x", "codex", 1, { parentSessionId: "y" }),
      session("y", "codex", 2, { parentSessionId: "x" }),
      session("self", "codex", 3, { parentSessionId: "self" }),
    ]);
    for (const id of ["x", "y", "self"]) expect(node(layout, agentNodeId(id))).toBeTruthy();
    expect(new Set(layout.nodes.map((n) => n.id)).size).toBe(layout.nodes.length);
  });

  it("每个发起端记下它第一次委派的时间：取所有委派会话里最早的，嵌套会话也算，与输入顺序无关", () => {
    const layout = layoutScene([
      session("late", "codex", 9),
      session("early", "codex", 3),
      session("kid", "codex", 1, { parentSessionId: "early" }),
      session("other", "cursor", 7),
    ]);
    const startedAt = (key: string): string | undefined => layout.origins.find((group) => group.origin.key === key)?.startedAt;
    expect(startedAt("codex")).toBe(new Date(Date.UTC(2026, 0, 1, 0, 0, 1)).toISOString());
    expect(startedAt("cursor")).toBe(new Date(Date.UTC(2026, 0, 1, 0, 0, 7)).toISOString());
  });

  it("发起端的对话标题取最近一次委派时读到的：中途改名以后一次为准，之前没读到不影响", () => {
    const withTitle = (id: string, origin: string, order: number, hostTitle?: string, extra: Partial<SessionSummary> = {}): SessionSummary => {
      const base = session(id, origin, order, extra);
      return { ...base, origin: { key: origin, ...(hostTitle ? { hostTitle } : {}) } } as SessionSummary;
    };
    const layout = layoutScene([
      withTitle("newest", "codex", 9, "改过的新标题"),
      withTitle("first", "codex", 1), // 当时还没起名
      withTitle("middle", "codex", 5, "旧标题"),
      withTitle("kept", "cursor", 2, "只有一个"),
      withTitle("none", "pi", 3),
    ]);
    const titleOf = (key: string): string | undefined => layout.origins.find((group) => group.origin.key === key)?.hostTitle;
    expect(titleOf("codex")).toBe("改过的新标题");
    expect(titleOf("cursor")).toBe("只有一个");
    expect(titleOf("pi")).toBeUndefined();
  });

  it("没有会话时是空布局", () => {
    expect(layoutScene([])).toEqual({ nodes: [], edges: [], bounds: { x: 0, y: 0, w: 0, h: 0 }, origins: [], folders: [] });
  });

  it("取景范围把左右接口伸出的部分算进去", () => {
    const layout = layoutScene([session("a", "codex", 1)]);
    expect(layout.bounds.x).toBe(0);
    expect(layout.bounds.w).toBe(NODE.originW + NODE.originGap + NODE.agentW);

    const lone: LayoutNode = { id: "agent:x", kind: "agent", x: 100, y: 20, w: 200, h: 110, overhang: { left: 10, right: 27 } };
    expect(boundsOf([lone])).toEqual({ x: 90, y: 20, w: 237, h: 110 });
  });
});

describe("layoutScene · 多个发起端", () => {
  const sessions = sessionsOfThreeOrigins;

  it("不给取景区域时单列纵向排开，组与组之间留出 groupGap", () => {
    const layout = layoutScene(sessions);
    const a3 = node(layout, agentNodeId("a3"));
    const b1 = node(layout, agentNodeId("b1"));
    expect(b1.y - (a3.y + a3.h)).toBe(NODE.groupGap);
    expect(new Set(layout.nodes.filter((n) => n.kind === "origin").map((n) => n.x))).toEqual(new Set([0]));
  });

  it("宽而矮的取景区域会让各组并排，内容缩得比单列少", () => {
    const single = layoutScene(sessions);
    const wide = { w: 1168, h: 656 };
    const packed = layoutScene(sessions, { area: wide });

    const columns = new Set(packed.nodes.filter((n) => n.kind === "origin").map((n) => n.x));
    expect(columns.size).toBeGreaterThan(1);
    expect(fitScale(packed.bounds, wide)).toBeGreaterThan(fitScale(single.bounds, wide));
    // 并排的列之间不重叠。
    const origins = packed.nodes.filter((n) => n.kind === "origin").sort((l, r) => l.x - r.x);
    const second = origins.find((n) => n.x > 0)!;
    const firstColumnRight = Math.max(...packed.nodes.filter((n) => n.x < second.x).map((n) => n.x + n.w));
    expect(second.x - firstColumnRight).toBeGreaterThanOrEqual(NODE.clusterGap);
  });

  it("窄的取景区域（宿主侧栏）保持单列，并收紧水平间距", () => {
    const narrow = { w: 480, h: 700 };
    const layout = layoutScene(sessions, { area: narrow });
    expect(new Set(layout.nodes.filter((n) => n.kind === "origin").map((n) => n.x))).toEqual(new Set([0]));
    expect(node(layout, agentNodeId("a1")).x).toBe(NODE.originWCompact + NODE.originGapCompact);
    // 窄画布上取消错位：同一列的会话左缘对齐。
    expect(node(layout, agentNodeId("a2")).x).toBe(node(layout, agentNodeId("a1")).x);
  });

  it("320px 侧栏的单层会话保持可读的取景比例", () => {
    const area = fitArea(320, 720);
    const layout = layoutScene([session("a", "codex", 1)], { area });
    expect(fitScale(layout.bounds, area)).toBeGreaterThanOrEqual(0.72);
  });

  it("在放得下的区域里新增一组，不会让已有的组换位置（新组排在末尾）", () => {
    // 区域足够大时两种摆法都不需要缩小，列数不会因为多了一组而改变。
    const area = { w: 1800, h: 1200 };
    const before = layoutScene(sessions.slice(0, 5), { area });
    const after = layoutScene(sessions, { area });
    for (const key of ["codex", "cursor"]) {
      const was = node(before, originNodeId(key));
      const now = node(after, originNodeId(key));
      expect({ x: now.x, y: now.y }).toEqual({ x: was.x, y: was.y });
    }
    const last = node(after, originNodeId("console"));
    expect(last.y).toBeGreaterThan(node(after, originNodeId("cursor")).y);
  });

  it("所有节点互不重叠", () => {
    for (const area of [undefined, { w: 1168, h: 656 }, { w: 480, h: 700 }, { w: 1800, h: 900 }]) {
      const layout = layoutScene(sessions, area ? { area } : {});
      expect(overlapsOf(layout), JSON.stringify(area)).toEqual([]);
    }
  });
});

describe("fitScale", () => {
  it("内容放得下时不放大", () => {
    expect(fitScale({ w: 400, h: 300 }, { w: 1200, h: 800 })).toBe(1);
  });

  it("太宽就按宽度缩", () => {
    expect(fitScale({ w: 1000, h: 300 }, { w: 500, h: 800 })).toBeCloseTo(0.5, 6);
  });

  it("只是太高时缩到可读下限为止，剩下的靠上下滚动", () => {
    expect(fitScale({ w: 600, h: 3000 }, { w: 1200, h: 600 })).toBe(FIT_FLOOR);
    expect(fitScale({ w: 600, h: 800 }, { w: 1200, h: 600 })).toBeCloseTo(0.75, 6);
  });

  it("宽度要求更小时不受可读下限约束，但不会小于最小缩放", () => {
    expect(fitScale({ w: 1000, h: 300 }, { w: 400, h: 800 })).toBeCloseTo(0.4, 6);
    expect(fitScale({ w: 10_000, h: 300 }, { w: 400, h: 800 })).toBe(MIN_ZOOM);
  });

  it("没有内容时返回 1", () => {
    expect(fitScale({ w: 0, h: 0 }, { w: 400, h: 800 })).toBe(1);
  });

  it("fitAll=true 时允许突破可读下限（FIT_FLOOR）以把大量节点完整收入视口，最低到 FIT_ALL_MIN_ZOOM", () => {
    expect(fitScale({ w: 2800, h: 1800 }, { w: 1120, h: 720 }, MIN_ZOOM, true)).toBeCloseTo(0.4, 6);
    expect(fitScale({ w: 20_000, h: 20_000 }, { w: 1000, h: 800 }, MIN_ZOOM, true)).toBe(FIT_ALL_MIN_ZOOM);
    const cam = fitCamera({ x: 0, y: 0, w: 2800, h: 1800 }, { w: 1200, h: 800 }, { top: 40, right: 40, bottom: 40, left: 40 }, true);
    expect(cam.k).toBeCloseTo(0.4, 6);
  });
});

describe("layoutScene · 单来源多列规则网格（grid: true）", () => {
  it("根会话多到单列装不下时，自动按视口宽高比排成多列均匀网格，节点互不重叠且来源卡紧挨着这一块", () => {
    const many = Array.from({ length: 24 }, (_, idx) => session(`s${idx + 1}`, "cursor:big", idx + 1));
    const area = { w: 1088, h: 710 };
    const layout = layoutScene(many, { area, grid: true, hideContextNodes: true });
    expect(layout.grid).toBe(true);
    expect(overlapsOf(layout)).toEqual([]);

    const agents = layout.nodes.filter((n) => n.kind === "agent");
    const cols = new Set(agents.map((n) => Math.round(n.x)));
    const rows = new Set(agents.map((n) => Math.round(n.y)));
    expect(cols.size).toBeGreaterThanOrEqual(3);
    expect(rows.size).toBeGreaterThanOrEqual(2);

    // 来源卡紧挨着整块会话：在它们上面，或在它们左边（来源卡排在上还是排在左，取放得下的缩放更大的一种，一样大取左边）。
    const origin = node(layout, originNodeId("cursor:big"));
    const above = Math.min(...agents.map((n) => n.y)) >= origin.y + origin.h;
    const beside = Math.min(...agents.map((n) => n.x)) >= origin.x + origin.w;
    expect(above || beside).toBe(true);
    // 相比单列，网格排布的整体 fitAll 缩放明显更大（更充分利用画面）
    const single = layoutScene(many, { area, hideContextNodes: true });
    expect(fitScale(layout.bounds, area, MIN_ZOOM, true)).toBeGreaterThan(fitScale(single.bounds, area, MIN_ZOOM, true));
  });

  it("混合独立单卡与高大复合子树时分区紧排：单卡保持严格紧凑网格无断层、子会话不错位、锚点顺序合法且互不重叠", () => {
    const list: SessionSummary[] = [];
    for (let i = 1; i <= 20; i++) list.push(session(`s${i}`, "cursor:mix", i));
    list.push(session("parent", "cursor:mix", 21));
    for (let k = 1; k <= 10; k++) list.push(session(`k${k}`, "cursor:mix", 21 + k, { parentSessionId: "parent" }));

    const area = { w: 1088, h: 710 };
    const layout = layoutScene(list, { area, grid: true, hideContextNodes: true });
    expect(layout.grid).toBe(true);
    expect(overlapsOf(layout)).toEqual([]);

    // 子会话在网格模式下取消交错错位：全部在父会话右边，左缘落在父会话那一列往右的整数列上
    // （同一父会话的子会话可以折成几列，但不再有每行错开的半格）。
    const parent = node(layout, agentNodeId("parent"));
    const pitchX = cellsFor(false).pitchX;
    for (let i = 1; i <= 10; i++) {
      const kid = node(layout, agentNodeId(`k${i}`));
      expect(kid.x).toBeGreaterThan(parent.x);
      expect((kid.x - parent.x) % pitchX).toBe(0);
    }

    // 独立单卡相邻行的垂直间距保持紧凑（绝不被 10 个子节点的复合子树撑出巨型空白断层）
    const singleYs = [...new Set(Array.from({ length: 20 }, (_, i) => Math.round(node(layout, agentNodeId(`s${i + 1}`)).y)))].sort((a, b) => a - b);
    for (let i = 1; i < singleYs.length; i++) {
      expect(singleYs[i]! - singleYs[i - 1]!).toBeLessThanOrEqual(NODE.agentH + 24);
    }

    // 所有节点的 anchor 均出现在自己之前（满足引擎顺序放置不变量）
    const indexById = new Map(layout.nodes.map((n, idx) => [n.id, idx]));
    for (const n of layout.nodes) {
      if (n.anchor) expect(indexById.get(n.anchor.id)!).toBeLessThan(indexById.get(n.id)!);
    }
  });

  it("一两个根会话即使传了 grid: true 仍保持经典的左到右树形：来源卡在左、会话在右，两张卡左缘对齐（不错位）", () => {
    // 旧断言用 3 个会话：横屏里 3 个单卡根会话不再保留成一列（见 layout.stacked.test.ts），所以这条改用 2 个；
    // 旧断言只查第一张卡的 x，现在补上第二张：规划式排布里同一列的卡左缘在同一个 x 上。
    const few = [session("a", "cursor:small", 1), session("b", "cursor:small", 2)];
    const layout = layoutScene(few, { area: { w: 1088, h: 710 }, grid: true, hideContextNodes: true });
    expect(layout.grid).toBeUndefined();
    const origin = node(layout, originNodeId("cursor:small"));
    expect(origin.x).toBe(0);
    expect(node(layout, agentNodeId("a")).x).toBe(NODE.originW + NODE.originGap);
    expect(node(layout, agentNodeId("b")).x).toBe(NODE.originW + NODE.originGap);
  });
});

describe("fitArea", () => {
  it("扣除留白，窄屏的留白更小", () => {
    const wide = fitArea(1280, 800);
    const narrow = fitArea(520, 800);
    expect(wide).toEqual({ w: 1280 - 112, h: 800 - 190 });
    expect(narrow.w).toBe(520 - 40);
  });

  it("极小的视口也给出正数区域", () => {
    const tiny = fitArea(10, 10);
    expect(tiny.w).toBeGreaterThan(0);
    expect(tiny.h).toBeGreaterThan(0);
  });
});
