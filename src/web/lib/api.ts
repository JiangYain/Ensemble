import { TOKEN_HEADER, TOKEN_META_NAME } from "@shared/constants";
import type {
  AnswerQuestionRequest,
  ArchiveRequest,
  ArchiveResponse,
  CancelResponse,
  DeclineQuestionRequest,
  ErrorBody,
  EventsResponse,
  GitResponse,
  ProfilesResponse,
  PutProfileRequest,
  QuestionResolvedResponse,
  RenameProfileRequest,
  RetentionResponse,
  RetentionSettings,
  SendRequest,
  SendResponse,
  SessionDetail,
  SetAllowedModelsRequest,
  SetAllowedModelsResponse,
  SetConcurrencyRequest,
  SetConcurrencyResponse,
  StateSnapshot,
  UnarchiveRequest,
} from "@shared/protocol";
import type { QuestionId } from "@shared/questions";
import type { ReportDetail, ReportLang, ReportScope } from "@shared/report-options";
import type { HarnessId, SessionId, SessionSummary } from "@shared/types";

/** 服务在返回网页时把访问令牌写进 <meta>；开发服务器下也允许用 ?token= 提供。 */
function readToken(): string {
  const meta = document.querySelector(`meta[name="${TOKEN_META_NAME}"]`)?.getAttribute("content");
  if (meta) return meta;
  return new URLSearchParams(location.search).get("token") ?? "";
}

export const token = readToken();

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    /** 服务端随错误附带的事实（例如回答提问时提问已有的结局）；没有则省略。 */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: { [TOKEN_HEADER]: token, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError("network", "Cannot reach the Ensemble service", 0);
  }
  const text = await response.text();
  let parsed: unknown = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = {};
    }
  }
  if (!response.ok) {
    const error = (parsed as Partial<ErrorBody>).error;
    throw new ApiError(error?.code ?? "http_error", error?.message ?? `HTTP ${response.status}`, response.status, error?.details);
  }
  return parsed as T;
}

/** 服务端的错误回执（`{ error: { code, message } }`）→ ApiError；读不出来就退回状态码。 */
function apiErrorOf(text: string, status: number): ApiError {
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = {};
  }
  const error = (parsed as Partial<ErrorBody>).error;
  return new ApiError(error?.code ?? "http_error", error?.message ?? `HTTP ${status}`, status);
}

/**
 * 读文本回执（导出的 Markdown 报告）：令牌放在请求头里、不进链接；错误映射与 request 一致，成功的回执不按 JSON 解析。
 * 同时交出 Content-Disposition：文件名由服务端起（见 filenameFromDisposition）。
 */
async function requestText(path: string, signal?: AbortSignal): Promise<{ text: string; disposition: string | null }> {
  let response: Response;
  try {
    response = await fetch(path, { method: "GET", headers: { [TOKEN_HEADER]: token }, ...(signal ? { signal } : {}) });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError("network", "Cannot reach the Ensemble service", 0);
  }
  const text = await response.text();
  if (!response.ok) throw apiErrorOf(text, response.status);
  return { text, disposition: response.headers?.get("content-disposition") ?? null };
}

/**
 * 从 Content-Disposition 取文件名：优先 RFC 5987 的 `filename*=UTF-8''…`（百分号编码，带中文的标题靠它），
 * 其次普通的 `filename="…"` 或 `filename=…`。取不到、或清洗后是空的就返回 undefined，由调用方用自己的兜底名。
 * 路径分隔符与控制字符一律换成下划线：文件名是别处给的，不能让它带着目录跑出下载目录。
 */
export function filenameFromDisposition(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  let name: string | undefined;
  const extended = /filename\*\s*=\s*([^;]+)/i.exec(header)?.[1]?.trim();
  if (extended) {
    // 形如 UTF-8'zh'%E6%8A%A5%E5%91%8A.md：字符集、语言、百分号编码的值。
    const parts = /^[\w-]+'[^']*'(.*)$/.exec(extended);
    try {
      name = decodeURIComponent(parts?.[1] ?? extended);
    } catch {
      name = undefined;
    }
  }
  if (!name) {
    const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header)?.[1];
    name = quoted !== undefined ? quoted.replace(/\\(.)/g, "$1") : /filename\s*=\s*([^;"]+)/i.exec(header)?.[1]?.trim();
  }
  const safe = name?.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "").trim().slice(0, 150);
  return safe ? safe : undefined;
}

