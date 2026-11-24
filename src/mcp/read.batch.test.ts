import { describe, expect, it } from "vitest";
import { mapPool as sharedMapPool } from "@shared/map-pool";
import { EventLog } from "@shared/testing";
import type { Usage } from "@shared/types";
import { BATCH_CONCURRENCY, mapPool, readBatch, renderBatch, type BatchOutcome, type ManyRequest } from "./read";
import { cmd, snapshot, twoRuns } from "./read.fixtures";

/**
 * `read` 的批量读取（sessionIds）：renderBatch 怎样把多个会话排成一份（顺序、结论、费用、预算），mapPool 的有界并发，
 * 以及 readBatch 怎样边取边压成事实、保持顺序。批量读取里“结论一节”的措辞随会话局面而变，另在 read.phase-wording.test.ts 里。
 */

// ───────────────────────── 批量读取 ─────────────────────────

function finishedSession(id: string, title: string, answer: string, usage?: Usage, extra?: (log: EventLog, runId: string) => void): EventLog {
  const log = new EventLog(id);
  const runId = `r_${id}`;
  log.created({ title });
  log.message(`m_${id}`, "task", `Task for ${id}`);
  log.run(runId, 1, `m_${id}`);
  log.startRun(runId);
  extra?.(log, runId);
  log.push({ kind: "assistant.delta", data: { itemId: "a1", text: answer, phase: "final" } }, { runId });
  log.push({ kind: "assistant.completed", data: { itemId: "a1", phase: "final" } }, { runId });
  if (usage) log.push({ kind: "usage.updated", data: { usage } }, { runId });
  log.push({ kind: "run.completed", data: {} }, { runId });
  return log;
}

const outcome = (log: EventLog): BatchOutcome => ({ id: log.sessionId, detail: snapshot(log).detail });

