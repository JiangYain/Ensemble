import { describe, expect, it } from "vitest";
import {
  bulletProblems,
  bulletlessClasses,
  codeViolations,
  cssViolations,
  curvedLiterals,
  iconPaths,
  invisibleInputs,
  scrollbarViolations,
  svgViolations,
} from "./corner-system.scan";

/**
 * 零圆角守卫的自检：只用样本文本调用 corner-system.scan.ts 里的检测器，不读仓库——证明它们抓得到，也不误伤。
 * 样本里写着 border-radius: 4px、<circle>、● 这类违规写法，所以这份文件必须是 *.test.ts：读仓库的守卫（corner-system.test.ts）只扫非测试的源码，扫不到这里。
 * 检测器放在 corner-system.scan.ts，而不是留在 corner-system.test.ts 里：从另一个测试文件导入，会把那份文件的用例在这里再注册一遍。
 */

describe("守卫自己：抓得到，也不误伤（样本文本，不读仓库）", () => {
  it("CSS：非零圆角（各角、前缀、简写、变量、!important）与圆角体系的残留都会被抓到", () => {
    for (const sample of [
      ".a { border-radius: 4px }",
      ".a { border-radius: 50% }",
      ".a { border-radius: 999px !important }",
      ".a { border-top-left-radius: 2px }",
      ".a { border-start-start-radius: 2px }",
      ".a { -webkit-border-radius: 3px }",
      ".a { border-radius: var(--x) }",
      ".a { border-radius: inherit }",
      ".a { border-radius: 0 4px 0 0 }",
      ".a { border-radius: 0 / 4px }",
      // 写在 @media / @supports / 嵌套规则里也一样：扫的是整份样式表的文本，不看规则嵌了几层。
      "@media (min-width: 640px) { .a { border-radius: 4px } }",
      "@supports (display: grid) { .a { border-top-left-radius: 2px } }",
      ".a { & .b { border-radius: 50% } }",
      ":root { --r-ctl: 8px }",
      ".a { --card-radius: 8px }",
      ".a { corner-shape: superellipse(1.5) }",
      ".a { clip-path: inset(0 round 4px) }",
      ".a { clip-path: circle(50%) }",
      ".a { stroke-linecap: round }",
      ".a { stroke-linejoin: round }",
      ".a { background: radial-gradient(circle, #000 40%, transparent 41%) }",
      ".a { background: conic-gradient(#000, #fff) }",
      '.a::before { content: "●" }',
      '.a::before { content: "\\25CF" }',
    ]) {
      expect(cssViolations(sample), sample).not.toEqual([]);
    }
  });

  it("CSS：0、initial、注释里的字、方头线帽、椭圆形的辉光渐变、间隔号都不算", () => {
    for (const sample of [
      ".a { border-radius: 0 }",
      ".a { border-radius: 0px !important }",
      ".a { border-top-left-radius: 0 }",
      ".a { border-radius: 0 0 0 0 / 0 }",
      ".a { border-radius: initial }",
      "/* border-radius: 8px; --r-ctl; corner-shape: round; ● */ .a { color: red }",
      ".a { stroke-linecap: square; stroke-linejoin: miter }",
      ".a { stroke-linecap: butt }",
      ".a { background: radial-gradient(ellipse closest-side at 50% 50%, #000, transparent) }",
      '.a::before { content: "·" }',
      ".radius-note { color: red }",
    ]) {
      expect(cssViolations(sample), sample).toEqual([]);
    }
  });

  it("滚动条：标准属性写在 @supports not selector(::-webkit-scrollbar) 之外会被抓到，写在里面不算", () => {
    expect(scrollbarViolations("* { scrollbar-width: thin; }")).not.toEqual([]);
    expect(scrollbarViolations("html { scrollbar-color: red blue; }")).not.toEqual([]);
    expect(scrollbarViolations("@supports not selector(::-webkit-scrollbar) {\n  * { scrollbar-width: thin; scrollbar-color: red transparent; }\n}")).toEqual([]);
    expect(scrollbarViolations("@supports not selector(::-webkit-scrollbar) { * { scrollbar-width: thin; } }\nbody { scrollbar-width: thin; }")).not.toEqual([]);
    // none = 不画滚动条，没有拇指，不算
    expect(scrollbarViolations(".a { scrollbar-width: none; }")).toEqual([]);
    expect(scrollbarViolations(".a { scrollbar-width: none !important; }")).toEqual([]);
  });

  it("TS / TSX：borderRadius、rx / ry、<circle>、圆头线帽、圆形字符都会被抓到", () => {
    for (const sample of [
      "const style = { borderRadius: 4 };",
      'const s = "border-radius: 4px";',
      "const s = { 'border-radius': '4px' };",
      '<rect rx="2.6" />',
      "<rect ry={r} />",
      '<circle cx="1" cy="1" r="1" />',
      "<ellipse />",
      '<path strokeLinecap="round" />',
      "<path strokeLinejoin='round' />",
      '<path stroke-linecap="round" />',
      "const dot = '●';",
      'const v = "var(--r-ctl)";',
    ]) {
      expect(codeViolations(sample), sample).not.toEqual([]);
    }
  });

  it("TS / TSX：0、方头线帽、注释里的字、网址都不算", () => {
    for (const sample of [
      '<rect x="1" rx="0" />',
      "<rect rx={0} />",
      '<path strokeLinecap="square" strokeLinejoin="miter" />',
      "// borderRadius: 4 与 <circle> 只在注释里\nconst a = 1;",
      '/* rx="2" */ const a = 1;',
      "{/* <circle /> */}",
      "const s = 'https://example.com/a';",
      "const text = 'a · b';",
    ]) {
      expect(codeViolations(sample), sample).toEqual([]);
    }
  });

  it("路径：曲线命令抓得到，直线与普通字符串不误伤", () => {
    expect(curvedLiterals('const d = "M12 3a9 9 0 1 0 0 18";')).toHaveLength(1);
    expect(curvedLiterals("const d = 'M3.5 5.5C4 4 5 4 6 5';")).toHaveLength(1);
    expect(curvedLiterals('const d = "M3.5 5.5h5.6l2 2.2h9.4v11.8h-17z";')).toEqual([]);
    expect(curvedLiterals('const t = "Main Agent";')).toEqual([]);
    expect(curvedLiterals('const t = "M1";')).toEqual([]);
    expect(Object.keys(iconPaths('const PATHS = {\n  a: "M1 1h2",\n  b: "M1 1a2 2 0 1 0 0 4",\n} as const;'))).toEqual(["a", "b"]);
  });

  it("SVG：rx / ry、圆、曲线路径、圆头线帽会被抓到；直线与 rx=0 不算", () => {
    expect(svgViolations('<rect width="32" height="32" rx="8"/>')).not.toEqual([]);
    expect(svgViolations('<circle cx="1" cy="1" r="1"/>')).not.toEqual([]);
    expect(svgViolations('<path d="M1 1a2 2 0 0 1 2 2" stroke-linecap="round"/>')).toHaveLength(2);
    expect(svgViolations('<rect width="32" height="32" rx="0"/><path d="M1 1h4v4z"/><!-- <circle/> -->')).toEqual([]);
  });

  // ───── 下面是 2026-11-22 补的洞：每一条都先在现有源码里查过 0 命中（见各自的注释），再给出抓得到与不误伤的样本 ─────

  it("CSS：写成圆的径向渐变都会被抓到——circle 在第一个参数的任何位置、重复渐变、前缀、大小写、折行、mask、只给一个长度", () => {
    for (const sample of [
      ".a { background: radial-gradient(closest-side circle, #000, transparent) }",
      ".a { background: radial-gradient(circle at 20% 30%, #000, transparent) }",
      ".a { background: radial-gradient(farthest-corner circle at 0 0, #000, transparent) }",
      ".a { background: repeating-radial-gradient(circle, #000 0 2px, transparent 2px 6px) }",
      ".a { background: -webkit-radial-gradient(circle, #000, #fff) }",
      ".a { background: RADIAL-GRADIENT(CIRCLE, #000, #fff) }",
      ".a {\n  background:\n    radial-gradient(\n      circle at 50% 50%,\n      #000,\n      transparent\n    );\n}",
      ".a { background: radial-gradient(20px at 50% 50%, #000, transparent) }",
      ".a { background: radial-gradient(1.5rem, #000, transparent) }",
      ".a { mask-image: radial-gradient(closest-side circle, #000 60%, transparent) }",
      ".a { background: linear-gradient(#000, #fff), radial-gradient(circle, #000, #fff) }",
    ]) {
      expect(cssViolations(sample), sample).not.toEqual([]);
    }
  });

  it("CSS：椭圆（ellipse、两个长度、省略形状）、色标开头的径向渐变、线性渐变、注释里的 circle 都不算——画布的“氤氲”用的就是这几种", () => {
    for (const sample of [
      ".a { background: radial-gradient(ellipse closest-side at 50% 50%, #000, transparent) }",
      ".a { background: radial-gradient(ellipse 60% 50% at 20% 50%, rgba(0, 0, 0, 0.1), transparent 70%) }",
      ".a { background: radial-gradient(60px 40px at 50% 50%, #000, transparent) }",
      ".a { background: radial-gradient(farthest-corner at 50% 0, #000, transparent) }",
      ".a { background: radial-gradient(rgba(0, 0, 0, 0.1), transparent) }",
      ".a { background: radial-gradient(#000 40%, transparent 41%) }",
      ".a { background: radial-gradient(closest-side, #000, transparent) }",
      ".a { background: radial-gradient(var(--glow-size) at 50% 50%, #000, transparent) }",
      ".a { background: linear-gradient(90deg, #000, #fff) }",
      "/* radial-gradient(circle, #000, #fff) */ .a { color: red }",
    ]) {
      expect(cssViolations(sample), sample).toEqual([]);
    }
  });

  it("CSS：圆形的项目符号（list-style / list-style-type 里的 disc、circle）会被抓到；none、square、数字、箭头、别的 list-style-* 不算", () => {
    // rg "list-style" src/web --glob "*.css"：现有只有 none（十来处）与 content.css 里 .md ul 的 square，0 处 disc / circle。
    for (const sample of [
      "ul { list-style: disc }",
      "ul ul { list-style-type: circle; }",
      ".a { list-style: inside disc }",
      ".a { list-style: circle outside none }",
      ".a { LIST-STYLE: DISC }",
      ".a { list-style-type: disc !important }",
      ".a { list-style: url(dot.svg) disc }",
    ]) {
      expect(cssViolations(sample), sample).not.toEqual([]);
    }
    for (const sample of [
      "ul { list-style: none }",
      ".md ul { list-style-type: square; }",
      ".a { list-style: square inside }",
      "ol { list-style-type: decimal }",
      "ol { list-style-type: disclosure-closed }",
      ".a { list-style-position: inside }",
      ".a { list-style-image: none }",
    ]) {
      expect(cssViolations(sample), sample).toEqual([]);
    }
  });

  it("CSS：点线（border / outline / text-decoration / column-rule 里的 dotted，较粗时画成圆点）会被抓到；dashed、solid 与类名里的 dotted 不算", () => {
    // rg -i "dotted" src/web：0 命中。
    for (const sample of [
      ".a { border-bottom: 1px dotted #000 }",
      ".a { border: 2px dotted red }",
      ".a { border-style: dotted }",
      ".a { outline: 1px dotted var(--x) }",
      ".a { text-decoration: underline dotted }",
      ".a { text-decoration-style: dotted }",
      ".a { column-rule: 1px dotted #000 }",
      ".a { border-top: 1px DOTTED #000 }",
    ]) {
      expect(cssViolations(sample), sample).not.toEqual([]);
    }
    for (const sample of [
      ".a { border-bottom: 1px dashed #000 }",
      ".a { border: 1px solid red }",
      ".a { text-decoration: underline }",
      ".dotted { color: red }",
      ".border-dotted:hover { color: red }",
    ]) {
      expect(cssViolations(sample), sample).toEqual([]);
    }
  });

  it("CSS：rx / ry 写成样式（SVG 几何属性）非 0 会被抓到；0、auto 不算", () => {
    // rg "(?<![\w-])r[xy]\s*:" src/web --glob "*.css" -P：0 命中。
    for (const sample of ["rect { rx: 4px }", ".a { ry: 50% }", ".a { rx: 2; ry: 2 }", "rect { RX: 3px }"]) {
      expect(cssViolations(sample), sample).not.toEqual([]);
    }
    for (const sample of ["rect { rx: 0 }", "rect { rx: auto; ry: auto }", "rect { rx: 0px; ry: 0 }", ".entry { color: red }", ".a { stroke-dasharray: 1 }"]) {
      expect(cssViolations(sample), sample).toEqual([]);
    }
  });

  it("CSS：clip-path / offset-path 里 path(\"…\") 的曲线命令会被抓到；直线路径与多边形不算", () => {
    // rg "path\(" src/web --glob "*.css"：0 命中。
    for (const sample of [
      ".a { clip-path: path('M0 0 A5 5 0 1 0 10 0') }",
      '.a { offset-path: path("M0 0 C 10 0 10 10 0 10") }',
      '.a { clip-path: path(evenodd, "M0 0 Q 5 5 10 0") }',
      '.a { clip-path: path("M0 0 s 5 5 10 0") }',
    ]) {
      expect(cssViolations(sample), sample).not.toEqual([]);
    }
    for (const sample of [
      '.a { clip-path: path("M0 0 H10 V10 H0 Z") }',
      ".a { clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%) }",
      ".a { clip-path: inset(0 0 4px 0) }",
    ]) {
      expect(cssViolations(sample), sample).toEqual([]);
    }
  });

  it("CSS：把 <circle> / <ellipse> 内联在 data URI 里（明文或 %3C 转义）会被抓到；别的内联 SVG 形状不算", () => {
    // rg -i "(<|%3C)(circle|ellipse)" src/web --glob "*.css"：0 命中。
    for (const sample of [
      `.a { background: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'><circle cx='1' cy='1' r='1'/></svg>") }`,
      ".a { background: url(data:image/svg+xml,%3Csvg%3E%3Ccircle%20r='1'/%3E) }",
      ".a { background: url(data:image/svg+xml,%3Csvg%3E%3Cellipse%20rx='1'/%3E) }",
      ".a { mask: url('data:image/svg+xml;utf8,<svg><ELLIPSE/></svg>') }",
    ]) {
      expect(cssViolations(sample), sample).not.toEqual([]);
    }
    expect(cssViolations(`.a { background: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'><rect width='1' height='1'/></svg>") }`)).toEqual([]);
  });

  it("CSS：更多圆形字符（⏺ ◌ ⭕ 🔴 🟢 🔘 及其 CSS 转义，大小写不论）会被抓到；别的 emoji、箭头与几何符号不算", () => {
    // rg "[⏺◌⭕⚬⭘🔘🔴🔵🟠🟡🟢🟣🟤]|\\\\(23FA|25CC|2B55|1F534|1F7E|1F518)" src/web：0 命中（用 rg 的 -i 再查一遍大小写）。
    for (const sample of [
      '.a::before { content: "⏺" }',
      '.a::before { content: "◌" }',
      '.a::before { content: "⭕" }',
      '.a::before { content: "🔴" }',
      '.a::before { content: "🟢" }',
      '.a::before { content: "🔘" }',
      '.a::before { content: "\\23FA" }',
      '.a::before { content: "\\25cf" }',
      '.a::before { content: "\\1F534" }',
    ]) {
      expect(cssViolations(sample), sample).not.toEqual([]);
    }
    for (const sample of [
      '.a::before { content: "🚀 😀 👍" }',
      '.a::before { content: "→ ▶ ■ ◆" }',
      '.a::before { content: "\\2192" }',
      '.a::before { content: "\\25B6" }',
    ]) {
      expect(cssViolations(sample), sample).toEqual([]);
    }
  });

  it("TS / TSX：borderRadius 的各种写法（驼峰、带前缀、样式字符串、模板字符串、名字里带 radius 的变量）都会被抓到；叫 radius 的普通变量不算", () => {
    // rg "[A-Za-z]*[Bb]order[A-Za-z]*Radius|--[\w-]*radius" src/web --glob "!*.test.*" -g "*.ts*"：0 命中。
    for (const sample of [
      "const s = { borderTopLeftRadius: 2 };",
      "const s = { WebkitBorderRadius: 2 };",
      "el.style.borderRadius = '4px';",
      "el.style.setProperty('border-radius', '4px');",
      'const css = `.a { border-radius: ${r}px }`;',
      "const v = { '--tab-radius': '4px' };",
      "const style = { '--r-ctl': 4 };",
    ]) {
      expect(codeViolations(sample), sample).not.toEqual([]);
    }
    for (const sample of [
      "const radius = 4; const r = radius * 2;",
      "const s = { border: '1px solid red' };",
      "const note = 'a border and a radius';",
    ]) {
      expect(codeViolations(sample), sample).toEqual([]);
    }
  });

  it("TS / TSX：元素名写成字符串（\"circle\"）、画布与 Path2D 的圆弧接口、自带圆形外观的原生控件都会被抓到；普通字符串与注释不算", () => {
    // rg "[\"'`](circle|ellipse)[\"'`]|\.(arc|arcTo|ellipse|roundRect)\(|<(progress|meter)\b|type=.?.?range" src/web --glob "!*.test.*" -g "*.ts*"：0 命中。
    for (const sample of [
      "const Tag = 'circle';",
      'document.createElementNS(NS, "ellipse");',
      "const tag = `circle`;",
      "ctx.arc(10, 10, 5, 0, Math.PI * 2);",
      "path.arcTo(1, 1, 2, 2, 3);",
      "path.roundRect(0, 0, 10, 10, 4);",
      "ctx.ellipse(1, 1, 2, 2, 0, 0, 7);",
      "<progress value={0.5} />",
      "<meter min={0} max={1} />",
      '<input type="range" />',
      "<input type='range' />",
      '<input type={"range"} />',
    ]) {
      expect(codeViolations(sample), sample).not.toEqual([]);
    }
    for (const sample of [
      "const label = 'circle graph';",
      "const tag = 'circles';",
      "const id = 'arc';",
      "x.arcs.map(f);",
      '<input type="text" />',
      '<input type="checkbox" />',
      '<input type="radio" />',
      "// ctx.arc(1, 1, 1, 0, 7) 在注释里\nconst a = 1;",
      "/* <progress /> */ const a = 1;",
    ]) {
      expect(codeViolations(sample), sample).toEqual([]);
    }
  });

  it("TS / TSX：圆形字符的转义与 HTML 实体（\\u25CF、\\u{1F534}、&bull;、&#8226;）和更多圆形 emoji 会被抓到；别的 emoji 与符号不算", () => {
    for (const sample of [
      "const dot = '🔴';",
      "const dot = '⏺';",
      "const dot = '\\u25CF';",
      "const dot = '\\u{1F534}';",
      "<span>&bull;</span>",
      "<span>&#8226;</span>",
      "<span>&#x25CF;</span>",
    ]) {
      expect(codeViolations(sample), sample).not.toEqual([]);
    }
    for (const sample of ["const s = '🚀 😀 👍';", "const s = 'a &amp; b';", "const s = '→ ▶ ■ ◆';"]) {
      expect(codeViolations(sample), sample).toEqual([]);
    }
  });

  it("隐形的原生输入框：选择器带 input / *-input 且 opacity: 0 的规则会被挑出来，并带着它声明的半径（没写就是 undefined）", () => {
    expect(
      invisibleInputs('.q-opt input[type="radio"], .q-opt input[type="checkbox"] { position: absolute; margin: 0; border-radius: 0; opacity: 0; }'),
    ).toEqual([{ selector: '.q-opt input[type="radio"], .q-opt input[type="checkbox"]', radius: "0" }]);
    expect(invisibleInputs(".mrow-input { position: absolute; opacity: 0; }")).toEqual([{ selector: ".mrow-input", radius: undefined }]);
    // @media 里的规则也算；半径写的是 50% 就如实带出来，由调用方判成不合格。
    expect(invisibleInputs("@media (min-width: 1px) {\n  .x-input { opacity: 0; border-radius: 50%; }\n}")).toEqual([{ selector: ".x-input", radius: "50%" }]);
    // 不是隐形的、或根本不是输入框，都不挑。
    expect(invisibleInputs("input { opacity: 0.5; }")).toEqual([]);
    expect(invisibleInputs("input { opacity: 1; }")).toEqual([]);
    expect(invisibleInputs(".fade { opacity: 0; }")).toEqual([]);
    expect(invisibleInputs(".q-mark[data-kind=\"box\"] svg { opacity: 0; }")).toEqual([]);
    expect(invisibleInputs("/* .x-input { opacity: 0; } */ .y { color: red }")).toEqual([]);
  });

  it("项目符号的类名：只认“选择器就是这个类（可带 ul 前缀）”且声明了 none / square 的规则", () => {
    expect(
      bulletlessClasses(".a-list { list-style: none; margin: 0 }\nul.b-list { list-style-type: square }\n.c, .d-list { list-style: none }"),
    ).toEqual(["a-list", "b-list", "c", "d-list"]);
    for (const sample of [
      ".md ul { list-style-type: square }",
      ".x li { list-style: none }",
      "ul { list-style: none }",
      ".e { list-style: disc }",
      ".f { margin: 0 }",
      "/* .g { list-style: none } */",
    ]) {
      expect(bulletlessClasses(sample), sample).toEqual([]);
    }
  });

  it("<ul> 的项目符号：没有类名、或类名里没有一个声明了 none / square 的会被抓到；有、动态类名、<ol> 与注释不算", () => {
    const safe = new Set(["usage-legend"]);
    for (const sample of [
      "const A = () => <ul><li>a</li></ul>;",
      '<ul className="plain"><li>a</li></ul>',
      '<ul id="x" className="a b"><li>a</li></ul>',
      '<ul\n  className="mlist"\n  onKeyDown={(event) => { go(event); }}\n>',
    ]) {
      expect(bulletProblems(sample, safe), sample).toHaveLength(1);
    }
    for (const sample of [
      '<ul className="usage-legend"><li>a</li></ul>',
      '<ul className="x usage-legend"><li>a</li></ul>',
      "<ul className={cx('a')}><li>a</li></ul>",
      // 属性值里的箭头函数自带一个 >，开标签要靠花括号配对才找得到真正的结尾（className 写在箭头函数后面也读得到）。
      '<ul\n  onKeyDown={(event) => { go(event); }}\n  className="usage-legend"\n>',
      "<ol><li>a</li></ol>",
      "<ulx />",
      "// <ul> 只在注释里\nconst a = 1;",
      "{/* <ul> */}",
    ]) {
      expect(bulletProblems(sample, safe), sample).toEqual([]);
    }
  });
});
