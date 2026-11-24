import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReasoningItem, ToolItem } from "@shared/types";
import { setLang } from "../lib/app";
import { FROZEN_WINDOW_EXTRA, GROUP_WINDOW, ReasoningRow, ToolRow, WorkGroup } from "./Steps";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AT = "2026-11-15T10:00:00.000Z";
const later = (ms: number): string => new Date(Date.parse(AT) + ms).toISOString();

function tool(over: Partial<ToolItem> = {}): ToolItem {
  return { id: "t1", type: "tool", callId: "c1", name: "read_file", category: "read", title: "src/parser.ts", status: "completed", at: AT, updatedAt: AT, startedAt: AT, ...over };
}

function thought(over: Partial<ReasoningItem> = {}): ReasoningItem {
  return { id: "r1", type: "reasoning", text: "先看入口，再决定怎么拆。", streaming: false, at: AT, updatedAt: AT, ...over };
}

function mount(): { host: HTMLDivElement; root: Root; unmount: () => void } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  return {
    host,
    root,
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe("工具步骤", () => {
  let view: ReturnType<typeof mount>;

  beforeEach(() => {
    setLang("zh");
    view = mount();
  });

  afterEach(() => {
    view.unmount();
    vi.useRealTimers();
  });

  const render = (item: ToolItem): void => {
    act(() => view.root.render(<ToolRow item={item} />));
  };
  const head = (): HTMLButtonElement => view.host.querySelector<HTMLButtonElement>(".tool-head")!;

  it("已完成的步骤什么标记也不加：动词、标题、耗时；没有细节时整行不可点，也不摆展开箭头", () => {
    render(tool({ durationMs: 1200 }));
    expect(view.host.querySelector(".tool-verb")?.textContent).toBe("读取");
    expect(view.host.querySelector(".tool-title")?.textContent).toBe("src/parser.ts");
    expect(view.host.querySelector(".tool-dur")?.textContent).toBe("1.2s");
    expect(view.host.querySelector(".tool-state")).toBeNull();
    expect(view.host.querySelector(".spinner")).toBeNull();
    expect(head().disabled).toBe(true);
    expect(head().hasAttribute("aria-expanded")).toBe(false);
    expect(view.host.querySelector(".tool-chevron")).toBeNull();
  });

  it("有输入输出时可以展开与收起，aria-expanded 跟着变", () => {
    render(tool({ input: { text: "src/parser.ts", truncated: false }, output: { text: "export class Parser {}", truncated: false } }));
    expect(head().getAttribute("aria-expanded")).toBe("false");
    expect(view.host.querySelector(".tool-detail")).toBeNull();

    act(() => head().click());
    expect(head().getAttribute("aria-expanded")).toBe("true");
    const labels = [...view.host.querySelectorAll(".preview-head > span")].map((node) => node.textContent);
    expect(labels).toEqual(["输入", "输出"]);
    expect(view.host.querySelector(".tool-detail")?.textContent).toContain("export class Parser {}");

    act(() => head().click());
    expect(view.host.querySelector(".tool-detail")).toBeNull();
  });

  it("进行中：转圈 + 读屏文字“进行中” + 已经跑了多久（每秒走），完成后改为定格的耗时", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(AT) + 2300);
    render(tool({ status: "running", category: "shell", title: "npm test" }));
    expect(view.host.querySelector(".tool-icon .spinner")).not.toBeNull();
    expect(view.host.querySelector(".tool-icon .sr-only")?.textContent).toBe("进行中");
    expect(view.host.querySelector(".tool-dur")?.textContent).toBe("2.3s");

    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(view.host.querySelector(".tool-dur")?.textContent).toBe("5.3s");

    render(tool({ status: "completed", category: "shell", title: "npm test", durationMs: 5400 }));
    expect(view.host.querySelector(".spinner")).toBeNull();
    expect(view.host.querySelector(".tool-dur")?.textContent).toBe("5.4s");
  });

  it("失败：带标记与文字说明；展开后原因用红色，退出码写在输出的标题里", () => {
    render(tool({ status: "failed", category: "shell", title: "npm test", error: "exit status 2", exitCode: 2, output: { text: "1 failing", truncated: false } }));
    const mark = view.host.querySelector<HTMLElement>(".tool-state")!;
    expect(mark.getAttribute("data-tip")).toBe("失败");
    expect(mark.querySelector(".sr-only")?.textContent).toBe("失败");

    act(() => head().click());
    expect(view.host.querySelector(".note--red")?.textContent).toBe("exit status 2");
    expect(view.host.querySelector(".preview-head > span")?.textContent).toBe("输出 · 退出码 2");
  });

  it("没有结束事件：标成“未结束”，展开后如实写明结果未知，不当作成功也不当作失败", () => {
    render(tool({ status: "unfinished", input: { text: "src/parser.ts", truncated: false } }));
    expect(view.host.querySelector(".tool-state")?.getAttribute("data-tip")).toBe("未结束（没有结束事件）");
    act(() => head().click());
    expect(view.host.querySelector(".tool-detail .note")?.textContent).toBe("运行结束时执行端没有上报这个步骤的结束事件，它的结果未知。");
    expect(view.host.querySelector(".note--red")).toBeNull();
  });

  it("单个文件只显示执行端真实上报、且不为 0 的行数：没上报的一侧不写成 0；多个文件只写个数，路径放在提示里", () => {
    const marks = (): string[] => [...view.host.querySelectorAll<HTMLElement>(".tool-files i")].map((node) => `${node.getAttribute("data-sign")}:${node.textContent}`);
    const single = (file: { addedLines?: number; removedLines?: number }): ToolItem => tool({ category: "edit", title: "src/parser.ts", files: [{ path: "src/parser.ts", change: "modified", ...file }] });

    render(single({ addedLines: 12, removedLines: 0 }));
    expect(marks()).toEqual(["add:+12"]);
    render(single({ addedLines: 0, removedLines: 7 }));
    expect(marks()).toEqual(["del:−7"]);
    render(single({ addedLines: 3, removedLines: 2 }));
    expect(marks()).toEqual(["add:+3", "del:−2"]);
    // 没上报、或上报的都是 0：没有数字，连容器也不渲染。
    for (const counts of [{}, { addedLines: 0, removedLines: 0 }, { addedLines: 0 }]) {
      render(single(counts));
      expect(view.host.querySelector(".tool-files"), JSON.stringify(counts)).toBeNull();
    }

    render(
      tool({
        category: "edit",
        files: [
          { path: "src/a.ts", change: "modified", addedLines: 1, removedLines: 1 },
          { path: "src/b.ts", change: "created", addedLines: 8 },
        ],
      }),
    );
    const files = view.host.querySelector<HTMLElement>(".tool-files")!;
    expect(files.textContent).toBe("2 个文件");
    expect(files.getAttribute("data-tip")).toBe("src/a.ts\nsrc/b.ts");

    act(() => head().click());
    expect([...view.host.querySelectorAll(".file-path")].map((node) => node.textContent)).toEqual(["src/a.ts", "src/b.ts"]);
    expect([...view.host.querySelectorAll(".file-change-head .chip")].map((node) => node.textContent)).toEqual(["修改", "新建"]);
    // 展开后每个文件各自只写上报过的数：b.ts 没有上报删除，就没有“−”。
    expect([...view.host.querySelectorAll(".file-change")].map((row) => [...row.querySelectorAll(".file-stat i")].map((node) => node.textContent))).toEqual([["+1", "−1"], ["+8"]]);
  });

  it("MCP 工具：服务名与工具名放在标题前", () => {
    render(tool({ category: "mcp", title: "query docs", mcp: { server: "magpie", tool: "search" } }));
    expect(view.host.querySelector(".tool-title em")?.textContent).toBe("magpie · search");
  });
});

