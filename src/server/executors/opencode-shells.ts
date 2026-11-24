import { errorMessage } from "@shared/format";
import { arr, asRecord, num, str, type Json } from "./common";
import { killTree } from "./process";

/**
 * shell 工具的进程树管理。
 *
 * 为什么要自己管：OpenCode 的 shell 工具在 Windows 上是「shell ← 命令启动的子孙进程」，它自己的中断只杀得掉 shell 本身，
 * 子孙进程会变成孤儿继续跑；私有服务退出时也不会带走它们。所以取消与关闭时，Ensemble 必须按 pid 结束整棵进程树。
 * 上面是 Windows 上的实测。Linux 与 macOS 上 OpenCode 的中断是否同样只杀 shell 没有验证；killTree 在那里已实现（冻结整棵树再统一 SIGKILL，
 * 见 process-kill.ts），没有验证过，没有孤儿时这一步也不会多做什么。
 *
 * 进程从哪里知道（两路取并集）：
 * - 事件流里的 `shell.created`（带真实 pid）与 `shell.exited`；
 * - 服务端自己的登记表 `GET /api/shell`（只含运行中的 shell，退出后条目消失）。
 *   事件可能还没处理到（事件循环正忙、命令刚起就取消了），登记表不依赖这一点，取消时先问它，事件只作补充。
 *
 * 取消时的顺序是整件事的要害：必须「先杀树、再中断」。中断先到，OpenCode 会先杀掉 shell，子孙进程失去父进程后，
 * 按父子关系找后代的办法（Windows 的 taskkill /T、POSIX 上沿 ppid 向下找）就找不到了（POSIX 上它们会被系统收养）；
 * 但杀树之后也不能等它完全收尾再中断：机器忙时 Windows 的 taskkill 能拖上好几秒，模型一旦发现工具被杀就会立刻接着开始下一步，
 * 运行就变成了“完成”而不是“已取消”。折中是：根进程一消失（taskkill 先杀子孙再杀根）就发中断，杀树的收尾留到之后再等。
 * POSIX 的杀树同样强制、不拖延（不先 SIGTERM 等宽限），冻结整棵树后统一 SIGKILL，通常很快就收尾（没有实测耗时）。
 */

const POLL_MS = 20;
/** 等根进程退出的上限；超过就不等了，照样发中断（它自己也会杀 shell），进程树的收尾由还在跑的杀树动作（Windows 的 taskkill、POSIX 的 killTree）完成。 */
export const ROOT_EXIT_WAIT_MS = 3_000;
export const SHELL_LIST_TIMEOUT_MS = 2_000;

/** pid 0 在 POSIX 上代表“整个进程组”，≤4 是系统进程：登记表或事件里出现这些值时绝不能去杀。 */
export const isKillablePid = (pid: number | undefined): pid is number => pid !== undefined && Number.isSafeInteger(pid) && pid > 4;

/**
 * POSIX 上已死、还没被父进程回收的僵尸也探测得到，会被当成还活着；killAll 不靠这里收尾——
 * killTree 的收尾用进程表确认（僵尸不算活着），它先完成时 killAll 的等待随即结束。
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM：进程存在，只是不归我们管。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface ShellDeps {
  /** 本会话的 OpenCode 会话 id；事件里别的会话的 shell 不归这里管。 */
  sessionId(): string;
  /** `GET /api/shell`。 */
  list(): Promise<unknown>;
  debug?(message: string, detail?: Json): void;
  /** 测试注入点：默认结束整棵进程树 / 探测进程是否还在。 */
  kill?(pid: number): Promise<void>;
  alive?(pid: number): boolean;
}

export class OpenCodeShells {
  /** 事件里已知的运行中 shell：shell id → 它的真实 pid。 */
  private readonly running = new Map<string, number | undefined>();
  /** 取消进行中：这时才冒出来的 shell 来不及被登记就要立刻结束（取消结束后恢复）。 */
  private halting = false;
  /** 会话关闭：同上，但不再恢复。 */
  private finished = false;

  constructor(private readonly deps: ShellDeps) {}

  created(info: Json | undefined): void {
    const id = str(info?.["id"]);
    if (!id || str(asRecord(info?.["metadata"])?.["sessionID"]) !== this.deps.sessionId()) return;
    const pid = num(info?.["pid"]);
    if (this.halting || this.finished) {
      if (isKillablePid(pid)) void this.kill(pid);
      return;
    }
    this.running.set(id, pid);
  }

  exited(id: string | undefined): void {
    if (id) this.running.delete(id);
  }

  /** 取消开始：此后新出现的 shell 立刻结束。 */
  halt(): void {
    this.halting = true;
  }

  /** 取消结束：之后的运行可以正常使用 shell（会话已关闭则不恢复）。 */
  resume(): void {
    this.halting = false;
  }

  /** 会话关闭：此后新出现的 shell 一律立刻结束。 */
  finish(): void {
    this.finished = true;
  }

  /**
   * 结束所有运行中 shell 的进程树。返回时它们的根进程已经退出（或已等满 `waitMs`），
   * 杀树的收尾（Windows 的 taskkill、POSIX 的冻结收敛）放在 `settled` 里：调用方应当先发中断，最后再等它，确保孙进程确实清干净了。
   */
  async killAll(waitMs = ROOT_EXIT_WAIT_MS): Promise<{ settled: Promise<void> }> {
    const roots = await this.roots();
    const settled = Promise.all(roots.map((pid) => this.kill(pid))).then(() => undefined);
    await Promise.race([settled, this.untilGone(roots, waitMs)]);
    return { settled };
  }

  private async roots(): Promise<number[]> {
    const pids = new Set<number>();
    for (const pid of this.running.values()) if (isKillablePid(pid)) pids.add(pid);
    try {
      for (const entry of arr(asRecord(await this.deps.list())?.["data"]) ?? []) {
        const info = asRecord(entry);
        const pid = num(info?.["pid"]);
        if (str(info?.["status"]) === "running" && isKillablePid(pid)) pids.add(pid);
      }
    } catch (error) {
      // 服务没有回应（已崩溃、卡住）：只能靠事件里知道的那些。
      this.deps.debug?.("shell list unavailable, using the pids seen in events", { error: errorMessage(error) });
    }
    return [...pids];
  }

  private async untilGone(pids: number[], waitMs: number): Promise<void> {
    const alive = this.deps.alive ?? isAlive;
    const deadline = Date.now() + waitMs;
    while (pids.some((pid) => alive(pid)) && Date.now() < deadline) await sleep(POLL_MS);
  }

  private kill(pid: number): Promise<void> {
    // 杀进程是尽力而为：进程可能刚好自己退出了。
    return (this.deps.kill ?? killTree)(pid).catch(() => undefined);
  }
}
