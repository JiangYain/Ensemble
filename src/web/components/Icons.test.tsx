import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Icon } from "./Icons";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("图标", () => {
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

  const plateOf = (svg: Element): Element => [...svg.children].find((child) => child.localName === "path")!;

  it("Git 标是实心菱形底（填 currentColor、不描边），分叉用 mask 镂出：三个节点加一条干线与支线", () => {
    act(() => root.render(<Icon name="git" size={12.6} />));
    const svg = host.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("12.6");
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("fill")).toBe("currentColor");
    expect(svg.hasAttribute("stroke")).toBe(false);
    expect(svg.getAttribute("aria-hidden")).toBe("true");

    const mask = svg.querySelector("mask")!;
    // 节点是转了 45° 的方块（没有圆）：一块铺满的白底加三个节点，共四个 rect；第一个 rect 是白底。
    expect(mask.querySelectorAll("circle")).toHaveLength(0);
    expect(mask.querySelectorAll("rect")).toHaveLength(4);
    expect(mask.querySelectorAll("rect[transform]")).toHaveLength(3);
    expect(mask.querySelectorAll("path")).toHaveLength(1);
    // 镂空线宽取 1.9：12.6px 下正好 1 个 CSS 像素（见 Icons.tsx 里的说明）。
    expect(mask.querySelector("path")!.getAttribute("stroke-width")).toBe("1.9");
    expect(mask.querySelector("path")!.getAttribute("stroke-linecap")).toBe("square");
    expect(plateOf(svg).getAttribute("mask")).toBe(`url(#${mask.id})`);
  });

  it("同屏的几个 Git 标各用各的 mask：id 互不相同，也不含冒号，可以直接写进 url(#…)", () => {
    act(() =>
      root.render(
        <>
          <Icon name="git" />
          <Icon name="git" />
        </>,
      ),
    );
    const masks = [...host.querySelectorAll("mask")];
    expect(masks).toHaveLength(2);
    expect(masks[0]!.id).not.toBe(masks[1]!.id);
    for (const mask of masks) expect(mask.id).toMatch(/^git-fork-[A-Za-z0-9_-]+$/);
  });

  it("实心图标（点点点、停止、小点）都是方块：没有 circle / ellipse，也没有 rx / ry", () => {
    for (const name of ["more", "stop", "dot"] as const) {
      act(() => root.render(<Icon name={name} />));
      const svg = host.querySelector("svg")!;
      expect(svg.querySelectorAll("circle, ellipse"), name).toHaveLength(0);
      expect(svg.querySelectorAll("[rx], [ry]"), name).toHaveLength(0);
      expect(svg.querySelectorAll("rect").length, name).toBeGreaterThan(0);
    }
  });

  it("Git 标与分支行用的 branch 形状不同；其余线性图标仍是 1.7 描边、不填充的单条路径", () => {
    act(() => root.render(<Icon name="branch" />));
    const branch = host.querySelector("svg")!;
    expect(branch.getAttribute("fill")).toBe("none");
    expect(branch.getAttribute("stroke")).toBe("currentColor");
    expect(branch.getAttribute("stroke-width")).toBe("1.7");
    // 线的两端是方头、转角是斜接，没有圆头圆角（守卫见 lib/corner-system.test.ts）。
    expect(branch.getAttribute("stroke-linecap")).toBe("square");
    expect(branch.getAttribute("stroke-linejoin")).toBe("miter");
    expect(Number(branch.getAttribute("stroke-miterlimit"))).toBeGreaterThan(1);
    expect(branch.querySelector("mask")).toBeNull();
    const branchPath = branch.querySelector("path")!.getAttribute("d");

    act(() => root.render(<Icon name="git" />));
    expect(plateOf(host.querySelector("svg")!).getAttribute("d")).not.toBe(branchPath);
  });

  describe("设置（齿轮）", () => {
    const gear = (): string => {
      act(() => root.render(<Icon name="settings" />));
      return host.querySelector("path")!.getAttribute("d")!;
    };

    it("与其他线性图标同一套：1.7 描边、不填充、currentColor；一条路径，外轮廓加中心孔两个子路径", () => {
      act(() => root.render(<Icon name="settings" />));
      const svg = host.querySelector("svg")!;
      expect(svg.getAttribute("fill")).toBe("none");
      expect(svg.getAttribute("stroke")).toBe("currentColor");
      expect(svg.getAttribute("stroke-width")).toBe("1.7");
      expect(svg.getAttribute("aria-hidden")).toBe("true");
      expect(svg.querySelectorAll("path")).toHaveLength(1);
      expect(gear().match(/M/g)).toHaveLength(2);
    });

    it("六齿：外圈十二段弧（齿顶与齿根各六）；中心孔是一条 a 命令（两段半圆）；所有坐标落在 24 格内且留出 3 以上的边（16px 下不被裁、不糊成圆块）", () => {
      const d = gear();
      expect(d.match(/A/g)).toHaveLength(12);
      expect(d.match(/a/g)).toHaveLength(1);
      const numbers = d.replace(/[Aa][^A-Za-z]*/g, "").match(/-?\d+(\.\d+)?/g)!.map(Number);
      for (const value of numbers) expect(value).toBeGreaterThanOrEqual(3);
      for (const value of numbers) expect(value).toBeLessThanOrEqual(21);
    });

    it("和导航里用的 layers、globe 不是同一个形状", () => {
      const own = gear();
      for (const name of ["layers", "globe"] as const) {
        act(() => root.render(<Icon name={name} />));
        expect(host.querySelector("path")!.getAttribute("d")).not.toBe(own);
      }
    });
  });

  describe("归档 / 取消归档 / 导出", () => {
    const names = ["archive", "unarchive", "download"] as const;
    const pathOf = (name: (typeof names)[number] | "inbox"): string => {
      act(() => root.render(<Icon name={name} />));
      return host.querySelector("path")!.getAttribute("d")!;
    };

    it("与其他线性图标同一套：1.7 描边、不填充、方头斜接，一条路径，没有圆", () => {
      for (const name of names) {
        act(() => root.render(<Icon name={name} />));
        const svg = host.querySelector("svg")!;
        expect(svg.getAttribute("fill"), name).toBe("none");
        expect(svg.getAttribute("stroke"), name).toBe("currentColor");
        expect(svg.getAttribute("stroke-width"), name).toBe("1.7");
        expect(svg.getAttribute("stroke-linecap"), name).toBe("square");
        expect(svg.getAttribute("stroke-linejoin"), name).toBe("miter");
        expect(svg.getAttribute("aria-hidden"), name).toBe("true");
        expect(svg.querySelectorAll("path"), name).toHaveLength(1);
        expect(svg.querySelectorAll("circle, ellipse, [rx], [ry]"), name).toHaveLength(0);
      }
    });

    it("全是直线：路径里没有弧线（A / a）也没有曲线（C / S / Q / T）命令", () => {
      for (const name of names) expect(pathOf(name), name).not.toMatch(/[AaCcSsQqTt]/);
    });

    it("三个形状互不相同，也和收件箱不是同一个形状（菜单里它们会挨在一起）", () => {
      const shapes = [...names, "inbox" as const].map(pathOf);
      expect(new Set(shapes).size).toBe(shapes.length);
    });
  });
});
