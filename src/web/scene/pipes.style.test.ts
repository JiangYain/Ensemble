import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 管线的样式契约（scene.css）：读 CSS 文本，不渲染。
 * 用户的要求是静止的连线一视同仁：来源 → 会话与会话 → 会话同色、同宽、同不透明度，并且都看得清（不低于会话之间的连线本来的 1.7 : 1）。
 * 这里只钉文本里钉得住的部分——静止的管壁只有一套笔法、对比度的下限、运行中的线只换颜色与虚线、样式不再按起点类型或网格区别对待；
 * 线在真实浏览器里清不清楚（亚像素线宽、不同缩放与像素密度）、大扇出疏密如何，不在这里断言。
 */

const css = readFileSync("src/web/styles/scene.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

interface Rule {
  /** 规则的选择器列表，逐个拆开并压掉多余空白。 */
  selectors: string[];
  decls: Map<string, string>;
}

/** 够用的拆法：规则之间没有嵌套（@media 里的规则各自单独匹配），选择器里没有逗号以外的列表分隔。 */
const rules: Rule[] = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => {
  const decls = new Map<string, string>();
  for (const part of match[2]!.split(";")) {
    const colon = part.indexOf(":");
    if (colon > 0) decls.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
  }
  return { selectors: match[1]!.split(",").map((selector) => selector.trim().replace(/\s+/g, " ")), decls };
});

/** 选择器点名了 `.pipe-tube`（含属性、伪类、后代的写法；不含 `.pipe-tube-xxx` 这样的别的类）。 */
const mentionsTube = (selector: string): boolean => /\.pipe-tube(?![\w-])/.test(selector);
/** 管壁的颜色、宽度、不透明度：线帽、线接头、虚线这类不在其中。 */
const PAINT = ["stroke", "stroke-width", "stroke-opacity", "opacity"];

const channel = (value: number): number => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** 不透明的 #rgb / #rrggbb 对白底的 WCAG 对比度。 */
function contrastOnWhite(hex: string): number {
  const digits = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex)?.[1];
  if (!digits) throw new Error(`不是不透明的十六进制颜色：${hex}`);
  const full = digits.length === 3 ? [...digits].map((c) => c + c).join("") : digits;
  const [r, g, b] = [0, 2, 4].map((at) => channel(Number.parseInt(full.slice(at, at + 2), 16)));
  return 1.05 / (0.2126 * r! + 0.7152 * g! + 0.0722 * b! + 0.05);
}

describe("管线的样式契约（scene.css）", () => {
  const base = rules.find((rule) => rule.selectors.length === 1 && rule.selectors[0] === ".pipe-tube" && rule.decls.has("stroke"));
  const running = rules.find((rule) => rule.selectors.includes('.pipe-tube[data-phase="running"]'));

  it("静止的管壁只有一套笔法：#c6c6c6、宽 1.3、不透明；别的规则不再给静止的线改色、改宽、改不透明度", () => {
    expect(base).toBeDefined();
    expect(base!.decls.get("stroke")).toBe("#c6c6c6");
    expect(base!.decls.get("stroke-width")).toBe("1.3");
    expect(base!.decls.has("opacity")).toBe(false);
    expect(base!.decls.has("stroke-opacity")).toBe(false);
    // 只有两处例外：运行中的线（颜色与虚线）、空画布引导图里更淡的装饰线。起点类型、网格、阶段……不该再各有一套。
    const painted = rules.filter((rule) => rule !== base && rule.selectors.some(mentionsTube) && PAINT.some((prop) => rule.decls.has(prop)));
    expect(painted.flatMap((rule) => rule.selectors.filter(mentionsTube)).sort()).toEqual([".ghost .pipe-tube", '.pipe-tube[data-phase="running"]']);
  });

  it("对白底的对比度不低于 1.7 : 1（会话之间的连线本来的水平），运行中的线比它更醒目", () => {
    const still = contrastOnWhite(base!.decls.get("stroke")!);
    expect(still).toBeGreaterThanOrEqual(1.7);
    expect(running).toBeDefined();
    expect(contrastOnWhite(running!.decls.get("stroke")!)).toBeGreaterThan(still);
  });

  it("运行中的线只换颜色并带虚线：宽度与不透明度仍是静止的那一套", () => {
    expect(running!.decls.has("stroke")).toBe(true);
    expect(running!.decls.has("stroke-dasharray")).toBe(true);
    for (const prop of ["stroke-width", "stroke-opacity", "opacity"]) expect(running!.decls.has(prop), prop).toBe(false);
  });

  it("样式不再按线的起点类型（data-kind）或画布是否排成多列网格（data-grid）区别对待管壁", () => {
    for (const rule of rules) {
      for (const selector of rule.selectors.filter(mentionsTube)) expect(selector, selector).not.toMatch(/data-kind|data-grid/);
    }
  });
});
