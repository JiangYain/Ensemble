import { resolveModelChoices } from "@shared/models";
import {
  PROFILE_NAME_MAX,
  normalizeProfileName,
  profileNameFault,
  type ProfileIssue,
  type ProfileNameFault,
  type ProfileSpec,
  type ProfilesView,
} from "@shared/profiles";
import type { AccessLevel, HarnessInfo, ModelInfo } from "@shared/types";
import { api } from "./api";
import { perform, store } from "./app";
import { translate, type TFunction } from "./i18n";
import { effortLabel, harnessName } from "./view";

/**
 * 设置窗口“角色”分区的逻辑：一行里的字段怎么联动、下拉框的选项从哪来、名称怎么校验、写入怎么排队。组件只管摆控件。
 * 规则本身在 shared/profiles.ts（此刻能不能用、名称规则）与 shared/models.ts（模型与推理档位）：这里只做网页自己的事，不再抄一份规则。
 * 选项全部来自 store 里的真实数据（执行端、模型目录、用户在“执行端”里的取舍），没有写死的模型名或档位。
 */

// ───────────────────────── 服务有没有角色功能 ─────────────────────────

/**
 * “服务根本没有角色功能”的标记。老服务的快照里没有 `profiles` 字段（shared/protocol.ts），live.ts 把这个对象放进 store.profiles，
 * 而不是一张空表：空表的意思是“有这项功能，只是还没建角色”，两种情形因此分得开。
 *
 * 靠对象身份判断（profilesSupported）：流里的 `profiles` 推送与每一次写入的回执给的都是新对象，一收到就自然变回“支持”，不需要谁去清标记。
 * 整个页面只有这一个对象，Store.set 按身份比较，所以老服务反复发来的快照不会再让 store 变一次。
 * 更直白的做法是在 AppState 里加一个布尔字段；AppState 在 lib/app.ts，不在这一批的改动范围里——换过去时只需改这里与 live.ts 的一处赋值。
 */
export const PROFILES_UNSUPPORTED: ProfilesView = Object.freeze({ entries: [] });

/** 连着的服务有没有角色功能（store.profiles 不是那个标记）。 */
export function profilesSupported(profiles: ProfilesView): boolean {
  return profiles !== PROFILES_UNSUPPORTED;
}

/** 一行里正在编辑的取值：就是角色的取值，只是执行端可以还没选（新增的草稿，或内容读不出来的旧条目）。 */
export type RoleFields = Partial<ProfileSpec>;

/** 只留四个字段、丢掉 undefined：整行（含 name、invalid 之类）传进来也不会把多余的东西带进请求。 */
function pick(fields: RoleFields): RoleFields {
  return {
    ...(fields.harness === undefined ? {} : { harness: fields.harness }),
    ...(fields.model === undefined ? {} : { model: fields.model }),
    ...(fields.effort === undefined ? {} : { effort: fields.effort }),
    ...(fields.access === undefined ? {} : { access: fields.access }),
  };
}

/** 能存下来的取值；还没选执行端就是 undefined。 */
export function specFrom(fields: RoleFields): ProfileSpec | undefined {
  const picked = pick(fields);
  return picked.harness === undefined ? undefined : { ...picked, harness: picked.harness };
}

export function sameFields(a: RoleFields, b: RoleFields): boolean {
  return a.harness === b.harness && a.model === b.model && a.effort === b.effort && a.access === b.access;
}

// ───────────────────────── 字段联动 ─────────────────────────

/**
 * 换执行端：模型与推理强度属于原来的执行端，不带过去（回到“默认”）；访问权限是通用的，带着。
 * 与委派时“显式换了执行端就不继承角色的模型与强度”（shared/profiles.ts 的 resolveDelegation）是同一条规则。
 * 带过去的访问权限新执行端不一定能落实：那时这一行会被标为“不可用”并说明原因，不会悄悄改成别的级别。
 */
export function withHarness(fields: RoleFields, harness: string): RoleFields {
  if (fields.harness === harness) return pick(fields);
  return { harness, ...(fields.access === undefined ? {} : { access: fields.access }) };
}

/** 换模型：推理强度是按具体模型的，新模型没有这一档就回到“默认”；换成同一个模型什么也不变。 */
export function withModel(fields: RoleFields, info: HarnessInfo | undefined, model: string | undefined): RoleFields {
  const base = pick(fields);
  if (base.model === model) return base;
  const { model: _model, effort, ...rest } = base;
  const next: RoleFields = { ...rest, ...(model === undefined ? {} : { model }) };
  return effort !== undefined && effortLevels(info, model).levels.includes(effort) ? { ...next, effort } : next;
}

export function withEffort(fields: RoleFields, effort: string | undefined): RoleFields {
  const { effort: _effort, ...rest } = pick(fields);
  return effort === undefined ? rest : { ...rest, effort };
}

