import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitInspector, displayRemote, parseStatus, pickRemote, runGit, type GitRunner, type GitRunResult } from "./git";

const ok = (stdout: string): GitRunResult => ({ code: 0, stdout, stderr: "" });

describe("parseStatus", () => {
  const status = (...items: string[]): string => items.map((item) => `${item}\0`).join("");

  it("读出分支、HEAD、上游与领先落后", () => {
    const parsed = parseStatus(
      status("# branch.oid 0123456789abcdef0123456789abcdef01234567", "# branch.head feature/a b", "# branch.upstream origin/feature/a b", "# branch.ab +3 -1"),
    );
    expect(parsed).toMatchObject({
      oid: "0123456789abcdef0123456789abcdef01234567",
      branch: "feature/a b",
      detached: false,
      upstream: { name: "origin/feature/a b", ahead: 3, behind: 1 },
      changes: { files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    });
  });

  it("游离 HEAD 没有分支名；新仓库没有 HEAD 提交；没有上游就没有领先落后", () => {
    const detached = parseStatus(status("# branch.oid abc", "# branch.head (detached)"));
    expect(detached.detached).toBe(true);
    expect(detached.branch).toBeUndefined();
    expect(detached.upstream).toBeUndefined();

    const fresh = parseStatus(status("# branch.oid (initial)", "# branch.head main"));
    expect(fresh.oid).toBeUndefined();
    expect(fresh.branch).toBe("main");
  });

  it("按文件计数：同一文件既暂存又有新改动只算一个文件，分项各记一次", () => {
    const parsed = parseStatus(
      status(
        "# branch.head main",
        "1 M. N... 100644 100644 100644 aaa bbb staged.txt",
        "1 .M N... 100644 100644 100644 aaa bbb unstaged.txt",
        "1 MM N... 100644 100644 100644 aaa bbb both.txt",
        "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt",
        "? new file.txt",
      ),
    );
    expect(parsed.changes).toEqual({ files: 5, staged: 2, unstaged: 2, untracked: 1, conflicted: 1 });
  });

  it("重命名与复制后面跟着原路径，要跳过，不能把它当成另一项改动", () => {
    const parsed = parseStatus(status("# branch.head main", "2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt", "old name.txt", "? 另一个.txt"));
    expect(parsed.changes).toEqual({ files: 2, staged: 1, unstaged: 0, untracked: 1, conflicted: 0 });
  });

  it("空输出得到干净的结果，被忽略的文件不计入", () => {
    expect(parseStatus("").changes).toEqual({ files: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
    expect(parseStatus(status("! ignored.log")).changes.files).toBe(0);
  });
});

describe("displayRemote", () => {
  it("去掉账号密码、协议与结尾的 .git", () => {
    expect(displayRemote("https://user:token@github.com/owner/repo.git")).toBe("github.com/owner/repo");
    expect(displayRemote("https://github.com/owner/repo/")).toBe("github.com/owner/repo");
    expect(displayRemote("ssh://git@example.com:2222/owner/repo.git")).toBe("example.com:2222/owner/repo");
  });

  it("scp 写法转成同样的样子", () => {
    expect(displayRemote("git@github.com:owner/repo.git")).toBe("github.com/owner/repo");
    expect(displayRemote("example.com:owner/repo")).toBe("example.com/owner/repo");
  });

  it("本地路径原样保留，盘符不会被当成主机", () => {
    expect(displayRemote("C:\\work\\repo.git")).toBe("C:\\work\\repo");
    expect(displayRemote("../sibling/repo.git")).toBe("../sibling/repo");
    expect(displayRemote("file:///C:/work/repo.git")).toBe("C:/work/repo");
  });

  it("无法解析的地址也不会把账号密码带出去", () => {
    expect(displayRemote("https://user:pa ss@exa mple.com/r.git")).not.toContain("pa ss");
  });
});

describe("pickRemote", () => {
  const config = ["remote.origin.url https://a.example/o/r.git", "remote.upstream.url git@b.example:u/r.git", "remote.team/mirror.url https://c.example/t/r.git"].join("\n");

  it("优先取上游所在的远程，远程名带斜杠时取最长前缀", () => {
    expect(pickRemote(config, "upstream/main")).toEqual({ name: "upstream", url: "b.example/u/r" });
    expect(pickRemote(config, "team/mirror/dev")).toEqual({ name: "team/mirror", url: "c.example/t/r" });
  });

  it("没有上游时取 origin，没有 origin 时取第一个，没有远程时什么也没有", () => {
    expect(pickRemote(config, undefined)).toEqual({ name: "origin", url: "a.example/o/r" });
    expect(pickRemote("remote.fork.url https://d.example/f/r.git", undefined)).toEqual({ name: "fork", url: "d.example/f/r" });
    expect(pickRemote("", undefined)).toBeUndefined();
  });
});

describe("GitInspector（假的 git）", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ensemble-git-"));
  });

  /** 按子命令分派的假 git；记录每次调用。 */
  function fake(overrides: Partial<Record<string, GitRunResult | (() => GitRunResult | Promise<GitRunResult>)>> = {}) {
    const calls: string[][] = [];
    const run: GitRunner = async (_cwd, args) => {
      calls.push([...args]);
      const key = args[0] as string;
      const entry = overrides[key];
      if (typeof entry === "function") return entry();
      if (entry) return entry;
      if (key === "rev-parse") return ok(`${dir.replaceAll("\\", "/")}\n`);
      if (key === "status") return ok(["# branch.oid 1111111111111111111111111111111111111111", "# branch.head main", ""].join("\0"));
      if (key === "log") return ok("fix: 修一处\x1f2026-11-14T10:00:00+08:00\n");
      return { code: 1, stdout: "", stderr: "" };
    };
    return { run, calls };
  }

  it("组装出完整的快照，并把提交说明与时间原样带出", async () => {
    const { run } = fake();
    const response = await createGitInspector({ run, now: () => Date.UTC(2026, 10, 14) }).inspect(dir);
    expect(response.reason).toBeUndefined();
    expect(response.path).toBe(dir);
    expect(response.git).toMatchObject({
      branch: "main",
      detached: false,
      head: { sha: "1111111111111111111111111111111111111111", subject: "fix: 修一处", committedAt: "2026-11-14T10:00:00+08:00" },
      changes: { files: 0 },
      checkedAt: "2026-11-14T00:00:00.000Z",
    });
    expect(response.git?.remote).toBeUndefined();
  });

  it("缓存期内同一目录只跑一遍 git；并发请求合并；过期后重新读取", async () => {
    let time = 1_000;
    const { run, calls } = fake();
    const inspector = createGitInspector({ run, now: () => time, ttlMs: 1_500 });
    await Promise.all([inspector.inspect(dir), inspector.inspect(dir), inspector.inspect(dir)]);
    const first = calls.length;
    expect(calls.filter((args) => args[0] === "status")).toHaveLength(1);
    time += 1_000;
    await inspector.inspect(dir);
    expect(calls).toHaveLength(first);
    time += 600;
    await inspector.inspect(dir);
    expect(calls.filter((args) => args[0] === "status")).toHaveLength(2);
  });

  it("目录不存在或不是目录：missing，而且不会去跑 git", async () => {
    const { run, calls } = fake();
    const inspector = createGitInspector({ run });
    expect((await inspector.inspect(join(dir, "nope"))).reason).toBe("missing");
    writeFileSync(join(dir, "file.txt"), "x");
    expect((await inspector.inspect(join(dir, "file.txt"))).reason).toBe("missing");
    expect(calls).toHaveLength(0);
  });

  it("区分“不是仓库”和其他失败", async () => {
    const notRepo = fake({ "rev-parse": { code: 128, stdout: "", stderr: "fatal: not a git repository (or any of the parent directories): .git" } });
    expect((await createGitInspector({ run: notRepo.run }).inspect(dir)).reason).toBe("not_repo");
    const bare = fake({ "rev-parse": { code: 128, stdout: "", stderr: "fatal: this operation must be run in a work tree" } });
    expect((await createGitInspector({ run: bare.run }).inspect(dir)).reason).toBe("not_repo");
    const unsafe = fake({ "rev-parse": { code: 128, stdout: "", stderr: "fatal: detected dubious ownership in repository at 'x'" } });
    expect((await createGitInspector({ run: unsafe.run }).inspect(dir)).reason).toBe("error");
    const broken = fake({ status: { code: 1, stdout: "", stderr: "boom" } });
    expect((await createGitInspector({ run: broken.run }).inspect(dir)).reason).toBe("error");
  });

  it("本机没有 git、超时都有各自的原因，而且不会抛出", async () => {
    const missing: GitRunner = async () => {
      throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    };
    expect((await createGitInspector({ run: missing }).inspect(dir)).reason).toBe("git_missing");
    const slow: GitRunner = async () => {
      throw Object.assign(new Error("git timed out"), { name: "GitTimeout" });
    };
    expect((await createGitInspector({ run: slow }).inspect(dir)).reason).toBe("timeout");
    const odd: GitRunner = async () => {
      throw new Error("something else");
    };
    expect((await createGitInspector({ run: odd }).inspect(dir)).reason).toBe("error");
  });

  it("“没有 git”的结论缓存得更久，不会每次轮询都去试", async () => {
    let time = 0;
    let attempts = 0;
    const missing: GitRunner = async () => {
      attempts += 1;
      throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    };
    const inspector = createGitInspector({ run: missing, now: () => time, ttlMs: 1_500 });
    await inspector.inspect(dir);
    time += 10_000;
    await inspector.inspect(dir);
    expect(attempts).toBe(1);
    time += 25_000;
    await inspector.inspect(dir);
    expect(attempts).toBe(2);
  });

  it("读到的是什么就是什么：日志读不到时没有 head，但仍有分支与改动", async () => {
    const { run } = fake({ log: { code: 128, stdout: "", stderr: "fatal: your current branch 'main' does not have any commits yet" } });
    const response = await createGitInspector({ run }).inspect(dir);
    expect(response.git?.head).toBeUndefined();
    expect(response.git?.branch).toBe("main");
  });
});

