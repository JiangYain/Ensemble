import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, ENV, LIMITS, PROTOCOL_VERSION, SERVICE_FEATURES } from "@shared/constants";
import { isoNow } from "@shared/format";
import { ConcurrencyControl, decideConcurrency } from "./concurrency";
import {
  isProcessAlive,
  probeService,
  readServiceFile,
  removeServiceFile,
  writeServiceFile,
  type ServiceFile,
} from "./discovery";
import { createExecutors } from "./executors";
import { ExecutorRegistry } from "./executors/registry";
import type { Executor } from "./executors/types";
import { createGitInspector, type GitInspector } from "./git";
import { createHttpServer } from "./http/server";
import { historyModeFrom } from "./history-mode";
import { EventHub, type HubOptions } from "./hub";
import { createLogger, type Logger } from "./logger";
import { SessionManager, type ManagerConfig } from "./manager";
import { NoticeCenter } from "./notices";
import { pathsFor, type EnsemblePaths } from "./paths";
import { RetentionSweeper, type RetentionSweeperOptions } from "./retention";
import { concurrencyFromEnv, UNLIMITED_RUNS } from "./run-slots";
import { SettingsStore } from "./settings";
import { AttentionSupervisor, type SupervisorOptions } from "./supervisor";
import { FileEventStore } from "./store";

declare const __ENSEMBLE_VERSION__: string | undefined;

export function appVersion(): string {
  return typeof __ENSEMBLE_VERSION__ === "string" ? __ENSEMBLE_VERSION__ : "0.0.0-dev";
}

/**
 * 界面语言提示：`ENSEMBLE_LANG` 优先，否则取操作系统的区域设置；认不出来就不给提示，
 * 交给浏览器自己判断。宿主内置浏览器自带的语言偏好常常不是使用者本人的，所以服务端补一个依据。
 */
export function systemLang(env: NodeJS.ProcessEnv): "zh" | "en" | undefined {
  const fromTag = (tag: string | undefined): "zh" | "en" | undefined => {
    const lower = tag?.trim().toLowerCase() ?? "";
    if (lower.startsWith("zh")) return "zh";
    if (lower.startsWith("en")) return "en";
    return undefined;
  };
  const forced = fromTag(env["ENSEMBLE_LANG"]);
  if (forced) return forced;
  try {
    return fromTag(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return undefined;
  }
}

/** 读取非负整数环境变量；0 是有效值（端口 0 = 系统分配，空闲退出 0 = 不退出）。 */
function envInteger(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

export interface StartServiceOptions {
  home: string;
  /** 0 表示由系统分配；默认使用固定的 DEFAULT_PORT，被占用时退回到系统分配。 */
  port?: number;
  dev?: boolean;
  executors?: Executor[];
  env?: NodeJS.ProcessEnv;
  log?: Logger;
  /** null 表示不托管网页（测试）。默认自动定位 dist/web。 */
  webRoot?: string | null;
  managerConfig?: Partial<ManagerConfig>;
  /** 读取工作目录 Git 状态的实现；默认直接调用本机的 git（测试可以换成假的）。 */
  git?: GitInspector;
  /** 无工作且无连接时自动退出的时间；0 表示不自动退出。 */
  idleExitMs?: number;
  /** “值得留意”的判定阈值与复查节奏（测试里缩短，真实使用保持默认）。 */
  attention?: Omit<SupervisorOptions, "hub" | "log">;
  /** 历史会话冷热分离的参数：保温期、清扫间隔、事件缓存上限、时钟（测试里缩短，真实使用保持默认）。载入方式（lazy / eager）由环境变量决定。 */
  history?: Pick<HubOptions, "warmMs" | "sweepMs" | "eventCache" | "now">;
  /** 留存清扫的周期、时钟与批大小（测试里缩短，真实使用保持默认）。 */
  retention?: Pick<RetentionSweeperOptions, "intervalMs" | "now" | "batchSize">;
  /** 接管 SIGINT / SIGTERM 并在退出前做优雅收尾（CLI 使用）。 */
  handleSignals?: boolean;
  /** 退出时是否 process.exit（CLI 使用）。 */
  exitOnClose?: boolean;
}

export interface RunningService {
  url: string;
  port: number;
  token: string;
  paths: EnsemblePaths;
  hub: EventHub;
  manager: SessionManager;
  /** 全局并发上限这项设置（运行中改写、来源与存值）。 */
  concurrency: ConcurrencyControl;
  /** 留存策略的执行者（只归档、不删除）；测试可以直接触发一次清扫。 */
  retention: RetentionSweeper;
  notices: NoticeCenter;
  registry: ExecutorRegistry;
  close(reason?: string): Promise<void>;
  closed: Promise<void>;
}

export class AlreadyRunningError extends Error {
  constructor(readonly info: ServiceFile) {
    super(`Ensemble is already running at ${info.url}`);
    this.name = "AlreadyRunningError";
  }
}

export function locateWebRoot(): string | undefined {
  const override = process.env["ENSEMBLE_WEB_ROOT"];
  if (override && existsSync(join(override, "index.html"))) return override;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, "web"), join(here, "..", "..", "dist", "web"), join(here, "..", "web")]) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  return undefined;
}

