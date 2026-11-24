/**
 * 历史会话（冷热分离、归档、留存）经 HTTP 的端到端行为：用真实的服务、真实的文件存储（临时目录），
 * 先把一批“老会话”的日志写进 home，再起服务——它们启动时就是冷的，所以这里读到的、归档的都是冷会话。
 * 时间不依赖真实时钟：服务的时钟固定在 NOW（history / retention 的 now），夹具都是相对 NOW 的几十天前。
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LIMITS, SERVICE_FEATURES, TOKEN_HEADER } from "@shared/constants";
import type { ArchiveResponse, HealthBody, RetentionResponse, SessionDetail, StateSnapshot, StreamMessage } from "@shared/protocol";
import type { SessionSummary } from "@shared/types";
import { FixtureExecutor } from "./executors/fixture";
import { DAY, NOW, seed, sessionEvents, type SessionFixture } from "./history-fixtures";
import { silentLogger } from "./logger";
import { pathsFor } from "./paths";
import { startService, type RunningService, type StartServiceOptions } from "./service";
import { FileEventStore } from "./store";
import { until } from "./testing";

const running: RunningService[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()!.close("test");
});

const A = "ses_a";
const B = "ses_b";
const C = "ses_c";
const PARENT = "ses_parent";
const CHILD = "ses_child";
const RECENT = "ses_recent";

/**
 * 一批老会话：A（完成）、B（失败）、C（待命，不算已结束）、PARENT 与它的下级 CHILD（都完成）、RECENT（完成，只有 2 天）。
 * 距 NOW 的天数：A 40、B 35、C 33、PARENT 32、CHILD 31（所以 PARENT 这棵树的最后活动是 31 天前）、RECENT 2。
 */
const OLD: SessionFixture[] = [
  { id: A, ending: "done", at: NOW - 40 * DAY },
  { id: B, ending: "failed", at: NOW - 35 * DAY },
  { id: C, ending: "ready", at: NOW - 33 * DAY },
  { id: PARENT, ending: "done", at: NOW - 32 * DAY },
  { id: CHILD, ending: "done", at: NOW - 31 * DAY, parent: PARENT },
  { id: RECENT, ending: "done", at: NOW - 2 * DAY },
];
const EVERYONE = OLD.map((fixture) => fixture.id).sort();

async function emptyHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ensemble-archive-http-"));
}

/** 先把这些会话的日志写进一个新 home 的会话目录，再起服务：服务启动时看到的就是一批没有快照的“老会话”。 */
async function homeWith(fixtures: readonly SessionFixture[]): Promise<string> {
  const home = await emptyHome();
  await seed(new FileEventStore(pathsFor(home).sessions, silentLogger), fixtures);
  return home;
}

const logOf = (home: string, id: string): string => join(pathsFor(home).sessions, id, "events.jsonl");

async function boot(home: string, options: Partial<StartServiceOptions> = {}): Promise<RunningService> {
  const service = await startService({
    home,
    port: 0,
    executors: [new FixtureExecutor("pi", { speed: 0 }), new FixtureExecutor("cursor", { speed: 0 })],
    log: silentLogger,
    webRoot: null,
    idleExitMs: 0,
    // 服务的时钟固定在夹具的“现在”：夹具里的会话是几十天前的老会话；测试里新创建的会话带真实时间，在这个时钟看来不比它们老，
    // 不会被当作冷会话冻结。
    history: { now: () => NOW },
    retention: { now: () => NOW },
    ...options,
  });
  running.push(service);
  return service;
}

interface Api {
  get(path: string): Promise<Response>;
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  put(path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  json<T>(response: Response): Promise<T>;
}

function api(service: RunningService): Api {
  const headers = { [TOKEN_HEADER]: service.token, "content-type": "application/json" };
  return {
    get: (path) => fetch(`${service.url}${path}`, { headers }),
    post: (path, body, extra) => fetch(`${service.url}${path}`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(body ?? {}) }),
    put: (path, body, extra) => fetch(`${service.url}${path}`, { method: "PUT", headers: { ...headers, ...extra }, body: JSON.stringify(body ?? {}) }),
    json: async <T>(response: Response) => (await response.json()) as T,
  };
}

