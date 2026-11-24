import { describe, expect, it } from "vitest";
import { replay, toSummary, type SessionState } from "@shared/projection";
import type { SendResponse } from "@shared/protocol";
import type { HarnessInfo, Notice, Run, SessionPhase } from "@shared/types";
import { EventLog, USER } from "@shared/testing";
import {
  collectFiles,
  finalAnswer,
  modelText,
  renderHarness,
  renderNotices,
  renderResult,
  renderSessionDetail,
  renderSessionLine,
  renderSharedOriginHint,
  renderTranscript,
  runScopeLine,
  sendOutcomeText,
} from "./format";

function build(setup: (log: EventLog) => void, meta = {}): { state: SessionState; log: EventLog } {
  const log = new EventLog();
  log.created(meta);
  setup(log);
  const state = replay(log.events);
  if (!state) throw new Error("replay failed");
  return { state, log };
}

function startedRun(log: EventLog): void {
  log.message("m1", "task", "Audit the auth module");
  log.run("r1", 1, "m1");
  log.startRun("r1");
}

const afterMs = (log: EventLog, ms: number) => Date.parse(log.now()) + ms;

describe("session text", () => {
  it("describes a running session with its live activity", () => {
    const { state, log } = build((l) => {
      startedRun(l);
      l.tool("r1", "c1", "running", { title: "npm test", category: "shell" });
    });
    const line = renderSessionLine(toSummary(state), { now: afterMs(log, 14_000) });
    expect(line).toContain("• ses_test [Pi]");
    expect(line).toContain('"Refactor the parser"');
    expect(line).toContain("running — shell `npm test`");
    expect(line).toContain("1 tool step");
  });

  it("marks simulated harnesses so they are never mistaken for the real thing", () => {
    const { state } = build(() => {}, { runtime: "fixture" });
    expect(renderSessionLine(toSummary(state))).toContain("[Pi (simulated)]");
  });

  it("spells DSH in capitals instead of capitalising its id into “Dsh”", () => {
    const real = build(() => {}, { harness: "dsh" }).state;
    expect(renderSessionLine(toSummary(real))).toContain("[DSH]");
    const simulated = build(() => {}, { harness: "dsh", runtime: "fixture" }).state;
    expect(renderSessionLine(toSummary(simulated))).toContain("[DSH (simulated)]");
  });

  it("shows a Full Access session without anything that waits on the user", () => {
    const { state, log } = build(
      (l) => {
        startedRun(l);
        l.tool("r1", "c1", "running", { title: "npm install", category: "shell" });
      },
      { access: "full", accessEnforcement: { level: "none", mechanism: "Pi has no sandbox" } },
    );
    const text = renderSessionDetail(toSummary(state), { now: afterMs(log, 1000) });
    expect(text).toContain("access: full (NOT enforced: Pi has no sandbox)");
    expect(text).toContain("running — shell `npm install`");
    expect(text).not.toMatch(/needs the user|permission|approve/i);
  });

  it("is honest about access that is not enforced", () => {
    const { state } = build(() => {}, { access: "read_only", accessEnforcement: { level: "advisory", mechanism: "prompt only" } });
    expect(renderSessionDetail(toSummary(state))).toContain("read_only (prompt-only, not enforced: prompt only)");
  });

  it("shows the resolved model next to what was requested", () => {
    expect(modelText({ requested: "fast", resolved: "gpt-5.6-luna" }, "low")).toBe("gpt-5.6-luna (requested fast), effort low");
    expect(modelText(undefined, undefined)).toBe("harness default");
  });

  it("includes the failure reason", () => {
    const { state } = build((l) => {
      startedRun(l);
      l.push({ kind: "run.failed", data: { error: { code: "rate_limited", message: "Usage limit reached." } } }, { runId: "r1" });
    });
    const text = renderSessionDetail(toSummary(state));
    expect(text).toContain("failed");
    expect(text).toContain("error: [rate_limited] Usage limit reached.");
  });
});

