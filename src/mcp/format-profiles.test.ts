import { describe, expect, it } from "vitest";
import type { FieldSource, ProfileCheck, ProfileEcho, ProfileEffective, ProfileField, ProfileIssue, ProfileReportEntry, ProfilesReport, SkippedField } from "@shared/profiles";
import { profilesData, renderProfiles, renderRoleEcho } from "./format-profiles";

/**
 * 角色在 MCP 输出里的文字：`delegate` 回执里的那一行、`harnesses` 里的角色块、结构化结果里的 `profiles`。
 * 都是纯函数，这里只测“写成什么字”；它们在工具里怎么被用上见 bridge.profiles.test.ts。
 */

const sources = (patch: Partial<Record<ProfileField, FieldSource>> = {}): Record<ProfileField, FieldSource> => ({
  harness: "profile",
  model: "profile",
  effort: "profile",
  access: "profile",
  ...patch,
});

const effective = (patch: Partial<ProfileEffective> = {}): ProfileEffective => ({ harness: "codex", access: "full", enforcement: "enforced", ...patch });
const usable = (patch: Partial<ProfileEffective> = {}): ProfileCheck => ({ usable: true, effective: effective(patch) });
const refused = (issue: ProfileIssue): ProfileCheck => ({ usable: false, issue });
const report = (...entries: ProfileReportEntry[]): ProfilesReport => ({ entries });

/** 一个角色块里除表头之外的行。 */
const lines = (text: string | undefined): string[] => (text ?? "").split("\n").slice(1);

describe("renderRoleEcho：delegate 回执里的角色", () => {
  it("全部取自角色：只有一行，字段按 harness、model、effort、access 的固定顺序合并，句末有句号", () => {
    expect(renderRoleEcho({ name: "verify", sources: sources() })).toEqual(['    role "verify": harness, model, effort, access from the role.']);
  });

  it("按来由分组，组的顺序固定为：角色、你的调用、默认", () => {
    const echo: ProfileEcho = { name: "x", sources: sources({ model: "explicit", effort: "default" }) };
    expect(renderRoleEcho(echo)).toEqual(['    role "x": harness, access from the role; model from your call; effort by default.']);
  });

  it("没有字段取自角色时不出现“from the role”这一组", () => {
    const echo: ProfileEcho = { name: "x", sources: { harness: "explicit", model: "default", effort: "default", access: "default" } };
    expect(renderRoleEcho(echo)).toEqual(['    role "x": harness from your call; model, effort, access by default.']);
  });

  it("角色里写了、这次没有用上的取值另起一行，逐项说明为什么没有用上", () => {
    const skipped: SkippedField[] = [
      { field: "harness", value: "codex", why: "overridden" },
      { field: "model", value: "m-big", why: "other_harness" },
      { field: "effort", value: "high", why: "other_model" },
      { field: "access", value: "read_only", why: "overridden" },
    ];
    const out = renderRoleEcho({ name: "verify", sources: sources({ harness: "explicit", model: "default", effort: "default", access: "explicit" }), skipped });
    expect(out).toHaveLength(2);
    expect(out[1]).toBe(
      '    not applied from the role: harness "codex" (you passed another harness); ' +
        'model "m-big" (it belongs to the role\'s harness, not the one you passed); ' +
        'effort "high" (it belongs to the role\'s model, not the one you passed); ' +
        'access "read_only" (you passed another access level).',
    );
  });

  it("“被你覆盖了”的说法随字段变：model 与 effort 说 another model / another effort，access 说 another access level", () => {
    const out = renderRoleEcho({
      name: "verify",
      sources: sources({ model: "explicit", effort: "explicit", access: "explicit" }),
      skipped: [
        { field: "model", value: "m-big", why: "overridden" },
        { field: "effort", value: "high", why: "overridden" },
        { field: "access", value: "read_only", why: "overridden" },
      ],
    });
    expect(out[1]).toBe('    not applied from the role: model "m-big" (you passed another model); effort "high" (you passed another effort); access "read_only" (you passed another access level).');
  });

  it("skipped 是空数组与没有这个字段一样：不多出一行", () => {
    expect(renderRoleEcho({ name: "x", sources: sources(), skipped: [] })).toHaveLength(1);
    expect(renderRoleEcho({ name: "x", sources: sources() })).toHaveLength(1);
  });
});

