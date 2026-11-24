import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROFILE_NAME_MAX, type ProfileIssue, type ProfilesView } from "@shared/profiles";
import type { ProfilesResponse } from "@shared/protocol";
import { TEST_CAPABILITIES } from "@shared/testing";
import type { HarnessId, HarnessInfo, ModelInfo } from "@shared/types";
import { ApiError, api } from "./api";
import { store } from "./app";
import { bindT } from "./i18n";
import {
  DEFAULT_VALUE,
  accessOptions,
  checkName,
  createRole,
  effortLevels,
  effortOptions,
  harnessOptions,
  issueText,
  modelOptions,
  nameProblemText,
  removeRole,
  renameRole,
  sameFields,
  saveRole,
  specFrom,
  withAccess,
  withEffort,
  withHarness,
  withModel,
  type RoleFields,
} from "./profiles";

/**
 * 设置窗口“角色”分区的逻辑：一行里的字段怎么联动、下拉框的选项从哪来、名称怎么校验、不可用的原因怎么说、写入怎么排队。
 * 规则本身（此刻能不能用、名称规则、模型与档位）在 shared 里各有测试；这里只测网页自己的那一层。
 */

const zh = bindT("zh");
const en = bindT("en");

const MODELS: ModelInfo[] = [
  { id: "m-fast", label: "Fast", isDefault: true, efforts: ["low", "high"], defaultEffort: "low" },
  { id: "m-big", label: "Big", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
  { id: "m-plain", label: "Plain" },
];

const info = (id: HarnessId = "codex", patch: Partial<HarnessInfo> = {}): HarnessInfo => ({
  id,
  displayName: id,
  runtime: "native",
  status: "ready",
  models: MODELS,
  capabilities: TEST_CAPABILITIES,
  access: { read_only: { level: "enforced", mechanism: "test" }, full: { level: "enforced", mechanism: "test" } },
  checkedAt: "2026-01-01T00:00:00.000Z",
  ...patch,
});

describe("RoleFields：取值的取舍", () => {
  it("specFrom：没选执行端就存不了；只留四个字段、不带 undefined，整行（含名称、invalid）传进来也不会夹带多余的东西", () => {
    expect(specFrom({})).toBeUndefined();
    expect(specFrom({ model: "m-big", access: "full" })).toBeUndefined();
    expect(specFrom({ harness: "pi" })).toStrictEqual({ harness: "pi" });
    expect(specFrom({ harness: "pi", model: "m-big", effort: undefined, access: "full" })).toStrictEqual({ harness: "pi", model: "m-big", access: "full" });
    expect(specFrom({ harness: "pi", name: "verify", invalid: "name" } as RoleFields)).toStrictEqual({ harness: "pi" });
  });

  it("sameFields：逐项比较四个字段，没写与 undefined 是同一回事", () => {
    expect(sameFields({}, {})).toBe(true);
    expect(sameFields({ harness: "pi" }, { harness: "pi", model: undefined })).toBe(true);
    expect(sameFields({ harness: "pi", model: "a" }, { harness: "pi", model: "b" })).toBe(false);
    expect(sameFields({ harness: "pi" }, { harness: "codex" })).toBe(false);
    expect(sameFields({ harness: "pi", access: "full" }, { harness: "pi" })).toBe(false);
  });
});

describe("字段联动", () => {
  const full: RoleFields = { harness: "codex", model: "m-big", effort: "high", access: "read_only" };

  it("换执行端：模型与推理强度属于原来的执行端，不带过去；访问权限是通用的，带着", () => {
    expect(withHarness(full, "pi")).toStrictEqual({ harness: "pi", access: "read_only" });
    expect(withHarness({ harness: "codex", model: "m-big" }, "pi")).toStrictEqual({ harness: "pi" });
    // 新增的草稿：还没有执行端，选一个就是它。
    expect(withHarness({}, "pi")).toStrictEqual({ harness: "pi" });
  });

  it("“换”成同一个执行端什么也不变（也不夹带整行里别的字段）", () => {
    expect(withHarness(full, "codex")).toStrictEqual(full);
    expect(withHarness({ harness: "codex", name: "x", invalid: "entry" } as RoleFields, "codex")).toStrictEqual({ harness: "codex" });
  });

  it("换模型：新模型也有这一档推理强度就保留，没有就回到默认", () => {
    const codex = info();
    // m-fast 有 low / high：low 保留，medium 不在其中。
    expect(withModel({ harness: "codex", model: "m-big", effort: "low", access: "full" }, codex, "m-fast")).toStrictEqual({ harness: "codex", model: "m-fast", effort: "low", access: "full" });
    expect(withModel({ harness: "codex", model: "m-big", effort: "medium", access: "full" }, codex, "m-fast")).toStrictEqual({ harness: "codex", model: "m-fast", access: "full" });
    // 完全没有档位的模型。
    expect(withModel(full, codex, "m-plain")).toStrictEqual({ harness: "codex", model: "m-plain", access: "read_only" });
    // 之前没有固定模型：选一个，强度仍按它的档位检查。
    expect(withModel({ harness: "codex", effort: "low" }, codex, "m-big")).toStrictEqual({ harness: "codex", model: "m-big", effort: "low" });
  });

  it("换回“默认”模型：强度按此刻默认模型的档位检查", () => {
    const codex = info();
    // 默认模型是 m-fast（low / high）。
    expect(withModel(full, codex, undefined)).toStrictEqual({ harness: "codex", effort: "high", access: "read_only" });
    expect(withModel({ harness: "codex", model: "m-big", effort: "medium" }, codex, undefined)).toStrictEqual({ harness: "codex" });
  });

  it("换成同一个模型什么也不变；执行端未知时没有档位可保留", () => {
    expect(withModel(full, info(), "m-big")).toStrictEqual(full);
    expect(withModel(full, undefined, "m-fast")).toStrictEqual({ harness: "codex", model: "m-fast", access: "read_only" });
  });

  it("推理强度与访问权限：给了就覆盖，undefined 就是“默认”（去掉这一项）", () => {
    expect(withEffort({ harness: "pi" }, "high")).toStrictEqual({ harness: "pi", effort: "high" });
    expect(withEffort({ harness: "pi", effort: "low" }, "high")).toStrictEqual({ harness: "pi", effort: "high" });
    expect(withEffort({ harness: "pi", effort: "low" }, undefined)).toStrictEqual({ harness: "pi" });
    expect(withAccess({ harness: "pi" }, "read_only")).toStrictEqual({ harness: "pi", access: "read_only" });
    expect(withAccess({ harness: "pi", access: "full" }, undefined)).toStrictEqual({ harness: "pi" });
  });
});

describe("effortLevels：某个模型此刻可选的推理强度", () => {
  it("执行端未知：没有可选项", () => {
    expect(effortLevels(undefined, "m-big")).toEqual({ levels: [], fallback: undefined });
  });

  it("点名的模型取它自己的档位与默认档位；不点名就看此刻的默认模型；不报档位的模型是空", () => {
    const codex = info();
    expect(effortLevels(codex, "m-big")).toEqual({ levels: ["low", "medium", "high"], fallback: "medium" });
    expect(effortLevels(codex, undefined)).toEqual({ levels: ["low", "high"], fallback: "low" });
    expect(effortLevels(codex, "m-plain")).toEqual({ levels: [], fallback: undefined });
    expect(effortLevels(codex, "no-such-model")).toEqual({ levels: [], fallback: undefined });
  });

  it("已按用户在“执行端”里的取舍收窄：只剩允许的档位，默认档位不在其中就取第一个", () => {
    expect(effortLevels(info("codex", { allowedEfforts: { "m-big": ["high"] } }), "m-big")).toEqual({ levels: ["high"], fallback: "high" });
    // 没有被收窄的模型不受影响。
    expect(effortLevels(info("codex", { allowedEfforts: { "m-big": ["high"] } }), "m-fast")).toEqual({ levels: ["low", "high"], fallback: "low" });
  });

  it("没被开放的模型没有可选档位；不点名时默认模型退到第一个被开放的", () => {
    const restricted = info("codex", { allowedModels: ["m-big"] });
    expect(effortLevels(restricted, "m-fast")).toEqual({ levels: [], fallback: undefined });
    expect(effortLevels(restricted, undefined)).toEqual({ levels: ["low", "medium", "high"], fallback: "medium" });
  });
});

describe("下拉框的选项", () => {
  describe("执行端", () => {
    const codex = info("codex");
    const pi = info("pi", { status: "needs_setup" });

    it("全部执行端都列出来，没就绪的注明状态（角色可以先建好）；还没选的有一个不可选的提示项", () => {
      expect(harnessOptions([codex, pi], undefined, zh)).toEqual([
        { value: DEFAULT_VALUE, label: "选择执行端", disabled: true },
        { value: "codex", label: "Codex" },
        { value: "pi", label: "Pi · 需要设置" },
      ]);
    });

    it("已经选了就没有提示项", () => {
      expect(harnessOptions([codex, pi], "pi", zh).map((option) => option.value)).toEqual(["codex", "pi"]);
    });

    it("角色里存着的、这一版不认识的执行端也要在，下拉框才与存的值对得上", () => {
      expect(harnessOptions([codex], "quantum", zh)).toEqual([
        { value: "codex", label: "Codex" },
        { value: "quantum", label: "quantum · 未知" },
      ]);
      expect(harnessOptions([codex], "quantum", en).at(-1)).toEqual({ value: "quantum", label: "quantum · Unknown" });
    });
  });

  describe("模型", () => {
    it("“默认”一项写明此刻实际会用哪个，然后是开放的模型", () => {
      expect(modelOptions(info(), undefined, zh)).toEqual([
        { value: DEFAULT_VALUE, label: "默认 · Fast" },
        { value: "m-fast", label: "Fast" },
        { value: "m-big", label: "Big" },
        { value: "m-plain", label: "Plain" },
      ]);
    });

    it("用户在“执行端”里指定了默认、或收窄了名单：“默认”写的是实际会用的那个，只列开放的", () => {
      expect(modelOptions(info("codex", { userDefaultModel: "m-big" }), undefined, zh)[0]).toEqual({ value: DEFAULT_VALUE, label: "默认 · Big" });
      expect(modelOptions(info("codex", { allowedModels: ["m-big", "m-plain"] }), undefined, zh)).toEqual([
        { value: DEFAULT_VALUE, label: "默认 · Big" },
        { value: "m-big", label: "Big" },
        { value: "m-plain", label: "Plain" },
      ]);
    });

    it("角色里存着的模型已经不在开放名单里：仍保留一项（用目录里的名字），下拉框才与存的值对得上", () => {
      const restricted = info("codex", { allowedModels: ["m-big"] });
      expect(modelOptions(restricted, "m-fast", zh).at(-1)).toEqual({ value: "m-fast", label: "Fast" });
      // 目录里也没有：只能写 id。
      expect(modelOptions(info(), "gone", zh).at(-1)).toEqual({ value: "gone", label: "gone" });
    });

    it("执行端未知、或模型设置读不了：只有“默认”（不编一个模型名）", () => {
      expect(modelOptions(undefined, undefined, zh)).toEqual([{ value: DEFAULT_VALUE, label: "默认" }]);
      expect(modelOptions(info("codex", { modelSettingsIssue: "unreadable_file" }), undefined, zh)).toEqual([{ value: DEFAULT_VALUE, label: "默认" }]);
      expect(modelOptions(undefined, "x", zh)).toEqual([
        { value: DEFAULT_VALUE, label: "默认" },
        { value: "x", label: "x" },
      ]);
    });
  });

  describe("推理强度", () => {
    it("该模型此刻可选的档位；不固定模型时看默认模型", () => {
      expect(effortOptions(info(), "m-big", undefined, zh)).toEqual([
        { value: DEFAULT_VALUE, label: "默认" },
        { value: "low", label: "低" },
        { value: "medium", label: "中" },
        { value: "high", label: "高" },
      ]);
      expect(effortOptions(info(), undefined, undefined, zh).map((option) => option.value)).toEqual([DEFAULT_VALUE, "low", "high"]);
    });

    it("模型没有档位（或执行端未知）：只有“默认”", () => {
      expect(effortOptions(info(), "m-plain", undefined, zh)).toEqual([{ value: DEFAULT_VALUE, label: "默认" }]);
      expect(effortOptions(undefined, undefined, undefined, zh)).toEqual([{ value: DEFAULT_VALUE, label: "默认" }]);
    });

    it("角色里存着、现在不被允许的档位仍保留一项；不认识的档位名原样显示", () => {
      expect(effortOptions(info(), "m-fast", "medium", zh).at(-1)).toEqual({ value: "medium", label: "中" });
      expect(effortOptions(info(), "m-fast", "turbo", zh).at(-1)).toEqual({ value: "turbo", label: "turbo" });
    });
  });

  describe("访问权限", () => {
    it("两个级别都能落实：都可选，另有“默认”（不固定＝委派时是完全访问）", () => {
      expect(accessOptions(info(), undefined, zh)).toEqual([
        { value: DEFAULT_VALUE, label: "默认" },
        { value: "read_only", label: "只读", disabled: false },
        { value: "full", label: "完全访问", disabled: false },
      ]);
    });

    it("执行端落实不了的级别注明“不支持”并且不能新选；角色里已经存着的那个仍可见、不禁用", () => {
      const noSandbox = info("codex", { access: { read_only: null, full: { level: "none", mechanism: "test" } } });
      expect(accessOptions(noSandbox, undefined, zh)[1]).toEqual({ value: "read_only", label: "只读 · 不支持", disabled: true });
      expect(accessOptions(noSandbox, "read_only", zh)[1]).toEqual({ value: "read_only", label: "只读 · 不支持", disabled: false });
      expect(accessOptions(noSandbox, undefined, zh)[2]).toEqual({ value: "full", label: "完全访问", disabled: false });
    });

    it("执行端未知：不替它判断，都可选", () => {
      expect(accessOptions(undefined, undefined, zh).every((option) => option.disabled !== true)).toBe(true);
    });
  });
});

describe("名称", () => {
  it("checkName：去空白、转小写，存下来的就是这个；合格就没有问题", () => {
    expect(checkName("  Verify ", [])).toEqual({ name: "verify", problem: undefined });
    expect(checkName("a-b_c9", [])).toEqual({ name: "a-b_c9", problem: undefined });
    expect(checkName("9a", []).problem).toBeUndefined();
    expect(checkName("a".repeat(PROFILE_NAME_MAX), []).problem).toBeUndefined();
  });

  it("checkName：各种不合格", () => {
    expect(checkName("", []).problem).toBe("empty");
    expect(checkName("   ", []).problem).toBe("empty");
    expect(checkName("a".repeat(PROFILE_NAME_MAX + 1), []).problem).toBe("too_long");
    expect(checkName("has space", []).problem).toBe("bad_characters");
    expect(checkName("-x", []).problem).toBe("bad_characters");
    expect(checkName("_x", []).problem).toBe("bad_characters");
    expect(checkName("名字", []).problem).toBe("bad_characters");
    expect(checkName("007", []).problem).toBe("digits_only");
  });

  it("checkName：与别的角色重名（规范化之后比较）；格式问题排在重名前面", () => {
    expect(checkName("Verify", ["verify"])).toEqual({ name: "verify", problem: "duplicate" });
    expect(checkName("other", ["verify"]).problem).toBeUndefined();
    expect(checkName("A B", ["a b"]).problem).toBe("bad_characters");
  });

  it("nameProblemText：每种问题一句话，两种语言", () => {
    expect(nameProblemText("empty", "", zh)).toBe("名称不能为空。");
    expect(nameProblemText("too_long", "x", zh)).toBe(`名称最多 ${PROFILE_NAME_MAX} 个字符。`);
    expect(nameProblemText("bad_characters", "X Y", zh)).toBe("名称只能用小写字母、数字、- 和 _，并以字母或数字开头。");
    expect(nameProblemText("digits_only", "007", zh)).toBe("名称不能全是数字：至少要有一个字母、- 或 _。");
    expect(nameProblemText("duplicate", "verify", zh)).toBe("已经有一个叫「verify」的角色。");
    expect(nameProblemText("duplicate", "verify", en)).toContain("verify");
    expect(nameProblemText("duplicate", "verify", en)).toContain("already exists");
    expect(nameProblemText("too_long", "x", en)).toContain(String(PROFILE_NAME_MAX));
  });
});

describe("issueText：角色此刻不能用的原因", () => {
  it("每种原因一句话，写明是哪个执行端、哪个模型，并给出出路", () => {
    const cases: Array<[ProfileIssue, string]> = [
      [{ reason: "invalid_entry" }, "settings.json 里这个角色的内容读不出来。重新选一个执行端，或删除这个角色。"],
      [{ reason: "invalid_name" }, "settings.json 里这个角色的名称不合规，主 Agent 引用不到它。改个名称即可。"],
      [{ reason: "unknown_harness", harness: "quantum" }, "这一版 Ensemble 不认识执行端「quantum」。换一个执行端，或删除这个角色。"],
      [{ reason: "harness_not_ready", harness: "pi", status: "needs_setup" }, "Pi：需要设置。这个角色暂时不能用。"],
      [{ reason: "access_unsupported", harness: "codex", access: "read_only", supported: ["full"] }, "Codex 无法落实访问权限「只读」。改一下访问权限，或换一个执行端。"],
      [{ reason: "settings_unavailable", harness: "codex", issue: "unreadable_file" }, "模型设置不可用，没法确认 Codex 开放了哪些模型。见「执行端」。"],
      [{ reason: "no_models_open", harness: "codex" }, "Codex 没有开放任何模型。到「执行端」里勾选，或换一个执行端。"],
      [{ reason: "model_not_open", harness: "codex", model: "m-big", allowed: ["m-fast"] }, "模型「m-big」在 Codex 上没有开放。"],
      [{ reason: "model_unverified", harness: "codex", allowed: [] }, "Codex 限制了推理强度，却没法确定它默认用哪个模型。请为这个角色指定模型。"],
      [{ reason: "model_unverified", harness: "codex", model: "gone", allowed: [] }, "「gone」不是 Codex 报告的模型，而它的推理强度受限，没法确认能不能用。"],
      [{ reason: "effort_not_open", harness: "codex", model: "m-big", effort: "xhigh", allowed: ["low"] }, "推理强度「极高」在模型「m-big」上不被允许。"],
      [{ reason: "effort_not_open", harness: "codex", model: "m-big", allowed: [] }, "模型「m-big」没有可用的推理强度。"],
    ];
    for (const [issue, text] of cases) expect(issueText(issue, zh), issue.reason).toBe(text);
  });

  it("英文版也都有（没有漏掉的词条键、没有留下占位符）", () => {
    const issues: ProfileIssue[] = [
      { reason: "invalid_entry" },
      { reason: "invalid_name" },
      { reason: "unknown_harness", harness: "quantum" },
      { reason: "harness_not_ready", harness: "pi", status: "unavailable" },
      { reason: "access_unsupported", harness: "codex", access: "full", supported: [] },
      { reason: "settings_unavailable", harness: "codex", issue: "unreadable_file" },
      { reason: "no_models_open", harness: "codex" },
      { reason: "model_not_open", harness: "codex", model: "m-big", allowed: [] },
      { reason: "model_unverified", harness: "codex", allowed: [] },
      { reason: "model_unverified", harness: "codex", model: "gone", allowed: [] },
      { reason: "effort_not_open", harness: "codex", model: "m-big", effort: "high", allowed: ["low"] },
      { reason: "effort_not_open", harness: "codex", model: "m-big", allowed: [] },
    ];
    for (const issue of issues) {
      const text = issueText(issue, en);
      expect(text, issue.reason).not.toMatch(/\{[a-z]+\}/);
      expect(text, issue.reason).not.toMatch(/^profiles\./);
      expect(text.length, issue.reason).toBeGreaterThan(10);
    }
  });
});

describe("写入：串行，失败有提示", () => {
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  const view = (names: string[]): ProfilesView => ({ entries: names.map((name) => ({ name, harness: "pi" })) });
  const reply = (names: string[]): ProfilesResponse => ({ profiles: view(names) });

  beforeEach(() => {
    store.set({ lang: "zh", toasts: [], profiles: { entries: [] } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store.set({ toasts: [] });
  });

  it("几次写入按调用的顺序一个接一个发给服务端：前一个的回执回来之前，后一个不发", async () => {
    const calls: string[] = [];
    const releases: Array<() => void> = [];
    vi.spyOn(api, "putProfile").mockImplementation(
      (name) =>
        new Promise<ProfilesResponse>((resolve) => {
          calls.push(`put ${name}`);
          releases.push(() => resolve(reply([name])));
        }),
    );
    vi.spyOn(api, "removeProfile").mockImplementation(async (name) => {
      calls.push(`remove ${name}`);
      return reply([]);
    });

    const first = saveRole("a", { harness: "pi" });
    const second = removeRole("b");
    await settle();
    expect(calls).toEqual(["put a"]);

    releases[0]!();
    await first;
    await second;
    expect(calls).toEqual(["put a", "remove b"]);
  });

  it("一次写入失败：提示一句（带本地化的原因），返回 undefined，后面的写入照常发", async () => {
    vi.spyOn(api, "putProfile").mockRejectedValueOnce(new ApiError("invalid_request", "boom", 400));
    const removed = vi.spyOn(api, "removeProfile").mockResolvedValue(reply([]));

    expect(await saveRole("a", { harness: "pi" })).toBeUndefined();
    expect(store.get().toasts.at(-1)?.text).toBe("没能保存角色：请求无效（boom）");

    expect(await removeRole("b")).toEqual(view([]));
    expect(removed).toHaveBeenCalledWith("b");
  });

  it("删除失败的提示是“没能删除角色”", async () => {
    vi.spyOn(api, "removeProfile").mockRejectedValueOnce(new ApiError("not_found", "", 404));
    expect(await removeRole("a")).toBeUndefined();
    expect(store.get().toasts.at(-1)?.text).toContain("没能删除角色");
  });

  it("各个写入对应的请求：新增带 create（名称被占用就拒绝），整条改写不带，改名与删除各一个", async () => {
    const put = vi.spyOn(api, "putProfile").mockResolvedValue(reply(["a"]));
    const rename = vi.spyOn(api, "renameProfile").mockResolvedValue(reply(["b"]));
    const remove = vi.spyOn(api, "removeProfile").mockResolvedValue(reply([]));

    await createRole("a", { harness: "pi", model: "m-big" });
    expect(put).toHaveBeenLastCalledWith("a", { harness: "pi", model: "m-big", create: true });
    await saveRole("a", { harness: "codex" });
    expect(put).toHaveBeenLastCalledWith("a", { harness: "codex" });
    await renameRole("a", "b");
    expect(rename).toHaveBeenLastCalledWith("a", "b");
    await removeRole("b");
    expect(remove).toHaveBeenLastCalledWith("b");
  });

  it("成功时返回生效后的整张角色表，但不替调用方放进 store（新增与改名要先记下这一行的身份再放）", async () => {
    vi.spyOn(api, "putProfile").mockResolvedValue(reply(["a", "b"]));
    expect(await saveRole("a", { harness: "pi" })).toEqual(view(["a", "b"]));
    expect(store.get().profiles).toEqual({ entries: [] });
  });
});
