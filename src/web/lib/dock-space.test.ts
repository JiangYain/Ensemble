import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 方案 A 布局与留白守卫（读 CSS 文本，不渲染）：
 * - 已彻底移除原来的底部居中浮空胶囊 Dock，画布右下角是 32px 直角图纸比例尺（.canvas-scale），
 *   多选时画布底中浮现像素级等高（32px）且共底线的直角对齐标尺（.arrange）；
 * - 聚焦页底部只留 20px（窄屏 12px），仅当无侧栏且存在浮动状态提示时让出 52px；
 * - 概览 toast 贴近右下角比例尺上方（56px，窄屏 52px），聚焦页 toast 贴输入区上沿；
 * - 左侧栏选中态纯净无左侧竖条、顶栏不放 Ctrl K 按钮。
 */

const strip = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const editorial = strip(readFileSync("src/web/styles/editorial.css", "utf8"));
const dock = strip(readFileSync("src/web/styles/dock.css", "utf8"));
const workspace = strip(readFileSync("src/web/styles/workspace.css", "utf8"));

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function block(text: string, header: string): string {
  const start = text.indexOf(header);
  if (start < 0) throw new Error(`没有找到 ${header}`);
  const open = text.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error(`${header} 的花括号没有配对`);
}

function declarations(text: string, selector: string): string | undefined {
  const match = new RegExp(`(?:^|[{}])\\s*${escape(selector)}\\s*\\{([^{}]*)\\}`).exec(text);
  return match?.[1]?.replace(/\s+/g, " ").trim();
}

