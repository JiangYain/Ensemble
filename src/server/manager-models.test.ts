import { afterEach, describe, expect, it } from "vitest";
import type { ModelInfo, ModelSettingsView } from "@shared/types";
import { CursorExecutor } from "./executors/cursor";
import { FakeSdk } from "./executors/cursor-fake";
import type { ModelPolicy } from "./executors/registry";
import { EnsembleError } from "./errors";
import { delegatorFor, makeTrackedEnv, ManualExecutor, shutdownTrackedEnvs, stateOf, until } from "./testing";

afterEach(shutdownTrackedEnvs);

const models: ModelInfo[] = [
  { id: "alpha", label: "Alpha" },
  { id: "beta", label: "Beta" },
  { id: "gamma", label: "Gamma" },
];
const delegate = delegatorFor("codex");

/** 名单可以在测试中途改，模拟用户在配置页里的修改。 */
function setup(initial?: string[], catalog: ModelInfo[] = models) {
  let allowed = initial;
  const policy: ModelPolicy = { modelSettings: () => allowed === undefined ? {} : { allowedModels: allowed } };
  const executor = new ManualExecutor("codex", { models: catalog, defaultModel: "beta" });
  const env = makeTrackedEnv([executor], {}, undefined, policy);
  return { env, setAllowed: (next: string[] | undefined) => void (allowed = next) };
}

async function rejection(promise: Promise<unknown>): Promise<EnsembleError> {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(EnsembleError);
  return error as EnsembleError;
}

