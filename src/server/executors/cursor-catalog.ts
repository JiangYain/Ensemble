import type { ModelInfo, SessionMeta } from "@shared/types";
import { HarnessStartError, arr, asRecord, str } from "./common";

/** Cursor 自己的模型目录（`Cursor.models.list()`）里与 Ensemble 有关的部分。 */
export interface CatalogModel {
  id: string;
  label: string;
  aliases: string[];
  /** 控制推理档位的参数 id；没有则该模型不能选档位。 */
  effortParam?: string;
  efforts: string[];
  defaultEffort?: string;
}

/** 会话要用的模型与档位：已按 Cursor 自己的模型目录解析。 */
export interface ResolvedModel {
  id: string;
  label: string;
  effort?: string;
  params?: Array<{ id: string; value: string }>;
  /** 目录里的模型 id（最多列 15 个），模型不存在时附在错误信息后面给用户看。 */
  available?: string;
}

const EFFORT_PARAM = /reason|effort|think/i;

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function parseCatalog(raw: unknown): CatalogModel[] {
  const models: CatalogModel[] = [];
  for (const item of arr(raw) ?? []) {
    const model = asRecord(item);
    const id = str(model?.["id"]);
    if (!model || !id) continue;
    const entry: CatalogModel = {
      id,
      label: str(model["displayName"]) ?? id,
      aliases: (arr(model["aliases"]) ?? []).filter(isString),
      efforts: [],
    };
    for (const rawParam of arr(model["parameters"]) ?? []) {
      const param = asRecord(rawParam);
      const paramId = str(param?.["id"]);
      if (!param || !paramId || !EFFORT_PARAM.test(paramId)) continue;
      const values = (arr(param["values"]) ?? []).map((value) => str(asRecord(value)?.["value"])).filter(isString);
      if (values.length < 2) continue;
      entry.effortParam = paramId;
      entry.efforts = values;
      const defaultVariant = (arr(model["variants"]) ?? []).map(asRecord).find((variant) => variant?.["isDefault"] === true);
      const defaultParam = (arr(defaultVariant?.["params"]) ?? []).map(asRecord).find((value) => str(value?.["id"]) === paramId);
      const defaultEffort = str(defaultParam?.["value"]);
      if (defaultEffort && values.includes(defaultEffort)) entry.defaultEffort = defaultEffort;
      break;
    }
    models.push(entry);
  }
  return models;
}

/**
 * Auto 让服务端自己挑，不会因为目录变化而失效；没有它就用目录里的第一个。
 * 真实目录（2026-11-08 经 SDK 1.0.28 取到）里它叫 `{ id: "default", displayName: "Auto", aliases: ["auto"] }`，
 * 所以 id 与别名都要认；只认 id "auto" 的话，只有在它恰好排第一时才会选对。
 */
export function pickDefaultModel(catalog: readonly CatalogModel[] | undefined): string | undefined {
  const auto = catalog?.find((model) => model.id === "auto") ?? catalog?.find((model) => model.aliases.includes("auto") || model.id === "default");
  return (auto ?? catalog?.[0])?.id;
}

function findModel(catalog: readonly CatalogModel[] | undefined, id: string): CatalogModel | undefined {
  return catalog?.find((model) => model.id === id || model.aliases.includes(id));
}

export function toModelInfo(model: CatalogModel, defaultId: string | undefined): ModelInfo {
  const isDefault = model.id === defaultId;
  return {
    id: model.id,
    label: model.label,
    ...(model.efforts.length > 1 ? { efforts: model.efforts } : {}),
    ...(model.defaultEffort ? { defaultEffort: model.defaultEffort } : {}),
    ...(isDefault ? { isDefault: true } : {}),
  };
}

function availableModels(catalog: readonly CatalogModel[] | undefined): string | undefined {
  const ids = (catalog ?? []).map((model) => model.id);
  if (ids.length === 0) return undefined;
  const shown = ids.slice(0, 15).join(", ");
  return ids.length > 15 ? `${shown}, …` : shown;
}

/** 以 Cursor 自己的模型目录为准；档位不合法就明说，不静默忽略。 */
export function resolveModel(catalog: readonly CatalogModel[] | undefined, meta: Pick<SessionMeta, "model" | "effort">): ResolvedModel {
  const available = availableModels(catalog);
  const id = meta.model?.requested?.trim() || meta.model?.resolved?.trim() || pickDefaultModel(catalog);
  if (!id) {
    throw new HarnessStartError(
      "model_not_found",
      "No Cursor model was requested and the model catalog could not be loaded, so there is no default to use. Pass a model id.",
    );
  }
  const entry = findModel(catalog, id);

  let params: ResolvedModel["params"];
  let effort = meta.effort?.trim() || undefined;
  if (effort) {
    if (!entry) {
      throw new HarnessStartError(
        "invalid_request",
        `Cannot apply effort "${effort}": Cursor's model catalog does not list "${id}"${available ? ` (available: ${available})` : ""}.`,
      );
    }
    if (!entry.effortParam || !entry.efforts.includes(effort)) {
      throw new HarnessStartError(
        "invalid_request",
        `Cursor model "${entry.id}" ${entry.efforts.length > 0 ? `supports the efforts ${entry.efforts.join(", ")}` : "has no reasoning-effort setting"}; "${effort}" cannot be applied.`,
      );
    }
    params = [{ id: entry.effortParam, value: effort }];
  } else {
    effort = entry?.defaultEffort;
  }

  // 目录里按别名找到的模型，用它的正式 id 发给 SDK。
  const canonical = entry?.id ?? id;
  return {
    id: canonical,
    label: entry?.label ?? canonical,
    ...(effort ? { effort } : {}),
    ...(params ? { params } : {}),
    ...(available ? { available } : {}),
  };
}
