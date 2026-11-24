import { decideModel, resolveModelChoices, type ModelDecision } from "./models";
import type { AccessEnforcement, AccessLevel, HarnessInfo, HarnessStatus, ModelInfo, ModelSettingsIssue } from "./types";

/**
 * 委派角色（Delegation Profiles）：用户在设置里把一组 (执行端, 模型, 推理强度, 访问权限) 绑定到一个短名字，
 * 主 Agent 委派时传 `profile: "verify"` 就按这组配置走，显式传的参数按字段覆盖它。
 * 服务端（委派入口的解析与强制）、MCP（告诉主 Agent 有哪些角色、此刻能不能用）和网页（设置窗口的“角色”分区）
 * 共用这里的同一套规则，与 models.ts 同一个思路：不在三处各写一份而逐渐不一致。全部是纯函数。
 *
 * 一个角色 = 短名字 + 执行端（必填）+ 可选的模型、推理强度、访问权限。省略的字段＝不固定，交给现有规则：
 * 没写模型就走“用户指定的默认 → 执行端默认”，没写强度用该模型的默认档位，没写访问权限是 Full Access。
 * 不放“说明”之类的额外字段（用户要的是极简）；不预置任何角色。
 *
 * 名字：1～24 个字符，小写字母、数字、`-`、`_`，以字母或数字开头，不能全是数字。
 *  - 与主 Agent 在工具调用里敲的东西一致；查找时按小写（对大小写宽容），所以存下来的名字一律是小写；
 *  - 全数字的名字不行：对象的遍历顺序里，整数形的键永远排在最前面，“按创建顺序保留”就保不住了；
 *  - 数量上限 20（见 PROFILE_LIMIT）。
 * 名字可以叫 `constructor`、`valueof` 之类：本文件与存储层只用 Map / 数组 / Object.fromEntries 处理名字，不做 `obj[name] = …`。
 */

export const PROFILE_NAME_MAX = 24;
export const PROFILE_LIMIT = 20;
/** 各字段的长度上限，与委派请求里同名字段的上限一致（HTTP 校验、设置文件的解析都用它）。 */
export const PROFILE_FIELD_MAX = { harness: 100, model: 200, effort: 40 } as const;

export type ProfileNameFault = "empty" | "too_long" | "bad_characters" | "digits_only";

/** 查找前的规范化：去掉首尾空白、转小写。 */
export function normalizeProfileName(input: string): string {
  return input.trim().toLowerCase();
}

/** 名字不合格的原因（合格返回 undefined）。入参应已规范化：大写字母算不合格字符。 */
export function profileNameFault(name: string): ProfileNameFault | undefined {
  if (name.length === 0) return "empty";
  if (name.length > PROFILE_NAME_MAX) return "too_long";
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) return "bad_characters";
  if (/^[0-9]+$/.test(name)) return "digits_only";
  return undefined;
}

export function describeNameFault(fault: ProfileNameFault): string {
  switch (fault) {
    case "empty":
      return "A role name cannot be empty.";
    case "too_long":
      return `A role name can have at most ${PROFILE_NAME_MAX} characters.`;
    case "bad_characters":
      return "A role name can only use lowercase letters, digits, - and _, and must start with a letter or digit.";
    case "digits_only":
      return "A role name cannot be made of digits only: it needs at least one letter, - or _.";
  }
}

// ───────────────────────── 角色本身 ─────────────────────────

/** 角色里“要固定的东西”。`harness` 是文本而不是 HarnessId：文件里可能是这一版不认识的执行端（保留、标为暂时不可用）。 */
export interface ProfileSpec {
  harness: string;
  model?: string;
  effort?: string;
  access?: AccessLevel;
}

/**
 * 读者（MCP、网页）看到的一个角色。
 * - `invalid: "name"`：settings.json 里的名字不合规（手改文件）。内容读得出来，改名即可，但主 Agent 没法按这个名字引用它；
 * - `invalid: "entry"`：条目本身不合格，没有可信的字段，只能改好（重新选一个执行端）或删除。
 * 无效的条目照样在列表里：不悄悄抹掉，也不悄悄放过。
 */
export interface ProfileEntry extends Partial<ProfileSpec> {
  name: string;
  invalid?: "name" | "entry";
}

/** 角色列表（按创建顺序）。`unavailable`：settings.json 整个读不了，角色列表不可用——不是“没有角色”。 */
export interface ProfilesView {
  entries: ProfileEntry[];
  unavailable?: "unreadable_file";
}

/** 在名单里按名字找一个可用的角色（规范化后精确匹配；无效条目不参与，主 Agent 引用不到它们）。 */
export function findProfile(entries: readonly ProfileEntry[], name: string): ProfileEntry | undefined {
  const key = normalizeProfileName(name);
  return entries.find((entry) => entry.invalid === undefined && entry.name === key);
}

