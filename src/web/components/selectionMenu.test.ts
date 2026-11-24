import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog } from "@shared/testing";
import type { SessionSummary } from "@shared/types";
import { store } from "../lib/app";
import { bindT } from "../lib/i18n";
import type { MenuEntry, MenuItem } from "./Menu";
import { selectionMenuEntries, type ArrangeEngine } from "./selectionMenu";

const t = bindT("zh");

const engine: ArrangeEngine = { align: () => false, distribute: () => false, undo: () => false, redo: () => false, clearSelection: () => undefined };

function summaryOf(id: string, patch: Partial<SessionSummary>): SessionSummary {
  const log = new EventLog(id);
  log.created({ id, title: id, harness: "cursor", runtime: "native" });
  return { ...toSummary(replay(log.events)!), seq: 5, ...patch };
}

const BUSY = { phase: "running", status: "running", activeRunId: "run_1" } as const;
const IDLE = { phase: "done", status: "idle", activeRunId: undefined } as const;
const CLOSED = { phase: "stopped", status: "stopped", activeRunId: undefined } as const;

/**
 * 四个会话：两个在运行（能中断、能关闭、不能删）、一个空闲（不能中断、能关闭、能删）、一个已关闭（只能删）。
 * 菜单在这份快照上建好之后，各个用例再让其中某个会话的状态变掉。
 */
function fixture(): Record<string, SessionSummary> {
  return Object.fromEntries(
    [summaryOf("busy_a", BUSY), summaryOf("busy_b", BUSY), summaryOf("idle", IDLE), summaryOf("closed", CLOSED)].map((summary) => [summary.id, summary]),
  );
}

function entryNamed(entries: readonly MenuEntry[], id: string): MenuItem {
  const found = entries.find((entry): entry is MenuItem => entry.id === id && "onSelect" in entry);
  if (!found) throw new Error(`菜单里没有：${id}`);
  return found;
}

/** 记录每个请求；各动作的返回值都按“已经成功”给。 */
function stubFetch(): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const [, id, action] = /\/api\/sessions\/([^/]+)(?:\/([^/]+))?$/.exec(path)!;
      calls.push(`${init?.method ?? "GET"} ${id}${action ? `/${action}` : ""}`);
      const summary = { ...store.get().sessions[id!]!, seq: 99 };
      const body = action === "cancel" ? { summary, interrupted: true, cancelledQueued: 0 } : action === "stop" ? { summary } : { removed: id };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    }),
  );
  return calls;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 批量动作的对象在菜单建好那一刻定下（确认框里写的数量、菜单项后面的数量就是它）：
 * 之后会话的状态怎么变，名单只会缩小，不会变大。
 */
describe("多选菜单的批量动作：对象固定，只缩小不扩大", () => {
  // `confirmTitle` 为空表示没有确认框：点击本身就是执行。
  const cases = [
    {
      action: "中断当前运行",
      entry: "cancel",
      confirmTitle: undefined,
      // 建好时可中断的是 busy_a、busy_b。
      grow: { id: "idle", patch: BUSY },
      shrink: { id: "busy_b", patch: IDLE },
      calls: { grow: ["POST busy_a/cancel", "POST busy_b/cancel"], shrink: ["POST busy_a/cancel"] },
      summary: { grow: "中断当前运行：2 个已完成", shrink: "中断当前运行：1 个已完成" },
    },
    {
      action: "关闭会话",
      entry: "stop",
      confirmTitle: "关闭这 3 个会话？",
      // 可关闭的是 busy_a、busy_b、idle；closed 已经关闭。
      grow: { id: "closed", patch: IDLE },
      shrink: { id: "busy_b", patch: CLOSED },
      calls: { grow: ["POST busy_a/stop", "POST busy_b/stop", "POST idle/stop"], shrink: ["POST busy_a/stop", "POST idle/stop"] },
      summary: { grow: "关闭会话：3 个已完成", shrink: "关闭会话：2 个已完成" },
    },
    {
      action: "删除记录",
      entry: "remove",
      confirmTitle: "删除这 2 条会话记录？",
      // 可删的是 idle、closed；两个运行中的不能删。
      grow: { id: "busy_a", patch: IDLE },
      shrink: { id: "idle", patch: BUSY },
      calls: { grow: ["DELETE closed", "DELETE idle"], shrink: ["DELETE closed"] },
      summary: { grow: "删除记录：2 个已完成", shrink: "删除记录：1 个已完成" },
    },
  ] as const;

  let calls: string[];

  beforeEach(() => {
    store.set({ sessions: fixture(), toasts: [], confirm: undefined });
    calls = stubFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    store.set({ sessions: {}, toasts: [], confirm: undefined });
  });

  /** 在当前快照上建菜单，`change` 在“对象定下之后、请求发出之前”改变一个会话：有确认框时是框开着的那几秒。 */
  async function run(row: (typeof cases)[number], change: { id: string; patch: Partial<SessionSummary> }): Promise<void> {
    const sessions = Object.values(store.get().sessions);
    const item = entryNamed(selectionMenuEntries({ engine, count: sessions.length, sessions, canUndo: false, canRedo: false, t, announce: () => undefined }), row.entry);
    const mutate = (): void => store.set({ sessions: { ...store.get().sessions, [change.id]: { ...store.get().sessions[change.id]!, ...change.patch, seq: 20 } } });

    if (row.confirmTitle === undefined) mutate();
    item.onSelect();
    if (row.confirmTitle !== undefined) {
      const confirm = store.get().confirm!;
      expect(confirm.title).toBe(row.confirmTitle);
      mutate();
      await confirm.onConfirm();
    }
    await settle();
  }

  for (const row of cases) {
    it(`${row.action}：名单之外的会话之后变得符合条件，也不会被加进来`, async () => {
      await run(row, row.grow);
      expect(calls.sort()).toEqual([...row.calls.grow]);
      expect(store.get().toasts.at(-1)?.text).toBe(row.summary.grow);
    });

    it(`${row.action}：名单里的会话之后变得不符合条件，被剔除，汇总只算真正动了的`, async () => {
      await run(row, row.shrink);
      expect(calls.sort()).toEqual([...row.calls.shrink]);
      expect(store.get().toasts.at(-1)?.text).toBe(row.summary.shrink);
    });
  }
});
