import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { TOKEN_HEADER } from "@shared/constants";
import { ClaudeExecutor } from "../server/executors/claude";
import type { RunningService } from "../server/service";
import { ManualExecutor, until } from "../server/testing";
import { explainError } from "./bridge";
import { closeTestBridges, setupBridge as setup, type ToolData } from "./bridge.fixtures";
import { ServiceError } from "./client";

/**
 * 桥的基本面：八个工具的目录与说明、委派并取回结果（含用户开放的模型与推理档位）、打开面板，以及出错时怎样变成主 Agent 能照做的下一步。
 * 其余几组按主题分在 bridge.intervening / bridge.follows / bridge.read-detail 三个文件里。
 */

afterEach(closeTestBridges);

describe("tool catalogue", () => {
  it("exposes the eight tools with usable descriptions and schemas", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["cancel", "delegate", "harnesses", "open_panel", "read", "send", "status", "wait"]);
    for (const tool of tools) {
      expect(tool.description?.length ?? 0, tool.name).toBeGreaterThan(60);
      expect(tool.inputSchema.type).toBe("object");
    }
    const delegate = tools.find((tool) => tool.name === "delegate")!;
    // harness 不再必填：给了 profile（用户在设置里定义的角色）就够；“两个至少有一个”由工具在请求服务之前自己检查（见 bridge.profiles.test.ts）。
    expect(delegate.inputSchema.required).toEqual(["task"]);
    expect(Object.keys(delegate.inputSchema.properties as Record<string, unknown>)).toEqual(expect.arrayContaining(["harness", "profile"]));
    const harness = (delegate.inputSchema.properties as Record<string, { enum?: string[] }>)["harness"];
    expect(harness?.enum).toContain("claude");
    expect(harness?.enum).toContain("opencode");
    expect(tools.find((tool) => tool.name === "wait")?.annotations?.readOnlyHint).toBe(true);
  });

  it("is annotated so that no host has to ask the user before using a tool, and offers only two access levels", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      // 批准策略为 never 的宿主会直接拒绝“需要批准”的工具（破坏性，或非只读且面向开放世界）。
      expect(tool.annotations?.destructiveHint, `${tool.name}: destructiveHint`).not.toBe(true);
      expect(tool.annotations?.openWorldHint, `${tool.name}: openWorldHint`).toBe(false);
    }
    const delegate = tools.find((tool) => tool.name === "delegate")!;
    const access = (delegate.inputSchema.properties as Record<string, { enum?: string[] }>)["access"];
    expect(access?.enum).toEqual(["read_only", "full"]);
  });

  it("tells the main agent up front that `cwd` is required where the host starts Ensemble from the home directory", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    const delegate = tools.find((tool) => tool.name === "delegate")!;
    const cwd = (delegate.inputSchema.properties as Record<string, { description?: string }>)["cwd"];
    expect(cwd?.description).toMatch(/pass the directory you are working in/);
    expect(cwd?.description).toMatch(/Cursor/);
    expect(cwd?.description).toMatch(/home directory/);
    expect(cwd?.description).toMatch(/refused/);
  });

  it("explains how to use the plugin in the server instructions", async () => {
    const { client } = await setup();
    expect(client.getInstructions()).toMatch(/complete brief/);
    expect(client.getInstructions()).toMatch(/Full Access by default and never stop to ask anyone for approval/);
  });
});