/** 有效条目里固定的取值；无效的条目没有可信的取值。 */
export function specOf(entry: ProfileEntry): ProfileSpec | undefined {
  if (entry.invalid !== undefined || entry.harness === undefined) return undefined;
  return {
    harness: entry.harness,
    ...(entry.model === undefined ? {} : { model: entry.model }),
    ...(entry.effort === undefined ? {} : { effort: entry.effort }),
    ...(entry.access === undefined ? {} : { access: entry.access }),
  };
}

/** 能被引用的角色名（保持创建顺序）。 */
export function usableProfileNames(entries: readonly ProfileEntry[]): string[] {
  return entries.filter((entry) => entry.invalid === undefined).map((entry) => entry.name);
}

// ───────────────────────── 委派时的解析 ─────────────────────────

export type ProfileField = "harness" | "model" | "effort" | "access";
/** 字段取值的来由：角色给的 / 主 Agent 显式传的 / 都没给（按现有的默认规则）。 */
export type FieldSource = "profile" | "explicit" | "default";

export interface ExplicitFields {
  harness?: string;
  model?: string;
  effort?: string;
  access?: AccessLevel;
}

/**
 * 角色里写了、这次没有用上的取值：
 * - `overridden`：主 Agent 显式传了另一个值；
 * - `other_harness`：显式换了执行端，角色的模型与强度属于原来的执行端，不继承；
 * - `other_model`：显式换了模型，角色的强度属于原来的模型，不继承。
 */
export interface SkippedField {
  field: ProfileField;
  value: string;
  why: "overridden" | "other_harness" | "other_model";
}

export interface DelegationPlan {
  harness: string;
  /** undefined＝不固定，交给现有的默认规则（模型：用户指定的默认 → 执行端默认；强度：该模型的默认档位；访问权限：Full Access）。 */
  model: string | undefined;
  effort: string | undefined;
  access: AccessLevel | undefined;
  sources: Record<ProfileField, FieldSource>;
  skipped: SkippedField[];
}

/** 委派回执里的“这次用了哪个角色”：只是这次调用的回执，不写进会话记录。 */
export interface ProfileEcho {
  name: string;
  sources: Record<ProfileField, FieldSource>;
  skipped?: SkippedField[];
}

/**
 * 角色（可以没有）加主 Agent 显式传的参数，得出这次委派的实际请求。按字段覆盖，并且不把一个执行端的模型悄悄套到另一个执行端上：
 *  - 显式的执行端与角色的不同：角色的模型与强度不继承（它们属于原来的执行端），访问权限继承；
 *  - 显式给了与角色不同的模型：角色的强度不继承（档位是按模型的）；显式的模型就是角色的那个时，强度照常继承——
 *    不然主 Agent 多写一句同样的模型名，就悄悄丢掉了用户定下的强度；
 *  - 显式给了强度 / 访问权限：各自覆盖角色的。
 * 没有执行端可用（既没传，角色也没有）时返回 undefined，由调用方报“至少要给 harness 或 profile”。
 * 角色必须是有效的（`invalid` 的条目不应该走到这里）。
 */
export function resolveDelegation(profile: ProfileSpec | undefined, explicit: ExplicitFields): DelegationPlan | undefined {
  const harness = explicit.harness ?? profile?.harness;
  if (harness === undefined) return undefined;
  const skipped: SkippedField[] = [];
  const fixed = { harness: profile?.harness, model: profile?.model, effort: profile?.effort, access: profile?.access };
  const own = fixed.harness !== undefined && harness === fixed.harness;
  const sameModel = own && (explicit.model === undefined || explicit.model === fixed.model);

  if (fixed.harness !== undefined && harness !== fixed.harness) skipped.push({ field: "harness", value: fixed.harness, why: "overridden" });

  const model = explicit.model ?? (own ? fixed.model : undefined);
  if (fixed.model !== undefined && model !== fixed.model) skipped.push({ field: "model", value: fixed.model, why: own ? "overridden" : "other_harness" });

  const effort = explicit.effort ?? (sameModel ? fixed.effort : undefined);
  if (fixed.effort !== undefined && effort !== fixed.effort) {
    skipped.push({ field: "effort", value: fixed.effort, why: !own ? "other_harness" : explicit.effort !== undefined ? "overridden" : "other_model" });
  }

  const access = explicit.access ?? fixed.access;
  if (fixed.access !== undefined && access !== fixed.access) skipped.push({ field: "access", value: fixed.access, why: "overridden" });

  const source = (explicitValue: string | undefined, value: string | undefined): FieldSource =>
    explicitValue !== undefined ? "explicit" : value !== undefined ? "profile" : "default";
  return {
    harness,
    model,
    effort,
    access,
    sources: {
      harness: explicit.harness !== undefined ? "explicit" : "profile",
      model: source(explicit.model, model),
      effort: source(explicit.effort, effort),
      access: source(explicit.access, access),
    },
    skipped,
  };
}

