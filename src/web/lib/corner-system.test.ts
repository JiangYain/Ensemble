import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CURVE,
  ICON_TABLE,
  bulletProblems,
  bulletlessClasses,
  codeViolations,
  cssViolations,
  curvedLiterals,
  iconPaths,
  invisibleInputs,
  isZeroRadius,
  scrollbarViolations,
  stripCode,
  stripCss,
  svgViolations,
} from "./corner-system.scan";

/**
 * 零圆角守卫：读源码文本，不渲染。
 * 本文件读仓库、对照例外表（KEPT、CURVED_ICONS、BRAND_SVG_DIR）；检测器是 corner-system.scan.ts 里的纯函数，检测器自己的自检（样本文本，不读仓库）在 corner-system.selfcheck.test.ts。
 *
 * Ensemble 的网页没有圆角——不是“圆角很小”，是没有。这里防止它悄悄长回来，范围是 src/web 下所有的样式表、非测试的 TS / TSX / HTML 与 SVG：
 *  · CSS：任何 `*-radius`（含各角的写法、简写、`-webkit-` 前缀、变量、!important，写在 @media / @supports 里也一样）只能是 0；不存在 `--r-*` / `--seg-r` / `--corner` 或名字里带 radius 的变量，
 *    `rx` / `ry` 属性为 0；不用 corner-shape；clip-path 不带 round / circle() / ellipse()，任何 path("…") 里没有曲线命令；
 *    径向渐变不写 circle（不论它在第一个参数的哪个位置，如 `closest-side circle`），也不写“只给一个长度、没有形状”的圆（`radial-gradient(20px at …)`）；conic-gradient 不用；
 *    项目符号不是 disc / circle，不用点线（dotted，较粗时是圆点），不把 <circle> / <ellipse> 内联在 data URI 里；
 *    `content` 里没有 ● ○ ◯ ⏺ ◌ ⭕ 与 🔴 🟢 之类的圆形字符（含 CSS / JS 转义与 HTML 实体）；线帽与线角不是 round；
 *  · 浏览器自己画的滚动条：scrollbar-width / scrollbar-color 会让 Chromium 放弃 ::-webkit-scrollbar（拇指就成了圆头），所以只能写在不认 ::-webkit-scrollbar 的浏览器里（`scrollbar-width: none` 除外：根本不画滚动条）；
 *  · TS / TSX / HTML：没有 borderRadius / borderTopLeftRadius / WebkitBorderRadius / border-radius、名字里带 radius 的变量、非 0 的 rx / ry、<circle> / <ellipse>（写成字符串 "circle" 也算）、
 *    画布的 arc / ellipse / roundRect、<progress> / <meter> / type="range" 这类自带圆形外观的原生控件、圆头线帽与圆角线角、圆形字符；
 *  · 图标与自绘图形的路径数据：除 CURVED_ICONS 里的几枚（曲率本身就是图形），路径里不能出现曲线命令（C S Q T A）；
 *  · 列表：写成 <ul className="…"> 的列表，类名里至少有一个声明了 list-style: none（或 square），否则浏览器默认画实心圆点；
 *  · 原生 radio / checkbox：藏在自绘外观后面的（opacity: 0 盖在上面的），规则里显式写 border-radius: 0——原生单选框自带 50% 的半径，不写的话上面的扫描看不见；
 *  · SVG 文件：同上。
 *
 * 用量环已经是方环（一条方形路径上的几截平头、尖角的虚线，没有 <circle>），不再是例外，见下面“用量环”那一条。
 * 例外只有 KEPT 与 CURVED_ICONS 里列出的，以及按目录放行的第三方品牌标与模型标（BRAND_SVG_DIR，即 src/web/marks/ 下的 .svg，形状是别人的商标与官方矢量；同目录的 brand.css 照常扫），每一项都写明了为什么留；守卫同时核对例外是否还在，过期的例外也会红——
 * 要新增例外，先在这里写理由。间隔号 “·” 是标点（文案里的分隔符），不是图形，不在检查之内。
 * 守卫是读文本的，抓不到的写在这里，别当成“已经保证”：用 ellipse 写、却放进方形盒子里的渐变（要靠评审）；运行时拼出来的样式字符串；浏览器自己画的控件（下拉框的展开列表等）。
 * 原先的圆角体系（--corner、--r-*、corner-shape 与 editorial.css 末尾的 @supports 块）已整体删除，这里不再为它做任何断言。
 * 扫描范围里只有一份文件被排除：检测器 corner-system.scan.ts（见 SCAN_SOURCE）。它是非测试的 .ts，正则字面量里写着 border-radius、● 之类，扫它等于扫自己；它只含纯函数、不含界面代码。
 */