describe("result view", () => {
  const finished = () =>
    build((l) => {
      startedRun(l);
      l.tool("r1", "c1", "completed", { title: "src/auth.ts", category: "edit" });
      l.push({ kind: "file.changed", data: { callId: "c1", files: [{ path: "src/auth.ts", change: "modified", addedLines: 4, removedLines: 1 }] } }, { runId: "r1" });
      l.push({ kind: "assistant.delta", data: { itemId: "a1", text: "Looked at it. ", phase: "commentary" } }, { runId: "r1" });
      l.push({ kind: "assistant.completed", data: { itemId: "a1", phase: "commentary" } }, { runId: "r1" });
      l.push({ kind: "assistant.delta", data: { itemId: "a2", text: "Found 2 issues in auth.ts.", phase: "final" } }, { runId: "r1" });
      l.push({ kind: "assistant.completed", data: { itemId: "a2", phase: "final" } }, { runId: "r1" });
      l.push({ kind: "usage.updated", data: { usage: { totalTokens: 12_300 } } }, { runId: "r1" });
      l.push({ kind: "run.completed", data: {} }, { runId: "r1" });
    });

  it("returns the final answer, changed files and usage", () => {
    const { state } = finished();
    const text = renderResult(state, toSummary(state), { maxChars: 8000 });
    expect(text).toContain("Final answer:\nFound 2 issues in auth.ts.");
    expect(text).not.toContain("Looked at it.");
    expect(text).toContain("Files changed (1):");
    expect(text).toContain("modified src/auth.ts +4 −1");
    expect(text).toContain("Usage: 12k tokens");
    expect(collectFiles(state)).toHaveLength(1);
    expect(finalAnswer(state)?.final).toBe(true);
  });

  it("does not present output from a run that is still going as a final answer", () => {
    const { state } = build((l) => {
      startedRun(l);
      l.push({ kind: "assistant.delta", data: { itemId: "a1", text: "Working on it", phase: "commentary" } }, { runId: "r1" });
    });
    const text = renderResult(state, toSummary(state), { maxChars: 8000 });
    expect(text).toContain("not a final answer");
    expect(text).toContain("Working on it");
  });

  it("says so when there is no output yet", () => {
    const { state } = build(startedRun);
    expect(renderResult(state, toSummary(state), { maxChars: 8000 })).toContain("No output yet");
  });

  it("truncates a very long answer and points to the transcript", () => {
    const { state } = build((l) => {
      startedRun(l);
      l.push({ kind: "assistant.delta", data: { itemId: "a1", text: "x".repeat(5000), phase: "final" } }, { runId: "r1" });
      l.push({ kind: "assistant.completed", data: { itemId: "a1", phase: "final" } }, { runId: "r1" });
      l.push({ kind: "run.completed", data: {} }, { runId: "r1" });
    });
    const text = renderResult(state, toSummary(state), { maxChars: 1500 });
    expect(text.length).toBeLessThan(2200);
    expect(text).toContain('more characters; use view="transcript"');
  });
});

