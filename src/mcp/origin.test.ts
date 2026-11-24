import { describe, expect, it } from "vitest";
import { describeClues, detectOrigin } from "./origin";

const base = { env: {}, bridgeId: "b1" };

describe("detectOrigin", () => {
  it("identifies the host from clientInfo and never invents a session id", () => {
    const { origin, clues } = detectOrigin({ ...base, clientInfo: { name: "codex-mcp-client", version: "0.151.0" } });
    expect(origin).toMatchObject({
      kind: "agent",
      host: "codex",
      hostLabel: "Codex",
      key: "codex:bridge-b1",
      clientInfo: { name: "codex-mcp-client", version: "0.151.0" },
      evidence: ["clientInfo:codex-mcp-client"],
    });
    expect(origin.sessionRef).toBeUndefined();
    expect(clues).toEqual({ host: "codex" });
  });

  it.each([
    ["cursor-vscode", "cursor", "Cursor"],
    ["claude-code", "claude", "Claude"],
    ["Visual Studio Code", "vscode", "VS Code"],
  ])("recognises %s", (name, host, label) => {
    expect(detectOrigin({ ...base, clientInfo: { name } }).origin).toMatchObject({ host, hostLabel: label });
  });

  it("keeps unknown clients visible under their own name", () => {
    expect(detectOrigin({ ...base, clientInfo: { name: "my-fancy-client" } }).origin).toMatchObject({
      host: "unknown",
      hostLabel: "my-fancy-client",
    });
    expect(detectOrigin(base).origin).toMatchObject({ host: "unknown", hostLabel: "MCP client" });
  });

  it("reads the session from a JSON string container such as Codex turn metadata", () => {
    const meta = { "x-codex-turn-metadata": JSON.stringify({ session_id: "019a-aaaa", turn_id: "t-1", other: 1 }) };
    const { origin } = detectOrigin({ ...base, clientInfo: { name: "codex-mcp-client" }, meta });
    expect(origin.sessionRef).toEqual({ id: "019a-aaaa", kind: "session", source: "mcp-meta" });
    expect(origin.key).toBe("codex:019a-aaaa");
    expect(origin.evidence).toContain("_meta.x-codex-turn-metadata.session_id");
  });

  it("reads the session from a nested object and infers the host from the key prefix", () => {
    const meta = { "x-codex-turn-metadata": { threadId: "thr-9" } };
    const { origin } = detectOrigin({ ...base, meta });
    expect(origin).toMatchObject({ host: "codex", sessionRef: { id: "thr-9", kind: "thread", source: "mcp-meta" } });
  });

  it("prefers a session id over a thread id when both are present", () => {
    const meta = { thread_id: "thr", session_id: "ses" };
    expect(detectOrigin({ ...base, meta }).origin.sessionRef?.id).toBe("ses");
  });

  it("ignores ids that are empty, oversized or contain whitespace", () => {
    const meta = { session_id: "has space", thread_id: "", conversation_id: "x".repeat(300) };
    expect(detectOrigin({ ...base, meta }).origin.sessionRef).toBeUndefined();
  });

  it("falls back to environment hints, recording which variable was used", () => {
    const { origin } = detectOrigin({ ...base, env: { CODEX_THREAD_ID: "env-thread" } });
    expect(origin).toMatchObject({
      host: "codex",
      sessionRef: { id: "env-thread", kind: "thread", source: "env" },
      evidence: ["env:CODEX_THREAD_ID"],
    });
  });

  it("reads Claude Code's session from CLAUDE_CODE_SESSION_ID (the name seen by a real MCP child process)", () => {
    const id = "0ee8ca57-7685-49b4-ac4b-14c3482d466a";
    const { origin } = detectOrigin({ ...base, clientInfo: { name: "claude-code", version: "2.1.325" }, env: { CLAUDE_CODE_SESSION_ID: id } });
    expect(origin).toMatchObject({ host: "claude", key: `claude:${id}`, sessionRef: { id, kind: "session", source: "env" }, evidence: ["clientInfo:claude-code", "env:CLAUDE_CODE_SESSION_ID"] });
  });

  it("once the host is known, only that host's own variables count (a Claude Code started in a Cursor terminal inherits Cursor's)", () => {
    const env = { CURSOR_CONVERSATION_ID: "cursor-chat", CODEX_THREAD_ID: "codex-thread", CLAUDE_CODE_SESSION_ID: "claude-session" };
    expect(detectOrigin({ ...base, clientInfo: { name: "claude-code" }, env }).origin.sessionRef?.id).toBe("claude-session");
    expect(detectOrigin({ ...base, clientInfo: { name: "cursor-vscode" }, env }).origin.sessionRef?.id).toBe("cursor-chat");

    const leaked = detectOrigin({ ...base, clientInfo: { name: "claude-code" }, env: { CURSOR_CONVERSATION_ID: "cursor-chat" } }).origin;
    expect(leaked.host).toBe("claude");
    expect(leaked.sessionRef).toBeUndefined();
    expect(leaked.key).toBe("claude:bridge-b1");
  });

  it("Pi's MCP child gets no session variable, so a Pi origin has no session reference", () => {
    const { origin } = detectOrigin({ ...base, clientInfo: { name: "pi", version: "1.5.2" }, env: { PI_CODING_AGENT: "true", CURSOR_CONVERSATION_ID: "inherited" } });
    expect(origin).toMatchObject({ host: "pi", hostLabel: "Pi", key: "pi:bridge-b1" });
    expect(origin.sessionRef).toBeUndefined();
  });

  it("prefers request metadata over the environment", () => {
    const { origin } = detectOrigin({ ...base, meta: { session_id: "from-meta" }, env: { CODEX_THREAD_ID: "from-env" } });
    expect(origin.sessionRef?.id).toBe("from-meta");
  });

  it("reuses clues from an earlier call when this call carries none", () => {
    const first = detectOrigin({ ...base, clientInfo: { name: "codex-mcp-client" }, meta: { session_id: "s-1" } });
    const second = detectOrigin({ ...base, clientInfo: { name: "codex-mcp-client" }, sticky: first.clues });
    expect(second.origin.key).toBe(first.origin.key);
    expect(second.origin.evidence).toContain("earlier-call");
  });

  it("records the workspace when known", () => {
    expect(detectOrigin({ ...base, workspace: "C:\\proj" }).origin.workspace).toBe("C:\\proj");
  });

  it("records where the workspace came from, and nothing without a workspace", () => {
    const withSource = detectOrigin({ ...base, workspace: "C:\\proj", workspaceSource: "delegate-cwd" }).origin;
    expect(withSource).toMatchObject({ workspace: "C:\\proj", workspaceSource: "delegate-cwd" });
    // 没有目录就不会有目录的来源：不留下一个指向空气的字段。
    const without = detectOrigin({ ...base, workspaceSource: "mcp-roots" }).origin;
    expect(without).not.toHaveProperty("workspace");
    expect(without).not.toHaveProperty("workspaceSource");
    expect(detectOrigin({ ...base, workspace: "C:\\proj" }).origin).not.toHaveProperty("workspaceSource");
  });
});