// ───────────────────────── 真实的 git ─────────────────────────

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGit)("GitInspector（真实的 git 仓库）", () => {
  let base: string;
  let savedCeiling: string | undefined;
  beforeEach(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "ensemble-git-real-")));
    savedCeiling = process.env["GIT_CEILING_DIRECTORIES"];
    // 不让 git 向上找到测试目录之外的仓库：开发者的家目录本身可能就是一个仓库。
    process.env["GIT_CEILING_DIRECTORIES"] = dirname(base);
  });
  afterEach(() => {
    if (savedCeiling === undefined) delete process.env["GIT_CEILING_DIRECTORIES"];
    else process.env["GIT_CEILING_DIRECTORIES"] = savedCeiling;
  });

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=Tester", "-c", "user.email=tester@example.com", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    });
  const same = (a: string, b: string): boolean => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

  function repo(name = "repo"): string {
    const dir = join(base, name);
    mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "a\n");
    writeFileSync(join(dir, "b.txt"), "b\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "第一次提交 first");
    return dir;
  }

  it("读出分支、HEAD、远程（去掉密码）与三类改动", async () => {
    const dir = repo();
    git(dir, "remote", "add", "origin", "https://user:secret@example.com/owner/repo.git");
    writeFileSync(join(dir, "a.txt"), "changed\n");
    writeFileSync(join(dir, "b.txt"), "changed\n");
    git(dir, "add", "b.txt");
    writeFileSync(join(dir, "c.txt"), "new\n");

    const response = await createGitInspector({ ttlMs: 0 }).inspect(dir);
    const snapshot = response.git!;
    expect(snapshot).toBeTruthy();
    expect(same(snapshot.root, dir)).toBe(true);
    expect(snapshot.branch).toBe("main");
    expect(snapshot.detached).toBe(false);
    expect(snapshot.head?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(snapshot.head?.subject).toBe("第一次提交 first");
    expect(Number.isNaN(Date.parse(snapshot.head!.committedAt))).toBe(false);
    expect(snapshot.changes).toEqual({ files: 3, staged: 1, unstaged: 1, untracked: 1, conflicted: 0 });
    expect(snapshot.remote).toEqual({ name: "origin", url: "example.com/owner/repo" });
    expect(snapshot.upstream).toBeUndefined();
    expect(JSON.stringify(response)).not.toContain("secret");
  });

  it("读出相对上游的领先与落后", async () => {
    const dir = repo();
    const bare = join(base, "remote.git");
    git(base, "init", "-q", "--bare", "-b", "main", bare);
    git(dir, "remote", "add", "origin", bare);
    git(dir, "push", "-q", "-u", "origin", "main");
    writeFileSync(join(dir, "local.txt"), "1\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "local");

    const other = join(base, "other");
    git(base, "clone", "-q", bare, other);
    writeFileSync(join(other, "remote.txt"), "1\n");
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "remote");
    git(other, "push", "-q");
    git(dir, "fetch", "-q");

    const snapshot = (await createGitInspector({ ttlMs: 0 }).inspect(dir)).git!;
    expect(snapshot.upstream).toEqual({ name: "origin/main", ahead: 1, behind: 1 });
    expect(snapshot.remote?.name).toBe("origin");
  });

  it("游离 HEAD：没有分支名，但有提交", async () => {
    const dir = repo();
    git(dir, "checkout", "-q", "--detach");
    const snapshot = (await createGitInspector({ ttlMs: 0 }).inspect(dir)).git!;
    expect(snapshot.detached).toBe(true);
    expect(snapshot.branch).toBeUndefined();
    expect(snapshot.head?.subject).toBe("第一次提交 first");
  });

  it("还没有任何提交的新仓库：有分支名，没有 head", async () => {
    const dir = join(base, "fresh");
    mkdirSync(dir);
    git(dir, "init", "-q", "-b", "trunk");
    writeFileSync(join(dir, "x.txt"), "x\n");
    const snapshot = (await createGitInspector({ ttlMs: 0 }).inspect(dir)).git!;
    expect(snapshot.branch).toBe("trunk");
    expect(snapshot.head).toBeUndefined();
    expect(snapshot.changes).toMatchObject({ files: 1, untracked: 1 });
  });

  it("目录是仓库里的子目录时，仍然得到整个仓库的根与状态", async () => {
    const dir = repo();
    mkdirSync(join(dir, "packages", "web"), { recursive: true });
    const snapshot = (await createGitInspector({ ttlMs: 0 }).inspect(join(dir, "packages", "web"))).git!;
    expect(same(snapshot.root, dir)).toBe(true);
  });

  it("不是仓库的目录：not_repo；真实的 runGit 不会被仓库里的 fsmonitor 配置带去执行命令", async () => {
    const plain = join(base, "plain");
    mkdirSync(plain);
    expect((await createGitInspector({ ttlMs: 0 }).inspect(plain)).reason).toBe("not_repo");

    // 仓库自己的配置可以让 git status 执行一条命令（core.fsmonitor）。值是一条 shell 命令，git 会在后面追加参数，
    // 所以用 # 把追加的部分变成注释；路径用正斜杠，Windows 上的 sh 才认。
    const dir = repo("hooked");
    const marker = join(base, "fsmonitor-ran.txt").replaceAll("\\", "/");
    git(dir, "config", "core.fsmonitor", `echo ran > "${marker}" #`);

    // 对照组：不加保护的 git status 确实会执行它——否则下面“没有执行”什么也证明不了。
    execFileSync("git", ["status", "--porcelain"], { cwd: dir, stdio: "ignore" });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    const result = await runGit(dir, ["status", "--porcelain=v2", "-z"]);
    expect(result.code).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });
});