describe("renderProfiles：harnesses 里的角色块", () => {
  it("用户没有定义角色：什么也不输出（不写“没有角色”：每个回合都会进上下文的字，没有就一个都不该有）", () => {
    expect(renderProfiles({ entries: [] })).toBeUndefined();
  });

  it("设置文件读不了：说“角色此刻不可用”并给出出路——它不是“没有角色”", () => {
    const text = renderProfiles({ entries: [], unavailable: "unreadable_file" });
    expect(text).toMatch(/^Roles: unavailable — /);
    expect(text).toContain("could not read settings.json");
    expect(text).toContain("Delegation itself is refused until then, even with an explicit `harness`.");
    // 这时没有可信的角色清单，不去列任何一个。
    expect(text?.split("\n")).toHaveLength(1);
  });

  it("表头讲清怎么用：名字当 profile 传、显式参数覆盖角色、用不了的角色被拒绝而不是被默认值顶替", () => {
    const text = renderProfiles(report({ name: "verify", harness: "codex", check: usable() }));
    const header = (text ?? "").split("\n")[0] ?? "";
    expect(header).toContain("Roles — named configurations the user defined");
    expect(header).toContain("Pass a name as `profile` to `delegate`");
    expect(header).toContain("anything you pass explicitly overrides the role");
    expect(header).toContain("refused rather than replaced by defaults");
  });

  it("一行一个角色，按给出的顺序（创建顺序）；四项都固定了就原样写出", () => {
    const text = renderProfiles(
      report(
        { name: "verify", harness: "codex", model: "m-big", effort: "high", access: "read_only", check: usable({ model: "m-big", effort: "high", access: "read_only" }) },
        { name: "scout", harness: "pi", check: usable({ harness: "pi" }) },
      ),
    );
    expect(lines(text)).toEqual([
      "• verify — codex · model m-big · effort high · access read_only — usable now",
      "• scout — pi · model not fixed · access full (default) — usable now",
    ]);
  });

  it("没固定的字段写明此刻实际会落成什么，并标 (default)；访问权限没写就是 Full Access", () => {
    const text = renderProfiles(report({ name: "scout", harness: "pi", check: usable({ harness: "pi", model: "m-fast", effort: "low" }) }));
    expect(lines(text)).toEqual(["• scout — pi · model m-fast (default) · effort low (default) · access full (default) — usable now"]);
  });

  it("写明的模型 / 强度不加 (default)，哪怕此刻的实际取值与它相同", () => {
    const text = renderProfiles(report({ name: "r", harness: "pi", model: "m-fast", effort: "low", check: usable({ harness: "pi", model: "m-fast", effort: "low" }) }));
    expect(lines(text)).toEqual(["• r — pi · model m-fast · effort low · access full (default) — usable now"]);
  });

  it("只读在这个执行端只靠提示词、或没有约束：如实标出（它不算不能用）；Full Access 不带这个注", () => {
    const row = (access: "read_only" | "full", enforcement: "enforced" | "advisory" | "none"): string | undefined =>
      lines(renderProfiles(report({ name: "a", harness: "pi", access, check: usable({ harness: "pi", access, enforcement }) })))[0];
    expect(row("read_only", "enforced")).toBe("• a — pi · model not fixed · access read_only — usable now");
    expect(row("read_only", "advisory")).toBe("• a — pi · model not fixed · access read_only (prompt-only) — usable now");
    expect(row("read_only", "none")).toBe("• a — pi · model not fixed · access read_only (not enforced) — usable now");
    expect(row("full", "advisory")).toBe("• a — pi · model not fixed · access full — usable now");
  });

  it("不能用的角色：写固定了什么，再写 NOT usable now 与原因（措辞来自 describeIssue）；没有“实际会落成什么”可写", () => {
    const text = renderProfiles(
      report(
        { name: "stale", harness: "pi", model: "m-big", check: refused({ reason: "model_not_open", harness: "pi", model: "m-big", allowed: ["m-fast"] }) },
        { name: "locked", harness: "pi", model: "m", effort: "high", access: "read_only", check: refused({ reason: "access_unsupported", harness: "pi", access: "read_only", supported: ["full"] }) },
      ),
    );
    expect(lines(text)).toEqual([
      '• stale — pi · model m-big · access full (default) — NOT usable now: model "m-big" is not open for harness "pi" (open: m-fast)',
      '• locked — pi · model m · effort high · access read_only — NOT usable now: harness "pi" cannot run access level "read_only" (it supports: full)',
    ]);
  });

  it("各种不能用的原因都有一句话", () => {
    const cases: Array<[ProfileIssue, string]> = [
      [{ reason: "unknown_harness", harness: "ghost" }, 'harness "ghost" is not known to this version of Ensemble'],
      [{ reason: "harness_not_ready", harness: "pi", status: "needs_setup" }, 'harness "pi" is not ready (it needs setup)'],
      [{ reason: "no_models_open", harness: "pi" }, 'the user has not opened any model for harness "pi"'],
      [{ reason: "effort_not_open", harness: "pi", model: "m", effort: "xhigh", allowed: ["low", "high"] }, 'effort "xhigh" is not allowed for model "m" (allowed: low, high)'],
      [{ reason: "settings_unavailable", harness: "pi", issue: "unreadable_file" }, "Ensemble could not read settings.json"],
    ];
    for (const [issue, why] of cases) {
      const text = renderProfiles(report({ name: "r", harness: "pi", check: refused(issue) }));
      expect(lines(text), why).toEqual([`• r — pi · model not fixed · access full (default) — NOT usable now: ${why}`]);
    }
  });

  it("手改文件造成的无效条目照样列出，写明它为什么用不了（不悄悄抹掉，也不悄悄放过）", () => {
    const text = renderProfiles(
      report(
        { name: "Bad Name", invalid: "name", harness: "pi", check: refused({ reason: "invalid_name" }) },
        { name: "broken", invalid: "entry", check: refused({ reason: "invalid_entry" }) },
      ),
    );
    expect(lines(text)).toEqual([
      "• Bad Name — pi · model not fixed · access full (default) — NOT usable now: its name in settings.json is not valid",
      // 条目本身没有可信的字段：不写任何固定项，也不多出分隔符。
      "• broken — NOT usable now: its entry in settings.json is not valid",
    ]);
  });
});