describe("result view for one run", () => {
  const twoRuns = () =>
    build((l) => {
      startedRun(l);
      l.tool("r1", "c1", "completed", { title: "src/a.ts", category: "edit" });
      l.push({ kind: "file.changed", data: { callId: "c1", files: [{ path: "src/a.ts", change: "modified", addedLines: 4, removedLines: 1 }] } }, { runId: "r1" });
      l.push({ kind: "assistant.delta", data: { itemId: "a1", text: "First answer.", phase: "final" } }, { runId: "r1" });
      l.push({ kind: "assistant.completed", data: { itemId: "a1", phase: "final" } }, { runId: "r1" });
      l.push({ kind: "usage.updated", data: { usage: { totalTokens: 2_000 } } }, { runId: "r1" });
      l.push({ kind: "run.completed", data: {} }, { runId: "r1" });
      l.message("m2", "follow_up", "And the second thing", USER);
      l.run("r2", 2, "m2", "follow_up");
      l.startRun("r2");
      l.tool("r2", "c2", "completed", { title: "src/b.ts", category: "edit" });
      l.push({ kind: "file.changed", data: { callId: "c2", files: [{ path: "src/b.ts", change: "created", addedLines: 9 }] } }, { runId: "r2" });
      l.push({ kind: "assistant.delta", data: { itemId: "a2", text: "Second answer.", phase: "final" } }, { runId: "r2" });
      l.push({ kind: "assistant.completed", data: { itemId: "a2", phase: "final" } }, { runId: "r2" });
      l.push({ kind: "usage.updated", data: { usage: { totalTokens: 500 } } }, { runId: "r2" });
      l.push({ kind: "run.completed", data: {} }, { runId: "r2" });
    });

  it("leaves the default as it was: the latest run's answer, every file, the whole session's usage", () => {
    const { state } = twoRuns();
    const text = renderResult(state, toSummary(state), { maxChars: 8000 });
    expect(text).toContain("Final answer:\nSecond answer.");
    expect(text).toContain("Files changed (2):");
    expect(text).toContain("Usage: 2.5k tokens");
    expect(text).not.toMatch(/^Run \d+ of \d+/m);
  });

  it("takes the answer, files and usage of the run asked for, under a line saying which run it is", () => {
    const { state } = twoRuns();
    const summary = toSummary(state);
    const first = renderResult(state, summary, { maxChars: 8000, run: state.runs[0]! });
    expect(first).toMatch(/\nRun 1 of 2 · completed in \d+s\n/);
    expect(first).toContain("Final answer:\nFirst answer.");
    expect(first).not.toContain("Second answer.");
    expect(first).toContain("Files changed (1):\n  - modified src/a.ts +4 −1");
    expect(first).toContain("Usage (run 1): 2.0k tokens");

    const second = renderResult(state, summary, { maxChars: 8000, run: state.runs[1]! });
    expect(second).toContain("Final answer:\nSecond answer.");
    expect(second).toContain("Files changed (1):\n  - created src/b.ts +9 −0");
    expect(second).toContain("Usage (run 2): 500 tokens");
  });

  it("shows the failure of the run asked for, and says so when that run produced no text", () => {
    const { state } = build((l) => {
      startedRun(l);
      l.push({ kind: "run.failed", data: { error: { code: "rate_limited", message: "Usage limit reached." } } }, { runId: "r1" });
      l.message("m2", "follow_up", "Try again", USER);
      l.run("r2", 2, "m2", "follow_up");
      l.startRun("r2");
      l.push({ kind: "assistant.delta", data: { itemId: "a1", text: "Worked this time.", phase: "final" } }, { runId: "r2" });
      l.push({ kind: "assistant.completed", data: { itemId: "a1", phase: "final" } }, { runId: "r2" });
      l.push({ kind: "run.completed", data: {} }, { runId: "r2" });
    });
    const summary = toSummary(state);
    const first = renderResult(state, summary, { maxChars: 8000, run: state.runs[0]! });
    expect(first).toContain("Error: [rate_limited] Usage limit reached.");
    expect(first).toContain("The session produced no assistant text in this run.");
    const second = renderResult(state, summary, { maxChars: 8000, run: state.runs[1]! });
    expect(second).not.toContain("Error:");
    expect(second).toContain("Final answer:\nWorked this time.");
  });

  it("points at maxChars, not at a transcript that would clip it too, when one run's long answer is cut", () => {
    const { state } = build((l) => {
      startedRun(l);
      l.push({ kind: "assistant.delta", data: { itemId: "a1", text: "x".repeat(5000), phase: "final" } }, { runId: "r1" });
      l.push({ kind: "assistant.completed", data: { itemId: "a1", phase: "final" } }, { runId: "r1" });
      l.push({ kind: "run.completed", data: {} }, { runId: "r1" });
    });
    const text = renderResult(state, toSummary(state), { maxChars: 1500, run: state.runs[0]! });
    expect(text).toContain("more characters; raise maxChars to see more");
    expect(text).not.toContain('view="transcript"');
  });
});

describe("runScopeLine", () => {
  const run = (patch: Partial<Run>): Run => ({
    id: "r2",
    sessionId: "ses_test",
    index: 2,
    trigger: "follow_up",
    messageId: "m2",
    status: "queued",
    queuedAt: "2026-01-01T00:00:00.000Z",
    steerCount: 0,
    ...patch,
  });
  const startedAt = "2026-01-01T00:00:10.000Z";
  const at = (seconds: number) => new Date(Date.parse(startedAt) + seconds * 1000).toISOString();

  it("says which run it is and where it stands", () => {
    expect(runScopeLine(run({}), 3, 0)).toBe("Run 2 of 3 · queued, not started yet");
    expect(runScopeLine(run({ status: "starting" }), 3, 0)).toBe("Run 2 of 3 · starting");
    expect(runScopeLine(run({ status: "running", startedAt }), 3, Date.parse(startedAt) + 75_000)).toBe("Run 2 of 3 · running for 1m 15s");
    expect(runScopeLine(run({ status: "completed", startedAt, endedAt: at(120) }), 3, 0)).toBe("Run 2 of 3 · completed in 2m 00s");
    expect(runScopeLine(run({ status: "failed", startedAt, endedAt: at(5) }), 3, 0)).toBe("Run 2 of 3 · failed after 5s");
    expect(runScopeLine(run({ status: "cancelled", startedAt, endedAt: at(7) }), 3, 0)).toBe("Run 2 of 3 · cancelled after 7s");
    expect(runScopeLine(run({ status: "cancelled" }), 3, 0)).toBe("Run 2 of 3 · cancelled before it started");
  });
});

