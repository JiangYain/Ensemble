import { describe, expect, it } from "vitest";
import {
  ZERO_TALLY,
  addTally,
  errorInfoOf,
  fileChangesOf,
  modelKey,
  permissionRules,
  readCatalog,
  readTally,
  redact,
  splitModelKey,
  toModelInfo,
  toUsage,
  toolInput,
  toolTitle,
} from "./opencode-items";

const model = (patch: Record<string, unknown>) => ({
  id: "m1",
  modelID: "m1",
  providerID: "p1",
  type: "chat",
  name: "Model One",
  enabled: true,
  status: "active",
  // 真实目录里 settings 带凭据：任何读取结果都不能把它带出来。
  settings: { apiKey: "SECRET-KEY-VALUE", baseURL: "https://example.invalid" },
  variants: [{ id: "low", settings: {} }, { id: "high", settings: {} }],
  limit: { context: 200000, output: 32000 },
  ...patch,
});

describe("permission rules", () => {
  // 提问不是授权：执行端遇到需求歧义要向发起方要一个答案，直接拒绝只会让它瞎猜返工。所以两种级别都放行 question，由 opencode-questions.ts 转交。
  it("Full Access allows everything, the question tool explicitly (a question is not an authorization)", () => {
    expect(permissionRules("full")).toEqual([
      { action: "*", resource: "*", effect: "allow" },
      { action: "question", resource: "*", effect: "allow" },
    ]);
  });

  it("read-only denies everything first, then re-allows only the read-type actions and the question tool (last match wins)", () => {
    expect(permissionRules("read_only")).toEqual([
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "glob", resource: "*", effect: "allow" },
      { action: "grep", resource: "*", effect: "allow" },
      { action: "question", resource: "*", effect: "allow" },
    ]);
  });
});

describe("model catalog", () => {
  it("keeps usable chat models only, with real variants, and never carries credentials along", () => {
    const body = {
      data: [
        model({}),
        model({ modelID: "x/y", id: "x/y", providerID: "google-vertex", name: "Nested", variants: [] }),
        model({ modelID: "off", id: "off", enabled: false }),
        model({ modelID: "old", id: "old", status: "deprecated" }),
        model({ modelID: "embed", id: "embed", type: "embedding" }),
        model({}), // 重复项
        { id: "broken" },
      ],
    };
    const models = readCatalog(body);
    expect(models.map(modelKey)).toEqual(["p1/m1", "google-vertex/x/y"]);
    expect(models[0]).toEqual({ providerID: "p1", modelID: "m1", name: "Model One", variants: ["low", "high"], contextWindow: 200000 });
    expect(JSON.stringify(models)).not.toContain("SECRET-KEY-VALUE");
    expect(JSON.stringify(models.map((m) => toModelInfo(m, undefined)))).not.toContain("SECRET-KEY-VALUE");
  });

  it("maps to ModelInfo with provider-qualified ids, efforts only when OpenCode reports variants, and the default flag", () => {
    const [first, second] = readCatalog({ data: [model({}), model({ modelID: "plain", id: "plain", variants: [] })] });
    expect(toModelInfo(first!, "p1/m1")).toEqual({ id: "p1/m1", label: "Model One", provider: "p1", efforts: ["low", "high"], isDefault: true, contextWindow: 200000 });
    expect(toModelInfo(second!, "p1/m1")).toEqual({ id: "p1/plain", label: "Model One", provider: "p1", contextWindow: 200000 });
  });

  it("splits the key at the first slash because model ids may contain slashes", () => {
    expect(splitModelKey("opencode/deepseek-v4.1-flash-free")).toEqual({ providerID: "opencode", modelID: "deepseek-v4.1-flash-free" });
    expect(splitModelKey("google-vertex/xai/grok-4.7")).toEqual({ providerID: "google-vertex", modelID: "xai/grok-4.7" });
    expect(splitModelKey("no-slash")).toBeUndefined();
    expect(splitModelKey("/leading")).toBeUndefined();
    expect(splitModelKey("trailing/")).toBeUndefined();
  });
});

describe("tool summaries", () => {
  const cwd = "C:\\work";
  it("titles tools by what they act on", () => {
    expect(toolTitle("read", { path: "C:\\work\\src\\a.ts" }, cwd)).toBe("src/a.ts");
    expect(toolTitle("shell", { command: "ping -n 3 127.0.0.1" }, cwd)).toBe("ping -n 3 127.0.0.1");
    expect(toolTitle("grep", { pattern: "TODO", path: "src" }, cwd)).toBe("TODO in src");
    expect(toolTitle("execute", { code: "const r = await search({})\nreturn r" }, cwd)).toBe("const r = await search({}) return r");
    expect(toolTitle("webfetch", { url: "https://example.com" }, cwd)).toBe("https://example.com");
  });

  it("shows edits as a diff, shell as the command and everything else as JSON", () => {
    expect(toolInput("edit", { path: "a", oldString: "beta", newString: "BETA" })).toMatchObject({ text: "-beta\n+BETA", format: "diff" });
    expect(toolInput("shell", { command: "echo hi" })).toMatchObject({ text: "echo hi" });
    expect(toolInput("glob", { pattern: "**/*.ts" }).text).toContain("**/*.ts");
  });
});

