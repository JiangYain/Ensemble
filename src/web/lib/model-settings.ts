import { effortRule, effortsAllowed, type StaleDefault } from "@shared/models";
import type { SetAllowedModelsRequest } from "@shared/protocol";
import type { HarnessId, HarnessInfo, ModelSettingsIssue } from "@shared/types";
import { api } from "./api";
import { applyHarness, perform, store } from "./app";
import { translate } from "./i18n";

/** 一次保存的整份快照：开放的模型 + 按模型 id 的推理档位 + 用户指定的默认模型（null＝没指定）。在途的合并成最新一份，所以每次都带全。 */
type Selection = Required<SetAllowedModelsRequest>;
type Allowed = Selection["allowed"];

export const modelSettingsMessage = {
  invalid_entry: "harness.modelSettings.invalid_entry",
  unreadable_file: "harness.modelSettings.unreadable_file",
} as const satisfies Record<ModelSettingsIssue, string>;

/** 指定的默认模型用不了时的说明（按失效的原因；词条键写成字面量，死键检查才认得出它们仍在使用）。 */
export const staleDefaultMessage = {
  missing: "harness.defaultStale.missing",
  not_allowed: "harness.defaultStale.not_allowed",
} as const satisfies Record<StaleDefault["why"], string>;

/** 界面上此刻的选择：还在途的优先，否则是服务端确认的。设置损坏时视为什么都没开放，重新保存即可修复。 */
function currentSelection(info: HarnessInfo, pending: Selection | undefined): Selection {
  if (pending !== undefined) return pending;
  if (info.modelSettingsIssue) return { allowed: [], efforts: {}, userDefaultModel: null };
  return { allowed: info.allowedModels ?? null, efforts: info.allowedEfforts ?? {}, userDefaultModel: info.userDefaultModel ?? null };
}

/** 用户指定的默认模型（含还在保存途中的）；null＝没指定，沿用执行端自己的默认。它可能已经失效，是否可用看 resolveModelChoices。 */
export function defaultSelection(info: HarnessInfo, pending: Selection | undefined): string | null {
  return currentSelection(info, pending).userDefaultModel;
}

export function modelSelection(info: HarnessInfo, pending: Selection | undefined): Allowed {
  return currentSelection(info, pending).allowed;
}

export function effortSelection(info: HarnessInfo, pending: Selection | undefined): Selection["efforts"] {
  return currentSelection(info, pending).efforts;
}

/** 只修改这次点选的模型；探测暂时缺少的 id 仍保留在原名单里。 */
export function changeModelChecks(harness: HarnessId, ids: readonly string[], on: boolean): void {
  const state = store.get();
  const info = state.harnesses.find((item) => item.id === harness);
  if (!info) return;
  const catalog = info.models.map((model) => model.id);
  const wanted = new Set(modelSelection(info, state.pendingModelSettings[harness]) ?? catalog);
  for (const id of ids) {
    if (on) wanted.add(id);
    else wanted.delete(id);
  }
  saveModelSelection(harness, { allowed: [...new Set([...catalog, ...wanted])].filter((id) => wanted.has(id)) });
}

/**
 * 修改某个模型的一个推理档位。开放的模型至少留一档：把最后一档也取消，界面会说“没有档位可选”，
 * 派发时却无从固定，所以这样的修改不予保存。目录暂时没有返回的档位仍保留在记录里。
 */
export function changeEffortCheck(harness: HarnessId, modelId: string, effort: string, on: boolean): void {
  const state = store.get();
  const info = state.harnesses.find((item) => item.id === harness);
  const offered = info?.models.find((model) => model.id === modelId)?.efforts ?? [];
  if (!info || !offered.includes(effort)) return;
  const efforts = effortSelection(info, state.pendingModelSettings[harness]);
  const rule = effortRule(efforts, modelId);
  const wanted = new Set(effortsAllowed(offered, rule));
  if (on) wanted.add(effort);
  else wanted.delete(effort);
  const visible = offered.filter((candidate) => wanted.has(candidate));
  if (visible.length === 0) return;
  const unseen = (rule ?? []).filter((candidate) => !offered.includes(candidate));
  saveModelSelection(harness, { efforts: { ...efforts, [modelId]: [...visible, ...unseen] } });
}

export function clearEffortLimit(harness: HarnessId, modelId: string): void {
  const { harnesses, pendingModelSettings } = store.get();
  const info = harnesses.find((item) => item.id === harness);
  if (!info) return;
  const efforts = effortSelection(info, pendingModelSettings[harness]);
  if (!Object.hasOwn(efforts, modelId)) return;
  const { [modelId]: _removed, ...remaining } = efforts;
  saveModelSelection(harness, { efforts: remaining });
}

/** 每个执行端一条队列；关掉再打开设置窗口仍然看到同一份在途选择。只改给出的那一项，另一项沿用当前的。 */
export function saveModelSelection(harness: HarnessId, patch: Partial<Selection>): void {
  const { pendingModelSettings, harnesses } = store.get();
  const info = harnesses.find((item) => item.id === harness);
  if (info?.modelSettingsIssue === "unreadable_file") return;
  const pending = pendingModelSettings[harness];
  const base = info ? currentSelection(info, pending) : (pending ?? { allowed: null, efforts: {}, userDefaultModel: null });
  const next = { ...base, ...patch };
  // 新名单把指定的默认模型排除在外（取消勾选它、全不选）：一并清掉，与服务端同一条规则，界面不会先停在“默认没被开放”上。
  const dropped = next.allowed !== null && next.userDefaultModel !== null && !next.allowed.includes(next.userDefaultModel);
  store.set({ pendingModelSettings: { ...pendingModelSettings, [harness]: dropped ? { ...next, userDefaultModel: null } : next } });
  if (pending === undefined) void flush(harness);
}

/** 指定（或用 null 取消）一个执行端的默认模型。 */
export function chooseDefaultModel(harness: HarnessId, model: string | null): void {
  saveModelSelection(harness, { userDefaultModel: model });
}

async function flush(harness: HarnessId): Promise<void> {
  for (;;) {
    const { pendingModelSettings, lang, harnesses } = store.get();
    const selection = pendingModelSettings[harness];
    if (selection === undefined) return;
    // 默认模型只在有改动时才发：失效的旧默认（执行端已不再提供）不能随着“只是勾了一个别的模型”被当作新的指定再送一遍，
    // 否则服务端按“指定”核对它，整次保存都会被拒绝。
    const saved = harnesses.find((item) => item.id === harness)?.userDefaultModel ?? null;
    const chosen = selection.userDefaultModel === saved ? undefined : selection.userDefaultModel;
    const response = await perform(() => api.setAllowedModels(harness, selection.allowed, selection.efforts, chosen), translate(lang, "harness.modelsSaveFailed"));
    if (response) applyHarness(response.harness);

    const latest = store.get().pendingModelSettings;
    if (latest[harness] !== selection) continue;
    const { [harness]: _settled, ...rest } = latest;
    store.set({ pendingModelSettings: rest });
    return;
  }
}
