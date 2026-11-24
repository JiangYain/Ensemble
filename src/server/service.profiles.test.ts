import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SERVICE_FEATURES, TOKEN_HEADER } from "@shared/constants";
import type { DelegateResponse, HarnessesResponse, ProfilesResponse, StateSnapshot, StreamMessage } from "@shared/protocol";
import type { HarnessInfo, ModelInfo } from "@shared/types";
import { silentLogger } from "./logger";
import { startService, type RunningService } from "./service";
import { ManualExecutor, until } from "./testing";

/**
 * 委派角色在服务这一层：HTTP 入口（新增 / 改写 / 改名 / 删除 / 校验 / 防护）、
 * 推给所有页面的 `profiles` 消息、`GET /api/harnesses` 带着的此刻评估，以及 `POST /api/sessions` 带 `profile` 的整条路径。
 * 存储、纯规则、解析各自的单元测试在旁边的文件里（settings.profiles / shared/profiles / profiles）。
 * 全部用临时状态目录，从不碰真实的 settings.json。
 */

const running: RunningService[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()!.close("test");
});

const models: ModelInfo[] = [
  { id: "m-fast", label: "Fast", isDefault: true, efforts: ["low", "high"], defaultEffort: "low" },
  { id: "m-big", label: "Big", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
];

async function boot(options: { home?: string; codex?: Partial<HarnessInfo> } = {}): Promise<{ service: RunningService; home: string }> {
  const home = options.home ?? mkdtempSync(join(tmpdir(), "ensemble-home-"));
  const service = await startService({
    home,
    port: 0,
    executors: [new ManualExecutor("codex", { models, ...options.codex }), new ManualExecutor("pi", { models })],
    log: silentLogger,
    webRoot: null,
    idleExitMs: 0,
    // 显式传入：不读测试进程自己的环境变量。
    env: {},
  });
  running.push(service);
  return { service, home };
}

function api(service: RunningService) {
  const headers = { [TOKEN_HEADER]: service.token, "content-type": "application/json" };
  const call = (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    fetch(`${service.url}${path}`, { method, headers: { ...headers, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return {
    get: (path: string) => call("GET", path),
    put: (path: string, body: unknown, extra?: Record<string, string>) => call("PUT", path, body, extra),
    post: (path: string, body: unknown, extra?: Record<string, string>) => call("POST", path, body, extra),
    del: (path: string, extra?: Record<string, string>) => call("DELETE", path, undefined, extra),
    json: async <T>(response: Response) => (await response.json()) as T,
  };
}

const settingsOf = (home: string): unknown => JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));

/** 浏览器里别的网页发来的写请求会带这样的 Origin；MCP 桥与脚本不带。 */
const FOREIGN = { origin: "https://evil.example.com" };

/** 极简 SSE 客户端：读取并解析帧里的消息。 */
async function openStream(service: RunningService) {
  const controller = new AbortController();
  const response = await fetch(`${service.url}/api/stream?token=${service.token}`, { signal: controller.signal });
  const messages: StreamMessage[] = [];
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
          if (data) messages.push(JSON.parse(data.slice(6)) as StreamMessage);
        }
      }
    } catch {
      // 连接被主动中止。
    }
  })();
  return { messages, close: () => controller.abort() };
}

type ProfilesMessage = Extract<StreamMessage, { type: "profiles" }>;
const profilesMessages = (stream: { messages: StreamMessage[] }): ProfilesMessage[] =>
  stream.messages.filter((message): message is ProfilesMessage => message.type === "profiles");

const VERIFY = { harness: "codex", model: "m-big", effort: "high", access: "read_only" };

