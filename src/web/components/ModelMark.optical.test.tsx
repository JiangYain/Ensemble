import { readFileSync } from "node:fs";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelFamily } from "../lib/modelFamily";
import { MODEL_MARKS, MODEL_PLACEHOLDERS, ModelMark, ModelSlot, type Optical } from "./ModelMark";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FAMILIES = Object.keys(MODEL_MARKS) as ModelFamily[];

// ───────────────────────── 从 SVG 路径算几何（不依赖 ModelMark 里记的那张表，所以能核对它） ─────────────────────────
// 十二枚标的路径含直线、三次贝塞尔与弧，没有现成的 SVG 渲染器可用：这里把路径展平成折线，
// 包围盒取折线的外接框，面积用 even-odd 的行扫描（x 向精确、y 向 1200 行）。已对照 Chrome 把 SVG 画进 2400×2400 画布的实测，
// 包围盒差在 0.0013 内，面积差在千分之一内（见 ModelMark.tsx 里 MODEL_MARKS 的注释）。

type Pt = [number, number];

const TOKEN = /([MmLlHhVvCcSsAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/gi;

function flatten(d: string): Pt[][] {
  const tokens = [...d.matchAll(TOKEN)].map((m) => (m[1] ?? m[2])!);
  const polys: Pt[][] = [];
  let cur: Pt[] = [];
  let x = 0, y = 0, startX = 0, startY = 0;
  let lastControl: Pt | undefined;
  let i = 0;
  const num = (): number => Number(tokens[i++]);
  // 弧的两个标志位可以和后面的数连写（“00-.998”）：按单个字符读。
  const flag = (): number => {
    const token = tokens[i]!;
    if (token.length === 1) { i++; return Number(token); }
    tokens[i] = token.slice(1);
    return Number(token[0]);
  };
  const push = (px: number, py: number): void => { cur.push([px, py]); x = px; y = py; };
  const cubic = (x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): void => {
    for (let s = 1; s <= 48; s++) {
      const t = s / 48, u = 1 - t;
      push(u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3);
    }
  };
  // SVG 规范 F.6.5：端点参数 → 圆心参数。
  const arc = (x0: number, y0: number, rxIn: number, ryIn: number, phiDeg: number, large: number, sweep: number, x1: number, y1: number): void => {
    if (rxIn === 0 || ryIn === 0) { push(x1, y1); return; }
    const phi = (phiDeg * Math.PI) / 180, cp = Math.cos(phi), sp = Math.sin(phi);
    const dx = (x0 - x1) / 2, dy = (y0 - y1) / 2;
    const xp = cp * dx + sp * dy, yp = -sp * dx + cp * dy;
    let rx = Math.abs(rxIn), ry = Math.abs(ryIn);
    const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
    if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s; }
    const numerator = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
    const denominator = rx * rx * yp * yp + ry * ry * xp * xp;
    const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, numerator / denominator));
    const cxp = (k * rx * yp) / ry, cyp = (-k * ry * xp) / rx;
    const cx = cp * cxp - sp * cyp + (x0 + x1) / 2, cy = sp * cxp + cp * cyp + (y0 + y1) / 2;
    const angle = (ux: number, uy: number, vx: number, vy: number): number => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const theta = angle(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
    let delta = angle((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
    if (!sweep && delta > 0) delta -= 2 * Math.PI;
    else if (sweep && delta < 0) delta += 2 * Math.PI;
    const steps = Math.max(8, Math.ceil(Math.abs(delta) / (Math.PI / 48)));
    for (let s = 1; s <= steps; s++) {
      const t = theta + (delta * s) / steps;
      push(cx + rx * Math.cos(t) * cp - ry * Math.sin(t) * sp, cy + rx * Math.cos(t) * sp + ry * Math.sin(t) * cp);
    }
    x = x1;
    y = y1;
  };

  let command = "";
  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i]!)) command = tokens[i++]!;
    else if (command === "M") command = "L";
    else if (command === "m") command = "l";
    const relative = command === command.toLowerCase();
    const ox = relative ? x : 0, oy = relative ? y : 0;
    switch (command.toUpperCase()) {
      case "M": { if (cur.length > 1) polys.push(cur); cur = []; const nx = num() + ox, ny = num() + oy; push(nx, ny); startX = nx; startY = ny; lastControl = undefined; break; }
      case "L": push(num() + ox, num() + oy); lastControl = undefined; break;
      case "H": push(num() + ox, y); lastControl = undefined; break;
      case "V": push(x, num() + oy); lastControl = undefined; break;
      case "C": { const x0 = x, y0 = y, x1 = num() + ox, y1 = num() + oy, x2 = num() + ox, y2 = num() + oy, x3 = num() + ox, y3 = num() + oy; cubic(x0, y0, x1, y1, x2, y2, x3, y3); lastControl = [x2, y2]; break; }
      case "S": { const x0 = x, y0 = y; const [x1, y1] = lastControl ? [2 * x - lastControl[0], 2 * y - lastControl[1]] : [x, y]; const x2 = num() + ox, y2 = num() + oy, x3 = num() + ox, y3 = num() + oy; cubic(x0, y0, x1!, y1!, x2, y2, x3, y3); lastControl = [x2, y2]; break; }
      case "A": { const x0 = x, y0 = y, rx = num(), ry = num(), phi = num(), large = flag(), sweep = flag(), nx = num() + ox, ny = num() + oy; arc(x0, y0, rx, ry, phi, large, sweep, nx, ny); lastControl = undefined; break; }
      case "Z": if (cur.length) { push(startX, startY); polys.push(cur); cur = []; x = startX; y = startY; } lastControl = undefined; command = ""; break;
      default: throw new Error(`路径里有没处理的命令 ${command}`);
    }
  }
  if (cur.length > 1) polys.push(cur);
  return polys;
}