describe("detectOrigin: the conversation id an agent declares", () => {
  // Cursor IDE：所有对话共用一个桥进程，宿主既不在 _meta 里也不在环境变量里交出对话标识。
  const cursor = { ...base, clientInfo: { name: "cursor-vscode", version: "1.0.0" } };
  const A = "4706e0d9-12d7-4b10-a784-5d3416b186a9";
  const B = "38ba040b-4d8b-41a4-af34-abd1ce037962";

  it("takes effect when the host gives no identity: the origin is keyed by it and marked as declared", () => {
    const { origin } = detectOrigin({ ...cursor, declaredConversationId: A });
    expect(origin).toMatchObject({
      host: "cursor",
      key: `cursor:${A}`,
      sessionRef: { id: A, kind: "conversation", source: "declared" },
    });
    // 依据如实写成自报：没有 _meta 或 env: 的痕迹冒充宿主证据。
    expect(origin.evidence).toEqual(["clientInfo:cursor-vscode", "declared:conversationId"]);
  });

  it("never beats an identity the host gave: request metadata first, then environment variables", () => {
    const fromMeta = detectOrigin({ ...cursor, meta: { conversation_id: "host-chat" }, declaredConversationId: A }).origin;
    expect(fromMeta).toMatchObject({ key: "cursor:host-chat", sessionRef: { id: "host-chat", kind: "conversation", source: "mcp-meta" } });
    expect(fromMeta.evidence.some((entry) => entry.startsWith("declared"))).toBe(false);

    const fromEnv = detectOrigin({ ...cursor, env: { CURSOR_CONVERSATION_ID: "env-chat" }, declaredConversationId: A }).origin;
    expect(fromEnv).toMatchObject({ key: "cursor:env-chat", sessionRef: { id: "env-chat", source: "env" } });
    expect(fromEnv.evidence.some((entry) => entry.startsWith("declared"))).toBe(false);
  });

  it("ranks above the bridge's earlier-call memory, which can belong to someone else", () => {
    const remembered = { host: "cursor" as const, sessionRef: { id: "earlier-host-chat", kind: "conversation" as const, source: "mcp-meta" as const } };
    const { origin } = detectOrigin({ ...cursor, sticky: remembered, declaredConversationId: A });
    expect(origin.sessionRef).toEqual({ id: A, kind: "conversation", source: "declared" });
    expect(origin.evidence).not.toContain("earlier-call");
    // 没有自报时仍然照旧继承。
    expect(detectOrigin({ ...cursor, sticky: remembered }).origin.key).toBe("cursor:earlier-host-chat");
  });

  it("is not clue material: it never reaches the clues a bridge keeps, so it cannot make a conversation look like a second session", () => {
    const { clues } = detectOrigin({ ...cursor, declaredConversationId: A });
    expect(clues).toEqual({ host: "cursor" });
  });

  it("is decided call by call: two conversations on one bridge are two origins and neither inherits from the other", () => {
    let sticky = {};
    const keys: string[] = [];
    for (const declared of [A, B, undefined, A]) {
      const { origin, clues } = detectOrigin({ ...cursor, sticky, declaredConversationId: declared });
      keys.push(origin.key);
      sticky = { ...sticky, ...clues };
    }
    // 第三次没有自报：回到桥进程级别的来源，而不是“沿用上一个对话”。
    expect(keys).toEqual([`cursor:${A}`, `cursor:${B}`, "cursor:bridge-b1", `cursor:${A}`]);
  });

  it("is checked like any other id: empty, oversized or whitespace-containing values are ignored", () => {
    for (const bad of ["", "has space", "tab\there", "x".repeat(201), " leading"]) {
      const { origin } = detectOrigin({ ...cursor, declaredConversationId: bad });
      expect(origin.sessionRef).toBeUndefined();
      expect(origin.key).toBe("cursor:bridge-b1");
    }
    // 上限正好 200 个字符，与宿主给的标识同一个标准。
    expect(detectOrigin({ ...cursor, declaredConversationId: "x".repeat(200) }).origin.sessionRef?.id).toHaveLength(200);
  });

  it("does nothing when omitted: identical to an origin detected without the field", () => {
    const withoutField = detectOrigin(cursor);
    expect(detectOrigin({ ...cursor, declaredConversationId: undefined })).toEqual(withoutField);
    expect(withoutField.origin.key).toBe("cursor:bridge-b1");
    expect(withoutField.origin.evidence).toEqual(["clientInfo:cursor-vscode"]);
  });

  it("is recorded in the troubleshooting snapshot so a missing parameter can be told apart from a wrong one", () => {
    expect(describeClues({ env: {}, declaredConversationId: A })["declaredConversationId"]).toBe(A);
    expect(describeClues({ env: {} })["declaredConversationId"]).toBeNull();
    expect(describeClues({ env: {}, declaredConversationId: "has space" })["declaredConversationId"]).toBeNull();
  });
});

