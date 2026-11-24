import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelFamily } from "../lib/modelFamily";
import { ModelMark } from "./ModelMark";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 品牌标识色层的文本：vitest 会把 CSS 导入 stub 成空，所以像 layout.test 那样直接读文件（只读，不改）。 */
const brandCss = readFileSync("src/web/marks/brand.css", "utf8");

/**
 * 品牌色层的两类家族：
 * - COLOURED：有可核实官方品牌色/渐变的，brand.css 逐家铺色（glm 是官方黑白标 + 核实界面色的例外）；
 * - MONOCHROME：官方只有黑白标的（OpenAI、xAI、Kimi、Composer），保持 scene.css 的中性墨色，品牌层不许给它们上色。
 */
const COLOURED: readonly ModelFamily[] = ["claude", "deepseek", "qwen", "gemini", "llama", "mistral", "minimax", "glm"];
const MONOCHROME: readonly ModelFamily[] = ["openai", "grok", "kimi", "composer"];
const ALL: readonly ModelFamily[] = [...COLOURED, ...MONOCHROME];

describe("模型家族标", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("每个家族渲染出同一种结构：带 data-family 的遮罩标，尺寸跟随 size，不因家族不同而变版式", () => {
    for (const family of ALL) {
      act(() => root.render(<ModelMark family={family} size={14} />));
      const mark = host.querySelector<HTMLElement>(".model-mark");
      expect(mark?.tagName).toBe("SPAN");
      expect(mark?.getAttribute("data-family")).toBe(family);
      expect(mark?.style.width).toBe("14px");
      expect(mark?.style.height).toBe("14px");
    }
  });

  it("品牌色层给每个有官方彩的家族一条铺色规则（来源清单见 marks/README.md）", () => {
    for (const family of COLOURED) {
      expect(brandCss).toMatch(new RegExp(`\\.model-mark\\[data-family="${family}"\\]\\s*\\{[^}]*background`));
    }
  });

  it("官方只有黑白标的家族不出现任何铺色规则，只以例外说明出现——不用颜色冒充品牌", () => {
    for (const family of MONOCHROME) {
      expect(brandCss).not.toMatch(new RegExp(`\\[data-family="${family}"\\][^}]*\\{[^}]*background`));
      expect(brandCss).toContain(family);
    }
  });

  it("Git 橙只作用于 Git 卡片头部的标识格，写成精确选择器而不是全局规则", () => {
    expect(brandCss).toContain(".node.git .o-head .a-mark { color: #F03C2E; }");
  });
});