export function echoOf(name: string, plan: DelegationPlan): ProfileEcho {
  return { name, sources: plan.sources, ...(plan.skipped.length > 0 ? { skipped: plan.skipped } : {}) };
}

// ───────────────────────── 此刻能不能用 ─────────────────────────

/** 一次要执行的配置：委派前先拿它对照执行端此刻的状态。`access` 省略时按 Full Access 算（调用方先折算好）。 */
export interface RequestedConfig {
  harness: string;
  model?: string;
  effort?: string;
  access: AccessLevel;
}

/** 不能用的原因代码：网页据此本地化，`describeIssue` 给 MCP 与服务端错误的英文原文。 */
export type ProfileIssue =
  | { reason: "invalid_entry" }
  | { reason: "invalid_name" }
  | { reason: "unknown_harness"; harness: string }
  | { reason: "harness_not_ready"; harness: string; status: HarnessStatus }
  | { reason: "access_unsupported"; harness: string; access: AccessLevel; supported: AccessLevel[] }
  | { reason: "settings_unavailable"; harness: string; issue: ModelSettingsIssue }
  | { reason: "no_models_open"; harness: string }
  | { reason: "model_not_open"; harness: string; model: string; allowed: string[] }
  | { reason: "model_unverified"; harness: string; model?: string; allowed: string[] }
  | { reason: "effort_not_open"; harness: string; model: string; effort?: string; allowed: string[] };

/** 这个原因出在哪个字段上（决定它是不是“角色里写死的东西”出了问题）。 */
export function issueField(issue: ProfileIssue): ProfileField | "entry" {
  switch (issue.reason) {
    case "invalid_entry":
    case "invalid_name":
      return "entry";
    case "unknown_harness":
    case "harness_not_ready":
      return "harness";
    case "access_unsupported":
      return "access";
    case "settings_unavailable":
    case "no_models_open":
    case "model_not_open":
    case "model_unverified":
      return "model";
    case "effort_not_open":
      return "effort";
  }
}

/** 角色（或一次请求）实际会落成什么：模型不固定时写明此刻实际会用哪个。 */
export interface ProfileEffective {
  harness: string;
  /** 实际会用的模型；undefined＝执行端自己决定（目录里没有可核对的默认）。 */
  model?: string;
  /** 实际会用的强度（固定的、或该模型的默认档位）；undefined＝没有可说的。 */
  effort?: string;
  access: AccessLevel;
  /** 这个访问权限在该执行端是怎么落实的；见 HarnessInfo.access。 */
  enforcement?: AccessEnforcement["level"];
}

export type ProfileCheck = { usable: true; effective: ProfileEffective } | { usable: false; issue: ProfileIssue };

const ACCESS_LEVELS: readonly AccessLevel[] = ["read_only", "full"];

/**
 * 对照执行端此刻的状态，看一次配置能不能执行。判断的顺序与顺序里的每一条，都与服务端委派入口（manager.delegate）一致：
 * 执行端在不在、就没就绪 → 访问权限能不能落实（info.access 对应项为 null＝执行端无法执行这个级别）→ 模型与强度（decideModel）。
 * 所以这里说“能用”的，委派时不会因为同样的原因被拒；`advisory`（只靠提示词约束）不算不能用，委派入口今天也是放行的，只在结果里如实标出。
 */
export function checkRequest(info: HarnessInfo | undefined, request: RequestedConfig): ProfileCheck {
  if (!info) return { usable: false, issue: { reason: "unknown_harness", harness: request.harness } };
  if (info.status !== "ready") return { usable: false, issue: { reason: "harness_not_ready", harness: info.id, status: info.status } };
  const enforcement = info.access[request.access];
  if (!enforcement) {
    return { usable: false, issue: { reason: "access_unsupported", harness: info.id, access: request.access, supported: ACCESS_LEVELS.filter((level) => info.access[level]) } };
  }
  const decision = decideModel(info, request.model, request.effort);
  if (!decision.ok) return { usable: false, issue: issueOf(info.id, request, decision) };

  // 模型不固定（交给执行端的默认规则）时，写明此刻实际会用哪个；强度同理，取该模型此刻（已按用户的限制收窄后）的默认档位。
  const choices = resolveModelChoices(info);
  const known: readonly ModelInfo[] = choices.models;
  const model = decision.model ?? choices.defaultModel;
  const effort = decision.effort ?? known.find((candidate) => candidate.id === model)?.defaultEffort;
  return {
    usable: true,
    effective: { harness: info.id, access: request.access, enforcement: enforcement.level, ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) },
  };
}

