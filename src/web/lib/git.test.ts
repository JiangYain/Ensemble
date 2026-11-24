import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitResponse, GitSnapshot } from "@shared/protocol";
import type { SessionSummary } from "@shared/types";
import { GIT_BUSY_MS, GIT_FIRST_WAIT_MS, GIT_IDLE_MS, GitWatcher, groupGit, planGit, resolveFolderGit, worktreeKey, type FolderGit, type GitEntry, type GitReading } from "./git";

function snapshot(branch = "main", extra: Partial<GitSnapshot> = {}): GitSnapshot {
  return {
    root: "C:/repo",
    branch,
    detached: false,
    changes: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    checkedAt: new Date().toISOString(),
    ...extra,
  };
}
const found = (path: string, git: GitSnapshot): GitResponse => ({ path, git });
const absent = (path: string, reason: GitResponse["reason"]): GitResponse => ({ path, git: null, reason });

const settle = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

describe("GitWatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function watch(load: (path: string) => Promise<GitResponse>, extra: { visible?: () => boolean } = {}) {
    return new GitWatcher({ load, ...extra });
  }

  it("同一个目录只查一次，读到之后出现在视图里", async () => {
    const load = vi.fn(async (path: string) => found(path, snapshot()));
    const watcher = watch(load);
    watcher.setTargets([{ workspace: "C:/repo", busy: false }, { workspace: "C:/repo", busy: true }]);
    await settle();

    expect(load).toHaveBeenCalledTimes(1);
    expect(watcher.getView().entries.get("C:/repo")).toMatchObject({ stale: false, git: { branch: "main" } });
    expect(watcher.getView().tracked.has("C:/repo")).toBe(true);
    watcher.stop();
  });

  it("不是仓库、目录不存在：没有条目，也不再算“还在等”；读到之前它们是 pending", async () => {
    const watcher = watch(async (path) => absent(path, path.startsWith("C:/gone") ? "missing" : "not_repo"));
    watcher.setTargets([{ workspace: "C:/plain", busy: false }, { workspace: "C:/gone", busy: false }]);
    expect(watcher.getView().pending).toBe(true);
    await settle();

    expect(watcher.getView().entries.size).toBe(0);
    expect(watcher.getView().pending).toBe(false);
    watcher.stop();
  });

  it("有会话在运行时每 4 秒读一次，否则每 15 秒读一次", async () => {
    const load = vi.fn(async (path: string) => found(path, snapshot()));
    const watcher = watch(load);
    watcher.setTargets([{ workspace: "C:/busy", busy: true }, { workspace: "C:/idle", busy: false }]);
    await settle();
    expect(load).toHaveBeenCalledTimes(2);

    await settle(GIT_BUSY_MS);
    expect(load.mock.calls.filter(([path]) => path === "C:/busy")).toHaveLength(2);
    expect(load.mock.calls.filter(([path]) => path === "C:/idle")).toHaveLength(1);

    await settle(GIT_IDLE_MS - GIT_BUSY_MS);
    expect(load.mock.calls.filter(([path]) => path === "C:/idle")).toHaveLength(2);
    watcher.stop();
  });

  it("运行状态一变（开始 / 结束）就马上再读一次：文件刚改完，不等下一轮", async () => {
    const load = vi.fn(async (path: string) => found(path, snapshot()));
    const watcher = watch(load);
    watcher.setTargets([{ workspace: "C:/repo", busy: false }]);
    await settle();
    expect(load).toHaveBeenCalledTimes(1);

    watcher.setTargets([{ workspace: "C:/repo", busy: true }]);
    await settle();
    expect(load).toHaveBeenCalledTimes(2);

    // 状态没变就不重复读。
    watcher.setTargets([{ workspace: "C:/repo", busy: true }]);
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    watcher.stop();
  });

  it("读取失败时保留上一次的状态并标成旧的；下次读到了就恢复；确认不是仓库了才拿掉", async () => {
    const answers: (GitResponse | Error)[] = [found("C:/repo", snapshot("main")), absent("C:/repo", "timeout"), new Error("down"), found("C:/repo", snapshot("dev")), absent("C:/repo", "not_repo")];
    const load = vi.fn(async () => {
      const next = answers.shift()!;
      if (next instanceof Error) throw next;
      return next;
    });
    const watcher = watch(load);
    watcher.setTargets([{ workspace: "C:/repo", busy: true }]);
    await settle();
    expect(watcher.getView().entries.get("C:/repo")).toMatchObject({ stale: false, git: { branch: "main" } });

    await settle(GIT_BUSY_MS);
    expect(watcher.getView().entries.get("C:/repo")).toMatchObject({ stale: true, git: { branch: "main" } });
    await settle(GIT_BUSY_MS);
    expect(watcher.getView().entries.get("C:/repo")).toMatchObject({ stale: true, git: { branch: "main" } });

    await settle(GIT_BUSY_MS);
    expect(watcher.getView().entries.get("C:/repo")).toMatchObject({ stale: false, git: { branch: "dev" } });

    await settle(GIT_BUSY_MS);
    expect(watcher.getView().entries.has("C:/repo")).toBe(false);
    watcher.stop();
  });

  it("从来没读成功过的目录，失败了也不会凭空出现节点", async () => {
    const watcher = watch(async (path) => absent(path, "error"));
    watcher.setTargets([{ workspace: "C:/repo", busy: false }]);
    await settle();
    expect(watcher.getView().entries.size).toBe(0);
    expect(watcher.getView().pending).toBe(false);
    watcher.stop();
  });

  it("不在名单里的目录停止轮询，条目一并拿掉", async () => {
    const load = vi.fn(async (path: string) => found(path, snapshot()));
    const watcher = watch(load);
    watcher.setTargets([{ workspace: "C:/a", busy: true }, { workspace: "C:/b", busy: true }]);
    await settle();
    expect([...watcher.getView().entries.keys()].sort()).toEqual(["C:/a", "C:/b"]);

    watcher.setTargets([{ workspace: "C:/a", busy: true }]);
    expect([...watcher.getView().entries.keys()]).toEqual(["C:/a"]);
    load.mockClear();
    await settle(GIT_BUSY_MS);
    expect(load.mock.calls.map(([path]) => path)).toEqual(["C:/a"]);
    watcher.stop();
  });

  it("首次等待有上限：一直不回来的查询，700 毫秒后不再算 pending，并通知订阅者", async () => {
    const watcher = watch(() => new Promise<GitResponse>(() => undefined));
    const listener = vi.fn();
    watcher.subscribe(listener);
    watcher.setTargets([{ workspace: "C:/slow", busy: false }]);
    expect(watcher.getView().pending).toBe(true);

    await settle(GIT_FIRST_WAIT_MS - 50);
    expect(watcher.getView().pending).toBe(true);
    const calls = listener.mock.calls.length;
    await settle(100);
    expect(watcher.getView().pending).toBe(false);
    expect(listener.mock.calls.length).toBeGreaterThan(calls);
    watcher.stop();
  });

  it("慢的读取不会重叠：读的时候又要求再读，等这次回来后补一次", async () => {
    const resolvers: (() => void)[] = [];
    const load = vi.fn(
      (path: string) =>
        new Promise<GitResponse>((resolve) => {
          resolvers.push(() => resolve(found(path, snapshot())));
        }),
    );
    const watcher = watch(load);
    watcher.setTargets([{ workspace: "C:/repo", busy: false }]);
    watcher.setTargets([{ workspace: "C:/repo", busy: true }]);
    await settle();
    expect(load).toHaveBeenCalledTimes(1);

    resolvers.shift()!();
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    resolvers.shift()!();
    await settle();
    expect(watcher.getView().entries.size).toBe(1);
    watcher.stop();
  });

  it("页面不可见时不排下一次轮询，回到可见再补读", async () => {
    let visible = true;
    const load = vi.fn(async (path: string) => found(path, snapshot()));
    const watcher = watch(load, { visible: () => visible });
    watcher.setTargets([{ workspace: "C:/repo", busy: true }]);
    await settle();
    expect(load).toHaveBeenCalledTimes(1);

    visible = false;
    await settle(GIT_BUSY_MS); // 这一轮读完后看到页面不可见，不再排下一次
    expect(load).toHaveBeenCalledTimes(2);
    await settle(GIT_IDLE_MS * 2);
    expect(load).toHaveBeenCalledTimes(2);

    visible = true;
    watcher.resume();
    await settle();
    expect(load).toHaveBeenCalledTimes(3);
    await settle(GIT_BUSY_MS);
    expect(load).toHaveBeenCalledTimes(4);
    watcher.stop();
  });

  it("stop 之后迟到的结果被丢弃，视图清空", async () => {
    let finish: (() => void) | undefined;
    const watcher = watch(
      (path) =>
        new Promise<GitResponse>((resolve) => {
          finish = () => resolve(found(path, snapshot()));
        }),
    );
    watcher.setTargets([{ workspace: "C:/repo", busy: false }]);
    await settle();
    watcher.stop();
    finish!();
    await settle();
    expect(watcher.getView().entries.size).toBe(0);
    expect(watcher.getView().tracked.size).toBe(0);
  });
});