describe("transcript view", () => {
  it("lists the delegation, steps, interventions and delivery state in order", () => {
    const { state } = build((l) => {
      startedRun(l);
      l.tool("r1", "c1", "completed", { title: "rg auth", category: "search" });
      l.tool("r1", "c2", "failed", { title: "npm test", category: "shell", exitCode: 1, error: "2 tests failed" });
      const steer = l.message("m2", "steer", "Skip the migration tests", USER, "r1");
      l.push({ kind: "message.delivery", data: { messageId: steer.id, record: { stage: "handed_off", at: l.now() } } }, { runId: "r1" });
      l.push({ kind: "assistant.delta", data: { itemId: "a1", text: "Done.", phase: "final" } }, { runId: "r1" });
      l.push({ kind: "assistant.completed", data: { itemId: "a1", phase: "final" } }, { runId: "r1" });
      l.push({ kind: "run.completed", data: {} }, { runId: "r1" });
    });
    const text = renderTranscript(state, toSummary(state), { maxChars: 8000 });
    const order = ["task → Pi", "search: rg auth → ok", "shell: npm test → failed (exit 1)", "2 tests failed", "correction from You", "handed to the harness", "Pi: Done.", "run 1 completed"];
    let last = -1;
    for (const needle of order) {
      const at = text.indexOf(needle);
      expect(at, needle).toBeGreaterThan(last);
      last = at;
    }
  });

  it("drops the oldest entries first when over budget, and says how many", () => {
    const { state } = build((l) => {
      startedRun(l);
      for (let i = 0; i < 30; i++) l.tool("r1", `c${i}`, "completed", { title: `step number ${i}`, category: "shell" });
    });
    const text = renderTranscript(state, toSummary(state), { maxChars: 900 });
    expect(text.length).toBeLessThan(1100);
    expect(text).toMatch(/\(\d+ earlier entries omitted/);
    expect(text).toContain("step number 29");
    expect(text).not.toContain("step number 0 ");
  });

  it("leaves reasoning out unless asked", () => {
    const { state } = build((l) => {
      startedRun(l);
      l.push({ kind: "reasoning.delta", data: { itemId: "t1", text: "Considering the options" } }, { runId: "r1" });
      l.push({ kind: "reasoning.completed", data: { itemId: "t1" } }, { runId: "r1" });
    });
    const summary = toSummary(state);
    expect(renderTranscript(state, summary, { maxChars: 4000 })).not.toContain("Considering");
    expect(renderTranscript(state, summary, { maxChars: 4000, includeReasoning: true })).toContain("reasoning summary): Considering the options");
  });
});

describe("delivery wording", () => {
  const response = (kind: SendResponse["kind"], stage: SendResponse["stage"]) => ({ kind, stage }) as SendResponse;

  it("never claims a handed-off correction has taken effect", () => {
    const text = sendOutcomeText(response("steer", "handed_off"), "Codex");
    expect(text).toContain("has not yet confirmed");
    expect(text).not.toMatch(/confirmed applied/);
  });

  it("distinguishes queued follow-ups from queued corrections", () => {
    expect(sendOutcomeText(response("follow_up", "queued"), "Pi")).toContain("start a new run");
    expect(sendOutcomeText(response("steer", "queued"), "Pi")).toContain("next safe boundary");
  });

  it("reports confirmed and failed deliveries plainly", () => {
    expect(sendOutcomeText(response("steer", "applied"), "Pi")).toContain("confirmed applied");
    expect(sendOutcomeText(response("steer", "failed"), "Pi")).toContain("could not be delivered");
  });
});

describe("harness and notice text", () => {
  const info = (patch: Partial<HarnessInfo>): HarnessInfo => ({
    id: "codex",
    displayName: "Codex",
    runtime: "native",
    status: "ready",
    models: [{ id: "gpt-5.6-luna", label: "luna", isDefault: true }, { id: "gpt-5.6-sol", label: "sol" }],
    defaultModel: "gpt-5.6-luna",
    capabilities: {
      steer: { support: "yes", verification: "live" },
      followUp: { support: "yes", verification: "declared" },
      cancel: { support: "yes", verification: "live" },
      resume: { support: "no" },
      reasoning: { support: "yes" },
      plan: { support: "yes" },
      usage: { support: "yes" },
      fileEvents: { support: "partial" },
    },
    access: {
      read_only: { level: "enforced", mechanism: "sandbox" },
      full: { level: "none", mechanism: "no sandbox" },
    },
    checkedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  });

  it("separates verified from merely declared abilities", () => {
    const text = renderHarness(info({ version: "0.151.0" }));
    expect(text).toContain("codex — Codex: ready · v0.151.0");
    expect(text).toContain("models: gpt-5.6-luna*, gpt-5.6-sol");
    expect(text).toContain("steer mid-run, follow-up (declared), cancel, no resume after restart");
    expect(text).toContain("read_only: enforced · full: not enforced");
    expect(text).not.toContain("workspace_write");
  });

  it("shows setup guidance for a harness that is not ready", () => {
    const text = renderHarness(info({ status: "needs_setup", setup: { code: "codex_login_required", message: "Sign in to Codex.", command: "codex login" } }));
    expect(text).toContain("needs_setup");
    expect(text).toContain("Sign in to Codex. — run: codex login");
    expect(text).not.toContain("models:");
  });

  it("lists only the models the user has allowed, and says so", () => {
    const text = renderHarness(info({ allowedModels: ["gpt-5.6-sol"] }));
    expect(text).toContain("models: gpt-5.6-sol*  (* = default; only these are allowed by the user)");
    // 没被开放的模型对主 Agent 不存在，连名字都不出现。
    expect(text).not.toContain("gpt-5.6-luna");
  });

  it("keeps the harness default only when the user left it open", () => {
    expect(renderHarness(info({ allowedModels: ["gpt-5.6-luna", "gpt-5.6-sol"] }))).toContain("models: gpt-5.6-luna*, gpt-5.6-sol");
    expect(renderHarness(info({}))).not.toContain("allowed by the user");
  });

  describe("the default the user chose in the settings", () => {
    const line = (text: string): string | undefined => text.split("\n").find((entry) => entry.includes("default model:"));

    it("says nothing extra while the harness's own default applies: the `*` is that default", () => {
      expect(line(renderHarness(info({})))).toBeUndefined();
      expect(line(renderHarness(info({ allowedModels: ["gpt-5.6-luna", "gpt-5.6-sol"] })))).toBeUndefined();
    });

    it("marks the chosen model with `*`, and says it was the user's choice and what the harness would use itself", () => {
      const text = renderHarness(info({ userDefaultModel: "gpt-5.6-sol" }));
      expect(text).toContain("models: gpt-5.6-luna, gpt-5.6-sol*");
      expect(line(text)).toBe("    default model: gpt-5.6-sol — chosen by the user in Ensemble's settings; used when you omit `model` (the harness's own default is gpt-5.6-luna)");
    });

    it("does not repeat itself when the user chose what the harness defaults to, and never names a model the user has closed", () => {
      expect(line(renderHarness(info({ userDefaultModel: "gpt-5.6-luna" })))).toBe("    default model: gpt-5.6-luna — chosen by the user in Ensemble's settings; used when you omit `model`");
      const closed = renderHarness(info({ allowedModels: ["gpt-5.6-sol"], userDefaultModel: "gpt-5.6-sol" }));
      expect(line(closed)).toBe("    default model: gpt-5.6-sol — chosen by the user in Ensemble's settings; used when you omit `model`");
      expect(closed).not.toContain("gpt-5.6-luna");
    });

    it("says when the chosen default cannot be used right now, and what is used instead — without naming it", () => {
      const gone = renderHarness(info({ userDefaultModel: "retired-model" }));
      expect(line(gone)).toBe("    default model: gpt-5.6-luna — used when you omit `model`. The default the user chose in Ensemble's settings is not usable right now (this harness no longer offers that model), so the harness's own default applies instead");
      expect(gone).not.toContain("retired-model");

      const closed = renderHarness(info({ allowedModels: ["gpt-5.6-luna"], userDefaultModel: "gpt-5.6-sol" }));
      expect(line(closed)).toBe("    default model: gpt-5.6-luna — used when you omit `model`. The default the user chose in Ensemble's settings is not usable right now (that model is not among the ones the user allows), so the harness's own default applies instead");
      expect(closed).not.toContain("gpt-5.6-sol");

      const first = renderHarness(info({ allowedModels: ["gpt-5.6-sol"], userDefaultModel: "retired-model" }));
      expect(line(first)).toContain("so the first model the user allows applies instead");
    });

    it("when the harness reports no default either, says the harness will pick", () => {
      const text = renderHarness(info({ defaultModel: undefined, models: [{ id: "gpt-5.6-luna", label: "luna" }], userDefaultModel: "retired-model" }));
      expect(line(text)).toBe("    default model: none fixed — omitting `model` lets the harness pick its own. The default the user chose in Ensemble's settings is not usable right now (this harness no longer offers that model)");
    });

    it("adds nothing when no model can be chosen at all", () => {
      expect(line(renderHarness(info({ allowedModels: [], userDefaultModel: "gpt-5.6-sol" })))).toBeUndefined();
      expect(line(renderHarness(info({ modelSettingsIssue: "invalid_entry", userDefaultModel: "gpt-5.6-sol" })))).toBeUndefined();
    });
  });

  it("tells the main agent not to delegate when nothing is allowed", () => {
    const text = renderHarness(info({ allowedModels: [] }));
    expect(text).toContain("models: none allowed");
    expect(text).toContain("do not delegate");
    expect(text).not.toContain("gpt-5.6");
    // 能力等其他信息照常给，主 Agent 仍能判断这个执行端本身的状况。
    expect(text).toContain("steer mid-run");
  });

  it("caps a long list but counts what is left", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ id: `m${i}`, label: `m${i}` }));
    const text = renderHarness(info({ models: many, defaultModel: undefined, allowedModels: many.slice(0, 10).map((m) => m.id) }));
    // 执行端没声明默认模型：限制之后，不指定模型时落到第一个被开放的，所以标在它上面。
    expect(text).toContain("m0*, m1, m2, m3, m4, m5, m6, m7, … (+2)");
    expect(text).not.toContain("m10");
  });

  it("renders interventions with the user's own words", () => {
    const notice: Notice = {
      id: "n1",
      originKey: "k",
      sessionId: "ses_1",
      kind: "intervention",
      createdAt: "2026-01-01T00:00:00.000Z",
      summary: "The user sent a correction to Pi.",
      text: "Use tabs, not spaces.",
    };
    const text = renderNotices([notice]);
    expect(text).toContain("[ses_1] The user sent a correction to Pi.");
    expect(text).toContain('user wrote: "Use tabs, not spaces."');
    expect(renderNotices([])).toBe("");
  });
});