describe("delegating and collecting results", () => {
  it("dispatches a Claude Code session through MCP and reads its result", async () => {
    const cli = fileURLToPath(new URL("../../test/fixtures/fake-claude.mjs", import.meta.url));
    const executor = new ClaudeExecutor({ cli, env: { ...process.env, CLAUDE_CODE_SKIP_PROMPT_HISTORY: undefined } });
    const { call, service } = await setup({ executors: [executor] });
    const delegated = await call("delegate", { harness: "claude", task: "Inspect [fake:tool]", cwd: tmpdir(), access: "read_only" });
    expect(delegated.isError).toBe(false);
    const id = delegated.data?.["sessionId"] as string;
    await until(() => service.hub.summary(id)?.phase === "done", 12_000);
    const transcript = await call("read", { sessionId: id, view: "transcript" });
    expect(transcript.isError).toBe(false);
    expect(transcript.text).toContain("Read");
    expect(transcript.text).toContain("Ready.");
  });

  it("lists harnesses, marking simulated ones", async () => {
    const { call } = await setup();
    const result = await call("harnesses");
    expect(result.isError).toBe(false);
    expect(result.text).toContain("pi — Pi · 模拟");
    expect(result.text).toContain("(simulated)");
    expect(result.data?.["harnesses"]).toHaveLength(2);
  });

  describe("models the user has allowed", () => {
    const allow = (service: RunningService, harness: string, allowed: string[] | null) =>
      fetch(`${service.url}/api/harnesses/${harness}/models`, {
        method: "PUT",
        headers: { [TOKEN_HEADER]: service.token, "content-type": "application/json" },
        body: JSON.stringify({ allowed }),
      });
    const piModels = (data: ToolData | undefined) => (data?.["harnesses"] as { id: string; models: string[]; defaultModel?: string }[]).find((h) => h.id === "pi")!;

    it("shows the main agent only those models, in text and in structured data", async () => {
      const { call, service } = await setup();
      expect(piModels((await call("harnesses")).data).models).toEqual(["fixture-fast", "fixture-deep"]);

      expect((await allow(service, "pi", ["fixture-deep"])).status).toBe(200);
      const result = await call("harnesses");
      expect(piModels(result.data)).toMatchObject({ models: ["fixture-deep"], defaultModel: "fixture-deep" });
      const piLines = result.text.split("\n• ").find((block) => block.includes("pi — "))!;
      expect(piLines).toContain("models: fixture-deep*  (* = default; only these are allowed by the user)");
      expect(piLines).not.toContain("fixture-fast");
      // 另一个执行端没有被限制，仍是整个目录。
      expect((result.data?.["harnesses"] as { id: string; models: string[] }[]).find((h) => h.id === "cursor")?.models).toEqual(["fixture-fast", "fixture-deep"]);
    });

    it("lists the allowed IDs when the catalog is missing and delegates with the same default", async () => {
      const { call, service, sessions } = await setup({ executors: [new ManualExecutor("pi")] });
      expect((await allow(service, "pi", ["known-model", "other-model"])).status).toBe(200);
      const listed = await call("harnesses");
      expect(piModels(listed.data)).toMatchObject({ models: ["known-model", "other-model"], defaultModel: "known-model" });
      expect(listed.text).toContain("models: known-model*, other-model");
      expect(listed.text).not.toContain("none allowed");

      const result = await call("delegate", { harness: "pi", task: "x", cwd: tmpdir() });
      expect(result.isError).toBe(false);
      expect(sessions()[0]?.model?.requested).toBe("known-model");
    });

    describe("the default the user chose", () => {
      const choose = (service: RunningService, harness: string, allowed: string[] | null, userDefaultModel: string | null) =>
        fetch(`${service.url}/api/harnesses/${harness}/models`, {
          method: "PUT",
          headers: { [TOKEN_HEADER]: service.token, "content-type": "application/json" },
          body: JSON.stringify({ allowed, userDefaultModel }),
        });
      const piBlock = (text: string) => text.split("\n• ").find((block) => block.includes("pi — "))!;

      it("shows it in text and structured data, tells where it comes from, and a delegation that omits `model` uses it", async () => {
        const { call, service, sessions } = await setup();
        const plain = await call("harnesses");
        expect(piBlock(plain.text)).not.toContain("default model:");
        expect(piModels(plain.data)).toMatchObject({ defaultModel: "fixture-fast", defaultSource: "harness" });

        expect((await choose(service, "pi", null, "fixture-deep")).status).toBe(200);
        const listed = await call("harnesses");
        expect(piBlock(listed.text)).toContain("models: fixture-fast, fixture-deep*  (* = default)");
        expect(piBlock(listed.text)).toContain("default model: fixture-deep — chosen by the user in Ensemble's settings; used when you omit `model` (the harness's own default is fixture-fast)");
        expect(piModels(listed.data)).toMatchObject({ defaultModel: "fixture-deep", defaultSource: "user" });
        expect(piModels(listed.data)).not.toHaveProperty("userDefaultUnavailable");
        // 另一个执行端不受影响。
        expect((listed.data?.["harnesses"] as { id: string; defaultSource?: string }[]).find((h) => h.id === "cursor")?.defaultSource).toBe("harness");

        const result = await call("delegate", { harness: "pi", task: "[fixture:quick]", cwd: tmpdir() });
        expect(result.isError).toBe(false);
        expect(sessions()[0]?.model?.requested).toBe("fixture-deep");
        // 写了模型就按写的来。
        await call("delegate", { harness: "pi", task: "[fixture:quick] named", cwd: tmpdir(), model: "fixture-fast" });
        expect(sessions().find((s) => s.title.includes("named"))?.model?.requested).toBe("fixture-fast");
      });

      it("follows a change made in the settings straight away, including clearing it", async () => {
        const { call, service } = await setup();
        await choose(service, "pi", ["fixture-fast", "fixture-deep"], "fixture-deep");
        expect(piModels((await call("harnesses")).data)).toMatchObject({ defaultModel: "fixture-deep", defaultSource: "user" });
        await choose(service, "pi", ["fixture-fast", "fixture-deep"], null);
        const cleared = await call("harnesses");
        expect(piModels(cleared.data)).toMatchObject({ defaultModel: "fixture-fast", defaultSource: "harness" });
        expect(piBlock(cleared.text)).not.toContain("default model:");
      });

      it("says when the chosen default is no longer usable and what is used instead", async () => {
        const pi = new ManualExecutor("pi", { models: [{ id: "known-a", label: "A" }, { id: "known-b", label: "B" }], defaultModel: "known-a" });
        const { call, service, sessions } = await setup({ executors: [pi] });
        expect((await choose(service, "pi", null, "known-b")).status).toBe(200);
        expect(piModels((await call("harnesses")).data)).toMatchObject({ defaultModel: "known-b", defaultSource: "user" });

        // 执行端换了账号：目录里不再有 known-b。
        pi.info = { ...pi.info, models: [{ id: "known-a", label: "A" }] };
        const gone = await call("harnesses", { refresh: true });
        expect(piBlock(gone.text)).toContain("default model: known-a — used when you omit `model`. The default the user chose in Ensemble's settings is not usable right now (this harness no longer offers that model), so the harness's own default applies instead");
        expect(piBlock(gone.text)).not.toContain("known-b");
        expect(piModels(gone.data)).toMatchObject({ defaultModel: "known-a", defaultSource: "harness", userDefaultUnavailable: "missing" });

        // 委派不报错，用的就是它说的那个（执行端自己的默认，不固定）。
        const result = await call("delegate", { harness: "pi", task: "x", cwd: tmpdir() });
        expect(result.isError).toBe(false);
        expect(sessions()[0]?.model).toBeUndefined();
      });

      it("explains in the delegate tool what omitting `model` does", async () => {
        const { client } = await setup();
        const delegate = (await client.listTools()).tools.find((tool) => tool.name === "delegate")!;
        const model = (delegate.inputSchema.properties as Record<string, { description?: string }>)["model"]!;
        expect(model.description).toContain("the one the user chose as default in Ensemble's settings if they chose one, otherwise the harness's own default");
      });
    });

    it("refuses a model that is not open, with a next step the main agent can act on", async () => {
      const { call, service, sessions } = await setup();
      await allow(service, "pi", ["fixture-deep"]);
      const refused = await call("delegate", { harness: "pi", task: "x", cwd: tmpdir(), model: "fixture-fast" });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('Model "fixture-fast" is not allowed for harness "pi"');
      expect(refused.text).toContain("Allowed: fixture-deep");
      expect(refused.text).toContain("tell the user");
      expect(sessions()).toHaveLength(0);

      const accepted = await call("delegate", { harness: "pi", task: "[fixture:quick]", cwd: tmpdir(), model: "fixture-deep" });
      expect(accepted.isError).toBe(false);
    });

    it("shows the efforts the user allows (and the real default), and refuses the rest with a next step", async () => {
      const { call, service, sessions } = await setup();
      const before = await call("harnesses");
      expect(before.text).toContain("efforts: fixture-deep: low, medium, high (default medium)");
      expect((before.data?.["harnesses"] as { id: string; modelEfforts: Record<string, unknown> }[]).find((h) => h.id === "pi")?.modelEfforts["fixture-deep"])
        .toEqual({ efforts: ["low", "medium", "high"], defaultEffort: "medium" });

      const saved = await fetch(`${service.url}/api/harnesses/pi/models`, {
        method: "PUT",
        headers: { [TOKEN_HEADER]: service.token, "content-type": "application/json" },
        body: JSON.stringify({ allowed: ["fixture-deep"], efforts: { "fixture-deep": ["high", "low"] } }),
      });
      expect(saved.status).toBe(200);
      const listed = await call("harnesses");
      const piBlock = listed.text.split("\n• ").find((block) => block.includes("pi — "))!;
      expect(piBlock).toContain("efforts: fixture-deep: low, high (default low; only these are allowed by the user)");
      expect((listed.data?.["harnesses"] as { id: string; modelEfforts: Record<string, unknown> }[]).find((h) => h.id === "pi")?.modelEfforts["fixture-deep"])
        .toEqual({ efforts: ["low", "high"], defaultEffort: "low", limitedByUser: true });
      // 另一个执行端没被限制，仍是执行端自己报告的档位。
      expect(listed.text.split("\n• ").find((block) => block.includes("cursor — "))).toContain("efforts: fixture-deep: low, medium, high (default medium)");

      const refused = await call("delegate", { harness: "pi", task: "x", cwd: tmpdir(), model: "fixture-deep", effort: "medium" });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('Effort "medium" is not allowed for model "fixture-deep" on harness "pi"');
      expect(refused.text).toContain("Allowed: low, high");
      expect(refused.text).toContain("do not try to work around the restriction");
      expect(sessions()).toHaveLength(0);

      const omitted = await call("delegate", { harness: "pi", task: "[fixture:quick]", cwd: tmpdir() });
      expect(omitted.isError).toBe(false);
      expect(omitted.text).toContain("effort low");
      expect(sessions()[0]).toMatchObject({ model: { requested: "fixture-deep" }, effort: "low" });
    });

    it("tells the main agent to leave a harness alone when nothing is open", async () => {
      const { call, service, sessions } = await setup();
      await allow(service, "pi", []);
      const listed = await call("harnesses");
      expect(piModels(listed.data).models).toEqual([]);
      expect(listed.text).toContain("models: none allowed");
      const refused = await call("delegate", { harness: "pi", task: "x", cwd: tmpdir() });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("No model is allowed for harness");
      expect(sessions()).toHaveLength(0);
    });
  });

  it("returns at once with a session id and a panel URL that focuses the new session", async () => {
    const { call, service } = await setup();
    const result = await call("delegate", { harness: "pi", task: "[fixture:long] Audit the auth module", title: "Auth audit", cwd: tmpdir() });
    expect(result.isError).toBe(false);
    const id = result.data?.["sessionId"] as string;
    expect(id).toMatch(/^ses_/);
    expect(result.data?.["panelUrl"]).toBe(`${service.url}/#/s/${id}`);
    expect(result.text).toContain(`session ${id}`);
    expect(result.text).toContain("working in the background");
    expect(result.text).toContain("open the panel URL in your browser tool");
    expect(result.text).toContain('"Auth audit"');
    await call("cancel", { sessionId: id, stop: true });
  });

  it("waits for a session to finish and reads back its answer", async () => {
    const { call } = await setup();
    const delegated = await call("delegate", { harness: "pi", task: "[fixture:quick] summarise", cwd: tmpdir() });
    const id = delegated.data?.["sessionId"] as string;

    const waited = await call("wait", { timeoutSeconds: 10 });
    expect(waited.data?.["reason"]).toBe("settled");
    // 模拟执行端瞬间完成时，wait 会直接给出已有结果；否则是等到结束后返回。两种说法都表示“全部结束”。
    expect(waited.text).toMatch(/All (of your )?sessions have (already )?finished/);

    const read = await call("read", { sessionId: id });
    expect(read.text).toContain("Final answer:");
    expect(read.text).toContain("done");

    const transcript = await call("read", { sessionId: id, view: "transcript" });
    expect(transcript.text).toContain("task → Pi (simulated)");
    expect(transcript.text).toContain("run 1 completed");
  });

  it("says plainly when there is nothing to wait for", async () => {
    const { call } = await setup();
    expect((await call("wait")).text).toContain("no delegated sessions");
    const delegated = await call("delegate", { harness: "pi", task: "[fixture:quick] go", cwd: tmpdir() });
    await call("wait", { timeoutSeconds: 10 });
    const again = await call("wait");
    expect(again.text).toContain("All of your sessions have already finished");
    expect(again.text).toContain("done");
    expect(again.data?.["reason"]).toBe("settled");
    expect(delegated.isError).toBe(false);
  });

  it("scopes status to the sessions started from this conversation by default", async () => {
    const { call, service } = await setup();
    await call("delegate", { harness: "pi", task: "[fixture:quick] mine", cwd: tmpdir() });
    // 另一个发起端（例如用户在网页里）创建的会话不应出现在“我的”里。
    const other = await fetch(`${service.url}/api/sessions`, {
      method: "POST",
      headers: { [TOKEN_HEADER]: service.token, "content-type": "application/json" },
      body: JSON.stringify({ harness: "pi", task: "[fixture:quick] not mine", cwd: tmpdir() }),
    });
    expect(other.status).toBe(201);
    await until(() => service.hub.allSummaries().every((s) => s.phase === "done"), 6000);

    const mine = await call("status");
    expect(mine.text).toContain("1 session (mine)");
    expect(mine.text).not.toContain("not mine");
    const all = await call("status", { scope: "all" });
    expect(all.text).toContain("2 sessions (all)");
  });
});

