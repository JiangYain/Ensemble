import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { GitResponse, GitSnapshot } from "@shared/protocol";
import type { SessionSummary } from "@shared/types";
import { api } from "./api";
import { directoryKey, groupFolders } from "./folder";

/**
 * 来源工作目录的 Git 状态：服务端只在被问到时读一次（只读命令），这里负责“问”：
 * 每个不同的工作目录各自轮询，有会话正在运行时勤一点（文件随时在变），否则松一点；
 * 没有事件可订阅，所以这是一份定期刷新的快照，不是实时流——卡片上写的就是这个意思。
 */

export interface GitTarget {
  workspace: string;
  /** 这个目录的来源下有会话正在运行。 */
  busy: boolean;
}

export interface GitEntry {
  git: GitSnapshot;
  /** 最近一次读取失败（超时、服务出错）：给出的是上一次读到的状态，卡片要如实标出来。 */
  stale: boolean;
}

export interface GitView {
  /** 按工作目录（原样的字符串）索引；不是 Git 仓库或还没读到的目录没有条目。 */
  entries: ReadonlyMap<string, GitEntry>;
  /** 第一批查询还没回来、且等待窗口没到：首次布局值得再等一小会儿，免得 Git 节点晚到、整组被推开。 */
  pending: boolean;
  /** 已经开始查询的工作目录。 */
  tracked: ReadonlySet<string>;
}

export const GIT_BUSY_MS = 4_000;
export const GIT_IDLE_MS = 15_000;
/** 首次布局最多为 Git 查询多等多久。读得再慢的，之后补上。 */
export const GIT_FIRST_WAIT_MS = 700;

interface Slot {
  target: GitTarget;
  entry: GitEntry | undefined;
  settled: boolean;
  since: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  inflight: boolean;
  again: boolean;
}

export interface GitWatcherOptions {
  load?: (path: string) => Promise<GitResponse>;
  busyMs?: number;
  idleMs?: number;
  firstWaitMs?: number;
  now?: () => number;
  /** 页面不可见时不轮询，回到可见再补一次。 */
  visible?: () => boolean;
}

const EMPTY_VIEW: GitView = { entries: new Map(), pending: false, tracked: new Set() };

export class GitWatcher {
  private readonly slots = new Map<string, Slot>();
  private readonly listeners = new Set<() => void>();
  private view: GitView = EMPTY_VIEW;
  private waitTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly load: (path: string) => Promise<GitResponse>;
  private readonly busyMs: number;
  private readonly idleMs: number;
  private readonly firstWaitMs: number;
  private readonly now: () => number;
  private readonly visible: () => boolean;

