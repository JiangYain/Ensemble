import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HandoffNoResult, HandoffSample, SessionContextItem } from "@shared/handoff";
import { replay, toSummary } from "@shared/projection";
import { EventLog } from "@shared/testing";
import type { ContextItem } from "@shared/types";
import { setLang, store } from "../lib/app";
import { archiveUi } from "../lib/archive";
import { archivedSummary, stubApi, summary } from "../lib/archive.fixtures";
import { dateTime } from "../lib/text";
import { ContextRef } from "./ContextRef";
import { TaskPanel } from "./Panels";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 聚焦页“传入的上下文”里的会话引用：画的全是派发那一刻冻结的事实与当时交出去的原文，不回头读上游；
 * 唯一实时的是标题能不能点（上游还在 → 链接；已经不在 → 文字加一句说明，冻结的内容照旧）。
 * 上游去向由 useUpstream 判断（未归档表、已归档表、后台补读已归档列表），这里一并覆盖。
 */

const UP = "ses_up";
const AT = "2026-03-04T05:06:07.000Z";
const ANSWER = "Parser fixed.\nAll tests pass.";
const BLOCK = `### Session ${UP}: Fix the parser\n\n#### Result (final answer of run 1 of 1)\n\`\`\`text\n${ANSWER}\n\`\`\``;
const LEAD = "Review the fix\n\n";
const PROMPT = `${LEAD}${BLOCK}\n\nPlease be strict.`;

function sampleOf(patch: Partial<HandoffSample> = {}): HandoffSample {
  return {
    at: AT,
    title: "Fix the parser",
    harness: "codex",
    model: "gpt-x",
    phase: "done",
    runCount: 1,
    result: { found: true, label: "final", runIndex: 1, chars: ANSWER.length, sentChars: ANSWER.length },
    block: { start: LEAD.length, end: LEAD.length + BLOCK.length },
    ...patch,
  };
}

const refOf = (patch: Partial<SessionContextItem> = {}): SessionContextItem => ({ kind: "session", sessionId: UP, include: ["result"], sample: sampleOf(), ...patch });