describe("renderSharedOriginHint", () => {
  const bridgeLevel = {};
  const declared = { sessionRef: { id: "c-1", kind: "conversation" as const, source: "declared" as const } };
  const at = (phase: SessionPhase, cwd: string) => ({ phase, cwd });

  it("points out that an origin without a conversation identity may be shared when its running sessions work in different directories", () => {
    const hint = renderSharedOriginHint(bridgeLevel, [at("running", "C:\\proj\\a"), at("running", "C:\\proj\\b")]);
    expect(hint).toContain("may be shared by several conversations");
    expect(hint).toContain("2 different directories");
    expect(hint).toContain("`sessionIds`");
    expect(hint).toContain("`conversationId`");
  });

  it("counts every phase that occupies a harness, and nothing else", () => {
    for (const phase of ["starting", "queued", "running"] as const) {
      expect(renderSharedOriginHint(bridgeLevel, [at(phase, "C:\\a"), at("running", "C:\\b")]), phase).toBeDefined();
    }
    // 待命与各种已结束的会话没有在干活，不构成“同时在跑”。
    for (const phase of ["ready", "done", "failed", "cancelled", "stopped", "lost"] as const) {
      expect(renderSharedOriginHint(bridgeLevel, [at(phase, "C:\\a"), at("running", "C:\\b")]), phase).toBeUndefined();
    }
  });

  it("stays silent for one directory (however it is written), for a single session, for no sessions", () => {
    expect(renderSharedOriginHint(bridgeLevel, [at("running", "C:\\proj\\a"), at("running", "C:\\proj\\a")])).toBeUndefined();
    expect(renderSharedOriginHint(bridgeLevel, [at("running", "C:\\proj\\a"), at("running", "C:\\proj\\a\\")])).toBeUndefined();
    expect(renderSharedOriginHint(bridgeLevel, [at("running", "C:\\proj\\a")])).toBeUndefined();
    expect(renderSharedOriginHint(bridgeLevel, [])).toBeUndefined();
  });

  it("stays silent once the origin has an identity of its own", () => {
    expect(renderSharedOriginHint(declared, [at("running", "C:\\proj\\a"), at("running", "C:\\proj\\b")])).toBeUndefined();
  });
});