describe("profilesData：结构化结果里的角色", () => {
  it("没有角色返回 undefined：结构化结果里不出现 profiles 这一项", () => {
    expect(profilesData({ entries: [] })).toBeUndefined();
  });

  it("设置文件读不了：只给 profilesIssue，不给任何角色", () => {
    expect(profilesData({ entries: [], unavailable: "unreadable_file" })).toEqual({ profilesIssue: "unreadable_file" });
  });

  it("能用的角色带 effective（实际会落成什么）；不能用的带 reason 代码与 why 原文；字段只在写了时才出现", () => {
    const first = effective({ model: "m-big", effort: "high", access: "read_only" });
    const data = profilesData(
      report(
        { name: "verify", harness: "codex", model: "m-big", effort: "high", access: "read_only", check: { usable: true, effective: first } },
        { name: "scout", harness: "pi", check: usable({ harness: "pi", model: "m-fast", effort: "low" }) },
        { name: "stale", harness: "pi", model: "m-big", check: refused({ reason: "model_not_open", harness: "pi", model: "m-big", allowed: ["m-fast"] }) },
      ),
    );
    expect(data).toStrictEqual({
      profiles: [
        { name: "verify", usable: true, harness: "codex", model: "m-big", effort: "high", access: "read_only", effective: first },
        { name: "scout", usable: true, harness: "pi", effective: { harness: "pi", access: "full", enforcement: "enforced", model: "m-fast", effort: "low" } },
        { name: "stale", usable: false, harness: "pi", model: "m-big", reason: "model_not_open", why: 'model "m-big" is not open for harness "pi" (open: m-fast)' },
      ],
    });
  });

  it("无效的条目带 invalid 标记；内容读得出的照给（改个名字就行），读不出的只有名字", () => {
    const data = profilesData(
      report(
        { name: "Bad Name", invalid: "name", harness: "pi", check: refused({ reason: "invalid_name" }) },
        { name: "broken", invalid: "entry", check: refused({ reason: "invalid_entry" }) },
      ),
    );
    expect(data).toStrictEqual({
      profiles: [
        { name: "Bad Name", usable: false, invalid: "name", harness: "pi", reason: "invalid_name", why: "its name in settings.json is not valid" },
        { name: "broken", usable: false, invalid: "entry", reason: "invalid_entry", why: "its entry in settings.json is not valid" },
      ],
    });
  });
});
