import { describe, expect, it } from "vitest";
import { attentionKey, deriveAttention, sameAttention, sortAttention, type AttentionLimits } from "./attention";
import type { EventPayload } from "./events";
import { applyEvent, createState, type SessionState } from "./projection";
import { SYSTEM_ACTOR, type QuestionPrompt } from "./questions";
import { EventLog, USER } from "./testing";
import type { AttentionItem } from "./types";

const MIN = 60_000;
const LIMITS: AttentionLimits = { quietMs: 4 * MIN, longToolMs: 10 * MIN, longRunMs: 60 * MIN, undeliveredMs: 2 * MIN, sharedFileWindowMs: 10 * MIN };

/** 一个正在运行、任务消息已生效的会话；返回日志与状态，`feed()` 把日志里的新事件应用到状态。 */
function running(): { log: EventLog; state: SessionState; feed: () => void } {
  const log = new EventLog();
  const created = log.created();
  if (created.kind !== "session.created") throw new Error("unreachable");
  const state = createState(created);
  let applied = 0;
  const feed = (): void => {
    for (const event of log.events.slice(applied)) applyEvent(state, event);
    applied = log.events.length;
  };
  log.message("msg_1", "task", "Do the thing");
  log.run("run_1", 1, "msg_1");
  log.startRun("run_1");
  log.push({ kind: "message.delivery", data: { messageId: "msg_1", record: { stage: "applied", at: log.now() } } }, { source: "ensemble" });
  feed();
  return { log, state, feed };
}

/** 距离最后一条事件 `ms` 毫秒的时刻。 */
function after(state: SessionState, ms: number): number {
  return Date.parse(state.updatedAt) + ms;
}

describe("deriveAttention: quiet and long_tool", () => {
  it("says nothing while events keep arriving", () => {
    const { state } = running();
    expect(deriveAttention(state, after(state, 30_000), LIMITS)).toEqual([]);
  });

  it("reports a session with no tool in progress once it has been silent for the quiet threshold", () => {
    const { state } = running();
    expect(deriveAttention(state, after(state, 4 * MIN - 1), LIMITS)).toEqual([]);
    expect(deriveAttention(state, after(state, 4 * MIN), LIMITS)).toEqual([{ kind: "quiet", since: state.updatedAt, seq: state.seq, runId: "run_1" }]);
  });

  it("does not call a tool in progress quiet; it waits for the longer tool threshold and names the tool", () => {
    const { log, state, feed } = running();
    log.tool("run_1", "call_build", "running", { name: "shell", category: "shell", title: "npm run build" });
    feed();

    expect(deriveAttention(state, after(state, 5 * MIN), LIMITS)).toEqual([]);
    const [item] = deriveAttention(state, after(state, 10 * MIN), LIMITS);
    expect(item).toMatchObject({ kind: "long_tool", seq: state.seq, tool: { callId: "call_build", category: "shell", title: "npm run build" } });
    expect(item?.kind === "long_tool" ? item.tool.startedAt : undefined).toBe(state.updatedAt);
  });

  it("falls back to quiet once the tool has ended", () => {
    const { log, state, feed } = running();
    log.tool("run_1", "call_build", "running");
    log.tool("run_1", "call_build", "completed");
    feed();
    expect(deriveAttention(state, after(state, 4 * MIN), LIMITS).map((item) => item.kind)).toEqual(["quiet"]);
  });

  it("does not blame a tool that never reported its end while the session keeps producing events", () => {
    const { log, state, feed } = running();
    log.tool("run_1", "call_stale", "running");
    log.tick(20 * MIN);
    log.push({ kind: "assistant.delta", data: { itemId: "a1", text: "still going" } }, { runId: "run_1" });
    feed();
    // 那个工具已经“运行”了二十多分钟，但会话刚刚还在输出：没有静默，也就没有要提的事。
    expect(deriveAttention(state, after(state, 30_000), LIMITS)).toEqual([]);
  });

  it("only looks at sessions that are working", () => {
    const { log, state, feed } = running();
    log.push({ kind: "run.completed", data: { stopReason: "end_turn" } }, { runId: "run_1" });
    feed();
    expect(deriveAttention(state, after(state, 5 * 60 * MIN), LIMITS)).toEqual([]);
  });
});

