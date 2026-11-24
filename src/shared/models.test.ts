import { describe, expect, it } from "vitest";
import type { ModelInfo } from "./types";
import { catalogDefaultModel, decideModel, defaultModelFault, effortRule, effortsLimited, resolveModelChoices } from "./models";

const model = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({ id, label: id, ...extra });
const catalog = [model("alpha"), model("beta"), model("gamma"), model("delta")];

type Policy = Parameters<typeof resolveModelChoices>[0];
const policy = (patch: Partial<Policy> = {}): Policy => ({ models: catalog, defaultModel: "beta", ...patch });

describe("没有限制时", () => {
  it("目录全部可选，默认模型照执行端的来", () => {
    const info = policy();
    const choices = resolveModelChoices(info);
    expect(choices.models.map((m) => m.id)).toEqual(["alpha", "beta", "gamma", "delta"]);
    expect(choices.defaultModel).toBe("beta");
    expect(decideModel(info, undefined)).toEqual({ ok: true, model: undefined });
  });

  it("请求什么模型就用什么，哪怕目录里没有：是否存在由执行端去判断", () => {
    expect(decideModel(policy(), "some-alias")).toEqual({ ok: true, model: "some-alias" });
  });

  it("默认模型取 defaultModel，其次取目录里标了 isDefault 的", () => {
    expect(catalogDefaultModel({ models: catalog, defaultModel: "gamma" })).toBe("gamma");
    expect(catalogDefaultModel({ models: [model("a"), model("b", { isDefault: true })] })).toBe("b");
    expect(catalogDefaultModel({ models: catalog })).toBeUndefined();
  });
});

describe("有限制时", () => {
  it("只有被开放的模型可选，顺序仍按目录而不是点选的先后", () => {
    const info = policy({ allowedModels: ["delta", "alpha"] });
    expect(resolveModelChoices(info).models.map((m) => m.id)).toEqual(["alpha", "delta"]);
  });

  it("请求被开放的模型通过；请求没开放的被拒绝，并带上可选名单", () => {
    const info = policy({ allowedModels: ["alpha", "gamma"] });
    expect(decideModel(info, "gamma")).toEqual({ ok: true, model: "gamma" });
    expect(decideModel(info, "delta")).toEqual({ ok: false, reason: "not_allowed", allowed: ["alpha", "gamma"] });
    // 目录里没有的名字同样不在名单里。
    expect(decideModel(info, "unknown")).toMatchObject({ ok: false, reason: "not_allowed" });
  });

  it("不指定模型也固定型号：默认模型被开放时用它，否则选第一个被开放的", () => {
    expect(decideModel(policy({ allowedModels: ["alpha", "beta"] }), undefined)).toEqual({ ok: true, model: "beta" });
    expect(resolveModelChoices(policy({ allowedModels: ["alpha", "beta"] })).defaultModel).toBe("beta");

    const moved = policy({ allowedModels: ["gamma", "alpha"] });
    expect(decideModel(moved, undefined)).toEqual({ ok: true, model: "alpha" });
    expect(resolveModelChoices(moved).defaultModel).toBe("alpha");
  });

  it("执行端没有默认模型时，同样退到第一个被开放的", () => {
    const info = policy({ allowedModels: ["gamma", "delta"], defaultModel: undefined });
    expect(decideModel(info, undefined)).toEqual({ ok: true, model: "gamma" });
  });

  it("一个都没开放：任何请求都被拒绝，也没有默认", () => {
    const info = policy({ allowedModels: [] });
    expect(resolveModelChoices(info)).toEqual({ kind: "empty", models: [], defaultModel: undefined });
    expect(decideModel(info, undefined)).toEqual({ ok: false, reason: "none_allowed", allowed: [] });
    expect(decideModel(info, "alpha")).toEqual({ ok: false, reason: "none_allowed", allowed: [] });
  });

  it("名单里残留的、目录里已经没有的 id 不算可选，但也不影响其余的", () => {
    const info = policy({ allowedModels: ["retired", "gamma"] });
    expect(resolveModelChoices(info).models.map((m) => m.id)).toEqual(["gamma"]);
    expect(decideModel(info, undefined)).toEqual({ ok: true, model: "gamma" });
    // 名单里全是已下线的：目录读到了而一个都对不上，等于一个都没得选。
    const gone = policy({ allowedModels: ["retired"] });
    expect(decideModel(gone, undefined)).toEqual({ ok: false, reason: "none_allowed", allowed: [] });
  });

  it("目录一时读不到（为空）时，以用户点名的为准，不把明确开放的模型判成不可用", () => {
    const info = policy({ models: [], defaultModel: undefined, allowedModels: ["alpha", "beta"] });
    expect(decideModel(info, "beta")).toEqual({ ok: true, model: "beta" });
    expect(decideModel(info, "gamma")).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(decideModel(info, undefined)).toEqual({ ok: true, model: "alpha" });
    expect(resolveModelChoices(info)).toEqual({
      kind: "restricted", defaultModel: "alpha", defaultSource: "first_open", models: [{ id: "alpha", label: "alpha" }, { id: "beta", label: "beta" }],
    });
  });

  it("设置损坏时同时阻断委派与模型展示", () => {
    const info = policy({ modelSettingsIssue: "invalid_entry" });
    expect(resolveModelChoices(info)).toEqual({ kind: "blocked", issue: "invalid_entry", models: [], defaultModel: undefined });
    expect(decideModel(info, "alpha")).toEqual({ ok: false, reason: "settings_unavailable", issue: "invalid_entry" });
  });
});

