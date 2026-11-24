import type { SessionSummary } from "@shared/types";
import { describe, expect, it } from "vitest";
import { cellsFor } from "./layout-cells";
import { centerOf, foldersOf, gitsOf, inDir, node, overlapsOf, REPO, session } from "./layout.fixtures";
import { agentNodeId, FIT_ALL_MIN_ZOOM, fitCamera, fitScale, holdScale, layoutScene, MIN_ZOOM, originNodeId, type SceneLayout } from "./layout";

/**
 * 规划式排布（`grid: true` 加 `area`）与保持缩放取景的纯函数测试：
 * 目标是全部节点在取景区域里整齐地一屏放下；缩放上限 `zoom` 是第一约束，放得下就不动经典的树，放不下才换网格，再放不下才缩小。
 * 下面的“放得下的最大缩放”都用宽高各自的比例取较小者（不封顶、不受可读下限约束），和布局里比较各种排法用的是同一个量。
 */

/** 桌面宽度下的取景区域：1280 × 800 的视口扣掉四周留白（Overview 再量化到 16px 之前的样子）。 */
const AREA = { w: 1088, h: 610 };

const rawScale = (layout: SceneLayout, area = AREA): number => Math.min(area.w / layout.bounds.w, area.h / layout.bounds.h);

/** 同一来源名下 count 个互不相干的根会话；`from` 是第一个会话创建的先后（秒）。 */
const singles = (key: string, count: number, from = 1): SessionSummary[] => Array.from({ length: count }, (_, i) => session(`${key}-${i + 1}`, key, from + i));

const agentsOf = (layout: SceneLayout) => layout.nodes.filter((n) => n.kind === "agent");
/** 取整后有几个不同的值：数列数、行数。 */
const distinct = (values: readonly number[]): number => new Set(values.map((value) => Math.round(value))).size;
const placesOf = (layout: SceneLayout) => layout.nodes.map((n) => [n.id, n.x, n.y]);
/** 每个节点的锚点都排在它自己之前（引擎按顺序放置的不变量，见 LayoutNode.anchor）。 */
const anchorsFirst = (layout: SceneLayout): boolean => {
  const index = new Map(layout.nodes.map((n, i) => [n.id, i]));
  return layout.nodes.every((n, i) => !n.anchor || index.get(n.anchor.id)! < i);
};

const options = { area: AREA, grid: true, hideContextNodes: true } as const;

