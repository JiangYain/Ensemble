/**
 * 画布布局的固定输入：18 个场景 × 8 个取景变体，共 144 个用例，以及把一份布局压成摘要的 `digestOf`。
 * 这里只有输入与摘要，没有断言，也不依赖 vitest；期望值与比较见 layout.golden.test.ts，各用例都要满足的不变量见 layout.invariants.test.ts。
 *
 * 前 13 个场景与前 6 个取景变体从（已删除的）原 layout.parity.test.ts 的“场景对照”一半原样搬来，内容一个字没改（2026-11-22 排布重做前后都是）；
 * 重做时新增了 5 个场景（一个父会话带 32 个子会话、多棵中等的树加许多单卡、嵌套三层、四个来源并排、一百多个会话混排）与 2 个取景变体（窗口很矮、竖屏的窄窗口），
 * 取景变体里原有的“窄区域（紧凑模式）”就是窗口很窄的那一个。改动输入就等于换了一份对照，要按 layout.golden.test.ts 文件头的做法重新生成期望值。
 * `goldenCases` 每次调用都现造全新的会话数组、Set 与 Map，用例之间、调用之间都不共用可变状态；取景区域是冻结的，共用也无妨。
 */

// tsconfig.web.json 只带 vite/client 的类型，而这个文件不是测试文件、会被它编译：显式引入 node 的类型，才能用 node:crypto。
/// <reference types="node" />
import { createHash } from "node:crypto";
import type { SessionSummary } from "@shared/types";
import type { Bounds, LayoutOptions, SceneLayout } from "./layout";
import { inDir, REPO, session } from "./layout.fixtures";

/** 一个用例：一批会话，与交给 `layoutScene` 的选项。 */
export interface GoldenCase {
  name: string;
  sessions: readonly SessionSummary[];
  options: LayoutOptions;
}

/**
 * 一份布局的摘要：`hash` 是整份布局（节点、连线与它们的次序、外框、各来源与 Folder 卡的信息、被收起的会话、grid、fitAll）的指纹，
 * 其余字段是给人看的——hash 对不上时，先看这几项差在哪。
 */
export interface LayoutDigest {
  hash: string;
  nodes: number;
  edges: number;
  bounds: Bounds;
  grid: boolean;
  fitAll: boolean;
}

/** 桌面宽度下的取景区域（与 layout.fill.test.ts 同一个）、宽屏，以及宿主浏览器侧栏那样的窄区域（低于 720 走紧凑模式）。 */
const AREA = Object.freeze({ w: 1088, h: 610 });
const WIDE = Object.freeze({ w: 1800, h: 900 });
const NARROW = Object.freeze({ w: 288, h: 544 });
/** 窗口很矮：一行卡片都要缩着放。 */
const SHORT = Object.freeze({ w: 1088, h: 240 });
/** 竖屏、窄但不进紧凑模式（宽 720 正好不低于紧凑的界线）：排布要往高处长。 */
const PORTRAIT = Object.freeze({ w: 720, h: 1000 });

const singles = (key: string, count: number, from = 1): SessionSummary[] => Array.from({ length: count }, (_, i) => session(`${key}-${i + 1}`, key, from + i));

/** 一棵深浅不一的子树：根带三个子会话，其中一个再带两个，那两个里的一个再带一个（深三层）。 */
const tree = (key: string, name: string, from: number): SessionSummary[] => {
  const id = (suffix: string): string => `${key}:${name}${suffix}`;
  return [
    session(id(""), key, from),
    session(id("-a"), key, from + 1, { parentSessionId: id("") }),
    session(id("-b"), key, from + 2, { parentSessionId: id("") }),
    session(id("-c"), key, from + 3, { parentSessionId: id("") }),
    session(id("-a1"), key, from + 4, { parentSessionId: id("-a") }),
    session(id("-a2"), key, from + 5, { parentSessionId: id("-a") }),
    session(id("-a1x"), key, from + 6, { parentSessionId: id("-a1") }),
  ];
};

/**
 * 汇聚，且被推到更右的列：r → a → b 是三层，r → c 是两层；d 同时跟随 c 与 b，树里挂在 c 下面（排在最前的上级），
 * 但 b 在第 2 列，所以 d 的列是 3 而不是 c 之下的 2——外框的宽必须读到这个列，不能只数树里的深度。
 */
const pushed = (key: string, from: number): SessionSummary[] => [
  session(`${key}-r`, key, from),
  session(`${key}-a`, key, from + 1, { parentSessionId: `${key}-r` }),
  session(`${key}-b`, key, from + 2, { parentSessionId: `${key}-a` }),
  session(`${key}-c`, key, from + 3, { parentSessionId: `${key}-r` }),
  session(`${key}-d`, key, from + 4, { parentSessionId: `${key}-c`, parentSessionIds: [`${key}-c`, `${key}-b`] }),
];

/** 一个根会话带 `kids` 个子会话：子树很高（每个子会话占一行）、只有两层。 */
const fanOf = (key: string, kids: number, from = 1): SessionSummary[] => [
  session(`${key}-root`, key, from),
  ...Array.from({ length: kids }, (_, i) => session(`${key}-kid-${i + 1}`, key, from + 1 + i, { parentSessionId: `${key}-root` })),
];

