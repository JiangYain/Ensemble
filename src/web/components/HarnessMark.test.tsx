import { readFileSync } from "node:fs";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HarnessId } from "@shared/types";
import { HARNESS_MARKS, HarnessMark, type HarnessMarkEntry } from "./HarnessMark";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FILES: Record<string, string> = { cursor: "cursor.svg", dsh: "dsh.svg", codex: "codex.svg", claude: "claude-code.svg", opencode: "opencode.svg", pi: "pi.svg" };
/** 与组件拿到同一份资源引用（文件路径，小文件被 vite 内联时是 data URI），用来核对条目的 src 没拷错文件。 */
const ASSETS = import.meta.glob<string>("../marks/*.svg", { eager: true, import: "default" });

/**
 * 每枚标的可见图形包围盒（SVG 用户坐标），不依赖 HarnessMark 里记的光学尺寸，所以能核对它：
 * - Claude Code 与 Pi 的路径全是直线（M/H/V/Z），直接从路径坐标算；
 * - Cursor 的六边形与 Codex 的墨团是曲线，没有现成的 SVG 渲染器可用，改用 Chrome 实测的结论：图形顶满整个 viewBox；
 * - DSH 的鲸鱼全由三次贝塞尔曲线（M/C/Z）构成，按曲线求极值来算：控制点会伸到曲线之外，不能直接拿控制点的包围盒当可见范围。
 * 换了 SVG 文件、改了 viewBox 或路径，这里都会对不上，提醒重量 HarnessMark.tsx 里 HARNESS_MARKS 各条目的 optical。
 */
function inkOf(harness: string): { vb: [number, number, number, number]; box: [number, number, number, number] } {
  const svg = readFileSync(`src/web/marks/${FILES[harness]}`, "utf8");
  const vb = svg.match(/viewBox="([^"]+)"/)![1]!.trim().split(/\s+/).map(Number) as [number, number, number, number];
  if (harness === "cursor" || harness === "codex") return { vb, box: [vb[0], vb[1], vb[0] + vb[2], vb[1] + vb[3]] };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [, d] of svg.matchAll(/\sd="([^"]+)"/g)) {
    let x = 0, y = 0, startX = 0, startY = 0;
    const take = (px: number, py: number): void => {
      x = px; y = py;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    };
    // 三次贝塞尔：x、y 各自对 t 求导，把落在 (0, 1) 里的极值点计入包围盒；终点交给 take（它也会移动当前点）。
    const cubic = (c: number[]): void => {
      const px = [x, c[0]!, c[2]!, c[4]!];
      const py = [y, c[1]!, c[3]!, c[5]!];
      const at = (v: number[], t: number): number => (1 - t) ** 3 * v[0]! + 3 * (1 - t) ** 2 * t * v[1]! + 3 * (1 - t) * t ** 2 * v[2]! + t ** 3 * v[3]!;
      const extrema = (v: number[]): number[] => {
        const a = -v[0]! + 3 * v[1]! - 3 * v[2]! + v[3]!;
        const b = 2 * (v[0]! - 2 * v[1]! + v[2]!);
        const k = v[1]! - v[0]!;
        const roots: number[] = [];
        if (Math.abs(a) < 1e-12) {
          if (Math.abs(b) > 1e-12) roots.push(-k / b);
        } else {
          const disc = b * b - 4 * a * k;
          if (disc >= 0) roots.push((-b + Math.sqrt(disc)) / (2 * a), (-b - Math.sqrt(disc)) / (2 * a));
        }
        return roots.filter((t) => t > 0 && t < 1);
      };
      for (const t of [...extrema(px), ...extrema(py)]) {
        const ex = at(px, t), ey = at(py, t);
        x0 = Math.min(x0, ex); x1 = Math.max(x1, ex); y0 = Math.min(y0, ey); y1 = Math.max(y1, ey);
      }
      take(c[4]!, c[5]!);
    };
    for (const [, command, args] of d!.matchAll(/([MmHhVvZzCc])([^MmHhVvZzCc]*)/g)) {
      const n = (args!.match(/-?\d*\.?\d+/g) ?? []).map(Number);
      switch (command) {
        case "M": take(n[0]!, n[1]!); startX = x; startY = y; for (let i = 2; i < n.length; i += 2) take(n[i]!, n[i + 1]!); break;
        case "m": take(x + n[0]!, y + n[1]!); startX = x; startY = y; break;
        case "H": for (const v of n) take(v, y); break;
        case "h": for (const v of n) take(x + v, y); break;
        case "V": for (const v of n) take(x, v); break;
        case "v": for (const v of n) take(x, y + v); break;
        case "C": for (let i = 0; i + 5 < n.length; i += 6) cubic(n.slice(i, i + 6)); break;
        // 相对坐标的控制点都以这一段的起点为原点；map 先于 cubic 执行，此时 x、y 还是起点。
        case "c": for (let i = 0; i + 5 < n.length; i += 6) cubic(n.slice(i, i + 6).map((v, j) => v + (j % 2 === 0 ? x : y))); break;
        default: take(startX, startY); // Z / z：回到子路径起点
      }
    }
  }
  return { vb, box: [x0, y0, x1, y1] };
}