describe("layoutScene · 规划式排布与缩放上限 zoom", () => {
  const seven = singles("cursor:seven", 7);

  it("经典的树放得进缩放上限、又不是一条细长的竖串就保持原样；放不进、或是一条竖串，才排成多列网格", () => {
    // 2 个根会话一列只有 552 × 248：放得下，也不是竖串（宽高比是取景区域的 1.25 倍），保持经典的树；两张卡左缘对齐（以前奇偶行错开 24px，已去掉）。
    // 旧断言用 3 个会话：横屏里 3 个起的单卡根会话不再保留成一列（见 layout.stacked.test.ts），所以这里改用 2 个。
    const few = layoutScene(singles("cursor:few", 2), options);
    expect(few.grid).toBeUndefined();
    expect(distinct(agentsOf(few).map((n) => n.x))).toBe(1);
    expect(few.fitAll).toBeUndefined();

    // 7 个根会话排成一列要缩到 66% 才放得进 1088 × 610：上限 0.6 时单列已经“放得下”，但那是一条宽高比只有取景区域 0.31 倍的竖串，
    // 不再原样保留（否则“重新排列”点出来的就是一条竖排到底）；上限 1 时单列放不下。两种上限排出同一张网格。
    const loose = layoutScene(seven, { ...options, zoom: 0.6 });
    expect(loose.grid).toBe(true);
    expect(placesOf(loose)).toEqual(placesOf(layoutScene(seven, options)));
    const column = layoutScene(seven, { area: AREA, hideContextNodes: true });

    const tight = layoutScene(seven, options);
    expect(tight.grid).toBe(true);
    expect(distinct(agentsOf(tight).map((n) => n.x))).toBe(3);
    expect(rawScale(tight)).toBeGreaterThan(rawScale(column));
    // 网格在 100% 下放得下：取景不必缩，也就没有 fitAll。
    expect(rawScale(tight)).toBeGreaterThanOrEqual(1);
    expect(tight.fitAll).toBeUndefined();
    expect(overlapsOf(tight)).toEqual([]);
    expect(tight.bounds.w).toBeLessThanOrEqual(AREA.w);
    expect(tight.bounds.h).toBeLessThanOrEqual(AREA.h);
  });

  it("zoom 缺省就是 100%，并被限制在 [FIT_ALL_MIN_ZOOM, 1.6]：越界的值与边界值排出一样的结果", () => {
    expect(placesOf(layoutScene(seven, { ...options, zoom: 1 }))).toEqual(placesOf(layoutScene(seven, options)));
    expect(placesOf(layoutScene(seven, { ...options, zoom: 0.01 }))).toEqual(placesOf(layoutScene(seven, { ...options, zoom: FIT_ALL_MIN_ZOOM })));
    expect(placesOf(layoutScene(seven, { ...options, zoom: 99 }))).toEqual(placesOf(layoutScene(seven, { ...options, zoom: 1.6 })));
  });

  it("没有 grid 时还是原来的经典排法：没有 grid 与 fitAll 标志，zoom 不起作用", () => {
    const legacy = layoutScene(seven, { area: AREA, hideContextNodes: true });
    expect(legacy.grid).toBeUndefined();
    expect(legacy.fitAll).toBeUndefined();
    const withZoom = layoutScene(seven, { area: AREA, hideContextNodes: true, zoom: 0.3 });
    expect(placesOf(withZoom)).toEqual(placesOf(legacy));
  });

  it("放不下 100% 的网格排布带 fitAll，缩放比经典的单列大得多；放得下的不带", () => {
    const many = singles("cursor:big", 24);
    const layout = layoutScene(many, options);
    expect(layout.grid).toBe(true);
    expect(layout.fitAll).toBe(true);
    expect(overlapsOf(layout)).toEqual([]);
    // 24 个会话在 1088 × 610 里排成 5 列 × 5 行，按 75% 左右放得下；经典的单列只有 19%。
    expect(rawScale(layout)).toBeGreaterThan(0.74);
    expect(rawScale(layout)).toBeLessThan(1);
    expect(rawScale(layout)).toBeGreaterThan(rawScale(layoutScene(many, { area: AREA, hideContextNodes: true })) * 3);
  });

  it("每个会话仍只有一条连入的线：来源连到根会话、父会话连到子会话，排成网格也不变", () => {
    const list: SessionSummary[] = [...singles("cursor:mix", 20)];
    list.push(session("parent", "cursor:mix", 21));
    for (let k = 1; k <= 10; k++) list.push(session(`k${k}`, "cursor:mix", 21 + k, { parentSessionId: "parent" }));
    const layout = layoutScene(list, options);
    expect(layout.grid).toBe(true);
    expect(layout.edges).toHaveLength(list.length);
    expect(new Set(layout.edges.map((edge) => edge.to)).size).toBe(list.length);
    const edgeIds = new Set(layout.edges.map((edge) => edge.id));
    expect(edgeIds.has(`${originNodeId("cursor:mix")}>${agentNodeId("parent")}`)).toBe(true);
    expect(edgeIds.has(`${agentNodeId("parent")}>${agentNodeId("k1")}`)).toBe(true);
    expect(anchorsFirst(layout)).toBe(true);
    expect(overlapsOf(layout)).toEqual([]);
  });

  describe("几个来源并排", () => {
    // 三个来源各 10 个根会话：经典排法三列并排要缩到 46%；每个来源排成 5 列 × 2 行的块（来源卡在左），三块上下叠进同一张格点，按 66% 放得下。
    const three = [...singles("cursor:a", 10, 1), ...singles("cursor:b", 10, 101), ...singles("cursor:c", 10, 201)];

    it("来源块排进同一张格点、各自成组（各占一个矩形，互不交错），整体不重叠，缩放比经典排法大", () => {
      const layout = layoutScene(three, options);
      expect(layout.grid).toBe(true);
      expect(layout.fitAll).toBe(true);
      expect(overlapsOf(layout)).toEqual([]);
      expect(anchorsFirst(layout)).toBe(true);
      expect(rawScale(layout)).toBeGreaterThan(0.62);
      expect(rawScale(layout)).toBeGreaterThan(rawScale(layoutScene(three, { area: AREA, hideContextNodes: true })));

      // 每个来源块（来源卡加它的 10 个会话）各占一个矩形，三个矩形两两不相交：不同来源的卡片不混在一起。
      const boxes = ["cursor:a", "cursor:b", "cursor:c"].map((key) => {
        const own = layout.nodes.filter((n) => n.id === originNodeId(key) || n.id.startsWith(`agent:${key}-`));
        expect(own).toHaveLength(11);
        return { left: Math.min(...own.map((n) => n.x)), right: Math.max(...own.map((n) => n.x + n.w)), top: Math.min(...own.map((n) => n.y)), bottom: Math.max(...own.map((n) => n.y + n.h)) };
      });
      for (const [i, a] of boxes.entries()) {
        for (const b of boxes.slice(i + 1)) {
          expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true);
        }
      }
      // 三块共用同一套列距与行距：任意两张会话卡的左缘之差是整数个列距、上缘之差是整数个行距。
      const { pitchX, pitchY } = cellsFor(false);
      const agents = agentsOf(layout);
      for (const n of agents) {
        expect(Math.abs(n.x - agents[0]!.x) % pitchX).toBe(0);
        expect(Math.abs(n.y - agents[0]!.y) % pitchY).toBe(0);
      }
    });

    it("缩放上限放宽到经典排法放得下，就回到经典的并排的树，不为排而排", () => {
      const layout = layoutScene(three, { ...options, zoom: 0.4 });
      expect(layout.grid).toBeUndefined();
      expect(distinct(["cursor:a", "cursor:b", "cursor:c"].map((key) => node(layout, originNodeId(key)).x))).toBe(3);
      expect(overlapsOf(layout)).toEqual([]);
    });
  });

  it("全部空间：Folder 与 Git 卡随来源块一起规划，仍在来源左边、与来源卡同高，整体不重叠", () => {
    const sessions = Array.from({ length: 24 }, (_, i) => inDir(`s${i + 1}`, "cursor:big", i + 1, REPO));
    const layout = layoutScene(sessions, { area: AREA, grid: true, git: new Map([["cursor:big", "wt:repo"]]) });
    expect(layout.grid).toBe(true);
    expect(overlapsOf(layout)).toEqual([]);
    expect(anchorsFirst(layout)).toBe(true);
    const origin = node(layout, originNodeId("cursor:big"));
    const [folder] = foldersOf(layout);
    const [git] = gitsOf(layout);
    expect(folder).toBeDefined();
    expect(git).toBeDefined();
    expect(git!.x + git!.w).toBeLessThan(folder!.x);
    expect(folder!.x + folder!.w).toBeLessThan(origin.x);
    expect(centerOf(folder!)).toBe(centerOf(origin));
    expect(centerOf(git!)).toBe(centerOf(origin));
    expect(rawScale(layout)).toBeGreaterThan(rawScale(layoutScene(sessions, { area: AREA, git: new Map([["cursor:big", "wt:repo"]]) })));
  });

  it("窄取景区域（宿主的浏览器侧栏）也排成规则网格：不画 Folder 与 Git 卡、列数不超过 4、整体不重叠", () => {
    const narrow = { w: 288, h: 544 };
    const sessions = Array.from({ length: 12 }, (_, i) => inDir(`s${i + 1}`, "cursor:narrow", i + 1, REPO));
    const git = new Map([["cursor:narrow", "wt:repo"]]);
    const layout = layoutScene(sessions, { area: narrow, grid: true, git });
    expect(layout.grid).toBe(true);
    expect(overlapsOf(layout)).toEqual([]);
    expect(foldersOf(layout)).toHaveLength(0);
    expect(gitsOf(layout)).toHaveLength(0);
    expect(distinct(agentsOf(layout).map((n) => n.x))).toBeLessThanOrEqual(4);
    expect(rawScale(layout, narrow)).toBeGreaterThan(rawScale(layoutScene(sessions, { area: narrow, git }), narrow));
  });

  it("网格里的间距都是 4 的倍数：同一列的行距、相邻列的列距", () => {
    const layout = layoutScene(singles("cursor:big", 24), options);
    const agents = agentsOf(layout);
    const xs = [...new Set(agents.map((n) => n.x))].sort((a, b) => a - b);
    const ys = [...new Set(agents.map((n) => n.y))].sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) expect((xs[i]! - xs[i - 1]! - agents[0]!.w) % 4).toBe(0);
    for (let i = 1; i < ys.length; i++) expect((ys[i]! - ys[i - 1]! - agents[0]!.h) % 4).toBe(0);
  });

  it("节点多到缩到下限也放不下时：照样排成最紧凑的网格并带 fitAll，取景停在 FIT_ALL_MIN_ZOOM（内容会超出画面，由用户平移）", () => {
    // 1000 个：同样的规划在 1088 × 610 里 600 个就能排进 16.3%，放得下的缩放要低于下限，得再多一些。
    const layout = layoutScene(singles("cursor:huge", 1000), options);
    expect(layout.grid).toBe(true);
    expect(layout.fitAll).toBe(true);
    expect(rawScale(layout)).toBeLessThan(FIT_ALL_MIN_ZOOM);
    expect(holdScale(layout.bounds, AREA, 1)).toBe(FIT_ALL_MIN_ZOOM);
  });
});

