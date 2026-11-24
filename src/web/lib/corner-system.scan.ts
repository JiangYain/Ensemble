/**
 * 零圆角守卫的检测器：纯函数，输入一段源码文本（样式表、TS / TSX / HTML、SVG），输出它抓到的违规；不读仓库，也不依赖测试框架。
 * 读仓库的守卫（corner-system.test.ts）拿它扫 src/web；它自己的自检（corner-system.selfcheck.test.ts）拿样本文本调用它。
 * 各条规则抓什么、扫描范围与例外，见 corner-system.test.ts 的头注释。
 *
 * 它不叫 *.test.ts，是因为两份测试都要从这里导入：导入一个测试文件会把它的用例在导入方里再注册一遍。
 * 代价是守卫扫“非测试的 TS / TSX / HTML”时会扫到它：下面的正则字面量写着 border-radius、corner-shape、--seg-r 之类的圆角写法，还有 ● 之类的圆形字符，扫它等于扫自己，必然命中，
 * 所以 corner-system.test.ts 的 codeFiles 只排除这一份（SCAN_SOURCE，精确路径，不用前缀或通配）。由此：
 *  · 这里只放检测器，不放任何会被当成界面代码的东西——这个文件不在零圆角守卫的扫描之内；
 *  · 样本文本（“border-radius: 4px”之类）只能写在 *.test.ts 里，那些从不被扫；
 *  · 改名或挪走这个文件时，同步改 SCAN_SOURCE（忘了改，守卫会因为扫到它而变红）。
 */

// ───────────────────────── 检测器：纯函数，既用来扫仓库，也用样本文本自测 ─────────────────────────

export const stripCss = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
/** 去掉块注释与行注释；`://` 前面是冒号的不算行注释（网址）。 */
export const stripCode = (code: string): string => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
const stripMarkup = (text: string): string => text.replace(/<!--[\s\S]*?-->/g, "");

/**
 * 圆形的字符：拿它当图形用就是圆点（间隔号 “·” 是标点，不在此列）。
 * 字符类里只放基本平面的字符；🔘 🔴 🟢 这类要用两个 UTF-16 单元表示的得逐个列出——放进字符类会连同它们共用的高位代理一起，把 🚀 之类的别的 emoji 也抓成圆。
 * 后半是转义写法：CSS 的 \25CF、JS 的 \u25CF / \u{25CF}，以及 HTML 实体（&bull; 等）。
 */
