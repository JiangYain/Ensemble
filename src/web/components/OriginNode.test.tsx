import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OriginSummary } from "@shared/types";
import { COLLAPSED_ORIGINS_KEY, setLang, store } from "../lib/app";
import type { SceneEngine } from "../scene/engine";
import { Icon, type IconName } from "./Icons";
import { ModelMark } from "./ModelMark";
import { OriginNode } from "./OriginNode";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const engine = { register: () => () => undefined, toggleSelection: vi.fn(), moveNode: vi.fn() } as unknown as SceneEngine;

/** 用本地时间构造，测试不依赖运行机器的时区。 */
const startedAt = new Date(2026, 0, 2, 17, 50, 22).toISOString();

describe("来源卡片", () => {
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

  const render = (origin: Partial<OriginSummary>, extra: { count?: number; running?: number; hostTitle?: string; compact?: boolean; folderNode?: boolean; collapsed?: boolean; hidden?: number } = {}): HTMLElement => {
    const full: OriginSummary = { key: "k", kind: "agent", host: "cursor", hostLabel: "Cursor", workspace: "C:\\Users\\alice\\Desktop\\Ensemble", ...origin };
    act(() => root.render(<OriginNode origin={full} count={extra.count ?? 1} running={extra.running ?? 0} startedAt={startedAt} hostTitle={extra.hostTitle} compact={extra.compact} folderNode={extra.folderNode} collapsed={extra.collapsed} hidden={extra.hidden} engine={engine} />));
    return host.querySelector<HTMLElement>(".node.origin")!;
  };

  /** 把某个图标单独渲染一遍，取出它的路径，用来判断卡片上画的是哪一个。 */
  const pathOf = (name: IconName): string | null => {
    const scratch = document.createElement("div");
    const scratchRoot = createRoot(scratch);
    act(() => scratchRoot.render(<Icon name={name} />));
    const d = scratch.querySelector("path")?.getAttribute("d") ?? null;
    act(() => scratchRoot.unmount());
    return d;
  };

  it("有图标的宿主不再写宿主名和会话号：卡片上只有工作目录、时间和会话数", () => {
    const node = render({ sessionRef: { id: "38ba040b-4d8b-41a4-af34-abd1ce037962", kind: "conversation", source: "env" } });
    expect(node.querySelector(".o-main .o-text")?.textContent).toBe("Ensemble");
    // 完整的年月日 + 时分，不显示秒。
    expect(node.querySelector(".o-sub time")?.textContent).toBe("2026年1月2日 17:50");
    expect(node.querySelector(".o-sub time")?.getAttribute("datetime")).toBe(startedAt);
    expect(node.querySelector(".o-count")?.textContent).toBe("1");
    // 头部的 Main Agent 标签是卡片自己的标题；正文里不出现宿主名或会话号。
    const body = node.querySelector(".o-body")!.textContent ?? "";
    expect(body).not.toContain("Cursor");
    expect(body).not.toContain("38ba040b");
    expect(body).not.toContain("对话");
  });

  it("紧凑模式下日期换成同样完整但更短的数字写法，悬停提示仍是完整的本地化时间", () => {
    const wide = render({});
    expect(wide.querySelector(".o-sub time")?.textContent).toBe("2026年1月2日 17:50");
    const compact = render({}, { compact: true });
    expect(compact.querySelector(".o-sub time")?.textContent).toBe("2026-01-02 17:50");
    expect(compact.querySelector(".o-sub time")?.getAttribute("datetime")).toBe(startedAt);
    expect(compact.getAttribute("data-tip")).toContain("首次委派: ");
    // 没有工作目录、日期升为主行时，同样跟随。
    const bare = render({ kind: "user", host: "console", hostLabel: "Ensemble", workspace: undefined as unknown as string }, { compact: true });
    expect(bare.querySelector(".o-main .o-text")?.textContent).toBe("2026-01-02 17:50");
  });

  it("头部的宿主图标与会话卡头部的模型图标一样大，不比同一排的图标小", () => {
    const scratch = document.createElement("div");
    const scratchRoot = createRoot(scratch);
    act(() => scratchRoot.render(<ModelMark family="deepseek" />));
    const modelMark = parseFloat(scratch.querySelector<HTMLElement>(".model-mark")!.style.width);
    act(() => scratchRoot.unmount());

    const mark = render({}).querySelector(".o-head .a-mark img.harness-mark")!;
    expect(parseFloat(mark.getAttribute("width")!)).toBe(modelMark);
    expect(parseFloat(mark.getAttribute("height")!)).toBe(modelMark);
    // 放得进图标格（13，与正文图标同宽）：不会被 .a-mark 的 max-width 裁小，也不撑乱头部的列轴。
    expect(modelMark).toBeLessThanOrEqual(13);
  });

  it("头部最左就是宿主图标：没有抓手或别的装饰，图标格与正文图标同宽", () => {
    const node = render({}, { hostTitle: "审查 Ensemble 代码质量" });
    const head = node.querySelector(".o-head")!;
    expect(head.firstElementChild?.className).toBe("a-mark");
    expect(head.children[1]?.className).toBe("o-label");
    expect(node.querySelector(".node-grip")).toBeNull();
    // 头部图标格（样式里 13）与正文图标是同一个尺寸：两者的中心线重合，文字同列。
    expect(parseFloat(node.querySelector(".o-main .o-ico")!.getAttribute("width")!)).toBe(13);
    // 没有宿主图标的发起端（控制台）同样：头部最左是同一个格子，里面是线性图标。
    const user = render({ kind: "user", host: "console", hostLabel: "Ensemble" });
    expect(user.querySelector(".o-head")?.firstElementChild?.className).toBe("a-mark");
    expect(user.querySelector(".o-head")?.firstElementChild?.querySelector("svg")).not.toBeNull();
  });

  describe("头部列轴（凡是用 .o-head 的卡片都一样）", () => {
    let styles: HTMLStyleElement;
    beforeEach(() => {
      styles = document.createElement("style");
      styles.textContent = readFileSync("src/web/styles/scene.css", "utf8");
      document.head.append(styles);
    });
    afterEach(() => styles.remove());

    const px = (value: string): number => parseFloat(value);
    /** 头部最左的图标格起点、图标格宽、头部文字的起点、右缘：直接由样式推出，对应 scene.css 版式基准里的列轴。 */
    const axes = (node: HTMLElement): { slotLeft: number; slot: number; textLeft: number; right: number } => {
      const head = node.querySelector<HTMLElement>(".o-head")!;
      const style = getComputedStyle(head);
      const slot = px(getComputedStyle(head.querySelector(".a-mark")!).width);
      return { slotLeft: px(style.paddingLeft), slot, textLeft: px(style.paddingLeft) + slot + px(style.gap), right: px(style.paddingRight) };
    };

    it("图标格 13 起于 x=14，文字起于 x=34；右缘留 14", () => {
      const node = render({});
      expect(axes(node)).toEqual({ slotLeft: 14, slot: 13, textLeft: 34, right: 14 });
      expect(px(getComputedStyle(node.querySelector(".a-mark")!).height)).toBe(13);
    });

    it("紧凑一档里只是左右内边距收到 10：整条列轴一起左移到 x=10 / x=30，图标格仍是 13", () => {
      // happy-dom 的计算样式不解析“.scene[data-compact] .o-head”这类后代加属性选择器，这条规则只能直接读样式表。
      const css = readFileSync("src/web/styles/scene.css", "utf8");
      expect(css).toMatch(/\.scene\[data-compact\] \.o-head \{ padding-inline: 10px; \}/);
      expect(css).not.toMatch(/\.scene\[data-compact\] \.(?:a-mark|o-label)\b/);
      // 图标格起点到文字起点是 20（格 13 + 间距 7），紧凑一档只换了起点：10 + 20 = 30。
      const { slot, slotLeft, textLeft } = axes(render({}, { compact: true }));
      expect(slot).toBe(13);
      expect(textLeft - slotLeft).toBe(20);
      expect(10 + (textLeft - slotLeft)).toBe(30);
    });
  });

  it("会话数在头部右端，不占正文的宽度", () => {
    const node = render({}, { count: 12 });
    const count = node.querySelector(".o-head > .o-count");
    expect(count?.textContent).toBe("12");
    expect(node.querySelector(".o-body .o-count")).toBeNull();
    // 头部里它排在标签之后。
    const label = node.querySelector(".o-head > .o-label")!;
    expect(label.compareDocumentPosition(count!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("工作目录行画文件夹图标，时间与标题缩进到同一条文字列", () => {
    const node = render({}, { hostTitle: "审查 Ensemble 代码质量" });
    expect(node.querySelector(".o-main .o-ico path")?.getAttribute("d")).toBe(pathOf("folder"));
    // 时间与标题都是文字列里的行（同一个缩进类），而不是各自带着图标。
    expect(node.querySelector(".o-sub .o-ico")).toBeNull();
    expect(node.querySelector(".o-title .o-ico")).toBeNull();
  });

  it("宿主给对话起了标题就显示在时间下面，悬停给出全文和来源", () => {
    const node = render({}, { hostTitle: "审查 Ensemble 代码质量" });
    const title = node.querySelector<HTMLElement>(".o-title")!;
    expect(title.textContent).toBe("审查 Ensemble 代码质量");
    expect(title.getAttribute("data-tip")).toBe("Cursor 里这段对话的标题\n审查 Ensemble 代码质量");
    // 顺序：工作目录、时间、标题。
    const order = [".o-main", ".o-sub", ".o-title"].map((selector) => node.querySelector(selector)!);
    expect(order[0]!.compareDocumentPosition(order[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[1]!.compareDocumentPosition(order[2]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("宿主没有标题时没有这一行，不拿别的文字顶替", () => {
    const node = render({});
    expect(node.querySelector(".o-title")).toBeNull();
    expect(node.querySelector(".o-body")?.children).toHaveLength(2);
  });

  it("会话标识和首次委派时间放在悬停提示里", () => {
    const node = render({ sessionRef: { id: "38ba040b-4d8b-41a4-af34-abd1ce037962", kind: "conversation", source: "env" } });
    const tip = node.getAttribute("data-tip") ?? "";
    expect(tip).toContain("发起端：Cursor");
    expect(tip).toContain("对话: 38ba040b-4d8b-41a4-af34-abd1ce037962");
    expect(tip).toContain("工作区: C:\\Users\\alice\\Desktop\\Ensemble");
    expect(tip).toContain("首次委派: ");
  });

  it("没有会话标识就不写这一行，也不特意声明“没有”", () => {
    const tip = render({}).getAttribute("data-tip") ?? "";
    expect(tip).not.toContain("会话标识");
    expect(tip).not.toContain("不做猜测");
    expect(tip.split("\n")).toEqual([expect.stringContaining("发起端：Cursor"), expect.stringContaining("工作区: "), expect.stringContaining("首次委派: ")]);
  });

  it("控制台发起的来源，提示里只有发起端和首次委派时间", () => {
    const tip = render({ kind: "user", host: "console", hostLabel: "Ensemble", workspace: undefined as unknown as string }).getAttribute("data-tip") ?? "";
    expect(tip.split("\n")).toEqual(["发起端：Ensemble", expect.stringContaining("首次委派: ")]);
  });

  it("图标说明不了身份的宿主仍然写出名字：写在头部（Main Agent / 名字），不挤占正文里的日期", () => {
    const node = render({ host: "unknown", hostLabel: "my-mcp-client" });
    expect(node.querySelector(".o-head > .a-model")?.textContent).toBe("my-mcp-client");
    // 正文里的日期完整保留，名字不在正文里。
    expect(node.querySelector(".o-sub")?.textContent).toBe("2026年1月2日 17:50");
    expect(node.querySelector(".o-body")?.textContent).not.toContain("my-mcp-client");
    // 有图标的宿主头部没有这一段。
    expect(render({}).querySelector(".o-head > .a-model")).toBeNull();
  });

  it("控制台发起的来源有用户图标，不再写“你（控制台）”", () => {
    const node = render({ kind: "user", host: "console", hostLabel: "Ensemble" });
    expect(node.querySelector(".o-body")?.textContent).not.toContain("你（控制台）");
    // 可访问名称仍然说明是谁。
    expect(node.getAttribute("aria-label")).toContain("你（控制台）");
  });

  it("没有工作目录时不画目录行、不写“没有”：时间升为主行", () => {
    const node = render({ kind: "user", host: "console", hostLabel: "Ensemble", workspace: undefined as unknown as string });
    const main = node.querySelector(".o-main")!;
    expect(main.querySelector(".o-text")?.textContent).toBe("2026年1月2日 17:50");
    expect(main.querySelector(".o-text")?.tagName).toBe("TIME");
    expect(main.querySelector(".o-ico path")?.getAttribute("d")).toBe(pathOf("clock"));
    // 正文里只剩这一行：没有重复的时间，也没有任何“未提供”之类的声明。
    expect(node.querySelector(".o-body")?.children).toHaveLength(1);
    expect(node.textContent).not.toContain("未提供");
    expect(node.querySelector(".o-body")?.textContent?.match(/17:50/g)).toHaveLength(1);
  });

  it("Agent 发起的来源没有工作目录：目录行写“未知”，时间退到次行；提示里写明未知，不拿别的目录顶替", () => {
    const node = render({ workspace: undefined as unknown as string });
    const main = node.querySelector(".o-main")!;
    expect(main.querySelector(".o-text")?.textContent).toBe("未知");
    expect(main.querySelector(".o-text")?.classList.contains("o-unknown")).toBe(true);
    expect(main.querySelector(".o-ico path")?.getAttribute("d")).toBe(pathOf("folder"));
    expect(node.querySelector(".o-sub time")?.textContent).toBe("2026年1月2日 17:50");
    expect(node.getAttribute("data-tip")).toContain("工作区: 未知（宿主没有报告工作区，委派时也没有传 cwd）");
    // 工作目录已经画成 Folder 节点时（有目录才会画），这一行不出现；窄画布也一样是布局给的事实。
    expect(render({}, { folderNode: true }).querySelector(".o-unknown")).toBeNull();
    // 控制台来源本来就没有目录：不写“未知”。
    const user = render({ kind: "user", host: "console", hostLabel: "Ensemble", workspace: undefined as unknown as string });
    expect(user.querySelector(".o-unknown")).toBeNull();
    expect(user.getAttribute("data-tip")).not.toContain("工作区");
  });

  it("会话标识是 Agent 自报的，悬停提示里如实说明；宿主交出的标识不带这句话", () => {
    const declared = render({ sessionRef: { id: "4706e0d9-12d7-4b10-a784-5d3416b186a9", kind: "conversation", source: "declared" } });
    expect(declared.getAttribute("data-tip")).toContain("对话: 4706e0d9-12d7-4b10-a784-5d3416b186a9");
    expect(declared.getAttribute("data-tip")).toContain("宿主没有交出会话标识；这个标识是 Agent 通过 conversationId 参数自己报的，Ensemble 无法核对。");
    const fromHost = render({ sessionRef: { id: "38ba040b-4d8b-41a4-af34-abd1ce037962", kind: "conversation", source: "env" } });
    expect(fromHost.getAttribute("data-tip")).toContain("对话: 38ba040b-4d8b-41a4-af34-abd1ce037962");
    expect(fromHost.getAttribute("data-tip")).not.toContain("conversationId");
    expect(fromHost.getAttribute("data-tip")).not.toContain("无法核对");
    // 标识不上卡面：卡片正文里没有会话号（说明只放在提示里，不占卡片）。
    expect(declared.querySelector(".o-body")?.textContent).not.toContain("4706e0d9");
  });

  it("工作目录带着来历：宿主的对话记录、宿主报告的、委派时传入的 cwd 各自注明；没有来历的旧数据只写路径", () => {
    expect(render({ workspaceSource: "host-record" }).getAttribute("data-tip")).toContain("工作区: C:\\Users\\alice\\Desktop\\Ensemble（宿主的对话记录）");
    expect(render({ workspaceSource: "mcp-roots" }).getAttribute("data-tip")).toContain("工作区: C:\\Users\\alice\\Desktop\\Ensemble（宿主报告）");
    expect(render({ workspaceSource: "delegate-cwd" }).getAttribute("data-tip")).toContain("工作区: C:\\Users\\alice\\Desktop\\Ensemble（委派时传入的 cwd）");
    const legacy = render({}).getAttribute("data-tip") ?? "";
    expect(legacy).toContain("工作区: C:\\Users\\alice\\Desktop\\Ensemble");
    expect(legacy).not.toContain("（");
  });

  it("没有工作目录但有标题时，标题接在时间之后", () => {
    const node = render({ kind: "user", host: "console", hostLabel: "Ensemble", workspace: undefined as unknown as string }, { hostTitle: "某个标题" });
    expect([...node.querySelector(".o-body")!.children].map((child) => child.className)).toEqual(["o-main", "o-title"]);
  });

  describe("工作目录画成了左边的 Folder 节点（folderNode）", () => {
    it("正文不再重复目录行：首次委派时间升为主行（钟表图标 + 时间），正文里只剩这一行", () => {
      const node = render({}, { folderNode: true });
      const main = node.querySelector(".o-main")!;
      expect(main.querySelector(".o-ico path")?.getAttribute("d")).toBe(pathOf("clock"));
      expect(main.querySelector(".o-text")?.tagName).toBe("TIME");
      expect(main.querySelector(".o-text")?.textContent).toBe("2026年1月2日 17:50");
      expect(node.querySelector(".o-body")?.children).toHaveLength(1);
      expect([...node.querySelectorAll(".o-ico path")].some((path) => path.getAttribute("d") === pathOf("folder"))).toBe(false);
      expect(node.querySelector(".o-body")?.textContent).not.toContain("Ensemble");
      expect(node.querySelector(".o-body")?.textContent?.match(/17:50/g)).toHaveLength(1);
    });

    it("宿主给对话起的标题接在时间之后，与控制台来源（本来没有工作目录）的版式完全一样", () => {
      const withFolder = render({}, { folderNode: true, hostTitle: "审查 Ensemble 代码质量" });
      const bare = render({ kind: "user", host: "console", hostLabel: "Ensemble", workspace: undefined as unknown as string }, { hostTitle: "审查 Ensemble 代码质量" });
      expect([...withFolder.querySelector(".o-body")!.children].map((child) => child.className)).toEqual(["o-main", "o-title"]);
      // 标题的悬停提示里写着各自宿主的名字，所以逐段比：主行（钟表 + 时间）与标题文字完全一致。
      expect(withFolder.querySelector(".o-main")!.innerHTML).toBe(bare.querySelector(".o-main")!.innerHTML);
      expect(withFolder.querySelector(".o-title")!.textContent).toBe(bare.querySelector(".o-title")!.textContent);
    });

    it("悬停提示里仍有完整的工作区路径：来源自己带着的信息不因为拆成节点而丢", () => {
      expect(render({}, { folderNode: true }).getAttribute("data-tip")).toContain("工作区: C:\\Users\\alice\\Desktop\\Ensemble");
    });

    it("目录行写不写只由布局给的 folderNode 决定，组件不自己看窗口宽窄：紧凑且没有 Folder 节点时保留目录行", () => {
      const compact = render({}, { compact: true, folderNode: false });
      expect(compact.querySelector(".o-main .o-text")?.textContent).toBe("Ensemble");
      expect(compact.querySelector(".o-main .o-ico path")?.getAttribute("d")).toBe(pathOf("folder"));
      expect(compact.querySelector(".o-sub time")).not.toBeNull();
      expect(compact.querySelector(".o-body")?.children).toHaveLength(2);

      // 同样的紧凑，布局说 Folder 画了就不写；不紧凑、布局说没画就写。
      expect(render({}, { compact: true, folderNode: true }).querySelector(".o-body")?.children).toHaveLength(1);
      expect(render({}, { compact: false, folderNode: false }).querySelector(".o-main .o-text")?.textContent).toBe("Ensemble");
    });

    it("来源本来就没有工作目录：folderNode 与否都一样，没有目录行，也不写“没有”", () => {
      const bare = { kind: "user", host: "console", hostLabel: "Ensemble", workspace: undefined as unknown as string } as const;
      expect(render(bare, { folderNode: true }).querySelector(".o-body")!.innerHTML).toBe(render(bare, { folderNode: false }).querySelector(".o-body")!.innerHTML);
    });
  });

  it("有会话在运行时会话数前出现与 Agent 卡同款的运行指示点", () => {
    const node = render({}, { count: 3, running: 2 });
    expect(node.querySelector(".o-count i.a-run")).not.toBeNull();
    expect(node.querySelector(".o-count")?.textContent).toBe("3");
    expect(node.querySelector(".o-count")?.getAttribute("data-tip")).toBe("3 个会话 · 2 个运行中");
    expect(render({}, { count: 3, running: 0 }).querySelector(".o-count i")).toBeNull();
  });

  describe("隐藏了相关节点（collapsed）", () => {
    it("没隐藏时与以前一样：没有 data-collapsed，会话数是一段普通文字，不是按钮", () => {
      const node = render({}, { count: 3 });
      expect(node.hasAttribute("data-collapsed")).toBe(false);
      expect(node.querySelector(".o-count")?.tagName).toBe("SPAN");
      expect(node.querySelector("button")).toBeNull();
      expect(node.getAttribute("aria-label")).toBe("来源：Cursor");
    });

    it("隐藏后：卡片打上 data-collapsed；头部的会话数换成“显示”按钮——同一个数，前面多一只关着的眼睛", () => {
      const node = render({}, { count: 3, hidden: 3, collapsed: true });
      expect(node.hasAttribute("data-collapsed")).toBe(true);
      const button = node.querySelector<HTMLButtonElement>("button.o-expand")!;
      expect(button.type).toBe("button");
      expect(button.classList.contains("o-count")).toBe(true);
      expect(button.textContent).toBe("3");
      expect(button.querySelector("svg path")?.getAttribute("d")).toBe(pathOf("eyeOff"));
      expect(button.getAttribute("aria-label")).toBe("显示相关节点");
      expect(button.getAttribute("data-tip")).toBe("相关节点已隐藏 · 3 个会话\n点击或右键显示");
      expect(node.getAttribute("aria-label")).toBe("来源：Cursor（相关节点已隐藏）");
      // 卡片的其余内容原样：工作目录、时间仍在。
      expect(node.querySelector(".o-main .o-text")?.textContent).toBe("Ensemble");
      expect(node.querySelector(".o-sub time")).not.toBeNull();
    });

    it("提示里写的是收起的会话数（含嵌套的），数字与右键菜单一致；有运行中的会话时写明", () => {
      const node = render({}, { count: 2, hidden: 5, running: 1, collapsed: true });
      expect(node.querySelector("button.o-expand")?.getAttribute("data-tip")).toBe("相关节点已隐藏 · 5 个会话 · 1 个运行中\n点击或右键显示");
      // 卡片上的数仍是来源自己的会话数，与没隐藏时同一个数；运行指示点留在原处，运行中的会话没有被藏得无影无踪。
      expect(node.querySelector("button.o-expand")?.textContent).toBe("2");
      expect(node.querySelector("button.o-expand i.a-run")).not.toBeNull();
    });

    it("点“显示”按钮：把这个来源从隐藏名单里去掉并写进浏览器偏好；不影响别的来源", () => {
      act(() => store.set({ collapsedOrigins: new Set(["k", "other"]), ready: false }));
      const node = render({ key: "k" }, { collapsed: true });
      act(() => node.querySelector<HTMLButtonElement>("button.o-expand")!.click());
      expect([...store.get().collapsedOrigins]).toEqual(["other"]);
      expect(JSON.parse(localStorage.getItem(COLLAPSED_ORIGINS_KEY)!)).toEqual(["other"]);
      act(() => store.set({ collapsedOrigins: new Set() }));
    });

    it("英文界面", () => {
      act(() => setLang("en"));
      const node = render({}, { count: 1, hidden: 1, collapsed: true });
      expect(node.querySelector("button.o-expand")?.getAttribute("aria-label")).toBe("Show related nodes");
      expect(node.querySelector("button.o-expand")?.getAttribute("data-tip")).toBe("Related nodes hidden · 1 session\nClick or right-click to show");
      expect(node.getAttribute("aria-label")).toBe("Origin: Cursor (related nodes hidden)");
      act(() => setLang("zh"));
    });
  });});