describe("委派时的模型把关", () => {
  it("用户没有限制时，原样放行，也包括目录里没有的名字（是否存在由执行端判断）", async () => {
    const { env } = setup(undefined);
    const picked = await delegate(env, { model: "gamma" });
    expect(stateOf(env, picked.sessionId).meta.model).toEqual({ requested: "gamma" });
    const alias = await delegate(env, { model: "some-alias" });
    expect(stateOf(env, alias.sessionId).meta.model).toEqual({ requested: "some-alias" });
    // 不指定就不写，交给执行端用它自己的默认。
    const omitted = await delegate(env);
    expect(stateOf(env, omitted.sessionId).meta.model).toBeUndefined();
  });

  it("只开放了一部分时，开放的模型照常委派", async () => {
    const { env } = setup(["alpha", "gamma"]);
    const result = await delegate(env, { model: "gamma" });
    expect(stateOf(env, result.sessionId).meta.model).toEqual({ requested: "gamma" });
  });

  it("请求没开放的模型：拒绝，并说明能选哪些；不会留下半成品会话", async () => {
    const { env } = setup(["alpha", "gamma"]);
    const error = await rejection(delegate(env, { model: "beta" }));
    expect(error.code).toBe("model_not_allowed");
    expect(error.status).toBe(422);
    expect(error.message).toContain('Model "beta" is not allowed for harness "codex"');
    expect(error.message).toContain("Allowed: alpha, gamma");
    expect(error.details).toEqual({ harness: "codex", requested: "beta", allowed: ["alpha", "gamma"] });
    expect(env.hub.allSummaries()).toHaveLength(0);
  });

  it("没指定模型：执行端默认模型被开放就照常，没开放就退到第一个被开放的", async () => {
    const kept = setup(["alpha", "beta"]);
    const keptResult = await delegate(kept.env);
    expect(stateOf(kept.env, keptResult.sessionId).meta.model).toEqual({ requested: "beta" });

    const moved = setup(["gamma", "alpha"]);
    const movedResult = await delegate(moved.env);
    // 按目录顺序（alpha 在 gamma 之前），而不是点选的先后。
    expect(stateOf(moved.env, movedResult.sessionId).meta.model).toEqual({ requested: "alpha" });
  });

  it("排队期间目录换了默认模型，Cursor 启动仍收到委派时选定的白名单模型", async () => {
    const sdk = new FakeSdk();
    const alpha = { id: "alpha", displayName: "Alpha" };
    const beta = { id: "beta", displayName: "Beta" };
    sdk.models = [alpha, beta];
    const cursor = new CursorExecutor({ env: {}, loadSdk: sdk.loader });
    const blocker = new ManualExecutor("pi");
    const env = makeTrackedEnv([blocker, cursor], { maxConcurrentRuns: 1 }, undefined, {
      modelSettings: (id) => id === "cursor" ? { allowedModels: ["alpha"] } : {},
    });
    const held = await delegatorFor("pi")(env);
    await until(() => blocker.sessions[0]?.started.length === 1);
    await delegatorFor("cursor")(env);
    expect(env.manager.capacity().waiting).toBe(1);

    sdk.models = [beta, alpha];
    expect((await env.registry.info("cursor", { force: true }))?.defaultModel).toBe("beta");
    blocker.sessions[0]!.complete(held.runId);
    await until(() => sdk.created.length === 1);
    expect(sdk.created[0]?.["model"]).toEqual({ id: "alpha" });
  });

  it("一个都没开放：拒绝，并告诉主 Agent 这要用户去配置页里处理", async () => {
    const { env } = setup([]);
    const error = await rejection(delegate(env));
    expect(error.code).toBe("model_not_allowed");
    expect(error.message).toContain('No model is allowed for harness "codex"');
    expect(error.message).toContain("executor settings");
    expect((await rejection(delegate(env, { model: "alpha" }))).code).toBe("model_not_allowed");
    expect(env.hub.allSummaries()).toHaveLength(0);
  });

  it("用户改了名单，下一次委派立即按新的来，不需要重启", async () => {
    const { env, setAllowed } = setup(["alpha"]);
    expect((await rejection(delegate(env, { model: "gamma" }))).code).toBe("model_not_allowed");
    setAllowed(["alpha", "gamma"]);
    const result = await delegate(env, { model: "gamma" });
    expect(stateOf(env, result.sessionId).meta.model).toEqual({ requested: "gamma" });
    setAllowed(undefined);
    await delegate(env, { model: "beta" });
  });

  it("目录一时读不到时，以用户点名的为准：明确开放的模型仍能用，没点名的仍被拒", async () => {
    const { env } = setup(["alpha"], []);
    const result = await delegate(env, { model: "alpha" });
    expect(stateOf(env, result.sessionId).meta.model).toEqual({ requested: "alpha" });
    expect((await rejection(delegate(env, { model: "beta" }))).code).toBe("model_not_allowed");
  });

  it("已经创建的会话不受影响：之后收窄名单，不会回头动它用过的模型", async () => {
    const { env, setAllowed } = setup(undefined);
    const first = await delegate(env, { model: "gamma" });
    setAllowed(["alpha"]);
    expect(stateOf(env, first.sessionId).meta.model).toEqual({ requested: "gamma" });
  });
});

