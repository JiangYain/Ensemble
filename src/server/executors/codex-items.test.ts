import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  commandText,
  fileChangesOf,
  pickDefaultModel,
  sandboxFor,
  toModelEntry,
  toolEnd,
  toolStart,
  toTurnErrorInfo,
  unwrapShellCommand,
  usageOf,
  type CodexModelEntry,
} from "./codex-items";

const cwd = join(tmpdir(), "ensemble-items-cwd");

describe("unwrapShellCommand", () => {
  it.each([
    [`"C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe" -Command 'echo hello-from-codex'`, "echo hello-from-codex"],
    [
      `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "Set-Content -LiteralPath .\\out.txt -Value 'hello' -NoNewline"`,
      "Set-Content -LiteralPath .\\out.txt -Value 'hello' -NoNewline",
    ],
    ["powershell.exe -NoProfile -Command Get-ChildItem", "Get-ChildItem"],
    [`/bin/bash -lc "rg -n foo | head"`, "rg -n foo | head"],
    ["bash -c 'ls -la'", "ls -la"],
    ["cmd.exe /c dir", "dir"],
    ["git status --short", "git status --short"],
    ["", ""],
  ])("%s → %s", (raw, expected) => {
    expect(unwrapShellCommand(raw)).toBe(expected);
  });

  it("falls back to the parsed command actions when the raw command is empty", () => {
    expect(commandText({ command: "", commandActions: [{ type: "unknown", command: "echo a" }, { type: "unknown", command: "echo b" }] })).toBe("echo a && echo b");
  });
});

describe("file changes", () => {
  it("counts additions for new files (the diff is the file's content) and hunks for updates", () => {
    const files = fileChangesOf(
      {
        changes: [
          { path: join(cwd, "notes.txt"), kind: { type: "add" }, diff: "ready\nsteady\n" },
          { path: join(cwd, "src", "a.ts"), kind: { type: "update", move_path: null }, diff: "@@ -1,3 +1,3 @@\n one\n-old\n+new\n three\n" },
          { path: join(cwd, "gone.txt"), kind: { type: "delete" }, diff: "bye\n" },
          { path: join(cwd, "old-name.ts"), kind: { type: "update", move_path: join(cwd, "new-name.ts") }, diff: "" },
        ],
      },
      cwd,
    );
    expect(files.map(({ path, change, addedLines, removedLines }) => ({ path, change, addedLines, removedLines }))).toEqual([
      { path: "notes.txt", change: "created", addedLines: 2, removedLines: undefined },
      { path: "src/a.ts", change: "modified", addedLines: 1, removedLines: 1 },
      { path: "gone.txt", change: "deleted", addedLines: undefined, removedLines: 1 },
      { path: "new-name.ts", change: "renamed", addedLines: 0, removedLines: 0 },
    ]);
    expect(files[0]?.diff?.text).toBe("*** Add File: notes.txt\n+ready\n+steady");
    expect(files[1]?.diff?.text).toContain("@@ -1,3 +1,3 @@");
    expect(files[0]?.diff?.format).toBe("diff");
  });

  it("ignores malformed entries instead of throwing", () => {
    expect(fileChangesOf({ changes: [null, { path: 3 }, { path: "x", kind: { type: "teleport" } }] }, cwd)).toEqual([]);
  });
});