describe("deriveAttention: long_run", () => {
  it("reports a run that has been going on for the run threshold even though events keep flowing", () => {
    const { log, state, feed } = running();
    const startedAt = state.runs[0]?.startedAt;
    log.tick(61 * MIN);
    log.push({ kind: "assistant.delta", data: { itemId: "a1", text: "x" } }, { runId: "run_1" });
    feed();
    expect(startedAt).toBeDefined();
    expect(deriveAttention(state, after(state, 1_000), LIMITS)).toEqual([{ kind: "long_run", since: startedAt, runId: "run_1" }]);
  });
});

describe("deriveAttention: undelivered", () => {
  function withSteer(stage: "recorded" | "handed_off" | "queued_by_harness" | "applied"): { state: SessionState; sentAt: string } {
    const { log, state, feed } = running();
    // 投递阶段的时间以记录里的 at 为准（而不是事件落盘的时间）。
    let sentAt = log.message("msg_2", "steer", "Skip the slow ones").delivery.at;
    const advance = (record: Extract<EventPayload, { kind: "message.delivery" }>["data"]["record"]): void => {
      sentAt = record.at;
      log.push({ kind: "message.delivery", data: { messageId: "msg_2", record } }, { source: "ensemble" });
    };
    if (stage === "handed_off") advance({ stage: "handed_off", at: log.now() });
    if (stage === "queued_by_harness") advance({ stage: "queued", queuedBy: "harness", at: log.now() });
    if (stage === "applied") advance({ stage: "applied", at: log.now() });
    feed();
    return { state, sentAt };
  }

  it("reports a message stuck at handed_off or recorded after the threshold", () => {
    for (const stage of ["recorded", "handed_off"] as const) {
      const { state, sentAt } = withSteer(stage);
      expect(deriveAttention(state, after(state, 119_000), LIMITS).filter((item) => item.kind === "undelivered")).toEqual([]);
      expect(deriveAttention(state, after(state, 2 * MIN), LIMITS).filter((item) => item.kind === "undelivered")).toEqual([
        { kind: "undelivered", since: sentAt, messageId: "msg_2", messageKind: "steer", stage },
      ]);
    }
  });

  it("does not report a message that is waiting at a boundary or has been applied", () => {
    for (const stage of ["queued_by_harness", "applied"] as const) {
      const { state } = withSteer(stage);
      expect(deriveAttention(state, after(state, 3 * MIN), LIMITS).filter((item) => item.kind === "undelivered")).toEqual([]);
    }
  });

  it("does not keep nagging about sessions that were closed", () => {
    const { log, state, feed } = running();
    log.message("msg_2", "steer", "Skip the slow ones");
    log.push({ kind: "session.status", data: { status: "stopped" } }, { source: "ensemble" });
    feed();
    expect(deriveAttention(state, after(state, 60 * MIN), LIMITS)).toEqual([]);
  });
});