describe("batch read", () => {
  const alpha = () =>
    finishedSession("ses_a", "Alpha job", "Alpha found two issues in the parser.", { totalTokens: 12_240, costUsd: 0.024 }, (log, runId) => {
      log.tool(runId, "c1", "completed", { title: "npm test", input: cmd("npm test"), exitCode: 0 });
      log.tool(runId, "c2", "failed", { title: "npm run build", exitCode: 2, error: "boom" });
      log.tool(runId, "c3", "completed", { name: "edit", category: "edit", title: "src/a.ts" });
      log.push({ kind: "file.changed", data: { callId: "c3", files: [{ path: "src/a.ts", change: "modified", addedLines: 1 }, { path: "src/b.ts", change: "created", addedLines: 2 }] } }, { runId });
    });
  const beta = () => finishedSession("ses_b", "Beta job", "Beta is fine.", { totalTokens: 900 });
  const gamma = () => finishedSession("ses_c", "Gamma job", "Gamma done.", { totalTokens: 100, costUsd: 0 });
  const missing: BatchOutcome = { id: "ses_missing", reason: "Session ses_missing does not exist." };
  const now = Date.parse("2026-01-01T00:10:00.000Z");

  it("gives one block per session in the order asked, with the facts a main agent needs", () => {
    const batch = renderBatch([outcome(alpha()), missing, outcome(beta()), outcome(gamma())], { maxChars: 8000, now });
    const { text } = batch;

    expect(text.startsWith("Read 4 sessions, in the order given (maxChars 8000 in total).")).toBe(true);
    const positions = ['1/4 • ses_a [Pi] "Alpha job" — done', "2/4 ses_missing", '3/4 • ses_b [Pi] "Beta job" — done', '4/4 • ses_c [Pi] "Gamma job" — done'].map((needle) => text.indexOf(needle));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    expect(text).toMatch(/ {4}run: #1, \d+s/);
    expect(text).toContain("    tools: 3 calls, 1 failed");
    expect(text).toContain("    files: 2 changed — src/a.ts, src/b.ts");
    expect(text).toContain("    conclusion:\n      Alpha found two issues in the parser.");
    expect(text).toContain("2/4 ses_missing — could not be read: Session ses_missing does not exist.");

    expect(batch.readable.map((summary) => summary.id)).toEqual(["ses_a", "ses_b", "ses_c"]);
    expect(batch.unreadable).toEqual([{ id: "ses_missing", reason: "Session ses_missing does not exist." }]);
  });

  it("states cost honestly: a real figure, not reported, and reported as zero", () => {
    const { text } = renderBatch([outcome(alpha()), outcome(beta()), outcome(gamma())], { maxChars: 8000, now });
    expect(text).toContain("    usage (all runs): 12k tokens, cost $0.02");
    expect(text).toContain("    usage (all runs): 900 tokens, cost: not reported by the harness");
    expect(text).toContain("    usage (all runs): 100 tokens, cost $0.00 (reported as zero — may mean the harness has no price for the model)");
  });

  it("says plainly that a session still running has no final answer yet, and keeps its attention lines", () => {
    const log = new EventLog("ses_run");
    log.created({ title: "Still going" });
    log.message("m1", "task", "Audit everything");
    log.run("r1", 1, "m1");
    log.startRun("r1");
    log.tool("r1", "c1", "running", { title: "npm test", input: cmd("npm test") });
    log.push({ kind: "assistant.delta", data: { itemId: "a1", text: "Halfway through the audit", phase: "commentary" } }, { runId: "r1" });
    const detail = snapshot(log).detail;
    const at = Date.parse(log.now()) + 5_000;
    const withAttention: BatchOutcome = {
      id: "ses_run",
      detail: { ...detail, summary: { ...detail.summary, attention: [{ kind: "long_run" as const, since: new Date(Date.parse(log.now()) - 70 * 60_000).toISOString() }] } },
    };
    const { text } = renderBatch([withAttention], { maxChars: 4000, now: at });
    expect(text).toContain("    latest output so far (not final):\n      Halfway through the audit");
    expect(text).toContain("    attention: this run has been going for 1h 10m");
    expect(text).toContain("    still running — not final");
    expect(text).not.toMatch(/stuck/i);
  });

  it("says so when a session has no conclusion to give", () => {
    const fresh = new EventLog("ses_new");
    fresh.created({ title: "Not started" });
    const { text } = renderBatch([outcome(fresh)], { maxChars: 4000, now });
    expect(text).toContain("    conclusion: none — the session has not run yet");
    expect(text).toContain("    run: none yet");
    // 一轮都没开始过，就没有东西在跑：不写 still running（与上一行 `run: none yet` 自相矛盾）。
    expect(text).not.toContain("still running");
  });

  it("does not call a session still running when its first run is only queued: nothing has started yet", () => {
    const queued = new EventLog("ses_queued");
    queued.created({ title: "Waiting for its turn" });
    queued.message("m1", "task", "Do the thing");
    queued.run("r1", 1, "m1");
    const { text } = renderBatch([outcome(queued)], { maxChars: 4000, now });
    expect(text).toContain("    run: none yet");
    expect(text).toContain("    conclusion: none — the session has not run yet");
    expect(text).not.toContain("still running");
  });

  it("keeps saying still running for a session that is running and has no answer to give yet", () => {
    const log = new EventLog("ses_busy");
    log.created({ title: "Busy" });
    log.message("m1", "task", "Audit everything");
    log.run("r1", 1, "m1");
    log.startRun("r1");
    log.tool("r1", "c1", "running", { title: "npm test", input: cmd("npm test") });
    const { text } = renderBatch([outcome(log)], { maxChars: 4000, now });
    expect(text).toContain("    conclusion: none yet — still running");
    expect(text).toContain("    still running — not final");
    expect(text).not.toContain("has not run yet");
  });

  it("labels the duration of a session with several runs, and the usage as the sum of all of them", () => {
    const { text } = renderBatch([outcome(twoRuns())], { maxChars: 8000, now });
    expect(text).toMatch(/ {4}run: #2 of 2 runs, \d+s; all runs together: \d+s/);
    expect(text).toContain("    usage (all runs): 1.5k tokens");
    expect(text).toContain("    conclusion:\n      Second run: lexer audited.");
  });

  it("counts blank or repeated ids it was told to ignore", () => {
    expect(renderBatch([outcome(beta())], { maxChars: 4000, ignored: 2, now }).text).toContain("2 duplicate or blank ids ignored.");
    expect(renderBatch([outcome(beta())], { maxChars: 4000, now }).text).not.toContain("ignored");
  });

  describe("budget", () => {
    const longAnswer = "Long answer sentence. ".repeat(200);
    const long = (id: string) => finishedSession(id, `Job ${id}`, longAnswer, { totalTokens: 100 });

    it("gives every conclusion in full when the budget allows, without any notice", () => {
      const { text } = renderBatch([outcome(long("ses_1")), outcome(long("ses_2")), outcome(long("ses_3"))], { maxChars: 40_000, now });
      expect(text).not.toContain("more characters");
      expect(text).not.toContain("too small");
      expect(text).not.toContain("cut to fit");
      expect(text.length).toBeGreaterThan(3 * longAnswer.length);
    });

    it("shares a tight budget out: short conclusions stay whole, the long one is cut, and the cut is stated", () => {
      const short = finishedSession("ses_s", "Short", "Short and complete.", { totalTokens: 10 });
      const middling = finishedSession("ses_m", "Middling", "Middling answer. ".repeat(15), { totalTokens: 10 });
      const { text } = renderBatch([outcome(short), outcome(middling), outcome(long("ses_l"))], { maxChars: 3000, now });
      expect(text).toContain("Short and complete.");
      expect(text).toContain("Middling answer. ".repeat(15).trim());
      expect(text).toContain("1 of 3 conclusions was cut to fit; raise maxChars (up to 40000) or read those sessions on their own.");
      expect(text).toMatch(/… \(\d+ more characters; read ses_l on its own with a larger maxChars for the full answer\)/);
      expect(text).not.toContain("too small");
    });

    it("keeps every session's facts and the start of its conclusion when even that does not fit, and says the budget is too small", () => {
      const { text } = renderBatch([outcome(long("ses_1")), outcome(long("ses_2")), outcome(long("ses_3"))], { maxChars: 500, now });
      expect(text).toContain("maxChars 500 is too small for 3 sessions");
      for (const id of ["ses_1", "ses_2", "ses_3"]) {
        expect(text).toContain(`read ${id} on its own with a larger maxChars`);
      }
      expect(text.match(/ {4}usage \(all runs\):/g)).toHaveLength(3);
      expect(text.match(/Long answer sentence\./g)!.length).toBeGreaterThanOrEqual(3);
    });
  });
});

// ───────────────────────── 有界并发 ─────────────────────────

describe("mapPool", () => {
  it("keeps results in input order and never runs more than the limit at once", async () => {
    let running = 0;
    let peak = 0;
    const results = await mapPool([30, 5, 20, 1, 10, 3], 2, async (ms, index) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, ms));
      running -= 1;
      return `${index}:${ms}`;
    });
    expect(results).toEqual(["0:30", "1:5", "2:20", "3:1", "4:10", "5:3"]);
    expect(peak).toBe(2);
  });

  it("fails as a whole when one piece of work throws", async () => {
    await expect(
      mapPool([1, 2, 3], 2, async (value) => {
        if (value === 2) throw new Error("boom");
        return value;
      }),
    ).rejects.toThrow("boom");
  });

  it("handles an empty list", async () => {
    expect(await mapPool([], 4, async () => 1)).toEqual([]);
  });

  it("is the shared implementation (@shared/map-pool), not a copy of its own", () => {
    expect(mapPool).toBe(sharedMapPool);
  });
});