const ROUND_GLYPHS =
  /[●○◯⬤◉•⚫⚪◦⏺◌⭕⚬⭘]|🔘|🔴|🔵|🟠|🟡|🟢|🟣|🟤|\\(?:u\{?)?(?:25CF|25CB|25EF|2B24|25C9|2022|26AB|26AA|25E6|23FA|25CC|2B55|26AC|2B58|1F534|1F535|1F7E[0-4]|1F518)|&(?:bull|#(?:x2022|8226|x25CF|9679|x25CB|9675));/i;

const ZERO = /^0(?:\.0+)?(?:px|%|em|rem)?$/;

/** 圆角的值是不是 0：各角、斜杠两侧的每一项都得是 0；initial / unset 回到初始值，也是 0。 */
export function isZeroRadius(raw: string): boolean {
  const value = raw.replace(/!important/i, "").trim().toLowerCase();
  if (value === "initial" || value === "unset") return true;
  const parts = value.split(/[\s/]+/).filter(Boolean);
  return parts.length > 0 && parts.every((part) => ZERO.test(part));
}

/**
 * 每个 radial-gradient( 的第一个参数：从左括号到第一个顶层逗号（括号配对，所以 calc() / var() 里的逗号不会截断它）。
 * 径向渐变的形状与大小只能写在第一个参数里；第一个参数里没有形状的，第一项就已经是色标了。
 */
function radialGradientHeads(css: string): string[] {
  const heads: string[] = [];
  for (const m of css.matchAll(/radial-gradient\(/gi)) {
    let depth = 0;
    let head = "";
    for (let i = (m.index ?? 0) + m[0].length; i < css.length; i++) {
      const ch = css[i]!;
      if (ch === "(") depth++;
      else if (ch === ")") {
        if (depth === 0) break;
        depth--;
      } else if (ch === "," && depth === 0) break;
      head += ch;
    }
    heads.push(head);
  }
  return heads;
}

/**
 * CSS 里径向渐变只有两种写法是圆：关键字 circle，或形状不写、位置之前只给一个长度（半径）。
 * 写成 ellipse、两个长度、或干脆省略（默认是椭圆）都不是“圆”这种类型；方盒子里的椭圆看起来仍是圆，那是版式问题，不是这条守卫能判的。
 */
function isCircularHead(head: string): boolean {
  if (/\bcircle\b/i.test(head)) return true;
  const size = head.replace(/\bat\b[\s\S]*$/i, "").replace(/\b(?:closest|farthest)-(?:side|corner)\b/gi, "").trim();
  return /^[\d.]+(?:px|r?em|vw|vh|vmin|vmax|ch|ex|cm|mm|in|pt|pc)$/i.test(size);
}

export function cssViolations(source: string): string[] {
  const css = stripCss(source);
  const out: string[] = [];
  for (const m of css.matchAll(/(?<![\w-])((?:-[a-z]+-)?(?:[a-z]+-)*radius)\s*:\s*([^;}]*)/gi)) {
    if (!isZeroRadius(m[2]!)) out.push(`${m[1]!}: ${m[2]!.trim()}`);
  }
  // SVG 几何属性 rx / ry 也能写在 CSS 里（auto = 不倒角）。
  for (const m of css.matchAll(/(?<![\w-])(?:rx|ry)\s*:\s*([^;}]*)/gi)) {
    if (!/^auto\b/i.test(m[1]!.trim()) && !isZeroRadius(m[1]!)) out.push(`rx / ry：${m[0].trim()}`);
  }
  for (const m of css.matchAll(/--[\w-]*radius[\w-]*|--r-[a-z][\w-]*|--seg-r\b|--corner\b|corner-shape|superellipse/gi)) out.push(`圆角体系的残留：${m[0]}`);
  for (const m of css.matchAll(/clip-path\s*:[^;}]*/gi)) {
    if (/round|circle\(|ellipse\(/i.test(m[0])) out.push(m[0].trim());
  }
  // path("…")（clip-path、offset-path 等）里的曲线命令：一段 A / C / Q 就能画出圆。
  for (const m of css.matchAll(/path\(\s*(?:(?:evenodd|nonzero)\s*,\s*)?(["'])(.*?)\1/gi)) {
    if (CURVE.test(m[2]!)) out.push(`曲线路径：path(${m[2]!.slice(0, 24)}…`);
  }
  for (const m of css.matchAll(/stroke-line(?:cap|join)\s*:\s*round/gi)) out.push(m[0]);
  for (const m of css.matchAll(/conic-gradient/gi)) out.push(`用渐变画圆：${m[0]}`);
  for (const head of radialGradientHeads(css)) {
    if (isCircularHead(head)) out.push(`用渐变画圆：radial-gradient(${head.trim()}…`);
  }
  for (const m of css.matchAll(/(?<![\w-])list-style(?:-type)?\s*:\s*([^;}]*)/gi)) {
    if (/\b(?:disc|circle)\b/i.test(m[1]!)) out.push(`圆形的项目符号：${m[0].trim()}`);
  }
  for (const m of css.matchAll(/(?<![\w-])(?:border|outline|text-decoration|column-rule)[\w-]*\s*:[^;{}]*\bdotted\b/gi)) out.push(`点线（较粗时画成圆点）：${m[0].trim()}`);
  for (const m of css.matchAll(/(?:<|%3C)(?:circle|ellipse)\b/gi)) out.push(`内联在 CSS 里的 SVG 圆：${m[0]}`);
  const glyph = ROUND_GLYPHS.exec(css);
  if (glyph) out.push(`圆形字符：${glyph[0]}`);
  return out;
}

/** 某个位置是否落在 `@supports not selector(::-webkit-scrollbar) { … }` 这个块里。 */
function insideNoWebkitScrollbar(css: string, index: number): boolean {
  const opener = /@supports\s+not\s+selector\(\s*::-webkit-scrollbar\s*\)\s*\{/g;
  for (let m = opener.exec(css); m; m = opener.exec(css)) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    if (index >= m.index && index < i) return true;
  }
  return false;
}

export function scrollbarViolations(source: string): string[] {
  const css = stripCss(source);
  return [...css.matchAll(/scrollbar-(?:width|color)\s*:\s*[^;}]*/g)]
    // scrollbar-width: none 是根本不画滚动条，没有拇指可言，不在此列。
    .filter((m) => !/^scrollbar-width\s*:\s*none\s*(?:!important)?$/i.test(m[0].trim()))
    .filter((m) => !insideNoWebkitScrollbar(css, m.index ?? 0))
    .map((m) => `${m[0].trim()} 写在 @supports not selector(::-webkit-scrollbar) 之外`);
}

/**
 * 代码里圆角的各种写法：驼峰（borderRadius / borderTopLeftRadius / WebkitBorderRadius）、短横线（border-radius、任何 *-radius:）、
 * 样式字符串与模板字符串里的 border-radius、名字里带 radius 的变量（"--tab-radius"）、老的圆角 token。
 */
const RADIUS_IN_CODE =
  /[A-Za-z]*[Bb]order[A-Za-z]*Radius|border-radius|[A-Za-z]+-radius\s*:|--[\w-]*radius|corner-shape|superellipse|--r-[a-z][\w-]*|--seg-r\b|--corner\b/g;

export function codeViolations(source: string): string[] {
  const code = stripCode(stripMarkup(source));
  const out: string[] = [];
  for (const m of code.matchAll(RADIUS_IN_CODE)) out.push(`圆角：${m[0]}`);
  for (const m of code.matchAll(/\b(?:rx|ry)=(?:"([^"]*)"|\{([^}]*)\})/g)) {
    if (!ZERO.test((m[1] ?? m[2] ?? "").trim())) out.push(m[0]);
  }
  for (const m of code.matchAll(/<(?:circle|ellipse)\b/g)) out.push(m[0]);
  // 元素名写成字符串（createElementNS(ns, "circle")、const Tag = "ellipse"）：上一条的 <circle 看不见它。
  for (const m of code.matchAll(/(["'`])(?:circle|ellipse)\1/g)) out.push(`圆形元素的名字写成了字符串：${m[0]}`);
  for (const m of code.matchAll(/\.(?:arc|arcTo|ellipse|roundRect)\(/g)) out.push(`画布 / Path2D 的圆弧接口：${m[0]}`);
  // 这几种原生控件在 Chromium 里自带圆角或圆形的外观（进度条的槽、滑块的圆钮）；要用就自己画。
  for (const m of code.matchAll(/<(?:progress|meter)\b|type=(?:"range"|'range'|\{["']range["']\})/g)) out.push(`自带圆形外观的原生控件：${m[0]}`);
  for (const m of code.matchAll(/(?:strokeLinecap|strokeLinejoin|stroke-linecap|stroke-linejoin)\W{1,6}round/g)) out.push(m[0]);
  const glyph = ROUND_GLYPHS.exec(code);
  if (glyph) out.push(`圆形字符：${glyph[0]}`);
  return out;
}

/** 路径数据：以 M x y 起笔、只含路径命令与数字。 */
const PATH_DATA = /^[Mm]\s*-?[\d.]+[\s,]+-?[\d.]+[MmLlHhVvCcSsQqTtAaZz\d\s.,+\-eE]*$/;
export const CURVE = /[CcSsQqTtAa]/;

/** 源码里字面写出的、带曲线命令的路径数据。 */
export function curvedLiterals(source: string): string[] {
  return [...stripCode(source).matchAll(/(["'`])([^"'`\n]+)\1/g)].map((m) => m[2]!.trim()).filter((text) => PATH_DATA.test(text) && CURVE.test(text));
}

export function svgViolations(source: string): string[] {
  const svg = stripMarkup(source);
  const out: string[] = [];
  for (const m of svg.matchAll(/\b(?:rx|ry)="([^"]*)"/g)) {
    if (!ZERO.test(m[1]!.trim())) out.push(m[0]);
  }
  for (const m of svg.matchAll(/<(?:circle|ellipse)\b/g)) out.push(m[0]);
  for (const m of svg.matchAll(/stroke-line(?:cap|join)="round"/g)) out.push(m[0]);
  for (const m of svg.matchAll(/\sd="([^"]+)"/g)) {
    if (CURVE.test(m[1]!)) out.push(`曲线路径：${m[1]!.slice(0, 24)}…`);
  }
  return out;
}

/** 样式表里的每一条规则：选择器（空白折成一格）与声明块。@media / @supports 里的规则也在内（只取最里面一层）。 */
function cssRules(source: string): Array<{ selector: string; body: string }> {
  return [...stripCss(source).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.replace(/\s+/g, " ").trim(), body: m[2]! }));
}

/**
 * 藏在自绘外观后面的原生输入框：选择器里带 input（元素 input，或类名以 -input 结尾），声明里有 opacity: 0。
 * radius 是它声明的 border-radius（没写就是 undefined）：原生单选框自带 50% 的半径，不显式写成 0，别的扫描就看不见它。
 */
export function invisibleInputs(source: string): Array<{ selector: string; radius: string | undefined }> {
  return cssRules(source)
    .filter(({ selector, body }) => /(?:^|[\s,>+~])input\b|-input\b/.test(selector) && /(?<![\w-])opacity\s*:\s*0\s*(?:!important\s*)?(?:;|$)/i.test(body))
    .map(({ selector, body }) => ({ selector, radius: /(?<![\w-])border-radius\s*:\s*([^;]*)/i.exec(body)?.[1] }));
}

/** 样式表里声明了“不画实心圆点”（list-style: none / square）的类名：规则的选择器就是这个类本身，可带 ul 前缀。 */
export function bulletlessClasses(source: string): string[] {
  const classes: string[] = [];
  for (const { selector, body } of cssRules(source)) {
    if (!/(?<![\w-])list-style(?:-type)?\s*:\s*[^;}]*\b(?:none|square)\b/i.test(body)) continue;
    for (const item of selector.split(",")) {
      const name = /^\s*(?:ul)?\.([\w-]+)\s*$/.exec(item)?.[1];
      if (name) classes.push(name);
    }
  }
  return classes;
}

/** 每个 <ul …> 的开标签文本：花括号配对到 `>` 为止（属性值里的箭头函数 `=>` 自带一个 `>`，不能当成标签的结尾）。 */
function listOpenings(code: string): string[] {
  const tags: string[] = [];
  for (const m of code.matchAll(/<ul\b/g)) {
    const start = m.index ?? 0;
    let depth = 0;
    let end = start + m[0].length;
    for (; end < code.length; end++) {
      const ch = code[end];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) break;
    }
    tags.push(code.slice(start, end + 1));
  }
  return tags;
}

/**
 * 写成 <ul …> 的列表里，没有类名、或类名里没有一个声明了不画圆点的，各报一条：浏览器默认给 ul 画实心圆点（嵌套时是空心圆）。
 * 动态的 className={…} 看不出来，不报；<ol> 的默认是数字，不是圆，不查。
 */
export function bulletProblems(source: string, safe: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const tag of listOpenings(stripCode(stripMarkup(source)))) {
    if (/\bclassName=\{/.test(tag)) continue;
    const classes = /\bclassName="([^"]*)"/.exec(tag)?.[1];
    const label = tag.replace(/\s+/g, " ").slice(0, 60);
    if (classes === undefined) out.push(`${label}：没有类名，会画浏览器默认的圆点`);
    else if (!classes.split(/\s+/).some((name) => safe.has(name))) out.push(`${label}：这些类名都没有声明 list-style: none（或 square）`);
  }
  return out;
}

/** Icons.tsx 里 PATHS 表的每一项：名字 → 路径数据。 */
export const ICON_TABLE = /const PATHS = \{[\s\S]*?\n\} as const;/;
export function iconPaths(source: string): Record<string, string> {
  const table = ICON_TABLE.exec(stripCode(source))?.[0] ?? "";
  return Object.fromEntries([...table.matchAll(/\b([A-Za-z]+):\s*"([^"]+)"/g)].map((m): [string, string] => [m[1]!, m[2]!]));
}
