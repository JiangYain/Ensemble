import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { layoutScene, type LayoutEdge, type LayoutNode, type SceneLayout } from "./layout";
import { digestOf, goldenCases, type GoldenCase, type LayoutDigest } from "./layout.golden.fixtures";

/**
 * 画布布局的固定对照：固定的输入（layout.golden.fixtures.ts 的 144 个用例）、固定的期望（layout.golden.json）。
 * 之后只动结构的整改靠它兜底：每个节点的位置与锚点、连线与它们的次序（引擎按“第一条指向它的连线”找上游，次序是契约）、
 * 外框、grid 与 fitAll，都要与记录逐项一致。
 *
 * **这份期望是 2026-11-22 画布排布重做时有意“重新定的基线”**：原来的 78 个用例记录的是旧排法的输出（经典的树放不下就换成逐块凑出来的网格），
 * 在新的格点排布下必然不再成立——其中 65 个规划式用例的摘要变了，13 个不规划的经典排法用例与旧记录的哈希逐项相同（没有动经典排法）。
 * 新基线由**新规划器**生成，所以它只证明“之后没有悄悄改变布局”，不证明布局好：好不好由 layout.invariants.test.ts 的不变量
 * （无重叠、全部在取景区域内、同一套列距行距、外框形状、相对统一网格上限的效率）和 layout.real.test.ts（真实画布）管。
 *
 * **第二次有意重新定基线（LAYOUT2）**：在上面那份基线上又有意改了四处排法——W1 少量根会话不再排成“单列竖堆 + 24px 错位”（规划式排布里同一列的卡左缘相同）、
 * W2 小家族（后代数不超过 SMALL_FAMILY）的子会话竖排在父会话右边一列、W3 汇聚的会话一律落在同一来源块里所有上级的右边、W5 全部空间里各来源卡用同一种摆法。
 * 144 个用例里 59 个与第一次的记录逐项相同，85 个变了；变了的逐个归因过（临时给各项加开关、关掉一项再算一遍，看哪个用例回到第一次的记录）：
 * 只因 W2 变的 55 个（场景里有后代数 1~5 的会话、又走格点排布）、只因 W5 变的 14 个（不止一个来源块）、W2 与 W5 都占的 13 个、
 * 只因 W1 去错位变的 1 个（竖屏里 7 个单卡仍是一列经典排法，左缘从相差 24px 变成相同）；
 * 另有 2 个汇聚用例（窄区域与竖屏里汇聚的会话被推到更右的一列）把 W1、W2、W5 都关掉仍然变，按排除法归到 W3（W3 没有做成可以单独关掉的开关）。
 * 没动的有五类：只有单卡的单来源场景（除上面那 1 个竖屏用例）、只有后代很多的大扇出（32 个与 10 个子会话）、数据异常的场景、“不规划”这个取景变体
 * （没有 grid 选项，不走规划式排布），以及 9 个多来源场景在窄区域、竖屏、窗口很矮等取景下的变体（没有逐个核对为什么没动）。
 * 记在这里，是为了以后再改排法时，这几类的摘要变了就先问为什么。
 * 重新生成的脚本是一次性的，放在 src 之外，不进仓库。
 *
 * **2026-11-24 公开发布前的一处改动**：夹具里写死的本机用户名换成了占位的 alice（REPO 现在是 `C:\Users\alice\Desktop\Ensemble`）。Folder 与 Git 卡的 id 带着这段路径，
 * 所以“两个来源共用 Folder 与 Git 卡”的 8 个用例只有 hash 变了（nodes、edges、bounds、grid、fitAll 都没变），其余 136 个原样。排法没动：
 * 把夹具临时改回旧写法、用同一份代码跑，144 个摘要与改名前的记录逐项一致；只更新了这 8 个 hash。
 *
 * 不要用现在的代码重新生成 layout.golden.json 来“让测试通过”：那样这份对照就什么也证明不了。
 * 只有布局被有意改变时才更新它，并且要在提交说明里写明改了什么、为什么。重新生成的做法：写一个临时脚本，对 `goldenCases()` 的每个用例算
 * `digestOf(layoutScene(entry.sessions, entry.options))`，以 `{ cases: { "<用例名>": 摘要 } }` 的形状 `JSON.stringify(…, null, 2)`
 * 再加一个换行写回本目录的 layout.golden.json；运行：`node node_modules\tsx\dist\cli.mjs --tsconfig tsconfig.web.json <脚本>`（脚本里的相对路径从仓库根算起）。
 *
 * 文件格式：`{ "cases": { "<用例名>": <LayoutDigest> } }`，两个空格缩进，末尾有换行。
 */

type Golden = { cases: Record<string, LayoutDigest> } | { error: Error };