describe("推理档位", () => {
  const LEVELS = ["low", "medium", "high", "xhigh", "max", "ultra"];
  // sol：目录给了默认档位 medium；luna：只有两档，目录没说默认；plain：没有可配置的档位。
  const leveled = [model("sol", { efforts: LEVELS, defaultEffort: "medium" }), model("luna", { efforts: ["low", "high"] }), model("plain")];
  const eff = (patch: Partial<Policy> = {}): Policy => ({ models: leveled, defaultModel: "sol", ...patch });
  const efforts = (info: Policy, id: string) => resolveModelChoices(info).models.find((m) => m.id === id)?.efforts;

  it("没有记录：不收窄也不固定，请求什么档位交给执行端去判断，原来的行为不变", () => {
    const info = eff({ allowedModels: ["sol", "luna"] });
    expect(efforts(info, "sol")).toEqual(LEVELS);
    expect(decideModel(info, "sol")).toEqual({ ok: true, model: "sol" });
    expect(decideModel(info, "sol", "turbo")).toEqual({ ok: true, model: "sol", effort: "turbo" });
    expect(effortsLimited(info, "sol")).toBe(false);
    // 没有 allowedEfforts 字段的旧设置与空对象等价。
    expect(decideModel(eff({ allowedEfforts: {} }), "sol", "high")).toEqual({ ok: true, model: "sol", effort: "high" });
  });

  it("有记录：只剩被允许的档位（顺序仍按目录），请求的必须在其中，拒绝时带上可选档位", () => {
    const info = eff({ allowedEfforts: { sol: ["high", "low"] } });
    expect(efforts(info, "sol")).toEqual(["low", "high"]);
    expect(efforts(info, "luna")).toEqual(["low", "high"]);
    expect(effortsLimited(info, "sol")).toBe(true);
    expect(decideModel(info, "sol", "high")).toEqual({ ok: true, model: "sol", effort: "high" });
    expect(decideModel(info, "sol", "max")).toEqual({ ok: false, reason: "effort_not_allowed", model: "sol", allowed: ["low", "high"] });
    // 记录不会影响别的模型。
    expect(decideModel(info, "luna", "high")).toEqual({ ok: true, model: "luna", effort: "high" });
  });

  it("省略档位：先用被允许的实际默认，其次第一个被允许的；绝不回落到没授权的原生默认", () => {
    // 原生默认 medium 没被允许：固定成第一个被允许的，界面显示的默认也是它。
    const moved = eff({ allowedEfforts: { sol: ["high", "low"] } });
    expect(decideModel(moved, "sol")).toEqual({ ok: true, model: "sol", effort: "low" });
    expect(resolveModelChoices(moved).models.find((m) => m.id === "sol")?.defaultEffort).toBe("low");
    // 原生默认被允许：照用。
    expect(decideModel(eff({ allowedEfforts: { sol: ["high", "medium"] } }), "sol")).toEqual({ ok: true, model: "sol", effort: "medium" });
    // 目录没有给出默认档位：不去猜，取第一个被允许的。
    expect(decideModel(eff({ allowedEfforts: { luna: ["high"] } }), "luna")).toEqual({ ok: true, model: "luna", effort: "high" });
  });

  it("记录恰好等于目录报告的全部档位：记录照样生效，固定实际档位，只是不算收窄", () => {
    const info = eff({ allowedEfforts: { sol: LEVELS, luna: ["low", "high"] } });
    expect(effortsLimited(info, "sol")).toBe(false);
    expect(decideModel(info, "sol")).toEqual({ ok: true, model: "sol", effort: "medium" });
    expect(decideModel(info, "sol", "xhigh")).toEqual({ ok: true, model: "sol", effort: "xhigh" });
    // 目录没给默认档位：取第一个被允许的，而不是放给原生默认。
    expect(decideModel(info, "luna")).toEqual({ ok: true, model: "luna", effort: "low" });
    // 目录之后多报告了一档，用户没允许它：仍然只认记录。
    const grown = eff({ models: [model("sol", { efforts: [...LEVELS, "turbo"], defaultEffort: "turbo" })], allowedEfforts: { sol: LEVELS } });
    expect(decideModel(grown, "sol", "turbo")).toMatchObject({ ok: false, reason: "effort_not_allowed", allowed: LEVELS });
    expect(decideModel(grown, "sol")).toEqual({ ok: true, model: "sol", effort: "low" });
  });

  it("没指定模型时，档位跟着实际会用的模型走：白名单与不设限两种情况都固定下模型与档位", () => {
    const rule = { sol: ["high"] };
    expect(decideModel(eff({ allowedModels: ["sol", "luna"], allowedEfforts: rule }), undefined)).toEqual({ ok: true, model: "sol", effort: "high" });
    expect(decideModel(eff({ allowedEfforts: rule }), undefined)).toEqual({ ok: true, model: "sol", effort: "high" });
  });

  it("不设限时只要有任何档位记录，省略模型也固定实际模型——哪怕默认模型自己没有记录", () => {
    // 默认 sol 没有记录、luna 有：不固定的话，排队期间执行端默认换成 luna 就绕过了它的限制。
    const info = eff({ allowedEfforts: { luna: ["high"] } });
    expect(decideModel(info, undefined)).toEqual({ ok: true, model: "sol" });
    // 点名没有记录的模型：同样固定，档位照旧交给执行端。
    expect(decideModel(info, "plain", "turbo")).toEqual({ ok: true, model: "plain", effort: "turbo" });
    // 没有任何记录：原有行为不变，不固定模型。
    expect(decideModel(eff(), undefined)).toEqual({ ok: true, model: undefined });
    expect(decideModel(eff({ allowedEfforts: {} }), undefined)).toEqual({ ok: true, model: undefined });
  });

  it("有档位记录而默认模型不明：宁可明确拒绝，要求点名模型", () => {
    const rule = { sol: ["low"] };
    // 目录读到了，但没有任何默认。
    const noDefault = eff({ defaultModel: undefined, allowedEfforts: rule });
    expect(decideModel(noDefault, undefined)).toEqual({ ok: false, reason: "model_unverified", allowed: ["sol", "luna", "plain"] });
    expect(decideModel(noDefault, "luna")).toEqual({ ok: true, model: "luna" });
    // 目录读不到、默认也不知道。
    const unreadable = eff({ models: [], defaultModel: undefined, allowedEfforts: rule });
    expect(decideModel(unreadable, undefined)).toEqual({ ok: false, reason: "model_unverified", allowed: [] });
    // 没有记录时，仍交给执行端用它自己的默认。
    expect(decideModel(eff({ defaultModel: undefined }), undefined)).toEqual({ ok: true, model: undefined });
    // 默认模型指向目录和记录都不认识的名字，同样无从核对。
    expect(decideModel(eff({ defaultModel: "ghost", allowedEfforts: rule }), undefined)).toMatchObject({ ok: false, reason: "model_unverified" });
  });

  it("目录不认识的名字（别名）不能绕过记录：有档位记录时拒绝，没有记录时原有兼容不变", () => {
    const info = eff({ allowedEfforts: { sol: ["high"] } });
    expect(decideModel(info, "sol-latest")).toEqual({ ok: false, reason: "model_unverified", allowed: ["sol", "luna", "plain"] });
    expect(decideModel(info, "sol-latest", "low")).toMatchObject({ ok: false, reason: "model_unverified" });
    // 用户的记录点了名的 id 是认识的：按它的记录来。
    const named = eff({ allowedEfforts: { "sol-latest": ["high", "low"] } });
    expect(decideModel(named, "sol-latest")).toEqual({ ok: true, model: "sol-latest", effort: "high" });
    expect(decideModel(named, "sol-latest", "max")).toMatchObject({ ok: false, reason: "effort_not_allowed", allowed: ["high", "low"] });
    // 没有任何记录：照旧原样放行，由执行端判断。
    expect(decideModel(eff(), "sol-latest")).toEqual({ ok: true, model: "sol-latest" });
    expect(decideModel(eff({ allowedEfforts: {} }), "sol-latest", "high")).toEqual({ ok: true, model: "sol-latest", effort: "high" });
    // 白名单模式本来就只放行名单里的。
    expect(decideModel(eff({ allowedModels: ["sol"], allowedEfforts: { sol: ["high"] } }), "sol-latest")).toMatchObject({ ok: false, reason: "not_allowed" });
  });

  it("记录与目录对不上（允许的档位一个都不在目录里）：这个模型不可选，不会悄悄放开全部档位", () => {
    const stale = eff({ allowedModels: ["sol", "luna"], allowedEfforts: { luna: ["max"] } });
    expect(resolveModelChoices(stale).models.map((m) => m.id)).toEqual(["sol"]);
    expect(decideModel(stale, "luna")).toMatchObject({ ok: false, reason: "not_allowed", allowed: ["sol"] });
    // 开放的模型全都这样：等于没得选，不是“没有限制”。
    const all = eff({ allowedModels: ["luna"], allowedEfforts: { luna: ["max"] } });
    expect(resolveModelChoices(all)).toMatchObject({ kind: "empty" });
    expect(decideModel(all, undefined)).toEqual({ ok: false, reason: "none_allowed", allowed: [] });

    // 不设限时也一样：点名这个模型被拒绝；执行端默认模型是它，就换成第一个可用的并固定下来。
    const open = eff({ defaultModel: "luna", allowedEfforts: { luna: ["max"] } });
    expect(decideModel(open, "luna")).toEqual({ ok: false, reason: "effort_not_allowed", model: "luna", allowed: [] });
    expect(resolveModelChoices(open)).toMatchObject({ kind: "unrestricted", defaultModel: "sol" });
    expect(decideModel(open, undefined)).toEqual({ ok: true, model: "sol" });
    expect(resolveModelChoices(eff({ models: [leveled[1]!], defaultModel: "luna", allowedEfforts: { luna: ["max"] } }))).toMatchObject({ kind: "empty" });
  });

  it("目录读到了、但这个模型暂时不报档位：记录仍然生效，按用户明确允许的值固定，不回落到原生默认", () => {
    const info = eff({ allowedModels: ["plain", "luna"], allowedEfforts: { plain: ["medium", "low"], sol: ["low"] } });
    expect(efforts(info, "plain")).toEqual(["medium", "low"]);
    expect(effortsLimited(info, "plain")).toBe(true);
    expect(decideModel(info, "plain")).toEqual({ ok: true, model: "plain", effort: "medium" });
    expect(decideModel(info, "plain", "low")).toEqual({ ok: true, model: "plain", effort: "low" });
    expect(decideModel(info, "plain", "high")).toMatchObject({ ok: false, reason: "effort_not_allowed", allowed: ["medium", "low"] });
    // 不设限时同理。
    const open = eff({ allowedEfforts: { plain: ["low"] } });
    expect(decideModel(open, "plain")).toEqual({ ok: true, model: "plain", effort: "low" });
    expect(decideModel(open, "plain", "turbo")).toMatchObject({ ok: false, reason: "effort_not_allowed" });
    // sol 没开放：它的记录既不让它可选，也不改动别的模型。
    expect(decideModel(info, "sol")).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(efforts(info, "luna")).toEqual(["low", "high"]);
  });

  it("目录读不到时，以用户记录的档位为准，不编造目录没有给出的档位，也不放开", () => {
    const base = { models: [], defaultModel: undefined, allowedModels: ["sol", "luna"] } satisfies Partial<Policy>;
    const noRule = eff(base);
    expect(resolveModelChoices(noRule).models).toEqual([{ id: "sol", label: "sol" }, { id: "luna", label: "luna" }]);
    expect(decideModel(noRule, "sol", "turbo")).toEqual({ ok: true, model: "sol", effort: "turbo" });

    const info = eff({ ...base, allowedEfforts: { sol: ["low", "high"] } });
    expect(resolveModelChoices(info).models).toEqual([
      { id: "sol", label: "sol", efforts: ["low", "high"], defaultEffort: "low" },
      { id: "luna", label: "luna" },
    ]);
    expect(decideModel(info, "sol")).toEqual({ ok: true, model: "sol", effort: "low" });
    expect(decideModel(info, "sol", "max")).toMatchObject({ ok: false, reason: "effort_not_allowed", allowed: ["low", "high"] });
  });

  it("设置损坏时仍整体阻断；模型 id 叫 constructor 之类时不会读到对象原型", () => {
    expect(decideModel(eff({ modelSettingsIssue: "invalid_entry", allowedEfforts: { sol: ["low"] } }), "sol", "low")).toMatchObject({ reason: "settings_unavailable" });
    expect(effortRule({ sol: ["low"] }, "constructor")).toBeUndefined();
    expect(effortRule({ sol: ["low"] }, "sol")).toEqual(["low"]);
    expect(effortRule(undefined, "sol")).toBeUndefined();
  });
});