describe("角色的 HTTP 入口", () => {
  it("health 公布 delegation-profiles：桥据此决定能不能带 profile，老服务没有这一项", async () => {
    const { service } = await boot();
    const health = await fetch(`${service.url}/api/health`);
    const body = (await health.json()) as { features?: string[] };
    expect(SERVICE_FEATURES).toContain("delegation-profiles");
    expect(body.features).toContain("delegation-profiles");
  });

  it("没有角色时快照里是空表；新增后回执是生效后的整张表，落盘成文件顶层的 profiles，快照里也有", async () => {
    const { service, home } = await boot();
    const client = api(service);
    expect((await client.json<StateSnapshot>(await client.get("/api/state"))).profiles).toEqual({ entries: [] });

    const put = await client.put("/api/profiles/verify", { ...VERIFY, create: true });
    expect(put.status).toBe(200);
    const expected = { entries: [{ name: "verify", ...VERIFY }] };
    expect((await client.json<ProfilesResponse>(put)).profiles).toEqual(expected);
    expect(settingsOf(home)).toEqual({ version: 1, harnesses: {}, profiles: { verify: VERIFY } });
    expect((await client.json<StateSnapshot>(await client.get("/api/state"))).profiles).toEqual(expected);
  });

  it("名字在路径里按小写存；省略的字段就是不固定；整条改写时没给的字段被去掉", async () => {
    const { service, home } = await boot();
    const client = api(service);
    await client.put("/api/profiles/Scout", { harness: "pi" });
    expect(settingsOf(home)).toMatchObject({ profiles: { scout: { harness: "pi" } } });

    await client.put("/api/profiles/scout", { harness: "pi", model: "m-fast", effort: "low" });
    await client.put("/api/profiles/scout", { harness: "pi", model: "m-fast" });
    expect(settingsOf(home)).toMatchObject({ profiles: { scout: { harness: "pi", model: "m-fast" } } });
    expect(JSON.stringify(settingsOf(home))).not.toContain("effort");
  });

  it("改名保持位置；删除幂等；删最后一个后文件里不再有 profiles", async () => {
    const { service, home } = await boot();
    const client = api(service);
    for (const name of ["a", "b", "c"]) await client.put(`/api/profiles/${name}`, { harness: "pi" });

    const renamed = await client.post("/api/profiles/b/rename", { to: "Bee" });
    expect(renamed.status).toBe(200);
    expect((await client.json<ProfilesResponse>(renamed)).profiles.entries.map((entry) => entry.name)).toEqual(["a", "bee", "c"]);

    for (const name of ["a", "bee", "c", "c"]) {
      const response = await client.del(`/api/profiles/${name}`);
      expect(response.status).toBe(200);
    }
    expect(settingsOf(home)).toEqual({ version: 1, harnesses: {} });
    expect((await client.json<ProfilesResponse>(await client.del("/api/profiles/ghost"))).profiles).toEqual({ entries: [] });
  });

  it("写角色不会碰执行端的模型设置，反过来也一样（同一个文件、同一条写盘队列）", async () => {
    const { service, home } = await boot();
    const client = api(service);
    await client.put("/api/profiles/verify", VERIFY);
    await client.put("/api/harnesses/codex/models", { allowed: ["m-big"] });
    await client.put("/api/profiles/scout", { harness: "pi" });
    await client.put("/api/harnesses/codex/models", { allowed: null });
    expect(settingsOf(home)).toEqual({ version: 1, harnesses: {}, profiles: { verify: VERIFY, scout: { harness: "pi" } } });
  });

  it("校验失败有稳定的错误码：名字、字段形状、create 撞名、执行端没有启用、改名的各种冲突", async () => {
    const { service } = await boot();
    const client = api(service);
    const code = async (response: Response): Promise<{ status: number; code: string }> => ({
      status: response.status,
      code: (await client.json<{ error: { code: string } }>(response)).error.code,
    });

    expect(await code(await client.put("/api/profiles/Bad%20Name", { harness: "pi" }))).toEqual({ status: 400, code: "invalid_request" });
    expect(await code(await client.put("/api/profiles/2024", { harness: "pi" }))).toEqual({ status: 400, code: "invalid_request" });
    expect(await code(await client.put("/api/profiles/ok", { harness: "pi", access: "admin" }))).toEqual({ status: 400, code: "invalid_request" });
    expect(await code(await client.put("/api/profiles/ok", {}))).toEqual({ status: 400, code: "invalid_request" });
    expect(await code(await client.put("/api/profiles/ok", { harness: "pi", model: "" }))).toEqual({ status: 400, code: "invalid_request" });
    // 只拦手误：拼错的、或这台服务没有启用的执行端。
    expect(await code(await client.put("/api/profiles/ok", { harness: "claude" }))).toEqual({ status: 404, code: "not_found" });
    expect(await code(await client.put("/api/profiles/ok", { harness: "nope" }))).toEqual({ status: 404, code: "not_found" });

    await client.put("/api/profiles/taken", { harness: "pi" });
    expect(await code(await client.put("/api/profiles/taken", { harness: "codex", create: true }))).toEqual({ status: 400, code: "invalid_request" });
    // 改成同一个名字（含大小写不同）不是错误，什么也不变。
    expect((await client.post("/api/profiles/taken/rename", { to: "TAKEN" })).status).toBe(200);
    await client.put("/api/profiles/other", { harness: "pi" });
    expect(await code(await client.post("/api/profiles/other/rename", { to: "taken" }))).toEqual({ status: 400, code: "invalid_request" });
    // 要改名的角色不存在：资源不在，404（其余的改名冲突与形状问题仍是 400）。
    expect(await code(await client.post("/api/profiles/ghost/rename", { to: "x" }))).toEqual({ status: 404, code: "not_found" });
    expect(await code(await client.post("/api/profiles/other/rename", { to: "not ok" }))).toEqual({ status: 400, code: "invalid_request" });
    expect(await code(await client.post("/api/profiles/other/rename", {}))).toEqual({ status: 400, code: "invalid_request" });
  });

  it("写入口与其他写入口一样要过令牌与 Origin 检查：别的网页不能借浏览器替用户改", async () => {
    const { service, home } = await boot();
    const client = api(service);
    await client.put("/api/profiles/verify", VERIFY);
    const before = settingsOf(home);

    for (const response of [
      await client.put("/api/profiles/x", { harness: "pi" }, FOREIGN),
      await client.del("/api/profiles/verify", FOREIGN),
      await client.post("/api/profiles/verify/rename", { to: "y" }, FOREIGN),
    ]) {
      expect(response.status).toBe(403);
    }
    const anonymous = await fetch(`${service.url}/api/profiles/x`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ harness: "pi" }) });
    expect(anonymous.status).toBe(403);
    expect(settingsOf(home)).toEqual(before);
  });

  it("GET /api/harnesses 带着每个角色此刻的评估：能用的写明会落成什么，不能用的写明原因", async () => {
    const { service } = await boot();
    const client = api(service);
    await client.put("/api/profiles/verify", VERIFY);
    await client.put("/api/profiles/scout", { harness: "pi" });
    await client.put("/api/harnesses/pi/models", { allowed: ["m-fast"] });
    await client.put("/api/profiles/stale", { harness: "pi", model: "m-big" });

    const { harnesses, profiles } = await client.json<HarnessesResponse>(await client.get("/api/harnesses"));
    expect(harnesses.map((info) => info.id).sort()).toEqual(["codex", "pi"]);
    expect(profiles?.entries.map((entry) => [entry.name, entry.check.usable])).toEqual([
      ["verify", true],
      ["scout", true],
      ["stale", false],
    ]);
    expect(profiles?.entries[0]?.check).toEqual({
      usable: true,
      effective: { harness: "codex", access: "read_only", enforcement: "enforced", model: "m-big", effort: "high" },
    });
    // 不固定的字段写明此刻实际会用哪个：执行端自己的默认模型与它的默认档位，访问权限是 Full Access。
    expect(profiles?.entries[1]?.check).toMatchObject({ usable: true, effective: { harness: "pi", access: "full", model: "m-fast", effort: "low" } });
    expect(profiles?.entries[2]?.check).toEqual({ usable: false, issue: { reason: "model_not_open", harness: "pi", model: "m-big", allowed: ["m-fast"] } });
  });

  it("改动经 SSE 推给所有页面（整张表）：首帧快照里就有，新增、改名、删除各推一条", async () => {
    const { service } = await boot();
    const client = api(service);
    await client.put("/api/profiles/first", { harness: "pi" });
    const stream = await openStream(service);
    try {
      await until(() => stream.messages.some((message) => message.type === "snapshot"));
      const snapshot = stream.messages.find((message): message is Extract<StreamMessage, { type: "snapshot" }> => message.type === "snapshot")!;
      expect(snapshot.snapshot.profiles).toEqual({ entries: [{ name: "first", harness: "pi" }] });

      await client.put("/api/profiles/second", { harness: "codex" });
      await until(() => profilesMessages(stream).length === 1);
      expect(profilesMessages(stream)[0]!.profiles.entries.map((entry) => entry.name)).toEqual(["first", "second"]);

      await client.post("/api/profiles/first/rename", { to: "primary" });
      await until(() => profilesMessages(stream).length === 2);
      expect(profilesMessages(stream)[1]!.profiles.entries.map((entry) => entry.name)).toEqual(["primary", "second"]);

      await client.del("/api/profiles/second");
      await until(() => profilesMessages(stream).length === 3);
      expect(profilesMessages(stream)[2]!.profiles.entries.map((entry) => entry.name)).toEqual(["primary"]);

      // 没有变化的写入不推（也不写盘）。
      await client.put("/api/profiles/primary", { harness: "pi" });
      await client.del("/api/profiles/ghost");
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(profilesMessages(stream)).toHaveLength(3);
    } finally {
      stream.close();
    }
  });

  it("重启之后角色还在（落盘的就是服务读回来的）", async () => {
    const first = await boot();
    await api(first.service).put("/api/profiles/verify", VERIFY);
    await first.service.close("restart");
    running.splice(running.indexOf(first.service), 1);

    const second = await boot({ home: first.home });
    const state = await api(second.service).json<StateSnapshot>(await api(second.service).get("/api/state"));
    expect(state.profiles).toEqual({ entries: [{ name: "verify", ...VERIFY }] });
  });
});

