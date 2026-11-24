import type { OriginSummary } from "@shared/types";
import type { TFunction } from "./i18n";

/**
 * 来源（Main Agent）的会话标识、工作目录在界面各处的统一说法。
 * 来源怎么识别、哪些线索算宿主证据见 src/mcp/origin.ts；这里只管如实说出来。
 */

/**
 * 会话标识是不是 Agent 自报的：宿主没有交出标识时（例如 Cursor IDE），Agent 通过工具参数 `conversationId` 报上来。
 * Ensemble 无法核对，所以凡是写出这个标识的地方都要同时说明。
 */
export function refDeclared(origin: Pick<OriginSummary, "sessionRef">): boolean {
  return origin.sessionRef?.source === "declared";
}

/**
 * 工作目录是不是“未知”：只有 Agent 发起的来源才有这个说法（宿主没有报告、委派时也没显式传 cwd）；
 * 从网页控制台发起的来源本来就没有工作目录，不写“未知”。
 */
export function workspaceUnknown(origin: Pick<OriginSummary, "kind" | "workspace">): boolean {
  return origin.kind === "agent" && !origin.workspace;
}

/** 悬停提示里的会话标识行：“对话: <id>”，自报的再补一句来历。没有标识时返回 undefined。 */
export function refTipLines(origin: Pick<OriginSummary, "sessionRef">, t: TFunction): string[] {
  const ref = origin.sessionRef;
  if (!ref) return [];
  return [`${t(`origin.refLabel.${ref.kind}`)}: ${ref.id}`, ...(ref.source === "declared" ? [t("origin.refDeclaredTip")] : [])];
}

/** 悬停提示里的“工作区: …”行：有目录就带上它的来源（宿主的对话记录 / 宿主报告 / 委派时传入的 cwd），未知就明说未知。 */
export function workspaceTipLine(origin: Pick<OriginSummary, "kind" | "workspace" | "workspaceSource">, t: TFunction): string | undefined {
  if (origin.workspace) {
    const from = origin.workspaceSource ? t(`origin.workspaceFrom.${origin.workspaceSource}`) : undefined;
    return `${t("origin.workspace")}: ${from ? t("origin.workspaceNote", { path: origin.workspace, from }) : origin.workspace}`;
  }
  return workspaceUnknown(origin) ? `${t("origin.workspace")}: ${t("origin.workspaceUnknownTip")}` : undefined;
}