describe("推理步骤", () => {
  let view: ReturnType<typeof mount>;

  beforeEach(() => {
    setLang("zh");
    view = mount();
  });

  afterEach(() => view.unmount());

  const render = (item: ReasoningItem): void => {
    act(() => view.root.render(<ReasoningRow item={item} />));
  };
  const head = (): HTMLButtonElement => view.host.querySelector<HTMLButtonElement>(".reasoning-head")!;
  const verb = (): HTMLElement => view.host.querySelector<HTMLElement>(".reasoning-head .tool-verb")!;
  const NOTE = "这是执行端提供的推理摘要，不是模型完整的思考过程。";

  it("正在输出：转圈与“正在思考”，没有时长（事件里没有就不编）", () => {
    render(thought({ streaming: true }));
    expect(view.host.querySelector(".tool-icon .spinner")).not.toBeNull();
    expect(view.host.querySelector(".tool-verb")?.textContent).toBe("正在思考");
    expect(view.host.querySelector(".tool-dur")).toBeNull();
  });

  it("已结束：“思考”加执行端上报的时长；展开只看到摘要正文，不再每个块都附一行说明", () => {
    render(thought({ durationMs: 1500 }));
    expect(view.host.querySelector(".spinner")).toBeNull();
    expect(view.host.querySelector(".tool-verb")?.textContent).toBe("思考");
    expect(view.host.querySelector(".tool-dur")?.textContent).toBe("1.5s");
    expect(head().getAttribute("aria-expanded")).toBe("false");

    act(() => head().click());
    expect(head().getAttribute("aria-expanded")).toBe("true");
    expect(view.host.querySelector(".reasoning-body")?.textContent).toContain("先看入口，再决定怎么拆。");
    expect(view.host.querySelector(".reasoning-body .note")).toBeNull();
    expect(view.host.textContent).not.toContain("推理摘要");
  });

  it("“这不是模型完整的思考过程”是悬停提示：只挂在动词上，读屏走按钮的 aria-description，展开与否都不变", () => {
    render(thought({ durationMs: 1500 }));
    expect(verb().getAttribute("data-tip")).toBe(NOTE);
    expect(head().getAttribute("aria-description")).toBe(NOTE);
    // 只有这一处：整行、箭头、时长上都没有，悬停行内其他位置不会弹。
    expect([...view.host.querySelectorAll("[data-tip]")]).toEqual([verb()]);
    // 不是常驻文字，也没有塞进按钮的可访问名称（名称仍是“思考 1.5s”）。
    expect(head().textContent).toBe("思考1.5s");
    expect(view.host.querySelector(".sr-only")).toBeNull();

    act(() => head().click());
    expect(verb().getAttribute("data-tip")).toBe(NOTE);
    expect(head().getAttribute("aria-description")).toBe(NOTE);
    expect(view.host.querySelector(".reasoning-body")?.textContent).not.toContain(NOTE);

    // 正在思考时同样有：这个动词最容易让人以为展示的是完整的思考。
    render(thought({ streaming: true }));
    expect(verb().textContent).toBe("正在思考");
    expect(verb().getAttribute("data-tip")).toBe(NOTE);
  });

  it("提示与读屏说明跟着语言走（沿用字典里的 reasoning.note）", () => {
    act(() => setLang("en"));
    render(thought({ durationMs: 1500 }));
    const english = "This is the reasoning summary the harness exposes, not the model's full train of thought.";
    expect(verb().textContent).toBe("Thought");
    expect(verb().getAttribute("data-tip")).toBe(english);
    expect(head().getAttribute("aria-description")).toBe(english);
  });

  it("执行端没给出文字内容：不可展开，也不摆箭头", () => {
    render(thought({ text: "  " }));
    expect(head().disabled).toBe(true);
    expect(head().hasAttribute("aria-expanded")).toBe(false);
    expect(view.host.querySelector(".tool-chevron")).toBeNull();
  });

  it("执行端没给出文字内容（行是 disabled）：悬停提示与读屏说明照样在，点击不展开，也不凭空多出文字", () => {
    render(thought({ text: "  ", durationMs: 1500 }));
    expect(head().disabled).toBe(true);
    expect(verb().textContent).toBe("思考");
    expect(verb().getAttribute("data-tip")).toBe(NOTE);
    expect(head().getAttribute("aria-description")).toBe(NOTE);
    expect([...view.host.querySelectorAll("[data-tip]")]).toEqual([verb()]);

    act(() => head().click());
    expect(view.host.querySelector(".reasoning-body")).toBeNull();
    expect(view.host.textContent).toBe("思考1.5s");
  });
});