// ───────────────────────── 批量读取：边取边压成事实 ─────────────────────────

describe("readBatch", () => {
  const at = Date.parse("2026-01-01T00:10:00.000Z");
  const many = (ids: readonly string[], maxChars = 40_000, ignored = 0): ManyRequest => ({ kind: "many", sessionIds: [...ids], maxChars, ignored });
  const jobs = (count: number): EventLog[] => Array.from({ length: count }, (_, index) => finishedSession(`ses_${index}`, `Job ${index}`, `Answer ${index}.`, { totalTokens: 100 + index }));
  const idsOf = (logs: readonly EventLog[]): string[] => logs.map((log) => log.sessionId);
  /** 按编号取现成的日志：模拟桥向服务取这个会话的详情。 */
  const logFor = (logs: readonly EventLog[], id: string): EventLog => {
    const log = logs.find((entry) => entry.sessionId === id);
    if (!log) throw new Error(`no log for ${id}`);
    return log;
  };

  it("renders exactly what renderBatch renders for the same details at the same moment, with the unreadable one in place", async () => {
    const logs = jobs(3);
    const gone: BatchOutcome = { id: "ses_gone", reason: "Session ses_gone does not exist." };
    const fetchOutcome = async (id: string): Promise<BatchOutcome> => (id === "ses_gone" ? gone : outcome(logFor(logs, id)));

    const viaRead = await readBatch(many([...idsOf(logs), "ses_gone"], 3000, 1), fetchOutcome, { now: at });
    const viaRender = renderBatch([...logs.map(outcome), gone], { maxChars: 3000, ignored: 1, now: at });

    expect(viaRead).toEqual(viaRender);
    expect(viaRead.unreadable).toEqual([{ id: "ses_gone", reason: "Session ses_gone does not exist." }]);
    expect(viaRead.text).toContain("4/4 ses_gone — could not be read: Session ses_gone does not exist.");
  });

  it("keeps the order asked, even when the later sessions arrive first", async () => {
    const logs = jobs(5);
    const ids = idsOf(logs);
    const slowFirst = async (id: string): Promise<BatchOutcome> => {
      await new Promise((resolve) => setTimeout(resolve, (ids.length - ids.indexOf(id)) * 4));
      return outcome(logFor(logs, id));
    };

    const batch = await readBatch(many(ids), slowFirst, { now: at });

    expect(batch.readable.map((summary) => summary.id)).toEqual(ids);
    const positions = ids.map((id, index) => batch.text.indexOf(`${index + 1}/${ids.length} • ${id} `));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("holds at most BATCH_CONCURRENCY full details at a time: each one is condensed before the next is taken", async () => {
    const logs = jobs(BATCH_CONCURRENCY * 2);
    const order: string[] = [];
    let held = 0;
    let peak = 0;
    const fetchOutcome = async (id: string): Promise<BatchOutcome> => {
      order.push(`fetch ${id}`);
      held += 1;
      peak = Math.max(peak, held);
      const { summary, events } = snapshot(logFor(logs, id)).detail;
      return {
        id,
        detail: {
          summary,
          // 事件数组只在“压成事实”时被读一次：这次读取过后，整份详情就不再被需要了。
          get events() {
            order.push(`digest ${id}`);
            held -= 1;
            return events;
          },
        },
      };
    };

    await readBatch(many(idsOf(logs)), fetchOutcome, { now: at });

    expect(peak).toBeLessThanOrEqual(BATCH_CONCURRENCY);
    expect(order.filter((step) => step.startsWith("digest "))).toHaveLength(logs.length);
    // 第一个会话早在最后一个会话被取之前就压好了；要是全部取完才一起压，这个先后正好相反。
    expect(order.indexOf("digest ses_0")).toBeLessThan(order.indexOf(`fetch ses_${logs.length - 1}`));
  });

  it("takes the display time once, after the last session has been fetched", async () => {
    const running = (id: string): EventLog => {
      const log = new EventLog(id);
      log.created({ title: id });
      log.message(`m_${id}`, "task", "Audit everything");
      log.run(`r_${id}`, 1, `m_${id}`);
      log.startRun(`r_${id}`);
      return log;
    };
    const early = running("ses_early");
    const late = running("ses_late");
    const startedAt = Date.parse(early.now());
    const realNow = Date.now;
    let clock = startedAt + 60_000;
    Date.now = () => clock;
    try {
      const batch = await readBatch(many(["ses_early", "ses_late"]), async (id) => {
        if (id !== "ses_late") return outcome(early);
        // 先让前一个会话取回、压好，再让钟走四分钟：展示时刻若在压缩时就定下，前一个会话读到的会是旧钟。
        await new Promise((resolve) => setTimeout(resolve, 5));
        clock = startedAt + 5 * 60_000;
        return outcome(late);
      });
      expect(batch.text.match(/ {4}run: #1, running for 5m 00s/g)).toHaveLength(2);
    } finally {
      Date.now = realNow;
    }
  });

  it("fails as a whole when fetching one session throws: that is a problem for every session, not for one", async () => {
    const logs = jobs(3);
    const fetchOutcome = async (id: string): Promise<BatchOutcome> => {
      if (id === "ses_1") throw new Error("the service went away");
      return outcome(logFor(logs, id));
    };

    await expect(readBatch(many(idsOf(logs)), fetchOutcome, { now: at })).rejects.toThrow("the service went away");
  });

  it("writes a session whose log cannot be replayed as unreadable, and goes on with the others", async () => {
    const [good] = jobs(1);
    const readable = outcome(good!);
    const bare: BatchOutcome = { id: "ses_empty", detail: { summary: snapshot(good!).detail.summary, events: [] } };

    const batch = await readBatch(many(["ses_empty", "ses_0"]), async (id) => (id === "ses_empty" ? bare : readable), { now: at });

    expect(batch.unreadable).toEqual([{ id: "ses_empty", reason: "it has no readable history." }]);
    expect(batch.text).toContain("1/2 ses_empty — could not be read: it has no readable history.");
    expect(batch.readable.map((summary) => summary.id)).toEqual(["ses_0"]);
  });
});
