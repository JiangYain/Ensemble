import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replay, toSummary } from "@shared/projection";
import { EventLog, testOrigin } from "@shared/testing";
import type { SessionPhase, SessionSummary } from "@shared/types";
import { setLang, store } from "../lib/app";
import { translate } from "../lib/i18n";
import { buildWorkspaces } from "../lib/workspaces";
import { SessionList } from "./SessionList";
import { WorkspaceRail } from "./WorkspaceRail";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = "cursor:a";
const B = "cursor:b";
const T0 = Date.parse("2026-11-21T08:00:00.000Z");
const MINUTE = 60_000;

const pad = (n: number): string => String(n).padStart(2, "0");
/** 第 n 个根会话（创建于第 n 分钟，数字越大越新）的 id 与标题；B 空间的另有一套，避免两个空间的会话撞名。 */
const idOf = (n: number, origin = A): string => (origin === A ? `ses_${pad(n)}` : `ses_b${pad(n)}`);
const titleOf = (n: number, origin = A): string => (origin === A ? `会话 ${pad(n)}` : `乙会话 ${pad(n)}`);
/** 从 hi 数到 lo 的标题（新→旧），就是根会话在稳定顺序里的样子。 */
const down = (hi: number, lo: number, origin = A): string[] =>
  Array.from({ length: hi - lo + 1 }, (_, i) => titleOf(hi - i, origin));
const more = (n: number): string => translate("zh", "rail.moreSessions", { n });

function make(
  id: string,
  title: string,
  at: number,
  opts: { origin?: string; parent?: string; phase?: SessionPhase; updated?: number } = {},
): SessionSummary {
  const log = new EventLog(id, T0 + at * MINUTE);
  log.created({
    title,
    harness: "cursor",
    createdAt: new Date(T0 + at * MINUTE).toISOString(),
    origin: testOrigin({ key: opts.origin ?? A, host: "cursor", hostLabel: "Cursor", hostTitle: "批量改造" }),
    ...(opts.parent ? { parentSessionId: opts.parent } : {}),
  });
  return {
    ...toSummary(replay(log.events)!),
    phase: opts.phase ?? "done",
    updatedAt: new Date(T0 + (opts.updated ?? at) * MINUTE).toISOString(),
  };
}

/** from … to 号根会话（都是已结束的）。 */
function batch(from: number, to: number, origin = A): SessionSummary[] {
  return Array.from({ length: to - from + 1 }, (_, i) => make(idOf(from + i, origin), titleOf(from + i, origin), from + i, { origin }));
}

/** 把每个会话的状态与最近更新时间都换掉：偶数下标在运行、最近才更新，奇数下标失败、更新得很早。 */
function churn(sessions: readonly SessionSummary[]): SessionSummary[] {
  return sessions.map((session, index) => ({
    ...session,
    phase: (index % 2 === 0 ? "running" : "failed") as SessionPhase,
    updatedAt: new Date(T0 + (900 - index) * MINUTE).toISOString(),
  }));
}