describe("panel", () => {
  it("returns the URL for the host's own browser by default and opens the system browser on request", async () => {
    const { call, service, opened } = await setup();
    const hostBrowser = await call("open_panel");
    expect(hostBrowser.text).toContain(`Panel: ${service.url}/`);
    expect(opened).toEqual([]);

    const system = await call("open_panel", { sessionId: "ses_abc", where: "system_browser" });
    expect(opened).toEqual([`${service.url}/#/s/ses_abc`]);
    expect(system.text).toContain("Opened");
  });

  it("opens the system browser on the first delegation only when asked to by the environment", async () => {
    const { call, opened } = await setup({ env: { ENSEMBLE_AUTO_OPEN: "system" } });
    await call("delegate", { harness: "pi", task: "[fixture:quick] a", cwd: tmpdir() });
    await call("delegate", { harness: "pi", task: "[fixture:quick] b", cwd: tmpdir() });
    expect(opened).toHaveLength(1);
  });
});

describe("errors", () => {
  it("turns a harness that is not enabled into guidance", async () => {
    const { call } = await setup();
    const result = await call("delegate", { harness: "codex", task: "hello", cwd: tmpdir() });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Harness "codex" is not enabled');
    expect(result.text).toContain("Call `harnesses`");
  });

  it("points at `status` when a session id is wrong", async () => {
    const { call } = await setup();
    const result = await call("read", { sessionId: "ses_nope" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Call `status`");
  });

  it("rejects a malformed call before it reaches the service", async () => {
    const { call, sessions } = await setup();
    const result = await call("delegate", { harness: "pi", task: "", cwd: tmpdir() });
    expect(result.isError).toBe(true);
    expect(sessions()).toHaveLength(0);
  });

  it("maps service error codes to next steps", () => {
    const setupError = new ServiceError("harness_needs_setup", 'Harness "cursor" needs setup: not signed in.', 422, { setup: { command: "cursor login" } });
    expect(explainError(setupError)).toContain("The user can fix this by running: cursor login.");
    expect(explainError(new ServiceError("depth_exceeded", "Delegation depth 3 exceeds the limit of 2.", 422))).toContain("Do the work yourself");
    expect(explainError(new Error("did not become ready in time"))).toContain("Could not start the Ensemble service");
    const notAllowed = explainError(new ServiceError("model_not_allowed", 'Model "x" is not allowed for harness "pi". Allowed: a.', 422));
    expect(notAllowed).toContain("Pick one of the allowed models");
    expect(notAllowed).toContain("do not try to work around");
    // 默认模型不明或名字无从核对时，“省略 model”不是出路，不能这样建议。
    const unverified = explainError(new ServiceError("model_not_allowed", 'Model "x" is not a model harness "pi" reports.', 422, { reason: "model_unverified", allowed: ["a"] }));
    expect(unverified).toContain("Pass `model` as one of the known models");
    expect(unverified).not.toContain("omit `model`");
    expect(explainError(new ServiceError("conflict", "Session is busy.", 409))).toBe("Session is busy. [conflict]");
  });
});