const ROOT = "src/web";

// ───────────────────────── 要扫的文件，与例外 ─────────────────────────

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

/**
 * 守卫自己的检测器（corner-system.scan.ts）：它不叫 *.test.ts（两份测试都要从它导入），所以会落进下面“非测试的 TS / TSX / HTML”的范围，
 * 而里面的正则字面量写着 border-radius、corner-shape、--seg-r 之类的圆角写法，还有 ● 之类的圆形字符——扫它等于扫自己，必然命中。
 * 所以只排除这一份：精确路径，不用前缀或通配，范围里其余的文件一个都没少。样本文本（自检里的“border-radius: 4px”之类）只能写在 *.test.ts 里，那些从不被扫。
 */
const SCAN_SOURCE = `${ROOT}/lib/corner-system.scan.ts`;

const read = (file: string): string => readFileSync(file, "utf8");
const files = walk(ROOT);
const cssFiles = files.filter((file) => file.endsWith(".css"));
// 非测试的 TS / TSX / HTML：只多排除守卫自己的检测器 SCAN_SOURCE（理由见上），其余一个都不少。
const codeFiles = files.filter((file) => /\.(?:tsx?|html)$/.test(file) && !/\.test\.tsx?$/.test(file) && file !== SCAN_SOURCE);
const svgFiles = files.filter((file) => file.endsWith(".svg"));

const ICONS = `${ROOT}/components/Icons.tsx`;

/**
 * 第三方 / 厂商的品牌标志与模型标：形状是别人的商标与官方矢量，不为“直角”去改（底板、描边与容器里的圆角都保持原样）。
 * 只免 marks/ 下的 .svg；同目录的 brand.css（品牌色层）照常扫。
 */
const BRAND_SVG_DIR = `${ROOT}/marks/`;
const isBrandSvg = (file: string): boolean => file.startsWith(BRAND_SVG_DIR) && file.endsWith(".svg");

interface Kept {
  file: string;
  /** 放行的检出：只放这些，同一个文件里别的圆角照样红。 */
  allow: RegExp;
  why: string;
}

const KEPT: readonly Kept[] = [
  {
    file: `${ROOT}/public/favicon.svg`,
    allow: /./,
    why: "浏览器标签页图标：index.html 里是空图标（data:,），没有任何地方引用它，仍是旧版的圆角底板与圆点；没有重画，等用户决定是重画成直角还是删掉。",
  },
];
const keptFiles = new Set(KEPT.map((kept) => kept.file));
const unlessKept = (file: string, findings: string[]): string[] => {
  const kept = KEPT.find((item) => item.file === file);
  return kept ? findings.filter((finding) => !kept.allow.test(finding)) : findings;
};

/** Icons.tsx 里仍带曲线的图标：曲率本身就是图形。轮廓里的圆角（文件夹、窗口、键盘、插头……）一律已是直角。 */
const CURVED_ICONS: Readonly<Record<string, string>> = {
  clock: "钟面是圆，指针是直线",
  refresh: "刷新是一段弧加箭头，弧就是“循环”",
  search: "放大镜的镜片是圆",
  globe: "地球是圆加经线",
  info: "信息标是圆里一个 i",
  eye: "眼眶与瞳孔",
  eyeOff: "眼眶（同一条曲线）加一道斜线",
  settings: "齿轮：齿顶与齿根各是一段圆弧，中心孔是圆",
  user: "人像：头是圆、肩是弧",
  hand: "手：指尖与手掌的有机轮廓",
};