/** 服务端没给文件名时自己起的：带上范围与会话 id 的前一段，足够在下载目录里区分。 */
export function fallbackReportName(id: SessionId, options: Pick<ReportOptions, "scope">): string {
  const head = id.replace(/[^\w-]/g, "_").slice(0, 16);
  return `ensemble-${options.scope}-${head}.md`;
}

/** 导出报告的选项（语义见 `GET /api/sessions/:id/report`）：scope 单个会话或整棵任务树，detail 摘要或带工具输出，lang 报告的语言。 */
export interface ReportOptions {
  scope: ReportScope;
  detail: ReportDetail;
  lang: ReportLang;
}

const enc = encodeURIComponent;

/**
 * 版本兼容：网页可能连着比它旧的服务。服务端用 zod 校验请求体，对象默认丢掉不认识的字段而不是报错，
 * 所以在已有端点的请求体里多发一个字段，旧服务会“照常成功”地把它忽略；而新增的端点在旧服务上是显式的 404（没有这条路由）。
 * 下面每个请求属于哪一类，在 api.requests.test.ts 里逐个登记（新增一个请求要在那里选边，不选边那条测试会红）：
 *  · 与旧服务一致：路由与请求体字段旧服务都认得；
 *  · 新路由：旧服务回 404，用户走不到这一步——快照里缺少对应字段（concurrency / profiles / archivedCount）时界面不提供入口，提问则是旧服务根本不会产生；
 *  · 已有路由上的新参数：只有 `sessions` 的 `archived`（旧服务忽略它、回全部会话），所以已归档列表只在快照带 archivedCount 时才会去读。
 * 新路由上还有一处静默丢字段：取消归档的 `exact`，只有更早的、已经认得归档却还不认得它的服务才会丢掉它（认得归档的服务才有这条路由）。
 * 后果是撤销时多恢复几个会话，提示里照实写了恢复的个数（见 shared/protocol.ts 的 UnarchiveRequest 与 archive.test.ts），所以没有为它降级。
 */
