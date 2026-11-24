import { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { setLang } from "../lib/app";
import { usageBreakdown } from "../lib/usage";
import { UsageRing } from "./UsageRing";

/** 真实运行的量级：缓存占输入的绝大部分，推理占输出的绝大部分。 */
const SAMPLE = { inputTokens: 6_300_000, cachedTokens: 6_200_000, outputTokens: 218_000, reasoningTokens: 201_000 };

function renderRing(usage: Parameters<typeof usageBreakdown>[0], body: (host: HTMLElement) => void): void {
  const breakdown = usageBreakdown(usage);
  if (!breakdown) throw new Error("no breakdown for this usage");
  setLang("zh");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(<UsageRing breakdown={breakdown} />));
    body(host);
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
}

/** 每一段的虚线：一段可见的长度、其余的长度、起点离环起点的距离（dashoffset 取反；写成 0 - x，免得得到 -0）。 */
function dashesOf(host: HTMLElement): Array<{ length: number; rest: number; offset: number }> {
  return [...host.querySelectorAll<SVGPathElement>("path.usage-seg")].map((seg) => {
    const [length, rest] = seg.style.getPropertyValue("stroke-dasharray").split(/\s+/).map(Number);
    return { length: length!, rest: rest!, offset: 0 - Number(seg.style.getPropertyValue("stroke-dashoffset")) };
  });
}

describe("UsageRing（方环）", () => {
  it("每一段都是同一条方形路径上的一截，按图例的顺序，没有任何圆", () => {
    renderRing(SAMPLE, (host) => {
      const svg = host.querySelector("svg.usage-ring")!;
      expect(svg.getAttribute("aria-hidden")).toBe("true");
      expect(svg.getAttribute("viewBox")).toBe("0 0 96 96");
      expect(svg.querySelectorAll("circle, ellipse")).toHaveLength(0);
      const segs = [...svg.querySelectorAll(".usage-seg")];
      expect(segs.map((seg) => seg.tagName.toLowerCase())).toEqual(["path", "path", "path", "path"]);
      expect(segs.map((seg) => seg.getAttribute("data-seg"))).toEqual(["cached", "input", "reasoning", "output"]);
      for (const seg of segs) {
        expect(seg.getAttribute("d")).toBe("M48 6 H90 V90 H6 V6 H48");
        expect(seg.getAttribute("stroke-width")).toBe("6");
        expect(seg.getAttribute("fill")).toBe("none");
      }
    });
  });

  it("各段在一周上首尾相接：每段的可见长度加上其余等于一周（336），后一段从前一段结束后的缺口之后开始", () => {
    renderRing(SAMPLE, (host) => {
      const dashes = dashesOf(host);
      expect(dashes).toHaveLength(4);
      for (const dash of dashes) expect(dash.length + dash.rest).toBeCloseTo(336, 6);
      expect(dashes[0]?.offset).toBeCloseTo(0, 9);
      dashes.slice(1).forEach((dash, index) => {
        const before = dashes[index]!;
        expect(dash.offset - (before.offset + before.length), `第 ${index + 1} 个缺口`).toBeCloseTo(2, 6);
      });
      // 最后一段结束后还留着一个缺口，才回到起点。
      const last = dashes[3]!;
      expect(last.offset + last.length + 2).toBeCloseTo(336, 6);
    });
  });

  it("按比例缺口会落在拐角上时，缺口被挪开：13% 的一段本来在 43.16 结束（压着右上角 42），现在在 45", () => {
    // 缓存 13、其余输出 87：两段，占比 0.13 与 0.87；一周 336 扣掉两个缺口，第一段按比例是 43.16。
    renderRing({ inputTokens: 13, cachedTokens: 13, outputTokens: 87 }, (host) => {
      const [first, second] = dashesOf(host);
      expect(first?.length).toBeCloseTo(45, 9);
      expect(second?.offset).toBeCloseTo(47, 9);
      expect((second?.offset ?? 0) - ((first?.offset ?? 0) + (first?.length ?? 0))).toBeCloseTo(2, 9);
    });
  });

  it("只有一段时是完整的一周，没有缺口", () => {
    renderRing({ inputTokens: 100, cachedTokens: 100, outputTokens: 0 }, (host) => {
      expect(dashesOf(host)).toEqual([{ length: 336, rest: 0, offset: 0 }]);
    });
  });

  it("入场动画读的自定义属性就是组件写在 svg 上的那一个，它的值是一周的长度", () => {
    const css = readFileSync("src/web/styles/sidebar.css", "utf8");
    expect(css).toMatch(/@keyframes usage-draw\s*\{\s*from\s*\{\s*stroke-dasharray:\s*0 var\(--usage-perimeter\)/);
    renderRing(SAMPLE, (host) => {
      expect(host.querySelector<SVGElement>("svg.usage-ring")!.style.getPropertyValue("--usage-perimeter")).toBe("336");
    });
  });
});