describe("带 profile 的委派（POST /api/sessions）", () => {
  const delegate = (client: ReturnType<typeof api>, body: Record<string, unknown>) => client.post("/api/sessions", { task: "Review the diff", cwd: tmpdir(), ...body });
  const sessionCount = async (client: ReturnType<typeof api>): Promise<number> => (await client.json<{ sessions: unknown[] }>(await client.get("/api/sessions"))).sessions.length;

  async function withRoles() {
    const booted = await boot();
    const client = api(booted.service);
    await client.put("/api/profiles/verify", VERIFY);
    await client.put("/api/profiles/scout", { harness: "pi" });
    return { ...booted, client };
  }

  it("会话用的是角色的取值，回执写明每一项的来由；会话记录里不留“用过哪个角色”", async () => {
    const { client } = await withRoles();
    const response = await delegate(client, { profile: "verify" });
    expect(response.status).toBe(201);
    const body = await client.json<DelegateResponse>(response);
    expect(body.profile).toEqual({ name: "verify", sources: { harness: "profile", model: "profile", effort: "profile", access: "profile" } });
    expect(body.summary).toMatchObject({ harness: "codex", model: { requested: "m-big" }, effort: "high", access: "read_only" });
    expect(body.summary).not.toHaveProperty("profile");
  });

  it("名字对大小写宽容；角色只固定了执行端时，其余照现有的默认规则（执行端默认模型，Full Access）", async () => {
    const { client } = await withRoles();
    const body = await client.json<DelegateResponse>(await delegate(client, { profile: "SCOUT" }));
    expect(body.profile).toEqual({ name: "scout", sources: { harness: "profile", model: "default", effort: "default", access: "default" } });
    expect(body.summary).toMatchObject({ harness: "pi", access: "full" });
  });

  it("显式参数按字段覆盖，回执记下被跳过的角色取值", async () => {
    const { client } = await withRoles();
    const body = await client.json<DelegateResponse>(await delegate(client, { profile: "verify", effort: "low", access: "full" }));
    expect(body.summary).toMatchObject({ harness: "codex", model: { requested: "m-big" }, effort: "low", access: "full" });
    expect(body.profile?.skipped).toEqual([
      { field: "effort", value: "high", why: "overridden" },
      { field: "access", value: "read_only", why: "overridden" },
    ]);
  });

  it("显式换了执行端：角色的模型与强度不会套到另一个执行端上", async () => {
    const { client } = await withRoles();
    const body = await client.json<DelegateResponse>(await delegate(client, { profile: "verify", harness: "pi" }));
    expect(body.summary.harness).toBe("pi");
    expect(body.summary.model).toBeUndefined();
    expect(body.summary.access).toBe("read_only");
    expect(body.profile?.skipped).toEqual([
      { field: "harness", value: "codex", why: "overridden" },
      { field: "model", value: "m-big", why: "other_harness" },
      { field: "effort", value: "high", why: "other_harness" },
    ]);
  });

  it("不带 profile 的委派照旧：只有 harness 也行，没有回执", async () => {
    const { client } = await withRoles();
    const body = await client.json<DelegateResponse>(await delegate(client, { harness: "pi", model: "m-big" }));
    expect(body.profile).toBeUndefined();
    expect(body.summary).toMatchObject({ harness: "pi", model: { requested: "m-big" } });
  });

  it("harness 与 profile 都没有：400，错误里说明两条出路", async () => {
    const { client } = await withRoles();
    const response = await delegate(client, {});
    expect(response.status).toBe(400);
    const { error } = await client.json<{ error: { code: string; message: string } }>(response);
    expect(error.code).toBe("invalid_request");
    expect(error.message).toContain('"harness"');
    expect(error.message).toContain('"profile"');
    expect(await sessionCount(client)).toBe(0);
  });

  it("角色不存在：422 profile_not_found，列出现有的；没有任何会话被创建（绝不悄悄退回默认）", async () => {
    const { client } = await withRoles();
    const response = await delegate(client, { profile: "reviewer", harness: "pi" });
    expect(response.status).toBe(422);
    const { error } = await client.json<{ error: { code: string; message: string } }>(response);
    expect(error.code).toBe("profile_not_found");
    expect(error.message).toContain("verify, scout");
    expect(await sessionCount(client)).toBe(0);
  });

  it("角色此刻用不了：422 profile_unusable，点名角色与原因；用户开放范围的改动立即生效，改回来就能用", async () => {
    const { client } = await withRoles();
    await client.put("/api/profiles/reviewer", { harness: "pi", model: "m-big" });
    await client.put("/api/harnesses/pi/models", { allowed: ["m-fast"] });

    const response = await delegate(client, { profile: "reviewer" });
    expect(response.status).toBe(422);
    const { error } = await client.json<{ error: { code: string; message: string } }>(response);
    expect(error.code).toBe("profile_unusable");
    expect(error.message).toContain('Role "reviewer" cannot be used right now');
    expect(error.message).toContain('model "m-big" is not open for harness "pi"');
    expect(await sessionCount(client)).toBe(0);

    await client.put("/api/harnesses/pi/models", { allowed: null });
    expect((await delegate(client, { profile: "reviewer" })).status).toBe(201);
  });

  it("角色没固定、用户却一个模型都没开放：不是角色的错，由现有的把关给出 model_not_allowed", async () => {
    const { client } = await withRoles();
    await client.put("/api/harnesses/pi/models", { allowed: [] });
    const response = await delegate(client, { profile: "scout" });
    expect(response.status).toBe(422);
    expect((await client.json<{ error: { code: string } }>(response)).error.code).toBe("model_not_allowed");
  });

  it("防重复看的是解析之后的实际取值：同一个角色连发两次是重复；换一个强度不是；等价的显式写法也是", async () => {
    const { client } = await withRoles();
    const first = await delegate(client, { profile: "verify" });
    const second = await delegate(client, { profile: "verify" });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    const firstBody = await client.json<DelegateResponse>(first);
    const secondBody = await client.json<DelegateResponse>(second);
    expect(secondBody.duplicate).toBeDefined();
    expect(secondBody.sessionId).toBe(firstBody.sessionId);
    // 回执说明这次请求是怎么解析的，命中重复时也带着。
    expect(secondBody.profile?.name).toBe("verify");

    expect((await delegate(client, { profile: "verify", effort: "low" })).status).toBe(201);
    const spelledOut = await delegate(client, { harness: "codex", model: "m-big", effort: "high", access: "read_only" });
    expect(spelledOut.status).toBe(200);
    expect((await client.json<DelegateResponse>(spelledOut)).sessionId).toBe(firstBody.sessionId);
  });
});
