import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionLayer } from "./connections";
import type { LayoutEdge } from "./layout";
import { pipePath, ROUTE } from "./pipes";

/**
 * 连接层本身的测试：不经过 SceneEngine，节点位置由测试手写、时间由测试直接传进 frame。
 * 引擎里连线与端口的整体行为另见 engine.pipes.test.ts。
 */

const SVG_NS = "http://www.w3.org/2000/svg";

interface Body { x: number; y: number; tx: number; ty: number; w: number; h: number }

const edge = (from: string, to: string, phase: LayoutEdge["phase"] = "running"): LayoutEdge => ({ id: `${from}>${to}`, from, to, phase });

interface Setup {
  layer: ConnectionLayer;
  tube: SVGGElement;
  dots: SVGGElement;
  els: Map<string, HTMLElement>;
  bodies: Map<string, Body>;
  /** 放一个节点（位置、目标位置相同）并注册它的元素。 */
  put: (id: string, x: number, y: number, size?: { w: number; h: number }) => Body;
  /** 把节点挪到新位置（位置与目标同时到位，等于拖动）。 */
  move: (id: string, x: number, y: number) => void;
  frame: (now?: number, reduced?: boolean) => boolean;
}

function setup(): Setup {
  const tube = document.createElementNS(SVG_NS, "g");
  const dots = document.createElementNS(SVG_NS, "g");
  document.body.append(tube, dots);
  const layer = new ConnectionLayer();
  const els = new Map<string, HTMLElement>();
  const bodies = new Map<string, Body>();
  const put = (id: string, x: number, y: number, size = { w: 212, h: 112 }): Body => {
    const el = document.createElement("div");
    document.body.append(el);
    els.set(id, el);
    layer.register(id, el);
    const body = { x, y, tx: x, ty: y, ...size };
    bodies.set(id, body);
    return body;
  };
  const move = (id: string, x: number, y: number): void => {
    const body = bodies.get(id)!;
    body.x = body.tx = x;
    body.y = body.ty = y;
  };
  layer.mount({ tube, dots });
  return { layer, tube, dots, els, bodies, put, move, frame: (now = 0, reduced = false) => layer.frame(bodies, now, reduced) };
}