describe("WorkspaceRail · 会话页里的兄弟会话（稳定顺序与可见窗口）", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let previous: ReturnType<typeof store.get>;

  beforeEach(() => {
    previous = store.get();
    localStorage.clear();
    location.hash = "";
    setLang("zh");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    location.hash = "";
    localStorage.clear();
    store.set(previous);
  });

  /**
   * 在同一个 root 里反复渲染，像真实页面里换会话、来新事件那样：侧栏自己的 state（窗口位置）会留着。
   * focus 是聚焦页当前打开的会话 id，不传就是在概览页（侧栏里没有兄弟列表）。
   */
  const render = (sessions: readonly SessionSummary[], focus?: string, origin = A): void => {
    act(() =>
      root.render(
        <WorkspaceRail
          workspaces={buildWorkspaces(sessions)}
          sessions={sessions}
          currentScope={{ kind: "origin", key: origin }}
          {...(focus ? { focusedSessionId: focus, focusedOriginKey: origin } : {})}
        />,
      ),
    );
  };

  const siblingRows = (): HTMLElement[] =>
    [...host.querySelectorAll<HTMLElement>(".rail-siblings .rail-sibling:not(.rail-sibling--more)")];
  const rowTitle = (row: HTMLElement): string => row.querySelector(".rail-sibling-title")?.textContent ?? "";
  const titles = (): string[] => siblingRows().map(rowTitle);
  const highlighted = (): string[] => siblingRows().filter((row) => row.hasAttribute("data-active")).map(rowTitle);
  const moreRow = (): HTMLElement | null => host.querySelector<HTMLElement>(".rail-sibling--more");

  /** 把同一批会话交给列表视图渲染，读出它的行序。 */
  const listOrder = (sessions: readonly SessionSummary[]): string[] => {
    const listHost = document.createElement("div");
    document.body.append(listHost);
    const listRoot = createRoot(listHost);
    try {
      act(() => listRoot.render(<SessionList sessions={sessions} />));
      return [...listHost.querySelectorAll<HTMLElement>(".slist-row .slist-title")].map((el) => el.textContent ?? "");
    } finally {
      act(() => listRoot.unmount());
      listHost.remove();
    }
  };

  it("行序只看创建先后：状态、最近更新、传入数组的顺序、哪个是当前会话都不让行换位；当前会话留在自己的位置上，只靠高亮标出", () => {
    // 05 … 01 五个根会话，外加 02 名下的一个子会话（创建得最晚，但紧跟在上级之后）。
    const sessions = [...batch(1, 5), make("ses_kid", "会话 02 的子会话", 6, { parent: idOf(2) })];
    const order = [titleOf(5), titleOf(4), titleOf(3), titleOf(2), "会话 02 的子会话", titleOf(1)];

    // 当前打开的是最早创建的 01：旧排序会把它顶到第一行，现在它留在最后一行。
    render(sessions, idOf(1));
    expect(titles()).toEqual(order);
    expect(highlighted()).toEqual([titleOf(1)]);
    expect(siblingRows().at(-1)?.getAttribute("aria-current")).toBe("page");
    expect(moreRow()).toBeNull();

    // 每个会话的状态都变了、最近更新时间彻底颠倒（01 成了最近更新、还在运行的），传入数组的顺序也倒过来：行一动没动。
    const phases = ["running", "failed", "ready", "queued", "starting", "done"] as const;
    const churned = sessions.map((session, index) => ({
      ...session,
      phase: phases[index]!,
      updatedAt: new Date(T0 + (900 - index * 100) * MINUTE).toISOString(),
    }));
    render([...churned].reverse(), idOf(1));
    // 状态确实全变了（按显示顺序：05 starting、04 queued、03 ready、02 failed、子会话 done、01 running）。
    expect(siblingRows().map((row) => row.getAttribute("data-phase"))).toEqual([
      "starting",
      "queued",
      "ready",
      "failed",
      "done",
      "running",
    ]);
    expect(titles()).toEqual(order);
    expect(highlighted()).toEqual([titleOf(1)]);

    // 换当前会话：只换高亮，行不动，也没有谁被顶到第一行。
    render([...churned].reverse(), idOf(4));
    expect(titles()).toEqual(order);
    expect(highlighted()).toEqual([titleOf(4)]);
    expect(siblingRows().filter((row) => row.getAttribute("aria-current") === "page")).toHaveLength(1);
    expect(siblingRows()[0]?.hasAttribute("data-active")).toBe(false);
  });

  it("点另一行：去那个会话，列表本身不动，只有高亮换了", () => {
    const sessions = batch(1, 5);
    render(sessions, idOf(5));
    expect(titles()).toEqual(down(5, 1));

    act(() => siblingRows()[2]!.click());
    expect(location.hash).toBe(`#/s/${idOf(3)}`);

    // 路由换了之后 App 会带着新的当前会话重新渲染这一栏。
    render(sessions, idOf(3));
    expect(titles()).toEqual(down(5, 1));
    expect(highlighted()).toEqual([titleOf(3)]);
  });

  it("同一个空间里，侧栏兄弟会话的先后与列表视图一致（同一份顺序）：不超过 6 个时完全相同，超过时露出的是它的连续一段", () => {
    // 不超过 6 个，含两层嵌套：04 … 01，02 名下有子会话，子会话名下又有一个。
    const small = [
      ...batch(1, 4),
      make("ses_kid", "会话 02 的子会话", 5, { parent: idOf(2) }),
      make("ses_grand", "子会话的子会话", 6, { parent: "ses_kid" }),
    ];
    const smallList = listOrder(small);
    expect(smallList).toEqual([titleOf(4), titleOf(3), titleOf(2), "会话 02 的子会话", "子会话的子会话", titleOf(1)]);
    render(small, idOf(3));
    expect(titles()).toEqual(smallList);
    // 状态全变、传入顺序倒过来，两处仍然一致。
    render(churn([...small].reverse()), idOf(3));
    expect(titles()).toEqual(listOrder(churn([...small].reverse())));
    expect(titles()).toEqual(smallList);

    // 超过 6 个：侧栏里是列表视图那一列里连续的 6 行。
    const big = [...batch(1, 9), make("ses_kid", "会话 05 的子会话", 10, { parent: idOf(5) })];
    const full = listOrder(big);
    expect(full).toHaveLength(10);
    render(big, idOf(3));
    const start = full.indexOf(titles()[0]!);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(titles()).toHaveLength(6);
    expect(titles()).toEqual(full.slice(start, start + 6));
    expect(highlighted()).toEqual([titleOf(3)]);
  });

  it("总数不超过 6 个时没有“更多”；多一个就折成一行，数字是真正被藏起来的个数", () => {
    render(batch(1, 6), idOf(6));
    expect(titles()).toEqual(down(6, 1));
    expect(moreRow()).toBeNull();

    render(batch(1, 7), idOf(7));
    expect(titles()).toEqual(down(7, 2));
    expect(moreRow()?.textContent).toBe(more(1));

    render(batch(1, 13), idOf(13));
    expect(titles()).toEqual(down(13, 8));
    expect(moreRow()?.textContent).toBe(more(7));
  });

  it("当前会话在前 6 个之外时也看得见：窗口是连续的一段，不是“前 5 个 + 隔着一大段的当前会话”，隐藏数如实", () => {
    const ten = batch(1, 10);
    // 02 是新→旧的第 9 行：窗口只移到刚好看见它，它是最后一行。
    render(ten, idOf(2));
    expect(titles()).toEqual(down(7, 2));
    expect(highlighted()).toEqual([titleOf(2)]);
    expect(moreRow()?.textContent).toBe(more(4));
    expect(titles()).not.toContain(titleOf(10));
    // “更多”仍是最后一行，且是个按钮。
    expect(moreRow()?.tagName).toBe("BUTTON");
    expect(host.querySelector(".rail-siblings")?.lastElementChild).toBe(moreRow());
  });

  it("窗口规则：在窗口里换当前会话，窗口不动；只有它落到窗口之外，窗口才移动，而且只移到刚好看见它", () => {
    const ten = batch(1, 10);
    render(ten, idOf(2));
    expect(titles()).toEqual(down(7, 2));

    // 窗口里随便换（第一行、中间、最后一行）：窗口纹丝不动，只有高亮在换。
    for (const n of [5, 7, 3, 2]) {
      render(ten, idOf(n));
      expect(titles()).toEqual(down(7, 2));
      expect(highlighted()).toEqual([titleOf(n)]);
      expect(moreRow()?.textContent).toBe(more(4));
    }

    // 落到窗口上方（08）：窗口只上移一格，它成了第一行。
    render(ten, idOf(8));
    expect(titles()).toEqual(down(8, 3));
    expect(highlighted()).toEqual([titleOf(8)]);

    // 落到窗口下方（01）：窗口只下移到它成为最后一行。
    render(ten, idOf(1));
    expect(titles()).toEqual(down(6, 1));
    expect(highlighted()).toEqual([titleOf(1)]);
    expect(moreRow()?.textContent).toBe(more(4));

    // 回到最新的 10：窗口回到最顶端。
    render(ten, idOf(10));
    expect(titles()).toEqual(down(10, 5));
    expect(moreRow()?.textContent).toBe(more(4));
  });

  it("状态变了、新会话来了，窗口也不跟着摇：贴着顶端的看得到新来的，滚下去的原样不动", () => {
    const ten = batch(1, 10);
    const eleven = [...ten, make(idOf(11), titleOf(11), 11)];

    // 贴着顶端（当前是最新的 10）：新会话出现在顶部，已有的行往下推，窗口仍在顶端。
    render(ten, idOf(10));
    expect(titles()).toEqual(down(10, 5));
    render(eleven, idOf(10));
    expect(titles()).toEqual(down(11, 6));
    expect(moreRow()?.textContent).toBe(more(5));

    // 窗口滚到了 07 … 02：新会话落在窗口上方，窗口里的会话一个不换，只是“另有 n 个”多了一个。
    render(ten, idOf(2));
    expect(titles()).toEqual(down(7, 2));
    expect(moreRow()?.textContent).toBe(more(4));
    render(eleven, idOf(2));
    expect(titles()).toEqual(down(7, 2));
    expect(moreRow()?.textContent).toBe(more(5));

    // 全体换状态、更新时间：这个 Main Agent 的条目从“最近”换到“进行中”那一段（整个重新挂载），窗口也不复位。
    expect(host.querySelector(".rail-section-label")?.textContent).toBe(translate("zh", "rail.sectionRecent"));
    render(churn(eleven), idOf(2));
    expect(host.querySelector(".rail-section-label")?.textContent).toBe(translate("zh", "rail.sectionActive"));
    expect(titles()).toEqual(down(7, 2));
    expect(highlighted()).toEqual([titleOf(2)]);
  });

  it("离开聚焦页、或换到别的 Main Agent 再回来，窗口从最上面重新开始，不带着旧位置走", () => {
    const a = batch(1, 10);
    const b = batch(1, 8, B);
    const all = [...a, ...b];

    // A 的窗口滚到 07 … 02。
    render(all, idOf(2));
    expect(titles()).toEqual(down(7, 2));

    // 换到 B 的会话：B 从最上面开始（03 在前 6 个里）。
    render(all, idOf(3, B), B);
    expect(titles()).toEqual(down(8, 3, B));
    expect(moreRow()?.textContent).toBe(more(2));

    // 再回到 A 的 05：不会还是 07 … 02（旧位置没带回来），而是最上面那一段。
    render(all, idOf(5));
    expect(titles()).toEqual(down(10, 5));

    // 同样的，退到概览页（没有聚焦会话，兄弟列表消失）再进来。
    render(all, idOf(2));
    expect(titles()).toEqual(down(7, 2));
    render(all);
    expect(siblingRows()).toHaveLength(0);
    expect(host.querySelector(".rail-siblings")).toBeNull();
    render(all, idOf(5));
    expect(titles()).toEqual(down(10, 5));
  });

  it("点“另有 n 个会话”回到该空间的概览，去向与以前一样", () => {
    render(batch(1, 9), idOf(9));
    expect(moreRow()?.textContent).toBe(more(3));
    act(() => moreRow()!.click());
    expect(location.hash).toBe("#/m/cursor%3Aa");
  });
});