/** 老数据：派发时没有留下取样记录。 */
const NO_SAMPLE: SessionContextItem = { kind: "session", sessionId: UP, include: ["result"] };

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("ContextRef", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const previous = store.get();

  beforeEach(() => {
    setLang("zh");
    store.set({ ready: true, sessions: {}, archived: {}, archivedLoaded: false, archivedCount: 0 });
    archiveUi.set({ list: { status: "idle" }, busy: 0 });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    store.set(previous);
    archiveUi.set({ list: { status: "idle" }, busy: 0 });
  });

  const mount = (item: SessionContextItem, prompt = PROMPT): void => {
    act(() => root.render(<ul><ContextRef item={item} prompt={prompt} /></ul>));
  };
  const card = (): HTMLElement => host.querySelector<HTMLElement>("li.cref")!;
  const link = (): HTMLAnchorElement | null => host.querySelector<HTMLAnchorElement>("a.cref-title");
  const plainTitle = (): HTMLElement | null => host.querySelector<HTMLElement>("span.cref-title");
  const toggle = (): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>("button.cref-toggle");
  const gone = (): string | undefined => host.querySelector(".cref-gone")?.textContent ?? undefined;
  const rows = (): { label: string | null | undefined; main: string | null | undefined; notes: (string | null)[] }[] =>
    [...host.querySelectorAll<HTMLElement>(".kvs .kv")].map((row) => ({
      label: row.querySelector("dt")?.textContent,
      main: row.querySelector("dd > span")?.textContent,
      notes: [...row.querySelectorAll(".kv-sub")].map((note) => note.textContent),
    }));

  describe("上游还在", () => {
    it("标题是指向上游的链接，用它现在的名字；是原生链接（Tab 能到、Enter 能点），带读屏名称，没有“已不在”的说明", () => {
      store.set({ sessions: { [UP]: summary(UP, { title: "Fix the parser v2" }) } });
      mount(refOf());

      expect(card().getAttribute("data-state")).toBe("found");
      const anchor = link()!;
      expect(anchor.getAttribute("href")).toBe("#/s/ses_up");
      expect(anchor.textContent).toBe("Fix the parser v2");
      expect(anchor.getAttribute("aria-label")).toBe("打开被引用的会话：Fix the parser v2");
      expect(anchor.getAttribute("data-tip")).toBe(UP);
      expect(anchor.hasAttribute("tabindex")).toBe(false);
      expect(plainTitle()).toBeNull();
      expect(gone()).toBeUndefined();
    });

    it("会话编号里有特殊字符时，链接按路由规则编码", () => {
      const odd = "ses/odd id";
      store.set({ sessions: { [odd]: summary(odd, { title: "Odd" }) } });
      mount(refOf({ sessionId: odd, sample: sampleOf({ title: "Odd", block: undefined }) }));

      expect(link()?.getAttribute("href")).toBe("#/s/ses%2Fodd%20id");
    });

    it("来历一行：执行端、模型、交接时的状态、读取时刻；状态是当时的，不随上游现在的状态变", () => {
      store.set({ sessions: { [UP]: summary(UP, { phase: "running" }) } });
      mount(refOf());

      expect([...host.querySelectorAll(".cref-sub > *")].map((part) => part.textContent)).toEqual(["Codex", "gpt-x", "交接时：已完成", `读取于 ${dateTime(AT, "zh")}`]);
      expect(host.querySelector(".cref-phase .status-dot")?.getAttribute("data-phase")).toBe("done");
      expect(host.querySelector(".cref-phase .status-dot")?.getAttribute("aria-hidden")).toBe("true");
    });

    it("上游在已归档表里也算还在：同样是链接", () => {
      store.set({ archived: { [UP]: archivedSummary(UP, { title: "Archived title" }) } });
      mount(refOf());

      expect(card().getAttribute("data-state")).toBe("found");
      expect(link()?.textContent).toBe("Archived title");
    });
  });

  describe("取到了什么", () => {
    it("三样都取：结果、文件、错误各一行，主文字加补充（取自第几次运行、被跳过的更新运行、没标 final、被截断……）", () => {
      store.set({ sessions: { [UP]: summary(UP) } });
      mount(
        refOf({
          include: ["result", "files", "error"],
          sample: sampleOf({
            runCount: 2,
            result: { found: true, label: "unlabeled", runIndex: 1, chars: 50_000, sentChars: 40_000, latest: { runIndex: 2, status: "failed" } },
            files: { total: 203, sent: 200 },
            error: { found: true, code: "executor_exit", runIndex: 2, truncated: true },
          }),
        }),
      );

      expect(rows()).toEqual([
        {
          label: "结果",
          main: "40000 个字符",
          notes: ["取自第 1 次运行（共 2 次）", "更新的第 2 次运行没有产出", "执行端没有把它标为最终回答", "只交了前 40000 个字符（原文共 50000 个）"],
        },
        { label: "改动文件", main: "200 个路径", notes: ["只列出前 200 个（共 203 个）"] },
        { label: "最后的错误", main: "executor_exit，第 2 次运行", notes: ["错误消息被截断"] },
      ]);
    });

    it("没有改动文件、没有失败：照实写“没有上报文件改动”“没有失败记录”；会话级的失败写“（会话级）”", () => {
      store.set({ sessions: { [UP]: summary(UP) } });
      mount(refOf({ include: ["files", "error"], sample: sampleOf({ result: undefined, files: { total: 0, sent: 0 }, error: { found: false } }) }));
      expect(rows()).toEqual([
        { label: "改动文件", main: "没有上报文件改动", notes: [] },
        { label: "最后的错误", main: "没有失败记录", notes: [] },
      ]);

      mount(refOf({ include: ["error"], sample: sampleOf({ result: undefined, error: { found: true, code: "spawn_failed" } }) }));
      expect(rows()).toEqual([{ label: "最后的错误", main: "spawn_failed（会话级）", notes: [] }]);
    });

    it.each([
      ["no_runs", "这个会话没有任何运行"],
      ["no_text", "它的运行里没有任何助手文字"],
      ["no_final", "它写的文字都被标成过程说明，没有最终回答"],
    ] as [HandoffNoResult, string][])("取不到结果（%s）：写“没有可取的结果”和原因，不留空", (reason, why) => {
      store.set({ sessions: { [UP]: summary(UP) } });
      mount(refOf({ sample: sampleOf({ result: { found: false, reason } }) }));

      expect(rows()).toEqual([{ label: "结果", main: "没有可取的结果", notes: [why] }]);
    });

    it("发起端写的说明（note）单独一行，原样显示", () => {
      store.set({ sessions: { [UP]: summary(UP) } });
      mount(refOf({ note: "Review this\nand be strict" }));

      const note = rows().find((row) => row.label === "说明");
      expect(note?.main).toBe("Review this\nand be strict");
    });

    it("没有取样记录的老数据：不编造当时拿到了什么——没有事实行、没有来历行、没有展开按钮，只说没有记录", () => {
      store.set({ sessions: { [UP]: summary(UP, { title: "Live title" }) } });
      mount(NO_SAMPLE);

      expect(host.querySelector("p.muted")?.textContent).toBe("没有记录当时交接了什么。");
      expect(rows()).toEqual([]);
      expect(host.querySelector(".cref-sub")).toBeNull();
      expect(toggle()).toBeNull();
      // 上游还在，标题仍然可点。
      expect(link()?.textContent).toBe("Live title");
    });
  });

  describe("当时交出去的原文", () => {
    it("默认收起、不渲染；展开后是提示里那一块的原文，逐字不差；再点一下收起", () => {
      store.set({ sessions: { [UP]: summary(UP) } });
      mount(refOf());

      const button = toggle()!;
      expect(button.textContent).toBe("交接的原文");
      expect(button.getAttribute("type")).toBe("button");
      expect(button.getAttribute("aria-expanded")).toBe("false");
      const body = document.getElementById(button.getAttribute("aria-controls")!)!;
      expect(body.hasAttribute("hidden")).toBe(true);
      expect(host.querySelector(".preview")).toBeNull();

      act(() => button.click());
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(body.hasAttribute("hidden")).toBe(false);
      expect(body.querySelector(".preview pre code")?.textContent).toBe(BLOCK);

      act(() => button.click());
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(body.hasAttribute("hidden")).toBe(true);
      expect(host.querySelector(".preview")).toBeNull();
    });

    it("区间对不上（提示被改过、记录损坏）：说“找不到”，不展示一段错位的文字", () => {
      store.set({ sessions: { [UP]: summary(UP) } });
      mount(refOf({ sample: sampleOf({ block: { start: 0, end: 10 } }) }));

      act(() => toggle()!.click());
      expect(host.querySelector(".preview")).toBeNull();
      const body = document.getElementById(toggle()!.getAttribute("aria-controls")!)!;
      expect(body.querySelector("p.muted")?.textContent).toBe("在已保存的提示里找不到这份交接的原文。");
    });

    it("记录里没有区间：同样说“找不到”", () => {
      store.set({ sessions: { [UP]: summary(UP) } });
      mount(refOf({ sample: sampleOf({ block: undefined }) }));

      act(() => toggle()!.click());
      expect(host.querySelector(".preview")).toBeNull();
      expect(document.getElementById(toggle()!.getAttribute("aria-controls")!)?.textContent).toBe("在已保存的提示里找不到这份交接的原文。");
    });
  });

  describe("上游已经不在", () => {
    it("标题只剩文字（取交接时记下的）并说明无法打开；冻结的事实与原文照旧可看", () => {
      // 两张表都是空的、第一份快照已收到、也没有已归档的会话：上游已被删除。
      mount(refOf());

      expect(card().getAttribute("data-state")).toBe("gone");
      expect(link()).toBeNull();
      expect(plainTitle()?.textContent).toBe("Fix the parser");
      expect(gone()).toBe("这个会话已不在 Ensemble 里，无法再打开；下面是当时交接出去的内容。");
      // 说明是文字，不是靠颜色表达的状态；标题不再有读屏名称（它不是控件了）。
      expect(plainTitle()?.hasAttribute("aria-label")).toBe(false);
      expect(rows()).toEqual([{ label: "结果", main: "29 个字符", notes: ["取自第 1 次运行（共 1 次）"] }]);

      act(() => toggle()!.click());
      expect(host.querySelector(".preview pre code")?.textContent).toBe(BLOCK);
    });

    it("连取样记录也没有：标题退回会话编号，说明与“没有记录”都写出来", () => {
      mount(NO_SAMPLE);

      expect(plainTitle()?.textContent).toBe(UP);
      expect(gone()).toBeDefined();
      expect(host.querySelector("p.muted")?.textContent).toBe("没有记录当时交接了什么。");
    });
  });

  describe("还不能下结论", () => {
    it("还没收到第一份快照：先当它在、标题可点，不说“已不在”（免得刷新的一瞬间闪出错误的说明）", () => {
      store.set({ ready: false });
      mount(refOf());

      expect(card().getAttribute("data-state")).toBe("checking");
      // 上游的现名还不知道，用交接时记下的标题。
      expect(link()?.textContent).toBe("Fix the parser");
      expect(gone()).toBeUndefined();
    });

    it("有已归档的会话而列表还没读全：先是“检查中”，后台读一遍；读回来认得它，标题用它的名字", async () => {
      store.set({ archivedCount: 1, archivedLoaded: false });
      const calls = stubApi(() => ({ body: { sessions: [archivedSummary(UP, { title: "Archived title" })] } }));
      mount(refOf());
      expect(card().getAttribute("data-state")).toBe("checking");
      expect(gone()).toBeUndefined();

      await act(async () => {
        await settle();
      });

      expect(calls).toEqual([{ method: "GET", path: "/api/sessions?archived=only" }]);
      expect(card().getAttribute("data-state")).toBe("found");
      expect(link()?.textContent).toBe("Archived title");
      expect(gone()).toBeUndefined();
    });

    it("已归档的列表读全了仍没有它：这才下结论，说已不在", async () => {
      store.set({ archivedCount: 1, archivedLoaded: false });
      stubApi(() => ({ body: { sessions: [archivedSummary("ses_other")] } }));
      mount(refOf());
      expect(card().getAttribute("data-state")).toBe("checking");

      await act(async () => {
        await settle();
      });

      expect(card().getAttribute("data-state")).toBe("gone");
      expect(link()).toBeNull();
      expect(gone()).toBeDefined();
    });

    it("已归档列表读不到：不打扰，不下结论（一直是“检查中”，标题仍可点）", async () => {
      store.set({ archivedCount: 1, archivedLoaded: false });
      stubApi(() => ({ status: 500, body: { error: { code: "internal", message: "boom" } } }));
      mount(refOf());

      await act(async () => {
        await settle();
      });

      expect(card().getAttribute("data-state")).toBe("checking");
      expect(link()).not.toBeNull();
      expect(gone()).toBeUndefined();
    });
  });

  it("英文界面：同样的结构，措辞用英文（单复数按数量）", () => {
    setLang("en");
    store.set({ sessions: { [UP]: summary(UP, { title: "Fix the parser v2" }) } });
    mount(refOf({ include: ["result", "files"], sample: sampleOf({ files: { total: 1, sent: 1 } }) }));

    expect(link()?.getAttribute("aria-label")).toBe("Open the referenced session: Fix the parser v2");
    expect([...host.querySelectorAll(".cref-sub > *")].map((part) => part.textContent).slice(0, 3)).toEqual(["Codex", "gpt-x", "Done at handover"]);
    expect(rows()).toEqual([
      { label: "Result", main: "29 characters", notes: ["From run 1 of 1"] },
      { label: "Files", main: "1 path", notes: [] },
    ]);
    expect(toggle()?.textContent).toBe("Handed-over text");
  });
});

