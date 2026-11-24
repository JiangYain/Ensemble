import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyEvent, replay, toSummary, type SessionState } from "@shared/projection";
import type { QuestionPrompt } from "@shared/questions";
import { EventLog, USER } from "@shared/testing";
import { setLang } from "../lib/app";
import { buildRows, Timeline } from "./Timeline";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROMPTS: QuestionPrompt[] = [
  {
    key: "db",
    text: "Which database should the service use?",
    options: [{ label: "SQLite" }, { label: "PostgreSQL" }],
    multiple: false,
    custom: true,
  },
];

/**
 * 一个在运行的会话：日志继续往后追加，`sync()` 把新事件逐条应用到同一个状态上
 * （与页面收到推送时一样，被更新的条目换成新对象、没动的保持原样，memo 才能命中）。
 */
function live(): { log: EventLog; state: SessionState; sync: () => void } {
  const log = new EventLog("ses_t");
  log.created({ harness: "codex" });
  const message = log.message("msg_1", "task", "做点什么");
  log.run("run_1", 1, message.id);
  log.startRun("run_1");
  const state = replay(log.events);
  if (!state) throw new Error("replay produced no state");
  let applied = log.events.length;
  return {
    log,
    state,
    sync: () => {
      for (const event of log.events.slice(applied)) applyEvent(state, event);
      applied = log.events.length;
    },
  };
}

const step = (log: EventLog, id: string): void => {
  log.tool("run_1", id, "running");
  log.tool("run_1", id, "completed");
};

const answer = (log: EventLog): void => {
  log.settle({ questionId: "qst_1", outcome: "answered", by: USER, answers: [["SQLite"]], delivery: "handed_off" }, "run_1");
};

type Rows = ReturnType<typeof buildRows>;
const statusOf = (rows: Rows, questionKey = "question:qst_1"): string | undefined => {
  const row = rows.find((candidate) => candidate.key === questionKey);
  return row?.kind === "question" ? row.item.status : undefined;
};

describe("时间线里的提问：行", () => {
  it("提问是一行，位置就是它被问出的地方，并把前后的工作组隔开", () => {
    const session = live();
    step(session.log, "t1");
    session.log.ask("qst_1", PROMPTS, "run_1");
    step(session.log, "t2");
    session.sync();
    const rows = buildRows(session.state);
    expect(rows.map((row) => row.kind)).toEqual(["message", "run", "work", "question", "work"]);
    expect(rows[3]?.key).toBe("question:qst_1");
    expect(statusOf(rows)).toBe("open");
  });

  it("回答之后同一个 key 原位变成只读的记录：不多一行，行的顺序不变", () => {
    const session = live();
    step(session.log, "t1");
    session.log.ask("qst_1", PROMPTS, "run_1");
    session.sync();
    const before = buildRows(session.state);
    answer(session.log);
    session.sync();
    const after = buildRows(session.state, before);

    expect(after.map((row) => row.key)).toEqual(before.map((row) => row.key));
    expect(statusOf(before)).toBe("open");
    expect(statusOf(after)).toBe("answered");
  });

  it("没变的工作组仍沿用上一次的那一行（提问不破坏 memo 命中）", () => {
    const session = live();
    step(session.log, "t1");
    session.log.ask("qst_1", PROMPTS, "run_1");
    session.sync();
    const before = buildRows(session.state);
    answer(session.log);
    session.sync();
    const after = buildRows(session.state, before);
    const work = (rows: Rows) => rows.find((row) => row.kind === "work");
    expect(work(before)).toBeDefined();
    expect(work(after)).toBe(work(before));
  });
});

describe("时间线里的提问：渲染", () => {
  let host: HTMLDivElement;
  let root: Root;

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

  const render = (state: SessionState): void => {
    act(() => {
      root.render(<Timeline state={state} rev={state.seq} summary={toSummary(state)} />);
    });
  };

  const line = (): HTMLElement | null => host.querySelector<HTMLElement>(".live-line");
  const cards = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>("section.question")];

  it("待回答：时间线上有卡片；会话仍在运行（没有新的阶段），“现在”这一行写“等待回答”，不转圈", () => {
    const session = live();
    step(session.log, "t1");
    session.log.ask("qst_1", PROMPTS, "run_1");
    session.sync();
    expect(toSummary(session.state).phase).toBe("running");
    render(session.state);

    expect(cards()).toHaveLength(1);
    expect(cards()[0]?.getAttribute("data-status")).toBe("open");
    expect(cards()[0]?.textContent).toContain("Which database should the service use?");

    expect(line()?.hasAttribute("data-waiting")).toBe(true);
    expect(line()?.querySelector(".spinner")).toBeNull();
    expect(line()?.querySelector("svg")).not.toBeNull();
    expect(line()?.querySelector(".live-text")?.textContent).toBe("等待回答");
  });

  it("卡片就在它被问出的位置：工作组之后、“现在”这一行之前", () => {
    const session = live();
    step(session.log, "t1");
    session.log.ask("qst_1", PROMPTS, "run_1");
    session.sync();
    render(session.state);

    const work = host.querySelector(".work-head");
    const card = cards()[0];
    const now = line();
    if (!work || !card || !now) throw new Error("work group, question card and live line should all be rendered");
    expect(work.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.compareDocumentPosition(now) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("回答之后：卡片原位变成只读记录，“现在”这一行恢复成运行中的样子", () => {
    const session = live();
    step(session.log, "t1");
    session.log.ask("qst_1", PROMPTS, "run_1");
    session.sync();
    render(session.state);
    expect(cards()).toHaveLength(1);

    answer(session.log);
    session.sync();
    render(session.state);
    expect(cards()).toHaveLength(1);
    expect(cards()[0]?.getAttribute("data-status")).toBe("answered");
    expect(cards()[0]?.querySelector("input, textarea")).toBeNull();

    expect(line()?.hasAttribute("data-waiting")).toBe(false);
    expect(line()?.querySelector(".spinner")).not.toBeNull();
    expect(line()?.querySelector(".live-text")?.textContent).not.toBe("等待回答");
  });

  it("同一条时间线上的两次提问各是一张卡片，先后顺序不变；还有一张在等就仍然说“等待回答”", () => {
    const session = live();
    session.log.ask("qst_1", PROMPTS, "run_1");
    answer(session.log);
    step(session.log, "t2");
    session.log.ask("qst_2", [{ key: "n", text: "What should the table be called?", multiple: false, custom: true }], "run_1");
    session.sync();
    render(session.state);

    expect(cards().map((card) => card.getAttribute("data-status"))).toEqual(["answered", "open"]);
    expect(cards()[1]?.textContent).toContain("What should the table be called?");
    expect(line()?.querySelector(".live-text")?.textContent).toBe("等待回答");
  });

  it("所属运行结束了，没有结局的提问显示为已过期，也不再提示“等待回答”", () => {
    const session = live();
    session.log.ask("qst_1", PROMPTS, "run_1");
    session.log.push({ kind: "run.completed", data: { stopReason: "end_turn" } }, { runId: "run_1" });
    session.log.push({ kind: "session.status", data: { status: "idle" } }, { source: "ensemble" });
    session.sync();
    render(session.state);

    expect(cards()).toHaveLength(1);
    expect(cards()[0]?.getAttribute("data-status")).toBe("expired");
    expect(cards()[0]?.querySelector("input, textarea")).toBeNull();
    expect(host.textContent).not.toContain("等待回答");
  });
});
