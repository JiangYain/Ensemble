import { planRetention } from "@shared/archive";
import { LIMITS } from "@shared/constants";
import { isoNow } from "@shared/format";
import type { RetentionSettings } from "@shared/protocol";
import { archiveSessions, archiveTreeOf } from "./archive";
import type { EventHub } from "./hub";
import type { Logger } from "./logger";

export interface RetentionSweeperOptions {
  hub: EventHub;
  log: Logger;
  /** 当前生效的留存策略（服务启动时接到设置文件上，所以改设置后下一次清扫就用新的）。 */
  settings: () => RetentionSettings;
  /** 周期（毫秒），缺省 LIMITS.retention.sweepMs。 */
  intervalMs?: number;
  /** 当前时刻（毫秒），测试注入。 */
  now?: () => number;
  /** 一批归档多少棵根会话树；批与批之间让出事件循环。缺省 25。 */
  batchSize?: number;
}

export interface RetentionSweep {
  at: string;
  /** 这一轮归档了多少个会话（连同被一起归档的后代，不是树的数量）。 */
  archived: number;
}

/**
 * 留存策略的执行者：定期（以及启动后、修改设置后立刻）按设置里的 keepDays / keepCount 把旧的、已结束的会话树归档。
 * 只归档，永远不删除，也不改变任何会话的状态与记录；规则全在 shared/archive.ts 的 planRetention / planArchive 里，
 * 这里只负责“什么时候算、分批做、不阻塞服务”。
 *
 * 几百棵会话树一次处理完也不会卡住服务：规划是对内存里摘要的一次同步遍历（毫秒级），真正的写盘（每个会话一个 archive.json）
 * 按批进行，每批之间 `setImmediate` 让出事件循环，批内每次写盘本来就是异步的。
 * 每一批都重新规划：两批之间有会话又有了动静，它所在的树就不会被归档。
 *
 * 一次清扫的 `archived` 计的是会话数（含随根一起归档的后代）。keepCount 是在“未归档的根会话树”里数名额，
 * 每一批之后已归档的树不再占名额，所以分批做与一次做完的结果一致。
 */
export class RetentionSweeper {
  private timer: NodeJS.Timeout | undefined;
  /** 清扫串行执行：设置刚改完的那一次必须排在正在跑的那一次之后，才会用上新设置。 */
  private chain: Promise<unknown> = Promise.resolve();
  private running = false;
  private last: RetentionSweep | undefined;
  private readonly hub: EventHub;
  private readonly log: Logger;
  private readonly settings: () => RetentionSettings;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly batchSize: number;

  constructor(options: RetentionSweeperOptions) {
    this.hub = options.hub;
    this.log = options.log;
    this.settings = options.settings;
    this.intervalMs = options.intervalMs ?? LIMITS.retention.sweepMs;
    this.now = options.now ?? Date.now;
    this.batchSize = Math.max(1, options.batchSize ?? 25);
  }

  /** 最近一次清扫的结果；服务启动后还没有清扫过就是 undefined。 */
  lastSweep(): RetentionSweep | undefined {
    return this.last;
  }

  /** 启动周期清扫（定时器不阻止进程退出）。启动后的第一次清扫由调用方显式触发（要等重启对账完成）。 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // 上一轮还没跑完就跳过这一次：周期清扫不堆积；设置刚改完的清扫走 sweep()，会排队而不是跳过。
      if (this.running) return;
      void this.sweep().catch((error: unknown) => this.log.error("retention sweep failed", { error }));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  /** 停止周期清扫，并等正在进行的一轮收尾。 */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.chain.catch(() => undefined);
  }

  /** 立刻按当前设置清扫一次（排在已经在进行的清扫之后），返回这一轮的结果。 */
  sweep(): Promise<RetentionSweep> {
    const run = this.chain.then(() => this.sweepOnce());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async sweepOnce(): Promise<RetentionSweep> {
    this.running = true;
    try {
      let archived = 0;
      const settings = this.settings();
      for (;;) {
        // 每一批前重新规划：已归档的树不会再被选中，两批之间又有动静的树也会按最新状态重新判断。
        const roots = planRetention(archiveTreeOf(this.hub), settings, this.now()).slice(0, this.batchSize);
        if (roots.length === 0) break;
        const response = await archiveSessions(this.hub, roots, "retention");
        archived += response.changed.length;
        // 这一批一个也没归档（被选中的树都在这一瞬间又活跃了）：别原地打转，留给下一次清扫。
        if (response.changed.length === 0) break;
        // 让出事件循环：一次清扫几百棵树时，别的请求照常得到响应。
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (archived > 0) this.log.info("retention archived sessions", { archived, keepDays: settings.keepDays, keepCount: settings.keepCount });
      this.last = { at: isoNow(), archived };
      return this.last;
    } finally {
      this.running = false;
    }
  }
}