describe("TaskPanel：传入的上下文里的会话引用", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const previous = store.get();

  beforeEach(() => {
    setLang("zh");
    store.set({ ready: true, sessions: { [UP]: summary(UP, { title: "Fix the parser v2" }) }, archived: {}, archivedLoaded: false, archivedCount: 0 });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    store.set(previous);
  });

  function panel(context: ContextItem[]): void {
    const log = new EventLog("ses_down");
    log.created({ harness: "pi", task: { text: "Review the fix", context, prompt: PROMPT } });
    const state = replay(log.events);
    if (!state) throw new Error("missing session state");
    act(() => root.render(<TaskPanel state={state} summary={toSummary(state)} />));
  }

  it("会话引用与别的条目并列、按原来的顺序；展开的原文取自这个会话自己的完整提示", () => {
    panel([{ kind: "text", title: "Background", text: "The parser is in src/parser.ts" }, refOf()]);

    const items = [...host.querySelectorAll<HTMLElement>(".ctx-list > li")];
    expect(items).toHaveLength(2);
    expect(items[0]?.classList.contains("cref")).toBe(false);
    expect(items[0]?.textContent).toContain("Background");
    expect(items[1]?.classList.contains("cref")).toBe(true);
    expect(items[1]?.querySelector("a.cref-title")?.getAttribute("href")).toBe("#/s/ses_up");

    act(() => items[1]!.querySelector<HTMLButtonElement>("button.cref-toggle")!.click());
    expect(items[1]?.querySelector(".preview pre code")?.textContent).toBe(BLOCK);
  });

  it("不认识的条目类型（更新的版本写下的记录）：不画这一项，也不抛错；认识的照常画", () => {
    panel([{ kind: "audio", url: "x" } as unknown as ContextItem, refOf()]);

    expect(host.querySelectorAll(".ctx-list > li")).toHaveLength(1);
    expect(host.querySelector(".ctx-list > li.cref")).not.toBeNull();
  });
});
