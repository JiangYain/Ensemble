import type { ConcurrencySetting, ConcurrencyValue } from "@shared/protocol";
import { EnsembleError } from "./errors";
import type { Logger } from "./logger";
import type { SessionManager } from "./manager";
import { UNLIMITED_RUNS, type EnvLimit } from "./run-slots";
import type { SettingsStore, StoredConcurrencyView } from "./settings";

/** 一次合成的结果：此刻应当生效的上限（0＝不设上限，与 RunSlots 同一套写法），以及页面上要解释它的那份设置。 */
export interface ConcurrencyDecision {
  max: number;
  setting: ConcurrencySetting;
}

/**
 * 全局并发上限的合成规则，只此一处：
 *   启动方显式给定（managerConfig，测试与嵌入）> 用户在设置里指定的（settings.json）> 环境变量 > 内置默认。
 * - 环境变量因此只是“用户没指定过”时的初始值，不是被忽略：设置里“恢复默认”之后回到的就是它；
 * - 设置文件整个读不出来、或这一项的值无效时按“用户没指定”处理——上限落回环境变量 / 内置默认，服务照常运行
 *   （文件原样保留，页面如实说明，见 ConcurrencySetting.issue）；
 * - 启动方显式给定的上限设置里改不动（页面上是只读）。文件里存的值仍如实放进 `setting.stored`（存在、但此刻不生效），不因为被盖住就隐去；
 *   网页目前只拿它决定“恢复默认”是否可用，启动方固定时那个入口本来就不提供，所以页面上并不显示这个值。
 * 纯函数：不碰文件、不碰 manager，所以所有组合都能直接测。
 */
export function decideConcurrency(input: { pinned: number | undefined; stored: StoredConcurrencyView; inherited: EnvLimit }): ConcurrencyDecision {
  const { pinned, stored, inherited } = input;
  const base = {
    inherited: { max: inherited.max, source: inherited.source },
    ...(stored.value === undefined ? {} : { stored: stored.value }),
    ...(stored.issue === undefined ? {} : { issue: stored.issue }),
  };
  if (pinned !== undefined) return { max: pinned, setting: { source: "startup", ...base } };
  if (stored.value !== undefined) {
    return { max: stored.value === "unlimited" ? UNLIMITED_RUNS : stored.value, setting: { source: "settings", ...base } };
  }
  return { max: inherited.max, setting: { source: inherited.source, ...base } };
}

export interface ConcurrencyDeps {
  manager: SessionManager;
  settings: SettingsStore;
  /** 环境变量这一层（启动时读一次，运行中不会变）。 */
  env: EnvLimit;
  /** 启动方显式给定的上限（managerConfig.maxConcurrentRuns）；有它就不允许在设置里改。 */
  pinned: number | undefined;
  log: Logger;
}

/**
 * 把“设置里的并发上限”接到正在运行的服务上：设置变了（落盘之后）就把新上限交给 SessionManager——不重启、立即生效——
 * 并通知订阅者（HTTP 层靠它把新的设置推给所有页面）。
 * 它自己不存任何状态：来源、存值与问题每次都从 SettingsStore 现读再合成，所以任何入口改了设置之后，看到的都是同一份。
 */
export class ConcurrencyControl {
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: ConcurrencyDeps) {
    deps.settings.onConcurrencyChange(() => this.refresh());
  }

  /** 此刻的合成结果。 */
  decide(): ConcurrencyDecision {
    const { pinned, settings, env } = this.deps;
    return decideConcurrency({ pinned, stored: settings.concurrency(), inherited: env });
  }

  /** 设置的来源、用户存的值与问题（生效的上限本身是 manager.capacity().max）。 */
  view(): ConcurrencySetting {
    return this.decide().setting;
  }

  /**
   * 指定上限（正整数或 "unlimited"），`null` 清掉指定。落盘成功之后由 SettingsStore 的通知触发 refresh，所以这个 Promise
   * 结束时新上限已经在 manager 里生效。启动方显式给定了上限时拒绝（409）：这时改设置不会改变任何东西，不该假装成功。
   */
  async set(value: ConcurrencyValue | null): Promise<void> {
    if (this.deps.pinned !== undefined) {
      throw new EnsembleError("conflict", "The concurrency limit was fixed by the process that started this service, so it cannot be changed from Settings.");
    }
    await this.deps.settings.setConcurrency(value);
  }

  /** 设置的来源 / 存值 / 问题变了（落盘之后）。名额占用的变化不走这里，见 SessionManager.onCapacityChange。返回取消订阅的函数。 */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private refresh(): void {
    const { max, setting } = this.decide();
    try {
      this.deps.manager.setMaxConcurrentRuns(max, setting.source);
    } finally {
      // 提升排队的会话时有人抛错（见 RunSlots）也不能让页面停在旧设置上：上限与账目此时已经是一致的。
      for (const listener of [...this.listeners]) {
        try {
          listener();
        } catch (error) {
          this.deps.log.warn("concurrency listener failed", { error });
        }
      }
    }
  }
}