/** 一棵中等的树：根带 4 个子会话，第一个子会话再带 2 个（深两层，共 7 个）。 */
const medium = (key: string, name: string, from: number): SessionSummary[] => {
  const id = (suffix: string): string => `${key}:${name}${suffix}`;
  return [
    session(id(""), key, from),
    ...[1, 2, 3, 4].map((i) => session(id(`-${i}`), key, from + i, { parentSessionId: id("") })),
    session(id("-1a"), key, from + 5, { parentSessionId: id("-1") }),
    session(id("-1b"), key, from + 6, { parentSessionId: id("-1") }),
  ];
};

/** 嵌套三层：根带 3 个子会话，每个子会话再带 3 个孙会话（共 13 个）。 */
const nested = (key: string, name: string, from: number): SessionSummary[] => {
  const id = (suffix: string): string => `${key}:${name}${suffix}`;
  const list = [session(id(""), key, from)];
  let order = from;
  for (const kid of [1, 2, 3]) {
    list.push(session(id(`-${kid}`), key, ++order, { parentSessionId: id("") }));
    for (const grandkid of [1, 2, 3]) list.push(session(id(`-${kid}.${grandkid}`), key, ++order, { parentSessionId: id(`-${kid}`) }));
  }
  return list;
};

interface Scene {
  name: string;
  /** 会话每次现造：用例之间不共用数组与会话对象。 */
  sessions: () => SessionSummary[];
  /** 场景自己带的选项（visible、collapsed、git）；Set 与 Map 同样每次现造，参数是刚造出来的那批会话。 */
  extra?: (sessions: readonly SessionSummary[]) => LayoutOptions;
}

const sessionsHidden = (): SessionSummary[] => [...singles("o:b", 3, 1), ...singles("o:a", 14, 10), ...tree("o:c", "t", 40)];
const sessionsFiltered = (): SessionSummary[] => [...singles("o:a", 16, 1), ...tree("o:a", "t", 30)];

const SCENES: readonly Scene[] = [
  { name: "7 个单卡", sessions: () => singles("cursor:seven", 7) },
  { name: "24 个单卡", sessions: () => singles("cursor:big", 24) },
  { name: "单卡加一棵深浅不一的子树", sessions: () => [...singles("cursor:mix", 20), ...tree("cursor:mix", "t", 21)] },
  {
    name: "只有子树",
    sessions: () => [...tree("cursor:trees", "p", 1), ...tree("cursor:trees", "q", 20), ...tree("cursor:trees", "r", 40), ...tree("cursor:trees", "s", 60)],
  },
  // 来源卡放在网格上方比放在左边多占一行高：子树很高时网格比经典排法更不利，试算过了也要保持经典（不更优就不换）。
  { name: "一棵很高的子树", sessions: () => fanOf("cursor:fan", 10) },
  { name: "三个来源各 10 个单卡", sessions: () => [...singles("cursor:a", 10, 1), ...singles("cursor:b", 10, 101), ...singles("cursor:c", 10, 201)] },
  {
    name: "三个来源：只有单卡、只有子树、两者都有",
    sessions: () => [...singles("cursor:a", 16, 1), ...tree("cursor:b", "t", 101), ...tree("cursor:b", "u", 120), ...singles("cursor:c", 9, 201), ...tree("cursor:c", "v", 230)],
  },
  { name: "汇聚的会话被推到更右的列", sessions: () => [...singles("cursor:push", 14, 1), ...pushed("cursor:push", 30)] },
  {
    name: "汇聚：另一个上级在别的来源块里",
    sessions: () => [
      ...singles("cursor:a", 14, 1),
      session("a-root", "cursor:a", 20),
      session("a-kid", "cursor:a", 21, { parentSessionId: "a-root" }),
      ...singles("codex:b", 8, 30),
      session("b-join", "codex:b", 40, { parentSessionId: "a-kid", parentSessionIds: ["a-kid", "codex:b-1"] }),
    ],
  },
  {
    name: "数据异常：上下级互指与自指",
    sessions: () => [
      ...singles("cursor:c", 12, 1),
      session("x1", "cursor:c", 20, { parentSessionId: "x2" }),
      session("x2", "cursor:c", 21, { parentSessionId: "x1" }),
      session("x3", "cursor:c", 22, { parentSessionId: "x3" }),
    ],
  },
  {
    name: "被隐藏的来源只剩一张来源卡",
    sessions: sessionsHidden,
    extra: (all) => ({ visible: new Set(all.filter((s) => s.origin.key !== "o:b").map((s) => s.id)), collapsed: new Set(["o:b"]) }),
  },
  {
    name: "按 visible 收起一部分单卡",
    sessions: sessionsFiltered,
    extra: (all) => ({ visible: new Set(all.filter((s) => !/^o:a-[1-6]$/.test(s.id)).map((s) => s.id)) }),
  },
  {
    name: "两个来源共用 Folder 与 Git 卡",
    sessions: () => [
      ...Array.from({ length: 14 }, (_, i) => inDir(`s${i + 1}`, "cursor:big", i + 1, REPO)),
      ...Array.from({ length: 6 }, (_, i) => inDir(`t${i + 1}`, "codex:other", 100 + i, REPO)),
    ],
    extra: () => ({
      git: new Map([
        ["cursor:big", "wt:repo"],
        ["codex:other", "wt:repo"],
      ]),
    }),
  },
  // 以下 5 个是排布重做时新增的形状（2026-11-22）：
  { name: "一个父会话带 32 个子会话", sessions: () => fanOf("cursor:wide", 32) },
  {
    name: "多棵中等的树加许多单卡",
    sessions: () => [...singles("cursor:forest", 24, 1), ...medium("cursor:forest", "m1", 30), ...medium("cursor:forest", "m2", 40), ...medium("cursor:forest", "m3", 50), ...medium("cursor:forest", "m4", 60), ...medium("cursor:forest", "m5", 70)],
  },
  { name: "嵌套三层", sessions: () => [...nested("cursor:deep", "n1", 1), ...nested("cursor:deep", "n2", 20), ...singles("cursor:deep", 8, 40)] },
  {
    name: "四个来源并排：单卡、小树、一个父会话带很多子会话、只有一个会话",
    sessions: () => [
      ...singles("cursor:a", 12, 1),
      ...medium("cursor:b", "m1", 101),
      ...medium("cursor:b", "m2", 110),
      ...medium("cursor:b", "m3", 120),
      ...fanOf("cursor:c", 8, 201),
      ...singles("cursor:d", 1, 301),
    ],
  },
  {
    name: "一百多个会话：单卡与小树混排",
    sessions: () => [...singles("cursor:crowd", 70, 1), ...Array.from({ length: 8 }, (_, i) => medium("cursor:crowd", `m${i + 1}`, 100 + i * 10)).flat()],
  },
];

