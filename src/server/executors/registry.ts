import { errorMessage } from "@shared/format";
import type { HarnessId, HarnessInfo, ModelSettingsView } from "@shared/types";
import type { Logger } from "../logger";
import type { Executor } from "./types";

/** 探测结果在这段时间内视为新鲜，直接使用。 */
const FRESH_MS = 60_000;
/**
 * 超过新鲜期但仍在这段时间内、且状态是 ready 的结果：先用旧结果立刻返回，同时在后台刷新。
 * 探测可能要几秒（例如 Codex 要查询账号与模型目录），不能让每次委派都等一遍。
 */
const STALE_MS = 10 * 60_000;

const DISPLAY_NAMES: Partial<Record<HarnessId, string>> = {
  cursor: "Cursor",
  codex: "Codex",
  pi: "Pi",
  claude: "Claude Code",
  opencode: "OpenCode",
  dsh: "DSH",
};

export type HarnessListener = (info: HarnessInfo) => void;

/** 用户对每个执行端可选模型的取舍（来自持久化的设置）。 */
export interface ModelPolicy {
  modelSettings(harness: HarnessId): ModelSettingsView;
}

export interface RegistryOptions {
  /** 测试用：可注入的时钟。 */
  now?: () => number;
  /** 把模型设置附到每个执行端的信息上。 */
  policy?: ModelPolicy;
}

/** 持有所有已启用的执行端，并缓存探测结果（探测可能涉及子进程或网络，不能每次都做）。 */
export class ExecutorRegistry {
  private readonly executors = new Map<HarnessId, Executor>();
  private readonly cache = new Map<HarnessId, { at: number; info: HarnessInfo }>();
  private readonly inflight = new Map<HarnessId, Promise<HarnessInfo>>();
  private readonly listeners = new Set<HarnessListener>();
  private readonly now: () => number;
  private readonly policy: ModelPolicy | undefined;

  constructor(
    executors: Executor[],
    private readonly log: Logger,
    options: RegistryOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.policy = options.policy;
    for (const executor of executors) this.executors.set(executor.id, executor);
  }

  ids(): HarnessId[] {
    return [...this.executors.keys()];
  }

  get(id: HarnessId): Executor | undefined {
    return this.executors.get(id);
  }

  /** 某个 Harness 的探测结果发生了实质变化（不含仅 checkedAt 变化）时通知，网页据此即时更新。 */
  onUpdate(listener: HarnessListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 在后台探测所有尚未探测的 Harness（服务启动时调用），之后第一次委派通常不必再等。 */
  warm(): void {
    for (const id of this.ids()) {
      if (!this.cache.has(id)) void this.refresh(id);
    }
  }

  /**
   * 立即返回当前已知的信息，从不等待探测：没有结果的 Harness 以 "checking" 占位，
   * 并在后台开始探测；过了新鲜期的也会在后台刷新。
   */
  snapshot(): HarnessInfo[] {
    return [...this.executors.values()].map((executor) => {
      const id = executor.id;
      const cached = this.cache.get(id);
      if (!cached || this.now() - cached.at >= FRESH_MS) void this.refresh(id);
      return this.current(executor);
    });
  }

  /** 已登记执行端的当前视图；保存模型设置时可以立即回执，探测无需参与。 */
  current(executor: Executor): HarnessInfo {
    return this.decorate(this.cache.get(executor.id)?.info ?? this.placeholder(executor));
  }

  async info(id: HarnessId, options: { force?: boolean } = {}): Promise<HarnessInfo | undefined> {
    const info = await this.probed(id, options);
    return info && this.decorate(info);
  }

  /** 模型设置变更与探测结果独立，可以在首次探测仍未完成时推送。 */
  policyChanged(id: HarnessId): void {
    const executor = this.get(id);
    if (executor) this.notify(this.current(executor));
  }

  /** 缓存里存的永远是执行端自己的探测结果；用户的取舍在对外返回时才附上，这样名单变化不必重新探测。 */
  private decorate(info: HarnessInfo): HarnessInfo {
    const settings = this.policy?.modelSettings(info.id);
    return settings && Object.keys(settings).length > 0 ? { ...info, ...settings } : info;
  }

  private async probed(id: HarnessId, options: { force?: boolean }): Promise<HarnessInfo | undefined> {
    if (!this.executors.has(id)) return undefined;
    const cached = this.cache.get(id);
    if (!options.force && cached) {
      const age = this.now() - cached.at;
      if (age < FRESH_MS) return cached.info;
      // 只对 ready 的旧结果这样做：needs_setup / unavailable 往往是用户刚刚在处理的状态，必须拿到最新的。
      if (age < STALE_MS && cached.info.status === "ready") {
        void this.refresh(id);
        return cached.info;
      }
    }
    return this.refresh(id);
  }

  async all(options: { force?: boolean } = {}): Promise<HarnessInfo[]> {
    const infos = await Promise.all(this.ids().map((id) => this.info(id, options)));
    return infos.filter((info): info is HarnessInfo => info !== undefined);
  }

  /** 使缓存失效（例如用户刚完成登录后）。 */
  invalidate(id?: HarnessId): void {
    if (id) this.cache.delete(id);
    else this.cache.clear();
  }

  private refresh(id: HarnessId): Promise<HarnessInfo> {
    const running = this.inflight.get(id);
    if (running) return running;
    const executor = this.executors.get(id);
    if (!executor) return Promise.reject(new Error(`Unknown harness "${id}".`));

    const probe = executor
      .probe()
      .catch((error: unknown): HarnessInfo => {
        this.log.error("harness probe failed", { harness: id, error });
        const message = errorMessage(error);
        return {
          id,
          displayName: DISPLAY_NAMES[id] ?? id,
          runtime: executor.runtime,
          status: "unavailable",
          setup: { code: "probe_failed", message },
          models: [],
          capabilities: unknownCapabilities(),
          access: { read_only: null, full: null },
          checkedAt: new Date(this.now()).toISOString(),
        };
      })
      .then((info) => {
        const before = this.cache.get(id)?.info;
        this.cache.set(id, { at: this.now(), info });
        this.inflight.delete(id);
        if (!before || !sameInfo(before, info)) this.notify(this.decorate(info));
        return info;
      });
    this.inflight.set(id, probe);
    return probe;
  }

  private notify(info: HarnessInfo): void {
    for (const listener of this.listeners) {
      try {
        listener(info);
      } catch (error) {
        this.log.warn("harness listener failed", { error });
      }
    }
  }

  private placeholder({ id, runtime }: Executor): HarnessInfo {
    return {
      id,
      displayName: DISPLAY_NAMES[id] ?? id,
      runtime,
      status: "checking",
      models: [],
      capabilities: unknownCapabilities(),
      access: { read_only: null, full: null },
      checkedAt: new Date(this.now()).toISOString(),
    };
  }
}

function sameInfo(a: HarnessInfo, b: HarnessInfo): boolean {
  return JSON.stringify({ ...a, checkedAt: "" }) === JSON.stringify({ ...b, checkedAt: "" });
}

function unknownCapabilities(): HarnessInfo["capabilities"] {
  const unknown = { support: "unknown" as const };
  return {
    steer: unknown,
    followUp: unknown,
    cancel: unknown,
    resume: unknown,
    reasoning: unknown,
    plan: unknown,
    usage: unknown,
    fileEvents: unknown,
  };
}