describe("planGit", () => {
  function session(id: string, key: string, phase: string, workspace?: string): SessionSummary {
    return { id, phase, createdAt: "2026-01-01T00:00:00Z", origin: { key, ...(workspace ? { workspace } : {}) } } as unknown as SessionSummary;
  }

  it("每个来源取它第一个会话带的工作目录；没有工作目录的来源不查", () => {
    const plan = planGit([session("a", "codex", "done", "C:/repo"), session("b", "codex", "done", "C:/other"), session("c", "console", "done")]);
    expect(plan.workspaceOf.get("codex")).toBe("C:/repo");
    expect(plan.workspaceOf.has("console")).toBe(false);
    expect(plan.targets).toEqual([{ workspace: "C:/repo", busy: false }]);
  });

  it("多个来源共用一个目录时只查一次；其中任何一个有会话在运行，这个目录就算忙", () => {
    const plan = planGit([session("a", "codex", "done", "C:/repo"), session("b", "cursor", "running", "C:/repo"), session("c", "pi", "done", "C:/solo")]);
    expect(plan.targets).toEqual([
      { workspace: "C:/repo", busy: true },
      { workspace: "C:/solo", busy: false },
    ]);
  });

  it("嵌套的会话（父会话属于别的来源）也算它所属来源的运行状态", () => {
    const plan = planGit([session("a", "codex", "done", "C:/repo"), session("b", "codex", "running", "C:/repo")]);
    expect(plan.targets).toEqual([{ workspace: "C:/repo", busy: true }]);
  });

  it("没有会话时没有要查的目录", () => {
    expect(planGit([]).targets).toEqual([]);
  });
});

