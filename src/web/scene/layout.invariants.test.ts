import { describe, expect, it } from "vitest";
import { layoutScene, type LayoutNode, type SceneLayout } from "./layout";
import { cellsFor } from "./layout-cells";
import { isCompact, type Area } from "./layout-geometry";
import { overlapsOf } from "./layout.fixtures";
import { goldenCases, type GoldenCase } from "./layout.golden.fixtures";
import { chooseSide, Curve, routeCurve } from "./pipes";

/**
 * 画布排布的不变量（2026-11-22 排布重做时加的）：对 layout.golden.fixtures.ts 的每个用例都成立的几何性质。
 * layout.golden.test.ts 只证明“之后没有悄悄变”，这里证明“现在的排法本身站得住”：无重叠、放得下就放进去、
 * 同一张格子、外框贴着取景区域、父子相邻、连线不穿过别的家族的卡片、节点与连线的次序契约。
 *
 * 不测耗时（机器忙时会抖）；真实画布的数字（相对统一网格上限的效率等）见 layout.real.test.ts。
 */

interface Laid {
  entry: GoldenCase;
  layout: SceneLayout;
  area: Area | undefined;
  /** 走了格点排布（`layout.grid`）。 */
  lattice: boolean;
}

const laid: Laid[] = goldenCases().map((entry) => {
  const layout = layoutScene(entry.sessions, entry.options);
  return { entry, layout, area: entry.options.area, lattice: layout.grid === true };
});

/** 规划式的用例（给了 grid 与取景区域）。 */
const planned = laid.filter(({ entry }) => entry.options.grid === true && entry.options.area !== undefined);
const lattices = planned.filter(({ lattice }) => lattice);
const agentsOf = (layout: SceneLayout): LayoutNode[] => layout.nodes.filter((node) => node.kind === "agent");

/** 同一件事在报错里要看得出是哪个用例：名字放进断言的说明。 */
const each = (list: readonly Laid[], check: (item: Laid) => void): void => {
  for (const item of list) check(item);
};

describe("排布的不变量 · 所有用例", () => {
  it("用例集覆盖到：规划式的用例里既有格点排布也有保留经典的，格点排布不少于 100 个", () => {
    expect(planned.length).toBeGreaterThanOrEqual(120);
    expect(lattices.length).toBeGreaterThanOrEqual(100);
    expect(planned.some(({ lattice }) => !lattice)).toBe(true);
  });

  it("任何两张卡片都不重叠", () => {
    each(laid, ({ entry, layout }) => expect(overlapsOf(layout), entry.name).toEqual([]));
  });

  it("所有位置与尺寸都是整数像素（半个像素会让卡片里的文字发虚、管线对不齐端口）", () => {
    each(laid, ({ entry, layout }) => {
      for (const node of layout.nodes) {
        expect([node.x, node.y, node.w, node.h].every(Number.isInteger), `${entry.name} · ${node.id}`).toBe(true);
      }
    });
  });

  it("节点 id 互不相同；连线的两端都是真实存在的节点；每个会话至少有一条连入的线", () => {
    each(laid, ({ entry, layout }) => {
      const ids = layout.nodes.map((node) => node.id);
      expect(new Set(ids).size, entry.name).toBe(ids.length);
      const known = new Set(ids);
      const entered = new Set(layout.edges.filter((edge) => edge.phase !== "link").map((edge) => edge.to));
      for (const edge of layout.edges) {
        expect(known.has(edge.from) && known.has(edge.to), `${entry.name} · ${edge.id}`).toBe(true);
      }
      for (const node of layout.nodes) if (node.kind === "agent") expect(entered.has(node.id), `${entry.name} · ${node.id}`).toBe(true);
    });
  });

  it("锚点都指向排在它自己之前的节点（引擎按顺序放置节点）", () => {
    each(laid, ({ entry, layout }) => {
      const index = new Map(layout.nodes.map((node, i) => [node.id, i]));
      for (const [i, node] of layout.nodes.entries()) {
        if (node.anchor) expect(index.get(node.anchor.id) ?? Infinity, `${entry.name} · ${node.id}`).toBeLessThan(i);
      }
    });
  });

  it("节点与连线的次序与经典排法逐项相同（引擎按“第一条指向它的连线”找上游，次序是契约）：排成格点只改位置与锚点", () => {
    each(lattices, ({ entry, layout }) => {
      const classic = layoutScene(entry.sessions, { ...entry.options, grid: false });
      expect(layout.nodes.map((node) => node.id), entry.name).toEqual(classic.nodes.map((node) => node.id));
      expect(layout.edges.map((edge) => edge.id), entry.name).toEqual(classic.edges.map((edge) => edge.id));
    });
  });
});