describe("file changes (only what OpenCode explicitly reports)", () => {
  const cwd = "C:\\work";
  it("takes edit's reported files with status, line counts and the unified diff", () => {
    const patch = "Index: notes.txt\n--- notes.txt\n+++ notes.txt\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n";
    const changes = fileChangesOf("edit", { path: "C:\\work\\notes.txt" }, "Edited notes.txt (1 replacement)", { files: [{ file: "notes.txt", patch, status: "modified", additions: 1, deletions: 1 }] }, cwd);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ path: "notes.txt", change: "modified", addedLines: 1, removedLines: 1, diff: { format: "diff", truncated: false } });
    expect(changes[0]?.diff?.text).toContain("+BETA");
  });

  it("counts diff lines itself when the report has a patch but no totals, and maps other statuses", () => {
    const changes = fileChangesOf("apply_patch", {}, "", { files: [{ file: "a.txt", patch: "--- a\n+++ a\n+x\n+y\n-z\n", status: "added" }, { file: "b.txt", status: "deleted" }, { file: "c.txt", status: "renamed" }] }, cwd);
    expect(changes.map((c) => [c.path, c.change, c.addedLines, c.removedLines])).toEqual([
      ["a.txt", "created", 2, 1],
      ["b.txt", "deleted", undefined, undefined],
      ["c.txt", "renamed", undefined, undefined],
    ]);
  });

  it("tells a created file from an overwritten one by the write tool's own receipt", () => {
    expect(fileChangesOf("write", { path: "out.txt", content: "a\nb\n" }, "Created file successfully: out.txt", { truncated: false }, cwd)).toEqual([
      { path: "out.txt", change: "created", addedLines: 2 },
    ]);
    expect(fileChangesOf("write", { path: "out.txt", content: "new\n" }, "Wrote file successfully: out.txt", undefined, cwd)).toEqual([{ path: "out.txt", change: "modified" }]);
    // 回执看不懂时保守地记为修改，不猜“新建”。
    expect(fileChangesOf("write", { path: "out.txt", content: "x" }, "ok", undefined, cwd)).toEqual([{ path: "out.txt", change: "modified" }]);
  });

  it("reports nothing for tools that do not explicitly report writes", () => {
    expect(fileChangesOf("shell", { command: "Remove-Item a.txt" }, "(no output)", { status: "completed", exit: 0 }, cwd)).toEqual([]);
    expect(fileChangesOf("execute", { code: "await tools.fs.write()" }, "", { toolCalls: [] }, cwd)).toEqual([]);
    expect(fileChangesOf("write", {}, "Created file successfully", undefined, cwd)).toEqual([]);
  });
});

describe("usage", () => {
  it("normalises OpenCode's counting (input excludes cache, reasoning is separate) to Ensemble's", () => {
    const step1 = readTally({ tokens: { input: 91, output: 40, reasoning: 20, cache: { read: 5660, write: 10 } }, cost: 0.002 })!;
    const step2 = readTally({ tokens: { input: 9, output: 5, reasoning: 0, cache: { read: 100, write: 0 } }, cost: 0.001 })!;
    const total = addTally(addTally(ZERO_TALLY, step1), step2);
    expect(toUsage(total, step2, 200000)).toEqual({
      inputTokens: 100 + 5770,
      outputTokens: 65,
      cachedTokens: 5760,
      reasoningTokens: 20,
      totalTokens: 5870 + 65,
      costUsd: 0.003,
      contextTokens: 109,
      contextWindow: 200000,
    });
  });

  it("returns undefined when an event carries no token statistics", () => {
    expect(readTally({ error: { type: "aborted" } })).toBeUndefined();
    expect(readTally(undefined)).toBeUndefined();
  });
});

describe("error classification", () => {
  it("recognises the asynchronous no-route failures OpenCode reports for bad models and variants", () => {
    expect(errorInfoOf({ type: "provider.no-route", message: "Model unavailable: opencode/nope" }, "x")).toMatchObject({ code: "model_not_found", message: "Model unavailable: opencode/nope" });
    expect(errorInfoOf({ type: "provider.no-route", message: "Variant unavailable for opencode/m: ultra" }, "x").code).toBe("invalid_request");
  });

  it("uses HTTP status when present and falls back to text classification", () => {
    expect(errorInfoOf({ type: "provider.http", status: 401, message: "denied" }, "x").code).toBe("auth_failed");
    expect(errorInfoOf({ type: "provider.http", status: 429, message: "slow down" }, "x")).toMatchObject({ code: "rate_limited", retryable: true });
    expect(errorInfoOf({ type: "provider.http", status: 503, message: "busy" }, "x")).toMatchObject({ code: "provider_unavailable", retryable: true });
    expect(errorInfoOf({ type: "other", message: "context length exceeded" }, "x").code).toBe("context_overflow");
    expect(errorInfoOf(undefined, "fallback text").message).toBe("fallback text");
  });

  it("never lets credentials through, and ignores the raw response object", () => {
    const info = errorInfoOf({ type: "provider.http", status: 400, message: "bad key sk-abcdefghijklmnop and Bearer abcdefghijklmnop", response: { headers: { authorization: "Bearer LEAK-LEAK-LEAK" } } }, "x");
    expect(JSON.stringify(info)).not.toMatch(/abcdefghijklmnop|LEAK/);
  });
});

describe("redact", () => {
  it("masks bearer tokens, sk- style keys and key=value secrets but leaves ordinary text alone", () => {
    expect(redact("Authorization: Bearer abcdefgh12345678")).toBe("Authorization: Bearer ***");
    expect(redact("key sk-abcdefghijkl end")).toBe("key sk-*** end");
    expect(redact('{"apiKey":"abcdef123456"}')).toBe('{"apiKey":"***"}');
    expect(redact("password=hunter2hunter2")).toBe("password=***");
    expect(redact("File not found: does-not-exist.txt")).toBe("File not found: does-not-exist.txt");
  });
});
