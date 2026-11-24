import type { HarnessInfo, ModelInfo, ModelSettingsIssue } from "./types";

/**
 * 用户对某个执行端「可选模型」与「可选推理档位」的取舍如何生效。服务端（派发时校验）、MCP（告诉主 Agent 能选什么）
 * 和网页（设置窗口里的模型选择）都用这里的同一套规则，避免三处各写一份而逐渐不一致。
 *
 * 模型：
 * - `allowedModels` 缺省：没有限制，一切照执行端自己的目录与默认来。
 * - 有限制：只有名单里的模型可以选；不指定模型时，执行端默认模型若在名单里就照常使用，
 *   否则退到目录里第一个被开放的模型——不会悄悄用一个用户没开放的模型。
 * - 名单里的 id 以用户点名的为准：执行端目录一时读不到（为空）时，不能因此把用户明确开放的模型判成不可用。
 *
 * 默认模型（不指定模型时用哪个）：
 * - 用户指定了（`userDefaultModel`）且它此刻可选：用它，不论执行端自己的默认是谁。“可选”与上面的规则是同一份——
 *   有限制时在名单里，不设限时是目录里的模型（目录读不到时无从核对，按失效处理）。
 * - 指定了但已失效（执行端不再提供，或没被开放）：退回没指定时的规则，不报错；失效的事实放在结果的
 *   `staleDefault` 里，界面与 MCP 据此说明，而不是悄悄换掉或悄悄清掉。
 * - 没指定：执行端自己的默认，行为与加这一项之前完全一致。
 * - 没得选（空名单、设置损坏）时不存在默认，指定的默认也就无从谈起，不另报“失效”。
 *
 * 推理档位（`allowedEfforts`，按模型 id 记录，只对开放的模型起作用）：
 * - 没有任何档位记录：档位不设限，一切照旧（请求什么档位交给执行端去判断，不指定就用执行端自己的默认；
 *   不指定模型时也不固定模型）。
 * - 某个模型有记录：记录始终生效，与目录此刻报告什么无关——目录碰巧只报告这些档位、或这个模型暂时不报档位，
 *   都不会让记录失效。入队时就固定实际档位：请求的必须在记录里；没请求时用目录默认（若它被允许），
 *   否则用第一个被允许的，不会回落到没被授权的原生默认。目录没有给出档位时，以用户明确允许的为准，
 *   交给执行端按这个值去执行（不支持就明确失败），不去猜它的原生默认。
 * - 记录与目录对不上（允许的档位一个都不在目录里）：这个模型不可选，而不是悄悄放开全部档位。
 * - 存在任何档位记录时，不设限的模式下也要把“实际用哪个模型”确定下来：不指定模型就固定为默认模型
 *   （即使它自己没有记录，否则排队期间执行端默认换成受限的模型会绕过限制）；默认模型不明则拒绝；
 *   目录和用户记录都不认识的名字（别名等）同样拒绝，因为它可能就是某个受限模型。
 */

export type ModelCatalog = Pick<HarnessInfo, "models" | "allowedModels" | "allowedEfforts" | "defaultModel" | "userDefaultModel" | "modelSettingsIssue">;

/** 原样传递的 id 不能在执行端被 trim 成空值或另一项（模型 id 与推理档位都用它判断）。 */
export function isModelId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

/** 执行端自己的默认模型（用户的取舍不改变它）。 */
export function catalogDefaultModel(info: Pick<HarnessInfo, "models" | "defaultModel">): string | undefined {
  return info.defaultModel ?? info.models.find((model) => model.isDefault)?.id;
}

/** 某个模型的档位记录。只认自己的属性：模型 id 叫 constructor 之类时不能读到对象原型上的东西。 */
export function effortRule(rules: HarnessInfo["allowedEfforts"], modelId: string): readonly string[] | undefined {
  return rules !== undefined && Object.hasOwn(rules, modelId) ? rules[modelId] : undefined;
}

/** 目录报告的档位里被用户允许的那些（保持目录顺序）；没有记录就是全部。 */
export function effortsAllowed(offered: readonly string[], rule: readonly string[] | undefined): string[] {
  return rule ? offered.filter((effort) => rule.includes(effort)) : [...offered];
}

interface Settled {
  model: ModelInfo;
  /** 有档位记录在起作用：派发时必须固定实际档位，不能交给执行端自己的默认。 */
  limited: boolean;
  /** 可选的档位比执行端报告的少，或执行端根本没报告、只有用户的记录（MCP 据此说明这是用户定的）。 */
  narrowed: boolean;
}

/**
 * 把档位记录用到一个模型上。undefined：记录让它没有任何可用档位。
 * 没有目录依据（目录读不到、没有这个模型的条目、或它暂时不报档位）时，以用户记录里明确允许的为准，
 * 而不是把记录当作无效。
 */
