/**
 * 来源与工作区：谁发起了委派（客户端名、请求元数据、Agent 自报的 conversationId）、来源卡上的工作目录取自哪里，
 * 以及新桥遇到没有这些功能的老服务时怎样降级。这两组测试原先在 bridge.test.ts 里，整段挪了出来，断言没有改。
 * 用的是真服务（临时状态目录、模拟执行端）与进程内的 MCP 客户端，从不碰这台机器上真实的数据。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SERVICE_FEATURES, TOKEN_HEADER } from "@shared/constants";
import type { RunningService } from "../server/service";
import { ManualExecutor, until } from "../server/testing";
import { closeTestBridges, connectTestBridge, setupBridge as setup, simulateOlderService, type ToolReply } from "./bridge.fixtures";

afterEach(closeTestBridges);

describe("origin and workspace", () => {
  it("records who delegated, from the client info and the request metadata", async () => {
    const { call, service } = await setup({ clientName: "codex-mcp-client" });
    const delegated = await call(
      "delegate",
      { harness: "pi", task: "[fixture:quick] hello", cwd: tmpdir() },
      { "x-codex-turn-metadata": JSON.stringify({ session_id: "thr-abc" }) },
    );
    const origin = service.hub.summary(delegated.data?.["sessionId"] as string)?.origin;
    expect(origin).toMatchObject({ host: "codex", hostLabel: "Codex", key: "codex:thr-abc", sessionRef: { id: "thr-abc", source: "mcp-meta" } });
  });

  it("keeps the session identity from an earlier call when later calls carry no metadata", async () => {
    const { call, service } = await setup({ clientName: "codex-mcp-client" });
    await call("harnesses", {}, { session_id: "thr-sticky" });
    const delegated = await call("delegate", { harness: "pi", task: "[fixture:quick] hello", cwd: tmpdir() });
    expect(service.hub.summary(delegated.data?.["sessionId"] as string)?.origin.key).toBe("codex:thr-sticky");
  });

  it("attaches the host's own conversation title when the host has one", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ensemble-codex-home-"));
    writeFileSync(join(codexHome, "session_index.jsonl"), `${JSON.stringify({ id: "thr-titled", thread_name: "审查 Ensemble 代码质量", updated_at: "2026-11-14T05:50:18Z" })}\n`);
    const { call, service } = await setup({ clientName: "codex-mcp-client", env: { CODEX_HOME: codexHome } });
    const delegated = await call("delegate", { harness: "pi", task: "[fixture:quick] hello", cwd: tmpdir() }, { session_id: "thr-titled" });
    expect(delegated.isError).toBe(false);
    expect(service.hub.summary(delegated.data?.["sessionId"] as string)?.origin).toMatchObject({ key: "codex:thr-titled", hostTitle: "审查 Ensemble 代码质量" });
  });

  it("delegates normally and leaves the title out when the host has none to read", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "ensemble-codex-home-"));
    const { call, service } = await setup({ clientName: "codex-mcp-client", env: { CODEX_HOME: codexHome } });
    const delegated = await call("delegate", { harness: "pi", task: "[fixture:quick] hello", cwd: tmpdir() }, { session_id: "thr-untitled" });
    expect(delegated.isError).toBe(false);
    const origin = service.hub.summary(delegated.data?.["sessionId"] as string)?.origin;
    expect(origin?.key).toBe("codex:thr-untitled");
    expect(origin).not.toHaveProperty("hostTitle");
  });

  it("writes what the host provided to the origin debug log, without environment values", async () => {
    const { call, service } = await setup({ clientName: "codex-mcp-client", env: { CODEX_SECRET_THING: "do-not-log-me" } });
    await call("harnesses", {}, { session_id: "thr-dbg", api_key: "hunter2" });
    expect(existsSync(service.paths.originDebugLog)).toBe(true);
    const text = readFileSync(service.paths.originDebugLog, "utf8");
    expect(text).toContain("thr-dbg");
    expect(text).toContain("CODEX_SECRET_THING");
    expect(text).not.toContain("do-not-log-me");
    expect(text).not.toContain("hunter2");
  });

  it("uses the workspace folder the host reports when no cwd is given", async () => {
    const root = mkdtempSync(join(tmpdir(), "ensemble-root-"));
    const { call, service } = await setup({ roots: [root] });
    const delegated = await call("delegate", { harness: "pi", task: "[fixture:quick] hello" });
    expect(delegated.text).toContain("workspace source: the workspace folder reported by the host");
    expect(service.hub.summary(delegated.data?.["sessionId"] as string)?.cwd.toLowerCase()).toBe(root.toLowerCase());
  });

  it("falls back to the bridge directory and says so", async () => {
    const { call } = await setup();
    const delegated = await call("delegate", { harness: "pi", task: "[fixture:quick] hello" });
    expect(delegated.text).toContain("workspace source: the bridge process directory");
    expect(delegated.text).toContain("pass `cwd` explicitly");
  });

  it("refuses to guess the project when the bridge was started inside a plugin install directory", async () => {
    // Agent Plugins 默认在插件根目录里启动 MCP 服务；宿主又没告知工作区时，不能把可写会话放进插件安装目录。
    const installDir = join(mkdtempSync(join(tmpdir(), "ensemble-home-")), ".codex", "plugins", "cache", "personal", "ensemble", "0.1.0");
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, "plugin.json"), "{}");

    const { call, sessions } = await setup({ cwd: installDir });
    const refused = await call("delegate", { harness: "pi", task: "[fixture:quick] hello" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Call `delegate` again with `cwd`");
    expect(sessions()).toHaveLength(0);

    // 显式给出 cwd 就不受影响。
    const accepted = await call("delegate", { harness: "pi", task: "[fixture:quick] hello", cwd: tmpdir() });
    expect(accepted.isError).toBe(false);
    expect(accepted.text).toContain("workspace source: argument");
  });

  it("still uses the host's workspace folder when the bridge sits in a plugin install directory", async () => {
    const installDir = join(mkdtempSync(join(tmpdir(), "ensemble-home-")), ".cursor", "plugins", "local", "ensemble");
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, "plugin.json"), "{}");
    const root = mkdtempSync(join(tmpdir(), "ensemble-root-"));

    const { call } = await setup({ cwd: installDir, roots: [root] });
    const delegated = await call("delegate", { harness: "pi", task: "[fixture:quick] hello" });
    expect(delegated.isError).toBe(false);
    expect(delegated.text).toContain("workspace source: the workspace folder reported by the host");
  });

  it("nests a delegation under the session named by ENSEMBLE_PARENT_SESSION", async () => {
    const parentHost = await setup();
    const parent = await parentHost.call("delegate", { harness: "pi", task: "[fixture:long] parent", cwd: tmpdir() });
    const parentId = parent.data?.["sessionId"] as string;

    // 同一个服务上的另一个桥，模拟“被委派的会话自己又调用了 Ensemble”。
    const nested = await connectTestBridge(parentHost.service, { clientName: "nested-client", env: { ENSEMBLE_PARENT_SESSION: parentId } });
    const child = await nested.call("delegate", { harness: "pi", task: "[fixture:quick] child", cwd: tmpdir() });
    const childId = child.data?.["sessionId"] as string;
    expect(parentHost.service.hub.summary(childId)).toMatchObject({ parentSessionId: parentId, depth: 1 });
    expect(child.text).toContain(`nested under session ${parentId}`);
    await parentHost.call("cancel", { sessionId: parentId, stop: true });
  });
});

describe("the conversation an agent declares (conversationId)", () => {
  // Cursor IDE：所有对话共用一个桥进程，宿主既不在 _meta 里也不在环境变量里交出对话标识。
  const A = "4706e0d9-12d7-4b10-a784-5d3416b186a9";
  const B = "38ba040b-4d8b-41a4-af34-abd1ce037962";
  const cursor = { clientName: "cursor-vscode" };
  const dir = (): string => mkdtempSync(join(tmpdir(), "ensemble-cwd-"));
  /** 服务端存下来的完整来源：含识别依据 evidence（会话摘要里的来源不带它）。 */
  const storedOrigin = (service: RunningService, delegated: Pick<ToolReply, "data">) => service.hub.state(delegated.data?.["sessionId"] as string)?.meta.origin;

  /** 用户在网页里直接对某个会话说话（不带来源）：这是干预通知要送达的那一类事件。 */
  async function userSays(service: RunningService, sessionId: string, text: string): Promise<void> {
    const response = await fetch(`${service.url}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { [TOKEN_HEADER]: service.token, "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    expect(response.status).toBe(200);
  }

  /** 模拟老服务：把服务写下的 service.json 改成老服务写的样子（没有 features 字段）；服务本身还是新的。 */
  function makeServiceLookOld(service: RunningService): void {
    const advertised = simulateOlderService(service);
    // 跟着登记表走（每加一个可协商功能都不必回来改这里），但必须真的公布了，包括角色功能。
    expect(advertised, "the new service advertises its features").toEqual([...SERVICE_FEATURES]);
    expect(advertised).toContain("delegation-profiles");
  }

  it("is an optional string parameter on every tool, with the same limits as any session id", async () => {
    const { client } = await setup(cursor);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(8);
    for (const tool of tools) {
      const property = (tool.inputSchema.properties as Record<string, { type?: string; maxLength?: number; pattern?: string; description?: string }>)["conversationId"];
      expect(property, tool.name).toMatchObject({ type: "string", maxLength: 200 });
      expect(property?.pattern, tool.name).toBeDefined();
      expect(tool.inputSchema.required ?? [], tool.name).not.toContain("conversationId");
      // 说明里要交代：哪里拿、每次都带、别编、宿主给了就不用。
      expect(property?.description, tool.name).toMatch(/every Ensemble call/);
      expect(property?.description, tool.name).toMatch(/never invent/i);
    }
    expect(client.getInstructions()).toMatch(/conversationId/);
  });

  it("makes a host without any conversation identity distinguishable: the origin is keyed by the declared id and says it was declared", async () => {
    const { call, service } = await setup(cursor);
    const delegated = await call("delegate", { harness: "pi", task: "[fixture:quick] hello", cwd: tmpdir(), conversationId: A });
    expect(delegated.isError).toBe(false);
    const origin = storedOrigin(service, delegated);
    expect(origin).toMatchObject({
      host: "cursor",
      key: `cursor:${A}`,
      sessionRef: { id: A, kind: "conversation", source: "declared" },
    });
    expect(origin?.evidence).toContain("declared:conversationId");
    expect(origin?.evidence.some((entry) => entry.startsWith("_meta.") || entry.startsWith("env:"))).toBe(false);
  });

  it("never overrides an identity the host gave, in request metadata or in the environment", async () => {
    const meta = await setup(cursor);
    const withMeta = await meta.call("delegate", { harness: "pi", task: "[fixture:quick] hello", cwd: tmpdir(), conversationId: A }, { conversation_id: "host-chat" });
    expect(meta.service.hub.summary(withMeta.data?.["sessionId"] as string)?.origin).toMatchObject({
      key: "cursor:host-chat",
      sessionRef: { id: "host-chat", source: "mcp-meta" },
    });

    const env = await setup({ ...cursor, env: { CURSOR_CONVERSATION_ID: "env-chat" } });
    const withEnv = await env.call("delegate", { harness: "pi", task: "[fixture:quick] hello", cwd: tmpdir(), conversationId: A });
    const origin = storedOrigin(env.service, withEnv);
    expect(origin).toMatchObject({ key: "cursor:env-chat", sessionRef: { id: "env-chat", source: "env" } });
    expect(origin?.evidence.some((entry) => entry.startsWith("declared"))).toBe(false);
    expect(storedOrigin(meta.service, withMeta)?.evidence.some((entry) => entry.startsWith("declared"))).toBe(false);
  });

  it("does not nest a delegation under another session because of an id the agent only declared, while an id the host gave still does", async () => {
    const { call, service } = await setup({ ...cursor, executors: [new ManualExecutor("pi")] });
    const first = await call("delegate", { harness: "pi", task: "first", cwd: tmpdir() });
    const firstId = first.data?.["sessionId"] as string;
    expect(service.hub.summary(firstId)?.nativeRef?.id).toBe("native-1");

    const declared = await call("delegate", { harness: "pi", task: "second", cwd: tmpdir(), conversationId: "native-1" });
    expect(declared.isError).toBe(false);
    expect(service.hub.summary(declared.data?.["sessionId"] as string)?.parentSessionId).toBeUndefined();
    expect(declared.text).not.toContain("nested under");

    const given = await call("delegate", { harness: "pi", task: "third", cwd: tmpdir() }, { session_id: "native-1" });
    expect(service.hub.summary(given.data?.["sessionId"] as string)).toMatchObject({ parentSessionId: firstId, depth: 1 });
    expect(given.text).toContain(`nested under session ${firstId}`);
  });
  it("rejects an invalid id on any tool before anything happens", async () => {
    const { call, sessions } = await setup(cursor);
    for (const bad of ["", "has a space", "x".repeat(201)]) {
      const delegated = await call("delegate", { harness: "pi", task: "[fixture:quick] hello", cwd: tmpdir(), conversationId: bad });
      expect(delegated.isError, JSON.stringify(bad.slice(0, 12))).toBe(true);
      expect(delegated.text).toMatch(/conversationId/);
      expect((await call("status", { conversationId: bad })).isError).toBe(true);
      expect((await call("wait", { conversationId: bad })).isError).toBe(true);
    }
    expect(sessions()).toHaveLength(0);
    // 正好 200 个字符是合法的。
    expect((await call("status", { conversationId: "x".repeat(200) })).isError).toBe(false);
  });

  it("keeps two conversations on one bridge apart: their sessions, `wait` and the user's interventions do not cross", async () => {
    const { call, service } = await setup(cursor);
    const a = (await call("delegate", { harness: "pi", task: "[fixture:hold] for A", cwd: tmpdir(), conversationId: A })).data?.["sessionId"] as string;
    const b = (await call("delegate", { harness: "pi", task: "[fixture:hold] for B", cwd: tmpdir(), conversationId: B })).data?.["sessionId"] as string;
    await until(() => service.hub.summary(a)?.phase === "running" && service.hub.summary(b)?.phase === "running", 6000);
    expect(service.hub.summary(a)?.origin.key).toBe(`cursor:${A}`);
    expect(service.hub.summary(b)?.origin.key).toBe(`cursor:${B}`);

    // 谁问就只看到谁的：status 默认范围、wait 的默认对象。
    expect((await call("status", { conversationId: A })).data?.["sessions"]).toEqual([expect.objectContaining({ id: a })]);
    expect((await call("status", { conversationId: B })).data?.["sessions"]).toEqual([expect.objectContaining({ id: b })]);
    const waitA = await call("wait", { conversationId: A, timeoutSeconds: 1, attention: false });
    expect(waitA.data?.["waitedOn"]).toEqual([a]);
    expect(waitA.data?.["sessions"]).toEqual([expect.objectContaining({ id: a })]);
    // 不带标识的调用不属于任何一个对话：它回到桥进程级别的来源，看不到 A 与 B 的会话，也不会“沿用上一个对话”。
    const anonymous = await call("status");
    expect(anonymous.data?.["sessions"]).toEqual([]);
    expect(anonymous.text).toContain("You have not delegated anything in this conversation yet.");

    await userSays(service, b, "Correction for B.");
    await userSays(service, a, "Correction for A.");
    const noticesA = await call("status", { conversationId: A });
    expect(noticesA.data?.["notices"]).toEqual([expect.objectContaining({ sessionId: a, text: "Correction for A." })]);
    expect(noticesA.text).not.toContain("Correction for B.");
    // 匿名调用与别的对话都收不到；B 的那条留给 B，且只送达一次。
    expect((await call("status")).data?.["notices"]).toBeUndefined();
    const noticesB = await call("harnesses", { conversationId: B });
    expect(noticesB.data?.["notices"]).toEqual([expect.objectContaining({ sessionId: b, text: "Correction for B." })]);
    expect((await call("status", { conversationId: B })).data?.["notices"]).toBeUndefined();
    expect((await call("status", { conversationId: A })).data?.["notices"]).toBeUndefined();
    await until(() => service.hub.summary(a)?.phase === "done" && service.hub.summary(b)?.phase === "done", 6000);
  });

  it("treats a message the declaring conversation sends itself as its own, not as the user stepping in", async () => {
    // send 带的 originKey 也按自报的标识走：对话 A 自己发的补充消息，不会作为“用户干预”回送给 A。
    const { call, service } = await setup(cursor);
    const a = (await call("delegate", { harness: "pi", task: "[fixture:hold] for A", cwd: tmpdir(), conversationId: A })).data?.["sessionId"] as string;
    await until(() => service.hub.summary(a)?.phase === "running", 6000);
    const sent = await call("send", { sessionId: a, text: "From the main agent.", conversationId: A });
    expect(sent.isError).toBe(false);
    expect((await call("status", { conversationId: A })).data?.["notices"]).toBeUndefined();
    await until(() => service.hub.summary(a)?.phase === "done", 6000);
  });

  it("changes nothing when omitted: one origin per bridge, as before", async () => {
    const { call, service } = await setup(cursor);
    const first = await call("delegate", { harness: "pi", task: "[fixture:quick] one", cwd: tmpdir() });
    const second = await call("delegate", { harness: "pi", task: "[fixture:quick] two", cwd: tmpdir() });
    const origins = [first, second].map((delegated) => storedOrigin(service, delegated));
    expect(origins[0]?.key).toMatch(/^cursor:bridge-[0-9a-f]{8}$/);
    expect(origins[1]?.key).toBe(origins[0]?.key);
    expect(origins[0]).not.toHaveProperty("sessionRef");
    expect(origins[0]?.evidence).toEqual(["clientInfo:cursor-vscode"]);
    expect((await call("status")).data?.["sessions"]).toHaveLength(2);
    await until(() => service.hub.allSummaries().every((summary) => summary.phase === "done"), 6000);
  });

  it("is not remembered between calls, so switching ids is not mistaken for several host sessions sharing the bridge", async () => {
    const { call, service } = await setup(cursor);
    // 宿主在这一次调用里带了标识：桥记下它（只有宿主给的才会被记）。
    await call("harnesses", {}, { conversation_id: "host-chat" });
    await call("harnesses", { conversationId: A });
    await call("harnesses", { conversationId: B });
    // 之后一次什么都不带的委派，仍然沿用宿主给过的那一个；自报的两个都没有被当作“又见到了别的会话”而让桥放弃记忆。
    const delegated = await call("delegate", { harness: "pi", task: "[fixture:quick] hello", cwd: tmpdir() });
    expect(service.hub.summary(delegated.data?.["sessionId"] as string)?.origin).toMatchObject({
      key: "cursor:host-chat",
      sessionRef: { id: "host-chat", source: "mcp-meta" },
    });
  });

  it("writes the declared id to the origin debug log so a forgotten parameter can be told from a wrong one", async () => {
    const { call, service } = await setup(cursor);
    await call("harnesses", { conversationId: A });
    expect(readFileSync(service.paths.originDebugLog, "utf8")).toContain(`"declaredConversationId":"${A}"`);
  });

  describe("an older Ensemble service that does not know the new reference kind", () => {
    it("keeps the grouping, leaves the reference out of the request and tells the main agent", async () => {
      const { call, service } = await setup(cursor);
      makeServiceLookOld(service);
      const delegated = await call("delegate", { harness: "pi", task: "[fixture:quick] hello", cwd: tmpdir(), conversationId: A });
      expect(delegated.isError).toBe(false);
      const origin = storedOrigin(service, delegated);
      // 老服务会拒绝 source: "declared"，所以没有发；来源 key 只是字符串，仍按对话区分。
      expect(origin).not.toHaveProperty("sessionRef");
      expect(origin).toMatchObject({ key: `cursor:${A}`, host: "cursor" });
      expect(origin?.evidence).toContain("declared:conversationId");
      expect(delegated.text).toContain("older than this plugin");
      expect(delegated.text).toContain("conversationId");
      // 按这个 key 区分对话仍然有效。
      expect((await call("status", { conversationId: A })).data?.["sessions"]).toHaveLength(1);
      expect((await call("status", { conversationId: B })).data?.["sessions"]).toEqual([]);
    });

    it("sends the reference as before when the service advertises support, and an identity from the host never needs it", async () => {
      const current = await setup(cursor);
      const delegated = await current.call("delegate", { harness: "pi", task: "[fixture:quick] hello", cwd: tmpdir(), conversationId: A });
      expect(delegated.text).not.toContain("older than this plugin");
      expect(current.service.hub.summary(delegated.data?.["sessionId"] as string)?.origin.sessionRef).toEqual({ id: A, kind: "conversation", source: "declared" });

      // 老服务 + 宿主给了标识：来源里的标识是宿主的（mcp-meta），老服务认得，照常带上。
      const old = await setup(cursor);
      makeServiceLookOld(old.service);
      const hosted = await old.call("delegate", { harness: "pi", task: "[fixture:quick] hello", cwd: tmpdir(), conversationId: A }, { conversation_id: "host-chat" });
      expect(hosted.text).not.toContain("older than this plugin");
      expect(old.service.hub.summary(hosted.data?.["sessionId"] as string)?.origin.sessionRef).toEqual({ id: "host-chat", kind: "conversation", source: "mcp-meta" });
    });
  });

  describe("the workspace recorded for the origin", () => {
    // Codex、Claude Code 等每个会话各起一个桥进程，它们报告的 roots 就是这段对话的目录；Cursor 的桥被所有窗口共用，不是（见下面几条）。
    const codex = { clientName: "codex-mcp-client" };
    /** 与服务端记下的目录比较：Windows 上盘符大小写可能不同，只比小写。 */
    const same = (actual: string | undefined, expected: string): boolean => actual?.toLowerCase() === expected.toLowerCase();

    /** 照着 Cursor 真实记录的形状建一个小的对话库：只放这些测试用到的字段（标题、`workspaceIdentifier`）。 */
    function cursorDbWith(rows: { id: string; name?: string; folder?: string }[]): string {
      const file = join(mkdtempSync(join(tmpdir(), "ensemble-cursor-db-")), "state.vscdb");
      const db = new DatabaseSync(file);
      db.exec("CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, createdAt INTEGER, value BLOB)");
      const insert = db.prepare("INSERT INTO composerHeaders (composerId, createdAt, value) VALUES (?, ?, ?)");
      for (const row of rows) {
        const workspaceIdentifier = row.folder ? { id: "w", uri: { scheme: "file", fsPath: row.folder, external: pathToFileURL(row.folder).href } } : { id: "w" };
        insert.run(row.id, 1, new Uint8Array(Buffer.from(JSON.stringify({ ...(row.name ? { name: row.name } : {}), workspaceIdentifier }), "utf8")));
      }
      db.close();
      return file;
    }

    it("is the folder the host reports, even on the very first delegation", async () => {
      const root = dir();
      const { call, service } = await setup({ ...codex, roots: [root], cwd: dir() });
      const delegated = await call("delegate", { harness: "pi", task: "[fixture:quick] hello", cwd: dir() });
      const origin = service.hub.summary(delegated.data?.["sessionId"] as string)?.origin;
      expect(origin?.workspace?.toLowerCase()).toBe(root.toLowerCase());
      expect(origin?.workspaceSource).toBe("mcp-roots");
    });

    it("is the cwd passed to this delegation when the host reports none", async () => {
      const project = dir();
      const { call, service } = await setup({ ...cursor, cwd: dir() });
      const delegated = await call("delegate", { harness: "pi", task: "[fixture:quick] hello", cwd: project });
      expect(service.hub.summary(delegated.data?.["sessionId"] as string)?.origin).toMatchObject({ workspace: project, workspaceSource: "delegate-cwd" });
    });

    it("is left out, not filled with the bridge process directory, when nothing says where the conversation works", async () => {
      const bridgeDir = dir();
      const { call, service } = await setup({ ...cursor, cwd: bridgeDir });
      const delegated = await call("delegate", { harness: "pi", task: "[fixture:quick] hello" });
      expect(delegated.isError).toBe(false);
      // 会话本身仍然退到桥进程目录干活（并且明说了），但来源的工作目录是未知的。
      expect(delegated.text).toContain("workspace source: the bridge process directory");
      const summary = service.hub.summary(delegated.data?.["sessionId"] as string);
      expect(summary?.cwd.toLowerCase()).toBe(bridgeDir.toLowerCase());
      expect(summary?.origin).not.toHaveProperty("workspace");
      expect(summary?.origin).not.toHaveProperty("workspaceSource");
    });

    it("prefers what the host reports over the cwd of one delegation", async () => {
      const root = dir();
      const { call, service } = await setup({ ...codex, roots: [root] });
      const delegated = await call("delegate", { harness: "pi", task: "[fixture:quick] hello", cwd: dir() });
      expect(service.hub.summary(delegated.data?.["sessionId"] as string)?.origin.workspaceSource).toBe("mcp-roots");
    });

    it("does not take the roots Cursor reports for this conversation's: one bridge serves every window, so the list is theirs combined", async () => {
      const otherWindow = dir();
      const project = dir();
      const logged: [string, Record<string, unknown> | undefined][] = [];
      const { call, service } = await setup({ ...cursor, roots: [otherWindow], cwd: dir(), log: (message, fields) => logged.push([message, fields]) });
      const delegated = await call("delegate", { harness: "pi", task: "[fixture:quick] hello", cwd: project });
      expect(delegated.isError).toBe(false);
      const summary = service.hub.summary(delegated.data?.["sessionId"] as string);
      // 来源的目录与会话的运行目录都只认这次显式传入的 cwd，不是别的窗口的目录。
      expect(summary?.origin).toMatchObject({ workspace: project, workspaceSource: "delegate-cwd" });
      expect(same(summary?.cwd, project)).toBe(true);
      expect(delegated.text).toContain("workspace source: argument");
      // 读得到却不用，留一条记录：只有条数，没有路径。
      const note = logged.find(([message]) => message === "host workspace roots are readable but not used");
      expect(note?.[1]).toEqual({ host: "cursor", entries: 1 });
    });

    it("does not let readable Cursor roots place a session either when no cwd is passed", async () => {
      const otherWindow = dir();
      const bridgeDir = dir();
      const { call, service } = await setup({ ...cursor, roots: [otherWindow], cwd: bridgeDir });
      const delegated = await call("delegate", { harness: "pi", task: "[fixture:quick] hello" });
      expect(delegated.isError).toBe(false);
      expect(delegated.text).toContain("workspace source: the bridge process directory");
      const summary = service.hub.summary(delegated.data?.["sessionId"] as string);
      expect(same(summary?.cwd, bridgeDir)).toBe(true);
      expect(summary?.origin).not.toHaveProperty("workspace");
    });

    it("logs what failed when the host's roots answer is rejected: a count and the kind of mistake, never a path", async () => {
      // Cursor 的 roots/list 应答里 `uri` 是普通路径而不是 file://，MCP SDK 的校验把整份应答挡掉（2026-11-21 在真实日志里见到的 `roots unavailable`）。
      const logged: [string, Record<string, unknown> | undefined][] = [];
      const { call } = await setup({
        ...cursor,
        rootUris: ["C:\\work\\project-a", "C:\\work\\secret-client-project"],
        cwd: dir(),
        log: (message, fields) => logged.push([message, fields]),
      });
      const delegated = await call("delegate", { harness: "pi", task: "[fixture:quick] hello", cwd: dir() });
      expect(delegated.isError).toBe(false);
      const failure = logged.find(([message]) => message === "roots unavailable")?.[1];
      expect(failure).toMatchObject({ invalidEntries: 2, notFileUri: 2 });
      expect(JSON.stringify(failure)).not.toContain("secret-client-project");
      expect(String(failure?.["error"]).length).toBeLessThanOrEqual(300);
    });

    describe("when the bridge was started in the user's home directory", () => {
      // Cursor 从用户主目录拉起 stdio MCP 服务（除非服务配置里写了 cwd），又被所有窗口共用。测试里的“主目录”是个临时目录。
      const home = (): string => mkdtempSync(join(tmpdir(), "ensemble-fake-home-"));

      it("refuses to start a Full Access session there without being told the project, and starts nothing", async () => {
        const homeDirectory = home();
        const { call, sessions } = await setup({ ...cursor, cwd: homeDirectory, homeDirectory });
        const refused = await call("delegate", { harness: "pi", task: "[fixture:quick] hello" });
        expect(refused.isError).toBe(true);
        expect(refused.text).toContain("home directory");
        expect(refused.text).toContain("Call `delegate` again with `cwd`");
        expect(sessions()).toHaveLength(0);
      });

      it("accepts the same call as soon as cwd is passed, and records that cwd as the origin's workspace", async () => {
        const homeDirectory = home();
        const project = dir();
        const { call, service } = await setup({ ...cursor, cwd: homeDirectory, homeDirectory });
        const delegated = await call("delegate", { harness: "pi", task: "[fixture:quick] hello", cwd: project });
        expect(delegated.isError).toBe(false);
        const summary = service.hub.summary(delegated.data?.["sessionId"] as string);
        expect(summary?.origin).toMatchObject({ workspace: project, workspaceSource: "delegate-cwd" });
        expect(same(summary?.cwd, project)).toBe(true);
        // 来源里从来没有用户主目录。
        expect(summary?.origin.workspace?.toLowerCase()).not.toBe(homeDirectory.toLowerCase());
      });

      it("does not refuse a project that merely sits inside the home directory, nor a host that reports its workspace", async () => {
        const homeDirectory = home();
        const project = join(homeDirectory, "project");
        mkdirSync(project);
        const inside = await setup({ ...cursor, cwd: project, homeDirectory });
        const delegated = await inside.call("delegate", { harness: "pi", task: "[fixture:quick] hello" });
        expect(delegated.isError).toBe(false);
        expect(delegated.text).toContain("workspace source: the bridge process directory");

        // 宿主老老实实报了 roots（每个会话各起桥的宿主）：桥虽然在主目录里，会话照 roots 走。
        const root = dir();
        const reported = await setup({ ...codex, roots: [root], cwd: homeDirectory, homeDirectory });
        const viaRoots = await reported.call("delegate", { harness: "pi", task: "[fixture:quick] hello" });
        expect(viaRoots.isError).toBe(false);
        expect(viaRoots.text).toContain("workspace source: the workspace folder reported by the host");
      });
    });

    describe("the workspace Cursor recorded for the conversation", () => {
      /** 对话 A 记着自己的项目目录；对话 B 在没有目录的窗口里；`target` 是这次委派让会话去干活的另一个目录。 */
      function fixture() {
        const recorded = dir();
        const cursorDb = cursorDbWith([
          { id: A, name: "Current project overview", folder: recorded },
          { id: B, name: "A conversation in an empty window" },
        ]);
        return { recorded, target: dir(), cursorDb };
      }

      it("is used for the origin when the conversation id is known, while the session still goes where cwd says", async () => {
        const { recorded, target, cursorDb } = fixture();
        const { call, service } = await setup({ ...cursor, cursorDb, cwd: dir() });
        const delegated = await call("delegate", { harness: "pi", task: "[fixture:quick] hello", cwd: target, conversationId: A });
        expect(delegated.isError).toBe(false);
        const summary = service.hub.summary(delegated.data?.["sessionId"] as string);
        expect(summary?.origin.workspaceSource).toBe("host-record");
        expect(same(summary?.origin.workspace, recorded)).toBe(true);
        expect(summary?.origin.hostTitle).toBe("Current project overview");
        // 记录说明“这段对话在哪个项目里”，不决定被委派的会话去哪干活：自报的标识没法核对，会话又是 Full Access。
        expect(same(summary?.cwd, target)).toBe(true);
        expect(delegated.text).toContain("workspace source: argument");
      });

      it("works the same for an identity the host gave", async () => {
        const { recorded, target, cursorDb } = fixture();
        const { call, service } = await setup({ ...cursor, cursorDb, cwd: dir(), env: { CURSOR_CONVERSATION_ID: A } });
        const delegated = await call("delegate", { harness: "pi", task: "[fixture:quick] hello", cwd: target });
        const origin = service.hub.summary(delegated.data?.["sessionId"] as string)?.origin;
        expect(origin?.sessionRef).toMatchObject({ id: A, source: "env" });
        expect(origin?.workspaceSource).toBe("host-record");
        expect(same(origin?.workspace, recorded)).toBe(true);
      });

      it("is not looked up at all without a conversation id: no guessing from the database", async () => {
        const { target, cursorDb } = fixture();
        const { call, service } = await setup({ ...cursor, cursorDb, cwd: dir() });
        const delegated = await call("delegate", { harness: "pi", task: "[fixture:quick] hello", cwd: target });
        expect(service.hub.summary(delegated.data?.["sessionId"] as string)?.origin).toMatchObject({ workspace: target, workspaceSource: "delegate-cwd" });
      });

      it("falls back to the cwd passed when the record has no folder, the conversation is unknown, or the database cannot be read", async () => {
        const { target, cursorDb } = fixture();
        const unknown = "9d3c5f4e-0000-4000-8000-000000000000";
        for (const options of [
          { conversationId: B, cursorDb },
          { conversationId: unknown, cursorDb },
          { conversationId: A, cursorDb: join(dir(), "missing.vscdb") },
        ]) {
          const { call, service } = await setup({ ...cursor, cursorDb: options.cursorDb, cwd: dir() });
          const delegated = await call("delegate", { harness: "pi", task: "[fixture:quick] hello", cwd: target, conversationId: options.conversationId });
          expect(delegated.isError).toBe(false);
          expect(service.hub.summary(delegated.data?.["sessionId"] as string)?.origin).toMatchObject({ workspace: target, workspaceSource: "delegate-cwd" });
        }
      });

      it("outranks the cwd passed, and the roots Cursor reports stay out of it", async () => {
        const { recorded, target, cursorDb } = fixture();
        const root = dir();
        const { call, service } = await setup({ ...cursor, cursorDb, roots: [root], cwd: dir() });
        const delegated = await call("delegate", { harness: "pi", task: "[fixture:quick] hello", cwd: target, conversationId: A });
        const origin = service.hub.summary(delegated.data?.["sessionId"] as string)?.origin;
        expect(origin?.workspaceSource).toBe("host-record");
        expect(same(origin?.workspace, recorded)).toBe(true);
      });

      it("is sent without its origin note to a service that does not advertise host-record-workspace", async () => {
        const { recorded, target, cursorDb } = fixture();
        const { call, service } = await setup({ ...cursor, cursorDb, cwd: dir() });
        makeServiceLookOld(service);
        const delegated = await call("delegate", { harness: "pi", task: "[fixture:quick] hello", cwd: target, conversationId: A });
        expect(delegated.isError).toBe(false);
        const origin = service.hub.summary(delegated.data?.["sessionId"] as string)?.origin;
        // 老服务的校验不认 host-record，发了会拒绝整条委派：目录照发，只是不带来历。
        expect(same(origin?.workspace, recorded)).toBe(true);
        expect(origin).not.toHaveProperty("workspaceSource");
      });
    });
  });

  describe("the hint that an origin may be shared", () => {
    const hint = /may be shared by several conversations/;

    async function twoRunning(options: { sameDirectory?: boolean; conversationId?: string } = {}) {
      const harness = await setup(cursor);
      const first = dir();
      const second = options.sameDirectory ? first : dir();
      const ids = [first, second].map(async (cwd, index) => {
        const delegated = await harness.call("delegate", { harness: "pi", task: `[fixture:hold] ${index}`, cwd, ...(options.conversationId ? { conversationId: options.conversationId } : {}) });
        return delegated.data?.["sessionId"] as string;
      });
      const resolved = await Promise.all(ids);
      await until(() => resolved.every((id) => harness.service.hub.summary(id)?.phase === "running"), 6000);
      return { ...harness, ids: resolved };
    }

    it("is added at the end of `status` and `wait` when an origin with no conversation identity has sessions running in different directories", async () => {
      const { call, ids, service } = await twoRunning();
      const status = await call("status");
      expect(status.text).toMatch(hint);
      expect(status.text.trimEnd().endsWith("or pass your conversation id as `conversationId` on every Ensemble call.")).toBe(true);
      expect(status.data?.["originMaybeShared"]).toBe(true);
      expect(status.text).toMatch(/2 different directories/);

      const waited = await call("wait", { timeoutSeconds: 1, attention: false });
      expect(waited.text).toMatch(hint);
      expect(waited.data?.["originMaybeShared"]).toBe(true);
      for (const id of ids) await userSays(service, id, "wrap up");
    });

    it("stays silent when the sessions share a directory, when the caller named sessions explicitly, or when the origin has an identity", async () => {
      const same = await twoRunning({ sameDirectory: true });
      expect((await same.call("status")).text).not.toMatch(hint);
      expect((await same.call("wait", { timeoutSeconds: 1, attention: false })).text).not.toMatch(hint);

      const explicit = await twoRunning();
      expect((await explicit.call("status", { sessionIds: explicit.ids })).text).not.toMatch(hint);
      expect((await explicit.call("wait", { sessionIds: explicit.ids, timeoutSeconds: 1, attention: false })).text).not.toMatch(hint);
      expect((await explicit.call("status", { scope: "all" })).text).not.toMatch(hint);

      // 带着自报的标识：来源已经有了对话级别的身份，不再提示。
      const declared = await twoRunning({ conversationId: A });
      expect((await declared.call("status", { conversationId: A })).text).not.toMatch(hint);
      expect((await declared.call("wait", { conversationId: A, timeoutSeconds: 1, attention: false })).data?.["originMaybeShared"]).toBeUndefined();
    });

    it("comes after the user's interventions, which matter more", async () => {
      const harness = await twoRunning();
      const third = (await harness.call("delegate", { harness: "pi", task: "[fixture:hold] three", cwd: dir() })).data?.["sessionId"] as string;
      await until(() => harness.service.hub.summary(third)?.phase === "running", 6000);
      await userSays(harness.service, third, "Use tabs.");
      const status = await harness.call("status");
      const notice = status.text.indexOf("While you were away");
      expect(notice).toBeGreaterThan(-1);
      expect(status.text.search(hint)).toBeGreaterThan(notice);
    });
  });

  describe("`wait` without session ids", () => {
    it("says which sessions it actually waited on", async () => {
      const { call, service } = await setup(cursor);
      const ids = [] as string[];
      for (const name of ["one", "two"]) ids.push((await call("delegate", { harness: "pi", task: `[fixture:hold] ${name}`, cwd: tmpdir(), conversationId: A })).data?.["sessionId"] as string);
      await until(() => ids.every((id) => service.hub.summary(id)?.phase === "running"), 6000);

      const waited = await call("wait", { conversationId: A, timeoutSeconds: 1, attention: false });
      expect(waited.text).toContain("Waited on 2 unfinished sessions of yours (no `sessionIds` given): ");
      for (const id of ids) expect(waited.text).toContain(id);
      expect([...(waited.data?.["waitedOn"] as string[])].sort()).toEqual([...ids].sort());

      // 显式给了 id 就不必再说一遍，但结构化结果仍然写明等的是哪些。
      const explicit = await call("wait", { sessionIds: [ids[0]!], conversationId: A, timeoutSeconds: 1, attention: false });
      expect(explicit.text).not.toContain("Waited on");
      expect(explicit.data?.["waitedOn"]).toEqual([ids[0]]);
      for (const id of ids) await userSays(service, id, "wrap up");
    });
  });
});