describe("worktreeKey · 工作树的身份", () => {
  const same = (...paths: string[]): void => {
    const keys = paths.map(worktreeKey);
    expect(new Set(keys), paths.join(" ≡ ")).toEqual(new Set([keys[0]]));
  };
  const different = (a: string, b: string): void => {
    expect(worktreeKey(a), `${a} ≠ ${b}`).not.toBe(worktreeKey(b));
  };

  it("Windows：正反斜杠、盘符与目录名的大小写、结尾与重复的分隔符，都是同一个目录", () => {
    same("C:\\Users\\alice\\Desktop\\Ensemble", "c:/users/alice/desktop/ensemble", "C:/Users/alice/Desktop/Ensemble/", "C:\\Users\\\\alice\\Desktop\\Ensemble\\", "  C:\\Users\\alice\\Desktop\\Ensemble  ");
    expect(worktreeKey("C:\\Users\\alice\\Desktop\\Ensemble")).toBe("c:/users/alice/desktop/ensemble");
  });

  it("Windows：扩展长度前缀、UNC、`.` 与 `..` 只是写法不同", () => {
    same("C:\\repo", "\\\\?\\C:\\repo", "//?/c:/repo", "C:\\x\\..\\repo", "C:\\.\\repo\\.");
    same("\\\\server\\share\\Repo", "//SERVER/share/repo/", "\\\\?\\UNC\\server\\share\\repo");
    // `..` 不能越过盘符或共享名。
    same("C:\\..\\..\\repo", "C:\\repo");
    same("\\\\server\\share\\..\\repo", "\\\\server\\share\\repo");
  });

  it("盘符根目录与 POSIX 根目录各有稳定的写法", () => {
    same("C:\\", "c:/", "C:");
    expect(worktreeKey("c:/")).toBe("c:/");
    expect(worktreeKey("/")).toBe("/");
    expect(worktreeKey("//server/share")).toBe("//server/share/");
  });

  it("不同的目录不会被抹平：不同盘符、父子目录、名字只差一个后缀、不同的 clone 与 worktree", () => {
    different("C:\\repo", "D:\\repo");
    different("C:\\repo", "C:\\repo\\sub");
    different("C:\\repo", "C:\\repo2");
    different("C:\\work\\a\\Ensemble", "C:\\work\\b\\Ensemble");
    different("C:\\work\\Ensemble", "C:\\work\\Ensemble-feature");
    different("\\\\server\\share\\repo", "\\\\server\\other\\repo");
    different("\\\\server\\share\\repo", "C:\\share\\repo");
  });

  it("POSIX：区分大小写，反斜杠是文件名的一部分；多余的分隔符与 `..` 仍被抹平", () => {
    different("/home/me/Repo", "/home/me/repo");
    different("/home/me/a\\b", "/home/me/a/b");
    same("/home/me/repo", "/home/me/repo/", "/home/me//repo", "/home/me/x/../repo", "/home/./me/repo");
    expect(worktreeKey("/home/me/Repo")).toBe("/home/me/Repo");
  });

  it("没有身份的输入返回空串，不会撞上根目录", () => {
    expect(worktreeKey("")).toBe("");
    expect(worktreeKey("   ")).toBe("");
  });
});

