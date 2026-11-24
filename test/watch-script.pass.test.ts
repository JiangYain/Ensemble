/**
 * 看门狗脚本（skills/ensemble-delegate/scripts/watch.mjs）的巡检流程与输出格式。
 *
 * 巡检流程用假的服务读取函数驱动（夹具里的 `world()`：假时钟、假的会话与事件，可以让服务“断掉”），
 * 所以不等真实时间、不起任何进程；输出格式那一组把 stdout 的写入换成记录，看每一行长什么样。
 *
 * 脚本其余部分的测试在同目录：watch-script.test.ts（判断逻辑）、watch-script.copies.test.ts（与应用同口径的拷贝）、
 * watch-script.run.test.ts（当作脚本跑、随插件分发）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { clip as appClip, collapseWhitespace } from "../src/shared/format";
import { at, cleanup, ended, NOW, started, watch, world } from "./watch-script.fixtures";

// 拆分前这是整份测试文件的文件级钩子（对每个用例都生效）；这个文件里没有东西要清理，留着它是为了与拆分前的语义完全相同。
afterEach(cleanup);

// ───────────────────────── 巡检流程（假的服务） ─────────────────────────

describe("a pass over the service", () => {
  it("watches what is in progress, and whatever is created after it started", async () => {
    const w = world();
    w.session("ses_run");
    w.session("ses_wait", { phase: "queued", status: "queued", activity: { kind: "queued", since: at(0) } });
    w.session("ses_done", { phase: "done", status: "idle" });
    w.session("ses_ready", { phase: "ready", status: "idle" });
    expect(await w.pass()).toEqual({});
    expect(w.out).toHaveLength(1);
    expect(w.out[0]).toMatch(/^\[INFO\] watching 2 sessions: "Session ses_run" \(ses_run\), "Session ses_wait" \(ses_wait\); checking every 30s; exits once they have finished$/);

    w.advance(30_000);
    w.session("ses_new", { phase: "ready", status: "idle" });
    await w.pass();
    expect(w.out.at(-1)).toBe('[INFO] now also watching "Session ses_new" (ses_new)');
  });

  it("with explicit ids watches only those, and says so about an unknown one", async () => {
    const w = world({ ids: ["ses_a", "ses_ghost"] });
    w.session("ses_a");
    w.session("ses_b");
    await w.pass();
    expect(w.out[0]).toBe("[ALERT] unknown session ses_ghost — not watching it");
    expect(w.out[1]).toMatch(/^\[INFO\] watching 1 session: "Session ses_a"/);
    w.session("ses_c");
    await w.pass();
    expect(w.out.some((line) => line.includes("ses_c"))).toBe(false);
    expect(w.out).toHaveLength(2);
  });

  it("gives up with exit code 2 when none of the given ids exists", async () => {
    const w = world({ ids: ["ses_ghost"] });
    w.session("ses_a");
    expect(await w.pass()).toEqual({ exit: 2 });
    expect(w.out).toEqual(["[ALERT] unknown session ses_ghost — not watching it"]);
  });

  it("exits with 0 straight away when nothing is in progress, unless told to stay", async () => {
    const w = world();
    w.session("ses_done", { phase: "done", status: "idle" });
    expect(await w.pass()).toEqual({ exit: 0 });
    expect(w.out).toEqual(["[INFO] no unfinished sessions to watch"]);

    const staying = world({ forever: true });
    staying.session("ses_done", { phase: "done", status: "idle" });
    expect(await staying.pass()).toEqual({});
    staying.session("ses_late");
    await staying.pass();
    expect(staying.out.at(-1)).toMatch(/now also watching .*ses_late/);
  });

  it("says a persistent fact once, repeats it only after a while, and speaks again at once about a new one", async () => {
    const w = world();
    w.session("ses_a", { attention: [{ kind: "quiet", since: at(-300_000), seq: 5 }] });
    await w.pass();
    expect(w.lines("ALERT")).toHaveLength(1);
    expect(w.lines("ALERT")[0]).toBe('[ALERT] "Session ses_a" (ses_a): no events from Codex for 5m 00s (last event #5) and no tool call is in progress — read the transcript to see what it was last doing before deciding anything');

    w.advance(30_000);
    await w.pass();
    expect(w.lines("ALERT")).toHaveLength(1);

    w.advance(12 * 60_000);
    await w.pass();
    expect(w.lines("ALERT")).toHaveLength(2);
    expect(w.lines("ALERT")[1]).toContain("no events from Codex for 17m 30s");

    // 一件新的事（起点不同，标识就不同）马上说，不必等。
    w.session("ses_a", { attention: [{ kind: "quiet", since: at(13 * 60_000), seq: 9 }] });
    w.advance(30_000);
    await w.pass();
    expect(w.lines("ALERT")).toHaveLength(3);
  });

  it("reports a finished session once, and exits when everything it watches has finished", async () => {
    const w = world();
    w.session("ses_a");
    w.session("ses_b");
    await w.pass();

    w.advance(1000);
    w.session("ses_a", { phase: "done", status: "idle", counters: { tools: 7, failedTools: 1, files: 2, interventions: 0 } });
    expect(await w.pass()).toEqual({});
    expect(w.lines("DONE")).toEqual(['[DONE] "Session ses_a" (ses_a): finished (7 tool calls, 1 failed, 2 files changed) — use the `read` tool for its result']);
    const before = w.out.length;
    await w.pass();
    expect(w.out).toHaveLength(before);

    w.session("ses_b", { phase: "failed", status: "failed", lastError: { code: "boom", message: "it broke" } });
    expect(await w.pass()).toEqual({ exit: 0 });
    expect(w.out.at(-2)).toBe('[ALERT] "Session ses_b" (ses_b): ended as failed — [boom] it broke');
    expect(w.out.at(-1)).toBe("[INFO] all 2 watched sessions have finished; the watcher is exiting");
  });

  it("keeps watching with --forever, and reports each new run of a session separately", async () => {
    const w = world({ forever: true });
    w.session("ses_a");
    await w.pass();
    w.session("ses_a", { phase: "done", status: "idle", lastRun: { id: "run_1", index: 1, status: "completed" } });
    expect(await w.pass()).toEqual({});
    w.session("ses_a", { phase: "running", status: "running", lastRun: { id: "run_2", index: 2, status: "running" } });
    await w.pass();
    w.session("ses_a", { phase: "done", status: "idle", lastRun: { id: "run_2", index: 2, status: "completed" } });
    expect(await w.pass()).toEqual({});
    expect(w.lines("DONE")).toHaveLength(2);
    expect(w.out.some((line) => line.includes("exiting"))).toBe(false);
    // 一次性的话（结束了、已经说过）隔再久也不重复；只有“仍然成立的事”才会隔一阵再提醒。
    const before = w.out.length;
    w.advance(60 * 60_000);
    await w.pass();
    expect(w.out).toHaveLength(before);
  });

  it("shortens a long title, so one line stays one line", async () => {
    const title = "A very long title that goes on and on and on, far beyond what a notification line should carry";
    const shown = appClip(collapseWhitespace(title), 40);
    expect(shown.length).toBeLessThanOrEqual(40);
    expect(shown.endsWith("…")).toBe(true);
    const w = world();
    w.session("ses_a", { title });
    await w.pass();
    expect(w.out[0]).toContain(`"${shown}" (ses_a)`);
  });

  it("treats an answer it does not understand like a service it cannot use", async () => {
    const lines: string[] = [];
    const watcher = watch.createWatcher(
      { ids: [], interval: 30, tick: 0, goneAfter: 10, forever: false, once: true },
      { home: "unused", now: () => NOW, say: (tag: string, text: string) => lines.push(`[${tag}] ${text}`), readService: () => ({ port: 1, token: "t" }), fetchJson: async () => ({ unexpected: true }) },
    );
    expect(await watch.pass(watcher)).toEqual({ exit: 3 });
    expect(lines).toEqual(["[ALERT] cannot reach the Ensemble service (the service answered /api/sessions with something unexpected)"]);
  });

  it("does not call a session finished while a follow-up is still waiting to start", async () => {
    const w = world();
    w.session("ses_a");
    await w.pass();
    w.session("ses_a", { phase: "done", status: "idle", messages: { total: 2, pending: 1 } });
    expect(await w.pass()).toEqual({});
    expect(w.lines("DONE")).toEqual([]);
  });

  it("is quiet about an idle session for two minutes, then says so and counts it as finished", async () => {
    const w = world({ ids: ["ses_idle"] });
    w.session("ses_idle", { phase: "ready", status: "idle" });
    expect(await w.pass()).toEqual({});
    w.advance(60_000);
    expect(await w.pass()).toEqual({});
    expect(w.out).toHaveLength(1);
    w.advance(61_000);
    expect(await w.pass()).toEqual({ exit: 0 });
    expect(w.out.slice(1)).toEqual(['[INFO] "Session ses_idle" (ses_idle): is idle (ready): nothing is running in it', "[INFO] all 1 watched session has finished; the watcher is exiting"]);
  });

  it("reads the history once, then only what is new, and nothing while nothing changed", async () => {
    const w = world();
    w.session("ses_a");
    w.emit("ses_a", started("c1", "npm test"), ended("c1", "completed", "ok"));
    await w.pass();
    expect(w.eventRequests()).toEqual(["/sessions/ses_a/events?after=0&limit=600"]);
    await w.pass();
    expect(w.eventRequests()).toHaveLength(1);

    w.emit("ses_a", started("c2", "npm run lint"));
    await w.pass();
    expect(w.eventRequests().at(-1)).toBe("/sessions/ses_a/events?after=2");

    // 结束之后不再读。
    w.session("ses_a", { phase: "done", status: "idle" });
    await w.pass();
    const count = w.eventRequests().length;
    w.emit("ses_a", ended("c2", "completed"));
    await w.pass();
    expect(w.eventRequests()).toHaveLength(count);
  });

  it("starts reading from the beginning again when a session's log has been reset", async () => {
    const w = world();
    w.session("ses_a");
    w.emit("ses_a", started("c1", "npm test"), ended("c1", "completed"), started("c2", "npm run lint"));
    await w.pass();
    const before = w.eventRequests().length;
    w.replaceEvents("ses_a", started("n1", "echo fresh"));
    await w.pass();
    // 确实又读了一次，而且是从头读（只比较最后一条请求会和第一次的相同而白白通过）。
    expect(w.eventRequests()).toHaveLength(before + 1);
    expect(w.eventRequests().at(-1)).toBe("/sessions/ses_a/events?after=0&limit=600");
  });

  it("raises a rule hit for recent events only, even on the first look at a session", async () => {
    const rules = watch.compileRules({ commands: [{ match: "git push", message: "pushed" }] });
    const w = world({}, rules);
    w.session("ses_a");
    w.emit("ses_a", started("old", "git push -f", {}, -600_000), ended("old", "completed", "", -599_000), started("new", "git push origin", {}, -20_000));
    await w.pass();
    expect(w.out[0]).toContain("1 project rule loaded");
    expect(w.lines("ALERT")).toEqual(['[ALERT] "Session ses_a" (ses_a): pushed: git push origin']);
  });

  it("stops watching a session that has disappeared, and exits when none is left", async () => {
    const w = world();
    w.session("ses_a");
    w.session("ses_b");
    await w.pass();
    w.drop("ses_a");
    expect(await w.pass()).toEqual({});
    expect(w.out.at(-1)).toBe("[INFO] session ses_a no longer exists — not watching it any more");
    w.drop("ses_b");
    expect(await w.pass()).toEqual({ exit: 0 });
    expect(w.out.at(-1)).toBe("[INFO] nothing left to watch; the watcher is exiting");
  });

  it("prints a summary line every few minutes when asked to", async () => {
    const w = world({ tick: 5 });
    w.session("ses_a");
    w.session("ses_b", { phase: "queued", status: "queued", activity: { kind: "queued", since: at(0) } });
    await w.pass();
    expect(w.lines("TICK")).toEqual([]);
    w.advance(4 * 60_000);
    await w.pass();
    expect(w.lines("TICK")).toEqual([]);
    w.advance(61_000);
    await w.pass();
    expect(w.lines("TICK")).toEqual(["[TICK] watching 2 · running 1 · queued 1 · finished 0 · other 0 · service ok"]);
  });

  it("does not repeat a summary line without being asked", async () => {
    const w = world({ tick: 0 });
    w.session("ses_a");
    await w.pass();
    w.advance(60 * 60_000);
    await w.pass();
    expect(w.lines("TICK")).toEqual([]);
  });

  it("flags a session that waits for a slot although capacity is free, and not when it cannot tell", async () => {
    const w = world();
    w.session("ses_q", { phase: "queued", status: "queued", activity: { kind: "queued", since: at(-30 * 60_000) } });
    await w.pass();
    expect(w.lines("ALERT")).toHaveLength(1);
    expect(w.lines("ALERT")[0]).toContain("waiting for a concurrency slot for 30m 00s");

    const blind = world();
    blind.session("ses_q", { phase: "queued", status: "queued", activity: { kind: "queued", since: at(-30 * 60_000) } });
    blind.setCapacity(undefined);
    await blind.pass();
    expect(blind.lines("ALERT")).toEqual([]);
  });

  describe("when the service cannot be reached", () => {
    it("tolerates one failed read, speaks on the second, notes the recovery, and does not repeat itself", async () => {
      const w = world();
      w.session("ses_a");
      await w.pass();
      const base = w.out.length;

      w.breakService(new Error("fetch failed"));
      w.advance(30_000);
      expect(await w.pass()).toEqual({});
      expect(w.out).toHaveLength(base);
      w.advance(30_000);
      expect(await w.pass()).toEqual({});
      expect(w.out.at(-1)).toBe("[ALERT] the Ensemble service is unreachable (fetch failed) — sessions running in it are interrupted if it has stopped. Still retrying.");
      w.advance(30_000);
      await w.pass();
      expect(w.out).toHaveLength(base + 1);

      w.mendService();
      w.advance(30_000);
      await w.pass();
      expect(w.out.at(-1)).toBe("[INFO] the Ensemble service is reachable again after 1m 30s");
    });

    it("gives up with exit code 3 once it has been gone for --gone-after minutes", async () => {
      const w = world({ goneAfter: 2 });
      w.session("ses_a");
      await w.pass();
      w.breakService(new Error("ECONNREFUSED"));
      w.advance(30_000);
      await w.pass();
      w.advance(119_000);
      expect(await w.pass()).toEqual({});
      w.advance(1000);
      expect(await w.pass()).toEqual({ exit: 3 });
      expect(w.out.at(-1)).toMatch(/^\[ALERT\] the Ensemble service has been unreachable for 2m 00s \(ECONNREFUSED\); giving up\./);
    });

    it("with --once reports it at once and exits with 3", async () => {
      const w = world({ once: true });
      w.breakService(new Error("ECONNREFUSED"));
      expect(await w.pass()).toEqual({ exit: 3 });
      expect(w.out).toEqual(["[ALERT] cannot reach the Ensemble service (ECONNREFUSED)"]);
    });
  });

  it("with --once looks once and leaves", async () => {
    const w = world({ once: true });
    w.session("ses_a");
    expect(await w.pass()).toEqual({ exit: 0 });
    expect(w.out).toHaveLength(1);
  });
});

describe("what it prints", () => {
  it("starts each line with the local time and the tag, and never lets one line run on", () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as never);
    try {
      const watcher = watch.createWatcher({ ids: [], interval: 30, tick: 0, goneAfter: 10, forever: false, once: false }, { home: "unused", now: () => NOW });
      watcher.say("ALERT", `long ${"x".repeat(2000)}`);
      watcher.say("INFO", "short");
    } finally {
      spy.mockRestore();
    }
    const date = new Date(NOW);
    const two = (value: number): string => String(value).padStart(2, "0");
    const clock = `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
    expect(writes).toHaveLength(2);
    expect(writes[0]?.startsWith(`${clock} [ALERT] long xxx`)).toBe(true);
    expect(writes[0]?.length).toBe(`${clock} [ALERT] `.length + 420 + 1);
    expect(writes[0]?.endsWith("…\n")).toBe(true);
    expect(writes[1]).toBe(`${clock} [INFO] short\n`);
  });
});