const offenders = (list: string[], scan: (source: string) => string[]): string[] =>
  list.flatMap((file) => unlessKept(file, scan(read(file))).map((finding) => `${file}: ${finding}`));

// ───────────────────────── 守卫 ─────────────────────────

describe("零圆角守卫 · 样式表", () => {
  it("扫得到文件（目录改了名这条会先红，免得守卫变成空转）", () => {
    expect(cssFiles.length).toBeGreaterThan(10);
    expect(cssFiles).toContain(`${ROOT}/styles/scene.css`);
    expect(cssFiles).toContain(`${ROOT}/styles/workspace.css`);
    expect(codeFiles.length).toBeGreaterThan(50);
  });

  it("任何 *-radius 声明都是 0；没有圆角变量、corner-shape、圆形剪裁 / 渐变 / 项目符号 / 点线 / 内联圆 / 字符、圆头线帽", () => {
    expect(offenders(cssFiles, cssViolations)).toEqual([]);
  });

  it("表单控件显式清零圆角（有的浏览器与系统主题会给控件自带圆角，不指望“没声明就是直角”）", () => {
    const base = stripCss(read(`${ROOT}/styles/base.css`));
    expect(base).toMatch(/input,\s*textarea,\s*select\s*\{[^}]*border-radius:\s*0\s*;/);
    expect(base).toMatch(/(?:^|\n)button\s*\{[^}]*border-radius:\s*0\s*;/);
  });

  it("隐形的原生单选 / 复选框（opacity: 0 盖在自绘外观上）也显式写着 border-radius: 0：它们自带 50% 的半径，源码里不写，扫描就看不见", () => {
    const found = cssFiles.flatMap((file) => invisibleInputs(read(file)).map((rule) => ({ file, ...rule })));
    // 现在有五条：问句卡一条（单选与多选并列）、模型勾选三条（.mrow-input / .echip-input / .mpick-input）、留存开关一条（.retention-input）。
    // 下限取 3 而不是 5：某个控件被改版删掉不该让守卫红；掉到 3 以下，说明扫描失灵或样式表改了结构，回来看。
    expect(found.length).toBeGreaterThanOrEqual(3);
    const missing = found.filter(({ radius }) => radius === undefined || !isZeroRadius(radius)).map(({ file, selector }) => `${file}: ${selector}`);
    expect(missing, "这些规则要加一行 border-radius: 0;").toEqual([]);
  });

  it("滚动条拇指是直角：scrollbar-width / scrollbar-color 只写在不认 ::-webkit-scrollbar 的浏览器里", () => {
    expect(offenders(cssFiles, scrollbarViolations)).toEqual([]);
    const base = stripCss(read(`${ROOT}/styles/base.css`));
    expect(base).toMatch(/::-webkit-scrollbar-thumb\s*\{/);
    expect(base).toMatch(/@supports\s+not\s+selector\(\s*::-webkit-scrollbar\s*\)/);
  });
});

describe("零圆角守卫 · TS / TSX / HTML", () => {
  it("没有 borderRadius 及其驼峰 / 前缀写法、非 0 的 rx / ry、<circle> / <ellipse>（含字符串写法）、画布圆弧、圆形的原生控件、圆头线帽与圆角线角、圆形字符", () => {
    expect(offenders(codeFiles, codeViolations)).toEqual([]);
  });

  it("写成 <ul className=\"…\"> 的列表，类名里至少有一个声明了 list-style: none（或 square）：浏览器默认的实心圆点不能漏进来", () => {
    const safe = new Set(cssFiles.flatMap((file) => bulletlessClasses(read(file))));
    // 现在有十一个（.ctx-list、.attn-list、.msg-log、.files、.usage-legend、.access-list、.mlist、.q-picks、.prof-list、.plan-list、.dl-steps）。
    // 下限取 5：个别列表被删掉不该让守卫红；掉到 5 以下，说明扫描失灵或样式表改了结构，回来看。
    expect(safe.size).toBeGreaterThanOrEqual(5);
    expect(codeFiles.flatMap((file) => bulletProblems(read(file), safe).map((problem) => `${file}: ${problem}`))).toEqual([]);
  });

  it("字面写出的路径数据里没有曲线命令（Icons.tsx 的 PATHS 表另见下一条）", () => {
    const found = codeFiles.flatMap((file) => {
      const source = file === ICONS ? read(file).replace(ICON_TABLE, "") : read(file);
      return unlessKept(file, curvedLiterals(source)).map((d) => `${file}: ${d.slice(0, 24)}…`);
    });
    expect(found).toEqual([]);
  });

  it("Icons.tsx：带曲线的图标正好是 CURVED_ICONS 里的这几枚，其余全是直线", () => {
    const paths = iconPaths(read(ICONS));
    expect(Object.keys(paths).length).toBeGreaterThan(50);
    const curved = Object.entries(paths).filter(([, d]) => CURVE.test(d)).map(([name]) => name).sort();
    expect(curved).toEqual(Object.keys(CURVED_ICONS).sort());
  });

  it("图标的线帽是方头、线角是斜接：默认渲染里写明 square / miter", () => {
    const source = stripCode(read(ICONS));
    expect(source).toMatch(/strokeLinecap="square"\s+strokeLinejoin="miter"/);
  });
});

describe("零圆角守卫 · SVG 文件", () => {
  it("品牌标之外的 .svg 没有圆角、圆与曲线", () => {
    const own = svgFiles.filter((file) => !isBrandSvg(file));
    expect(offenders(own, svgViolations)).toEqual([]);
  });
});

describe("零圆角守卫 · 例外还在（过期的例外也会红）", () => {
  it("品牌标目录还在、里面确有 SVG：第三方形状不扫", () => {
    expect(svgFiles.filter(isBrandSvg).length).toBeGreaterThanOrEqual(10);
  });

  it("每一项例外都写着理由，文件还在，并且确实还有要放行的东西", () => {
    for (const kept of KEPT) {
      expect(kept.why.length, kept.file).toBeGreaterThan(20);
      expect(files, `${kept.file} 已不存在：把它从 KEPT 里拿掉`).toContain(kept.file);
      const raw = kept.file.endsWith(".svg") ? svgViolations(read(kept.file)) : codeViolations(read(kept.file));
      const excused = raw.filter((finding) => kept.allow.test(finding));
      expect(excused.length, `${kept.file} 里已经没有需要放行的东西：把它从 KEPT 里拿掉`).toBeGreaterThan(0);
    }
    expect([...keptFiles].sort()).toEqual(KEPT.map((kept) => kept.file).sort());
  });

  it("用量环是方环：UsageRing.tsx 里没有 <circle>，每一段是平头、尖角的虚线；容器与中心的合计没有圆角", () => {
    expect(read(`${ROOT}/components/UsageRing.tsx`)).not.toMatch(/<circle/);
    const sidebar = stripCss(read(`${ROOT}/styles/sidebar.css`));
    expect(sidebar).toMatch(/\.usage-seg\s*\{[^}]*stroke-linecap:\s*butt/);
    expect(sidebar).toMatch(/\.usage-seg\s*\{[^}]*stroke-linejoin:\s*miter/);
    expect(sidebar).not.toMatch(/\.usage-[\w-]+\s*\{[^}]*radius/);
  });

  it("CURVED_ICONS 每一项都写着理由", () => {
    for (const [name, why] of Object.entries(CURVED_ICONS)) expect(why.length, name).toBeGreaterThan(3);
  });
});
