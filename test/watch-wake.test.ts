/**
 * 看门狗脚本（skills/ensemble-delegate/scripts/watch.mjs）的“唤醒式”用法：`--wake`、`--state`、`--origin`，
 * 以及一并改进的几处：续跑的会话重新纳入、重复调用的指纹、`clip` / `shortenPath` 的代理对安全。
 *
 * 夹具在 test/watch-script.fixtures.ts（载入脚本、造数据、假的服务）。合并窗口、轮询间隔与时钟都走注入的 deps
 * （假时钟、假 sleep），这里没有依赖真实计时的等待；只有最后两个用例起真实的服务与真实的子进程，等的是进程自己退出。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { until } from "../src/server/testing";
import { clip as appClip, collapseWhitespace, shortenPath as appShortenPath } from "../src/shared/format";
import { sliceHead as appSliceHead, sliceTail as appSliceTail } from "../src/shared/safe-slice";
import { testOrigin } from "../src/shared/testing";
import { at, cleanup, delegate, ended, feeder, keysOf, NOW, run, scriptPath, serve, skillDir, started, summary, track, watch, world, type Json } from "./watch-script.fixtures";

// ───────────────────────── 造数据 ─────────────────────────

const context = { now: NOW, capacity: undefined };

/** 服务端算好的“值得留意”：一件会持续存在的事（重复提醒、状态文件里的指纹都靠它）。 */
const quiet = { kind: "quiet", since: at(-300_000), seq: 5, runId: "run_1" };
const quietKey = `attention|quiet|${at(-300_000)}`;

/** 一次运行结束后的会话摘要（`endedAtMs` 是相对 NOW 的结束时刻）。 */
const finishedRun = (runId: string, index = 1, endedAtMs = 0): Json => ({
  phase: "done",
  status: "idle",
  endedAt: at(endedAtMs),
  lastRun: { id: runId, index, status: "completed", endedAt: at(endedAtMs) },
});

/** 被 `send` 续跑起来、正在进行的第二轮：服务端在有活动运行时不给会话级的 endedAt。 */
const runningRun = (runId: string, index: number): Json => ({ phase: "running", status: "running", endedAt: undefined, lastRun: { id: runId, index, status: "running" } });

const stateFile = (): string => join(mkdtempSync(join(tmpdir(), "ensemble-watch-state-")), "state.json");
const readState = (file: string): Json => JSON.parse(readFileSync(file, "utf8"));

/** 捕获 stderr 的写入（`main` 对参数错误写在这里）。 */
async function captureStderr<T>(action: () => Promise<T>): Promise<{ result: T; text: string }> {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  }) as never);
  try {
    return { result: await action(), text: writes.join("") };
  } finally {
    spy.mockRestore();
  }
}

// ───────────────────────── 参数 ─────────────────────────