async function listed(client: Api, query = ""): Promise<SessionSummary[]> {
  return (await client.json<{ sessions: SessionSummary[] }>(await client.get(`/api/sessions${query}`))).sessions;
}

const idsOf = (sessions: readonly SessionSummary[]): string[] => sessions.map((session) => session.id).sort();

async function healthOf(service: RunningService): Promise<HealthBody> {
  return (await (await fetch(`${service.url}/api/health`)).json()) as HealthBody;
}

async function delegate(client: Api, task: string, extra: Record<string, unknown> = {}) {
  const response = await client.post("/api/sessions", { harness: "pi", task, cwd: tmpdir(), ...extra });
  const body = await client.json<{ sessionId: string }>(response);
  return { response, body };
}

async function archive(client: Api, action: "archive" | "unarchive", ...ids: string[]): Promise<ArchiveResponse> {
  return client.json<ArchiveResponse>(await client.post(`/api/sessions/${action}`, { ids }));
}

/** 极简 SSE 客户端：读取并解析帧。与 service.fixtures.ts 的 `openStream` 做同一件事，只是更小：不能按 `lastEventId` 续传，`frames` 是裸的 `StreamMessage`（没有 `id:` 与修订号）。 */
async function openStream(service: RunningService) {
  const controller = new AbortController();
  const response = await fetch(`${service.url}/api/stream?token=${service.token}`, { signal: controller.signal });
  const frames: StreamMessage[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const raw = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const data = raw.split("\n").find((line) => line.startsWith("data: "));
          if (data) frames.push(JSON.parse(data.slice(6)) as StreamMessage);
        }
      }
    } catch {
      // 连接被主动中止。
    }
  })();
  return { frames, close: () => controller.abort() };
}

describe("old sessions over HTTP", () => {
  it("starts with them out of memory and still answers for every one of them", async () => {
    const service = await boot(await homeWith(OLD));
    const client = api(service);

    const health = await healthOf(service);
    expect(health).toMatchObject({ sessions: OLD.length, sessionsHot: 0, sessionsArchived: 0 });
    expect(health.features).toContain("session-archive");
    expect(SERVICE_FEATURES).toContain("session-archive");

    const state = await client.json<StateSnapshot>(await client.get("/api/state"));
    expect(idsOf(state.sessions)).toEqual(EVERYONE);
    expect(state.archivedCount).toBe(0);
    expect(state.retention).toEqual({ keepDays: null, keepCount: null });

    const events = sessionEvents(OLD[0]!);
    const detail = await client.json<SessionDetail>(await client.get(`/api/sessions/${A}`));
    expect(detail.summary).toMatchObject({ id: A, phase: "done" });
    expect(detail.events.map((event) => event.seq)).toEqual(events.map((event) => event.seq));
    const tail = await client.json<{ events: { seq: number }[]; lastSeq: number }>(await client.get(`/api/sessions/${A}/events?after=2`));
    expect(tail.events.map((event) => event.seq)).toEqual(events.slice(2).map((event) => event.seq));
    expect(tail.lastSeq).toBe(events.length);
    // 只读的使用（详情、事件）不会把冷会话载回内存。
    expect(service.hub.isHot(A)).toBe(false);

    expect((await client.get("/api/sessions/ses_missing")).status).toBe(404);
  });
});

