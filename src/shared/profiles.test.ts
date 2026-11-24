import { describe, expect, it } from "vitest";
import {
  PROFILE_LIMIT,
  PROFILE_NAME_MAX,
  checkProfile,
  checkRequest,
  describeIssue,
  describeNameFault,
  echoOf,
  findProfile,
  issueField,
  normalizeProfileName,
  profileNameFault,
  reportProfiles,
  resolveDelegation,
  specOf,
  usableProfileNames,
  type ProfileEntry,
  type ProfileIssue,
  type ProfileSpec,
} from "./profiles";
import { TEST_CAPABILITIES } from "./testing";
import type { HarnessInfo } from "./types";

/**
 * 委派角色的共用规则（纯函数）：服务端的委派入口、MCP 的 harnesses 工具与网页的设置窗口都靠它，
 * 所以这里钉死的是三处必须一致的承诺：名字怎么算合规、显式参数怎么按字段覆盖角色、角色此刻能不能用以及为什么。
 */

const enforced = { level: "enforced", mechanism: "sandbox" } as const;
const advisory = { level: "advisory", mechanism: "prompt" } as const;

/** 两个模型：m-fast 是执行端的默认、两档；m-big 三档、默认中档。 */
function harness(id: HarnessInfo["id"] = "codex", patch: Partial<HarnessInfo> = {}): HarnessInfo {
  return {
    id,
    displayName: id,
    runtime: "native",
    status: "ready",
    models: [
      { id: "m-fast", label: "Fast", isDefault: true, efforts: ["low", "high"], defaultEffort: "low" },
      { id: "m-big", label: "Big", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    ],
    capabilities: TEST_CAPABILITIES,
    access: { read_only: enforced, full: enforced },
    checkedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

describe("名字", () => {
  it("规范化：去掉首尾空白、转小写（查找时对大小写宽容）", () => {
    expect(normalizeProfileName("  Verify ")).toBe("verify");
    expect(normalizeProfileName("R2-D2_X")).toBe("r2-d2_x");
    expect(normalizeProfileName("")).toBe("");
  });

  it("合规：1～24 个字符，小写字母、数字、- 与 _，以字母或数字开头，不能全是数字", () => {
    for (const name of ["a", "verify", "r2-d2_x", "9lives", "a".repeat(PROFILE_NAME_MAX), "x-", "x_"]) {
      expect(profileNameFault(name), name).toBeUndefined();
    }
  });

  it("不合规各有各的原因", () => {
    expect(profileNameFault("")).toBe("empty");
    expect(profileNameFault("a".repeat(PROFILE_NAME_MAX + 1))).toBe("too_long");
    for (const name of ["Verify", "has space", "-lead", "_lead", "a.b", "角色", "a/b"]) {
      expect(profileNameFault(name), name).toBe("bad_characters");
    }
    for (const name of ["0", "2024", "007"]) expect(profileNameFault(name), name).toBe("digits_only");
  });

  it("全数字不行的原因：整数形的键在对象里永远排最前，“按创建顺序保留”就保不住了（所以带字母或符号的才行）", () => {
    expect(Object.keys({ b: 1, 10: 1, a: 1, 2: 1 })).toEqual(["2", "10", "b", "a"]);
    expect(profileNameFault("10")).toBe("digits_only");
    expect(profileNameFault("10a")).toBeUndefined();
  });

  it("每一种原因都有一句写给人看的英文，点明规则", () => {
    expect(describeNameFault("empty")).toMatch(/empty/);
    expect(describeNameFault("too_long")).toContain(String(PROFILE_NAME_MAX));
    expect(describeNameFault("bad_characters")).toMatch(/lowercase letters, digits, - and _/);
    expect(describeNameFault("digits_only")).toMatch(/digits only/);
  });

  it("上限是 20", () => {
    expect(PROFILE_LIMIT).toBe(20);
  });
});

describe("在名单里找角色", () => {
  const entries: ProfileEntry[] = [
    { name: "verify", harness: "codex" },
    { name: "Bad Name", harness: "pi", invalid: "name" },
    { name: "broken", invalid: "entry" },
    { name: "scout", harness: "pi", model: "m", effort: "low", access: "read_only" },
  ];

  it("按规范化后的名字精确匹配；无效的条目引用不到（主 Agent 敲不出那个名字，也不该用一个坏条目）", () => {
    expect(findProfile(entries, " VERIFY ")?.name).toBe("verify");
    expect(findProfile(entries, "scout")?.harness).toBe("pi");
    expect(findProfile(entries, "bad name")).toBeUndefined();
    expect(findProfile(entries, "Bad Name")).toBeUndefined();
    expect(findProfile(entries, "broken")).toBeUndefined();
    expect(findProfile(entries, "ver")).toBeUndefined();
    expect(findProfile([], "verify")).toBeUndefined();
  });

  it("可以被引用的名字保持创建顺序，不含无效条目", () => {
    expect(usableProfileNames(entries)).toEqual(["verify", "scout"]);
  });

  it("名字叫 constructor 之类也能查（不走对象属性）", () => {
    expect(findProfile([{ name: "constructor", harness: "pi" }], "Constructor")?.harness).toBe("pi");
    expect(findProfile([{ name: "tostring", harness: "pi" }], "valueof")).toBeUndefined();
  });

  it("specOf：只带条目里写了的字段；无效的条目没有可信的取值", () => {
    expect(specOf({ name: "a", harness: "codex" })).toEqual({ harness: "codex" });
    expect(specOf({ name: "a", harness: "codex", model: "m", effort: "low", access: "read_only" })).toEqual({ harness: "codex", model: "m", effort: "low", access: "read_only" });
    expect(specOf({ name: "a", harness: "codex", invalid: "name" })).toBeUndefined();
    expect(specOf({ name: "a", invalid: "entry" })).toBeUndefined();
    expect(specOf({ name: "a" })).toBeUndefined();
  });
});

describe("按字段覆盖：角色 + 显式参数 → 这次委派的实际取值", () => {
  const verify: ProfileSpec = { harness: "codex", model: "m-big", effort: "high", access: "read_only" };

  it("只给角色：四项都取角色的，来由都是 profile，没有被跳过的", () => {
    expect(resolveDelegation(verify, {})).toEqual({
      harness: "codex",
      model: "m-big",
      effort: "high",
      access: "read_only",
      sources: { harness: "profile", model: "profile", effort: "profile", access: "profile" },
      skipped: [],
    });
  });

  it("角色没写的字段就是“不固定”：来由是 default，留给现有的默认规则（模型 → 用户默认 → 执行端默认；强度 → 模型默认；访问权限 → Full Access）", () => {
    expect(resolveDelegation({ harness: "codex" }, {})).toEqual({
      harness: "codex",
      model: undefined,
      effort: undefined,
      access: undefined,
      sources: { harness: "profile", model: "default", effort: "default", access: "default" },
      skipped: [],
    });
  });

  it("没有角色（原来的用法）：显式的全部照用，来由是 explicit；和没有这项功能之前一样", () => {
    expect(resolveDelegation(undefined, { harness: "pi", model: "m", effort: "low", access: "read_only" })).toEqual({
      harness: "pi",
      model: "m",
      effort: "low",
      access: "read_only",
      sources: { harness: "explicit", model: "explicit", effort: "explicit", access: "explicit" },
      skipped: [],
    });
  });

  it("既没有角色也没有 harness：没得委派，返回 undefined（由调用方说“至少给 harness 或 profile”）", () => {
    expect(resolveDelegation(undefined, {})).toBeUndefined();
    expect(resolveDelegation(undefined, { model: "m", effort: "low", access: "full" })).toBeUndefined();
  });

  it("显式的强度覆盖角色的强度，并如实记下角色的那个被跳过了", () => {
    const plan = resolveDelegation(verify, { effort: "low" })!;
    expect(plan).toMatchObject({ harness: "codex", model: "m-big", effort: "low", access: "read_only" });
    expect(plan.sources).toEqual({ harness: "profile", model: "profile", effort: "explicit", access: "profile" });
    expect(plan.skipped).toEqual([{ field: "effort", value: "high", why: "overridden" }]);
  });

  it("显式的访问权限覆盖角色的（角色的 read_only 只是默认，不是锁）", () => {
    const plan = resolveDelegation(verify, { access: "full" })!;
    expect(plan.access).toBe("full");
    expect(plan.sources.access).toBe("explicit");
    expect(plan.skipped).toEqual([{ field: "access", value: "read_only", why: "overridden" }]);
  });

  it("显式换了模型：角色的强度不继承（档位是按模型的），两条都记下来", () => {
    const plan = resolveDelegation(verify, { model: "m-fast" })!;
    expect(plan).toMatchObject({ harness: "codex", model: "m-fast", effort: undefined, access: "read_only" });
    expect(plan.sources).toEqual({ harness: "profile", model: "explicit", effort: "default", access: "profile" });
    expect(plan.skipped).toEqual([
      { field: "model", value: "m-big", why: "overridden" },
      { field: "effort", value: "high", why: "other_model" },
    ]);
  });

  it("显式换了模型、同时给了强度：强度用显式的", () => {
    const plan = resolveDelegation(verify, { model: "m-fast", effort: "low" })!;
    expect(plan).toMatchObject({ model: "m-fast", effort: "low" });
    expect(plan.skipped).toEqual([
      { field: "model", value: "m-big", why: "overridden" },
      { field: "effort", value: "high", why: "overridden" },
    ]);
  });

  it("显式的模型就是角色的那个：强度照常继承，不会因为主 Agent 多写了一句同样的模型名就悄悄丢掉用户定的强度", () => {
    const plan = resolveDelegation(verify, { model: "m-big" })!;
    expect(plan).toMatchObject({ model: "m-big", effort: "high" });
    expect(plan.sources).toEqual({ harness: "profile", model: "explicit", effort: "profile", access: "profile" });
    expect(plan.skipped).toEqual([]);
  });

  it("显式换了执行端：角色的模型与强度不继承（它们属于原来的执行端，绝不悄悄套到另一个执行端上），访问权限继承", () => {
    const plan = resolveDelegation(verify, { harness: "pi" })!;
    expect(plan).toMatchObject({ harness: "pi", model: undefined, effort: undefined, access: "read_only" });
    expect(plan.sources).toEqual({ harness: "explicit", model: "default", effort: "default", access: "profile" });
    expect(plan.skipped).toEqual([
      { field: "harness", value: "codex", why: "overridden" },
      { field: "model", value: "m-big", why: "other_harness" },
      { field: "effort", value: "high", why: "other_harness" },
    ]);
  });

  it("换了执行端又显式给了模型、强度、访问权限：显式的都用；被跳过的原因里，执行端不同排在最前", () => {
    const plan = resolveDelegation(verify, { harness: "pi", model: "m-x", effort: "low", access: "full" })!;
    expect(plan).toMatchObject({ harness: "pi", model: "m-x", effort: "low", access: "full" });
    expect(plan.sources).toEqual({ harness: "explicit", model: "explicit", effort: "explicit", access: "explicit" });
    expect(plan.skipped).toEqual([
      { field: "harness", value: "codex", why: "overridden" },
      { field: "model", value: "m-big", why: "other_harness" },
      { field: "effort", value: "high", why: "other_harness" },
      { field: "access", value: "read_only", why: "overridden" },
    ]);
  });

  it("显式的执行端就是角色的：和没传一样，只是来由写 explicit", () => {
    const plan = resolveDelegation(verify, { harness: "codex" })!;
    expect(plan).toMatchObject({ harness: "codex", model: "m-big", effort: "high", access: "read_only" });
    expect(plan.sources.harness).toBe("explicit");
    expect(plan.sources.model).toBe("profile");
    expect(plan.skipped).toEqual([]);
  });

  it("显式的取值恰好与角色相同：来由是 explicit，但没有什么被跳过", () => {
    const plan = resolveDelegation(verify, { effort: "high", access: "read_only" })!;
    expect(plan.sources).toMatchObject({ effort: "explicit", access: "explicit" });
    expect(plan.skipped).toEqual([]);
  });

  it("回执：带角色名与每个字段的来由；有被跳过的才带 skipped", () => {
    expect(echoOf("verify", resolveDelegation(verify, {})!)).toEqual({
      name: "verify",
      sources: { harness: "profile", model: "profile", effort: "profile", access: "profile" },
    });
    expect(echoOf("verify", resolveDelegation(verify, { effort: "low" })!)).toEqual({
      name: "verify",
      sources: { harness: "profile", model: "profile", effort: "explicit", access: "profile" },
      skipped: [{ field: "effort", value: "high", why: "overridden" }],
    });
  });
});

describe("此刻能不能用（与委派入口同一套判断）", () => {
  it("执行端就绪、模型不固定：能用，并写明此刻实际会用哪个模型与档位（执行端的默认）", () => {
    expect(checkRequest(harness(), { harness: "codex", access: "full" })).toEqual({
      usable: true,
      effective: { harness: "codex", access: "full", enforcement: "enforced", model: "m-fast", effort: "low" },
    });
  });

  it("用户指定了默认模型：模型不固定的角色实际会用它", () => {
    const check = checkRequest(harness("codex", { userDefaultModel: "m-big" }), { harness: "codex", access: "full" });
    expect(check).toMatchObject({ usable: true, effective: { model: "m-big", effort: "medium" } });
  });

  it("固定了模型与强度：就是它们", () => {
    const check = checkRequest(harness(), { harness: "codex", access: "read_only", model: "m-big", effort: "high" });
    expect(check).toEqual({ usable: true, effective: { harness: "codex", access: "read_only", enforcement: "enforced", model: "m-big", effort: "high" } });
  });

  it("执行端此刻不认识：unknown_harness", () => {
    expect(checkRequest(undefined, { harness: "ghost", access: "full" })).toEqual({ usable: false, issue: { reason: "unknown_harness", harness: "ghost" } });
  });

  it.each(["needs_setup", "unavailable", "checking"] as const)("执行端状态是 %s：harness_not_ready，带着状态", (status) => {
    expect(checkRequest(harness("codex", { status }), { harness: "codex", access: "full" })).toEqual({
      usable: false,
      issue: { reason: "harness_not_ready", harness: "codex", status },
    });
  });

  it("执行端落实不了这个访问级别：access_unsupported，并列出它能落实的", () => {
    const info = harness("codex", { access: { read_only: null, full: enforced } });
    expect(checkRequest(info, { harness: "codex", access: "read_only" })).toEqual({
      usable: false,
      issue: { reason: "access_unsupported", harness: "codex", access: "read_only", supported: ["full"] },
    });
    expect(checkRequest(harness("codex", { access: { read_only: null, full: null } }), { harness: "codex", access: "full" })).toMatchObject({
      usable: false,
      issue: { reason: "access_unsupported", supported: [] },
    });
  });

  it("只靠提示词约束（advisory）不算不能用：委派入口今天也放行，只在结果里如实标出", () => {
    const info = harness("codex", { access: { read_only: advisory, full: enforced } });
    expect(checkRequest(info, { harness: "codex", access: "read_only" })).toMatchObject({ usable: true, effective: { access: "read_only", enforcement: "advisory" } });
  });

  it("模型没被用户开放：model_not_open，带着开放的名单", () => {
    const info = harness("codex", { allowedModels: ["m-fast"] });
    expect(checkRequest(info, { harness: "codex", access: "full", model: "m-big" })).toEqual({
      usable: false,
      issue: { reason: "model_not_open", harness: "codex", model: "m-big", allowed: ["m-fast"] },
    });
    expect(checkRequest(info, { harness: "codex", access: "full", model: "m-fast" }).usable).toBe(true);
  });

  it("一个模型都没开放：no_models_open（模型不固定的角色也受影响）", () => {
    const info = harness("codex", { allowedModels: [] });
    expect(checkRequest(info, { harness: "codex", access: "full" })).toEqual({ usable: false, issue: { reason: "no_models_open", harness: "codex" } });
  });

  it("模型设置读不了：settings_unavailable，原因随之带上", () => {
    expect(checkRequest(harness("codex", { modelSettingsIssue: "unreadable_file" }), { harness: "codex", access: "full" })).toEqual({
      usable: false,
      issue: { reason: "settings_unavailable", harness: "codex", issue: "unreadable_file" },
    });
    expect(checkRequest(harness("codex", { modelSettingsIssue: "invalid_entry" }), { harness: "codex", access: "full" })).toMatchObject({
      issue: { reason: "settings_unavailable", issue: "invalid_entry" },
    });
  });

  it("强度被用户收窄、角色固定的强度不在其中：effort_not_open，带着允许的档位；不固定强度时取收窄后的默认档位", () => {
    const info = harness("codex", { allowedEfforts: { "m-big": ["low"] } });
    expect(checkRequest(info, { harness: "codex", access: "full", model: "m-big", effort: "high" })).toEqual({
      usable: false,
      issue: { reason: "effort_not_open", harness: "codex", model: "m-big", effort: "high", allowed: ["low"] },
    });
    expect(checkRequest(info, { harness: "codex", access: "full", model: "m-big" })).toMatchObject({ usable: true, effective: { model: "m-big", effort: "low" } });
  });

  it("用户限制了强度、却无从知道会落在哪个模型上：model_unverified（需要点名一个模型）", () => {
    const info = harness("codex", { models: [], allowedEfforts: { x: ["low"] } });
    expect(checkRequest(info, { harness: "codex", access: "full" })).toEqual({ usable: false, issue: { reason: "model_unverified", harness: "codex", allowed: [] } });
    expect(checkRequest(info, { harness: "codex", access: "full", model: "other" })).toEqual({
      usable: false,
      issue: { reason: "model_unverified", harness: "codex", model: "other", allowed: [] },
    });
  });

  it("判断的顺序：先看执行端在不在、就没就绪，再看访问级别，最后才是模型与强度", () => {
    const broken = harness("codex", { status: "needs_setup", access: { read_only: null, full: null }, allowedModels: [] });
    expect(checkRequest(broken, { harness: "codex", access: "full", model: "m-big" })).toMatchObject({ issue: { reason: "harness_not_ready" } });
    const noAccess = harness("codex", { access: { read_only: null, full: null }, allowedModels: [] });
    expect(checkRequest(noAccess, { harness: "codex", access: "full", model: "m-big" })).toMatchObject({ issue: { reason: "access_unsupported" } });
  });
});

describe("角色此刻能不能用", () => {
  it("无效的条目直接是“不能用”，不去猜它的内容（名字无效与整条无效分开）", () => {
    expect(checkProfile({ name: "Bad Name", harness: "codex", invalid: "name" }, harness())).toEqual({ usable: false, issue: { reason: "invalid_name" } });
    expect(checkProfile({ name: "x", invalid: "entry" }, harness())).toEqual({ usable: false, issue: { reason: "invalid_entry" } });
    expect(checkProfile({ name: "x" }, harness())).toEqual({ usable: false, issue: { reason: "invalid_entry" } });
  });

  it("访问权限没写按 Full Access 算（被委派的 Agent 一律完全访问，只读是明确要求才用的另一档）", () => {
    expect(checkProfile({ name: "x", harness: "codex" }, harness())).toMatchObject({ usable: true, effective: { access: "full" } });
    expect(checkProfile({ name: "x", harness: "codex", access: "read_only" }, harness())).toMatchObject({ usable: true, effective: { access: "read_only" } });
    const onlyFull = harness("codex", { access: { read_only: null, full: enforced } });
    expect(checkProfile({ name: "x", harness: "codex" }, onlyFull).usable).toBe(true);
    expect(checkProfile({ name: "x", harness: "codex", access: "read_only" }, onlyFull)).toMatchObject({ usable: false, issue: { reason: "access_unsupported" } });
  });

  it("角色指向的执行端此刻不存在：unknown_harness（条目照样保留，只是暂时不能用）", () => {
    expect(checkProfile({ name: "x", harness: "future-harness" }, undefined)).toEqual({ usable: false, issue: { reason: "unknown_harness", harness: "future-harness" } });
  });

  it("按角色固定的模型与强度检查", () => {
    expect(checkProfile({ name: "x", harness: "codex", model: "m-big", effort: "high" }, harness())).toMatchObject({ usable: true, effective: { model: "m-big", effort: "high" } });
    expect(checkProfile({ name: "x", harness: "codex", model: "m-big" }, harness("codex", { allowedModels: ["m-fast"] }))).toMatchObject({
      usable: false,
      issue: { reason: "model_not_open" },
    });
  });
});

describe("给读者的报告", () => {
  it("每个角色对照当前的执行端评估一遍，保持原有顺序；无效、不认识的执行端都是“不能用”", () => {
    const report = reportProfiles(
      {
        entries: [
          { name: "a", harness: "codex" },
          { name: "b", harness: "ghost" },
          { name: "c", invalid: "entry" },
          { name: "d", harness: "pi", model: "nope" },
        ],
      },
      [harness("codex"), harness("pi", { allowedModels: ["m-fast"] })],
    );
    expect(report.entries.map((entry) => [entry.name, entry.check.usable])).toEqual([
      ["a", true],
      ["b", false],
      ["c", false],
      ["d", false],
    ]);
    expect(report.entries[1]?.check).toEqual({ usable: false, issue: { reason: "unknown_harness", harness: "ghost" } });
    expect(report.entries[2]?.check).toEqual({ usable: false, issue: { reason: "invalid_entry" } });
    expect(report.entries[3]?.check).toMatchObject({ usable: false, issue: { reason: "model_not_open", model: "nope" } });
    expect(report.unavailable).toBeUndefined();
  });

  it("设置文件读不了时，“不可用”原样带出去（它不是“没有角色”）", () => {
    expect(reportProfiles({ entries: [], unavailable: "unreadable_file" }, [])).toEqual({ entries: [], unavailable: "unreadable_file" });
    expect(reportProfiles({ entries: [] }, [])).toEqual({ entries: [] });
  });
});

describe("不能用的原因", () => {
  const cases: Array<[ProfileIssue, "entry" | "harness" | "model" | "effort" | "access"]> = [
    [{ reason: "invalid_entry" }, "entry"],
    [{ reason: "invalid_name" }, "entry"],
    [{ reason: "unknown_harness", harness: "ghost" }, "harness"],
    [{ reason: "harness_not_ready", harness: "codex", status: "unavailable" }, "harness"],
    [{ reason: "access_unsupported", harness: "codex", access: "read_only", supported: ["full"] }, "access"],
    [{ reason: "settings_unavailable", harness: "codex", issue: "unreadable_file" }, "model"],
    [{ reason: "no_models_open", harness: "codex" }, "model"],
    [{ reason: "model_not_open", harness: "codex", model: "m", allowed: [] }, "model"],
    [{ reason: "model_unverified", harness: "codex", allowed: [] }, "model"],
    [{ reason: "effort_not_open", harness: "codex", model: "m", allowed: [] }, "effort"],
  ];

  it("每个原因对应角色里的哪个字段（决定出问题的是不是“角色写死的取值”）", () => {
    for (const [issue, field] of cases) expect(issueField(issue), issue.reason).toBe(field);
  });

  it("每个原因都有一句只陈述事实的英文，不带句号（由调用方接着写出路）", () => {
    for (const [issue] of cases) {
      const text = describeIssue(issue);
      expect(text.length, issue.reason).toBeGreaterThan(0);
      expect(text.endsWith("."), issue.reason).toBe(false);
    }
  });

  it("措辞点明事实：哪个执行端、什么状态、哪个模型、开放的名单", () => {
    expect(describeIssue({ reason: "invalid_entry" })).toBe("its entry in settings.json is not valid");
    expect(describeIssue({ reason: "invalid_name" })).toBe("its name in settings.json is not valid");
    expect(describeIssue({ reason: "unknown_harness", harness: "ghost" })).toContain('harness "ghost" is not known');
    expect(describeIssue({ reason: "harness_not_ready", harness: "codex", status: "needs_setup" })).toBe('harness "codex" is not ready (it needs setup)');
    expect(describeIssue({ reason: "harness_not_ready", harness: "codex", status: "unavailable" })).toContain("it is unavailable");
    expect(describeIssue({ reason: "harness_not_ready", harness: "codex", status: "checking" })).toContain("still being checked");
    expect(describeIssue({ reason: "access_unsupported", harness: "codex", access: "read_only", supported: ["full"] })).toBe(
      'harness "codex" cannot run access level "read_only" (it supports: full)',
    );
    expect(describeIssue({ reason: "access_unsupported", harness: "codex", access: "full", supported: [] })).toBe('harness "codex" cannot run access level "full"');
    expect(describeIssue({ reason: "settings_unavailable", harness: "codex", issue: "unreadable_file" })).toBe("Ensemble could not read settings.json");
    expect(describeIssue({ reason: "settings_unavailable", harness: "codex", issue: "invalid_entry" })).toContain('model settings for harness "codex" are invalid');
    expect(describeIssue({ reason: "no_models_open", harness: "codex" })).toBe('the user has not opened any model for harness "codex"');
    expect(describeIssue({ reason: "model_not_open", harness: "codex", model: "m-big", allowed: ["m-fast", "m-mid"] })).toBe(
      'model "m-big" is not open for harness "codex" (open: m-fast, m-mid)',
    );
    expect(describeIssue({ reason: "model_not_open", harness: "codex", model: "m-big", allowed: [] })).toBe('model "m-big" is not open for harness "codex"');
    expect(describeIssue({ reason: "model_unverified", harness: "codex", allowed: [] })).toContain("a model has to be named");
    expect(describeIssue({ reason: "model_unverified", harness: "codex", model: "other", allowed: ["a", "b"] })).toContain('"other" is not a model harness "codex" reports');
    expect(describeIssue({ reason: "model_unverified", harness: "codex", model: "other", allowed: ["a", "b"] })).toContain("(known models: a, b)");
    expect(describeIssue({ reason: "effort_not_open", harness: "codex", model: "m-big", effort: "high", allowed: ["low"] })).toBe(
      'effort "high" is not allowed for model "m-big" (allowed: low)',
    );
    expect(describeIssue({ reason: "effort_not_open", harness: "codex", model: "m-big", allowed: [] })).toBe('no reasoning effort is allowed for model "m-big" of harness "codex"');
  });
});
