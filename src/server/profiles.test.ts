import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { testOrigin } from "@shared/testing";
import type { HarnessInfo, ModelInfo } from "@shared/types";
import { EnsembleError } from "./errors";
import { silentLogger } from "./logger";
import { resolveDelegationFields, type DelegationFields } from "./profiles";
import { SettingsStore } from "./settings";
import { makeTrackedEnv, ManualExecutor, shutdownTrackedEnvs } from "./testing";

/**
 * 委派入口里“角色 → 实际取值”的解析与把关（服务端那一份）。字段覆盖的规则在 shared/profiles.test.ts，
 * 这里钉的是接上真实的设置文件与执行端注册表之后的行为：找不到 / 无效 / 设置读不了 / 此刻用不了，各自怎么说；
 * 以及“只替角色自己写死的取值把关，其余原样交给 manager”这条界线。
 */

afterEach(shutdownTrackedEnvs);

const models: ModelInfo[] = [
  { id: "m-fast", label: "Fast", isDefault: true, efforts: ["low", "high"], defaultEffort: "low" },
  { id: "m-big", label: "Big", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
];

interface Setup {
  /** settings.json 里的整份内容（对象会被序列化，字符串原样写入）；不给就是没有文件。 */
  file?: unknown;
  codex?: Partial<HarnessInfo>;
  pi?: Partial<HarnessInfo>;
}

async function setup({ file, codex, pi }: Setup = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ensemble-profile-resolve-"));
  const path = join(dir, "settings.json");
  if (file !== undefined) await writeFile(path, typeof file === "string" ? file : JSON.stringify(file));
  const settings = await SettingsStore.open(path, silentLogger);
  // 真实的 SettingsStore 当作模型策略：注册表对外返回的执行端信息里带着用户开放的名单与强度，与服务里的接法一致。
  const env = makeTrackedEnv([new ManualExecutor("codex", { models, ...codex }), new ManualExecutor("pi", { models, ...pi })], {}, undefined, settings);
  return {
    settings,
    env,
    resolve: (request: DelegationFields) => resolveDelegationFields({ settings, registry: env.registry }, request),
  };
}

const withProfiles = (profiles: Record<string, unknown>, harnesses: Record<string, unknown> = {}) => ({ version: 1, harnesses, profiles });

async function rejection(promise: Promise<unknown>): Promise<EnsembleError> {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(EnsembleError);
  return error as EnsembleError;
}

const VERIFY = { harness: "codex", model: "m-big", effort: "high", access: "read_only" };

describe("不带 profile：与没有这项功能之前完全一样", () => {
  it("必须有 harness，错误里点明还可以用 profile；其余校验原样留给 manager", async () => {
    const { resolve } = await setup();
    const error = await rejection(resolve({}));
    expect(error.code).toBe("invalid_request");
    expect(error.message).toContain('Give "harness"');
    expect(error.message).toContain('"profile"');
  });

  it("显式的取值原样带过去，没有任何回执（也不去核对它们此刻能不能用：那是 manager 的事）", async () => {
    const { resolve } = await setup({ file: { version: 1, harnesses: { codex: { allowedModels: ["m-fast"] } } } });
    const result = await resolve({ harness: "codex", model: "m-big", effort: "high", access: "read_only" });
    expect(result).toEqual({ harness: "codex", model: "m-big", effort: "high", access: "read_only" });
    expect(result.profile).toBeUndefined();
  });

  it("只给 harness：结果里只有 harness", async () => {
    const { resolve } = await setup();
    expect(await resolve({ harness: "pi" })).toEqual({ harness: "pi" });
  });
});

describe("带 profile：按角色解析", () => {
  it("四项都取角色的，回执写明每一项都来自角色；名字对大小写与首尾空白宽容", async () => {
    const { resolve } = await setup({ file: withProfiles({ verify: VERIFY }) });
    for (const name of ["verify", "VERIFY", "Verify", "  verify "]) {
      expect(await resolve({ profile: name }), name).toEqual({
        harness: "codex",
        model: "m-big",
        effort: "high",
        access: "read_only",
        profile: { name: "verify", sources: { harness: "profile", model: "profile", effort: "profile", access: "profile" } },
      });
    }
  });

  it("角色只固定了执行端：其余留空，交给 manager 的默认规则（回执里这三项是 default）", async () => {
    const { resolve } = await setup({ file: withProfiles({ scout: { harness: "pi" } }) });
    const result = await resolve({ profile: "scout" });
    expect(result).toEqual({
      harness: "pi",
      profile: { name: "scout", sources: { harness: "profile", model: "default", effort: "default", access: "default" } },
    });
    expect(result.model).toBeUndefined();
    expect(result.effort).toBeUndefined();
    expect(result.access).toBeUndefined();
  });

  it("显式参数按字段覆盖，并在回执里如实记下角色的哪个值没有用上", async () => {
    const { resolve } = await setup({ file: withProfiles({ verify: VERIFY }) });
    const result = await resolve({ profile: "verify", effort: "low", access: "full" });
    expect(result).toMatchObject({ harness: "codex", model: "m-big", effort: "low", access: "full" });
    expect(result.profile).toEqual({
      name: "verify",
      sources: { harness: "profile", model: "profile", effort: "explicit", access: "explicit" },
      skipped: [
        { field: "effort", value: "high", why: "overridden" },
        { field: "access", value: "read_only", why: "overridden" },
      ],
    });
  });

  it("显式换了执行端：角色的模型与强度不会被悄悄套到另一个执行端上，访问权限继承", async () => {
    const { resolve } = await setup({ file: withProfiles({ verify: VERIFY }) });
    const result = await resolve({ profile: "verify", harness: "pi" });
    expect(result.harness).toBe("pi");
    expect(result.model).toBeUndefined();
    expect(result.effort).toBeUndefined();
    expect(result.access).toBe("read_only");
    expect(result.profile?.skipped).toEqual([
      { field: "harness", value: "codex", why: "overridden" },
      { field: "model", value: "m-big", why: "other_harness" },
      { field: "effort", value: "high", why: "other_harness" },
    ]);
  });

  it("显式换了模型：角色的强度不继承", async () => {
    const { resolve } = await setup({ file: withProfiles({ verify: VERIFY }) });
    const result = await resolve({ profile: "verify", model: "m-fast" });
    expect(result).toMatchObject({ harness: "codex", model: "m-fast", access: "read_only" });
    expect(result.effort).toBeUndefined();
  });
});

describe("角色不存在、无效、或读不了", () => {
  it("名字不存在：profile_not_found，列出用户定义的角色（只列能引用的）；绝不悄悄退回默认", async () => {
    const { resolve } = await setup({ file: withProfiles({ verify: VERIFY, scout: { harness: "pi" }, "Bad Name": { harness: "pi" }, broken: "oops" }) });
    const error = await rejection(resolve({ profile: "reviewer", harness: "pi" }));
    expect(error.code).toBe("profile_not_found");
    expect(error.status).toBe(422);
    expect(error.message).toContain('There is no role named "reviewer"');
    expect(error.message).toContain("verify, scout");
    expect(error.message).not.toContain("Bad Name");
    expect(error.details).toEqual({ profile: "reviewer", available: ["verify", "scout"] });
  });

  it("用户一个角色都没有定义：说清这一点，并告诉主 Agent 出路", async () => {
    const { resolve } = await setup();
    const error = await rejection(resolve({ profile: "verify" }));
    expect(error.code).toBe("profile_not_found");
    expect(error.message).toContain("has not defined any roles");
    expect(error.message).toContain("pass harness");
    expect(error.details).toEqual({ profile: "verify", available: [] });
  });

  it("条目在、但无效（手改文件）：说它无效，而不是“不存在”——前者用户去设置里修，后者是名字写错了", async () => {
    const { resolve } = await setup({ file: withProfiles({ broken: "oops", "no-harness": { model: "x" }, "Bad Name": { harness: "pi" } }) });

    const entry = await rejection(resolve({ profile: "broken" }));
    expect(entry.code).toBe("profile_unusable");
    expect(entry.message).toContain('Role "broken" cannot be used');
    expect(entry.message).toContain("its entry in settings.json is not valid");
    expect(entry.message).toContain("Ensemble Settings, under Roles");
    expect(entry.details).toEqual({ profile: "broken" });

    expect((await rejection(resolve({ profile: "no-harness" }))).code).toBe("profile_unusable");

    const name = await rejection(resolve({ profile: "Bad Name" }));
    expect(name.code).toBe("profile_unusable");
    expect(name.message).toContain("its name in settings.json is not valid");
  });

  it("设置文件读不了：model_settings_unavailable，写明是哪个角色、怎么办；不带 profile 的委派不受这一层影响", async () => {
    const { resolve } = await setup({ file: "{ nope" });
    const error = await rejection(resolve({ profile: "verify" }));
    expect(error.code).toBe("model_settings_unavailable");
    expect(error.message).toContain('Role "verify" cannot be resolved');
    expect(error.message).toContain("could not read settings.json");
    // 后面的委派入口会拒绝所有委派（带不带 profile 都一样）：这句话不能再教主 Agent 去传 harness，那条路也走不通。
    expect(error.message).toContain("until then delegation is refused, with or without a role");
    expect(error.message).not.toContain("pass harness");
    expect(await resolve({ harness: "codex" })).toEqual({ harness: "codex" });
  });
});

describe("角色自己写死的取值此刻用不了：拒绝，点名角色与原因", () => {
  const expectUnusable = async (promise: Promise<unknown>, reason: string, fragment: string): Promise<EnsembleError> => {
    const error = await rejection(promise);
    expect(error.code).toBe("profile_unusable");
    expect(error.status).toBe(422);
    expect(error.message).toContain('Role "verify" cannot be used right now');
    expect(error.message).toContain(fragment);
    expect(error.message).toContain("Ensemble Settings, under Roles");
    expect(error.details).toEqual({ profile: "verify", reason });
    return error;
  };

  it("执行端没就绪", async () => {
    const { resolve } = await setup({ file: withProfiles({ verify: VERIFY }), codex: { status: "needs_setup" } });
    await expectUnusable(resolve({ profile: "verify" }), "harness_not_ready", 'harness "codex" is not ready (it needs setup)');
  });

  it("执行端这台服务没有启用（或这一版不认识）", async () => {
    const { resolve } = await setup({ file: withProfiles({ verify: { harness: "claude" } }) });
    await expectUnusable(resolve({ profile: "verify" }), "unknown_harness", 'harness "claude" is not known');
  });

  it("模型不再被用户开放", async () => {
    const { resolve } = await setup({ file: withProfiles({ verify: VERIFY }, { codex: { allowedModels: ["m-fast"] } }) });
    await expectUnusable(resolve({ profile: "verify" }), "model_not_open", 'model "m-big" is not open for harness "codex" (open: m-fast)');
  });

  it("强度被用户收窄、角色固定的强度不在其中", async () => {
    const { resolve } = await setup({ file: withProfiles({ verify: VERIFY }, { codex: { allowedEfforts: { "m-big": ["low"] } } }) });
    await expectUnusable(resolve({ profile: "verify" }), "effort_not_open", 'effort "high" is not allowed for model "m-big" (allowed: low)');
  });

  it("执行端落实不了角色要求的访问权限", async () => {
    const enforced = { level: "enforced", mechanism: "test" } as const;
    const { resolve } = await setup({ file: withProfiles({ verify: VERIFY }), codex: { access: { read_only: null, full: enforced } } });
    await expectUnusable(resolve({ profile: "verify" }), "access_unsupported", 'harness "codex" cannot run access level "read_only" (it supports: full)');
  });

  it("有显式取值时，显式的盖过角色里用不了的那一项，就能用（用户在设置里做的取舍并没有被绕过：显式值仍由 manager 照常把关）", async () => {
    const { resolve } = await setup({ file: withProfiles({ verify: VERIFY }, { codex: { allowedModels: ["m-fast"] } }) });
    const result = await resolve({ profile: "verify", model: "m-fast" });
    expect(result).toMatchObject({ harness: "codex", model: "m-fast", access: "read_only" });
    // 角色的强度属于 m-big，换了模型就不继承。
    expect(result.effort).toBeUndefined();
  });

  it("换一个执行端：角色原来执行端的问题与这次无关", async () => {
    const { resolve } = await setup({ file: withProfiles({ verify: VERIFY }), codex: { status: "unavailable" } });
    const result = await resolve({ profile: "verify", harness: "pi" });
    expect(result.harness).toBe("pi");
  });
});

describe("不是角色的错，就不在这里拦：交给 manager 给出同一套标准错误", () => {
  it("角色没固定模型，而用户一个模型都没开放：这里放行，manager 随后以 model_not_allowed 拒绝", async () => {
    const { resolve, env } = await setup({ file: withProfiles({ scout: { harness: "codex" } }, { codex: { allowedModels: [] } }) });
    const result = await resolve({ profile: "scout" });
    expect(result.harness).toBe("codex");
    const error = await rejection(env.manager.delegate({ harness: result.harness, task: "x", cwd: env.cwd, origin: testOrigin() }));
    expect(error.code).toBe("model_not_allowed");
  });

  it("主 Agent 显式传的模型没被开放：这里放行（它不是角色里写死的），manager 照旧拒绝", async () => {
    const { resolve } = await setup({ file: withProfiles({ scout: { harness: "codex" } }, { codex: { allowedModels: ["m-fast"] } }) });
    const result = await resolve({ profile: "scout", model: "m-big" });
    expect(result).toMatchObject({ harness: "codex", model: "m-big" });
    expect(result.profile?.sources.model).toBe("explicit");
  });

  it("显式传的执行端这台服务没有：这里放行，manager 以 harness_unavailable 拒绝", async () => {
    const { resolve } = await setup({ file: withProfiles({ verify: VERIFY }) });
    const result = await resolve({ profile: "verify", harness: "claude" });
    expect(result.harness).toBe("claude");
  });
});