describe("方案 A 留白与 toast：告别底部浮空胶囊 Dock", () => {
  const narrow = block(editorial, "@media (max-width: 640px)");

  it(".focus 的底部：无提示 20px、窄屏 12px；仅在无侧栏且存在浮动状态提示时让出 52px", () => {
    expect(declarations(editorial, ".focus")).toBe("bottom: 20px;");
    expect(declarations(editorial, '.app:has(.status-notices[data-place="floating"]) .focus')).toBe("bottom: 52px;");
    expect(declarations(narrow, ".focus")).toBe("bottom: 12px;");
  });

  it("旧底部胶囊选择器和 90px/110px 留白已清理", () => {
    expect(dock).not.toMatch(/\.dock\s*\{|\.dock-new|\.dock-settings|\.dock-zoom/);
    for (const value of ["80px", "110px", "72px", "108px"]) {
      expect(editorial, value).not.toMatch(new RegExp(`\\.focus\\s*\\{[^}]*bottom:\\s*${value}`));
    }
  });

  it("多选对齐条容器（.arrange-wrap）靠 left/right: 0 + margin-inline: auto 整像素居中，不使用 translateX(-50%)", () => {
    const wrap = declarations(dock, ".arrange-wrap") ?? "";
    expect(wrap).toContain("left: 0;");
    expect(wrap).toContain("right: 0;");
    expect(wrap).toContain("width: max-content;");
    expect(wrap).toContain("margin-inline: auto;");
    expect(wrap).not.toMatch(/transform|left: 50%/);
  });

  it("右下角图纸比例尺（.canvas-scale）与多选对齐条（.arrange）像素级等高（32px）、同底边、同直角细边", () => {
    const scale = declarations(workspace, ".canvas-scale") ?? "";
    expect(scale).toContain("height: 32px;");
    expect(scale).toContain("border: 1px solid #dedede;");
    expect(scale).not.toContain("border-radius"); // 全站没有圆角声明（守卫见 corner-system.test.ts），直角是默认
    expect(scale).toContain("bottom: max(16px, env(safe-area-inset-bottom));");
    const arrange = declarations(dock, ".arrange") ?? "";
    expect(arrange).toContain("height: 32px;");
    expect(arrange).toContain("border: 1px solid #dedede;");
    expect(arrange).not.toContain("border-radius");
    const wrap = declarations(dock, ".arrange-wrap") ?? "";
    expect(wrap).toContain("bottom: max(16px, env(safe-area-inset-bottom));");
    // 窄屏下两者同为 12px 底边，继续保持齐平
    const narrowScale = declarations(block(workspace, "@media (max-width: 560px)"), ".canvas-scale") ?? "";
    const narrowWrap = declarations(block(dock, "@media (max-width: 560px)"), ".arrange-wrap") ?? "";
    expect(narrowScale).toContain("bottom: max(12px, env(safe-area-inset-bottom));");
    expect(narrowWrap).toContain("bottom: max(12px, env(safe-area-inset-bottom));");
  });

  it("左侧栏选中态纯净无左侧竖条、无外描边，顶部不再放置 Ctrl K 快捷键按钮", () => {
    const active = declarations(workspace, ".rail-item[data-active]") ?? "";
    expect(active).not.toMatch(/box-shadow|border-left|border:/);
    expect(active).toContain("background:");
    expect(workspace).not.toContain(".rail-kbd-btn");
  });

  it("概览的 toast 避开右下角比例尺（56px，窄屏 52px）；聚焦页 toast 贴输入区上沿", () => {
    expect(declarations(editorial, ".toasts")).toBe("bottom: 56px;");
    expect(declarations(narrow, ".toasts")).toBe("left: 12px; right: 12px; bottom: 52px;");
    expect(declarations(editorial, '.app[data-view="session"] .toasts')).toBe("bottom: 20px;");
    expect(declarations(editorial, ".composer")).toBe("anchor-name: --composer;");
    const supported = block(editorial, "@supports (anchor-name: --composer)");
    const anchored = declarations(supported, '.app[data-view="session"] .toasts');
    expect(anchored).toBe("bottom: calc(anchor(--composer top, 12px) + 8px);");
  });
});

/*
 * 样式表按控件归属拆分之后的守卫（读 main.tsx 与 CSS 文本，不渲染）：
 * - main.tsx 里的引入顺序就是层叠顺序：拆分之前就有的样式表彼此的先后一个不能变，新建的文件一个不能漏掉引入；
 * - quick-switcher.css 紧跟 workspace.css；settings-checkbox.css 夹在 sidebar.css 与 model-pick.css 之间，先于用到它的两个文件；
 * - 一条规则只属于一个控件的样式表：快速切换器只在 quick-switcher.css，模型勾选列表只在 model-pick.css（外加共用勾选框的 settings-checkbox.css）；
 * - 模型勾选与历史留存开关共用的框与状态只写一份，且保持“没勾 → 悬停 → 勾上 → 聚焦”的先后（悬停与勾上权重相同，后写的赢）。
 * 零圆角由 corner-system.test.ts 扫整个样式目录，新文件自动在内。
 */
const STYLES = "src/web/styles";
const styleFiles = readdirSync(STYLES).filter((name) => name.endsWith(".css"));
const styleText = (name: string): string => strip(readFileSync(`${STYLES}/${name}`, "utf8"));
/** 样式目录里除 owners 之外的样式表文件名。 */
const others = (...owners: string[]): string[] => styleFiles.filter((name) => !owners.includes(name));

/** main.tsx 里 `import "./styles/xxx.css"` 的文件名，按书写顺序。 */
const imported = [...readFileSync("src/web/main.tsx", "utf8").matchAll(/^import "\.\/styles\/([\w-]+\.css)";$/gm)].map((match) => match[1] ?? "");

/** 一张样式表里每条规则的选择器（逗号并列的每一项各算一个）；只用来读没有嵌套的规则。 */
function selectorLists(css: string): string[][] {
  return [...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].map((match) => (match[1] ?? "").split(",").map((selector) => selector.trim()));
}

describe("样式表拆分：main.tsx 的引入顺序就是层叠顺序", () => {
  /** 拆分之前就在 main.tsx 里的样式表，按当时的先后。拆分只许在它们之间插新文件，不许让其中任何两个换序。 */
  const ORIGINAL: readonly string[] = [
    "tokens.css",
    "base.css",
    "components.css",
    "controls.css",
    "content.css",
    "dock.css",
    "workspace.css",
    "scene.css",
    "focus.css",
    "timeline.css",
    "intervention.css",
    "question.css",
    "sidebar.css",
    "model-pick.css",
    "overlays.css",
    "limits.css",
    "profiles.css",
    "archive.css",
    "handoff.css",
    "editorial.css",
  ];

  it("拆分前就有的样式表：各引入一次，彼此的先后一个没变", () => {
    expect(imported.filter((name) => ORIGINAL.includes(name))).toEqual(ORIGINAL);
  });

  it("styles 目录里的每个样式表都在 main.tsx 里引入一次：新建的文件不会漏掉引入", () => {
    expect([...imported].sort()).toEqual([...styleFiles].sort());
  });

  it("quick-switcher.css 紧跟在 workspace.css 之后", () => {
    const at = imported.indexOf("workspace.css");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(imported[at + 1]).toBe("quick-switcher.css");
  });

  it("settings-checkbox.css 夹在 sidebar.css 与 model-pick.css 之间：先于用到它的 model-pick.css 与 archive.css", () => {
    const at = imported.indexOf("sidebar.css");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(imported.slice(at, at + 3)).toEqual(["sidebar.css", "settings-checkbox.css", "model-pick.css"]);
    expect(imported.indexOf("settings-checkbox.css")).toBeLessThan(imported.indexOf("archive.css"));
  });
});

describe("样式表拆分：规则跟着控件走", () => {
  it("快速切换器（.switcher*）只在 quick-switcher.css：workspace.css 与别的样式表里一条都没有", () => {
    for (const name of others("quick-switcher.css")) expect(styleText(name), name).not.toMatch(/\.switcher/);
    const quick = styleText("quick-switcher.css");
    for (const name of ["switcher", "switcher-bar", "switcher-input", "switcher-list", "switcher-item", "switcher-empty"]) {
      expect(quick, name).toMatch(new RegExp(`\\.${name}(?![\\w-])`));
    }
  });

  it("模型勾选列表（.mcfg / .mlist / .mitem / .mline / .mrow / .mefforts / .echip / .mpick）只在 model-pick.css 与共用勾选框的 settings-checkbox.css 里", () => {
    for (const name of others("model-pick.css", "settings-checkbox.css")) {
      expect(styleText(name), name).not.toMatch(/\.(?:mcfg|mlist|mitem|mline|mrow|mefforts|echip|mpick)\b/);
    }
  });

  it("model-pick.css 里行骨架（.mline）在默认模型的单选（.mpick）之前：.mpick 依赖前面行的列与位置", () => {
    const pick = styleText("model-pick.css");
    expect(pick.indexOf(".mline {")).toBeGreaterThan(-1);
    expect(pick.indexOf(".mline {")).toBeLessThan(pick.indexOf(".mpick {"));
  });

  it("用量环与访问权限的规则留在 sidebar.css", () => {
    const sidebar = styleText("sidebar.css");
    expect(sidebar).toMatch(/\.usage-seg\s*\{/);
    expect(sidebar).toMatch(/\.access-list li\s*\{/);
  });
});

describe("样式表拆分：模型勾选与留存开关共用一份框与状态", () => {
  /** 共用的四组规则：[模型勾选的选择器, 留存开关的选择器]，依次是 没勾、悬停、勾上、聚焦。 */
  const SHARED = [
    [".mrow-box", ".retention-box"],
    [".mline:hover .mrow-box", ".retention-toggle:hover .retention-box"],
    [".mrow-input:checked + .mrow-box", ".retention-input:checked + .retention-box"],
    [".mrow-input:focus-visible + .mrow-box", ".retention-input:focus-visible + .retention-box"],
  ] as const;

  it("四组规则各是一条逗号并列的规则，先后是 没勾 → 悬停 → 勾上 → 聚焦（悬停与勾上权重相同，勾上必须在后）", () => {
    const lists = selectorLists(styleText("settings-checkbox.css"));
    const at = SHARED.map(([model, retention]) => lists.findIndex((list) => list.includes(model) && list.includes(retention)));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it("模型勾选与留存开关各自的样式表里不再写这几组规则：框只剩各自独有的声明，悬停、勾上、聚焦一条不留", () => {
    const pick = selectorLists(styleText("model-pick.css"));
    const history = selectorLists(styleText("archive.css"));
    for (const [model, retention] of SHARED.slice(1)) {
      expect(pick.some((list) => list.includes(model)), model).toBe(false);
      expect(history.some((list) => list.includes(retention)), retention).toBe(false);
    }
    for (const [file, selector] of [
      ["model-pick.css", ".mrow-box"],
      ["archive.css", ".retention-box"],
    ] as const) {
      const body = declarations(styleText(file), selector) ?? "";
      expect(body, selector).not.toBe("");
      for (const property of ["display", "flex", "place-items", "width", "height", "box-shadow", "transition"]) {
        expect(body, `${selector} 不再写 ${property}`).not.toMatch(new RegExp(`(?:^|\\s)${property}:`));
      }
    }
  });
});