function settleEfforts(model: ModelInfo, rule: readonly string[] | undefined): Settled | undefined {
  if (rule === undefined) return { model, limited: false, narrowed: false };
  const offered = model.efforts ?? [];
  if (offered.length === 0) {
    const first = rule[0];
    return first === undefined ? undefined : { model: { ...model, efforts: [...rule], defaultEffort: first }, limited: true, narrowed: true };
  }
  const efforts = effortsAllowed(offered, rule);
  const first = efforts[0];
  if (first === undefined) return undefined;
  const defaultEffort = model.defaultEffort !== undefined && efforts.includes(model.defaultEffort) ? model.defaultEffort : first;
  return { model: { ...model, efforts, defaultEffort }, limited: true, narrowed: efforts.length < offered.length };
}

/** 用户开放、并且档位设置对得上的模型（档位已收窄为实际可选的）。 */
function openModels(info: ModelCatalog): Settled[] {
  const settle = (model: ModelInfo): Settled[] => {
    const settled = settleEfforts(model, effortRule(info.allowedEfforts, model.id));
    return settled ? [settled] : [];
  };
  if (info.allowedModels === undefined) return info.models.flatMap(settle);
  const allowed = new Set(info.allowedModels);
  if (info.models.length === 0) return [...allowed].flatMap((id) => settle({ id, label: id }));
  return info.models.filter((model) => allowed.has(model.id)).flatMap(settle);
}

/** 这个模型的档位是否被用户收窄（MCP 据此告诉主 Agent，这不是执行端自己的限制）。 */
export function effortsLimited(info: ModelCatalog, modelId: string): boolean {
  return openModels(info).find((entry) => entry.model.id === modelId)?.narrowed ?? false;
}

/** 是否存在任何档位记录。有记录时，委派必须落在一个确定的模型上，记录才管得到它。 */
function hasEffortPolicy(info: ModelCatalog): boolean {
  return info.allowedEfforts !== undefined && Object.keys(info.allowedEfforts).length > 0;
}

/** 目录里有、或用户的档位记录点了名的模型 id：只有这样的名字才能确定它受哪条记录管。 */
function isKnownModel(info: ModelCatalog, id: string): boolean {
  return info.models.some((model) => model.id === id) || effortRule(info.allowedEfforts, id) !== undefined;
}

/** 默认模型的来由：用户指定的 / 执行端自己的 / 执行端的默认用不了、退到第一个被开放的。 */
export type DefaultSource = "user" | "harness" | "first_open";

/** 用户指定的默认模型此刻用不了：`missing` 执行端目录里没有它，`not_allowed` 目录里有但没被开放（名单或档位设置）。 */
export interface StaleDefault {
  id: string;
  why: "missing" | "not_allowed";
}

export type ModelChoices =
  | { kind: "unrestricted"; models: readonly ModelInfo[]; defaultModel: string | undefined; defaultSource: DefaultSource | undefined; staleDefault?: StaleDefault }
  | { kind: "restricted"; models: readonly ModelInfo[]; defaultModel: string; defaultSource: DefaultSource; staleDefault?: StaleDefault }
  | { kind: "empty"; models: readonly []; defaultModel: undefined }
  | { kind: "blocked"; issue: ModelSettingsIssue; models: readonly []; defaultModel: undefined };

/** 委派校验和展示共用这一份结果；目录读不到也能显示用户明确开放的 id。`models` 里的档位已是实际可选的。 */
export function resolveModelChoices(info: ModelCatalog): ModelChoices {
  if (info.modelSettingsIssue) return { kind: "blocked", issue: info.modelSettingsIssue, models: [], defaultModel: undefined };
  const preferred = catalogDefaultModel(info);
  const models = openModels(info).map((entry) => entry.model);
  const first = models[0];
  const chosen = info.userDefaultModel;
  const chosenOpen = chosen !== undefined && models.some((model) => model.id === chosen);
  const stale: { staleDefault?: StaleDefault } = chosen === undefined || chosenOpen
    ? {}
    : { staleDefault: { id: chosen, why: info.models.some((model) => model.id === chosen) ? "not_allowed" : "missing" } };
  if (info.allowedModels === undefined) {
    // 目录有模型、却因档位设置对不上而一个都不可选：同样是“没得选”，不能还说成没有限制。
    if (!first && info.models.length > 0) return { kind: "empty", models: [], defaultModel: undefined };
    if (chosenOpen) return { kind: "unrestricted", models, defaultModel: chosen, defaultSource: "user" };
    // 目录默认模型正是被排除的那个：不能再把它当默认。
    const excluded = preferred !== undefined && info.models.some((model) => model.id === preferred) && !models.some((model) => model.id === preferred);
    const defaultModel = excluded ? first?.id : preferred;
    return { kind: "unrestricted", models, defaultModel, defaultSource: defaultModel === undefined ? undefined : excluded ? "first_open" : "harness", ...stale };
  }
  if (!first) return { kind: "empty", models: [], defaultModel: undefined };
  if (chosenOpen) return { kind: "restricted", models, defaultModel: chosen, defaultSource: "user" };
  const preferredOpen = preferred !== undefined && models.some((model) => model.id === preferred);
  return { kind: "restricted", models, defaultModel: preferredOpen ? preferred : first.id, defaultSource: preferredOpen ? "harness" : "first_open", ...stale };
}