describe("holdScale · 保持缩放取景", () => {
  it("内容放得下就是保持的缩放本身，不放大也不缩小", () => {
    expect(holdScale({ w: 500, h: 300 }, { w: 1000, h: 600 }, 0.8)).toBe(0.8);
    expect(holdScale({ w: 500, h: 300 }, { w: 1000, h: 600 }, 1.4)).toBe(1.4);
  });

  it("放不下才缩，缩到刚好放下（宽高里更紧的那个）", () => {
    expect(holdScale({ w: 2000, h: 300 }, { w: 1000, h: 600 }, 0.8)).toBeCloseTo(0.5, 6);
    expect(holdScale({ w: 500, h: 2400 }, { w: 1000, h: 600 }, 0.8)).toBeCloseTo(0.25, 6);
  });

  it("不受可读下限 FIT_FLOOR 约束，最低到 FIT_ALL_MIN_ZOOM", () => {
    expect(holdScale({ w: 500, h: 1200 }, { w: 1000, h: 600 }, 1)).toBeCloseTo(0.5, 6);
    expect(holdScale({ w: 100_000, h: 100 }, { w: 1000, h: 600 }, 1)).toBe(FIT_ALL_MIN_ZOOM);
    expect(holdScale({ w: 500, h: 300 }, { w: 1000, h: 600 }, 0.01)).toBe(FIT_ALL_MIN_ZOOM);
  });

  it("只比取景区域大不到 1.5% 时仍保持（量化取景区域带来的几个像素不该让缩放少一个百分点）", () => {
    expect(holdScale({ w: 1010, h: 300 }, { w: 1000, h: 600 }, 1)).toBe(1);
    expect(holdScale({ w: 1030, h: 300 }, { w: 1000, h: 600 }, 1)).toBeCloseTo(1000 / 1030, 6);
  });

  it("没有内容尺寸时返回保持的缩放", () => {
    expect(holdScale({ w: 0, h: 0 }, { w: 1000, h: 600 }, 0.7)).toBe(0.7);
  });
});