async function acquireLock(paths: EnsemblePaths, log: Logger): Promise<() => Promise<void>> {
  await mkdir(paths.run, { recursive: true });
  const staleAfterMs = 4_000;
  const started = Date.now();

  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const handle = await open(paths.lockFile, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: isoNow() }));
      await handle.close();
      return async () => {
        const current = await readFile(paths.lockFile, "utf8").catch(() => "");
        if (current.includes(`"pid":${process.pid}`)) await rm(paths.lockFile, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const existing = await readServiceFile(paths);
    if (existing && isProcessAlive(existing.pid) && (await probeService(existing))) {
      throw new AlreadyRunningError(existing);
    }
    const holder = await readFile(paths.lockFile, "utf8")
      .then((text) => JSON.parse(text) as { pid?: number })
      .catch(() => undefined);
    const holderAlive = holder?.pid !== undefined && isProcessAlive(holder.pid);
    if (!holderAlive || Date.now() - started > staleAfterMs) {
      log.warn("removing stale service lock", { holder: holder?.pid });
      await rm(paths.lockFile, { force: true });
    } else {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  throw new Error("Could not acquire the Ensemble service lock.");
}

function listen(server: Server, port: number, log: Logger): Promise<number> {
  return new Promise((resolve, reject) => {
    const attempt = (target: number, allowFallback: boolean): void => {
      const onError = (error: NodeJS.ErrnoException): void => {
        server.off("listening", onListening);
        if (error.code === "EADDRINUSE" && allowFallback) {
          log.warn("default port is busy, falling back to a system-assigned port", { port: target });
          attempt(0, false);
          return;
        }
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve((server.address() as AddressInfo).port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(target, "127.0.0.1");
    };
    attempt(port, port !== 0);
  });
}

export async function startService(options: StartServiceOptions): Promise<RunningService> {
  const env = options.env ?? process.env;
  const paths = pathsFor(options.home);
  await mkdir(paths.sessions, { recursive: true });
  await mkdir(paths.logs, { recursive: true });

  const log = options.log ?? createLogger({ file: paths.serviceLog, level: env["ENSEMBLE_LOG_LEVEL"] === "debug" ? "debug" : "info" }, "service");
  const releaseLock = await acquireLock(paths, log);

  try {
    const startedAt = isoNow();
    const token = randomBytes(24).toString("base64url");
    const version = appVersion();

    const store = new FileEventStore(paths.sessions, log);
    // 历史会话怎样载入：默认 lazy（只读各会话的摘要快照，已结束的会话作为“冷会话”按需再读）；
    // ENSEMBLE_HISTORY_MODE=eager 退回老办法（启动时全部重放进内存），出了问题时用它排除冷热分离的影响。写错了按默认处理，只记一行警告、不挡启动。
    const historyChoice = historyModeFrom(env);
    if (historyChoice.ignored !== undefined) {
      log.warn(`ignoring unusable ${ENV.historyMode} (expected "lazy" or "eager")`, { value: historyChoice.ignored.slice(0, 80), fallback: historyChoice.mode });
    }
    const hub = new EventHub({ store, log, mode: historyChoice.mode, ...options.history });
    const loadStartedAt = Date.now();
    const loaded = await hub.load();
    const loadedCounts = hub.counts();
    log.info("sessions loaded", {
      count: loaded.length,
      hot: loadedCounts.hot,
      cold: loadedCounts.total - loadedCounts.hot,
      archived: loadedCounts.archived,
      mode: hub.mode,
      ms: Date.now() - loadStartedAt,
    });

    const settings = await SettingsStore.open(paths.settings, log);
    const executors = options.executors ?? createExecutors({ env, paths, log });
    const registry = new ExecutorRegistry(executors, log, { policy: settings });
    // 用户改了开放哪些模型：立即把带着新名单的执行端信息推给所有页面。
    settings.onChange((harness) => registry.policyChanged(harness));
    const notices = new NoticeCenter(hub);
    notices.rebuild();
    // 并发上限：显式的 managerConfig（测试、嵌入）> 用户在设置里指定的 > 环境变量 > 默认值（合成规则只在 concurrency.ts 一处）。
    // 环境变量写得无法解析时回落到默认值，只记一行警告，不挡启动。
    const envLimit = concurrencyFromEnv(env);
    if (envLimit.ignored !== undefined) {
      log.warn("ignoring unusable ENSEMBLE_MAX_CONCURRENT_RUNS (expected a positive integer, 0 or \"unlimited\")", { value: envLimit.ignored.slice(0, 80), fallback: envLimit.max });
    }
    const pinned = options.managerConfig?.maxConcurrentRuns;
    const initial = decideConcurrency({ pinned, stored: settings.concurrency(), inherited: envLimit });
    const manager = new SessionManager({
      hub, executors: registry, notices, log,
      config: { ...options.managerConfig, maxConcurrentRuns: initial.max },
    });
    // 此后设置里的并发上限变了（落盘之后），新上限立即交给 manager——不重启、不中断在跑的会话。
    const concurrency = new ConcurrencyControl({ manager, settings, env: envLimit, pinned, log });
    const reconciled = manager.reconcileAfterRestart();
    if (reconciled > 0) log.warn("marked sessions from the previous run as lost", { count: reconciled });
    // 先于 HTTP 服务启动：之后进入的每个订阅者（SSE、wait）看到的摘要里都已经带着“值得留意”的事项。
    const supervisor = new AttentionSupervisor({ ...options.attention, hub, log: log.child("attention") });
    supervisor.start();
    // 冷热分离的后台清扫：把过了保温期的已结束会话放出内存。放在重启对账之后——上次遗留的运行先被标成失联，再谈冻结。
    hub.startSweeper();
    // 留存策略（默认关闭：settings.json 没有 retention，或两项都为 null）：只归档、不删除。启动后先清扫一次，之后每小时一次，改了设置时立即再清扫。
    // 清扫在后台进行，不挡启动；失败只记日志。
    const retention = new RetentionSweeper({ hub, log: log.child("retention"), settings: () => settings.retention(), ...options.retention });
    retention.start();
    void retention.sweep().catch((error: unknown) => log.error("retention sweep failed", { error }));

    const webRoot = options.webRoot === null ? undefined : (options.webRoot ?? locateWebRoot());
    const dev = options.dev === true || env["ENSEMBLE_DEV"] === "1";

    let lastActivity = Date.now();
    let closing: Promise<void> | undefined;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });

    const { server, broadcaster } = createHttpServer({
      hub,
      manager,
      notices,
      registry,
      settings,
      concurrency,
      retention,
      git: options.git ?? createGitInspector(),
      log,
      token,
      version,
      startedAt,
      webRoot,
      dev,
      lang: systemLang(env),
      onActivity: () => {
        lastActivity = Date.now();
      },
      onShutdownRequest: () => void close("shutdown_request"),
    });

    registry.onUpdate((info) => broadcaster.publish({ type: "harness", info }));
    // 角色表变了（不论是哪个标签页、哪个入口写的）：把整张表推给所有页面，多个标签页保持一致。
    settings.onProfilesChange(() => broadcaster.publish({ type: "profiles", profiles: settings.profilesView() }));

    const requestedPort = options.port ?? envInteger(env, "ENSEMBLE_PORT") ?? DEFAULT_PORT;
    const port = await listen(server, requestedPort, log);
    const url = `http://127.0.0.1:${port}`;

    const file: ServiceFile = {
      pid: process.pid,
      port,
      url,
      token,
      version,
      protocol: PROTOCOL_VERSION,
      startedAt,
      home: paths.home,
      features: [...SERVICE_FEATURES],
    };
    await writeServiceFile(paths, file);
    const maxRuns = manager.capacity().max;
    log.info("service started", {
      url, pid: process.pid, webRoot: webRoot ?? null, dev,
      maxConcurrentRuns: maxRuns === UNLIMITED_RUNS ? "unlimited" : maxRuns,
      // 这个上限从哪来：settings（用户在设置里指定的）/ env / default / startup（启动方显式给定）。
      maxConcurrentRunsSource: initial.setting.source,
    });
    // 在后台先探测一遍各 Harness：探测可能要几秒，这样第一次委派和第一次打开网页通常都不必等待。
    registry.warm();

    const idleExitMs = options.idleExitMs ?? envInteger(env, "ENSEMBLE_IDLE_EXIT_MS") ?? LIMITS.idleExitMs;
    const idleTimer =
      idleExitMs > 0
        ? setInterval(() => {
            const busy = manager.hasActiveWork() || broadcaster.clientCount() > 0;
            if (busy) {
              lastActivity = Date.now();
              return;
            }
            if (Date.now() - lastActivity > idleExitMs) void close("idle");
          }, Math.min(30_000, Math.max(1_000, Math.floor(idleExitMs / 4))))
        : undefined;
    idleTimer?.unref();

    const close = (reason = "close"): Promise<void> => {
      closing ??= (async () => {
        log.info("service stopping", { reason });
        if (idleTimer) clearInterval(idleTimer);
        supervisor.stop();
        // 先让两个后台清扫收尾（等正在进行的一轮结束），再收尾会话：免得退出时留下写到一半的快照或归档标记。
        await retention.stop();
        await hub.stopSweeper();
        try {
          await manager.shutdown();
        } catch (error) {
          log.error("manager shutdown failed", { error });
        }
        broadcaster.stop();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
        await removeServiceFile(paths, process.pid);
        await releaseLock();
        log.info("service stopped", { reason });
        resolveClosed();
        if (options.exitOnClose) setImmediate(() => process.exit(0));
      })();
      return closing;
    };

    if (options.handleSignals) {
      for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
        process.on(signal, () => void close(signal));
      }
    }

    return { url, port, token, paths, hub, manager, concurrency, retention, notices, registry, close, closed };
  } catch (error) {
    await releaseLock();
    throw error;
  }
}