describe("archiving over HTTP", () => {
  it("moves a session out of the default views without touching its record, and brings it back", async () => {
    const home = await homeWith(OLD);
    const before = await readFile(logOf(home, A));
    const service = await boot(home);
    const client = api(service);
    const others = EVERYONE.filter((id) => id !== A);

    const archived = await client.post("/api/sessions/archive", { ids: [A] });
    expect(archived.status).toBe(200);
    expect(await client.json<ArchiveResponse>(archived)).toEqual({ changed: [A], skipped: [] });

    expect(idsOf(await listed(client))).toEqual(others);
    expect(idsOf(await listed(client, "?archived=exclude"))).toEqual(others);
    expect(idsOf(await listed(client, "?archived=include"))).toEqual(EVERYONE);
    const only = await listed(client, "?archived=only");
    expect(idsOf(only)).toEqual([A]);
    expect(only[0]).toMatchObject({ archivedBy: "user", archivedAt: expect.any(String) });

    const state = await client.json<StateSnapshot>(await client.get("/api/state"));
    expect(state.archivedCount).toBe(1);
    expect(idsOf(state.sessions)).toEqual(others);
    expect(await healthOf(service)).toMatchObject({ sessions: OLD.length, sessionsArchived: 1 });

    // 已归档的会话照样读得到，主 Agent 的 wait 也照样能等到它（它早已结束）；读它不会把它载回内存。
    const detail = await client.json<SessionDetail>(await client.get(`/api/sessions/${A}`));
    expect(detail.summary).toMatchObject({ id: A, archivedBy: "user" });
    expect(detail.events).toHaveLength(sessionEvents(OLD[0]!).length);
    const waited = await client.json<{ reason: string; sessions: SessionSummary[] }>(await client.post("/api/wait", { sessionIds: [A], timeoutMs: 1000 }));
    expect(waited.reason).toBe("settled");
    expect(waited.sessions.map((session) => session.id)).toEqual([A]);
    expect(service.hub.isHot(A)).toBe(false);

    // 标记是会话目录里的一个小文件；记录本身一个字节都没动。
    expect(existsSync(join(dirname(logOf(home, A)), "archive.json"))).toBe(true);
    expect(await readFile(logOf(home, A))).toEqual(before);

    expect(await archive(client, "archive", A)).toEqual({ changed: [], skipped: [{ id: A, reason: "already" }] });
    expect(await archive(client, "unarchive", A)).toEqual({ changed: [A], skipped: [] });
    expect(idsOf(await listed(client))).toEqual(EVERYONE);
    expect(await listed(client, "?archived=only")).toEqual([]);
    expect(existsSync(join(dirname(logOf(home, A)), "archive.json"))).toBe(false);
    expect(await archive(client, "unarchive", A)).toEqual({ changed: [], skipped: [{ id: A, reason: "not_archived" }] });
    expect(await readFile(logOf(home, A))).toEqual(before);
  });

  it("keeps the mark across a restart", async () => {
    const home = await homeWith(OLD);
    const first = await boot(home);
    expect((await archive(api(first), "archive", B)).changed).toEqual([B]);
    await first.close("restart");

    const second = await boot(home);
    const client = api(second);
    expect(idsOf(await listed(client, "?archived=only"))).toEqual([B]);
    expect((await client.json<StateSnapshot>(await client.get("/api/state"))).archivedCount).toBe(1);
    expect(await healthOf(second)).toMatchObject({ sessionsArchived: 1 });
  });

  it("archives a whole task tree together, and unarchiving a child brings its parent back with it", async () => {
    const service = await boot(await homeWith(OLD));
    const client = api(service);

    const whole = await archive(client, "archive", PARENT);
    expect(whole.changed).toEqual([PARENT, CHILD]);
    expect(idsOf(await listed(client, "?archived=only"))).toEqual([CHILD, PARENT]);

    // 点名下级取消归档：连同仍归档的上级一起回来（它不会脱离上级单独冒出来）。
    const back = await archive(client, "unarchive", CHILD);
    expect(back.changed).toEqual([PARENT, CHILD]);
    expect(await listed(client, "?archived=only")).toEqual([]);

    // 只归档下级：上级留在默认视图里。
    expect((await archive(client, "archive", CHILD)).changed).toEqual([CHILD]);
    const visible = idsOf(await listed(client));
    expect(visible).toContain(PARENT);
    expect(visible).not.toContain(CHILD);
  });

  // 撤销刚才那次归档（exact）：下级更早就单独归档了，后来归档上级，这次真正变化的只有上级；
  // 撤销只该放回上级。没有 exact 的取消归档把整棵子树带回来，它是另一个动作（上面那条），保持原样。
  describe("undoing an archive", () => {
    async function branchThenParent(home: string) {
      const service = await boot(home);
      const client = api(service);
      expect((await archive(client, "archive", CHILD)).changed).toEqual([CHILD]);
      const whole = await archive(client, "archive", PARENT);
      expect(whole.changed).toEqual([PARENT]);
      return { client, whole };
    }

    it("with exact puts back only what the archive changed, in the listing and on disk", async () => {
      const home = await homeWith(OLD);
      const { client, whole } = await branchThenParent(home);

      const undo = await client.post("/api/sessions/unarchive", { ids: whole.changed, exact: true });

      expect(undo.status).toBe(200);
      expect(await client.json<ArchiveResponse>(undo)).toEqual({ changed: [PARENT], skipped: [] });
      expect(idsOf(await listed(client, "?archived=only"))).toEqual([CHILD]);
      expect(existsSync(join(dirname(logOf(home, PARENT)), "archive.json"))).toBe(false);
      expect(existsSync(join(dirname(logOf(home, CHILD)), "archive.json"))).toBe(true);
    });

    it("without exact, or with exact false, the same request is the ordinary unarchive and brings the branch back too", async () => {
      const { client, whole } = await branchThenParent(await homeWith(OLD));

      expect(await archive(client, "unarchive", ...whole.changed)).toEqual({ changed: [PARENT, CHILD], skipped: [] });
      expect(await listed(client, "?archived=only")).toEqual([]);

      await archive(client, "archive", PARENT);
      const off = await client.post("/api/sessions/unarchive", { ids: [PARENT], exact: false });
      expect(await client.json<ArchiveResponse>(off)).toEqual({ changed: [PARENT, CHILD], skipped: [] });
    });

    it("takes exact as a boolean only: anything else fails the whole request and changes nothing", async () => {
      const service = await boot(await homeWith(OLD));
      const client = api(service);
      await archive(client, "archive", A);

      for (const exact of ["true", 1, null, {}, []]) {
        const response = await client.post("/api/sessions/unarchive", { ids: [A], exact });
        expect(response.status, JSON.stringify(exact)).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
      }
      expect(idsOf(await listed(client, "?archived=only"))).toEqual([A]);
    });
  });

  it("refuses what is still working and says why, id by id", async () => {
    const service = await boot(await homeWith(OLD));
    const client = api(service);
    const { body: held } = await delegate(client, "Wait for guidance [fixture:hold]");
    await until(() => service.hub.state(held.sessionId)?.status === "running");

    const result = await archive(client, "archive", held.sessionId, "ses_missing", A);

    expect(result).toEqual({
      changed: [A],
      skipped: [{ id: held.sessionId, reason: "active" }, { id: "ses_missing", reason: "not_found" }],
    });
    expect(service.hub.summary(held.sessionId)?.archivedAt).toBeUndefined();
    expect(idsOf(await listed(client))).toContain(held.sessionId);
    await client.post(`/api/sessions/${held.sessionId}/stop`);
  });

  it("does not archive a session that is only on standby, however old", async () => {
    const service = await boot(await homeWith(OLD));
    const client = api(service);

    expect(await archive(client, "archive", C)).toEqual({ changed: [], skipped: [{ id: C, reason: "active" }] });
    expect(service.hub.summary(C)).toMatchObject({ phase: "ready" });
    expect(service.hub.summary(C)?.archivedAt).toBeUndefined();
  });

  it("pushes the changed summary to an open page when a session is archived and unarchived", async () => {
    const service = await boot(await homeWith(OLD));
    const client = api(service);
    const stream = await openStream(service);
    try {
      await until(() => stream.frames.some((frame) => frame.type === "snapshot"));
      const flags = (): boolean[] =>
        stream.frames.flatMap((frame) => (frame.type === "summary" && frame.summary.id === A ? [frame.summary.archivedAt !== undefined] : []));

      await archive(client, "archive", A);
      await until(() => flags().includes(true), 6000, "the archived summary");
      await archive(client, "unarchive", A);
      await until(() => flags().lastIndexOf(false) > flags().indexOf(true), 6000, "the summary after unarchiving");
    } finally {
      stream.close();
    }
  });

  it("rejects a malformed request as a whole, accepts a full batch, and changes nothing by mistake", async () => {
    const service = await boot(await homeWith(OLD));
    const client = api(service);
    const bad: unknown[] = [
      {},
      { ids: [] },
      { ids: A },
      { ids: [""] },
      { ids: [1] },
      { ids: [A, 7] },
      { ids: Array.from({ length: LIMITS.maxArchiveIds + 1 }, (_, index) => `ses_${index}`) },
    ];
    for (const body of bad) {
      for (const action of ["archive", "unarchive"]) {
        const response = await client.post(`/api/sessions/${action}`, body);
        expect(response.status, `${action} ${JSON.stringify(body).slice(0, 60)}`).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
      }
    }
    expect(service.hub.counts().archived).toBe(0);

    // 恰好到上限的一批（都不存在）被接受，每个 id 都如实回答“不存在”。
    const ids = Array.from({ length: LIMITS.maxArchiveIds }, (_, index) => `ses_none_${index}`);
    const accepted = await archive(client, "archive", ...ids);
    expect(accepted.changed).toEqual([]);
    expect(accepted.skipped).toHaveLength(LIMITS.maxArchiveIds);
    expect(accepted.skipped.every((skip) => skip.reason === "not_found")).toBe(true);
  });

  it("refuses an unknown value of the archived filter instead of treating it as the default", async () => {
    const service = await boot(await homeWith(OLD));
    const client = api(service);

    for (const value of ["yes", "ONLY", "", "all", "true"]) {
      const response = await client.get(`/api/sessions?archived=${encodeURIComponent(value)}`);
      expect(response.status, JSON.stringify(value)).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request", message: expect.stringContaining("archived") } });
    }
  });

  it("needs the token for every one of these routes and refuses foreign origins on the writes, changing nothing", async () => {
    const service = await boot(await homeWith(OLD));
    const client = api(service);
    const headers = { "content-type": "application/json" };
    const archiveBody = JSON.stringify({ ids: [A] });
    const retentionBody = JSON.stringify({ keepDays: 30, keepCount: null });

    const anonymous = await fetch(`${service.url}/api/sessions/archive`, { method: "POST", headers, body: archiveBody });
    expect(anonymous.status).toBe(403);
    expect(await anonymous.json()).toMatchObject({ error: { code: "invalid_token" } });
    expect((await fetch(`${service.url}/api/sessions/unarchive`, { method: "POST", headers, body: archiveBody })).status).toBe(403);
    expect((await fetch(`${service.url}/api/retention`, { method: "PUT", headers, body: retentionBody })).status).toBe(403);
    expect((await fetch(`${service.url}/api/retention`)).status).toBe(403);

    const foreign = { origin: "https://evil.example.com" };
    for (const response of [
      await client.post("/api/sessions/archive", { ids: [A] }, foreign),
      await client.post("/api/sessions/unarchive", { ids: [A] }, foreign),
      await client.put("/api/retention", { keepDays: 30, keepCount: null }, foreign),
    ]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "forbidden" } });
    }

    expect(service.hub.counts().archived).toBe(0);
    expect((await client.json<RetentionResponse>(await client.get("/api/retention"))).retention).toEqual({ keepDays: null, keepCount: null });
  });
});

