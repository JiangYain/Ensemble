/**
 * 经真实本地 HTTP 委派会话：实时事件与详情、父会话的摘要推送、用户纠正与介入通知、桥带来的来源（可协商功能、自报的会话标识、宿主记录的工作区、老桥的来源目录兜底）、
 * Git 查询、取消与删除、访问级别、wait 长轮询、SSE 续传与状态快照。
 * 服务的安全、静态托管与生命周期在 service.test.ts；执行端模型设置在 service.models.test.ts；改挂上级在 service.relink.test.ts。
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, SERVICE_FEATURES, TOKEN_HEADER } from "@shared/constants";
import type { StateSnapshot, StreamMessage } from "@shared/protocol";
import { testOrigin } from "@shared/testing";
import type { GitInspector } from "./git";
import type { RunningService } from "./service";
import { api, boot, closeServices, openStream } from "./service.fixtures";
import { delegate } from "./service.http.fixtures";
import { until } from "./testing";

afterEach(closeServices);

describe("delegation over http", () => {
  it("delegates, streams live events and summaries, and exposes the full detail", async () => {
    const service = await boot();
    const client = api(service);
    const stream = await openStream(service);
    await until(() => stream.frames.some((f) => f.message.type === "snapshot"));

    const { response, body } = await delegate(client, "Refactor the parser");
    expect(response.status).toBe(201);
    expect(body.summary.phase).toBe("starting");

    await until(() => stream.frames.some((f) => f.message.type === "summary" && f.message.summary.id === body.sessionId && f.message.summary.phase === "done"), 6000, "done summary");
    const kinds = new Set(
      stream.frames.flatMap((f) => (f.message.type === "events" ? f.message.events.map((e) => e.kind) : [])),
    );
    for (const kind of ["session.created", "run.started", "tool.updated", "assistant.delta", "run.completed"]) {
      expect(kinds.has(kind as never)).toBe(true);
    }
    const ids = stream.identified().map((f) => f.rev);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));

    const detail = await client.json<{ summary: { phase: string }; events: { seq: number }[] }>(await client.get(`/api/sessions/${body.sessionId}`));
    expect(detail.summary.phase).toBe("done");
    expect(detail.events.map((e) => e.seq)).toEqual(detail.events.map((_, i) => i + 1));

    const tail = await client.json<{ events: { seq: number }[]; lastSeq: number }>(await client.get(`/api/sessions/${body.sessionId}/events?after=${detail.events.length - 3}`));
    expect(tail.events).toHaveLength(3);
    expect(tail.lastSeq).toBe(detail.events.length);
    stream.close();
  });

  it("updates the parent's SSE summary when a child is delegated and removed", async () => {
    const service = await boot();
    const client = api(service);
    const { body: parent } = await delegate(client, "[fixture:quick] Parent");
    await until(() => service.hub.summary(parent.sessionId)?.phase === "done");
    const stream = await openStream(service);
    try {
      await until(() => stream.frames.some((frame) => frame.message.type === "snapshot"));
      const { body: child } = await delegate(client, "[fixture:quick] Child", { origin: testOrigin(), parentSessionId: parent.sessionId });
      const changes = () => stream.frames.flatMap(({ message }) =>
        message.type === "summary" && message.summary.id === parent.sessionId ? [message.summary.childIds] : []);
      await until(() => changes().some((ids) => ids.includes(child.sessionId)));
      await until(() => service.hub.summary(child.sessionId)?.phase === "done");
      const response = await fetch(`${service.url}/api/sessions/${child.sessionId}`, {
        method: "DELETE", headers: { [TOKEN_HEADER]: service.token },
      });
      expect(response.ok).toBe(true);
      await until(() => changes().at(-1)?.length === 0);
    } finally {
      stream.close();
    }
  });

  it("sends a user steer, then lets the bridge collect the intervention notice", async () => {
    const service = await boot();
    const client = api(service);
    const origin = testOrigin();
    const { body } = await delegate(client, "Wait for guidance [fixture:hold]", { origin });
    // 没有 x-ensemble-client: mcp 时，来源一律是控制台。
    const summary = (await client.json<{ summary: { origin: { host: string } } }>(await client.get(`/api/sessions/${body.sessionId}`))).summary;
    expect(summary.origin.host).toBe("console");

    const fromBridge = await client.post("/api/sessions", { harness: "pi", task: "Wait for guidance [fixture:hold]", cwd: tmpdir(), origin }, { "x-ensemble-client": "mcp" });
    const bridged = await client.json<{ sessionId: string; summary: { origin: { host: string; key: string } } }>(fromBridge);
    expect(bridged.summary.origin).toMatchObject({ host: "codex", key: origin.key });
    await until(() => service.hub.state(bridged.sessionId)?.status === "running");

    const sent = await client.post(`/api/sessions/${bridged.sessionId}/messages`, { text: "Please use the async API" });
    expect(sent.status).toBe(200);
    const sentBody = await client.json<{ kind: string }>(sent);
    expect(sentBody.kind).toBe("steer");

    const collected = await client.json<{ notices: { kind: string; text: string }[] }>(await client.post("/api/notices/collect", { originKey: origin.key }, { "x-ensemble-client": "mcp" }));
    expect(collected.notices).toHaveLength(1);
    expect(collected.notices[0]).toMatchObject({ kind: "intervention", text: "Please use the async API" });
    const again = await client.json<{ notices: unknown[] }>(await client.post("/api/notices/collect", { originKey: origin.key }));
    expect(again.notices).toHaveLength(0);
    await until(() => service.hub.state(bridged.sessionId)?.runs[0]?.status === "completed");
  });

  describe("negotiable features and the origin a bridge sends", () => {
    it("advertises what it can do in /api/health and in service.json, so an older service is recognisable by their absence", async () => {
      const service = await boot();
      const health = (await (await fetch(`${service.url}/api/health`)).json()) as { features?: string[]; protocol: number };
      // 以常量为准：每新增一项可协商功能（会话归档、报告、角色……）这里都不必再改；老的两项仍须在里面。
      expect(health.features).toEqual([...SERVICE_FEATURES]);
      expect(health.features).toEqual(expect.arrayContaining(["declared-session-ref", "host-record-workspace", "session-archive"]));
      expect(health.protocol).toBe(PROTOCOL_VERSION);
      const file = JSON.parse(readFileSync(service.paths.serviceFile, "utf8")) as { features?: string[]; protocol: number };
      expect(file.features).toEqual([...SERVICE_FEATURES]);
      // 新增可协商功能不换协议版本：版本一变，正在运行的老服务就会被新的桥拒绝。
      expect(file.protocol).toBe(PROTOCOL_VERSION);
    });

    it("accepts an origin whose session reference was declared by the agent, and keeps where its workspace came from", async () => {
      const service = await boot();
      const client = api(service);
      const origin = testOrigin({
        key: "cursor:4706e0d9-12d7-4b10-a784-5d3416b186a9",
        host: "cursor",
        hostLabel: "Cursor",
        sessionRef: { id: "4706e0d9-12d7-4b10-a784-5d3416b186a9", kind: "conversation", source: "declared" },
        workspace: tmpdir(),
        workspaceSource: "delegate-cwd",
        evidence: ["clientInfo:cursor-vscode", "declared:conversationId"],
      });
      const response = await client.post("/api/sessions", { harness: "pi", task: "[fixture:quick] declared", cwd: tmpdir(), origin }, { "x-ensemble-client": "mcp" });
      expect(response.status).toBe(201);
      const created = await client.json<{ summary: { origin: unknown } }>(response);
      expect(created.summary.origin).toMatchObject({
        key: origin.key,
        sessionRef: { kind: "conversation", source: "declared" },
        workspace: tmpdir(),
        workspaceSource: "delegate-cwd",
      });
    });

    it("still refuses a session reference source it does not know", async () => {
      const service = await boot();
      const origin = testOrigin({ sessionRef: { id: "x", kind: "conversation", source: "guessed" as never } });
      const response = await api(service).post("/api/sessions", { harness: "pi", task: "[fixture:quick]", cwd: tmpdir(), origin }, { "x-ensemble-client": "mcp" });
      expect(response.status).toBe(400);
    });

    it("accepts a workspace the host recorded for the conversation and keeps where it came from, but still refuses a source it does not know", async () => {
      const service = await boot();
      const client = api(service);
      const workspace = mkdtempSync(join(tmpdir(), "ensemble-ws-"));
      const origin = testOrigin({ key: "cursor:chat", host: "cursor", hostLabel: "Cursor", workspace, workspaceSource: "host-record", evidence: ["clientInfo:cursor-vscode"] });
      const response = await client.post("/api/sessions", { harness: "pi", task: "[fixture:quick] host record", cwd: tmpdir(), origin }, { "x-ensemble-client": "mcp" });
      expect(response.status).toBe(201);
      expect((await client.json<{ summary: { origin: unknown } }>(response)).summary.origin).toMatchObject({ workspace, workspaceSource: "host-record" });

      const unknown = { ...origin, workspaceSource: "guessed" };
      const refused = await client.post("/api/sessions", { harness: "pi", task: "[fixture:quick] unknown source", cwd: tmpdir(), origin: unknown }, { "x-ensemble-client": "mcp" });
      expect(refused.status).toBe(400);
    });
  });

  describe("an origin recorded by an older bridge", () => {
    // 老桥（2026-11-17 之前）把自己的启动目录记成来源的工作目录且不带来历；Cursor 把桥从用户主目录拉起来，于是来源卡上写着主目录。
    const legacy = (workspace: string | undefined, extra: object = {}) =>
      testOrigin({ key: "cursor:bridge-old", host: "cursor", hostLabel: "Cursor", ...(workspace ? { workspace } : {}), evidence: ["clientInfo:cursor-vscode"], ...extra });

    async function delegateFrom(service: RunningService, origin: unknown, cwd: string, task: string) {
      const response = await api(service).post("/api/sessions", { harness: "pi", task, cwd, origin }, { "x-ensemble-client": "mcp" });
      expect(response.status).toBe(201);
      return (await api(service).json<{ summary: { origin: Record<string, unknown> } }>(response)).summary.origin;
    }

    it("replaces the user's home directory, which only says where the bridge was started, with the cwd the delegation passed", async () => {
      const service = await boot();
      const project = mkdtempSync(join(tmpdir(), "ensemble-project-"));
      const origin = await delegateFrom(service, legacy(homedir()), project, "[fixture:quick] old bridge");
      expect(origin).toMatchObject({ workspace: project, workspaceSource: "delegate-cwd" });
    });

    it("leaves an origin alone when it names a source, or a directory other than the home directory", async () => {
      const service = await boot();
      const project = mkdtempSync(join(tmpdir(), "ensemble-project-"));
      const elsewhere = mkdtempSync(join(tmpdir(), "ensemble-elsewhere-"));

      // 新桥写目录时一定带来历：即使目录恰好是主目录，也是它按宿主报告或显式 cwd 得到的，不改。
      const sourced = await delegateFrom(service, legacy(homedir(), { workspaceSource: "delegate-cwd" }), project, "[fixture:quick] sourced");
      expect(sourced).toMatchObject({ workspace: homedir(), workspaceSource: "delegate-cwd" });

      // 老桥记的是别的目录（例如 Codex 里桥在项目目录启动）：不动，也不加来历。
      const other = await delegateFrom(service, legacy(elsewhere), project, "[fixture:quick] other directory");
      expect(other).toMatchObject({ workspace: elsewhere });
      expect(other).not.toHaveProperty("workspaceSource");

      // 没有目录就仍然没有。
      const none = await delegateFrom(service, legacy(undefined), project, "[fixture:quick] no workspace");
      expect(none).not.toHaveProperty("workspace");
    });
  });

  it("answers Git questions only for workspaces it already knows, and only with the token", async () => {
    const asked: string[] = [];
    const git: GitInspector = {
      async inspect(path) {
        asked.push(path);
        return { path, git: null, reason: "not_repo" };
      },
    };
    const service = await boot({ git });
    const client = api(service);
    const workspace = mkdtempSync(join(tmpdir(), "ensemble-ws-"));
    const origin = testOrigin({ workspace });
    await client.json(await client.post("/api/sessions", { harness: "pi", task: "[fixture:quick]", cwd: tmpdir(), origin }, { "x-ensemble-client": "mcp" }));

    const known = await client.get(`/api/git?path=${encodeURIComponent(workspace)}`);
    expect(known.status).toBe(200);
    expect(await client.json(known)).toEqual({ path: workspace, git: null, reason: "not_repo" });
    // 会话的运行目录也算已知；Windows 上大小写不敏感，路径写法不同也认得。
    expect((await client.get(`/api/git?path=${encodeURIComponent(tmpdir())}`)).status).toBe(200);
    if (process.platform === "win32") expect((await client.get(`/api/git?path=${encodeURIComponent(workspace.toUpperCase())}`)).status).toBe(200);
    expect(asked.length).toBeGreaterThanOrEqual(2);

    const before = asked.length;
    const stranger = mkdtempSync(join(tmpdir(), "ensemble-stranger-"));
    expect((await client.get(`/api/git?path=${encodeURIComponent(stranger)}`)).status).toBe(404);
    expect((await client.get("/api/git")).status).toBe(400);
    expect((await client.get("/api/git?path=")).status).toBe(400);
    expect((await fetch(`${service.url}/api/git?path=${encodeURIComponent(workspace)}`)).status).toBe(403);
    expect(asked).toHaveLength(before);
  });

  it("cancels a running session and removes finished ones", async () => {
    const service = await boot();
    const client = api(service);
    const { body } = await delegate(client, "[fixture:long]");
    await until(() => service.hub.state(body.sessionId)?.status === "running");

    const removeRunning = await fetch(`${service.url}/api/sessions/${body.sessionId}`, { method: "DELETE", headers: { [TOKEN_HEADER]: service.token } });
    expect(removeRunning.status).toBe(409);

    const cancelled = await client.post(`/api/sessions/${body.sessionId}/cancel`);
    expect(cancelled.status).toBe(200);
    await until(() => service.hub.state(body.sessionId)?.runs[0]?.status === "cancelled");

    const removed = await fetch(`${service.url}/api/sessions/${body.sessionId}`, { method: "DELETE", headers: { [TOKEN_HEADER]: service.token } });
    expect(removed.status).toBe(200);
    expect((await client.get(`/api/sessions/${body.sessionId}`)).status).toBe(404);
  });

  it("delegates with Full Access by default, offers only read-only besides, and has no approval endpoint", async () => {
    const service = await boot();
    const client = api(service);
    const { body } = await delegate(client, "[fixture:quick]");
    expect(body.summary).toMatchObject({ access: "full" });

    const readOnly = await client.post("/api/sessions", { harness: "pi", task: "[fixture:quick]", cwd: tmpdir(), access: "read_only" });
    expect((await client.json<{ summary: { access: string } }>(readOnly)).summary.access).toBe("read_only");

    const retired = await client.post("/api/sessions", { harness: "pi", task: "[fixture:quick]", cwd: tmpdir(), access: "workspace_write" });
    expect(retired.status).toBe(400);

    const approve = await client.post(`/api/sessions/${body.sessionId}/permissions/p1`, { decision: "approved" });
    expect(approve.status).toBe(404);
  });

  it("long-polls until sessions settle, and returns early when the user has intervened", async () => {
    const service = await boot();
    const client = api(service);
    const { body: quick } = await delegate(client, "[fixture:quick]");
    const settled = await client.json<{ reason: string; sessions: { phase: string }[] }>(
      await client.post("/api/wait", { sessionIds: [quick.sessionId], timeoutMs: 5000 }),
    );
    expect(settled.reason).toBe("settled");
    expect(settled.sessions[0]?.phase).toBe("done");

    const { body: long } = await delegate(client, "[fixture:long]");
    await until(() => service.hub.state(long.sessionId)?.status === "running");
    const timeout = await client.json<{ reason: string }>(await client.post("/api/wait", { sessionIds: [long.sessionId], timeoutMs: 150 }));
    expect(timeout.reason).toBe("timeout");

    // 用户在网页里直接纠正一个由主 Agent 派出的会话：带着发起端键的 wait 立刻因通知返回，而不是等满超时。
    const origin = testOrigin();
    const fromBridge = await client.post("/api/sessions", { harness: "pi", task: "Wait for guidance [fixture:hold]", cwd: tmpdir(), origin }, { "x-ensemble-client": "mcp" });
    const bridged = await client.json<{ sessionId: string }>(fromBridge);
    await until(() => service.hub.state(bridged.sessionId)?.status === "running");
    await client.post(`/api/sessions/${bridged.sessionId}/messages`, { text: "Please use the async API" });
    const notified = await client.json<{ reason: string }>(await client.post("/api/wait", { sessionIds: [bridged.sessionId], timeoutMs: 5000, originKey: origin.key }));
    expect(notified.reason).toBe("notice");

    const missing = await client.post("/api/wait", { sessionIds: ["ses_missing"] });
    expect(missing.status).toBe(404);
    await client.post(`/api/sessions/${long.sessionId}/stop`);
  });

  it("resumes the event stream from Last-Event-ID without a snapshot, and falls back to a snapshot when too old", async () => {
    const service = await boot();
    const client = api(service);
    const first = await openStream(service);
    await until(() => first.frames.some((f) => f.message.type === "snapshot"));
    await delegate(client, "[fixture:quick]");
    await until(() => first.frames.some((f) => f.message.type === "summary" && f.message.summary.phase === "done"), 6000);
    const last = first.identified().at(-1)!;
    first.close();

    // 任务写得不一样：逐字相同的委派在短时间内会被当作重复提交，不会再建第二个会话。
    await delegate(client, "[fixture:quick] second");
    await until(() => service.hub.allSummaries().filter((s) => s.phase === "done").length === 2, 6000);
    const resumed = await openStream(service, last.rawId);
    await until(() => resumed.identified().length > 0);
    await new Promise((r) => setTimeout(r, 120));
    expect(resumed.frames.some((f) => f.message.type === "snapshot")).toBe(false);
    expect(resumed.identified()[0]!.rev).toBe(last.rev + 1);
    resumed.close();

    // 来自另一个进程（例如重启前）的 Last-Event-ID 不能拿来补发，必须重新发快照。
    const stale = await openStream(service, `deadbeef:${last.rev}`);
    await until(() => stale.frames.some((f) => f.message.type === "snapshot"));
    const snapshot = stale.frames.find((f) => f.message.type === "snapshot")!.message as Extract<StreamMessage, { type: "snapshot" }>;
    expect(snapshot.snapshot.sessions).toHaveLength(2);
    expect(snapshot.snapshot.harnesses.map((h) => h.id).sort()).toEqual(["cursor", "pi"]);
    stale.close();
  });

  it("reports state with harness info, runtime labels and the dev flag", async () => {
    const service = await boot();
    const state = await api(service).json<StateSnapshot>(await api(service).get("/api/state"));
    expect(state.dev).toBe(true);
    expect(state.harnesses.every((h) => h.runtime === "fixture")).toBe(true);
    expect(state.capacity).toMatchObject({ occupied: 0 });
  });
});