const VARIANTS: readonly { name: string; options: LayoutOptions }[] = [
  { name: "桌面 · 默认缩放上限", options: { area: AREA, grid: true, hideContextNodes: true } },
  { name: "桌面 · 缩放上限 0.5", options: { area: AREA, grid: true, hideContextNodes: true, zoom: 0.5 } },
  { name: "桌面 · 缩放上限 1.6", options: { area: AREA, grid: true, hideContextNodes: true, zoom: 1.6 } },
  { name: "宽屏 · 画 Folder 与 Git 卡", options: { area: WIDE, grid: true } },
  { name: "窄区域（紧凑模式）", options: { area: NARROW, grid: true } },
  { name: "不规划（经典排法）", options: { area: AREA } },
  { name: "窗口很矮", options: { area: SHORT, grid: true, hideContextNodes: true } },
  { name: "竖屏的窄窗口", options: { area: PORTRAIT, grid: true, hideContextNodes: true } },
];

/** 全部 144 个用例（18 个场景 × 8 个取景变体）；名字是“场景名 · 变体名”，彼此不同。 */
export function goldenCases(): GoldenCase[] {
  return SCENES.flatMap((scene) =>
    VARIANTS.map((variant): GoldenCase => {
      const sessions = scene.sessions();
      return { name: `${scene.name} · ${variant.name}`, sessions, options: { ...variant.options, ...scene.extra?.(sessions) } };
    }),
  );
}

/**
 * 把一个值规范成与书写次序无关的形状，供 `JSON.stringify` 得到确定的文本：
 * 对象的键排序、值为 `undefined` 的键丢掉（缺省与 `undefined` 等价）；数组保持原次序（节点与连线的次序是契约）；
 * `Set` 变成排序后的数组（成员的插入次序不是契约）。除此之外不认识的值（Map、Date、函数……）直接报错，免得悄悄被当成 `{}`。
 */
function canonical(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((member) => canonical(member));
  const tag = Object.prototype.toString.call(value);
  if (tag === "[object Set]") {
    return [...(value as ReadonlySet<unknown>)]
      .map((member) => canonical(member))
      .map((member) => ({ member, text: JSON.stringify(member) }))
      .sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0))
      .map(({ member }) => member);
  }
  if (tag === "[object Object]") {
    const entries: [string, unknown][] = [];
    for (const key of Object.keys(value as object).sort()) {
      const member = canonical((value as Record<string, unknown>)[key]);
      if (member !== undefined) entries.push([key, member]);
    }
    return Object.fromEntries(entries);
  }
  throw new TypeError(`digestOf 不认识的值：${tag}`);
}

/** 把一份布局压成摘要：`hash` 管住全部内容（见 LayoutDigest），其余几项是给人看的。 */
export function digestOf(layout: SceneLayout): LayoutDigest {
  return {
    hash: createHash("sha256").update(JSON.stringify(canonical(layout)), "utf8").digest("hex"),
    nodes: layout.nodes.length,
    edges: layout.edges.length,
    bounds: { ...layout.bounds },
    grid: layout.grid === true,
    fitAll: layout.fitAll === true,
  };
}