describe("a session that is used again comes back from the archive", () => {
  it("when it gets a message", async () => {
    const home = await emptyHome();
    const service = await boot(home);
    const client = api(service);
    const { body } = await delegate(client, "[fixture:quick] Archive me, then ask for more");
    await until(() => service.hub.summary(body.sessionId)?.phase === "done");
    expect((await archive(client, "archive", body.sessionId)).changed).toEqual([body.sessionId]);
    expect(await listed(client)).toEqual([]);

    const sent = await client.post(`/api/sessions/${body.sessionId}/messages`, { text: "[fixture:quick] One more thing" });

    expect(sent.status).toBe(200);
    expect(service.hub.summary(body.sessionId)?.archivedAt).toBeUndefined();
    expect(idsOf(await listed(client))).toEqual([body.sessionId]);
    expect(existsSync(join(pathsFor(home).sessions, body.sessionId, "archive.json"))).toBe(false);
  });

  it("but not when the message was refused, and refusing it writes nothing", async () => {
    const home = await homeWith(OLD);
    const before = await readFile(logOf(home, B));
    const service = await boot(home);
    const client = api(service);
    await archive(client, "archive", B);

    // 这个执行端没法恢复一个已经断开的会话：消息被拒绝，会话也就没有“被用到”，仍留在归档里。
    const refused = await client.post(`/api/sessions/${B}/messages`, { text: "Are you still there?" });

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "session_not_resumable" } });
    expect(service.hub.summary(B)?.archivedAt).toBeDefined();
    expect(idsOf(await listed(client, "?archived=only"))).toEqual([B]);
    await service.hub.flush();
    expect(await readFile(logOf(home, B))).toEqual(before);
  });

  it("when a new delegation follows it", async () => {
    const service = await boot(await homeWith(OLD));
    const client = api(service);
    await archive(client, "archive", PARENT);
    expect(idsOf(await listed(client, "?archived=only"))).toEqual([CHILD, PARENT]);

    const { response, body } = await delegate(client, "[fixture:quick] Pick up where the old work stopped", { parentSessionId: PARENT });

    expect(response.status).toBe(201);
    // 上级连同它的整棵子树一起取消归档。
    expect(await listed(client, "?archived=only")).toEqual([]);
    expect(service.hub.summary(body.sessionId)).toMatchObject({ parentSessionId: PARENT });
    expect(service.hub.childIds(PARENT)).toEqual(expect.arrayContaining([CHILD, body.sessionId]));
  });

  it("when another session is moved under it, which only appends to the log of the one that moved", async () => {
    const home = await homeWith(OLD);
    const before = await readFile(logOf(home, RECENT));
    const service = await boot(home);
    const client = api(service);
    await archive(client, "archive", PARENT);

    const moved = await client.post(`/api/sessions/${RECENT}/parent`, { parentSessionId: PARENT });

    expect(moved.status).toBe(200);
    expect(await listed(client, "?archived=only")).toEqual([]);
    await service.hub.flush();
    const after = await readFile(logOf(home, RECENT));
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.subarray(0, before.length)).toEqual(before);
    const detail = await client.json<SessionDetail>(await client.get(`/api/sessions/${RECENT}`));
    expect(detail.summary.parentSessionId).toBe(PARENT);
    expect(detail.events.at(-1)).toMatchObject({ kind: "session.relinked", seq: sessionEvents(OLD[5]!).length + 1 });

    // 日志在快照写好之后又长了一条：重启后读到的是新的关系，而不是快照里的旧状态。
    await service.close("restart");
    const second = await boot(home);
    const again = await api(second).json<SessionDetail>(await api(second).get(`/api/sessions/${RECENT}`));
    expect(again.summary.parentSessionId).toBe(PARENT);
    expect(again.events).toHaveLength(detail.events.length);
  });
});

