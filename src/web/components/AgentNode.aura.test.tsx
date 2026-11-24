import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog } from "@shared/testing";
import type { AttentionItem, SessionPhase, SessionSummary } from "@shared/types";
import { setLang } from "../lib/app";
import { AURA_PHASE_VARS, auraPhases } from "../lib/aura";
import { AgentNode } from "./AgentNode";
import { declared, engine, ruleBody, sceneCss } from "./AgentNode.fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 会话卡片测试之三：工作中的氤氲（.a-aura）——节点里的位置与相位、什么状态下显示、两团渐变与四条漂移腿的参数、只用合成层友好的写法、减弱动效。
// 测试环境不做布局也不跑动画，参数与显隐条件只能直接读 scene.css 的写法来守住（读样式表的小工具在 AgentNode.fixtures.ts）。
// 头部与正文图标、副标题在 AgentNode.test.tsx，头部右端的菜单与标记在 AgentNode.menu.test.tsx。

describe("会话卡片里工作中的氤氲（.a-aura）", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    setLang("zh");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = (id: string, patch: Partial<SessionSummary> = {}): HTMLElement => {
    const log = new EventLog(id);
    log.created({ harness: "cursor", runtime: "native" });
    const base = toSummary(replay(log.events)!);
    act(() => root.render(<AgentNode summary={{ ...base, ...patch }} engine={engine} />));
    return host.querySelector<HTMLElement>(".node.agent")!;
  };
  const attention: AttentionItem[] = [{ kind: "long_run", since: "2026-11-22T00:00:00.000Z" }];
  const styleOf = (node: HTMLElement): string => node.querySelector(".a-aura")?.getAttribute("style") ?? "";

  it("氤氲是节点里的第一个子元素：aria-hidden、没有内容，头部与正文的位置不受它影响", () => {
    const node = render("ses_aura");
    const aura = node.firstElementChild!;
    expect(aura.className).toBe("a-aura");
    expect(aura.getAttribute("aria-hidden")).toBe("true");
    expect(aura.childElementCount).toBe(0);
    expect(aura.textContent).toBe("");
    expect([...node.children].map((el) => el.className)).toEqual(["a-aura", "a-head", "a-inset"]);
  });

  it("起始相位只由会话标识决定：同一个标识每次渲染、每种状态下都是同一组，不同标识各不相同", () => {
    const first = styleOf(render("ses_aura_a"));
    expect(first).not.toBe("");
    // 重渲染与状态变化都不改变相位：不依赖 Math.random，也不依赖渲染次数。
    expect(styleOf(render("ses_aura_a", { phase: "running" }))).toBe(first);
    expect(styleOf(render("ses_aura_a", { phase: "done" }))).toBe(first);
    expect(styleOf(render("ses_aura_b"))).not.toBe(first);
    // 行内样式正是 lib/aura 算出的四个自定义属性，样式表里的 animation-delay 读它们。
    const phases = auraPhases("ses_aura_a");
    for (const [index, name] of AURA_PHASE_VARS.entries()) {
      const written = new RegExp(`${name}:\\s*([0-9.]+)`).exec(first)?.[1];
      expect(Number(written), name).toBe(Number(phases[index]!.toFixed(3)));
    }
  });

  it("显示条件只看节点的 data-phase 与 data-attention：运行中一律显示，启动中 / 排队中仅在没有“值得留意”时显示，琥珀线与它互斥", () => {
    const css = sceneCss();
    const visibleOn = [
      '.node.agent[data-phase="running"]',
      '.node.agent[data-phase="starting"]:not([data-attention])',
      '.node.agent[data-phase="queued"]:not([data-attention])',
    ];
    const visible = declared(ruleBody(css, visibleOn.map((selector) => `${selector} .a-aura`).join(",\n")));
    expect([visible["opacity"], visible["visibility"], visible["transition-delay"]]).toEqual(["1", "visible", "0s"]);
    // 琥珀线的选择器与声明一个字符都不能变：它的权重 (0,3,0) 要压在悬停 / 选中 / 拖动之下，线要在每个状态下都在。
    const amberOn = '.agent[data-attention]:not([data-phase="running"])';
    expect(declared(ruleBody(css, amberOn))).toEqual({
      "border-color": "#d6ccc5",
      "box-shadow": "none",
      "background-image": "linear-gradient(var(--amber), var(--amber))",
      "background-repeat": "no-repeat",
      "background-size": "2px 100%",
    });

    const phases: SessionPhase[] = ["ready", "starting", "queued", "running", "done", "failed", "cancelled", "stopped", "lost"];
    for (const phase of phases) {
      for (const flagged of [false, true]) {
        const label = `${phase}${flagged ? " + 值得留意" : ""}`;
        const node = render("ses_aura", { phase, ...(flagged ? { attention } : {}) });
        const hazy = visibleOn.some((selector) => node.matches(selector));
        const amber = node.matches(amberOn);
        expect(hazy, label).toBe(phase === "running" || ((phase === "starting" || phase === "queued") && !flagged));
        expect(amber, label).toBe(flagged && phase !== "running");
        // 同一张卡不会同时有氤氲和琥珀线。
        expect(hazy && amber, label).toBe(false);
      }
    }
  });

  it("只有运行中的氤氲在流：动画一直挂着并暂停，只有运行中放开；启动中 / 排队中停在自己的相位上", () => {
    const css = sceneCss();
    const layers = declared(ruleBody(css, ".a-aura::before,\n.a-aura::after"));
    expect([layers["animation-play-state"], layers["animation-iteration-count"], layers["animation-direction"], layers["animation-timing-function"]]).toEqual([
      "paused",
      "infinite",
      "alternate",
      "cubic-bezier(.37, 0, .63, 1)",
    ]);
    expect(declared(ruleBody(css, '.node.agent[data-phase="running"] .a-aura::before,\n.node.agent[data-phase="running"] .a-aura::after'))).toEqual({ "animation-play-state": "running" });
    // 两团各带两条腿（横、纵）；.a-aura 自己不动，节点自己也不挂氤氲的动画。
    expect(declared(ruleBody(css, ".a-aura::before"))["animation-name"]).toBe("aura-a-x, aura-a-y");
    expect(declared(ruleBody(css, ".a-aura::after"))["animation-name"]).toBe("aura-b-x, aura-b-y");
    expect(declared(ruleBody(css, ".a-aura"))["animation-name"]).toBeUndefined();
    expect(css).not.toMatch(/\.node[^{]*\{[^{}]*animation[^{}]*aura-/);
  });

  it("两团氤氲：叠加后的峰值不超过文字对比度允许的 4.84%（硬上限 7%），按余弦缓动分档，首尾斜率为零，只用 --teal", () => {
    const css = sceneCss();
    const peaks = [".a-aura::before", ".a-aura::after"].map((selector) => {
      const background = declared(ruleBody(css, selector))["background"]!;
      expect(background, selector).toMatch(/^radial-gradient\(\s*ellipse closest-side at 50% 50%,/);
      // 最后一档是 100% 处的 transparent：尾巴落到零，没有硬边。
      expect(background, selector).toMatch(/,\s*transparent\s*\)$/);
      expect([...background.matchAll(/var\((--[\w-]+)\)/g)].every((match) => match[1] === "--teal"), selector).toBe(true);
      const stops = [...background.matchAll(/color-mix\(in srgb, var\(--teal\) ([\d.]+)%, transparent\)(?: ([\d.]+)%)?/g)].map((match) => ({
        alpha: Number(match[1]),
        at: match[2] === undefined ? 0 : Number(match[2]),
      }));
      expect(stops.map((stop) => stop.at), selector).toEqual([0, 12.5, 25, 37.5, 50, 62.5, 75, 87.5]);
      // 余弦缓动：第 i 档 = 峰值 × (1 + cos(π·i/8)) / 2，终点是 0——首尾斜率为零，峰顶是圆的、尾巴是软的。
      const peak = stops[0]!.alpha;
      stops.forEach((stop, index) => {
        const expected = (peak * (1 + Math.cos((Math.PI * index) / 8))) / 2;
        expect(Math.abs(stop.alpha - expected), `${selector} 第 ${index} 档`).toBeLessThan(0.01);
      });
      return peak;
    });
    // 两团核心重合的瞬间是最坏情形：1 − (1 − a)(1 − b)。旧版注释里排队中动作行 3.28 的对比度对应约 4.84%，不能再浓；7% 是更外层的硬上限。
    const worst = 1 - peaks.reduce((rest, peak) => rest * (1 - peak / 100), 1);
    expect(worst).toBeLessThanOrEqual(0.0484);
    expect(worst).toBeLessThanOrEqual(0.07);
    // 也不能被改成看不见的：它是“感觉得到多于看得到”的一层，不是没有。
    expect(worst).toBeGreaterThan(0.02);
  });

  it("四条漂移腿：周期 11 / 17 / 13 / 19 秒两两互质，每个来回都在 10 秒以上；起始相位乘的是一整个来回", () => {
    const css = sceneCss();
    const layers = [".a-aura::before", ".a-aura::after"].map((selector) => declared(ruleBody(css, selector)));
    const durations = layers.flatMap((layer) => layer["animation-duration"]!.split(",").map((value) => parseFloat(value)));
    expect(durations).toEqual([11, 17, 13, 19]);
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    durations.forEach((a, index) => {
      for (const b of durations.slice(index + 1)) expect(gcd(a, b), `${a}s 与 ${b}s`).toBe(1);
    });
    // 每趟是 from → to 的一程，alternate 往返：一个来回是两程，不短于 10 秒。
    for (const duration of durations) expect(duration * 2).toBeGreaterThanOrEqual(10);
    // animation-delay = 相位变量 × 负的一个来回：动画出生时已走到来回中的某一处，暂停（启动中 / 排队中）时也是这张卡自己的一帧。
    const delays = layers.flatMap((layer) =>
      [...layer["animation-delay"]!.matchAll(/calc\(var\((--aura-[a-z]+), 0\) \* (-\d+)s\)/g)].map((match): [string, number] => [match[1]!, Number(match[2])]),
    );
    expect(delays.map(([name]) => name)).toEqual([...AURA_PHASE_VARS]);
    expect(delays.map(([, seconds]) => -seconds)).toEqual(durations.map((duration) => duration * 2));
  });

  it("漂移关键帧只动 translate / transform（合成层的位移）：横向写在 translate、纵向写在 transform，两条腿互不覆盖", () => {
    const css = sceneCss();
    const legs = Object.fromEntries(
      ["aura-a-x", "aura-a-y", "aura-b-x", "aura-b-y"].map((name): [string, string[]] => {
        const match = new RegExp(`@keyframes ${name}\\s*\\{\\s*from\\s*\\{([^{}]*)\\}\\s*to\\s*\\{([^{}]*)\\}\\s*\\}`).exec(css);
        expect(match, name).not.toBeNull();
        return [name, [match![1]!.trim(), match![2]!.trim()]];
      }),
    );
    expect(legs).toEqual({
      "aura-a-x": ["translate: -60px 0;", "translate: 60px 0;"],
      "aura-a-y": ["transform: translateY(-14px);", "transform: translateY(14px);"],
      "aura-b-x": ["translate: 66px 0;", "translate: -66px 0;"],
      "aura-b-y": ["transform: translateY(-20px);", "transform: translateY(20px);"],
    });
  });

  it("氤氲只用合成层友好的写法：垫在内容之下、不拦指针、裁在内边距盒里；没有 filter / 混合模式 / will-change / 遮罩，没有圆角，也不用 animation 简写与 fill-mode", () => {
    const css = sceneCss();
    const block = [
      ".a-aura",
      '.node.agent[data-phase="running"] .a-aura,\n.node.agent[data-phase="starting"]:not([data-attention]) .a-aura,\n.node.agent[data-phase="queued"]:not([data-attention]) .a-aura',
      ".a-aura::before,\n.a-aura::after",
      ".a-aura::before",
      ".a-aura::after",
      '.node.agent[data-phase="running"] .a-aura::before,\n.node.agent[data-phase="running"] .a-aura::after',
    ]
      .map((selector) => ruleBody(css, selector))
      .join("\n");
    expect(block).not.toMatch(/filter|mix-blend-mode|will-change|mask|border-radius|--r-|corner-shape|animation-fill-mode|animation:/);

    const base = declared(ruleBody(css, ".a-aura"));
    expect([base["position"], base["inset"], base["z-index"], base["overflow"], base["pointer-events"], base["contain"]]).toEqual(["absolute", "0", "-1", "hidden", "none", "strict"]);
    // 显隐是 opacity + visibility 的过渡，时长取 --dur 的倍数：减弱动效下 --dur 是 1ms，瞬间完成。
    expect([base["opacity"], base["visibility"]]).toEqual(["0", "hidden"]);
    expect(base["transition"]).toContain("calc(var(--dur) * 3)");
  });

  it("节点自己不再带氤氲：旧的“自左缘弥散”的渐变不见了，工作中的节点规则里没有 background-image", () => {
    const css = sceneCss();
    expect(css).not.toMatch(/ellipse 66% 150% at 0 50%/);
    expect(css).not.toMatch(/\.node\.agent\[data-phase="(?:running|starting|queued)"\][,\s][^{]*\{[^{}]*background-image/);
  });

  it("减弱动效沿用 base.css 的全局规则：两个伪元素没有 fill-mode，动画被压成一次之后回到 translate 写的静止帧", () => {
    const base = readFileSync("src/web/styles/base.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{\s*\*,\s*\*::before,\s*\*::after \{([^{}]*)\}/.exec(base);
    expect(reduced).not.toBeNull();
    const rule = declared(reduced![1]!);
    expect([rule["animation-duration"], rule["animation-iteration-count"]]).toEqual(["0.001ms !important", "1 !important"]);
    // 静止帧：A 团偏左、B 团偏右，写在伪元素自己的 translate 上，动画结束后回落到它（所以不能有 fill-mode）。
    const css = sceneCss();
    expect([declared(ruleBody(css, ".a-aura::before"))["translate"], declared(ruleBody(css, ".a-aura::after"))["translate"]]).toEqual(["-30px 0", "44px 0"]);
  });
});
