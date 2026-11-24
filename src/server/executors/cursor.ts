import { basename } from "node:path";
import {
  CURSOR_API_KEY_VARIABLE,
  CURSOR_DEFAULT_SETTING_SOURCES,
  CURSOR_SDK_PACKAGE,
  CURSOR_SETTING_SOURCES,
  cursorFailure,
} from "@mosoo/agent-driver";
import { CURSOR_SDK_VERSION, ENV } from "@shared/constants";
import { clip, errorMessage, isoNow } from "@shared/format";
import type { AccessEnforcement, AccessLevel, Capabilities, HarnessInfo, ModelInfo } from "@shared/types";
import { CursorDriverSession } from "../driver/cursor-driver-session";
import { parseCatalog, pickDefaultModel, resolveModel, toModelInfo, type CatalogModel } from "./cursor-catalog";
import { defaultSdkLoader, type CursorSdk, type CursorSdkLoader, type LoadedCursorSdk } from "./cursor-sdk-loader";
import { HarnessStartError, asRecord, str, type Json } from "./common";
import type { Executor, ExecutorSession, OpenInput } from "./types";

/**
 * Cursor 适配器：通过 Driver Kernel 驱动一个完整的 Cursor Agent 会话。
 *
 * 会话本身由 `../driver/cursor-driver-session.ts` 承载：Ensemble 在进程内持有 mosoo agent-driver 的本地副本
 * （`vendor/mosoo-agent-driver`，见 VENDORING.md），其中的 Cursor SDK 后端负责与 `@cursor/sdk`（本地 Agent）对话，
 * 内核负责命令与终态纪律；SDK 消息到事件的映射及其依据写在后端的 `cursor-event-translator.ts` 里。
 * 本文件只保留宿主侧的事：探测与登录状态、模型目录缓存、把解析好的模型与访问级别交给会话。
 * SDK 的加载在 `cursor-sdk-loader.ts`，模型目录与档位解析在 `cursor-catalog.ts`。
 *
 * 诚实声明：capabilities 的 verification 一律是 declared（按 SDK 文档与源码声明），不是 live。真实数据有两份：
 * 2026-11-08 经用户自己的 SDK 网关（SDK 1.0.28）做的一次最小运行，事件的顺序与形状已做成回放测试
 * （cursor-events.test.ts 的 “replays a real run…”）；2026-11-14 经本执行端在真实账号上完成了一次真实只读运行。
 * 纠偏、取消、恢复和只读强制在真实账号上仍没有逐项验证过；验证一项，再把对应能力改成 live。
 */

/** 各能力均为“按 SDK 文档声明”，没有在真实账号上验证过。 */
const CURSOR_CAPABILITIES: Capabilities = {
  // Run.steer() 是可选方法；本地控制器不支持注入时 SDK 会回答 revert_to_followup，所以只能说“部分支持”。
  steer: { support: "partial", mode: "immediate_or_follow_up", verification: "declared" },
  followUp: { support: "yes", mode: "after_run", verification: "declared" },
  cancel: { support: "yes", verification: "declared" },
  resume: { support: "yes", verification: "declared" },
  // thinking 事件存在，但文本可能为空，只带时长。
  reasoning: { support: "partial", verification: "declared" },
  // 只有 updateTodos 工具带出的待办清单。
  plan: { support: "partial", verification: "declared" },
  usage: { support: "yes", verification: "declared" },
  // 只能从 edit / delete 等工具调用得知文件变更；shell 里的改动看不到。
  fileEvents: { support: "partial", verification: "declared" },
};

const CURSOR_ACCESS: Record<AccessLevel, AccessEnforcement | null> = {
  read_only: {
    level: "enforced",
    mechanism:
      "Cursor SDK tool allowlist: read, grep, glob, ls, semSearch, readLints, readTodos, updateTodos (no shell / edit / delete / subagents / MCP; the two todo tools only touch the session's own to-do list). Documented SDK behaviour, not yet verified against a live run; Ensemble flags any mutating tool call it still sees and tries to stop the run.",
  },
  full: {
    level: "none",
    mechanism: "Cursor local agents run their tools directly on this machine: no sandbox and no approval prompts (the SDK has no interactive approval channel)",
  },
};