/**
 * 读 layout.golden.json（与本测试文件在同一个目录）；读不到就返回错误，让测试明确失败，绝不拿当前代码补一份：
 * - 文件真的不存在（ENOENT）才说“缺失”；权限、路径不对等其余读取错误，把原始错误信息带出来；
 * - 路径用 `fileURLToPath(import.meta.url)` 拼，不用 `new URL("./layout.golden.json", import.meta.url)`：
 *   web 测试项目跑在 happy-dom 里，全局 `URL` 会忽略 base 参数、把相对路径解析成 http 地址，`readFileSync` 读不了。
 */
function loadGolden(): Golden {
  let text: string;
  try {
    text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "layout.golden.json"), "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { error: new Error("layout.golden.json 缺失：不要在测试里用当前代码补一份（重新生成的做法见本文件头）", { cause: error }) };
    }
    return { error: new Error(`layout.golden.json 读取失败：${error instanceof Error ? error.message : String(error)}`, { cause: error }) };
  }
  let file: { cases?: Record<string, LayoutDigest> };
  try {
    file = JSON.parse(text) as { cases?: Record<string, LayoutDigest> };
  } catch (error) {
    return { error: new Error("layout.golden.json 不是合法的 JSON", { cause: error }) };
  }
  return file.cases ? { cases: file.cases } : { error: new Error("layout.golden.json 的格式不对：应是 { cases: { 用例名: 摘要 } }") };
}

/** 与记录走同一条路（写成 JSON 再读回来）：JSON 里没有 -0，也没有 undefined。 */
const throughJson = (digest: LayoutDigest): LayoutDigest => JSON.parse(JSON.stringify(digest)) as LayoutDigest;

