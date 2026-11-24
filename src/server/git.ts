import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { GitResponse, GitSnapshot, GitUnavailable } from "@shared/protocol";

/**
 * 画布上“来源节点左边的 Git 节点”的数据来源：对来源的工作目录只读地跑几条 `git`。
 *
 * 只读且尽量不打扰仓库：
 *  - `--no-optional-locks` / `GIT_OPTIONAL_LOCKS=0`：不为刷新索引去抢锁，不会和正在提交的 Agent 互相卡住；
 *  - `core.fsmonitor=false`：仓库自己的配置可以指定一条命令在 `git status` 时执行，这里不让它执行；
 *  - `GIT_TERMINAL_PROMPT=0`：绝不弹出要账号密码的提示；`LC_ALL=C`：错误文字固定为英文，才能可靠地区分“不是仓库”。
 * 没有的信息（没有上游、还没有提交……）不填，也不用别的东西顶替。
 */

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 在 cwd 里运行一条 git。本机没有 git 时 reject 一个 code 为 ENOENT 的错误；超时 reject 一个 name 为 GitTimeout 的错误。 */
export type GitRunner = (cwd: string, args: readonly string[]) => Promise<GitRunResult>;

const COMMAND_TIMEOUT_MS = 8_000;

const SAFE_ARGS = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.quotepath=off"] as const;

export const runGit: GitRunner = (cwd, args) =>
  new Promise((done, fail) => {
    execFile(
      "git",
      [...SAFE_ARGS, ...args],
      {
        cwd,
        timeout: COMMAND_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", GIT_PAGER: "cat" },
      },
      (error, stdout, stderr) => {
        if (!error) {
          done({ code: 0, stdout, stderr });
          return;
        }
        const failure = error as NodeJS.ErrnoException & { killed?: boolean };
        if (failure.code === "ENOENT") {
          fail(error);
        } else if (failure.killed) {
          const timeout = new Error("git timed out");
          timeout.name = "GitTimeout";
          fail(timeout);
        } else {
          done({ code: typeof failure.code === "number" ? failure.code : 1, stdout, stderr });
        }
      },
    );
  });

// ───────────────────────── 解析 ─────────────────────────

export interface ParsedStatus {
  /** HEAD 的完整提交；新仓库（还没有任何提交）没有。 */
  oid?: string;
  branch?: string;
  detached: boolean;
  upstream?: { name: string; ahead: number; behind: number };
  changes: GitSnapshot["changes"];
}

/**
 * 解析 `git status --porcelain=v2 --branch -z`。-z 之后每一项以 NUL 结尾，路径不再被转义；
 * 重命名与复制（`2` 开头）后面多带一项原路径，要一并跳过。
 */
export function parseStatus(output: string): ParsedStatus {
  const changes = { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
  let oid: string | undefined;
  let branch: string | undefined;
  let detached = false;
  let upstreamName: string | undefined;
  let ahead = 0;
  let behind = 0;

  const items = output.split("\0");
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] ?? "";
    if (item.startsWith("# branch.oid ")) {
      const value = item.slice("# branch.oid ".length);
      if (value !== "(initial)") oid = value;
    } else if (item.startsWith("# branch.head ")) {
      const value = item.slice("# branch.head ".length);
      if (value === "(detached)") detached = true;
      else branch = value;
    } else if (item.startsWith("# branch.upstream ")) {
      upstreamName = item.slice("# branch.upstream ".length);
    } else if (item.startsWith("# branch.ab ")) {
      const match = /^\+(\d+) -(\d+)$/.exec(item.slice("# branch.ab ".length));
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    } else if (item.startsWith("1 ") || item.startsWith("2 ")) {
      // `1 XY …` / `2 XY …`：X 是暂存区相对 HEAD 的状态，Y 是工作区相对暂存区的状态，"." 表示没有变化。
      const xy = item.slice(2, 4);
      changes.files += 1;
      if (xy[0] !== undefined && xy[0] !== ".") changes.staged += 1;
      if (xy[1] !== undefined && xy[1] !== ".") changes.unstaged += 1;
      if (item.startsWith("2 ")) index += 1;
    } else if (item.startsWith("u ")) {
      changes.files += 1;
      changes.conflicted += 1;
    } else if (item.startsWith("? ")) {
      changes.files += 1;
      changes.untracked += 1;
    }
  }

  return {
    ...(oid ? { oid } : {}),
    ...(branch ? { branch } : {}),
    detached,
    ...(upstreamName ? { upstream: { name: upstreamName, ahead, behind } } : {}),
    changes,
  };
}

/**
 * 把远程地址整理成可以展示的样子：去掉账号密码、协议和结尾的 `.git`。
 * `https://user:token@github.com/o/r.git` → `github.com/o/r`；`git@github.com:o/r.git` → `github.com/o/r`；本地路径原样保留。
 */
export function displayRemote(url: string): string {
  const trimmed = url.trim();
  const strip = (value: string): string => value.replace(/\/+$/, "").replace(/\.git$/, "");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const path = decodeURIComponent(parsed.pathname);
      return strip(parsed.protocol === "file:" ? path.replace(/^\/(?=[A-Za-z]:)/, "") : `${parsed.host}${path}`);
    } catch {
      // 不是合法 URL：往下按原文处理，但仍然要去掉可能的账号密码。
      return strip(trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/@]*@/i, ""));
    }
  }
  // scp 写法 `user@host:path`；盘符路径（`C:\repo`）不是这种写法。
  const scp = /^(?:[^/@\s]+@)?([^/:\s]{2,}):(?!\\)(.+)$/.exec(trimmed);
  if (scp) return strip(`${scp[1]}/${scp[2]}`);
  return strip(trimmed);
}

