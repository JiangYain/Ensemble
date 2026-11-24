import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replay, toSummary } from "@shared/projection";
import type { GitResponse, GitSnapshot } from "@shared/protocol";
import { EventLog, testOrigin } from "@shared/testing";
import { api } from "../lib/api";
import { setLang, store } from "../lib/app";
import { GIT_FIRST_WAIT_MS, GIT_IDLE_MS } from "../lib/git";
import { SceneEngine } from "../scene/engine";
import type { SceneLayout } from "../scene/layout";
import { Overview } from "./Overview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE = "C:\\Users\\alice\\Desktop\\Ensemble";
/** WORKSPACE 作为工作树的标识（worktreeKey 的写法）；Git 节点的 id 是 `git:` 加上它。 */
const WORKTREE = "c:/users/alice/desktop/ensemble";
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

function snapshot(extra: Partial<GitSnapshot> = {}): GitSnapshot {
  return {
    root: WORKSPACE,
    branch: "main",
    detached: false,
    head: { sha: SHA, subject: "feat: node", committedAt: new Date(2026, 0, 2, 9, 5).toISOString() },
    changes: { files: 2, staged: 0, unstaged: 2, untracked: 0, conflicted: 0 },
    checkedAt: new Date().toISOString(),
    ...extra,
  };
}

function summaryOf(id: string, key: string, workspace?: string) {
  const log = new EventLog(id);
  log.created({ id, origin: testOrigin({ key, ...(workspace ? { workspace } : {}) }) });
  return toSummary(replay(log.events)!);
}