describe("layoutScene · 固定输入对照（layout.golden.json）", () => {
  const golden = loadGolden();
  if ("error" in golden) {
    it("layout.golden.json 在，并且读得出来", () => {
      throw golden.error;
    });
    return;
  }
  const recorded = golden.cases;
  const cases = goldenCases();

  it("每条记录都是摘要：64 位十六进制的 hash，加上节点数、连线数、外框、grid 与 fitAll", () => {
    for (const [name, digest] of Object.entries(recorded)) {
      expect(Object.keys(digest).sort(), name).toEqual(["bounds", "edges", "fitAll", "grid", "hash", "nodes"]);
      expect(digest.hash, name).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("用例名与 layout.golden.json 的键完全相等（不多不少），用例不少于 144 个", () => {
    const names = cases.map((entry) => entry.name);
    expect(names.length).toBeGreaterThanOrEqual(144);
    expect(
      names.filter((name) => !Object.hasOwn(recorded, name)),
      "goldenCases() 里有、layout.golden.json 里没有的用例",
    ).toEqual([]);
    expect(
      Object.keys(recorded).filter((name) => !names.includes(name)),
      "layout.golden.json 里有、goldenCases() 里没有的用例",
    ).toEqual([]);
  });

  it("覆盖保护：记录里既有网格形态、缩小取景，也有保持经典排法的、节点很多的用例（以防输入退化成全落在经典排法上）", () => {
    const digests = Object.values(recorded);
    expect(digests.some((digest) => digest.grid), "没有 grid 为真的用例").toBe(true);
    expect(digests.some((digest) => digest.fitAll), "没有 fitAll 为真的用例").toBe(true);
    expect(digests.some((digest) => !digest.grid), "没有 grid 为假（经典排法保留）的用例").toBe(true);
    expect(digests.some((digest) => digest.nodes > 40), "没有节点数大于 40 的用例").toBe(true);
  });

  for (const { name, sessions, options } of cases) {
    it(name, () => {
      const actual = throughJson(digestOf(layoutScene(sessions, options)));
      expect(actual, `用例“${name}”与 layout.golden.json 记录的摘要不同：nodes、edges、bounds、grid、fitAll 看下面的差异，hash 管住其余全部内容`).toEqual(recorded[name]);
    });
  }
});

describe("digestOf · 摘要", () => {
  const card = (id: string, x: number, y: number): LayoutNode => ({ id, kind: "agent", x, y, w: 248, h: 112, overhang: { left: 0, right: 0 } });
  const link = (from: string, to: string): LayoutEdge => ({ id: `${from}>${to}`, from, to, phase: "running" });
  const sample = (): SceneLayout => ({
    nodes: [card("a", 0, 0), card("b", 340, 0), card("c", 680, 0)],
    edges: [link("a", "b"), link("b", "c")],
    bounds: { x: 0, y: 0, w: 928, h: 112 },
    origins: [],
    folders: [],
  });

  it("节点数、连线数与外框原样；grid 与 fitAll 缺省时是 false，给了才是 true", () => {
    const digest = digestOf(sample());
    expect(digest).toMatchObject({ nodes: 3, edges: 2, bounds: { x: 0, y: 0, w: 928, h: 112 }, grid: false, fitAll: false });
    expect(digest.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(digestOf({ ...sample(), grid: true, fitAll: true })).toMatchObject({ grid: true, fitAll: true });
  });

  it("外框是拷贝：之后改布局的外框不会改动已经算出的摘要", () => {
    const layout = sample();
    const digest = digestOf(layout);
    layout.bounds.w = 1;
    expect(digest.bounds.w).toBe(928);
  });

  it("相同的布局得到相同的 hash（与是不是同一个对象无关）", () => {
    expect(digestOf(sample()).hash).toBe(digestOf(sample()).hash);
  });

  it("把一个节点的 x 改 1，hash 就不同", () => {
    const moved = sample();
    moved.nodes[1]!.x += 1;
    expect(digestOf(moved).hash).not.toBe(digestOf(sample()).hash);
  });

  it("把两个节点的次序互换，hash 就不同（次序是契约）", () => {
    const swapped = sample();
    swapped.nodes = [swapped.nodes[1]!, swapped.nodes[0]!, swapped.nodes[2]!];
    expect(digestOf(swapped).hash).not.toBe(digestOf(sample()).hash);
  });

  it("把两条连线的次序互换，hash 就不同（引擎按第一条指向它的连线找上游）", () => {
    const swapped = sample();
    swapped.edges = [swapped.edges[1]!, swapped.edges[0]!];
    expect(digestOf(swapped).hash).not.toBe(digestOf(sample()).hash);
  });

  it("hidden 的插入次序不影响 hash，成员不同才影响", () => {
    const first = { ...sample(), hidden: new Set(["agent:x", "agent:y", "agent:z"]) };
    const second = { ...sample(), hidden: new Set(["agent:z", "agent:x", "agent:y"]) };
    const fewer = { ...sample(), hidden: new Set(["agent:x", "agent:y"]) };
    expect(digestOf(first).hash).toBe(digestOf(second).hash);
    expect(digestOf(first).hash).not.toBe(digestOf(fewer).hash);
    expect(digestOf(first).hash).not.toBe(digestOf(sample()).hash);
  });

  it("值为 undefined 的属性与缺省的属性等价（顶层与嵌套都是），有值就不同", () => {
    const plain = sample();
    const explicit = { ...sample(), hidden: undefined, grid: undefined, fitAll: undefined };
    explicit.nodes[1]!.anchor = undefined;
    expect(digestOf(explicit).hash).toBe(digestOf(plain).hash);
    plain.nodes[1]!.anchor = { id: "a", dx: 340, dy: 0 };
    expect(digestOf(plain).hash).not.toBe(digestOf(explicit).hash);
  });

  it("对象的键次序不影响 hash", () => {
    const original = sample();
    const reordered: SceneLayout = {
      folders: [],
      origins: [],
      bounds: { h: 112, w: 928, y: 0, x: 0 },
      edges: original.edges.map((edge) => ({ phase: edge.phase, to: edge.to, from: edge.from, id: edge.id })),
      nodes: original.nodes.map((node) => ({ overhang: node.overhang, h: node.h, w: node.w, y: node.y, x: node.x, kind: node.kind, id: node.id })),
    };
    expect(digestOf(reordered).hash).toBe(digestOf(original).hash);
  });

  it("不认识的容器（Map）直接报错，不会悄悄被当成空对象", () => {
    const layout = { ...sample(), hidden: new Map([["agent:x", true]]) } as unknown as SceneLayout;
    expect(() => digestOf(layout)).toThrow(/Map/);
  });
});

describe("goldenCases · 用例集", () => {
  it("18 个场景 × 8 个取景变体，名字全部唯一，每次调用的内容都相同（没有随机、没有时钟）", () => {
    const first = goldenCases();
    expect(first).toHaveLength(18 * 8);
    expect(new Set(first.map((entry) => entry.name)).size).toBe(first.length);
    expect(goldenCases()).toEqual(first);
  });

  it("每次调用都现造会话、Set 与 Map：同一次调用里各用例互不共用，两次调用之间也不共用", () => {
    const containersOf = (cases: readonly GoldenCase[]): object[] =>
      cases.flatMap((entry) => {
        const found: object[] = [entry.sessions, ...entry.sessions];
        for (const container of [entry.options.visible, entry.options.collapsed, entry.options.git]) {
          if (container) found.push(container);
        }
        return found;
      });
    const first = containersOf(goldenCases());
    const second = containersOf(goldenCases());
    expect(new Set(first).size, "同一次调用里有用例共用了容器").toBe(first.length);
    expect(
      second.filter((container) => first.includes(container)),
      "两次调用共用了容器",
    ).toEqual([]);
  });
});