const pathsOf = (tube: SVGGElement): SVGPathElement[] => [...tube.querySelectorAll("path")];
const dOf = (tube: SVGGElement): string[] => pathsOf(tube).map((path) => path.getAttribute("d") ?? "");
const phasesOf = (tube: SVGGElement): (string | null)[] => pathsOf(tube).map((path) => path.getAttribute("data-phase"));
const numbersOf = (text: string): number[] => (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
const startOf = (d: string): number[] => numbersOf(d).slice(0, 2);
const endOf = (d: string): number[] => numbersOf(d).slice(-2);

const portsOf = (el: HTMLElement): HTMLElement[] => ([...el.children] as HTMLElement[]).filter((child) => child.classList.contains("node-port"));
/** 点亮的方点所在的边（排序后）。 */
const lit = (el: HTMLElement): string[] => portsOf(el).filter((dot) => dot.hasAttribute("data-on")).map((dot) => dot.getAttribute("data-side")!).sort();
const dotOf = (el: HTMLElement, side: string): HTMLElement => portsOf(el).find((dot) => dot.getAttribute("data-side") === side)!;

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("ConnectionLayer · 边集合", () => {
  it("sync 按边增删连线：留下的连线沿用同一个元素，拆掉的连线连渐变一起拿走", () => {
    const s = setup();
    s.put("o", 0, 0);
    s.put("a", 400, 0);
    s.put("b", 400, 200);
    s.put("c", 400, 400);
    s.layer.sync([edge("o", "a"), edge("o", "b")]);
    s.frame();
    const [toA, toB] = pathsOf(s.tube);
    expect(pathsOf(s.tube)).toHaveLength(2);
    expect(s.dots.querySelectorAll("linearGradient")).toHaveLength(2);

    s.layer.sync([edge("o", "b"), edge("o", "c")]);
    s.frame();
    const now = pathsOf(s.tube);
    expect(now).toHaveLength(2);
    expect(now).toContain(toB);
    expect(now).not.toContain(toA);
    expect(toA!.isConnected).toBe(false);
    expect(s.dots.querySelectorAll("linearGradient")).toHaveLength(2);

    s.layer.sync([]);
    s.frame();
    expect(pathsOf(s.tube)).toHaveLength(0);
    expect(s.dots.children).toHaveLength(0);
  });

  it("没有 mount 之前 sync 什么也不做；mount 之后重新 sync 才有连线", () => {
    const tube = document.createElementNS(SVG_NS, "g");
    const dots = document.createElementNS(SVG_NS, "g");
    const layer = new ConnectionLayer();
    layer.sync([edge("o", "a")]);
    layer.mount({ tube, dots });
    expect(pathsOf(tube)).toHaveLength(0);
    layer.sync([edge("o", "a")]);
    expect(pathsOf(tube)).toHaveLength(1);
  });

  it("一端不在 bodies 里：这条线不画（路径不写），也不点亮任何方点，不抛错", () => {
    const s = setup();
    s.put("o", 0, 0);
    s.layer.sync([edge("o", "ghost")]);
    expect(() => s.frame()).not.toThrow();
    expect(dOf(s.tube)).toEqual([""]);
    expect(lit(s.els.get("o")!)).toEqual([]);
  });

  it("来源 → 会话、会话 → 会话、归属线在 DOM 上没有区别：管壁只带阶段，不按起点类型再打标（样式一视同仁，见 pipes.style.test.ts）", () => {
    const s = setup();
    for (const [id, x] of [["git:g", -400], ["origin:o", 0], ["agent:a", 400], ["agent:b", 800]] as const) s.put(id, x, 0);
    s.layer.sync([edge("git:g", "origin:o", "link"), edge("origin:o", "agent:a", "done"), edge("agent:a", "agent:b", "done")]);
    s.frame();
    const names = pathsOf(s.tube).map((path) => path.getAttributeNames().sort());
    expect(names).toHaveLength(3);
    expect(names[1]).toEqual(names[0]);
    expect(names[2]).toEqual(names[0]);
    expect(names[0]).toContain("data-phase");
    expect(names[0]).not.toContain("data-kind");
  });
});

describe("ConnectionLayer · 层叠顺序", () => {
  it("越活跃的连线越靠上（DOM 里越靠后）：running > failed > starting/queued > done > 其余；同级按 id", () => {
    const s = setup();
    for (const id of ["o", "a", "b", "c", "d", "e"]) s.put(id, 0, 0);
    s.layer.sync([edge("o", "a", "running"), edge("o", "b", "link"), edge("o", "c", "failed"), edge("o", "d", "done"), edge("o", "e", "queued")]);
    expect(phasesOf(s.tube)).toEqual(["link", "done", "queued", "failed", "running"]);
    // 一条线的流动点、渐变与管壁在各自的组里按同一个顺序排。
    const classes = [...s.dots.children].filter((child) => child.getAttribute("class") === "pipe-fine").map((child) => child.getAttribute("data-phase"));
    expect(classes).toEqual(["link", "done", "queued", "failed", "running"]);
  });

  it("阶段变了，顺序跟着变；顺序没变就不碰 DOM（哪怕边数组是新的）", () => {
    const s = setup();
    for (const id of ["o", "a", "b"]) s.put(id, 0, 0);
    s.layer.sync([edge("o", "a", "done"), edge("o", "b", "running")]);
    const appends = vi.spyOn(s.tube, "appendChild");
    const dotAppends = vi.spyOn(s.dots, "appendChild");
    s.layer.sync([edge("o", "a", "done"), edge("o", "b", "running")]);
    s.layer.sync([edge("o", "b", "running"), edge("o", "a", "done")]);
    expect(appends).not.toHaveBeenCalled();
    expect(dotAppends).not.toHaveBeenCalled();
    s.layer.sync([edge("o", "a", "running"), edge("o", "b", "done")]);
    expect(appends).toHaveBeenCalled();
    expect(phasesOf(s.tube)).toEqual(["done", "running"]);
  });

  it("来源扇出的静止线再多，也压不住会话之间活跃的线：层叠只看阶段，与线从来源还是从会话出发无关", () => {
    const s = setup();
    const targets = Array.from({ length: 12 }, (_, index) => `agent:t${index}`);
    for (const id of ["origin:o", ...targets, "agent:n1", "agent:n2"]) s.put(id, 0, 0);
    s.layer.sync([
      // 活跃的线故意排在输入的最前面，而且 id 以 "agent:" 开头（字典序在 "origin:" 之前）：顺序不能取决于输入的先后或 id 的写法。
      edge("agent:t0", "agent:n1", "running"),
      edge("agent:t1", "agent:n2", "failed"),
      ...targets.map((id) => edge("origin:o", id, "done")),
    ]);
    const phases = phasesOf(s.tube);
    expect(phases.slice(0, 12)).toEqual(Array.from({ length: 12 }, () => "done"));
    expect(phases.slice(12)).toEqual(["failed", "running"]);
  });
});

describe("ConnectionLayer · 曲线与过渡", () => {
  const source = (): Setup => {
    const s = setup();
    s.put("o", 0, 30);
    s.put("a", 240, 180);
    s.layer.sync([edge("o", "a")]);
    return s;
  };

  it("默认从左到右：来源右缘中点到目标左缘中点", () => {
    const s = source();
    s.frame();
    expect(dOf(s.tube)).toEqual([pipePath({ x: 212, y: 86 }, { x: 240, y: 236 })]);
  });

  it("换边：第一帧的曲线就是上一帧画着的那条，之后每帧位移受控，0.24 秒后与新路线逐位相同", () => {
    const s = source();
    expect(s.frame(0)).toBe(false);
    const before = dOf(s.tube)[0]!;
    s.move("a", 217, 180); // 水平空隙 5 < 6：RIGHT → DOWN
    expect(s.frame(1000)).toBe(true);
    const first = dOf(s.tube)[0]!;
    expect(startOf(first)).toEqual(startOf(before));
    expect(endOf(first)).toEqual(endOf(before));

    const steps = Math.round((ROUTE.morph * 1000) / 16);
    let busy = true;
    let last = first;
    let worst = 0;
    for (let i = 1; i <= steps - 1; i++) {
      busy = s.frame(1000 + i * 16);
      const d = dOf(s.tube)[0]!;
      worst = Math.max(worst, Math.hypot(startOf(d)[0]! - startOf(last)[0]!, startOf(d)[1]! - startOf(last)[1]!));
      last = d;
      expect(busy).toBe(true);
    }
    // 总位移约 120：没有过渡的话一帧就跳完。
    expect(worst).toBeLessThan(120 / 4);
    expect(last).not.toBe("M106 142C106 161 323 161 323 180");
    busy = s.frame(1000 + ROUTE.morph * 1000);
    expect(busy).toBe(false);
    expect(dOf(s.tube)).toEqual(["M106 142C106 161 323 161 323 180"]);
  });

  it("过渡中节点继续被拖：两端贴着各自的节点，没有 NaN", () => {
    const s = source();
    s.frame(0);
    s.move("a", 217, 180);
    s.frame(1000);
    for (let i = 1; i <= 6; i++) {
      s.move("a", 217 - i * 7, 180);
      s.frame(1000 + i * 16);
      expect(dOf(s.tube)[0]).not.toMatch(/NaN|Infinity/);
    }
    s.frame(3000);
    expect(dOf(s.tube)).toEqual(["M106 142C106 161 281 161 281 180"]);
  });

  it("减少动效：换边直接到位，没有过渡", () => {
    const s = source();
    s.frame(0, true);
    s.move("a", 217, 180);
    expect(s.frame(16, true)).toBe(false);
    expect(dOf(s.tube)).toEqual(["M106 142C106 161 323 161 323 180"]);
  });

  it("选边看的是节点正在走向的位置（tx、ty）：弹簧还在途中，也按目标选边，曲线画在节点此刻的位置上", () => {
    const s = source();
    const body = s.bodies.get("a")!;
    // 目标在来源正下方，节点此刻还在右边：按目标选 DOWN，所以从来源的下缘出线；终点跟着节点此刻的上缘（346 = 240 + 106）。
    body.tx = 20;
    body.ty = 300;
    s.frame(0);
    expect(dOf(s.tube)).toEqual(["M106 142C106 161 346 161 346 180"]);
    expect(lit(s.els.get("o")!)).toEqual(["bottom"]);
  });

  it("没变就不写 DOM：重复 frame、挪动无关的节点，d 与渐变都不再被写；端点变了才一起写", () => {
    const s = setup();
    s.put("o", 0, 30);
    s.put("a", 310, 14);
    s.put("lonely", 0, 600);
    s.layer.sync([edge("o", "a")]);
    s.frame();
    const path = pathsOf(s.tube)[0]!;
    const gradient = s.dots.querySelector("linearGradient")!;
    const pathWrites = vi.spyOn(path, "setAttribute");
    const gradientWrites = vi.spyOn(gradient, "setAttribute");
    const dWrites = (): number => pathWrites.mock.calls.filter(([name]) => name === "d").length;
    for (let i = 0; i < 5; i++) s.frame(i * 16);
    s.move("lonely", 40, 600);
    s.frame(100);
    expect(dWrites()).toBe(0);
    expect(gradientWrites).not.toHaveBeenCalled();
    s.move("a", 310, 44);
    s.frame(116);
    expect(dWrites()).toBe(1);
    expect(gradientWrites).toHaveBeenCalledTimes(4);
    s.frame(132);
    expect(dWrites()).toBe(1);
  });

  it("节点叠在一起、尺寸为 0：不抛错，路径里没有 NaN", () => {
    const s = setup();
    s.put("o", 100, 100);
    s.put("same", 100, 100);
    s.put("zero", 100, 100, { w: 0, h: 0 });
    s.layer.sync([edge("o", "same"), edge("o", "zero"), edge("zero", "same")]);
    expect(() => s.frame()).not.toThrow();
    for (const d of dOf(s.tube)) expect(d).not.toMatch(/NaN|Infinity/);
  });
});

describe("ConnectionLayer · 端口方点", () => {
  it("每个注册的元素里放四个方点；只有接着连线的那一边点亮，落点在这一边的中点", () => {
    const s = setup();
    s.put("o", 0, 30);
    s.put("a", 310, 14, { w: 248, h: 144 });
    s.put("lonely", 0, 600);
    s.layer.sync([edge("o", "a")]);
    s.frame();
    for (const el of s.els.values()) expect(portsOf(el)).toHaveLength(4);
    expect(lit(s.els.get("o")!)).toEqual(["right"]);
    expect(lit(s.els.get("a")!)).toEqual(["left"]);
    expect(lit(s.els.get("lonely")!)).toEqual([]);
    const right = dotOf(s.els.get("o")!, "right");
    expect([right.style.getPropertyValue("--port-x"), right.style.getPropertyValue("--port-y")]).toEqual(["212px", "56px"]);
    const left = dotOf(s.els.get("a")!, "left");
    expect([left.style.getPropertyValue("--port-x"), left.style.getPropertyValue("--port-y")]).toEqual(["0px", "72px"]);
  });

  it("换边时方点跟着换到新的一边；尺寸变了，落点跟着更新", () => {
    const s = setup();
    s.put("o", 0, 30);
    s.put("a", 20, 300);
    s.layer.sync([edge("o", "a")]);
    s.frame();
    expect(lit(s.els.get("o")!)).toEqual(["bottom"]);
    expect(lit(s.els.get("a")!)).toEqual(["top"]);
    expect(dotOf(s.els.get("a")!, "top").style.getPropertyValue("--port-x")).toBe("106px");
    s.bodies.get("a")!.w = 300;
    s.frame(16);
    expect(dotOf(s.els.get("a")!, "top").style.getPropertyValue("--port-x")).toBe("150px");
    s.move("a", 600, 30);
    s.frame(32);
    s.frame(2000);
    expect(lit(s.els.get("o")!)).toEqual(["right"]);
    expect(lit(s.els.get("a")!)).toEqual(["left"]);
  });

  it("同一边接着几条连线：只有一个方点，颜色取最活跃的阶段；连线拆掉，方点熄灭", () => {
    const s = setup();
    s.put("o", 0, 30);
    s.put("a", 400, -200);
    s.put("b", 400, 30);
    s.put("c", 400, 260);
    const right = (): HTMLElement => dotOf(s.els.get("o")!, "right");
    const run = (...edges: LayoutEdge[]): void => {
      s.layer.sync(edges);
      s.frame();
    };
    run(edge("o", "a", "done"), edge("o", "b", "running"), edge("o", "c", "failed"));
    expect(lit(s.els.get("o")!)).toEqual(["right"]);
    expect(right().getAttribute("data-phase")).toBe("running");
    run(edge("o", "a", "done"), edge("o", "c", "failed"));
    expect(right().getAttribute("data-phase")).toBe("failed");
    run(edge("o", "a", "done"), edge("o", "c", "queued"));
    expect(right().getAttribute("data-phase")).toBe("queued");
    run(edge("o", "a", "done"), edge("o", "c", "link"));
    expect(right().getAttribute("data-phase")).toBe("done");
    run(edge("o", "c", "link"));
    expect(right().getAttribute("data-phase")).toBe("link");
    expect(lit(s.els.get("a")!)).toEqual([]);
    run();
    for (const el of s.els.values()) expect(lit(el)).toEqual([]);
    // 熄灭时保留颜色，淡出时不会闪成灰色。
    expect(right().getAttribute("data-phase")).toBe("link");
  });

  it("逐帧调用不碰方点的 DOM：状态没变就一个属性也不写", () => {
    const s = setup();
    s.put("o", 0, 30);
    s.put("a", 310, 14);
    s.layer.sync([edge("o", "a")]);
    s.frame();
    const writes = [...s.els.values()].flatMap((el) => portsOf(el)).flatMap((dot) => [vi.spyOn(dot, "setAttribute"), vi.spyOn(dot, "removeAttribute"), vi.spyOn(dot.style, "setProperty")]);
    for (let i = 0; i < 20; i++) s.frame(i * 16);
    expect(writes.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    // 探针确实有效：节点高度变了，落点才会写。
    s.bodies.get("a")!.h = 200;
    s.frame(400);
    expect(writes.some((spy) => spy.mock.calls.length > 0)).toBe(true);
  });

  it("端点的元素没有注册：线照画，只有注册了的那一端有方点", () => {
    const s = setup();
    s.put("o", 0, 30);
    s.bodies.set("a", { x: 310, y: 14, tx: 310, ty: 14, w: 212, h: 112 });
    s.layer.sync([edge("o", "a")]);
    s.frame();
    expect(pathsOf(s.tube)).toHaveLength(1);
    expect(dOf(s.tube)[0]).not.toBe("");
    expect(lit(s.els.get("o")!)).toEqual(["right"]);
  });

  it("元素换了（同一个 id 注册新元素）：旧元素的方点拿走，新元素的方点跟着连线点亮", () => {
    const s = setup();
    s.put("o", 0, 30);
    s.put("a", 310, 14);
    s.layer.sync([edge("o", "a")]);
    s.frame();
    const old = s.els.get("a")!;
    const fresh = document.createElement("div");
    document.body.append(fresh);
    s.layer.register("a", fresh);
    expect(portsOf(old)).toHaveLength(0);
    expect(portsOf(fresh)).toHaveLength(4);
    s.frame(16);
    expect(lit(fresh)).toEqual(["left"]);
    expect(dotOf(fresh, "left").style.getPropertyValue("--port-x")).toBe("0px");
  });

  it("同一个元素重复注册不会重复放方点；卸载只拿走自己的方点，旧的卸载函数动不了新元素", () => {
    const s = setup();
    s.put("o", 0, 30);
    s.put("a", 310, 14);
    s.layer.sync([edge("o", "a")]);
    const el = s.els.get("a")!;
    s.layer.register("a", el);
    const release = s.layer.register("a", el);
    expect(portsOf(el)).toHaveLength(4);
    const fresh = document.createElement("div");
    document.body.append(fresh);
    s.layer.register("a", fresh);
    release(); // 旧元素的卸载：方点早已拿走，不能连累新元素
    expect(portsOf(fresh)).toHaveLength(4);
    s.frame();
    expect(lit(fresh)).toEqual(["left"]);
    const releaseFresh = s.layer.register("a", fresh);
    releaseFresh();
    expect(portsOf(fresh)).toHaveLength(0);
    s.frame(16);
    expect(lit(s.els.get("o")!)).toEqual(["right"]);
  });
});

describe("ConnectionLayer · unmount", () => {
  it("unmount：连线拆干净，方点熄灭但还在；重新 mount 后 sync 与 frame 再点亮", () => {
    const s = setup();
    s.put("o", 0, 30);
    s.put("a", 310, 14);
    s.put("b", 700, 14);
    s.layer.sync([edge("o", "a", "failed"), edge("a", "b", "link")]);
    s.frame();
    expect(lit(s.els.get("a")!)).toEqual(["left", "right"]);
    s.layer.unmount();
    expect(s.tube.children).toHaveLength(0);
    expect(s.dots.children).toHaveLength(0);
    for (const el of s.els.values()) {
      expect(lit(el)).toEqual([]);
      expect(portsOf(el)).toHaveLength(4);
    }
    // 没有 mount 时 sync 与 frame 都不做事。
    s.layer.sync([edge("o", "a")]);
    expect(s.frame()).toBe(false);
    expect(s.tube.children).toHaveLength(0);

    s.layer.mount({ tube: s.tube, dots: s.dots });
    s.layer.sync([edge("o", "a")]);
    s.frame();
    expect(pathsOf(s.tube)).toHaveLength(1);
    expect(lit(s.els.get("a")!)).toEqual(["left"]);
  });
});