describe("parseArgs: --wake, --wake-batch, --state, --origin, --origin-of", () => {
  it("has the new options off by default", () => {
    const { options, errors } = watch.parseArgs([]);
    expect(errors).toEqual([]);
    expect(options).toMatchObject({ wake: false, wakeBatch: 3, origins: [], originOf: [] });
    expect(options["state"]).toBeUndefined();
  });

  it("reads them in both `--name value` and `--name=value` form, and lets --origin repeat", () => {
    const { options, errors } = watch.parseArgs(["--wake", "--wake-batch", "0", "--state", "state.json", "--origin", "cursor:a", "--origin=codex:b", "--origin-of", "ses_x"]);
    expect(errors).toEqual([]);
    expect(options).toMatchObject({ wake: true, wakeBatch: 0, state: "state.json", origins: ["cursor:a", "codex:b"], originOf: ["ses_x"] });
  });

  it("takes explicit session ids after --wake", () => {
    const { options, errors } = watch.parseArgs(["--wake", "ses_a", "ses_b"]);
    expect(errors).toEqual([]);
    expect(options["ids"]).toEqual(["ses_a", "ses_b"]);
  });

  it("refuses --wake together with --forever or --once, and a --wake-batch without --wake", () => {
    expect(watch.parseArgs(["--wake", "--forever"]).errors).toEqual([expect.stringContaining("--wake cannot be combined with --forever")]);
    expect(watch.parseArgs(["--wake", "--once"]).errors).toEqual([expect.stringContaining("--wake cannot be combined with --once")]);
    expect(watch.parseArgs(["--wake-batch", "5"]).errors).toEqual(["--wake-batch only applies together with --wake"]);
  });

  it("needs a value for --state and --origin, a number for --wake-batch, and a real session id for --origin-of", () => {
    expect(watch.parseArgs(["--state"]).errors).toEqual(["--state needs a file"]);
    expect(watch.parseArgs(["--origin"]).errors).toEqual([expect.stringContaining("--origin needs an origin key")]);
    expect(watch.parseArgs(["--wake", "--wake-batch", "soon"]).errors).toEqual(["--wake-batch needs a number of at least 0"]);
    expect(watch.parseArgs(["--origin-of", "not an id!"]).errors).toEqual([expect.stringContaining("is not a session id")]);
  });

  it("does not let an origin filter be mixed with explicit session ids (the named session could be silently ignored)", () => {
    expect(watch.parseArgs(["ses_a", "--origin", "cursor:a"]).errors).toEqual([expect.stringContaining("cannot be combined with explicit session ids")]);
    expect(watch.parseArgs(["ses_a", "--origin-of", "ses_b"]).errors).toEqual([expect.stringContaining("cannot be combined with explicit session ids")]);
  });

  it("makes `main` exit with 2 and say why, before it talks to any service", async () => {
    const forever = await captureStderr(() => watch.main(["--wake", "--forever"], {}));
    expect(forever.result).toBe(2);
    expect(forever.text).toContain("--wake cannot be combined with --forever");
    const once = await captureStderr(() => watch.main(["--wake", "--once"], {}));
    expect(once.result).toBe(2);
    expect(once.text).toContain("--wake cannot be combined with --once");
  });

  it("makes `main` refuse a --state path it could never write, instead of silently losing the state", async () => {
    const folder = mkdtempSync(join(tmpdir(), "ensemble-watch-state-"));
    const missing = await captureStderr(() => watch.main(["--wake", "--state", join(folder, "no-such-folder", "state.json")], {}));
    expect(missing.result).toBe(2);
    expect(missing.text).toContain("does not exist (create it first");
    const directory = await captureStderr(() => watch.main(["--wake", "--state", folder], {}));
    expect(directory.result).toBe(2);
    expect(directory.text).toContain("that path is a folder, not a file");
  });

  it("documents the new options and the exit codes in --help", () => {
    const help = spawnSync(process.execPath, [scriptPath, "--help"], { encoding: "utf8", windowsHide: true });
    expect(help.status).toBe(0);
    for (const text of ["--wake ", "--wake-batch <seconds>", "--state <file>", "--origin <key>", "--origin-of <id>", "[WAKE]", "10 --wake: something needs handling"]) {
      expect(help.stdout, text).toContain(text);
    }
  });

  it("is described in the watchdog section of SKILL.md: --wake first, exit code 10, --state, --origin, a PowerShell example", () => {
    const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8").replace(/\r\n/g, "\n");
    const section = skill.split("\n## ").find((part) => part.startsWith("让宿主在后台盯着会话（看门狗脚本）")) ?? "";
    for (const text of ["--wake", "退出码 10", "--state", "--origin", "--origin-of", "PowerShell", "输出匹配"]) expect(section, text).toContain(text);
  });
});

// ───────────────────────── 代理对安全的截断 ─────────────────────────

describe("clip and shortenPath never leave half an emoji behind", () => {
  /** 孤立的高位或低位代理项（输出里会变成乱码字符）。 */
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it("sliceHead and sliceTail follow the shared convention", () => {
    // 先确认检查本身有效：朴素的 slice 切在 emoji 中间，会留下孤立的高位代理项。
    expect(lone.test("a😀".slice(0, 2))).toBe(true);

    expect(watch.sliceHead("a😀b", 2)).toBe("a");
    expect(watch.sliceHead("a😀b", 3)).toBe("a😀");
    expect(watch.sliceTail("a😀b", 2)).toBe("b");
    expect(watch.sliceTail("a😀b", 3)).toBe("😀b");
    // 原文里本来就有的孤立代理项原样保留，不去修补。
    expect(watch.sliceHead("a\uD83Db", 2)).toBe("a\uD83D");
    expect(watch.sliceTail("a\uDE00b", 2)).toBe("\uDE00b");
    // n 夹在 [0, 长度] 之内。
    expect(watch.sliceHead("abc", -3)).toBe("");
    expect(watch.sliceHead("abc", 99)).toBe("abc");
    expect(watch.sliceTail("abc", 0)).toBe("");
    expect(watch.sliceTail("abc", 99)).toBe("abc");
  });

  it("sliceHead and sliceTail agree with the server copies on every cut", () => {
    const samples = ["", "a", "😀", "a😀", "😀a", "😀😀😀😀", "ab😀cd", `x${"😀".repeat(5)}y`, "\uD83D", "\uDE00", "a\uD83Db", "a\uDE00b", "a\uD83D😀"];
    for (const text of samples) {
      for (let max = -1; max <= text.length + 2; max += 1) {
        expect(watch.sliceHead(text, max), `head ${max} of ${JSON.stringify(text)}`).toBe(appSliceHead(text, max));
        expect(watch.sliceTail(text, max), `tail ${max} of ${JSON.stringify(text)}`).toBe(appSliceTail(text, max));
      }
    }
  });

  it("clip cuts text with emoji exactly like the server copy, and never splits one", () => {
    for (const lead of ["", "a", "ab"]) {
      for (const count of [1, 2, 3, 6]) {
        for (let max = 1; max <= 12; max += 1) {
          const text = `${lead}${"😀".repeat(count)} tail`;
          const mine = watch.clip(text, max);
          expect(mine, `${max}: ${JSON.stringify(text)}`).toBe(appClip(collapseWhitespace(text), max));
          expect(lone.test(mine), `${max}: ${JSON.stringify(text)}`).toBe(false);
        }
      }
    }
  });

  it("shortenPath cuts paths with emoji exactly like the server copy, and never splits one", () => {
    const paths = [`/work/${"😀".repeat(30)}/deeply/nested/${"😀".repeat(12)}.ts`, `C:\\work\\${"😀".repeat(40)}\\file.ts`, `/${"😀".repeat(40)}`, `${"d/".repeat(20)}${"😀".repeat(25)}.ts`];
    for (const path of paths) {
      for (const max of [8, 20, 31, 32, 33, 52]) {
        const mine = watch.shortenPath(path, max);
        expect(mine, `${max}: ${JSON.stringify(path)}`).toBe(appShortenPath(path, max));
        expect(lone.test(mine), `${max}: ${JSON.stringify(path)}`).toBe(false);
      }
    }
  });
});