describe("describeClues", () => {
  it("records environment variable names only, never values", () => {
    const clues = describeClues({
      env: { CODEX_THREAD_ID: "secret-ish-value", PATH: "x", CURSOR_TRACE_ID: "abc" },
    });
    expect(clues["envNames"]).toEqual(["CODEX_THREAD_ID", "CURSOR_TRACE_ID"]);
    expect(JSON.stringify(clues)).not.toContain("secret-ish-value");
  });

  it("redacts credential-looking fields and clips long strings in request metadata", () => {
    const clues = describeClues({
      env: {},
      meta: { session_id: "s", authToken: "hunter2", nested: { api_key: "k", ok: "v" }, long: "z".repeat(500) },
    });
    const text = JSON.stringify(clues);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain('"k"');
    expect(text).toContain("[redacted]");
    expect(text).toContain("session_id");
    expect(text.length).toBeLessThan(600);
  });

  it("records whether the host's WORKSPACE_FOLDER_PATHS is present and how many entries it has, never the paths", () => {
    const env = { WORKSPACE_FOLDER_PATHS: "C:\\work\\project-a,C:\\work\\secret-client-project,D:\\other" };
    const clues = describeClues({ env });
    expect(clues["workspaceFolderPaths"]).toEqual({ entries: 3 });
    expect(JSON.stringify(clues)).not.toContain("secret-client-project");
    expect(describeClues({ env: {} })["workspaceFolderPaths"]).toBeNull();
    expect(describeClues({ env: { WORKSPACE_FOLDER_PATHS: "" } })["workspaceFolderPaths"]).toBeNull();
    // 空项不算。
    expect(describeClues({ env: { WORKSPACE_FOLDER_PATHS: "a,, ,b" } })["workspaceFolderPaths"]).toEqual({ entries: 2 });
  });

  it("WORKSPACE_FOLDER_PATHS is a union over all of the host's windows, so it is never taken as the origin's workspace", () => {
    const env = { WORKSPACE_FOLDER_PATHS: "C:\\work\\project-a,C:\\work\\project-b" };
    const { origin } = detectOrigin({ ...base, clientInfo: { name: "cursor-vscode" }, env });
    expect(origin.workspace).toBeUndefined();
    expect(origin.workspaceSource).toBeUndefined();
    expect(origin.evidence).toEqual(["clientInfo:cursor-vscode"]);
  });
});