const PROBE_TIMEOUT_MS = 20_000;
const AUTH_STATUS_TIMEOUT_MS = 10_000;
/** steer() 最多等这么久；超过就先回报“已交给执行端”，之后的结论异步补报。 */
const STEER_ACK_WINDOW_MS = 2_000;
const CATALOG_TTL_MS = 10 * 60_000;

// ───────────────────────── 小工具 ─────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)}s`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function apiKeyOf(env: NodeJS.ProcessEnv): string | undefined {
  const key = env[CURSOR_API_KEY_VARIABLE]?.trim();
  return key ? key : undefined;
}

/** 解析 ENSEMBLE_CURSOR_SETTINGS；默认只加载项目层（规则、AGENTS.md），不加载用户层与团队层。 */
export function settingSourcesFrom(env: NodeJS.ProcessEnv): string[] {
  const raw = env[ENV.cursorSettings]?.trim().toLowerCase();
  if (!raw) return [...CURSOR_DEFAULT_SETTING_SOURCES];
  if (raw === "none") return [];
  const sources = raw.split(/[\s,]+/).filter((part) => CURSOR_SETTING_SOURCES.has(part));
  return sources.length > 0 ? sources : [...CURSOR_DEFAULT_SETTING_SOURCES];
}

function loginCommand(): string {
  const entry = process.argv[1];
  const script = entry && basename(entry) === "ensemble.mjs" ? entry : "dist/ensemble.mjs";
  return `node "${script}" cursor-login`;
}

function installCommand(runtimeDir: string | undefined): string {
  return `npm install --prefix "${runtimeDir ?? "<Ensemble home>/runtime"}" --no-audit --no-fund ${CURSOR_SDK_PACKAGE}@${CURSOR_SDK_VERSION}`;
}

// ───────────────────────── 执行端 ─────────────────────────

export interface CursorExecutorOptions {
  env?: NodeJS.ProcessEnv;
  /** Ensemble 管理的依赖目录（<home>/runtime）：其中的 node_modules/@cursor/sdk 可作为备选位置。 */
  runtimeDir?: string;
  /** 测试用：直接提供 SDK。 */
  loadSdk?: CursorSdkLoader;
  /** 测试用：steer() 等待 SDK 确认的时长。 */
  steerAckMs?: number;
}

export class CursorExecutor implements Executor {
  readonly id = "cursor" as const;
  readonly runtime = "native" as const;
  readonly canResume = true;

  private readonly loader: CursorSdkLoader;
  private catalog: CatalogModel[] | undefined;
  private catalogAt = 0;

  constructor(private readonly options: CursorExecutorOptions = {}) {
    this.loader = options.loadSdk ?? defaultSdkLoader({ env: this.env, runtimeDir: options.runtimeDir });
  }