describe("画布上的 Git 节点", () => {
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
    vi.useRealTimers();
  });

  const flush = async (): Promise<void> => {
    await act(async () => {
      for (let tick = 0; tick < 6; tick++) await Promise.resolve();
    });
  };
  const open = (...sessions: ReturnType<typeof summaryOf>[]): void => {
    act(() => store.set({ sessions: Object.fromEntries(sessions.map((s) => [s.id, s])) }));
  };
  const gitNodes = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>(".node.git")];
  const gitIds = (): string[] => gitNodes().map((node) => node.getAttribute("data-node-id")!).sort();
  const folderNodes = (): HTMLElement[] => [...container.querySelectorAll<HTMLElement>(".node.folder")];
  const folderIds = (): string[] => folderNodes().map((node) => node.getAttribute("data-node-id")!).sort();
  /** 节点左边的端口亮着：引擎只在真有连线接进左边时点亮它，节点自己不带任何“有没有入口”的标记。 */
  const hasLeftPort = (node: Element | null | undefined): boolean => node?.querySelector(".node-port[data-side='left']")?.hasAttribute("data-on") ?? false;
  /** 左边接着连线的来源节点数：左边接着 Folder（有工作目录且画布够宽）或 Git（只有布局里 Git 直连来源的情形）。 */
  const litOrigins = (): number => [...container.querySelectorAll(".node.origin")].filter(hasLeftPort).length;
  /** 页面上有且只有这一个 Git 节点，并且就是传入的那个 DOM 元素（没有被拆掉重建）。 */
  const expectOnlyCard = (card: HTMLElement | undefined): void => {
    expect(gitNodes().map((node) => node === card)).toEqual([true]);
  };

  /** 按请求的目录给出各自读到的根目录（模拟服务端的 `git rev-parse --show-toplevel`）；表里没有的目录不是仓库。 */
  const serve = (roots: Record<string, string>, extra: Partial<GitSnapshot> = {}) =>
    vi.spyOn(api, "git").mockImplementation(async (path): Promise<GitResponse> => {
      const found = roots[path];
      return found === undefined ? { path, git: null, reason: "not_repo" } : { path, git: snapshot({ root: found, ...extra }) };
    });
  /** 页面上的节点就是布局里的节点：没有布局之外的节点，也没有漏掉的。 */
  const expectPageMatches = (layout: SceneLayout): void => {
    const pageIds = [...container.querySelectorAll("[data-node-id]")].map((el) => el.getAttribute("data-node-id")!).sort();
    expect(pageIds).toEqual(layout.nodes.map((node) => node.id).sort());
    expect(new Set(pageIds).size).toBe(pageIds.length);
    expect(new Set(layout.edges.map((edge) => edge.id)).size).toBe(layout.edges.length);
  };
  const links = (layout: SceneLayout) => layout.edges.filter((edge) => edge.phase === "link");
  /** Git 节点 → Folder 节点的连线与 Folder 节点 → 来源的连线，分开看。 */
  const gitLinks = (layout: SceneLayout) => links(layout).filter((edge) => edge.from.startsWith("git:"));
  const originLinks = (layout: SceneLayout) => links(layout).filter((edge) => edge.to.startsWith("origin:"));

  it("来源的工作目录在 Git 仓库里：从左到右是 Git 节点 → Folder 节点 → 来源节点，连线都是静态的 link", async () => {
    vi.spyOn(api, "git").mockImplementation(async (path): Promise<GitResponse> => ({ path, git: snapshot() }));
    const engine = new SceneEngine();
    const setLayout = vi.spyOn(engine, "setLayout");
    open(summaryOf("ses_a", "codex:a", WORKSPACE));
    act(() => root.render(<Overview engine={engine} />));
    await flush();

    expect(api.git).toHaveBeenCalledTimes(1);
    expect(api.git).toHaveBeenCalledWith(WORKSPACE);
    const [node] = gitNodes();
    expect(node?.getAttribute("data-node-id")).toBe(`git:${WORKTREE}`);
    expect(node?.querySelector(".o-main .o-text")?.textContent).toBe("main");
    expect(node?.querySelector(".o-title")?.textContent).toBe("2 个文件有改动");
    expect(hasLeftPort(container.querySelector(".node.origin"))).toBe(true);
    // 工作目录是它自己的节点：夹在 Git 与来源之间，左边接着 Git（左边的端口亮着），来源卡上不再重复目录行。
    const [folder] = folderNodes();
    expect(folder?.getAttribute("data-node-id")).toBe(`folder:${WORKTREE}`);
    expect(hasLeftPort(folder)).toBe(true);
    expect(folder?.querySelector(".o-main .o-text")?.textContent).toBe("Ensemble");
    expect(folder?.querySelector(".o-sub")?.textContent).toBe("C:\\Users\\alice\\Desktop");
    expect(container.querySelector(".node.origin .o-main time")).not.toBeNull();
    expect(container.querySelector(".node.origin .o-main .o-text")?.textContent).not.toBe("Ensemble");

    const layout = setLayout.mock.lastCall![0];
    const git = layout.nodes.find((n) => n.kind === "git")!;
    const dir = layout.nodes.find((n) => n.kind === "folder")!;
    const origin = layout.nodes.find((n) => n.kind === "origin")!;
    expect(git.x + git.w).toBeLessThan(dir.x);
    expect(dir.x + dir.w).toBeLessThan(origin.x);
    expect(links(layout)).toEqual([
      { id: `${git.id}>${dir.id}`, from: git.id, to: dir.id, phase: "link" },
      { id: `${dir.id}>${origin.id}`, from: dir.id, to: origin.id, phase: "link" },
    ]);
    // 没有 Git 直连来源的线。
    expect(layout.edges.some((edge) => edge.from === git.id && edge.to === origin.id)).toBe(false);
    expectPageMatches(layout);
  });

  it("第一次排布等 Git 的结果：一开始就把 Git 节点算进去，加载时不会先摆一遍再整体右移", async () => {
    let answer!: (response: GitResponse) => void;
    vi.spyOn(api, "git").mockImplementation(() => new Promise<GitResponse>((resolve) => (answer = resolve)));
    const engine = new SceneEngine();
    const setLayout = vi.spyOn(engine, "setLayout");
    open(summaryOf("ses_a", "codex:a", WORKSPACE));
    act(() => root.render(<Overview engine={engine} />));
    await flush();
    expect(setLayout).not.toHaveBeenCalled();

    await act(async () => answer({ path: WORKSPACE, git: snapshot() }));
    await flush();
    expect(setLayout).toHaveBeenCalledTimes(1);
    expect(setLayout.mock.calls[0]![0].nodes.some((n) => n.kind === "git")).toBe(true);
  });

  it("Git 查得太慢不拖住画布：等待窗口一过就先排布，结果回来后再补上 Git 节点", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let answer!: (response: GitResponse) => void;
    vi.spyOn(api, "git").mockImplementation(() => new Promise<GitResponse>((resolve) => (answer = resolve)));
    const engine = new SceneEngine();
    const setLayout = vi.spyOn(engine, "setLayout");
    open(summaryOf("ses_a", "codex:a", WORKSPACE));
    act(() => root.render(<Overview engine={engine} />));
    expect(setLayout).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(GIT_FIRST_WAIT_MS + 50);
    });
    expect(setLayout).toHaveBeenCalledTimes(1);
    expect(setLayout.mock.calls[0]![0].nodes.some((n) => n.kind === "git")).toBe(false);
    // Folder 只依赖来源自带的目录字符串，不等 Git：先排布时它已经在，Git 迟到只是在它左边补一张卡。
    expect(setLayout.mock.calls[0]![0].nodes.filter((n) => n.kind === "folder").map((n) => n.id)).toEqual([`folder:${WORKTREE}`]);
    expect(folderIds()).toEqual([`folder:${WORKTREE}`]);
    expect(hasLeftPort(folderNodes()[0])).toBe(false);
    const folderCard = folderNodes()[0];

    await act(async () => answer({ path: WORKSPACE, git: snapshot() }));
    await flush();
    expect(setLayout.mock.lastCall![0].nodes.some((n) => n.kind === "git")).toBe(true);
    expect(gitNodes()).toHaveLength(1);
    // 同一个 Folder 节点（没有被拆掉重建），只是左边多了一条连线，端口亮起。
    expect(folderNodes()).toHaveLength(1);
    expect(folderNodes()[0]).toBe(folderCard);
    expect(hasLeftPort(folderCard)).toBe(true);
  });

  it("不是 Git 仓库的目录：没有 Git 节点，Folder 直接连到来源、自己没有入口；没有工作目录的来源既没有 Folder 也没有入口", async () => {
    vi.spyOn(api, "git").mockImplementation(async (path): Promise<GitResponse> => ({ path, git: null, reason: "not_repo" }));
    const engine = new SceneEngine();
    const setLayout = vi.spyOn(engine, "setLayout");
    open(summaryOf("ses_a", "codex:a", WORKSPACE), summaryOf("ses_b", "console:b"));
    act(() => root.render(<Overview engine={engine} />));
    await flush();

    expect(api.git).toHaveBeenCalledTimes(1);
    expect(gitNodes()).toHaveLength(0);
    expect(container.querySelectorAll(".node.origin")).toHaveLength(2);
    expect(folderIds()).toEqual([`folder:${WORKTREE}`]);
    expect(hasLeftPort(folderNodes()[0])).toBe(false);
    // 左边端口亮着的来源只有“有 Folder 的来源”一个；控制台来源没有。
    expect(litOrigins()).toBe(1);
    expect(hasLeftPort(container.querySelector(".node.origin[data-node-id='origin:console:b']"))).toBe(false);
    const layout = setLayout.mock.lastCall![0];
    expect(links(layout).map((edge) => edge.id)).toEqual([`folder:${WORKTREE}>origin:codex:a`]);
    expectPageMatches(layout);
  });

  it("窄画布（宿主侧栏）里不画 Git 节点，也不画 Folder 节点：工作目录仍写在来源卡上，信息不消失", async () => {
    wide = false;
    vi.spyOn(api, "git").mockImplementation(async (path): Promise<GitResponse> => ({ path, git: snapshot() }));
    const engine = new SceneEngine();
    const setLayout = vi.spyOn(engine, "setLayout");
    open(summaryOf("ses_a", "codex:a", WORKSPACE));
    act(() => root.render(<Overview engine={engine} />));
    await flush();

    expect(gitNodes()).toHaveLength(0);
    expect(folderNodes()).toHaveLength(0);
    expect(hasLeftPort(container.querySelector(".node.origin"))).toBe(false);
    expect(setLayout.mock.lastCall![0].nodes.some((n) => n.kind === "git" || n.kind === "folder")).toBe(false);
    // 来源卡保留目录行（主行是目录名，次行是时间）。
    expect(container.querySelector(".node.origin .o-main .o-text")?.textContent).toBe("Ensemble");
    expect(container.querySelector(".node.origin .o-sub time")).not.toBeNull();
  });

  it("窄画布里共用同一个工作树的来源也不画 Git 节点，来源节点没有入口、也没有连线", async () => {
    wide = false;
    serve({ [WORKSPACE]: WORKSPACE });
    const engine = new SceneEngine();
    const setLayout = vi.spyOn(engine, "setLayout");
    open(summaryOf("ses_a", "codex:a", WORKSPACE), summaryOf("ses_b", "cursor:b", WORKSPACE), summaryOf("ses_c", "pi:c", WORKSPACE));
    act(() => root.render(<Overview engine={engine} />));
    await flush();

    expect(api.git).toHaveBeenCalledTimes(1);
    expect(gitNodes()).toHaveLength(0);
    expect(folderNodes()).toHaveLength(0);
    expect(litOrigins()).toBe(0);
    const layout = setLayout.mock.lastCall![0];
    expect(links(layout)).toHaveLength(0);
    expectPageMatches(layout);
    // 三张来源卡各自保留目录行。
    expect([...container.querySelectorAll(".node.origin .o-main .o-text")].map((el) => el.textContent)).toEqual(["Ensemble", "Ensemble", "Ensemble"]);
  });

  it("目录读取失败又从没成功过：没有 Git 节点；Folder 不依赖 Git，照常画出；读取不到不会让画布报错", async () => {
    vi.spyOn(api, "git").mockRejectedValue(new Error("offline"));
    open(summaryOf("ses_a", "codex:a", WORKSPACE));
    act(() => root.render(<Overview engine={new SceneEngine()} />));
    await flush();
    expect(gitNodes()).toHaveLength(0);
    expect(folderIds()).toEqual([`folder:${WORKTREE}`]);
    expect(container.querySelectorAll(".node.origin")).toHaveLength(1);
  });

  describe("同一个真实 Git 工作树只有一张卡", () => {
    it("三个 Main Agent 来自同一个工作树、同一个目录：只查一次，只有一张 Git 卡、一张 Folder 卡；Git 连 Folder，Folder 向三个来源各一条线", async () => {
      serve({ [WORKSPACE]: WORKSPACE });
      const engine = new SceneEngine();
      const setLayout = vi.spyOn(engine, "setLayout");
      open(summaryOf("ses_a", "codex:a", WORKSPACE), summaryOf("ses_b", "cursor:b", WORKSPACE), summaryOf("ses_c", "pi:c", WORKSPACE));
      act(() => root.render(<Overview engine={engine} />));
      await flush();

      expect(api.git).toHaveBeenCalledTimes(1);
      expect(gitIds()).toEqual([`git:${WORKTREE}`]);
      expect(folderIds()).toEqual([`folder:${WORKTREE}`]);
      expect(container.querySelectorAll(".node.origin")).toHaveLength(3);
      expect(litOrigins()).toBe(3);
      // Folder 头部右端写出用它的 Main Agent 个数。
      expect(folderNodes()[0]!.querySelector(".o-count")?.textContent).toBe("3 个 Main Agent");

      const layout = setLayout.mock.lastCall![0];
      expect(layout.nodes.filter((n) => n.kind === "git")).toHaveLength(1);
      expect(layout.nodes.filter((n) => n.kind === "folder")).toHaveLength(1);
      expect(links(layout).map((edge) => edge.id).sort()).toEqual([
        `folder:${WORKTREE}>origin:codex:a`,
        `folder:${WORKTREE}>origin:cursor:b`,
        `folder:${WORKTREE}>origin:pi:c`,
        `git:${WORKTREE}>folder:${WORKTREE}`,
      ]);
      expect(new Set(originLinks(layout).map((edge) => edge.from))).toEqual(new Set([`folder:${WORKTREE}`]));
      expect(gitLinks(layout).map((edge) => edge.to)).toEqual([`folder:${WORKTREE}`]);
      // 每个来源节点只有这一条进线；Git 在最左、Folder 居中，三个来源同在它们右边的一列。
      const git = layout.nodes.find((n) => n.kind === "git")!;
      const dir = layout.nodes.find((n) => n.kind === "folder")!;
      const origins = layout.nodes.filter((n) => n.kind === "origin");
      expect(origins).toHaveLength(3);
      expect(dir.x).toBeGreaterThan(git.x + git.w);
      for (const origin of origins) {
        expect(layout.edges.filter((edge) => edge.to === origin.id)).toHaveLength(1);
        expect(origin.x).toBeGreaterThan(dir.x + dir.w);
      }
      expect(new Set(origins.map((origin) => origin.x)).size).toBe(1);
      expectPageMatches(layout);
    });

    it("同一个根目录下的不同子目录：各查各的目录，读到的根目录一样，仍是一张 Git 卡；每个目录各一张 Folder，Git 连到每一张", async () => {
      const web = `${WORKSPACE}\\packages\\web`;
      const server = `${WORKSPACE}\\src\\server`;
      serve({ [web]: WORKSPACE, [server]: WORKSPACE, [WORKSPACE]: WORKSPACE });
      const engine = new SceneEngine();
      const setLayout = vi.spyOn(engine, "setLayout");
      open(summaryOf("ses_a", "codex:a", web), summaryOf("ses_b", "cursor:b", server), summaryOf("ses_c", "pi:c", WORKSPACE));
      act(() => root.render(<Overview engine={engine} />));
      await flush();

      expect(api.git).toHaveBeenCalledTimes(3);
      expect(gitIds()).toEqual([`git:${WORKTREE}`]);
      expect(folderIds()).toEqual([`folder:${WORKTREE}`, `folder:${WORKTREE}/packages/web`, `folder:${WORKTREE}/src/server`]);
      expect(folderNodes().every(hasLeftPort)).toBe(true);
      expect(litOrigins()).toBe(3);
      const layout = setLayout.mock.lastCall![0];
      // Git → 每个 Folder（3 条）+ Folder → 各自的来源（3 条）。
      expect(gitLinks(layout)).toHaveLength(3);
      expect(originLinks(layout)).toHaveLength(3);
      expect(links(layout)).toHaveLength(6);
      expectPageMatches(layout);
    });

    it("Windows 路径写法不同（盘符与目录大小写、斜杠方向、结尾斜杠、扩展长度前缀）：仍是同一个工作树，同一个目录仍是同一张 Folder", async () => {
      const lower = "c:/users/alice/desktop/ensemble/packages/web";
      const upper = "C:\\USERS\\ALICE\\DESKTOP\\ENSEMBLE\\src";
      serve({ [WORKSPACE]: WORKSPACE, [lower]: "c:/users/alice/desktop/ensemble/", [upper]: "\\\\?\\C:\\Users\\alice\\Desktop\\Ensemble" });
      const engine = new SceneEngine();
      const setLayout = vi.spyOn(engine, "setLayout");
      open(summaryOf("ses_a", "codex:a", WORKSPACE), summaryOf("ses_b", "cursor:b", lower), summaryOf("ses_c", "pi:c", upper));
      act(() => root.render(<Overview engine={engine} />));
      await flush();

      expect(gitIds()).toEqual([`git:${WORKTREE}`]);
      // 三个不同的目录（根、packages/web、src），各一张 Folder；每个来源各一条进线。
      expect(folderIds()).toEqual([`folder:${WORKTREE}`, `folder:${WORKTREE}/packages/web`, `folder:${WORKTREE}/src`]);
      expect(originLinks(setLayout.mock.lastCall![0])).toHaveLength(3);
      expect(gitLinks(setLayout.mock.lastCall![0])).toHaveLength(3);
      expect(litOrigins()).toBe(3);
    });

    it("独立的 clone / worktree：仓库名、远程、分支和 HEAD 完全相同，也各是各的卡，各自一条连线", async () => {
      const cloneA = "C:\\work\\a\\Ensemble";
      const cloneB = "C:\\work\\b\\Ensemble";
      serve({ [cloneA]: cloneA, [cloneB]: cloneB }, { remote: { name: "origin", url: "github.com/alice/ensemble" } });
      const engine = new SceneEngine();
      const setLayout = vi.spyOn(engine, "setLayout");
      open(summaryOf("ses_a", "codex:a", cloneA), summaryOf("ses_b", "cursor:b", cloneB));
      act(() => root.render(<Overview engine={engine} />));
      await flush();

      expect(gitIds()).toEqual(["git:c:/work/a/ensemble", "git:c:/work/b/ensemble"]);
      // 两张卡上的字一模一样（头部的仓库名、分支、提交、改动数），区分它们的只有各自的根目录。
      const [first, second] = gitNodes();
      expect(first!.querySelector(".o-head")?.textContent).toBe(second!.querySelector(".o-head")?.textContent);
      expect(first!.querySelector(".o-body")?.textContent).toBe(second!.querySelector(".o-body")?.textContent);
      expect(first!.getAttribute("data-tip")).not.toBe(second!.getAttribute("data-tip"));

      const layout = setLayout.mock.lastCall![0];
      expect(folderIds()).toEqual(["folder:c:/work/a/ensemble", "folder:c:/work/b/ensemble"]);
      expect(links(layout).map((edge) => edge.id).sort()).toEqual([
        "folder:c:/work/a/ensemble>origin:codex:a",
        "folder:c:/work/b/ensemble>origin:cursor:b",
        "git:c:/work/a/ensemble>folder:c:/work/a/ensemble",
        "git:c:/work/b/ensemble>folder:c:/work/b/ensemble",
      ]);
      expectPageMatches(layout);
    });

    it("几个来源在同一个工作树、另一个在独立的工作树：两张 Git 卡、两张 Folder 卡，Git → Folder 两条、Folder → 来源三条，同一个工作树的来源挨在一起", async () => {
      const other = "C:\\work\\Ensemble-feature";
      serve({ [WORKSPACE]: WORKSPACE, [other]: other });
      const engine = new SceneEngine();
      const setLayout = vi.spyOn(engine, "setLayout");
      // 创建顺序是 主工作树、feature、主工作树：同一个工作树的两个来源不会被夹在中间。
      open(summaryOf("ses_a", "codex:a", WORKSPACE), summaryOf("ses_b", "cursor:b", other), summaryOf("ses_c", "pi:c", WORKSPACE));
      act(() => root.render(<Overview engine={engine} />));
      await flush();

      expect(gitIds()).toEqual(["git:c:/users/alice/desktop/ensemble", "git:c:/work/ensemble-feature"]);
      expect(folderIds()).toEqual(["folder:c:/users/alice/desktop/ensemble", "folder:c:/work/ensemble-feature"]);
      const layout = setLayout.mock.lastCall![0];
      expect(gitLinks(layout)).toHaveLength(2);
      expect(originLinks(layout)).toHaveLength(3);
      expect(links(layout)).toHaveLength(5);
      const top = (key: string): number => layout.nodes.find((n) => n.id === `origin:${key}`)!.y;
      expect(Math.abs(top("codex:a") - top("pi:c"))).toBeLessThan(Math.abs(top("codex:a") - top("cursor:b")));
      expectPageMatches(layout);
    });

    it("卡片的 id 不随来源的先后、增减而变：来源走了、换了、又来了，仍是同一张卡（同一个节点）", async () => {
      serve({ [WORKSPACE]: WORKSPACE });
      const engine = new SceneEngine();
      const setLayout = vi.spyOn(engine, "setLayout");
      const a = summaryOf("ses_a", "codex:a", WORKSPACE);
      const b = summaryOf("ses_b", "cursor:b", WORKSPACE);
      const c = summaryOf("ses_c", "pi:c", WORKSPACE);
      open(a, b);
      act(() => root.render(<Overview engine={engine} />));
      await flush();
      const card = gitNodes()[0]!;
      const folderCard = folderNodes()[0]!;
      expect(gitIds()).toEqual([`git:${WORKTREE}`]);
      expect(folderIds()).toEqual([`folder:${WORKTREE}`]);
      expect(folderCard.querySelector(".o-count")?.textContent).toBe("2 个 Main Agent");
      const onlyFolder = (): void => expect(folderNodes().map((node) => node === folderCard)).toEqual([true]);

      // 排在最前的来源走了：两张卡仍是同一个节点，只剩一条来源连线；Folder 头部的个数跟着变（只剩一个就不写）。
      open(b);
      await flush();
      expectOnlyCard(card);
      onlyFolder();
      expect(gitIds()).toEqual([`git:${WORKTREE}`]);
      expect(originLinks(setLayout.mock.lastCall![0]).map((edge) => edge.to)).toEqual(["origin:cursor:b"]);
      expect(gitLinks(setLayout.mock.lastCall![0])).toHaveLength(1);
      expect(folderCard.querySelector(".o-count")).toBeNull();

      // 换成另一批来源，其中有排在最前的新来源：还是这两张。
      open(c, b);
      await flush();
      expectOnlyCard(card);
      onlyFolder();
      expect(originLinks(setLayout.mock.lastCall![0])).toHaveLength(2);
      expect(links(setLayout.mock.lastCall![0])).toHaveLength(3);

      // 来源全部离开后两张卡也离开；回来时用的仍是同一个 id。
      open();
      await flush();
      expect(gitNodes()).toHaveLength(0);
      expect(folderNodes()).toHaveLength(0);
      open(c, a, b);
      await flush();
      expect(gitIds()).toEqual([`git:${WORKTREE}`]);
      expect(folderIds()).toEqual([`folder:${WORKTREE}`]);
      expect(originLinks(setLayout.mock.lastCall![0])).toHaveLength(3);
      expect(links(setLayout.mock.lastCall![0])).toHaveLength(4);
      expectPageMatches(setLayout.mock.lastCall![0]);
    });

    it("同一个工作树里有的来源读不到 Git（不是仓库、没有工作目录）：只有在工作树里的目录才连到 Git；读不到的目录仍有自己的 Folder，没有工作目录的来源没有 Folder", async () => {
      serve({ [WORKSPACE]: WORKSPACE, [`${WORKSPACE}\\sub`]: WORKSPACE });
      const engine = new SceneEngine();
      const setLayout = vi.spyOn(engine, "setLayout");
      open(
        summaryOf("ses_a", "codex:a", WORKSPACE),
        summaryOf("ses_b", "cursor:b", `${WORKSPACE}\\sub`),
        summaryOf("ses_c", "pi:c", "C:\\plain"),
        summaryOf("ses_d", "console:d"),
      );
      act(() => root.render(<Overview engine={engine} />));
      await flush();

      expect(container.querySelectorAll(".node.origin")).toHaveLength(4);
      expect(gitIds()).toEqual([`git:${WORKTREE}`]);
      expect(folderIds()).toEqual(["folder:c:/plain", `folder:${WORKTREE}`, `folder:${WORKTREE}/sub`]);
      // a、b、c 各有 Folder 接在左边（c 的 Folder 不在 Git 里）；d 没有工作目录，左边没有连线。
      expect(litOrigins()).toBe(3);
      const plain = folderNodes().find((node) => node.getAttribute("data-node-id") === "folder:c:/plain")!;
      expect(hasLeftPort(plain)).toBe(false);
      expect(folderNodes().filter(hasLeftPort)).toHaveLength(2);
      const layout = setLayout.mock.lastCall![0];
      expect(gitLinks(layout).map((edge) => edge.to).sort()).toEqual([`folder:${WORKTREE}`, `folder:${WORKTREE}/sub`]);
      expect(originLinks(layout).map((edge) => edge.to).sort()).toEqual(["origin:codex:a", "origin:cursor:b", "origin:pi:c"]);
      expect(layout.edges.filter((edge) => edge.to === "origin:console:d")).toHaveLength(0);
      expect(layout.edges.filter((edge) => edge.to === "folder:c:/plain")).toHaveLength(0);
      expectPageMatches(layout);
    });
  });

  describe("读数刷新", () => {
    const fakeTimers = (): void => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    };
    const poll = async (): Promise<void> => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(GIT_IDLE_MS + 50);
      });
      await flush();
    };

    it("分支、改动数变了：卡片上的字跟着变，但画布不重新排布", async () => {
      fakeTimers();
      let branch = "main";
      vi.spyOn(api, "git").mockImplementation(async (path): Promise<GitResponse> => ({ path, git: snapshot({ branch, changes: { files: branch === "main" ? 2 : 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 } }) }));
      const engine = new SceneEngine();
      const setLayout = vi.spyOn(engine, "setLayout");
      open(summaryOf("ses_a", "codex:a", WORKSPACE), summaryOf("ses_b", "cursor:b", `${WORKSPACE}\\sub`));
      act(() => root.render(<Overview engine={engine} />));
      await flush();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(GIT_FIRST_WAIT_MS + 50);
      });
      await flush();
      expect(gitNodes()[0]!.querySelector(".o-main .o-text")?.textContent).toBe("main");
      const layouts = setLayout.mock.calls.length;
      const card = gitNodes()[0];

      branch = "dev";
      await poll();
      expectOnlyCard(card);
      expect(gitNodes()[0]!.querySelector(".o-main .o-text")?.textContent).toBe("dev");
      expect(gitNodes()[0]!.querySelector(".o-title")?.textContent).toBe("工作区干净");
      expect(setLayout).toHaveBeenCalledTimes(layouts);
    });

    it("同一个工作树的一份读数失败了、另一份还在：卡片不标成旧的；全都失败才标旧；恢复后恢复；全程不重排", async () => {
      fakeTimers();
      const sub = `${WORKSPACE}\\sub`;
      const failing = new Set<string>();
      vi.spyOn(api, "git").mockImplementation(async (path): Promise<GitResponse> => {
        if (failing.has(path)) throw new Error("offline");
        return { path, git: snapshot() };
      });
      const engine = new SceneEngine();
      const setLayout = vi.spyOn(engine, "setLayout");
      open(summaryOf("ses_a", "codex:a", WORKSPACE), summaryOf("ses_b", "cursor:b", sub));
      act(() => root.render(<Overview engine={engine} />));
      await flush();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(GIT_FIRST_WAIT_MS + 50);
      });
      await flush();
      expect(gitIds()).toEqual([`git:${WORKTREE}`]);
      expect(gitNodes()[0]!.hasAttribute("data-stale")).toBe(false);
      const layouts = setLayout.mock.calls.length;

      failing.add(sub);
      await poll();
      expect(gitIds()).toEqual([`git:${WORKTREE}`]);
      expect(gitNodes()[0]!.hasAttribute("data-stale")).toBe(false);
      expect(litOrigins()).toBe(2);

      failing.add(WORKSPACE);
      await poll();
      expect(gitIds()).toEqual([`git:${WORKTREE}`]);
      expect(gitNodes()[0]!.hasAttribute("data-stale")).toBe(true);
      expect(gitNodes()[0]!.querySelector(".g-stale")).not.toBeNull();
      expect(litOrigins()).toBe(2);

      failing.clear();
      await poll();
      expect(gitNodes()[0]!.hasAttribute("data-stale")).toBe(false);
      expect(gitNodes()).toHaveLength(1);
      expect(setLayout).toHaveBeenCalledTimes(layouts);
    });

    it("一个目录后来读到不是仓库了：它的 Folder 不再接到 Git 上（但仍在、仍连着自己的来源），其余目录仍连着同一张 Git 卡", async () => {
      fakeTimers();
      const sub = `${WORKSPACE}\\sub`;
      let gone = false;
      vi.spyOn(api, "git").mockImplementation(async (path): Promise<GitResponse> =>
        gone && path === sub ? { path, git: null, reason: "not_repo" } : { path, git: snapshot() });
      const engine = new SceneEngine();
      const setLayout = vi.spyOn(engine, "setLayout");
      open(summaryOf("ses_a", "codex:a", WORKSPACE), summaryOf("ses_b", "cursor:b", sub));
      act(() => root.render(<Overview engine={engine} />));
      await flush();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(GIT_FIRST_WAIT_MS + 50);
      });
      await flush();
      // Git → 两个 Folder，两个 Folder → 各自的来源。
      expect(links(setLayout.mock.lastCall![0])).toHaveLength(4);
      const card = gitNodes()[0];
      expect(folderNodes().every(hasLeftPort)).toBe(true);

      gone = true;
      await poll();
      expectOnlyCard(card);
      // 两个来源仍各有自己的 Folder 接在左边；只是 sub 的 Folder 左边不再接着 Git。
      expect(litOrigins()).toBe(2);
      expect(folderIds()).toEqual([`folder:${WORKTREE}`, `folder:${WORKTREE}/sub`]);
      expect(hasLeftPort(folderNodes().find((node) => node.getAttribute("data-node-id") === `folder:${WORKTREE}/sub`))).toBe(false);
      expect(hasLeftPort(folderNodes().find((node) => node.getAttribute("data-node-id") === `folder:${WORKTREE}`))).toBe(true);
      const layout = setLayout.mock.lastCall![0];
      expect(gitLinks(layout).map((edge) => edge.to)).toEqual([`folder:${WORKTREE}`]);
      expect(originLinks(layout).map((edge) => edge.to).sort()).toEqual(["origin:codex:a", "origin:cursor:b"]);
      expectPageMatches(layout);
    });

    it("同一个目录的两种写法读到不同的根目录（都读成功）：不画 Git 归属，Folder 仍是一张、连着两个来源；冲突期间刷新不重排；旧的一份追上后才接上 Git", async () => {
      fakeTimers();
      // 两种写法是同一张 Folder，却各被查询一次：其中一份读到的根目录还停在目录变化之前。
      const lower = "c:/users/alice/desktop/ensemble/";
      const above = "C:\\Users\\alice\\Desktop";
      let behind = true;
      vi.spyOn(api, "git").mockImplementation(async (path): Promise<GitResponse> => ({ path, git: snapshot({ root: path === lower && behind ? above : WORKSPACE }) }));
      const engine = new SceneEngine();
      const setLayout = vi.spyOn(engine, "setLayout");
      open(summaryOf("ses_a", "codex:a", WORKSPACE), summaryOf("ses_b", "cursor:b", lower));
      act(() => root.render(<Overview engine={engine} />));
      await flush();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(GIT_FIRST_WAIT_MS + 50);
      });
      await flush();

      expect(api.git).toHaveBeenCalledTimes(2);
      expect(gitNodes()).toHaveLength(0);
      expect(folderIds()).toEqual([`folder:${WORKTREE}`]);
      expect(hasLeftPort(folderNodes()[0])).toBe(false);
      expect(litOrigins()).toBe(2);
      const layout = setLayout.mock.lastCall![0];
      expect(links(layout).map((edge) => edge.id).sort()).toEqual([`folder:${WORKTREE}>origin:codex:a`, `folder:${WORKTREE}>origin:cursor:b`]);
      expectPageMatches(layout);

      const layouts = setLayout.mock.calls.length;
      await poll();
      expect(gitNodes()).toHaveLength(0);
      expect(setLayout).toHaveBeenCalledTimes(layouts);

      behind = false;
      await poll();
      expect(gitIds()).toEqual([`git:${WORKTREE}`]);
      expect(folderIds()).toEqual([`folder:${WORKTREE}`]);
      expect(hasLeftPort(folderNodes()[0])).toBe(true);
      expect(links(setLayout.mock.lastCall![0]).map((edge) => edge.id).sort()).toEqual([
        `folder:${WORKTREE}>origin:codex:a`,
        `folder:${WORKTREE}>origin:cursor:b`,
        `git:${WORKTREE}>folder:${WORKTREE}`,
      ]);
      expectPageMatches(setLayout.mock.lastCall![0]);
    });
  });
});