describe("fitCamera · 保持缩放", () => {
  const pad = { top: 100, right: 100, bottom: 100, left: 100 };

  it("放得下：缩放不变，内容居中在扣掉留白的取景区域里", () => {
    // 取景区域 1000 × 600；外框 400 × 200，缩放 0.5 后是 200 × 100。
    const camera = fitCamera({ x: 100, y: 50, w: 400, h: 200 }, { w: 1200, h: 800 }, pad, false, 0.5);
    expect(camera).toEqual({ x: 450, y: 325, k: 0.5 });
  });

  it("给了保持缩放，fitAll 不再起作用", () => {
    const bounds = { x: 0, y: 0, w: 600, h: 300 };
    expect(fitCamera(bounds, { w: 1200, h: 800 }, pad, true).k).toBe(1);
    expect(fitCamera(bounds, { w: 1200, h: 800 }, pad, true, 0.5).k).toBe(0.5);
  });

  it("放不下：缩到刚好放下，与 fitAll 在这种情况下的结果一致", () => {
    const bounds = { x: 0, y: 0, w: 2800, h: 1800 };
    const held = fitCamera(bounds, { w: 1200, h: 800 }, { top: 40, right: 40, bottom: 40, left: 40 }, false, 0.9);
    expect(held.k).toBeCloseTo(0.4, 6);
    expect(held.k).toBeCloseTo(fitScale(bounds, { w: 1120, h: 720 }, MIN_ZOOM, true), 6);
  });

  it("溢出的那一点点（HOLD_SLACK 以内）也居中，不对齐左上", () => {
    // 取景区域 1000 × 600；外框 1010 × 100、保持 1：比区域宽 1%，仍按 1 居中，左右各溢出 5。
    const camera = fitCamera({ x: 0, y: 0, w: 1010, h: 100 }, { w: 1200, h: 800 }, pad, false, 1);
    expect(camera.k).toBe(1);
    expect(camera.x).toBeCloseTo(100 - 5, 6);
  });
});
