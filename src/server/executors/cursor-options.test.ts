import { afterEach, describe, expect, it } from "vitest";
import { ENV } from "@shared/constants";
import { shutdownTrackedEnvs, stateOf, until } from "../testing";
import { settingSourcesFrom } from "./cursor";
import { assistantText, finished, toolCall, typedError } from "./cursor-fake";
import { FAKE_KEY, READ_ONLY_TOOLS, WAIT, completed, delegate, diagnostics, runOf, setup, tools } from "./cursor-test-kit";

afterEach(shutdownTrackedEnvs);

/**
 * 按真实目录的形状写的（2026-11-08 经 SDK 1.0.28 的 Cursor.models.list() 取到，只留了和适配器有关的部分）：
 * Auto 的 id 是 "default"、别名是 "auto"，并且不一定排在第一个；推理档位叫 reasoning_effort，和 context、fast 并列。
 */
const REAL_SHAPED_CATALOG = [
  {
    id: "grok-4.7",
    displayName: "Grok 4.7",
    parameters: [
      { id: "context", displayName: "Context", values: [{ value: "256k", displayName: "256K" }, { value: "500k", displayName: "500K" }] },
      { id: "reasoning_effort", displayName: "Effort", values: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }] },
      { id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
    ],
    variants: [
      {
        params: [
          { id: "context", value: "256k" },
          { id: "reasoning_effort", value: "low" },
          { id: "fast", value: "false" },
        ],
        displayName: "Grok 4.7  Low",
        isMaxMode: true,
      },
    ],
  },
  { id: "default", displayName: "Auto", aliases: ["auto"], variants: [{ params: [], displayName: "Auto", isDefault: true }] },
];

describe("Cursor catalog in the real shape", () => {
  it("treats the Auto entry (id default, alias auto) as the default model even when it is not first", async () => {
    const { executor } = setup({ configure: (fake) => (fake.models = REAL_SHAPED_CATALOG) });
    const info = await executor.probe();

    expect(info.status).toBe("ready");
    expect(info.defaultModel).toBe("default");
    expect(info.models.map((model) => model.id)).toEqual(["grok-4.7", "default"]);
    expect(info.models.find((model) => model.id === "default")).toMatchObject({ label: "Auto", isDefault: true });
    expect(info.models.find((model) => model.id === "grok-4.7")).toMatchObject({ efforts: ["low", "medium", "high", "xhigh"] });
    // 这个模型没有标出默认变体，所以不编造默认档位。
    expect(info.models.find((model) => model.id === "grok-4.7")?.defaultEffort).toBeUndefined();
  });

  it("starts with the Auto entry when no model is requested, and resolves the alias to its canonical id", async () => {
    const { env, fake } = setup({ configure: (f) => (f.models = REAL_SHAPED_CATALOG) });
    await delegate(env);
    await delegate(env, { model: "auto" });
    await until(() => fake.created.length === 2, WAIT, "both agents created");
    expect(fake.created.map((options) => options["model"])).toEqual([{ id: "default" }, { id: "default" }]);
  });

  it("sends the effort under the catalog's own parameter id (reasoning_effort)", async () => {
    const { env, fake } = setup({ configure: (f) => (f.models = REAL_SHAPED_CATALOG) });
    await delegate(env, { model: "grok-4.7", effort: "high" });
    await until(() => fake.created.length === 1, WAIT, "agent created");
    expect(fake.created[0]?.["model"]).toEqual({ id: "grok-4.7", params: [{ id: "reasoning_effort", value: "high" }] });
  });
});

