import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { USER } from "@shared/testing";
import { delegatorFor, itemsOf, makeTrackedEnv, shutdownTrackedEnvs, stateOf, until } from "../testing";
import { ClaudeExecutor } from "./claude";

const CLI = fileURLToPath(new URL("../../../test/fixtures/fake-claude.mjs", import.meta.url));
const WAIT = 12_000;
const delegate = delegatorFor("claude");

function setup(extra: NodeJS.ProcessEnv = {}) {
  const log = join(mkdtempSync(join(tmpdir(), "ensemble-claude-log-")), "runs.jsonl");
  writeFileSync(log, "");
  const executor = new ClaudeExecutor({ cli: CLI, env: { ...process.env, FAKE_CLAUDE_LOG: log, CLAUDE_CODE_SKIP_PROMPT_HISTORY: undefined, ...extra } });
  const env = makeTrackedEnv([executor]);
  const launches = (): { args: string[]; parent?: string; depth?: string }[] => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { env, executor, launches };
}

afterEach(shutdownTrackedEnvs);

describe("Claude Code executor", () => {
  it("probes authentication and reports supported access without claiming a live verification", async () => {
    const { executor } = setup({ ANTHROPIC_MODEL: "configured-model" });
    const info = await executor.probe();
    expect(info).toMatchObject({ id: "claude", status: "ready", version: "2.1.322", defaultModel: "configured-model" });
    expect(info.access.read_only?.level).toBe("enforced");
    expect(info.capabilities.steer.support).toBe("no");
    expect(info.capabilities.resume.verification).toBe("declared");
    expect((await setup({ FAKE_CLAUDE_LOGGED_OUT: "1" }).executor.probe()).status).toBe("needs_setup");
    expect((await setup({ FAKE_CLAUDE_OLD: "1" }).executor.probe()).access.read_only).toBeNull();
    expect((await setup({ CLAUDE_CODE_SKIP_PROMPT_HISTORY: "1" }).executor.probe()).setup?.code).toBe("claude_persistence_disabled");
  });

  it("streams a real-shaped run, preserves the native session and resumes it for a follow-up", async () => {
    const { env, launches } = setup();
    const { sessionId, messageId } = await delegate(env, { task: "Inspect [fake:tool]", access: "read_only" });
    await until(() => stateOf(env, sessionId).runs[0]?.status === "completed", WAIT, "first Claude run");
    const state = stateOf(env, sessionId);
    const native = state.meta.nativeRef;
    expect(native).toMatchObject({ kind: "claude-session" });
    expect(state.meta.model?.resolved).toBe("claude-fake-model");
    expect(state.messages.find((message) => message.id === messageId)?.delivery.history.map((entry) => entry.stage)).toEqual(["recorded", "handed_off", "applied"]);
    expect(itemsOf(env, sessionId, "assistant").map((item) => item.text)).toEqual(["Ready."]);
    expect(itemsOf(env, sessionId, "tool")).toMatchObject([{ name: "Read", category: "read", status: "completed", output: { text: "contents" } }]);
    expect(state.usageByRun[state.runs[0]!.id]).toMatchObject({ inputTokens: 14, outputTokens: 2, cachedTokens: 3, totalTokens: 16, costUsd: 0.002 });
    const first = launches()[0]!;
    expect(first.args).toEqual(expect.arrayContaining(["--safe-mode", "--strict-mcp-config", "--tools", "Read,Glob,Grep", "--permission-mode", "bypassPermissions", "--session-id", native!.id]));
    expect(first.parent).toBe(sessionId);
    await env.manager.send(sessionId, { text: "Continue", author: USER });
    await until(() => state.runs[1]?.status === "completed", WAIT, "Claude follow-up");
    expect(launches()[1]?.args).toEqual(expect.arrayContaining(["--resume", native!.id]));
    expect(state.meta.nativeRef).toEqual(native);
    expect(itemsOf(env, sessionId, "assistant").map((item) => item.text)).toEqual(["Ready.", "Ready."]);
  });

  it("queues a correction for the next run when the current run cannot be steered", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Wait [fake:slow]" });
    await until(() => stateOf(env, sessionId).runs[0]?.status === "running", WAIT);
    const queued = await env.manager.send(sessionId, { text: "Use a different approach", mode: "steer", author: USER });
    const state = stateOf(env, sessionId);
    await until(() => state.runs[1]?.status === "completed", WAIT);
    expect(queued.runId).toBe(state.runs[1]?.id);
    expect(state.messages.find((message) => message.id === queued.messageId)?.delivery.history.map((entry) => entry.stage)).toEqual(["recorded", "queued", "handed_off", "applied"]);
  });

  it("cancels one process without interrupting the next run", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { task: "Wait [fake:hold]" });
    await until(() => stateOf(env, sessionId).runs[0]?.status === "running", WAIT);
    await env.manager.cancel(sessionId, USER);
    await until(() => stateOf(env, sessionId).runs[0]?.status === "cancelled", WAIT);
    const follow = await env.manager.send(sessionId, { text: "Continue", author: USER });
    await until(() => stateOf(env, sessionId).runs.find((run) => run.id === follow.runId)?.status === "completed", WAIT);
    expect(stateOf(env, sessionId).runs.map((run) => run.status)).toEqual(["cancelled", "completed"]);
  });

  it("fails instead of claiming success when the process exits without a result or reports unsafe tools", async () => {
    const normal = setup();
    const missing = await delegate(normal.env, { task: "[fake:noresult]" });
    await until(() => stateOf(normal.env, missing.sessionId).runs[0]?.status === "failed", WAIT);
    const unsafe = setup({ FAKE_CLAUDE_UNSAFE: "1" });
    const blocked = await delegate(unsafe.env, { task: "Inspect", access: "read_only" });
    await until(() => stateOf(unsafe.env, blocked.sessionId).runs[0]?.status === "failed", WAIT);
    expect(stateOf(unsafe.env, blocked.sessionId).runs[0]?.error?.code).toBe("access_unsupported");
    expect(stateOf(unsafe.env, blocked.sessionId).runs[0]?.startedAt).toBeUndefined();
  });

  it("does not claim a message was applied before a valid initialization", async () => {
    const early = setup();
    const rejected = await delegate(early.env, { task: "[fake:early]" });
    await until(() => stateOf(early.env, rejected.sessionId).runs[0]?.status === "failed", WAIT);
    const earlyState = stateOf(early.env, rejected.sessionId);
    expect(earlyState.runs[0]?.startedAt).toBeUndefined();
    expect(earlyState.messages[0]?.delivery.history.map((entry) => entry.stage)).not.toContain("applied");

    const reverse = setup({ FAKE_CLAUDE_REVERSE_INIT: "1", FAKE_CLAUDE_UNSAFE: "1" });
    const blocked = await delegate(reverse.env, { task: "Inspect", access: "read_only" });
    await until(() => stateOf(reverse.env, blocked.sessionId).runs[0]?.status === "failed", WAIT);
    const blockedState = stateOf(reverse.env, blocked.sessionId);
    expect(blockedState.runs[0]?.error?.code).toBe("access_unsupported");
    expect(blockedState.runs[0]?.startedAt).toBeUndefined();
    expect(blockedState.messages[0]?.delivery.history.map((entry) => entry.stage)).not.toContain("applied");

    const noInit = setup({ FAKE_CLAUDE_NO_INIT: "1" });
    const invalid = await delegate(noInit.env, { task: "Inspect" });
    await until(() => stateOf(noInit.env, invalid.sessionId).runs[0]?.status === "failed", WAIT);
    expect(stateOf(noInit.env, invalid.sessionId).meta.nativeRef).toBeUndefined();
  });
});