describe("工作组", () => {
  let view: ReturnType<typeof mount>;

  beforeEach(() => {
    setLang("zh");
    view = mount();
  });

  afterEach(() => {
    view.unmount();
    vi.useRealTimers();
  });

  const render = (items: Array<ToolItem | ReasoningItem>, live = false, expandAll = false): void => {
    act(() => view.root.render(<WorkGroup items={items} live={live} expandAll={expandAll} />));
  };
  const head = (): HTMLButtonElement => view.host.querySelector<HTMLButtonElement>(".work-head")!;
  const panel = (): HTMLElement | null => view.host.querySelector<HTMLElement>(".work-panel");

  const done = (): Array<ToolItem | ReasoningItem> => [
    tool({ id: "t1", category: "read", durationMs: 300 }),
    tool({ id: "t2", category: "read", title: "src/lexer.ts", durationMs: 200 }),
    tool({ id: "t3", category: "search", title: "TokenKind", durationMs: 100, updatedAt: later(3000) }),
  ];

  it("结束后默认收起成一行：步骤数、各类次数、总耗时；点开才看到逐步记录", () => {
    render(done());
    expect(view.host.querySelector(".work-title")?.textContent).toBe("执行了 3 个步骤");
    expect(view.host.querySelector(".work-mix")?.textContent).toBe("读取 2 · 搜索 1");
    expect(view.host.querySelector(".work-dur")?.textContent).toBe("3.0s");
    expect(head().getAttribute("aria-expanded")).toBe("false");
    expect(head().hasAttribute("aria-controls")).toBe(false);
    expect(panel()).toBeNull();

    act(() => head().click());
    expect(head().getAttribute("aria-expanded")).toBe("true");
    expect(panel()?.getAttribute("data-state")).toBe("open");
    expect(head().getAttribute("aria-controls")).toBe(panel()?.id);
    expect(view.host.querySelectorAll(".tool")).toHaveLength(3);
  });

  it("收起时先播完退出动画再卸载；用户的选择高于“全部展开”", () => {
    vi.useFakeTimers();
    render(done(), false, true);
    expect(panel()?.getAttribute("data-state")).toBe("open");

    act(() => head().click());
    expect(head().getAttribute("aria-expanded")).toBe("false");
    expect(panel()?.getAttribute("data-state")).toBe("closing");
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(panel()).toBeNull();
  });

  it("进行中的组默认展开；进度只落在正在跑的那一步上，标题行不转圈、不报耗时", () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(AT) + 1000);
    render([tool({ id: "t1", durationMs: 300 }), tool({ id: "t2", status: "running", category: "shell", title: "npm test" })], true);
    expect(view.host.querySelector(".work")?.hasAttribute("data-live")).toBe(true);
    expect(view.host.querySelector(".work-title")?.textContent).toBe("正在执行 · 2 个步骤");
    expect(head().querySelector(".spinner")).toBeNull();
    expect(view.host.querySelector(".work-dur")).toBeNull();
    expect(head().getAttribute("aria-expanded")).toBe("true");
    expect(view.host.querySelectorAll(".spinner")).toHaveLength(1);
    expect(view.host.querySelector('.tool[data-status="running"] .spinner')).not.toBeNull();
  });

  it("写入与编辑共用一个动词：合并成“写入 3”，不出现两个“写入”", () => {
    render([
      tool({ id: "t1", category: "write", title: "a.ts" }),
      tool({ id: "t2", category: "write", title: "b.ts" }),
      tool({ id: "t3", category: "edit", title: "c.ts" }),
      tool({ id: "t4", category: "read", title: "d.ts" }),
    ]);
    expect(view.host.querySelector(".work-mix")?.textContent).toBe("写入 3 · 读取 1");
  });

  it("有失败的步骤：标题行带失败数（红）与说明，整组打上 data-failed", () => {
    render([...done(), tool({ id: "t4", status: "failed", category: "shell", title: "npm test", error: "boom" })]);
    const failed = view.host.querySelector<HTMLElement>(".work-failed")!;
    expect(failed.textContent).toBe("1 失败");
    expect(failed.getAttribute("data-tip")).toBe("其中有步骤失败了。单个步骤失败不一定意味着整次运行失败。");
    expect(view.host.querySelector(".work")?.hasAttribute("data-failed")).toBe(true);
  });

  it("只有推理、没有工具调用：直接展示推理行，不写“执行了 0 个步骤”", () => {
    render([thought()]);
    expect(view.host.querySelector(".work-head")).toBeNull();
    expect(view.host.querySelector(".work--solo .reasoning")).not.toBeNull();
    expect(view.host.textContent).not.toContain("0 个步骤");
  });

  it("英文界面走词典", () => {
    setLang("en");
    render(done());
    expect(view.host.querySelector(".work-title")?.textContent).toBe("Ran 3 steps");
  });
});

