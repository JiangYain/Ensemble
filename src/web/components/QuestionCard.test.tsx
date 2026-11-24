import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { replay, toSummary } from "@shared/projection";
import type { QuestionResolvedResponse } from "@shared/protocol";
import { SYSTEM_ACTOR, type QuestionPrompt, type QuestionResolution } from "@shared/questions";
import { EventLog, USER } from "@shared/testing";
import type { Actor, QuestionItem, SessionSummary } from "@shared/types";
import { ApiError, api } from "../lib/api";
import { setLang, store } from "../lib/app";
import { QuestionCard } from "./QuestionCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SES = "ses_t";
const RUN = "run_1";

// ───────────────────────── 夹具 ─────────────────────────

const SINGLE: QuestionPrompt = {
  key: "scope",
  header: "Scope",
  text: "Which package should I update?",
  options: [{ label: "core" }, { label: "web", description: "the UI" }],
  multiple: false,
  custom: true,
};
const MULTI: QuestionPrompt = {
  key: "targets",
  text: "Which targets should the build cover?",
  options: [{ label: "linux" }, { label: "mac" }, { label: "win" }],
  multiple: true,
  custom: true,
};
const CLOSED: QuestionPrompt = {
  key: "mode",
  text: "Which mode?",
  options: [{ label: "fast" }, { label: "safe" }],
  multiple: false,
  custom: false,
};
const FREE: QuestionPrompt = { key: "note", text: "Which database should the service use?", multiple: false, custom: true };

let counter = 0;
/** 每个用例用自己的提问编号：卡片在模块里记着填到一半的草稿，编号相同会串到下一个用例。 */
const nextId = (): string => `qst_card${++counter}`;

interface World {
  id: string;
  item: QuestionItem;
  summary: SessionSummary;
}

/** 用真实的事件序列与投影得到提问条目（与服务端、页面其余部分看到的同一形状），而不是手写对象。 */
function world(prompts: QuestionPrompt[], settle?: (log: EventLog, id: string) => void, id = nextId()): World {
  const log = new EventLog(SES);
  log.created({ harness: "codex" });
  const message = log.message("msg_1", "task", "做点什么");
  log.run(RUN, 1, message.id);
  log.startRun(RUN);
  log.ask(id, prompts, RUN);
  settle?.(log, id);
  const state = replay(log.events);
  if (!state) throw new Error("replay produced no state");
  const item = state.timeline.find((entry): entry is QuestionItem => entry.type === "question");
  if (!item) throw new Error("no question item");
  return { id, item, summary: toSummary(state) };
}

const resolve =
  (resolution: Omit<QuestionResolution, "questionId">) =>
  (log: EventLog, id: string): void => {
    log.settle({ questionId: id, ...resolution }, RUN);
  };

const answeredBy = (by: Actor, answers: string[][]) => resolve({ outcome: "answered", by, answers, delivery: "handed_off" });
const expiredBy = (reason: NonNullable<QuestionResolution["reason"]>, delivery?: QuestionResolution["delivery"]) =>
  resolve({ outcome: "expired", by: SYSTEM_ACTOR, reason, ...(delivery ? { delivery } : {}) });

/** 服务端在回答 / 不回答生效之后回给 HTTP 调用方的回执，取自“同一个提问有了结局”的世界。 */
function receipt({ id, item, summary }: World): QuestionResolvedResponse {
  if (item.status === "open" || !item.outcome) throw new Error("the question is not settled in this world");
  return { questionId: id, status: item.status, outcome: item.outcome, summary };
}

/** 让已经就绪的 Promise 链都跑完。 */
const tick = (): Promise<void> => new Promise((resolveTick) => setTimeout(resolveTick, 0));

interface Held {
  kind: "answer" | "decline";
  resolve(response: QuestionResolvedResponse): void;
  reject(error: Error): void;
}

// ───────────────────────── 测试 ─────────────────────────