describe("排布的不变量 · 取景", () => {
  it("fitAll 当且仅当内容在 100% 缩放下放不进取景区域（允许 1 像素的取整）", () => {
    each(planned, ({ entry, layout, area }) => {
      const { w, h } = layout.bounds;
      const fits = w <= area!.w + 1 && h <= area!.h + 1;
      expect(layout.fitAll === true, `${entry.name}：外框 ${w}×${h}，取景 ${area!.w}×${area!.h}`).toBe(!fits);
    });
  });

  it("外框的宽高比贴着取景区域（会话 ≥ 12 个时在 0.7 ~ 1/0.7 倍之内）；少数由树的深度撑宽的用例是已知例外，例外过期会红", () => {
    // 这几个用例的树至少要占 4 列（来源卡 → 会话 → 子会话 → 孙会话），窄窗口 / 隐藏了单卡之后剩下的树把外框撑宽了：
    // 数字是量出来的外框宽高比相对取景区域宽高比的倍数。
    // LAYOUT2 之后的变动（数字都是量出来的，不是调出来的）：
    // - 汇聚两条：d 同时跟随 c 与 b（r → a → b 是三层），规则要求 d 的列严格大于 b 的列，于是 r → a → b → d 这条链本身就要 4 列，
    //   与“按 visible 收起”两条是同一个原因；
    // - 窗口很矮两条（0.70、0.69）：取景区域只有 240px 高（4.5 : 1），小家族的子会话竖排成一列之后不能再摊成一行，外框比取景区域略高了一点点，
    //   差的只有 0.01 ~ 0.02 的带宽；
    // - “只有子树 · 宽屏”那条退出了例外：小家族竖排之后它回到了带宽之内（例外过期会红，所以必须去掉）。
    const exceptions = new Map<string, number>([
      ["单卡加一棵深浅不一的子树 · 窄区域（紧凑模式）", 1.5],
      ["按 visible 收起一部分单卡 · 窄区域（紧凑模式）", 1.94],
      ["按 visible 收起一部分单卡 · 竖屏的窄窗口", 1.63],
      ["按 visible 收起一部分单卡 · 窗口很矮", 0.7],
      ["汇聚的会话被推到更右的列 · 窄区域（紧凑模式）", 1.94],
      ["汇聚的会话被推到更右的列 · 竖屏的窄窗口", 1.63],
      ["嵌套三层 · 窗口很矮", 0.69],
    ]);
    const seen = new Set<string>();
    each(lattices, ({ entry, layout, area }) => {
      if (agentsOf(layout).length < 12) return;
      const ratio = layout.bounds.w / layout.bounds.h / (area!.w / area!.h);
      const inBand = ratio >= 0.7 && ratio <= 1 / 0.7;
      const known = exceptions.get(entry.name);
      if (known === undefined) {
        expect(inBand, `${entry.name}：外框宽高比是取景区域的 ${ratio.toFixed(2)} 倍`).toBe(true);
        return;
      }
      seen.add(entry.name);
      expect(inBand, `${entry.name} 已经在范围内（${ratio.toFixed(2)} 倍）：把它从例外里去掉`).toBe(false);
      expect(ratio, entry.name).toBeCloseTo(known, 1);
    });
    expect([...exceptions.keys()].filter((name) => !seen.has(name)), "例外里有不再走格点排布的用例").toEqual([]);
  });

  /** 统一网格上限：同样多张 248×112 的卡、行列距都取 24，在取景区域里排成最合适的 c × r 网格能得到的缩放，封顶 100%（默认的缩放上限）。 */
  const uniformBound = (count: number, area: Area): number => {
    let best = 0;
    for (let c = 1; c <= count; c++) {
      const r = Math.ceil(count / c);
      best = Math.max(best, Math.min(1, area.w / (c * 248 + (c - 1) * 24), area.h / (r * 112 + (r - 1) * 24)));
    }
    return best;
  };

  it("只有单卡的画布：缩放（封顶 100%）不低于统一网格上限的 80%（规则网格的代价只有列距多出来的 8px 与来源卡那一格）", () => {
    each(
      lattices.filter(({ entry, area }) => /^(7|24) 个单卡/.test(entry.name) && !isCompact(area)),
      ({ entry, layout, area }) => {
        const scale = Math.min(1, area!.w / layout.bounds.w, area!.h / layout.bounds.h);
        const bound = uniformBound(layout.nodes.length, area!);
        expect(scale / bound, `${entry.name}：缩放 ${(scale * 100).toFixed(0)}%，上限 ${(bound * 100).toFixed(0)}%`).toBeGreaterThanOrEqual(0.8);
      },
    );
  });
});

describe("排布的不变量 · 同一张格子", () => {
  it("会话卡的左缘彼此相差列距 pitchX 的整数倍，上缘彼此相差行距 pitchY 的整数倍（全局一张格子，没有错位）", () => {
    each(lattices, ({ entry, layout, area }) => {
      const cells = cellsFor(isCompact(area));
      const agents = agentsOf(layout);
      const left = Math.min(...agents.map((node) => node.x));
      const top = Math.min(...agents.map((node) => node.y));
      for (const node of agents) {
        expect(Math.abs(node.x - left) % cells.pitchX, `${entry.name} · ${node.id} 的 x`).toBe(0);
        expect(Math.abs(node.y - top) % cells.pitchY, `${entry.name} · ${node.id} 的 y`).toBe(0);
        expect(node.w, entry.name).toBe(cells.agentW);
      }
    });
  });

  it("只有单卡的画布：每一列的卡片数最多差 1（一格一格装进去，不会这一列满那一列空）", () => {
    each(
      lattices.filter(({ entry }) => /^(7|24) 个单卡/.test(entry.name)),
      ({ entry, layout }) => {
        const perColumn = new Map<number, number>();
        for (const node of agentsOf(layout)) perColumn.set(node.x, (perColumn.get(node.x) ?? 0) + 1);
        const counts = [...perColumn.values()];
        expect(Math.max(...counts) - Math.min(...counts), `${entry.name}：各列 ${counts.join("、")}`).toBeLessThanOrEqual(1);
      },
    );
  });
});

