import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog } from "@shared/testing";
import type { SessionMeta } from "@shared/types";
import { setLang } from "../lib/app";
import { AgentNode } from "./AgentNode";
import { declared, engine, escapeRegExp, ruleBody, sceneCss } from "./AgentNode.fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 会话卡片测试之一：头部（执行端图标、名字、模型与档位及其收起）、正文两行与模型头像，以及副标题。
// 头部右端的菜单与标记在 AgentNode.menu.test.tsx，工作中的氤氲在 AgentNode.aura.test.tsx；共用的夹具（假引擎与读 scene.css 的小工具）在 AgentNode.fixtures.ts。

/** 一条 @container 规则：返回它里面唯一一条规则的选择器与声明块。 */
const containerRule = (css: string, query: string): { selector: string; body: string } => {
  const match = new RegExp(`@container ${escapeRegExp(query)}\\s*\\{\\s*([^{}]+?)\\s*\\{([^{}]*)\\}\\s*\\}`).exec(css);
  if (!match) throw new Error(`scene.css 里没有这条容器查询：${query}`);
  return { selector: match[1]!, body: match[2]! };
};

describe("会话卡片的头部与正文图标", () => {
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

  const render = (meta: Partial<SessionMeta>): HTMLElement => {
    const log = new EventLog("ses_card");
    log.created({ harness: "cursor", runtime: "native", ...meta });
    const summary = toSummary(replay(log.events)!);
    act(() => root.render(<AgentNode summary={summary} engine={engine} />));
    return host.querySelector<HTMLElement>(".node.agent")!;
  };

  it("头部写的是执行端与它用的模型：图标 → 名字 → 模型名与档位，用的是来源卡头部同一套类（.a-mark / .o-label / .a-model）", () => {
    const node = render({ model: { resolved: "deepseek-v41-flash-1017", label: "DeepSeek V4.1 Flash 1017" }, effort: "high" });
    const head = node.querySelector(".a-head")!;

    // 与 OriginNode / GitNode 头部同一套写法：.a-mark（图标格）→ .o-label（名字）→ .a-model（模型）。
    expect(head.firstElementChild?.className).toBe("a-mark");
    expect(head.querySelector(".o-label")?.textContent).toBe("Cursor");
    expect(head.querySelector(".a-mark")?.nextElementSibling).toBe(head.querySelector(".o-label"));
    // .a-model 住在一块弹性空白（.a-room，容器查询的容器）里，紧跟在执行端名后面。
    const room = head.querySelector(".a-room")!;
    expect(head.querySelector(".o-label")?.nextElementSibling).toBe(room);
    expect([...room.children].map((el) => el.className)).toEqual(["a-model"]);
    // 一个整体：名字 → 档位。
    const model = room.querySelector(".a-model")!;
    expect([...model.children].map((el) => el.className)).toEqual(["a-model-name", "a-effort"]);
    expect(model.querySelector(".a-model-name")?.textContent).toBe("DeepSeek V4.1 Flash 1017");
    expect(model.querySelector(".a-effort")?.textContent).toBe("high");
    // 头部没有模型图标（家族标只在正文的头像格里），也没有旧的 .a-label 与已被取代的 .a-spacer。
    for (const selector of [".a-label", ".a-spacer", ".model-mark", ".model-glyph", ".model-slot"]) {
      expect(head.querySelector(selector), selector).toBeNull();
    }
  });

  it("模型名与档位只在头部：正文不再有第二份，只剩标题与最近动作两行", () => {
    const node = render({ model: { resolved: "claude-sonnet-5.5", label: "Claude Sonnet 5.5" }, effort: "xhigh" });
    const body = node.querySelector(".a-inset")!;

    expect(node.querySelectorAll(".a-model-name")).toHaveLength(1);
    expect(node.querySelectorAll(".a-effort")).toHaveLength(1);
    expect(body.querySelector(".a-model, .a-model-name, .a-effort")).toBeNull();
    expect(body.textContent).not.toContain("Claude Sonnet 5.5");
    expect(body.textContent).not.toContain("xhigh");
  });

  it("六个执行端各用自己的标：头部最左就是那一枚（12px、无抓手），名字照执行端写；没有官方标的画中性烧瓶", () => {
    // 每次渲染复用同一个 DOM 节点：必须渲染一次就检查一次，不能先渲染完再统一看。
    const headOf = (harness: string): Element => {
      const node = render({ harness: harness as SessionMeta["harness"] });
      expect(node.querySelector(".node-grip")).toBeNull();
      return node.querySelector(".a-head")!;
    };
    for (const [harness, name] of [["cursor", "Cursor"], ["codex", "Codex"], ["pi", "Pi"], ["claude", "Claude Code"], ["opencode", "OpenCode"], ["dsh", "DSH"]] as const) {
      const head = headOf(harness);
      const mark = head.querySelector<HTMLImageElement>(".a-mark > img")!;
      expect(mark.getAttribute("data-harness"), harness).toBe(harness);
      expect([mark.getAttribute("width"), mark.getAttribute("height")], harness).toEqual(["12", "12"]);
      expect(mark.getAttribute("aria-hidden")).toBe("true");
      expect(head.querySelector(".o-label")?.textContent, harness).toBe(name);
    }
    // 模拟端没有官方标，没见过的执行端更没有：都是同一枚中性烧瓶，名字照写（没有名字的原样写 id），不借别家的标。
    for (const [harness, name] of [["fixture", "模拟执行端"], ["mystery", "mystery"]] as const) {
      const head = headOf(harness);
      expect(head.querySelector(".a-mark > img"), harness).toBeNull();
      expect(head.querySelector(".a-mark > svg")?.getAttribute("viewBox"), harness).toBe("0 0 24 24");
      expect(head.querySelector(".o-label")?.textContent, harness).toBe(name);
    }
  });

  it("头部列轴：执行端图标格起于 x=14（13 宽），名字起于 x=34；正文头像左缘 x=14、文字起于 x=48——与来源卡、Git 卡同一条列轴", () => {
    const styles = document.createElement("style");
    styles.textContent = readFileSync("src/web/styles/scene.css", "utf8");
    document.head.append(styles);
    try {
      for (const harness of ["cursor", "codex", "pi", "claude"] as const) {
        const node = render({ harness });
        const head = node.querySelector<HTMLElement>(".a-head")!;
        const style = getComputedStyle(head);
        const mark = getComputedStyle(head.querySelector(".a-mark")!);
        // 左边距 + 图标格 + 间距 = 名字的起点（图标在格内居中，比格子大的图标向两侧等量溢出，格子不动）。
        expect([parseFloat(style.paddingLeft), parseFloat(mark.width), parseFloat(style.paddingLeft) + parseFloat(mark.width) + parseFloat(style.gap)], harness).toEqual([14, 13, 34]);
        // 正文：内边距 14（与头部同一条左缘）+ 头像格 24 + 间距 10 = 文字的起点 48。
        // happy-dom 不展开 inset 简写，内边距直接从样式表里的写法读；头像格的宽度是内联样式。
        const inset = /\.a-inset\s*\{[^}]*?inset:\s*\d+px\s+(\d+)px\s/.exec(styles.textContent!)![1]!;
        const slot = (node.querySelector(".model-slot") as HTMLElement).style.width;
        const row = getComputedStyle(node.querySelector(".a-row")!);
        expect([parseFloat(inset), parseFloat(slot), parseFloat(row.gap)], harness).toEqual([14, 24, 10]);
        expect(parseFloat(inset) + parseFloat(slot) + parseFloat(row.gap)).toBe(48);
      }
    } finally {
      styles.remove();
    }
  });

  it("正文最左是模型头像：24px 的格子里画家族标，不再是执行端图标", () => {
    const node = render({ harness: "codex", model: { resolved: "gpt-5.1-codex", label: "gpt-5.1-codex" } });
    const row = node.querySelector(".a-row")!;
    const slot = row.firstElementChild as HTMLElement;

    expect(slot.className).toBe("model-slot");
    expect([slot.style.width, slot.style.height]).toEqual(["24px", "24px"]);
    expect(slot.getAttribute("aria-hidden")).toBe("true");
    expect(slot.querySelector(".model-mark")?.getAttribute("data-family")).toBe("openai");
    expect(slot.hasAttribute("data-placeholder")).toBe(false);
    // 执行端图标不在正文里，也没有方格那一层（它的框线、底色、虚线只属于执行端卡片那类场景）。
    expect(node.querySelector(".harness-glyph, .harness-tile, .a-row img")).toBeNull();
    // 头像紧挨着文字块，模型名由第二行的文字说出。
    expect(row.querySelector(".a-text")?.previousElementSibling).toBe(slot);
  });

  it("头像按模型名认家族，与执行端无关：同一个 Cursor 会话里 Claude / Composer / DeepSeek 各画各的", () => {
    // 每次渲染复用同一个 DOM 节点：必须渲染一次就检查一次。
    const familyOf = (resolved: string, harness: SessionMeta["harness"] = "cursor"): string | null | undefined => {
      const node = render({ harness, model: { resolved, label: resolved } });
      return node.querySelector(".a-row .model-mark")?.getAttribute("data-family");
    };
    expect(familyOf("claude-sonnet-5.5")).toBe("claude");
    expect(familyOf("composer-2.5")).toBe("composer");
    expect(familyOf("deepseek-v41-flash-1017")).toBe("deepseek");
    expect(familyOf("claude-opus-4.1", "claude")).toBe("claude");
    expect(familyOf("gpt-5.1-codex-max", "pi")).toBe("openai");
  });

  it("认不出的模型不画别家的标，改占同一格中性图标；没有模型时写默认", () => {
    const unknown = render({ model: { resolved: "some-unknown-model-7b", label: "Some Unknown 7B" } });
    const slot = unknown.querySelector(".a-row")!.firstElementChild!;
    expect(slot.className).toBe("model-slot");
    expect(slot.getAttribute("data-placeholder")).toBe("unknown");
    expect(slot.querySelector(".model-mark")).toBeNull();
    // 仍占同样大的一格，名字才总起在同一条列轴上。
    expect((slot as HTMLElement).style.width).toBe("24px");
    expect(slot.querySelector("svg.model-glyph")).not.toBeNull();
    expect(unknown.querySelector(".a-head .a-model-name")?.textContent).toBe("Some Unknown 7B");

    const none = render({ model: undefined });
    expect(none.querySelector(".a-row .model-mark")).toBeNull();
    expect(none.querySelector(".a-row .model-slot")?.getAttribute("data-placeholder")).toBe("unknown");
    expect(none.querySelector(".a-head .a-model-name")?.textContent).toBe("默认模型");
  });

  it("模拟执行端的模型是假的：头部写“模拟执行”，头像画烧瓶，不画家族标；头部仍写真实的执行端", () => {
    const node = render({ runtime: "fixture", model: { resolved: "deepseek-fixture", label: "DeepSeek Fixture", provider: "fixture" } });
    const slot = node.querySelector(".model-slot")!;
    expect(slot.getAttribute("data-placeholder")).toBe("simulated");
    expect(node.querySelector(".a-head .a-model-name")?.textContent).toBe("模拟执行");
    // 头部的名字与正文的头像说同一句话：这是模拟，不是真实 Harness 的运行记录。
    expect(node.querySelector(".a-head .a-model-name")?.getAttribute("data-tip")).toContain("并非真实 Harness 的运行记录");
    expect(slot.getAttribute("data-tip")).toBe(node.querySelector(".a-head .a-model-name")?.getAttribute("data-tip"));
    // 即便名字像某个家族，也不画那个家族的标、不写那个模型名。
    expect(node.querySelector(".model-mark")).toBeNull();
    expect(node.textContent).not.toContain("DeepSeek");
    expect(node.querySelector(".a-head .o-label")?.textContent).toBe("Cursor");
  });

  it("悬停模型名与头像都能看到模型与推理强度：名字在窄卡上会整块收起，头像始终在场", () => {
    const node = render({ model: { resolved: "claude-4.5-sonnet", label: "Sonnet 4.5" }, effort: "low" });
    const tip = "模型：Sonnet 4.5\n推理强度：低";
    expect(node.querySelector(".a-head .a-model-name")?.getAttribute("data-tip")).toBe(tip);
    expect(node.querySelector(".a-row .model-slot")?.getAttribute("data-tip")).toBe(tip);
    // 没有给档位时，提示里写“无”，而不是一段空白。
    const none = render({ model: { resolved: "claude-4.5-sonnet", label: "Sonnet 4.5" } });
    expect(none.querySelector(".a-row .model-slot")?.getAttribute("data-tip")).toBe("模型：Sonnet 4.5\n推理强度：无");
  });

  it("中文界面里档位徽标仍写执行端的英文短值，紧跟模型名，在头部里", () => {
    const node = render({ model: { resolved: "claude-sonnet-5.5", label: "Claude Sonnet 5.5" }, effort: "xhigh" });
    const model = node.querySelector(".a-head .a-model")!;
    const badge = model.querySelector<HTMLElement>(".a-effort")!;

    // 不翻译成「极高」：与聚焦页头部、模型选择里的英文档位同一写法。
    expect(badge.textContent).toBe("xhigh");
    expect(badge.textContent).not.toBe("极高");
    // 次级信息：提示仍是界面语言，说明它是什么。
    expect(badge.getAttribute("data-tip")).toBe("推理强度");
    // 版式：模型名 → 档位，模型名仍是主信息；档位不在正文里。
    expect(model.querySelector(".a-model-name")?.textContent).toBe("Claude Sonnet 5.5");
    expect(model.querySelector(".a-model-name")?.nextElementSibling).toBe(badge);
    expect(badge.nextElementSibling).toBeNull();
    expect(node.querySelector(".a-inset .a-effort")).toBeNull();
  });

  it("执行端没有给出档位时不渲染徽标，也不留空位", () => {
    const node = render({ model: { resolved: "claude-sonnet-5.5", label: "Claude Sonnet 5.5" } });
    const model = node.querySelector(".a-head .a-model")!;
    expect(model.querySelector(".a-effort")).toBeNull();
    // 这一块只剩模型名，没有多余的空元素。
    expect(model.children).toHaveLength(1);

    const blank = render({ model: { resolved: "claude-sonnet-5.5", label: "Claude Sonnet 5.5" }, effort: "   " });
    expect(blank.querySelector(".a-head .a-effort")).toBeNull();
    expect(blank.querySelector(".a-head .a-model")?.children).toHaveLength(1);
  });

  it("模拟卡片以模拟标识为主，不显示档位", () => {
    const node = render({ runtime: "fixture", model: { resolved: "claude-fixture", label: "Claude Fixture" }, effort: "high" });
    const model = node.querySelector(".a-head .a-model")!;
    expect(model.querySelector(".a-model-name")?.textContent).toBe("模拟执行");
    expect(model.querySelector(".a-effort")).toBeNull();
    expect(model.children).toHaveLength(1);
    expect(node.textContent).not.toContain("Claude Fixture");
  });

  it("正文两行的顺序：标题与状态 → 最近动作；头像在文字块左边", () => {
    const node = render({ model: { resolved: "claude-sonnet-5.5", label: "Claude Sonnet 5.5" }, effort: "high" });
    const text = node.querySelector(".a-text")!;
    expect([...text.children].map((el) => el.className)).toEqual(["a-line", "a-sub"]);
    expect([...node.querySelector(".a-row")!.children].map((el) => el.className)).toEqual(["model-slot", "a-text"]);
  });

  it("超长的模型名只在头部里省略、悬停读全名与档位；档位徽标不被挤掉、也不收缩", () => {
    const label = "DeepSeek R1 Distill Llama 70B Instruct Preview 0317";
    const node = render({ model: { resolved: "deepseek-r1-distill-llama-70b", label }, effort: "xhigh" });
    const styles = document.createElement("style");
    styles.textContent = readFileSync("src/web/styles/scene.css", "utf8");
    document.head.append(styles);
    try {
      const name = node.querySelector<HTMLElement>(".a-head .a-model-name")!;
      expect(name.textContent).toBe(label);
      // 悬停提示里的档位是界面语言（极高）；卡片上的徽标才写执行端的英文短值。
      expect(name.getAttribute("data-tip")).toBe(`模型：${label}\n推理强度：极高`);
      const style = getComputedStyle(name);
      expect([style.overflow, style.textOverflow, style.whiteSpace]).toEqual(["hidden", "ellipsis", "nowrap"]);
      expect(parseFloat(style.minWidth) || 0).toBe(0);
      // flex: 0 1 auto——名字可收缩，档位 flex: none 不收缩。
      expect([style.flexGrow, style.flexShrink]).toEqual(["0", "1"]);
      expect(getComputedStyle(node.querySelector(".a-effort")!).flexShrink).toBe("0");
    } finally {
      styles.remove();
    }
  });

  it("头部的模型与档位按真正剩下的宽度收起：弹性空白是容器查询的容器，名字先省略，放不下一个像样的名字时整块收起", () => {
    const css = sceneCss();
    // 容器：.a-room 吃掉头部里执行端名与右端标记之外的全部宽度（flex-basis 为 0，内容撑不开它），命名并只量行内尺寸。
    const room = declared(ruleBody(css, ".a-room"));
    expect([room["container"], room["flex"], room["min-width"]]).toEqual(["a-room / inline-size", "1 1 0", "0"]);
    // 两档阈值：带档位的整块在 84 以下收起，只有名字的在 39 以下收起。
    const withBadge = containerRule(css, "a-room (max-width: 84px)");
    const nameOnly = containerRule(css, "a-room (max-width: 39px)");
    expect(withBadge.selector).toBe(".a-room .a-model:has(.a-effort)");
    expect(nameOnly.selector).toBe(".a-room .a-model");
    for (const { body } of [withBadge, nameOnly]) {
      const hidden = declared(body);
      // 项目里 .sr-only 的写法：视觉上收起，文字仍在可访问性树里（不是 display: none / visibility: hidden）；不留一个 1px 的悬停目标。
      expect([hidden["position"], hidden["width"], hidden["height"], hidden["clip"], hidden["pointer-events"]]).toEqual(["absolute", "1px", "1px", "rect(0, 0, 0, 0)", "none"]);
      expect(hidden["display"]).toBeUndefined();
      expect(hidden["visibility"]).toBeUndefined();
    }
    // 右边紧挨着菜单（没有标记）时，把右边那个 gap 让回来；有标记时不让。
    expect(declared(ruleBody(css, ".a-room:has(+ .a-menu)"))["margin-right"]).toBe("-7px");
  });

  it("会话卡头部不画“/”，来源卡与 Git 卡头部沿用基础规则里的“/”；收起完全交给样式表，组件里没有量宽度的代码", () => {
    const css = sceneCss();
    expect(declared(ruleBody(css, ".a-head .a-model::before"))["content"]).toBe("none");
    expect(declared(ruleBody(css, ".a-model::before"))["content"]).toBe('"/"');
    // 头部的模型与档位是同一个整体：名字可收缩（省略），档位不收缩；名字 14 高，与徽标同高。
    expect(declared(ruleBody(css, ".a-model-name"))["line-height"]).toBe("14px");
    expect(declared(ruleBody(css, ".a-effort"))["line-height"]).toBe("14px");
    const source = readFileSync("src/web/components/AgentNode.tsx", "utf8");
    expect(source).not.toMatch(/getBoundingClientRect|offsetWidth|clientWidth|scrollWidth|ResizeObserver|IntersectionObserver/);
  });

  it("正文两行落在 4px 的网格上：行高 16 + 间距 4 + 16 = 36，在 68 高的正文里上下各留 16；24 的头像在文字块中线上", () => {
    const css = sceneCss();
    const text = declared(ruleBody(css, ".a-text"));
    expect([declared(ruleBody(css, ".a-line"))["height"], declared(ruleBody(css, ".a-title"))["line-height"]]).toEqual(["16px", "16px"]);
    expect([declared(ruleBody(css, ".a-sub"))["height"], declared(ruleBody(css, ".a-sub"))["line-height"]]).toEqual(["16px", "16px"]);
    expect([text["flex-direction"], text["gap"]]).toEqual(["column", "4px"]);

    // 版式算术：卡高 112，内边距盒 110（去掉上下各 1px 的边框），头部 42，正文 68；两行 36，余 32，上下各 16——全是整数、全是 4 的倍数。
    const cardHeight = parseFloat(declared(ruleBody(css, ".agent"))["height"]!);
    const headHeight = parseFloat(declared(ruleBody(css, ".a-head"))["height"]!);
    expect(parseFloat(declared(ruleBody(css, ".a-inset"))["inset"]!)).toBe(headHeight);
    const body = cardHeight - 2 - headHeight;
    const block = 16 + 4 + 16;
    expect([cardHeight, headHeight, body, block, (body - block) / 2]).toEqual([112, 42, 68, 36, 16]);
    // 正文整块居中，头像与文字块在同一条中线上：24 的头像上下各比 36 的文字块短 6。
    expect(declared(ruleBody(css, ".a-inset"))["justify-content"]).toBe("center");
    expect(declared(ruleBody(css, ".a-row"))["align-items"]).toBe("center");
    const node = render({});
    expect([(node.querySelector(".model-slot") as HTMLElement).style.height, (block - 24) / 2]).toEqual(["24px", 6]);
  });
});

