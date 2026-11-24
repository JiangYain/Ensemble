import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { toSummary } from "@shared/projection";
import { USER } from "@shared/testing";
import type { AssistantItem, PlanItem, ReasoningItem } from "@shared/types";
import { shutdownTrackedEnvs, stateOf, until } from "../testing";
import { assistantText, failure, finished, thinking, toolCall, typedError, usageMessage, success } from "./cursor-fake";
import { WAIT, completed, delegate, diagnostics, messageOf, runOf, setup, tools } from "./cursor-test-kit";

afterEach(shutdownTrackedEnvs);

// ───────────────────────── 事件映射 ─────────────────────────

describe("Cursor event mapping", () => {
  it("maps thinking, answers, tool calls, file changes, plans and usage from SDK messages", async () => {
    const { env, fake } = setup();
    writeFileSync(join(env.cwd, "existing.txt"), "old\n");
    const { sessionId, messageId } = await delegate(env, { task: "Tidy the repo" });
    const run = await runOf(fake);

    run.push(
      { type: "system", agent_id: "agent-1", run_id: "run-1", model: { id: "auto" }, tools: ["read", "shell", "edit"] },
      thinking("Considering "),
      thinking("the layout"),
      thinking("", 1200),
      assistantText("I'll look "),
      assistantText("around."),
      toolCall("c1", "read", "running", { path: "existing.txt" }),
      toolCall("c1", "read", "completed", { path: "existing.txt" }, success({ content: "old\n", totalLines: 1, fileSize: 4 })),
      toolCall("c2", "edit", "running", { path: "new.txt" }),
      toolCall("c2", "edit", "completed", { path: "new.txt" }, success({ linesAdded: 3, linesRemoved: 0, diffString: "+a\n+b\n+c\n" })),
      toolCall("c3", "edit", "running", { path: "existing.txt" }),
      toolCall("c3", "edit", "completed", { path: "existing.txt" }, success({ linesAdded: 1, linesRemoved: 1 })),
      toolCall("c4", "shell", "running", { command: "echo done" }),
      toolCall("c4", "shell", "completed", { command: "echo done" }, success({ exitCode: 0, signal: "", stdout: "done\n", stderr: "", executionTime: 12 })),
      toolCall("c5", "shell", "running", { command: "exit 3" }),
      toolCall("c5", "shell", "completed", { command: "exit 3" }, success({ exitCode: 3, signal: "", stdout: "", stderr: "boom\n", executionTime: 5 })),
      toolCall(
        "c6",
        "updateTodos",
        "completed",
        { todos: [{ content: "Inspect", status: "completed" }, { content: "Fix", status: "inProgress" }, { content: "Ship", status: "pending" }] },
        success({
          todos: [
            { content: "Inspect", status: "completed" },
            { content: "Fix", status: "inProgress" },
            { content: "Ship", status: "pending" },
          ],
          totalCount: 3,
        }),
      ),
      assistantText("All done."),
      usageMessage(100, 10, 50),
      usageMessage(100, 10, 50),
    );
    run.finish(finished("All done.", { durationMs: 1234, usage: { inputTokens: 250, outputTokens: 25, cacheReadTokens: 100, cacheWriteTokens: 0, totalTokens: 275 } }));
    await until(completed(env, sessionId), WAIT, "run completed");

    const state = stateOf(env, sessionId);
    expect(state.meta.nativeRef).toEqual({ kind: "cursor-agent", id: "agent-1" });
    expect(state.meta.model).toMatchObject({ resolved: "auto", label: "Auto" });
    expect(state.runs[0]?.nativeTurnId).toBe("run-1");
    expect(state.status).toBe("idle");

    // 任务消息的投递证据：run.started 必须排在“已交给执行端”之后。
    expect(messageOf(env, sessionId, messageId).delivery.history.map((h) => h.stage)).toEqual(["recorded", "handed_off", "applied"]);

    const reasoning = state.timeline.filter((item): item is ReasoningItem => item.type === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]).toMatchObject({ text: "Considering the layout", streaming: false, durationMs: 1200 });

    const assistants = state.timeline.filter((item): item is AssistantItem => item.type === "assistant");
    expect(assistants.map((a) => [a.text, a.phase])).toEqual([
      ["I'll look around.", "commentary"],
      ["All done.", "final"],
    ]);

    const items = tools(env, sessionId);
    expect(items.map((t) => [t.callId, t.category, t.status, t.title])).toEqual([
      ["c1", "read", "completed", "existing.txt"],
      ["c2", "edit", "completed", "new.txt"],
      ["c3", "edit", "completed", "existing.txt"],
      ["c4", "shell", "completed", "echo done"],
      ["c5", "shell", "failed", "exit 3"],
      ["c6", "plan", "completed", "updateTodos"],
    ]);
    expect(items[0]?.output?.text).toBe("old\n");
    expect(items[3]?.output?.text).toBe("done\n");
    expect(items[3]?.exitCode).toBe(0);
    expect(items[4]?.exitCode).toBe(3);
    expect(items[4]?.error).toContain("boom");

    // “新建 vs 修改”要在工具运行之前判定；编辑工具的结果 JSON 不原样倒出来。
    expect(items[1]?.files).toEqual([
      expect.objectContaining({ path: "new.txt", change: "created", addedLines: 3, removedLines: 0 }),
    ]);
    expect(items[1]?.files?.[0]?.diff?.text).toContain("+a");
    expect(items[1]?.output).toBeUndefined();
    expect(items[2]?.files).toEqual([expect.objectContaining({ path: "existing.txt", change: "modified", addedLines: 1, removedLines: 1 })]);

    const plan = state.timeline.find((item): item is PlanItem => item.type === "plan");
    expect(plan?.entries.map((e) => [e.text, e.status])).toEqual([
      ["Inspect", "completed"],
      ["Fix", "in_progress"],
      ["Ship", "pending"],
    ]);

    // 运行结束时 RunResult.usage 是最终口径，覆盖逐轮累计。
    expect(toSummary(state).usage).toMatchObject({ inputTokens: 250, outputTokens: 25, cachedTokens: 100, totalTokens: 275 });
  });

  it("replays a real run captured from SDK 1.0.28 without noise or a system message", async () => {
    const { env, fake } = setup();
    const { sessionId } = await delegate(env, { task: "List the files" });
    const run = await runOf(fake);

    const ids = { agent_id: "agent-1", run_id: "run-1" };
    const think = (text: string, durationMs?: number) => ({
      type: "thinking",
      ...ids,
      text,
      ...(durationMs !== undefined ? { thinking_duration_ms: durationMs } : {}),
    });
    const say = (text: string) => ({ type: "assistant", ...ids, message: { role: "assistant", content: [{ type: "text", text }] } });
    const args = { globPattern: "*", targetDirectory: "C:\\work\\demo" };
    const callId = "chatcmpl-tool-4e77f5ff176a4c2e9d37398fdaaa85b1";

    // 顺序与字段取自 2026-11-08 经 SDK 1.0.28 跑的一次真实运行（空目录里只有 hello.txt）：
    // 没有 system 消息，第一条是 status；思考被工具调用隔成两段，各自以 text: "" + thinking_duration_ms 收尾；
    // usage 在最终回答之后、结束状态之前；glob 的结果路径是 SDK 自己给的 "../.\\hello.txt"。思考增量在这里缩短了。
    run.push(
      { type: "status", ...ids, status: "RUNNING" },
      think("The"),
      think(" user asks to"),
      think(" use the \"ls"),
      think(" tool\" exactly once"),
      think(" I should use Glob"),
      think("", 209),
      { type: "tool_call", ...ids, call_id: callId, name: "glob", status: "running", args },
      {
        type: "tool_call",
        ...ids,
        call_id: callId,
        name: "glob",
        status: "completed",
        args,
        result: { status: "success", value: { files: ["../.\\hello.txt"], totalFiles: 1, clientTruncated: false, ripgrepTruncated: false } },
      },
      think("The"),
      think(" user asked to"),
      think(" answer in one sentence."),
      think("", 96),
      say("当前工作目录中只有一个文件"),
      say("：`hello.txt"),
      say("`。"),
      { type: "usage", ...ids, usage: { inputTokens: 6271, outputTokens: 207, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 6478, reasoningTokens: 118 } },
      { type: "status", ...ids, status: "FINISHED" },
    );
    run.finish(
      finished("当前工作目录中只有一个文件：`hello.txt`。", {
        model: { id: "deepseek-v41-flash-1017", params: [{ id: "reasoning_effort", value: "max" }] },
        durationMs: 7655,
        usage: { inputTokens: 6271, outputTokens: 207, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 6478, reasoningTokens: 118 },
      }),
    );
    await until(completed(env, sessionId), WAIT, "run completed");

    const state = stateOf(env, sessionId);
    expect(state.status).toBe("idle");
    // status / usage 这类消息是正常流量：不能变成诊断噪音。
    expect(diagnostics(env, sessionId)).toEqual([]);

    const reasoning = state.timeline.filter((item): item is ReasoningItem => item.type === "reasoning");
    expect(reasoning.map((item) => [item.streaming, item.durationMs])).toEqual([
      [false, 209],
      [false, 96],
    ]);
    expect(reasoning[0]?.text).toBe("The user asks to use the \"ls tool\" exactly once I should use Glob");

    const [glob, ...otherTools] = tools(env, sessionId);
    expect(otherTools).toEqual([]);
    expect(glob).toMatchObject({ callId, status: "completed", title: "*" });
    expect(glob?.output?.text).toContain("hello.txt");

    const assistants = state.timeline.filter((item): item is AssistantItem => item.type === "assistant");
    expect(assistants.map((item) => [item.text, item.phase])).toEqual([["当前工作目录中只有一个文件：`hello.txt`。", "final"]]);
    expect(toSummary(state).usage).toMatchObject({ inputTokens: 6271, outputTokens: 207, totalTokens: 6478, reasoningTokens: 118 });
  });

  it("renders the real result shapes of the other tools", async () => {
    const { env, fake } = setup();
    const { sessionId } = await delegate(env);
    const run = await runOf(fake);
    run.push(
      toolCall("g1", "grep", "completed", { pattern: "TODO", path: "src" }, success({
        workspaceResults: {
          [env.cwd]: { type: "content", output: { matches: [{ file: join(env.cwd, "src", "a.ts"), lineNumber: 3, line: "// TODO x" }], totalMatches: 1 } },
        },
      })),
      toolCall("m1", "mcp", "completed", { providerIdentifier: "docs", toolName: "search", args: { q: "x" } }, success({ content: [{ text: { text: "hit" } }], isError: false })),
      toolCall("m2", "mcp", "completed", { providerIdentifier: "docs", toolName: "search" }, success({ content: [{ text: { text: "quota" } }], isError: true })),
      toolCall("l1", "readLints", "completed", { paths: ["a.ts", "b.ts"] }, success({ fileDiagnostics: [], totalFiles: 2, totalDiagnostics: 0 })),
      toolCall("l2", "glob", "completed", { globPattern: "**/*.ts" }, success({ files: ["a.ts", "b.ts"], totalFiles: 2, clientTruncated: false, ripgrepTruncated: false })),
      toolCall("l3", "ls", "completed", { path: "." }, success({
        directoryTreeRoot: {
          absPath: env.cwd,
          childrenDirs: [{ absPath: join(env.cwd, "src"), childrenDirs: [], childrenFiles: [], childrenWereProcessed: true, fullSubtreeExtensionCounts: {}, numFiles: 0 }],
          childrenFiles: [{ name: "a.txt" }],
          childrenWereProcessed: true,
          fullSubtreeExtensionCounts: {},
          numFiles: 1,
        },
      })),
      toolCall("d1", "delete", "running", { path: "old.log" }),
      toolCall("d1", "delete", "completed", { path: "old.log" }, success({ fileSize: 12 })),
      toolCall("r1", "read", "completed", { path: "missing.txt" }, failure("File not found", { path: "missing.txt" })),
      // 没有 running 事件、直接给出结果的调用也要完整呈现。
      toolCall("s1", "semSearch", "completed", { query: "where is auth" }, success({ results: "src/auth.ts" })),
    );
    run.finish(finished("ok"));
    await until(completed(env, sessionId), WAIT, "run completed");

    const byId = new Map(tools(env, sessionId).map((t) => [t.callId, t]));
    expect(byId.get("g1")).toMatchObject({ category: "search", status: "completed", title: "TODO in src" });
    expect(byId.get("g1")?.output?.text).toMatch(/a\.ts:3: \/\/ TODO x$/);
    expect(byId.get("m1")).toMatchObject({ category: "mcp", status: "completed", title: "docs · search", mcp: { server: "docs", tool: "search" } });
    expect(byId.get("m1")?.output?.text).toBe("hit");
    // MCP 的失败写在 isError 里，tool_call.status 仍是 completed。
    expect(byId.get("m2")?.status).toBe("failed");
    expect(byId.get("l1")).toMatchObject({ status: "completed", title: "a.ts +1" });
    expect(byId.get("l1")?.output).toBeUndefined();
    expect(byId.get("l2")?.output?.text).toBe("a.ts\nb.ts");
    expect(byId.get("l3")?.output?.text).toBe("src/\na.txt");
    expect(byId.get("d1")?.files).toEqual([{ path: "old.log", change: "deleted" }]);
    expect(byId.get("d1")?.output).toBeUndefined();
    // 工具自己的失败：tool_call.status 是 completed，result.status 才是 error。
    expect(byId.get("r1")).toMatchObject({ status: "failed", error: "File not found" });
    expect(byId.get("s1")).toMatchObject({ status: "completed", title: "where is auth" });
    expect(byId.get("s1")?.output?.text).toBe("src/auth.ts");
  });

  it("emits one update for a flood of partial tool-call events", async () => {
    const { env, fake } = setup();
    const { sessionId } = await delegate(env);
    const run = await runOf(fake);
    const partials = Array.from({ length: 30 }, (_, i) => toolCall("w1", "edit", "running", { path: "big.txt", streamContent: "x".repeat(i + 1) }));
    run.push(...partials, toolCall("w1", "edit", "completed", { path: "big.txt" }, success({ linesAdded: 30 })));
    run.finish(finished("ok"));
    await until(completed(env, sessionId), WAIT, "run completed");
    const updates = env.hub.events(sessionId).filter((event) => event.kind === "tool.updated" && event.data.callId === "w1");
    expect(updates.map((event) => (event.kind === "tool.updated" ? event.data.status : ""))).toEqual(["running", "completed"]);
  });

  it("corrects the streamed answer with RunResult.result", async () => {
    const { env, fake } = setup();
    const { sessionId } = await delegate(env);
    const run = await runOf(fake);
    run.push(assistantText("Partial"));
    run.finish(finished("Partial answer, complete."));
    await until(completed(env, sessionId), WAIT, "run completed");
    const assistants = stateOf(env, sessionId).timeline.filter((item): item is AssistantItem => item.type === "assistant");
    expect(assistants.map((a) => [a.text, a.phase])).toEqual([["Partial answer, complete.", "final"]]);
  });

  it("falls back to the streamed text and the accumulated per-turn usage when the result carries neither", async () => {
    const { env, fake } = setup();
    const { sessionId } = await delegate(env);
    const run = await runOf(fake);
    run.push(assistantText("Only streamed"), usageMessage(100, 10, 50), usageMessage(40, 4, 0));
    run.finish({ status: "finished" });
    await until(completed(env, sessionId), WAIT, "run completed");
    const state = stateOf(env, sessionId);
    const assistants = state.timeline.filter((item): item is AssistantItem => item.type === "assistant");
    expect(assistants.map((a) => [a.text, a.phase])).toEqual([["Only streamed", "final"]]);
    expect(toSummary(state).usage).toMatchObject({ inputTokens: 140, outputTokens: 14, cachedTokens: 50, totalTokens: 154 });
  });

  it("notes the tool list and the request id once, and updates the model only when Cursor chose a different one", async () => {
    const { env, fake } = setup();
    const { sessionId } = await delegate(env, { model: "composer-fake" });
    const first = await runOf(fake);
    first.push(
      { type: "system", model: { id: "composer-fake-resolved" }, tools: ["read", "grep"] },
      { type: "request", request_id: "req-1" },
      { type: "request", request_id: "req-2" },
    );
    first.finish(finished("one"));
    await until(completed(env, sessionId), WAIT, "first run completed");

    await env.manager.send(sessionId, { text: "Again", author: USER });
    const second = await runOf(fake, 1);
    second.push({ type: "system", model: { id: "composer-fake-resolved" }, tools: ["read", "grep"] });
    second.finish(finished("two"));
    await until(completed(env, sessionId, 1), WAIT, "second run completed");

    const state = stateOf(env, sessionId);
    expect(state.meta.model).toMatchObject({ requested: "composer-fake", resolved: "composer-fake-resolved" });
    expect(diagnostics(env, sessionId).filter((d) => d.code === "cursor.tools")).toHaveLength(1);
    expect(diagnostics(env, sessionId).filter((d) => d.code === "cursor.request")).toHaveLength(1);
  });

  it("classifies a run that ends in error and keeps Cursor's own error code", async () => {
    const { env, fake } = setup();
    const { sessionId } = await delegate(env);
    const run = await runOf(fake);
    run.finish({ status: "error", error: { message: "429 rate limit exceeded", code: "rate_limited" } });
    await until(() => stateOf(env, sessionId).runs[0]?.status === "failed", WAIT, "run failed");
    const error = stateOf(env, sessionId).runs[0]?.error;
    expect(error).toMatchObject({ code: "rate_limited", retryable: true });
    expect(error?.message).toContain("429");
    expect(error?.detail).toContain("rate_limited");
    // 失败的是运行，不是会话。
    expect(stateOf(env, sessionId).status).toBe("idle");
  });

  it("uses the status message when a failed run has no error of its own", async () => {
    const { env, fake } = setup();
    const { sessionId } = await delegate(env);
    const run = await runOf(fake);
    run.push({ type: "status", status: "ERROR", message: "Model temporarily unavailable" });
    run.finish({ status: "error" });
    await until(() => stateOf(env, sessionId).runs[0]?.status === "failed", WAIT, "run failed");
    expect(stateOf(env, sessionId).runs[0]?.error).toMatchObject({ code: "provider_unavailable", message: "Model temporarily unavailable" });
  });

  it("fails the run, not the session, when the event stream breaks", async () => {
    const { env, fake } = setup();
    const { sessionId } = await delegate(env);
    const run = await runOf(fake);
    run.push(assistantText("Working…"));
    run.crash(new Error("fetch failed"));
    await until(() => stateOf(env, sessionId).runs[0]?.status === "failed", WAIT, "run failed");
    expect(stateOf(env, sessionId).runs[0]?.error).toMatchObject({ code: "provider_unavailable", retryable: true });
    expect(stateOf(env, sessionId).status).toBe("idle");
  });

  it("reports a rejected send as an actionable start failure", async () => {
    const { env } = setup({ configure: (f) => (f.sendError = typedError("AuthenticationError", "Unauthorized", { status: 401 })) });
    const { sessionId } = await delegate(env);
    await until(() => stateOf(env, sessionId).runs[0]?.status === "failed", WAIT, "run failed");
    expect(stateOf(env, sessionId).runs[0]?.error).toMatchObject({ code: "auth_failed" });
  });
});

// ───────────────────────── 模型、档位与访问级别 ─────────────────────────
