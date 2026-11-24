/**
 * 经真实本地 HTTP 配置执行端允许主 Agent 选用的模型：名单与推理强度的保存、校验、实时推送与重启后仍在，以及用户指定的默认模型；
 * 委派入口（网页与桥）一律按这份设置强制。
 * 服务的安全、静态托管与生命周期在 service.test.ts；委派在 service.delegation.test.ts；改挂上级在 service.relink.test.ts。
 */

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StateSnapshot } from "@shared/protocol";
import { testOrigin } from "@shared/testing";
import type { RunningService } from "./service";
import { api, boot, closeServices, openStream, stopService, tempHome, type Api } from "./service.fixtures";
import { delegate } from "./service.http.fixtures";
import { ManualExecutor, until } from "./testing";

afterEach(closeServices);

describe("executor model settings", () => {
  type HarnessBody = { harness: { id: string; models: { id: string }[]; allowedModels?: string[] } };
  type Harnesses = { harnesses: { id: string; allowedModels?: string[] }[] };

  const setModels = (client: Api, harness: string, allowed: string[] | null) => client.put(`/api/harnesses/${harness}/models`, { allowed });
  const allowedIn = async (client: Api, harness: string) =>
    (await client.json<Harnesses>(await client.get("/api/harnesses"))).harnesses.find((h) => h.id === harness)?.allowedModels;

  it("saves the list, answers with the updated harness, and shows it in every view of the harness", async () => {
    const service = await boot();
    const client = api(service);
    await client.get("/api/harnesses");
    const saved = await setModels(client, "pi", ["fixture-deep"]);
    expect(saved.status).toBe(200);
    const body = await client.json<HarnessBody>(saved);
    expect(body.harness).toMatchObject({ id: "pi", allowedModels: ["fixture-deep"] });
    // 目录本身不被改动：配置页要靠它列出全部模型。
    expect(body.harness.models.map((model) => model.id)).toEqual(["fixture-fast", "fixture-deep"]);

    expect(await allowedIn(client, "pi")).toEqual(["fixture-deep"]);
    const state = await client.json<StateSnapshot>(await client.get("/api/state"));
    expect(state.harnesses.find((h) => h.id === "pi")?.allowedModels).toEqual(["fixture-deep"]);
    // 别的执行端不受影响。
    expect(await allowedIn(client, "cursor")).toBeUndefined();
  });

  it("pushes the new list to open pages at once", async () => {
    const service = await boot();
    const client = api(service);
    const stream = await openStream(service);
    await until(() => stream.frames.some((f) => f.message.type === "snapshot"));
    await setModels(client, "pi", ["fixture-fast"]);
    await until(() =>
      stream.frames.some((f) => f.message.type === "harness" && f.message.info.id === "pi" && f.message.info.allowedModels?.join() === "fixture-fast"),
    );
    stream.close();
  });

  it("applies to delegations from the console and from the bridge alike", async () => {
    const service = await boot();
    const client = api(service);
    await setModels(client, "pi", ["fixture-deep"]);

    const refused = await client.post("/api/sessions", { harness: "pi", task: "x", cwd: tmpdir(), model: "fixture-fast" });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ error: { code: "model_not_allowed", details: { allowed: ["fixture-deep"] } } });
    const viaBridge = await client.post(
      "/api/sessions",
      { harness: "pi", task: "x", cwd: tmpdir(), model: "fixture-fast", origin: testOrigin() },
      { "x-ensemble-client": "mcp" },
    );
    expect(viaBridge.status).toBe(422);
    expect(service.hub.allSummaries()).toHaveLength(0);

    const accepted = await delegate(client, "[fixture:quick]", { model: "fixture-deep" });
    expect(accepted.response.status).toBe(201);
    // 没指定模型时，默认的 fixture-fast 没被开放，退到被开放的那个。
    // 任务写得不一样：落在同一个模型上、其余也逐字相同的委派会被当作重复提交（见 service.dedupe.test.ts）。
    const fallback = await delegate(client, "[fixture:quick] fallback");
    expect(fallback.response.status).toBe(201);
    expect(service.hub.state(fallback.body.sessionId)?.meta.model).toMatchObject({ requested: "fixture-deep" });
  });

  it("keeps an explicit list when it matches the current catalog; only null removes it", async () => {
    const pi = new ManualExecutor("pi", { models: [{ id: "alpha", label: "Alpha" }] });
    const service = await boot({ executors: [pi] });
    const client = api(service);
    expect(await allowedIn(client, "pi")).toBeUndefined();

    await setModels(client, "pi", ["alpha"]);
    expect(await allowedIn(client, "pi")).toEqual(["alpha"]);
    pi.info = { ...pi.info, models: [...pi.info.models, { id: "beta", label: "Beta" }] };
    await client.get("/api/harnesses?refresh=1");
    const refused = await delegate(client, "test", { model: "beta" });
    expect(refused.response.status).toBe(422);

    await setModels(client, "pi", null);
    expect(await allowedIn(client, "pi")).toBeUndefined();
    expect((await delegate(client, "test", { model: "beta" })).response.status).toBe(201);
  });

  it("refuses models for an invalid entry and keeps enforcing the other saved lists", async () => {
    const home = tempHome();
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      version: 1,
      harnesses: { cursor: { allowedModels: "broken" }, pi: { allowedModels: ["fixture-deep"] } },
    }));
    const service = await boot({ home });
    const client = api(service);
    const state = await client.json<StateSnapshot>(await client.get("/api/state"));
    expect(state.harnesses.find((h) => h.id === "cursor")?.modelSettingsIssue).toBe("invalid_entry");
    const blocked = await client.post("/api/sessions", { harness: "cursor", task: "x", cwd: tmpdir() });
    expect(blocked.status).toBe(422);
    expect(await blocked.json()).toMatchObject({ error: { code: "model_settings_unavailable" } });
    expect((await delegate(client, "x", { model: "fixture-fast" })).response.status).toBe(422);
    expect((await delegate(client, "[fixture:quick]", { model: "fixture-deep" })).response.status).toBe(201);
  });

  it("allows an empty list: nothing is open, and delegating is refused until something is", async () => {
    const service = await boot();
    const client = api(service);
    const saved = await setModels(client, "pi", []);
    expect((await client.json<HarnessBody>(saved)).harness.allowedModels).toEqual([]);
    const refused = await client.post("/api/sessions", { harness: "pi", task: "x", cwd: tmpdir() });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ error: { code: "model_not_allowed" } });
  });

  describe("reasoning efforts", () => {
    type Entry = { harness: { allowedModels?: string[]; allowedEfforts?: Record<string, string[]> } };
    const save = (client: Api, allowed: string[] | null, efforts?: Record<string, string[]>) =>
      client.put("/api/harnesses/pi/models", { allowed, ...(efforts ? { efforts } : {}) });

    it("saves them with the list, answers with them, and enforces them for console and bridge alike", async () => {
      const service = await boot();
      const client = api(service);
      const saved = await save(client, ["fixture-deep"], { "fixture-deep": ["low", "high"] });
      expect(saved.status).toBe(200);
      expect((await client.json<Entry>(saved)).harness).toMatchObject({ allowedModels: ["fixture-deep"], allowedEfforts: { "fixture-deep": ["low", "high"] } });

      const refused = await delegate(client, "x", { model: "fixture-deep", effort: "medium" });
      expect(refused.response.status).toBe(422);
      expect(refused.body).toMatchObject({ error: { code: "effort_not_allowed", details: { allowed: ["low", "high"] } } });
      const viaBridge = await client.post(
        "/api/sessions",
        { harness: "pi", task: "x", cwd: tmpdir(), model: "fixture-deep", effort: "medium", origin: testOrigin() },
        { "x-ensemble-client": "mcp" },
      );
      expect(viaBridge.status).toBe(422);
      expect(await viaBridge.json()).toMatchObject({ error: { code: "effort_not_allowed", details: { allowed: ["low", "high"] } } });
      expect(service.hub.allSummaries()).toHaveLength(0);

      // 目录里 fixture-deep 的默认档位是 medium，没被允许：不指定时固定成第一个被允许的 low。
      const fallback = await delegate(client, "[fixture:quick]");
      expect(fallback.response.status).toBe(201);
      expect(service.hub.state(fallback.body.sessionId)?.meta).toMatchObject({ model: { requested: "fixture-deep" }, effort: "low" });
      const chosen = await delegate(client, "[fixture:quick]", { model: "fixture-deep", effort: "high" });
      expect(service.hub.state(chosen.body.sessionId)?.meta.effort).toBe("high");
    });

    it("keeps them when an older page saves only the list, and clears them when asked", async () => {
      const service = await boot();
      const client = api(service);
      await save(client, ["fixture-deep", "fixture-fast"], { "fixture-deep": ["high"] });
      const legacy = await client.json<Entry>(await save(client, ["fixture-deep"]));
      expect(legacy.harness).toMatchObject({ allowedModels: ["fixture-deep"], allowedEfforts: { "fixture-deep": ["high"] } });
      const cleared = await client.json<Entry>(await save(client, ["fixture-deep"], {}));
      expect(cleared.harness.allowedEfforts).toBeUndefined();
    });

    it("keeps a model id named __proto__ end to end, and never reads a lone one as an empty record", async () => {
      const home = tempHome();
      const first = await boot({ home });
      const client = api(first);
      // JSON.parse 才会造出自有的 __proto__ 键；对象字面量写它改的是原型。
      const lone = JSON.parse('{"__proto__":["high"]}') as Record<string, string[]>;
      await save(client, ["fixture-deep"], { "fixture-deep": ["low"] });
      const saved = await client.json<Entry>(await save(client, ["fixture-deep"], lone));
      expect(Object.keys(saved.harness.allowedEfforts ?? {})).toEqual(["__proto__"]);
      expect((await save(client, ["fixture-deep"], JSON.parse('{"__proto__":[]}'))).status).toBe(400);
      await stopService(first);

      const second = await boot({ home });
      const state = await api(second).json<StateSnapshot>(await api(second).get("/api/state"));
      expect(Object.keys(state.harnesses.find((h) => h.id === "pi")?.allowedEfforts ?? {})).toEqual(["__proto__"]);
    });

    it("rejects an empty or malformed record without touching the saved one, and survives a restart", async () => {
      const home = tempHome();
      const first = await boot({ home });
      const client = api(first);
      await save(client, ["fixture-deep"], { "fixture-deep": ["low", "medium"] });
      expect((await save(client, ["fixture-deep"], { "fixture-deep": [] })).status).toBe(400);
      expect((await client.put("/api/harnesses/pi/models", { allowed: null, efforts: { "fixture-deep": "low" } })).status).toBe(400);
      expect((await client.put("/api/harnesses/pi/models", { allowed: null, efforts: { "fixture-deep": [" low"] } })).status).toBe(400);
      await stopService(first);

      const second = await boot({ home });
      const state = await api(second).json<StateSnapshot>(await api(second).get("/api/state"));
      expect(state.harnesses.find((h) => h.id === "pi")).toMatchObject({ allowedModels: ["fixture-deep"], allowedEfforts: { "fixture-deep": ["low", "medium"] } });
      expect((await delegate(api(second), "x", { model: "fixture-deep", effort: "high" })).response.status).toBe(422);
    });
  });

  describe("default model", () => {
    type Entry = { harness: { allowedModels?: string[]; userDefaultModel?: string; defaultModel?: string } };
    const save = (client: Api, allowed: string[] | null, userDefaultModel?: string | null) =>
      client.put("/api/harnesses/pi/models", { allowed, ...(userDefaultModel === undefined ? {} : { userDefaultModel }) });
    const requested = (service: RunningService, sessionId: string) => service.hub.state(sessionId)?.meta.model?.requested;

    it("a delegation that names no model gets the one the user chose — for console and bridge alike — while the harness's own default stays reported", async () => {
      const service = await boot();
      const client = api(service);
      const saved = await save(client, null, "fixture-deep");
      expect(saved.status).toBe(200);
      const { harness } = await client.json<Entry>(saved);
      expect(harness).toMatchObject({ userDefaultModel: "fixture-deep", defaultModel: "fixture-fast" });

      const viaConsole = await delegate(client, "[fixture:quick] console");
      expect(requested(service, viaConsole.body.sessionId)).toBe("fixture-deep");
      const viaBridge = await client.post("/api/sessions", { harness: "pi", task: "[fixture:quick] bridge", cwd: tmpdir(), origin: testOrigin() }, { "x-ensemble-client": "mcp" });
      expect(requested(service, (await client.json<{ sessionId: string }>(viaBridge)).sessionId)).toBe("fixture-deep");
      // 明确写了模型：照请求走，用户的默认不改写它。
      const named = await delegate(client, "[fixture:quick] named", { model: "fixture-fast" });
      expect(requested(service, named.body.sessionId)).toBe("fixture-fast");
    });

    it("shows in every view of the harness and is pushed to open pages at once", async () => {
      const service = await boot();
      const client = api(service);
      const stream = await openStream(service);
      await until(() => stream.frames.some((f) => f.message.type === "snapshot"));
      await save(client, null, "fixture-deep");
      await until(() => stream.frames.some((f) => f.message.type === "harness" && f.message.info.id === "pi" && f.message.info.userDefaultModel === "fixture-deep"));
      stream.close();
      const list = await client.json<{ harnesses: { id: string; userDefaultModel?: string }[] }>(await client.get("/api/harnesses"));
      expect(list.harnesses.find((h) => h.id === "pi")?.userDefaultModel).toBe("fixture-deep");
      const state = await client.json<StateSnapshot>(await client.get("/api/state"));
      expect(state.harnesses.find((h) => h.id === "pi")?.userDefaultModel).toBe("fixture-deep");
      expect(state.harnesses.find((h) => h.id === "cursor")?.userDefaultModel).toBeUndefined();
    });

    it("refuses a default the main Agent could not pick, and keeps what was saved", async () => {
      const service = await boot();
      const client = api(service);
      await save(client, ["fixture-fast", "fixture-deep"], "fixture-deep");

      const outside = await save(client, ["fixture-fast"], "fixture-deep");
      expect(outside.status).toBe(422);
      expect(await outside.json()).toMatchObject({ error: { code: "model_not_allowed" } });
      const unknown = await save(client, null, "no-such-model");
      expect(unknown.status).toBe(422);
      expect(await unknown.json()).toMatchObject({ error: { code: "model_not_allowed", details: { harness: "pi", requested: "no-such-model" } } });
      expect((await save(client, ["fixture-fast"], "")).status).toBe(400);

      const state = await client.json<StateSnapshot>(await client.get("/api/state"));
      expect(state.harnesses.find((h) => h.id === "pi")).toMatchObject({ allowedModels: ["fixture-fast", "fixture-deep"], userDefaultModel: "fixture-deep" });
    });

    it("drops the default when the new list leaves it out, keeps it when everything is opened up again, and clears on null", async () => {
      const service = await boot();
      const client = api(service);
      await save(client, ["fixture-fast", "fixture-deep"], "fixture-deep");

      // 旧版页面只发名单：名单没了它，同一次保存里一并清掉；委派回到执行端自己的默认。
      const narrowed = await client.json<Entry>(await save(client, ["fixture-fast"]));
      expect(narrowed.harness.userDefaultModel).toBeUndefined();
      expect(requested(service, (await delegate(client, "[fixture:quick] narrowed")).body.sessionId)).toBe("fixture-fast");

      await save(client, ["fixture-fast", "fixture-deep"], "fixture-deep");
      const opened = await client.json<Entry>(await save(client, null));
      expect(opened.harness).toMatchObject({ userDefaultModel: "fixture-deep" });
      const emptied = await client.json<Entry>(await save(client, []));
      expect(emptied.harness.userDefaultModel).toBeUndefined();

      await save(client, null, "fixture-deep");
      const restored = await client.json<Entry>(await save(client, null, null));
      expect(restored.harness.userDefaultModel).toBeUndefined();
      expect(requested(service, (await delegate(client, "[fixture:quick] restored")).body.sessionId)).toBeUndefined();
    });

    it("is still there after a restart, and an old file without the field behaves exactly as before", async () => {
      const home = tempHome();
      const first = await boot({ home });
      await save(api(first), ["fixture-fast", "fixture-deep"], "fixture-deep");
      await stopService(first);

      const second = await boot({ home });
      const state = await api(second).json<StateSnapshot>(await api(second).get("/api/state"));
      expect(state.harnesses.find((h) => h.id === "pi")).toMatchObject({ userDefaultModel: "fixture-deep" });
      expect(requested(second, (await delegate(api(second), "[fixture:quick] again")).body.sessionId)).toBe("fixture-deep");

      const legacyHome = tempHome();
      writeFileSync(join(legacyHome, "settings.json"), JSON.stringify({ version: 1, harnesses: { pi: { allowedModels: ["fixture-deep", "fixture-fast"], futureOption: 1 } } }));
      const legacy = await boot({ home: legacyHome });
      const entry = (await api(legacy).json<StateSnapshot>(await api(legacy).get("/api/state"))).harnesses.find((h) => h.id === "pi");
      expect(entry?.userDefaultModel).toBeUndefined();
      expect(requested(legacy, (await delegate(api(legacy), "[fixture:quick] legacy")).body.sessionId)).toBe("fixture-fast");
    });

    it("falls back to the existing rule when the saved default is no longer usable: no error, and the stale choice stays visible", async () => {
      const home = tempHome();
      writeFileSync(join(home, "settings.json"), JSON.stringify({ version: 1, harnesses: { pi: { userDefaultModel: "retired-model" } } }));
      const service = await boot({ home });
      const client = api(service);

      const fallback = await delegate(client, "[fixture:quick] stale");
      expect(fallback.response.status).toBe(201);
      expect(requested(service, fallback.body.sessionId)).toBeUndefined();
      const state = await client.json<StateSnapshot>(await client.get("/api/state"));
      expect(state.harnesses.find((h) => h.id === "pi")).toMatchObject({ userDefaultModel: "retired-model", defaultModel: "fixture-fast" });

      // 名单收窄到不含它的范围，行为同样是现有规则（执行端默认被开放就用它）。
      await client.put("/api/harnesses/pi/models", { allowed: ["fixture-fast"] });
      expect(requested(service, (await delegate(client, "[fixture:quick] stale narrowed")).body.sessionId)).toBe("fixture-fast");
    });
  });

  it("is still there after a restart", async () => {
    const home = tempHome();
    const first = await boot({ home });
    await setModels(api(first), "pi", ["fixture-deep"]);
    await stopService(first);

    const second = await boot({ home });
    const client = api(second);
    expect(await allowedIn(client, "pi")).toEqual(["fixture-deep"]);
    const state = await client.json<StateSnapshot>(await client.get("/api/state"));
    expect(state.harnesses.find((h) => h.id === "pi")?.allowedModels).toEqual(["fixture-deep"]);
    expect((await client.post("/api/sessions", { harness: "pi", task: "x", cwd: tmpdir(), model: "fixture-fast" })).status).toBe(422);
  });

  it("answers unknown harnesses with 404, malformed bodies with 400, and refuses foreign origins", async () => {
    const service = await boot();
    const client = api(service);
    expect((await setModels(client, "codex", ["x"])).status).toBe(404);
    expect((await client.put("/api/harnesses/pi/models", { allowed: "fixture-fast" })).status).toBe(400);
    expect((await client.put("/api/harnesses/pi/models", {})).status).toBe(400);
    expect((await client.put("/api/harnesses/pi/models", { allowed: [""] })).status).toBe(400);
    const foreign = await client.put("/api/harnesses/pi/models", { allowed: ["fixture-fast"] }, { origin: "http://evil.example.com" });
    expect(foreign.status).toBe(403);
    expect(await allowedIn(client, "pi")).toBeUndefined();

    const noToken = await fetch(`${service.url}/api/harnesses/pi/models`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allowed: [] }),
    });
    expect(noToken.status).toBe(403);
  });
});