describe("tool mapping", () => {
  const command = (status: string, extra: Record<string, unknown> = {}) => ({
    type: "commandExecution",
    id: "c1",
    command: `"pwsh.exe" -Command 'dotnet build'`,
    cwd,
    status,
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    ...extra,
  });

  it("shows the real command (not the shell wrapper) and its exit code", () => {
    const start = toolStart(command("inProgress"), cwd);
    expect(start).toMatchObject({ callId: "c1", name: "shell", category: "shell", title: "dotnet build", status: "running" });
    expect(start?.input?.text).toBe("dotnet build");

    const failed = toolEnd(command("failed", { aggregatedOutput: "error CS0103", exitCode: 1 }), cwd);
    expect(failed?.update).toMatchObject({ status: "failed", exitCode: 1, error: "Exit code 1", output: { text: "error CS0103" } });
    // 被用户拒绝的命令从未执行：中性的“已取消”，而不是红色的失败。
    expect(toolEnd(command("declined"), cwd)?.update).toMatchObject({ status: "cancelled" });
    expect(toolEnd(command("declined"), cwd)?.update.error).toBeUndefined();
  });

  it("classifies patches as write when every change is a new file, otherwise edit", () => {
    const patch = (kinds: string[]) => ({
      type: "fileChange",
      id: "p1",
      status: "inProgress",
      changes: kinds.map((type, i) => ({ path: join(cwd, `f${i}.txt`), kind: { type, move_path: null }, diff: "x\n" })),
    });
    expect(toolStart(patch(["add", "add"]), cwd)).toMatchObject({ category: "write", title: "f0.txt, f1.txt" });
    expect(toolStart(patch(["add", "update", "add"]), cwd)).toMatchObject({ category: "edit", title: "f0.txt, f1.txt +1" });
    // 文件变更只在成功落盘时才会上报；被拒绝或失败的补丁不能算作改动了文件。
    expect(toolEnd({ ...patch(["add"]), status: "completed" }, cwd)?.files).toHaveLength(1);
    expect(toolEnd({ ...patch(["add"]), status: "declined" }, cwd)?.files).toEqual([]);
    expect(toolEnd({ ...patch(["add"]), status: "failed" }, cwd)).toMatchObject({ files: [], update: { status: "failed" } });
  });

  it("maps MCP calls with server/tool metadata, results and errors", () => {
    const call = { type: "mcpToolCall", id: "m1", server: "docs", tool: "search", arguments: { q: "x" }, status: "inProgress" };
    expect(toolStart(call, cwd)).toMatchObject({ name: "mcp__docs__search", category: "mcp", title: "docs / search", mcp: { server: "docs", tool: "search" } });
    expect(toolEnd({ ...call, status: "completed", result: { content: [{ type: "text", text: "3 results" }], structuredContent: null } }, cwd)?.update).toMatchObject({
      status: "completed",
      output: { text: "3 results" },
    });
    expect(toolEnd({ ...call, status: "failed", error: { message: "upstream 500" } }, cwd)?.update).toMatchObject({ status: "failed", error: "upstream 500" });
    // 没有文本内容时，退而展示结构化结果。
    expect(toolEnd({ ...call, status: "completed", result: { content: [], structuredContent: { total: 3 } } }, cwd)?.update.output?.text).toContain('"total": 3');
  });

  it("covers web search, sub-agent calls and unknown tool-like items without dropping them", () => {
    expect(toolStart({ type: "webSearch", id: "w1", query: "codex protocol", action: null }, cwd)).toMatchObject({ category: "web", title: "codex protocol" });
    expect(toolStart({ type: "collabAgentToolCall", id: "a1", tool: "spawnAgent", prompt: "Review the diff" }, cwd)).toMatchObject({
      category: "task",
      name: "agent_spawnAgent",
      title: "spawnAgent: Review the diff",
    });
    expect(toolStart({ type: "sleep", id: "s1" }, cwd)).toMatchObject({ category: "other", name: "sleep" });
  });

  it("never treats conversation items as tools", () => {
    for (const type of ["userMessage", "agentMessage", "reasoning", "plan", "contextCompaction"]) {
      expect(toolStart({ type, id: "x" }, cwd)).toBeUndefined();
      expect(toolEnd({ type, id: "x" }, cwd)).toBeUndefined();
    }
  });
});

describe("usageOf", () => {
  const breakdown = (n: number) => ({ totalTokens: n, inputTokens: n - 10, cachedInputTokens: 5, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 2 });

  it("derives the run's baseline from the first report (total − last) and measures increments from it", () => {
    const first = usageOf({ total: breakdown(5_110), last: breakdown(110), modelContextWindow: 400_000 }, undefined);
    expect(first?.base).toEqual({ input: 5_000, output: 0, cached: 0, reasoning: 0, total: 5_000 });
    expect(first?.usage).toMatchObject({
      totalTokens: 110,
      inputTokens: 100,
      outputTokens: 10,
      cachedTokens: 5,
      reasoningTokens: 2,
      contextTokens: 110,
      contextWindow: 400_000,
    });
    const second = usageOf({ total: breakdown(5_250), last: breakdown(140) }, first?.base);
    expect(second?.usage.totalTokens).toBe(250);
    expect(second?.usage.contextTokens).toBe(140);
  });

  it("never reports negative numbers when counters reset (for example after compaction)", () => {
    const usage = usageOf({ total: breakdown(50), last: breakdown(50) }, { input: 900, output: 90, cached: 9, reasoning: 9, total: 1_000 });
    expect(usage?.usage).toMatchObject({ totalTokens: 0, inputTokens: 0, outputTokens: 0 });
  });

  it("returns nothing without a total", () => {
    expect(usageOf({ last: breakdown(1) }, undefined)).toBeUndefined();
  });
});