describe("用户指定的默认模型（userDefaultModel）", () => {
  const user = (userDefaultModel: string | undefined, patch: Partial<Policy> = {}): Policy => policy({ ...(userDefaultModel === undefined ? {} : { userDefaultModel }), ...patch });
  const pick = (info: Policy) => {
    const choices = resolveModelChoices(info);
    return { kind: choices.kind, model: choices.defaultModel, source: "defaultSource" in choices ? choices.defaultSource : undefined, stale: "staleDefault" in choices ? choices.staleDefault : undefined };
  };

  describe("不设限", () => {
    it("未设：沿用执行端自己的默认，行为与此前完全一致（不额外固定模型）", () => {
      expect(pick(user(undefined))).toEqual({ kind: "unrestricted", model: "beta", source: "harness", stale: undefined });
      expect(decideModel(user(undefined), undefined)).toEqual({ ok: true, model: undefined });
    });

    it("有效：目录里的任意模型都能当默认；不指定模型时固定为它", () => {
      const info = user("gamma");
      expect(pick(info)).toEqual({ kind: "unrestricted", model: "gamma", source: "user", stale: undefined });
      // 即使没有任何档位记录也要固定：否则执行端自己的默认在排队期间一变，用户的指定就落空。
      expect(decideModel(info, undefined)).toEqual({ ok: true, model: "gamma" });
    });

    it("明确写了模型就按请求走，用户的默认不改写它，也不因此拒绝执行端才认识的别名", () => {
      const info = user("gamma");
      expect(decideModel(info, "alpha")).toEqual({ ok: true, model: "alpha" });
      expect(decideModel(info, "some-alias")).toEqual({ ok: true, model: "some-alias" });
    });

    it("失效（执行端已不再提供）：退回执行端的默认，不报错，并带出失效的是哪个、为什么", () => {
      const info = user("retired");
      expect(pick(info)).toEqual({ kind: "unrestricted", model: "beta", source: "harness", stale: { id: "retired", why: "missing" } });
      expect(decideModel(info, undefined)).toEqual({ ok: true, model: undefined });
    });

    it("执行端自己没有默认时，失效的默认不会变成别的东西", () => {
      expect(pick(user("retired", { defaultModel: undefined }))).toMatchObject({ model: undefined, source: undefined, stale: { id: "retired", why: "missing" } });
    });

    it("目录读不到时无从核对：按失效处理，而不是当作有效去固定一个可能不存在的模型", () => {
      const info = user("gamma", { models: [], defaultModel: undefined });
      expect(pick(info)).toMatchObject({ kind: "unrestricted", model: undefined, stale: { id: "gamma", why: "missing" } });
    });

    it("档位设置让这个模型没有可用档位：当作没被开放", () => {
      const withEfforts = catalog.map((entry) => entry.id === "gamma" ? { ...entry, efforts: ["low", "high"] } : entry);
      const info = user("gamma", { models: withEfforts, allowedEfforts: { gamma: ["turbo"] } });
      expect(pick(info)).toMatchObject({ model: "beta", source: "harness", stale: { id: "gamma", why: "not_allowed" } });
    });

    it("有档位记录时仍按那条规则固定模型与档位", () => {
      const models = catalog.map((entry) => entry.id === "gamma" ? { ...entry, efforts: ["low", "high"], defaultEffort: "high" } : entry);
      const info = user("gamma", { models, allowedEfforts: { gamma: ["low"] } });
      expect(decideModel(info, undefined)).toEqual({ ok: true, model: "gamma", effort: "low" });
    });
  });

  describe("有限制", () => {
    it("未设：执行端的默认被开放就用它，否则第一个被开放的（与此前一致）", () => {
      expect(pick(user(undefined, { allowedModels: ["alpha", "beta"] }))).toMatchObject({ kind: "restricted", model: "beta", source: "harness" });
      expect(pick(user(undefined, { allowedModels: ["gamma", "alpha"] }))).toMatchObject({ model: "alpha", source: "first_open" });
    });

    it("有效：在名单里就用它；不指定模型时固定为它", () => {
      const info = user("gamma", { allowedModels: ["alpha", "gamma"] });
      expect(pick(info)).toEqual({ kind: "restricted", model: "gamma", source: "user", stale: undefined });
      expect(decideModel(info, undefined)).toEqual({ ok: true, model: "gamma" });
      // 其余的模型仍照名单校验。
      expect(decideModel(info, "delta")).toMatchObject({ ok: false, reason: "not_allowed" });
    });

    it("失效（没在名单里）：退回现有规则，并说明是因为没被开放", () => {
      const info = user("delta", { allowedModels: ["alpha", "beta"] });
      expect(pick(info)).toEqual({ kind: "restricted", model: "beta", source: "harness", stale: { id: "delta", why: "not_allowed" } });
      expect(decideModel(info, undefined)).toEqual({ ok: true, model: "beta" });
      expect(decideModel(info, "delta")).toMatchObject({ ok: false, reason: "not_allowed" });
    });

    it("失效（在名单里，但目录里已经没有）：说明是执行端不再提供", () => {
      const info = user("retired", { allowedModels: ["retired", "gamma"] });
      expect(pick(info)).toMatchObject({ model: "gamma", source: "first_open", stale: { id: "retired", why: "missing" } });
    });

    it("目录一时读不到时，以名单里用户点名的为准：指定的默认仍然有效", () => {
      const info = user("beta", { models: [], defaultModel: undefined, allowedModels: ["alpha", "beta"] });
      expect(pick(info)).toMatchObject({ model: "beta", source: "user", stale: undefined });
      expect(decideModel(info, undefined)).toEqual({ ok: true, model: "beta" });
    });
  });

  it("全不选（空名单）：没有默认，也不报告“默认失效”——真正的问题是没得选", () => {
    const info = user("gamma", { allowedModels: [] });
    expect(resolveModelChoices(info)).toEqual({ kind: "empty", models: [], defaultModel: undefined });
    expect(decideModel(info, undefined)).toEqual({ ok: false, reason: "none_allowed", allowed: [] });
  });

  it("设置损坏时整体阻断，不看用户指定的默认", () => {
    const info = user("gamma", { modelSettingsIssue: "invalid_entry" });
    expect(resolveModelChoices(info)).toEqual({ kind: "blocked", issue: "invalid_entry", models: [], defaultModel: undefined });
    expect(decideModel(info, undefined)).toMatchObject({ ok: false, reason: "settings_unavailable" });
  });

  describe("defaultModelFault（保存时的校验）", () => {
    const ids = catalog.map((entry) => entry.id);
    it("有限制：必须在名单里", () => {
      expect(defaultModelFault(ids, ["alpha", "gamma"], "gamma")).toBeUndefined();
      expect(defaultModelFault(ids, ["alpha", "gamma"], "delta")).toBe("not_allowed");
      expect(defaultModelFault(ids, [], "alpha")).toBe("not_allowed");
    });

    it("不设限：必须是目录里的模型", () => {
      expect(defaultModelFault(ids, null, "delta")).toBeUndefined();
      expect(defaultModelFault(ids, null, "retired")).toBe("unknown");
      expect(defaultModelFault([], null, "alpha")).toBe("unknown");
    });
  });
});