/**
 * 保存“用户指定的默认模型”时的校验（服务端的保存入口与 settings 共用）：主 Agent 必须能选用它——
 * 有限制时在新名单里，不设限时是执行端目录里的模型。`allowed` 是这次保存后生效的名单。
 */
export function defaultModelFault(catalogIds: readonly string[], allowed: readonly string[] | null, id: string): "not_allowed" | "unknown" | undefined {
  if (allowed !== null) return allowed.includes(id) ? undefined : "not_allowed";
  return catalogIds.includes(id) ? undefined : "unknown";
}

export type ModelDecision =
  /** `model` 为 undefined 表示不指定，交给执行端用它自己的默认模型；`effort` 同理（有限制时一定是固定下来的实际档位）。 */
  | { ok: true; model: string | undefined; effort?: string }
  | { ok: false; reason: "settings_unavailable"; issue: ModelSettingsIssue }
  | { ok: false; reason: "not_allowed" | "none_allowed"; allowed: string[] }
  /** 有档位记录，但无法确定实际落在哪个模型上（默认模型不明，或点名了目录与记录都不认识的名字）。 */
  | { ok: false; reason: "model_unverified"; allowed: string[] }
  | { ok: false; reason: "effort_not_allowed"; model: string; allowed: string[] };

/** 目标模型此刻的档位设置；undefined：档位设置让它不可用。 */
function settleTarget(info: ModelCatalog, id: string): Settled | undefined {
  const open = openModels(info).find((entry) => entry.model.id === id);
  if (open) return open;
  // 目录里有这个模型，却没能进入可选名单：档位记录与目录对不上，宁可不放行。
  if (info.models.some((model) => model.id === id)) return undefined;
  // 目录里没有的名字：没有记录就原样放行（有档位记录时已在更早处拒绝），有记录则按用户记录的来。
  return settleEfforts({ id, label: id }, effortRule(info.allowedEfforts, id));
}

/** 派发时决定用哪个模型与档位：校验请求是否被开放；没有请求时按默认规则给出结果。 */
export function decideModel(info: ModelCatalog, requested: string | undefined, requestedEffort?: string): ModelDecision {
  const choices = resolveModelChoices(info);
  if (choices.kind === "blocked") return { ok: false, reason: "settings_unavailable", issue: choices.issue };
  if (choices.kind === "empty") return { ok: false, reason: "none_allowed", allowed: [] };
  const unrestricted = choices.kind === "unrestricted";
  if (!unrestricted && requested !== undefined && !choices.models.some((model) => model.id === requested)) {
    return { ok: false, reason: "not_allowed", allowed: choices.models.map((model) => model.id) };
  }

  // 档位记录属于具体的模型：没指定模型时，看它会落在哪个模型上（不设限时即执行端自己的默认）。
  const target = requested ?? choices.defaultModel;
  // 白名单模式，或不设限但存在任何档位记录：入队时就固定实际模型。运行时执行端的默认可能随探测刷新而改变，
  // 排队期间换成受限的模型就会绕过记录；落在没有记录的默认模型上时也一样要固定。
  const pinModel = !unrestricted || hasEffortPolicy(info);
  if (unrestricted && pinModel && (target === undefined || !isKnownModel(info, target))) {
    return { ok: false, reason: "model_unverified", allowed: choices.models.map((model) => model.id) };
  }

  let effort = requestedEffort;
  if (target !== undefined) {
    const settled = settleTarget(info, target);
    if (!settled) return { ok: false, reason: "effort_not_allowed", model: target, allowed: [] };
    if (settled.limited) {
      const levels = settled.model.efforts ?? [];
      if (effort !== undefined && !levels.includes(effort)) return { ok: false, reason: "effort_not_allowed", model: target, allowed: levels };
      effort ??= settled.model.defaultEffort;
    }
  }

  // 用户指定了默认模型：不指定时也要在入队时固定下来，运行时才由执行端定默认的话，指定就可能落空。
  const userPick = requested === undefined && choices.defaultSource === "user";
  return { ok: true, model: pinModel || userPick ? target : requested, ...(effort !== undefined ? { effort } : {}) };
}