  private get env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }

  private requestOptions(): Json | undefined {
    const apiKey = apiKeyOf(this.env);
    return apiKey ? { apiKey } : undefined;
  }

  private async catalogFor(sdk: CursorSdk): Promise<CatalogModel[] | undefined> {
    if (this.catalog && Date.now() - this.catalogAt < CATALOG_TTL_MS) return this.catalog;
    try {
      const raw = await withTimeout(sdk.Cursor.models.list(this.requestOptions()), PROBE_TIMEOUT_MS, "Cursor.models.list()");
      this.catalog = parseCatalog(raw);
      this.catalogAt = Date.now();
    } catch {
      // 目录取不到时沿用旧的（可能过期）；SDK 自己会校验模型 id。
    }
    return this.catalog;
  }

  async probe(): Promise<HarnessInfo> {
    const base = {
      id: "cursor" as const,
      displayName: "Cursor",
      runtime: "native" as const,
      capabilities: CURSOR_CAPABILITIES,
      access: CURSOR_ACCESS,
      models: [] as ModelInfo[],
    };

    let loaded: LoadedCursorSdk;
    try {
      loaded = await this.loader();
    } catch (error) {
      return {
        ...base,
        status: "unavailable",
        setup: {
          code: "cursor_sdk_missing",
          message: `The Cursor SDK (${CURSOR_SDK_PACKAGE}) could not be loaded: ${clip(errorMessage(error), 300)}`,
          command: installCommand(this.options.runtimeDir),
        },
        checkedAt: isoNow(),
      };
    }
    const { sdk } = loaded;
    const version = loaded.version ? `SDK ${loaded.version}` : undefined;
    const withVersion = { ...base, ...(version ? { version } : {}) };

    // 先问 SDK 有没有可用的凭据：它只返回状态，不会返回密钥。
    const hasEnvKey = apiKeyOf(this.env) !== undefined;
    let storedEmail: string | undefined;
    let loggedOut = false;
    try {
      const auth = asRecord(await withTimeout(sdk.Cursor.auth.status(), AUTH_STATUS_TIMEOUT_MS, "Cursor.auth.status()"));
      loggedOut = str(auth?.["status"]) === "logged-out";
      storedEmail = str(auth?.["email"]);
    } catch {
      // 状态查询失败不等于没登录；交给下面的真实调用判断。
    }
    if (loggedOut && !hasEnvKey) {
      return {
        ...withVersion,
        status: "needs_setup",
        setup: {
          code: "cursor_login_required",
          message: "Cursor has no credentials. Set CURSOR_API_KEY (Cursor Dashboard → Integrations) or sign in with the SDK.",
          command: loginCommand(),
        },
        checkedAt: isoNow(),
      };
    }

    const request = this.requestOptions();
    const [modelsResult, meResult] = await Promise.allSettled([
      withTimeout(sdk.Cursor.models.list(request), PROBE_TIMEOUT_MS, "Cursor.models.list()"),
      withTimeout(sdk.Cursor.me(request), PROBE_TIMEOUT_MS, "Cursor.me()"),
    ]);

    if (modelsResult.status === "rejected") {
      const failure = cursorFailure(modelsResult.reason, "Cursor did not answer the model list request.");
      if (failure.code === "auth_failed") {
        return {
          ...withVersion,
          status: "needs_setup",
          setup: {
            code: "cursor_auth_rejected",
            message: `Cursor rejected the credentials (${clip(failure.message, 160)}). Create a new API key and set CURSOR_API_KEY, or sign in again.`,
            command: loginCommand(),
          },
          checkedAt: isoNow(),
        };
      }
      return {
        ...withVersion,
        status: "unavailable",
        setup: { code: "cursor_probe_failed", message: failure.message },
        checkedAt: isoNow(),
      };
    }

    const catalog = parseCatalog(modelsResult.value);
    this.catalog = catalog;
    this.catalogAt = Date.now();
    const defaultModel = pickDefaultModel(catalog);
    const me = meResult.status === "fulfilled" ? asRecord(meResult.value) : undefined;
    const account = str(me?.["userEmail"]) ?? str(me?.["apiKeyName"]) ?? storedEmail;

    const info: HarnessInfo = {
      ...withVersion,
      status: catalog.length > 0 ? "ready" : "needs_setup",
      models: catalog.map((model) => toModelInfo(model, defaultModel)),
      ...(defaultModel ? { defaultModel } : {}),
      ...(account ? { account } : {}),
      checkedAt: isoNow(),
    };
    if (catalog.length === 0) {
      info.setup = { code: "cursor_no_models", message: "Cursor returned no models for this account." };
    }
    return info;
  }

  async open(input: OpenInput): Promise<ExecutorSession> {
    let loaded: LoadedCursorSdk;
    try {
      loaded = await this.loader();
    } catch (error) {
      throw new HarnessStartError("harness_unavailable", `The Cursor SDK (${CURSOR_SDK_PACKAGE}) is not available: ${clip(errorMessage(error), 300)}`);
    }
    const { meta } = input;
    const model = resolveModel(await this.catalogFor(loaded.sdk), meta);
    const session = new CursorDriverSession(input, {
      agentName: clip(meta.title, 80),
      apiKey: apiKeyOf(this.env),
      effort: model.effort,
      modelHint: model.available,
      modelId: model.id,
      modelLabel: model.label,
      modelParams: model.params,
      readOnly: meta.access === "read_only",
      settingSources: settingSourcesFrom(this.env),
      steerAckMs: this.options.steerAckMs ?? STEER_ACK_WINDOW_MS,
      loadSdk: async () => (await this.loader()).sdk,
    });
    try {
      await session.start();
    } catch (error) {
      await session.close();
      throw error;
    }
    return session;
  }
}