describe("the retention policy over HTTP", () => {
  it("saves the policy, archives what it selects right away, and keeps both after a restart", async () => {
    const home = await homeWith(OLD);
    const before = await readFile(logOf(home, A));
    const first = await boot(home);
    const client = api(first);

    const initial = await client.json<RetentionResponse>(await client.get("/api/retention"));
    expect(initial.retention).toEqual({ keepDays: null, keepCount: null });

    const saved = await client.put("/api/retention", { keepDays: 30, keepCount: null });
    expect(saved.status).toBe(200);
    const body = await client.json<RetentionResponse>(saved);
    expect(body.retention).toEqual({ keepDays: 30, keepCount: null });
    // A、B 各一个，PARENT 这棵树两个（最后活动是 31 天前）；待命的 C 不算已结束，RECENT 只有 2 天。
    expect(body.lastSweep).toMatchObject({ archived: 4 });

    const archived = await listed(client, "?archived=only");
    expect(idsOf(archived)).toEqual([A, B, CHILD, PARENT]);
    expect(archived.every((session) => session.archivedBy === "retention")).toBe(true);
    expect(idsOf(await listed(client))).toEqual([C, RECENT]);
    expect(JSON.parse(await readFile(pathsFor(home).settings, "utf8"))).toMatchObject({ retention: { keepDays: 30, keepCount: null } });

    const again = await client.json<RetentionResponse>(await client.put("/api/retention", { keepDays: 30, keepCount: null }));
    expect(again.lastSweep).toMatchObject({ archived: 0 });

    await first.close("restart");
    const second = await boot(home);
    const state = await api(second).json<StateSnapshot>(await api(second).get("/api/state"));
    expect(state.archivedCount).toBe(4);
    expect(state.retention).toEqual({ keepDays: 30, keepCount: null });
    expect(idsOf(state.sessions)).toEqual([C, RECENT]);
    expect(await second.retention.sweep()).toMatchObject({ archived: 0 });
    // 清扫只加标记，会话的记录一个字节都没动。
    expect(await readFile(logOf(home, A))).toEqual(before);
  });

  it("counts roots in keepCount, lets a standby session keep its place, and turning the policy off unarchives nothing", async () => {
    const home = await homeWith(OLD);
    const service = await boot(home);
    const client = api(service);

    // 按最后活动由近到远：RECENT、PARENT 这棵树、C、B、A。保留 2 棵：C 排第三但不是已结束的，不归档；B、A 归档。
    const saved = await client.json<RetentionResponse>(await client.put("/api/retention", { keepDays: null, keepCount: 2 }));
    expect(saved.lastSweep).toMatchObject({ archived: 2 });
    expect(idsOf(await listed(client, "?archived=only"))).toEqual([A, B]);
    expect(idsOf(await listed(client))).toEqual([C, CHILD, PARENT, RECENT]);

    const off = await client.json<RetentionResponse>(await client.put("/api/retention", { keepDays: null, keepCount: null }));
    expect(off.retention).toEqual({ keepDays: null, keepCount: null });
    expect(off.lastSweep).toMatchObject({ archived: 0 });
    expect(idsOf(await listed(client, "?archived=only"))).toEqual([A, B]);
    expect(JSON.parse(await readFile(pathsFor(home).settings, "utf8"))).not.toHaveProperty("retention");
  });

  it("explains which value is wrong and leaves the policy as it was", async () => {
    const service = await boot(await homeWith(OLD));
    const client = api(service);
    const bad: unknown[] = [
      { keepDays: 0, keepCount: null },
      { keepDays: -3, keepCount: null },
      { keepDays: 1.5, keepCount: null },
      { keepDays: "30", keepCount: null },
      { keepDays: LIMITS.retention.maxKeepDays + 1, keepCount: null },
      { keepDays: null, keepCount: LIMITS.retention.maxKeepCount + 1 },
      // 省略不等于不限：两个键都必须出现。
      { keepDays: 30 },
      { keepCount: 5 },
      {},
    ];
    for (const body of bad) {
      const response = await client.put("/api/retention", body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
    expect((await client.json<RetentionResponse>(await client.get("/api/retention"))).retention).toEqual({ keepDays: null, keepCount: null });
    expect(service.hub.counts().archived).toBe(0);

    const worded = await client.put("/api/retention", { keepDays: 0, keepCount: null });
    expect(await worded.json()).toMatchObject({ error: { message: expect.stringContaining("keepDays") } });
  });

  it("does nothing while the policy is off, however old the sessions are", async () => {
    const service = await boot(await homeWith(OLD));

    expect(await service.retention.sweep()).toMatchObject({ archived: 0 });
    expect(service.hub.counts().archived).toBe(0);
  });
});
