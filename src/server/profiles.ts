import { checkRequest, describeIssue, echoOf, findProfile, issueField, normalizeProfileName, resolveDelegation, specOf, usableProfileNames, type ProfileEcho } from "@shared/profiles";
import type { AccessLevel, HarnessId } from "@shared/types";
import { EnsembleError } from "./errors";
import type { ExecutorRegistry } from "./executors/registry";
import type { SettingsStore } from "./settings";

/**
 * 委派入口里“角色（profile）→ 实际的 harness / model / effort / access”的解析（规则本身在 shared/profiles.ts）。
 *
 * 放在服务端而不是 MCP 桥里：强制执行与评估只有一份代码；角色是在委派的这一刻才读的，没有桥缓存过期的问题；
 * 任何走 HTTP 的调用方（不只是 MCP）行为一致；错误能带上角色名。解析结果再交给 manager.delegate：
 * 已有的校验（执行端就绪、访问级别、模型与强度的开放范围）与判重看到的都是实际取值，不会被角色绕过。
 */

export interface DelegationFields {
  harness?: HarnessId | undefined;
  profile?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  access?: AccessLevel | undefined;
}

export interface ResolvedDelegation {
  harness: HarnessId;
  model?: string;
  effort?: string;
  access?: AccessLevel;
  /** 只有请求带了 profile 才有；委派回执里原样带回。 */
  profile?: ProfileEcho;
}

export interface ProfileDeps {
  settings: SettingsStore;
  registry: ExecutorRegistry;
}

const WAYS_OUT = "The user can change the role in Ensemble Settings, under Roles. Or pass harness, model, effort or access explicitly (explicit values override the role), or omit profile.";

/**
 * 不带 profile 的请求原样放行（只要求有 harness）：与没有这项功能之前完全一样，校验都留给 manager。
 * 带了 profile：
 *  - 角色不存在、条目无效、设置文件读不了：直接拒绝，错误里写明角色名与出路；绝不悄悄退回执行端默认；
 *  - 角色本身固定的取值此刻用不了（执行端没就绪、模型不再开放、强度被收窄、访问级别落实不了）：拒绝，点名是哪个角色、哪个原因；
 *  - 用不了的是主 Agent 显式传的值（或没传时的默认规则）：不在这里判，交给 manager 给出同一套标准错误。
 */
export async function resolveDelegationFields(deps: ProfileDeps, request: DelegationFields): Promise<ResolvedDelegation> {
  const given = {
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.effort === undefined ? {} : { effort: request.effort }),
    ...(request.access === undefined ? {} : { access: request.access }),
  };
  if (request.profile === undefined) {
    if (request.harness === undefined) {
      throw new EnsembleError("invalid_request", 'Give "harness", or "profile" naming one of the roles the user defined in Ensemble Settings.');
    }
    return { harness: request.harness, ...given };
  }

  const name = request.profile;
  const view = deps.settings.profilesView();
  if (view.unavailable) {
    throw new EnsembleError(
      "model_settings_unavailable",
      `Role "${name}" cannot be resolved: Ensemble could not read settings.json. Ask the user to restore a valid settings file and restart Ensemble; until then delegation is refused, with or without a role.`,
    );
  }
  const entry = findProfile(view.entries, name);
  if (!entry) {
    // 条目在、但无效（手改文件）：说清它是无效的，而不是“不存在”——前者用户去设置里修，后者是名字写错了。
    const key = normalizeProfileName(name);
    const broken = view.entries.find((candidate) => candidate.invalid !== undefined && (candidate.name === name || candidate.name === key));
    if (broken) {
      const issue = describeIssue({ reason: broken.invalid === "name" ? "invalid_name" : "invalid_entry" });
      throw new EnsembleError("profile_unusable", `Role "${broken.name}" cannot be used: ${issue}. ${WAYS_OUT}`, { profile: broken.name });
    }
    const names = usableProfileNames(view.entries);
    throw new EnsembleError(
      "profile_not_found",
      names.length > 0
        ? `There is no role named "${name}". Roles defined by the user: ${names.join(", ")}.`
        : `There is no role named "${name}": the user has not defined any roles. They can add roles in Ensemble Settings, under Roles; otherwise pass harness (and model) explicitly.`,
      { profile: name, available: names },
    );
  }

  const spec = specOf(entry);
  const plan = spec && resolveDelegation(spec, { harness: request.harness, ...given });
  if (!plan) throw new EnsembleError("profile_unusable", `Role "${entry.name}" cannot be used: ${describeIssue({ reason: "invalid_entry" })}. ${WAYS_OUT}`, { profile: entry.name });

  // 预检：只替“角色自己写死的取值”把关（按上面规则，其余交给 manager）。顺序与 manager.delegate 一致。
  const id = deps.registry.ids().find((candidate) => candidate === plan.harness);
  const info = id === undefined ? undefined : await deps.registry.info(id);
  const check = checkRequest(info, {
    harness: plan.harness,
    access: plan.access ?? "full",
    ...(plan.model === undefined ? {} : { model: plan.model }),
    ...(plan.effort === undefined ? {} : { effort: plan.effort }),
  });
  if (!check.usable) {
    const field = issueField(check.issue);
    if (field === "entry" || plan.sources[field] === "profile") {
      throw new EnsembleError("profile_unusable", `Role "${entry.name}" cannot be used right now: ${describeIssue(check.issue)}. ${WAYS_OUT}`, { profile: entry.name, reason: check.issue.reason });
    }
  }
  const harness = id ?? request.harness;
  if (harness === undefined) {
    throw new EnsembleError("profile_unusable", `Role "${entry.name}" cannot be used right now: ${describeIssue({ reason: "unknown_harness", harness: plan.harness })}. ${WAYS_OUT}`, { profile: entry.name, reason: "unknown_harness" });
  }
  return {
    harness,
    ...(plan.model === undefined ? {} : { model: plan.model }),
    ...(plan.effort === undefined ? {} : { effort: plan.effort }),
    ...(plan.access === undefined ? {} : { access: plan.access }),
    profile: echoOf(entry.name, plan),
  };
}
