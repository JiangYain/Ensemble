// ENSEMBLE ADDED — 本文件由 Ensemble 新增（Cursor SDK 后端），不属于上游 mosoo-agent-driver。详见 VENDORING.md。
import type { RunError } from "../../runtime-command";
import { asRecord, clip, collapseWhitespace, errorMessage, isString, num, str } from "./cursor-values";

/** 后端对 Cursor 失败的统一描述；code 是稳定的、可行动的错误码（宿主原样展示）。 */
export interface CursorFailure {
  readonly code: string;
  readonly detail?: string;
  readonly message: string;
  readonly retryable: boolean;
}

/**
 * 启动阶段（Agent.create / resume）失败。带稳定错误码，宿主据此给出“模型不存在 / 需要登录”
 * 这类可行动的原因，而不是泛泛的“启动失败”。
 */
export class CursorStartError extends Error {
  readonly code: string;
  readonly detail: string | undefined;

  constructor(code: string, message: string, detail?: string) {
    super(message);
    this.name = "CursorStartError";
    this.code = code;
    this.detail = detail;
  }
}

export function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : "";
}

function errorStatusOf(error: unknown): number | undefined {
  return num(asRecord(error)?.["status"]);
}

/** 把执行端返回的错误文本归类为稳定的错误码，方便界面本地化与主 Agent 判断是否值得重试。 */
export function classifyError(message: string): { code: string; retryable: boolean } {
  const text = message.toLowerCase();
  if (
    /model.{0,60}(not found|not supported|does not exist)|unknown model|invalid model|unsupported model|model_not_found/.test(
      text,
    )
  ) {
    return { code: "model_not_found", retryable: false };
  }
  if (
    /\b401\b|unauthori[sz]ed|invalid api key|authentication|not logged in|login required|credential|api key/.test(
      text,
    )
  ) {
    return { code: "auth_failed", retryable: false };
  }
  if (/\b429\b|rate.?limit|usage.?limit|quota|too many requests|insufficient/.test(text)) {
    return { code: "rate_limited", retryable: true };
  }
  if (/context (length|window)|too long|maximum context|token limit|context_length/.test(text)) {
    return { code: "context_overflow", retryable: false };
  }
  if (/overloaded|\b5\d\d\b|unavailable|timeout|timed out|econnreset|enotfound|network|fetch failed/.test(text)) {
    return { code: "provider_unavailable", retryable: true };
  }
  return { code: "model_error", retryable: false };
}

/** SDK 抛出的类型化错误优先；其余按文本归类。 */
function sdkErrorCode(error: unknown): string {
  const name = errorNameOf(error);
  const status = errorStatusOf(error);
  if (name === "AuthenticationError" || status === 401) return "auth_failed";
  if (name === "RateLimitError" || status === 429) return "rate_limited";
  if (name === "NetworkError" || (status !== undefined && status >= 500)) return "provider_unavailable";
  return classifyError(errorMessage(error)).code;
}

export function sdkErrorDetail(error: unknown): string | undefined {
  const record = asRecord(error);
  const bits = [
    str(record?.["code"]) ? `Cursor error code: ${str(record?.["code"])}` : undefined,
    str(record?.["requestId"]) ? `request ${str(record?.["requestId"])}` : undefined,
    str(record?.["operation"]) ? `during ${str(record?.["operation"])}` : undefined,
  ].filter(isString);
  return bits.length > 0 ? bits.join(", ") : undefined;
}

export function isAuthFailure(error: unknown): boolean {
  return sdkErrorCode(error) === "auth_failed";
}

export function sdkFailure(error: unknown, fallbackMessage: string): CursorFailure {
  const message = clip(errorMessage(error) || fallbackMessage, 400);
  const detail = sdkErrorDetail(error);
  const code = sdkErrorCode(error);
  // SDK 的类型化错误自己带 isRetryable；其他错误按归类结果推断。
  const flagged = asRecord(error)?.["isRetryable"];
  const retryable = typeof flagged === "boolean" ? flagged : code === "rate_limited" || code === "provider_unavailable";
  return { code, message, ...(detail ? { detail } : {}), retryable };
}

/** 由一段错误文本（例如 RunResult.error.message）直接构造；`detail` 与文本相同时不重复记录。 */
export function failureFromText(message: string, detail?: string): CursorFailure {
  const classified = classifyError(message);
  return {
    code: classified.code,
    message: clip(collapseWhitespace(message), 400),
    ...(detail && detail !== message ? { detail: clip(detail, 2_000) } : {}),
    retryable: classified.retryable,
  };
}

/** Driver 的 run.failed 要求 retryable 为布尔、details 为原始值字典。 */
export function toRunError(failure: CursorFailure): RunError {
  return {
    code: failure.code,
    details: failure.detail ? { detail: failure.detail } : {},
    message: failure.message,
    retryable: failure.retryable,
  };
}

/** 把启动阶段的失败转换成可行动的错误。 */
export function toStartError(
  error: unknown,
  context: { resumeId: string | undefined; availableModels: string | undefined },
): CursorStartError {
  if (error instanceof CursorStartError) return error;
  if (context.resumeId && errorNameOf(error) === "AgentNotFoundError") {
    return new CursorStartError(
      "session_not_resumable",
      `Cursor can no longer find agent ${context.resumeId} (it may have been deleted, or it belongs to another workspace).`,
      sdkErrorDetail(error),
    );
  }
  const failure = sdkFailure(error, "Cursor could not start the agent.");
  const hint =
    failure.code === "model_not_found" && context.availableModels
      ? ` Available models: ${context.availableModels}.`
      : "";
  return new CursorStartError(failure.code, `${failure.message}${hint}`, failure.detail);
}