export function withAccess(fields: RoleFields, access: AccessLevel | undefined): RoleFields {
  const { access: _access, ...rest } = pick(fields);
  return access === undefined ? rest : { ...rest, access };
}

/**
 * 某个模型此刻可选的推理档位（已按用户在“执行端”里的设置收窄）与它的默认档位。模型不固定时看此刻的默认模型。
 * 执行端未知、没有这个模型或它不报告档位，就是空：这时推理强度没有可选项。
 */
export function effortLevels(info: HarnessInfo | undefined, model: string | undefined): { levels: readonly string[]; fallback: string | undefined } {
  if (!info) return { levels: [], fallback: undefined };
  const choices = resolveModelChoices(info);
  // 联合类型的数组直接 .find 过不了类型检查：先收成同一种。
  const models: readonly ModelInfo[] = choices.models;
  const entry = models.find((candidate) => candidate.id === (model ?? choices.defaultModel));
  return { levels: entry?.efforts ?? [], fallback: entry?.defaultEffort };
}

// ───────────────────────── 下拉框的选项 ─────────────────────────

export interface PickOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/** 选项里的“默认”（不固定）：值是空串。 */
export const DEFAULT_VALUE = "";

/**
 * 执行端：此刻所有的执行端（还没就绪的也列出来并注明状态：角色可以先建好）。角色里存着的、这一版不认识的执行端也要在，
 * 否则下拉框与存的值对不上；还没选的（草稿、读不出来的旧条目）有一个不可选的提示项。
 */
export function harnessOptions(harnesses: readonly HarnessInfo[], current: string | undefined, t: TFunction): PickOption[] {
  const options: PickOption[] = [];
  if (current === undefined) options.push({ value: DEFAULT_VALUE, label: t("profiles.pickHarness"), disabled: true });
  for (const info of harnesses) {
    const name = harnessName(info.id, t);
    options.push({ value: info.id, label: info.status === "ready" ? name : `${name} · ${t(`harness.status.${info.status}`)}` });
  }
  if (current !== undefined && !harnesses.some((info) => info.id === current)) options.push({ value: current, label: `${current} · ${t("profiles.unknown")}` });
  return options;
}

/**
 * 模型：“默认”一项写明此刻实际会用哪个（用户指定的默认 → 执行端的默认），然后是用户在“执行端”里开放的模型。
 * 角色里存着的模型已经不在开放名单里时仍保留一项，下拉框才与存的值对得上；为什么不能用由这一行下面的那句话说明。
 */
export function modelOptions(info: HarnessInfo | undefined, current: string | undefined, t: TFunction): PickOption[] {
  const choices = info ? resolveModelChoices(info) : undefined;
  const models: readonly ModelInfo[] = choices?.models ?? [];
  const fallback = choices?.defaultModel;
  const fallbackName = fallback === undefined ? undefined : (models.find((model) => model.id === fallback)?.label ?? fallback);
  const options: PickOption[] = [{ value: DEFAULT_VALUE, label: fallbackName === undefined ? t("harness.default") : `${t("harness.default")} · ${fallbackName}` }];
  for (const model of models) options.push({ value: model.id, label: model.label });
  if (current !== undefined && !models.some((model) => model.id === current)) {
    options.push({ value: current, label: info?.models.find((model) => model.id === current)?.label ?? current });
  }
  return options;
}

/** 推理强度：该模型此刻可选的档位；模型没有档位（或执行端未知）时只有“默认”。 */
export function effortOptions(info: HarnessInfo | undefined, model: string | undefined, current: string | undefined, t: TFunction): PickOption[] {
  const { levels } = effortLevels(info, model);
  const options: PickOption[] = [{ value: DEFAULT_VALUE, label: t("harness.default") }];
  for (const level of levels) options.push({ value: level, label: effortLabel(level, t) ?? level });
  if (current !== undefined && !levels.includes(current)) options.push({ value: current, label: effortLabel(current, t) ?? current });
  return options;
}

/**
 * 访问权限：执行端落实不了的级别注明“不支持”并且不能新选；角色里已经存着的那个仍可见（它不可用的原因在这一行下面说明）。
 * “默认”＝不固定，委派时是完全访问。
 */
export function accessOptions(info: HarnessInfo | undefined, current: AccessLevel | undefined, t: TFunction): PickOption[] {
  const options: PickOption[] = [{ value: DEFAULT_VALUE, label: t("harness.default") }];
  for (const level of ["read_only", "full"] as const) {
    const name = t(`access.${level}`);
    const supported = info === undefined || info.access[level] !== null;
    options.push({ value: level, label: supported ? name : `${name} · ${t("harness.accessUnsupported")}`, disabled: !supported && current !== level });
  }
  return options;
}