describe("groupGit · 按真实工作树归并", () => {
  const ROOT = "C:\\Users\\alice\\Desktop\\Ensemble";
  const at = (minute: number): string => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
  const entry = (root: string, extra: { checkedAt?: string; branch?: string; stale?: boolean } = {}): GitEntry => ({
    git: snapshot(extra.branch ?? "main", { root, checkedAt: extra.checkedAt ?? at(0) }),
    stale: extra.stale ?? false,
  });
  const workspaces = (pairs: Record<string, string>): ReadonlyMap<string, string> => new Map(Object.entries(pairs));
  const entries = (pairs: Record<string, GitEntry>): ReadonlyMap<string, GitEntry> => new Map(Object.entries(pairs));

  it("同一个目录的几个来源是一组：一张卡，每个来源都在它的来源列表里", () => {
    const groups = groupGit(workspaces({ "codex:a": ROOT, "codex:b": ROOT, "cursor:c": ROOT }), entries({ [ROOT]: entry(ROOT) }));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: "c:/users/alice/desktop/ensemble", origins: ["codex:a", "codex:b", "cursor:c"] });
  });

  it("同一个根目录下的不同子目录（各读各的）也是一组", () => {
    const web = `${ROOT}\\packages\\web`;
    const server = `${ROOT}\\src\\server`;
    const groups = groupGit(
      workspaces({ "codex:a": web, "cursor:b": server, "pi:c": ROOT }),
      entries({ [web]: entry(ROOT), [server]: entry(ROOT), [ROOT]: entry(ROOT) }),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.origins).toEqual(["codex:a", "cursor:b", "pi:c"]);
  });

  it("Windows 路径写法不同（盘符大小写、斜杠方向、结尾斜杠）仍是一组", () => {
    const groups = groupGit(
      workspaces({ "codex:a": "C:\\repo", "cursor:b": "c:/repo/sub", "pi:c": "C:\\repo\\sub2" }),
      entries({ "C:\\repo": entry("C:\\repo"), "c:/repo/sub": entry("c:/repo/"), "C:\\repo\\sub2": entry("\\\\?\\C:\\REPO") }),
    );
    expect(groups.map((group) => group.origins)).toEqual([["codex:a", "cursor:b", "pi:c"]]);
  });

  it("独立的 clone 与 worktree：根目录不同就各是各的，哪怕仓库名、远程、分支和 HEAD 完全相同", () => {
    const same = (root: string): GitEntry => ({
      git: snapshot("main", { root, head: { sha: "a".repeat(40), subject: "同一个提交", committedAt: at(0) }, remote: { name: "origin", url: "github.com/o/ensemble" }, checkedAt: at(0) }),
      stale: false,
    });
    const groups = groupGit(
      workspaces({ "codex:a": "C:\\work\\a\\Ensemble", "cursor:b": "C:\\work\\b\\Ensemble", "pi:c": "C:\\work\\Ensemble-feature" }),
      entries({ "C:\\work\\a\\Ensemble": same("C:\\work\\a\\Ensemble"), "C:\\work\\b\\Ensemble": same("C:\\work\\b\\Ensemble"), "C:\\work\\Ensemble-feature": same("C:\\work\\Ensemble-feature") }),
    );
    expect(groups).toHaveLength(3);
    expect(new Set(groups.map((group) => group.key)).size).toBe(3);
    expect(groups.flatMap((group) => group.origins).sort()).toEqual(["codex:a", "cursor:b", "pi:c"]);
    for (const group of groups) expect(group.origins).toHaveLength(1);
  });

  it("身份只看读到的根目录：不按路径前缀、不按来源 key 去猜", () => {
    // 工作目录在另一个工作树的根目录之下，但自己读到的根目录是自己（子仓库）→ 两组，不会因为路径前缀相同就并进去。
    const nested = groupGit(
      workspaces({ "codex:a": "C:\\repo\\vendor\\lib", "codex:b": "C:\\repo\\src" }),
      entries({ "C:\\repo\\vendor\\lib": entry("C:\\repo\\vendor\\lib"), "C:\\repo\\src": entry("C:\\repo") }),
    );
    expect(nested.map((group) => [group.key, group.origins])).toEqual([
      ["c:/repo", ["codex:b"]],
      ["c:/repo/vendor/lib", ["codex:a"]],
    ]);
    // 宿主、会话 id 各不相同的来源，只要读到的根目录一样，就是一组。
    const mixed = groupGit(
      workspaces({ "codex:thr_1": "C:\\repo", "cursor:conv_9": "C:\\repo\\a", "pi:run-x": "C:\\repo\\b" }),
      entries({ "C:\\repo": entry("C:\\repo"), "C:\\repo\\a": entry("C:\\repo"), "C:\\repo\\b": entry("C:\\repo") }),
    );
    expect(mixed).toHaveLength(1);
  });

  it("读不到 Git 的来源不属于任何一组：没有读到、不是仓库；根目录为空的读数也不凭工作目录去猜", () => {
    const groups = groupGit(
      workspaces({ "codex:a": ROOT, "cursor:b": "C:\\plain", "pi:c": "C:\\pending", "claude:d": "C:\\blank" }),
      entries({ [ROOT]: entry(ROOT), "C:\\blank": entry("") }),
    );
    expect(groups.map((group) => group.origins)).toEqual([["codex:a"]]);
    expect(groupGit(workspaces({ "codex:a": ROOT }), entries({}))).toEqual([]);
    expect(groupGit(workspaces({}), entries({ [ROOT]: entry(ROOT) }))).toEqual([]);
  });

  it("结果与输入的迭代顺序无关：组按工作树 key 排序，来源按字典序", () => {
    const one = groupGit(
      workspaces({ "pi:z": "C:\\b", "codex:a": "C:\\a", "cursor:m": "C:\\b", "claude:k": "C:\\a" }),
      entries({ "C:\\b": entry("C:\\b"), "C:\\a": entry("C:\\a") }),
    );
    const two = groupGit(
      workspaces({ "claude:k": "C:\\a", "cursor:m": "C:\\b", "codex:a": "C:\\a", "pi:z": "C:\\b" }),
      entries({ "C:\\a": entry("C:\\a"), "C:\\b": entry("C:\\b") }),
    );
    expect(one).toEqual(two);
    expect(one.map((group) => group.key)).toEqual(["c:/a", "c:/b"]);
    expect(one.map((group) => group.origins)).toEqual([["claude:k", "codex:a"], ["cursor:m", "pi:z"]]);
  });

  describe("同一个工作树有几份读数时，卡片展示哪一份", () => {
    const sub = `${ROOT}\\sub`;
    const pick = (a: GitEntry, b: GitEntry, order: "ab" | "ba" = "ab"): GitEntry => {
      const pairs = order === "ab" ? { "codex:a": ROOT, "cursor:b": sub } : { "cursor:b": sub, "codex:a": ROOT };
      const [group] = groupGit(workspaces(pairs), entries({ [ROOT]: a, [sub]: b }));
      return group!.entry;
    };

    it("没读失败的优先于旧状态：一份读取失败了、另一份读到了，卡片不显示成旧的", () => {
      const fresh = entry(ROOT, { checkedAt: at(1), branch: "new" });
      const stale = entry(ROOT, { checkedAt: at(5), branch: "old", stale: true });
      expect(pick(stale, fresh)).toBe(fresh);
      expect(pick(fresh, stale)).toBe(fresh);
      expect(pick(stale, fresh, "ba")).toBe(fresh);
    });

    it("同样新鲜时取读得更晚的一份；时间相同按目录名定，不随迭代顺序改变", () => {
      const older = entry(ROOT, { checkedAt: at(1), branch: "older" });
      const newer = entry(ROOT, { checkedAt: at(2), branch: "newer" });
      expect(pick(older, newer)).toBe(newer);
      expect(pick(newer, older, "ba")).toBe(newer);

      const left = entry(ROOT, { checkedAt: at(3), branch: "left" });
      const right = entry(ROOT, { checkedAt: at(3), branch: "right" });
      expect(pick(left, right)).toBe(left); // ROOT 排在 ROOT\sub 前面
      expect(pick(left, right, "ba")).toBe(left);
    });

    it("全都读失败时仍然是一张卡，标成旧的，取其中最近读到的一份", () => {
      const a = entry(ROOT, { checkedAt: at(1), stale: true });
      const b = entry(ROOT, { checkedAt: at(4), stale: true });
      expect(pick(a, b)).toBe(b);
      expect(pick(a, b).stale).toBe(true);
    });
  });

  describe("同一张 Folder 卡（同一个目录的不同写法）的读数互相矛盾时", () => {
    // 两种写法规范化后是同一个目录、同一张 Folder 卡，却各被查询一次、各读一份。
    const upper = "C:\\work\\Repo";
    const lower = "c:/work/repo/";
    const above = "C:\\work";
    const pair = { "codex:a": upper, "cursor:b": lower };
    const summary = (groups: ReturnType<typeof groupGit>) => groups.map((group) => [group.key, group.origins]);

    it("都读成功、根目录却不同：不裁决，这张 Folder 的来源不属于任何一组；谁读得更晚、迭代顺序都不改变结论", () => {
      for (const [x, y] of [[at(1), at(2)], [at(2), at(1)], [at(1), at(1)]] as const) {
        const a = entry(upper, { checkedAt: x });
        const b = entry(above, { checkedAt: y });
        expect(groupGit(workspaces(pair), entries({ [upper]: a, [lower]: b }))).toEqual([]);
        expect(groupGit(workspaces({ "cursor:b": lower, "codex:a": upper }), entries({ [lower]: b, [upper]: a }))).toEqual([]);
      }
    });

    it("冲突只涉及这一张 Folder：同一个工作树里别的目录仍成一组，但不把冲突的来源算进去", () => {
      const sub = `${upper}\\sub`;
      const groups = groupGit(
        workspaces({ ...pair, "pi:c": sub }),
        entries({ [upper]: entry(upper), [lower]: entry(above), [sub]: entry(upper) }),
      );
      expect(summary(groups)).toEqual([["c:/work/repo", ["pi:c"]]]);
    });

    it("读取失败的那份让位给读成功的（它给的只是更早读到的状态），失败的是哪一种写法都一样；同一张 Folder 的来源都归到这一组", () => {
      const fresh = entry(upper, { checkedAt: at(1) });
      const stale = entry(above, { checkedAt: at(9), stale: true });
      for (const [first, second] of [[fresh, stale], [stale, fresh]]) {
        const groups = groupGit(workspaces(pair), entries({ [upper]: first!, [lower]: second! }));
        expect(summary(groups)).toEqual([["c:/work/repo", ["codex:a", "cursor:b"]]]);
        expect(groups[0]!.entry.stale).toBe(false);
      }
    });

    it("全都读失败、根目录又不同：同样不裁决", () => {
      const groups = groupGit(
        workspaces(pair),
        entries({ [upper]: entry(upper, { checkedAt: at(1), stale: true }), [lower]: entry(above, { checkedAt: at(5), stale: true }) }),
      );
      expect(groups).toEqual([]);
    });

    it("只有一种写法读到了（另一种不是仓库、还没读到）：以读到的为准，这张 Folder 的所有来源都在这一组里", () => {
      const groups = groupGit(workspaces(pair), entries({ [upper]: entry(upper) }));
      expect(summary(groups)).toEqual([["c:/work/repo", ["codex:a", "cursor:b"]]]);
    });

    it("冲突不会留下痕迹：旧的那份追上之后，两种写法同归一组", () => {
      expect(groupGit(workspaces(pair), entries({ [upper]: entry(upper, { checkedAt: at(2) }), [lower]: entry(above, { checkedAt: at(1) }) }))).toEqual([]);
      const groups = groupGit(workspaces(pair), entries({ [upper]: entry(upper, { checkedAt: at(2) }), [lower]: entry(upper, { checkedAt: at(3) }) }));
      expect(summary(groups)).toEqual([["c:/work/repo", ["codex:a", "cursor:b"]]]);
    });
  });
});