describe("会话卡片的副标题", () => {
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

  const render = (fill: (log: EventLog) => void): HTMLElement => {
    const log = new EventLog("ses_sub");
    log.created({ harness: "cursor", runtime: "native" });
    const message = log.message("msg_1", "task", "做点什么");
    log.run("run_1", 1, message.id);
    log.startRun("run_1");
    fill(log);
    const summary = toSummary(replay(log.events)!);
    act(() => root.render(<AgentNode summary={summary} engine={engine} />));
    return host.querySelector<HTMLElement>(".node.agent")!;
  };

  it("已完成：副标题是执行端最后一条回复去掉围栏与行内标记之后的单行文字，悬停提示是同一句", () => {
    const node = render((log) => {
      log.push({ kind: "assistant.delta", data: { itemId: "a1", text: "```ts\nexport class ParseError extends Error {}\n```\n\n详见 **这次提交**。", phase: "final" } }, { runId: "run_1" });
      log.push({ kind: "assistant.completed", data: { itemId: "a1" } }, { runId: "run_1" });
      log.push({ kind: "run.completed", data: { stopReason: "end_turn" } }, { runId: "run_1" });
      log.push({ kind: "session.status", data: { status: "idle" } }, { source: "ensemble" });
    });
    expect(node.getAttribute("data-phase")).toBe("done");
    const sub = node.querySelector<HTMLElement>(".a-sub")!;
    expect(sub.textContent).toBe("export class ParseError extends Error {} 详见 这次提交。");
    expect(sub.getAttribute("data-tip")).toBe(sub.textContent);
  });

  it("进行中的工具标题与失败的错误原文不是 Markdown，原样显示，不被当成标记处理", () => {
    const command = "rg `TODO` src/**/*.ts **/a.ts";
    const running = render((log) => log.tool("run_1", "call_1", "running", { category: "shell", title: command }));
    expect(running.getAttribute("data-phase")).toBe("running");
    expect(running.querySelector(".a-sub")?.textContent).toContain(command);

    const failed = render((log) => {
      log.push({ kind: "run.failed", data: { error: { code: "boom", message: "Cannot read `x` of **undefined**" } } }, { runId: "run_1" });
    });
    expect(failed.getAttribute("data-phase")).toBe("failed");
    expect(failed.querySelector(".a-sub")?.textContent).toBe("Cannot read `x` of **undefined**");
  });
});