describe("执行端图标 HarnessMark", () => {
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

  const render = (node: ReactNode): void => act(() => root.render(node));

  describe("glyph：画布会话卡里的图标，没有框也没有底色", () => {
    it("外层只是一个不画出来的方格：边长 = size，带名字（悬停提示与读屏文字），没有 tile 的框线与模拟虚线", () => {
      render(<HarnessMark harness="pi" size={24} variant="glyph" tip="Pi" />);
      const slot = host.querySelector<HTMLElement>(".harness-glyph")!;
      expect(host.querySelector(".harness-tile")).toBeNull();
      expect(slot.style.width).toBe("24px");
      expect(slot.style.height).toBe("24px");
      expect(slot.getAttribute("data-harness")).toBe("pi");
      expect(slot.getAttribute("data-tip")).toBe("Pi");
      expect(slot.getAttribute("aria-label")).toBe("Pi");
      expect(slot.getAttribute("role")).toBe("img");
      expect(slot.hasAttribute("data-sim")).toBe(false);
      // 图片本身只是图形，不再带 harness-mark（它的 Pi 放大只属于 tile / bare），读屏也不重复念。
      const img = slot.querySelector("img")!;
      expect(img.classList.contains("harness-mark")).toBe(false);
      expect(img.getAttribute("aria-hidden")).toBe("true");
    });

    it("没有名字时不冒充有名字：不带 role 与 aria-label", () => {
      render(<HarnessMark harness="codex" size={24} variant="glyph" />);
      const slot = host.querySelector<HTMLElement>(".harness-glyph")!;
      expect(slot.getAttribute("role")).toBeNull();
      expect(slot.getAttribute("aria-label")).toBeNull();
      expect(slot.getAttribute("data-tip")).toBeNull();
    });

    // 约定的光学大小：可见图形的长边占方格的比例。Cursor / Claude Code 形状开阔、墨量小，占满；
    // Codex 的实心墨团与 Pi 的大块色阶同样占满会更重，收到 22/24。Codex 以最终的渐变版 codex.svg 为准：
    // 白色 `>_` 在白卡片上等于镂空，可见面积仍是 338 px²（含它的轮廓是 360），所以不再收（不是 21.3/24），见 HarnessMark.tsx 的注释。
    // OpenCode 的官方 logo 是竖版 4:5 的粗框（可见面积约 288 px²，在上面四枚之间）：方格 24 里 20/24 恰好是官方最小的 16×20 px。
    // DSH 的鲸鱼墨量最小（方格 24 里即使占满也只有约 218 px²，Chrome 实测），长边已是方格上限，所以也是 1。
    const REACH: Record<string, number> = { cursor: 1, dsh: 1, codex: 22 / 24, claude: 1, opencode: 20 / 24, pi: 22 / 24 };

    for (const size of [24, 36]) {
      it(`每枚标的可见图形：左缘都贴方格的左缘，竖向都居中，长边按约定的光学大小（方格 ${size}）`, () => {
        for (const harness of Object.keys(FILES)) {
          render(<HarnessMark harness={harness} size={size} variant="glyph" tip={harness} />);
          const img = host.querySelector<HTMLImageElement>(".harness-glyph img")!;
          const g = Number(img.getAttribute("width"));
          expect(Number(img.getAttribute("height"))).toBe(g);
          // translate 是 "x y"；happy-dom 不一定回写，没有就直接读样式属性串。
          const raw = img.style.translate || /translate:\s*([^;]+)/.exec(img.getAttribute("style") ?? "")?.[1] || "";
          const [tx, ty] = raw.split(/\s+/).map((v) => parseFloat(v)) as [number, number];

          // 图片框（g 见方，contain）里的可见图形，再换算到方格坐标：方格左缘 = 0，方格竖向由 flex 居中。
          const { vb, box } = inkOf(harness);
          const s = g / Math.max(vb[2], vb[3]);
          const offsetX = (g - vb[2] * s) / 2;
          const offsetY = (g - vb[3] * s) / 2;
          const left = tx + offsetX + (box[0] - vb[0]) * s;
          const top = (size - g) / 2 + ty + offsetY + (box[1] - vb[1]) * s;
          const width = (box[2] - box[0]) * s;
          const height = (box[3] - box[1]) * s;

          expect(left, `${harness} 左缘`).toBeCloseTo(0, 1);
          expect(top + height / 2, `${harness} 竖向中心`).toBeCloseTo(size / 2, 1);
          expect(Math.max(width, height), `${harness} 长边`).toBeCloseTo(size * REACH[harness]!, 1);
        }
      });
    }

    it("没有官方标的执行端画中性的烧瓶：同样有名字，可见的左缘同样贴方格", () => {
      render(<HarnessMark harness="some-future-harness" size={24} variant="glyph" tip="Future" />);
      const slot = host.querySelector<HTMLElement>(".harness-glyph")!;
      expect(slot.getAttribute("aria-label")).toBe("Future");
      const svg = slot.querySelector("svg")!;
      const g = Number(svg.getAttribute("width"));
      const raw = svg.style.translate || /translate:\s*([^;]+)/.exec(svg.getAttribute("style") ?? "")?.[1] || "";
      const tx = parseFloat(raw);
      // 烧瓶最左的墨迹是底角的外尖：路径顶点 x = 5.78，斜接的尖端再向左伸出约 1.17，即 24 画布里约 4.6；按 g/24 缩放后平移回方格左缘。
      expect(tx + (4.6 / 24) * g).toBeCloseTo(0, 1);
      expect(g).toBeCloseTo(((22 / 24) * 24) / 0.7333, 1);
    });
  });

  describe("tile 与 bare 不受 glyph 影响", () => {
    it("tile：方格里的图标，带框线（CSS）、模拟时带 data-sim，图形是方格的 0.65", () => {
      render(<HarnessMark harness="cursor" size={48} simulated tip="Cursor" />);
      const tile = host.querySelector<HTMLElement>(".harness-tile")!;
      expect(tile.style.width).toBe("48px");
      expect(tile.hasAttribute("data-sim")).toBe(true);
      expect(tile.getAttribute("role")).toBe("img");
      const img = tile.querySelector("img")!;
      expect(img.classList.contains("harness-mark")).toBe(true);
      expect(img.getAttribute("data-harness")).toBe("cursor");
      expect(Number(img.getAttribute("width"))).toBeCloseTo(48 * 0.65, 5);
      expect(img.getAttribute("style")).toBeNull();
    });

    it("bare：只有图标本身，按 size 画，没有外层", () => {
      render(<HarnessMark harness="codex" size={16} variant="bare" />);
      expect(host.querySelector(".harness-tile, .harness-glyph")).toBeNull();
      const img = host.firstElementChild as HTMLImageElement;
      expect(img.tagName).toBe("IMG");
      expect(img.classList.contains("harness-mark")).toBe(true);
      expect(Number(img.getAttribute("width"))).toBe(16);
    });
  });

  // 资源与光学尺寸是同一个条目的两个必填字段：漏一项在 tsc 就过不了，这里补运行时与类型层面的保证。
  describe("注册表 HARNESS_MARKS", () => {
    const entries = Object.entries(HARNESS_MARKS) as [string, HarnessMarkEntry][];
    const variants = ["tile", "glyph", "bare"] as const;

    it("每个条目都有资源和完整的光学尺寸：可见包围盒落在图片框内，光学大小在 (0, 1]", () => {
      expect(entries.length).toBeGreaterThan(0);
      for (const [id, { src, optical }] of entries) {
        expect(src, `${id} 资源`).toMatch(/svg/); // 文件路径（…/x.svg），小文件会被 vite 内联成 data:image/svg+xml
        expect(Object.keys(optical).sort(), `${id} 光学尺寸的字段`).toEqual(["height", "left", "reach", "top", "width"]);
        expect(optical.width, `${id}.width`).toBeGreaterThan(0);
        expect(optical.height, `${id}.height`).toBeGreaterThan(0);
        expect(optical.left, `${id}.left`).toBeGreaterThanOrEqual(0);
        expect(optical.top, `${id}.top`).toBeGreaterThanOrEqual(0);
        expect(optical.left + optical.width, `${id} 右缘`).toBeLessThanOrEqual(1 + 1e-9);
        expect(optical.top + optical.height, `${id} 下缘`).toBeLessThanOrEqual(1 + 1e-9);
        expect(optical.reach, `${id}.reach`).toBeGreaterThan(0);
        expect(optical.reach, `${id}.reach`).toBeLessThanOrEqual(1);
      }
    });

    it("每个条目的资源就是它名下的那个 SVG 文件（拷错文件、两枚标互换都会被抓到）", () => {
      for (const [id, { src }] of entries) expect(src, id).toBe(ASSETS[`../marks/${FILES[id]}`]);
    });

    it("没有两枚标共用同一个资源（拷贝条目时忘了换文件）", () => {
      const sources = entries.map(([, entry]) => entry.src);
      expect(new Set(sources).size).toBe(sources.length);
    });

    it("键集合与本文件的量测约定一致：新增一枚标必须同时补上它的 SVG 文件名（FILES）与光学大小（REACH）", () => {
      expect(Object.keys(HARNESS_MARKS).sort()).toEqual(Object.keys(FILES).sort());
    });

    it("每种变体画的都是条目里的资源", () => {
      for (const [id, { src }] of entries) {
        for (const variant of variants) {
          render(<HarnessMark harness={id} size={24} variant={variant} />);
          expect(host.querySelector("img")!.getAttribute("src"), `${id} ${variant}`).toBe(src);
        }
      }
    });

    it("没有官方标的执行端——包括 Object.prototype 上的名字——画中性烧瓶，不会被当成有标", () => {
      for (const harness of ["fixture", "constructor", "toString", "__proto__"]) {
        for (const variant of variants) {
          render(<HarnessMark harness={harness} size={24} variant={variant} />);
          expect(host.querySelector("img"), `${harness} ${variant}`).toBeNull();
          expect(host.querySelector("svg"), `${harness} ${variant}`).not.toBeNull();
        }
      }
    });

    it("类型约束（由 tsc -p tsconfig.web.test.json 检查下面的 @ts-expect-error）：漏资源、漏光学尺寸、拼错执行端名都编译不过", () => {
      const optical = HARNESS_MARKS.pi.optical;
      // @ts-expect-error 缺光学尺寸
      const noOptical: HarnessMarkEntry = { src: "x.svg" };
      // @ts-expect-error 缺资源
      const noSrc: HarnessMarkEntry = { optical };
      // @ts-expect-error 键必须是真实的 HarnessId：拼错就成了一条永远查不到的条目
      const typo = { claud: { src: "x.svg", optical } } satisfies Partial<Record<HarnessId, HarnessMarkEntry>>;
      expect([noOptical, noSrc, typo]).toHaveLength(3);
    });
  });
});