describe("resolveFolderGit · 一张 Folder 卡的 Git 结论", () => {
  const at = (minute: number): string => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
  const reading = (workspace: string, root: string, extra: { checkedAt?: string; stale?: boolean } = {}): GitReading => ({
    workspace,
    entry: { git: snapshot("main", { root, checkedAt: extra.checkedAt ?? at(0) }), stale: extra.stale ?? false },
  });
  /** 输入的每一种排列都给出同一个结论。 */
  const resolveAll = (readings: readonly GitReading[]): FolderGit[] => {
    const permutations = (list: readonly GitReading[]): GitReading[][] =>
      list.length <= 1 ? [[...list]] : list.flatMap((item, index) => permutations([...list.slice(0, index), ...list.slice(index + 1)]).map((rest) => [item, ...rest]));
    return permutations(readings).map((order) => resolveFolderGit(order));
  };
  const same = (results: readonly FolderGit[]): FolderGit => {
    for (const result of results) expect(result).toEqual(results[0]);
    return results[0]!;
  };

  it("没有读数、或读数的根目录为空（没有身份）：未知", () => {
    expect(resolveFolderGit([])).toEqual({ kind: "unknown" });
    expect(same(resolveAll([reading("C:\\a", ""), reading("C:\\b", "  ")]))).toEqual({ kind: "unknown" });
  });

  it("一份读数、或根目录写法不同但是同一个目录的几份：已知，工作树是规范化后的根目录，依据是其中最可信的一份", () => {
    const only = reading("C:\\repo", "C:\\repo");
    expect(resolveFolderGit([only])).toEqual({ kind: "known", worktree: "c:/repo", evidence: only });

    const old = reading("C:\\repo", "C:\\repo", { checkedAt: at(1) });
    const latest = reading("c:/repo/", "c:/repo/", { checkedAt: at(2) });
    const failed = reading("C:\\repo\\", "\\\\?\\C:\\REPO", { checkedAt: at(9), stale: true });
    const result = same(resolveAll([old, latest, failed]));
    expect(result).toMatchObject({ kind: "known", worktree: "c:/repo" });
    expect((result as Extract<FolderGit, { kind: "known" }>).evidence).toBe(latest);
  });

  it("读成功的根目录不同：冲突，候选是每个根目录里最可信的一份，按工作树 key 排；不比谁读得更晚，也与输入的顺序无关", () => {
    for (const [x, y] of [[at(1), at(2)], [at(2), at(1)], [at(1), at(1)]]) {
      const outer = reading("C:\\work\\a", "C:\\work", { checkedAt: x });
      const inner = reading("C:\\work\\b", "C:\\work\\a", { checkedAt: y });
      const result = same(resolveAll([inner, outer]));
      expect(result.kind).toBe("conflict");
      expect((result as Extract<FolderGit, { kind: "conflict" }>).candidates.map((candidate) => candidate.entry.git.root)).toEqual(["C:\\work", "C:\\work\\a"]);
    }

    const stale = reading("C:\\a", "C:\\one", { checkedAt: at(5), stale: true });
    const newer = reading("C:\\b", "C:\\one", { checkedAt: at(3) });
    const older = reading("C:\\c", "C:\\one", { checkedAt: at(2) });
    const other = reading("C:\\d", "C:\\two", { checkedAt: at(1) });
    const crowded = same(resolveAll([stale, newer, older, other]));
    expect(crowded.kind).toBe("conflict");
    const { candidates } = crowded as Extract<FolderGit, { kind: "conflict" }>;
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toBe(newer);
    expect(candidates[1]).toBe(other);
  });

  it("读失败的读数让位给读成功的：留下的根目录只有一个就是已知；全都失败了才用旧读数，根目录不同仍是冲突", () => {
    const fresh = reading("C:\\a", "C:\\one", { checkedAt: at(1) });
    const stale = reading("C:\\b", "C:\\two", { checkedAt: at(9), stale: true });
    const known = same(resolveAll([fresh, stale]));
    expect(known).toMatchObject({ kind: "known", worktree: "c:/one" });
    expect((known as Extract<FolderGit, { kind: "known" }>).evidence).toBe(fresh);

    expect(same(resolveAll([stale, reading("C:\\c", "C:\\three", { checkedAt: at(2), stale: true })])).kind).toBe("conflict");
    const onlyStale = same(resolveAll([stale]));
    expect(onlyStale).toMatchObject({ kind: "known", worktree: "c:/two" });
  });
});