function boxOf(groups: Pt[][][]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const polys of groups) for (const poly of polys) for (const [px, py] of poly) { x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py); }
  return { x0, y0, x1, y1 };
}

/** even-odd 面积，占 24×24 画布的比例；每个 <path> 单独 even-odd，同一行里各 path 的区间再取并集。 */
function inkOf(groups: Pt[][][]): number {
  const rows = 1200;
  let total = 0;
  for (let r = 0; r < rows; r++) {
    const y = ((r + 0.5) / rows) * 24;
    const spans: Pt[] = [];
    for (const polys of groups) {
      const xs: number[] = [];
      for (const poly of polys) {
        for (let k = 0; k < poly.length; k++) {
          const [ax, ay] = poly[k]!, [bx, by] = poly[(k + 1) % poly.length]!;
          if ((ay <= y && by > y) || (by <= y && ay > y)) xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) spans.push([xs[k]!, xs[k + 1]!]);
    }
    spans.sort((a, b) => a[0] - b[0]);
    let end = -Infinity;
    for (const [a, b] of spans) {
      if (b <= end) continue;
      total += b - Math.max(a, end);
      end = b;
    }
  }
  return total / rows / 24;
}

interface Ink {
  /** 可见包围盒，占 24 画布边长的比例。 */
  box: Optical;
  /** 可见墨量占画布面积的比例。 */
  ink: number;
}

function inkOfFile(family: ModelFamily): Ink {
  const svg = readFileSync(`src/web/marks/models/${family}.svg`, "utf8");
  expect(svg.match(/viewBox="([^"]+)"/)![1]).toBe("0 0 24 24"); // 表按 24 画布写；换了画布必须重量
  const groups = [...svg.matchAll(/<path\b[^>]*?\sd="([^"]+)"/g)].map((m) => flatten(m[1]!));
  const { x0, y0, x1, y1 } = boxOf(groups);
  return { box: { left: x0 / 24, top: y0 / 24, width: (x1 - x0) / 24, height: (y1 - y0) / 24, reach: 0 }, ink: inkOf(groups) };
}

/** 家族标 SVG 展平后的折线组（每个 <path> 一组），按 24 画布。 */
function groupsOfFile(family: ModelFamily): Pt[][][] {
  const svg = readFileSync(`src/web/marks/models/${family}.svg`, "utf8");
  return [...svg.matchAll(/<path\b[^>]*?\sd="([^"]+)"/g)].map((m) => flatten(m[1]!));
}

/**
 * 把图形按 ModelSlot 实际渲染出的图片框（边长 g，左上角在 (0, 竖向居中的偏移)）与平移放进 size×size 的格子，
 * 按 16×16 超采样取每个像素的覆盖率——眼睛看到的“可见”是覆盖率过半的像素，而不是 2400px 画布上连发丝都算的包围盒。
 */
function rasterize(groups: Pt[][][], g: number, tx: number, ty: number, size: number): number[][] {
  const SS = 16;
  const n = size * SS;
  const place = ([x, y]: Pt): Pt => [(x / 24) * g + tx, (y / 24) * g + ty];
  const placed = groups.map((polys) => polys.map((poly) => poly.map(place)));
  const cover = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  for (let r = 0; r < n; r++) {
    const y = (r + 0.5) / SS;
    const hit = new Uint8Array(n);
    for (const polys of placed) {
      const xs: number[] = [];
      for (const poly of polys) {
        for (let k = 0; k < poly.length; k++) {
          const [ax, ay] = poly[k]!, [bx, by] = poly[(k + 1) % poly.length]!;
          if ((ay <= y && by > y) || (by <= y && ay > y)) xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let c = Math.max(0, Math.round(xs[k]! * SS)); c < Math.min(n, Math.round(xs[k + 1]! * SS)); c++) hit[c] = 1;
      }
    }
    const row = cover[Math.floor(r / SS)]!;
    for (let c = 0; c < n; c++) if (hit[c]) row[Math.floor(c / SS)]! += 1 / (SS * SS);
  }
  return cover;
}

/** 覆盖率 ≥ 1/2 的像素的包围盒（含端点的列 / 行号）。 */
function visibleBox(cover: number[][]): { l: number; r: number; t: number; b: number } {
  let l = Infinity, r = -1, t = Infinity, b = -1;
  cover.forEach((row, y) => row.forEach((c, x) => { if (c >= 0.5) { l = Math.min(l, x); r = Math.max(r, x); t = Math.min(t, y); b = Math.max(b, y); } }));
  return { l, r, t, b };
}

/**
 * 占位线图的可见包围盒。线帽是方头、线角是斜接（上限取自 Icons.tsx 的 MITER_LIMIT），所以不是“中心线外接框 + 半个线宽”：
 * 尖角的斜接尖端伸得比半个线宽远，超过上限的尖角又被削平。做法是把每一段中心线画成矩形（开口路径的两端各伸出半个线宽），
 * 每个没超限的拐角再加上斜接的尖端，取这些点的外接框。路径与斜接上限都读自 Icons.tsx，换了就对不上。
 */
function strokedBox(icon: "sparkle" | "flask", stroke: number): Optical {
  const source = readFileSync("src/web/components/Icons.tsx", "utf8");
  const d = new RegExp(`\\b${icon}: "([^"]+)"`).exec(source)![1]!;
  const limit = Number(/const MITER_LIMIT = ([\d.]+);/.exec(source)![1]);
  const half = stroke / 2;
  const pts: Pt[] = [];
  for (const raw of flatten(d)) {
    const poly = raw.filter(([px, py], k) => k === 0 || px !== raw[k - 1]![0] || py !== raw[k - 1]![1]);
    const closed = poly.length > 2 && poly[0]![0] === poly[poly.length - 1]![0] && poly[0]![1] === poly[poly.length - 1]![1];
    const segs = poly.slice(1).map((b, k) => {
      const a = poly[k]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      return { a, b, u: [(b[0] - a[0]) / len, (b[1] - a[1]) / len] as Pt };
    });
    segs.forEach(({ a, b, u }, k) => {
      const start: Pt = !closed && k === 0 ? [a[0] - u[0] * half, a[1] - u[1] * half] : a;
      const end: Pt = !closed && k === segs.length - 1 ? [b[0] + u[0] * half, b[1] + u[1] * half] : b;
      const nx = -u[1] * half, ny = u[0] * half;
      pts.push([start[0] + nx, start[1] + ny], [start[0] - nx, start[1] - ny], [end[0] + nx, end[1] + ny], [end[0] - nx, end[1] - ny]);
    });
    const joins = closed ? segs.length : segs.length - 1;
    for (let k = 0; k < joins; k++) {
      const s1 = segs[k]!, s2 = segs[(k + 1) % segs.length]!;
      const turn = Math.acos(Math.max(-1, Math.min(1, s1.u[0] * s2.u[0] + s1.u[1] * s2.u[1])));
      if (turn < 1e-9) continue; // 直通，没有拐角
      const ratio = 1 / Math.sin((Math.PI - turn) / 2); // 斜接长度 / 线宽（SVG 规范里与 stroke-miterlimit 比的就是它）
      if (ratio > limit) continue; // 超限：削平，斜面的两个角点已经在各段的矩形里
      // 拐角外侧的方向：两段法线之和；朝哪一侧由转向（叉积的正负）决定。
      const cross = s1.u[0] * s2.u[1] - s1.u[1] * s2.u[0];
      const side = cross > 0 ? -1 : 1;
      const bx = side * (-s1.u[1] - s2.u[1]), by = side * (s1.u[0] + s2.u[0]);
      const bl = Math.hypot(bx, by);
      pts.push([s1.b[0] + (bx / bl) * half * ratio, s1.b[1] + (by / bl) * half * ratio]);
    }
  }
  const { x0, y0, x1, y1 } = boxOf([[pts]]);
  return { left: x0 / 24, top: y0 / 24, width: (x1 - x0) / 24, height: (y1 - y0) / 24, reach: 0 };
}

describe("模型标 ModelSlot：24px 的头像格", () => {
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
  const translateOf = (el: Element): [number, number] => {
    const raw = (el as HTMLElement).style.translate || /translate:\s*([^;]+)/.exec(el.getAttribute("style") ?? "")?.[1] || "";
    const [tx, ty] = raw.split(/\s+/).map((v) => parseFloat(v)) as [number, number];
    return [tx, ty];
  };
  const px = (value: string | null | undefined): number => parseFloat(value ?? "");

  describe("光学表按 SVG 文件核对", () => {
    it("注册表：十二个家族，资源与光学大小一个不缺", () => {
      expect([...FAMILIES].sort()).toEqual(["claude", "composer", "deepseek", "gemini", "glm", "grok", "kimi", "llama", "minimax", "mistral", "openai", "qwen"]);
      for (const family of FAMILIES) {
        // vitest 把小 SVG 内联成 data: URI，构建则是文件地址；两种都是非空字符串，内容由下面按文件核对。
        expect(MODEL_MARKS[family].src, family).toMatch(/svg/);
        expect(MODEL_MARKS[family].optical.reach, family).toBeGreaterThan(0.7);
        expect(MODEL_MARKS[family].optical.reach, family).toBeLessThanOrEqual(1);
      }
    });

    it("表里的可见包围盒就是文件里路径的包围盒（容差 0.002，约 0.05px）", () => {
      for (const family of FAMILIES) {
        const { box } = inkOfFile(family);
        const table = MODEL_MARKS[family].optical;
        expect(Math.abs(table.left - box.left), `${family} left`).toBeLessThan(0.002);
        expect(Math.abs(table.top - box.top), `${family} top`).toBeLessThan(0.002);
        expect(Math.abs(table.width - box.width), `${family} width`).toBeLessThan(0.002);
        expect(Math.abs(table.height - box.height), `${family} height`).toBeLessThan(0.002);
      }
    });

    it("长边取整像素（格子 24 时），实心的收、开阔的占满：可见面积落在窄带里", () => {
      const areas: Record<string, number> = {};
      const full: Record<string, number> = {};
      for (const family of FAMILIES) {
        const { ink } = inkOfFile(family);
        const { width, height, reach } = MODEL_MARKS[family].optical;
        const long = Math.max(width, height);
        expect(24 * reach, `${family} 长边是整像素`).toBeCloseTo(Math.round(24 * reach), 6);
        const area = (size: number, r: number): number => ink * ((size * r) / long) ** 2;
        areas[family] = area(24, reach);
        full[family] = area(24, 1);
      }
      const sorted = Object.values(areas).sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)]!;
      // 满格时最轻的是 grok（约 130）、最重的是 qwen（约 287），差 2.2 倍；收完之后最大 / 最小 1.48。
      expect(Math.max(...Object.values(full)) / Math.min(...Object.values(full))).toBeGreaterThan(2);
      expect(sorted[sorted.length - 1]! / sorted[0]!).toBeLessThan(1.5);
      for (const family of FAMILIES) {
        expect(areas[family]! / median, `${family} 面积 ${areas[family]!.toFixed(0)} px²`).toBeGreaterThan(0.7);
        expect(areas[family]! / median, `${family} 面积 ${areas[family]!.toFixed(0)} px²`).toBeLessThan(1.1);
        // 满格就偏重的标必须收，满格就偏轻的标必须占满：不能两头都收，也不能谁都不收。
        if (full[family]! > 230) expect(MODEL_MARKS[family].optical.reach, family).toBeLessThan(0.9);
        if (full[family]! < 180) expect(MODEL_MARKS[family].optical.reach, family).toBe(1);
      }
      // 记下来的数字（见 MODEL_MARKS 的注释）：中位数与最小值。
      expect(median).toBeGreaterThan(175);
      expect(median).toBeLessThan(185);
      expect(sorted[0]).toBeGreaterThan(125);
      expect(sorted[0]).toBeLessThan(135);
    });

    it("占位线图的可见包围盒：方头线帽 + 斜接线角（超限削平），与表一致", () => {
      for (const [kind, { icon, stroke, optical }] of Object.entries(MODEL_PLACEHOLDERS)) {
        const box = strokedBox(icon, stroke);
        expect(Math.abs(optical.left - box.left), `${kind} left`).toBeLessThan(0.002);
        expect(Math.abs(optical.top - box.top), `${kind} top`).toBeLessThan(0.002);
        expect(Math.abs(optical.width - box.width), `${kind} width`).toBeLessThan(0.002);
        expect(Math.abs(optical.height - box.height), `${kind} height`).toBeLessThan(0.002);
        // 屏幕上的描边宽度：两个占位同为约 1.5px。
        const g = (24 * optical.reach) / Math.max(optical.width, optical.height);
        expect((stroke * g) / 24, `${kind} 描边`).toBeCloseTo(1.5, 1);
      }
      // 占位是线图，比实心标轻（墨量按路径长度 × 线宽粗算，约 87 / 107 px²，家族标最轻的 grok 是 130）：长边不占满格子，闪光比烧瓶更小。
      expect(MODEL_PLACEHOLDERS.unknown.optical.reach).toBeLessThan(MODEL_PLACEHOLDERS.simulated.optical.reach);
      expect(MODEL_PLACEHOLDERS.simulated.optical.reach).toBeLessThan(1);
    });
  });

  describe("渲染：可见图形的左缘贴格子左缘，竖向居中", () => {
    for (const size of [24, 36]) {
      it(`十二个家族：左缘 = 0，竖向中心 = ${size / 2}，长边 = 约定的光学大小（格子 ${size}）`, () => {
        for (const family of FAMILIES) {
          render(<ModelSlot family={family} size={size} />);
          const slot = host.querySelector<HTMLElement>(".model-slot")!;
          expect(slot.style.width, family).toBe(`${size}px`);
          expect(slot.style.height, family).toBe(`${size}px`);
          const mark = slot.querySelector<HTMLElement>(".model-mark")!;
          expect(mark.getAttribute("data-family"), family).toBe(family);
          const g = px(mark.style.width);
          expect(px(mark.style.height), family).toBe(g);
          const [tx, ty] = translateOf(mark);

          // 以文件里路径的包围盒为准（不用表）：图片框 g 见方，由 flex 竖向居中，再按 translate 平移。
          const { box } = inkOfFile(family);
          const left = tx + box.left * g;
          const top = (size - g) / 2 + ty + box.top * g;
          const width = box.width * g;
          const height = box.height * g;
          // 左缘 = 0；只有带 hang 的家族（grok）让发丝尾巴悬在格子外 hang·g，环体才贴着左缘（见下一个用例）。
          expect(left, `${family} 左缘`).toBeCloseTo(-(MODEL_MARKS[family].optical.hang ?? 0) * g, 1);
          expect(top + height / 2, `${family} 竖向中心`).toBeCloseTo(size / 2, 1);
          expect(Math.max(width, height), `${family} 长边`).toBeCloseTo(size * MODEL_MARKS[family].optical.reach, 1);
        }
      });
    }

    it("24px 实际光栅：十二个家族覆盖率过半的最左列都是第 0 列，竖向中心都在 12（眼睛看到的左缘贴着列轴）", () => {
      for (const family of FAMILIES) {
        render(<ModelSlot family={family} />);
        const mark = host.querySelector<HTMLElement>(".model-mark")!;
        const g = px(mark.style.width);
        const [tx, ty] = translateOf(mark);
        const cover = rasterize(groupsOfFile(family), g, tx, (24 - g) / 2 + ty, 24);
        const { l, r, t, b } = visibleBox(cover);
        expect(l, `${family} 左缘列`).toBe(0);
        expect(Math.abs((t + b + 1) / 2 - 12), `${family} 竖向中心 ${(t + b + 1) / 2}`).toBeLessThanOrEqual(0.5);
        // 长边（可见像素）：环体 / 图形都落在格子里，没有被平移推出右缘或上下缘。
        expect(r, `${family} 右缘列`).toBeLessThanOrEqual(23);
        expect(t, `${family} 上缘行`).toBeGreaterThanOrEqual(0);
        expect(b, `${family} 下缘行`).toBeLessThanOrEqual(23);
      }
    });

    it("grok 是唯一带 hang 的家族：它左下角的发丝尾巴不到 1px、覆盖率不过半，贴列轴的是环体而不是尾尖", () => {
      expect(FAMILIES.filter((family) => MODEL_MARKS[family].optical.hang !== undefined)).toEqual(["grok"]);
      // 环体最左点：尾巴只出现在 y>17（左下）与 y<8（右上），y∈[8,16] 这一带全是环体。
      const points = groupsOfFile("grok").flat(2).filter(([, y]) => y >= 8 && y <= 16);
      const ringLeft = Math.min(...points.map(([x]) => x)) / 24;
      const { box } = inkOfFile("grok");
      expect(Math.abs(MODEL_MARKS.grok.optical.hang! - (ringLeft - box.left)), "hang = 环体最左点 − 包围盒左缘").toBeLessThan(0.002);
      // 不带 hang 时，覆盖率过半的最左列是 3：环体比尾尖靠里 3px，旁边的执行端图标与标题的列轴都在 x=14，对不上。
      const g = (24 * MODEL_MARKS.grok.optical.reach) / Math.max(MODEL_MARKS.grok.optical.width, MODEL_MARKS.grok.optical.height);
      const bare = rasterize(groupsOfFile("grok"), g, -MODEL_MARKS.grok.optical.left * g, (24 - g) / 2 + (0.5 - MODEL_MARKS.grok.optical.top - MODEL_MARKS.grok.optical.height / 2) * g, 24);
      expect(visibleBox(bare).l).toBe(3);
    });

    it("家族标仍是遮罩 + 品牌色层的 .model-mark：没有 data-placeholder，不带读屏文字", () => {
      render(<ModelSlot family="claude" />);
      const slot = host.querySelector<HTMLElement>(".model-slot")!;
      expect(slot.hasAttribute("data-placeholder")).toBe(false);
      expect(slot.getAttribute("aria-hidden")).toBe("true");
      expect(slot.querySelector(".model-glyph")).toBeNull();
      expect(slot.querySelector<HTMLElement>(".model-mark")!.getAttribute("style")).toContain(`--mark: url("${MODEL_MARKS.claude.src}")`);
    });

    it("认不出的模型：画中性的闪光，不画任何家族标；左缘同样贴格子左缘、竖向居中", () => {
      render(<ModelSlot family={undefined} />);
      const slot = host.querySelector<HTMLElement>(".model-slot")!;
      expect(slot.getAttribute("data-placeholder")).toBe("unknown");
      expect(slot.querySelector(".model-mark")).toBeNull();
      const icon = slot.querySelector<SVGElement>("svg.model-glyph")!;
      const g = px(icon.getAttribute("width"));
      const [tx, ty] = translateOf(icon);
      const box = strokedBox("sparkle", MODEL_PLACEHOLDERS.unknown.stroke);
      expect(tx + box.left * g).toBeCloseTo(0, 1);
      expect((24 - g) / 2 + ty + (box.top + box.height / 2) * g).toBeCloseTo(12, 1);
      expect(Math.max(box.width, box.height) * g).toBeCloseTo(18, 1);
      expect(icon.getAttribute("stroke-width")).toBe(String(MODEL_PLACEHOLDERS.unknown.stroke));
    });

    it("模拟执行：画烧瓶，即使名字像某个家族也不画那个家族的标", () => {
      render(<ModelSlot family="deepseek" simulated />);
      const slot = host.querySelector<HTMLElement>(".model-slot")!;
      expect(slot.getAttribute("data-placeholder")).toBe("simulated");
      expect(slot.querySelector(".model-mark")).toBeNull();
      const icon = slot.querySelector<SVGElement>("svg.model-glyph")!;
      const g = px(icon.getAttribute("width"));
      const [tx, ty] = translateOf(icon);
      const box = strokedBox("flask", MODEL_PLACEHOLDERS.simulated.stroke);
      expect(tx + box.left * g).toBeCloseTo(0, 1);
      expect((24 - g) / 2 + ty + (box.top + box.height / 2) * g).toBeCloseTo(12, 1);
      expect(Math.max(box.width, box.height) * g).toBeCloseTo(20, 1);
    });
  });

  describe("12px 的 ModelMark 不受影响", () => {
    it("还是一个带 data-family 的遮罩 span：没有外层格子，没有平移，样式字符串与原来一字不差", () => {
      for (const family of FAMILIES) {
        render(<ModelMark family={family} />);
        expect(host.querySelector(".model-slot")).toBeNull();
        const mark = host.firstElementChild as HTMLElement;
        expect(mark.tagName).toBe("SPAN");
        expect(mark.className).toBe("model-mark");
        expect(mark.getAttribute("data-family")).toBe(family);
        expect(mark.getAttribute("aria-hidden")).toBe("true");
        expect(mark.getAttribute("style")).toBe(`width: 12px; height: 12px; --mark: url("${MODEL_MARKS[family].src}");`);
        expect(mark.children).toHaveLength(0);
      }
    });

    it("size 照旧可调（设置窗口“执行端”分区里的模型列表用 14：放进 16 的格子，左右各 1）", () => {
      render(<ModelMark family="kimi" size={14} />);
      expect((host.firstElementChild as HTMLElement).getAttribute("style")).toBe(`width: 14px; height: 14px; --mark: url("${MODEL_MARKS.kimi.src}");`);
    });
  });
});