export const api = {
  state: (signal?: AbortSignal) => request<StateSnapshot>("GET", "/api/state", undefined, signal),
  harnesses: (refresh = false) => request<{ harnesses: StateSnapshot["harnesses"] }>("GET", `/api/harnesses${refresh ? "?refresh=1" : ""}`),
  /**
   * 设置主 Agent 可以选用哪些模型（null 表示不限制）、各模型的推理档位，以及用户指定的默认模型（字符串＝指定，
   * null＝恢复执行端自己的默认，省略＝不改动）。服务端存盘，所有宿主与页面共用。
   */
  setAllowedModels: (harness: HarnessId, allowed: string[] | null, efforts?: Record<string, string[]>, userDefaultModel?: string | null) =>
    request<SetAllowedModelsResponse>("PUT", `/api/harnesses/${enc(harness)}/models`, {
      allowed,
      ...(efforts ? { efforts } : {}),
      ...(userDefaultModel !== undefined ? { userDefaultModel } : {}),
    } satisfies SetAllowedModelsRequest),
  /**
   * 指定全局并发上限（正整数或 "unlimited"）；null 清掉指定、回到环境变量 / 内置默认。服务端落盘后立即生效，
   * 所有宿主与页面共用；回执是生效后的容量与设置。
   */
  setConcurrency: (max: SetConcurrencyRequest["max"]) =>
    request<SetConcurrencyResponse>("PUT", "/api/settings/concurrency", { max } satisfies SetConcurrencyRequest),
  /**
   * 角色（委派预设）的写入：每次只动一个角色，回执是生效后的整张角色表。服务端落盘后才生效，所有宿主与页面共用。
   * `putProfile` 新增或整条改写（没给的字段＝不固定）；`create` 为 true 时名字已存在就拒绝。名字原样放进路径：无效的旧名字（手改文件造成）也要能改、能删。
   */
  putProfile: (name: string, body: PutProfileRequest) => request<ProfilesResponse>("PUT", `/api/profiles/${enc(name)}`, body),
  removeProfile: (name: string) => request<ProfilesResponse>("DELETE", `/api/profiles/${enc(name)}`),
  renameProfile: (name: string, to: string) =>
    request<ProfilesResponse>("POST", `/api/profiles/${enc(name)}/rename`, { to } satisfies RenameProfileRequest),
  session: (id: SessionId, signal?: AbortSignal) => request<SessionDetail>("GET", `/api/sessions/${enc(id)}`, undefined, signal),
  git: (path: string, signal?: AbortSignal) => request<GitResponse>("GET", `/api/git?path=${enc(path)}`, undefined, signal),
  events: (id: SessionId, after: number) => request<EventsResponse>("GET", `/api/sessions/${enc(id)}/events?after=${after}`),
  send: (id: SessionId, body: SendRequest) => request<SendResponse>("POST", `/api/sessions/${enc(id)}/messages`, body),
  /**
   * 回答执行端的提问（不是授权）：只有一个问题时 `answer` 最简，否则 `answers` 每个问题一项。回执是写进日志的结局；
   * 执行端已经不再等待（回合结束、被撤回……）时是 409，提问同时被记为过期，调用方要如实告诉用户回答没有送达。
   */
  answerQuestion: (id: SessionId, questionId: QuestionId, body: AnswerQuestionRequest) =>
    request<QuestionResolvedResponse>("POST", `/api/sessions/${enc(id)}/questions/${enc(questionId)}/answer`, body),
  /** 不回答：告知执行端自行判断。 */
  declineQuestion: (id: SessionId, questionId: QuestionId, body: DeclineQuestionRequest = {}) =>
    request<QuestionResolvedResponse>("POST", `/api/sessions/${enc(id)}/questions/${enc(questionId)}/decline`, body),
  cancel: (id: SessionId) => request<CancelResponse>("POST", `/api/sessions/${enc(id)}/cancel`, {}),
  stop: (id: SessionId) => request<{ summary: SessionSummary }>("POST", `/api/sessions/${enc(id)}/stop`, {}),
  remove: (id: SessionId) => request<{ removed: SessionId }>("DELETE", `/api/sessions/${enc(id)}`),
  /** 会话列表。`archived` 选“不含 / 含 / 只要”已归档的；不传＝服务端默认（不含）。 */
  sessions: (options: { archived?: "exclude" | "include" | "only" } = {}, signal?: AbortSignal) =>
    request<{ sessions: SessionSummary[] }>("GET", `/api/sessions${options.archived ? `?archived=${options.archived}` : ""}`, undefined, signal),
  /** 归档按子树：回执里 changed 是实际变化的会话（含随上级一起归档的下级），skipped 写明没动的原因。 */
  archive: (ids: SessionId[]) => request<ArchiveResponse>("POST", "/api/sessions/archive", { ids } satisfies ArchiveRequest),
  /**
   * 取消归档：被点名的会话、它仍归档的下级，加上仍归档的上级链。`exact` 时只恢复点名的会话（撤销刚才那次归档用）。
   * 只有 `exact` 为真才写进请求体：直接取消归档的请求体仍是 `{ ids }`，与原来一字不差（旧服务不认识 `exact`，会把它丢掉）。
   */
  unarchive: (ids: SessionId[], options: { exact?: boolean } = {}) =>
    request<ArchiveResponse>("POST", "/api/sessions/unarchive", { ids, ...(options.exact ? { exact: true } : {}) } satisfies UnarchiveRequest),
  /** 留存策略与最近一次清扫；PUT 整份替换（两项各自独立，null＝不限），回执是生效后的样子。 */
  retention: (signal?: AbortSignal) => request<RetentionResponse>("GET", "/api/retention", undefined, signal),
  setRetention: (body: RetentionSettings) => request<RetentionResponse>("PUT", "/api/retention", body),
  /** 导出某个会话（或它的整棵任务树）的 Markdown 复盘报告：返回文本与建议的文件名，保存由调用方做（见 lib/download.ts）。 */
  report: async (id: SessionId, options: ReportOptions, signal?: AbortSignal): Promise<{ text: string; filename: string }> => {
    const query = new URLSearchParams({ scope: options.scope, detail: options.detail, lang: options.lang });
    const { text, disposition } = await requestText(`/api/sessions/${enc(id)}/report?${query.toString()}`, signal);
    return { text, filename: filenameFromDisposition(disposition) ?? fallbackReportName(id, options) };
  },
};

export function streamUrl(): string {
  return `/api/stream?token=${encodeURIComponent(token)}`;
}