describe("排布的不变量 · 谱系可读", () => {
  /** 树边：每个节点第一条连入的（非归属）线；其余是多父汇聚补出来的线。 */
  const treeEdges = (layout: SceneLayout) => {
    const entered = new Set<string>();
    const tree: { from: string; to: string }[] = [];
    for (const edge of layout.edges) {
      if (edge.phase === "link") continue;
      if (entered.has(edge.to)) continue;
      entered.add(edge.to);
      tree.push({ from: edge.from, to: edge.to });
    }
    return tree;
  };

  it("子会话在父会话的右边隔一列；来源卡的会话在它右边或下面", () => {
    each(lattices, ({ entry, layout, area }) => {
      const cells = cellsFor(isCompact(area));
      const nodes = new Map(layout.nodes.map((node) => [node.id, node]));
      for (const { from, to } of treeEdges(layout)) {
        const parent = nodes.get(from)!;
        const child = nodes.get(to)!;
        if (parent.kind === "origin") {
          expect(child.x >= parent.x + parent.w || child.y >= parent.y + parent.h, `${entry.name} · ${from} → ${to}`).toBe(true);
        } else {
          expect(child.x - parent.x, `${entry.name} · ${from} → ${to}`).toBeGreaterThanOrEqual(cells.pitchX);
        }
      }
    });
  });

  it("连线不穿过别的家族的卡片：从来源出发的线，经过的卡片只会是它自己名下的（来源卡名下是整个来源块，会话名下是它的子树）", () => {
    // 多列的子网格里，指向靠右的子会话的线会从同一个父会话下的兄弟卡片后面经过（引擎的连线是端口到端口的一条 S 形曲线，不绕行）；
    // 这在“家族”之内，是折成多列的代价。这里只守住不会穿过别的家族。
    const curve = new Curve();
    each(lattices, ({ entry, layout }) => {
      const nodes = new Map(layout.nodes.map((node) => [node.id, node]));
      const tree = treeEdges(layout);
      const kids = new Map<string, string[]>();
      for (const { from, to } of tree) kids.set(from, [...(kids.get(from) ?? []), to]);
      const family = (id: string): Set<string> => {
        const members = new Set<string>([id]);
        const stack = [id];
        for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
          for (const kid of kids.get(next) ?? []) {
            if (members.has(kid)) continue;
            members.add(kid);
            stack.push(kid);
          }
        }
        return members;
      };
      const offenders: string[] = [];
      for (const { from, to } of tree) {
        const source = nodes.get(from)!;
        const target = nodes.get(to)!;
        const kin = family(from);
        const strangers = layout.nodes.filter((node) => !kin.has(node.id) && node !== source);
        routeCurve(source, target, chooseSide(-1, source, target), curve);
        for (let i = 1; i < 48; i++) {
          const u = i / 48;
          const v = 1 - u;
          const x = v * v * v * curve.x0 + 3 * v * v * u * curve.x1 + 3 * v * u * u * curve.x2 + u * u * u * curve.x3;
          const y = v * v * v * curve.y0 + 3 * v * v * u * curve.y1 + 3 * v * u * u * curve.y2 + u * u * u * curve.y3;
          for (const node of strangers) {
            // 缩进 2px：贴着卡片边缘擦过不算穿过。
            if (x > node.x + 2 && x < node.x + node.w - 2 && y > node.y + 2 && y < node.y + node.h - 2) offenders.push(`${from} → ${to} 穿过了 ${node.id}`);
          }
        }
      }
      expect([...new Set(offenders)], entry.name).toEqual([]);
    });
  });

  it("只有单卡的画布：会话按创建先后一格一格装进去，先创建的在前（行优先，同一行里从左到右）", () => {
    // 带子树的画布里，后面的兄弟可以落进前面某个孩子的父列空格（见 layout-fold 的 pack），所以这条只对单卡成立。
    each(
      lattices.filter(({ entry }) => /^(7|24) 个单卡/.test(entry.name)),
      ({ entry, layout }) => {
        // 节点在 nodes 里的次序就是创建先后（上面核对过与经典排法相同）。
        const agents = agentsOf(layout);
        for (let i = 1; i < agents.length; i++) {
          const before = agents[i - 1]!;
          const after = agents[i]!;
          expect(before.y < after.y || (before.y === after.y && before.x < after.x), `${entry.name} · ${before.id} 之后是 ${after.id}`).toBe(true);
        }
      },
    );
  });
});
