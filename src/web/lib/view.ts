import type { SessionSummary } from "@shared/types";
import type { TFunction } from "./i18n";

/** 模型显示名：优先执行端解析出来的真实模型，其次是请求的，最后如实写“默认模型”。 */
export function modelLabel(summary: Pick<SessionSummary, "model">, t: TFunction): string {
  const model = summary.model;
  return model?.label ?? model?.resolved ?? model?.requested ?? t("model.default");
}

export function effortLabel(effort: string | undefined, t: TFunction): string | undefined {
  if (!effort) return undefined;
  const key = `effort.${effort}`;
  const text = t(key);
  return text === key ? effort : text;
}

export function harnessName(id: string, t: TFunction): string {
  const key = `harness.${id}`;
  const text = t(key);
  return text === key ? id : text;
}

export function panelHref(sessionId: string): string {
  return `${location.origin}/#/s/${encodeURIComponent(sessionId)}`;
}
