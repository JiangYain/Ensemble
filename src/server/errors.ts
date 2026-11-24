import { errorMessage } from "@shared/format";
import { INVALID_TOKEN } from "@shared/constants";
import type { ErrorInfo } from "@shared/types";

/** 对外可见的、带稳定错误代码的业务错误（HTTP 层映射为 4xx/5xx）。 */

export type ErrorCode =
  | "invalid_request"
  | "not_found"
  | "forbidden"
  | typeof INVALID_TOKEN
  | "conflict"
  | "harness_unavailable"
  | "harness_needs_setup"
  | "access_unsupported"
  | "model_settings_unavailable"
  | "model_not_allowed"
  | "effort_not_allowed"
  | "profile_not_found"
  | "profile_unusable"
  | "depth_exceeded"
  | "context_session_active"
  | "context_too_large"
  | "session_closed"
  | "session_not_resumable"
  | "question_unsupported"
  | "internal";

const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  not_found: 404,
  forbidden: 403,
  [INVALID_TOKEN]: 403,
  conflict: 409,
  harness_unavailable: 422,
  harness_needs_setup: 422,
  access_unsupported: 422,
  model_settings_unavailable: 422,
  model_not_allowed: 422,
  effort_not_allowed: 422,
  profile_not_found: 422,
  profile_unusable: 422,
  depth_exceeded: 422,
  // 引用的会话还在运行：它现在还没有最终产出可以交接，等它结束（wait）再派；409 表示“状态不对，稍后可重试”
  context_session_active: 409,
  // 引用的个数或展开后的提示超出额度：请求本身的内容问题，改小再试
  context_too_large: 422,
  session_closed: 409,
  session_not_resumable: 409,
  question_unsupported: 422,
  internal: 500,
};

export class EnsembleError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "EnsembleError";
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return STATUS[this.code];
  }
}

/** 把任意抛出的值整理成可以写进事件的错误；`fallbackCode` 用于没有自带错误码的普通异常。 */
export function toErrorInfo(error: unknown, fallbackCode = "internal"): ErrorInfo {
  if (error instanceof EnsembleError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    const { code, detail } = error as { code?: unknown; detail?: unknown };
    // 适配器给出的 detail（例如执行端的 stderr）比 JS 调用栈更有用，优先使用。
    const fallbackDetail = error.stack ? error.stack.split("\n").slice(0, 6).join("\n") : undefined;
    const resolvedDetail = typeof detail === "string" && detail.length > 0 ? detail : fallbackDetail;
    return {
      code: typeof code === "string" ? code : fallbackCode,
      message: error.message,
      ...(resolvedDetail ? { detail: resolvedDetail } : {}),
    };
  }
  return { code: fallbackCode, message: errorMessage(error) };
}