// ───────────────────────── 重复调用的指纹 ─────────────────────────

describe("which calls count as 'the same call'", () => {
  const shell = (input: Json | undefined, title = "git log"): Json => ({ name: "shell", category: "shell", title, ...(input ? { input } : {}) });

  it("tells shell commands apart by their full text, not by their first words", () => {
    expect(watch.callFingerprint(shell({ text: "git log -n 1" }))).toBe("shell: git log -n 1");
    expect(watch.callFingerprint(shell({ text: "git log -n 1" }))).not.toBe(watch.callFingerprint(shell({ text: "git log -n 2" })));
  });

  it("folds whitespace, and keeps about 200 characters of a long command", () => {
    expect(watch.callFingerprint(shell({ text: "npm   test\n --silent" }))).toBe("shell: npm test --silent");
    const long = watch.callFingerprint(shell({ text: `echo ${"x".repeat(400)}` }));
    expect(long.length).toBe("shell: ".length + 200);
    expect(long.endsWith("…")).toBe(true);
  });

  it("reads the command out of JSON parameters, and falls back to the title when the preview was cut", () => {
    const json = { name: "Bash", category: "shell", title: "ignored", input: { format: "json", text: JSON.stringify({ command: "git status", description: "x" }) } };
    expect(watch.callFingerprint(json)).toBe("Bash: git status");
    const cut = { name: "Bash", category: "shell", title: "git status --short", input: { format: "json", text: '{"command":"git sta', truncated: true } };
    expect(watch.callFingerprint(cut)).toBe("Bash: git status --short");
    expect(watch.callFingerprint(shell(undefined, "pwd"))).toBe("shell: pwd");
  });

  it("uses the tool name plus its target for other tools", () => {
    const read = (path: string): Json => ({ name: "Read", category: "read", title: path, input: { format: "json", text: JSON.stringify({ file_path: path, limit: 10 }) } });
    expect(watch.callFingerprint(read("src/a.ts"))).toBe("Read: src/a.ts");
    expect(watch.callFingerprint(read("src/a.ts"))).not.toBe(watch.callFingerprint(read("src/b.ts")));
    const grep = { name: "Grep", category: "search", title: "foo", input: { format: "json", text: JSON.stringify({ pattern: "foo", path: "src" }) } };
    expect(watch.callFingerprint(grep)).toBe("Grep: src foo");
    expect(watch.callFingerprint({ name: "mcp", category: "other", title: "do the thing" })).toBe("mcp: do the thing");
  });

  it("no longer takes `git log -n 1…5` for one call repeating, but still catches the same failing command coming back", () => {
    // 标题都是“git log”、参数不同：以前只比标题前缀，会被当成同一个调用。
    const differing = track();
    watch.ingest(differing, feeder()(...[1, 2, 3, 4, 5].flatMap((n) => [started(`d${n}`, "git log", { input: { text: `git log -n ${n}` } }), ended(`d${n}`, "failed", "fatal: bad revision")])), { now: NOW });
    expect(keysOf(watch.inspect(differing, summary(), context)).some((key) => key.startsWith("repeat|"))).toBe(false);

    const same = track();
    watch.ingest(same, feeder()(...[1, 2, 3, 4, 5].flatMap((n) => [started(`s${n}`, "git log", { input: { text: "git log -n 1" } }), ended(`s${n}`, n % 2 === 1 ? "failed" : "completed", "fatal: bad revision")])), { now: NOW });
    const finding = watch.inspect(same, summary(), context).find((candidate) => candidate.key.startsWith("repeat|"));
    expect(finding?.key).toBe("repeat|shell: git log -n 1");
    expect(finding?.text).toBe("the same tool call ran 5 times among the last 5 finished calls, 3 of them failed: shell: git log -n 1");
  });
});