describe("toTurnErrorInfo", () => {
  it.each([
    [{ message: "context too large", codexErrorInfo: "contextWindowExceeded" }, { code: "context_overflow" }],
    [{ message: "usage limit hit", codexErrorInfo: "usageLimitExceeded" }, { code: "rate_limited" }],
    [{ message: "slow down", codexErrorInfo: "rateLimitExceeded" }, { code: "rate_limited", retryable: true }],
    [{ message: "stream dropped", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } }, { code: "provider_unavailable", retryable: true }],
    [{ message: "denied", codexErrorInfo: "sandboxError" }, { code: "sandbox_error" }],
    [{ message: "blocked", codexErrorInfo: "cyberPolicy" }, { code: "policy_blocked" }],
    // 缺失的模型常被归为泛化的 badRequest；消息里明确的原因优先。
    [{ message: "The 'x' model is not supported (model_not_found)", codexErrorInfo: "badRequest" }, { code: "model_not_found" }],
    [{ message: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.", codexErrorInfo: "badRequest" }, { code: "model_not_found" }],
    // 与模型有关但不是“模型不可用”的错误不能被误判。
    [{ message: "The model is overloaded, please retry.", codexErrorInfo: "serverOverloaded" }, { code: "provider_unavailable", retryable: true }],
    [{ message: "401 Unauthorized", codexErrorInfo: "other" }, { code: "auth_failed" }],
    [{ message: "something odd", codexErrorInfo: null }, { code: "model_error" }],
  ])("%j → %j", (raw, expected) => {
    expect(toTurnErrorInfo(raw)).toMatchObject(expected);
  });

  it("keeps additional details separate from the headline", () => {
    expect(toTurnErrorInfo({ message: "Request failed", additionalDetails: "HTTP 502 from upstream" })).toMatchObject({
      message: "Request failed",
      detail: "HTTP 502 from upstream",
    });
    expect(toTurnErrorInfo(undefined, "fallback text").message).toBe("fallback text");
  });
});

describe("model selection", () => {
  const entries = (...ids: string[]): CodexModelEntry[] =>
    ids.map((id, index) => ({ model: id, info: { id, label: id, ...(index === 0 ? { isDefault: true } : {}) } }));

  it("prefers the user's configured model when it is available", () => {
    expect(pickDefaultModel(entries("a", "b"), "b")).toEqual({ model: "b" });
  });

  it("falls back to the catalog default when the configured model is not available, and says which one it replaced", () => {
    expect(pickDefaultModel(entries("a", "b"), "gone")).toEqual({ model: "a", fellBackFrom: "gone" });
  });

  it("trusts the configured model when the catalog is empty, and uses the catalog default when nothing is configured", () => {
    expect(pickDefaultModel([], "custom")).toEqual({ model: "custom" });
    expect(pickDefaultModel(entries("a", "b"), undefined)).toEqual({ model: "a" });
    expect(pickDefaultModel([], undefined)).toEqual({ model: undefined });
  });

  it("reads reasoning efforts and the default effort from the catalog", () => {
    const entry = toModelEntry({
      id: "m",
      model: "gpt-x",
      displayName: "GPT X",
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }],
    });
    expect(entry).toMatchObject({ model: "gpt-x", info: { id: "gpt-x", label: "GPT X", efforts: ["low", "medium", "high"], defaultEffort: "medium", isDefault: true } });
    expect(toModelEntry({ model: "single", supportedReasoningEfforts: [{ reasoningEffort: "low" }] })?.info.efforts).toBeUndefined();
    expect(toModelEntry({})).toBeUndefined();
  });
});

describe("sandboxFor", () => {
  it("never lets any delegation wait on an approval that nobody is there to answer", () => {
    expect(sandboxFor("read_only")).toEqual({ sandbox: "read-only", approvalPolicy: "never", expectType: "readOnly" });
    expect(sandboxFor("full")).toEqual({ sandbox: "danger-full-access", approvalPolicy: "never", expectType: "dangerFullAccess" });
  });
});
