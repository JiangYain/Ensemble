import { ACCEPTS_HEADER, INVALID_TOKEN, TOKEN_HEADER, type ServiceFeature } from "@shared/constants";
import type { ErrorBody } from "@shared/protocol";
import { ensureService, readServiceFile, probeService, protocolCompatible, serviceSupports, type ServiceFile } from "../server/discovery";
import type { EnsemblePaths } from "../server/paths";

/** 服务返回的业务错误（带机器可读的 code，便于 MCP 文本给出恰当提示）。 */
export class ServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export interface RequestOptions {
  body?: unknown;
  /** 请求整体超时；长轮询（wait）需要比它自己的等待时间更长。 */
  timeoutMs?: number;
  signal?: AbortSignal | undefined;
  /**
   * 成功响应怎么读：缺省按 JSON；导出报告（返回 Markdown 文本）的路由用 "text"，原样交回正文。
   * 出错时服务端回的永远是 JSON 错误体（见 ErrorBody），与这个选项无关——所以失败的报告请求照样得到带 code 的 ServiceError。
   */
  as?: "json" | "text";
  /**
   * 请求体是按“构造它时连着的那个服务”声明的功能（`supports`）写的，而不认识某个字段的老服务会把它静默丢掉
   * （例如 `delegate` 的 `profile`：角色里的只读就变成了完全访问）。请求因令牌被拒或连接被拒绝而重试时，重新发现连上的可能是另一个服务；
   * 它声明的功能与之前不同，原来的请求体就不能原样重发——给了这个回调，客户端改为请它按新服务重新构造（此时 `supports` 读到的已经是新服务；
   * 回调可以抛错，让这次请求被拒绝而不是发出去）。
   * 没有重试、或重新发现后功能没有变（服务重启成同一个版本是最常见的），一律照旧重发 `body`：行为、耗时与日志都不变。
   */
  rebuildBody?: () => Promise<unknown>;
}

export interface ServiceClientOptions {
  paths: EnsemblePaths;
  /** 默认以独立进程按需拉起服务；测试可以注入已经启动的服务。 */
  ensure?: (paths: EnsemblePaths) => Promise<ServiceFile>;
  fetchImpl?: typeof fetch;
}

/** MCP 桥访问本地服务的 HTTP 客户端：按需拉起服务，连接失败时重新发现一次。 */
export class ServiceClient {
  private file: ServiceFile | undefined;
  private connecting: Promise<ServiceFile> | undefined;
  private readonly ensure: (paths: EnsemblePaths) => Promise<ServiceFile>;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ServiceClientOptions) {
    this.ensure = options.ensure ?? ((paths) => ensureService({ paths }));
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** 当前已连接的服务信息（尚未连接时返回 undefined）。 */
  current(): ServiceFile | undefined {
    return this.file;
  }

  /**
   * 已连接的服务是否声明支持某个可协商功能（见 SERVICE_FEATURES）。尚未连接、或服务没有声明（老服务），都按“不支持”。
   * 调用方要先确保已经连接过（任何一次 request 之后都是）。
   */
  supports(feature: ServiceFeature): boolean {
    return serviceSupports(this.file, feature);
  }

  async connect(): Promise<ServiceFile> {
    if (this.file) return this.file;
    this.connecting ??= (async () => {
      try {
        const existing = await readServiceFile(this.options.paths);
        const file = existing && (await probeService(existing)) ? existing : await this.ensure(this.options.paths);
        if (!protocolCompatible(file)) {
          throw new ServiceError(
            "protocol_mismatch",
            `The running Ensemble service (v${file.version}) speaks protocol ${file.protocol}, which this plugin does not understand. Stop it (\`node dist/ensemble.mjs stop\`) and try again.`,
            0,
          );
        }
        this.file = file;
        return file;
      } finally {
        this.connecting = undefined;
      }
    })();
    return this.connecting;
  }

  async request<T>(method: "GET" | "POST" | "DELETE", path: string, options: RequestOptions = {}): Promise<T> {
    const file = await this.connect();
    try {
      return await this.once<T>(file, method, path, options);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const rejectedToken = error instanceof ServiceError && error.code === INVALID_TOKEN && error.status === 403;
      if (error instanceof ServiceError && !rejectedToken) throw error;
      // 只在“确定没有送达”时重试：连接被拒绝说明请求根本没到服务；
      // 连接中途被掐断时请求可能已被处理，只对只读请求重试，避免重复委派。
      const retry = rejectedToken || connectionRefused(error) || (method === "GET" && connectionDropped(error));
      if (!retry) throw error;
      // A rejected token never reaches a handler, so even a mutation can be retried once.
      if (this.file === file) this.file = undefined;
      const current = await this.connect();
      if (rejectedToken && current.token === file.token) throw error;
      // 连上的服务声明的功能变了（例如换成了更老的版本）：原来的请求体按旧服务的能力写，不能原样重发给它，见 `rebuildBody`。
      if (options.rebuildBody && !sameFeatures(file, current)) {
        return this.once<T>(current, method, path, { ...options, body: await options.rebuildBody() });
      }
      return this.once<T>(current, method, path, options);
    }
  }

  private async once<T>(file: ServiceFile, method: string, path: string, options: RequestOptions): Promise<T> {
    const signals = [AbortSignal.timeout(options.timeoutMs ?? 30_000)];
    if (options.signal) signals.push(options.signal);

    const response = await this.fetchImpl(`${file.url}${path}`, {
      method,
      headers: {
        [TOKEN_HEADER]: file.token,
        "x-ensemble-client": "mcp",
        // 声明这个桥读得懂“提问”：新服务据此才把提问这种值得留意的事项交给它（老桥不带这个头，见 ACCEPTS_HEADER）。
        [ACCEPTS_HEADER]: "session-questions" satisfies ServiceFeature,
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.any(signals),
    });

    const text = await response.text();
    if (response.ok && options.as === "text") return text as T;
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new ServiceError("bad_response", `The Ensemble service returned a non-JSON response (HTTP ${response.status}).`, response.status);
    }
    if (!response.ok) {
      const body = parsed as Partial<ErrorBody>;
      throw new ServiceError(
        body.error?.code ?? "http_error",
        body.error?.message ?? `The Ensemble service answered HTTP ${response.status}.`,
        response.status,
        body.error?.details,
      );
    }
    return parsed as T;
  }

  /** 面板地址；传入会话 id 时直接聚焦到该会话。 */
  async panelUrl(sessionId?: string): Promise<string> {
    const file = await this.connect();
    return sessionId ? `${file.url}/#/s/${encodeURIComponent(sessionId)}` : `${file.url}/`;
  }
}

/** 两次发现到的服务声明的功能是否一样：与顺序无关；没有声明（老服务）与空列表都是“什么都不支持”，算一样。 */
function sameFeatures(a: Pick<ServiceFile, "features">, b: Pick<ServiceFile, "features">): boolean {
  const before = new Set(a.features ?? []);
  const after = new Set(b.features ?? []);
  return before.size === after.size && [...before].every((feature) => after.has(feature));
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const cause = (error as Error & { cause?: { code?: string } }).cause;
  return cause?.code ?? (error as NodeJS.ErrnoException).code;
}

function connectionRefused(error: unknown): boolean {
  return errorCode(error) === "ECONNREFUSED";
}

function connectionDropped(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ECONNRESET" || code === "UND_ERR_SOCKET" || (error instanceof TypeError && code === undefined);
}