// ───────────────────────── --wake ─────────────────────────

describe("--wake", () => {
  it("prints [DONE], waits out the merge window, adds a [WAKE] summary and exits with 10", async () => {
    const w = world({ wake: true });
    w.session("ses_a");
    expect(await w.pass()).toEqual({});
    expect(w.out).toEqual(['[INFO] watching 1 session: "Session ses_a" (ses_a); checking every 30s; exits when one finishes or needs attention']);

    w.advance(30_000);
    w.session("ses_a", finishedRun("run_1", 1, 30_000));
    expect(await w.pass()).toEqual({ exit: 10 });
    expect(w.slept).toEqual([3000]);
    expect(w.lines("DONE")).toEqual(['[DONE] "Session ses_a" (ses_a): finished (4 tool calls, 1 file changed) — use the `read` tool for its result']);
    expect(w.out.at(-1)).toBe("[WAKE] 1 finished — handle it, then start this watcher again with the same arguments; pass --state <file> next time so a restart does not repeat what it already told you.");
  });

  it("carries what arrives during the merge window into the same wake", async () => {
    const w = world({ wake: true });
    w.session("ses_a");
    w.session("ses_b");
    await w.pass();
    w.advance(30_000);
    w.session("ses_a", finishedRun("run_1", 1, 30_000));
    w.whileSleeping(() => {
      w.session("ses_b", { phase: "failed", status: "failed", lastError: { code: "boom", message: "it broke" } });
    });
    expect(await w.pass()).toEqual({ exit: 10 });
    expect(w.lines("DONE")).toHaveLength(1);
    expect(w.lines("ALERT")).toEqual(['[ALERT] "Session ses_b" (ses_b): ended as failed — [boom] it broke']);
    expect(w.out.at(-1)).toMatch(/^\[WAKE\] 1 finished, 1 attention — handle them, then start this watcher again with the same arguments/);
  });

  it("with --wake-batch 0 exits at once, without waiting", async () => {
    const w = world({ wake: true, wakeBatch: 0 });
    w.session("ses_a");
    await w.pass();
    w.advance(30_000);
    w.session("ses_a", finishedRun("run_1", 1, 30_000));
    expect(await w.pass()).toEqual({ exit: 10 });
    expect(w.slept).toEqual([]);
  });

  it("does not treat having nothing to watch as an error: it waits, and picks up what appears later", async () => {
    const w = world({ wake: true });
    w.session("ses_old", { phase: "done", status: "idle" });
    expect(await w.pass()).toEqual({});
    expect(w.out).toEqual(["[INFO] no unfinished sessions to watch yet — waiting for one to start (--wake keeps waiting)"]);
    w.advance(30_000);
    expect(await w.pass()).toEqual({});
    w.session("ses_new");
    w.advance(30_000);
    expect(await w.pass()).toEqual({});
    expect(w.out.at(-1)).toBe('[INFO] now also watching "Session ses_new" (ses_new)');
  });

  it("is not woken by [INFO] or [TICK]: a cancelled session and a periodic summary leave it running", async () => {
    const w = world({ wake: true, tick: 1 });
    w.session("ses_a");
    await w.pass();
    w.advance(61_000);
    w.session("ses_a", { phase: "cancelled", status: "idle" });
    expect(await w.pass()).toEqual({});
    expect(w.lines("INFO").some((line) => line.includes("ended as cancelled"))).toBe(true);
    expect(w.lines("TICK")).toHaveLength(1);
    expect(w.lines("WAKE")).toEqual([]);
  });

  it("watches a finished session again when it is resumed, and reports its next ending", async () => {
    const w = world({ wake: true, wakeBatch: 0 });
    w.session("ses_a", { phase: "done", status: "idle" });
    w.session("ses_b");
    await w.pass();
    expect(w.out).toEqual(['[INFO] watching 1 session: "Session ses_b" (ses_b); checking every 30s; exits when one finishes or needs attention']);

    w.advance(30_000);
    w.session("ses_a", runningRun("run_2", 2));
    expect(await w.pass()).toEqual({});
    expect(w.out.at(-1)).toBe('[INFO] watching "Session ses_a" (ses_a) again: it is back in progress');

    w.advance(30_000);
    w.session("ses_a", finishedRun("run_2", 2, 60_000));
    expect(await w.pass()).toEqual({ exit: 10 });
    expect(w.lines("DONE")).toHaveLength(1);
    expect(w.lines("DONE")[0]).toContain("(ses_a)");
  });

  it("also wakes for explicitly named sessions", async () => {
    const w = world({ wake: true, wakeBatch: 0, ids: ["ses_a"] });
    w.session("ses_a", finishedRun("run_1"));
    expect(await w.pass()).toEqual({ exit: 10 });
    expect(w.lines("DONE")).toHaveLength(1);
  });

  it("still gives up with exit 3 when the service stays unreachable; the outage itself does not wake it", async () => {
    const w = world({ wake: true, goneAfter: 2 });
    w.session("ses_a");
    await w.pass();
    w.breakService(new Error("ECONNREFUSED"));
    w.advance(1000);
    expect(await w.pass()).toEqual({});
    w.advance(1000);
    expect(await w.pass()).toEqual({});
    expect(w.lines("ALERT")).toHaveLength(1);
    expect(w.lines("WAKE")).toEqual([]);
    w.advance(2 * 60_000);
    expect(await w.pass()).toEqual({ exit: 3 });
    expect(w.lines("WAKE")).toEqual([]);
  });

  it("loops in `main` on its own interval, wakes, and returns 10", async () => {
    let now = NOW;
    const out: string[] = [];
    const sleeps: number[] = [];
    let sessions: Json[] = [summary({ id: "ses_a", title: "A" })];
    const code = await watch.main(["--wake", "--wake-batch", "2", "--interval", "7"], {}, {
      home: "unused",
      now: () => now,
      say: (tag: string, text: string) => out.push(`[${tag}] ${text}`),
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
        if (sleeps.length === 1) sessions = [summary({ id: "ses_a", title: "A", phase: "done", status: "idle" })];
      },
      readService: () => ({ port: 1, token: "t" }),
      fetchJson: async (_service: Json, path: string) => (path === "/sessions" ? { sessions } : path === "/health" ? { capacity: { occupied: 0, max: 0, waiting: 0 } } : { events: [] }),
    });
    expect(code).toBe(10);
    expect(sleeps).toEqual([7000, 2000]);
    expect(out.filter((line) => line.startsWith("[DONE]"))).toHaveLength(1);
    expect(out.at(-1)).toMatch(/^\[WAKE\] 1 finished — handle it, then start this watcher again with the same arguments/);
  });
});