describe("委派时的推理档位把关", () => {
  const leveled: ModelInfo[] = [
    { id: "alpha", label: "Alpha", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
    { id: "beta", label: "Beta" },
  ];

  function setupEfforts(settings: ModelSettingsView, defaultModel: string | null = "alpha") {
    let current = settings;
    const executor = new ManualExecutor("codex", { models: leveled, defaultModel: defaultModel ?? undefined });
    const env = makeTrackedEnv([executor], {}, undefined, { modelSettings: () => current });
    return { env, executor, change: (next: ModelSettingsView) => void (current = next) };
  }

  it("请求被允许的档位：照常委派，会话记录的就是它", async () => {
    const { env } = setupEfforts({ allowedEfforts: { alpha: ["low", "high"] } });
    const result = await delegate(env, { model: "alpha", effort: "high" });
    expect(stateOf(env, result.sessionId).meta).toMatchObject({ model: { requested: "alpha" }, effort: "high" });
  });

  it("请求没被允许的档位：拒绝并说明能选哪些，不留下半成品会话；两种入口看到的是同一个结果", async () => {
    const { env } = setupEfforts({ allowedModels: ["alpha"], allowedEfforts: { alpha: ["low", "high"] } });
    const error = await rejection(delegate(env, { model: "alpha", effort: "xhigh" }));
    expect(error.code).toBe("effort_not_allowed");
    expect(error.status).toBe(422);
    expect(error.message).toContain('Effort "xhigh" is not allowed for model "alpha" on harness "codex"');
    expect(error.message).toContain("Allowed: low, high");
    expect(error.details).toEqual({ harness: "codex", model: "alpha", requested: "xhigh", allowed: ["low", "high"] });
    // 没指定模型时同样按实际会用的模型来判断。
    expect((await rejection(delegate(env, { effort: "xhigh" }))).code).toBe("effort_not_allowed");
    expect(env.hub.allSummaries()).toHaveLength(0);
  });

  it("省略档位：固定成被允许的实际默认；原生默认没被允许就用第一个被允许的，不回落到原生默认", async () => {
    const kept = setupEfforts({ allowedEfforts: { alpha: ["medium", "high"] } });
    const keptResult = await delegate(kept.env, { model: "alpha" });
    expect(stateOf(kept.env, keptResult.sessionId).meta.effort).toBe("medium");

    const moved = setupEfforts({ allowedEfforts: { alpha: ["high", "xhigh"] } });
    const movedResult = await delegate(moved.env, { model: "alpha" });
    expect(stateOf(moved.env, movedResult.sessionId).meta.effort).toBe("high");
    // 没指定模型：落在执行端默认的 alpha 上，模型与档位一起固定。
    const bare = await delegate(moved.env);
    expect(stateOf(moved.env, bare.sessionId).meta).toMatchObject({ model: { requested: "alpha" }, effort: "high" });
  });

  it("档位在委派时就固定下来：排队期间设置或目录变了，也不改它", async () => {
    const { env, executor, change } = setupEfforts({ allowedEfforts: { alpha: ["high"] } });
    const first = await delegate(env);
    change({ allowedEfforts: { alpha: ["low"] } });
    executor.info = { ...executor.info, models: [{ ...leveled[0]!, defaultEffort: "xhigh" }, leveled[1]!] };
    await env.registry.info("codex", { force: true });
    expect(stateOf(env, first.sessionId).meta.effort).toBe("high");
    await until(() => executor.sessions.length === 1);
    expect(executor.sessions[0]?.input.meta.effort).toBe("high");
    // 下一次委派才按新的设置。
    const second = await delegate(env);
    expect(stateOf(env, second.sessionId).meta.effort).toBe("low");
  });

  it("没有档位限制时保持原样：请求什么就传什么，不指定就不固定", async () => {
    const { env } = setupEfforts({});
    const explicit = await delegate(env, { model: "alpha", effort: "ultra" });
    expect(stateOf(env, explicit.sessionId).meta.effort).toBe("ultra");
    const omitted = await delegate(env, { model: "alpha" });
    expect(stateOf(env, omitted.sessionId).meta.effort).toBeUndefined();
  });

  it("已保存的档位记录始终生效：目录只报这些档位、或该模型暂时不报档位，也照样固定许可的档位", async () => {
    const same = setupEfforts({ allowedEfforts: { alpha: ["low", "medium", "high", "xhigh"] } });
    const whole = await delegate(same.env, { model: "alpha" });
    expect(stateOf(same.env, whole.sessionId).meta.effort).toBe("medium");
    expect((await rejection(delegate(same.env, { model: "alpha", effort: "ultra" }))).code).toBe("effort_not_allowed");

    // beta 目录里没有档位：用户的记录是唯一的依据，原样交给执行端，而不是当作没有限制。
    const silent = setupEfforts({ allowedEfforts: { beta: ["high", "low"] } });
    const fixed = await delegate(silent.env, { model: "beta" });
    expect(stateOf(silent.env, fixed.sessionId).meta.effort).toBe("high");
    expect((await rejection(delegate(silent.env, { model: "beta", effort: "max" }))).code).toBe("effort_not_allowed");
  });

  it("有档位记录时，省略模型也固定实际模型：默认模型自己没有记录，排队期间默认换成受限的模型也绕不过去", async () => {
    const { env, executor } = setupEfforts({ allowedEfforts: { alpha: ["high"] } }, "beta");
    const queued = await delegate(env);
    expect(stateOf(env, queued.sessionId).meta.model).toEqual({ requested: "beta" });
    expect(stateOf(env, queued.sessionId).meta.effort).toBeUndefined();
    // 排队期间执行端的默认换成了受限的 alpha：已入队的会话仍是委派时固定的模型。
    executor.info = { ...executor.info, defaultModel: "alpha" };
    await env.registry.info("codex", { force: true });
    await until(() => executor.sessions.length === 1);
    expect(executor.sessions[0]?.input.meta.model).toEqual({ requested: "beta" });
    // 之后的委派落在 alpha 上，档位随之固定。
    const next = await delegate(env);
    expect(stateOf(env, next.sessionId).meta).toMatchObject({ model: { requested: "alpha" }, effort: "high" });
  });

  it("有档位记录而默认模型不明：明确拒绝，点名模型即可；没有记录时仍交给执行端", async () => {
    const { env } = setupEfforts({ allowedEfforts: { alpha: ["high"] } }, null);
    const error = await rejection(delegate(env));
    expect(error.code).toBe("model_not_allowed");
    expect(error.message).toContain("has to be named explicitly");
    expect(error.details).toMatchObject({ harness: "codex", reason: "model_unverified", allowed: ["alpha", "beta"] });
    expect(env.hub.allSummaries()).toHaveLength(0);
    const named = await delegate(env, { model: "beta" });
    expect(stateOf(env, named.sessionId).meta.model).toEqual({ requested: "beta" });

    const open = setupEfforts({}, null);
    const bare = await delegate(open.env);
    expect(stateOf(open.env, bare.sessionId).meta.model).toBeUndefined();
  });

  it("目录不认识的名字（别名）不能绕过已配置的档位规则；没有档位记录时原有兼容不变", async () => {
    const { env } = setupEfforts({ allowedEfforts: { alpha: ["high"] } });
    const error = await rejection(delegate(env, { model: "alpha-latest", effort: "xhigh" }));
    expect(error.code).toBe("model_not_allowed");
    expect(error.status).toBe(422);
    expect(error.message).toContain('Model "alpha-latest" is not a model harness "codex" reports');
    expect(error.details).toMatchObject({ requested: "alpha-latest", reason: "model_unverified", allowed: ["alpha", "beta"] });
    expect(env.hub.allSummaries()).toHaveLength(0);

    const open = setupEfforts({});
    const alias = await delegate(open.env, { model: "alpha-latest", effort: "xhigh" });
    expect(stateOf(open.env, alias.sessionId).meta).toMatchObject({ model: { requested: "alpha-latest" }, effort: "xhigh" });
  });

  it("允许的档位与目录对不上：拒绝，而不是放开全部档位", async () => {
    const { env } = setupEfforts({ allowedEfforts: { alpha: ["max"] } });
    const error = await rejection(delegate(env, { model: "alpha", effort: "low" }));
    expect(error.code).toBe("effort_not_allowed");
    expect(error.message).toContain("No reasoning effort is allowed");
    // 没指定模型：执行端默认的 alpha 用不了，就换成第一个可用的 beta 并固定下来（与白名单里默认被关掉时一样）。
    const bare = await delegate(env);
    expect(stateOf(env, bare.sessionId).meta.model).toEqual({ requested: "beta" });
    expect(stateOf(env, bare.sessionId).meta.effort).toBeUndefined();
  });
});

describe("用户在设置里指定的默认模型", () => {
  /** 执行端自己的默认是 beta；设置可以在测试中途改，模拟用户在配置页里的修改。 */
  function setupDefault(settings: ModelSettingsView) {
    let current = settings;
    const executor = new ManualExecutor("codex", { models, defaultModel: "beta" });
    const env = makeTrackedEnv([executor], {}, undefined, { modelSettings: () => current });
    return { env, change: (next: ModelSettingsView) => void (current = next) };
  }
  const modelOf = (env: ReturnType<typeof setupDefault>["env"], sessionId: string) => stateOf(env, sessionId as never).meta.model;

  it("不指定模型：不设限时固定为指定的默认，没有指定则仍交给执行端（不写模型）", async () => {
    const chosen = setupDefault({ userDefaultModel: "gamma" });
    expect(modelOf(chosen.env, (await delegate(chosen.env)).sessionId)).toEqual({ requested: "gamma" });
    const none = setupDefault({});
    expect(modelOf(none.env, (await delegate(none.env)).sessionId)).toBeUndefined();
  });

  it("有限制时同样用它，而不是执行端的默认；写了模型就按白名单校验，指定的默认不改写它", async () => {
    const { env } = setupDefault({ allowedModels: ["alpha", "gamma"], userDefaultModel: "gamma" });
    expect(modelOf(env, (await delegate(env)).sessionId)).toEqual({ requested: "gamma" });
    expect(modelOf(env, (await delegate(env, { task: "second", model: "alpha" })).sessionId)).toEqual({ requested: "alpha" });
    const error = await rejection(delegate(env, { task: "third", model: "beta" }));
    expect(error.code).toBe("model_not_allowed");
    expect(error.details).toEqual({ harness: "codex", requested: "beta", allowed: ["alpha", "gamma"] });
  });

  it("指定之后又改了设置：下一次委派按新的来；失效了就回到现有规则，不报错", async () => {
    const { env, change } = setupDefault({ allowedModels: ["alpha", "beta", "gamma"], userDefaultModel: "gamma" });
    expect(modelOf(env, (await delegate(env, { task: "one" })).sessionId)).toEqual({ requested: "gamma" });

    // 手改文件等造成的失效：指定的默认不在名单里 → 现有规则（执行端默认 beta 被开放就用它）。
    change({ allowedModels: ["alpha", "beta"], userDefaultModel: "gamma" });
    expect(modelOf(env, (await delegate(env, { task: "two" })).sessionId)).toEqual({ requested: "beta" });
    // 执行端的默认也不在名单里：第一个被开放的。
    change({ allowedModels: ["alpha"], userDefaultModel: "gamma" });
    expect(modelOf(env, (await delegate(env, { task: "three" })).sessionId)).toEqual({ requested: "alpha" });
    // 不设限、指定的默认执行端已不再提供：交给执行端自己的默认。
    change({ userDefaultModel: "retired" });
    expect(modelOf(env, (await delegate(env, { task: "four" })).sessionId)).toBeUndefined();
    // 清掉之后一切照旧。
    change({});
    expect(modelOf(env, (await delegate(env, { task: "five" })).sessionId)).toBeUndefined();
  });

  it("没得选（空名单、设置损坏）时仍然拒绝，指定的默认不会让它放行", async () => {
    const empty = setupDefault({ allowedModels: [], userDefaultModel: "gamma" });
    expect((await rejection(delegate(empty.env))).details).toEqual({ harness: "codex", allowed: [] });
    const broken = setupDefault({ modelSettingsIssue: "invalid_entry", userDefaultModel: "gamma" });
    expect((await rejection(delegate(broken.env))).code).toBe("model_settings_unavailable");
    expect(empty.env.hub.allSummaries()).toHaveLength(0);
  });

  it("与推理档位一起：指定的默认模型若有档位记录，固定成被允许的那一档", async () => {
    const leveled: ModelInfo[] = [{ id: "alpha", label: "Alpha" }, { id: "beta", label: "Beta", efforts: ["low", "high"], defaultEffort: "high" }];
    const executor = new ManualExecutor("codex", { models: leveled, defaultModel: "alpha" });
    const env = makeTrackedEnv([executor], {}, undefined, { modelSettings: () => ({ userDefaultModel: "beta", allowedEfforts: { beta: ["low"] } }) });
    const result = await delegate(env);
    expect(stateOf(env, result.sessionId).meta).toMatchObject({ model: { requested: "beta" }, effort: "low" });
  });
});
