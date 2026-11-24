import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replay, toSummary } from "@shared/projection";
import type { GitResponse } from "@shared/protocol";
import { EventLog, testOrigin } from "@shared/testing";
import { api } from "../lib/api";
import { setLang, store } from "../lib/app";
import { SceneEngine } from "../scene/engine";
import { NODE, type SceneLayout } from "../scene/layout";
import { Overview } from "./Overview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REPO = "C:\\Users\\alice\\Desktop\\Ensemble";
const REPO_KEY = "c:/users/alice/desktop/ensemble";

function summaryOf(id: string, key: string, workspace?: string) {
  const log = new EventLog(id);
  // 键以 console: 开头的是从网页控制台发起的来源（用户，本来就没有工作目录）；其余是 Agent 发起的。
  const fromConsole = key.startsWith("console:") ? ({ kind: "user", host: "console", hostLabel: "Ensemble" } as const) : {};
  log.created({ id, origin: testOrigin({ key, ...fromConsole, ...(workspace ? { workspace } : {}) }) });
  return toSummary(replay(log.events)!);
}

describe("画布上的 Folder 节点", () => {
  const previous = store.get().sessions;
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let wide = true;

  beforeEach(() => {
    setLang("zh");
    wide = true;
    // happy-dom 没有布局：让取景区域有尺寸（宽 1280 是普通浏览器窗口，窄的是宿主侧栏）。
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => (wide ? 1280 : 480) });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });
    // 这些目录都不是 Git 仓库：画布上只有 Folder，没有 Git。
    vi.spyOn(api, "git").mockImplementation(async (path): Promise<GitResponse> => ({ path, git: null, reason: "not_repo" }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    store.set({ sessions: previous });
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)["clientWidth"];
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)["clientHeight"];
    vi.restoreAllMocks();
  });

  const flush = async (): Promise<void> => {
    await act(async () => {
      for (let tick = 0; tick < 6; tick++) await Promise.resolve();
    });
  };
  const open = (...sessions: ReturnType<typeof summaryOf>[]): void => {
    act(() => store.set({ sessions: Object.fromEntries(sessions.map((s) => [s.id, s])) }));
  };
  const mount = async (...sessions: ReturnType<typeof summaryOf>[]) => {
    const engine = new SceneEngine();
    const setLayout = vi.spyOn(engine, "setLayout");
    const register = vi.spyOn(engine, "register");
    open(...sessions);
    act(() => root.render(<Overview engine={engine} />));
    await flush();
    return { engine, register, layout: (): SceneLayout => setLayout.mock.lastCall![0] };
  };
  const folders = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>(".node.folder")];
  const originCard = (key: string): HTMLElement => container.querySelector<HTMLElement>(`.node.origin[data-node-id='origin:${key}']`)!;
  /** 节点左边的端口亮着：引擎只在真有连线接进左边时点亮它，节点自己不带任何“有没有入口”的标记。 */
  const hasLeftPort = (node: Element): boolean => node.querySelector(".node-port[data-side='left']")?.hasAttribute("data-on") ?? false;
  const litOrigins = (): number => [...container.querySelectorAll(".node.origin")].filter(hasLeftPort).length;

  it("来源的工作目录是自己的 Folder 节点：在来源左边、与来源同高居中，注册到画布，来源卡不再重复目录行", async () => {
    const { register, layout } = await mount(summaryOf("ses_a", "codex:a", REPO));

    expect(folders()).toHaveLength(1);
    const card = folders()[0]!;
    expect(card.getAttribute("data-node-id")).toBe(`folder:${REPO_KEY}`);
    expect(register).toHaveBeenCalledWith(`folder:${REPO_KEY}`, card);
    expect(card.querySelector(".o-label")?.textContent).toBe("文件夹");
    expect(card.querySelector(".o-main .o-text")?.textContent).toBe("Ensemble");
    expect(card.querySelector(".o-sub")?.textContent).toBe("C:\\Users\\alice\\Desktop");
    expect(card.querySelector(".o-count")).toBeNull();
    // 没有 Git：Folder 左边没有连线，端口不亮；来源左边接着 Folder，端口亮着。
    expect(hasLeftPort(card)).toBe(false);
    expect(hasLeftPort(originCard("codex:a"))).toBe(true);
    // 来源卡正文里只剩首次委派时间。
    expect(originCard("codex:a").querySelector(".o-body")?.children).toHaveLength(1);
    expect(originCard("codex:a").querySelector(".o-main time")).not.toBeNull();
    expect(originCard("codex:a").querySelector(".o-body")?.textContent).not.toContain("Ensemble");

    const scene = layout();
    const dir = scene.nodes.find((n) => n.kind === "folder")!;
    const origin = scene.nodes.find((n) => n.kind === "origin")!;
    expect([dir.w, dir.h]).toEqual([NODE.folderW, NODE.folderH]);
    expect(dir.x + dir.w).toBeLessThan(origin.x);
    expect(dir.y + dir.h / 2).toBe(origin.y + origin.h / 2);
    expect(scene.edges.filter((edge) => edge.phase === "link")).toEqual([
      { id: `folder:${REPO_KEY}>origin:codex:a`, from: `folder:${REPO_KEY}`, to: "origin:codex:a", phase: "link" },
    ]);
    // 页面上的节点就是布局里的节点。
    expect([...container.querySelectorAll("[data-node-id]")].map((el) => el.getAttribute("data-node-id")).sort()).toEqual(scene.nodes.map((n) => n.id).sort());
  });

  it("同一个目录的不同写法是同一张 Folder：只有一张卡，头部写 Main Agent 个数，卡上写的是确定的那种写法", async () => {
    const spellings = [REPO, "c:/users/alice/desktop/ensemble/", "C:\\USERS\\ALICE\\DESKTOP\\ENSEMBLE\\"];
    for (const order of [spellings, [...spellings].reverse()]) {
      const { layout } = await mount(...order.map((dir, index) => summaryOf(`ses_${index}`, `host:${index}`, dir)));
      expect(folders()).toHaveLength(1);
      expect(folders()[0]!.querySelector(".o-count")?.textContent).toBe("3 个 Main Agent");
      expect(folders()[0]!.querySelector(".o-count")?.getAttribute("data-tip")).toBe("3 个 Main Agent 使用这个工作目录");
      // 结尾没有分隔符、字典序最小的写法：与来源的先后无关。
      expect(folders()[0]!.getAttribute("data-tip")).toContain(`目录: ${REPO}`);
      expect(layout().edges.filter((edge) => edge.phase === "link")).toHaveLength(3);
      act(() => root.unmount());
      root = createRoot(container);
    }
  });

  it("多个目录、控制台来源混在一起：每个目录一张 Folder，控制台来源没有 Folder、左边也没有连线，也不空出一列", async () => {
    const { layout } = await mount(
      summaryOf("ses_a", "codex:a", REPO),
      summaryOf("ses_b", "cursor:b", "C:\\work\\other"),
      summaryOf("ses_c", "pi:c", REPO),
      summaryOf("ses_d", "console:d"),
    );
    expect(folders().map((node) => node.getAttribute("data-node-id")).sort()).toEqual([`folder:${REPO_KEY}`, "folder:c:/work/other"]);
    expect(hasLeftPort(originCard("console:d"))).toBe(false);
    expect(originCard("console:d").querySelector(".o-main time")).not.toBeNull();
    expect(litOrigins()).toBe(3);

    const scene = layout();
    expect(scene.edges.filter((edge) => edge.to === "origin:console:d")).toHaveLength(0);
    expect(scene.edges.filter((edge) => edge.phase === "link")).toHaveLength(3);
    // 同一列：有 Folder 与没有 Folder 的来源共用一条竖轴。
    expect(new Set(scene.nodes.filter((n) => n.kind === "origin").map((n) => n.x)).size).toBe(1);
  });

  it("Agent 发起的来源没有工作目录（宿主没报告、委派也没传 cwd）：没有 Folder、没有连线，卡片写“未知”，不拿别的目录顶替", async () => {
    const { layout } = await mount(summaryOf("ses_a", "cursor:a"), summaryOf("ses_b", "codex:b", REPO));
    expect(folders().map((node) => node.getAttribute("data-node-id"))).toEqual([`folder:${REPO_KEY}`]);

    const card = originCard("cursor:a");
    expect(hasLeftPort(card)).toBe(false);
    expect(card.querySelector(".o-main .o-text")?.textContent).toBe("未知");
    expect(card.querySelector(".o-main .o-text")?.classList.contains("o-unknown")).toBe(true);
    // 目录行占了主行，首次委派时间退到次行；提示里同样说明是未知。
    expect(card.querySelector(".o-sub time")).not.toBeNull();
    expect(card.getAttribute("data-tip")).toContain("工作区: 未知");
    expect(card.textContent).not.toContain("Ensemble");

    const scene = layout();
    expect(scene.edges.filter((edge) => edge.to === "origin:cursor:a")).toHaveLength(0);
    expect(scene.edges.filter((edge) => edge.phase === "link")).toHaveLength(1);
  });

  it("所有来源都没有工作目录：没有 Folder，也不为它留一列空白", async () => {
    const { layout } = await mount(summaryOf("ses_a", "console:a"), summaryOf("ses_b", "console:b"));
    expect(folders()).toHaveLength(0);
    expect(litOrigins()).toBe(0);
    const scene = layout();
    expect(scene.folders).toEqual([]);
    expect(Math.min(...scene.nodes.map((n) => n.x))).toBe(0);
    expect(scene.nodes.find((n) => n.kind === "origin")!.x).toBe(0);
  });

  it("窄画布（宿主侧栏）里不画 Folder：每个来源卡自己写目录行，多个来源共用一个目录也各写各的", async () => {
    wide = false;
    const { layout } = await mount(summaryOf("ses_a", "codex:a", REPO), summaryOf("ses_b", "cursor:b", REPO));
    expect(folders()).toHaveLength(0);
    expect(layout().folders).toEqual([]);
    expect(layout().edges.filter((edge) => edge.phase === "link")).toHaveLength(0);
    expect([...container.querySelectorAll(".node.origin .o-main .o-text")].map((el) => el.textContent)).toEqual(["Ensemble", "Ensemble"]);
  });

  it("英文界面：标签、个数与提示都是英文，没有中文", async () => {
    setLang("en");
    try {
      await mount(summaryOf("ses_a", "codex:a", REPO), summaryOf("ses_b", "cursor:b", REPO));
      const card = folders()[0]!;
      expect(card.querySelector(".o-label")?.textContent).toBe("Folder");
      expect(card.querySelector(".o-count")?.textContent).toBe("2 Main Agents");
      expect(card.getAttribute("aria-label")).toBe("Folder: Ensemble");
      expect(card.textContent).not.toMatch(/[\u4e00-\u9fff]/);
      expect(card.getAttribute("data-tip")).not.toMatch(/[\u4e00-\u9fff]/);
    } finally {
      setLang("zh");
    }
  });
});