// ───────────────────────── --state ─────────────────────────

describe("--state", () => {
  it("on the first run starts from now (no history is reported) and creates the file atomically", async () => {
    const file = stateFile();
    const w = world({ wake: true, wakeBatch: 0, state: file });
    w.session("ses_running");
    w.session("ses_old", { ...finishedRun("run_1", 1, -600_000) });
    expect(await w.pass()).toEqual({});
    expect(w.out[0]).toBe(`[INFO] the --state file ${file} does not exist yet — starting from now; it is created after the first pass`);
    expect(w.lines("DONE")).toEqual([]);
    const saved = readState(file);
    expect(Object.keys(saved).sort()).toEqual(["lastPoll", "savedAt", "sessions", "version"]);
    expect(saved).toMatchObject({ version: 1, lastPoll: NOW, savedAt: NOW });
    expect(saved["sessions"]).toEqual({});
    // 先写临时文件再改名：目录里只剩状态文件本身。
    expect(readdirSync(dirname(file))).toEqual(["state.json"]);
  });

  it("after a restart reports a session that finished in between, once — and says nothing more about it", async () => {
    const file = stateFile();
    const w = world({ wake: true, wakeBatch: 0, state: file });
    w.session("ses_a");
    w.session("ses_b");
    expect(await w.pass()).toEqual({});

    // 看门狗不在的这一分钟里，ses_a 结束了。
    w.advance(60_000);
    w.session("ses_a", finishedRun("run_1", 1, 30_000));
    w.restart();
    const before = w.out.length;
    expect(await w.pass()).toEqual({ exit: 10 });
    expect(w.out.slice(before)).toEqual([
      `[INFO] resuming from the --state file ${file} (it was last saved 1m 00s ago)`,
      '[INFO] watching 1 session: "Session ses_b" (ses_b); checking every 30s; exits when one finishes or needs attention',
      '[INFO] 1 session finished since this watcher last looked (1m 00s ago): "Session ses_a" (ses_a)',
      '[DONE] "Session ses_a" (ses_a): finished (4 tool calls, 1 file changed) — use the `read` tool for its result',
      "[WAKE] 1 finished — handle it, then start this watcher again with the same arguments.",
    ]);

    // 再重启一次：已经说过的，不再说。
    w.advance(30_000);
    w.restart();
    const again = w.out.length;
    expect(await w.pass()).toEqual({});
    expect(w.out.slice(again).filter((line) => line.startsWith("[DONE]") || line.startsWith("[ALERT]"))).toEqual([]);
  });

  it("reports a session again when it is resumed and finishes again, across restarts", async () => {
    const file = stateFile();
    const w = world({ wake: true, wakeBatch: 0, state: file });
    w.session("ses_a");
    await w.pass();
    w.advance(30_000);
    w.session("ses_a", finishedRun("run_1", 1, 30_000));
    expect(await w.pass()).toEqual({ exit: 10 });
    // “这一次结束”的标识就是最近一轮的运行 id 加阶段：同一次结束前后一致，续跑之后的结束是另一个。
    expect(readState(file)["sessions"]["ses_a"]).toEqual({ ended: "end|run_1|done" });

    w.restart();
    w.advance(30_000);
    expect(await w.pass()).toEqual({});
    expect(w.lines("DONE")).toHaveLength(1);

    w.advance(30_000);
    w.session("ses_a", runningRun("run_2", 2));
    expect(await w.pass()).toEqual({});
    expect(w.out.at(-1)).toBe('[INFO] watching "Session ses_a" (ses_a) again: it is back in progress');

    w.advance(30_000);
    w.session("ses_a", finishedRun("run_2", 2, 100_000));
    expect(await w.pass()).toEqual({ exit: 10 });
    expect(w.lines("DONE")).toHaveLength(2);
    expect(readState(file)["sessions"]["ses_a"]).toEqual({ ended: "end|run_2|done" });
  });

  it("continues reading each session's events where it stopped, so old events do not trigger the rules again", async () => {
    const file = stateFile();
    const rules = watch.compileRules({ commands: [{ match: "npm test", message: "ran the tests" }] });
    const w = world({ state: file }, rules);
    w.session("ses_a");
    w.emit("ses_a", started("c1", "npm test"), ended("c1", "completed", "ok"));
    expect(await w.pass()).toEqual({});
    expect(w.lines("ALERT")).toEqual(['[ALERT] "Session ses_a" (ses_a): ran the tests: npm test']);
    expect(readState(file)["sessions"]["ses_a"]["cursor"]).toBe(2);

    w.restart();
    w.emit("ses_a", started("c2", "npm run lint"));
    w.advance(30_000);
    expect(await w.pass()).toEqual({});
    expect(w.eventRequests()).toEqual(["/sessions/ses_a/events?after=0&limit=600", "/sessions/ses_a/events?after=2"]);
    expect(w.lines("ALERT")).toHaveLength(1);
  });

  it("remembers what it already said about a persisting fact: no repeat within 12 minutes, a reminder after that", async () => {
    const file = stateFile();
    const w = world({ wake: true, wakeBatch: 0, state: file });
    w.session("ses_a", { attention: [quiet] });
    expect(await w.pass()).toEqual({ exit: 10 });
    expect(w.lines("ALERT")).toHaveLength(1);
    expect(readState(file)["sessions"]["ses_a"]["alerts"]).toEqual({ [quietKey]: NOW });

    w.restart();
    w.advance(60_000);
    expect(await w.pass()).toEqual({});
    expect(w.lines("ALERT")).toHaveLength(1);

    w.advance(12 * 60_000);
    expect(await w.pass()).toEqual({ exit: 10 });
    expect(w.lines("ALERT")).toHaveLength(2);
  });

  it("writes exactly the fields it documents", async () => {
    const file = stateFile();
    const w = world({ wake: true, wakeBatch: 0, state: file });
    w.session("ses_a", { attention: [quiet] });
    w.emit("ses_a", started("c1", "x"), ended("c1", "completed", "ok"));
    await w.pass();
    const saved = readState(file);
    expect(Object.keys(saved).sort()).toEqual(["lastPoll", "savedAt", "sessions", "version"]);
    expect(saved["sessions"]["ses_a"]).toEqual({ cursor: 2, alerts: { [quietKey]: NOW } });
  });

  it("treats an unreadable or unknown file as none, says so, and replaces it", async () => {
    const cases: Array<[string, string, string]> = [
      ["not JSON", "{oops", "it is not valid JSON"],
      ["not an object", "[]", "it is not a JSON object"],
      ["no version", JSON.stringify({ savedAt: 1, lastPoll: 1, sessions: {} }), "it has no version, this script reads version 1"],
      ["another version", JSON.stringify({ version: 2, savedAt: 1, lastPoll: 1, sessions: {} }), "it is version 2, this script reads version 1"],
      ["no times", JSON.stringify({ version: 1, sessions: {} }), "it has no usable lastPoll / savedAt"],
    ];
    for (const [label, content, problem] of cases) {
      const file = stateFile();
      writeFileSync(file, content);
      const w = world({ state: file });
      w.session("ses_a");
      expect(await w.pass(), label).toEqual({});
      expect(w.out[0], label).toBe(`[INFO] ignoring the --state file ${file}: ${problem} — starting from now; it is replaced after the first pass`);
      expect(readState(file)["version"], label).toBe(1);
    }
  });

  it("parses what it wrote, ignores malformed entries, and accepts a byte-order mark", () => {
    const text = JSON.stringify({
      version: 1,
      savedAt: 5,
      lastPoll: 4,
      sessions: { ses_a: { cursor: 7, ended: "end|run_1|done", alerts: { k: 3, bad: "x" } }, ses_b: { cursor: -1, ended: "" }, ses_c: null },
    });
    const parsed = watch.parseState(`\uFEFF${text}`);
    expect(parsed.problem).toBeUndefined();
    const sessions = parsed.state?.["sessions"];
    expect(parsed.state).toMatchObject({ savedAt: 5, lastPoll: 4 });
    expect(sessions.get("ses_a")).toEqual({ cursor: 7, ended: "end|run_1|done", alerts: new Map([["k", 3]]) });
    expect(sessions.get("ses_b")).toEqual({ cursor: undefined, ended: undefined, alerts: new Map() });
    expect(sessions.has("ses_c")).toBe(false);
  });

  it("keeps watching, and says so only once, when the file cannot be written", async () => {
    const folder = mkdtempSync(join(tmpdir(), "ensemble-watch-state-"));
    const w = world({ state: join(folder, "no-such-folder", "state.json") });
    w.session("ses_a");
    expect(await w.pass()).toEqual({});
    w.advance(30_000);
    expect(await w.pass()).toEqual({});
    expect(w.out.filter((line) => line.includes("could not save the --state file"))).toHaveLength(1);
  });

  it("with explicit session ids it only speaks about those, also after a restart (no 'finished since' catch-up for the rest)", async () => {
    const file = stateFile();
    const w = world({ ids: ["ses_b"], state: file });
    w.session("ses_a");
    w.session("ses_b");
    await w.pass();
    w.advance(60_000);
    w.session("ses_a", finishedRun("run_1", 1, 30_000));
    w.restart();
    expect(await w.pass()).toEqual({});
    expect(w.lines("DONE")).toEqual([]);
  });

  it("finds out when a session ended from what the service recorded, and leaves out what it cannot date", () => {
    expect(watch.endedAtOf({ endedAt: at(5), lastRun: { endedAt: at(9) } })).toBe(NOW + 5);
    expect(watch.endedAtOf({ lastRun: { endedAt: at(9) } })).toBe(NOW + 9);
    expect(watch.endedAtOf({})).toBeUndefined();
    expect(watch.endedAtOf({ endedAt: "soon" })).toBeUndefined();
  });
});