describe("Cursor session options", () => {
  it("uses the catalog's default model when none is requested", async () => {
    const { env, fake } = setup();
    const { sessionId } = await delegate(env);
    await until(() => fake.created.length === 1, WAIT, "agent created");
    expect(fake.created[0]?.["model"]).toEqual({ id: "auto" });
    expect(stateOf(env, sessionId).meta.effort).toBeUndefined();
  });

  it("sends the effort as the model's own parameter and records it", async () => {
    const { env, fake } = setup();
    const { sessionId } = await delegate(env, { model: "composer-fake", effort: "high" });
    await until(() => fake.created.length === 1, WAIT, "agent created");
    expect(fake.created[0]?.["model"]).toEqual({ id: "composer-fake", params: [{ id: "reasoning", value: "high" }] });
    await until(() => stateOf(env, sessionId).meta.model?.label === "Composer Fake", WAIT, "model recorded");
    expect(stateOf(env, sessionId).meta.effort).toBe("high");
    expect(stateOf(env, sessionId).meta.model).toMatchObject({ requested: "composer-fake", resolved: "composer-fake", label: "Composer Fake" });
  });

  it("reports the catalog's default effort without overriding it", async () => {
    const { env, fake } = setup();
    const { sessionId } = await delegate(env, { model: "composer-fake" });
    await until(() => stateOf(env, sessionId).meta.effort === "medium", WAIT, "effort recorded");
    expect(fake.created[0]?.["model"]).toEqual({ id: "composer-fake" });
  });

  it("resolves aliases to the model's canonical id", async () => {
    const { env, fake } = setup();
    await delegate(env, { model: "plain" });
    await until(() => fake.created.length === 1, WAIT, "agent created");
    expect(fake.created[0]?.["model"]).toEqual({ id: "plain-fake" });
  });

  it("refuses an effort the model does not offer instead of ignoring it", async () => {
    const { env, fake } = setup();
    const { sessionId } = await delegate(env, { model: "composer-fake", effort: "max" });
    await until(() => stateOf(env, sessionId).runs[0]?.status === "failed", WAIT, "run failed");
    const error = stateOf(env, sessionId).runs[0]?.error;
    expect(error).toMatchObject({ code: "invalid_request" });
    expect(error?.message).toContain("low, medium, high");
    expect(fake.created).toHaveLength(0);
  });

  it("refuses an effort for a model that has no effort setting", async () => {
    const { env } = setup();
    const { sessionId } = await delegate(env, { model: "plain-fake", effort: "high" });
    await until(() => stateOf(env, sessionId).runs[0]?.status === "failed", WAIT, "run failed");
    expect(stateOf(env, sessionId).runs[0]?.error?.message).toContain("no reasoning-effort setting");
  });

  it("lets the SDK judge an unknown model and lists what the account does offer", async () => {
    const { env, fake } = setup({ configure: (f) => (f.createError = typedError("ConfigurationError", "invalid model nope-model")) });
    const { sessionId } = await delegate(env, { model: "nope-model" });
    await until(() => stateOf(env, sessionId).runs[0]?.status === "failed", WAIT, "run failed");
    const error = stateOf(env, sessionId).runs[0]?.error;
    expect(error?.code).toBe("model_not_found");
    expect(error?.message).toContain("Available models: auto, composer-fake, plain-fake");
    expect(fake.created).toHaveLength(0);
  });

  it("restricts a read-only session to the read tools and records the enforcement", async () => {
    const { env, fake } = setup();
    const { sessionId } = await delegate(env, { access: "read_only" });
    await until(() => fake.created.length === 1, WAIT, "agent created");
    expect(fake.created[0]?.["tools"]).toEqual(READ_ONLY_TOOLS);
    expect(stateOf(env, sessionId).meta.accessEnforcement?.level).toBe("enforced");
  });

  it("runs with Full Access by default: no tool restriction, and it says nothing is enforced", async () => {
    const { env, fake } = setup();
    const { sessionId } = await delegate(env);
    await until(() => fake.created.length === 1, WAIT, "agent created");
    expect("tools" in (fake.created[0] ?? {})).toBe(false);
    expect(stateOf(env, sessionId).meta.access).toBe("full");
    expect(stateOf(env, sessionId).meta.accessEnforcement?.level).toBe("none");
  });

  it("stops a read-only run that still uses a mutating tool, and calls it a policy block", async () => {
    const { env, fake } = setup();
    const { sessionId } = await delegate(env, { access: "read_only" });
    const run = await runOf(fake);
    run.push(toolCall("x1", "shell", "running", { command: "rm -rf build" }));
    await until(() => stateOf(env, sessionId).runs[0]?.status === "failed", WAIT, "run failed");

    expect(run.cancelCalls).toBe(1);
    expect(stateOf(env, sessionId).runs[0]?.error).toMatchObject({ code: "policy_blocked" });
    expect(diagnostics(env, sessionId).some((d) => d.code === "cursor.access_violation" && d.level === "error")).toBe(true);
    expect(tools(env, sessionId)[0]?.status).toBe("cancelled");
    expect(stateOf(env, sessionId).status).toBe("idle");
  });

  it("loads only the project settings layer by default and honours ENSEMBLE_CURSOR_SETTINGS", async () => {
    expect(settingSourcesFrom({})).toEqual(["project"]);
    expect(settingSourcesFrom({ [ENV.cursorSettings]: "none" })).toEqual([]);
    expect(settingSourcesFrom({ [ENV.cursorSettings]: "project, user" })).toEqual(["project", "user"]);
    expect(settingSourcesFrom({ [ENV.cursorSettings]: "ALL" })).toEqual(["all"]);
    expect(settingSourcesFrom({ [ENV.cursorSettings]: "bogus" })).toEqual(["project"]);

    const { env, fake } = setup({ env: { [ENV.cursorSettings]: "none" } });
    const { sessionId } = await delegate(env);
    await until(() => fake.created.length === 1, WAIT, "agent created");
    expect(fake.created[0]?.["local"]).toEqual({ cwd: stateOf(env, sessionId).meta.cwd, settingSources: [] });
  });

  it("passes CURSOR_API_KEY to the SDK explicitly and keeps it out of every recorded event", async () => {
    const { env, fake } = setup({ env: { CURSOR_API_KEY: FAKE_KEY } });
    const { sessionId } = await delegate(env);
    const run = await runOf(fake);
    run.push(assistantText("hello"));
    run.finish(finished("hello"));
    await until(completed(env, sessionId), WAIT, "run completed");
    expect(fake.created[0]?.["apiKey"]).toBe(FAKE_KEY);
    expect(JSON.stringify(env.hub.events(sessionId))).not.toContain(FAKE_KEY);

    const other = setup();
    await delegate(other.env);
    await until(() => other.fake.created.length === 1, WAIT, "agent created");
    expect("apiKey" in (other.fake.created[0] ?? {})).toBe(false);
  });
});