/** 从 `git config --get-regexp ^remote\..*\.url$` 的输出里选出要展示的远程。 */
export function pickRemote(output: string, upstream: string | undefined): { name: string; url: string } | undefined {
  const remotes = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^remote\.(.+)\.url (.+)$/.exec(line);
    if (match && !remotes.has(match[1] as string)) remotes.set(match[1] as string, match[2] as string);
  }
  if (remotes.size === 0) return undefined;
  // 上游写作 `<远程>/<分支>`；远程名可以带斜杠，所以取最长的那个前缀。
  const fromUpstream = upstream
    ? [...remotes.keys()].filter((name) => upstream.startsWith(`${name}/`)).sort((a, b) => b.length - a.length)[0]
    : undefined;
  const name = fromUpstream ?? (remotes.has("origin") ? "origin" : [...remotes.keys()][0]);
  const url = name !== undefined ? remotes.get(name) : undefined;
  return name !== undefined && url !== undefined ? { name, url: displayRemote(url) } : undefined;
}

// ───────────────────────── 检查器 ─────────────────────────

export interface GitInspector {
  /** 读取 path 所在仓库的状态；读不到时 git 为 null 并给出原因。从不抛出。 */
  inspect(path: string): Promise<GitResponse>;
}

export interface GitInspectorOptions {
  run?: GitRunner;
  now?: () => number;
  /** 同一目录的结果缓存多久。多个网页、轮询同时来问时，只会真的跑一遍 git。 */
  ttlMs?: number;
}

type Outcome = { git: GitSnapshot } | { git: null; reason: GitUnavailable };

const MAX_CACHED = 64;
/** 本机没有 git 的结论缓存久一点：装上 git 之前每次轮询都去试一遍没有意义。 */
const MISSING_GIT_TTL_MS = 30_000;

export function createGitInspector(options: GitInspectorOptions = {}): GitInspector {
  const run = options.run ?? runGit;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 1_500;
  const cache = new Map<string, { at: number; ttl: number; outcome: Outcome }>();
  const pending = new Map<string, Promise<Outcome>>();

  const keyOf = (path: string): string => {
    const absolute = resolve(path);
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  };

  async function read(path: string): Promise<Outcome> {
    const info = await stat(path).catch(() => undefined);
    if (!info?.isDirectory()) return { git: null, reason: "missing" };

    const top = await run(path, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0) {
      // 不在仓库里，或在裸仓库 / .git 目录内部（没有工作区）；其余失败（如目录归属不安全）当作错误，不假装“不是仓库”。
      const notRepo = /not a git repository|must be run in a work tree/i.test(top.stderr);
      return { git: null, reason: notRepo ? "not_repo" : "error" };
    }
    const root = resolve(top.stdout.trim());

    const [status, log, remotes] = await Promise.all([
      run(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"]),
      run(root, ["log", "-1", "--format=%s%x1f%cI"]),
      run(root, ["config", "--get-regexp", "^remote\\..*\\.url$"]),
    ]);
    if (status.code !== 0) return { git: null, reason: "error" };

    const parsed = parseStatus(status.stdout);
    let head: GitSnapshot["head"];
    if (parsed.oid && log.code === 0) {
      const [subject = "", committedAt = ""] = log.stdout.replace(/\r?\n$/, "").split("\x1f");
      head = { sha: parsed.oid, subject, committedAt };
    }
    // 没有任何远程时 `git config` 以 1 退出，输出为空，pickRemote 会给出 undefined。
    const remote = pickRemote(remotes.stdout, parsed.upstream?.name);

    const git: GitSnapshot = {
      root,
      ...(parsed.branch ? { branch: parsed.branch } : {}),
      detached: parsed.detached,
      ...(head ? { head } : {}),
      ...(parsed.upstream ? { upstream: parsed.upstream } : {}),
      changes: parsed.changes,
      ...(remote ? { remote } : {}),
      checkedAt: new Date(now()).toISOString(),
    };
    return { git };
  }

  async function lookup(path: string): Promise<Outcome> {
    try {
      return await read(path);
    } catch (error) {
      const failure = error as NodeJS.ErrnoException;
      if (failure.code === "ENOENT") return { git: null, reason: "git_missing" };
      if (failure.name === "GitTimeout") return { git: null, reason: "timeout" };
      return { git: null, reason: "error" };
    }
  }

  return {
    async inspect(path) {
      const key = keyOf(path);
      const hit = cache.get(key);
      let outcome: Outcome;
      if (hit && now() - hit.at < hit.ttl) {
        outcome = hit.outcome;
      } else {
        let inflight = pending.get(key);
        if (!inflight) {
          inflight = lookup(path).then((result) => {
            const ttl = !result.git && result.reason === "git_missing" ? MISSING_GIT_TTL_MS : ttlMs;
            cache.delete(key);
            cache.set(key, { at: now(), ttl, outcome: result });
            while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value as string);
            return result;
          });
          pending.set(key, inflight);
          void inflight.finally(() => pending.delete(key)).catch(() => undefined);
        }
        outcome = await inflight;
      }
      return outcome.git ? { path, git: outcome.git } : { path, git: null, reason: outcome.reason };
    },
  };
}