describe("工作组的窗口：用户向上翻阅时起点冻结", () => {
  let view: ReturnType<typeof mount>;

  beforeEach(() => {
    setLang("zh");
    view = mount();
  });

  afterEach(() => {
    view.unmount();
    vi.useRealTimers();
  });

  /** step-from … step-(to-1)，标题就是编号，方便断言窗口的起点。 */
  const steps = (to: number, from = 0): ToolItem[] => Array.from({ length: to - from }, (_, i) => tool({ id: `t${from + i}`, title: `step-${from + i}`, durationMs: 10 }));
  const render = (items: ToolItem[], following: boolean): void => {
    act(() => view.root.render(<WorkGroup items={items} live expandAll={false} following={following} />));
  };
  const rows = (): HTMLElement[] => [...view.host.querySelectorAll<HTMLElement>(".tool")];
  const titles = (): Array<string | null> => [...view.host.querySelectorAll(".tool-title")].map((node) => node.textContent);
  const older = (): HTMLButtonElement | null => view.host.querySelector<HTMLButtonElement>(".more-btn--inline");

  it("贴底时窗口跟着尾部滑动：每来一步，起点前移一步，行数恒为 GROUP_WINDOW", () => {
    render(steps(100), true);
    expect(rows()).toHaveLength(GROUP_WINDOW);
    expect(titles()[0]).toBe("step-40");

    render(steps(101), true);
    expect(rows()).toHaveLength(GROUP_WINDOW);
    expect(titles()[0]).toBe("step-41");
    expect(titles().at(-1)).toBe("step-100");
    expect(older()?.textContent).toContain("41");
  });

  it("离开底部后起点冻结：新步骤只在尾部追加，已渲染的行一个都不卸载、也不换 DOM 节点", () => {
    render(steps(100), true);
    const before = rows();
    expect(titles()[0]).toBe("step-40");

    render(steps(100), false);
    render(steps(130), false);

    expect(rows()).toHaveLength(GROUP_WINDOW + 30);
    expect(titles()[0]).toBe("step-40");
    expect(titles().at(-1)).toBe("step-129");
    // “更早的 N 步”的 N 不变：被收起的始终是同一批。
    expect(older()?.textContent).toContain("40");
    // 原先屏幕上的那 60 行就是同一批节点（key 稳定，没有重建）。
    rows()
      .slice(0, GROUP_WINDOW)
      .forEach((node, i) => expect(node).toBe(before[i]));

    // 再来几批仍然冻结。
    render(steps(131), false);
    render(steps(160), false);
    expect(titles()[0]).toBe("step-40");
    expect(rows()).toHaveLength(GROUP_WINDOW + 60);
  });

  it("回到底部后恢复正常窗口化：只留最近的 GROUP_WINDOW 步，起点追上来", () => {
    render(steps(100), true);
    render(steps(100), false);
    render(steps(130), false);
    expect(rows()).toHaveLength(GROUP_WINDOW + 30);

    render(steps(130), true);
    expect(rows()).toHaveLength(GROUP_WINDOW);
    expect(titles()[0]).toBe("step-70");
    expect(older()?.textContent).toContain("70");

    // 恢复之后又是逐条前移。
    render(steps(131), true);
    expect(titles()[0]).toBe("step-71");
  });

  it("冻结的起点是屏幕上此刻实际的起点：“离开底部”与一批新步骤在同一次渲染里到来，也不会位移", () => {
    render(steps(100), true);
    expect(titles()[0]).toBe("step-40");

    render(steps(130), false);
    expect(titles()[0]).toBe("step-40");
    expect(rows()).toHaveLength(GROUP_WINDOW + 30);
  });

  it("冻结期间点“显示更早的”：起点只会更早，之后新来的步骤不会又把刚展开的行收回去", () => {
    render(steps(400), true);
    expect(rows()).toHaveLength(GROUP_WINDOW);
    render(steps(400), false);

    act(() => older()?.click());
    expect(titles()[0]).toBe("step-140");
    expect(rows()).toHaveLength(260);

    render(steps(440), false);
    expect(titles()[0]).toBe("step-140");
    expect(rows()).toHaveLength(300);
  });

  it("冻结期间窗口最多比正常窗口长出 FROZEN_WINDOW_EXTRA 行，超过之后起点才继续前移", () => {
    render(steps(100), true);
    render(steps(100), false);

    const total = 100 + FROZEN_WINDOW_EXTRA + 50;
    render(steps(total), false);
    expect(rows()).toHaveLength(GROUP_WINDOW + FROZEN_WINDOW_EXTRA);
    expect(titles()[0]).toBe(`step-${total - GROUP_WINDOW - FROZEN_WINDOW_EXTRA}`);
    expect(titles().at(-1)).toBe(`step-${total - 1}`);
  });

  it("一开始就不贴底时挂载的长组（例如展开“更早的行”时露出来的）仍按正常窗口渲染，不会一次铺开", () => {
    render(steps(140), false);
    expect(rows()).toHaveLength(GROUP_WINDOW);
    expect(titles()[0]).toBe("step-80");
  });

  it("不传 following 时按贴底处理（窗口跟着尾部滑动）", () => {
    act(() => view.root.render(<WorkGroup items={steps(100)} live expandAll={false} />));
    expect(titles()[0]).toBe("step-40");
    act(() => view.root.render(<WorkGroup items={steps(120)} live expandAll={false} />));
    expect(titles()[0]).toBe("step-60");
  });

  it("工作组收起时也不影响冻结：展开之后看到的仍是离开时的那个起点", () => {
    vi.useFakeTimers();
    const toggle = (): void => act(() => view.host.querySelector<HTMLButtonElement>(".work-head")?.click());
    render(steps(100), true);
    render(steps(100), false);
    toggle();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(rows()).toHaveLength(0);

    render(steps(130), false);
    toggle();
    expect(titles()[0]).toBe("step-40");
    expect(rows()).toHaveLength(GROUP_WINDOW + 30);
  });
});
