import { ENV, LIMITS } from "@shared/constants";

/** “不设并发上限”的表示：ManagerConfig.maxConcurrentRuns 与 `capacity().max` 都用它（网页和协议里没有第二种写法）。 */
export const UNLIMITED_RUNS = 0;

/**
 * 环境变量这一层读出的上限。`source` 为 "default" 表示环境变量没有生效：没设，或写得无法解析
 * （`ignored` 是被忽略的原文，只给启动日志用，不影响行为）。
 */
export interface EnvLimit {
  max: number;
  source: "env" | "default";
  ignored?: string;
}

/**
 * 读取 ENSEMBLE_MAX_CONCURRENT_RUNS。它现在只是“用户没有在设置里指定过上限时的初始值”（优先级见 concurrency.ts）。
 * 结果只有三种：正整数上限、UNLIMITED_RUNS、默认上限（LIMITS.maxConcurrentRuns）。
 * - 正整数（两侧空白忽略）：新上限；
 * - `0` 或 `unlimited`（不区分大小写）：不设上限；
 * - 未设置、空串，以及一切无法解析的写法（负数、小数、科学计数、十六进制、非数字、超出安全整数范围）：默认上限。
 *   环境变量写错不该让服务起不来，更不该悄悄变成 0 / NaN 而放行或拒绝全部会话。
 * 这里不套用设置里 1–1000 的范围：环境变量的口径一直是“任何正整数”，改它会让原来能用的写法失效。
 */
export function concurrencyFromEnv(env: NodeJS.ProcessEnv): EnvLimit {
  const raw = env[ENV.maxConcurrentRuns]?.trim();
  if (!raw) return { max: LIMITS.maxConcurrentRuns, source: "default" };
  if (raw.toLowerCase() === "unlimited") return { max: UNLIMITED_RUNS, source: "env" };
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value)) return { max: LIMITS.maxConcurrentRuns, source: "default", ignored: raw };
  return { max: value, source: "env" };
}

export function maxConcurrentRunsFrom(env: NodeJS.ProcessEnv): number {
  return concurrencyFromEnv(env).max;
}

/**
 * 构造函数与 setMax 共用的校验。负数、小数、NaN 是调用方的错误，直接抛出：
 * `holders.size < NaN` 恒为假，会让全部会话排队而且永远等不到名额。Infinity 当作不限。
 */
function limitOf(max: number): number {
  const limit = max === Infinity ? UNLIMITED_RUNS : max;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError(`RunSlots needs a positive integer or ${UNLIMITED_RUNS} (unlimited), got ${String(max)}.`);
  }
  // 顺手把 -0 规整成 +0：容量对外是 JSON，也会被 toEqual / Object.is 比较，-0 与 0 在那里是两个值。
  return limit === 0 ? UNLIMITED_RUNS : limit;
}

interface Failure {
  error: unknown;
}

/**
 * 每个活动运行占一个名额；名额空出来时，已经等待的会话先取得（先到先得）。
 * 上限为 UNLIMITED_RUNS 时永远有名额，没有人会进入等待。
 *
 * 上限可以在运行中调整（setMax），且与等待者的先后顺序无关——等待者的顺序在调整前后都不变：
 * - 调高（含改为不设上限）：立刻按先到先得提升等待者，直到占用数到达新上限；
 * - 调低：绝不收回已经给出的名额，所以占用数可以暂时高于上限；新请求排队，释放之后也只有占用数降到上限以下才再提升等待者。
 *   这就是为什么提升是“循环 + 条件”（有空位且有人在等），而不是释放一个就无条件提一个。
 *
 * 提升时调用的 `start` 可以重入（SessionRuntime.startNext 在没有可开始的输入时会 release 自己，原则上也可以 request 别人）：
 * 每个等待者在被叫起 `start` 之前就已经从队列挪进占用表，循环每一圈都重新读当前状态，所以重入的调用看到的账目永远是一致的，
 * 不会重复提升、漏提升，也不会让一个名额被两个会话占着。
 * `start` 抛错意味着这个会话没能真正开始：它的名额立刻还回去，队列里后面的照常往下提升（队列不会卡死、名额不会泄漏），
 * 第一个错误在账目整理完之后重新抛给触发这次提升的调用方——与改造前一样让它看得见，只是不再带着一笔烂账。
 */
export class RunSlots {
  private readonly holders = new Set<string>();
  private readonly waiting = new Map<string, () => void>();
  private readonly listeners = new Set<() => void>();
  private max: number;

  /**
   * @param max 正整数；UNLIMITED_RUNS（0）或 Infinity 表示不限。
   */
  constructor(max: number) {
    this.max = limitOf(max);
  }

  /** `max` 为 UNLIMITED_RUNS（0）表示不设上限；此时 `waiting` 恒为 0。调低上限之后 `occupied` 可以暂时大于 `max`。 */
  get capacity(): { occupied: number; max: number; waiting: number } {
    return { occupied: this.holders.size, max: this.max, waiting: this.waiting.size };
  }

  /** 此刻还能不能再给一个名额：不设上限，或占用数低于上限。 */
  private get hasRoom(): boolean {
    return this.max === UNLIMITED_RUNS || this.holders.size < this.max;
  }

  /**
   * 占用数、等待数或上限变了就同步通知一次（嵌套的调用各自通知，监听者自己合并）。通知时账目已经一致；
   * 监听者只是通知，它抛的错会被忽略，不能影响名额。返回取消订阅的函数。
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 运行中调整上限；值与构造函数同一套规则（非负安全整数，0＝不限），不合格就抛 RangeError 且什么都不改。 */
  setMax(max: number): void {
    const limit = limitOf(max);
    if (limit === this.max) return;
    this.max = limit;
    this.settle();
  }

  request(id: string, start: () => void): boolean {
    // 只有有空位、而且没有人在等的时候才直接开始：已经有人在等就先到先得，新来的排在后面
    // （这种情况只会出现在提升循环的 start 回调里；平时“有空位”与“有人在等”不会同时成立）。
    if (this.waiting.size > 0 || !this.hasRoom) {
      this.waiting.set(id, start);
      this.notify();
      return false;
    }
    const failure = this.occupy(id, start);
    if (failure) {
      // 回调里可能有人排了进来，刚还回去的名额要让他们接着用；这时只关心把账理平，原来的错误才是调用方要看的。
      this.promote();
      this.notify();
      throw failure.error;
    }
    this.notify();
    return true;
  }

  release(id: string): void {
    const waited = this.waiting.delete(id);
    const held = this.holders.delete(id);
    if (waited || held) this.settle();
  }

  /** 先占名额再叫起 start：start 里重入的调用看到的占用表已经包含它。start 抛错就把名额还回去。 */
  private occupy(id: string, start: () => void): Failure | undefined {
    this.holders.add(id);
    try {
      start();
      return undefined;
    } catch (error) {
      this.holders.delete(id);
      return { error };
    }
  }

  /** 按先到先得提升等待者，直到没有空位或没有人在等；返回第一个没能开始的失败（继续提升后面的，不让队列卡住）。 */
  private promote(): Failure | undefined {
    let first: Failure | undefined;
    while (this.waiting.size > 0 && this.hasRoom) {
      const next = this.waiting.entries().next().value;
      if (!next) break;
      const [id, start] = next;
      this.waiting.delete(id);
      const failure = this.occupy(id, start);
      first ??= failure;
    }
    return first;
  }

  private settle(): void {
    const failure = this.promote();
    this.notify();
    if (failure) throw failure.error;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // 监听者只是通知，出错不能影响名额账目。
      }
    }
  }
}
