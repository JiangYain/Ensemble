/**
 * 随插件分发的看门狗脚本：skills/ensemble-delegate/scripts/watch.mjs。
 *
 * 这一份测它的判断逻辑：参数、项目规矩、事件读取、逐会话的判断、会话停下时怎么说。
 * 判断逻辑用纯函数直接测（时间由参数传入，不等真实时间）。
 *
 * 其余部分拆在同目录（共用的夹具在 watch-script.fixtures.ts，值得留意的样本在 watch-script.shared.fixtures.ts）：
 * - watch-script.copies.test.ts：脚本为了能独立运行而自带的那几份“与应用同口径”的拷贝，对照应用的真实实现；
 * - watch-script.pass.test.ts：巡检流程（用假的服务读取函数驱动）与输出格式；
 * - watch-script.run.test.ts：起一个隔离的真实服务，把脚本当子进程跑一遍，以及随插件分发的静态检查。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeAttention as appDescribeAttention } from "../src/mcp/format";
import { attentionKey as appAttentionKey } from "../src/shared/attention";
import type { SessionSummary } from "../src/shared/types";
import { at, calls, changed, cleanup, ended, examplePath, feeder, keysOf, NOW, started, summary, track, watch, type Json } from "./watch-script.fixtures";
import { attentionSamples } from "./watch-script.shared.fixtures";

// 拆分前这是整份测试文件的文件级钩子（对每个用例都生效）；这个文件里没有东西要清理，留着它是为了与拆分前的语义完全相同。
afterEach(cleanup);

// ───────────────────────── 参数 ─────────────────────────

describe("parseArgs", () => {
  it("takes session ids as plain arguments or through --sessions, without duplicates", () => {
    const { options, errors } = watch.parseArgs(["ses_a", "--sessions", "ses_b,ses_c", "--sessions=ses_a"]);
    expect(errors).toEqual([]);
    expect(options["ids"]).toEqual(["ses_a", "ses_b", "ses_c"]);
  });

  it("reads values in both `--name value` and `--name=value` form, and has sensible defaults", () => {
    expect(watch.parseArgs([]).options).toMatchObject({ ids: [], interval: 30, tick: 5, goneAfter: 10, forever: false, once: false, help: false });
    const parsed = watch.parseArgs(["--interval", "5", "--tick=0", "--gone-after", "2", "--rules", "rules.json", "--forever", "--once"]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.options).toMatchObject({ interval: 5, tick: 0, goneAfter: 2, rules: "rules.json", forever: true, once: true });
  });

  it("rejects what it cannot understand instead of guessing", () => {
    for (const argv of [["--bogus"], ["--interval", "abc"], ["--interval"], ["--interval", "0"], ["--tick", "-1"], ["--sessions"], ["--rules"], ["not an id!"]]) {
      expect(watch.parseArgs(argv).errors.length, argv.join(" ")).toBeGreaterThan(0);
    }
  });
});

// ───────────────────────── 项目规矩 ─────────────────────────

describe("project rules", () => {
  const example = watch.loadRules(examplePath);
  const hits = (kind: "commands" | "paths", text: string): string[] => example[kind].filter((rule) => rule.regex.test(text)).map((rule) => rule.message);

  it("ships an example that compiles and matches what it says", () => {
    expect(hits("commands", "git commit -m x")).toHaveLength(1);
    expect(hits("commands", "git status")).toEqual([]);
    expect(hits("commands", "git stash list")).toEqual([]);
    expect(hits("commands", "git stash")).toHaveLength(1);
    expect(hits("commands", "cat .env.local")).toHaveLength(1);
    expect(hits("commands", 'node -e "console.log(process.env.TEMP)"')).toEqual([]);
    expect(hits("commands", "echo $CURSOR_API_KEY")).toHaveLength(1);
    expect(hits("commands", "taskkill /F /IM node.exe")).toHaveLength(1);
    expect(hits("commands", "taskkill /F /PID 1234")).toEqual([]);
    expect(hits("paths", "src/a.ts")).toEqual([]);
    expect(hits("paths", "scripts/release.mjs")).toEqual([]);
    expect(hits("paths", "src/environment.ts")).toEqual([]);
    expect(hits("paths", "C:/elsewhere/file.txt")).toEqual(["changed a file outside the session's working directory"]);
    expect(hits("paths", "/etc/hosts")).toEqual(["changed a file outside the session's working directory"]);
    expect(hits("paths", "package-lock.json")).toEqual(["changed package-lock.json"]);
    expect(hits("paths", ".github/workflows/ci.yml")).toEqual(["changed a CI workflow"]);
    expect(hits("paths", "config/.env.local")).toEqual(["changed an env file"]);
  });

  it("flags only what really lies outside the working directory when the example is applied to a session", () => {
    const flagged = (file: string): string[] => hits("paths", watch.normalizePath(file, "C:\\work\\app"));
    expect(flagged("C:\\work\\app\\src\\a.ts")).toEqual([]);
    expect(flagged("src\\a.ts")).toEqual([]);
    expect(flagged("C:\\work\\other\\a.ts")).toEqual(["changed a file outside the session's working directory"]);
    expect(flagged("\\\\server\\share\\a.ts")).toEqual(["changed a file outside the session's working directory"]);
  });

  it("refuses rules it cannot use, and says which one is wrong", () => {
    expect(watch.compileRules({})).toEqual({ commands: [], paths: [] });
    expect(() => watch.compileRules({ commands: "git" })).toThrow(/"commands" must be an array/);
    expect(() => watch.compileRules({ commands: [{ match: "x" }] })).toThrow(/commands\[0\] needs a "match" pattern and a "message"/);
    expect(() => watch.compileRules({ paths: [{ match: "x", message: "" }] })).toThrow(/paths\[0\] needs/);
    expect(() => watch.compileRules({ paths: [{ match: "(", message: "m" }] })).toThrow(/paths\[0\]\.match is not a valid regular expression/);
    expect(() => watch.compileRules({ commands: [{ match: "x", message: "m", flags: "gi" }] })).toThrow(/must not contain g or y/);
  });

  it("matches case-insensitively unless told otherwise", () => {
    const [insensitive] = watch.compileRules({ commands: [{ match: "GIT", message: "m" }] }).commands;
    const [exact] = watch.compileRules({ commands: [{ match: "GIT", message: "m", flags: "" }] }).commands;
    expect(insensitive?.regex.test("git push")).toBe(true);
    expect(exact?.regex.test("git push")).toBe(false);
  });

  it("reads a rules file that starts with a byte-order mark", () => {
    const file = join(mkdtempSync(join(tmpdir(), "ensemble-watch-rules-")), "rules.json");
    writeFileSync(file, `\uFEFF${JSON.stringify({ commands: [{ match: "x", message: "m" }] })}`);
    expect(watch.loadRules(file).commands).toHaveLength(1);
  });

  it("writes paths relative to the session's working directory, with forward slashes", () => {
    expect(watch.normalizePath("C:\\work\\app\\src\\a.ts", "C:\\work\\app")).toBe("src/a.ts");
    expect(watch.normalizePath("src\\a.ts", "C:\\work\\app")).toBe("src/a.ts");
    expect(watch.normalizePath("./src/a.ts", "/work/app")).toBe("src/a.ts");
    expect(watch.normalizePath("/work/app/src/a.ts", "/work/app/")).toBe("src/a.ts");
    expect(watch.normalizePath("C:\\work\\app", "C:\\work\\app")).toBe("");
    expect(watch.normalizePath("C:\\elsewhere\\x.txt", "C:\\work\\app")).toBe("C:/elsewhere/x.txt");
    expect(watch.normalizePath("/work/application/x.ts", "/work/app")).toBe("/work/application/x.ts");
  });

  it("compares case-insensitively only where the file system does", () => {
    const insensitive = process.platform === "win32" || process.platform === "darwin";
    expect(watch.normalizePath("C:/Work/App/src/a.ts", "c:/work/app")).toBe(insensitive ? "src/a.ts" : "C:/Work/App/src/a.ts");
  });
});

// ───────────────────────── 逐会话的判断 ─────────────────────────

describe("reading events", () => {
  it("merges the pieces of a tool call by id and remembers which calls finished, in order", () => {
    const tracker = track();
    const feed = feeder();
    const events = feed(started("c1", "npm test"), started("c2", "npm run lint"), ended("c2", "completed", "ok"), ended("c1", "failed", "boom"));
    expect(watch.ingest(tracker, events, { now: NOW })).toEqual([]);
    expect(tracker["finished"]).toEqual(["c2", "c1"]);
    expect(tracker["tools"].get("c1")).toMatchObject({ title: "npm test", category: "shell", status: "failed", error: "boom" });
    expect(tracker["afterSeq"]).toBe(events.at(-1)?.["seq"]);
    expect(tracker["backfilling"]).toBe(false);
  });

  it("reports a file-conflict style failure as something to know, but not for old history", () => {
    const tracker = track();
    const feed = feeder();
    const edit = (callId: string, offsetMs: number): Json[] => [
      started(callId, "edit src/a.ts", { category: "edit", name: "edit" }, offsetMs),
      ended(callId, "failed", "EBUSY: resource busy or locked, open 'src/a.ts'", offsetMs + 500),
    ];
    // 第一批是补读的历史：十分钟前的不提。
    expect(watch.ingest(tracker, feed(...edit("old", -600_000)), { now: NOW })).toEqual([]);
    const recent = watch.ingest(tracker, feed(...edit("new", -2000)), { now: NOW });
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({ tag: "INFO", key: "conflict|new" });
    expect(recent[0]?.text).toContain("EBUSY");
    expect(watch.ingest(tracker, feed(started("plain", "npm test"), ended("plain", "failed", "1 test failed")), { now: NOW })).toEqual([]);
  });

  it("ignores project rules unless it was given some", () => {
    const tracker = track();
    expect(watch.ingest(tracker, feeder()(started("c1", "git push -f"), changed([{ path: "secret/key.txt", change: "created" }])), { now: NOW })).toEqual([]);
  });

  it("raises a command rule once per call, whichever update carries the command", () => {
    const rules = watch.compileRules({ commands: [{ match: "\\bgit\\s+push\\b", message: "pushed to a remote" }] });
    const tracker = track();
    const feed = feeder();
    const first = watch.ingest(tracker, feed(started("c1", "run release script", { input: undefined }), started("c1", "run release script", { input: { text: "git push --force origin main" } }), ended("c1", "completed")), { rules, now: NOW });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ tag: "ALERT", key: "rule|c1|pushed to a remote" });
    expect(first[0]?.text).toBe("pushed to a remote: git push --force origin main");
    // 同一个调用之后再来的更新不会重复提；别的工具（读文件）里出现同样的字不算命令。
    expect(watch.ingest(tracker, feed(ended("c1", "completed", "done")), { rules, now: NOW })).toEqual([]);
    expect(watch.ingest(tracker, feed(started("c2", "git push", { category: "read", name: "read", input: { text: "git push" } })), { rules, now: NOW })).toEqual([]);
  });

  it("raises a path rule against the path relative to the session's directory", () => {
    const rules = watch.compileRules({ paths: [{ match: "^secret/", message: "touched the secret directory" }] });
    const tracker = track({ cwd: "C:\\work\\app" });
    const findings = watch.ingest(
      tracker,
      feeder()(changed([{ path: "C:\\work\\app\\secret\\key.txt", change: "created" }, { path: "C:\\work\\app\\src\\a.ts", change: "modified" }])),
      { rules, now: NOW },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ tag: "ALERT", text: "touched the secret directory: secret/key.txt" });
  });

  it("does not raise rules for history older than three minutes, only for what is recent", () => {
    const rules = watch.compileRules({ commands: [{ match: "git push", message: "pushed" }] });
    const tracker = track();
    const findings = watch.ingest(
      tracker,
      feeder()(started("old", "git push -f", {}, -600_000), ended("old", "completed", "", -599_000), started("new", "git push origin", {}, -20_000)),
      { rules, now: NOW },
    );
    expect(findings.map((finding) => finding.text)).toEqual(["pushed: git push origin"]);
  });
});

describe("judging a session", () => {
  const context = { now: NOW, capacity: undefined };

  it("mentions a run of failed tool calls only once there are four in a row", () => {
    const tracker = track();
    const feed = feeder();
    watch.ingest(tracker, feed(...calls("a", 3, "failed")), { now: NOW });
    expect(keysOf(watch.inspect(tracker, summary(), context))).not.toContain("failstreak");
    watch.ingest(tracker, feed(...calls("b", 1, "failed")), { now: NOW });
    const findings = watch.inspect(tracker, summary(), context);
    expect(keysOf(findings)).toContain("failstreak");
    expect(findings.find((finding) => finding.key === "failstreak")).toMatchObject({ tag: "ALERT", repeat: true });
    // 输出与错误是同一段话时只写一遍。
    expect(findings.find((finding) => finding.key === "failstreak")?.text).toBe("4 tool calls in a row have failed; latest: `step b0` → exit code 1");
    // 中间有一次成功就重新数。
    watch.ingest(tracker, feed(...calls("c", 1, "completed"), ...calls("d", 3, "failed")), { now: NOW });
    expect(keysOf(watch.inspect(tracker, summary(), context))).not.toContain("failstreak");
  });

  it("does not raise the failed-run fact for a session that is not running", () => {
    const tracker = track();
    watch.ingest(tracker, feeder()(...calls("a", 6, "failed")), { now: NOW });
    expect(keysOf(watch.inspect(tracker, summary({ phase: "running" }), context))).toContain("failstreak");
    expect(watch.inspect(tracker, summary({ phase: "done", status: "idle" }), context)).toEqual([]);
  });

  it("notices the same call coming back over and over with failures among them", () => {
    const feed = feeder();
    const rounds = (statuses: Array<"completed" | "failed">): Json[] => statuses.flatMap((status, index) => [started(`r${index}`, "npm test"), ended(`r${index}`, status, status === "failed" ? "1 failing" : "ok")]);
    const repeated = track();
    watch.ingest(repeated, feed(...rounds(["failed", "completed", "failed", "completed", "completed"])), { now: NOW });
    const finding = watch.inspect(repeated, summary(), context).find((candidate) => candidate.key.startsWith("repeat|"));
    expect(finding).toMatchObject({ tag: "ALERT", repeat: true });
    expect(finding?.text).toBe("the same tool call ran 5 times among the last 5 finished calls, 2 of them failed: shell: npm test");

    // 反复出现但只失败过一次：像是在正常地反复跑测试，不提。
    const mostlyFine = track();
    watch.ingest(mostlyFine, feeder()(...rounds(["failed", "completed", "completed", "completed", "completed"])), { now: NOW });
    expect(keysOf(watch.inspect(mostlyFine, summary(), context)).some((key) => key.startsWith("repeat|"))).toBe(false);

    // 出现次数不够。
    const few = track();
    watch.ingest(few, feeder()(...rounds(["failed", "failed", "failed"])), { now: NOW });
    expect(keysOf(watch.inspect(few, summary(), context)).some((key) => key.startsWith("repeat|"))).toBe(false);
  });

  it("does not mistake calls it never saw the start of for repeats", () => {
    const tracker = track();
    watch.ingest(tracker, feeder()(...Array.from({ length: 6 }, (_, index) => ended(`orphan${index}`, "failed", "x"))), { now: NOW });
    expect(keysOf(watch.inspect(tracker, summary(), context)).some((key) => key.startsWith("repeat|"))).toBe(false);
  });

  it("passes on what the service already worked out, once per item and each with its own wording", () => {
    const items = Object.values(attentionSamples);
    const findings = watch.inspect(track(), summary({ attention: items }), context);
    expect(keysOf(findings)).toEqual(items.map((item) => `attention|${appAttentionKey(item)}`));
    expect(findings.every((finding) => finding.tag === "ALERT" && finding.repeat === true)).toBe(true);
    expect(findings.map((finding) => finding.text)).toEqual(items.map((item) => appDescribeAttention(item, summary() as Pick<SessionSummary, "harness" | "runtime">, NOW)));
  });

  it("still passes on a kind of attention it has not been taught about, instead of dropping it", () => {
    const future = { kind: "something_new", since: at(-120_000) };
    expect(watch.attentionKey(future)).toBe(`something_new|${future.since}`);
    expect(watch.describeAttention(future, summary(), NOW)).toBe(`something_new since ${future.since}`);
    const findings = watch.inspect(track(), summary({ attention: [future] }), context);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ tag: "ALERT", key: `attention|something_new|${future.since}` });
  });

  it("flags a session that has waited for a slot for long although the service has room", () => {
    const waiting = (minutes: number): Json => summary({ phase: "queued", status: "queued", activity: { kind: "queued", since: at(-minutes * 60_000) } });
    const free = { occupied: 1, max: 4, waiting: 1 };
    const found = watch.inspect(track(), waiting(30), { now: NOW, capacity: free });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ tag: "ALERT", key: "queued", repeat: true });
    expect(found[0]?.text).toBe("waiting for a concurrency slot for 30m 00s, although the service reports free capacity (1 of 4 in use)");
    expect(watch.inspect(track(), waiting(10), { now: NOW, capacity: free })).toEqual([]);
    expect(watch.inspect(track(), waiting(30), { now: NOW, capacity: { occupied: 4, max: 4, waiting: 2 } })).toEqual([]);
    expect(watch.inspect(track(), waiting(30), { now: NOW, capacity: undefined })).toEqual([]);
    expect(watch.inspect(track(), waiting(30), { now: NOW, capacity: { occupied: 9, max: 0, waiting: 0 } })[0]?.text).toContain("9 of unlimited in use");
  });
});

describe("a session coming to rest", () => {
  it("says what a finished run did and points at `read`, once per run", () => {
    const tracker = track();
    const done = summary({ phase: "done", status: "idle", counters: { tools: 7, failedTools: 1, files: 2, interventions: 0 }, lastRun: { id: "run_1", index: 1, status: "completed" } });
    const first = watch.settle(tracker, done, NOW);
    expect(first).toEqual([{ tag: "DONE", key: "end|run_1|done", text: "finished (7 tool calls, 1 failed, 2 files changed) — use the `read` tool for its result" }]);
    const next = watch.settle(tracker, summary({ ...done, lastRun: { id: "run_2", index: 2, status: "completed" } }), NOW);
    expect(next[0]?.key).toBe("end|run_2|done");
    expect(watch.settle(track(), summary({ phase: "done", counters: { tools: 1, failedTools: 0, files: 1, interventions: 0 } }), NOW)[0]?.text).toBe("finished (1 tool call, 1 file changed) — use the `read` tool for its result");
  });

  it("treats a failed or lost session as something to look at, and a cancelled or stopped one as information", () => {
    const failed = watch.settle(track(), summary({ phase: "failed", status: "failed", lastError: { code: "boom", message: "the harness\nexited" } }), NOW);
    expect(failed).toEqual([{ tag: "ALERT", key: "end|run_1|failed", text: "ended as failed — [boom] the harness exited" }]);
    expect(watch.settle(track(), summary({ phase: "lost", status: "lost" }), NOW)[0]).toMatchObject({ tag: "ALERT", text: "ended as lost" });
    expect(watch.settle(track(), summary({ phase: "cancelled", status: "idle" }), NOW)[0]).toMatchObject({ tag: "INFO", text: "ended as cancelled" });
    expect(watch.settle(track(), summary({ phase: "stopped", status: "stopped" }), NOW)[0]).toMatchObject({ tag: "INFO", text: "ended as stopped" });
  });

  it("stays quiet while a follow-up message is still waiting to start another run", () => {
    expect(watch.settle(track(), summary({ phase: "done", status: "idle", messages: { total: 2, pending: 1 } }), NOW)).toEqual([]);
    expect(watch.settle(track(), summary({ phase: "running" }), NOW)).toEqual([]);
  });

  it("calls a session idle only after it has been idle for two minutes", () => {
    const tracker = track();
    const idle = summary({ phase: "ready", status: "idle" });
    expect(watch.settle(tracker, idle, NOW)).toEqual([]);
    expect(watch.settle(tracker, idle, NOW + 119_000)).toEqual([]);
    expect(watch.settle(tracker, idle, NOW + 121_000)).toEqual([{ tag: "INFO", key: "ready|run_1", text: "is idle (ready): nothing is running in it" }]);
    // 又动起来之后，下一次待命重新计时。
    watch.settle(tracker, summary({ phase: "running" }), NOW + 130_000);
    expect(watch.settle(tracker, idle, NOW + 131_000)).toEqual([]);
  });
});