describe("提问卡片（QuestionCard）", () => {
  let host: HTMLDivElement;
  let root: Root;
  let answerSpy: MockInstance<typeof api.answerQuestion>;
  let declineSpy: MockInstance<typeof api.declineQuestion>;
  let held: Held[];
  const previous = store.get();

  beforeEach(() => {
    setLang("zh");
    // 所有请求都不碰真实的 fetch：回执由 reply / fail 决定，挂着不动时就是“发送中”。
    held = [];
    answerSpy = vi.spyOn(api, "answerQuestion").mockImplementation(
      () => new Promise<QuestionResolvedResponse>((resolvePromise, reject) => void held.push({ kind: "answer", resolve: resolvePromise, reject })),
    );
    declineSpy = vi.spyOn(api, "declineQuestion").mockImplementation(
      () => new Promise<QuestionResolvedResponse>((resolvePromise, reject) => void held.push({ kind: "decline", resolve: resolvePromise, reject })),
    );
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    store.set({ lang: previous.lang, sessions: previous.sessions });
    vi.restoreAllMocks();
  });

  // ───────────── 操作 ─────────────

  /** 与时间线一致：行以条目编号为 key，换成另一个提问就是换一张卡片（重新挂载），同一个提问更新则原位变化。 */
  const render = (item: QuestionItem, enter = false): void => {
    act(() => {
      root.render(<QuestionCard key={item.id} item={item} sessionId={SES} enter={enter} />);
    });
  };

  const click = (element: Element | null | undefined): void => void act(() => (element as HTMLElement).click());

  const reply = (index: number, response: QuestionResolvedResponse): Promise<void> =>
    act(async () => {
      held[index]!.resolve(response);
      await tick();
    });

  const fail = (index: number, error: Error): Promise<void> =>
    act(async () => {
      held[index]!.reject(error);
      await tick();
    });

  /** 在输入框 / 文本框里写字（React 受控输入要走原型上的 setter，否则它认不出这次变化）。 */
  const type = (field: HTMLInputElement | HTMLTextAreaElement, text: string): void =>
    void act(() => {
      const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, text);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });

  const press = (target: Element, key: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    // 有的环境不认 KeyboardEventInit 里的 isComposing：补上，免得“组字期间”的用例空转。
    if (init.isComposing !== undefined && event.isComposing !== init.isComposing) Object.defineProperty(event, "isComposing", { value: init.isComposing });
    act(() => void target.dispatchEvent(event));
    return event;
  };

  // ───────────── 查询 ─────────────

  const card = (): HTMLElement => host.querySelector<HTMLElement>("section.question")!;
  const answerButton = (): HTMLButtonElement => host.querySelector<HTMLButtonElement>(".q-answer-btn")!;
  const declineButton = (): HTMLButtonElement => host.querySelector<HTMLButtonElement>(".q-decline-btn")!;
  const statusRow = (): HTMLElement => host.querySelector<HTMLElement>(".q-status")!;
  const alertText = (): string | undefined => host.querySelector('[role="alert"]')?.textContent ?? undefined;
  const otherInput = (): HTMLInputElement => host.querySelector<HTMLInputElement>("input.q-input")!;
  const textarea = (): HTMLTextAreaElement => host.querySelector<HTMLTextAreaElement>("textarea.q-input--area")!;
  const texts = (selector: string): string[] => [...host.querySelectorAll(selector)].map((element) => element.textContent ?? "");
  /** 选项行（不含“其他”）里标签为 label 的那个输入。 */
  const optionInput = (label: string): HTMLInputElement => {
    const row = [...host.querySelectorAll<HTMLLabelElement>("label.q-opt")].find((candidate) => candidate.querySelector(".q-opt-label")?.textContent === label);
    if (!row) throw new Error(`no option "${label}"`);
    return row.querySelector<HTMLInputElement>("input")!;
  };
  const pick = (label: string): void => click(optionInput(label));
  const checkedLabels = (): string[] => texts(".q-opt[data-checked] .q-opt-label");
  const controls = (): Array<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement> => [...host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>("input, textarea, button")];

  // ───────────────────────── 待回答 ─────────────────────────

  describe("待回答", () => {
    it("单选：问题、标题与可选项逐字呈现；没有回答前“回答”不可用并说明原因，“不回答”随时可用", () => {
      render(world([SINGLE]).item);
      const section = card();
      expect(section.getAttribute("role")).toBe("group");
      expect(section.getAttribute("aria-label")).toBe("执行端的提问");
      expect(section.getAttribute("data-status")).toBe("open");
      expect(host.querySelector(".q-title")?.textContent).toBe("提问");
      expect(host.querySelector(".q-state")?.textContent).toBe("待回答");
      expect(host.querySelector(".q-header")?.textContent).toBe("Scope");
      expect(host.querySelector(".q-index")).toBeNull();
      expect(host.querySelector(".q-text")?.textContent).toBe("Which package should I update?");
      expect(host.querySelector(".q-hint")?.textContent).toBe("选一项");
      expect(texts(".q-opt-label")).toEqual(["core", "web", "其他"]);
      expect(texts(".q-opt-desc")).toEqual(["the UI"]);
      expect(checkedLabels()).toEqual([]);

      expect(answerButton().disabled).toBe(true);
      expect(answerButton().getAttribute("data-tip")).toBe("每个问题都要有回答，或者选择不回答");
      expect(declineButton().disabled).toBe(false);
      expect(declineButton().textContent).toBe("不回答，让它自行判断");
    });

    it("选项是真正的单选框，同属一个按问题文字命名的单选组；多选是复选框", () => {
      render(world([SINGLE]).item);
      const group = host.querySelector(".q-options");
      expect(group?.getAttribute("role")).toBe("radiogroup");
      expect(group?.getAttribute("aria-labelledby")).toBe(host.querySelector(".q-text")?.id);
      const radios = [...host.querySelectorAll<HTMLInputElement>(".q-options input[type=radio]")];
      expect(radios).toHaveLength(3);
      expect(new Set(radios.map((radio) => radio.name)).size).toBe(1);

      render(world([MULTI]).item);
      expect(host.querySelector(".q-options")?.getAttribute("role")).toBe("group");
      expect(host.querySelectorAll(".q-options input[type=checkbox]")).toHaveLength(4);
      expect(host.querySelector(".q-hint")?.textContent).toBe("可多选");
    });

    it("不允许自己写答案的问题没有“其他”", () => {
      render(world([CLOSED]).item);
      expect(texts(".q-opt-label")).toEqual(["fast", "safe"]);
      expect(host.querySelector("input.q-input")).toBeNull();
    });

    it("状态行是一块有 aria-live 的固定区域；错误才用 role=alert", () => {
      render(world([SINGLE]).item);
      expect(statusRow().getAttribute("aria-live")).toBe("polite");
      expect(host.querySelector('[role="alert"]')).toBeNull();
    });

    it("刚出现的卡片带淡入标记，已经在的不带", () => {
      render(world([SINGLE]).item, true);
      expect(card().hasAttribute("data-enter")).toBe(true);
      render(world([SINGLE]).item, false);
      expect(card().hasAttribute("data-enter")).toBe(false);
    });

    it("英文界面：同一套结构，文案换成英文", () => {
      setLang("en");
      render(world([SINGLE]).item);
      expect(host.querySelector(".q-title")?.textContent).toBe("Question");
      expect(host.querySelector(".q-state")?.textContent).toBe("Awaiting an answer");
      expect(host.querySelector(".q-hint")?.textContent).toBe("Pick one");
      expect(answerButton().textContent).toBe("Answer");
      expect(declineButton().textContent).toBe("Don't answer — let it use its own judgment");
    });
  });

  // ───────────────────────── 回答 ─────────────────────────

  describe("回答", () => {
    it("选一项后回答：请求体是所选标签；发送中按钮与状态行都不换元素、不改文字；回执到了原位变成只读记录", async () => {
      const open = world([SINGLE]);
      const done = world([SINGLE], answeredBy(USER, [["web"]]), open.id);
      render(open.item);

      pick("web");
      expect(checkedLabels()).toEqual(["web"]);
      const button = answerButton();
      const row = statusRow();
      expect(button.disabled).toBe(false);
      expect(button.hasAttribute("data-tip")).toBe(false);

      click(button);
      expect(answerSpy).toHaveBeenCalledTimes(1);
      expect(answerSpy).toHaveBeenCalledWith(SES, open.id, { answers: [["web"]] });
      // 发送中：同一批元素，只有可用性与状态行里的字变了。
      expect(answerButton()).toBe(button);
      expect(statusRow()).toBe(row);
      expect(button.disabled).toBe(true);
      expect(button.getAttribute("aria-busy")).toBe("true");
      expect(button.textContent).toBe("回答");
      expect(declineButton().disabled).toBe(true);
      expect(controls().filter((control) => control instanceof HTMLInputElement).every((control) => control.disabled)).toBe(true);
      expect(row.textContent).toContain("正在交给执行端");

      await reply(0, receipt(done));
      expect(card().getAttribute("data-status")).toBe("answered");
      expect(host.querySelector(".q-state")?.textContent).toBe("已回答");
      expect(texts(".q-pick")).toEqual(["web"]);
      expect(host.querySelector(".q-who")?.textContent).toBe("你");
      expect(host.querySelector(".q-result")?.textContent).toBe("已交给执行端");
      expect(host.querySelector(".q-result")?.getAttribute("data-tip")).toContain("无法确认");
      expect(host.querySelector(".q-meta time")?.getAttribute("datetime")).toBe(done.item.outcome?.at);
      // 只读：没有任何输入或按钮。
      expect(host.querySelector("input, textarea, .q-answer-btn, .q-decline-btn")).toBeNull();
      // 回执里的摘要立刻进了页面的会话表（待回答数随之归零，不等事件）。
      expect(store.get().sessions[SES]?.id).toBe(SES);
      expect(store.get().sessions[SES]?.openQuestions).toBeUndefined();
    });

    it("单行输入里写字等于选了“其他”；Enter 直接提交", () => {
      const { item, id } = world([SINGLE]);
      render(item);
      pick("core");
      type(otherInput(), "  something else  ");
      expect(checkedLabels()).toEqual(["其他"]);
      expect(answerButton().disabled).toBe(false);
      const event = press(otherInput(), "Enter");
      expect(event.defaultPrevented).toBe(true);
      expect(answerSpy).toHaveBeenCalledTimes(1);
      expect(answerSpy).toHaveBeenCalledWith(SES, id, { answers: [["something else"]] });
    });

    it("输入法组字期间的 Enter 是选词，不提交；Shift+Enter 也不提交", () => {
      render(world([SINGLE]).item);
      type(otherInput(), "候选");
      press(otherInput(), "Enter", { isComposing: true });
      press(otherInput(), "Enter", { shiftKey: true });
      expect(answerSpy).not.toHaveBeenCalled();
    });

    it("多选问题：答案按可选项顺序排列，自己写的放最后", () => {
      const { item, id } = world([MULTI]);
      render(item);
      pick("win");
      pick("linux");
      type(otherInput(), "bsd");
      expect(checkedLabels()).toEqual(["linux", "win", "其他"]);
      click(answerButton());
      expect(answerSpy).toHaveBeenCalledWith(SES, id, { answers: [["linux", "win", "bsd"]] });
    });

    it("没有可选项的问题是一个文本框：Enter 只换行，Ctrl / ⌘ + Enter 才提交；只有空白不能提交", () => {
      const { item, id } = world([FREE]);
      render(item);
      expect(textarea().getAttribute("placeholder")).toBe("写下你的回答");
      expect(host.querySelector(".q-opt")).toBeNull();
      expect(textarea().getAttribute("aria-labelledby")).toBe(host.querySelector(".q-text")?.id);

      type(textarea(), "   ");
      expect(answerButton().disabled).toBe(true);
      press(textarea(), "Enter", { ctrlKey: true });
      expect(answerSpy).not.toHaveBeenCalled();

      type(textarea(), "Use PostgreSQL");
      expect(answerButton().disabled).toBe(false);
      expect(press(textarea(), "Enter").defaultPrevented).toBe(false);
      expect(answerSpy).not.toHaveBeenCalled();

      expect(press(textarea(), "Enter", { metaKey: true }).defaultPrevented).toBe(true);
      expect(answerSpy).toHaveBeenCalledTimes(1);
      expect(answerSpy).toHaveBeenCalledWith(SES, id, { answers: [["Use PostgreSQL"]] });
    });

    it("一次提了多个问题：标序号；每个问题都有回答才能提交，请求体一问一项", () => {
      const { item, id } = world([SINGLE, FREE]);
      render(item);
      expect(texts(".q-index")).toEqual(["1 / 2", "2 / 2"]);
      expect(host.querySelectorAll(".q-prompt")).toHaveLength(2);

      pick("core");
      expect(answerButton().disabled).toBe(true);
      type(textarea(), "ok");
      expect(answerButton().disabled).toBe(false);
      click(answerButton());
      expect(answerSpy).toHaveBeenCalledWith(SES, id, { answers: [["core"], ["ok"]] });
    });

    it("请求在途时再点没有用：只发一次", () => {
      const { item } = world([SINGLE]);
      render(item);
      pick("core");
      click(answerButton());
      click(answerButton());
      click(declineButton());
      expect(answerSpy).toHaveBeenCalledTimes(1);
      expect(declineSpy).not.toHaveBeenCalled();
    });
  });

  // ───────────────────────── 不回答 ─────────────────────────

  describe("不回答", () => {
    it("请求不带任何回答内容；回执到了变成“不回答”的只读记录，写明附言与告知结果", async () => {
      const open = world([SINGLE]);
      const done = world([SINGLE], resolve({ outcome: "declined", by: USER, delivery: "handed_off", note: "Use your own judgment." }), open.id);
      render(open.item);

      click(declineButton());
      expect(declineSpy).toHaveBeenCalledTimes(1);
      expect(declineSpy).toHaveBeenCalledWith(SES, open.id);
      expect(answerSpy).not.toHaveBeenCalled();
      expect(declineButton().getAttribute("aria-busy")).toBe("true");
      expect(answerButton().disabled).toBe(true);

      await reply(0, receipt(done));
      expect(card().getAttribute("data-status")).toBe("declined");
      expect(host.querySelector(".q-state")?.textContent).toBe("不回答");
      expect(host.querySelector(".q-who")?.textContent).toBe("你");
      expect(host.querySelector(".q-result")?.textContent).toBe("已告知执行端自行判断");
      expect(host.querySelector(".q-note")?.textContent).toContain("Use your own judgment.");
      expect(host.querySelector(".q-picks")).toBeNull();
    });

    it("不回答不需要先填任何东西", () => {
      render(world([SINGLE, FREE]).item);
      expect(declineButton().disabled).toBe(false);
      click(declineButton());
      expect(declineSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ───────────────────────── 失败 ─────────────────────────

  describe("回答没有成功", () => {
    it("409：说清提问此刻的状态；卡片仍是待回答，已填的内容还在，按钮与状态行不挪位置", async () => {
      const { item, id } = world([SINGLE]);
      render(item);
      pick("web");
      const button = answerButton();
      const row = statusRow();
      click(button);
      await fail(0, new ApiError("conflict", "already answered", 409, { questionId: id, status: "answered" }));

      expect(card().getAttribute("data-status")).toBe("open");
      expect(alertText()).toBe("这个提问刚刚已被回答，页面马上会更新。");
      expect(answerButton()).toBe(button);
      expect(statusRow()).toBe(row);
      expect(button.disabled).toBe(false);
      expect(button.hasAttribute("aria-busy")).toBe(false);
      expect(button.textContent).toBe("回答");
      expect(checkedLabels()).toEqual(["web"]);

      // 再动一下，错误就收起来。
      pick("core");
      expect(alertText()).toBeUndefined();
    });

    it("409 的措辞按提问当时的状态：已回答 / 不回答 / 已过期（执行端不再等待）/ 另一处正在处理", async () => {
      const cases: Array<[string, string]> = [
        ["answered", "这个提问刚刚已被回答，页面马上会更新。"],
        ["declined", "这个提问刚刚已被选择不回答，页面马上会更新。"],
        ["expired", "执行端已不再等待这个提问，你的回复没有送达。"],
        ["open", "另一处正在处理这个提问，请稍候。"],
      ];
      for (const [status, expected] of cases) {
        const { item, id } = world([FREE]);
        render(item);
        type(textarea(), "x");
        click(answerButton());
        await fail(held.length - 1, new ApiError("conflict", "", 409, { questionId: id, status }));
        expect(alertText(), status).toBe(expected);
      }
    });

    it("其他错误走通用的错误文案；不回答失败同样如此", async () => {
      const { item } = world([SINGLE]);
      render(item);
      pick("core");
      click(answerButton());
      await fail(0, new ApiError("question_unsupported", "", 422));
      expect(alertText()).toBe("该执行端不接收对提问的回复");

      click(declineButton());
      await fail(1, new Error("network down"));
      expect(alertText()).toContain("network down");
      expect(card().getAttribute("data-status")).toBe("open");
      expect(answerButton().disabled).toBe(false);
      expect(declineButton().disabled).toBe(false);
    });

    it("请求在途时回答先由事件送到：卡片以事件为准，迟到的失败回执不再改写它，也不报错", async () => {
      const open = world([SINGLE]);
      const byAgent = world([SINGLE], answeredBy({ kind: "agent", label: "Cursor" }, [["core"]]), open.id);
      render(open.item);
      pick("web");
      click(answerButton());
      expect(answerSpy).toHaveBeenCalledTimes(1);

      render(byAgent.item);
      expect(card().getAttribute("data-status")).toBe("answered");
      expect(host.querySelector(".q-who")?.textContent).toBe("Cursor");
      expect(texts(".q-pick")).toEqual(["core"]);

      await fail(0, new ApiError("conflict", "", 409, { questionId: open.id, status: "answered" }));
      expect(card().getAttribute("data-status")).toBe("answered");
      expect(alertText()).toBeUndefined();
      expect(texts(".q-pick")).toEqual(["core"]);
    });
  });

  // ───────────────────────── 已有结局（只读） ─────────────────────────

  describe("已有结局的提问", () => {
    const noControls = (): void => {
      expect(host.querySelector("input, textarea, .q-answer-btn, .q-decline-btn")).toBeNull();
    };

    it("已回答：答案、署名、时刻与“已交给执行端”；自填的答案与可选项一样逐字显示", () => {
      const { item } = world([SINGLE, MULTI], answeredBy(USER, [["web"], ["linux", "my own target"]]));
      render(item);
      expect(card().getAttribute("data-status")).toBe("answered");
      expect(host.querySelector(".q-state")?.textContent).toBe("已回答");
      expect(texts(".q-pick")).toEqual(["web", "linux", "my own target"]);
      expect(host.querySelector(".q-who")?.textContent).toBe("你");
      expect(host.querySelector(".q-result")?.textContent).toBe("已交给执行端");
      expect(host.querySelector(".q-meta time")?.getAttribute("datetime")).toBe(item.outcome?.at);
      expect(host.querySelector(".q-note")).toBeNull();
      noControls();
    });

    it("主 Agent 回答的：署名是来源宿主给的名字，不冒充用户", () => {
      render(world([SINGLE], answeredBy({ kind: "agent", label: "Codex", originKey: "codex:thr_x" }, [["core"]])).item);
      expect(host.querySelector(".q-who")?.textContent).toBe("Codex");
      expect(host.querySelector(".q-meta")?.textContent).not.toContain("你");
    });

    it("回答没有记下“已交给执行端”时，不替它编造这一句", () => {
      render(world([SINGLE], resolve({ outcome: "answered", by: USER, answers: [["core"]] })).item);
      expect(host.querySelector(".q-result")).toBeNull();
    });

    it("过期：只写原因，不署名（不是任何人做的）", () => {
      render(world([SINGLE], expiredBy("run_ended")).item);
      expect(card().getAttribute("data-status")).toBe("expired");
      expect(host.querySelector(".q-state")?.textContent).toBe("已过期");
      expect(host.querySelector(".q-result")?.textContent).toBe("所属运行已结束，执行端不再等待");
      expect(host.querySelector(".q-who")).toBeNull();
      expect(host.querySelector(".q-picks")).toBeNull();
      noControls();
    });

    it("想回复时执行端已不再等待：写明回复没有送达，不装作成功", () => {
      render(world([SINGLE], expiredBy("not_waiting", "not_waiting")).item);
      expect(host.querySelector(".q-result")?.textContent).toBe("执行端已不再等待这个提问，回复没有送达");
      expect(host.querySelector(".q-result")?.textContent).not.toContain("已交给执行端");
    });

    it("时限到了：说明已告知执行端自行判断并继续", () => {
      render(world([SINGLE], expiredBy("timeout", "handed_off")).item);
      expect(host.querySelector(".q-result")?.textContent).toBe("时限内无人回答，已告知执行端自行判断并继续");
    });

    it("过期却没有记下原因（旧日志）：只说“已过期”，不编造解释", () => {
      render(world([SINGLE], resolve({ outcome: "expired", by: SYSTEM_ACTOR })).item);
      expect(host.querySelector(".q-state")?.textContent).toBe("已过期");
      expect(host.querySelector(".q-result")).toBeNull();
    });
  });

  // ───────────────────────── 草稿 ─────────────────────────

  describe("填到一半的回答", () => {
    it("卡片被卸载再挂上（切到别的会话再回来）：草稿还在", () => {
      const { item } = world([SINGLE, FREE]);
      render(item);
      pick("web");
      type(textarea(), "half way");

      act(() => root.render(null));
      expect(host.querySelector(".question")).toBeNull();

      render(item);
      expect(checkedLabels()).toEqual(["web"]);
      expect(textarea().value).toBe("half way");
      expect(answerButton().disabled).toBe(false);
    });

    it("不同的提问各有各的草稿，回到原来那个提问时它还在", () => {
      const first = world([FREE]);
      const second = world([FREE]);
      render(first.item);
      type(textarea(), "for the first");
      render(second.item);
      expect(textarea().value).toBe("");
      render(first.item);
      expect(textarea().value).toBe("for the first");
    });
  });
});