// ───────────────────────── --origin ─────────────────────────

describe("--origin", () => {
  const mine = { key: "cursor:conv-1", kind: "agent", host: "cursor" };
  const theirs = { key: "codex:thr_other", kind: "agent", host: "codex" };
  const watchingMine = `[INFO] watching 1 session: "Session ses_mine" (ses_mine); checking every 30s; only origin ${mine.key}; exits once they have finished`;

  it("only picks up sessions of the given origin and never reads the others' events — a follower is judged by its own origin", async () => {
    const w = world({ origins: [mine.key] });
    w.session("ses_mine", { origin: mine });
    w.session("ses_theirs", { origin: theirs });
    w.session("ses_plain");
    w.emit("ses_mine", started("m1", "ls"));
    w.emit("ses_theirs", started("t1", "ls"));
    expect(await w.pass()).toEqual({});
    expect(w.out).toEqual([watchingMine]);
    expect(w.eventRequests()).toEqual(["/sessions/ses_mine/events?after=0&limit=600"]);

    w.advance(30_000);
    w.session("ses_theirs_new", { origin: theirs });
    w.session("ses_mine_new", { origin: mine });
    // 别人名下、follows 了我的会话；我名下、follows 了别人的会话：各按自己的来源判断。
    w.session("ses_child_theirs", { origin: theirs, parentSessionId: "ses_mine" });
    w.session("ses_child_mine", { origin: mine, parentSessionId: "ses_theirs" });
    await w.pass();
    expect(w.lines("INFO").filter((line) => line.includes("now also watching"))).toEqual([
      '[INFO] now also watching "Session ses_mine_new" (ses_mine_new)',
      '[INFO] now also watching "Session ses_child_mine" (ses_child_mine)',
    ]);
    expect(w.eventRequests()).toEqual(["/sessions/ses_mine/events?after=0&limit=600"]);
  });

  it("takes the origin from a session you name with --origin-of, and exits with 2 when that cannot be done", async () => {
    const w = world({ originOf: ["ses_mine"] });
    w.session("ses_mine", { origin: mine });
    w.session("ses_theirs", { origin: theirs });
    expect(await w.pass()).toEqual({});
    expect(w.out).toEqual([watchingMine]);

    const ghost = world({ originOf: ["ses_ghost"] });
    expect(await ghost.pass()).toEqual({ exit: 2 });
    expect(ghost.out).toEqual(["[ALERT] --origin-of ses_ghost: the service has no such session (archived sessions are not listed)"]);

    const plain = world({ originOf: ["ses_plain"] });
    plain.session("ses_plain");
    expect(await plain.pass()).toEqual({ exit: 2 });
    expect(plain.out).toEqual(["[ALERT] --origin-of ses_plain: that session has no origin key recorded"]);
  });

  it("does not report, after a restart, what other origins finished in between", async () => {
    const file = stateFile();
    const w = world({ origins: [mine.key], wake: true, wakeBatch: 0, state: file });
    w.session("ses_mine", { origin: mine });
    w.session("ses_theirs", { origin: theirs });
    await w.pass();
    w.advance(60_000);
    w.session("ses_theirs", finishedRun("run_1", 1, 30_000));
    w.restart();
    expect(await w.pass()).toEqual({});
    expect(w.lines("DONE")).toEqual([]);
  });
});