  constructor(options: GitWatcherOptions = {}) {
    this.load = options.load ?? ((path) => api.git(path));
    this.busyMs = options.busyMs ?? GIT_BUSY_MS;
    this.idleMs = options.idleMs ?? GIT_IDLE_MS;
    this.firstWaitMs = options.firstWaitMs ?? GIT_FIRST_WAIT_MS;
    this.now = options.now ?? Date.now;
    this.visible = options.visible ?? (() => typeof document === "undefined" || document.visibilityState !== "hidden");
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getView = (): GitView => this.view;

  /** 设定要关注的目录（同一目录只查一次）。新增的立刻查；运行状态变了的马上再看一眼；不在名单里的停掉。 */
  setTargets(targets: readonly GitTarget[]): void {
    const next = new Map<string, GitTarget>();
    for (const target of targets) {
      if (!target.workspace) continue;
      const known = next.get(target.workspace);
      next.set(target.workspace, { workspace: target.workspace, busy: target.busy || (known?.busy ?? false) });
    }
    for (const [path, slot] of [...this.slots]) {
      if (next.has(path)) continue;
      if (slot.timer) clearTimeout(slot.timer);
      this.slots.delete(path);
    }
    const started: Slot[] = [];
    const flipped: Slot[] = [];
    for (const [path, target] of next) {
      const slot = this.slots.get(path);
      if (!slot) {
        const fresh: Slot = { target, entry: undefined, settled: false, since: this.now(), timer: undefined, inflight: false, again: false };
        this.slots.set(path, fresh);
        started.push(fresh);
      } else if (slot.target.busy !== target.busy) {
        slot.target = target;
        flipped.push(slot);
      }
    }
    this.publish();
    for (const slot of [...started, ...flipped]) void this.refresh(slot);
  }

  /** 页面回到可见：补上没有排上轮询的目录。 */
  resume(): void {
    for (const slot of this.slots.values()) if (!slot.timer && !slot.inflight) void this.refresh(slot);
  }

  stop(): void {
    for (const slot of this.slots.values()) if (slot.timer) clearTimeout(slot.timer);
    this.slots.clear();
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.waitTimer = undefined;
    this.view = EMPTY_VIEW;
    for (const listener of [...this.listeners]) listener();
  }

  private async refresh(slot: Slot): Promise<void> {
    const workspace = slot.target.workspace;
    if (this.slots.get(workspace) !== slot) return;
    if (slot.inflight) {
      slot.again = true;
      return;
    }
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = undefined;
    slot.inflight = true;
    let response: GitResponse | undefined;
    try {
      response = await this.load(workspace);
    } catch {
      response = undefined;
    }
    slot.inflight = false;
    if (this.slots.get(workspace) !== slot) return;

    if (response?.git) slot.entry = { git: response.git, stale: false };
    else if (response && (response.reason === "not_repo" || response.reason === "missing")) slot.entry = undefined;
    else if (slot.entry && !slot.entry.stale) slot.entry = { git: slot.entry.git, stale: true };
    slot.settled = true;
    this.publish();

    if (slot.again) {
      slot.again = false;
      void this.refresh(slot);
      return;
    }
    if (this.visible()) slot.timer = setTimeout(() => void this.refresh(slot), slot.target.busy ? this.busyMs : this.idleMs);
  }

  private publish(): void {
    const at = this.now();
    const entries = new Map<string, GitEntry>();
    const tracked = new Set<string>();
    let pending = false;
    let remaining = Infinity;
    for (const [path, slot] of this.slots) {
      tracked.add(path);
      if (slot.entry) entries.set(path, slot.entry);
      if (!slot.settled) {
        const left = this.firstWaitMs - (at - slot.since);
        if (left > 0) {
          pending = true;
          remaining = Math.min(remaining, left);
        }
      }
    }
    this.view = { entries, pending, tracked };
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.waitTimer = pending ? setTimeout(() => this.publish(), remaining + 1) : undefined;
    for (const listener of [...this.listeners]) listener();
  }
}

export interface GitPlan {
  targets: GitTarget[];
  /** 来源 key → 它的工作目录；没有工作目录的来源（例如控制台发起的）不在里面。 */
  workspaceOf: ReadonlyMap<string, string>;
}

/**
 * 从会话列表里排出要查的目录。一个来源的工作目录取它第一个会话带的那份（与来源卡片取的是同一份）；
 * 同一目录下只要有一个来源的会话在运行，就算“忙”。
 */
export function planGit(sessions: readonly SessionSummary[]): GitPlan {
  const workspaceOf = new Map<string, string>();
  for (const session of sessions) {
    const { key, workspace } = session.origin;
    if (workspace && !workspaceOf.has(key)) workspaceOf.set(key, workspace);
  }
  const busy = new Map<string, boolean>();
  for (const workspace of workspaceOf.values()) busy.set(workspace, busy.get(workspace) ?? false);
  for (const session of sessions) {
    const workspace = workspaceOf.get(session.origin.key);
    if (workspace && session.phase === "running") busy.set(workspace, true);
  }
  return { targets: [...busy].map(([workspace, isBusy]) => ({ workspace, busy: isBusy })), workspaceOf };
}

// ───────────────────────── 工作树的身份与分组 ─────────────────────────

/**
 * 一个真实 Git 工作树的身份：`GitSnapshot.root`（服务端 `git rev-parse --show-toplevel` 读到的根目录）规范化后的写法。
 * 来源的工作目录、请求用的 cwd、来源 id、分支、提交、远程都不参与——它们相同并不说明是同一个工作树：
 * 两个 clone、或主工作树与 `git worktree add` 出来的工作树，仓库名、远程、分支和 HEAD 都可以完全一样，根目录却不同，各是各的。
 *
 * 规范化本身（“同一个目录的不同写法”怎么抹平、什么不抹平）与 Git 无关，和 Folder 节点共用 lib/folder 的 directoryKey。
 * `root` 总是服务端给出的绝对路径；空串没有身份，返回空串。
 */
export function worktreeKey(root: string): string {
  return directoryKey(root);
}

/** 画布上的一张 Git 卡：一个真实的工作树，和所有指向它的来源（Main Agent）。 */
export interface GitGroup {
  /** 工作树的稳定标识（见 worktreeKey）。卡片的节点 id 由它得来，不随来源的先后、增减而变。 */
  key: string;
  /** 卡片展示的快照：这个工作树的几份读数里最可信的一份。 */
  entry: GitEntry;
  /** 指向这张卡的来源 key（每个来源各一条连线）：它们所在的 Folder 都已确认在这个工作树里；按字典序，与来源出现的先后无关。 */
  origins: string[];
}

/** 一份读数：读的是哪个目录（来源报告的原样写法），读到了什么。 */
export interface GitReading {
  workspace: string;
  entry: GitEntry;
}

/**
 * 一张 Folder 卡在 Git 上的结论。Folder 卡按规范化后的目录归并（lib/folder），可是同一个目录的每种写法各被查询一次，
 * 所以同一张卡可能有几份读数，它们不一定一致。
 */
export type FolderGit =
  | { kind: "unknown" }
  | { kind: "known"; worktree: string; evidence: GitReading }
  | { kind: "conflict"; candidates: readonly GitReading[] };

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** 同一个工作树有几份读数（不同的子目录各读一次）时用哪一份：没读失败的优先，其次更新的，最后按目录名定下来，免得刷新一次换一份。 */
function preferred(a: GitReading, b: GitReading): boolean {
  if (a.entry.stale !== b.entry.stale) return !a.entry.stale;
  const left = Date.parse(a.entry.git.checkedAt) || 0;
  const right = Date.parse(b.entry.git.checkedAt) || 0;
  if (left !== right) return left > right;
  return a.workspace < b.workspace;
}

/**
 * 一张 Folder 卡的几份读数得出的结论：
 *  - 没有读数（不是仓库、还没读到、根目录为空）：unknown；
 *  - 读到的根目录只有一个：known，依据是这个根目录下最可信的一份（见 preferred）；
 *  - 读到的根目录不止一个：conflict，每个根目录各留最可信的一份作候选，不选边。
 *
 * 读取失败的那份给的只是更早读到的状态：只要还有读成功的，它就不参与；全都失败时才退而用这些旧读数。
 *
 * 根目录不同时不比“谁读得更晚”。几种写法指的若真是同一个目录，不一致只会出现在目录刚变（`git init`、搬走、重新克隆）、
 * 而各写法的轮询还没轮到的那几秒里，下一轮就一致了；可规范化只看字符串，指的若不是同一个目录（POSIX 上经符号链接再 `..`、
 * 按目录区分大小写的 NTFS），不一致就一直在，几份读数还会轮流成为“更晚的一份”——取更晚的，归属就随每次轮询来回跳，画布每隔几秒重排。
 * 所以不裁决，如实不画归属。
 */
export function resolveFolderGit(readings: readonly GitReading[]): FolderGit {
  const fresh = readings.filter((reading) => !reading.entry.stale);
  const byRoot = new Map<string, GitReading>();
  for (const reading of fresh.length > 0 ? fresh : readings) {
    const root = worktreeKey(reading.entry.git.root);
    if (!root) continue;
    const known = byRoot.get(root);
    if (!known || preferred(reading, known)) byRoot.set(root, reading);
  }
  const roots = [...byRoot].sort(([a], [b]) => byText(a, b));
  const [first] = roots;
  if (!first) return { kind: "unknown" };
  if (roots.length === 1) return { kind: "known", worktree: first[0], evidence: first[1] };
  return { kind: "conflict", candidates: roots.map(([, reading]) => reading) };
}

/**
 * 把来源按真实工作树归并：先按 Folder 卡（同一个目录的不同写法是一张）得出每张卡的结论（见 resolveFolderGit），
 * 已知的卡里，同一个根目录（哪怕目录是它下面的不同子目录）是一组，一张 Git 卡；根目录不同就是不同的组。
 * 一张卡里所有的来源一起进组，哪怕其中某个来源报告的写法这一刻读不到——Folder 是一个目录，它在哪个工作树里不因来源而异。
 *
 * 不属于任何一组的：读不到 Git（不是仓库、还没读到、读取一直失败）的目录——根目录不明，宁可没有卡，也不拿工作目录去猜；
 * 读数互相矛盾的目录——不替它挑一边，Folder 直接连到来源。
 * 画布布局、Git 节点和连线都从这一份结果出发（布局不再自己推断）。结果按工作树 key 排序，与输入的迭代顺序无关。
 */
export function groupGit(workspaceOf: ReadonlyMap<string, string>, entries: ReadonlyMap<string, GitEntry>): GitGroup[] {
  const groups = new Map<string, { evidence: GitReading; origins: string[] }>();
  for (const folder of groupFolders(workspaceOf)) {
    const readings = folder.origins.flatMap((origin) => {
      const workspace = workspaceOf.get(origin);
      const entry = workspace === undefined ? undefined : entries.get(workspace);
      return workspace !== undefined && entry ? [{ workspace, entry }] : [];
    });
    const resolved = resolveFolderGit(readings);
    if (resolved.kind !== "known") continue;
    const group = groups.get(resolved.worktree);
    if (!group) {
      groups.set(resolved.worktree, { evidence: resolved.evidence, origins: [...folder.origins] });
      continue;
    }
    group.origins.push(...folder.origins);
    if (preferred(resolved.evidence, group.evidence)) group.evidence = resolved.evidence;
  }
  return [...groups]
    .sort(([a], [b]) => byText(a, b))
    .map(([key, { evidence, origins }]) => ({ key, entry: evidence.entry, origins: origins.sort() }));
}

export function useGit(targets: readonly GitTarget[]): GitView {
  const watcher = useMemo(() => new GitWatcher(), []);
  const signature = JSON.stringify(targets.map((target) => [target.workspace, target.busy]));

  // signature 就是 targets 的内容，依赖它即可。
  useEffect(() => watcher.setTargets(targets), [watcher, signature]);
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === "visible") watcher.resume();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      watcher.stop();
    };
  }, [watcher]);

  const view = useSyncExternalStore(watcher.subscribe, watcher.getView, watcher.getView);
  // setTargets 在副作用里才跑：第一次渲染时 watcher 还没见过这些目录，也算“还在等”。
  const unseen = targets.some((target) => target.workspace && !view.tracked.has(target.workspace));
  return useMemo(() => (unseen && !view.pending ? { ...view, pending: true } : view), [view, unseen]);
}