// ───────────────────────── 名称 ─────────────────────────

export type NameProblem = ProfileNameFault | "duplicate";

/**
 * 规范化（去空白、转小写，存下来的就是这个）后的名称，以及它的问题（合格就没有）。
 * `others` 是别的角色的名称（不含这一行自己原来的）；与服务端的校验同一条规则（shared/profiles.ts 的 profileNameFault）。
 */
export function checkName(raw: string, others: readonly string[]): { name: string; problem: NameProblem | undefined } {
  const name = normalizeProfileName(raw);
  return { name, problem: profileNameFault(name) ?? (others.includes(name) ? "duplicate" : undefined) };
}

export function nameProblemText(problem: NameProblem, name: string, t: TFunction): string {
  switch (problem) {
    case "empty":
      return t("profiles.name.empty");
    case "too_long":
      return t("profiles.name.too_long", { max: PROFILE_NAME_MAX });
    case "bad_characters":
      return t("profiles.name.bad_characters");
    case "digits_only":
      return t("profiles.name.digits_only");
    case "duplicate":
      return t("profiles.name.duplicate", { name });
  }
}

// ───────────────────────── 不可用的原因 ─────────────────────────

/** 一个角色此刻不能用的原因，一句话（词条键都写成字面量，死键检查才认得出它们仍在使用）。 */
export function issueText(issue: ProfileIssue, t: TFunction): string {
  const section = t("settings.section.executors");
  switch (issue.reason) {
    case "invalid_entry":
      return t("profiles.issue.invalid_entry");
    case "invalid_name":
      return t("profiles.issue.invalid_name");
    case "unknown_harness":
      return t("profiles.issue.unknown_harness", { harness: issue.harness });
    case "harness_not_ready":
      return t("profiles.issue.harness_not_ready", { harness: harnessName(issue.harness, t), status: t(`harness.status.${issue.status}`) });
    case "access_unsupported":
      return t("profiles.issue.access_unsupported", { harness: harnessName(issue.harness, t), access: t(`access.${issue.access}`) });
    case "settings_unavailable":
      return t("profiles.issue.settings_unavailable", { harness: harnessName(issue.harness, t), section });
    case "no_models_open":
      return t("profiles.issue.no_models_open", { harness: harnessName(issue.harness, t), section });
    case "model_not_open":
      return t("profiles.issue.model_not_open", { harness: harnessName(issue.harness, t), model: issue.model });
    case "model_unverified":
      return issue.model === undefined
        ? t("profiles.issue.model_unverified", { harness: harnessName(issue.harness, t) })
        : t("profiles.issue.model_unknown", { harness: harnessName(issue.harness, t), model: issue.model });
    case "effort_not_open":
      return issue.allowed.length === 0
        ? t("profiles.issue.effort_none", { model: issue.model })
        : t("profiles.issue.effort_not_open", { model: issue.model, effort: effortLabel(issue.effort, t) ?? "" });
  }
}

// ───────────────────────── 写入 ─────────────────────────

/** 写入的串行队列：同一个页面里的几次修改按点击的顺序一个接一个发给服务端，回执也按这个顺序生效，后一次不会被前一次的回执盖掉。 */
let tail: Promise<unknown> = Promise.resolve();

/**
 * 发一次角色写入，成功返回生效后的整张角色表，失败（已经提示过）返回 undefined。
 * 不在这里把回执放进 store：新增与改名要先记下这一行的身份再放（否则一瞬间会渲染出两行），由调用方决定顺序。
 */
function write(action: () => Promise<{ profiles: ProfilesView }>, failure: string): Promise<ProfilesView | undefined> {
  const run = tail.then(async () => (await perform(action, translate(store.get().lang, failure)))?.profiles);
  tail = run.catch(() => undefined);
  return run;
}

/** 整条改写一个已有的角色（没给的字段＝不固定）。 */
export function saveRole(name: string, spec: ProfileSpec): Promise<ProfilesView | undefined> {
  return write(() => api.putProfile(name, spec), "profiles.saveFailed");
}

/** 新增：名称已经被占用就拒绝（两个标签页同时用同一个名称新增时，后到的不会悄悄覆盖先到的）。 */
export function createRole(name: string, spec: ProfileSpec): Promise<ProfilesView | undefined> {
  return write(() => api.putProfile(name, { ...spec, create: true }), "profiles.saveFailed");
}

export function renameRole(name: string, to: string): Promise<ProfilesView | undefined> {
  return write(() => api.renameProfile(name, to), "profiles.saveFailed");
}

export function removeRole(name: string): Promise<ProfilesView | undefined> {
  return write(() => api.removeProfile(name), "profiles.removeFailed");
}