function issueOf(harness: string, request: RequestedConfig, decision: Extract<ModelDecision, { ok: false }>): ProfileIssue {
  switch (decision.reason) {
    case "settings_unavailable":
      return { reason: "settings_unavailable", harness, issue: decision.issue };
    case "none_allowed":
      return { reason: "no_models_open", harness };
    case "not_allowed":
      return { reason: "model_not_open", harness, model: request.model ?? "", allowed: decision.allowed };
    case "model_unverified":
      return { reason: "model_unverified", harness, ...(request.model !== undefined ? { model: request.model } : {}), allowed: decision.allowed };
    case "effort_not_allowed":
      return { reason: "effort_not_open", harness, model: decision.model, ...(request.effort !== undefined ? { effort: request.effort } : {}), allowed: decision.allowed };
  }
}

/** 一个角色此刻能不能用。无效的条目（手改文件造成）直接是“不能用”，不去猜它的内容。 */
export function checkProfile(entry: ProfileEntry, info: HarnessInfo | undefined): ProfileCheck {
  if (entry.invalid === "name") return { usable: false, issue: { reason: "invalid_name" } };
  if (entry.invalid !== undefined || entry.harness === undefined) return { usable: false, issue: { reason: "invalid_entry" } };
  return checkRequest(info, {
    harness: entry.harness,
    access: entry.access ?? "full",
    ...(entry.model !== undefined ? { model: entry.model } : {}),
    ...(entry.effort !== undefined ? { effort: entry.effort } : {}),
  });
}

/** 带着此刻评估结果的角色（`GET /api/harnesses` 的 `profiles`，MCP 的 `harnesses` 工具用）。 */
export interface ProfileReportEntry extends ProfileEntry {
  check: ProfileCheck;
}

export interface ProfilesReport {
  entries: ProfileReportEntry[];
  unavailable?: "unreadable_file";
}

/** 服务端在返回执行端列表时，顺带把每个角色对照当前的执行端信息评估一遍。 */
export function reportProfiles(view: ProfilesView, infos: readonly HarnessInfo[]): ProfilesReport {
  return {
    entries: view.entries.map((entry) => ({ ...entry, check: checkProfile(entry, infos.find((info) => info.id === entry.harness)) })),
    ...(view.unavailable ? { unavailable: view.unavailable } : {}),
  };
}

// ───────────────────────── 英文原文（MCP 与服务端错误用） ─────────────────────────

const STATUS_TEXT: Record<HarnessStatus, string> = {
  ready: "ready",
  needs_setup: "it needs setup",
  unavailable: "it is unavailable",
  checking: "it is still being checked",
};

function listed(values: readonly string[]): string {
  return values.join(", ");
}

/** 不能用的原因，一个小句子（不带句号），写给主 Agent 看：只陈述事实。 */
export function describeIssue(issue: ProfileIssue): string {
  switch (issue.reason) {
    case "invalid_entry":
      return "its entry in settings.json is not valid";
    case "invalid_name":
      return "its name in settings.json is not valid";
    case "unknown_harness":
      return `harness "${issue.harness}" is not known to this version of Ensemble`;
    case "harness_not_ready":
      return `harness "${issue.harness}" is not ready (${STATUS_TEXT[issue.status]})`;
    case "access_unsupported":
      return `harness "${issue.harness}" cannot run access level "${issue.access}"${issue.supported.length > 0 ? ` (it supports: ${listed(issue.supported)})` : ""}`;
    case "settings_unavailable":
      return issue.issue === "unreadable_file" ? "Ensemble could not read settings.json" : `the model settings for harness "${issue.harness}" are invalid`;
    case "no_models_open":
      return `the user has not opened any model for harness "${issue.harness}"`;
    case "model_not_open":
      return `model "${issue.model}" is not open for harness "${issue.harness}"${issue.allowed.length > 0 ? ` (open: ${listed(issue.allowed)})` : ""}`;
    case "model_unverified":
      return `${
        issue.model === undefined
          ? `the user restricted reasoning efforts for harness "${issue.harness}", but Ensemble cannot tell which model it would use by default, so a model has to be named`
          : `"${issue.model}" is not a model harness "${issue.harness}" reports, and the user restricted reasoning efforts there`
      }${issue.allowed.length > 0 ? ` (known models: ${listed(issue.allowed)})` : ""}`;
    case "effort_not_open":
      return issue.allowed.length === 0
        ? `no reasoning effort is allowed for model "${issue.model}" of harness "${issue.harness}"`
        : `effort "${issue.effort ?? ""}" is not allowed for model "${issue.model}" (allowed: ${listed(issue.allowed)})`;
  }
}