describe("deriveAttention: question", () => {
  const prompts: QuestionPrompt[] = [{ key: "db", text: "Which database should the service use?", options: [{ label: "SQLite" }, { label: "PostgreSQL" }], multiple: false, custom: true }];

  function asking(): ReturnType<typeof running> & { askedAt: string } {
    const session = running();
    const asked = session.log.ask("qst_1", prompts, "run_1");
    session.feed();
    return { ...session, askedAt: asked.at };
  }

  it("is reported from the moment the question is asked, with no waiting threshold, and carries the prompts verbatim", () => {
    const { state, askedAt } = asking();
    expect(deriveAttention(state, after(state, 0), LIMITS)).toEqual([{ kind: "question", since: askedAt, questionId: "qst_1", prompts, runId: "run_1" }]);
  });

  it("does not add quiet or long_tool on top of it: waiting for an answer is the expected silence", () => {
    const { log, state, feed } = running();
    log.tool("run_1", "call_build", "running", { name: "shell", category: "shell", title: "npm run build" });
    log.ask("qst_1", prompts, "run_1");
    feed();
    expect(deriveAttention(state, after(state, 30 * MIN), LIMITS).map((item) => item.kind)).toEqual(["question"]);
  });

  it("goes away the moment the question is answered, and the usual silence rules apply again", () => {
    const { log, state, feed } = asking();
    log.settle({ questionId: "qst_1", outcome: "answered", by: USER, answers: [["SQLite"]], delivery: "handed_off" }, "run_1");
    feed();
    expect(deriveAttention(state, after(state, 0), LIMITS)).toEqual([]);
    expect(deriveAttention(state, after(state, 5 * MIN), LIMITS).map((item) => item.kind)).toEqual(["quiet"]);
  });

  it("goes away when the question expires, whatever the reason", () => {
    const { log, state, feed } = asking();
    log.settle({ questionId: "qst_1", outcome: "expired", by: SYSTEM_ACTOR, reason: "withdrawn" }, "run_1");
    feed();
    expect(deriveAttention(state, after(state, 0), LIMITS)).toEqual([]);
  });

  it("is not reported for a session that was closed: nobody can get an answer to the executor any more", () => {
    const { log, state, feed } = asking();
    log.push({ kind: "session.status", data: { status: "stopped" } }, { source: "ensemble" });
    feed();
    expect(deriveAttention(state, after(state, 0), LIMITS)).toEqual([]);
  });

  it("lists every open question, one item each, in the order they were asked", () => {
    const { log, state, feed } = asking();
    log.ask("qst_2", [{ key: "n", text: "What should the table be called?", multiple: false, custom: true }], "run_1");
    feed();
    expect(deriveAttention(state, after(state, 0), LIMITS).map((item) => (item.kind === "question" ? item.questionId : item.kind))).toEqual(["qst_1", "qst_2"]);
  });

  it("is identified by the question, not by time: same key and no change while it waits", () => {
    const { state } = asking();
    const first = deriveAttention(state, after(state, 0), LIMITS);
    const later = deriveAttention(state, after(state, 20 * MIN), LIMITS);
    expect(first.map(attentionKey)).toEqual(["question|qst_1"]);
    expect(later.map(attentionKey)).toEqual(first.map(attentionKey));
    expect(sameAttention(first, later)).toBe(true);
  });

  it("sorts before everything else: a request for an answer outranks what may merely be stuck", () => {
    const items: AttentionItem[] = [
      { kind: "long_run", since: "2026-01-01T00:00:00.000Z" },
      { kind: "quiet", since: "2026-01-01T00:00:00.000Z", seq: 7 },
      { kind: "question", since: "2026-01-01T00:00:00.000Z", questionId: "qst_1", prompts },
    ];
    expect(sortAttention(items).map((item) => item.kind)).toEqual(["question", "quiet", "long_run"]);
  });
});

describe("attention identity", () => {
  const quiet = (since: string): AttentionItem => ({ kind: "quiet", since, seq: 7 });
  const shared = (since: string, withSessionIds: string[]): AttentionItem => ({ kind: "shared_file", since, path: "C:/work/a.ts", withSessionIds });

  it("keeps the same key for the same quiet period however long it lasts, and a new key for a new one", () => {
    expect(attentionKey(quiet("2026-01-01T00:00:00.000Z"))).toBe(attentionKey(quiet("2026-01-01T00:00:00.000Z")));
    expect(attentionKey(quiet("2026-01-01T00:00:00.000Z"))).not.toBe(attentionKey(quiet("2026-01-01T00:09:00.000Z")));
  });

  it("identifies a shared file by its path, not by when the other session last wrote it", () => {
    expect(attentionKey(shared("2026-01-01T00:00:00.000Z", ["ses_b"]))).toBe(attentionKey(shared("2026-01-01T00:05:00.000Z", ["ses_b"])));
  });

  it("treats a changed latest write or other writer as a change, but nothing else", () => {
    const a = [shared("2026-01-01T00:00:00.000Z", ["ses_b"])];
    expect(sameAttention(a, [shared("2026-01-01T00:00:00.000Z", ["ses_b"])])).toBe(true);
    expect(sameAttention(a, [shared("2026-01-01T00:05:00.000Z", ["ses_b"])])).toBe(false);
    expect(sameAttention(a, [shared("2026-01-01T00:00:00.000Z", ["ses_b", "ses_c"])])).toBe(false);
    expect(sameAttention(undefined, [])).toBe(true);
    expect(sameAttention(a, [])).toBe(false);
  });

  it("orders what may be stuck before what is merely long", () => {
    const items: AttentionItem[] = [
      { kind: "long_run", since: "2026-01-01T00:00:00.000Z" },
      shared("2026-01-01T00:00:00.000Z", ["ses_b"]),
      quiet("2026-01-01T00:00:00.000Z"),
    ];
    expect(sortAttention(items).map((item) => item.kind)).toEqual(["quiet", "shared_file", "long_run"]);
  });
});