// ───────────────────────── 当作脚本跑（真实服务，真实子进程） ─────────────────────────

afterEach(cleanup);

describe("run as a script against a real service, with --wake", () => {
  // 第一个用例要先后起两个看门狗进程、跑完两个会话，所以单独给了比默认更宽的时限（机器忙时不至于误报）。
  it("exits with 10 once a session has finished, with [DONE] and [WAKE] fully written; a restart with the same state only speaks about what is new", async () => {
    const service = await serve();
    const state = stateFile();
    const args = ["--wake", "--interval", "0.2", "--wake-batch", "0.2", "--tick", "0", "--state", state];

    const first = run(args, service.paths.home);
    await first.waitFor(/no unfinished sessions to watch yet/);
    const one = await delegate(service, "[fixture:quick] say hello");
    const firstResult = await first.done;
    expect(firstResult.stderr).toBe("");
    expect(firstResult.code).toBe(10);
    expect(firstResult.stdout).toMatch(new RegExp(`\\[DONE\\] ".*" \\(${one.sessionId}\\): finished \\(\\d+ tool calls?.*\\) — use the \`read\` tool for its result`));
    // 退出前输出已经写完：最后一行就是 [WAKE]。
    const lastLine = firstResult.stdout.trimEnd().split("\n").at(-1) ?? "";
    expect(lastLine).toMatch(/\[WAKE\] 1 finished(, \d+ attention)? — handle (it|them), then start this watcher again with the same arguments\.$/);
    const saved = readState(state);
    expect(saved["version"]).toBe(1);
    expect(saved["sessions"][one.sessionId]["ended"]).toMatch(/^end\|.+\|done$/);
    expect(saved["sessions"][one.sessionId]["cursor"]).toBeGreaterThan(0);

    // 同样的参数、同一个状态文件重启：它只会说新出现的那个。
    const second = run(args, service.paths.home);
    await second.waitFor(/resuming from the --state file/);
    const two = await delegate(service, "[fixture:quick] say hello again");
    const secondResult = await second.done;
    expect(secondResult.stderr).toBe("");
    expect(secondResult.code).toBe(10);
    expect(secondResult.stdout).toContain(two.sessionId);
    expect(secondResult.stdout).not.toContain(one.sessionId);
  }, 40_000);

  it("with --origin it is only woken by that origin's sessions", async () => {
    const service = await serve();
    const theirs = testOrigin({ key: "codex:thr_other", sessionRef: { id: "thr_other", kind: "thread", source: "mcp-meta" } });
    const watcher = run(["--wake", "--interval", "0.2", "--wake-batch", "0.1", "--tick", "0", "--origin", testOrigin().key], service.paths.home);
    await watcher.waitFor(/no unfinished sessions to watch yet/);

    // 别的来源的会话先跑完：筛选失效的话，看门狗会在这里被叫醒。
    const other = await service.manager.delegate({ harness: "pi", task: "[fixture:quick] theirs", cwd: tmpdir(), origin: theirs, allowDuplicate: true });
    await until(() => service.hub.summary(other.sessionId)?.phase === "done", 8000, "the other origin's run to finish");
    const mine = await delegate(service, "[fixture:quick] mine");
    const result = await watcher.done;
    expect(result.stderr).toBe("");
    expect(result.code).toBe(10);
    expect(result.stdout).toContain(mine.sessionId);
    expect(result.stdout).not.toContain(other.sessionId);
  });
});
